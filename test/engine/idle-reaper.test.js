// Idle CLI reaper (main/engine/idle-reaper.js): closes only live, idle-long-enough, not-busy CLIs, quietly.
const test = require('node:test');
const assert = require('node:assert');
const { createIdleReaper } = require('../../main/engine/idle-reaper');

const MIN = 60 * 1000;
function fakeSession(id, { live = true, updatedAt = 0, busy = false, closing = false } = {}) {
  const es = {
    s: { id, updatedAt, status: 'idle' }, busy, closing, closes: [],
    live() { return live; },
    async close(o) { this.closes.push(o); live = false; },
  };
  return es;
}
const opts = (sessions, t, extra = {}) => ({ sessions, isBusy: (es) => es.busy, idleMs: 15 * MIN, now: () => t, setInterval: () => null, clearInterval: () => {}, ...extra });
const flush = () => new Promise((r) => setImmediate(r));

test('closes a live CLI idle past the threshold, quietly and not final', async () => {
  const t = 100 * MIN;
  const old = fakeSession('a', { updatedAt: t - 16 * MIN });
  const fresh = fakeSession('b', { updatedAt: t - 14 * MIN });
  const r = createIdleReaper(opts(new Map([['a', old], ['b', fresh]]), t));
  assert.deepStrictEqual(r.sweep(), ['a']);
  await flush();
  assert.deepStrictEqual(old.closes, [{ final: false, quiet: true }]);
  assert.deepStrictEqual(fresh.closes, []);
});

test('never closes a busy CLI (turn running, queued prompts, background agents ...)', async () => {
  const t = 100 * MIN;
  const busy = fakeSession('a', { updatedAt: t - 60 * MIN, busy: true });
  const r = createIdleReaper(opts(new Map([['a', busy]]), t));
  assert.deepStrictEqual(r.sweep(), []);
  await flush();
  assert.deepStrictEqual(busy.closes, []);
});

test('a throwing busy check counts as busy', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 60 * MIN });
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { isBusy: () => { throw new Error('x'); } }));
  assert.deepStrictEqual(r.sweep(), []);
});

test('skips sessions with no CLI, already closing, or no activity time', async () => {
  const t = 100 * MIN;
  const dead = fakeSession('a', { live: false, updatedAt: 1 });
  const closing = fakeSession('b', { updatedAt: 1, closing: true });
  const noTime = fakeSession('c', { updatedAt: 0 });
  const r = createIdleReaper(opts(new Map([['a', dead], ['b', closing], ['c', noTime]]), t));
  assert.deepStrictEqual(r.sweep(), []);
});

test('idleMs 0 disables it (no timer, sweep does nothing)', () => {
  let started = 0;
  const es = fakeSession('a', { updatedAt: 1 });
  const r = createIdleReaper(opts(new Map([['a', es]]), 100 * MIN, { idleMs: 0, setInterval: () => { started++; return null; } }));
  assert.strictEqual(started, 0);
  assert.deepStrictEqual(r.sweep(), []);
});

test('does not close the same session twice while its close is in flight', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 60 * MIN });
  let release; es.close = function (o) { this.closes.push(o); return new Promise((r) => { release = r; }); };
  const r = createIdleReaper(opts(new Map([['a', es]]), t));
  r.sweep(); await flush(); r.sweep(); await flush();
  assert.strictEqual(es.closes.length, 1);
  release();
});

test('idleMs can be a function (the Settings choice), read on every sweep; a draft (lastActiveAt) counts as use', async () => {
  const t = 100 * MIN;
  let win = 0;
  const es = fakeSession('a', { updatedAt: t - 20 * MIN });
  let armed = 0;
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { idleMs: () => win, setInterval: () => { armed++; return null; } }));
  assert.strictEqual(armed, 1, 'a function window keeps its timer, so turning it on later works');
  assert.deepStrictEqual(r.sweep(), [], 'Never (0) closes nothing');
  win = 15 * MIN;
  es.lastActiveAt = t - 5 * MIN; // the user typed a draft for it 5 min ago
  assert.deepStrictEqual(r.sweep(), []);
  es.lastActiveAt = t - 16 * MIN;
  assert.deepStrictEqual(r.sweep(), ['a']);
  await flush(); await flush();
  assert.strictEqual(es.closes.length, 1);
  assert.strictEqual(r.stats().closed, 1);
  assert.ok(es.idleClosedAt, 'marks the session so its next start is logged + counted as a resume');
  r.noteResume();
  assert.strictEqual(r.stats().resumed, 1);
});

