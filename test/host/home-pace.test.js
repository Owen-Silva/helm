// Unit tests for ui/lib/pace.js: Home's 5-hour pace verdict. Thresholds follow the pace mod's paceView()
// (~/.claude/mods/pace/hooks/pace.ts); the projection is the backtested fade model (lane helm-pace,
// tools/pace-backtest.js; its error budget is pinned in pace-backtest.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { paceOf, paceChip, fmtDuration } = require('../../ui/lib/pace.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 8, 21, 0, 0);
const fh = (percent, resetsInMs) => ({ percent, resetsAt: NOW + resetsInMs });
const clock = (ms) => `@${(ms - NOW) / MIN}m`;   // a stand-in wall clock, so tests do not depend on the locale

test("the mod's own example: 19% used, 4h29m elapsed, resets in 30m -> burn 4.2%/h, about 21% at reset, under pace", () => {
  const p = paceOf(fh(19, 30.5 * MIN), NOW);
  assert.equal(p.verdict, 'under');
  assert.equal(fmtDuration(p.elapsedMs), '4h29m');
  assert.equal(fmtDuration(p.remainingMs), '30m');
  assert.equal(Math.round(p.burnPerHour * 10) / 10, 4.2);
  assert.equal(Math.round(p.projectedFinal), 21);
  const c = paceChip(p, clock);
  assert.equal(c.label, 'Under pace');
  assert.equal(c.tone, 'quiet');
  assert.equal(c.reset, 'resets in 30m');             // inside the last hour: a countdown, not a clock time
  assert.match(c.title, /5-hour 19% used · 4h29m elapsed · resets in 30m/);
  assert.match(c.title, /Burn 4\.2%\/h so far \(even pace is 20\.0%\/h\)/);
  assert.match(c.title, /Projection about 21% at reset \(reading <1m old\)/);
  assert.match(c.title, /eases to a typical 5\.0%\/h within the hour/);
});

test('hot: 100% lands more than 30m before the reset', () => {
  // 85% after 3h: burn 28.3%/h fading to 5%/h -> 100% in 59m, 1h00m before the reset at 2h
  const p = paceOf(fh(85, 2 * HOUR), NOW);
  assert.equal(p.verdict, 'hot');
  assert.ok(Math.abs(p.burnPerHour - 85 / 3) < 1e-9);
  assert.equal(Math.round(p.projectedFinal), 106);
  assert.equal(fmtDuration(p.hitInMs), '59m');
  assert.equal(fmtDuration(p.hitBeforeResetMs), '1h00m');
  const c = paceChip(p, clock);
  assert.equal(c.label, 'Hot');
  assert.equal(c.tone, 'warn');
  assert.equal(c.reset, `resets ${clock(NOW + 2 * HOUR)}`);   // an hour or more away: the clock time
  assert.match(c.title, /Projection 100% in 59m, 1h00m before reset \(reading <1m old\)/);
});

test('a burst is not hot: the burn fades (the straight line called this hot; in the backtest it never was)', () => {
  // 60% after 2h = 30%/h: the straight line said 100% in 1h20m; the fade model says about 87% at the reset
  const p = paceOf(fh(60, 3 * HOUR), NOW);
  assert.equal(p.verdict, 'under');
  assert.equal(Math.round(p.projectedFinal), 87);
  assert.equal(p.hitInMs, null);
  assert.equal(paceChip(p, clock).label, 'Under pace');
});

test('hot needs 100% to land MORE than 30m before the reset', () => {
  // 80% after 3h: 100% lands 6m before the reset -> not hot (on pace)
  const a = paceOf(fh(80, 2 * HOUR), NOW);
  assert.equal(a.verdict, 'on');
  assert.equal(fmtDuration(a.hitBeforeResetMs), '6m');
  // 82% after 3h: 100% lands 31m before the reset -> hot
  const b = paceOf(fh(82, 2 * HOUR), NOW);
  assert.equal(b.verdict, 'hot');
  assert.equal(fmtDuration(b.hitBeforeResetMs), '31m');
});

test('on pace: the projection leaves less than one round (6 pts) after the 5-pt margin', () => {
  // 75% after 3h = 25%/h: about 95% at reset; spare 0 < 6 -> on; 100% not reached before the reset -> not hot
  const p = paceOf(fh(75, 2 * HOUR), NOW);
  assert.equal(p.verdict, 'on');
  assert.equal(Math.round(p.projectedFinal), 95);
  assert.equal(p.hitInMs, null);
  const c = paceChip(p, clock);
  assert.equal(c.label, 'On pace');
  assert.equal(c.tone, 'neutral');
  assert.match(c.title, /Projection about 95% at reset/);
});

