// Cold-start benchmark: process launch -> session list painted, in hidden `--test` instances (throwaway
// profiles seeded with a few sessions, off-screen window, stopped BY PID). Used to decide whether the
// <link rel="modulepreload"> block in ui/index.html earns its place.
//   node tools/bench-startup.js [--runs=5]            A/B: alternates "none" (no block) and
//                                                     "preload" (block present), then restores index.html
//   node tools/bench-startup.js --runs=3 --only        just the current index.html
// Reports per run: total = spawn -> first .srow (or Home card .hcard: Helm opens on Home) in the DOM (ms), page = navigation start -> same (ms),
// js = .js resources fetched. Never touches the user's Helm: own port, own profile, kill by PID.
// Owner: lane git-export.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { withBlock, withoutBlock } = require('./gen-modulepreload');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'ui', 'index.html');
const electronExe = require(path.join(ROOT, 'node_modules', 'electron'));
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const RUNS = Number(arg('runs', 5));
const ONLY = process.argv.includes('--only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

function seed(userData) {
  fs.mkdirSync(userData, { recursive: true });
  const now = Date.now();
  const sessions = Array.from({ length: 8 }, (_, i) => ({
    id: `s_bench${i}`, claudeSessionId: null, title: `Bench session ${i + 1}`, cwd: ROOT, project: 'helm',
    status: 'idle', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'default',
    createdAt: now - (i + 1) * 3600_000, updatedAt: now - i * 600_000, costUsd: 0, unread: 0, queued: 0, pinned: false,
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
}

function rpcClient(ws) {
  let id = 1; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); } });
  return (method, params = {}) => new Promise((resolve) => {
    const i = id++;
    const t = setTimeout(() => { pending.delete(i); resolve({ error: { message: 'timeout' } }); }, 3000);
    pending.set(i, (m) => { clearTimeout(t); resolve(m); });
    try { ws.send(JSON.stringify({ id: i, type: 'rpc', method, params })); } catch (e) { clearTimeout(t); pending.delete(i); resolve({ error: { message: e.message } }); }
  });
}

const PROBE = `(() => {
  const row = document.querySelector('.sidebar-scroll .srow, .home .hcard[data-sid]');
  if (!row) return null;
  const js = performance.getEntriesByType('resource').filter((e) => /\\.js(\\?|$)/.test(e.name));
  return { at: Date.now(), page: Math.round(performance.now()), js: js.length,
    jsDone: Math.round(Math.max(0, ...js.map((e) => e.responseEnd))) };
})()`;

async function once(tag) {
  const profile = `bench${process.pid}-${tag}`;
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  seed(userData);
  const t0 = Date.now();
  const child = spawn(electronExe, ['.', '--test', '--profile=' + profile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  try {
    let ready = null;
    const deadline = Date.now() + 45_000;
    while (!ready && Date.now() < deadline) { const m = /HELM_READY (\{.*\})/.exec(out); if (m) ready = JSON.parse(m[1]); else await sleep(5); }
    if (!ready) throw new Error('no HELM_READY');
    const tReady = Date.now() - t0;
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('close', () => j(new Error('ws closed'))); setTimeout(() => j(new Error('ws open timeout')), 10_000); });
    ws.on('error', () => {});
    const call = rpcClient(ws);
    let probe = null;
    const until = Date.now() + 30_000;
    while (!probe && Date.now() < until) {
      const r = await call('test.eval', { js: PROBE });
      if (r.result) probe = r.result; else await sleep(8);
    }
    ws.close();
    if (!probe) throw new Error('session list never painted');
    return { total: probe.at - t0, ready: tReady, page: probe.page, js: probe.js, jsDone: probe.jsDone };
  } finally {
    killTree(child.pid);
    await sleep(400);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2); };

async function main() {
  const original = fs.readFileSync(INDEX, 'utf8');
  // Both arms are built from the current file, whether or not it carries the block; the file is restored after.
  const variants = ONLY ? [['current', original]] : [['none', withoutBlock(original)], ['preload', withBlock(original)]];
  const res = Object.fromEntries(variants.map(([k]) => [k, []]));
  try {
    console.log('warm-up run (discarded)');
    await once('warm');
    for (let i = 0; i < RUNS; i++) {
      // alternate the order every round so neither arm always goes first
      const round = i % 2 ? [...variants].reverse() : variants;
      for (const [k, html] of round) {
        fs.writeFileSync(INDEX, html);
        const r = await once(`${k}${i}`);
        res[k].push(r);
        console.log(`run ${i + 1} ${k.padEnd(7)} total ${r.total} ms  page ${r.page} ms  (ready ${r.ready} ms, ${r.js} js, last js at ${r.jsDone} ms)`);
      }
    }
  } finally {
    fs.writeFileSync(INDEX, original);
  }
  for (const [k] of variants) {
    const a = res[k];
    if (!a.length) continue;
    console.log(`${k.padEnd(7)} median total ${median(a.map((r) => r.total))} ms, page ${median(a.map((r) => r.page))} ms, last js ${median(a.map((r) => r.jsDone))} ms  (n=${a.length}; totals ${a.map((r) => r.total).join(', ')})`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