test('busy again by the time the close runs: left alone', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 60 * MIN });
  const r = createIdleReaper(opts(new Map([['a', es]]), t));
  assert.deepStrictEqual(r.sweep(), ['a']);
  es.busy = true; // e.g. a send landed between the sweep and the close
  await flush(); await flush();
  assert.deepStrictEqual(es.closes, []);
  assert.strictEqual(r.stats().closed, 0);
});

// The real engine (fake SDK): the reaper is wired to es.busyState(), closes quietly, and the next send resumes.
test('engine: an idle session loses its CLI quietly and resumes on the next send; a background task keeps it', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createEngine } = require('../../main/engine');
  const { createFakeSdk, F } = require('./fake-sdk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-reaper-'));
  const mk = (p) => fs.mkdtempSync(path.join(root, p));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sdk = createFakeSdk(async function* (um) {
    const text = JSON.stringify(um.message && um.message.content);
    if (text.includes('background')) yield { type: 'system', subtype: 'task_started', task_id: 'bg1', task_type: 'local_bash', description: 'sleep 90' };
    for (const f of F.textTurn('m' + Math.random(), 'ok')) yield f;
    yield F.result(0.01);
  }, { projectsDir: mk('proj-') });
  let idleMs = 0;
  const logs = [];
  const engine = createEngine({ userDataDir: mk('ud-'), emit: () => {}, log: (lvl, m) => logs.push(m), sdk, claudePath: null, projectsDir: mk('proj2-'), statuslineDir: mk('sl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => idleMs, idleCheckMs: 20 });
  const es = (id) => engine._internal.sessions.get(id);
  const until = async (pred, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 4000) throw new Error('timed out: ' + what); await sleep(5); } };
  try {
    const cwd = mk('cwd-');
    const a = await engine.methods['sessions.create']({ cwd });
    const b = await engine.methods['sessions.create']({ cwd });
    await engine.methods['sessions.send']({ id: a.id, text: 'hello' });
    await engine.methods['sessions.send']({ id: b.id, text: 'start a background task' });
    await until(() => es(a.id).live() && es(a.id).s.status === 'idle' && es(b.id).live() && es(b.id).s.status === 'idle' && es(b.id).openTasks.size === 1, 'both turns done');
    const before = { ...es(a.id).s };
    const callsBefore = sdk.calls.length;
    idleMs = 30;
    await until(() => !es(a.id).live(), 'idle CLI closed');
    await sleep(150); // several more sweeps
    assert.strictEqual(es(b.id).live(), true, 'a session with a background task running keeps its CLI');
    const after = es(a.id).s;
    assert.strictEqual(after.status, 'idle');
    assert.strictEqual(after.updatedAt, before.updatedAt, 'quiet: does not reorder the sidebar');
    assert.strictEqual(after.activity, before.activity);
    assert.strictEqual(engine.methods['sessions.idleStats'] && (await engine.methods['sessions.idleStats']()).closed, 1);
    // viewing it reads history and does not start a CLI
    await engine.methods['sessions.history']({ id: a.id });
    await engine.methods['sessions.markRead']({ id: a.id });
    assert.strictEqual(es(a.id).live(), false, 'viewing does not respawn it');
    assert.strictEqual(sdk.calls.length, callsBefore);
    idleMs = 0; // hold it open for the checks below
    await engine.methods['sessions.send']({ id: a.id, text: 'again' });
    await until(() => es(a.id).live() && es(a.id).s.status === 'idle', 'resumed turn done');
    const resumed = sdk.calls[sdk.calls.length - 1].options;
    assert.strictEqual(resumed.resume || resumed.sessionId, before.claudeSessionId, 'the same conversation resumes');
    const st = await engine.methods['sessions.idleStats']();
    assert.strictEqual(st.resumed, 1);
    assert.ok(logs.some((m) => /closed idle CLI for/.test(m)) && logs.some((m) => /resumed idle-closed CLI for/.test(m)), 'one log line per close and per resume');
  } finally {
    await engine.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pending in-CLI schedule (isHeld) keeps an idle CLI; logged once per hold, then closed once it is over', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 60 * MIN });
  let held = { key: 'wake', reason: 'scheduled wake-up pending until 2026-10-08T20:00:00.000Z' };
  const logs = [];
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { isHeld: () => held, log: (lvl, m) => logs.push(m) }));
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(r.sweep(), []);
  await flush();
  assert.deepStrictEqual(es.closes, []);
  assert.equal(logs.filter((m) => /kept idle CLI for a: scheduled wake-up pending/.test(m)).length, 1, 'one line, not one per sweep');
  held = { key: 'wake', reason: 'scheduled wake-up pending until 2026-10-08T20:25:00.000Z' }; // the next /loop tick
  r.sweep();
  assert.equal(logs.filter((m) => /kept idle CLI/.test(m)).length, 1, 'a new tick of the same loop does not log again');
  held = null; // the loop stopped
  assert.deepStrictEqual(r.sweep(), ['a']);
  await flush(); await flush();
  assert.equal(es.closes.length, 1);
});

