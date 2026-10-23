// Live ETA from the user's eta mod (PROTOCOL "Round 3 additions" -> Session.eta).
//
// The mod (~/.claude/mods/eta, hooks/register.tsx writeSnapshot + hooks/core.ts snapshotOf)
// writes one JSON file per Claude Code session: <etaDir>/<claudeSessionId>.json, shape
// (EtaSnapshot, types/index.d.ts):
//   { v:1, sessionId, project, cwd, label, state:'working'|'idle'|'ended', summary,
//     etaAt: ms|null, isOverdue, agentsRunning, workStartedAt: ms|null, updatedAt: ms }
// All times are epoch MILLISECONDS (the mod uses $.clock.now()); toMs() below still accepts
// seconds and ISO strings defensively. Snapshot v1 does not carry the plan's steps/step/note
// (the note is folded into `label`), but the plan type has them, so they are passed through
// when present (top level, or under a `plan` object) for a later snapshot version.
// The file is written with a plain write (no tmp+rename), so a reader can see it empty or
// half-written: readEta returns null then, and the watcher keeps its last good value.
// Owner: lane engine-plus-ext. Node built-ins only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultEtaDir() {
  return process.env.HELM_ETA_DIR || path.join(os.homedir(), '.claude', 'mods-data', 'eta');
}

// Epoch ms from ms / seconds / numeric string / ISO string; null when absent or unparseable.
function toMs(x) {
  if (x === null || x === undefined || x === '') return null;
  let n;
  if (typeof x === 'number') n = x;
  else if (typeof x === 'string') {
    const t = x.trim();
    n = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : Date.parse(t);
  } else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) n *= 1000; // seconds (1e11 s is year 5138; 1e11 ms is 1973)
  return Math.round(n);
}

const str = (x) => (typeof x === 'string' ? x : '');

// The plan's milestones: non-empty strings only (the mod filters the same way).
function mapSteps(x) {
  if (!Array.isArray(x)) return null;
  const out = x.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  return out.length ? out : null;
}

// EtaPlan.step is `number | string | null`: a number is the model's 1-BASED index into steps
// (core.ts stepText clamps it to 1..n), a string is a step LABEL. Mapped faithfully: a number
// stays a 1-based integer (clamped to 1..steps.length when steps are known), a string stays the
// label. The UI resolves either against `steps`.
function mapStep(x, steps) {
  if (typeof x === 'number' && Number.isFinite(x)) {
    let i = Math.max(1, Math.round(x));
    if (steps && steps.length) i = Math.min(i, steps.length);
    return i;
  }
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

// raw snapshot (object or JSON text) -> contract shape, or null for garbage.
function mapEta(raw) {
  let o = raw;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.v !== undefined && o.v !== 1) return null; // the mod rejects unknown versions too
  const state = typeof o.state === 'string' ? o.state.trim() : '';
  if (!state) return null;
  const updatedAt = toMs(o.updatedAt);
  if (updatedAt === null) return null;

  const plan = o.plan && typeof o.plan === 'object' ? o.plan : {};
  const steps = mapSteps(o.steps !== undefined ? o.steps : plan.steps);
  const step = mapStep(o.step !== undefined ? o.step : plan.step, steps);
  const noteRaw = o.note !== undefined ? o.note : plan.note;
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : null;
  const agents = Number(o.agentsRunning);

  const out = { state, label: str(o.label), summary: str(o.summary) };
  if (note !== null) out.note = note;
  if (step !== null) out.step = step;
  if (steps) out.steps = steps;
  out.etaAt = toMs(o.etaAt);
  out.workStartedAt = toMs(o.workStartedAt);
  out.isOverdue = o.isOverdue === true;
  out.agentsRunning = Number.isFinite(agents) && agents > 0 ? Math.floor(agents) : 0;
  // Why the finish moved out on its own ("test failed · +10m", "agent launched · +12m"); the mod adds these
  if (typeof o.reason === 'string' && o.reason.trim()) out.reason = o.reason.trim().slice(0, 80);
  const ext = Number(o.extendedBy);
  if (Number.isFinite(ext) && ext > 0) out.extendedBy = Math.round(ext);
  out.updatedAt = updatedAt;
  return out;
}

// Session ids are uuids; anything with a path separator is refused (no traversal out of etaDir).
function fileFor(claudeSessionId, etaDir) {
  const id = String(claudeSessionId || '');
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') return null;
  return path.join(etaDir || defaultEtaDir(), id + '.json');
}

