// "Needs you" count on Helm's taskbar pin (lane badge, 2026-10-09).
// The user's rule: count = sessions WAITING on the user (a question / permission / plan: Session.status 'waiting',
// the same test notify.js's tray and the sidebar use) + sessions that STOPPED ON AN ERROR (Session.status
// 'error'). An error keeps counting until the user opens that session (sessions.markRead, which the UI sends on
// every open, from the desktop or the phone), the session starts a new turn (status 'working': the user sent
// again, so they have seen it), is archived, or is deleted. A session counts once, never twice.
//
// Published two ways, debounced (bursts of session.updated collapse into one write):
//  (a) the standard Windows taskbar overlay on Helm's window (win.setOverlayIcon, the number icon from
//      icons.js; cleared at 0). notify.js no longer sets the overlay when this module runs (overlay:false).
//  (b) <userData>\badge.json, written atomically (main/atomic.js) for Mantle's bar:
//      { v: 1, count, waiting, errors, errorIds, pid, updatedAt }
//      `pid` lets a reader drop a stale file left by a crash (process gone = treat as 0); `errorIds` carries
//      the unseen errors across a Helm restart (Session.status 'error' is persisted, so without it every
//      restart would resurrect errors the user already looked at). On quit Helm writes count 0.
// Driven by the engine's own events (hostEmit) + the sessions.markRead RPC: no polling.
// Owner: lane host (B).
const fs = require('fs');
const path = require('path');

/** Pure: the count from a status map and the set of unseen errors. */
function summarize(sessions, unseenErrors) {
  let waiting = 0;
  let errors = 0;
  const errorIds = [];
  for (const [id, s] of sessions) {
    if (!s || s.archived) continue;
    if (s.status === 'waiting') waiting++;
    else if (unseenErrors.has(id)) { errors++; errorIds.push(id); }
  }
  return { count: waiting + errors, waiting, errors, errorIds };
}

/**
 * The count logic, no Electron and no disk. onChange(state) runs (debounced) when the count's parts change.
 * createTracker({ onChange, debounceMs = 250, timers = { setTimeout, clearTimeout } })
 * -> { seed(sessions, { errorIds? }), onEngineEvent(event, data), opened(id), state(), flush(), destroy() }
 */
