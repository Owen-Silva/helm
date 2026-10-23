'use strict';
// Active hours (PROTOCOL "activity.*"): how many hours Claude was actually working on this PC,
// read from every Claude Code transcript under ~/.claude/projects (Helm sessions, terminal
// sessions and every subagent), READ-ONLY.
//
// Sources: <projectsDir>/<slug>/<sessionId>.jsonl (a "main" stream) and
//          <projectsDir>/<slug>/<sessionId>/subagents/agent-<hex>.jsonl (one stream per agent).
//
// Counting rule ("active" = Claude is working, not waiting on the user). Per stream (one file):
//   - A turn starts at a real prompt: a `user` line that is not a tool_result, not isMeta, not a
//     compact summary and not "[Request interrupted…"; also `system/scheduled_task_fire` (a /loop
//     or cron fire, whose prompt line is isMeta). Background-agent notifications arrive as plain
//     user lines and count as prompts too (Claude works on them).
//   - The turn is active through each following work event: assistant lines, tool_result lines,
//     compact summaries, `system/compact_boundary|api_error`, and the turn's tail
//     (`system/stop_hook_summary`, `system/turn_duration`). The time between consecutive events
//     counts, but any single gap is capped at 10 minutes (Claude Code's Bash timeout max): a
//     longer silence is a permission prompt or a stall, not work. The capped 10 minutes are
//     placed right after the earlier event.
//   - A gap during which every unanswered tool call is a wait does not count for that stream:
//     Agent/Task calls (the agent's own transcript counts that time; otherwise agent-hours would
//     count a parent waiting on its agents twice) and AskUserQuestion/ExitPlanMode (Claude is
//     waiting on the user's answer: 16 such gaps, 1.3 h, in a week of the user's transcripts).
//   - The turn ends at its final assistant message (stop_reason end_turn) plus the tail lines
//     right after it, or at an interrupt line. Time between turns never counts. A work event
//     after a finished turn without a new prompt starts a fresh interval at that event.
//   - Time is measured between event timestamps only: a turn still running counts up to its
//     latest event (never up to "now"). Lines of other kinds (attachments, queue operations,
//     titles, snapshots, local command output) are ignored.
// Totals: active time = union of every stream's intervals (wall clock with at least one Claude
// working); agent-hours = sum over streams (parallel work counts several times). Days are LOCAL
// days; an interval across midnight is split.
//
// Cost: ~4.3 GB across ~1,380 files fall in a 30-day window on the user's PC, so (1) only files whose
// mtime is inside the window are read; (2) lines are SKIMMED as bytes, not JSON.parse'd: the
// top-level keys are walked, string values are jumped over with Buffer.indexOf, and a line stops
// being read once its type, timestamp and message are known (big tool results are never decoded);
// (3) a per-file cache in <userData>/activity-cache.json (path -> size, mtime, byte offset, a
// hash of the 64 bytes before that offset, stream state, intervals; timestamps, offsets, tool ids
// and the project folder only, never prompt text) means a rescan parses only appended bytes;
// (4) the scan runs in a worker thread (main/activity-worker.js) so Electron's main process never
// blocks; rescans happen at most once a minute.
//
// All time (lane alltime): every scan has two phases. Phase 1 reads the files in the 30-day window
// and hands back the 14-day view at once (onWindow); phase 2 then brings every OLDER transcript's
// cache entry up to date (all ~3,500 files, ~7.8 GB on the user's PC; cold once, then only stats),
// reporting { done, total } as it goes, and aggregates all time: union / sum over every file,
// split into local months and projects. Cache entries keep their full interval list (never pruned
// to the window: all time needs them, and intervals, not day buckets, are what make the union
// exact) and are only dropped when the file is gone. Phase 2 reads two files at a time and saves
// the cache every 30 s, so a cold all-time scan neither hogs the disk nor starts over if Helm quits.
// Owner: lane activity. Node built-ins only.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Bump when the counting rule OR the cache shape changes (2 = intervals no longer pruned to the
// window, for all time): an old cache is dropped and everything is read again once.
const RULE_VERSION = 2;
const DEFAULTS = {
  capMs: 10 * 60 * 1000,     // longest single gap that still counts as work
  windowDays: 30,            // phase 1 (the 14-day view) reads files last written in this many local days
  minRescanMs: 60 * 1000,    // activity.summary rescans at most this often
  liveMs: 10 * 60 * 1000,    // an open turn whose latest event is older than this is not "working now"
  concurrency: 4,
  chunkBytes: 1 << 20,
  allTime: true,             // phase 2: every older transcript too
  allTimeConcurrency: 2,     // phase 2 reads this many files at once (it's background work)
  saveEveryMs: 30 * 1000,    // phase 2 saves the cache this often (a quit mid-scan keeps the progress)
  progressMs: 250,           // phase 2 reports { done, total } at most this often
  maxMonths: 120,            // all-time months shown at most (a bogus old timestamp can't make 600 bars)
};

// ---------- byte skimmer (one JSON line in a Buffer) ----------

const Q = 0x22, BSL = 0x5c, LB = 0x7b, RB = 0x7d, LS = 0x5b, RS = 0x5d, COLON = 0x3a, COMMA = 0x2c;
const STOP = -2; // a key callback's "stop reading this line"

function ws(b, i) {
  const n = b.length;
  while (i < n) { const c = b[i]; if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) i++; else break; }
  return i;
}

