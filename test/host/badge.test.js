// main/badge.js: the "needs you" count (waiting + unseen errors), its debounce, the overlay and badge.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { summarize, createTracker, createBadge, describe: describeState } = require('../../main/badge');

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout(fn) { const id = next++; pending.set(id, fn); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
    run() { const fns = [...pending.values()]; pending.clear(); for (const f of fns) f(); },
  };
}

function tracker(opts = {}) {
  const changes = [];
  const t = fakeTimers();
  const tr = createTracker({ onChange: (s) => changes.push(s), timers: t.timers, ...opts });
  return { tr, changes, t };
}

test('summarize: waiting + unseen errors, a session counts once, archived never', () => {
  const m = new Map([
    ['a', { status: 'waiting' }], ['b', { status: 'error' }], ['c', { status: 'idle' }],
    ['d', { status: 'waiting', archived: true }], ['e', { status: 'waiting' }],
  ]);
  const st = summarize(m, new Set(['b', 'e', 'c']));
  // e is waiting AND has an unseen error: one count, as waiting. c's unseen error counts (it stopped on one).
  assert.deepEqual(st, { count: 4, waiting: 2, errors: 2, errorIds: ['b', 'c'] });
});

test('waiting sessions count and drop back; bursts collapse into one change', () => {
  const { tr, changes, t } = tracker();
  tr.seed([{ id: 'a', status: 'idle' }, { id: 'b', status: 'idle' }]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].count, 0);
  tr.onEngineEvent('session.updated', { id: 'a', status: 'waiting' });
  tr.onEngineEvent('session.updated', { id: 'b', status: 'waiting' });
  tr.onEngineEvent('session.updated', { id: 'b', status: 'working' });
  tr.onEngineEvent('session.updated', { id: 'b', status: 'waiting' });
  assert.equal(changes.length, 1, 'debounced: nothing published yet');
  assert.equal(t.pending.size, 1, 'one timer for the burst');
  t.run();
  assert.equal(changes.length, 2);
  assert.deepEqual([changes[1].count, changes[1].waiting, changes[1].errors], [2, 2, 0]);
  tr.onEngineEvent('session.updated', { id: 'a', status: 'idle' });
  tr.onEngineEvent('session.updated', { id: 'b', status: 'idle' });
  t.run();
  assert.equal(changes.at(-1).count, 0);
});

test('no change, no publish (same count after a burst)', () => {
  const { tr, changes, t } = tracker();
  tr.seed([{ id: 'a', status: 'idle' }]);
  tr.onEngineEvent('session.updated', { id: 'a', status: 'waiting' });
  tr.onEngineEvent('session.updated', { id: 'a', status: 'idle' });
  t.run();
  assert.equal(changes.length, 1);
});

test('an error keeps counting until the session is opened', () => {
  const { tr, changes, t } = tracker();
  tr.seed([{ id: 'a', status: 'working' }]);
  tr.onEngineEvent('session.updated', { id: 'a', status: 'error' });
  t.run();
  assert.deepEqual([changes.at(-1).count, changes.at(-1).errors], [1, 1]);
  // a later quiet idle-close or any other status that is not a new turn does not clear it
  tr.onEngineEvent('session.updated', { id: 'a', status: 'idle' });
  t.run();
  assert.equal(tr.state().count, 1);
  tr.opened('zzz'); // another session opened: no change
  assert.equal(t.pending.size, 0);
  tr.opened('a');
  t.run();
  assert.equal(changes.at(-1).count, 0);
});

test('an error is cleared by a new turn, archive or delete', () => {
  const { tr, t } = tracker();
  tr.seed([{ id: 'a', status: 'error' }, { id: 'b', status: 'error' }, { id: 'c', status: 'error' }]);
  assert.equal(tr.state().errors, 3);
  tr.onEngineEvent('session.updated', { id: 'a', status: 'working' });
  tr.onEngineEvent('session.updated', { id: 'b', status: 'closed', archived: true });
  tr.onEngineEvent('session.removed', { id: 'c' });
  t.run();
  assert.equal(tr.state().count, 0);
  // unarchive (never starts a CLI; status stays closed): the old error does not come back
  tr.onEngineEvent('session.updated', { id: 'b', status: 'closed', archived: false });
  assert.equal(tr.state().errors, 0);
});

test('a session that errors again after being opened counts again', () => {
  const { tr } = tracker({ debounceMs: 0 });
  tr.seed([{ id: 'a', status: 'error' }]);
  tr.opened('a');
  assert.equal(tr.state().count, 0);
  tr.onEngineEvent('session.updated', { id: 'a', status: 'working' });
  tr.onEngineEvent('session.updated', { id: 'a', status: 'error' });
  assert.equal(tr.state().count, 1);
});