function createTracker({ onChange = () => {}, debounceMs = 250, timers = { setTimeout, clearTimeout } } = {}) {
  const sessions = new Map(); // id -> { status, archived }
  const unseen = new Set();   // ids of sessions that stopped on an error and the user has not opened since
  let last = null;            // last published key
  let timer = null;

  function state() { return summarize(sessions, unseen); }
  function key(st) { return `${st.waiting}|${st.errors}|${st.errorIds.join(',')}`; }

  function flush() {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    const st = state();
    const k = key(st);
    if (k === last) return;
    last = k;
    onChange(st);
  }
  function schedule() {
    if (timer) return;
    if (!debounceMs) { flush(); return; }
    timer = timers.setTimeout(() => { timer = null; flush(); }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function put(s) {
    const prev = sessions.get(s.id);
    const status = s.status || 'idle';
    sessions.set(s.id, { status, archived: !!s.archived });
    if (status === 'error' && (!prev || prev.status !== 'error')) unseen.add(s.id);
    // a new turn means the user sent again (or a job did): the error is behind it
    if (status === 'working' || s.archived) unseen.delete(s.id);
  }

  // errorIds: the unseen errors saved by the last run (null = no saved state: every errored session counts)
  function seed(list, { errorIds = null } = {}) {
    sessions.clear();
    unseen.clear();
    const keep = Array.isArray(errorIds) ? new Set(errorIds) : null;
    for (const s of list || []) {
      if (!s || !s.id) continue;
      sessions.set(s.id, { status: s.status || 'idle', archived: !!s.archived });
      if (s.status === 'error' && !s.archived && (!keep || keep.has(s.id))) unseen.add(s.id);
    }
    last = null;
    flush();
  }

  function onEngineEvent(event, data) {
    if (!data || !data.id) return;
    if (event === 'session.created' || event === 'session.updated') { put(data); schedule(); }
    else if (event === 'session.removed') { sessions.delete(data.id); unseen.delete(data.id); schedule(); }
  }

  // The user opened the session (sessions.markRead): its error has been seen.
  function opened(id) { if (id && unseen.delete(id)) schedule(); }

  function destroy() { if (timer) { timers.clearTimeout(timer); timer = null; } }

  return { seed, onEngineEvent, opened, state, flush, destroy };
}

/** Read the previous run's unseen error ids from badge.json (null when there is no usable file). */
function readSavedErrorIds(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && Array.isArray(v.errorIds) ? v.errorIds.filter((x) => typeof x === 'string') : null;
  } catch { return null; }
}

/**
 * createBadge({ electron, getWindow, userDataDir, log, record?, debounceMs?, writeFile? })
 *   record: test-mode { overlay: [] } gets { n, waiting, errors, at } per overlay change (tools/desktop-check.js)
 * -> { seed(sessions), onEngineEvent(event, data), opened(id), state(), file, flush(), close() }
 */
function createBadge(opts) {
  const { electron, getWindow, userDataDir, log = () => {}, record = null, debounceMs = 250 } = opts;
  const { writeFileAtomic } = require('./atomic');
  const writeFile = opts.writeFile || writeFileAtomic;
  const file = path.join(userDataDir, 'badge.json');
  const saved = readSavedErrorIds(file);
  let lastOverlay = -1;
  let closed = false; // after close(): late engine events (shutdown closes CLIs) must not write a count back

  function setOverlay(st) {
    const n = st.count;
    if (n === lastOverlay) return;
    const w = getWindow();
    if (!w || w.isDestroyed()) return; // re-applied by refreshWindow() once the window exists
    lastOverlay = n;
    try {
      if (n) {
        const { badgeBitmap } = require('./icons');
        const bm = badgeBitmap(n);
        const img = electron.nativeImage.createFromBitmap(bm.buffer, { width: bm.width, height: bm.height, scaleFactor: 2 });
        w.setOverlayIcon(img, describe(st));
      } else w.setOverlayIcon(null, '');
      if (record) record.overlay.push({ n, waiting: st.waiting, errors: st.errors, at: Date.now() });
    } catch (e) { log('badge overlay failed:', e.message); }
  }

  function writeState(st) {
    const body = { v: 1, count: st.count, waiting: st.waiting, errors: st.errors, errorIds: st.errorIds, pid: process.pid, updatedAt: Date.now() };
    try { writeFile(file, JSON.stringify(body)); } catch (e) { log('badge.json write failed:', e.message); }
  }

  const tracker = createTracker({ debounceMs, onChange: (st) => { if (closed) return; setOverlay(st); writeState(st); } });

  return {
    file,
    seed: (sessions) => tracker.seed(sessions, { errorIds: saved }),
    onEngineEvent: tracker.onEngineEvent,
    opened: tracker.opened,
    state: tracker.state,
    flush: tracker.flush,
    // the window was (re)created: put the overlay back on it
    refreshWindow() { lastOverlay = -1; setOverlay(tracker.state()); },
    // quitting: Mantle must not keep showing a number for a Helm that is gone (errorIds kept for next start)
    close() {
      if (closed) return;
      closed = true;
      tracker.destroy();
      const st = tracker.state();
      try { writeFile(file, JSON.stringify({ v: 1, count: 0, waiting: 0, errors: 0, errorIds: st.errorIds, pid: null, updatedAt: Date.now() })); } catch (e) { log('badge.json write failed:', e.message); }
    },
  };
}

/** Overlay description (screen readers / the taskbar tooltip): "2 waiting, 1 error". */
function describe(st) {
  const parts = [];
  if (st.waiting) parts.push(`${st.waiting} waiting`);
  if (st.errors) parts.push(`${st.errors} ${st.errors === 1 ? 'error' : 'errors'}`);
  return parts.join(', ');
}

module.exports = { summarize, createTracker, createBadge, describe, readSavedErrorIds };
