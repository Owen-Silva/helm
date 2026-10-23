// Unit tests for ui/panels/timeline-math.js (Agents panel, Timeline mode): peak concurrency,
// the gap-collapsing time scale and tick generation. The UI module is ESM with no imports, so
// require(esm) loads it directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { spanOf, runSpans, ranMs, lastActiveAt, workingTree, orderTree, fleetCounts, peakConcurrency, concurrencySteps, buildScale, timeTicks, fmtTick } = require('../../ui/panels/timeline-math.js');
const { displayStatus, agentsRunningOf, isAgentsOnly, agentsLabel } = require('../../ui/lib/session-status.js');

const MIN = 60_000;
const T = Date.UTC(2026, 9, 8, 12, 0, 0);

test('spanOf: running agents end at now, done agents at endedAt, no start = null; no end is NEVER now', () => {
  assert.deepEqual(spanOf({ status: 'running', startedAt: T }, T + 5 * MIN), { start: T, end: T + 5 * MIN });
  assert.deepEqual(spanOf({ status: 'done', startedAt: T, endedAt: T + MIN }, T + 9 * MIN), { start: T, end: T + MIN });
  // Finished with no endedAt (stopped with its CLI, end unknown): a zero-length span, not "until now".
  assert.deepEqual(spanOf({ status: 'error', startedAt: T }, T + 2 * MIN), { start: T, end: T, unknownEnd: true });
  assert.deepEqual(spanOf({ status: 'stopped', startedAt: T }, T + 4 * 60 * MIN), { start: T, end: T, unknownEnd: true });
  assert.equal(spanOf({ status: 'running' }, T), null);
});

test('peakConcurrency: counts true overlap; back-to-back agents do not overlap', () => {
  assert.deepEqual(peakConcurrency([]), { peak: 0, at: null });
  const spans = [
    { start: T, end: T + 10 * MIN },
    { start: T + 2 * MIN, end: T + 6 * MIN },
    { start: T + 3 * MIN, end: T + 4 * MIN },
    { start: T + 10 * MIN, end: T + 12 * MIN },   // starts exactly when the first ends
  ];
  assert.deepEqual(peakConcurrency(spans), { peak: 3, at: T + 3 * MIN });
  assert.equal(peakConcurrency([{ start: T, end: T + MIN }, { start: T + MIN, end: T + 2 * MIN }]).peak, 1);
});

test('concurrencySteps: a step function that returns to zero', () => {
  const steps = concurrencySteps([{ start: T, end: T + 4 * MIN }, { start: T + MIN, end: T + 2 * MIN }]);
  assert.deepEqual(steps, [{ t: T, n: 1 }, { t: T + MIN, n: 2 }, { t: T + 2 * MIN, n: 1 }, { t: T + 4 * MIN, n: 0 }]);
});

test('buildScale: fits the width, is monotonic and collapses a long idle gap into a break', () => {
  const spans = [
    { start: T, end: T + 30 * MIN },
    { start: T + 10 * MIN, end: T + 40 * MIN },
    { start: T + 5 * 60 * MIN, end: T + 5 * 60 * MIN + 20 * MIN },   // 4h20m later
  ];
  const s = buildScale(spans, { width: 300 });
  assert.equal(s.width, 300);
  assert.equal(s.segments.length, 2);
  assert.equal(s.breaks.length, 1);
  let prev = -Infinity;
  for (let t = T; t <= s.t1; t += 5 * MIN) { const x = s.x(t); assert.ok(x >= prev - 1e-9, `monotonic at ${t}`); prev = x; }
  assert.ok(s.x(s.t1) <= 300);
  // The collapsed gap takes the break's width, not 4h worth of pixels.
  assert.ok(s.segments[1].x0 - s.segments[0].x1 < 20);
});