test('seed with the saved errorIds only counts errors still unseen at the last run', () => {
  const { tr } = tracker({ debounceMs: 0 });
  tr.seed([{ id: 'a', status: 'error' }, { id: 'b', status: 'error' }, { id: 'c', status: 'waiting' }], { errorIds: ['b'] });
  assert.deepEqual(tr.state(), { count: 2, waiting: 1, errors: 1, errorIds: ['b'] });
  tr.seed([{ id: 'a', status: 'error' }], { errorIds: null }); // no saved state: every errored session counts
  assert.equal(tr.state().errors, 1);
});

test('describe: overlay description text', () => {
  assert.equal(describeState({ waiting: 2, errors: 0 }), '2 waiting');
  assert.equal(describeState({ waiting: 1, errors: 1 }), '1 waiting, 1 error');
  assert.equal(describeState({ waiting: 0, errors: 3 }), '3 errors');
});

test('createBadge: overlay set/cleared, badge.json written atomically, close writes 0 and keeps errorIds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-badge-'));
  try {
    const win = { overlay: undefined, desc: null, isDestroyed: () => false, setOverlayIcon(i, d) { this.overlay = i; this.desc = d; } };
    const electron = { nativeImage: { createFromBitmap: (b, o) => ({ bm: o }) } };
    const record = { overlay: [] };
    const b = createBadge({ electron, getWindow: () => win, userDataDir: dir, record, debounceMs: 0 });
    b.seed([{ id: 'a', status: 'waiting' }, { id: 'b', status: 'error' }]);
    assert.ok(win.overlay && win.overlay.bm.width === 32);
    assert.equal(win.desc, '1 waiting, 1 error');
    let j = JSON.parse(fs.readFileSync(b.file, 'utf8'));
    assert.deepEqual([j.v, j.count, j.waiting, j.errors, j.pid], [1, 2, 1, 1, process.pid]);
    assert.deepEqual(j.errorIds, ['b']);
    assert.ok(typeof j.updatedAt === 'number');
    assert.ok(!fs.existsSync(`${b.file}.tmp`), 'temp file renamed away');
    b.onEngineEvent('session.updated', { id: 'a', status: 'idle' });
    b.opened('b');
    assert.equal(win.overlay, null);
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf8')).count, 0);
    assert.deepEqual(record.overlay.map((r) => r.n), [2, 1, 0]);
    // error again, then quit: file says 0 (Mantle hides it) but remembers the unseen error for next start
    b.onEngineEvent('session.updated', { id: 'b', status: 'working' });
    b.onEngineEvent('session.updated', { id: 'b', status: 'error' });
    b.close();
    j = JSON.parse(fs.readFileSync(b.file, 'utf8'));
    assert.deepEqual([j.count, j.pid, j.errorIds], [0, null, ['b']]);
    b.onEngineEvent('session.updated', { id: 'a', status: 'waiting' }); // after close: nothing written
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf8')).count, 0);
    // next start: the saved unseen error counts again
    const win2 = { isDestroyed: () => false, setOverlayIcon(i, d) { this.overlay = i; this.desc = d; } };
    const b2 = createBadge({ electron, getWindow: () => win2, userDataDir: dir, debounceMs: 0 });
    b2.seed([{ id: 'a', status: 'idle' }, { id: 'b', status: 'error' }, { id: 'c', status: 'error' }]);
    assert.equal(win2.desc, '1 error');
    b2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createBadge: no window yet, refreshWindow applies the overlay once it exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-badge-'));
  try {
    let win = null;
    const electron = { nativeImage: { createFromBitmap: (b, o) => ({ bm: o }) } };
    const b = createBadge({ electron, getWindow: () => win, userDataDir: dir, debounceMs: 0 });
    b.seed([{ id: 'a', status: 'waiting' }]);
    win = { isDestroyed: () => false, setOverlayIcon(i, d) { this.overlay = i; this.desc = d; } };
    b.refreshWindow();
    assert.equal(win.desc, '1 waiting');
    b.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createBadge: a write failure is logged, never thrown', () => {
  const logs = [];
  const b = createBadge({
    electron: { nativeImage: { createFromBitmap: () => ({}) } }, getWindow: () => null, userDataDir: path.join(os.tmpdir(), 'helm-badge-none'),
    log: (...a) => logs.push(a.join(' ')), debounceMs: 0, writeFile: () => { throw new Error('disk full'); },
  });
  b.seed([{ id: 'a', status: 'waiting' }]);
  assert.ok(logs.some((l) => /badge\.json write failed: disk full/.test(l)));
});