// b[i] is an opening quote -> index of the closing quote, or -1.
function strEnd(b, i) {
  let j = i + 1;
  for (;;) {
    const q = b.indexOf(Q, j);
    if (q < 0) return -1;
    let k = q - 1;
    while (b[k] === BSL) k--;
    if (((q - 1 - k) & 1) === 0) return q;
    j = q + 1;
  }
}

// Index just past the JSON value starting at b[i], or -1 when malformed/truncated.
function valueEnd(b, i) {
  const c = b[i];
  if (c === Q) { const e = strEnd(b, i); return e < 0 ? -1 : e + 1; }
  if (c === LB || c === LS) {
    let depth = 0;
    const n = b.length;
    for (let j = i; j < n; j++) {
      const d = b[j];
      if (d === Q) { const e = strEnd(b, j); if (e < 0) return -1; j = e; }
      else if (d === LB || d === LS) depth++;
      else if (d === RB || d === RS) { if (--depth === 0) return j + 1; }
    }
    return -1;
  }
  const n = b.length;
  let j = i;
  while (j < n) { const d = b[j]; if (d === COMMA || d === RB || d === RS || d <= 0x20) break; j++; }
  return j === i ? -1 : j;
}

// Walk an object's keys: fn(keyStart, keyEnd, valueStart) returns undefined (skip the value),
// the index past the value (consumed it), or STOP. -> index past the object, STOP, or -1.
function eachKey(b, i, fn) {
  let j = ws(b, i + 1);
  if (b[j] === RB) return j + 1;
  for (;;) {
    if (b[j] !== Q) return -1;
    const ke = strEnd(b, j);
    if (ke < 0) return -1;
    let v = ws(b, ke + 1);
    if (b[v] !== COLON) return -1;
    v = ws(b, v + 1);
    let end = fn(j + 1, ke, v);
    if (end === STOP) return STOP;
    if (end === undefined) end = valueEnd(b, v);
    if (end < 0) return -1;
    j = ws(b, end);
    if (b[j] === COMMA) { j = ws(b, j + 1); continue; }
    if (b[j] === RB) return j + 1;
    return -1;
  }
}

const KEY = {};
for (const k of ['type', 'subtype', 'timestamp', 'isMeta', 'isCompactSummary', 'isSidechain', 'cwd', 'message',
  'content', 'stop_reason', 'id', 'name', 'tool_use_id', 'text']) KEY[k] = Buffer.from(k);

function eq(b, s, e, k) {
  if (e - s !== k.length) return false;
  for (let i = 0; i < k.length; i++) if (b[s + i] !== k[i]) return false;
  return true;
}

// A short ASCII string value (type, subtype, timestamp, ids), or null for anything else.
function ascii(b, v, max = 128) {
  if (b[v] !== Q) return null;
  const e = strEnd(b, v);
  if (e < 0 || e - v - 1 > max) return null;
  return b.toString('latin1', v + 1, e);
}

// The first bytes of a string value (enough to recognise "[Request interrupted").
function head(b, v) {
  if (b[v] !== Q) return null;
  return b.toString('latin1', v + 1, Math.min(b.length, v + 1 + 24));
}

const TRUE = Buffer.from('true');
function isTrue(b, v) { return eq(b, v, v + 4, TRUE); }

// Pending tool kinds: 0 = work (Bash, Edit, ...), 1 = waiting on a subagent, 2 = waiting on the user.
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const USER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
function toolKind(name) { return AGENT_TOOLS.has(name) ? 1 : USER_TOOLS.has(name) ? 2 : 0; }

function skimBlocks(b, i, r) {
  let j = ws(b, i + 1);
  if (b[j] === RS) return j + 1;
  for (;;) {
    let end;
    if (b[j] === LB) {
      let type = null, id = null, name = null, tuid = null, txt = null;
      end = eachKey(b, j, (ks, ke, v) => {
        if (eq(b, ks, ke, KEY.type)) type = ascii(b, v);
        else if (eq(b, ks, ke, KEY.id)) id = ascii(b, v);
        else if (eq(b, ks, ke, KEY.name)) name = ascii(b, v);
        else if (eq(b, ks, ke, KEY.tool_use_id)) tuid = ascii(b, v);
        else if (eq(b, ks, ke, KEY.text)) txt = head(b, v);
        return undefined;
      });
      if (type === 'tool_result') (r.results || (r.results = [])).push(tuid || '');
      else if (type === 'tool_use' && id) (r.uses || (r.uses = [])).push([id, toolKind(name)]);
      else if (type === 'text' && r.textHead === null && txt !== null) r.textHead = txt;
    } else end = valueEnd(b, j);
    if (end < 0) return -1;
    j = ws(b, end);
    if (b[j] === COMMA) { j = ws(b, j + 1); continue; }
    if (b[j] === RS) return j + 1;
    return -1;
  }
}

function skimMessage(b, i, r) {
  r.msg = true;
  return eachKey(b, i, (ks, ke, v) => {
    if (eq(b, ks, ke, KEY.stop_reason)) { r.stop = ascii(b, v); return undefined; }
    if (eq(b, ks, ke, KEY.content)) {
      if (b[v] === Q) { r.textHead = head(b, v); return undefined; }
      if (b[v] === LS) return skimBlocks(b, v, r);
    }
    return undefined;
  });
}

