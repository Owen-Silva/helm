// Production guard, LIVE (lane guard): a hidden `Helm.exe --test` (own profile, never port 4871 or
// %APPDATA%\Helm) running real claude-haiku-5-5 turns in bypassPermissions mode, in a TEMP git repo whose
// only remote is a LOCAL bare repo. The bare repo is made the protected "Shop" repo for this run via HELM_TEST_PROD_GUARD
// (honoured only under --test). No real remote is ever touched; railway is a stub script on PATH.
//
//   node test/engine/prod-guard.live.js [--model=claude-haiku-5-5] [--exe=dist/Helm/Helm.exe] [--keep]
//
// Checks: 1 card appears + Deny blocks (bare master unchanged)  2 Allow once lets it through
//         3 the user typed "commit and push" → no card, a visible "allowed · you said" line, pushed
//         4 the user typed "commit, don't push" → a later push still gets the card
//         5 railway up (stub) → card, Deny → stub never ran    6 interrupt while the card waits → blocked
// Each check runs in a fresh session (3 and 4 share one), so no check depends on what Claude made of an earlier one.
// Summary line: `guard-live: N passed, M failed` (+ live spend).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { dropLiveTranscripts } = require('../../tools/live-cleanup');

const ROOT = path.join(__dirname, '..', '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const MODEL = arg('model') || 'claude-haiku-5-5';
const EXE = path.resolve(ROOT, arg('exe') || 'dist/Helm/Helm.exe');
const KEEP = process.argv.includes('--keep');
const profile = 'guard' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-guard-live-'));
const BARE = path.join(TMP, 'shop-bare.git');
const WORK = path.join(TMP, 'work');
const BIN = path.join(TMP, 'bin');
const STUB_MARK = path.join(TMP, 'railway-ran.txt');
const LOCK = path.join(os.tmpdir(), 'claude-headless-browser.lock'); // lowcpu.js: one Electron/browser at a time
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const note = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's', ...a);
const results = [];
let spend = 0;

function git(cwd, ...a) { return execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString().trim(); }
const gitc = (...a) => git(WORK, '-c', 'user.email=g@helm.local', '-c', 'user.name=helm guard', ...a);
const bareHead = () => git(BARE, 'rev-parse', 'refs/heads/master');
const workHead = () => git(WORK, 'rev-parse', 'HEAD');

