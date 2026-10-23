// Lane tabrelease: closing a session's tab releases its claude.exe (idle-reaper.js release(), engine
// sessions.release / sessions.viewing). Never interrupts work; a schedule hold and an on-screen session win.
const test = require('node:test');
const assert = require('node:assert');
const { createIdleReaper } = require('../../main/engine/idle-reaper');

const MIN = 60 * 1000;
function fakeSession(id, { live = true, updatedAt = 0, busy = false } = {}) {
  return {
    s: { id, updatedAt, status: 'idle' }, busy, closing: false, closes: [],
    live() { return live; },
    async close(o) { this.closes.push(o); live = false; },
  };
}
const opts = (sessions, t, extra = {}) => ({ sessions, isBusy: (es) => es.busy, idleMs: 15 * MIN, now: () => t, setInterval: () => null, clearInterval: () => {}, ...extra });
const flush = () => new Promise((r) => setImmediate(r));

test('release: an idle CLI closes now (quiet, not final), whatever the idle window says (Never included)', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 1000 }); // used a second ago: the idle window would not close it
  const logs = [];
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { idleMs: 0, log: (lvl, m) => logs.push(m) }));
  assert.deepStrictEqual(await r.release(es), { action: 'closed' });
  assert.deepStrictEqual(es.closes, [{ final: false, quiet: true }]);
  assert.ok(es.idleClosedAt, 'the next start counts + logs as a resume');
  assert.strictEqual(r.stats().released, 1);
  assert.strictEqual(r.stats().closed, 1);
  assert.equal(logs.filter((m) => /closed CLI for a: released on tab close/.test(m)).length, 1);
  assert.deepStrictEqual(await r.release(es), { action: 'none', reason: 'no CLI running' }, 'no CLI left: nothing to do');
});

test('release: a busy CLI is marked, kept while busy, then closed at the first sweep once idle (no idle window wait)', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 1000, busy: true });
  let armed = 0;
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { idleMs: 0, setInterval: () => { armed++; return {}; } }));
  const res = await r.release(es);
  assert.strictEqual(res.action, 'marked');
  assert.strictEqual(armed, 1, 'a fixed Never window has no timer: a mark starts one');
  assert.ok(r.isMarked(es));
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(r.sweep(), []);
  await flush();
  assert.deepStrictEqual(es.closes, [], 'never interrupts work');
  es.busy = false; // the turn ended (updatedAt is fresh: the idle window alone would wait 15 min)
  es.s.updatedAt = t;
  assert.deepStrictEqual(r.sweep(), ['a']);
  await flush(); await flush();
  assert.deepStrictEqual(es.closes, [{ final: false, quiet: true }]);
  assert.strictEqual(r.isMarked(es), false);
  assert.strictEqual(r.stats().released, 1);
});

test('release: a schedule-held CLI (/loop wake-up, cron) is never closed; the mark waits for the hold to end', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 60 * MIN });
  let held = { key: 'cron:1', reason: '1 scheduled cron job pending' };
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { isHeld: () => held }));
  assert.deepStrictEqual(await r.release(es), { action: 'marked', reason: '1 scheduled cron job pending' });
  for (let i = 0; i < 5; i++) r.sweep();
  await flush(); await flush();
  assert.deepStrictEqual(es.closes, [], 'the schedule hold always wins');
  held = null; // the loop was stopped
  r.sweep();
  await flush(); await flush();
  assert.strictEqual(es.closes.length, 1);
});

test('release: re-opening (unmark) clears the mark; the normal idle window applies again', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 1000, busy: true });
  const r = createIdleReaper(opts(new Map([['a', es]]), t));
  assert.strictEqual((await r.release(es)).action, 'marked');
  r.unmark(es);
  es.busy = false;
  assert.deepStrictEqual(r.sweep(), [], 'idle for a second: the 15 min window keeps it');
  await flush();
  assert.deepStrictEqual(es.closes, []);
});

test('release: a marked session still on screen (isVisible) is not closed until it is off screen', async () => {
  const t = 100 * MIN;
  const es = fakeSession('a', { updatedAt: t - 1000, busy: true });
  let visible = true;
  const r = createIdleReaper(opts(new Map([['a', es]]), t, { isVisible: () => visible }));
  await r.release(es);
  es.busy = false;
  assert.deepStrictEqual(r.sweep(), []);
  visible = false;
  assert.deepStrictEqual(r.sweep(), ['a']);
  await flush(); await flush();
  assert.strictEqual(es.closes.length, 1);
});

test('release: the split-pane rule (ui/lib/tab-state.js): a session still in a pane is not released', async () => {
  const { onScreen, releaseOnClose } = await import('../../ui/lib/tab-state.js');
  // closing tab x while x and y are split: the UI closes x's pane first; if x were still in a pane, no release
  assert.strictEqual(releaseOnClose(onScreen({ view: 'session', active: 'y', splitIds: ['x', 'y'] }), 'x'), false);
  assert.strictEqual(releaseOnClose(onScreen({ view: 'session', active: 'y', splitIds: null }), 'x'), true);
  assert.strictEqual(releaseOnClose(onScreen({ view: 'session', active: 'x' }), 'x'), false, 'still the open session');
  assert.strictEqual(releaseOnClose(onScreen({ view: 'home', active: 'x', splitIds: ['x', 'y'] }), 'x'), true, 'Home shows no session');
  assert.deepStrictEqual(onScreen({ view: 'session', active: 'x', splitIds: ['x', 'y'], phone: true }), ['x'], 'the phone has one pane');
  assert.deepStrictEqual(onScreen({ view: 'session', active: 'x', hidden: true }), [], 'a hidden phone page shows nothing');
  assert.deepStrictEqual(onScreen({ view: 'session', active: 'x', external: true }), [], 'an external session fills the main area');
});