const RELEVANT = new Set(['user', 'assistant', 'system']);

/**
 * One transcript line (Buffer, no newline) -> the fields the counting rule needs, or null when
 * the line is malformed or not a user/assistant/system line. needCwd: also read `cwd`.
 */
function skimLine(b, needCwd) {
  const i = ws(b, 0);
  if (b[i] !== LB) return null;
  const r = { type: null, subtype: null, ts: null, meta: false, compact: false, side: false, cwd: null, msg: false, stop: null, textHead: null, results: null, uses: null };
  const done = () => {
    if (needCwd && r.cwd === null) return false;
    if (r.type === null || r.ts === null) return false;
    if (r.type === 'system') return r.subtype !== null;
    if (r.type === 'assistant') return r.msg;
    return r.msg && r.results !== null; // user: a prompt line is read to the end (isMeta may come late)
  };
  const end = eachKey(b, i, (ks, ke, v) => {
    if (eq(b, ks, ke, KEY.type)) {
      r.type = ascii(b, v);
      if (!RELEVANT.has(r.type)) return STOP;
    } else if (eq(b, ks, ke, KEY.timestamp)) r.ts = ascii(b, v, 40);
    else if (eq(b, ks, ke, KEY.subtype)) r.subtype = ascii(b, v);
    else if (eq(b, ks, ke, KEY.isMeta)) r.meta = isTrue(b, v);
    else if (eq(b, ks, ke, KEY.isCompactSummary)) r.compact = isTrue(b, v);
    else if (eq(b, ks, ke, KEY.isSidechain)) r.side = isTrue(b, v);
    else if (needCwd && eq(b, ks, ke, KEY.cwd) && b[v] === Q) {
      const e = strEnd(b, v);
      if (e > 0) { try { r.cwd = JSON.parse(b.toString('utf8', v, e + 1)); } catch { /* keep null */ } return e + 1; }
    } else if (eq(b, ks, ke, KEY.message) && b[v] === LB) {
      const e = skimMessage(b, v, r);
      if (e < 0) return -1;
      return done() ? STOP : e;
    } else return undefined;
    return done() ? STOP : undefined;
  });
  if (r.type === null || !RELEVANT.has(r.type)) return null;
  if (end === -1 && !done()) return null; // malformed before we had what we need
  return r;
}

// ---------- events + per-stream state machine ----------

const PROMPT = 1, WORK = 2, TAIL = 3, END = 4;
const NONE = 0, OPEN = 1, SOFT = 2, CLOSED = 3; // SOFT = final assistant message seen, tail may follow

/** skimLine result -> { k, t, ... } or null (ignored line). */
function classify(r, isSub) {
  if (!r || !r.ts) return null;
  const t = Date.parse(r.ts);
  if (!Number.isFinite(t)) return null;
  if (r.side && !isSub) return null; // pre-2025 inline sidechains: not on this PC's 30-day window
  if (r.type === 'assistant') return { k: WORK, t, endTurn: r.stop === 'end_turn', uses: r.uses, results: null, asst: true };
  if (r.type === 'user') {
    if (r.results) return { k: WORK, t, results: r.results, uses: null };
    if (r.compact) return { k: WORK, t, results: null, uses: null };
    if (r.meta || !r.msg) return null;
    if (r.textHead && r.textHead.startsWith('[Request interrupted')) return { k: END, t };
    return { k: PROMPT, t };
  }
  if (r.type === 'system') {
    switch (r.subtype) {
      case 'turn_duration': return { k: TAIL, t, close: true };
      case 'stop_hook_summary': return { k: TAIL, t, close: false };
      case 'compact_boundary': case 'api_error': return { k: WORK, t, results: null, uses: null };
      case 'scheduled_task_fire': return { k: PROMPT, t };
      default: return null;
    }
  }
  return null;
}

// Every unanswered tool call is a wait (subagent or the user), so this stream is not working.
function waitingOnly(pend) {
  let any = false;
  for (const k in pend) { if (!pend[k]) return false; any = true; }
  return any;
}

// Append [s, e] to a flat interval list, merging with the previous one when they touch.
function pushIv(iv, s, e) {
  if (!(e > s)) return;
  const n = iv.length;
  if (n && s <= iv[n - 1]) { if (e > iv[n - 1]) iv[n - 1] = e; return; }
  iv.push(s, e);
}

