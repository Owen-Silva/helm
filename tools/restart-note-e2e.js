// End-to-end proof of the restart note (lane restart, 2026-10-15) in the REAL app: a hidden `Helm.exe --test`
// (off-screen window, throwaway profile, its own port) with an empty throwaway CLAUDE_CONFIG_DIR (no credentials,
// settings, hooks, mods or CLAUDE.md; Claude Code authenticates with ANTHROPIC_API_KEY), allowed to really relaunch itself (HELM_TEST_ALLOW_RESTART).
//   1. a live claude-haiku-5-5 session launches a background agent and then sits in a foreground `sleep`
//   2. app.restartCheck names the session and the agent; app.restart without force is refused (busy)
//   3. app.restart { force: true } -> the relaunched instance's session has restartNote (turn + agent, with its id)
//   4. the conversation shows the card "Helm restarted at …: 1 agent stopped" with the agent; a screenshot is kept
//   5. Continue (a real click) -> the prompt "Continue where you left off." carries the <helm-note> naming the agent
//      and its id; the turn runs; the note and the card are gone.
// Guards: >= 2.5 GB free RAM (an Electron instance), the machine-wide %TEMP%\claude-headless-browser.lock, and
// ANTHROPIC_API_KEY set in the environment (else SKIP, exit 2). Never touches
// port 4871, %APPDATA%\Helm, ~/.claude or any process it did not start.
// Summary line: `restart-note-e2e: N passed, M failed`. Usage: node tools/restart-note-e2e.js [--exe=…] [--keep] [--shot=dir]
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
// default: this folder's Electron (a worktree tests its own main.js; the stamped Helm.exe always loads ~/helm/main.js)
const EXE = arg('exe') ? path.resolve(ROOT, arg('exe')) : require(path.join(ROOT, 'node_modules', 'electron'));
const KEEP = process.argv.includes('--keep');
const SHOTS = path.resolve(arg('shot') || os.tmpdir());
fs.mkdirSync(SHOTS, { recursive: true }); // a fresh --shot=dir (test.capture does not create it)
const profile = 'rn' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const repo = path.join(os.tmpdir(), 'helm-restart-note-e2e-' + process.pid);
const cfg = path.join(os.tmpdir(), 'helm-restart-note-cfg-' + process.pid);
const LOCK = path.join(os.tmpdir(), 'claude-headless-browser.lock');
const T0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 23);
const note = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => { results.push({ ok: !!ok, what }); console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${what}`); return ok; };
const started = new Set();
let haveLock = false;
const ours = (pid) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true }).includes(profile); } catch { return false; } };
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

// A question the model asks first (e.g. a standing "Let agents spawn sub-agents?" rule picked up from a CLAUDE.md)
// would park the turn: answer it with "Yes" (else the first option) so the turn goes on.
async function answerQuestion(c, id, ss) {
  const pr = ss && ss.pendingRequest;
  if (!(pr && pr.kind === 'question' && pr.choice && Array.isArray(pr.choice.options) && pr.choice.options.length)) return;
  const opt = pr.choice.options.find((o) => /^\s*yes\b/i.test(String(o.label))) || pr.choice.options[0];
  note(`answering "${pr.choice.question}" with "${opt.label}"`);
  await c.rpc('sessions.respond', { id, requestId: pr.requestId, response: { answers: { [pr.choice.question]: opt.label } } }).catch((e) => note('respond failed:', e.message));
}

async function main() {
  const freeGb = Number(execFileSync('powershell', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)'], { encoding: 'utf8', windowsHide: true }).trim());
  note(`free RAM ${freeGb} GB`);
  if (!(freeGb >= 2.5)) throw new Error(`only ${freeGb} GB free RAM (needs 2.5 GB for an Electron instance): not starting`);
  const held = readJson(LOCK);
  if (held && held.pid && alive(held.pid)) throw new Error(`the headless-browser lock is held by pid ${held.pid} (${held.by || '?'})`);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, by: 'helm restart-note-e2e', at: new Date().toISOString() }));
  haveLock = true;
  fs.mkdirSync(cfg, { recursive: true });   // empty: the instance's Claude Code gets ANTHROPIC_API_KEY from the env

  fs.mkdirSync(path.join(repo, 'main'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { windowsHide: true });
  fs.writeFileSync(path.join(repo, 'main', 'x.js'), '// v1\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false', 'add', '.'], { windowsHide: true });
  execFileSync('git', ['-C', repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial'], { windowsHide: true });
  const port = await freePort();
  note(`profile ${profile}; port ${port}; CLAUDE_CONFIG_DIR ${cfg}`);

  const env = { ...process.env, HELM_TEST_UPDATE_REPO: repo, HELM_TEST_ALLOW_RESTART: '1', CLAUDE_CONFIG_DIR: cfg, HELM_CLAUDE_DIR: cfg, HELM_CLAUDE_PROJECTS: path.join(cfg, 'projects') };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;   // API key only: never hand a subscription token to the test instance
  const child = spawn(EXE, [ROOT, '--test', '--profile=' + profile, '--port=' + port], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  started.add(child.pid);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ready = await waitReady(child, () => out);
  started.add(ready.pid);
  note(`instance 1 up: pid ${ready.pid}`);
  let c = await connect(port, ready.token);

  // 1. a turn that leaves a background agent running and then sits in a foreground sleep
  const s = await c.rpc('sessions.create', { cwd: repo, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'bypassPermissions',
    // A plain `sleep N` is refused by current CLIs (foreground sleep is blocked), which ended the turn before the
    // restart; a node timer is not. Questions are pre-empted (a user CLAUDE.md rule asked one; answerQuestion covers it too).
    prompt: 'Do exactly these two steps and nothing else, without asking any question first (this session may launch one background agent).\n1. Use the Agent tool with run_in_background set to true, subagent_type general-purpose, description "e2e sleeper", and prompt "Run this exact Bash command in the foreground: node -e setTimeout(Object,240000)   Then reply done."\n2. Right after launching it, without waiting for it, use the Bash tool (not in the background) to run exactly: node -e setTimeout(Object,90000)\nThen reply with the single word finished.' });
  note(`session ${s.id} created`);
  await ui(c, `import('/shell/state.js').then((st) => { st.openSession(${JSON.stringify(s.id)}); return true; })`); // selectSession alone leaves Home on screen
  let ss = null;
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(1000)) {
    ss = await sessionOf(c, s.id);
    if (ss && ss.status === 'working' && ss.agentsRunning >= 1) break;
    await answerQuestion(c, s.id, ss);
  }
  if (!check(ss && ss.status === 'working' && ss.agentsRunning >= 1, `mid-turn with an agent running (status ${ss && ss.status}, agents ${ss && ss.agentsRunning}${ss && ss.pendingRequest ? `, pending ${JSON.stringify(ss.pendingRequest).slice(0, 400)}` : ''}${ss && ss.lastText ? `, last ${JSON.stringify(String(ss.lastText).slice(0, 300))}` : ''}${ss && ss.error ? `, error ${JSON.stringify(ss.error).slice(0, 300)}` : ''})`)) return;
  await sleep(3000); // let the agent get going

  // 2. the gate names it; a restart without force is refused
  const rc = await c.rpc('app.restartCheck');
  check(rc.reasons.some((r) => /session working/.test(r)) && rc.reasons.some((r) => /agents? running/.test(r)), `app.restartCheck -> ${JSON.stringify(rc.reasons)}`);
  let refused = null;
  try { await c.rpc('app.restart', {}); } catch (e) { refused = e; }
  check(refused && refused.code === 'busy', `app.restart without force refused: ${refused && refused.code}`);

  // 3. The user restarts anyway
  let closed = false;
  c.ws.on('close', () => { closed = true; });
  await c.rpc('app.restart', { force: true });
  for (const end = Date.now() + 30000; Date.now() < end && !closed; await sleep(200));
  let next = null;
  for (const end = Date.now() + 90000; Date.now() < end; await sleep(500)) {
    const r = readJson(path.join(userData, 'ready.json'));
    if (r && r.pid !== ready.pid) { next = r; break; }
  }
  if (!check(next, `relaunched: ${next ? `pid ${next.pid}` : 'no'}`)) return;
  started.add(next.pid);
  c = await connect(next.port, next.token);
  const s2 = await sessionOf(c, s.id);
  const rn = s2 && s2.restartNote;
  check(rn && rn.cause === 'restart' && rn.working === true, `restartNote: cause ${rn && rn.cause}, working ${rn && rn.working}`);
  check(rn && rn.agents.length >= 1 && rn.agents.every((a) => a.agentId), `restartNote agents: ${JSON.stringify(rn && rn.agents)}`);

  // 4. the card in the conversation
  await ui(c, `import('/shell/state.js').then((st) => { st.openSession(${JSON.stringify(s.id)}); return true; })`); // selectSession alone leaves Home on screen
  let card = null;
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(500)) {
    card = await ui(c, `(() => { const el = document.querySelector('.restart-note'); if (!el) return null; el.scrollIntoView({ block: 'center' }); return { title: el.querySelector('.rn-title').innerText, rows: [...el.querySelectorAll('.rn-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')), cont: !!el.querySelector('[data-act=restart-continue]:not([disabled])'), toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\\s+/g, ' ')) }; })()`);
    if (card) break;
  }
  if (!card) note('no card; on screen:', JSON.stringify(await ui(c, `(() => ({ view: (document.querySelector('[data-view]') || {}).dataset?.view || null, conv: !!document.querySelector('.chat, .conv, .msgs'), text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) }))()`)));
  check(card && /^Helm restarted at .+: \d+ agents? stopped$/.test(card.title), `card title: ${card && card.title}`);
  check(card && card.rows.length >= 1 && card.cont, `card lists ${card && card.rows.length} row(s) ${JSON.stringify(card && card.rows)}; Continue enabled`);
  const shot = await c.rpc('test.capture', { file: path.join(SHOTS, `helm-restart-note-${process.pid}.png`), waitMs: 800 });
  note(`screenshot ${shot.file} (${shot.width}x${shot.height})`);

  // 5. Continue
  await ui(c, `(() => { document.querySelector('[data-act=restart-continue]').click(); return true; })()`);
  let after = null;
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(1000)) {
    after = await sessionOf(c, s.id);
    if (after && after.status === 'idle' && !after.restartNote && (after.lastText || '').length) break;
    await answerQuestion(c, s.id, after);
  }
  check(after && !after.restartNote, 'restartNote cleared after Continue');
  const items = await c.rpc('sessions.history', { id: s.id }).catch(() => null);
  const list = (items && (items.items || items)) || [];
  const cont = Array.isArray(list) ? list.filter((i) => i.type === 'user').pop() : null;
  check(cont && cont.text === 'Continue where you left off.', `the prompt sent: ${cont && JSON.stringify(cont.text)}`);
  check(cont && cont.helmNote && /Helm restarted at \d\d:\d\d while you were working/.test(cont.helmNote) && rn && rn.agents.every((a) => cont.helmNote.includes(a.agentId)), `the helm-note names the agent ids: ${cont && cont.helmNote}`);
  check(after && after.status === 'idle' && (after.lastText || '').length > 0, `Claude answered: ${after && JSON.stringify((after.lastText || '').slice(0, 160))}`);
  const gone = await ui(c, `!document.querySelector('.restart-note')`);
  check(gone === true, 'the card is gone');
}

if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
  console.log('restart-note-e2e: SKIP, ANTHROPIC_API_KEY is not set (this test runs a live Claude Code session, which authenticates with an Anthropic API key from the environment, as Helm passes it). Set it and re-run.');
  process.exit(2);
}

main().catch((e) => { check(false, 'threw: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }).finally(async () => {
  try {
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split('\n');
    for (const l of log.filter((x) => /restart|cuts off|shutting down|boot failed|uncaught/.test(x))) console.log('  log ' + l.slice(0, 300));
  } catch (e) { console.log('  (no profile log: ' + e.message + ')'); }
  for (const pid of started) killTree(pid);
  await sleep(1500);
  if (!KEEP) console.log(`  cleaned up ${dropLiveTranscripts([repo]).length} transcript folder(s)`);
  if (!KEEP) { for (const d of [repo, userData, cfg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
  if (haveLock) { try { const l = readJson(LOCK); if (l && l.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {} }
  const pass = results.filter((x) => x.ok).length;
  console.log(`restart-note-e2e: ${pass} passed, ${results.length - pass} failed (${((Date.now() - T0) / 1000).toFixed(0)} s; stopped PIDs ${[...started].join(', ')})`);
});