// The real engine (fake SDK): sessions.release / sessions.viewing over the RPC methods, per client.
test('engine: sessions.release closes an idle CLI now; another client viewing it keeps it; viewing / send clear a pending release', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createEngine } = require('../../main/engine');
  const { createFakeSdk, F } = require('./fake-sdk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-release-'));
  const mk = (p) => fs.mkdtempSync(path.join(root, p));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let gate = null; // a turn whose text says "slow" waits on this
  const sdk = createFakeSdk(async function* (um) {
    const text = JSON.stringify(um.message && um.message.content);
    if (text.includes('slow')) await new Promise((r) => { gate = r; });
    for (const f of F.textTurn('m' + Math.random(), 'ok')) yield f;
    yield F.result(0.01);
  }, { projectsDir: mk('proj-') });
  const logs = [];
  const engine = createEngine({ userDataDir: mk('ud-'), emit: () => {}, log: (lvl, m) => logs.push(m), sdk, claudePath: null, projectsDir: mk('proj2-'), statuslineDir: mk('sl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 0, idleCheckMs: 20 });
  const m = engine.methods;
  const es = (id) => engine._internal.sessions.get(id);
  const until = async (pred, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 4000) throw new Error('timed out: ' + what); await sleep(5); } };
  const openGate = () => { const g = gate; gate = null; if (g) g(); };
  const desk = { id: 'desk', platform: 'electron' }, phone = { id: 'phone', platform: 'web' };
  try {
    const cwd = mk('cwd-');
    const a = await m['sessions.create']({ cwd });
    const b = await m['sessions.create']({ cwd });
    const c = await m['sessions.create']({ cwd });
    for (const x of [a, b, c]) await m['sessions.send']({ id: x.id, text: 'hello' });
    await until(() => [a, b, c].every((x) => es(x.id).live() && es(x.id).s.status === 'idle'), 'turns done');
    const before = { ...es(a.id).s };

    // idle, shown on the desktop only: the desktop closes its tab -> closed now, quietly
    await m['sessions.viewing']({ ids: [a.id] }, desk);
    assert.deepStrictEqual(await m['sessions.release']({ id: a.id }, desk), { action: 'closed' });
    assert.strictEqual(es(a.id).live(), false);
    assert.strictEqual(es(a.id).s.updatedAt, before.updatedAt, 'quiet: same place in the list');
    assert.strictEqual(es(a.id).s.status, 'idle');
    assert.ok(logs.some((l) => l.includes(`closed CLI for ${a.id}: released on tab close`)));
    const calls = sdk.calls.length;
    await m['sessions.history']({ id: a.id });
    await m['sessions.markRead']({ id: a.id });
    await m['sessions.viewing']({ ids: [a.id] }, desk); // viewed again from the sidebar
    assert.strictEqual(es(a.id).live(), false, 'viewing does not respawn a CLI');
    assert.strictEqual(sdk.calls.length, calls);
    await m['sessions.viewing']({ ids: [] }, desk);

    // the phone has b open: a desktop tab close leaves its CLI alone (the idle window still applies)
    await m['sessions.viewing']({ ids: [b.id] }, phone);
    assert.deepStrictEqual(await m['sessions.release']({ id: b.id }, desk), { action: 'kept', reason: 'open on another screen' });
    await sleep(80);
    assert.strictEqual(es(b.id).live(), true);
    engine.clientClosed(phone); // the phone went away: nobody views b
    assert.strictEqual((await m['sessions.release']({ id: b.id }, desk)).action, 'closed');

    // busy: marked; the turn finishes normally, then the CLI closes within a sweep
    await m['sessions.send']({ id: c.id, text: 'slow one' });
    await until(() => gate && es(c.id).busyState(), 'c busy');
    assert.strictEqual((await m['sessions.release']({ id: c.id }, desk)).action, 'marked');
    await sleep(80);
    assert.strictEqual(es(c.id).live(), true, 'a running turn is never interrupted');
    openGate();
    await until(() => !es(c.id).live(), 'c closed once idle');
    assert.strictEqual(es(c.id).s.status, 'idle', 'the turn ended normally');
    assert.ok(logs.some((l) => l.includes(`closed CLI for ${c.id} released on tab close (now idle)`)));

    // re-opening it clears the mark (sessions.viewing) ...
    await m['sessions.send']({ id: c.id, text: 'slow two' });
    await until(() => gate && es(c.id).busyState(), 'c busy again');
    assert.strictEqual((await m['sessions.release']({ id: c.id }, desk)).action, 'marked');
    await m['sessions.viewing']({ ids: [c.id] }, desk);
    openGate();
    await until(() => !es(c.id).busyState(), 'c idle');
    await sleep(100); // several sweeps
    assert.strictEqual(es(c.id).live(), true, 're-opened: the mark is gone');
    // ... and so does sending it a message
    await m['sessions.viewing']({ ids: [] }, desk);
    await m['sessions.send']({ id: c.id, text: 'slow three' });
    await until(() => gate && es(c.id).busyState(), 'c busy a third time');
    assert.strictEqual((await m['sessions.release']({ id: c.id }, desk)).action, 'marked');
    await m['sessions.send']({ id: c.id, text: 'a follow-up' });
    openGate();
    await until(() => !es(c.id).busyState(), 'c idle again');
    await sleep(100);
    assert.strictEqual(es(c.id).live(), true, 'sent a message: the mark is gone');
    await assert.rejects(m['sessions.viewing']({ ids: 'x' }, desk), /ids must be/);
  } finally {
    openGate();
    await engine.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
