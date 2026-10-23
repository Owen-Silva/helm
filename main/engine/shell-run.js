'use strict';
// `!` shell mode (sessions.shell): run one command in the session folder, the way Claude Code's
// terminal does when a prompt starts with `!`, and hand its output to Claude with the NEXT prompt.
//
// - Shell: the same one Claude Code's Bash tool uses on Windows, Git Bash
//   (CLAUDE_CODE_GIT_BASH_PATH, else the usual install paths) via `bash -c` (no login profile).
//   PowerShell (`-NoProfile -EncodedCommand`) only when no bash is found. POSIX: /bin/bash or /bin/sh.
// - Env: Helm's own, minus Electron/Helm-specific variables (ELECTRON_*, NODE_OPTIONS, HELM_*).
// - Output: utf-8, ANSI escapes and stray control characters removed, CRLF → LF. Display keeps the
//   last ~1 MB; Claude's copy keeps the head and tail of each stream (CONTEXT_MAX, middle trimmed).
// - Stop: the whole process tree by PID (`taskkill /PID <pid> /T /F`), never by name.
//
// Context format (Claude Code's own tags, one set per run, oldest first, then the typed prompt):
//   <bash-input>git status</bash-input>
//   <bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>
//
//   what changed?
// A non-zero exit adds an "Exit code N" line to the stderr block; a stopped run adds STOPPED_LINE.
// splitShellBlocks() reverses it for transcripts read back from disk (normalize.js, history.js).

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CONTEXT_MAX = 30000; // per stream, chars: Claude Code's default BASH_MAX_OUTPUT_LENGTH
const DISPLAY_MAX = 1_000_000; // chars of combined output kept for the card
const STOPPED_LINE = 'Command stopped by the user';

// ---------- text ----------
// CSI (incl. private `?` params), OSC (BEL or ST terminated), DCS/PM/APC strings, 2-char escapes, 8-bit CSI.
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_][^\u001b]*\u001b\\|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g; // keeps \t \n \r
const COMPLETE_ESC_RE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[P^_][^\u001b]*\u001b\\|[@-Z\\-_])/;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '').replace(CTRL_RE, '');
}

// Progress bars rewrite a line with a bare \r: keep what the terminal would end up showing.
function collapseCR(s) {
  s = String(s || '');
  if (s.indexOf('\r') < 0) return s;
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((ln) => {
      const parts = ln.split('\r');
      for (let k = parts.length - 1; k >= 0; k--) if (parts[k]) return parts[k];
      return '';
    })
    .join('\n');
}

