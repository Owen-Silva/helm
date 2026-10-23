// In-CLI schedule tracking (main/engine/schedules.js): /loop ScheduleWakeup + CronCreate / CronDelete keep the idle
// reaper away from a CLI whose next tick lives inside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduleTracker } = require('../../main/engine/schedules');

const MIN = 60_000;
const GRACE = 5 * MIN;
let n = 0;
const tool = (name, input, ts, extra = {}) => ({ toolUseId: 'tu' + ++n, name, input, ts, status: 'running', result: '', ...extra });
const done = (it, patch = {}) => Object.assign(it, { status: 'done', ...patch });

function tracker(t0 = 1_000 * MIN) {
  const clock = { t: t0 };
  return { clock, tr: createScheduleTracker({ now: () => clock.t, graceMs: GRACE }) };
}

test('ScheduleWakeup: pending until its time + delaySeconds + grace, then expires', () => {
  const { clock, tr } = tracker();
  assert.equal(tr.pending(), null);
  const w = tool('ScheduleWakeup', { delaySeconds: 1500, reason: 'next tick', prompt: '/loop check' }, clock.t);
  tr.onToolInput(w); tr.onToolEnd(done(w));
  const p = tr.pending();
  assert.equal(p.wakeUntil, clock.t + 1500_000 + GRACE);
  assert.equal(p.crons, 0);
  assert.match(p.reason, /scheduled wake-up pending/);
  clock.t += 1500_000 + GRACE - 1;
  assert.ok(tr.pending(), 'still pending inside the grace');
  clock.t += 2;
  assert.equal(tr.pending(), null, 'expired: the wake fired (its turn makes the session busy) or never came');
});

test('ScheduleWakeup: a later call replaces it; stop: true clears it; a failed call clears its own wake', () => {
  const { clock, tr } = tracker();
  const a = tool('ScheduleWakeup', { delaySeconds: 3600 }, clock.t);
  tr.onToolInput(a); tr.onToolEnd(done(a));
  clock.t += 10 * MIN;
  const b = tool('ScheduleWakeup', { delaySeconds: 60 }, clock.t);
  tr.onToolInput(b); tr.onToolEnd(done(b));
  assert.equal(tr.pending().wakeUntil, clock.t + 60_000 + GRACE, 'replaced, not the longer earlier one');
  const stop = tool('ScheduleWakeup', { stop: true }, clock.t);
  tr.onToolInput(stop); tr.onToolEnd(done(stop));
  assert.equal(tr.pending(), null);
  const bad = tool('ScheduleWakeup', { delaySeconds: 600 }, clock.t);
  tr.onToolInput(bad);
  assert.ok(tr.pending());
  tr.onToolEnd(Object.assign(bad, { status: 'error' }));
  assert.equal(tr.pending(), null, 'a failed ScheduleWakeup schedules nothing');
});

test('ScheduleWakeup with no usable delay assumes the longest (an hour)', () => {
  const { clock, tr } = tracker();
  tr.onToolInput(tool('ScheduleWakeup', { prompt: 'x' }, clock.t));
  assert.equal(tr.pending().wakeUntil, clock.t + 3600_000 + GRACE);
});

test('CronCreate is pending until a CronDelete with its id (structured id or "job <id>" in the text)', () => {
  const { clock, tr } = tracker();
  const c1 = tool('CronCreate', { cron: '13,43 * * * *', prompt: 'tick', recurring: true }, clock.t);
  tr.onToolInput(c1);
  assert.equal(tr.pending().crons, 1, 'pending from the call, before the result');
  tr.onToolEnd(done(c1), { id: '0006e464', humanSchedule: '13,43 * * * *', recurring: true, durable: false });
  const c2 = tool('CronCreate', { cron: '*/5 * * * *', prompt: 'other' }, clock.t);
  tr.onToolInput(c2);
  tr.onToolEnd(done(c2, { result: 'Scheduled recurring job ab12cd34 (*/5 * * * *). Session-only (not written to disk, dies when Claude exits).' }), null);
  assert.equal(tr.pending().crons, 2);
  assert.equal(tr.pending().key, 'cron:2');
  const miss = tool('CronDelete', { id: 'ffffffff' }, clock.t);
  tr.onToolInput(miss); tr.onToolEnd(done(miss));
  assert.equal(tr.pending().crons, 2, 'a delete for an id it never saw removes nothing while ids are known');
  const d1 = tool('CronDelete', { id: 'ab12cd34' }, clock.t);
  tr.onToolInput(d1); tr.onToolEnd(done(d1));
  assert.equal(tr.pending().crons, 1);
  const failed = tool('CronDelete', { id: '0006e464' }, clock.t);
  tr.onToolInput(failed); tr.onToolEnd(Object.assign(failed, { status: 'error' }));
  assert.equal(tr.pending().crons, 1, 'a failed delete keeps the cron');
  const d2 = tool('CronDelete', { id: '0006e464' }, clock.t);
  tr.onToolInput(d2); tr.onToolEnd(done(d2));
  assert.equal(tr.pending(), null);
  clock.t += 30 * 24 * 60 * MIN;
  assert.equal(tr.pending(), null);
});

