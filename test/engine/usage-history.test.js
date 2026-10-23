'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageHistory, dayKey } = require('../../main/engine/usage-history');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function setup(start = new Date(2026, 9, 8, 15, 0, 0).getTime()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-uh-'));
  const file = path.join(dir, 'usage-history.jsonl');
  const clock = { t: start };
  const logs = [];
  const make = () => new UsageHistory({ file, now: () => clock.t, log: (lvl, msg) => logs.push([lvl, msg]) });
  return { dir, file, clock, logs, make };
}
const u = (fh, wk, fhR = null, wkR = null) => ({
  fiveHour: fh == null ? null : { percent: fh, resetsAt: fhR },
  week: wk == null ? null : { percent: wk, resetsAt: wkR },
  source: 'statusline',
});
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('sample dedupes identical readings inside the interval, records again after it', () => {
  const { clock, make, file } = setup();
  const h = make();
  assert.ok(h.sample(u(10, 40, 1000, 2000)));
  clock.t += MIN;
  assert.strictEqual(h.sample(u(10, 40, 1000, 2000)), null, 'same reading 1 min later is skipped');
  clock.t += 3 * MIN;
  assert.strictEqual(h.sample(u(10, 40, 1000, 2000)), null, 'still inside 5 min');
  clock.t += 1 * MIN; // 5 min since first
  assert.ok(h.sample(u(10, 40, 1000, 2000)), 'same reading after 5 min is recorded');
  assert.strictEqual(h.history().samples.length, 2);
  assert.strictEqual(lines(file).length, 2);
});

test('a changed reading is recorded immediately', () => {
  const { clock, make } = setup();
  const h = make();
  h.sample(u(10, 40, 1000, 2000));
  clock.t += 10_000;
  assert.ok(h.sample(u(11, 40, 1000, 2000)), 'percent change');
  clock.t += 10_000;
  assert.ok(h.sample(u(11, 40.5, 1000, 2000)), 'fractional week change');
  clock.t += 10_000;
  assert.ok(h.sample(u(11, 40.5, 1000 + 5 * HOUR, 2000)), 'resetsAt change');
  clock.t += 10_000;
  assert.strictEqual(h.sample(u(11, 40.5, 1000 + 5 * HOUR + 2000, 2000)), null, 'reset jitter under a minute is the same reset');
  const s = h.history().samples;
  assert.strictEqual(s.length, 4);
  assert.deepStrictEqual(s[1], { ts: s[1].ts, fiveHour: 11, week: 40, fiveHourResetsAt: 1000, weekResetsAt: 2000 });
  assert.strictEqual(s[2].week, 40.5);
});

test('null usage is skipped; one known window is enough', () => {
  const { make, file } = setup();
  const h = make();
  assert.strictEqual(h.sample(null), null);
  assert.strictEqual(h.sample(undefined), null);
  assert.strictEqual(h.sample(u(null, null)), null);
  assert.strictEqual(h.sample({ fiveHour: { percent: null }, week: { percent: NaN } }), null);
  assert.strictEqual(fs.existsSync(file), false, 'nothing written');
  const r = h.sample(u(null, 55));
  assert.deepStrictEqual(r && { fiveHour: r.fiveHour, week: r.week }, { fiveHour: null, week: 55 });
  assert.ok(!('fiveHourResetsAt' in r) && !('weekResetsAt' in r), 'unknown resets are omitted');
});

test('addCost aggregates by local day and project, rounds to 1e-6, ignores junk', () => {
  const { clock, make } = setup(new Date(2026, 9, 8, 15, 0, 0).getTime());
  const h = make();
  h.addCost({ usd: 0.1, sessionId: 'a', project: 'Storefront' });
  h.addCost({ usd: 0.2, sessionId: 'b', project: 'Storefront' });
  h.addCost({ usd: 1.0000004, sessionId: 'c', project: 'helm' });
  h.addCost({ usd: 0.5, sessionId: 'd' }); // no project
  assert.strictEqual(h.addCost({ usd: 0, project: 'x' }), null);
  assert.strictEqual(h.addCost({ usd: -1, project: 'x' }), null);
  assert.strictEqual(h.addCost({ usd: Infinity, project: 'x' }), null);
  assert.strictEqual(h.addCost({ usd: 'nope', project: 'x' }), null);
  // Yesterday 23:30 local and today 00:30 local land on different days.
  const today0 = new Date(2026, 9, 8, 0, 0, 0).getTime();
  h.addCost({ usd: 2, project: 'Booking', ts: today0 - 30 * MIN });
  h.addCost({ usd: 3, project: 'Booking', ts: today0 + 30 * MIN });
  const { costByDay } = h.history({ days: 2 });
  assert.deepStrictEqual(costByDay.map((d) => d.day), ['2026-10-07', '2026-10-08']);
  assert.deepStrictEqual(costByDay[0], { day: '2026-10-07', usd: 2, byProject: { Booking: 2 } });
  assert.strictEqual(costByDay[1].usd, 4.8);
  assert.deepStrictEqual(costByDay[1].byProject, { Storefront: 0.3, helm: 1, Other: 0.5, Booking: 3 });
  assert.strictEqual(dayKey(today0 + 30 * MIN), '2026-10-08');
  void clock;
});

