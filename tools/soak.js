'use strict';
// Soak test: the real Helm (hidden, --test, throwaway profile) driving 3 REAL Claude Code
// sessions at once in 3 scratch git repos, while sampling resource use every 10 s.
//   - main process: app.getAppMetrics() + process.memoryUsage() through the Node inspector
//     (--inspect=0), per-PID working set / CPU for the whole Electron tree + claude.exe via CIM
//   - renderer: JS heap / DOM size / sidebar statuses / eval round-trip through CDP
//     (--remote-debugging-port=0), app.ping round-trip over the WS every 2 s
//   - WS event rate per session; captures of the hidden window at start / middle / end while
//     switching sessions (test.capture)
// Then checks: every session idle with a result item, no cross-talk, sidebar == WS status,
// clean main.log, memory before vs after, renderer responsive, claude.exe exits on close.
// Usage: node tools/soak.js [--exe=dist/Helm/Helm.exe] [--model=claude-haiku-5-5]
//        [--minutes=15] [--budget=0.9] [--keep]
// Cost: three multi-step turns + one queued + one question on --model; aborts (interrupt) when
// the summed session cost passes --budget.
const { spawn, execFileSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const MODEL = arg('model') || 'claude-haiku-5-5';
const MINUTES = Number(arg('minutes') || 15);
const BUDGET = Number(arg('budget') || 0.9);
const KEEP = process.argv.includes('--keep');
const SHOTS = path.join(ROOT, '.shots');
const profile = 'soak' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const base = path.join(os.tmpdir(), 'helm-soak-' + process.pid);
const OUT = path.join(SHOTS, 'soak-' + process.pid + '.json');
const exeArg = arg('exe') || (fs.existsSync(path.join(ROOT, 'dist', 'Helm', 'Helm.exe')) ? 'dist/Helm/Helm.exe' : null);
const electronExe = exeArg ? path.resolve(ROOT, exeArg) : require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';
const note = (...a) => console.log(stamp(), ...a);
const short = (o, n = 300) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s && s.length > n ? s.slice(0, n) + '…' : s; };
const MB = (b) => (b == null ? null : Math.round(b / 1048576));
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function projectDirFor(cwd) { return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); }

// ---------- scratch repos ----------
const LANES = [
  { key: 'A', tag: 'alpha', dir: path.join(base, 'alpha') },
  { key: 'B', tag: 'bravo', dir: path.join(base, 'bravo') },
  { key: 'C', tag: 'charlie', dir: path.join(base, 'charlie') },
];
function makeRepo(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'soak-' + tag, version: '1.0.0', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.txt'), `Scratch repo ${tag} for the Helm soak test.\n`);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=soak@helm.local', '-c', 'user.name=helm soak', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
}
const taskPrompt = (tag, extra = '') => `[soak ${tag}] ${extra}In this repo, build 8 small JavaScript modules named lib/${tag}1.js through lib/${tag}8.js. Each exports 2 small pure functions (string, array or math helpers; prefix every function name with "${tag}"). Work on ONE module at a time: write it with the Write tool, write test/${tag}N.test.js using node:test and node:assert, then run \`node --test test/\` with the Bash tool and fix any failure before starting the next module. Track the 8 modules with TodoWrite. Do not use sub-agents. When all 8 pass, reply with a short summary table (module, functions, tests).`;