test('CronCreate stays pending with no expiry; a failed CronCreate is not pending; id-less cron goes with a lone delete', () => {
  const { clock, tr } = tracker();
  const bad = tool('CronCreate', { cron: 'bad' }, clock.t);
  tr.onToolInput(bad); tr.onToolEnd(Object.assign(bad, { status: 'error' }));
  assert.equal(tr.pending(), null);
  const c = tool('CronCreate', { cron: '0 * * * *' }, clock.t);
  tr.onToolInput(c); tr.onToolEnd(done(c, { result: 'ok' }), null); // no id anywhere
  clock.t += 3 * 24 * 60 * MIN;
  assert.equal(tr.pending().crons, 1, 'while the CLI lives');
  const d = tool('CronDelete', { id: 'whatever' }, clock.t);
  tr.onToolInput(d); tr.onToolEnd(done(d));
  assert.equal(tr.pending(), null);
});

test('wake + cron together; reset() (CLI start / exit) clears everything', () => {
  const { clock, tr } = tracker();
  tr.onToolInput(tool('ScheduleWakeup', { delaySeconds: 1200 }, clock.t));
  tr.onToolInput(tool('CronCreate', { cron: '0 * * * *' }, clock.t));
  const p = tr.pending();
  assert.equal(p.key, 'wakecron:1');
  assert.match(p.reason, /wake-up pending.*1 scheduled cron job pending/);
  tr.reset();
  assert.equal(tr.pending(), null);
});

// ---------- lane sched: list(), nextCronFire, the board (schedules.list / cancel / dismiss / Ended by restart) ----------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduleBoard, nextCronFire } = require('../../main/engine/schedules');

test('nextCronFire: local-time 5-field cron, steps, ranges, lists, names, dom/dow OR', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const t = at(2026, 10, 9, 14, 7); // Fri Oct 9 2026 14:07
  assert.equal(nextCronFire('*/5 * * * *', t), at(2026, 10, 9, 14, 10));
  assert.equal(nextCronFire('13,43 * * * *', t), at(2026, 10, 9, 14, 13));
  assert.equal(nextCronFire('0 9 * * mon-fri', t), at(2026, 10, 12, 9, 0), 'next weekday 9:00 is Monday');
  assert.equal(nextCronFire('30 14 28 2 *', t), at(2027, 2, 28, 14, 30));
  assert.equal(nextCronFire('0 0 1 * 0', t), at(2026, 10, 11, 0, 0), 'dom and dow both set: either matches (Sunday the 11th)');
  assert.equal(nextCronFire('0 12 * * 7', t), at(2026, 10, 11, 12, 0), 'dow 7 is Sunday');
  assert.equal(nextCronFire('7 14 * * *', t), at(2026, 10, 10, 14, 7), 'strictly after now');
  assert.equal(nextCronFire('bad', t), null);
  assert.equal(nextCronFire('61 * * * *', t), null);
  assert.equal(nextCronFire('0 0 31 2 *', t), null, 'never matches');
});

