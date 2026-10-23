// Memory + main-process responsiveness of a real Helm in a hidden `--test` instance (throwaway profile, own port,
// off-screen window, stopped BY PID; never touches the user's Helm, port 4871 or %APPDATA%\Helm).
//   node tools/host-mem.js [--sessions=8] [--settle=12] [--lag=30] [--bg=snow-peak.jpg] [--blur=2]
// Reports, per Chromium process role (browser/main, renderer, gpu, utility): working set and private MB
//   idle      after startup settles
//   bg-none   background switched to none (what the photo + blur layer cost, renderer and GPU)
//   bg-back   background restored
// plus main-process lag: RPC round trips (settings.get) every 100 ms for --lag seconds while idle (p50/p99/max),
// and spawn -> first sidebar row (startup). Refuses to start when free RAM is under 2 GB.
// Owner: lane smooth.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const electronExe = require(path.join(ROOT, 'node_modules', 'electron'));
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const N = Number(arg('sessions', 8));
const SETTLE = Number(arg('settle', 12));
const LAG = Number(arg('lag', 30));
const BG = arg('bg', 'snow-peak.jpg');
const BLUR = Number(arg('blur', 2));
const EXTRA = (arg('electron-args', '') || '').split(' ').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freeMb() { return Math.round(os.freemem() / 1048576); }
function tree(rootPid) {
  const PS = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$keep = @{}; $keep[${rootPid}] = $true
for ($i = 0; $i -lt 6; $i++) { foreach ($p in $all) { if ($keep.ContainsKey([int]$p.ParentProcessId)) { $keep[[int]$p.ProcessId] = $true } } }
$out = foreach ($p in $all) { if ($keep.ContainsKey([int]$p.ProcessId)) { $g = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($g) { $t = 'browser'; if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; if ($p.CommandLine -match '--utility-sub-type=([\\w\\.]+)') { $t = $t + ':' + ($Matches[1] -replace '^.*\\.', '') }
    [pscustomobject]@{ pid = [int]$p.ProcessId; name = $p.Name; role = $t; ws = $g.WorkingSet64; priv = $g.PrivateMemorySize64; cpu = $g.TotalProcessorTime.TotalSeconds } } } }
@($out) | ConvertTo-Json -Compress`;
  const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  const list = JSON.parse(raw || '[]');
  return Array.isArray(list) ? list : [list];
}
const mb = (b) => Math.round(b / 1048576);
function summary(procs) {
  const by = {};
  for (const p of procs) { const k = p.name === 'electron.exe' || p.name === 'Helm.exe' ? p.role : p.name; (by[k] ||= { n: 0, ws: 0, priv: 0 }); by[k].n++; by[k].ws += p.ws; by[k].priv += p.priv; }
  const tot = procs.reduce((a, p) => ({ ws: a.ws + p.ws, priv: a.priv + p.priv }), { ws: 0, priv: 0 });
  return Object.entries(by).map(([k, v]) => `${k}${v.n > 1 ? 'x' + v.n : ''} ${mb(v.ws)}/${mb(v.priv)}`).join('  ') + `  | TOTAL ${mb(tot.ws)}/${mb(tot.priv)} MB (ws/private)`;
}

function rpcClient(ws) {
  let id = 1; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); } });
  return (method, params = {}) => new Promise((resolve) => {
    const i = id++;
    const t = setTimeout(() => { pending.delete(i); resolve({ error: { message: 'timeout' } }); }, 10000);
    pending.set(i, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
  });
}

(async () => {
  if (freeMb() < 2048) { console.error(`host-mem: only ${freeMb()} MB free RAM (< 2 GB); not starting a test instance`); process.exit(3); }
  const profile = `mem${process.pid}`;
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  fs.mkdirSync(userData, { recursive: true });
  const now = Date.now();
  const sessions = Array.from({ length: N }, (_, i) => ({ id: `s_mem${i}`, claudeSessionId: null, title: `Mem session ${i + 1}`, cwd: ROOT, project: 'helm', status: 'idle', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'default', createdAt: now - (i + 1) * 3600_000, updatedAt: now - i * 600_000, costUsd: 0, unread: 0, queued: 0, pinned: false }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ background: { kind: 'image', file: BG, blur: BLUR, dim: 0.35 } }));
  const t0 = Date.now();
  const child = spawn(electronExe, ['.', '--test', '--profile=' + profile, ...EXTRA], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  try {
    let ready = null;
    for (const end = Date.now() + 45000; !ready && Date.now() < end;) { const m = /HELM_READY (\{.*\})/.exec(out); if (m) ready = JSON.parse(m[1]); else await sleep(20); }
    if (!ready) throw new Error('no HELM_READY');
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); setTimeout(() => j(new Error('ws open timeout')), 10000); });
    ws.on('error', () => {});
    const call = rpcClient(ws);
    let painted = null;
    for (const end = Date.now() + 30000; !painted && Date.now() < end;) { const r = await call('test.eval', { js: `document.querySelector('.sidebar-scroll .srow, .home .hcard[data-sid]') ? Date.now() : null` }); if (r.result) painted = r.result; else await sleep(20); }
    console.log(`startup: spawn -> first sidebar row ${painted ? painted - t0 : 'never'} ms (HELM_READY at ${ready ? 'ok' : '-'})`);
    await sleep(SETTLE * 1000);
    console.log('idle      ' + summary(tree(child.pid)));
    const r0 = tree(child.pid).reduce((a, p) => a + p.cpu, 0);
    // main-process lag while idle: settings.get round trips
    const lat = []; const lagEnd = Date.now() + LAG * 1000;
    while (Date.now() < lagEnd) { const a = process.hrtime.bigint(); await call('settings.get'); lat.push(Number(process.hrtime.bigint() - a) / 1e6); await sleep(100); }
    const r1 = tree(child.pid).reduce((a, p) => a + p.cpu, 0);
    const s = [...lat].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
    console.log(`main lag (settings.get RTT, ${s.length} calls): p50 ${q(0.5)} ms  p99 ${q(0.99)} ms  max ${s[s.length - 1].toFixed(1)} ms;  idle CPU (whole tree, incl. the RTT probes) ${(((r1 - r0) / LAG) * 100).toFixed(2)}% of one core`);
    const heap = await call('test.eval', { js: `(() => { const m = performance.memory; return { heapMB: +(m.usedJSHeapSize / 1048576).toFixed(1), nodes: document.getElementsByTagName('*').length }; })()` });
    console.log('renderer heap', JSON.stringify(heap.result));
    await call('settings.set', { background: { kind: 'none' } });
    await sleep(6000);
    console.log('bg-none   ' + summary(tree(child.pid)));
    await call('settings.set', { background: { kind: 'image', file: BG, blur: BLUR, dim: 0.35 } });
    await sleep(6000);
    console.log('bg-back   ' + summary(tree(child.pid)));
    ws.close();
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(800);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
