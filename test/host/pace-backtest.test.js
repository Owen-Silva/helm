// The 5-hour pace projection's error budget, pinned on a fixed fixture of real readings (lane helm-pace,
// 2026-10-14). fixtures/pace-history.jsonl = the 5H samples of the user's usage-history.jsonl from Oct 8 to Oct 15
// (k, ts, fiveHour, fiveHourResetsAt only: percentages and times). tools/pace-backtest.js prints the full table;
// this test fails if a change to ui/lib/pace.js or ui/panels/pace-math.js makes the shipped projection worse.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bt = require('../../tools/pace-backtest.js');
const pace = require('../../ui/lib/pace.js');
const paceMath = require('../../ui/panels/pace-math.js');

const data = bt.loadWindows(fs.readFileSync(path.join(__dirname, 'fixtures', 'pace-history.jsonl'), 'utf8'));
const { windows } = data;
const MIN = 60_000;
const table = bt.evaluate(windows, { ages: [0, 1, 2], pace, paceMath, only: ['linear', 'master/mod', 'panel(old)', 'fade', 'panel(new)'] });

test('the fixture: 28 finished windows, 1400 readings, none reached 100%', () => {
  assert.equal(windows.length, 28);
  assert.equal(data.readings, 1400);
  assert.equal(data.glitches, 4);
  assert.ok(Math.max(...windows.map((w) => w.final)) < 100);
});

test("Home's projection (fade) stays inside its error budget at fresh, 1 h and 2 h old readings", () => {
  const budget = { 0: 12.5, 1: 15.0, 2: 17.8 };   // measured 12.1 / 14.7 / 17.4
  for (const A of [0, 1, 2]) {
    const s = table.fade[A];
    assert.ok(s.mae <= budget[A], `${A} h: MAE ${s.mae.toFixed(2)} over ${budget[A]}`);
    assert.ok(Math.abs(s.bias) <= 7.5, `${A} h: bias ${s.bias.toFixed(2)}`);
    assert.equal(s.falseHot, 0, `${A} h: false hot`);
    assert.equal(s.missedHot, 0);
    assert.ok(table.linear[A].mae - s.mae >= 6, `${A} h: should beat the straight line by 6+ points`);
  }
});

test('the Home chip as shipped: fresh and 1 h old readings are projected, 2 h old are not; never a false hot', () => {
  const chip = bt.evaluateChip(windows, pace, [0, 1, 2]);
  assert.equal(chip[0].shown, chip[0].n);
  assert.equal(chip[1].shown, chip[1].n);
  assert.equal(chip[2].shown, 0);
  assert.ok(chip[0].mae <= 12.5 && chip[1].mae <= 15.0);
  for (const A of [0, 1, 2]) assert.equal(chip[A].falseHot, 0);
});

test("the Usage panel's pace line (paceReadout as shipped) stays inside its budget and beats its old straight line", () => {
  const budget = { 0: 12.0, 1: 14.6, 2: 17.0 };   // measured 11.6 / 14.2 / 16.5
  for (const A of [0, 1, 2]) {
    const s = table['panel(new)'][A];
    assert.ok(s.mae <= budget[A], `${A} h: MAE ${s.mae.toFixed(2)} over ${budget[A]}`);
    assert.equal(s.falseHot, 0);
    assert.ok(table['panel(old)'][A].mae - s.mae >= 10);
  }
});

test('the old projections, for the record: the straight line runs high and calls false hots', () => {
  assert.ok(table.linear[0].bias > 5);
  assert.ok(table.linear[0].falseHot > 100);
  assert.equal(table['master/mod'][0].mae, table.linear[0].mae);   // the same formula on a fresh reading
});

test('a steady runaway is still called hot before 100% (later than the straight line did)', () => {
  for (const r of bt.runaways(pace, paceMath, ['fade', 'linear'])) {
    assert.ok(r.firstHot.fade != null, `${r.label}: fade never said hot`);
    assert.ok(r.hitAt - r.firstHot.fade >= 15 * MIN, `${r.label}: under 15 min of warning`);
  }
});

test('out of sample: a long-run rate learned on the first half still beats the straight line on the second', () => {
  const s = bt.splitHalf(windows, pace, paceMath);
  assert.ok(s.fadeFirstHalfRate.mae < s.linear.mae - 5);
  assert.ok(Math.abs(s.fadeFirstHalfRate.mae - s.fadeShipped.mae) < 1);
});
