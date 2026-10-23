// notify.js with a fake Electron: badge count, frame flash, notification filtering, click -> app.select.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { EventEmitter } = require('events');
const { createNotifier } = require('../../main/notify');
const { badgeBitmap, appIconBitmap } = require('../../main/icons');

function fakeElectron() {
  const shown = [];
  class Notification extends EventEmitter {
    constructor(o) { super(); this.o = o; }
    static isSupported() { return true; }
    show() { shown.push(this); }
  }
  const img = { isEmpty: () => false, resize: () => img };
  class Tray extends EventEmitter {
    setToolTip(t) { this.tip = t; } setContextMenu(m) { this.menu = m; } destroy() {}
  }
  return {
    shown,
    electron: { Notification, Tray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromBitmap: (b, o) => ({ ...img, bm: o }), createFromPath: () => img } },
  };
}

function fakeWindow() {
  return {
    focused: false, overlay: undefined, flashes: [],
    isDestroyed: () => false, isVisible() { return true; }, isMinimized: () => false, isFocused() { return this.focused; },
    setOverlayIcon(i, d) { this.overlay = i ? d : null; }, flashFrame(v) { this.flashes.push(v); },
  };
}

function setup(prefs = { waiting: true, done: true, error: true }) {
  const { electron, shown } = fakeElectron();
  const win = fakeWindow();
  const broadcasts = []; let showCount = 0;
  const n = createNotifier({
    electron, getWindow: () => win, showWindow: () => { showCount++; }, broadcast: (e, d) => broadcasts.push([e, d]),
    getSettings: () => ({ notifications: prefs }), iconDir: os.tmpdir() + '/helm-no-icons-here', onQuit: () => {}, enableTray: true,
  });
  return { n, win, shown, broadcasts, shows: () => showCount };
}

test('badge counts waiting sessions and flashes on a new wait', () => {
  const { n, win } = setup();
  n.seed([{ id: 'a', status: 'idle' }, { id: 'b', status: 'waiting' }]);
  assert.equal(win.overlay, '1 waiting');
  n.onEngineEvent('session.updated', { id: 'a', status: 'waiting' });
  assert.equal(win.overlay, '2 waiting');
  assert.deepEqual(win.flashes, [true]);
  n.onEngineEvent('session.updated', { id: 'a', status: 'waiting' }); // no second flash for the same wait
  assert.deepEqual(win.flashes, [true]);
  n.onEngineEvent('session.updated', { id: 'a', status: 'idle' });
  n.onEngineEvent('session.removed', { id: 'b' });
  assert.equal(win.overlay, null);
  assert.equal(n.waitingCount(), 0);
});

test('no flash while the window is focused', () => {
  const { n, win } = setup();
  win.focused = true;
  n.onEngineEvent('session.created', { id: 'x', status: 'waiting' });
  assert.deepEqual(win.flashes, []);
});

test('notify: shown when unfocused, skipped when focused or the kind is turned off; click selects the session', () => {
  const { n, win, shown, broadcasts, shows } = setup({ waiting: true, done: false });
  win.focused = true;
  n.onEngineEvent('notify', { title: 'A', body: 'x', kind: 'waiting', sessionId: 's1' });
  assert.equal(shown.length, 0);
  win.focused = false;
  n.onEngineEvent('notify', { title: 'B', body: 'x', kind: 'done', sessionId: 's1' });
  assert.equal(shown.length, 0);
  n.onEngineEvent('notify', { title: 'C', body: 'needs you', kind: 'waiting', sessionId: 's1' });
  assert.equal(shown.length, 1);
  shown[0].emit('click');
  assert.equal(shows(), 1);
  assert.deepEqual(broadcasts, [['app.select', { sessionId: 's1' }]]);
});

test('badge and placeholder icon bitmaps are 32x32 BGRA', () => {
  for (const bm of [badgeBitmap(1), badgeBitmap(12), appIconBitmap()]) {
    assert.equal(bm.width, 32); assert.equal(bm.buffer.length, 32 * 32 * 4);
    assert.ok(bm.buffer.some((v, i) => i % 4 === 3 && v === 255), 'has opaque pixels');
  }
});

