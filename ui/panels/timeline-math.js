// Owner: lane panels (E). Pure helpers for the Agents panel's Timeline mode (no imports, so
// node:test can load this file directly: test/host/fleet-timeline.test.js).
//   spanOf(agent, now)            -> { start, end, unknownEnd? } or null (end = now ONLY while running)
//   runSpans(agent, now)          -> [{ start, end }]  the time it really ran: runs before a resume + this run
//   ranMs, lastActiveAt, isWorking, workingTree, orderTree, fleetCounts: Agents panel list helpers
//   peakConcurrency(spans)      -> { peak, at }      most agents running at the same instant
//   concurrencySteps(spans)       -> [{ t, n }]        step function of the running count
//   buildScale(spans, opts)       -> piecewise-linear time scale; long idle gaps are collapsed
//   timeTicks(scale, opts)        -> [{ t, x, step }]  "nice" ticks, at least minPx apart
//   fmtTick(t, step)              -> "14:05" | "14:05:30" | "Oct 8"

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const isNum = (v) => typeof v === 'number' && isFinite(v);

export const isWorking = (a) => !!a && a.status === 'running';

// The bar: first start to the end. An agent that is not running and has no endedAt (it stopped with
// no completion record and its end is unknown) ends where its last known run ended (or at its start),
// flagged unknownEnd: it never stretches to `now` (that made agents look like they ran for hours).
export function spanOf(a, now) {
  if (!a || !isNum(a.startedAt)) return null;
  if (isWorking(a)) return { start: a.startedAt, end: Math.max(a.startedAt, now) };
  if (isNum(a.endedAt)) return { start: a.startedAt, end: Math.max(a.startedAt, a.endedAt) };
  const runs = runSpans(a, now);
  return { start: a.startedAt, end: runs.length ? runs[runs.length - 1].end : a.startedAt, unknownEnd: true };
}

// Engine Agent: runs = [{ startedAt, endedAt }] before a SendMessage resume; resumedAt = this run's start.
export function runSpans(a, now) {
  if (!a || !isNum(a.startedAt)) return [];
  const out = [];
  for (const r of Array.isArray(a.runs) ? a.runs : []) {
    if (r && isNum(r.startedAt) && isNum(r.endedAt)) out.push({ start: r.startedAt, end: Math.max(r.startedAt, r.endedAt) });
  }
  const start = isNum(a.resumedAt) ? a.resumedAt : a.startedAt;
  const end = isWorking(a) ? now : isNum(a.endedAt) ? a.endedAt : null;
  if (end != null) out.push({ start, end: Math.max(start, end) });
  return out;
}

// Total time it ran (null when no run has a known end).
export function ranMs(a, now) {
  const r = runSpans(a, now);
  return r.length ? r.reduce((s, x) => s + (x.end - x.start), 0) : null;
}

// When it was last doing something: now while running, else its end (or its last start).
export function lastActiveAt(a, now) {
  if (!a) return 0;
  if (isWorking(a)) return now;
  if (isNum(a.endedAt)) return a.endedAt;
  const r = runSpans(a, now);
  if (r.length) return r[r.length - 1].end;
  return isNum(a.resumedAt) ? a.resumedAt : isNum(a.startedAt) ? a.startedAt : 0;
}

// Working view: the running agents plus their ancestors (so a running child keeps its place in the tree).
export function workingTree(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const keep = new Set();
  for (const a of list) {
    if (!isWorking(a)) continue;
    let x = a;
    const seen = new Set();
    while (x && !seen.has(x.id)) { seen.add(x.id); keep.add(x.id); x = x.parentId ? byId.get(x.parentId) : null; }
  }
  return list.filter((a) => keep.has(a.id));
}

// Tree order: [{ agent, depth }]. Children follow their parent. Siblings by start time, or with
// activity: true (the All list) running subtrees first, then finished ones newest-first.
export function orderTree(agents, { activity = false, now = Date.now() } = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const kids = new Map();
  const roots = [];
  for (const a of list) {
    if (a.parentId && byId.has(a.parentId) && a.parentId !== a.id) { if (!kids.has(a.parentId)) kids.set(a.parentId, []); kids.get(a.parentId).push(a); } else roots.push(a);
  }
  const memo = new Map();   // id -> { live, last } over the subtree
  const sub = (a, seen = new Set()) => {
    if (memo.has(a.id)) return memo.get(a.id);
    let live = isWorking(a), last = lastActiveAt(a, now);
    seen.add(a.id);
    for (const k of kids.get(a.id) || []) {
      if (seen.has(k.id)) continue;
      const s = sub(k, seen);
      live = live || s.live; last = Math.max(last, s.last);
    }
    const r = { live, last };
    memo.set(a.id, r);
    return r;
  };
  const byStart = (x, y) => (x.startedAt || 0) - (y.startedAt || 0);
  const byActivity = (x, y) => {
    const a = sub(x), b = sub(y);
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.live) return byStart(x, y);
    return (b.last - a.last) || byStart(y, x);
  };
  const cmp = activity ? byActivity : byStart;
  const out = [];
  const seen = new Set();
  const walk = (a, depth) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push({ agent: a, depth });
    for (const k of (kids.get(a.id) || []).slice().sort(cmp)) walk(k, depth + 1);
  };
  for (const r of roots.slice().sort(cmp)) walk(r, r.parentId ? (r.depth || 0) : 0);
  return out;
}

// Header numbers: { total, running, finished }.
export function fleetCounts(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const running = list.filter(isWorking).length;
  return { total: list.length, running, finished: list.length - running };
}

