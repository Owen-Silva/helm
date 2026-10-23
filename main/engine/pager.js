'use strict';
// Tail-first transcript reader for long sessions.
//
// The user's biggest Claude Code transcripts are 50-145 MB with up to 1 GB of subagent files next
// to them, so parsing a whole transcript (plus every subagent) to show the newest 300 items took
// 2-6 s. A TranscriptPager reads the .jsonl BACKWARDS in windows (whole lines only), normalizes
// each window on its own, and only parses the subagent transcripts of Agent cards that are in a
// parsed window (capped to their newest SUB_TAIL_BYTES).
//
// Item ids are derived from the byte offset of the line that produced them (`t<offset36>`, with
// `_<k>` for the k-th extra item of one line; subagent items `t<agentId>.<offset36>`), so they are
// the same whichever window, cache or process parsed them: `before` paging stays stable across
// re-reads and appends. A tool_result whose tool_use is in an older, not-yet-parsed window is kept
// as an "orphan" and applied when that window is parsed, so a tool never shows as running just
// because its result sat across a window boundary.

const fs = require('fs');
const path = require('path');
const { Normalizer } = require('./normalize');

const FIRST_WINDOW_BYTES = 512 * 1024;
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;
const SUB_TAIL_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const MAX_AGENT_DEPTH = 6;
const AGENT_NAMES = new Set(['Agent', 'Task']);
const CACHE_MAX = 6;

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function readRange(fd, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (!n) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

// Whole lines of buf (absolute offsets from base) that look like JSON objects.
function linesOf(buf, base) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let j = buf.indexOf(10, i);
    if (j < 0) j = buf.length;
    if (j > i && buf[i] === 123 /* { */) out.push({ off: base + i, text: buf.toString('utf8', i, j) });
    i = j + 1;
  }
  return out;
}

// Read the whole lines that END at or before `end` and START at or after roughly end-want.
// Returns { lines, start } where start is the first line's offset (0 at the top of the file).
// `floor` (a line start, default 0) is where reading stops: a stitched segment (StitchedPager) starts there.
function readLinesBefore(fd, end, want, floor = 0) {
  let len = Math.min(want, end - floor);
  for (;;) {
    const start = end - len;
    const buf = readRange(fd, start, len);
    if (start === floor) return { lines: linesOf(buf, floor), start: floor };
    const nl = buf.indexOf(10);
    if (nl >= 0 && nl < buf.length - 1) return { lines: linesOf(buf.subarray(nl + 1), start + nl + 1), start: start + nl + 1 };
    if (nl >= 0 && nl === buf.length - 1 && len >= end) return { lines: [], start: end };
    len = Math.min(end - floor, len * 2); // one line longer than the window: widen until a line start shows up
  }
}

// Offset just past the last '\n' at or before `size` (a line still being written is left out).
function completeEnd(fd, size) {
  let pos = size;
  const step = 64 * 1024;
  while (pos > 0) {
    const start = Math.max(0, pos - step);
    const buf = readRange(fd, start, pos - start);
    const nl = buf.lastIndexOf(10);
    if (nl >= 0) return start + nl + 1;
    pos = start;
  }
  return 0;
}