// ---------- context hand-off alerts (lane infra, 2026-10-08) ----------
function contextSetup(extra = {}, opts = {}) {
  const { electron, shown } = fakeElectron();
  const win = fakeWindow();
  const broadcasts = [];
  const settings = { notifications: { waiting: true, done: true, error: true }, notifyContextHandoff: true, ...extra };
  const record = { overlay: [], flash: [] };
  const n = createNotifier({
    electron, getWindow: () => win, showWindow: () => {}, broadcast: (e, d) => broadcasts.push([e, d]),
    getSettings: () => settings, iconDir: os.tmpdir() + '/helm-no-icons-here', onQuit: () => {}, enableTray: false, record, ...opts,
  });
  const fleet = (pct, status = 'running') => n.onEngineEvent('fleet.updated', { sessionId: 's1', agents: [{ id: 't1', status, description: 'audit-routes', context: { percent: pct } }] });
  return { n, win, shown, broadcasts, settings, record, fleet, notifies: () => broadcasts.filter(([e]) => e === 'notify').map(([, d]) => d) };
}

test('context alerts: fleet.updated past 32% / 40% -> one notify broadcast each, native toast + flash when unfocused', () => {
  const c = contextSetup();
  c.n.seed([{ id: 's1', status: 'running', title: 'Infra lane' }]);
  c.fleet(20); c.fleet(33); c.fleet(35); c.fleet(41); c.fleet(48);
  const sent = c.notifies();
  assert.deepEqual(sent.map((x) => x.title), ["Agent 'audit-routes' is at 33% context — hand it off", "Agent 'audit-routes' is at 41% context — over the 40% ceiling"]);
  assert.ok(sent.every((x) => x.sessionId === 's1' && /Infra lane/.test(x.body)));
  assert.equal(c.shown.length, 2);                       // native toasts (window not focused)
  assert.deepEqual(c.win.flashes, [true, true]);
  assert.deepEqual(c.record.flash.map((f) => f.context), [32, 40]);
});

test('context alerts: onContextAlert (main.js -> phone push) gets each crossing once, lane tag as the name', () => {
  const hooked = [];
  const c = contextSetup({}, { onContextAlert: (x) => hooked.push(x) });
  const lane = (pct) => c.n.onEngineEvent('fleet.updated', { sessionId: 's1', agents: [{ id: 't2', status: 'running', description: '[lane:ctxwarn2] Show context %', context: { percent: pct } }] });
  lane(12); lane(33); lane(33.6); lane(34); lane(41); lane(41.2); lane(45);
  assert.deepEqual(hooked.map((x) => [x.threshold, x.source, x.agentId, x.title]), [
    [32, 'context', 't2', "Agent 'lane:ctxwarn2' is at 33% context — hand it off"],
    [40, 'context', 't2', "Agent 'lane:ctxwarn2' is at 41% context — over the 40% ceiling"],
  ]);
  // the hook runs even with the window focused (push applies its own focus rule), never when the switch is off
  c.win.focused = true;
  const off = contextSetup({ notifyContextHandoff: false }, { onContextAlert: (x) => hooked.push(x) });
  off.fleet(35); off.fleet(45);
  assert.equal(hooked.length, 2);
});

test('context alerts: focused window gets the in-app notify only (no native toast, no flash)', () => {
  const c = contextSetup();
  c.win.focused = true;
  c.fleet(34);
  assert.equal(c.notifies().length, 1);
  assert.equal(c.shown.length, 0);
  assert.deepEqual(c.win.flashes, []);
});

test('context alerts: settings.notifyContextHandoff=false silences them', () => {
  const c = contextSetup({ notifyContextHandoff: false });
  c.fleet(33); c.fleet(45);
  assert.equal(c.notifies().length, 0);
  assert.equal(c.shown.length, 0);
  assert.deepEqual(c.win.flashes, []);
});

test('engine notify events go through the returned notify(), so a test-mode stub silences them', () => {
  const c = contextSetup();
  let stubbed = 0;
  c.n.notify = () => { stubbed++; };
  c.n.onEngineEvent('notify', { title: 'Session', body: 'done', kind: 'done' });
  c.fleet(33);
  assert.equal(stubbed, 2);
  assert.equal(c.shown.length, 0);
});

test('context alerts have their own switch: muting "Needs you"/"Errors" toasts does not mute them', () => {
  const c = contextSetup({ notifications: { waiting: false, done: true, error: false } });
  c.fleet(33); c.fleet(41);
  assert.equal(c.shown.length, 2);
});