class Stream {
  constructor(o) {
    this.s = (o && o.s) || NONE;
    this.last = o && Number.isFinite(o.last) ? o.last : null;
    this.cs = o && Number.isFinite(o.cs) ? o.cs : null; // start of the interval still growing
    this.pend = (o && o.pend && typeof o.pend === 'object') ? { ...o.pend } : {};
    this.iv = (o && Array.isArray(o.iv)) ? o.iv.slice() : [];
  }
  toJSON() { return { s: this.s, last: this.last, cs: this.cs, pend: this.pend, iv: this.iv }; }
  flush() {
    if (this.cs !== null && this.last !== null) pushIv(this.iv, this.cs, this.last);
    this.cs = null;
  }
  open(t) {
    this.flush();
    const start = this.last !== null ? Math.max(t, this.last) : t;
    this.cs = start;
    this.last = start;
    this.s = OPEN;
  }
  advance(t, capMs) {
    if (this.last === null || this.cs === null) { this.open(t); return; }
    if (t <= this.last) return;
    if (waitingOnly(this.pend)) { this.flush(); this.cs = t; }
    else if (t - this.last > capMs) { pushIv(this.iv, this.cs, this.last + capMs); this.cs = t; }
    this.last = t;
  }
  event(e, capMs) {
    switch (e.k) {
      case PROMPT: this.pend = {}; this.open(e.t); break;
      case END: this.pend = {}; this.s = CLOSED; break;
      case WORK:
        if (this.s === OPEN || (this.s === SOFT && e.asst && e.endTurn)) this.advance(e.t, capMs);
        else this.open(e.t);
        if (e.results) for (const id of e.results) delete this.pend[id];
        if (e.uses) for (const [id, kind] of e.uses) this.pend[id] = kind;
        if (Object.keys(this.pend).length > 256) this.pend = {}; // a malformed file never answers: forget
        if (e.endTurn) this.s = SOFT;
        break;
      case TAIL:
        if (this.s === OPEN || this.s === SOFT) {
          this.advance(e.t, capMs);
          if (e.close) { this.s = CLOSED; this.pend = {}; }
        }
        break;
      default: break;
    }
  }
  // Every interval, the growing one included (a turn in progress counts up to its latest event).
  intervals() {
    const out = this.iv.slice();
    if (this.cs !== null && this.last !== null) pushIv(out, this.cs, this.last);
    return out;
  }
  prune(before) {
    let k = 0;
    while (k < this.iv.length && this.iv[k + 1] < before) k += 2;
    if (k) this.iv = this.iv.slice(k);
  }
  working(now, liveMs) {
    return this.s === OPEN && this.last !== null && now - this.last <= liveMs && !waitingOnly(this.pend);
  }
}

// ---------- files ----------

const SUB_SEG = `${path.sep}subagents${path.sep}`;

function isSubagentFile(file) { return file.includes(SUB_SEG) || file.includes('/subagents/'); }

async function listTranscripts(dir) {
  const out = [];
  let slugs;
  try { slugs = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return { files: out, missing: true };
    throw e;
  }
  await pool(slugs.filter((d) => d.isDirectory()), 8, async (d) => {
    const sdir = path.join(dir, d.name);
    let ents;
    try { ents = await fsp.readdir(sdir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(sdir, e.name), slug: d.name });
      else if (e.isDirectory()) {
        const sub = path.join(sdir, e.name, 'subagents');
        let names;
        try { names = await fsp.readdir(sub); } catch { continue; }
        for (const n of names) if (n.endsWith('.jsonl')) out.push({ file: path.join(sub, n), slug: d.name });
      }
    }
  });
  return { files: out, missing: false };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const HASH_BYTES = 64;
async function hashBefore(fh, off) {
  const n = Math.min(HASH_BYTES, off);
  if (!n) return '';
  const b = Buffer.alloc(n);
  const { bytesRead } = await fh.read(b, 0, n, off - n);
  return crypto.createHash('sha1').update(b.subarray(0, bytesRead)).digest('hex').slice(0, 16);
}

/**
 * Bring one file's cache entry up to date. Reads only bytes after the cached offset when the
 * file grew and the 64 bytes before that offset are unchanged; otherwise re-reads it whole.
 * Only complete lines are parsed (a trailing partial line waits for its newline).
 * -> { entry, bytes } (bytes = how many were read)
 */
async function scanFile(file, st, prev, opts) {
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return { entry: prev, bytes: 0 };
  const isSub = isSubagentFile(file);
  const fh = await fsp.open(file, 'r');
  try {
    let from = 0;
    let entry = null;
    if (prev && st.size >= prev.off && prev.off > 0 && (await hashBefore(fh, prev.off)) === prev.h) {
      from = prev.off;
      entry = { ...prev, st: new Stream(prev.st) };
    } else {
      entry = { size: 0, mtimeMs: 0, off: 0, h: '', cwd: null, st: new Stream(null) };
    }
    const stream = entry.st;
    let needCwd = !entry.cwd;
    let buf = Buffer.allocUnsafe(opts.chunkBytes);
    let have = 0;
    let pos = from;
    let off = from;
    while (pos < st.size) {
      if (have === buf.length) { const nb = Buffer.allocUnsafe(buf.length * 2); buf.copy(nb, 0, 0, have); buf = nb; }
      const { bytesRead } = await fh.read(buf, have, Math.min(buf.length - have, st.size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const n = have + bytesRead;
      const view = buf.subarray(0, n);
      let ls = 0;
      for (;;) {
        const nl = view.indexOf(0x0a, ls);
        if (nl < 0) break;
        if (nl > ls) {
          const r = skimLine(view.subarray(ls, nl), needCwd);
          if (r) {
            if (needCwd && r.cwd) { entry.cwd = r.cwd; needCwd = false; }
            const e = classify(r, isSub);
            if (e) stream.event(e, opts.capMs);
          }
        }
        ls = nl + 1;
      }
      off += ls;
      if (ls < n) buf.copy(buf, 0, ls, n);
      have = n - ls;
    }
    entry.off = off;
    entry.h = await hashBefore(fh, off);
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    return { entry, bytes: pos - from };
  } finally {
    await fh.close();
  }
}

// ---------- days + projects ----------

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Local-midnight boundaries for the last `n` days (oldest first) + the end of today.
function dayBounds(now, n) {
  const d = new Date(now);
  const starts = [];
  for (let k = n - 1; k >= 0; k--) starts.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - k).getTime());
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { starts, end, keys: starts.map(localDayKey) };
}

function localMonthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Local month boundaries from the month holding `from` through the month holding `now` (oldest
// first, at most maxMonths: the newest ones) + the start of next month. Same shape as dayBounds,
// so addToDays splits intervals into months too.
function monthBounds(from, now, maxMonths = DEFAULTS.maxMonths) {
  const a = new Date(Math.min(from, now));
  const b = new Date(now);
  let y = a.getFullYear(), m = a.getMonth();
  const span = (b.getFullYear() - y) * 12 + (b.getMonth() - m) + 1;
  if (span > maxMonths) { const skip = span - maxMonths; y += Math.floor((m + skip) / 12); m = (m + skip) % 12; }
  const starts = [];
  for (;;) {
    const t = new Date(y, m, 1).getTime();
    starts.push(t);
    if (y === b.getFullYear() && m === b.getMonth()) break;
    if (++m === 12) { m = 0; y++; }
  }
  const end = new Date(b.getFullYear(), b.getMonth() + 1, 1).getTime();
  return { starts, end, keys: starts.map(localMonthKey) };
}

// Sorted, merged union of flat interval lists.
function union(lists) {
  const pairs = [];
  for (const iv of lists) for (let i = 0; i < iv.length; i += 2) pairs.push([iv[i], iv[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of pairs) pushIv(out, s, e);
  return out;
}

// Add each interval's length to the local days it overlaps (bounds from dayBounds).
function addToDays(iv, bounds, acc) {
  const { starts, end } = bounds;
  for (let i = 0; i < iv.length; i += 2) {
    let s = Math.max(iv[i], starts[0]);
    const e = Math.min(iv[i + 1], end);
    if (!(e > s)) continue;
    let d = upperBound(starts, s) - 1;
    while (s < e && d < starts.length) {
      const dEnd = d + 1 < starts.length ? starts[d + 1] : end;
      const piece = Math.min(e, dEnd) - s;
      if (piece > 0) acc[d] += piece;
      s = dEnd;
      d++;
    }
  }
  return acc;
}

function upperBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

function isTempCwd(cwd, tempDir) {
  if (!cwd || !tempDir) return false;
  const norm = (p) => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const c = norm(cwd);
  const t = norm(tempDir);
  return c === t || c.startsWith(t + path.sep);
}

// Project key + label for a file: its cwd (last folder name, like History), temp folders grouped,
// the projects-folder slug when no line carried a cwd.
function projectOf(entry, slug, tempDir) {
  const cwd = entry.cwd;
  if (cwd && isTempCwd(cwd, tempDir)) return { key: 'temp', project: 'Temp folders', cwd: tempDir };
  if (cwd) {
    const segs = cwd.split(/[\\/]+/).filter(Boolean);
    const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    return { key, project: segs.length ? segs[segs.length - 1] : cwd, cwd };
  }
  return { key: 'slug:' + slug, project: slug, cwd: null };
}

// ---------- full scan ----------

// Bring every file in `list` up to date in the cache (list items: { file, slug, st }; sets f.entry).
async function scanFiles(list, cache, n, opts, tally, onEach) {
  await pool(list, n, async (f) => {
    const prev = cache.files[f.file] || null;
    try {
      const { entry, bytes } = await scanFile(f.file, { size: f.st.size, mtimeMs: f.st.mtimeMs }, prev, opts);
      if (bytes || entry !== prev) {
        tally.filesRead++;
        tally.bytesRead += bytes;
        cache.files[f.file] = entry;
        tally.changed = true;
      }
      f.entry = cache.files[f.file];
    } catch (e) {
      if (tally.errors.length < 5) tally.errors.push(`${path.basename(f.file)}: ${e.message}`);
      f.entry = prev;
    }
    if (onEach) await onEach();
  });
}

// Intervals of each file (+ its project group) -> [all lists], Map(key -> { project, cwd, lists }).
function gather(list, tempDir, from = -Infinity) {
  const all = [];
  const byKey = new Map();
  for (const f of list) {
    const entry = f.entry;
    if (!entry) continue;
    const st = entry.st instanceof Stream ? entry.st : new Stream(entry.st);
    const iv = st.intervals();
    if (!iv.length || iv[iv.length - 1] < from) continue;
    all.push(iv);
    const p = projectOf(entry, f.slug, tempDir);
    let g = byKey.get(p.key);
    if (!g) { g = { key: p.key, project: p.project, cwd: p.cwd, lists: [] }; byKey.set(p.key, g); }
    g.lists.push(iv);
  }
  return { all, byKey };
}

function ivTotal(iv, from = -Infinity, to = Infinity) {
  let t = 0;
  for (let i = 0; i < iv.length; i += 2) { const s = Math.max(iv[i], from), e = Math.min(iv[i + 1], to); if (e > s) t += e - s; }
  return t;
}

/**
 * All-time totals over every file's cached intervals (time after the end of this month is
 * dropped, like the day view drops time after today).
 * -> { activeMs, agentMs, since ("YYYY-MM-DD" of the first counted moment, or null),
 *      byMonth: [{ month: "YYYY-MM", activeMs, agentMs }] (oldest first, zero months included),
 *      byProject: [{ project, cwd, activeMs, agentMs }] (by activeMs desc) }
 */
function aggregateAllTime(list, now, tempDir, opts = DEFAULTS) {
  const { all, byKey } = gather(list, tempDir);
  const u = union(all);
  if (!u.length) return { activeMs: 0, agentMs: 0, since: null, byMonth: [], byProject: [] };
  const mb = monthBounds(u[0], now, opts.maxMonths || DEFAULTS.maxMonths);
  const from = mb.starts[0], to = mb.end;
  const n = mb.starts.length;
  const active = addToDays(u, mb, new Array(n).fill(0));
  const agent = new Array(n).fill(0);
  for (const iv of all) addToDays(iv, mb, agent);
  const byProject = [];
  for (const g of byKey.values()) {
    let agentMs = 0;
    for (const iv of g.lists) agentMs += ivTotal(iv, from, to);
    if (agentMs > 0) byProject.push({ project: g.project, cwd: g.cwd, activeMs: Math.round(ivTotal(union(g.lists), from, to)), agentMs: Math.round(agentMs) });
  }
  byProject.sort((a, b) => b.activeMs - a.activeMs || b.agentMs - a.agentMs);
  let first = null;
  for (let i = 0; i < u.length; i += 2) if (u[i + 1] > from) { first = Math.max(u[i], from); break; }
  const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0));
  return {
    activeMs: sum(active),
    agentMs: sum(agent),
    since: first === null ? null : localDayKey(first),
    byMonth: mb.keys.map((month, i) => ({ month, activeMs: Math.round(active[i]), agentMs: Math.round(agent[i]) })),
    byProject,
  };
}

/**
 * Scan the transcripts, updating the cache in place.
 *   Phase 1: files written in the window -> `result` (handed to onWindow as soon as it's ready).
 *   Phase 2 (opts.allTime): every older file too -> `allTime` (onProgress(done, total) meanwhile,
 *   onCheckpoint(cache) every opts.saveEveryMs and once after phase 1).
 * -> { result, allTime, cache, changed }
 *   result: { keys, starts, active[], agent[], projects: [{ key, project, cwd, active[], agent[] }],
 *             workingNow, files, filesRead, bytesRead, scanMs, scannedAt, missing, errors }
 *   allTime: aggregateAllTime(...) + { files, filesRead, bytesRead, scanMs, scannedAt } or null
 */
async function scanAll({ projectsDir, cache, now = Date.now(), tempDir = os.tmpdir(), opts: o = {}, onWindow, onProgress, onCheckpoint }) {
  const opts = { ...DEFAULTS, ...o };
  const t0 = Date.now();
  const bounds = dayBounds(now, opts.windowDays);
  const windowStart = bounds.starts[0];
  if (!cache || cache.v !== RULE_VERSION || cache.capMs !== opts.capMs) cache = { v: RULE_VERSION, capMs: opts.capMs, files: {} };
  const { files, missing } = await listTranscripts(projectsDir);
  const listed = new Set();
  const inWindow = [];
  const older = [];
  await pool(files, 16, async (f) => {
    let st;
    try { st = await fsp.stat(f.file); } catch { return; }
    listed.add(f.file);
    (st.mtimeMs < windowStart ? older : inWindow).push({ ...f, st });
  });
  // A file that is gone from disk leaves the cache (only when the folder could be listed at all).
  let dropped = false;
  if (!missing) for (const k of Object.keys(cache.files)) if (!listed.has(k)) { delete cache.files[k]; dropped = true; }

  // ---- phase 1: the window ----
  const w = { filesRead: 0, bytesRead: 0, changed: dropped, errors: [] };
  await scanFiles(inWindow, cache, opts.concurrency, opts, w);

  // Per-day totals + per-project per-day totals.
  const n = bounds.starts.length;
  let workingNow = 0;
  for (const f of inWindow) {
    if (!f.entry) continue;
    const st = f.entry.st instanceof Stream ? f.entry.st : new Stream(f.entry.st);
    if (st.working(now, opts.liveMs)) workingNow++;
  }
  const { all, byKey } = gather(inWindow, tempDir, windowStart);
  const active = addToDays(union(all), bounds, new Array(n).fill(0));
  const agent = new Array(n).fill(0);
  for (const iv of all) addToDays(iv, bounds, agent);
  const projects = [];
  for (const g of byKey.values()) {
    const pa = addToDays(union(g.lists), bounds, new Array(n).fill(0));
    const pg = new Array(n).fill(0);
    for (const iv of g.lists) addToDays(iv, bounds, pg);
    if (pg.some((x) => x > 0)) projects.push({ key: g.key, project: g.project, cwd: g.cwd, active: pa, agent: pg });
  }
  const result = {
    keys: bounds.keys, starts: bounds.starts, active, agent, projects, workingNow,
    files: inWindow.length, filesRead: w.filesRead, bytesRead: w.bytesRead, scanMs: Date.now() - t0, scannedAt: now, missing, errors: w.errors,
    capMs: opts.capMs, windowDays: opts.windowDays,
  };
  if (onWindow) await onWindow(result);
  if (!opts.allTime) return { result, allTime: null, cache, changed: w.changed };

  // ---- phase 2: everything older (background work: fewer files at once, progress, checkpoints) ----
  let dirty = w.changed; // cache changes not saved yet
  if (onCheckpoint && dirty) { await onCheckpoint(cache); dirty = false; }
  const total = inWindow.length + older.length;
  const a = { filesRead: 0, bytesRead: 0, changed: false, errors: [] };
  let done = inWindow.length;
  let lastProgress = Date.now();
  let lastSave = Date.now();
  if (onProgress) onProgress(done, total);
  await scanFiles(older, cache, opts.allTimeConcurrency, opts, a, async () => {
    done++;
    if (a.changed) { dirty = true; a.changed = false; }
    const t = Date.now();
    if (onProgress && t - lastProgress >= opts.progressMs) { lastProgress = t; onProgress(done, total); }
    if (onCheckpoint && dirty && t - lastSave >= opts.saveEveryMs) { lastSave = t; dirty = false; await onCheckpoint(cache); }
  });
  if (onProgress) onProgress(total, total);
  const allTime = {
    ...aggregateAllTime(inWindow.concat(older), now, tempDir, opts),
    files: total, filesRead: w.filesRead + a.filesRead, bytesRead: w.bytesRead + a.bytesRead,
    scanMs: Date.now() - t0, scannedAt: now,
    ...(a.errors.length ? { errors: a.errors } : {}),
  };
  return { result, allTime, cache, changed: dirty };
}

function serializeCache(cache) {
  const files = {};
  for (const [k, e] of Object.entries(cache.files)) {
    files[k] = { size: e.size, mtimeMs: e.mtimeMs, off: e.off, h: e.h, cwd: e.cwd, st: e.st instanceof Stream ? e.st.toJSON() : e.st };
  }
  return JSON.stringify({ v: cache.v, capMs: cache.capMs, files });
}

function loadCache(cachePath) {
  if (!cachePath) return null;
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!c || c.v !== RULE_VERSION || !c.files || typeof c.files !== 'object') return null;
    return c;
  } catch { return null; }
}