function tsOf(j) {
  const t = j && j.timestamp ? Date.parse(j.timestamp) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

// Ids of the form <prefix><offset36>[_<k>] for the k-th item a line produced.
function lineIds(prefix) {
  const st = { off: 0, k: 0 };
  return {
    at(off) {
      st.off = off;
      st.k = 0;
    },
    next() {
      const id = st.k ? `${prefix}${st.off.toString(36)}_${st.k}` : `${prefix}${st.off.toString(36)}`;
      st.k++;
      return id;
    },
  };
}

function windowStore(byId) {
  const items = [];
  return {
    items,
    add(item) {
      items.push(item);
      byId.set(item.id, item);
    },
    patch(id, patch, appendText) {
      const it = byId.get(id);
      if (!it) return;
      if (patch) Object.assign(it, patch);
      if (appendText) it.text = (it.text || '') + appendText;
    },
    get(id) {
      return byId.get(id) || null;
    },
  };
}

class TranscriptPager {
  // `floor`: byte offset of a line start; lines before it are never read (a segment of a StitchedPager).
  constructor(file, { subagents = true, prefix = 't', windowBytes = FIRST_WINDOW_BYTES, subTailBytes = SUB_TAIL_BYTES, floor = 0 } = {}) {
    this.file = file;
    this.floor = floor > 0 ? floor : 0;
    this.windowBytes = windowBytes;
    this.subTailBytes = subTailBytes;
    this.subagents = subagents;
    this.prefix = prefix;
    this._reset();
  }

  _reset() {
    this.started = false;
    this.lo = 0; // offset of the oldest parsed line
    this.hi = 0; // offset just past the newest parsed line
    this.size = 0;
    this.windows = []; // oldest first: { start, end, flat: [item], toolIds: [toolUseId], orphanIds: [toolUseId] }
    this.items = []; // flattened (children placed after their Agent card), oldest first
    this.byId = new Map();
    this.toolItem = new Map(); // main-thread toolUseId → item
    this.orphans = new Map(); // toolUseId → { block, ts, structured } (result seen, tool_use not parsed yet)
    this.anchors = new Map(); // main-thread uuid → id of the last item at that line (turn-result merge)
    this.meta = { cwd: null, title: null, aiTitle: null, costUsd: null, lastUsage: null, lastModel: null, firstPrompt: null };
    this.subMap = null; // toolUseId → subagent .jsonl path
    this.subMapKey = null;
    this.subCache = new Map(); // subagent file → { size, items }
    this.resolver = new Normalizer({ store: windowStore(this.byId), newId: () => `${this.prefix}x` });
  }

  hasOlder() {
    return this.lo > this.floor;
  }

  _open(fn) {
    const fd = fs.openSync(this.file, 'r');
    try {
      return fn(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---------- parsing ----------
  _parseLines(lines) {
    const ids = lineIds(this.prefix);
    const store = windowStore(this.byId);
    const meta = { cwd: null, title: null, aiTitle: null, costUsd: null, lastUsage: null, lastModel: null };
    const norm = new Normalizer({
      store,
      newId: () => ids.next(),
      hooks: {
        onAssistant(m) {
          const u = m.message && m.message.usage;
          if (u && !m.isSidechain) {
            meta.lastUsage = u;
            meta.lastModel = m.message.model || meta.lastModel;
          }
        },
      },
    });
    const orphans = [];
    const anchors = [];
    for (const ln of lines) {
      let j;
      try {
        j = JSON.parse(ln.text);
      } catch {
        continue;
      }
      if (!j || typeof j !== 'object') continue;
      ids.at(ln.off);
      if (!meta.cwd && j.cwd) meta.cwd = j.cwd;
      if (j.type === 'custom-title' && j.customTitle) meta.title = j.customTitle;
      else if (j.type === 'ai-title' && j.aiTitle) meta.aiTitle = j.aiTitle;
      else if (j.type === 'cost-state' && typeof j.totalCostUSD === 'number') meta.costUsd = j.totalCostUSD;
      if (j.type === 'user' && !j.isSidechain && j.message && Array.isArray(j.message.content)) {
        for (const b of j.message.content) {
          if (b && b.type === 'tool_result' && b.tool_use_id && !norm.toolByUseId.has(b.tool_use_id)) {
            orphans.push({ toolUseId: b.tool_use_id, block: b, ts: tsOf(j), structured: j.toolUseResult });
          }
        }
      }
      norm.handleLine(j);
      if (j.uuid && !j.isSidechain && store.items.length) anchors.push([j.uuid, store.items[store.items.length - 1].id]);
    }
    norm.finishStreaming();
    return { items: store.items, norm, orphans, anchors, meta };
  }

  _applyResult(item, o) {
    this.resolver.toolByUseId.set(o.toolUseId, item.id);
    this.resolver._toolResult(o.block, o.ts, o.structured);
    this.resolver.toolByUseId.delete(o.toolUseId);
  }

  // Parse [start, end) as one window; `newest` = it goes after every parsed window.
  _addWindow(lines, start, end, newest) {
    const w = this._parseLines(lines);
    const toolIds = [];
    for (const it of w.items) {
      if (it.type === 'tool' && it.toolUseId) {
        this.toolItem.set(it.toolUseId, it);
        toolIds.push(it.toolUseId);
      }
    }
    // Results in this window for tools parsed earlier (an append re-parse) or not parsed yet.
    const orphanIds = [];
    for (const o of w.orphans) {
      const it = this.toolItem.get(o.toolUseId);
      if (it && !toolIds.includes(o.toolUseId)) this._applyResult(it, o);
      else if (!it) {
        this.orphans.set(o.toolUseId, o);
        orphanIds.push(o.toolUseId);
      }
    }
    // Results for this window's tools that newer windows already saw.
    for (const id of toolIds) {
      const o = this.orphans.get(id);
      const it = this.toolItem.get(id);
      if (o && it && it.status === 'running') {
        this._applyResult(it, o);
        this.orphans.delete(id);
      }
    }
    for (const [uuid, itemId] of w.anchors) this.anchors.set(uuid, itemId);
    // Newest wins for meta: a newer window's value is never replaced by an older one.
    for (const k of Object.keys(w.meta)) {
      if (w.meta[k] == null) continue;
      if (newest || this.meta[k] == null) this.meta[k] = w.meta[k];
    }
    const flat = this.subagents ? this._withChildren(w.items, 0) : w.items;
    const win = { start, end, flat, toolIds, orphanIds };
    if (newest) {
      this.windows.push(win);
      this.items.push(...flat);
    } else {
      this.windows.unshift(win);
      this.items = flat.concat(this.items);
    }
    return flat;
  }

  // ---------- subagents ----------
  _subDir() {
    return path.join(path.dirname(this.file), path.basename(this.file, '.jsonl'), 'subagents');
  }

  _subagentFile(toolUseId) {
    const dir = this._subDir();
    const st = statOf(dir);
    if (!st) return null;
    const key = String(st.mtimeMs);
    if (!this.subMap || this.subMapKey !== key || !this.subMap.has(toolUseId)) {
      if (this.subMap && this.subMapKey === key) return null; // dir unchanged and the id is not in it
      this.subMap = new Map();
      this.subMapKey = key;
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
      } catch {}
      for (const f of names) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (m && m.toolUseId) this.subMap.set(m.toolUseId, path.join(dir, f.replace(/\.meta\.json$/, '.jsonl')));
        } catch {}
      }
    }
    return this.subMap.get(toolUseId) || null;
  }

  _childrenOf(toolUseId, depth) {
    const file = this._subagentFile(toolUseId);
    if (!file) return [];
    const st = statOf(file);
    if (!st) return [];
    const hit = this.subCache.get(file);
    if (hit && hit.size === st.size) {
      for (const it of hit.items) this.byId.set(it.id, it);
      return hit.items;
    }
    const key = path.basename(file, '.jsonl').replace(/^agent-/, '');
    const prefix = `${this.prefix}${key}.`;
    let lines;
    let cut = false;
    try {
      lines = this._openFd(file, (fd) => {
        const end = completeEnd(fd, st.size);
        const r = readLinesBefore(fd, end, this.subTailBytes);
        cut = r.start > 0;
        return r.lines;
      });
    } catch {
      return [];
    }
    const ids = lineIds(prefix);
    const store = windowStore(this.byId);
    const sn = new Normalizer({ store, newId: () => ids.next(), forceParent: toolUseId, noPrompts: true });
    for (const ln of lines) {
      let j;
      try {
        j = JSON.parse(ln.text);
      } catch {
        continue;
      }
      ids.at(ln.off);
      sn.handleLine(j);
    }
    sn.finishStreaming();
    let items = store.items;
    if (cut) {
      const note = { id: `${prefix}cut`, type: 'system', subtype: 'info', ts: items.length ? items[0].ts : Date.now(), text: `Earlier steps of this agent are not shown (its transcript is ${Math.round(st.size / 1048576)} MB; the newest ${Math.round(this.subTailBytes / 1048576)} MB are).`, parentToolUseId: toolUseId };
      this.byId.set(note.id, note);
      items = [note, ...items];
    }
    items = this._withChildren(items, depth + 1);
    this.subCache.set(file, { size: st.size, items });
    return items;
  }

  _openFd(file, fn) {
    const fd = fs.openSync(file, 'r');
    try {
      return fn(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _withChildren(items, depth) {
    if (depth > MAX_AGENT_DEPTH) return items;
    let out = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type !== 'tool' || !AGENT_NAMES.has(it.name) || !it.toolUseId) {
        if (out) out.push(it);
        continue;
      }
      const kids = this._childrenOf(it.toolUseId, depth);
      if (!kids.length) {
        if (out) out.push(it);
        continue;
      }
      if (!out) out = items.slice(0, i);
      out.push(it, ...kids);
    }
    return out || items;
  }

  // ---------- loading ----------
  // Parse the newest window(s) until at least `minItems` items exist (or the file is exhausted).
  loadNewest(minItems = 300) {
    if (this.started) return this.items;
    const st = statOf(this.file);
    if (!st) {
      this.started = true;
      return this.items;
    }
    this._open((fd) => {
      const end = completeEnd(fd, st.size);
      this.size = st.size;
      this.hi = end;
      this.lo = end;
      this.started = true;
      this._extend(fd, minItems, true);
    });
    if (!this.meta.firstPrompt) this._readHead();
    return this.items;
  }

  // Parse older windows until at least `minItems` NEW items exist; returns them (oldest first).
  extendOlder(minItems = 300) {
    if (!this.started) this.loadNewest(minItems);
    if (this.lo <= this.floor) return [];
    let out = [];
    this._open((fd) => {
      out = this._extend(fd, minItems, false);
    });
    return out;
  }

  _extend(fd, minItems, first) {
    let produced = [];
    let want = this.windowBytes;
    let isNewest = first;
    while (this.lo > this.floor && produced.length < minItems) {
      const end = this.lo;
      const r = readLinesBefore(fd, end, want, this.floor);
      const flat = this._addWindow(r.lines, r.start, end, isNewest);
      isNewest = false;
      this.lo = r.start;
      produced = flat.concat(produced);
      want = Math.min(MAX_WINDOW_BYTES, want * 2);
    }
    return produced;
  }

  // First prompt (and an early custom title) from the head of the file.
  _readHead() {
    if (this.lo === 0 && !this.floor) {
      const first = this.items.find((i) => i.type === 'user' && i.text && !i.parentToolUseId);
      this.meta.firstPrompt = first ? first.text : null;
      return;
    }
    try {
      const lines = this._open((fd) => {
        const st = statOf(this.file);
        const len = Math.min(HEAD_BYTES, st ? st.size : 0);
        const buf = readRange(fd, 0, len);
        const nl = buf.lastIndexOf(10);
        return linesOf(nl >= 0 ? buf.subarray(0, nl) : buf, 0);
      });
      const items = [];
      const norm = new Normalizer({ store: { add: (i) => items.push(i), patch() {}, get: () => null }, newId: () => 'h' });
      for (const ln of lines) {
        let j;
        try {
          j = JSON.parse(ln.text);
        } catch {
          continue;
        }
        if (j.type === 'custom-title' && j.customTitle && !this.meta.title) this.meta.title = j.customTitle;
        if (!this.meta.cwd && j.cwd) this.meta.cwd = j.cwd;
        if (!items.some((i) => i.type === 'user' && i.text)) norm.handleLine(j);
      }
      const first = items.find((i) => i.type === 'user' && i.text);
      if (first) this.meta.firstPrompt = first.text;
    } catch {}
  }

  // ---------- read-only paging (external sessions) ----------
  // Picks up appended lines: the newest window is re-parsed from its start, so ids stay stable.
  refresh() {
    if (!this.started) return;
    const st = statOf(this.file);
    if (!st) return this._reset();
    if (st.size === this.size) return;
    if (st.size < this.hi) {
      this._reset();
      return;
    }
    const last = this.windows[this.windows.length - 1];
    this.size = st.size;
    this._open((fd) => {
      const end = completeEnd(fd, st.size);
      if (end === this.hi) return;
      let from = this.hi;
      if (last) {
        // Drop the newest window and parse it again together with the appended lines.
        this.windows.pop();
        this.items.length -= last.flat.length;
        for (const it of last.flat) this.byId.delete(it.id);
        for (const id of last.toolIds) this.toolItem.delete(id);
        for (const id of last.orphanIds) this.orphans.delete(id);
        from = last.start;
      }
      const buf = readRange(fd, from, end - from);
      this._addWindow(linesOf(buf, from), from, end, true);
      this.hi = end;
      if (!last) this.lo = Math.min(this.lo, from);
    });
  }

  page({ before, limit } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || 300, 2000));
    if (this.started) this.refresh();
    if (!this.started) this.loadNewest(lim);
    let end = this.items.length;
    if (before) {
      let idx = this.items.findIndex((i) => i.id === before);
      while (idx < 0 && this.lo > this.floor && this._mayBeOlder(before)) {
        this.extendOlder(lim);
        idx = this.items.findIndex((i) => i.id === before);
      }
      if (idx >= 0) end = idx;
    }
    while (end < lim && this.lo > this.floor) {
      const added = this.extendOlder(lim - end);
      end += added.length;
    }
    const start = Math.max(0, end - lim);
    return { items: this.items.slice(start, end), hasMore: start > 0 || this.lo > this.floor };
  }

  // An id this pager made for a line before `lo` (worth parsing further back for).
  _mayBeOlder(id) {
    const m = new RegExp(`^${this.prefix}([0-9a-z]+)(?:_\\d+)?$`).exec(String(id));
    if (!m) return String(id).startsWith(this.prefix); // a subagent child: its card is somewhere older
    return parseInt(m[1], 36) < this.lo;
  }
}