test('early in the window (under 20m): no burn or projection, verdict early, never a fake under/hot', () => {
  const p = paceOf(fh(4, 5 * HOUR - 10 * MIN), NOW);
  assert.equal(p.verdict, 'early');
  assert.equal(p.burnPerHour, null);
  assert.equal(p.projectedFinal, null);
  const c = paceChip(p, clock);
  assert.equal(c.label, 'Early');
  assert.match(c.title, /not projected yet \(needs 20m of the window; 10m so far\)/);
  assert.doesNotMatch(c.title, /Burn \d/);
});

test('pinned at 100%: Limit reached, amber', () => {
  const p = paceOf(fh(100, 90 * MIN), NOW);
  assert.equal(p.verdict, 'pinned');
  const c = paceChip(p, clock);
  assert.equal(c.label, 'Limit reached');
  assert.equal(c.tone, 'warn');
});

test('a reset more than 5h away is clamped to the window, like the mod', () => {
  const p = paceOf(fh(10, 6 * HOUR), NOW);
  assert.equal(p.remainingMs, 5 * HOUR);
  assert.equal(p.elapsedMs, 0);
  assert.equal(p.verdict, 'early');
});

test('missing data shows nothing: no reading, no window, no reset time, reset already passed, bad numbers', () => {
  assert.equal(paceOf(null, NOW), null);
  assert.equal(paceOf(undefined, NOW), null);
  assert.equal(paceOf({ percent: 30 }, NOW), null);
  assert.equal(paceOf({ resetsAt: NOW + HOUR }, NOW), null);
  assert.equal(paceOf({ percent: null, resetsAt: NOW + HOUR }, NOW), null);
  assert.equal(paceOf({ percent: '30', resetsAt: NOW + HOUR }, NOW), null);
  assert.equal(paceOf(fh(30, 0), NOW), null);
  assert.equal(paceOf(fh(30, -5 * MIN), NOW), null);
  assert.equal(paceChip(null, clock), null);
});

test('fmtDuration matches the mod: 2h41m, 41m, <1m', () => {
  assert.equal(fmtDuration(2 * HOUR + 41 * MIN + 59_000), '2h41m');
  assert.equal(fmtDuration(41 * MIN), '41m');
  assert.equal(fmtDuration(30_000), '<1m');
  assert.equal(fmtDuration(2 * HOUR), '2h00m');
});

// lane accuracy (2026-10-14): an old reading's burn is its percent over the time the window had run WHEN it
// was read, and the projection runs from the reading. lane helm-pace: the chip says how old the reading is, and
// a reading over 1 h old is not projected at all (past that, the backtest error grows by over half a round).
test('an old reading: burn measured at the reading, projection from the reading, its age shown', () => {
  const f = fh(40, 2 * HOUR);              // the window started at NOW - 3 h
  const p = paceOf(f, NOW, NOW - HOUR);    // read 2 h in, shown 1 h later
  assert.ok(Math.abs(p.burnPerHour - 20) < 1e-9, '40% over the 2 h the window had run at the reading');
  assert.equal(p.basisAgeMs, HOUR);
  assert.equal(Math.round(p.projectedFinal), 62);   // 3 h from the reading to the reset
  assert.equal(p.verdict, 'under');
  assert.match(paceChip(p, clock).title, /Projection about 62% at reset \(reading 1h00m old\)/);
  assert.match(paceChip(p, clock).title, /^5-hour 40% used · 2h00m elapsed at the reading · resets in 2h00m/);
  // at == now is the plain call exactly.
  assert.deepStrictEqual(paceOf(f, NOW, NOW), paceOf(f, NOW));
});

test('a reading over 1 h old is not projected: verdict stale, quiet, says why', () => {
  for (const [age, shown] of [[61 * MIN, '1h01m'], [2 * HOUR, '2h00m']]) {
    const p = paceOf(fh(40, 2 * HOUR), NOW, NOW - age);
    assert.equal(p.verdict, 'stale');
    assert.equal(p.projectedFinal, null);
    assert.equal(p.burnPerHour, null);
    assert.equal(p.hitInMs, null);
    const c = paceChip(p, clock);
    assert.equal(c.label, 'Old reading');
    assert.equal(c.tone, 'quiet');
    assert.ok(c.title.includes(`Not projected: the reading is ${shown} old (the limit is 1h00m)`), c.title);
    assert.doesNotMatch(c.title, /Projection/);
  }
  // a reading at 100% stays "Limit reached" however old: the window cannot go back down before it resets
  assert.equal(paceOf(fh(100, 2 * HOUR), NOW, NOW - 2 * HOUR).verdict, 'pinned');
});