test('list(): wake (kind loop), cron with structured result, one-shot fires off the list, auto-expiry, durable flag', () => {
  const { clock, tr } = tracker(new Date(2026, 9, 9, 14, 7).getTime());
  const w = tool('ScheduleWakeup', { delaySeconds: 1200, reason: 'watching CI', prompt: '/loop check the deploy' }, clock.t);
  tr.onToolInput(w); tr.onToolEnd(done(w), { scheduledFor: clock.t + 1_200_500, clampedDelaySeconds: 1200, wasClamped: false });
  const c = tool('CronCreate', { cron: '*/30 * * * *', prompt: 'summarise new issues', recurring: true }, clock.t);
  tr.onToolInput(c); tr.onToolEnd(done(c), { id: 'abcd1234', humanSchedule: 'every 30 minutes', recurring: true });
  const once = tool('CronCreate', { cron: '0 15 9 10 *', prompt: 'remind me', recurring: false, durable: true }, clock.t);
  tr.onToolInput(once); tr.onToolEnd(done(once, { result: 'Scheduled one-shot job ffff0000' }));
  let l = tr.list();
  assert.equal(l.length, 3);
  const wk = l.find((x) => x.key.startsWith('wake:'));
  assert.deepEqual([wk.kind, wk.label, wk.detail, wk.nextAt, wk.recurring], ['loop', '/loop check the deploy', 'watching CI', clock.t + 1_200_500, true]);
  const cr = l.find((x) => x.cronId === 'abcd1234');
  assert.deepEqual([cr.kind, cr.detail, cr.recurring, cr.nextAt], ['cron', 'every 30 minutes', true, new Date(2026, 9, 9, 14, 30).getTime()]);
  const os1 = l.find((x) => x.cronId === 'ffff0000');
  assert.deepEqual([os1.recurring, os1.durable, os1.nextAt], [false, true, new Date(2026, 9, 9, 15, 0).getTime()]);
  clock.t = new Date(2026, 9, 9, 15, 2).getTime();
  l = tr.list();
  assert.ok(!l.some((x) => x.cronId === 'ffff0000'), 'one-shot fired and deleted itself');
  assert.ok(!l.some((x) => x.key.startsWith('wake:')), 'wake fired');
  assert.equal(l[0].nextAt, new Date(2026, 9, 9, 15, 30).getTime(), 'recurring moves to its next fire');
  clock.t += 8 * 24 * 3600_000;
  assert.equal(tr.list().length, 0, 'recurring crons auto-expire after 7 days');
  assert.ok(tr.pending(), 'the reaper hold is unchanged by list()');
});

test('drainEnded(): CronDelete -> deleted, ScheduleWakeup stop -> stopped, reset -> exit; autonomous sentinel label', () => {
  const { clock, tr } = tracker();
  const w = tool('ScheduleWakeup', { delaySeconds: 600, prompt: '<<autonomous-loop-dynamic>>' }, clock.t);
  tr.onToolInput(w); tr.onToolEnd(done(w));
  assert.equal(tr.list()[0].label, 'Autonomous loop');
  const c = tool('CronCreate', { cron: '0 * * * *', prompt: 'hourly' }, clock.t);
  tr.onToolInput(c); tr.onToolEnd(done(c), { id: 'job12345' });
  const del = tool('CronDelete', { id: 'job12345' }, clock.t);
  tr.onToolInput(del); tr.onToolEnd(done(del));
  tr.onToolInput(tool('ScheduleWakeup', { stop: true }, clock.t));
  assert.deepEqual(tr.drainEnded().map((e) => e.why), ['deleted', 'stopped']);
  assert.deepEqual(tr.drainEnded(), []);
  const c2 = tool('CronCreate', { cron: '0 * * * *', prompt: 'again' }, clock.t);
  tr.onToolInput(c2); tr.onToolEnd(done(c2), { id: 'job99999' });
  tr.reset();
  assert.deepEqual(tr.drainEnded().map((e) => [e.why, e.label]), [['exit', 'again']]);
});

function fakeSession(id, t0) {
  const tr = createScheduleTracker({ now: () => t0.t, graceMs: GRACE });
  return {
    s: { id, title: `Session ${id}`, cwd: 'C:\\work\\proj' }, schedules: tr, closing: false, sent: [], _live: true, busy: null,
    live() { return this._live; }, busyState() { return this.busy; },
    async close() { this.closing = true; this._live = false; this.schedules.reset(); this.closing = false; },
  };
}