// Sweep line. An agent that ends at the exact instant another starts does not overlap it.
function events(spans) {
  const ev = [];
  for (const s of spans) {
    if (!s || !isNum(s.start) || !isNum(s.end) || s.end <= s.start) continue;
    ev.push([s.start, 1], [s.end, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // ends (-1) before starts (+1) at the same instant
  return ev;
}

export function peakConcurrency(spans) {
  let n = 0, peak = 0, at = null;
  for (const [t, d] of events(spans)) {
    n += d;
    if (n > peak) { peak = n; at = t; }
  }
  return { peak, at };
}

// [{ t, n }]: from t on, n agents run (until the next step). Collapses same-instant events.
export function concurrencySteps(spans) {
  const out = [];
  let n = 0;
  for (const [t, d] of events(spans)) {
    n += d;
    if (out.length && out[out.length - 1].t === t) out[out.length - 1].n = n;
    else out.push({ t, n });
  }
  return out;
}

// Merge spans into busy blocks, then split the timeline into segments separated by long idle
// gaps. Each segment is linear; a collapsed gap becomes a fixed `breakPx` break. Segments get at
// least `minSegPx`; if that (or minWidth) can't fit `width`, the scale is wider than asked and the
// chart scrolls sideways inside itself.
export function buildScale(spans, {
  width = 240, minWidth = 200, breakPx = 14, minSegPx = 36, padL = 6, padR = 10,
  gapMinMs = 20 * MIN, gapFrac = 0.25,
} = {}) {
  const ok = spans.filter((s) => s && isNum(s.start) && isNum(s.end)).map((s) => ({ start: s.start, end: Math.max(s.start, s.end) }));
  if (!ok.length) return null;
  ok.sort((a, b) => a.start - b.start);
  const blocks = [];
  for (const s of ok) {
    const last = blocks[blocks.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else blocks.push({ ...s });
  }
  const busy = blocks.reduce((sum, b) => sum + (b.end - b.start), 0);
  const segs = [{ t0: blocks[0].start, t1: blocks[0].end }];
  for (let i = 1; i < blocks.length; i++) {
    const gap = blocks[i].start - segs[segs.length - 1].t1;
    if (gap > gapMinMs && gap > gapFrac * busy) segs.push({ t0: blocks[i].start, t1: blocks[i].end });
    else segs[segs.length - 1].t1 = blocks[i].end;
  }
  // A zero-length segment (one instant, or an agent that only just started) still gets a minute.
  for (const s of segs) if (s.t1 - s.t0 < MIN) s.t1 = s.t0 + MIN;

  const total = Math.max(width, minWidth);
  const avail = total - padL - padR - (segs.length - 1) * breakPx;
  // Distribute px proportionally to duration, pinning short segments at minSegPx.
  const fixed = new Set();
  let k = 0;
  for (let iter = 0; iter <= segs.length; iter++) {
    const free = segs.filter((_, i) => !fixed.has(i));
    const freeDur = free.reduce((sum, s) => sum + (s.t1 - s.t0), 0);
    const room = avail - fixed.size * minSegPx;
    k = freeDur > 0 && room > 0 ? room / freeDur : 0;
    let changed = false;
    segs.forEach((s, i) => { if (!fixed.has(i) && (s.t1 - s.t0) * k < minSegPx) { fixed.add(i); changed = true; } });
    if (!changed) break;
  }
  let x = padL;
  const segments = segs.map((s, i) => {
    const w = fixed.has(i) ? minSegPx : (s.t1 - s.t0) * k;
    const seg = { t0: s.t0, t1: s.t1, x0: x, x1: x + w };
    x += w + breakPx;
    return seg;
  });
  const breaks = segments.slice(1).map((s) => ({ x: s.x0 - breakPx, w: breakPx }));
  const right = segments[segments.length - 1].x1 + padR;
  const scale = {
    t0: segments[0].t0, t1: segments[segments.length - 1].t1,
    width: Math.max(total, Math.ceil(right)), segments, breaks,
    x(t) {
      if (!isNum(t)) return padL;
      if (t <= segments[0].t0) return segments[0].x0;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        if (t <= s.t1) {
          if (t >= s.t0) return s.x0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.x1 - s.x0);
          return s.x0 - breakPx / 2;   // inside a collapsed gap: the middle of its break
        }
      }
      return segments[segments.length - 1].x1;
    },
  };
  return scale;
}

const STEPS = [SEC, 5 * SEC, 15 * SEC, 30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

// Ticks aligned to local wall-clock multiples of the step (tzOffsetMs = -getTimezoneOffset()*MIN).
export function timeTicks(scale, { minPx = 64, tzOffsetMs } = {}) {
  if (!scale) return [];
  const out = [];
  let lastX = -Infinity;
  scale.segments.forEach((s, i) => {
    const pxPerMs = (s.x1 - s.x0) / (s.t1 - s.t0);
    const step = STEPS.find((st) => st * pxPerMs >= minPx) || STEPS[STEPS.length - 1];
    const off = isNum(tzOffsetMs) ? tzOffsetMs : -new Date(s.t0).getTimezoneOffset() * MIN;
    // After a collapsed gap the clock jumps, so label where the segment starts (edge: true).
    if (i > 0 && s.x0 - lastX >= minPx * 0.75) {
      out.push({ t: s.t0, x: s.x0, step: Math.min(step, MIN), edge: true });
      lastX = s.x0;
    }
    let t = Math.ceil((s.t0 + off) / step) * step - off;
    for (; t <= s.t1; t += step) {
      const x = s.x0 + (t - s.t0) * pxPerMs;
      if (x - lastX < minPx * 0.75) continue;      // keeps labels apart across a break too
      out.push({ t, x, step });
      lastX = x;
    }
  });
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtTick(t, step) {
  const d = new Date(t);
  if (step >= DAY) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return step < MIN ? `${hm}:${pad2(d.getSeconds())}` : hm;
}