// ---------- module cache (read-only views) ----------
const cache = new Map(); // file → TranscriptPager (LRU by insertion order)

function pagerFor(file) {
  let p = cache.get(file);
  if (p) {
    cache.delete(file);
    cache.set(file, p);
    return p;
  }
  p = new TranscriptPager(file);
  cache.set(file, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

// readTranscriptPage(file, { before, limit }) → { items, hasMore }
function readTranscriptPage(file, opts = {}) {
  if (!statOf(file)) return { items: [], hasMore: false };
  return pagerFor(file).page(opts);
}

// The transcript line with this uuid (searching from the end, where recent prompts are), or null.
// `withOffset`: return { off, line } (off = byte offset of the line start) instead of the parsed line.
function findLineByUuid(file, uuid, { withOffset = false } = {}) {
  if (!uuid) return null;
  const st = statOf(file);
  if (!st) return null;
  const needle = Buffer.from(`"uuid":"${uuid}"`);
  const CH = 8 * 1024 * 1024;
  try {
    return TranscriptPager.prototype._openFd(file, (fd) => {
      let end = st.size;
      while (end > 0) {
        const start = Math.max(0, end - CH);
        const buf = readRange(fd, start, end - start + (end < st.size ? Math.min(needle.length, st.size - end) : 0));
        let at = buf.lastIndexOf(needle);
        while (at >= 0) {
          const abs = start + at;
          // Line bounds around the match.
          let ls = abs;
          let le = abs;
          let p = buf.lastIndexOf(10, at);
          if (p >= 0) ls = start + p + 1;
          else {
            ls = 0;
            let back = start;
            while (back > 0) {
              const s2 = Math.max(0, back - 1024 * 1024);
              const b2 = readRange(fd, s2, back - s2);
              const q = b2.lastIndexOf(10);
              if (q >= 0) {
                ls = s2 + q + 1;
                break;
              }
              back = s2;
            }
          }
          const q = buf.indexOf(10, at);
          if (q >= 0) le = start + q;
          else {
            le = st.size;
            let fwd = start + buf.length;
            while (fwd < st.size) {
              const b2 = readRange(fd, fwd, Math.min(1024 * 1024, st.size - fwd));
              const r = b2.indexOf(10);
              if (r >= 0) {
                le = fwd + r;
                break;
              }
              fwd += b2.length;
            }
          }
          try {
            const j = JSON.parse(readRange(fd, ls, le - ls).toString('utf8'));
            if (j && j.uuid === uuid) return withOffset ? { off: ls, line: j } : j;
          } catch {}
          at = at > 0 ? buf.lastIndexOf(needle, at - 1) : -1;
        }
        end = start;
      }
      return null;
    });
  } catch {
    return null;
  }
}

// ---------- stitched history (conversation rewinds that were sent) ----------
// Once a conversation rewind is sent, the session's transcript is a FORK: the kept part copied from
// its source, then the new turns. Helm keeps showing what the user saw before the restart: the source's
// whole history (the rewound part folds in the UI), the "Rewound to before…" marker(s), then the
// fork's own turns. A StitchedPager pages that tail-first across segments, oldest first:
//   { file, floor, prefix }  transcript lines from byte offset `floor` (a line start) on
//   { items }                ready-made items (the rewind markers)
// Only the segment being read is parsed, so a long source costs nothing until the user scrolls up to it.
// It has the TranscriptPager surface EngineSession uses (loadNewest / extendOlder / hasOlder /
// _mayBeOlder / meta / anchors / file); `files` lists every transcript, newest first.
class StitchedPager {
  constructor(segments) {
    this.segs = segments.map((s) => (s.items ? { items: s.items, done: false } : { file: s.file, pager: new TranscriptPager(s.file, { prefix: s.prefix, floor: s.floor || 0 }) }));
    this.cur = this.segs.length - 1; // newest segment that still has unread items
    this.items = [];
    this.started = false;
    this.files = this.segs.filter((s) => s.pager).map((s) => s.file).reverse();
    this.file = this.files[0] || null;
    this._own = [...this.segs].reverse().find((s) => s.pager) || null;
  }

  get meta() {
    return this._own ? this._own.pager.meta : {};
  }

  // uuid → item id across every parsed segment (turn results are merged back after these).
  get anchors() {
    const out = new Map();
    for (const s of this.segs) if (s.pager && s.pager.started) for (const [k, v] of s.pager.anchors) out.set(k, v);
    return out;
  }

  _segLeft(s) {
    return s.items ? !s.done : !s.pager.started || s.pager.hasOlder();
  }

  hasOlder() {
    for (let i = this.cur; i >= 0; i--) if (this._segLeft(this.segs[i])) return true;
    return false;
  }

  _take(minItems) {
    let out = [];
    while (this.cur >= 0 && out.length < minItems) {
      const s = this.segs[this.cur];
      let got = [];
      if (s.items) {
        if (!s.done) got = s.items;
        s.done = true;
      } else if (!s.pager.started) got = s.pager.loadNewest(minItems - out.length).slice();
      else got = s.pager.extendOlder(minItems - out.length);
      out = got.concat(out);
      if (!this._segLeft(s)) this.cur--;
    }
    this.items = out.concat(this.items);
    return out;
  }

  loadNewest(minItems = 300) {
    if (!this.started) {
      this.started = true;
      this._take(minItems);
    }
    return this.items;
  }

  extendOlder(minItems = 300) {
    if (!this.started) return this.loadNewest(minItems).slice();
    return this._take(minItems);
  }

  _mayBeOlder(id) {
    for (let i = this.cur; i >= 0; i--) {
      const s = this.segs[i];
      if (s.items) {
        if (!s.done && s.items.some((it) => it.id === id)) return true;
      } else if (s.pager.started ? s.pager.hasOlder() && s.pager._mayBeOlder(id) : String(id).startsWith(s.pager.prefix)) return true;
    }
    return false;
  }
}

module.exports = { TranscriptPager, StitchedPager, readTranscriptPage, findLineByUuid, pagerFor, _internal: { readLinesBefore, completeEnd, linesOf } };