// ---------- app ----------
// --app=HEAD runs a snapshot of the last commit (git archive into %TEMP%\helm-soak-<pid>\src,
// node_modules junctioned to the repo's) so other lanes' half-written edits can't break the run.
let APP = ROOT; let snapJunction = null;
function snapshotHead() {
  const snap = path.join(base, 'src'); const tar = path.join(base, 'src.tar');
  fs.mkdirSync(snap, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: ROOT });
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', tar, '-C', snap]);
  fs.rmSync(tar, { force: true });
  snapJunction = path.join(snap, 'node_modules');
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', snapJunction, path.join(ROOT, 'node_modules')], { stdio: 'ignore' });
  APP = snap;
  note(`app = snapshot of HEAD ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()} in ${snap}`);
}
function dropJunction() {
  if (!snapJunction || !fs.existsSync(snapJunction)) return true;
  try { execFileSync('cmd.exe', ['/c', 'rmdir', snapJunction], { stdio: 'ignore' }); } catch {}
  return !fs.existsSync(snapJunction) && fs.existsSync(path.join(ROOT, 'node_modules', 'ws'));
}
async function startApp() {
  if (arg('app') === 'HEAD') snapshotHead(); else if (arg('app')) APP = path.resolve(arg('app'));
  const args = [APP, '--test', '--profile=' + profile, '--inspect=0', '--remote-debugging-port=0'];
  const child = spawn(electronExe, args, { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const m = /HELM_READY (\{.*\})/.exec(out);
    if (m) {
      const ready = JSON.parse(m[1]);
      const insp = (/Debugger listening on (ws:\/\/\S+)/.exec(out) || [])[1] || null;
      const devtools = (/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(out) || [])[1] || null;
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      note(`app up: spawned pid ${child.pid}, main pid ${ready.pid}, port ${ready.port}, engine ${ready.engine}, exe ${ready.exe}`);
      note(`inspector ${insp ? 'yes' : 'NO'}, devtools port ${devtools || 'NO'}`);
      return { child, ready, out: () => out, c: client(ws), insp, devtools };
    }
    if (child.exitCode !== null) throw new Error('electron exited early:\n' + out.slice(-2000));
    await sleep(250);
  }
  killTree(child.pid);
  throw new Error('no HELM_READY within 60 s:\n' + out.slice(-2000));
}

function client(ws) {
  let id = 1;
  const pending = new Map();
  const events = [];
  const items = new Map();
  const sessions = new Map();
  const statusLog = new Map();
  const counter = new Map(); // sessionId -> { n, bytes } since last reset
  function itemsOf(sid) { if (!items.has(sid)) items.set(sid, new Map()); return items.get(sid); }
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
    if (m.type !== 'event') return;
    m.t = Date.now();
    events.push({ t: m.t, event: m.event, sid: m.data && (m.data.sessionId || (m.event.startsWith('session.') ? m.data.id : null)), data: m.event === 'session.itemUpdate' ? null : m.data });
    const d = m.data || {};
    const sid = d.sessionId || (m.event.startsWith('session.') ? d.id : null) || '_';
    const ctr = counter.get(sid) || { n: 0, bytes: 0 }; ctr.n++; ctr.bytes += raw.length; counter.set(sid, ctr);
    if (m.event === 'session.item') itemsOf(d.sessionId).set(d.item.id, { ...d.item });
    else if (m.event === 'session.itemUpdate') {
      const map = itemsOf(d.sessionId); const it = map.get(d.itemId);
      if (it) { Object.assign(it, d.patch || {}); if (d.appendText) it.text = (it.text || '') + d.appendText; }
    } else if (m.event === 'session.created' || m.event === 'session.updated') {
      sessions.set(d.id, d);
      if (!statusLog.has(d.id)) statusLog.set(d.id, []);
      const log = statusLog.get(d.id); const last = log[log.length - 1];
      if (!last || last.status !== d.status || last.queued !== d.queued) log.push({ t: m.t, status: d.status, queued: d.queued });
    }
  });
  async function call(method, params = {}, timeout = 30000) {
    const i = id++;
    const m = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, timeout);
      pending.set(i, (r) => { clearTimeout(t); resolve(r); });
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
    });
    if (m.error) throw Object.assign(new Error(`${method}: ${m.error.message}`), { code: m.error.code });
    return m.result;
  }
  return { ws, call, events, items, sessions, statusLog, itemsOf, counter };
}

// ---------- CDP (inspector on main, devtools on renderer) ----------
function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    let id = 1; const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    ws.once('open', () => resolve({
      ws,
      send(method, params = {}, timeout = 20000) {
        return new Promise((res, rej) => {
          const i = id++;
          const t = setTimeout(() => { pending.delete(i); rej(new Error('cdp ' + method + ' timed out')); }, timeout);
          pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result); });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      },
      async eval(expr, timeout) {
        const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
        if (r.exceptionDetails) throw new Error('eval: ' + short(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text, 300));
        return r.result.value;
      },
    }));
    ws.once('error', reject);
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

const MAIN_EXPR = `(() => { const { app } = process.mainModule.require('electron'); const mu = process.memoryUsage();
  return { metrics: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '', cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize * 1024, priv: (m.memory.privateBytes || 0) * 1024 })),
    mem: { rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, external: mu.external, arrayBuffers: mu.arrayBuffers } }; })()`;
const RENDERER_EXPR = `import('/lib/store.js').then((st) => ({
  heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null,
  nodes: document.getElementsByTagName('*').length,
  rows: [...document.querySelectorAll('.srow')].map((r) => ({ title: (r.querySelector('.srow-title') || r).textContent.trim(), st: ([...r.classList].find((c) => c.startsWith('st-')) || '').slice(3) })),
  store: st.sessions.value.map((s) => ({ id: s.id, status: s.status, queued: s.queued })),
  activeId: st.activeId.value,
  storeItems: Object.fromEntries(Object.entries(st.itemsBySession.value).map(([k, v]) => [k, v.length])),
}))`;