test('engine: a /loop session with a ScheduleWakeup pending keeps its CLI; ScheduleWakeup stop lets it close', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createEngine } = require('../../main/engine');
  const { createFakeSdk, F } = require('./fake-sdk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-reaper-loop-'));
  const mk = (p) => fs.mkdtempSync(path.join(root, p));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let k = 0;
  const sdk = createFakeSdk(async function* (um) {
    const text = JSON.stringify(um.message && um.message.content);
    const id = 'toolu_w' + ++k;
    const input = text.includes('stop the loop') ? { stop: true } : { delaySeconds: 1500, reason: 'next tick', prompt: '/loop check the build' };
    yield F.toolUse('mt' + k, id, 'ScheduleWakeup', input);
    yield F.toolResult(id, input.stop ? 'Loop stopped.' : 'Scheduled wake-up in 1500s.');
    for (const f of F.textTurn('m' + k, 'ok')) yield f;
    yield F.result(0.01 * k);
  }, { projectsDir: mk('proj-') });
  const logs = [];
  const engine = createEngine({ userDataDir: mk('ud-'), emit: () => {}, log: (lvl, m) => logs.push(m), sdk, claudePath: null, projectsDir: mk('proj2-'), statuslineDir: mk('sl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 30, idleCheckMs: 20 });
  const es = (id) => engine._internal.sessions.get(id);
  const until = async (pred, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 4000) throw new Error('timed out: ' + what); await sleep(5); } };
  try {
    const a = await engine.methods['sessions.create']({ cwd: mk('cwd-') });
    await engine.methods['sessions.send']({ id: a.id, text: '/loop check the build' });
    await until(() => es(a.id).live() && es(a.id).s.status === 'idle', 'loop turn done');
    await sleep(300); // ~15 sweeps past a 30 ms window
    assert.equal(es(a.id).live(), true, 'the CLI holding the next /loop tick stays');
    assert.equal(es(a.id).busyState(), null, 'the restart gate does not see it: updates are not blocked by a schedule');
    assert.equal(logs.filter((m) => m.includes(`kept idle CLI for ${a.id}: scheduled wake-up pending`)).length, 1, 'logged once');
    await engine.methods['sessions.send']({ id: a.id, text: 'stop the loop' });
    await until(() => !es(a.id).live(), 'closed once the loop stopped');
    assert.equal(es(a.id).s.status, 'idle');
  } finally {
    await engine.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
