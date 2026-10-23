// End-to-end proof of update detection + auto-restart in the REAL app (lane restart):
// a hidden `Helm.exe --test` watching a TEMP git repo (HELM_TEST_UPDATE_REPO), allowed to really relaunch
// itself (HELM_TEST_ALLOW_RESTART), with short timings (HELM_TEST_UPDATE_TIMING). Steps:
//   commit to the temp repo -> pending -> blocked while a live claude-haiku-5-5 session works and while
//   its background Bash (run_in_background) still runs -> restarts once idle -> the relaunched instance
//   reports the commit (update.restarted) and its window shows the "Helm restarted" toast with the
//   session still selected -> stop it by its PID.
// Never touches port 4871, %APPDATA%\Helm or any process it did not start (the relaunched instance's PID
// comes from its own ready.json in the throwaway profile). Summary line: `restart-e2e: N passed, M failed`.
// Usage: node tools/restart-e2e.js [--exe=dist/Helm/Helm.exe] [--keep]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { dropLiveTranscripts } = require('./live-cleanup');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const EXE = path.resolve(ROOT, arg('exe') || 'dist/Helm/Helm.exe');
const KEEP = process.argv.includes('--keep');
const profile = 'rs' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const repo = path.join(os.tmpdir(), 'helm-restart-e2e-' + process.pid);
const TIMING = { pollMs: 2000, quietMs: 6000, gateMs: 3000, confirmMs: 1000, inputQuietMs: 10000 };
const T0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 23);
const note = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => { results.push({ ok: !!ok, what }); console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${what}`); return ok; };
const started = new Set(); // PIDs this script started (directly, or the relaunch of one of them)
// only a live process whose command line carries THIS run's throwaway profile (a PID can be reused)
const ours = (pid) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8' }).includes('--profile=' + profile); } catch { return false; } };
const killTree = (pid) => { if (!ours(pid)) return; try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8', windowsHide: true }).trim();

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
function connect(port, token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    let id = 1;
    const pending = new Map(), events = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
      if (m.type === 'event') events.push({ t: Date.now(), ...m });
    });
    const rpc = (method, params = {}) => new Promise((ok, bad) => {
      const i = id++;
      pending.set(i, (m) => (m.error ? bad(Object.assign(new Error(m.error.message), { code: m.error.code })) : ok(m.result)));
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      setTimeout(() => { if (pending.delete(i)) bad(new Error(`${method} timed out`)); }, 30000);
    });
    ws.on('close', () => { for (const [i, p] of pending) { pending.delete(i); p({ error: { message: 'connection closed', code: 'closed' } }); } });
    ws.once('open', () => res({ ws, rpc, events }));
    ws.once('error', rej);
  });
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function main() {
  const freeGb = Number(execFileSync('powershell', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)'], { encoding: 'utf8' }).trim());
  note(`free RAM ${freeGb} GB`);
  if (!(freeGb > 1.5)) throw new Error('less than 1.5 GB free RAM: not starting a test instance');

  fs.mkdirSync(path.join(repo, 'main'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  fs.writeFileSync(path.join(repo, 'main', 'x.js'), '// v1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const first = git('rev-parse', 'HEAD');
  const port = await freePort();
  note(`temp repo ${repo} @ ${first.slice(0, 7)}; profile ${profile}; port ${port}`);

  const env = { ...process.env, HELM_TEST_UPDATE_REPO: repo, HELM_TEST_ALLOW_RESTART: '1', HELM_TEST_UPDATE_TIMING: JSON.stringify(TIMING) };
  const child = spawn(EXE, [ROOT, '--test', '--profile=' + profile, '--port=' + port], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  started.add(child.pid);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let ready = null;
  for (const end = Date.now() + 60000; Date.now() < end && !ready; await sleep(250)) {
    const m = /HELM_READY (\{.*\})/.exec(out);
    if (m) ready = JSON.parse(m[1]);
    if (child.exitCode !== null) throw new Error('app exited early:\n' + out.slice(-1500));
  }
  if (!ready) throw new Error('no HELM_READY in 60 s');
  started.add(ready.pid);
  note(`instance 1 up: pid ${ready.pid} port ${ready.port}`);
  let c = await connect(port, ready.token);
  const h = await c.rpc('app.hello');
  check(h.update && h.update.running && h.update.running.sha === first, `app.hello update.running = temp repo HEAD ${first.slice(0, 7)} (${h.update && h.update.running && h.update.running.subject})`);
  check(h.update && h.update.pending === null && h.update.restarted === null, 'nothing pending, not restarted at boot');

  // a manual restart while idle-but-test is allowed; check app.restartCheck answers instead (no restart yet)
  const rc0 = await c.rpc('app.restartCheck');
  check(Array.isArray(rc0.reasons) && rc0.reasons.length === 0, `app.restartCheck idle -> ${JSON.stringify(rc0.reasons)}`);

  // a live session that works for a while and leaves a background shell running
  const s = await c.rpc('sessions.create', { cwd: repo, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'bypassPermissions',
    prompt: 'Use the Bash tool with run_in_background set to true to run exactly this command: sleep 20\nThen reply with the single word started. Do not wait for it, do not check on it, do not run anything else.' });
  note(`session ${s.id} created`);
  await c.rpc('test.eval', { js: `import('/lib/store.js').then((m) => { m.selectSession(${JSON.stringify(s.id)}); return true; })` });
  for (const end = Date.now() + 60000; Date.now() < end; await sleep(500)) {
    const ss = (await c.rpc('app.hello')).sessions.find((x) => x.id === s.id);
    if (ss && ss.status === 'working') break;
  }
  const rcBusy = await c.rpc('app.restartCheck');
  check(rcBusy.reasons.some((r) => /working|starting/.test(r)), `app.restartCheck while working -> ${JSON.stringify(rcBusy.reasons)}`);
  let refused = null;
  try { await c.rpc('app.restart', {}); } catch (e) { refused = e; }
  check(refused && refused.code === 'busy', `app.restart without force while busy refused: ${refused && refused.code} "${refused && refused.message}"`);

  git('commit', '-q', '--allow-empty', '-m', 'feat: e2e update one');
  const second = git('rev-parse', 'HEAD');
  note(`committed ${second.slice(0, 7)} "feat: e2e update one" while the session works`);

  // watch the update state until the instance goes away
  const seen = new Map();
  let closedAt = null;
  c.ws.on('close', () => { closedAt = Date.now(); });
  for (const end = Date.now() + 180000; Date.now() < end && !closedAt; await sleep(700)) {
    let st = null;
    try { st = await c.rpc('app.updateState'); } catch { break; }
    const sess = (await c.rpc('app.hello').catch(() => ({ sessions: [] }))).sessions.find((x) => x.id === s.id) || {};
    const key = st.pending ? `${st.pending.phase}: ${st.pending.reason}` : 'none';
    if (!seen.has(key)) { seen.set(key, Date.now()); note(`update state -> ${key}  [session ${sess.status}, openTasks ${sess.openTasks}, agents ${sess.agentsRunning}]`); }
  }
  const keys = [...seen.keys()];
  check(keys.some((k) => k.startsWith('settling')), 'pending: settling (quiet period) seen');
  check(keys.some((k) => /waiting: .*session working/.test(k)), 'blocked while the session works');
  check(keys.some((k) => /background task running/.test(k)), 'blocked while its background shell runs (openTasks)');
  check(keys.some((k) => k.startsWith('restarting')) || closedAt, `restart started (connection closed ${closedAt ? new Date(closedAt).toISOString().slice(11, 23) : 'never'})`);

  // the relaunched instance: a new pid in the profile's ready.json
  let next = null;
  for (const end = Date.now() + 90000; Date.now() < end; await sleep(500)) {
    const r = readJson(path.join(userData, 'ready.json'));
    if (r && r.pid !== ready.pid) { next = r; break; }
  }
  if (!check(next, `relaunched instance came up: ${next ? `pid ${next.pid} port ${next.port}` : 'no'}`)) return;
  started.add(next.pid);
  check(next.port === port, `same port after restart (${next.port})`);
  c = await connect(next.port, next.token);
  const h2 = await c.rpc('app.hello');
  const r = h2.update && h2.update.restarted;
  check(r && r.auto === true && r.to === second && r.commits[0] && r.commits[0].subject === 'feat: e2e update one', `update.restarted names the commit: ${JSON.stringify(r && { auto: r.auto, to: r.to && r.to.slice(0, 7), commits: r.commits })}`);
  check(h2.update.running.sha === second && !h2.update.pending, `running ${h2.update.running.short} "${h2.update.running.subject}", nothing pending`);
  check(h2.sessions.some((x) => x.id === s.id), 'the session is still there');
  let ui = null;
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(500)) {
    ui = await c.rpc('test.eval', { js: `import('/lib/store.js').then((m) => ({ active: m.activeId.value, seen: localStorage.getItem('helm.restartedSeen'), toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()) }))` }).catch(() => null);
    if (ui && ui.toasts.some((t) => /Helm restarted/.test(t))) break;
  }
  check(ui && ui.toasts.some((t) => t.includes('Helm restarted · feat: e2e update one (' + second.slice(0, 7) + ')')), `toast: ${JSON.stringify(ui && ui.toasts)}`);
  check(ui && ui.seen === String(r && r.at), `the toast fired once for this restart (helm.restartedSeen = ${ui && ui.seen})`);
  check(ui && ui.active === s.id, `window reopened on the same session (${ui && ui.active})`);

}

main().catch((e) => { check(false, 'threw: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }).finally(async () => {
  try {
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split('\n');
    for (const l of log.filter((x) => /update:|restart|task_started|task_notification|background_tasks_changed|shutting down|listening on|boot failed|uncaught/.test(x))) console.log('  log ' + l.slice(0, 330));
  } catch (e) { console.log('  (no profile log: ' + e.message + ')'); }
  for (const pid of started) killTree(pid);
  await sleep(1500);
  if (!KEEP) console.log(`  cleaned up ${dropLiveTranscripts([repo]).length} transcript folder(s)`); // repo's ~/.claude/projects folder
  if (!KEEP) { for (const d of [repo, userData]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
  const pass = results.filter((x) => x.ok).length;
  console.log(`restart-e2e: ${pass} passed, ${results.length - pass} failed (${((Date.now() - T0) / 1000).toFixed(0)} s; stopped PIDs ${[...started].join(', ')})`);
});
