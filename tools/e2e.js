// End-to-end proof that Helm drives the REAL Claude Code: starts `electron . --test` hidden
// (throwaway profile in %TEMP%, free port, no tray/toasts), connects over the WebSocket with the
// token, and runs live scenarios against a scratch git repo with a cheap model. Every scenario is
// a pass/fail check with the reason; the window is captured mid-run so the UI lanes can see real
// data rendered. Stops the app BY PID only (never by name).
//
// Usage: node tools/e2e.js [--only=1,2,3] [--model=claude-haiku-5-5] [--keep] [--shots=.shots] [--exe=dist/Helm/Helm.exe]
//   --only   run just these scenario numbers (setup turns still run where a scenario needs them)
//   --dump=<file>  append every WS event as JSONL (debugging)
//   --keep   keep the scratch repo, the test profile and the ~/.claude/projects transcripts
// Cost: every turn uses --model (default claude-haiku-5-5); the run prints the live spend summed
// from Claude Code's own result messages.
// Owner: lane host (B) / e2e.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const MODEL = arg('model') || 'claude-haiku-5-5';
const DUMP = arg('dump') ? path.resolve(arg('dump')) : null; // JSONL of every event, for debugging
const ONLY = arg('only') ? new Set(arg('only').split(',').map(Number)) : null;
const KEEP = process.argv.includes('--keep');
const SHOTS = path.resolve(ROOT, arg('shots') || '.shots');
const profile = 'e2e' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const repo = path.join(os.tmpdir(), 'helm-e2e-' + process.pid);
// --exe=dist/Helm/Helm.exe runs the scenarios through the stamped Helm.exe (tools/make-exe.js)
const electronExe = arg('exe') ? path.resolve(arg('exe')) : require(path.join(ROOT, 'node_modules', 'electron'));
const want = (n) => !ONLY || ONLY.has(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';

// ---------- results ----------
const results = [];
function record(n, name, ok, reason) {
  results.push({ n, name, ok, reason });
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} S${n} ${name}${reason ? ' :: ' + reason : ''}`);
}
function note(...a) { console.log(stamp(), ...a); }

// ---------- app process ----------
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

// S18: the claude.exe processes under THIS test app (found by parent PID, never by name alone) and the memory of
// their process trees (claude.exe + whatever it runs). Read-only OS counters.
function cliProcs(rootPid) {
  const ps = `$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount
$keep = @{}; $keep[${Number(rootPid)}] = $true
for ($i = 0; $i -lt 8; $i++) { foreach ($p in $all) { if ($keep.ContainsKey([int]$p.ParentProcessId)) { $keep[[int]$p.ProcessId] = $true } } }
@($all | Where-Object { $keep.ContainsKey([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; ws = [double]$_.WorkingSetSize; priv = [double]$_.PrivatePageCount } }) | ConvertTo-Json -Compress`;
  let list = [];
  try { list = JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim() || '[]'); } catch {}
  if (!Array.isArray(list)) list = [list];
  const clis = list.filter((p) => /^claude(\.exe)?$/i.test(p.name || ''));
  const tree = new Set(clis.map((p) => p.pid));
  for (let i = 0; i < 8; i++) for (const p of list) if (tree.has(p.ppid)) tree.add(p.pid);
  const inTree = list.filter((p) => tree.has(p.pid));
  const mb = (n) => Math.round(n / 1048576);
  return { count: clis.length, pids: clis.map((p) => p.pid), procs: inTree.length, wsMB: mb(inTree.reduce((a, p) => a + p.ws, 0)), privMB: mb(inTree.reduce((a, p) => a + p.priv, 0)) };
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function startApp() {
  const child = spawn(electronExe, ['.', '--test', '--profile=' + profile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const m = /HELM_READY (\{.*\})/.exec(out);
    if (m) {
      const ready = JSON.parse(m[1]);
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      note(`app up: pid ${child.pid} port ${ready.port} engine ${ready.engine}`);
      return { child, ready, out: () => out, c: client(ws) };
    }
    if (child.exitCode !== null) throw new Error('electron exited early:\n' + out.slice(-2000));
    await sleep(250);
  }
  killTree(child.pid);
  throw new Error('no HELM_READY within 60 s:\n' + out.slice(-2000));
}

async function stopApp(app) {
  try { app.c.ws.close(); } catch {}
  killTree(app.child.pid);
  await sleep(1500);
}

// ---------- WS client with a local mirror of items / sessions ----------
function client(ws) {
  let id = 1;
  const pending = new Map();
  const events = [];
  const items = new Map(); // sessionId -> Map(itemId -> item)
  const sessions = new Map();
  const statusLog = new Map(); // sessionId -> [{ t, status, activity, queued }]
  function itemsOf(sid) { if (!items.has(sid)) items.set(sid, new Map()); return items.get(sid); }
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
    if (m.type !== 'event') return;
    m.t = Date.now();
    events.push(m);
    if (DUMP) fs.appendFileSync(DUMP, JSON.stringify(m) + '\n');
    const d = m.data || {};
    if (m.event === 'session.item') itemsOf(d.sessionId).set(d.item.id, { ...d.item });
    else if (m.event === 'session.itemUpdate') {
      const map = itemsOf(d.sessionId); const it = map.get(d.itemId);
      if (it) { Object.assign(it, d.patch || {}); if (d.appendText) it.text = (it.text || '') + d.appendText; }
    } else if (m.event === 'session.created' || m.event === 'session.updated') {
      sessions.set(d.id, d);
      if (!statusLog.has(d.id)) statusLog.set(d.id, []);
      statusLog.get(d.id).push({ t: m.t, status: d.status, activity: d.activity, queued: d.queued });
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
  async function waitFor(pred, timeout, what) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
      await sleep(100);
    }
  }
  return { ws, call, events, items, sessions, statusLog, itemsOf, waitFor };
}

// ---------- turn helpers ----------
let A = null; // app handle
const spend = { results: 0, bySession: new Map() };

function itemList(sid) { return [...A.c.itemsOf(sid).values()]; }
function evSince(idx, name, sid) { return A.c.events.slice(idx).filter((e) => e.event === name && (!sid || (e.data && (e.data.sessionId === sid || e.data.id === sid)))); }

// Auto-answer anything the scenario didn't plan for, so a stray question can't hang the run.
function autoAnswer(sid, handled, log) {
  for (const it of itemList(sid)) {
    if (it.type !== 'request' || it.status !== 'pending' || handled.has(it.requestId)) continue;
    handled.add(it.requestId);
    let response;
    if (it.kind === 'question') {
      const answers = {};
      for (const q of it.questions || []) {
        const no = (q.options || []).find((o) => /^no\b/i.test(o.label));
        answers[q.question] = (no || (q.options || [])[0] || { label: 'No' }).label;
      }
      response = { answers };
    } else response = { behavior: 'allow' };
    log.push({ kind: it.kind, toolName: it.toolName, questions: (it.questions || []).map((q) => q.question) });
    note(`  (auto-answered unplanned ${it.kind} request ${it.toolName}: ${JSON.stringify(response).slice(0, 120)})`);
    A.c.call('sessions.respond', { id: sid, requestId: it.requestId, response }).catch((e) => note('  auto-answer failed', e.message));
  }
}

// Send a prompt and wait for the turn's result item + idle. Returns everything that turn produced.
async function turn(sid, text, { timeout = 180000, onTick, expectQueued = false, autoAnswerRequests = true } = {}) {
  const idx = A.c.events.length;
  const before = new Set(A.c.itemsOf(sid).keys());
  const sent = await A.c.call('sessions.send', { id: sid, text });
  const handled = new Set(); const unplanned = [];
  const resultItem = await A.c.waitFor(() => {
    if (onTick) onTick();
    if (autoAnswerRequests) autoAnswer(sid, handled, unplanned);
    return itemList(sid).find((it) => it.type === 'result' && !before.has(it.id));
  }, timeout, `result item for "${text.slice(0, 40)}"`);
  await A.c.waitFor(() => { const s = A.c.sessions.get(sid); return s && s.status === 'idle' && !s.queued; }, 15000, 'session idle').catch(() => {});
  const fresh = itemList(sid).filter((it) => !before.has(it.id));
  if (typeof resultItem.costUsd === 'number') spend.results += resultItem.costUsd;
  return { sent, idx, items: fresh, result: resultItem, unplanned, expectQueued };
}

const textOf = (items) => items.filter((it) => it.type === 'assistant').map((it) => it.text || '').join('\n');
const tools = (items, name) => items.filter((it) => it.type === 'tool' && (!name || (Array.isArray(name) ? name.includes(it.name) : it.name === name)));
const short = (o, n = 300) => { const s = JSON.stringify(o); return s.length > n ? s.slice(0, n) + '…' : s; };

async function scenario(n, name, fn) {
  if (!want(n)) return;
  try {
    const r = await fn();
    if (r === undefined || r === true) record(n, name, true, '');
    else if (typeof r === 'string') record(n, name, false, r);
    else record(n, name, !!r.ok, r.reason || '');
  } catch (e) { record(n, name, false, 'threw: ' + e.message); }
}
// collect failing sub-checks; returns '' when everything held
function checks() {
  const fails = [];
  const c = (ok, what) => { if (!ok) fails.push(what); return ok; };
  c.result = () => (fails.length ? fails.join('; ') : true);
  return c;
}

async function capture(sid, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name);
  try {
    const r = await A.c.call('test.capture', { file, sessionId: sid, waitMs: 2500 }, 30000);
    note(`captured ${r.file} ${r.width}x${r.height}${r.empty ? ' (EMPTY)' : ''}`);
    return r;
  } catch (e) { note('capture failed: ' + e.message); return null; }
}

// ---------- scratch repo ----------
function makeRepo() {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'The first word is alpha.\nThe second line stays.\n');
  fs.writeFileSync(path.join(repo, 'app.js'), "console.log('hello');\n");
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=e2e@helm.local', '-c', 'user.name=helm e2e', 'add', '.');
  git('-c', 'user.email=e2e@helm.local', '-c', 'user.name=helm e2e', 'commit', '-q', '-m', 'init');
}

// The Claude Code transcript dir for the scratch cwd (same sanitising as the CLI).
function projectDirFor(cwd) { return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); }

// ---------- main ----------
async function main() {
  makeRepo();
  note(`scratch repo ${repo}, model ${MODEL}, profile ${userData}`);
  A = await startApp();
  const c = A.c;
  await c.call('settings.set', { defaults: { model: MODEL, permissionMode: 'bypassPermissions', cwd: repo } });
  const hello = await c.call('app.hello');
  if (hello.engine !== 'real') throw new Error('engine is ' + hello.engine + ', not real');

  const s = await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' });
  const sid = s.id;
  note(`session A ${sid}`);

  // S1 ------------------------------------------------------------------
  let firstTurn = null;
  await scenario(1, 'text reply streams', async () => {
    const t = firstTurn = await turn(sid, 'Remember this codeword for later: PELICAN. For now reply with exactly the words: hello from helm');
    const k = checks();
    const asst = t.items.find((it) => it.type === 'assistant');
    k(asst, 'no assistant item');
    const deltas = evSince(t.idx, 'session.itemUpdate', sid).filter((e) => asst && e.data.itemId === asst.id && e.data.appendText);
    k(deltas.length >= 1, `no appendText deltas for the assistant item (${deltas.length})`);
    k(/hello from helm/i.test(textOf(t.items)), 'reply text missing: ' + short(textOf(t.items), 120));
    k(asst && asst.streaming === false, 'assistant still streaming=' + (asst && asst.streaming));
    k(asst && asst.model, 'assistant has no model field');
    k(t.result.durationMs > 0 && typeof t.result.costUsd === 'number' && t.result.usage, 'result fields: ' + short(t.result));
    const st = (c.statusLog.get(sid) || []).filter((x) => x.t >= t.sent && true).map((x) => x.status);
    const seq = c.statusLog.get(sid).map((x) => x.status);
    k(seq.includes('working') && seq[seq.length - 1] === 'idle', 'status sequence ' + seq.join('>'));
    const sess = c.sessions.get(sid);
    k(sess.title && sess.title !== 'New session', 'title ' + short(sess.title));
    k(sess.costUsd > 0, 'session costUsd ' + sess.costUsd);
    k(sess.context && sess.context.usedTokens > 0 && sess.context.windowTokens > 0, 'context ' + short(sess.context));
    k(sess.claudeSessionId, 'no claudeSessionId');
    k(!t.unplanned.length, 'unplanned requests ' + short(t.unplanned));
    void st;
    return k.result();
  });
  if (!firstTurn && want(9)) firstTurn = await turn(sid, 'Remember this codeword for later: PELICAN. Reply with just: ok');

  // S17 ----------------------------------------------------------------- `!` shell mode, Active hours, Account
  await scenario(17, '! shell run reaches Claude; activity.summary; account.status', async () => {
    const k = checks();
    const { itemId } = await c.call('sessions.shell', { id: sid, command: 'echo SHELL-$((40+2))' });
    let sh = null;
    for (const t0 = Date.now(); Date.now() - t0 < 30000; await sleep(200)) { sh = A.c.itemsOf(sid).get(itemId); if (sh && sh.status !== 'running') break; }
    k(sh && sh.status === 'done' && sh.exitCode === 0 && /SHELL-42/.test(sh.stdout || ''), 'shell item ' + short(sh));
    k(sh && !sh.shared, 'shared before any send: ' + (sh && sh.shared));
    const t = await turn(sid, 'What exact word did my last shell command print? Reply with just that word.');
    k(/SHELL-42/.test(textOf(t.items)), 'reply ' + short(textOf(t.items), 120));
    k(A.c.itemsOf(sid).get(itemId)?.shared === true, 'not marked shared after the send');
    const u = t.items.find((it) => it.type === 'user');
    k(u && !/bash-(input|stdout)/.test(u.text || ''), 'user bubble shows the shell tags: ' + short(u && u.text));
    const act = await c.call('activity.summary', { days: 7 }, 180000);   // a fresh profile = a cold scan of a month of transcripts
    note(`activity.summary: scanMs ${act && act.scanMs}, files ${act && act.files}`);
    k(act && Array.isArray(act.days) && act.days.length === 7 && act.today && typeof act.today.activeMs === 'number', 'activity ' + short(act));
    const acc = await c.call('account.status');   // read-only: Claude Code's own status check (the first call runs it)
    k(acc && acc.claudeCode && ['signed-in', 'signed-out', 'unknown'].includes(acc.claudeCode.state) && acc.capabilities && acc.capabilities.login === false, 'account ' + short(acc && { provider: acc.provider, state: acc.claudeCode && acc.claudeCode.state, kind: acc.claudeCode && acc.claudeCode.kind }));
    return k.result();
  });

  // S2 ------------------------------------------------------------------
  await scenario(2, 'Bash tool running -> done + activity', async () => {
    let sawRunning = null; const activities = new Set();
    const t = await turn(sid, 'Use the Bash tool to run exactly this command: sleep 4 && echo e2e-bash-ok   Then reply with one short sentence.', {
      onTick: () => {
        const b = tools(itemList(sid), 'Bash').find((it) => it.status === 'running');
        if (b) sawRunning = b.id;
        const ss = c.sessions.get(sid); if (ss && ss.activity) activities.add(ss.activity);
      },
    });
    const k = checks();
    const bash = tools(t.items, 'Bash')[0];
    k(bash, 'no Bash tool item; tools=' + tools(t.items).map((x) => x.name).join(','));
    if (bash) {
      k(sawRunning === bash.id, 'never saw the Bash item in status running');
      k(bash.status === 'done', 'Bash status ' + bash.status);
      const res = typeof bash.result === 'string' ? bash.result : bash.result && bash.result.text;
      k(/e2e-bash-ok/.test(res || ''), 'result text ' + short(bash.result, 120));
      k(bash.startedAt && bash.endedAt && bash.endedAt >= bash.startedAt, 'startedAt/endedAt ' + bash.startedAt + '/' + bash.endedAt);
      const runMs = bash.endedAt - bash.startedAt;
      note(`  Bash item ran ${runMs} ms for a 4 s sleep (turn ${t.result.durationMs} ms)`);
      // the wall time is the CLI's (Git Bash spawn + hooks on Windows: 7-19 s seen), so only check
      // the item spans the sleep and isn't absurd
      k(runMs >= 4000 && runMs < 60000, `tool duration ${runMs} ms for a 4 s sleep`);
      k(bash.input && /sleep 4/.test(bash.input.command || ''), 'input ' + short(bash.input));
    }
    const log = (c.statusLog.get(sid) || []).filter((x) => x.activity).map((x) => x.activity);
    k(log.length > 0, 'activity never set while the tool ran');
    note('  activities seen: ' + short([...new Set(log)], 200));
    k(c.sessions.get(sid).activity == null, 'activity not cleared at idle: ' + c.sessions.get(sid).activity);
    return k.result();
  });

  // S3 ------------------------------------------------------------------
  let editTurn = null;
  await scenario(3, 'Edit -> files.changed / changes / diff', async () => {
    const t = editTurn = await turn(sid, 'Use the Edit tool to change the word "alpha" to "omega" in notes.txt (read it first if you must). Then reply with: edited');
    const k = checks();
    const ed = tools(t.items, ['Edit', 'MultiEdit', 'Write'])[0];
    k(ed, 'no Edit tool item; tools=' + tools(t.items).map((x) => x.name).join(','));
    if (ed) {
      k(ed.name === 'Edit', 'tool was ' + ed.name);
      k(ed.input && /alpha/.test(ed.input.old_string || '') && /omega/.test(ed.input.new_string || ''), 'input ' + short(ed.input));
      k(ed.status === 'done', 'status ' + ed.status + ' result ' + short(ed.result, 150));
    }
    const disk = fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8');
    k(/omega/.test(disk), 'file on disk not edited: ' + short(disk));
    const fc = evSince(t.idx, 'files.changed', sid);
    k(fc.some((e) => /notes\.txt$/.test(e.data.path)), 'no files.changed for notes.txt: ' + short(fc.map((e) => e.data)));
    const changes = await c.call('files.changes', { sessionId: sid });
    const ch = (changes || []).find((x) => /notes\.txt$/.test(x.path));
    k(ch && ch.status === 'M' && ch.additions >= 1 && ch.deletions >= 1, 'files.changes ' + short(changes));
    k(ch && ed && (ch.touchedBy || []).includes(ed.toolUseId), 'touchedBy ' + short(ch && ch.touchedBy));
    const diff = await c.call('files.diff', { cwd: repo, path: path.join(repo, 'notes.txt') });
    k(diff && /alpha/.test(diff.before || '') && /omega/.test(diff.after || ''), 'files.diff ' + short(diff));
    const rel = await c.call('files.diff', { cwd: repo, path: 'notes.txt' }).catch((e) => ({ error: e.message }));
    k(rel && /alpha/.test(rel.before || ''), 'files.diff with a relative path ' + short(rel));
    return k.result();
  });
  await capture(sid, 'e2e-after-edit.png');

  // S13 -----------------------------------------------------------------
  await scenario(13, 'checkpoint + rewind files', async () => {
    if (!editTurn) return 'needs S3';
    const k = checks();
    const cps = await c.call('sessions.checkpoints', { id: sid });
    note('  checkpoints: ' + short(cps, 400));
    k(Array.isArray(cps) && cps.length > 0, 'no checkpoints');
    const userItem = editTurn.items.find((it) => it.type === 'user');
    const cp = (cps || []).find((x) => userItem && x.itemId === userItem.id) || (cps || []).filter((x) => (x.files || []).some((f) => /notes\.txt$/.test(f))).pop();
    k(cp, 'no checkpoint for the edit turn (user item ' + (userItem && userItem.id) + ')');
    k(cp && (cp.files || []).some((f) => /notes\.txt$/.test(f)), 'checkpoint files ' + short(cp && cp.files));
    if (!cp) return k.result();
    await c.call('sessions.rewind', { id: sid, checkpointId: cp.id, files: true, conversation: false }, 60000);
    const disk = fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8');
    k(/alpha/.test(disk) && !/omega/.test(disk), 'notes.txt not restored: ' + short(disk));
    const sess = c.sessions.get(sid);
    k(sess && sess.status !== 'error', 'session status after rewind ' + (sess && sess.status));
    return k.result();
  });

  // S4 ------------------------------------------------------------------
  await scenario(4, 'AskUserQuestion round-trip', async () => {
    const idx = c.events.length;
    const before = new Set(c.itemsOf(sid).keys());
    const q = 'Which color should the logo be?';
    await c.call('sessions.send', { id: sid, text: `Use the AskUserQuestion tool to ask me exactly one question: "${q}" with exactly two options: "Red" and "Blue". After I answer, reply with only the color I picked, in uppercase.` });
    const k = checks();
    const req = await c.waitFor(() => itemList(sid).find((it) => !before.has(it.id) && it.type === 'request' && it.status === 'pending'), 120000, 'question request');
    k(req.kind === 'question', 'request kind ' + req.kind + ' ' + short(req));
    k(Array.isArray(req.questions) && req.questions.length === 1 && (req.questions[0].options || []).length === 2, 'questions ' + short(req.questions));
    await c.waitFor(() => c.sessions.get(sid).status === 'waiting', 5000, 'status waiting').catch(() => k(false, 'status never waiting: ' + c.sessions.get(sid).status));
    const nt = evSince(idx, 'notify').filter((e) => e.data.kind === 'waiting');
    k(nt.length > 0, 'no notify kind waiting');
    const question = (req.questions && req.questions[0] && req.questions[0].question) || q;
    await c.call('sessions.respond', { id: sid, requestId: req.requestId, response: { answers: { [question]: 'Blue' } } });
    const res = await c.waitFor(() => itemList(sid).find((it) => !before.has(it.id) && it.type === 'result'), 120000, 'result after answer');
    if (typeof res.costUsd === 'number') spend.results += res.costUsd;
    const fresh = itemList(sid).filter((it) => !before.has(it.id));
    k(/BLUE/.test(textOf(fresh)), 'reply does not reflect the choice: ' + short(textOf(fresh), 150));
    const r2 = itemList(sid).find((it) => it.id === req.id);
    k(r2.status === 'answered', 'request status ' + r2.status);
    k(r2.answer, 'request has no answer field');
    const tool = tools(fresh, 'AskUserQuestion')[0];
    k(tool, 'no AskUserQuestion tool item');
    k(tool && tool.status === 'done', 'AskUserQuestion tool status ' + (tool && tool.status) + ' ' + short(tool && tool.result, 150));
    await c.waitFor(() => c.sessions.get(sid).status === 'idle', 10000, 'idle').catch(() => k(false, 'not idle after'));
    return k.result();
  });

  // S6 ------------------------------------------------------------------
  const subagentScenario = async (background) => {
    const fleetSeen = [];
    const t = await turn(sid, `Use the Agent tool (subagent_type "general-purpose", model "haiku", run_in_background ${background}) with this exact task for the subagent: "Use the Bash tool to run: echo sub-agent-ok  then report the output in one line." Do not ask me anything first. After it returns, reply with one line.`, {
      timeout: 240000,
      onTick: () => {},
    });
    const k = checks();
    let ag = tools(t.items, ['Agent', 'Task'])[0];
    // A background agent returns at launch; its children and completion stream in after the
    // turn's result, and the CLI then runs a follow-up turn on the task notification.
    if (ag && /async agent launched|in the background/i.test(String(typeof ag.result === 'string' ? ag.result : (ag.result || {}).text))) {
      note('  agent ran in the background; waiting for it to finish + the follow-up turn');
      await c.waitFor(() => {
        const last = [...evSince(t.idx, 'fleet.updated', sid)].pop();
        const a = last && (last.data.agents || []).find((x) => x.id === ag.toolUseId);
        return a && a.status !== 'running';
      }, 180000, 'background agent to finish');
      await sleep(3000); // the follow-up turn on the task notification starts shortly after
      await c.waitFor(() => c.sessions.get(sid).status === 'idle', 120000, 'idle after the follow-up turn');
      for (const it of itemList(sid)) if (it.type === 'result' && !t.items.some((x) => x.id === it.id) && typeof it.costUsd === 'number' && itemList(sid).indexOf(it) > itemList(sid).indexOf(t.result)) spend.results += it.costUsd;
      const all = itemList(sid);
      t.items = all.slice(all.findIndex((it) => it.id === t.items[0].id));
      ag = tools(t.items, ['Agent', 'Task'])[0];
    }
    for (const e of evSince(t.idx, 'fleet.updated', sid)) fleetSeen.push(...(e.data.agents || []).map((a) => ({ id: a.id, status: a.status, toolCount: a.toolCount, ctx: a.context && a.context.usedTokens })));
    k(ag, 'no Agent/Task tool item; tools=' + tools(t.items).map((x) => x.name).join(','));
    if (!ag) return k.result();
    k(ag.status === 'done', 'agent tool status ' + ag.status);
    const kids = t.items.filter((it) => it.parentToolUseId === ag.toolUseId);
    k(kids.length > 0, 'no child items with parentToolUseId');
    k(kids.some((it) => it.type === 'tool' && it.name === 'Bash'), 'no child Bash tool; kids=' + kids.map((x) => x.type + ':' + (x.name || '')).join(','));
    const mine = fleetSeen.filter((a) => a.id === ag.toolUseId);
    k(mine.length > 0, 'no fleet.updated with the agent ' + short(fleetSeen));
    k(mine.some((a) => a.status === 'running'), 'fleet never showed running');
    const last = mine[mine.length - 1] || {};
    k(last.status === 'done', 'fleet final status ' + last.status);
    k(last.toolCount >= 1, 'fleet toolCount ' + last.toolCount);
    k(mine.some((a) => a.ctx > 0), 'fleet context never filled');
    const kidTools = kids.filter((it) => it.type === 'tool');
    k(last.toolCount === kidTools.length, `fleet toolCount ${last.toolCount} != ${kidTools.length} child tool items (${kidTools.map((x) => x.name).join(',')})`);
    const res = typeof ag.result === 'string' ? ag.result : ag.result && ag.result.text;
    k(/sub-agent-ok/.test(res || '') || /sub-agent-ok/.test(textOf(t.items)), 'agent result ' + short(ag.result, 150));
    if (t.unplanned.length) note('  unplanned requests during the agent turn: ' + short(t.unplanned));
    k(!!(c.sessions.get(sid) || {}).activity === false, 'activity left set at idle: ' + (c.sessions.get(sid) || {}).activity);
    return k.result();
  };
  await scenario(6, 'subagent (foreground) -> child items + fleet', () => subagentScenario(false));
  await capture(sid, 'e2e-after-subagent.png');
  await scenario(15, 'subagent (background) -> children, fleet done, follow-up turn', () => subagentScenario(true));

  // S7 ------------------------------------------------------------------
  await scenario(7, 'interrupt mid-turn', async () => {
    const idx = c.events.length;
    const before = new Set(c.itemsOf(sid).keys());
    await c.call('sessions.send', { id: sid, text: 'Use the Bash tool to run exactly this command: sleep 60' });
    const k = checks();
    await c.waitFor(() => tools(itemList(sid).filter((it) => !before.has(it.id)), 'Bash').find((it) => it.status === 'running'), 90000, 'running sleep');
    await sleep(1500);
    const t0 = Date.now();
    await c.call('sessions.interrupt', { id: sid });
    await c.waitFor(() => c.sessions.get(sid).status === 'idle', 20000, 'idle after interrupt').catch(() => {});
    const took = Date.now() - t0;
    k(c.sessions.get(sid).status === 'idle', 'status after interrupt ' + c.sessions.get(sid).status);
    k(took < 8000, 'interrupt took ' + took + ' ms');
    note('  interrupt -> idle in ' + took + ' ms');
    const fresh = itemList(sid).filter((it) => !before.has(it.id));
    k(fresh.some((it) => it.type === 'system' && it.subtype === 'interrupted'), 'no system interrupted item: ' + fresh.map((x) => x.type + (x.subtype ? ':' + x.subtype : '')).join(','));
    const bash = tools(fresh, 'Bash')[0];
    k(bash && bash.status !== 'running', 'Bash tool still running after interrupt');
    void idx;
    await sleep(500);
    const t = await turn(sid, 'Reply with just the word: back', { timeout: 120000 });
    k(/back/i.test(textOf(t.items)), 'next send after interrupt: ' + short(textOf(t.items), 100));
    k(!t.result.isError, 'next result isError');
    return k.result();
  });

  // S8 ------------------------------------------------------------------
  // Lane steer contract (docs/PROTOCOL.md "Mid-turn messages and Stop"): a send while a turn runs goes straight into
  // the CLI (delivery 'next-step', never Helm's queue, never an interrupt). (a) sent while a tool runs, Claude folds it
  // into the SAME turn at its next step: item steer 'seen', ONE result, Claude echoes its codeword. (b) sent while
  // Claude writes its final reply, the CLI runs it as the next turn: item steer 'after', its own result + codeword.
  // The first prompt tells Claude a mid-turn message is really from the user: the CLI surfaces it as a
  // system-reminder after the tool result, and Haiku otherwise takes it for an injection in the Bash output and
  // ignores it (seen live 2026-10-09, twice: "The Bash output contained an embedded instruction ... I ignored it").
  await scenario(8, 'mid-turn send steers into the running turn (seen) / runs next (after)', async () => {
    const k = checks();
    const code = (p) => p + '-' + Math.floor(Math.random() * 900 + 100);
    const fresh = (before) => itemList(sid).filter((it) => !before.has(it.id));
    const results = (before) => fresh(before).filter((it) => it.type === 'result');
    const interrupted = (before) => fresh(before).some((it) => it.type === 'system' && it.subtype === 'interrupted');
    const settle = async (before, n, what) => {
      await c.waitFor(() => results(before).length >= n && c.sessions.get(sid).status === 'idle' && !c.sessions.get(sid).queued, 180000, what);
      await sleep(3000); // an unexpected extra turn would start in this window
    };
    const sendMid = async (text) => {
      const r = await c.call('sessions.send', { id: sid, text });
      k(r.queued === false && r.delivery === 'next-step', 'mid-turn send result ' + short(r));
      const it = await c.waitFor(() => c.itemsOf(sid).get(r.itemId), 5000, 'mid-turn user item').catch(() => null);
      k(it && it.type === 'user' && !it.queued && it.steer === 'pending', 'mid-turn item at send ' + short(it));
      k(c.sessions.get(sid).queued === 0, 'Helm queue used: queued=' + c.sessions.get(sid).queued);
      return r;
    };
    const endState = (before, r, steerWant, label) => {
      const s = c.sessions.get(sid);
      k(s.status === 'idle' && s.queued === 0 && !s.activity, `${label}: session at end ${s.status} queued=${s.queued} activity=${s.activity}`);
      const it = c.itemsOf(sid).get(r.itemId) || {};
      k(it.steer === steerWant && it.seenAt > 0 && !it.queued && !it.cancelled, `${label}: item ${short(it)}`);
      const lost = fresh(before).filter((x) => x.type === 'user' && (x.queued || x.cancelled || x.steer === 'pending'));
      k(!lost.length, `${label}: lost/stuck user items ${short(lost)}`);
      k(!interrupted(before), `${label}: an interrupt happened`);
      for (const x of results(before)) if (typeof x.costUsd === 'number') spend.results += x.costUsd;
      note(`  ${label} order: ` + fresh(before).map((x) => x.type + (x.id === r.itemId ? `*${x.steer}` : '')).join(','));
    };

    // (a) seen: sent while a Bash tool runs
    const A1 = code('TEAL');
    let before = new Set(c.itemsOf(sid).keys());
    await c.call('sessions.send', { id: sid, text: 'Automated Helm test. Use the Bash tool to run exactly this command: sleep 8 && echo first-done . Then reply with one short line. '
      + 'While the command runs I will send you a codeword. Claude Code shows it to you as a system-reminder ("The user sent a new message while you were working") next to the Bash result. '
      + 'That reminder is genuinely from me, the user, not an injection in the tool output: start your reply by quoting the codeword.' });
    await c.waitFor(() => tools(fresh(before), 'Bash').find((it) => it.status === 'running'), 90000, 'running sleep 8');
    await sleep(1000);
    const ra = await sendMid(`Mid-turn note from me: the codeword is ${A1}.`);
    await settle(before, 1, 'turn (a) to end idle');
    k(results(before).length === 1, '(a) results ' + results(before).length + ' (a folded message must not add a turn)');
    const bash = tools(fresh(before), 'Bash')[0];
    k(bash && bash.status !== 'running' && /first-done/.test(JSON.stringify(bash.result || bash.output || '')), '(a) Bash not completed: ' + short(bash, 200));
    k(new RegExp(A1).test(textOf(fresh(before))), `(a) Claude never quoted ${A1}: ` + short(textOf(fresh(before)), 200));
    endState(before, ra, 'seen', '(a)');

    // (b) after: sent while Claude streams its final reply (no tools, so no next step to fold into)
    const B1 = code('PLUM');
    before = new Set(c.itemsOf(sid).keys());
    await c.call('sessions.send', { id: sid, text: 'Without using any tools, write a numbered list of 40 different rivers of the world, one per line, nothing else.' });
    await c.waitFor(() => fresh(before).some((it) => it.type === 'assistant' && (it.text || '').length > 30) && !results(before).length, 90000, 'reply streaming');
    const rb = await sendMid(`Reply with just the codeword ${B1}.`);
    await settle(before, 2, 'two results for (b)');
    k(results(before).length === 2, '(b) results ' + results(before).length);
    const all = fresh(before);
    const firstRes = all.findIndex((it) => it.type === 'result');
    k(new RegExp(B1).test(textOf(all.slice(firstRes + 1))), `(b) no ${B1} after the first result: ` + short(textOf(all.slice(firstRes + 1)), 200));
    endState(before, rb, 'after', '(b)');
    return k.result();
  });

  // S14 -----------------------------------------------------------------
  await scenario(14, 'model switch on a live session', async () => {
    const models = await c.call('sessions.models');
    note('  models: ' + short((models || []).map((m) => m.value), 300));
    const k = checks();
    const ids = (models || []).map((m) => m.value);
    // a concrete id (aliases like "haiku" can resolve to MODEL itself), cheapest family first
    const concrete = ids.filter((v) => /^claude-/.test(v) && !MODEL.startsWith(v) && !v.startsWith(MODEL));
    const alt = concrete.find((v) => /haiku/i.test(v)) || concrete.find((v) => /sonnet/i.test(v)) || concrete[0];
    k(alt, 'no alternative model in ' + short(ids));
    if (!alt) return k.result();
    const up = await c.call('sessions.update', { id: sid, model: alt });
    k(up.model === alt, 'update returned model ' + up.model);
    const t = await turn(sid, 'Reply with just: switched', { timeout: 120000 });
    const asst = t.items.find((it) => it.type === 'assistant');
    note(`  asked for ${alt}; assistant.model=${asst && asst.model}`);
    const norm = (m) => String(m || '').toLowerCase().replace(/\[.*\]$/, '');
    const fam = (m) => (/(opus|sonnet|haiku)/.exec(norm(m)) || [])[1];
    k(asst && (norm(asst.model).startsWith(norm(alt)) || norm(alt).startsWith(norm(asst.model)) || (fam(alt) && fam(alt) === fam(asst.model) && fam(alt) !== fam(MODEL)) || alt === 'default'), `assistant model ${asst && asst.model} vs ${alt}`);
    await c.call('sessions.update', { id: sid, model: MODEL });
    return k.result();
  });

  // S5 (session B, default permission mode) ------------------------------
  await scenario(5, 'permission prompts in default mode', async () => {
    const sb = await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'default' });
    const bid = sb.id;
    const k = checks();
    const runWith = async (word, decide) => {
      const before = new Set(c.itemsOf(bid).keys());
      // `echo` alone is a read-only command Claude Code auto-allows; touch makes it ask.
      await c.call('sessions.send', { id: bid, text: `Use the Bash tool to run exactly this command: touch ${word}.txt && echo ${word}   If it is denied, do not retry; just reply: denied. Otherwise reply: ran.` });
      const reqs = []; const seenAt = new Map();
      const res = await c.waitFor(() => {
        for (const it of itemList(bid)) {
          if (before.has(it.id) || it.type !== 'request' || it.status !== 'pending' || reqs.includes(it.requestId)) continue;
          // answer like a person would: once the session shows waiting (session.updated is debounced)
          if (!seenAt.has(it.requestId)) seenAt.set(it.requestId, Date.now());
          if (c.sessions.get(bid).status !== 'waiting' && Date.now() - seenAt.get(it.requestId) < 3000) continue;
          reqs.push(it.requestId);
          const response = decide(it, reqs.length);
          c.call('sessions.respond', { id: bid, requestId: it.requestId, response }).catch((e) => note('respond failed ' + e.message));
        }
        return itemList(bid).find((it) => !before.has(it.id) && it.type === 'result');
      }, 150000, 'result in session B');
      if (typeof res.costUsd === 'number') spend.results += res.costUsd;
      await c.waitFor(() => c.sessions.get(bid).status === 'idle', 10000, 'idle').catch(() => {});
      const fresh = itemList(bid).filter((it) => !before.has(it.id));
      return { fresh, reqs, reqItems: fresh.filter((it) => it.type === 'request') };
    };
    // 1: deny with a message
    let sawWaiting = false;
    const r1 = await runWith('perm-one', (it) => { sawWaiting = c.sessions.get(bid).status === 'waiting'; return { behavior: 'deny', message: 'Not now (e2e denies this one).' }; });
    k(r1.reqItems.length >= 1 && r1.reqItems[0].kind === 'permission' && r1.reqItems[0].toolName === 'Bash', 'turn1 request ' + short(r1.reqItems));
    k(sawWaiting, 'status was not waiting while the permission was pending');
    const b1 = tools(r1.fresh, 'Bash')[0];
    k(b1 && b1.status === 'denied', 'denied tool status ' + (b1 && b1.status) + ' ' + short(b1 && b1.result, 120));
    k(r1.reqItems[0] && r1.reqItems[0].status === 'answered', 'request status ' + (r1.reqItems[0] && r1.reqItems[0].status));
    // 2: allow once
    const r2 = await runWith('perm-two', () => ({ behavior: 'allow' }));
    const b2 = tools(r2.fresh, 'Bash')[0];
    k(r2.reqItems.length === 1, 'turn2 requests ' + r2.reqItems.length);
    k(b2 && b2.status === 'done' && /perm-two/.test(typeof b2.result === 'string' ? b2.result : (b2.result || {}).text || ''), 'allowed tool ' + short(b2, 200));
    // 3: allow always
    const r3 = await runWith('perm-three', () => ({ behavior: 'allow', always: true }));
    const b3 = tools(r3.fresh, 'Bash')[0];
    k(r3.reqItems.length === 1 && b3 && b3.status === 'done', 'turn3 ' + r3.reqItems.length + ' ' + short(b3 && b3.status));
    // 4: no prompt
    const r4 = await runWith('perm-four', () => ({ behavior: 'deny', message: 'should not have been asked' }));
    const b4 = tools(r4.fresh, 'Bash')[0];
    k(r4.reqItems.length === 0, 'allow-always did not skip the prompt: ' + short(r4.reqItems.map((x) => x.input)));
    k(b4 && b4.status === 'done', 'turn4 tool ' + short(b4 && b4.status));
    spend.bySession.set(bid, () => (c.sessions.get(bid) || {}).costUsd || 0);
    return k.result();
  });

  // S12 -----------------------------------------------------------------
  await scenario(12, 'queue job runs and finishes', async () => {
    const idx = c.events.length;
    const job = await c.call('queue.add', { prompt: 'Reply with just: QUEUE-OK', cwd: repo, model: MODEL, permissionMode: 'bypassPermissions', runAfter: null, maxFiveHourPercent: 100 });
    const k = checks();
    k(job.status === 'queued', 'added status ' + job.status);
    const t0 = Date.now();
    const started = await c.waitFor(() => evSince(idx, 'queue.updated').map((e) => (e.data.queue || []).find((j) => j.id === job.id)).find((j) => j && j.status !== 'queued'), 70000, 'job start').catch((e) => { k(false, e.message + ' waitReason=' + short(evSince(idx, 'queue.updated').map((x) => (x.data.queue || []).find((j) => j.id === job.id)).pop())); return null; });
    if (!started) return k.result();
    note(`  job started after ${Date.now() - t0} ms (${started.status})`);
    const done = await c.waitFor(() => { const j = (evSince(idx, 'queue.updated').pop() || { data: {} }).data.queue; const x = (j || []).find((q) => q.id === job.id); return x && ['done', 'failed', 'cancelled'].includes(x.status) ? x : null; }, 180000, 'job finish');
    k(done.status === 'done', 'job status ' + done.status + ' ' + short(done));
    k(done.summary && /QUEUE-OK/.test(done.summary), 'summary ' + short(done.summary));
    k(done.sessionId, 'no sessionId on job');
    k(evSince(idx, 'queue.updated').length >= 2, 'queue.updated count ' + evSince(idx, 'queue.updated').length);
    if (done.sessionId) spend.bySession.set(done.sessionId, () => (c.sessions.get(done.sessionId) || {}).costUsd || 0);
    return k.result();
  });

  // S11 -----------------------------------------------------------------
  await scenario(11, 'usage.get', async () => {
    const u = await c.call('usage.get');
    note('  usage: ' + short(u, 400));
    const k = checks();
    k(u && typeof u.source === 'string', 'no source');
    const okNum = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
    k(u && u.fiveHour !== undefined && u.week !== undefined, 'missing fiveHour/week keys');
    k(u && (!u.fiveHour || okNum(u.fiveHour.percent)), 'fiveHour.percent ' + short(u && u.fiveHour));
    k(u && (!u.week || okNum(u.week.percent)), 'week.percent ' + short(u && u.week));
    const anyNum = u && ((u.fiveHour && typeof u.fiveHour.percent === 'number') || typeof u.costTodayUsd === 'number');
    k(anyNum || (u && u.reason), 'no numbers and no reason');
    return k.result();
  });

  const costA = () => (c.sessions.get(sid) || {}).costUsd || 0;
  spend.bySession.set(sid, costA);

  // S9 / S10 ------------------------------------------------------------
  if (want(9) || want(10)) {
    const before = { ...c.sessions.get(sid) };
    // the engine's own live transcript (queued prompts moved to where they were sent)
    const liveItems = (await c.call('sessions.history', { id: sid, limit: 1000 })).items;
    const otherCosts = [...spend.bySession.entries()].filter(([k]) => k !== sid).map(([k, f]) => [k, f()]);
    note('stopping app for restart');
    await stopApp(A);
    A = await startApp();
    const c2 = A.c;
    await scenario(9, 'restart keeps the session and resumes the conversation', async () => {
      const k = checks();
      const hello2 = await c2.call('app.hello');
      const s2 = (hello2.sessions || []).find((x) => x.id === sid);
      k(s2, 'session not listed after restart');
      k(s2 && s2.claudeSessionId === before.claudeSessionId, 'claudeSessionId changed ' + (s2 && s2.claudeSessionId) + ' vs ' + before.claudeSessionId);
      k(s2 && s2.title === before.title, 'title changed');
      k(s2 && Math.abs((s2.costUsd || 0) - (before.costUsd || 0)) < 1e-6, 'cost not kept ' + (s2 && s2.costUsd) + ' vs ' + before.costUsd);
      const h = await c2.call('sessions.history', { id: sid });
      k(h && h.items && h.items.length >= 5, 'history items ' + (h && h.items && h.items.length));
      k(h && h.items.some((it) => it.type === 'user' && /PELICAN/.test(it.text || '')), 'history lacks the first prompt');
      k(h && h.items.some((it) => it.type === 'tool'), 'history has no tool items');
      // the transcript rebuilt from disk must match what streamed live
      const hist = (h && h.items) || [];
      const sig = (list) => list.filter((it) => it.type === 'user').map((it) => (it.text || '').slice(0, 30));
      const liveSent = liveItems.filter((it) => !it.cancelled);
      k(JSON.stringify(sig(hist)) === JSON.stringify(sig(liveSent)), 'user prompts differ: live ' + short(sig(liveSent), 400) + ' vs history ' + short(sig(hist), 400));
      const userOrder = (list) => list.filter((it) => it.type === 'user' || it.type === 'result').map((it) => it.type[0]).join('');
      note('  live u/r order    ' + userOrder(liveItems));
      note('  history u/r order ' + userOrder(hist));
      const hTools = new Map(hist.filter((it) => it.type === 'tool').map((it) => [it.toolUseId, it]));
      const toolDiffs = [];
      for (const lt of liveItems.filter((it) => it.type === 'tool')) {
        const ht = hTools.get(lt.toolUseId);
        if (!ht) { toolDiffs.push(`${lt.name} ${lt.toolUseId} missing`); continue; }
        if (ht.status !== lt.status) toolDiffs.push(`${lt.name} status live=${lt.status} history=${ht.status}`);
        if ((ht.parentToolUseId || null) !== (lt.parentToolUseId || null)) toolDiffs.push(`${lt.name} parent live=${lt.parentToolUseId} history=${ht.parentToolUseId}`);
        if (ht.name !== lt.name) toolDiffs.push(`name live=${lt.name} history=${ht.name}`);
      }
      k(!toolDiffs.length, 'tool items differ after reload: ' + toolDiffs.join('; '));
      const nRes = (list) => list.filter((it) => it.type === 'result').length;
      k(nRes(hist) === nRes(liveItems), `result items live ${nRes(liveItems)} vs history ${nRes(hist)}`);
      const asstText = (list) => list.filter((it) => it.type === 'assistant').map((it) => (it.text || '').trim()).filter(Boolean);
      const missingText = asstText(liveItems).filter((x) => !asstText(hist).includes(x));
      k(!missingText.length, 'assistant texts missing after reload: ' + short(missingText, 200));
      const lReq = liveItems.filter((it) => it.type === 'request').length, hReq = hist.filter((it) => it.type === 'request').length;
      if (lReq !== hReq) note(`  request items live ${lReq} vs history ${hReq}`);
      const lSys = liveItems.filter((it) => it.type === 'system').map((it) => it.subtype).join(','), hSys = hist.filter((it) => it.type === 'system').map((it) => it.subtype).join(',');
      if (lSys !== hSys) note(`  system items live [${lSys}] vs history [${hSys}]`);
      for (const it of hist) c2.itemsOf(sid).set(it.id, it);
      const t = await turn(sid, 'What was the codeword I asked you to remember at the very start of this conversation? Reply with just the word.', { timeout: 150000 });
      k(/PELICAN/i.test(textOf(t.items)), 'model did not remember: ' + short(textOf(t.items), 150));
      const s3 = A.c.sessions.get(sid);
      k(s3 && s3.claudeSessionId === before.claudeSessionId, 'resume forked to a new claudeSessionId ' + (s3 && s3.claudeSessionId));
      return k.result();
    });
    await scenario(10, 'history.search finds the session', async () => {
      const k = checks();
      const hidden = await c2.call('history.search', { q: 'PELICAN', limit: 20 });
      k(!(hidden || []).some((e) => e.claudeSessionId === before.claudeSessionId), 'a temp-dir session showed up without includeTemp');
      const r = await c2.call('history.search', { q: 'PELICAN', limit: 20, includeTemp: true });
      const hit = (r || []).find((e) => e.claudeSessionId === before.claudeSessionId || e.helmSessionId === sid);
      k(hit, 'not found: ' + short((r || []).map((e) => e.title), 200));
      k(hit && hit.helmSessionId === sid, 'helmSessionId ' + (hit && hit.helmSessionId));
      k(hit && hit.cwd && path.resolve(hit.cwd).toLowerCase() === path.resolve(repo).toLowerCase(), 'cwd ' + (hit && hit.cwd));
      k(hit && /PELICAN/.test(hit.firstPrompt || hit.title || ''), 'firstPrompt ' + short(hit && hit.firstPrompt));
      return k.result();
    });
    const totalSessions = (A.c.sessions.get(sid) || {}).costUsd || before.costUsd || 0;
    spend.final = totalSessions + otherCosts.reduce((a, [, v]) => a + v, 0);
  } else {
    spend.final = [...spend.bySession.values()].reduce((a, f) => a + f(), 0);
  }

  // S16 (lane engine-plus) ------------------------------------------------
  await scenario(16, 'fork + edit & resend', async () => {
    const c3 = A.c;
    const k = checks();
    const costOf = (id) => (c3.sessions.get(id) || {}).costUsd || 0;
    const srcCost0 = costOf(sid);
    const hist = async (id) => (await c3.call('sessions.history', { id, limit: 1000 })).items;
    const prompts = (list) => list.filter((it) => it.type === 'user' && !it.queued && !it.cancelled);
    let src = await hist(sid);
    if (!prompts(src).some((it) => /PELICAN/.test(it.text || ''))) await turn(sid, 'Remember this codeword for later: PELICAN. Reply with just: ok');
    src = await hist(sid);
    if (prompts(src).length < 2) await turn(sid, 'Reply with just: two');
    src = await hist(sid);
    const srcSession = c3.sessions.get(sid) || {};
    const target = prompts(src)[1];
    const edited = 'What was the codeword I asked you to remember? Reply with just the codeword and then the word FORKED.';
    const idx = c3.events.length;
    const f = await c3.call('sessions.fork', { id: sid, itemId: target.id, text: edited });
    k(f && f.id && f.id !== sid, 'fork id ' + short(f));
    k(f && / \(fork\)$/.test(f.title || ''), 'fork title ' + short(f && f.title));
    k(f && f.claudeSessionId && f.claudeSessionId !== srcSession.claudeSessionId, 'fork claudeSessionId ' + (f && f.claudeSessionId));
    k(evSince(idx, 'session.created').some((e) => e.data.id === f.id), 'no session.created for the fork');
    const res = await c3.waitFor(() => itemList(f.id).find((it) => it.type === 'result'), 150000, 'fork reply');
    if (typeof res.costUsd === 'number') spend.results += res.costUsd;
    await c3.waitFor(() => { const s = c3.sessions.get(f.id); return s && s.status === 'idle'; }, 15000, 'fork idle').catch(() => {});
    const fh = await hist(f.id);
    const fPrompts = prompts(fh).map((it) => it.text || '');
    note('  fork prompts ' + short(fPrompts, 300));
    k(fPrompts.some((t) => /PELICAN/.test(t)), 'fork lacks the inherited first prompt: ' + short(fPrompts));
    k(!fPrompts.includes(target.text), 'fork still has the replaced prompt');
    k(fPrompts[fPrompts.length - 1] === edited, 'last prompt is not the edited one: ' + short(fPrompts.slice(-1)));
    const reply = textOf(fh.slice(fh.findIndex((it) => it.type === 'user' && it.text === edited)));
    k(/PELICAN/i.test(reply) && /FORKED/i.test(reply), 'fork reply did not use the inherited conversation: ' + short(reply, 150));
    const srcAfter = await hist(sid);
    k(srcAfter.length === src.length, `source changed: ${src.length} -> ${srcAfter.length} items`);
    // Whole-conversation fork without a prompt: every prompt inherited, no turn started.
    const w = await c3.call('sessions.fork', { id: sid });
    const wh = await hist(w.id);
    const sigOf = (list) => prompts(list).map((it) => (it.text || '').slice(0, 40));
    k(JSON.stringify(sigOf(wh)) === JSON.stringify(sigOf(srcAfter)), 'whole fork prompts ' + short(sigOf(wh)) + ' vs ' + short(sigOf(srcAfter)));
    k((c3.sessions.get(w.id) || w).status !== 'working', 'whole fork started a turn');
    spend.final = (spend.final || 0) + (costOf(sid) - srcCost0) + costOf(f.id);
    return k.result();
  });

  // S18 (lane reaper) -------------------------------------------------------
  // Idle CLI close (main/engine/idle-reaper.js) with a tiny --test window (test.idleClose): idle sessions lose their
  // claude.exe (process really gone, session looks the same), viewing one does not respawn it, the next send resumes
  // the same conversation; a session with a background task running keeps its CLI.
  await scenario(18, 'idle CLI close: reaped quietly, view does not respawn, resumes in context; background task keeps its CLI', async () => {
    const c = A.c;
    const k = checks();
    const costOf = (id) => (c.sessions.get(id) || {}).costUsd || 0;
    await c.call('test.idleClose', { idleMs: 0 }); // off while the sessions are set up
    const mkS = async () => (await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' })).id;
    const r1 = await mkS(), r2 = await mkS(), r3 = await mkS();
    try {
      await turn(r1, 'Remember this codeword for later: TOUCAN. Reply with just: ok');
      await turn(r3, 'Reply with just: ok');
      await turn(r2, 'Use the Bash tool with run_in_background set to true to run exactly this command: sleep 100 . Do not wait for it and do not check on it. Then reply with just: started', { timeout: 150000 });
      await c.waitFor(() => (c.sessions.get(r2) || {}).openTasks > 0, 20000, 'r2 background task').catch(() => {});
      k((c.sessions.get(r2) || {}).openTasks > 0, `r2 shows no background task (openTasks ${(c.sessions.get(r2) || {}).openTasks})`);
      const st = (inf, id) => (inf.sessions || []).find((x) => x.id === id) || {};
      const inf0 = await c.call('test.idleClose', {});
      const pid1 = st(inf0, r1).pid, pid2 = st(inf0, r2).pid;
      k(st(inf0, r1).live && pid1 && st(inf0, r2).live && st(inf0, r3).live, 'r1/r2/r3 not all live before the window: ' + short(inf0.sessions.filter((x) => [r1, r2, r3].includes(x.id))));
      const pre = cliProcs(A.child.pid);
      note(`  before: ${pre.count} claude.exe (${inf0.live} live sessions), CLI trees ${pre.procs} procs, working set ${pre.wsMB} MB, private ${pre.privMB} MB`);
      const look = (s) => s && { status: s.status, title: s.title, updatedAt: s.updatedAt, activity: s.activity || null, claudeSessionId: s.claudeSessionId };
      const before1 = look(c.sessions.get(r1));
      await c.call('test.idleClose', { idleMs: 4000, everyMs: 500 });
      let inf1 = inf0;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        inf1 = await c.call('test.idleClose', {});
        if (!st(inf1, r1).live && !st(inf1, r3).live) break;
        await sleep(500);
      }
      k(!st(inf1, r1).live && !st(inf1, r3).live, 'idle sessions still live after 30 s: ' + short(inf1.sessions));
      await sleep(5000); // several more sweeps past the window
      const inf2 = await c.call('test.idleClose', {});
      k(st(inf2, r2).live && st(inf2, r2).pid === pid2, 'the session with a background task lost its CLI');
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = !pidAlive(pid1); if (!gone) await sleep(500); }
      k(gone, `r1's claude.exe (pid ${pid1}) still running after its close`);
      k(inf2.closed >= 2, 'stats.closed ' + inf2.closed);
      k(JSON.stringify(look(c.sessions.get(r1))) === JSON.stringify(before1), 'r1 looks different after the close: ' + short(look(c.sessions.get(r1))) + ' vs ' + short(before1));
      const post = cliProcs(A.child.pid);
      note(`  after:  ${post.count} claude.exe (${inf2.live} live sessions), CLI trees ${post.procs} procs, working set ${post.wsMB} MB, private ${post.privMB} MB (closed ${inf2.closed})`);
      k(post.count < pre.count, `claude.exe count ${pre.count} -> ${post.count}`);
      // viewing it (history from disk + mark read) must not start a CLI
      await c.call('sessions.history', { id: r1, limit: 200 });
      await c.call('sessions.markRead', { id: r1 });
      await sleep(1500);
      k(!st(await c.call('test.idleClose', {}), r1).live, 'viewing r1 respawned its CLI');
      // the next message resumes the same conversation, showing Starting while the CLI comes up
      const idx = c.events.length;
      const t = await turn(r1, 'What was the codeword I asked you to remember earlier in this conversation? Reply with just the word.', { timeout: 150000 });
      k(/TOUCAN/i.test(textOf(t.items)), 'resumed session did not remember: ' + short(textOf(t.items), 150));
      k(evSince(idx, 'session.updated', r1).some((e) => e.data.activity === 'Starting'), 'no "Starting" activity while the CLI came up');
      k((c.sessions.get(r1) || {}).claudeSessionId === before1.claudeSessionId, 'resume changed claudeSessionId');
      const inf3 = await c.call('test.idleClose', { idleMs: 0 });
      k(inf3.resumed >= 1, 'stats.resumed ' + inf3.resumed);
      k(st(inf3, r2).live, 'r2 lost its CLI by the end');
      let logTxt = '';
      try { logTxt = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8'); } catch {}
      k(logTxt.includes(`closed idle CLI for ${r1}`), 'no reap log line for r1');
      k(logTxt.includes(`resumed idle-closed CLI for ${r1}`), 'no resume log line for r1');
    } finally {
      await c.call('test.idleClose', { idleMs: null }).catch(() => {});
      spend.final = (spend.final || 0) + costOf(r1) + costOf(r2) + costOf(r3);
    }
    return k.result();
  });

  // S19 (lane tabrelease) ---------------------------------------------------
  // sessions.release (the user closing a session's tab) with the idle window OFF (Never: a release still closes):
  // an idle session's claude.exe really ends now, viewing it does not respawn it, a follow-up resumes in context;
  // a release mid-turn lets the turn finish normally, then the CLI closes within one (fast, --test) sweep.
  await scenario(19, 'tab release: idle CLI closes now, resumes in context; mid-turn release waits for the turn, then closes', async () => {
    const c = A.c;
    const k = checks();
    const costOf = (id) => (c.sessions.get(id) || {}).costUsd || 0;
    const st = (inf, id) => (inf.sessions || []).find((x) => x.id === id) || {};
    await c.call('test.idleClose', { idleMs: 0, everyMs: 500 }); // window Never; marked releases swept every 0.5 s
    const mkS = async () => (await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' })).id;
    const q1 = await mkS(), q2 = await mkS();
    try {
      await turn(q1, 'Remember this codeword for later: HERON. Reply with just: ok');
      await turn(q2, 'Reply with just: ok');
      const inf0 = await c.call('test.idleClose', {});
      const pid1 = st(inf0, q1).pid, pid2 = st(inf0, q2).pid;
      k(st(inf0, q1).live && pid1 && st(inf0, q2).live && pid2, 'q1/q2 not live before the release: ' + short(inf0.sessions.filter((x) => [q1, q2].includes(x.id))));
      const pre = cliProcs(A.child.pid);
      note(`  before release: ${pre.count} claude.exe under the test app (${inf0.live} live sessions)`);
      const look = (s) => s && { status: s.status, title: s.title, updatedAt: s.updatedAt, activity: s.activity || null, claudeSessionId: s.claudeSessionId };
      const before1 = look(c.sessions.get(q1));

      // 1. idle: closed now
      const r1 = await c.call('sessions.release', { id: q1 });
      k(r1 && r1.action === 'closed', 'idle release: ' + short(r1));
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = !pidAlive(pid1); if (!gone) await sleep(500); }
      k(gone, `q1's claude.exe (pid ${pid1}) still running after the release`);
      const mid = cliProcs(A.child.pid);
      note(`  after idle release: ${mid.count} claude.exe (was ${pre.count})`);
      k(mid.count === pre.count - 1, `claude.exe count ${pre.count} -> ${mid.count} (expected one fewer)`);
      k(!mid.pids.includes(pid1) && mid.pids.includes(pid2), 'the wrong claude.exe went: ' + short(mid.pids));
      await sleep(500);
      k(JSON.stringify(look(c.sessions.get(q1))) === JSON.stringify(before1), 'q1 looks different after the release: ' + short(look(c.sessions.get(q1))) + ' vs ' + short(before1));
      await c.call('sessions.history', { id: q1, limit: 200 });
      await c.call('sessions.markRead', { id: q1 });
      await sleep(1500);
      k(!st(await c.call('test.idleClose', {}), q1).live, 'viewing q1 respawned its CLI');
      const t1 = await turn(q1, 'What was the codeword I asked you to remember earlier in this conversation? Reply with just the word.', { timeout: 150000 });
      k(/HERON/i.test(textOf(t1.items)), 'resumed session did not remember: ' + short(textOf(t1.items), 150));
      k((c.sessions.get(q1) || {}).claudeSessionId === before1.claudeSessionId, 'resume changed claudeSessionId');

      // 2. mid-turn: marked, the turn finishes, then the CLI closes within a sweep
      let r2 = null, releasing = false, released = null;
      const t2 = await turn(q2, 'Use the Bash tool to run exactly this command: sleep 8 && echo slept . Wait for it to finish. Then reply with just: done', {
        timeout: 150000,
        onTick: () => {
          if (releasing) return;
          if (!itemList(q2).some((it) => it.type === 'tool' && it.name === 'Bash' && it.status === 'running')) return;
          releasing = true;
          c.call('sessions.release', { id: q2 }).then((r) => { r2 = r; }, (e) => { r2 = { error: e.message }; });
          c.call('test.idleClose', {}).then((inf) => { released = st(inf, q2); }, () => {});
        },
      });
      k(releasing, 'the Bash tool never showed as running, so no mid-turn release was sent');
      k(r2 && r2.action === 'marked', 'mid-turn release: ' + short(r2));
      k(released && released.live, 'q2 was not live right after the mid-turn release: ' + short(released));
      const bash = tools(t2.items, 'Bash')[0];
      const bashRes = bash && (typeof bash.result === 'string' ? bash.result : bash.result && bash.result.text);
      k(bash && bash.status === 'done' && /slept/.test(bashRes || ''), 'the Bash tool did not finish normally: ' + short(bash && { status: bash.status, result: bash.result }));
      k(/done/i.test(textOf(t2.items)) && !t2.result.isError, 'the turn did not finish normally: ' + short(textOf(t2.items), 150));
      const tEnd = Date.now();
      let inf2 = null;
      while (Date.now() - tEnd < 10000) {
        inf2 = await c.call('test.idleClose', {});
        if (!st(inf2, q2).live) break;
        await sleep(250);
      }
      const closedAfter = Date.now() - tEnd;
      k(inf2 && !st(inf2, q2).live, 'q2 still live 10 s after its turn ended');
      k(closedAfter < 5000, `q2 closed ${closedAfter} ms after its turn (sweep every 500 ms)`);
      gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = !pidAlive(pid2); if (!gone) await sleep(500); }
      k(gone, `q2's claude.exe (pid ${pid2}) still running after the marked release`);
      const post = cliProcs(A.child.pid);
      note(`  after mid-turn release: ${post.count} claude.exe (q2 closed ${closedAfter} ms after its turn ended)`);
      k(!post.pids.includes(pid2), 'q2 claude.exe still listed');
      let logTxt = '';
      try { logTxt = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8'); } catch {}
      k(logTxt.includes(`closed CLI for ${q1}: released on tab close`), 'no release log line for q1');
      k(logTxt.includes(`closed CLI for ${q2} released on tab close (now idle)`), 'no marked-release log line for q2');
    } finally {
      await c.call('test.idleClose', { idleMs: null, everyMs: 60000 }).catch(() => {});
      spend.final = (spend.final || 0) + costOf(q1) + costOf(q2);
    }
    return k.result();
  });
}

