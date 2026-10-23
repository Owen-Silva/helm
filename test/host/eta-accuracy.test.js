// lane eta-accuracy (2026-10-17): Usage > Estimates.
//   main/engine/eta-accuracy.js   readEtaHistory: async read of <etaDir>/history.jsonl (missing = no history)
//   ui/panels/eta-accuracy-math.js summarize / factorFor: the headline numbers, trend, chart points; factorFor
//                                  mirrors the eta mod's calibration (parity numbers below came from the mod's
//                                  own hooks/core.ts adjust(ADJUST) on the same samples, 2026-10-17)
// The fixture (test/host/fixtures/eta/history.jsonl) is synthetic: 24 tasks + 1 unreadable line. Never the user's file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readEtaHistory, parseHistory } = require('../../main/engine/eta-accuracy.js');
const M = require('../../ui/panels/eta-accuracy-math.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'eta');
const MIN = 60_000;
const rec = (first, took, i, extra = {}) => ({ first, took, firstAt: i * 3600_000, finishedAt: i * 3600_000 + took * MIN, factor: null, range: null, end: 'done', project: 'p', ...extra });

test('readEtaHistory: a missing file is no history yet, not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-eta-acc-'));
  try {
    const r = await readEtaHistory({ etaDir: dir });
    assert.equal(r.missing, true);
    assert.deepEqual(r.records, []);
    assert.equal(r.file, path.join(dir, 'history.jsonl'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readEtaHistory: the fixture reads as 24 records sorted by finish, with the unreadable line counted', async () => {
  const r = await readEtaHistory({ etaDir: FIXTURE_DIR });
  assert.equal(r.missing, false);
  assert.equal(r.records.length, 24);
  assert.equal(r.bad, 1);
  for (let i = 1; i < r.records.length; i++) assert.ok(r.records[i].finishedAt >= r.records[i - 1].finishedAt);
  const keys = Object.keys(r.records[0]).sort();
  assert.deepEqual(keys, ['end', 'factor', 'factorSrc', 'finishedAt', 'first', 'firstAt', 'project', 'range', 'reEstimates', 'session', 'took']);
});

test('readEtaHistory: a folder in place of the file rejects with the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-eta-acc-'));
  try {
    fs.mkdirSync(path.join(dir, 'history.jsonl'));
    await assert.rejects(readEtaHistory({ etaDir: dir }), /is not a file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseHistory keeps only known fields and skips what is not a record', () => {
  const { records, bad } = parseHistory('{"v":1,"first":10,"took":12,"firstAt":1,"finishedAt":2,"prompt":"secret"}\n{"v":2}\nnope\n\n');
  assert.equal(records.length, 1);
  assert.equal(bad, 2);
  assert.equal(records[0].prompt, undefined);
});

test('quantile matches the mod (midpoint rule) and median', () => {
  assert.equal(M.quantile([0.3, 0.4, 0.5, 0.6, 0.7], 0.25), 0.375);
  assert.equal(M.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(M.median([3, 1, 2]), 2);
});

test('factorFor mirrors the mod: the factor, "as said" below 3 similar, and the range', () => {
  const wide = [0.3, 0.5, 0.8, 1.2, 1.6, 2].map((r, i) => rec(30, 30 * r, i));
  assert.deepEqual(M.factorFor(wide, 30), { factor: null, n: 6, range: [0.5, 1.6], enough: true });
  const short = [0.3, 0.4, 0.5, 0.6, 0.7].map((r, i) => rec(30, 30 * r, i));
  assert.deepEqual(M.factorFor(short, 30), { factor: 0.75, n: 5, range: [0.375, 0.75], enough: true });
  assert.deepEqual(M.factorFor(wide.slice(0, 2), 30), { factor: null, n: 2, range: null, enough: false });
  assert.equal(M.factorFor(wide, 120).n, 0);
});

test('summarize on the fixture: parity with the mod for 10/30/90 min, headline, trend, points', async () => {
  const { records } = await readEtaHistory({ etaDir: FIXTURE_DIR });
  const s = M.summarize(records);
  // From the mod (adjust(ADJUST) on the same 24 samples): 10m as said (4 similar), 30m 0.9×, 90m 0.8×, no ranges.
  const f = Object.fromEntries(s.factorNow.map((x) => [x.minutes, x]));
  assert.equal(f[10].factor, null); assert.equal(f[10].n, 4);
  assert.equal(Math.round(f[30].factor * 1000) / 1000, 0.9); assert.equal(f[30].n, 20);
  assert.equal(Math.round(f[90].factor * 1000) / 1000, 0.8); assert.equal(f[90].n, 9);
  assert.ok(s.factorNow.every((x) => x.range === null));
  assert.equal(s.n, 24);
  assert.equal(s.total, 24);
  assert.equal(s.points.length, 24);
  assert.equal(s.recent.length, 8);
  assert.ok(s.recent[0].at > s.recent[7].at, 'newest first');
  // The fixture is noisy early and steady late: the trend says more accurate.
  assert.equal(s.trend.verdict, 'better');
  assert.equal(s.trend.k, 12);
  assert.ok(s.trend.recent.miss < s.trend.before.miss);
  // Shown = first × factor.
  for (const p of s.points) assert.equal(p.shown, p.said * (p.factor ?? 1));
});

test('summarize: within ±25% is measured against the actual; nothing usable is null', () => {
  const s = M.summarize([rec(10, 10, 1), rec(10, 13, 2), rec(10, 20, 3), rec(10, 7.9, 4)]);
  assert.equal(s.shown.within25, 0.5); // 10 vs 10 yes; 10 vs 13 yes (3 <= 3.25); 10 vs 20 no; 10 vs 7.9 no (2.1 > 1.975)
  assert.equal(s.trend, null);
  assert.equal(M.summarize([]), null);
  assert.equal(M.summarize([{ first: 0.5, took: 3, finishedAt: 1, firstAt: 0 }]), null);
});

test('formatting: minutes, ratios, shares, and the band wording', () => {
  assert.equal(M.fmtMin(0.4), '<1m');
  assert.equal(M.fmtMin(45), '45m');
  assert.equal(M.fmtMin(90), '1h30m');
  assert.equal(M.fmtRatio(0.75, 2), '0.75×');
  assert.equal(M.fmtRatio(0.8), '0.8×');
  assert.equal(M.fmtRatio(1), '1×');
  assert.equal(M.fmtRatio(2.5), '2.5×');
  assert.equal(M.fmtRatio(12.4), '12×');
  assert.equal(M.fmtShare(0.284), '28%');
  assert.equal(M.ratioPhrase(0.7), 'work takes ~0.7× the estimate');
  assert.equal(M.ratioPhrase(1.4), 'estimates run ~1.4× long');
});
