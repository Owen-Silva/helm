// lane detach (wk/detach): end-to-end proof that a running turn SURVIVES a Helm restart when the CLIs live in the
// broker (Settings "Keep sessions running through a restart", turned on over RPC; main/engine/broker.js). A hidden `--test` instance (off-screen window,
// throwaway profile, its own port) with an empty throwaway CLAUDE_CONFIG_DIR (Claude Code authenticates with ANTHROPIC_API_KEY),
// allowed to really relaunch itself (HELM_TEST_ALLOW_RESTART):
//   1. a live claude-haiku-5-5 session starts a slow 3-step turn (two 25 s foreground commands, then a file write)
//   2. mid-way through step 1, app.restart { force: true }
//   3. the old Helm process is gone, the SAME claude.exe pid is still alive (the broker kept it)
//   4. the relaunched Helm re-attaches: the session is working again with no restart note, then finishes; the file
//      from step 3 exists; the conversation shows the steps that ran after the restart and the final reply
//   5. a follow-up message goes through the re-attached CLI (still the same pid)
//   6. The user's rule: a MANUAL close (the window closed / Quit: app.quit with no restart intent) stops everything:
//      Helm, the CLI and the broker are all gone, nothing is kept
// Guards: >= 2.5 GB free RAM, the machine-wide %TEMP%\claude-headless-browser.lock, ANTHROPIC_API_KEY set (else SKIP, exit 2).
// Kills only the PIDs it started (Electron instances, and the broker whose command line names this run's profile).
// Summary line: `detach-e2e: N passed, M failed`. Usage: node tools/detach-e2e.js [--keep] [--shot=dir]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { dropLiveTranscripts } = require('./live-cleanup');
const { createBrokerClient } = require('../main/engine/broker-client');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const EXE = require(path.join(ROOT, 'node_modules', 'electron'));
const KEEP = process.argv.includes('--keep');
const SHOTS = path.resolve(arg('shot') || os.tmpdir());
fs.mkdirSync(SHOTS, { recursive: true });
const profile = 'dt' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const repo = path.join(os.tmpdir(), 'helm-detach-e2e-' + process.pid);
const cfg = path.join(os.tmpdir(), 'helm-detach-cfg-' + process.pid);
const LOCK = path.join(os.tmpdir(), 'claude-headless-browser.lock');
const T0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 23);
const note = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => { results.push({ ok: !!ok, what }); console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${what}`); return ok; };
const started = new Set();
let haveLock = false;
const cmdline = (pid) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true }); } catch { return ''; } };
const ours = (pid) => cmdline(pid).includes(profile);
const killTree = (pid) => { if (!ours(pid)) return; try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
function connect(port, token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    let id = 1;
    const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); } });
    const rpc = (method, params = {}) => new Promise((ok, bad) => {
      const i = id++;
      pending.set(i, (m) => (m.error ? bad(Object.assign(new Error(m.error.message), { code: m.error.code })) : ok(m.result)));
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      setTimeout(() => { if (pending.delete(i)) bad(new Error(`${method} timed out`)); }, 30000);
    });
    ws.on('close', () => { for (const [i, p] of pending) { pending.delete(i); p({ error: { message: 'connection closed', code: 'closed' } }); } });
    ws.once('open', () => res({ ws, rpc }));
    ws.once('error', rej);
  });
}
async function waitReady(child, getOut) {
  for (const end = Date.now() + 60000; Date.now() < end; await sleep(250)) {
    const m = /HELM_READY (\{.*\})/.exec(getOut());
    if (m) return JSON.parse(m[1]);
    if (child.exitCode !== null) throw new Error('app exited early:\n' + getOut().slice(-1500));
  }
  throw new Error('no HELM_READY in 60 s');
}
const sessionOf = async (c, id) => ((await c.rpc('app.hello')).sessions || []).find((x) => x.id === id) || null;
const ui = (c, js) => c.rpc('test.eval', { js });
async function answerQuestion(c, id, ss) {
  const pr = ss && ss.pendingRequest;
  if (!(pr && pr.kind === 'question' && pr.choice && Array.isArray(pr.choice.options) && pr.choice.options.length)) return;
  const opt = pr.choice.options.find((o) => /^\s*yes\b/i.test(String(o.label))) || pr.choice.options[0];
  note(`answering "${pr.choice.question}" with "${opt.label}"`);
  await c.rpc('sessions.respond', { id, requestId: pr.requestId, response: { answers: { [pr.choice.question]: opt.label } } }).catch((e) => note('respond failed:', e.message));
}
async function allHistory(c, id) {
  const r = await c.rpc('sessions.history', { id, limit: 400 }).catch(() => null);
  return (r && (r.items || r)) || [];
}

async function main() {
  const freeGb = Number(execFileSync('powershell', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)'], { encoding: 'utf8', windowsHide: true }).trim());
  note(`free RAM ${freeGb} GB`);
  if (!(freeGb >= 2.5)) throw new Error(`only ${freeGb} GB free RAM (needs 2.5 GB for an Electron instance): not starting`);
  const held = readJson(LOCK);
  if (held && held.pid && alive(held.pid)) throw new Error(`the headless-browser lock is held by pid ${held.pid} (${held.by || '?'})`);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, by: 'helm detach-e2e', at: new Date().toISOString() }));
  haveLock = true;
  fs.mkdirSync(cfg, { recursive: true });   // empty: the instance's Claude Code gets ANTHROPIC_API_KEY from the env

  fs.mkdirSync(path.join(repo, 'main'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { windowsHide: true });
  fs.writeFileSync(path.join(repo, 'main', 'x.js'), '// v1\n');
  const g = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false'];
  execFileSync('git', ['-C', repo, ...g, 'add', '.'], { windowsHide: true });
  execFileSync('git', ['-C', repo, ...g, 'commit', '-q', '-m', 'initial'], { windowsHide: true });
  const port = await freePort();
  note(`profile ${profile}; port ${port}; CLAUDE_CONFIG_DIR ${cfg}`);

  const env = { ...process.env, HELM_DETACH: '', HELM_TEST_UPDATE_REPO: repo, HELM_TEST_ALLOW_RESTART: '1', CLAUDE_CONFIG_DIR: cfg, HELM_CLAUDE_DIR: cfg, HELM_CLAUDE_PROJECTS: path.join(cfg, 'projects') };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;   // API key only: never hand a subscription token to the test instance
  const child = spawn(EXE, [ROOT, '--test', '--profile=' + profile, '--port=' + port], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  started.add(child.pid);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ready = await waitReady(child, () => out);
  started.add(ready.pid);
  note(`instance 1 up: pid ${ready.pid}`);
  let c = await connect(ready.port || port, ready.token);
  const broker = createBrokerClient({ stateDir: userData });
  // the real setting, not the env override (HELM_DETACH is blanked above)
  await c.rpc('settings.set', { keepSessionsThroughRestart: true });
  const ks = await c.rpc('sessions.keepStatus');
  check(ks && ks.on === true && ks.override === null, `the setting turns keeping on: ${JSON.stringify(ks && { on: ks.on, override: ks.override })}`);

  // 1. a slow multi-step turn
  const s = await c.rpc('sessions.create', { cwd: repo, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'bypassPermissions',
    prompt: 'Do exactly these steps in order, without asking any question first and without using agents. Use one tool call per step and run each command in the foreground (not in the background).\n1. Use the Bash tool to run exactly: node -e \"setTimeout(Object,25000)\"\n2. Use the Bash tool to run exactly: node -e \"setTimeout(Object,25000)\"\n3. Use the Write tool to create the file proof.txt in the current folder containing the single line: survived the restart\nThen reply with the single word DETACHDONE.' });
  note(`session ${s.id} created`);
  await ui(c, `import('/shell/state.js').then((st) => { st.openSession(${JSON.stringify(s.id)}); return true; })`);
  let ss = null;
  let hist = [];
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(1000)) {
    ss = await sessionOf(c, s.id);
    hist = await allHistory(c, s.id);
    if (ss && ss.status === 'working' && hist.some((i) => i.type === 'tool' && i.status === 'running')) break;
    await answerQuestion(c, s.id, ss);
  }
  const running1 = hist.filter((i) => i.type === 'tool');
  if (!check(ss && ss.status === 'working' && running1.some((i) => i.status === 'running'), `mid-turn with a tool running (status ${ss && ss.status}; tools ${JSON.stringify(running1.map((i) => `${i.name}:${i.status}`))})`)) return;
  const before = await broker.list();
  const cli = before.find((e) => e.sid === s.id);
  if (!check(cli && cli.pid && cli.attached && cli.busy, `the CLI runs in the broker: ${JSON.stringify(cli && { pid: cli.pid, attached: cli.attached, busy: cli.busy })}`)) return;
  const brokerPid = cli.broker && cli.broker.pid;
  const job = cli.broker && cli.broker.job;
  // every process here is in a session-wide job, so a broker that broke away can still report childInJob: what
  // matters is that it left Helm's jobs (no job at all, or a successful breakaway)
  check(job && job.method === 'launcher' && (job.childInJob === false || job.brokeAway === true), `the broker broke away from Helm's jobs (breakaway launcher): ${JSON.stringify(job)}`);
  started.add(brokerPid);
  check(brokerPid && ours(brokerPid), `broker pid ${brokerPid} is this run's (command line names the profile)`);
  await sleep(4000); // well inside step 1's 25 s
  // the tool that is running right now (and has been for > 4 s) is the one the restart lands on
  const runningAtRestart = (await allHistory(c, s.id)).filter((i) => i.type === 'tool' && i.status === 'running').pop();
  if (!check(runningAtRestart && runningAtRestart.name === 'Bash' && Date.now() - runningAtRestart.ts > 4000, `the restart lands on a running Bash (${runningAtRestart ? `${runningAtRestart.toolUseId}, ${Math.round((Date.now() - runningAtRestart.ts) / 1000)} s in: ${JSON.stringify((runningAtRestart.input || {}).command || '')}` : 'none running'})`)) return;

  // 2. restart mid-turn
  let closed = false;
  c.ws.on('close', () => { closed = true; });
  const restartAt = Date.now();
  await c.rpc('app.restart', { force: true });
  for (const end = Date.now() + 30000; Date.now() < end && !closed; await sleep(200));
  let next = null;
  for (const end = Date.now() + 90000; Date.now() < end; await sleep(500)) {
    const r = readJson(path.join(userData, 'ready.json'));
    if (r && r.pid !== ready.pid) { next = r; break; }
  }
  if (!check(next, `relaunched: ${next ? `pid ${next.pid} after ${((Date.now() - restartAt) / 1000).toFixed(1)} s` : 'no'}`)) return;
  started.add(next.pid);
  // 3. the old Helm is gone, the CLI is not
  for (const end = Date.now() + 15000; Date.now() < end && alive(ready.pid); await sleep(250));
  check(!alive(ready.pid), `the old Helm (pid ${ready.pid}) exited`);
  check(alive(cli.pid), `the same claude.exe (pid ${cli.pid}) is still running after the old Helm exited`);
  c = await connect(next.port, next.token);

  // 4. re-attached, then the turn finishes
  let s2 = null;
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(500)) {
    s2 = await sessionOf(c, s.id);
    if (s2 && s2.status === 'working') break;
    if (s2 && s2.status === 'idle' && /DETACHDONE/.test(s2.lastText || '')) break;
  }
  check(s2 && (s2.status === 'working' || /DETACHDONE/.test(s2.lastText || '')), `after the relaunch the session is ${s2 && s2.status} (re-attached, not idle-and-stopped)`);
  check(s2 && !s2.restartNote, `no restart note (nothing was cut off): ${JSON.stringify(s2 && s2.restartNote || null)}`);
  await ui(c, `import('/shell/state.js').then((st) => { st.openSession(${JSON.stringify(s.id)}); return true; })`);
  let fin = null;
  for (const end = Date.now() + 180000; Date.now() < end; await sleep(1000)) {
    fin = await sessionOf(c, s.id);
    if (fin && fin.status !== 'working' && fin.status !== 'waiting') break;
    await answerQuestion(c, s.id, fin);
  }
  const doneAt = Date.now();
  check(fin && fin.status === 'idle' && /DETACHDONE/.test(fin.lastText || ''), `the turn finished after the restart: status ${fin && fin.status}, last ${JSON.stringify(String(fin && fin.lastText || '').slice(0, 120))}${fin && fin.error ? `, error ${JSON.stringify(fin.error).slice(0, 200)}` : ''}`);
  const proof = path.join(repo, 'proof.txt');
  check(fs.existsSync(proof) && /survived the restart/.test(fs.readFileSync(proof, 'utf8')), `step 3 ran: proof.txt ${fs.existsSync(proof) ? JSON.stringify(fs.readFileSync(proof, 'utf8').trim()) : 'missing'} (mtime ${fs.existsSync(proof) ? ((fs.statSync(proof).mtimeMs - restartAt) / 1000).toFixed(1) + ' s after the restart' : '-'})`);
  hist = await allHistory(c, s.id);
  const tools = hist.filter((i) => i.type === 'tool');
  const cut = tools.find((i) => i.toolUseId === runningAtRestart.toolUseId);
  check(cut && cut.status === 'done', `the Bash that was running at the restart finished after it (not stopped): ${cut ? `${cut.status}${cut.result ? `, result ${JSON.stringify(String(cut.result).slice(0, 80))}` : ''}` : 'not found'}`);
  const texts = hist.filter((i) => i.type === 'assistant' && /DETACHDONE/.test(i.text || ''));
  const sys = hist.filter((i) => i.type === 'system' && i.subtype === 'kept' && /^Kept running through the restart$/.test(i.text || ''));
  note('tools after relaunch:', JSON.stringify(tools.map((i) => ({ name: i.name, status: i.status, ts: i.ts && Math.round((i.ts - restartAt) / 1000) }))));
  check(sys.length === 1, `the conversation says "Kept running through the restart": ${JSON.stringify(sys.map((i) => [i.text, i.detail]))}`);
  check(tools.filter((i) => i.name === 'Bash').length === 2 && tools.filter((i) => i.name === 'Write').length === 1, `each step shows once: ${tools.map((i) => i.name).join(', ')}`);
  check(tools.length && tools.every((i) => i.status === 'done' || i.status === 'ok' || i.status === 'success'), `every step shows finished: ${tools.map((i) => i.status).join(', ')}`);
  check(texts.length === 1, `the final reply shows once (${texts.length})`);
  const after = await broker.list();
  const cli2 = after.find((e) => e.sid === s.id);
  check(cli2 && cli2.pid === cli.pid && cli2.attached && !cli2.exited, `still the same CLI, attached to the new Helm: ${JSON.stringify(cli2 && { pid: cli2.pid, attached: cli2.attached, busy: cli2.busy })}`);
  const shot = await c.rpc('test.capture', { file: path.join(SHOTS, `helm-detach-${process.pid}.png`), waitMs: 800 }).catch((e) => ({ file: 'failed: ' + e.message }));
  note(`screenshot ${shot.file}${shot.width ? ` (${shot.width}x${shot.height})` : ''}`);

  // 5. a follow-up through the re-attached CLI
  await c.rpc('sessions.send', { id: s.id, text: 'Reply with the single word AFTERDONE.' });
  let f2 = null;
  for (const end = Date.now() + 90000; Date.now() < end; await sleep(1000)) {
    f2 = await sessionOf(c, s.id);
    if (f2 && f2.status === 'idle' && /AFTERDONE/.test(f2.lastText || '')) break;
    await answerQuestion(c, s.id, f2);
  }
  check(f2 && /AFTERDONE/.test(f2.lastText || ''), `a follow-up went through the re-attached CLI: ${JSON.stringify(String(f2 && f2.lastText || '').slice(0, 80))}`);
  const after2 = (await broker.list()).find((e) => e.sid === s.id);
  check(after2 && after2.pid === cli.pid, `the follow-up used the same pid ${after2 && after2.pid}`);
  const blog = (() => { try { return fs.readFileSync(path.join(userData, 'logs', 'broker.log'), 'utf8'); } catch { return ''; } })();
  const reinit = /re-initialize \S+: (\w+)[^\n]*hooks_applied (\w+)/.exec(blog);
  check(reinit && reinit[1] === 'success' && reinit[2] === 'true', `the real CLI took the re-attached Helm's initialize: ${reinit ? reinit[0].slice(0, 200) : 'no re-initialize line in broker.log'}`);
  note(`timeline: restart at +0 s, relaunched, turn done at +${((doneAt - restartAt) / 1000).toFixed(1)} s`);

  // 6. a manual close (not a restart Helm performs) stops everything. In --test the window close is not hidden to
  // the tray, so it ends in app.quit() with no restart intent, the same path as the tray's Quit Helm.
  const helmPid = next.pid;
  check(alive(helmPid) && alive(cli.pid) && alive(brokerPid), `before the manual close: Helm ${helmPid}, CLI ${cli.pid} and broker ${brokerPid} are running`);
  const closedAt = Date.now();
  await c.rpc('test.closeWindow', {}).catch(() => null);   // Helm quits; the reply may never come
  for (const end = Date.now() + 30000; Date.now() < end && (alive(helmPid) || alive(cli.pid) || alive(brokerPid)); await sleep(300));
  note(`manual close: everything checked at +${((Date.now() - closedAt) / 1000).toFixed(1)} s`);
  check(!alive(helmPid), `a manual close quit Helm (pid ${helmPid})`);
  check(!alive(cli.pid), `a manual close stopped the CLI (pid ${cli.pid}): not kept`);
  check(!alive(brokerPid), `a manual close stopped the broker (pid ${brokerPid})`);
  const blog2 = (() => { try { return fs.readFileSync(path.join(userData, 'logs', 'broker.log'), 'utf8'); } catch { return ''; } })();
  note('broker log after the manual close: ' + JSON.stringify(blog2.split(/\r?\n/).filter(Boolean).slice(-3).map((l) => l.slice(0, 160))));
}