(async () => {
  let crashed = null;
  try { await main(); } catch (e) { crashed = e; console.error('e2e crashed:', e.stack || e.message); }
  finally {
    if (A) {
      const log = path.join(userData, 'logs', 'main.log');
      try {
        const txt = fs.readFileSync(log, 'utf8');
        const bad = txt.split('\n').filter((l) => /error|threw|failed|unhandled/i.test(l)).slice(-15);
        if (bad.length) { console.log('\n--- main.log error lines (last 15) ---'); for (const l of bad) console.log('  ' + l.slice(0, 300)); }
      } catch {}
      await stopApp(A);
    }
    if (!KEEP) {
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(projectDirFor(repo), { recursive: true, force: true }); } catch {}
    } else console.log(`kept: ${repo}  ${userData}  ${projectDirFor(repo)}`);
  }
  console.log('\n=== e2e summary ===');
  for (const r of results.sort((a, b) => a.n - b.n)) console.log(`S${String(r.n).padEnd(3)} ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  :: ' + r.reason}`);
  const pass = results.filter((r) => r.ok).length;
  console.log(`live spend: $${(spend.final || 0).toFixed(4)} (session totals); $${spend.results.toFixed(4)} (sum of result items seen)`);
  console.log(`e2e: ${pass} passed, ${results.length - pass} failed${crashed ? ', CRASHED' : ''}`);
  process.exitCode = crashed ? 2 : results.length - pass ? 1 : 0;
})();