test('buildScale: short gaps stay linear; too-narrow panels widen the scale (chart scrolls)', () => {
  const s = buildScale([{ start: T, end: T + 10 * MIN }, { start: T + 12 * MIN, end: T + 20 * MIN }], { width: 400 });
  assert.equal(s.segments.length, 1);
  const narrow = buildScale([{ start: T, end: T + 10 * MIN }], { width: 120, minWidth: 200 });
  assert.equal(narrow.width, 200);
  // Many collapsed segments: each keeps minSegPx, so the total grows past the requested width.
  const many = Array.from({ length: 12 }, (_, i) => ({ start: T + i * 10 * 60 * MIN, end: T + i * 10 * 60 * MIN + 5 * MIN }));
  const wide = buildScale(many, { width: 240, minSegPx: 36 });
  assert.equal(wide.segments.length, 12);
  assert.ok(wide.width > 240);
  for (const seg of wide.segments) assert.ok(seg.x1 - seg.x0 >= 36 - 1e-9);
});

test('buildScale: a single instant still gets a readable one-minute segment', () => {
  const s = buildScale([{ start: T, end: T }], { width: 240 });
  assert.equal(s.t1 - s.t0, MIN);
  assert.equal(buildScale([], { width: 240 }), null);
});

test('timeTicks: nice steps, inside the range, never closer than the label spacing', () => {
  const s = buildScale([{ start: T, end: T + 3 * 60 * MIN }], { width: 360 });
  const ticks = timeTicks(s, { minPx: 64, tzOffsetMs: 0 });
  assert.ok(ticks.length >= 2 && ticks.length <= 6, `got ${ticks.length}`);
  for (const tk of ticks) {
    assert.ok(tk.t >= s.t0 && tk.t <= s.t1);
    assert.equal(tk.t % tk.step, 0);   // aligned to wall-clock multiples (UTC here)
  }
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 64 * 0.75);
  assert.equal(ticks[0].step, 60 * MIN);
});

test('timeTicks: a segment after a collapsed gap gets a start label', () => {
  const s = buildScale([{ start: T, end: T + 40 * MIN }, { start: T + 5 * 60 * MIN, end: T + 5 * 60 * MIN + 30 * MIN }], { width: 360 });
  assert.equal(s.segments.length, 2);
  const ticks = timeTicks(s, { minPx: 64, tzOffsetMs: 0 });
  const edge = ticks.filter((tk) => tk.edge);
  assert.equal(edge.length, 1);
  assert.equal(edge[0].t, s.segments[1].t0);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 64 * 0.75);
});

test('fmtTick: seconds only under a minute step, a date for day steps', () => {
  const t = new Date(2026, 9, 8, 9, 5, 30).getTime();
  assert.equal(fmtTick(t, 15_000), '09:05:30');
  assert.equal(fmtTick(t, 5 * MIN), '09:05');
  assert.equal(fmtTick(t, 24 * 60 * MIN), 'Oct 8');
});

// ---- lane fleet (2026-10-08): finished-without-end, resumes, peak, Working | All ----

const A = (id, o) => ({ id, sessionId: 's', parentId: null, depth: 0, status: 'done', startedAt: T, ...o });

test('the screenshot bug: seven agents with no endedAt no longer count toward peak or run for hours', () => {
  const now = T + 5 * 60 * MIN;
  const old = [1, 2, 3, 4, 5, 6, 7].map((i) => A('o' + i, { status: i % 2 ? 'done' : 'stopped', startedAt: T + i * MIN }));
  const live = [A('r1', { status: 'running', startedAt: now - 10 * MIN }), A('r2', { status: 'running', startedAt: now - 5 * MIN })];
  const all = [...old, ...live];
  assert.equal(peakConcurrency(all.flatMap((a) => runSpans(a, now))).peak, 2, 'only the two genuinely running overlap');
  for (const a of old) assert.equal(ranMs(a, now), null, 'unknown run time, not 4h+');
  assert.equal(ranMs(A('x', { endedAt: T + 34 * MIN }), now), 34 * MIN);
  assert.deepEqual(fleetCounts(all), { total: 9, running: 2, finished: 7 });
});