test('board: list across sessions soonest first, ask sends a visible message, close ends all, guards', async () => {
  const t0 = { t: new Date(2026, 9, 9, 14, 7).getTime() };
  const a = fakeSession('sA', t0), b = fakeSession('sB', t0);
  const sessions = new Map([['sA', a], ['sB', b]]);
  const events = [];
  const board = createScheduleBoard({ sessions, now: () => t0.t, emit: (e, d) => events.push([e, d]),
    send: async (id, text) => { sessions.get(id).sent.push(text); return { itemId: 'u1', queued: false }; } });
  const w = tool('ScheduleWakeup', { delaySeconds: 1800, prompt: '/loop babysit' }, t0.t);
  a.schedules.onToolInput(w); a.schedules.onToolEnd(done(w));
  const c = tool('CronCreate', { cron: '*/10 * * * *', prompt: 'poll the queue' }, t0.t);
  b.schedules.onToolInput(c); b.schedules.onToolEnd(done(c), { id: 'cr0n1234', humanSchedule: 'every 10 minutes' });
  let l = await board.methods['schedules.list']();
  assert.deepEqual(l.items.map((x) => x.sessionId), ['sB', 'sA'], 'soonest first');
  assert.equal(l.items[0].project, 'proj');
  assert.equal(l.items[0].canClose, true);

  const r = await board.methods['schedules.cancel']({ sessionId: 'sB', key: l.items[0].key, how: 'ask' });
  assert.equal(r.asked, true);
  assert.match(b.sent[0], /cancel the scheduled job cr0n1234 .*CronDelete/);
  l = await board.methods['schedules.list']();
  assert.equal(l.items.find((x) => x.sessionId === 'sB').askedAt, t0.t, 'every client sees it was asked');
  const del = tool('CronDelete', { id: 'cr0n1234' }, t0.t);
  b.schedules.onToolInput(del); b.schedules.onToolEnd(done(del));
  l = await board.methods['schedules.list']();
  assert.deepEqual(l.ended.map((e) => [e.why, e.asked, e.sessionId]), [['deleted', true, 'sB']], 'shows it really went');

  a.busy = { working: true };
  await assert.rejects(board.methods['schedules.cancel']({ sessionId: 'sA', key: l.items[0].key, how: 'close' }), { code: 'busy' });
  assert.equal((await board.methods['schedules.list']()).items[0].canClose, false);
  a.busy = null;
  const rc = await board.methods['schedules.cancel']({ sessionId: 'sA', key: l.items[0].key, how: 'close' });
  assert.deepEqual([rc.closed, rc.ended, rc.left], [true, 1, 0]);
  l = await board.methods['schedules.list']();
  assert.equal(l.items.length, 0);
  assert.equal(l.ended[0].why, 'closed');
  await assert.rejects(board.methods['schedules.cancel']({ sessionId: 'sA', key: 'wake:nope', how: 'ask' }), { code: 'gone' });
  await assert.rejects(board.methods['schedules.cancel']({ sessionId: 'sA', key: 'x', how: 'nuke' }), { code: 'bad_params' });
  await board.methods['schedules.dismiss']({ all: true });
  assert.equal((await board.methods['schedules.list']()).ended.length, 0);
  await new Promise((r2) => setTimeout(r2, 200));
  assert.ok(events.some(([e]) => e === 'schedules.updated'), 'pushes schedules.updated');
  board.stop();
});

test('board: durable crons cannot be closed away; Ended by restart is written at shutdown and shown once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-sched-'));
  const file = path.join(dir, 'schedules-at-exit.json');
  try {
    const t0 = { t: new Date(2026, 9, 9, 14, 7).getTime() };
    const a = fakeSession('sA', t0);
    const sessions = new Map([['sA', a]]);
    const board = createScheduleBoard({ sessions, file, now: () => t0.t, send: async () => ({}) });
    const d = tool('CronCreate', { cron: '0 9 * * *', prompt: 'daily digest', durable: true }, t0.t);
    a.schedules.onToolInput(d); a.schedules.onToolEnd(done(d), { id: 'dur12345', durable: true });
    const c = tool('CronCreate', { cron: '*/15 * * * *', prompt: 'tick' }, t0.t);
    a.schedules.onToolInput(c); a.schedules.onToolEnd(done(c), { id: 'tik12345' });
    const items = (await board.methods['schedules.list']()).items;
    const dur = items.find((x) => x.durable);
    assert.equal(dur.canClose, false);
    await assert.rejects(board.methods['schedules.cancel']({ sessionId: 'sA', key: dur.key, how: 'close' }), { code: 'durable' });
    board.atShutdown();
    await a.close(); // the CLI dies with Helm: not recorded as an in-session end
    assert.equal(board.list().ended.length, 0);
    board.stop();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.items.map((x) => x.label), ['tick'], 'durable ones survive a restart: not listed');

    t0.t += 60_000;
    const board2 = createScheduleBoard({ sessions: new Map(), file, now: () => t0.t, send: async () => ({}) });
    const l = board2.list();
    assert.deepEqual(l.ended.map((e) => [e.why, e.label, e.sessionTitle]), [['restart', 'tick', 'Session sA']]);
    assert.ok(!fs.existsSync(file), 'read once');
    await board2.methods['schedules.dismiss']({ id: l.ended[0].id });
    assert.equal(board2.list().ended.length, 0);
    board2.stop();
    const board3 = createScheduleBoard({ sessions: new Map(), file, now: () => t0.t, send: async () => ({}) });
    assert.equal(board3.list().ended.length, 0, 'shown once: not again on the next start');
    board3.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// fixup 2026-10-09: "Ask Claude to cancel" is Helm's text, not the user's. Through the real engine (index.js wires the