function setup() {
  git(TMP, 'init', '-q', '--bare', '-b', 'master', BARE);
  fs.mkdirSync(WORK);
  git(WORK, 'init', '-q', '-b', 'master');
  // a repo-local identity: Claude's own commits must work (no global identity on this machine; without it Claude
  // stopped to ask for a name, or made one up: checks 3 and 4 then failed or passed by luck)
  git(WORK, 'config', 'user.email', 'g@helm.local');
  git(WORK, 'config', 'user.name', 'helm guard');
  fs.writeFileSync(path.join(WORK, 'notes.txt'), 'one\n');
  gitc('add', '.');
  gitc('commit', '-q', '-m', 'init');
  git(WORK, 'remote', 'add', 'origin', BARE);
  git(WORK, 'push', '-q', '-u', 'origin', 'master'); // the test's own setup push, straight to the local bare repo
  fs.mkdirSync(BIN);
  // railway stub: records that it ran, never touches the network (Git Bash runs the extensionless one)
  fs.writeFileSync(path.join(BIN, 'railway'), `#!/bin/sh\necho "stub railway $*"\necho ran > "${STUB_MARK.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'railway.cmd'), `@echo stub railway %*\r\n@echo ran> "${STUB_MARK}"\r\n`);
}
function newCommit(msg) {
  fs.appendFileSync(path.join(WORK, 'notes.txt'), msg + '\n');
  gitc('commit', '-q', '-am', msg);
  return workHead();
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function takeLock() {
  const end = Date.now() + 8 * 60 * 1000;
  for (let said = false; ;) {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch {}
    if (!cur || !alive(cur.pid) || Date.now() - (cur.time || 0) > 12 * 60 * 1000 || cur.pid === process.pid) {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, time: Date.now(), label: 'guard-live (Helm --test)' }));
      return;
    }
    if (!said) { note(`waiting for the browser/Electron lock held by pid ${cur.pid} (${cur.label})`); said = true; }
    if (Date.now() > end) throw new Error('lock held for over 8 minutes');
    await sleep(2000);
  }
}
function dropLock() { try { const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(LOCK); } catch {} }

function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
let app = null;
async function startApp() {
  const env = { ...process.env, HELM_TEST_PROD_GUARD: JSON.stringify({ repos: [{ name: 'Shop', remotes: [BARE], branches: ['master'] }] }), PATH: BIN + path.delimiter + process.env.PATH };
  const child = spawn(EXE, ['.', '--test', '--profile=' + profile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const m = /HELM_READY (\{.*\})/.exec(out);
    if (m) {
      const ready = JSON.parse(m[1]);
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      note(`app up: pid ${child.pid} port ${ready.port}`);
      return { child, ws, ...client(ws), out: () => out };
    }
    if (child.exitCode !== null) throw new Error('app exited early:\n' + out.slice(-1500));
    await sleep(250);
  }
  killTree(child.pid);
  throw new Error('no HELM_READY in 60 s:\n' + out.slice(-1500));
}
function client(ws) {
  let id = 1;
  const pending = new Map();
  const items = new Map();
  const sessions = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
    if (m.type !== 'event') return;
    const d = m.data || {};
    if (m.event === 'session.item') { if (!items.has(d.sessionId)) items.set(d.sessionId, new Map()); items.get(d.sessionId).set(d.item.id, { ...d.item }); }
    else if (m.event === 'session.itemUpdate') { const it = items.get(d.sessionId) && items.get(d.sessionId).get(d.itemId); if (it) Object.assign(it, d.patch || {}); }
    else if (m.event === 'session.created' || m.event === 'session.updated') sessions.set(d.id, d);
  });
  async function call(method, params = {}, timeout = 30000) {
    const i = id++;
    const m = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, timeout);
      pending.set(i, (r) => { clearTimeout(t); resolve(r); });
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
    });
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  }
  const list = (sid) => [...((items.get(sid) || new Map()).values())];
  async function waitFor(pred, timeout, what) {
    const end = Date.now() + timeout;
    for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(150); }
  }
  return { call, list, sessions, waitFor };
}

async function check(n, name, fn) {
  note(`-- ${n} ${name}`);
  try {
    const why = await fn();
    results.push({ n, name, ok: true, why });
    note(`PASS ${n}: ${why || ''}`);
  } catch (e) {
    results.push({ n, name, ok: false, why: e.message });
    note(`FAIL ${n}: ${e.message}`);
  }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };

// send, then optionally answer the guard card; returns { card, result, newItems }
async function turn(sid, text, { origin, answer, interrupt, timeout = 240000 } = {}) {
  const before = new Set(app.list(sid).map((x) => x.id));
  await app.call('sessions.send', { id: sid, text, ...(origin ? { origin } : {}) });
  let card = null;
  const fresh = () => app.list(sid).filter((x) => !before.has(x.id));
  const res = await app.waitFor(() => {
    const c = fresh().find((x) => x.type === 'request' && x.guard && x.status === 'pending');
    if (c && !card) {
      card = { ...c };
      // session.updated is debounced (60 ms) behind the card item: read the status once it has caught up, then
      // answer (snapshotting it on the poll that first saw the card raced the debounce)
      (async () => {
        await app.waitFor(() => { const s = app.sessions.get(sid); return s && s.status === 'waiting'; }, 5000, 'waiting status').catch(() => {});
        const s = app.sessions.get(sid);
        card.sessionStatus = s && s.status;
        card.activity = s && s.activity;
        if (interrupt) await app.call('sessions.interrupt', { id: sid }).catch((e) => { card.interruptError = e.message; });
        else if (answer) await app.call('sessions.respond', { id: sid, requestId: c.requestId, response: { behavior: answer } }).catch((e) => { card.answerError = e.message; });
      })();
    }
    // any non-guard permission request (should not happen in bypass) is denied so nothing else runs
    for (const r of fresh().filter((x) => x.type === 'request' && !x.guard && x.status === 'pending')) app.call('sessions.respond', { id: sid, requestId: r.requestId, response: { behavior: 'deny' } }).catch(() => {});
    return fresh().find((x) => x.type === 'result');
  }, timeout, 'turn result');
  if (typeof res.costUsd === 'number') spend += res.costUsd;
  await app.waitFor(() => { const s = app.sessions.get(sid); return s && s.status !== 'working' && s.status !== 'waiting'; }, 20000, 'idle').catch(() => {});
  const all = fresh();
  return { card: card || all.find((x) => x.type === 'request' && x.guard) || null, result: res, items: all, text: all.filter((x) => x.type === 'assistant').map((x) => x.text).join(' ') };
}

const PUSH = 'Use the Bash tool to run exactly this one command and nothing else: git push origin master\nDo not retry it or run any other command. Then reply in one short line with what happened.';

async function main() {
  setup();
  await takeLock();
  try {
    app = await startApp();
    // A FRESH session per check (3 and 4 share one: 4 revokes the approval 3 grants). One session for all six
    // let a Deny leak into later checks: Claude read its own earlier "The user declined … Do not retry" and refused
    // the next push before the guard ever saw it (check 2 failed 3 runs of 3 that way; 4 and 6 too).
    const open = async (label) => {
      const s = await app.call('sessions.create', { cwd: WORK, model: MODEL, permissionMode: 'bypassPermissions', title: 'guard ' + label });
      note(`session ${s.id} (${label}) in ${WORK}`);
      return s.id;
    };
    const shut = (id) => app.call('sessions.close', { id }, 20000).catch((e) => note(`close ${id}: ${e.message}`));

    let sid = await open('1');
    await check(1, 'card appears in bypass mode, Deny blocks the push', async () => {
      const head = newCommit('second');
      const was = bareHead();
      const t = await turn(sid, PUSH, { origin: 'helm', answer: 'deny' });
      ok(t.card, 'no guard card appeared');
      ok(/Production push · Shop master/.test(t.card.title), `card title "${t.card.title}"`);
      ok(t.card.sessionStatus === 'waiting', `session status while the card waited: ${t.card.sessionStatus}`);
      ok(bareHead() === was && bareHead() !== head, 'bare master moved after Deny');
      return `card "${t.card.title}" (status ${t.card.sessionStatus}, activity "${t.card.activity}"); bare master unchanged ${was.slice(0, 7)}; Claude: ${t.text.slice(0, 120)}`;
    });
    await shut(sid);

    sid = await open('2');
    await check(2, 'Allow once lets it through', async () => {
      const head = workHead();
      ok(bareHead() !== head, 'nothing to push (check 1 left no unpushed commit)');
      const t = await turn(sid, PUSH, { origin: 'helm', answer: 'allow' });
      ok(t.card, `no guard card appeared; Claude: ${t.text.slice(0, 160)}`);
      ok(bareHead() === head, `bare master ${bareHead().slice(0, 7)} != work ${head.slice(0, 7)}`);
      return `card answered Allow; bare master now ${head.slice(0, 7)}`;
    });
    await shut(sid);

    sid = await open('3+4');
    await check(3, 'the user typed "commit and push" → no card, visible line, pushed', async () => {
      fs.appendFileSync(path.join(WORK, 'notes.txt'), 'three\n');
      const t = await turn(sid, 'There is an uncommitted change in notes.txt. Commit it with the message "three" and push to origin master. Use git in the Bash tool; one command per step.');
      ok(!t.card, `a card appeared: ${t.card && t.card.title}`);
      const line = t.items.find((x) => x.type === 'system' && /allowed · you said/.test(x.text || ''));
      ok(line, `no "allowed · you said" line; Claude: ${t.text.slice(0, 160)}`);
      ok(bareHead() === workHead(), 'bare master did not get the commit');
      return `line: ${line.text}; bare master ${bareHead().slice(0, 7)}`;
    });

    await check(4, 'the user typed "commit, don\'t push" → a later push still gets the card', async () => {
      // what this proves: "don't push" takes back the approval check 3's "commit and push" granted in this session
      ok(results.some((r) => r.n === 3 && r.ok), 'check 3 failed, so this session holds no approval to take back');
      fs.appendFileSync(path.join(WORK, 'notes.txt'), 'four\n');
      const was = bareHead();
      const t1 = await turn(sid, 'Commit the change in notes.txt with the message "four", don\'t push.');
      ok(!t1.card, 'a card appeared for a commit');
      ok(workHead() !== was, `Claude did not commit "four"; Claude: ${t1.text.slice(0, 160)}`);
      // origin helm: the push request is not the user's words, so it must not re-grant anything
      const t2 = await turn(sid, 'Change of plan, the commit is ready to go. ' + PUSH, { origin: 'helm', answer: 'deny' });
      ok(t2.card, `no card for the push after "don't push"; Claude: ${t2.text.slice(0, 160)}`);
      ok(bareHead() === was, 'bare master moved');
      return `card "${t2.card.title}"; bare master unchanged`;
    });
    await shut(sid);

    sid = await open('5');
    await check(5, 'railway up (stub on PATH) → card, Deny → stub never ran', async () => {
      const t = await turn(sid, 'Use the Bash tool to run exactly this one command and nothing else: railway up --detach\nDo not retry. Reply in one line.', { origin: 'helm', answer: 'deny' });
      ok(t.card, `no card; Claude: ${t.text.slice(0, 160)}`);
      ok(/Railway/.test(t.card.title), `title "${t.card.title}"`);
      ok(!fs.existsSync(STUB_MARK), 'the railway stub ran');
      return `card "${t.card.title}"; stub did not run`;
    });
    await shut(sid);

    sid = await open('6');
    await check(6, 'interrupt while the card waits → blocked, turn ends', async () => {
      newCommit('six');
      const was = bareHead();
      const t = await turn(sid, PUSH, { origin: 'helm', interrupt: true });
      ok(t.card, `no card; Claude: ${t.text.slice(0, 160)}`);
      ok(!t.card.interruptError, `sessions.interrupt refused: ${t.card.interruptError}`);
      await app.waitFor(() => { const c = app.list(sid).find((x) => x.id === t.card.id); return c && c.status !== 'pending'; }, 15000, 'card to close').catch(() => {});
      const c = app.list(sid).find((x) => x.id === t.card.id);
      ok(c && c.status === 'cancelled', `card status ${c && c.status}`);
      ok(bareHead() === was, 'bare master moved');
      return `card ${c.status}; bare master unchanged`;
    });
    await shut(sid);

    const log = app.out().split(/\r?\n/).filter((l) => /prod-guard/.test(l)).slice(-8);
    note('engine log (prod-guard):\n  ' + log.join('\n  '));
  } finally {
    if (app) { try { app.ws.close(); } catch {} killTree(app.child.pid); }
    dropLock();
    await sleep(1500);
    if (!KEEP) {
      // WORK's ~/.claude/projects transcript folder too, not just the temp tree (removes TMP as well)
      note(`cleaned up ${dropLiveTranscripts([WORK], { keep: false }).length} transcript folder(s)`);
      for (const d of [TMP, userData]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((e) => { results.push({ n: 0, name: 'harness', ok: false, why: e.message }); note('harness error: ' + e.stack); }).finally(() => {
  const pass = results.filter((r) => r.ok).length;
  console.log(`guard-live: ${pass} passed, ${results.length - pass} failed (live spend $${spend.toFixed(3)})`);
  process.exit(results.length && pass === results.length ? 0 : 1);
});