// Scan + persist the cache (used inline and by the worker). Callbacks as scanAll; the cache is
// saved after phase 1 when it changed, every opts.saveEveryMs in phase 2, and at the end.
async function runScan({ projectsDir, cachePath, now, tempDir, opts, cache: mem, onWindow, onProgress }) {
  const cache = mem || loadCache(cachePath);
  const saveErrors = [];
  const save = (c) => {
    if (!cachePath) return;
    try { require('./atomic').writeFileAtomic(cachePath, serializeCache(c)); } catch (e) { if (saveErrors.length < 1) saveErrors.push(`cache not saved: ${e.message}`); }
  };
  const out = await scanAll({ projectsDir, cache, now, tempDir, opts, onWindow, onProgress, onCheckpoint: cachePath ? save : null });
  if (cachePath && out.changed) save(out.cache);
  if (saveErrors.length) out.result.errors.push(...saveErrors);
  return out;
}

// ---------- summary (host side) ----------

function sumRange(arr, from, to) { let s = 0; for (let i = from; i < to; i++) s += arr[i]; return s; }

/** Raw scan result -> the activity.summary shape for the last `days` local days. */
function summarize(r, days, extra = {}) {
  const n = r.keys.length;
  const d = Math.max(1, Math.min(days, n));
  const from = n - d;
  const out = [];
  for (let i = from; i < n; i++) out.push({ date: r.keys[i], activeMs: Math.round(r.active[i]), agentMs: Math.round(r.agent[i]) });
  const wFrom = Math.max(0, n - 7);
  const byProject = r.projects
    .map((p) => ({ project: p.project, cwd: p.cwd, activeMs: Math.round(sumRange(p.active, from, n)), agentMs: Math.round(sumRange(p.agent, from, n)) }))
    .filter((p) => p.agentMs > 0)
    .sort((a, b) => b.activeMs - a.activeMs || b.agentMs - a.agentMs);
  return {
    days: out,
    today: { activeMs: Math.round(r.active[n - 1]), agentMs: Math.round(r.agent[n - 1]) },
    week: { activeMs: Math.round(sumRange(r.active, wFrom, n)), agentMs: Math.round(sumRange(r.agent, wFrom, n)) },
    byProject,
    live: { workingNow: r.workingNow },
    scannedAt: r.scannedAt,
    scanMs: r.scanMs,
    files: r.files,
    filesRead: r.filesRead,
    capMs: r.capMs,
    windowDays: r.windowDays,
    ...(r.missing ? { missing: true } : {}),
    ...(r.errors && r.errors.length ? { warnings: r.errors.slice(0, 5) } : {}),
    ...extra,
  };
}