// Raw read: { kind: 'ok', value } | { kind: 'missing' } | { kind: 'bad' } (empty/partial/garbage).
function readRaw(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? { kind: 'missing' } : { kind: 'bad' };
  }
  const value = mapEta(text);
  return value ? { kind: 'ok', value } : { kind: 'bad' };
}

// Mapped snapshot or null. Never throws.
function readEta(claudeSessionId, etaDir) {
  try {
    const file = fileFor(claudeSessionId, etaDir);
    if (!file) return null;
    const r = readRaw(file);
    return r.kind === 'ok' ? r.value : null;
  } catch {
    return null;
  }
}

// Watches one session's snapshot. fs.watch on the DIRECTORY (the file may not exist yet;
// events are filtered by filename) + a stat poll fallback, debounced. onChange(mapped|null)
// fires only when the mapped value changes (JSON compare). A parse failure keeps the last
// good value (the next event/poll retries); a deleted file emits null. The initial value is
// read synchronously and available from current(); it is not emitted unless emitInitial.
class EtaWatcher {
  constructor({ claudeSessionId, etaDir, onChange, pollMs = 5000, debounceMs = 150, emitInitial = false, log } = {}) {
    this.dir = etaDir || defaultEtaDir();
    this.file = fileFor(claudeSessionId, this.dir);
    this.name = this.file ? path.basename(this.file) : null;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.debounceMs = debounceMs;
    this.log = typeof log === 'function' ? log : () => {};
    this.value = null;
    this.sig = 'null';
    this.statSig = null; // mtime:size of the last GOOD read; a bad read leaves it unset so polls retry
    this.watcher = null;
    this.debounce = null;
    this.stopped = false;
    if (!this.file) return;
    this._read(emitInitial);
    this._watch();
    this.poll = setInterval(() => this._poll(), Math.max(50, pollMs));
    this.poll.unref();
  }

  current() { return this.value; }

  stop() {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    this.poll = this.debounce = null;
    this._unwatch();
  }

  _watch() {
    if (this.watcher || this.stopped) return;
    try {
      const w = fs.watch(this.dir, { persistent: false }, (_ev, filename) => {
        // filename can be null on some platforms: then check anyway.
        if (!filename || String(filename) === this.name) this._schedule();
      });
      w.on('error', (err) => {
        this.log('warn', `eta watch ${this.dir}: ${err.message}`);
        this._unwatch(); // the poll keeps going and re-arms the watch
      });
      this.watcher = w;
    } catch {
      // dir missing (mod never ran yet): the poll re-tries the watch
    }
  }

  _unwatch() {
    if (!this.watcher) return;
    try { this.watcher.close(); } catch { /* already closed */ }
    this.watcher = null;
  }

  _schedule() {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; this._read(true); }, this.debounceMs);
    this.debounce.unref();
  }

  _poll() {
    if (this.stopped) return;
    try {
      if (!this.watcher) this._watch();
      let st = null;
      try { st = fs.statSync(this.file); } catch { /* missing */ }
      const sig = st ? `${st.mtimeMs}:${st.size}` : null;
      if (sig === null ? this.value !== null : sig !== this.statSig) this._schedule();
    } catch (err) {
      this.log('warn', `eta poll: ${err.message}`);
    }
  }

  _read(emit) {
    if (this.stopped && emit) return;
    try {
      let st = null;
      try { st = fs.statSync(this.file); } catch { /* missing */ }
      const r = st ? readRaw(this.file) : { kind: 'missing' };
      if (r.kind === 'bad') { this.statSig = null; return; } // keep last good; retry later
      const next = r.kind === 'ok' ? r.value : null;
      this.statSig = st && r.kind === 'ok' ? `${st.mtimeMs}:${st.size}` : null;
      const sig = JSON.stringify(next);
      if (sig === this.sig) return;
      this.value = next;
      this.sig = sig;
      if (emit) {
        try { this.onChange(next); } catch (err) { this.log('warn', `eta onChange: ${err.message}`); }
      }
    } catch (err) {
      this.log('warn', `eta read: ${err.message}`);
    }
  }
}

function watchEta(opts) {
  const w = new EtaWatcher(opts);
  return { stop: () => w.stop(), current: () => w.current() };
}

module.exports = { defaultEtaDir, mapEta, readEta, EtaWatcher, watchEta, _internal: { toMs, fileFor } };
