// lane accuracy (2026-10-14): number formatting that must never overstate or round to a limit.
//   ui/panels/util.js  fmtPct / fmtAgo (Usage panel, meters, fleet)
//   ui/lib/eta-info.js etaInfo (header, sidebar, deck, Elsewhere): day-aware finish time + its basis
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fmtPct, fmtAgo, fmtCost } = require('../../ui/panels/util.js');
const { etaInfo, ETA_BASIS } = require('../../ui/lib/eta-info.js');

const MIN = 60_000;
const HOUR = 60 * MIN;

test('fmtPct: whole percents never round a meter to a limit it has not reached', () => {
  assert.equal(fmtPct(0.4), '<1%', 'some use is not 0%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(99.6), '99%', '99.6 is not the limit');
  assert.equal(fmtPct(100), '100%');
  assert.equal(fmtPct(104), '104%');
  assert.equal(fmtPct(26), '26%');
  assert.equal(fmtPct(24.5), '25%');
  assert.equal(fmtPct(99.6, 1), '99.6%');
  assert.equal(fmtPct(null), '—');
});

test('fmtAgo: whole units elapsed (floor), like a clock', () => {
  const now = Date.UTC(2026, 9, 14, 20, 0, 0);
  assert.equal(fmtAgo(now - 30 * 1000, now), 'just now');
  assert.equal(fmtAgo(now - 50 * 1000, now), '1m ago');
  assert.equal(fmtAgo(now - 59.7 * MIN, now), '59m ago', 'not "60m ago"');
  assert.equal(fmtAgo(now - 90 * MIN, now), '1h ago', 'not "2h ago"');
  assert.equal(fmtAgo(now - 23.9 * HOUR, now), '23h ago');
  assert.equal(fmtAgo(now - 36 * HOUR, now), '1d ago');
});

test('fmtCost: Claude Code figures, cents; unknown is a dash, never $0', () => {
  assert.equal(fmtCost(116.5575924), '$116.56');
  assert.equal(fmtCost(0.004), '<$0.01');
  assert.equal(fmtCost(null), '—');
  assert.equal(fmtCost(1234.4), '$1,234.40');
});

test('etaInfo: a finish on another day names the day; every ETA carries its basis', () => {
  const now = new Date(2026, 9, 14, 22, 50, 0).getTime(); // 10:50 PM local
  const soon = etaInfo({ etaAt: now + 14 * MIN, state: 'working' }, true, now);
  assert.equal(soon.long, '~14 min left');
  assert.ok(!/tomorrow/.test(soon.done), soon.done);
  assert.equal(soon.basis, ETA_BASIS);
  assert.ok(soon.title.endsWith(ETA_BASIS));
  const late = etaInfo({ etaAt: now + 2 * HOUR, state: 'working' }, true, now); // 12:50 AM
  assert.match(late.done, /^tomorrow /, 'a bare "12:50" would read as today');
  const far = etaInfo({ etaAt: now + 50 * HOUR, state: 'working' }, true, now);
  assert.match(far.done, /^[A-Za-z]{3} /);
  assert.equal(etaInfo({ etaAt: now + MIN, state: 'idle' }, true, now), null);
  assert.equal(etaInfo({ etaAt: null, state: 'working' }, true, now), null, 'no estimate: nothing, never a guess');
});
