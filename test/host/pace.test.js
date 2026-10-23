// Unit tests for ui/panels/pace-math.js (Usage panel, 5-hour pace line): burn rate since the window
// opened, projected % at reset, and the under / on / hot verdict. The UI module is ESM with one pure
// import (../lib/pace.js), so require(esm) loads it directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { paceReadout, windowPoints, fmtLeft, FIVE_H } = require('../../ui/panels/pace-math.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const OPEN = Date.UTC(2026, 9, 8, 12, 0, 0);   // window opened
const RESET = OPEN + FIVE_H;
const s = (atMin, pct, extra = {}) => ({ ts: OPEN + atMin * MIN, fiveHour: pct, week: 10, fiveHourResetsAt: RESET, ...extra });

// lane helm-pace: the projection is projectFrom() in ui/lib/pace.js (the rate eases to a typical 5%/h within the
// hour); carrying the rate straight to the reset ran high in the backtest (tools/pace-backtest.js).
test("the user's example: 7.2%/h, about 30% at reset, under pace", () => {
  // 2 h in at 14.4%: 7.2%/h, easing to 5%/h over the 3 h left -> 14.4 + 15 + 2.2 * 0.5 * (1 - e^-6) = 30.5
  const r = paceReadout({ samples: [s(0, 0), s(60, 7.2), s(120, 14.4)], resetsAt: RESET, now: OPEN + 120 * MIN });
  assert.equal(r.state, 'ok');
  assert.equal(r.verdict, 'under');
  assert.ok(Math.abs(r.rate - 7.2) < 1e-9);
  assert.ok(Math.abs(r.projected - (14.4 + 15 + 1.1 * (1 - Math.exp(-6)))) < 1e-9);
  assert.equal(r.text, '7.2%/h · about 30% at reset · under pace');
});

test('on pace: ends at 85%+, or lands 100% inside the last half hour', () => {
  // 70% at 3 h: about 89% at reset -> on pace without touching 100
  const a = paceReadout({ samples: [s(0, 0), s(180, 70)], resetsAt: RESET, now: OPEN + 180 * MIN });
  assert.equal(a.verdict, 'on');
  assert.equal(a.hitAt, null);
  assert.equal(a.text, '23%/h · about 89% at reset · on pace');
  // 80% at 3 h: 100% lands 7 min before reset, inside the 30 min margin -> still on pace
  const b = paceReadout({ samples: [s(0, 0), s(180, 80)], resetsAt: RESET, now: OPEN + 180 * MIN });
  assert.equal(b.verdict, 'on');
  assert.equal(Math.round((RESET - b.hitAt) / MIN), 7);
  assert.match(b.text, /about 100% at reset · on pace$/);
});

test('hot: 100% lands more than 30 min before reset', () => {
  // 84% at 3 h: 100% about 52 min before reset
  const r = paceReadout({ samples: [s(0, 0), s(180, 84)], resetsAt: RESET, now: OPEN + 180 * MIN });
  assert.equal(r.verdict, 'hot');
  assert.equal(Math.round((RESET - r.hitAt) / MIN), 52);
  assert.equal(r.text, '28%/h · 100% about 52m before reset · hot');
  // already pinned with an hour left
  const p = paceReadout({ samples: [s(0, 10), s(240, 100)], resetsAt: RESET, now: OPEN + 240 * MIN });
  assert.equal(p.verdict, 'hot');
  assert.match(p.text, /at 100% with 1h left · hot$/);
  // 82% at 3 h: 100% lands 31 min before reset -> just hot
  const q = paceReadout({ samples: [s(0, 0), s(180, 82)], resetsAt: RESET, now: OPEN + 180 * MIN });
  assert.equal(q.verdict, 'hot');
});

