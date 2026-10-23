'use strict';
// Starting the CLI broker (broker.js) so it outlives Helm, job objects included (lane detach, 2026-10-15).
//
// Node's `detached: true` keeps the broker out of libuv's own kill-on-close job, but NOT out of a job Helm itself
// was started in (some launchers, terminals, scheduled tasks): the broker would inherit that job and die when it
// closes. libuv never passes CREATE_BREAKAWAY_FROM_JOB and Helm has no FFI, so on Windows a tiny launcher does it:
// helm-broker-launch.exe (the C# below), compiled ONCE with the .NET Framework's csc.exe that ships with Windows
// and cached in <userData>/bin by source hash. It:
//   1. checks whether it (and so Helm) runs inside a job (IsProcessInJob);
//   2. starts the broker DETACHED, hidden, with CREATE_BREAKAWAY_FROM_JOB when it is in a job; if the job forbids
//      breakaway (ERROR_ACCESS_DENIED) it starts it without, and says so;
//   3. checks whether the broker ended up in a job, and prints one JSON line.
// On this machine EVERY process is in a session-wide job (explorer.exe included; its handle is out of reach), so a
// broker that broke away still reports childInJob === true: it left Helm's own jobs (libuv's kill-on-close job
// allows breakaway) and sits only in jobs that outlive Helm. So a successful breakaway counts as safe. Only a
// broker that could NOT break away (ERROR_ACCESS_DENIED: Helm was started inside a job that forbids it, e.g. a
// scheduled task or Git Bash) and still sits in a job is not counted on: sessions are not kept through restarts
// (they stop with a restart note, as before). When the launcher is unavailable (no
// csc, compile failed) Helm starts the broker with plain Node and the job state is unknown; that is logged and
// shown in Settings > Helm.
//
//   launchBroker({ execPath, args, env, cwd, binDir, log }) -> Promise<{ pid, job }>
//   job = { method: 'launcher'|'node', parentInJob, brokeAway, childInJob (true|false|null), breakawayError, note }
//   jobSafe(job) -> true | false | null (unknown)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const LAUNCHER_CS = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

static class HelmBrokerLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint DETACHED_PROCESS = 0x8, CREATE_NEW_PROCESS_GROUP = 0x200, CREATE_BREAKAWAY_FROM_JOB = 0x01000000;

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char ch in a) {
      if (ch == '\\') { bs++; continue; }
      if (ch == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(ch);
    }
    sb.Append('\\', bs * 2);
    sb.Append('"');
    return sb.ToString();
  }
  static string B(bool b) { return b ? "true" : "false"; }

  static int Main(string[] args) {
    if (args.Length < 1) { Console.WriteLine("{\"error\":\"usage: helm-broker-launch <exe> [args]\"}"); return 2; }
    var cmd = new StringBuilder();
    foreach (var a in args) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Quote(a)); }
    bool parentInJob;
    if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out parentInJob)) parentInJob = false;
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 1; // STARTF_USESHOWWINDOW
    si.wShowWindow = 0; // SW_HIDE
    PROCESS_INFORMATION pi;
    uint flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    bool brokeAway = false;
    int breakErr = 0;
    bool ok;
    if (parentInJob) {
      ok = CreateProcessW(args[0], new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, false, flags | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi);
      if (ok) brokeAway = true;
      else {
        breakErr = Marshal.GetLastWin32Error();
        ok = CreateProcessW(args[0], new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref si, out pi);
      }
    } else {
      ok = CreateProcessW(args[0], new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref si, out pi);
    }
    if (!ok) { Console.WriteLine("{\"error\":\"CreateProcess failed (" + Marshal.GetLastWin32Error() + ")\",\"breakawayError\":" + breakErr + "}"); return 1; }
    bool childInJob;
    if (!IsProcessInJob(pi.hProcess, IntPtr.Zero, out childInJob)) childInJob = false;
    Console.WriteLine("{\"pid\":" + pi.dwProcessId + ",\"parentInJob\":" + B(parentInJob) + ",\"brokeAway\":" + B(brokeAway) + ",\"childInJob\":" + B(childInJob) + ",\"breakawayError\":" + breakErr + "}");
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
  }
}
`;
const LAUNCHER_HASH = crypto.createHash('sha1').update(LAUNCHER_CS).digest('hex').slice(0, 10);

function cscPath() {
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const compiling = new Map(); // exe path -> Promise<exe>
// -> Promise<launcher exe path>; compiles once per source hash (about 1-2 s), then reuses the cached exe.
function ensureLauncher(binDir, log = () => {}) {
  const exe = path.join(binDir, `helm-broker-launch-${LAUNCHER_HASH}.exe`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  if (compiling.has(exe)) return compiling.get(exe);
  const p = new Promise((resolve, reject) => {
    const csc = cscPath();
    if (!csc) return reject(new Error('the .NET Framework C# compiler (csc.exe) is not on this PC'));
    try { fs.mkdirSync(binDir, { recursive: true }); } catch {}
    const src = path.join(binDir, `helm-broker-launch-${LAUNCHER_HASH}.cs`);
    const tmp = path.join(binDir, `helm-broker-launch-${LAUNCHER_HASH}.${process.pid}.tmp.exe`);
    try { fs.writeFileSync(src, LAUNCHER_CS); } catch (e) { return reject(new Error(`could not write the launcher source: ${e.message}`)); }
    const t0 = Date.now();
    execFile(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${tmp}`, src], { windowsHide: true, timeout: 60e3 }, (err, stdout) => {
      if (err) { try { fs.rmSync(tmp, { force: true }); } catch {} return reject(new Error(`compiling the launcher failed: ${String(stdout || err.message).trim().split(/\r?\n/).slice(-2).join(' ')}`)); }
      try { fs.renameSync(tmp, exe); } catch (e) { if (!fs.existsSync(exe)) return reject(new Error(`could not place the launcher: ${e.message}`)); try { fs.rmSync(tmp, { force: true }); } catch {} }
      log('info', `broker: compiled ${path.basename(exe)} in ${Date.now() - t0} ms`);
      resolve(exe);
    });
  });
  compiling.set(exe, p);
  p.then(() => compiling.delete(exe), () => compiling.delete(exe));
  return p;
}