// ---------- process sampling (CIM, async so the WS keeps flowing) ----------
const CIM = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress`;
function cimSnapshot() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CIM], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ err: err.message, procs: [] });
      try { resolve({ t: Date.now(), procs: JSON.parse(stdout) }); } catch (e) { resolve({ err: e.message, procs: [] }); }
    });
  });
}
function descendants(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const out = []; const seen = new Set();
  const root = procs.find((p) => p.ProcessId === rootPid);
  const stack = root ? [root] : [];
  while (stack.length) { const p = stack.pop(); if (seen.has(p.ProcessId)) continue; seen.add(p.ProcessId); out.push(p); for (const k of kids.get(p.ProcessId) || []) stack.push(k); }
  return out;
}
function classify(p) {
  const cl = p.CommandLine || '';
  if (/claude\.exe$/i.test(p.Name)) return 'claude';
  const t = (/--type=([\w-]+)/.exec(cl) || [])[1];
  if (/^(helm|electron)\.exe$/i.test(p.Name)) return t ? (t === 'renderer' ? 'renderer' : t === 'gpu-process' ? 'gpu' : 'utility') : 'main';
  return 'other:' + p.Name;
}

// ---------- main ----------
let A = null;
const samples = [];
const pings = [];        // { t, ms } app.ping round-trips
const rpings = [];       // { t, ms } renderer eval round-trips
const shots = [];
const problems = [];
let prevCim = null;

async function sample(label, mainCdp, rendCdp, rootPid) {
  const s = { t: Date.now(), label, el: Math.round((Date.now() - T0) / 1000) };
  const cim = await cimSnapshot();
  if (cim.err) s.cimErr = cim.err;
  const tree = descendants(cim.procs, rootPid);
  const procs = tree.map((p) => {
    const cpuT = (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e4; // ms
    let cpu = null;
    const prev = prevCim && prevCim.map.get(p.ProcessId);
    if (prev != null) cpu = Math.round(((cpuT - prev) / (cim.t - prevCim.t)) * 1000) / 10; // % of one core
    return { pid: p.ProcessId, kind: classify(p), ws: Number(p.WorkingSetSize), priv: Number(p.PrivatePageCount), cpu };
  });
  prevCim = { t: cim.t, map: new Map(tree.map((p) => [p.ProcessId, (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e4])) };
  const agg = (k) => { const ps = procs.filter((p) => p.kind === k); return { n: ps.length, ws: ps.reduce((a, p) => a + p.ws, 0), cpu: ps.some((p) => p.cpu != null) ? Math.round(ps.reduce((a, p) => a + (p.cpu || 0), 0) * 10) / 10 : null }; };
  s.proc = { main: agg('main'), renderer: agg('renderer'), gpu: agg('gpu'), utility: agg('utility'), claude: agg('claude') };
  s.other = procs.filter((p) => p.kind.startsWith('other:')).map((p) => p.kind.slice(6) + ':' + MB(p.ws)).join(',');
  if (mainCdp) { try { const m = await mainCdp.eval(MAIN_EXPR, 10000); s.mainHeap = m.mem; s.appMetrics = m.metrics; } catch (e) { s.mainErr = e.message; } }
  if (rendCdp) {
    const t0 = Date.now();
    try { const r = await rendCdp.eval(RENDERER_EXPR, 15000); s.rendMs = Date.now() - t0; s.rend = r; } catch (e) { s.rendErr = e.message; }
  }
  s.ev = {};
  for (const [sid, v] of A.c.counter) s.ev[sid] = { n: v.n, kb: Math.round(v.bytes / 102.4) / 10 };
  A.c.counter.clear();
  s.status = {};
  for (const [sid, ss] of A.c.sessions) s.status[sid] = { st: ss.status, q: ss.queued, cost: ss.costUsd };
  samples.push(s);
  const evTot = Object.values(s.ev).reduce((a, v) => a + v.n, 0);
  note(`[${label}] main ${MB(s.proc.main.ws)}MB ${s.proc.main.cpu}% | rend ${MB(s.proc.renderer.ws)}MB ${s.proc.renderer.cpu}% heap ${s.rend && s.rend.heap ? MB(s.rend.heap.used) : '?'}MB nodes ${s.rend ? s.rend.nodes : '?'} | gpu ${MB(s.proc.gpu.ws)}MB ${s.proc.gpu.cpu}% | claude x${s.proc.claude.n} ${MB(s.proc.claude.ws)}MB ${s.proc.claude.cpu}% | mainHeap ${s.mainHeap ? MB(s.mainHeap.heapUsed) : '?'}MB | ev/10s ${evTot} | rendEval ${s.rendMs}ms | ${Object.values(s.status).map((x) => x.st + (x.q ? '+' + x.q : '')).join(',')}`);
  return s;
}

async function capture(sid, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `soak-${name}.png`);
  const t0 = Date.now();
  try {
    const r = await A.c.call('test.capture', { file, sessionId: sid, waitMs: 1500 }, 30000);
    shots.push({ file, sid, ms: Date.now() - t0, empty: r.empty, size: `${r.width}x${r.height}` });
    note(`captured ${file} ${r.width}x${r.height}${r.empty ? ' (EMPTY)' : ''} in ${Date.now() - t0}ms`);
  } catch (e) { note('capture failed: ' + e.message); problems.push('capture failed: ' + e.message); }
}

async function main() {
  fs.mkdirSync(base, { recursive: true });
  for (const l of LANES) makeRepo(l.dir, l.tag);
  note(`scratch repos under ${base}; model ${MODEL}; profile ${userData}; exe ${electronExe}`);
  A = await startApp();
  const c = A.c;
  const rootPid = A.child.pid;
  let mainCdp = null; let rendCdp = null;
  if (A.insp) { try { mainCdp = await cdp(A.insp); await mainCdp.send('Runtime.enable'); } catch (e) { problems.push('inspector connect failed: ' + e.message); } }
  if (A.devtools) {
    try {
      let page = null;
      for (let i = 0; i < 40 && !page; i++) {
        const list = await getJson(A.devtools, '/json/list');
        page = list.find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${A.ready.port}`) && !t.url.includes('/quick'));
        if (!page) await sleep(500);
      }
      if (page) rendCdp = await cdp(page.webSocketDebuggerUrl); else problems.push('no renderer page target');
    } catch (e) { problems.push('devtools connect failed: ' + e.message); }
  }
  await c.call('settings.set', { defaults: { model: MODEL, permissionMode: 'bypassPermissions', cwd: LANES[0].dir } });
  const hello = await c.call('app.hello');
  if (hello.engine !== 'real') throw new Error('engine is ' + hello.engine + ', not real');

  // ping loop: main-process WS round-trip + renderer eval round-trip every 2 s
  let pinging = true;
  (async () => {
    while (pinging) {
      const t0 = Date.now();
      try { await c.call('app.ping', {}, 20000); pings.push({ t: t0, ms: Date.now() - t0 }); } catch (e) { pings.push({ t: t0, ms: 20000, err: e.message }); }
      if (rendCdp) { const t1 = Date.now(); try { await rendCdp.eval('1+1', 20000); rpings.push({ t: t1, ms: Date.now() - t1 }); } catch (e) { rpings.push({ t: t1, ms: 20000, err: e.message }); } }
      await sleep(2000);
    }
  })();

  await sleep(8000);
  if (rendCdp) { try { await rendCdp.send('HeapProfiler.collectGarbage'); } catch {} }
  if (mainCdp) { try { await mainCdp.send('HeapProfiler.collectGarbage'); } catch {} }
  await sample('warmup', mainCdp, rendCdp, rootPid);
  await sleep(3000);
  const before = await sample('before', mainCdp, rendCdp, rootPid);
  if (process.argv.includes('--dry')) { // plumbing check only: no sessions, no spend
    note('dry: appMetrics ' + short(before.appMetrics, 400) + ' mainErr ' + before.mainErr + ' rendErr ' + before.rendErr + ' rows ' + short(before.rend && before.rend.rows));
    pinging = false; return [];
  }

  // create the three sessions and start their turns together
  for (const l of LANES) {
    const s = await c.call('sessions.create', { cwd: l.dir, model: MODEL, permissionMode: 'bypassPermissions' });
    l.sid = s.id; note(`session ${l.key} ${s.id} in ${l.dir}`);
  }
  const question = 'Which naming style should the helper functions use?';
  const prompts = {
    A: taskPrompt('alpha'),
    B: taskPrompt('bravo', `Before anything else, use the AskUserQuestion tool to ask me exactly one question: "${question}" with exactly two options: "camelCase" and "snake_case". Use my answer for every function name. Then: `),
    C: taskPrompt('charlie'),
  };
  const sendStart = Date.now();
  const sends = await Promise.all(LANES.map((l) => c.call('sessions.send', { id: l.sid, text: prompts[l.key] })));
  LANES.forEach((l, i) => note(`sent ${l.key}: ${short(sends[i])}`));

  const queuedText = '[soak charlie] Now add README.md listing every module in lib/ and its functions, run `node --test test/` one final time, and reply with only the pass count.';
  let queuedSent = null; let answered = null; let interrupted = false;
  const shotPlan = [{ at: 40, sid: 'A', name: 'start-A' }, { at: 45, sid: 'B', name: 'start-B' }];
  let midDone = false;
  const ROUND_CUTOFF = Math.max(60, MINUTES * 60 - 240); // stop handing out new rounds 4 min before the deadline
  const roundPrompt = (tag, n) => `[soak ${tag}] Round ${n}: for each module lib/${tag}1.js through lib/${tag}8.js, one at a time, add one more small pure function (name prefixed "${tag}") and a test for it in the matching test/${tag}N.test.js, run \`node --test test/\` with the Bash tool after each module and fix any failure. Do not use sub-agents. Then reply with one line: the total test count.`;
  const handled = new Set();
  const deadline = sendStart + MINUTES * 60000;
  let lastSample = Date.now();
  const resultsOf = (sid) => [...c.itemsOf(sid).values()].filter((it) => it.type === 'result');
  const lane = (k) => LANES.find((l) => l.key === k);
  for (;;) {
    const el = (Date.now() - sendStart) / 1000;
    // answer B's question (planned) and anything unplanned (auto: first option / allow)
    for (const l of LANES) {
      for (const it of c.itemsOf(l.sid).values()) {
        if (it.type !== 'request' || it.status !== 'pending' || handled.has(it.requestId)) continue;
        handled.add(it.requestId);
        let response;
        if (it.kind === 'question') {
          const answers = {};
          for (const q of it.questions || []) answers[q.question] = ((q.options || []).find((o) => /snake/i.test(o.label)) || (q.options || [])[0] || { label: 'snake_case' }).label;
          response = { answers };
          if (l.key === 'B' && !answered) answered = { t: Date.now(), requestId: it.requestId, answers };
          else problems.push(`unplanned question in ${l.key}: ${short(it.questions, 200)}`);
        } else { response = { behavior: 'allow' }; problems.push(`unplanned ${it.kind} request in ${l.key}: ${it.toolName}`); }
        note(`answering ${l.key} ${it.kind} ${short(response, 150)}`);
        c.call('sessions.respond', { id: l.sid, requestId: it.requestId, response }).catch((e) => problems.push(`respond ${l.key} failed: ${e.message}`));
      }
    }
    // queue a second prompt on C once it has a few tool calls in
    if (!queuedSent && [...c.itemsOf(lane('C').sid).values()].filter((it) => it.type === 'tool').length >= 4) {
      const st = c.sessions.get(lane('C').sid);
      const r = await c.call('sessions.send', { id: lane('C').sid, text: queuedText });
      queuedSent = { t: Date.now(), statusAtSend: st && st.status, result: r };
      note(`queued second prompt on C (status ${st && st.status}): ${short(r)}`);
    }
    for (const p of shotPlan) if (!p.done && el >= p.at) { p.done = true; await capture(lane(p.sid).sid, p.name); }
    if (Date.now() - lastSample >= 10000) { lastSample = Date.now(); await sample('run', mainCdp, rendCdp, rootPid); }
    // middle: once any session has finished or at ~half the expected run, switch through all three
    // keep every lane busy: when a lane has finished all it was given and there is time left, give it another round
    for (const l of LANES) {
      const s = c.sessions.get(l.sid);
      if (!l.expected) l.expected = l.key === 'C' ? 2 : 1;
      if (l.key === 'C' && !queuedSent) continue;
      if (s && s.status === 'idle' && !s.queued && resultsOf(l.sid).length >= l.expected && el < ROUND_CUTOFF && !interrupted && LANES.reduce((a, x) => a + ((c.sessions.get(x.sid) || {}).costUsd || 0), 0) < BUDGET * 0.6) {
        l.round = (l.round || 1) + 1; l.expected++;
        await c.call('sessions.send', { id: l.sid, text: roundPrompt(l.tag, l.round) });
        note(`round ${l.round} sent to ${l.key}`);
      }
    }
    const doneCount = LANES.filter((l) => resultsOf(l.sid).length >= (l.expected || 1) && (el >= ROUND_CUTOFF || interrupted || LANES.reduce((a, x) => a + ((c.sessions.get(x.sid) || {}).costUsd || 0), 0) >= BUDGET * 0.6)).length;
    if (!midDone && el > ROUND_CUTOFF / 2) { midDone = true; for (const l of LANES) await capture(l.sid, 'mid-' + l.key); }
    // budget guard
    const spent = LANES.reduce((a, l) => a + ((c.sessions.get(l.sid) || {}).costUsd || 0), 0);
    if (!interrupted && spent > BUDGET) { interrupted = true; problems.push(`budget guard: spent $${spent.toFixed(3)} > $${BUDGET}, interrupted all`); for (const l of LANES) await c.call('sessions.interrupt', { id: l.sid }).catch(() => {}); }
    const allIdle = LANES.every((l) => { const s = c.sessions.get(l.sid); return s && s.status === 'idle' && !s.queued; });
    if (doneCount === 3 && allIdle) break;
    if (Date.now() > deadline) { problems.push(`deadline ${MINUTES} min hit; doneCount ${doneCount}`); for (const l of LANES) await c.call('sessions.interrupt', { id: l.sid }).catch(() => {}); await sleep(5000); break; }
    await sleep(500);
  }
  const runEnd = Date.now();
  note(`all sessions done after ${((runEnd - sendStart) / 1000).toFixed(0)} s`);
  await sample('done', mainCdp, rendCdp, rootPid);
  for (const l of LANES) await capture(l.sid, 'end-' + l.key);

  // ---- checks ----
  const checks = [];
  const check = (name, ok, evidence) => { checks.push({ name, ok: !!ok, evidence }); note(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${short(evidence, 400)}`); };
  const hist = {};
  const softLeaks = [];
  for (const l of LANES) {
    const h = await c.call('sessions.history', { id: l.sid, limit: 2000 }, 60000);
    hist[l.key] = h.items;
  }
  for (const l of LANES) {
    const s = c.sessions.get(l.sid);
    const res = hist[l.key].filter((it) => it.type === 'result');
    const want = l.expected || 1;
    check(`${l.key} ends idle with ${want} result item(s)`, s.status === 'idle' && res.length >= want && res.every((r) => !r.isError),
      `status ${s.status}, results ${res.length} ${short(res.map((r) => ({ cost: r.costUsd, turns: r.numTurns, ms: r.durationMs, err: r.isError })))}`);
    const tools = hist[l.key].filter((it) => it.type === 'tool');
    const others = LANES.filter((o) => o !== l);
    const leaks = [];
    for (const it of hist[l.key]) {
      const blob = JSON.stringify(it.input || '') + ' ' + (it.type === 'tool' ? '' : (it.text || ''));
      for (const o of others) {
        // a real leak names the other lane's modules (bravo3, bravo_x, bravoX) or its repo dir; "isAlpha"/"alphanumeric" are not
        const m = new RegExp('(?<![A-Za-z_])' + o.tag + '(?=\\d|_[a-z]|[A-Z])').exec(blob);
        const dirHit = [o.dir, o.dir.replace(/\\/g, '/'), o.dir.replace(/\\/g, '\\\\')].some((d) => blob.includes(d));
        const at = m ? m.index : blob.indexOf(o.tag);
        const ctx = `…${blob.slice(Math.max(0, at - 80), at + 60)}…`;
        if (m || dirHit) leaks.push(`${it.type}:${it.id} mentions ${o.tag}: ${ctx}`);
        else if (at >= 0) softLeaks.push(`${l.key} ${it.type}:${it.id} contains "${o.tag}" (not a module/dir name): ${ctx}`);
      }
    }
    check(`${l.key} no cross-talk (history items mention only ${l.tag})`, leaks.length === 0, leaks.length ? leaks.slice(0, 5).join('; ') : `${hist[l.key].length} items, ${tools.length} tool items`);
    // WS mirror vs history: same item ids
    const wsIds = new Set(c.itemsOf(l.sid).keys());
    const hIds = new Set(hist[l.key].map((it) => it.id));
    const missing = [...hIds].filter((x) => !wsIds.has(x)); const extra = [...wsIds].filter((x) => !hIds.has(x));
    check(`${l.key} WS-streamed items == sessions.history items`, missing.length === 0 && extra.length === 0, `ws ${wsIds.size}, history ${hIds.size}, missing-from-ws ${missing.length} ${short(missing.slice(0, 3))}, extra-in-ws ${extra.length} ${short(extra.slice(0, 3))}`);
    const files = fs.existsSync(path.join(l.dir, 'lib')) ? fs.readdirSync(path.join(l.dir, 'lib')) : [];
    const testsDir = fs.existsSync(path.join(l.dir, 'test')) ? fs.readdirSync(path.join(l.dir, 'test')) : [];
    check(`${l.key} files landed in its own repo only`, files.length >= 8 && files.every((f) => f.startsWith(l.tag)) && testsDir.every((f) => f.startsWith(l.tag)), `lib ${short(files)} test ${short(testsDir)}`);
  }
  if (softLeaks.length) note('substring-only mentions (not counted as leaks): ' + short(softLeaks.slice(0, 4), 900));
  // events tagged with a sessionId must reference a known item in that session
  const sidSet = new Set(LANES.map((l) => l.sid));
  const strayEv = c.events.filter((e) => e.sid && !sidSet.has(e.sid) && e.sid !== '_');
  check('no events for unknown session ids', strayEv.length === 0, `${strayEv.length} ${short(strayEv.slice(0, 3).map((e) => e.event + ':' + e.sid))}`);
  // queued prompt
  const cUser = hist.C.filter((it) => it.type === 'user');
  check('queued prompt on C was queued and later ran', queuedSent && queuedSent.result && queuedSent.result.queued === true && cUser.some((u) => (u.text || '').includes('README.md listing')),
    `send result ${short(queuedSent && queuedSent.result)} status-at-send ${queuedSent && queuedSent.statusAtSend}; C user items ${cUser.length}`);
  const bReq = hist.B.find((it) => it.type === 'request' && it.kind === 'question');
  check('AskUserQuestion on B answered', bReq && bReq.status === 'answered' && answered, `request ${short(bReq && { status: bReq.status, answer: bReq.answer })}`);
  const bSrc = LANES[1].dir; const bLib = fs.existsSync(path.join(bSrc, 'lib')) ? fs.readdirSync(path.join(bSrc, 'lib')).map((f) => fs.readFileSync(path.join(bSrc, 'lib', f), 'utf8')).join('\n') : '';
  check('B used the answer (snake_case function names)', /bravo_[a-z]/.test(bLib), short((bLib.match(/function\s+\w+|\b\w+\s*[:=]\s*(\(|function)/g) || []).slice(0, 6)));
  // sidebar vs WS status, every sample with a renderer read
  const mism = [];
  for (const s of samples) {
    if (!s.rend) continue;
    for (const l of LANES) {
      const ws = s.status[l.sid]; const ss = c.sessions.get(l.sid);
      const st = s.rend.store.find((x) => x.id === l.sid);
      if (ws && st && ws.st !== st.status) mism.push(`t=${s.el}s ${l.key} store ${st.status} vs ws ${ws.st}`);
      const row = s.rend.rows.find((r) => ss && r.title && ss.title && r.title.includes(ss.title.slice(0, 20)));
      if (ws && row && row.st !== ws.st) mism.push(`t=${s.el}s ${l.key} sidebar ${row.st} vs ws ${ws.st}`);
    }
  }
  const lastR = samples.filter((s) => s.rend).slice(-1)[0];
  check('sidebar/store statuses match WS (all samples)', mism.length <= 1 && lastR && lastR.rend.rows.length >= 3, `${mism.length} mismatches ${short(mism.slice(0, 6))}; last rows ${short(lastR && lastR.rend.rows)}`);

  // responsiveness
  const heavy = samples.filter((s) => s.label === 'run').sort((a, b) => Object.values(b.ev).reduce((x, v) => x + v.n, 0) - Object.values(a.ev).reduce((x, v) => x + v.n, 0))[0];
  const runPings = pings.filter((p) => p.t >= sendStart && p.t <= runEnd).map((p) => p.ms).sort((a, b) => a - b);
  const runR = rpings.filter((p) => p.t >= sendStart && p.t <= runEnd).map((p) => p.ms).sort((a, b) => a - b);
  const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null);
  const heavyPing = heavy ? pings.filter((p) => Math.abs(p.t - heavy.t) < 10000).map((p) => p.ms) : [];
  check('app.ping stays fast during streaming (p95 < 250 ms, max < 1000 ms)', pct(runPings, 0.95) < 250 && runPings[runPings.length - 1] < 1000,
    `n ${runPings.length} p50 ${pct(runPings, 0.5)} p95 ${pct(runPings, 0.95)} max ${runPings[runPings.length - 1]} ms; at heaviest sample (t=${heavy && heavy.el}s, ${heavy && Object.values(heavy.ev).reduce((x, v) => x + v.n, 0)} ev/10s) ${short(heavyPing)}`);
  check('renderer eval stays fast during streaming (p95 < 250 ms, max < 1000 ms)', runR.length && pct(runR, 0.95) < 250 && runR[runR.length - 1] < 1000,
    `n ${runR.length} p50 ${pct(runR, 0.5)} p95 ${pct(runR, 0.95)} max ${runR[runR.length - 1]} ms; heaviest-sample store read ${heavy && heavy.rendMs} ms`);

  // close sessions; claude.exe must exit
  const claudeBefore = samples[samples.length - 1].proc.claude.n;
  for (const l of LANES) await c.call('sessions.close', { id: l.sid }).catch((e) => problems.push(`close ${l.key}: ${e.message}`));
  let claudeAfter = null; let exitMs = null;
  const closeT = Date.now();
  for (let i = 0; i < 20; i++) {
    const cim = await cimSnapshot();
    claudeAfter = descendants(cim.procs, rootPid).filter((p) => /claude\.exe$/i.test(p.Name)).length;
    if (claudeAfter === 0) { exitMs = Date.now() - closeT; break; }
    await sleep(1000);
  }
  check('claude.exe processes exit after sessions.close', claudeAfter === 0, `before close ${claudeBefore}, after ${claudeAfter} (${exitMs != null ? exitMs + ' ms' : 'still alive after ~20 s'})`);
  const closedSt = LANES.map((l) => (c.sessions.get(l.sid) || {}).status);
  check('sessions report closed after close', closedSt.every((s) => s === 'closed'), short(closedSt));

  // memory after: settle, GC both, sample
  await sleep(10000);
  if (rendCdp) { try { await rendCdp.send('HeapProfiler.collectGarbage'); } catch {} }
  if (mainCdp) { try { await mainCdp.send('HeapProfiler.collectGarbage'); } catch {} }
  await sleep(3000);
  const after = await sample('after', mainCdp, rendCdp, rootPid);
  const peak = (f) => Math.max(...samples.map(f).filter((x) => x != null));
  const d = (f) => ({ before: f(before), peak: peak(f), after: f(after) });
  const mem = {
    mainWS: d((s) => MB(s.proc.main.ws)), rendWS: d((s) => MB(s.proc.renderer.ws)), gpuWS: d((s) => MB(s.proc.gpu.ws)), utilWS: d((s) => MB(s.proc.utility.ws)),
    claudeWS: d((s) => MB(s.proc.claude.ws)), claudeN: d((s) => s.proc.claude.n),
    mainHeap: d((s) => s.mainHeap && MB(s.mainHeap.heapUsed)), rendHeap: d((s) => s.rend && s.rend.heap && MB(s.rend.heap.used)), rendNodes: d((s) => s.rend && s.rend.nodes),
    mainCpu: d((s) => s.proc.main.cpu), rendCpu: d((s) => s.proc.renderer.cpu), gpuCpu: d((s) => s.proc.gpu.cpu), claudeCpu: d((s) => s.proc.claude.cpu),
  };
  console.log('\n--- measurements (MB / % of one core) before / peak / after ---');
  for (const [k, v] of Object.entries(mem)) console.log(`  ${k.padEnd(10)} ${String(v.before).padStart(6)} ${String(v.peak).padStart(6)} ${String(v.after).padStart(6)}`);
  check('main JS heap after <= before + 30 MB (leak?)', mem.mainHeap.after != null && mem.mainHeap.after - mem.mainHeap.before <= 30, short(mem.mainHeap));
  check('renderer JS heap after <= before + 40 MB (leak?)', mem.rendHeap.after != null && mem.rendHeap.after - mem.rendHeap.before <= 40, short(mem.rendHeap));
  check('main+renderer working set after <= before + 150 MB', mem.mainWS.after + mem.rendWS.after - mem.mainWS.before - mem.rendWS.before <= 150, `main ${short(mem.mainWS)} rend ${short(mem.rendWS)}`);

  // log
  const logTxt = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  const bad = logTxt.split(/\r?\n/).filter((l) => /\b(error|threw|failed|unhandled|exception|renderer gone)\b/i.test(l));
  check('no error lines in main.log', bad.length === 0, `${bad.length} lines; ${short(bad.slice(0, 8).map((l) => l.slice(0, 220)))}`);
  const logLines = logTxt.split(/\r?\n/).length;

  // spend
  const spend = LANES.map((l) => ({ key: l.key, session: (c.sessions.get(l.sid) || {}).costUsd, results: hist[l.key].filter((it) => it.type === 'result').reduce((a, r) => a + (r.costUsd || 0), 0) }));
  const total = spend.reduce((a, s) => a + s.results, 0);
  console.log(`\nspend by result items: ${spend.map((s) => `${s.key} $${s.results.toFixed(4)} (session $${(s.session || 0).toFixed(4)})`).join(', ')}; total $${total.toFixed(4)}`);

  const evByType = {};
  for (const e of c.events) evByType[e.event] = (evByType[e.event] || 0) + 1;
  const evRates = samples.filter((s) => s.label === 'run').map((s) => LANES.map((l) => (s.ev[l.sid] || { n: 0 }).n));
  const evPeak = LANES.map((_, i) => Math.max(0, ...evRates.map((r) => r[i])));
  console.log(`events total ${c.events.length} by type ${JSON.stringify(evByType)}; peak per-session events/10s A/B/C ${evPeak.join('/')}`);
  const turns = LANES.map((l) => `${l.key}: ${hist[l.key].filter((it) => it.type === 'tool').length} tools, ${hist[l.key].length} items`).join('; ');
  console.log('history: ' + turns + `; main.log ${logLines} lines`);

  fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, exe: electronExe, lanes: LANES, mem, checks, problems, spend, total, evByType, evPeak, shots, pings, rpings, samples: samples.map((s) => ({ ...s, appMetrics: s.appMetrics })), statusLog: Object.fromEntries(c.statusLog), queuedSent, answered, turns: Object.fromEntries(LANES.map((l) => [l.key, hist[l.key].filter((r) => r.type === "result").map((r) => ({ cost: r.costUsd, turns: r.numTurns, ms: r.durationMs, err: r.isError, usage: r.usage }))])), logBad: bad.slice(0, 50) }, null, 1));
  console.log('raw data ' + OUT);
  pinging = false;
  try { mainCdp && mainCdp.ws.close(); } catch {}
  try { rendCdp && rendCdp.ws.close(); } catch {}
  return checks;
}

(async () => {
  let checks = []; let crashed = null;
  try { checks = await main(); } catch (e) { crashed = e; console.error('soak crashed:', e.stack || e.message); }
  finally {
    if (A) {
      if (crashed) { try { const t = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split(/\r?\n/).filter((l) => /error|threw|failed/i.test(l)).slice(-10); for (const l of t) console.log('  log: ' + l.slice(0, 250)); } catch {} }
      try { A.c.ws.close(); } catch {}
      killTree(A.child.pid);
      await sleep(2000);
    }
    const dirs = LANES.map((l) => projectDirFor(l.dir)).filter((p) => fs.existsSync(p));
    console.log('transcript dirs from this run: ' + JSON.stringify(dirs));
    if (!KEEP) {
      for (const p of dirs) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { console.log('could not delete ' + p + ': ' + e.message); } }
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
      if (dropJunction()) { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }
      else console.log(`NOT deleting ${base}: node_modules junction still present (remove it with rmdir first)`);
    } else console.log(`kept ${base} ${userData}`);
  }
  console.log('\n=== soak summary ===');
  for (const k of checks) console.log(`${k.ok ? 'PASS' : 'FAIL'}  ${k.name}`);
  if (problems.length) console.log('problems: ' + problems.join(' | '));
  const pass = checks.filter((k) => k.ok).length;
  console.log(`soak: ${pass} passed, ${checks.length - pass} failed${crashed ? ', CRASHED' : ''}`);
  process.exitCode = crashed ? 2 : checks.length - pass ? 1 : 0;
})();