// Keep the start and the end, drop the middle with a marker that says how much went.
function middleTrim(s, max = CONTEXT_MAX, total = null) {
  s = String(s || '');
  const len = total != null ? total : s.length;
  if (len <= max && s.length <= max) return s;
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n... [${(len - max).toLocaleString('en-US')} characters truncated] ...\n\n${s.slice(-tail)}`;
}

// Output that contains one of our closing tags must not end its block early.
const esc = (s) => String(s || '').replace(/<\/(bash-(?:input|stdout|stderr))>/g, '<\\/$1>');
const unesc = (s) => String(s || '').replace(/<\\\/(bash-(?:input|stdout|stderr))>/g, '</$1>');

// One run → its context block (see the header). `run`: { command, stdout, stderr, exitCode, status }
// where stdout/stderr are already trimmed for context.
function shellContextBlock(run) {
  const trailer = run.status === 'stopped' ? STOPPED_LINE : typeof run.exitCode === 'number' && run.exitCode !== 0 ? `Exit code ${run.exitCode}` : '';
  const err = [String(run.stderr || '').replace(/\s+$/, ''), trailer].filter(Boolean).join('\n');
  return `<bash-input>${esc(run.command)}</bash-input>\n<bash-stdout>${esc(String(run.stdout || '').replace(/\s+$/, ''))}</bash-stdout><bash-stderr>${esc(err)}</bash-stderr>`;
}

// Prepend context blocks to SDK user content (a string, or blocks whose first is text).
function prependContext(content, pre) {
  if (!pre) return content;
  if (typeof content === 'string') return `${pre}\n\n${content}`;
  if (Array.isArray(content) && content.length && content[0] && content[0].type === 'text') {
    return [{ ...content[0], text: `${pre}\n\n${content[0].text}` }, ...content.slice(1)];
  }
  return [{ type: 'text', text: pre }, ...(Array.isArray(content) ? content : [])];
}

// A user text that starts with bash-* tags → { runs: [{ command, stdout, stderr, exitCode, status }],
// orphan: { stdout, stderr } | null (output with no input in this message: a terminal `!` run writes
// its output as the NEXT user message), rest: the typed text after the blocks }. null if no tags.
const TAG_RE = /^\s*<(bash-input|bash-stdout|bash-stderr)>([\s\S]*?)<\/\1>/;
const TRAILER_RE = /(?:^|\n)(?:Exit code (-?\d+)|(Command stopped by the user))\s*$/;

function readTrailer(stderr) {
  const m = TRAILER_RE.exec(stderr || '');
  if (!m) return { stderr: stderr || '', exitCode: null, stopped: false };
  return { stderr: stderr.slice(0, m.index), exitCode: m[1] != null ? Number(m[1]) : null, stopped: !!m[2] };
}

function splitShellBlocks(text) {
  let s = String(text || '');
  if (!/^\s*<bash-(?:input|stdout|stderr)>/.test(s)) return null;
  const runs = [];
  let cur = null;
  let orphan = null;
  for (;;) {
    const m = TAG_RE.exec(s);
    if (!m) break;
    const val = unesc(m[2]);
    if (m[1] === 'bash-input') {
      cur = { command: val, stdout: null, stderr: null };
      runs.push(cur);
    } else {
      const target = cur || (orphan = orphan || { stdout: null, stderr: null });
      target[m[1] === 'bash-stdout' ? 'stdout' : 'stderr'] = val;
    }
    s = s.slice(m[0].length);
  }
  const finish = (r) => {
    const t = readTrailer(r.stderr);
    const hasOutput = r.stdout != null || r.stderr != null;
    return { ...r, stdout: r.stdout || '', stderr: t.stderr, exitCode: t.exitCode, status: t.stopped ? 'stopped' : 'done', hasOutput };
  };
  return { runs: runs.map(finish), orphan: orphan ? finish(orphan) : null, rest: s.replace(/^\s+/, '') };
}

// ---------- process ----------
const WIN_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];

function pickShell({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const ok = (p) => {
    try {
      return !!p && exists(p);
    } catch {
      return false;
    }
  };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null;
    const bash = [env.CLAUDE_CODE_GIT_BASH_PATH, ...WIN_BASH, local].find(ok);
    if (bash) return { kind: 'bash', file: bash, args: (cmd) => ['-c', cmd] };
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = (cmd) => `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n${cmd}`;
    return { kind: 'powershell', file: ok(ps) ? ps : 'powershell.exe', args: (cmd) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script(cmd), 'utf16le').toString('base64')] };
  }
  const bash = ['/bin/bash', '/usr/bin/bash'].find(ok);
  return bash ? { kind: 'bash', file: bash, args: (cmd) => ['-c', cmd] } : { kind: 'sh', file: '/bin/sh', args: (cmd) => ['-c', cmd] };
}

const DROP_ENV = /^(ELECTRON_|HELM_|CHROME_CRASHPAD)/i;
function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null || DROP_ENV.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Git Bash on Windows: MSYS starts each exec'd program from a short-lived fork stub, so a command's
// processes (e.g. `sleep` inside `bash -c`) are orphans in the Windows process tree and
// `taskkill /T` on the bash misses them (measured 2026-10-08). MSYS keeps its own process group
// though: the run writes its MSYS pid ($$, the group leader) to `pidFile`, and stop signals that
// whole group from a second bash before ending the Windows tree by PID.
function killTree(pid, platform = process.platform, msys = null) {
  if (!pid) return;
  if (platform === 'win32') {
    const taskkill = () => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    let mp = null;
    try {
      if (msys && msys.pidFile) mp = /^\d{1,10}$/.exec(fs.readFileSync(msys.pidFile, 'utf8').trim());
    } catch {}
    if (!mp) return taskkill();
    execFile(msys.bash, ['-c', `kill -9 -- -${mp[0]} 2>/dev/null; kill -9 ${mp[0]} 2>/dev/null; true`], { windowsHide: true, env: childEnv(process.env), timeout: 5000 }, taskkill);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // the run is its own process group (detached)
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

// Bytes → clean text, holding back a trailing \r (half of a CRLF) or a half-received escape sequence.
function textStream() {
  const dec = new StringDecoder('utf8');
  let carry = '';
  const clean = (s, final) => {
    s = carry + s;
    carry = '';
    if (!final) {
      const e = s.lastIndexOf('\u001b');
      if (e >= 0 && s.length - e < 256 && !COMPLETE_ESC_RE.test(s.slice(e))) {
        carry = s.slice(e);
        s = s.slice(0, e);
      }
      if (s.endsWith('\r')) {
        carry = '\r' + carry;
        s = s.slice(0, -1);
      }
    }
    return stripAnsi(s.replace(/\r\n/g, '\n'));
  };
  return { write: (buf) => clean(dec.write(buf), false), end: () => clean(dec.end(), true) };
}

// Head + tail of one stream: enough for the middle-trimmed context copy without keeping it all.
class StreamBuf {
  constructor(keep = CONTEXT_MAX) {
    this.keep = keep;
    this.head = '';
    this.tail = '';
    this.total = 0;
  }
  push(s) {
    if (!s) return;
    this.total += s.length;
    if (this.head.length < this.keep) this.head += s.slice(0, this.keep - this.head.length);
    this.tail = (this.tail + s).slice(-this.keep);
  }
  // Context copy: whole when short, else head and tail around a marker (CR progress collapsed).
  context(max = CONTEXT_MAX) {
    if (this.total <= max) return collapseCR(this.head);
    const half = Math.floor(max / 2);
    return middleTrim(collapseCR(this.head.slice(0, half) + this.tail.slice(-(max - half))), max, this.total);
  }
}

// Spawn one run. onData(kind: 'stdout'|'stderr', text) gets clean text; onExit({ code, signal, error })
// fires once (closed: false when the shell exited but something it started still held the pipes
// after 1.5 s). Returns { pid, shell: kind, stop() }.
function runShell({ command, cwd, env = process.env, shell = null, onData = () => {}, onExit = () => {}, platform = process.platform }) {
  const sh = shell || pickShell({ env, platform });
  // Git Bash on Windows: record the MSYS pid first (see killTree). Its own line, so the command
  // itself runs exactly as typed (heredocs, `$0`, exit codes).
  let msys = null;
  let script = command;
  if (platform === 'win32' && sh.kind === 'bash') {
    const pidFile = path.join(require('os').tmpdir(), `helm-sh-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.pid`);
    msys = { bash: sh.file, pidFile };
    script = `printf '%s' "$$" > '${pidFile.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n${command}`;
  }
  let done = false;
  const finish = (r) => {
    if (done) return;
    done = true;
    if (msys) fs.unlink(msys.pidFile, () => {});
    onExit(r);
  };
  let child;
  try {
    child = spawn(sh.file, sh.args(script), { cwd, env: childEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' });
  } catch (e) {
    setImmediate(() => finish({ code: null, signal: null, error: e }));
    return { pid: null, shell: sh.kind, stop() {} };
  }
  const streams = { stdout: textStream(), stderr: textStream() };
  for (const kind of ['stdout', 'stderr']) {
    child[kind].on('data', (b) => {
      const t = streams[kind].write(b);
      if (t) onData(kind, t);
    });
  }
  const flush = () => {
    for (const kind of ['stdout', 'stderr']) {
      const t = streams[kind].end();
      if (t) onData(kind, t);
    }
  };
  let exitInfo = null;
  child.on('error', (e) => {
    flush();
    finish({ code: null, signal: null, error: e });
  });
  child.on('close', (code, signal) => {
    flush();
    finish({ ...(exitInfo || { code, signal }), closed: true });
  });
  // A background grandchild can hold the pipes open after the shell exits: don't wait on it forever.
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    const t = setTimeout(() => {
      flush();
      finish({ ...exitInfo, closed: false }); // something still holds the pipes
    }, 1500);
    if (t.unref) t.unref();
  });
  return {
    pid: child.pid || null,
    shell: sh.kind,
    stop() {
      if (done) return;
      killTree(child.pid, platform, msys);
    },
  };
}

module.exports = {
  CONTEXT_MAX,
  DISPLAY_MAX,
  STOPPED_LINE,
  stripAnsi,
  collapseCR,
  middleTrim,
  shellContextBlock,
  prependContext,
  splitShellBlocks,
  pickShell,
  childEnv,
  killTree,
  runShell,
  StreamBuf,
};
