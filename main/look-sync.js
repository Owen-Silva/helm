// VENDORED from the look-sync project (look-sync.js at commit 0b55b9c). Do not edit here:
// change it in look-sync, run its tests, and re-copy. Spec: ~/look-sync/CONTRACT.md.
'use strict';
/*
 * look-sync.js - one shared look file for Helm, Quartz and Mantle.
 * Spec: CONTRACT.md (sections 2, 3, 5) plus the user's answers of 2026-10-10.
 * Zero dependencies (Node built-ins only), CommonJS. Each app VENDORS (copies)
 * this file; do not edit a vendored copy, change it here and re-copy.
 *
 * Store: %APPDATA%\look-sync\look.json (override: opts.dir or env LOOK_SYNC_DIR).
 *
 *   const LS = require('./look-sync');
 *   const sync = LS.create({ app: 'helm', enabled: true, local: () => ({ theme, accent, glass }) });
 *   sync.on('status',  s => ...)  // { state: ok|missing|corrupt|newer|off|error, reason, rev, by, at, skipped }
 *                                 //   recovered: 'corrupt' on the ok right after a damaged file was moved aside and re-seeded
 *   sync.on('apply',   e => ...)  // { changes: { theme?, accent?, glass? }, by, rev, cause: remote|adopt|seed }
 *   sync.on('desktop', d => ...)  // the desktop record (or null) + reason; delivered even while sync is OFF
 *   sync.start();                 // read (seed if missing), then watch the folder
 *   await sync.publish('theme', 'light');   // -> { ok, rev, reason }   (never throws)
 *   await sync.setEnabled(false|true);      // the per-app switch, section 5
 *   sync.readOnlyNow();           // -> reason while a newer-schema file is on disk NOW, else null
 *   sync.refresh();               // call on window focus and on resume from sleep
 *   sync.close();
 *
 * Errors are never thrown out of the stream: every failure becomes a status
 * with a reason, because each app shows that state in its UI.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SCHEMA = 1;
const FILE = 'look.json';
const FIELDS = ['theme', 'accent', 'glass'];
const APP_NAMES = { helm: 'Helm', quartz: 'Quartz', mantle: 'Mantle' };

// The first seed: Match Windows (2026-10-14, when the user un-held the light look;
// the 2026-10-10 seed was Dark). Glass from the 10-10 matched dark values; light
// values = Mantle's island light (CONTRACT "Light look").
const SEED = Object.freeze({
  theme: 'system',
  accent: Object.freeze({ hue: null }),
  glass: Object.freeze({
    dark: Object.freeze({ blurPx: 5, dim: 0.50, panel: 0 }),
    light: Object.freeze({ blurPx: 12, dim: 0.45, panel: 0 }),
    render: 'picture'
  })
});

const RANGES = { blurPx: [0, 64], dim: [0.20, 0.90], panel: [-0.30, 0.15] };

function defaultDir() {
  if (process.env.LOOK_SYNC_DIR) return process.env.LOOK_SYNC_DIR;
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'look-sync');
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const appName = a => APP_NAMES[a] || String(a || 'another app');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// ---- validation -----------------------------------------------------------

// Returns null when the value is valid, else a short reason.
function checkValue(field, v) {
  if (field === 'theme') return ['system', 'light', 'dark'].includes(v) ? null : 'theme must be system, light or dark';
  if (field === 'accent') {
    if (!isObj(v) || !('hue' in v)) return 'accent must be { hue }';
    if (v.hue === null) return null;
    return Number.isInteger(v.hue) && v.hue >= 0 && v.hue <= 360 ? null : 'accent hue must be null or an integer 0..360';
  }
  if (field === 'glass') {
    if (!isObj(v)) return 'glass must be an object';
    for (const t of ['dark', 'light']) {
      const g = v[t];
      if (!isObj(g)) return 'glass.' + t + ' missing';
      for (const k of Object.keys(RANGES)) {
        if (!num(g[k], RANGES[k])) return 'glass.' + t + '.' + k + ' must be ' + RANGES[k][0] + '..' + RANGES[k][1];
      }
    }
    return ['picture', 'seeThrough'].includes(v.render) ? null : 'glass.render must be picture or seeThrough';
  }
  return 'unknown field ' + field;
}

function checkDesktop(d) {
  if (!isObj(d)) return 'desktop must be an object';
  if (!Number.isInteger(d.rev) || d.rev < 0) return 'desktop.rev must be a whole number';
  if (typeof d.ok !== 'boolean') return 'desktop.ok must be true or false';
  for (const k of ['id', 'type', 'title', 'file', 'still', 'reason']) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') return 'desktop.' + k + ' must be text or null';
  }
  if (d.stillSize !== undefined && d.stillSize !== null &&
      !(Array.isArray(d.stillSize) && d.stillSize.length === 2 && d.stillSize.every(n => Number.isInteger(n) && n > 0))) {
    return 'desktop.stillSize must be [width, height]';
  }
  return null;
}

// Older-shape fixes. v1 drafts carried wallpaperRequest; the user dropped it
// (pictures are chosen only on the desktop, in Mantle), so it is stripped.
function migrate(doc) {
  if (doc && doc.schema === SCHEMA && 'wallpaperRequest' in doc) {
    doc = Object.assign({}, doc);
    delete doc.wallpaperRequest;
  }
  return doc;
}

// Parse + validate the bytes of look.json. Never throws.
// -> { state: 'ok'|'corrupt'|'newer', doc, skipped: [{field, reason}], reason }
function parse(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    return { state: 'corrupt', doc: null, skipped: [], reason: 'not valid JSON (' + e.message + ')' };
  }
  if (!isObj(raw)) return { state: 'corrupt', doc: null, skipped: [], reason: 'top level is not an object' };
  if (!Number.isInteger(raw.schema) || raw.schema < 1) return { state: 'corrupt', doc: null, skipped: [], reason: 'schema is missing' };
  if (raw.schema > SCHEMA) {
    return { state: 'newer', doc: null, skipped: [], schema: raw.schema,
      reason: 'Shared look is from a newer version (schema ' + raw.schema + '); update this app' };
  }
  if (!Number.isInteger(raw.rev) || raw.rev < 0) return { state: 'corrupt', doc: null, skipped: [], reason: 'rev is missing' };
  raw = migrate(raw);
  const doc = { schema: SCHEMA, rev: raw.rev, writer: isObj(raw.writer) ? raw.writer : {}, look: {} };
  const skipped = [];
  const look = isObj(raw.look) ? raw.look : {};
  for (const f of FIELDS) {
    const e = look[f];
    if (e === undefined) continue;
    let why = !isObj(e) ? 'not an object'
      : !Number.isInteger(e.rev) || e.rev < 0 ? 'rev must be a whole number'
      : checkValue(f, e.v);
    if (why) { skipped.push({ field: f, by: isObj(e) ? e.by : undefined, reason: why }); continue; }
    doc.look[f] = { v: clone(e.v), rev: e.rev, by: typeof e.by === 'string' ? e.by : null };
  }
  if (raw.desktop !== undefined && raw.desktop !== null) {
    const why = checkDesktop(raw.desktop);
    if (why) skipped.push({ field: 'desktop', by: raw.desktop && raw.desktop.by, reason: why });
    else doc.desktop = clone(raw.desktop);
  }
  return { state: 'ok', doc, skipped, reason: null };
}

// Read look.json from dir. Never throws.
// -> { state: 'ok'|'missing'|'corrupt'|'newer'|'error', doc, hash, text, skipped, reason }
function read(dir, xfs) {
  xfs = xfs || fs;
  const file = path.join(dir, FILE);
  let buf;
  try { buf = xfs.readFileSync(file); } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing', doc: null, hash: null, skipped: [], reason: 'no shared look file yet' };
    return { state: 'error', doc: null, hash: null, skipped: [], reason: "Can't read " + file + ': ' + (e.code || e.message), code: e.code };
  }
  const p = parse(buf.toString('utf8'));
  return Object.assign(p, { hash: sha1(buf), text: buf.toString('utf8') });
}

// ---- atomic write ---------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

// Write text to dir/look.json via a temp file + rename. Retries the rename on
// EBUSY/EPERM/EACCES (antivirus, a reader holding the file). Never throws.
// -> { ok: true } | { ok: false, code, reason }
async function writeAtomic(dir, text, opts) {
  opts = opts || {};
  const xfs = opts.fs || fs;
  const delays = opts.retryDelays || [50, 100, 200];
  const file = path.join(dir, FILE);
  const tmp = path.join(dir, FILE + '.' + (opts.app || 'app') + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp');
  try {
    xfs.mkdirSync(dir, { recursive: true });
    xfs.writeFileSync(tmp, text);
  } catch (e) {
    try { xfs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: e.code, reason: "Can't write " + dir + ': ' + (e.code || e.message) };
  }
  let last;
  for (let i = 0; i <= delays.length; i++) {
    try { xfs.renameSync(tmp, file); return { ok: true, tries: i + 1 }; } catch (e) {
      last = e;
      if (!RETRY_CODES.has(e.code) || i === delays.length) break;
      await sleep(delays[i]);
    }
  }
  try { xfs.unlinkSync(tmp); } catch (_) {}
  return { ok: false, code: last.code, reason: "Can't write " + dir + ': ' + (last.code || last.message) + ' (after ' + (delays.length + 1) + ' tries)' };
}

// ---- the sync instance ----------------------------------------------------

function validLocal(local) {
  const out = {};
  if (!isObj(local)) return out;
  for (const f of FIELDS) if (local[f] !== undefined && !checkValue(f, local[f])) out[f] = clone(local[f]);
  return out;
}

function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function describeChange(field, v) {
  if (field === 'theme') return 'theme changed to ' + ({ system: 'Match Windows', light: 'Light', dark: 'Dark' })[v];
  if (field === 'accent') return v.hue === null ? 'accent back to default' : 'accent hue ' + v.hue;
  return 'glass changed';
}

class LookSync extends EventEmitter {
  constructor(opts) {
    super();
    if (!opts || typeof opts.app !== 'string' || !opts.app) throw new TypeError('look-sync: opts.app is required');
    this.app = opts.app;
    this.instance = opts.instance || crypto.randomUUID();
    this.dir = opts.dir || defaultDir();
    this.file = path.join(this.dir, FILE);
    this.enabled = opts.enabled !== false;
    this.local = typeof opts.local === 'function' ? opts.local : () => ({});
    this.fs = opts.fs || fs;
    this.retryDelays = opts.retryDelays || [50, 100, 200];
    this.debounceMs = opts.debounceMs != null ? opts.debounceMs : 50; // writes are atomic renames: 50 ms coalesces the burst (was 150; the 1 s follow target)
    this.corruptRetryMs = opts.corruptRetryMs != null ? opts.corruptRetryMs : 250;
    this.rewatchDelays = opts.rewatchDelays || [1000, 5000, 30000];
    this.now = opts.now || (() => new Date());

    this.doc = null;          // last good doc seen (validated)
    this.lastHash = null;     // hash of the bytes last handled
    this.lastDocRev = -1;     // highest doc rev seen, to spot a re-seed (rev went down)
    this.applied = {};        // field -> rev applied (or written) by this instance
    this.desktopRev = null;
    this.readOnly = false;    // newer schema on disk
    this.hadFile = false;
    this.watcher = null;
    this.debounce = null;
    this.rewatchTimer = null;
    this.rewatchStep = 0;
    this.closed = false;
    this.queue = Promise.resolve();
    this._status = { state: this.enabled ? 'missing' : 'off', reason: 'not started', rev: null };
  }

  status() { return Object.assign({}, this._status); }
  desktop() {
    const d = this.doc && this.doc.desktop;
    if (!d) return { record: null, reason: "Mantle hasn't shared a desktop wallpaper yet" };
    return { record: clone(d), reason: d.ok ? null : (d.reason || 'Mantle reported the wallpaper is unavailable') };
  }
  // Read-only RIGHT NOW? Re-reads the file (sync, cheap) instead of trusting the last status, so a newer
  // file that was just deleted or replaced never blocks a change while its watch event is still in flight
  // (or was missed). When it is no longer newer, a check is queued so the status catches up. -> reason | null
  readOnlyNow() {
    if (this.closed) return null;
    const r = read(this.dir, this.fs);
    if (r.state === 'newer') { this.readOnly = true; return r.reason; }
    if (this.readOnly || this._status.state === 'newer') { this.readOnly = false; this.lastHash = null; this._check({}); }
    return null;
  }
  shared() { return this.doc ? clone(this.doc.look) : null; }

  _emitStatus(state, reason, extra) {
    const d = this.doc;
    const s = Object.assign({
      state, reason: reason || null,
      rev: d ? d.rev : null,
      by: d && d.writer ? d.writer.app || null : null,
      at: d && d.writer ? d.writer.at || null : null,
      skipped: []
    }, extra || {});
    if (!this.enabled && state !== 'error' && state !== 'newer') {
      s.state = 'off';
      s.reason = s.reason && state !== 'ok' ? s.reason : "Sync is off; this app keeps its own look";
    }
    this._status = s;
    this.emit('status', s);
  }

  start() {
    if (this.closed) return this;
    this._watch();
    this._check({ startup: true });
    return this;
  }

  close() {
    this.closed = true;
    clearTimeout(this.debounce); clearTimeout(this.rewatchTimer);
    if (this.watcher) { try { this.watcher.close(); } catch (_) {} this.watcher = null; }
  }

  refresh() { if (!this.closed) this._check({}); }

  // ---- watching ----
  _watch() {
    if (this.closed || this.watcher) return;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      const w = fs.watch(this.dir, { persistent: false }, (ev, name) => this._onEvent(ev, name));
      w.on('error', e => this._lostWatch(e.code || e.message));
      this.watcher = w;
      this.rewatchStep = 0;
      return true;
    } catch (e) {
      this._lostWatch(e.code || e.message);
      return false;
    }
  }

  _onEvent(ev, name) {
    if (this.closed) return;
    // Windows: deleting the watched folder floods 'rename' events carrying the
    // folder's own absolute path. Close at once (no event storm) and re-watch.
    if (name && (path.isAbsolute(String(name)) || /[\\/]/.test(String(name)))) {
      return this._lostWatch('folder was removed');
    }
    if (name && String(name) !== FILE) return; // temp files, stills, bad copies
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this._check({}), this.debounceMs);
  }

  _lostWatch(why) {
    if (this.closed) return;
    if (this.watcher) { try { this.watcher.close(); } catch (_) {} this.watcher = null; }
    clearTimeout(this.debounce);
    if (this.rewatchTimer) return; // already scheduled
    const delays = this.rewatchDelays;
    const ms = delays[Math.min(this.rewatchStep, delays.length - 1)];
    this.rewatchStep++;
    this._emitStatus('error', 'Watching ' + this.dir + ' stopped (' + why + '); retrying in ' + (ms >= 1000 ? ms / 1000 + ' s' : ms + ' ms'));
    this.rewatchTimer = setTimeout(() => {
      this.rewatchTimer = null;
      if (this._watch()) this._check({});
    }, ms);
    if (this.rewatchTimer.unref) this.rewatchTimer.unref();
  }

  // ---- reading + applying ----
  // Coalesce: at most one queued check; it runs on the same queue as writes,
  // so a check never interleaves with a publish, a seed or a recovery.
  _check(ctx) {
    if (this.closed) return Promise.resolve();
    if (this.pendingCtx) { Object.assign(this.pendingCtx, ctx); return this.pendingP; }
    this.pendingCtx = Object.assign({}, ctx);
    this.pendingP = this._serial(() => {
      const c = this.pendingCtx; this.pendingCtx = null;
      return this._checkNow(c);
    });
    return this.pendingP;
  }

  async _checkNow(ctx) {
    if (this.closed) return;
    let r = read(this.dir, this.fs);
    if (r.state === 'corrupt') {
      await sleep(this.corruptRetryMs); // a torn read mid-write: retry once
      if (this.closed) return;
      r = read(this.dir, this.fs);
    }
    if (this.closed) return;
    if (r.hash && r.hash === this.lastHash && r.state === 'ok') return; // no-op event

    if (r.state === 'missing') {
      this.lastHash = null; this.readOnly = false; // a deleted newer file no longer makes this app read-only
      if (ctx.startup && this.enabled) return this._seed('first');
      if (this.hadFile) return this._emitStatus('missing', 'Not shared yet: file was removed');
      return this._emitStatus('missing', 'Not shared yet');
    }
    if (r.state === 'error') return this._emitStatus('error', r.reason);
    if (r.state === 'newer') {
      this.readOnly = true; this.lastHash = r.hash; this.hadFile = true;
      return this._emitStatus('newer', r.reason);
    }
    this.readOnly = false;
    if (r.state === 'corrupt') {
      this.lastHash = null;
      if (!this.enabled) return this._emitStatus('corrupt', 'Shared look file is damaged: ' + r.reason);
      return this._recoverCorrupt(r.reason);
    }
    this._take(r, ctx.cause);
  }

  // A good doc arrived (from disk). Loop guard + per-field apply.
  _take(r, cause) {
    const doc = r.doc;
    this.lastHash = r.hash;
    this.hadFile = true;
    if (doc.rev < this.lastDocRev) this.applied = {}; // the file was re-seeded: shared values win again
    this.lastDocRev = doc.rev;
    this.doc = doc;

    // The desktop record is a fact about the screen: delivered even when sync is OFF.
    const d = doc.desktop;
    if (d && d.rev !== this.desktopRev) {
      this.desktopRev = d.rev;
      this.emit('desktop', this.desktop());
    }

    const skipped = r.skipped.map(s => Object.assign({}, s, {
      text: 'Ignored bad ' + s.field + ' value' + (s.by ? ' from ' + appName(s.by) : '') + ': ' + s.reason
    }));
    const own = doc.writer && doc.writer.instance === this.instance;
    if (this.enabled && (!own || cause === 'adopt')) {
      const changes = {};
      for (const f of FIELDS) {
        const e = doc.look[f];
        if (!e) continue;
        if (cause === 'adopt' || !(f in this.applied) || e.rev > this.applied[f]) {
          this.applied[f] = e.rev;
          changes[f] = clone(e.v);
        }
      }
      if (Object.keys(changes).length) {
        this.emit('apply', { changes, by: doc.writer.app || null, rev: doc.rev, cause: cause || 'remote', fromSync: true });
      }
    }
    const reason = skipped.length ? skipped.map(s => s.text).join('; ') : null;
    this._emitStatus('ok', reason, { skipped });
  }

  _baseDoc() {
    return { schema: SCHEMA, rev: Math.max(this.lastDocRev, 0), writer: {}, look: {} };
  }

  async _seed(kind, corruptNote) {
    // kind 'first': the agreed SEED (Match Windows). 'local': this app's values.
    const vals = kind === 'first' ? clone(SEED) : Object.assign(clone(SEED), validLocal(this.local()));
    const doc = this._baseDoc();
    if (this.doc && this.doc.desktop) doc.desktop = clone(this.doc.desktop);
    const rev = doc.rev + 1;
    for (const f of FIELDS) doc.look[f] = { v: vals[f], rev, by: this.app };
    const res = await this._writeDoc(doc, rev);
    if (!res.ok) return this._emitStatus('error', res.reason);
    for (const f of FIELDS) this.applied[f] = rev;
    if (kind === 'first') {
      // This app adopts the seed so all three start on the same look.
      this.emit('apply', { changes: clone(vals), by: this.app, rev, cause: 'seed', fromSync: true });
      return this._emitStatus('ok', 'Look sync started from the shared defaults (Match Windows), seeded by ' + appName(this.app));
    }
    if (corruptNote) {
      // Say the damage once (apps toast a 'corrupt' fallback), then the TRUE state: the file is healthy again,
      // written from this app's values. The reason rides on the 'ok' status until the next change.
      this._emitStatus('corrupt', corruptNote);
      return this._emitStatus('ok', corruptNote, { recovered: 'corrupt' });
    }
    return this._emitStatus('ok', 'Look sync started from ' + appName(this.app) + "'s settings");
  }

  async _recoverCorrupt(why) {
    const ts = this.now().toISOString().replace(/[:.]/g, '-');
    const bad = FILE + '.bad-' + ts;
    let moved = true;
    try { this.fs.renameSync(this.file, path.join(this.dir, bad)); } catch (e) { moved = e.code === 'ENOENT'; }
    if (!moved) return this._emitStatus('corrupt', 'Shared look file is damaged (' + why + ") and couldn't be moved aside; using this app's own look");
    return this._seed('local', 'Shared look file was damaged; restarted from ' + appName(this.app) + "'s settings (old copy: " + bad + ')');
  }

  async _writeDoc(doc, rev) {
    doc.rev = rev;
    doc.writer = { app: this.app, instance: this.instance, pid: process.pid, at: this.now().toISOString() };
    const text = JSON.stringify(doc, null, 2) + '\n';
    const res = await writeAtomic(this.dir, text, { fs: this.fs, retryDelays: this.retryDelays, app: this.app });
    if (res.ok) {
      this.doc = doc; this.lastHash = sha1(Buffer.from(text)); this.lastDocRev = rev; this.hadFile = true;
    }
    return res;
  }

  // ---- writing (serialised per instance) ----
  _serial(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // Publish one look field. Call from the app's setter only when the change did
  // NOT come from sync ({fromSync:true} never publishes). -> { ok, rev, reason }
  publish(field, value) {
    return this._serial(async () => {
      if (!FIELDS.includes(field)) return { ok: false, reason: 'unknown field ' + field };
      const bad = checkValue(field, value);
      if (bad) return { ok: false, reason: bad };
      if (!this.enabled) return { ok: false, reason: 'Sync is off' };
      return this._mutate(doc => {
        doc.look[field] = { v: clone(value), rev: doc.rev + 1, by: this.app };
      }, rev => { this.applied[field] = rev; });
    });
  }

  // Mantle only: the desktop wallpaper record. Published even while sync is OFF.
  publishDesktop(record) {
    return this._serial(async () => {
      if (this.app !== 'mantle') return { ok: false, reason: 'only Mantle publishes the desktop record' };
      const rec = Object.assign({}, clone(record), { rev: 0, by: this.app });
      const bad = checkDesktop(rec);
      if (bad) return { ok: false, reason: bad };
      return this._mutate(doc => { rec.rev = doc.rev + 1; doc.desktop = rec; },
        rev => { this.desktopRev = rev; });
    });
  }

  async _mutate(change, after) {
    // Re-read so only the one field changes.
    const r = read(this.dir, this.fs);
    let doc;
    if (r.state === 'newer') {
      this.readOnly = true;
      this._emitStatus('newer', r.reason);
      return { ok: false, reason: r.reason };
    }
    if (r.state === 'error') { this._emitStatus('error', r.reason); return { ok: false, reason: r.reason }; }
    if (r.state === 'ok') {
      doc = r.doc;
      if (doc.rev < this.lastDocRev) this.applied = {};
    } else {
      // missing (re-create from current values) or corrupt (rebuild from the last good doc + local)
      doc = this._baseDoc();
      const vals = Object.assign(clone(SEED), this.doc ? Object.fromEntries(FIELDS.filter(f => this.doc.look[f]).map(f => [f, this.doc.look[f].v])) : {}, this.enabled ? validLocal(this.local()) : {});
      const rev0 = doc.rev + 1;
      if (this.enabled) for (const f of FIELDS) doc.look[f] = { v: vals[f], rev: rev0, by: this.app };
      if (this.doc && this.doc.desktop) doc.desktop = clone(this.doc.desktop);
      doc.rev = rev0;
    }
    change(doc);
    const rev = doc.rev + 1;
    for (const f of FIELDS) if (doc.look[f] && doc.look[f].rev > doc.rev) doc.look[f].rev = rev;
    const res = await this._writeDoc(doc, rev);
    if (!res.ok) { this._emitStatus('error', res.reason); return { ok: false, rev: null, reason: res.reason, code: res.code }; }
    after(rev);
    this.readOnly = false;
    this._emitStatus('ok', null);
    return { ok: true, rev, reason: null };
  }

  // The per-app switch (section 5). Turning ON adopts the shared values (shared wins).
  setEnabled(on) {
    return this._serial(async () => {
      on = !!on;
      if (on === this.enabled) return { ok: true, changed: false };
      this.enabled = on;
      if (!on) { this._emitStatus('off', null); return { ok: true, changed: true }; }
      const r = read(this.dir, this.fs);
      if (r.state === 'missing') { await this._seed('local'); return { ok: true, changed: true }; }
      if (r.state !== 'ok') { this.lastHash = null; await this._checkNow({}); return { ok: true, changed: true }; }
      const before = validLocal(this.local());
      let applied = null;
      const grab = e => { applied = e; };
      this.once('apply', grab);
      this.lastHash = null;
      this._take(r, 'adopt');
      this.removeListener('apply', grab);
      const notes = applied ? Object.keys(applied.changes).filter(f => !(f in before) || !sameValue(before[f], applied.changes[f])).map(f => describeChange(f, applied.changes[f])) : [];
      this._emitStatus('ok', 'Now matching the others' + (notes.length ? ' (' + notes.join(', ') + ')' : ''));
      return { ok: true, changed: true };
    });
  }
}

function create(opts) { return new LookSync(opts); }

module.exports = {
  create, LookSync, read, parse, migrate, writeAtomic, checkValue, checkDesktop,
  defaultDir, SEED, SCHEMA, FILE, FIELDS, RANGES
};