// board's send to sessions.send), it must neither take back a push approval the user gave nor grant one.
test('board through the engine: the cancel ask is origin helm, the production guard ignores it', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createEngine } = require('../../main/engine');
  const { createFakeSdk, F } = require('./fake-sdk');
  const G = require('../../main/engine/prod-guard');
  const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
  const prompts = [];
  const sdk = createFakeSdk(async function* (um) {
    prompts.push(typeof um.message.content === 'string' ? um.message.content : JSON.stringify(um.message.content));
    for (const f of F.textTurn('m' + prompts.length, 'ok')) yield f;
    yield F.result(0.001);
  });
  const dirs = [tmp('helm-eng-'), tmp('helm-cwd-'), tmp('helm-proj-'), tmp('helm-sl-')];
  const engine = createEngine({ userDataDir: dirs[0], emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: dirs[2], statuslineDir: dirs[3] });
  const m = engine.methods;
  const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out'); };
  const ALL = { approvable: 'all' };
  try {
    const plant = (es, label, id) => { const c = tool('CronCreate', { cron: '*/10 * * * *', prompt: label }, Date.now()); es.schedules.onToolInput(c); es.schedules.onToolEnd(done(c), { id }); };
    const ask = async (es) => {
      const it = (await m['schedules.list']()).items.find((x) => x.sessionId === es.s.id);
      assert.ok(it, 'the planted schedule is listed');
      const r = await m['schedules.cancel']({ sessionId: es.s.id, key: it.key, how: 'ask' });
      assert.equal(r.asked, true);
      await waitFor(() => prompts.length && prompts[prompts.length - 1].includes('Sent from Helm') && !es.turnActive);
      return r;
    };

    // 1) The user typed "push it to master": approved. The cancel ask (no push words) must not take that back.
    const a = await m['sessions.create']({ cwd: dirs[1], model: 'claude-haiku-5-5' });
    const ea = engine._internal.sessions.get(a.id);
    await m['sessions.send']({ id: a.id, text: 'commit and push it to master' });
    await waitFor(() => prompts.length === 1 && !ea.turnActive);
    assert.ok(G.priorApproval(ea, ALL), 'the user\'s typed "push it to master" approves');
    plant(ea, 'poll the queue', 'cr0n0001');
    const r1 = await ask(ea);
    assert.equal(G.promptApproval(r1.text, null), null, 'as the user\'s words this text would take the approval back');
    assert.ok(G.priorApproval(ea, ALL), 'the cancel ask did not revoke the user\'s approval');

    // 2) No approval yet; a schedule whose own prompt says "push to master": asking to cancel it grants nothing.
    const b = await m['sessions.create']({ cwd: dirs[1], model: 'claude-haiku-5-5' });
    const eb = engine._internal.sessions.get(b.id);
    await m['sessions.send']({ id: b.id, text: 'hello', origin: 'helm' });
    await waitFor(() => prompts.length === 3 && !eb.turnActive);
    plant(eb, 'push to master every 10 minutes', 'cr0n0002');
    await ask(eb);
    assert.equal(G.priorApproval(eb, ALL), null, 'the cancel ask granted no approval');
  } finally {
    await engine.shutdown().catch(() => {});
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
