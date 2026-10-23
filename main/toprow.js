// Top-row hints to Mantle (look-sync CONTRACT "Top-row hints", protocol v1). Mantle's main process listens on the
// named pipe \\.\pipe\look-sync-toprow; Helm's main process is a client. Each line is one JSON object:
//   {"v":1,"app":"helm","hwnd":"<decimal HWND>","seq":<int, increasing per hwnd>,"t":<Date.now()>,"top":TOP}
// The renderer works TOP out (ui/lib/toprow.js) in the same JS task that changes the window's top row and hands it
// over by IPC (preload helmNative.topRow); this module writes it at once. Every window's latest TOP is kept and
// re-sent on (re)connect. Mantle not running is normal: retry at most once per 2 s, never throw, log only when the
// state changes, and show the state in Settings > Appearance (state() / onStatus).
// Owner: lane helm-toprow-hints.
const net = require('net');

const PIPE = '\\\\.\\pipe\\look-sync-toprow';
const MAX_LINE = 8192;
const MAX_BUFFERED = 256 * 1024;   // Mantle stopped reading: drop the connection rather than queue forever

const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every(byte);

/** a TOP the protocol allows, or null */
function cleanTop(t) {
  if (!t || typeof t !== 'object') return null;
  switch (t.kind) {
    case 'none': return { kind: 'none' };
    case 'flat': return isRgb(t.rgb) ? { kind: 'flat', rgb: t.rgb.slice() } : null;
    case 'wash': return isRgb(t.rgb) && typeof t.alpha === 'number' && t.alpha >= 0 && t.alpha <= 1 ? { kind: 'wash', rgb: t.rgb.slice(), alpha: t.alpha } : null;
    case 'cols': return Array.isArray(t.cols) && t.cols.length > 0 && t.cols.length <= 512 && t.cols.every(isRgb) ? { kind: 'cols', cols: t.cols.map((c) => c.slice()) } : null;
    default: return null;
  }
}

/** the decimal HWND of a BrowserWindow (getNativeWindowHandle is the HWND's bytes, little-endian) */
function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
  } catch { return null; }
}

/**
 * createTopRow({ pipe, app, connect, log, onStatus, retryMs, now })
 *   pipe: the pipe path, or null = off (a --test run without HELM_TOPROW_PIPE); offReason says why
 * -> { start(), stop(), set(hwnd, top), resend(hwnd), forget(hwnd), state(), last(hwnd) }
 */
function createTopRow(opts = {}) {
  const pipe = opts.pipe === undefined ? PIPE : opts.pipe;
  const app = opts.app || 'helm';
  const connect = opts.connect || ((p) => net.connect(p));
  const log = opts.log || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const retryMs = Math.max(2000, opts.retryMs || 2000);   // the protocol: at most one attempt per 2 s
  const now = opts.now || Date.now;
  const wins = new Map();   // hwnd -> { top, seq }
  let sock = null, connected = false, timer = null, stopped = true, attempts = 0;
  let status = pipe
    ? { state: 'connecting', reason: null, pipe, sent: 0, since: now() }
    : { state: 'off', reason: opts.offReason || 'Top bar hints are off', pipe: null, sent: 0, since: now() };

  function setStatus(state, reason) {
    if (status.state === state && status.reason === reason) return;
    status = { ...status, state, reason, since: now() };
    if (state === 'connected') log('top-row hints: Mantle connected');
    else if (state !== 'connecting') log(`top-row hints: ${reason || state}`);
    try { onStatus(state); } catch {}
  }

  function line(hwnd, w) {
    let s = JSON.stringify({ v: 1, app, hwnd, seq: w.seq, t: now(), top: w.top });
    if (Buffer.byteLength(s) + 1 > MAX_LINE) s = JSON.stringify({ v: 1, app, hwnd, seq: w.seq, t: now(), top: { kind: 'none' } });
    return s + '\n';
  }
  function write(hwnd, w) {
    if (!connected || !sock) return false;
    try {
      if (sock.writableLength > MAX_BUFFERED) { drop('Mantle is not reading the hints (over 256 KB waiting)'); return false; }
      sock.write(line(hwnd, w));
      status.sent += 1;
      return true;
    } catch (e) { drop('write failed: ' + e.message); return false; }
  }

  function schedule() {
    if (stopped || timer || !pipe) return;
    timer = setTimeout(() => { timer = null; open(); }, attempts > 30 ? Math.max(retryMs, 5000) : retryMs);
    if (timer.unref) timer.unref();
  }
  function drop(reason) {
    const s = sock;
    sock = null; connected = false;
    if (s) { try { s.removeAllListeners(); s.on('error', () => {}); s.destroy(); } catch {} }
    if (!stopped) setStatus('not-running', reason);
    schedule();
  }
  function open() {
    if (stopped || sock || !pipe) return;
    attempts += 1;
    let s;
    try { s = connect(pipe); } catch (e) { drop('could not open the pipe: ' + e.message); return; }
    sock = s;
    s.setNoDelay && s.setNoDelay(true);
    s.on('connect', () => {
      if (sock !== s) return;
      connected = true; attempts = 0;
      setStatus('connected', null);
      for (const [hwnd, w] of wins) { w.seq += 1; write(hwnd, w); }   // every window on connect
    });
    s.on('data', () => {});   // Mantle may answer; nothing to read in v1
    s.on('error', (e) => {
      if (sock !== s) return;
      const missing = e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED');
      drop(missing ? 'nothing is listening on ' + pipe + ', so the bar reads the screen instead' : 'pipe error: ' + (e && (e.code || e.message)));
    });
    s.on('close', () => { if (sock === s) drop('Mantle closed the connection'); });
  }

  return {
    start() { if (!pipe || !stopped) return this; stopped = false; open(); return this; },
    stop() {
      stopped = true;
      clearTimeout(timer); timer = null;
      const s = sock; sock = null; connected = false;
      // end() lets the last lines (a closing window's none) drain; destroy shortly after in case Mantle hangs
      if (s) { try { s.removeAllListeners(); s.on('error', () => {}); s.end(); const k = setTimeout(() => { try { s.destroy(); } catch {} }, 300); k.unref && k.unref(); } catch {} }
    },
    /** a window's top row changed: keep it and send it now. Returns true when it went out. */
    set(hwnd, top) {
      const t = cleanTop(top);
      if (!hwnd || !t) return false;
      const w = wins.get(hwnd) || { top: null, seq: 0 };
      w.top = t; w.seq += 1;
      wins.set(hwnd, w);
      return write(hwnd, w);
    },
    /** the same TOP again with a new seq (maximize, fullscreen: the geometry changed, the look did not) */
    resend(hwnd) { const w = wins.get(hwnd); if (!w) return false; w.seq += 1; return write(hwnd, w); },
    /** the window closed: say none, then forget it */
    forget(hwnd) {
      const w = wins.get(hwnd);
      if (!w) return;
      w.top = { kind: 'none' }; w.seq += 1;
      write(hwnd, w);
      wins.delete(hwnd);
    },
    state() { return { ...status, connected, windows: wins.size }; },
    last(hwnd) { const w = wins.get(hwnd); return w ? { top: w.top, seq: w.seq } : null; },
  };
}

module.exports = { createTopRow, cleanTop, hwndOf, PIPE, MAX_LINE };