function runLauncher(exe, { execPath, args, env, cwd }) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let child;
    try {
      // detached: the launcher must not sit in libuv's own job (it would always see a job and break away from it)
      child = spawn(exe, [execPath, ...args], { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('the launcher did not answer in 15 s')); }, 15e3);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
      if (!r) return reject(new Error(`the launcher said nothing usable (exit ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''})`));
      if (r.error || !r.pid) return reject(new Error(r.error || 'the launcher started nothing'));
      resolve(r);
    });
  });
}

function plainSpawn({ execPath, args, env, cwd }) {
  const child = spawn(execPath, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
  return child.pid;
}

async function launchBroker({ execPath, args, env, cwd, binDir, log = () => {}, useLauncher = process.platform === 'win32' }) {
  if (useLauncher) {
    try {
      const exe = await ensureLauncher(binDir, log);
      const r = await runLauncher(exe, { execPath, args, env, cwd });
      const job = { method: 'launcher', parentInJob: !!r.parentInJob, brokeAway: !!r.brokeAway, childInJob: !!r.childInJob, breakawayError: r.breakawayError || 0, note: null };
      if (job.childInJob && !job.brokeAway) job.note = `Helm runs inside a Windows job that does not allow breakaway (error ${job.breakawayError}), so the broker could not leave it`;
      else if (job.childInJob) job.note = 'Helm runs inside a Windows job; the broker broke away from Helm jobs and sits only in the session-wide one, which outlives Helm';
      else if (job.parentInJob) job.note = 'Helm runs inside a Windows job; the broker broke away from it';
      return { pid: r.pid, job };
    } catch (e) {
      log('warn', `broker: launcher unavailable (${e.message}); starting the broker with Node, job state unknown`);
      return { pid: plainSpawn({ execPath, args, env, cwd }), job: { method: 'node', parentInJob: null, brokeAway: false, childInJob: null, breakawayError: 0, note: `job check unavailable: ${e.message}` } };
    }
  }
  return { pid: plainSpawn({ execPath, args, env, cwd }), job: { method: 'node', parentInJob: null, brokeAway: false, childInJob: process.platform === 'win32' ? null : false, breakawayError: 0, note: process.platform === 'win32' ? 'job check skipped' : null } };
}

// true: the broker sits in no job, or broke away from Helm's (restarts cannot reach it); false: it is in a job it
// could not leave; null: unknown
function jobSafe(job) {
  if (!job) return null;
  if (job.childInJob === true) return job.brokeAway === true;
  if (job.childInJob === false) return true;
  return null;
}

module.exports = { launchBroker, ensureLauncher, jobSafe, LAUNCHER_HASH, cscPath };