test('costByDay zero-fills every day in range, oldest first', () => {
  const { clock, make } = setup(new Date(2026, 9, 8, 9, 0, 0).getTime());
  const h = make();
  h.addCost({ usd: 1, project: 'helm', ts: clock.t - 3 * DAY });
  const { costByDay } = h.history({ days: 7 });
  assert.strictEqual(costByDay.length, 7);
  assert.deepStrictEqual(costByDay.map((d) => d.day), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.deepStrictEqual(costByDay.map((d) => d.usd), [0, 0, 0, 1, 0, 0, 0]);
  assert.deepStrictEqual(costByDay[0].byProject, {});
});

test('history({days}) clamps to 1..14 and filters samples to the window', () => {
  const { clock, make } = setup();
  const h = make();
  const start = clock.t;
  for (let i = 0; i < 16; i++) { h.sample(u(i, i)); clock.t += DAY; }
  clock.t = start + 15 * DAY + HOUR;
  assert.strictEqual(h.history().samples.length, 1, 'default is 1 day');
  assert.strictEqual(h.history({ days: 0 }).costByDay.length, 1);
  assert.strictEqual(h.history({ days: -5 }).costByDay.length, 1);
  assert.strictEqual(h.history({ days: 'abc' }).costByDay.length, 1);
  assert.strictEqual(h.history({ days: 99 }).costByDay.length, 14);
  assert.strictEqual(h.history({ days: 3.9 }).costByDay.length, 3);
  const s = h.history({ days: 3 }).samples;
  assert.strictEqual(s.length, 3);
  assert.ok(s.every((x, i) => i === 0 || x.ts > s[i - 1].ts), 'ascending');
  assert.ok(h.history({ days: 14 }).samples.length <= 14);
});

test('lines older than 14 days are pruned on reload and the file is rewritten', () => {
  const { clock, make, file } = setup();
  const h = make();
  h.sample(u(5, 20));
  h.addCost({ usd: 1, project: 'Storefront' });
  clock.t += 10 * DAY;
  h.sample(u(6, 21));
  assert.strictEqual(lines(file).length, 3);
  clock.t += 5 * DAY; // first two are now 15 days old
  const h2 = make();
  assert.deepStrictEqual(lines(file).map((r) => r.k), ['s'], 'old lines gone from disk');
  assert.strictEqual(h2.history({ days: 14 }).samples.length, 1);
  assert.strictEqual(h2.history({ days: 14 }).costByDay.reduce((t, d) => t + d.usd, 0), 0);
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')), 'no tmp left behind');
});

test('a long-running instance prunes at most hourly while appending', () => {
  const { clock, make, file } = setup();
  const h = make();
  h.sample(u(1, 1));
  clock.t += 15 * DAY;
  h.sample(u(2, 2)); // > 1 h since construction → prune + rewrite
  assert.deepStrictEqual(lines(file).map((r) => r.fiveHour), [2]);
  assert.strictEqual(h.history({ days: 14 }).samples.length, 1);
});

test('corrupt and partial lines are skipped, never fatal', () => {
  const { make, file, logs, clock } = setup();
  const good = { k: 's', ts: clock.t - HOUR, fiveHour: 30, week: 50 };
  fs.writeFileSync(file, [JSON.stringify(good), '{not json', '{"k":"s","ts":"x"}', '{"k":"zz","ts":1}', JSON.stringify({ k: 'c', ts: clock.t - HOUR, usd: 0.25, project: 'helm', v: 2 }), '{"k":"s","ts":12'].join('\n'));
  const h = make();
  const hist = h.history();
  assert.strictEqual(hist.samples.length, 1);
  assert.strictEqual(hist.samples[0].fiveHour, 30);
  assert.strictEqual(hist.costByDay.at(-1).usd, 0.25);
  assert.ok(logs.some(([lvl]) => lvl === 'warn'));
  assert.strictEqual(lines(file).length, 2, 'file rewritten clean');
  // Appending after the repair still works.
  assert.ok(h.sample(u(31, 50)));
});

test('reload from disk restores samples, costs and the dedupe baseline', () => {
  const { clock, make } = setup();
  const h = make();
  h.sample(u(12, 34, 111, 222));
  h.addCost({ usd: 0.75, sessionId: 's1', project: 'Storefront' });
  clock.t += MIN;
  const h2 = make();
  assert.deepStrictEqual(h2.history(), h.history());
  assert.strictEqual(h2.sample(u(12, 34, 111, 222)), null, 'last sample survives a restart for dedupe');
});

test('I/O errors are logged, not thrown', () => {
  const { dir, clock, logs } = setup();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x'); // a file where the parent directory should be
  const h = new UsageHistory({ file: path.join(blocker, 'usage-history.jsonl'), now: () => clock.t, log: (l, m) => logs.push([l, m]) });
  assert.doesNotThrow(() => h.sample(u(1, 2)));
  assert.doesNotThrow(() => h.addCost({ usd: 1, project: 'x' }));
  assert.ok(logs.some(([lvl]) => lvl === 'error'));
  assert.strictEqual(h.history().samples.length, 1, 'memory copy still serves history');
});

test('start samples immediately and stop clears the timer', () => {
  const { make } = setup();
  const h = make();
  let calls = 0;
  h.start(() => { calls++; return u(9, 9); });
  assert.strictEqual(calls, 1);
  assert.ok(h.timer);
  h.stop();
  assert.strictEqual(h.timer, null);
  assert.strictEqual(h.history().samples.length, 1);
  h.start(() => { throw new Error('boom'); }); // never throws out
  h.stop();
});

// lane accuracy (2026-10-14): cost records written before the fix re-added a conversation's lifetime cost on
// every resume. Shape taken from the user's real usage-history.jsonl (one "increment" was a $525.78 lifetime).
test('legacy (pre-fix) cost records are never summed: earlier days unknown, the fix day partial', () => {
  const { make, file, clock } = setup();
  const DAY = 24 * HOUR;
  fs.writeFileSync(file, [
    JSON.stringify({ k: 'c', ts: clock.t - 2 * DAY, usd: 525.78, sessionId: 's_a', project: 'helm' }),
    JSON.stringify({ k: 'c', ts: clock.t - 2 * HOUR, usd: 107.12, sessionId: 's_b', project: 'helm' }),
    JSON.stringify({ k: 's', ts: clock.t - HOUR, fiveHour: 24, week: 24 }),
  ].join('\n') + '\n');
  const h = make();
  assert.strictEqual(h.costSince, clock.t, 'v2 counting starts at load');
  assert.deepStrictEqual(h.costToday(), { usd: 0, since: clock.t });
  clock.t += MIN;
  h.addCost({ usd: 0.42, sessionId: 's_b', project: 'helm' });
  assert.deepStrictEqual(h.costToday(), { usd: 0.42, since: clock.t - MIN });
  const { costByDay, costSince } = h.history({ days: 3 });
  assert.strictEqual(costSince, clock.t - MIN);
  assert.strictEqual(costByDay[0].usd, null);
  assert.strictEqual(costByDay[0].unknown, true);
  assert.strictEqual(costByDay[1].usd, null, 'the $525.78 day is unknown, not $525.78');
  assert.strictEqual(costByDay[2].usd, 0.42);
  assert.strictEqual(costByDay[2].partial, true);
  // The marker survives a reload; no second marker.
  const h2 = make();
  assert.strictEqual(h2.costSince, clock.t - MIN);
  assert.strictEqual(lines(file).filter((l) => l.k === 'm').length, 1);
  assert.strictEqual(h2.costToday().usd, 0.42);
});

test('a file with only v2 costs needs no marker: every day is complete', () => {
  const { make, file, clock } = setup();
  fs.writeFileSync(file, JSON.stringify({ k: 'c', ts: clock.t - 30 * HOUR, usd: 1.5, project: 'x', v: 2 }) + '\n');
  const h = make();
  assert.strictEqual(h.costSince, null);
  const { costByDay } = h.history({ days: 3 });
  assert.ok(costByDay.every((d) => !d.unknown && !d.partial));
  assert.strictEqual(costByDay.reduce((t, d) => t + d.usd, 0), 1.5);
});

test('a stale reading (usage.stale) is not sampled as now', () => {
  const { make } = setup();
  const h = make();
  assert.strictEqual(h.sample({ ...u(30, 40), stale: true }), null);
  assert.ok(h.sample(u(30, 40)));
});