test('a one-hour burst is not hot: 40%/h for the first hour eases off (the straight line said hot)', () => {
  const r = paceReadout({ samples: [s(0, 0), s(30, 20), s(60, 40)], resetsAt: RESET, now: OPEN + 60 * MIN });
  assert.equal(r.verdict, 'under');
  assert.equal(r.hitAt, null);
  assert.equal(r.text, '40%/h · about 77% at reset · under pace');
});

test('not enough samples: says so plainly instead of guessing', () => {
  const none = paceReadout({ samples: [], resetsAt: RESET, now: OPEN + 30 * MIN });
  assert.equal(none.state, 'few');
  assert.match(none.text, /^Not enough readings for a pace yet \(none in this window/);
  const one = paceReadout({ samples: [s(20, 4)], resetsAt: RESET, now: OPEN + 30 * MIN });
  assert.equal(one.state, 'few');
  assert.equal(one.n, 1);
  assert.match(one.text, /\(one in this window/);
  // samples from the previous window never count toward this one
  const prev = [{ ts: OPEN - 30 * MIN, fiveHour: 80, fiveHourResetsAt: OPEN }, { ts: OPEN - 10 * MIN, fiveHour: 90, fiveHourResetsAt: OPEN }];
  assert.equal(paceReadout({ samples: [...prev, s(20, 4)], resetsAt: RESET, now: OPEN + 30 * MIN }).state, 'few');
  // a sample inside the time range but tagged with another window's reset is dropped too
  assert.equal(windowPoints([s(10, 3, { fiveHourResetsAt: RESET + HOUR }), s(20, 4)], RESET, OPEN + 30 * MIN).length, 1);
  // null readings are not readings
  assert.equal(paceReadout({ samples: [s(10, null), s(20, 4)], resetsAt: RESET, now: OPEN + 30 * MIN }).state, 'few');
  // two readings a minute apart say nothing about a rate
  assert.equal(paceReadout({ samples: [s(10, 3), s(11, 4)], resetsAt: RESET, now: OPEN + 12 * MIN }).state, 'few');
});

test('unknown reset time, or outside one window: no pace', () => {
  assert.equal(paceReadout({ samples: [s(0, 0), s(60, 10)], resetsAt: null, now: OPEN + 60 * MIN }).state, 'unknown');
  assert.equal(paceReadout({ samples: [s(0, 0), s(60, 10)], resetsAt: OPEN - MIN, now: OPEN + 60 * MIN }).state, 'unknown');
  assert.equal(paceReadout({}).state, 'unknown');
});

test('the live reading extends the newest point; flat use is 0%/h; order does not matter', () => {
  const r = paceReadout({ samples: [s(60, 10), s(0, 0)], resetsAt: RESET, now: OPEN + 120 * MIN, live: { percent: 20, at: OPEN + 120 * MIN } });
  assert.ok(Math.abs(r.rate - 10) < 1e-9);
  assert.equal(r.text, '10%/h · about 37% at reset · under pace');
  // a live reading older than the samples is ignored
  const old = paceReadout({ samples: [s(0, 0), s(60, 10)], resetsAt: RESET, now: OPEN + 90 * MIN, live: { percent: 99, at: OPEN + 30 * MIN } });
  assert.ok(Math.abs(old.rate - 10) < 1e-9);
  const flat = paceReadout({ samples: [s(0, 12), s(60, 12)], resetsAt: RESET, now: OPEN + 60 * MIN });
  assert.equal(flat.rate, 0);
  assert.equal(flat.hitAt, null);
  // flat so far: still expected to pick up to a typical 5%/h (12 + 20 - 2.5 * (1 - e^-8))
  assert.equal(flat.text, '0.0%/h · about 30% at reset · under pace');
});

test('fmtLeft', () => {
  assert.equal(fmtLeft(0), '0m');
  assert.equal(fmtLeft(40 * MIN), '40m');
  assert.equal(fmtLeft(60 * MIN), '1h');
  assert.equal(fmtLeft(65 * MIN), '1h 05m');
});