function rpcError(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * createActivity({ profileDir, projectsDir, log, useWorker, now, opts })
 *   profileDir: where activity-cache.json lives (null = memory only)
 * -> { summary(params), allTimeState(), whenIdle(), methods }
 *
 * One scan at a time (a worker run = phase 1 + phase 2). summary() waits for phase 1 only;
 * phase 2 (all time) finishes in the background and the next summary({ allTime: true }) picks it up.
 */
function createActivity({ profileDir = null, projectsDir = null, log = () => {}, useWorker = true, now = Date.now, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const dirOf = () => projectsDir || require('./engine/transcript').projectsDir();
  const cachePath = profileDir ? path.join(profileDir, 'activity-cache.json') : null;
  let memCache = null;      // inline mode keeps the cache object between scans
  let lastResult = null;
  let lastAt = 0;
  let lastAll = null;       // the last finished all-time aggregate
  let allError = null;      // why the last all-time pass failed (shown until one succeeds)
  let progress = null;      // { done, total } while a run is in phase 2
  let busy = null;          // the whole current run (phase 1 + 2)
  let win = null;           // { promise, settled } for the current run's phase 1

  function viaWorker(job, h) {
    const { Worker } = require('worker_threads');
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'activity-worker.js'), { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 512 } });
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      w.on('message', (m) => {
        if (!m) return;
        if (m.kind === 'window') h.window(m.result);
        else if (m.kind === 'progress') h.progress(m.done, m.total);
        else if (m.kind === 'alltime') h.allTime(m.result);
        else if (m.kind === 'done') { settled = true; resolve(); }
        else if (m.kind === 'error' || m.ok === false) fail(new Error(m.error || 'activity scan failed'));
      });
      w.once('error', fail);
      w.once('exit', (code) => fail(new Error(`activity worker exited with code ${code}`)));
    });
  }

  function run() {
    let resolveW, rejectW;
    const state = { settled: false };
    state.promise = new Promise((res, rej) => { resolveW = res; rejectW = rej; });
    state.promise.catch(() => {}); // awaited by summary(); never an unhandled rejection
    const h = {
      window: (r) => { lastResult = r; lastAt = now(); state.settled = true; resolveW(r); },
      progress: (done, total) => { progress = { done, total }; },
      allTime: (a) => { lastAll = a; allError = null; progress = null; },
    };
    const job = { projectsDir: dirOf(), cachePath, now: now(), tempDir: os.tmpdir(), opts: o };
    const exec = async () => {
      if (useWorker) {
        try { await viaWorker(job, h); return; } catch (e) {
          // After phase 1 a failure is phase 2's: never redo the heavy all-time pass on the main thread.
          if (state.settled) throw e;
          log('activity: worker scan failed, scanning inline:', e && e.message);
        }
      }
      const out = await runScan({ ...job, cache: memCache, onWindow: h.window, onProgress: h.progress });
      if (!cachePath) memCache = out.cache;
      if (out.allTime) h.allTime(out.allTime);
    };
    busy = exec()
      .catch((e) => {
        if (!state.settled) { state.settled = true; rejectW(e); return; }
        allError = (e && e.message) || String(e);
        log('activity: all-time scan failed:', allError);
      })
      .finally(() => { busy = null; progress = null; });
    win = state;
    return state;
  }

  // The `allTime` field of activity.summary.
  function allTimeState() {
    if (lastAll) {
      const { files, scannedAt, scanMs } = lastAll;
      return {
        activeMs: lastAll.activeMs, agentMs: lastAll.agentMs, since: lastAll.since,
        byMonth: lastAll.byMonth, byProject: lastAll.byProject, files, scannedAt, scanMs,
        ...(lastAll.errors && lastAll.errors.length ? { warnings: lastAll.errors.slice(0, 5) } : {}),
      };
    }
    if (busy) return { scanning: progress ? { ...progress } : { done: 0, total: 0 } };
    if (allError) return { error: allError };
    return { scanning: { done: 0, total: 0 } }; // asked before any run: one starts with this call
  }

  async function summary(p = {}) {
    const days = p.days === undefined ? 14 : p.days;
    if (!Number.isInteger(days) || days < 1 || days > o.windowDays) throw rpcError(`days must be a whole number from 1 to ${o.windowDays}`, 'bad_params');
    if (p.allTime !== undefined && typeof p.allTime !== 'boolean') throw rpcError('allTime must be true or false', 'bad_params');
    const fresh = lastResult && now() - lastAt < o.minRescanMs && !p.force;
    if (!fresh) {
      // A run still in phase 2 is shared: its phase 1 is the freshest window there is.
      if (!busy) run();
      if (win && !win.settled) {
        try { await win.promise; } catch (e) {
          if (!lastResult) throw rpcError(`Could not read the Claude Code transcripts: ${e.message}`, 'scan_failed');
          log('activity: rescan failed, serving the previous scan:', e.message);
        }
      }
    }
    if (!lastResult) {
      // Only a concurrent first call that raced a failure lands here.
      throw rpcError('Could not read the Claude Code transcripts', 'scan_failed');
    }
    return summarize(lastResult, days, { dir: dirOf(), ...(p.allTime ? { allTime: allTimeState() } : {}) });
  }

  return {
    summary,
    allTimeState,
    whenIdle: () => busy || Promise.resolve(),
    methods: { 'activity.summary': (p) => summary(p || {}) },
  };
}

// One-line hook for main/rpc.js: the `activity.summary` handler for a router (lazy: nothing is
// read until the first call). The cache goes next to settings.json (the profile folder).
function rpcHandler({ settings, log } = {}) {
  let inst = null;
  return (p) => {
    if (!inst) inst = createActivity({ profileDir: settings && settings.file ? path.dirname(settings.file) : null, log: log || (() => {}) });
    return inst.summary(p || {});
  };
}

module.exports = {
  createActivity, rpcHandler, runScan, summarize,
  _internal: { skimLine, classify, Stream, scanFile, scanAll, aggregateAllTime, union, addToDays, dayBounds, monthBounds, localDayKey, localMonthKey, projectOf, serializeCache, loadCache, DEFAULTS, RULE_VERSION },
};