if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
  console.log('detach-e2e: SKIP, ANTHROPIC_API_KEY is not set (this test runs a live Claude Code session, which authenticates with an Anthropic API key from the environment, as Helm passes it). Set it and re-run.');
  process.exit(2);
}

main().catch((e) => { check(false, 'threw: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }).finally(async () => {
  try {
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split('\n');
    for (const l of log.filter((x) => /restart|detach|re-attach|broker|cuts off|shutting down|boot failed|uncaught|CLI exited/.test(x))) console.log('  log ' + l.slice(0, 300));
  } catch (e) { console.log('  (no profile log: ' + e.message + ')'); }
  try { for (const l of fs.readFileSync(path.join(userData, 'logs', 'broker.log'), 'utf8').split('\n').filter(Boolean)) console.log('  broker ' + l.slice(0, 300)); } catch {}
  for (const pid of started) if (pid) killTree(pid);
  await sleep(1500);
  if (!KEEP) console.log(`  cleaned up ${dropLiveTranscripts([repo]).length} transcript folder(s)`);
  if (!KEEP) { for (const d of [repo, userData, cfg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
  if (haveLock) { try { const l = readJson(LOCK); if (l && l.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {} }
  const pass = results.filter((x) => x.ok).length;
  console.log(`detach-e2e: ${pass} passed, ${results.length - pass} failed (${((Date.now() - T0) / 1000).toFixed(0)} s; stopped PIDs ${[...started].filter(Boolean).join(', ')})`);
});