test('runSpans / ranMs: a SendMessage resume adds a run; the idle gap between runs does not count', () => {
  const now = T + 90 * MIN;
  const a = A('a', { status: 'running', runs: [{ startedAt: T, endedAt: T + 20 * MIN }], resumedAt: T + 80 * MIN });
  assert.deepEqual(runSpans(a, now), [{ start: T, end: T + 20 * MIN }, { start: T + 80 * MIN, end: now }]);
  assert.equal(ranMs(a, now), 30 * MIN);
  const b = A('b', { status: 'running', startedAt: T + 30 * MIN });   // runs while a was idle
  assert.equal(peakConcurrency([a, b].flatMap((x) => runSpans(x, now))).peak, 2, 'overlap only after the resume');
  assert.equal(peakConcurrency([a, A('c', { startedAt: T + 30 * MIN, endedAt: T + 40 * MIN })].flatMap((x) => runSpans(x, now))).peak, 1);
  assert.equal(lastActiveAt(a, now), now);
  assert.equal(lastActiveAt(A('d', { status: 'stopped', runs: [{ startedAt: T, endedAt: T + 5 * MIN }], resumedAt: T + 9 * MIN }), now), T + 5 * MIN);
});

test('workingTree: Working shows running agents plus their ancestors only', () => {
  const list = [
    A('p', { status: 'done', endedAt: T + 9 * MIN }), A('c', { parentId: 'p', depth: 1, status: 'running' }),
    A('done1', { endedAt: T + MIN }), A('run1', { status: 'running' }), A('stop', { status: 'stopped' }),
  ];
  assert.deepEqual(workingTree(list).map((a) => a.id), ['p', 'c', 'run1']);
  assert.deepEqual(workingTree([A('x', { endedAt: T + MIN })]), []);
});

test('orderTree activity: running first, then finished newest-first; children stay under their parent', () => {
  const now = T + 5 * 60 * MIN;
  const list = [
    A('old1', { startedAt: T, endedAt: T + 30 * MIN }),
    A('old2', { startedAt: T + MIN, endedAt: T + 60 * MIN }),
    A('stopNoEnd', { status: 'stopped', startedAt: T + 2 * MIN }),
    A('run1', { status: 'running', startedAt: now - 20 * MIN }),
    A('parent', { startedAt: T + 3 * MIN, endedAt: T + 10 * MIN }),
    A('kid', { parentId: 'parent', depth: 1, status: 'running', startedAt: now - 5 * MIN }),
    A('run2', { status: 'running', startedAt: now - 10 * MIN }),
  ];
  const ids = orderTree(list, { activity: true, now }).map((r) => r.agent.id);
  assert.deepEqual(ids, ['parent', 'kid', 'run1', 'run2', 'old2', 'old1', 'stopNoEnd'], 'running subtrees by start, then finished newest-first');
  const depth = orderTree(list, { activity: true, now }).find((r) => r.agent.id === 'kid').depth;
  assert.equal(depth, 1);
  // Default (Timeline): by start time.
  assert.deepEqual(orderTree(list).map((r) => r.agent.id).slice(0, 3), ['old1', 'old2', 'stopNoEnd']);
});

test('session-status: idle with agents running shows as working; status itself is untouched', () => {
  const idle = { status: 'idle', agentsRunning: 2 };
  assert.equal(displayStatus(idle), 'working');
  assert.equal(isAgentsOnly(idle), true);
  assert.equal(agentsLabel(idle), '2 agents running');
  assert.equal(agentsLabel(1), '1 agent running');
  assert.equal(agentsLabel(0), '');
  assert.equal(idle.status, 'idle');
  assert.equal(displayStatus({ status: 'idle', agentsRunning: 0 }), 'idle');
  assert.equal(displayStatus({ status: 'waiting', agentsRunning: 3 }), 'waiting', 'needs-you wins');
  assert.equal(displayStatus({ status: 'error', agentsRunning: 3 }), 'error');
  assert.equal(displayStatus({ status: 'closed', agentsRunning: 0 }), 'closed');
  assert.equal(isAgentsOnly({ status: 'working', agentsRunning: 2 }), false);
  // eta fallback only while a turn runs
  assert.equal(agentsRunningOf({ status: 'working', eta: { agentsRunning: 4 } }), 4);
  assert.equal(agentsRunningOf({ status: 'idle', eta: { agentsRunning: 4 } }), 0);
  assert.equal(displayStatus(null), 'idle');
});
