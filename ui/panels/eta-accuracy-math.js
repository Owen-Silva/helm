// Owner: lane eta-accuracy (2026-10-17). Pure math for Usage > Estimates: how accurate the eta mod's estimates
// are, from its finished-task history (engine method eta.accuracy, main/engine/eta-accuracy.js). No imports, so
// node:test loads it directly (test/host/eta-accuracy.test.js).
//
// A record: { first, took, firstAt, finishedAt, factor, range, end, project, session, reEstimates }, minutes.
// "As shown" = first × factor (the calibrated number the band showed; factor null = shown as said).
// "Within ±25%": |estimate − actual| ≤ 25% of the actual. "Typical miss": e^(mean |ln(actual/estimate)|),
// so 2× = typically off by a factor of two either way.
//
// factorFor() mirrors the mod's calibration (~/.claude/mods/eta/hooks/core.ts, adjust() with ADJUST):
// the median took/said of the last 30 finished estimates within 2× of this one's size, from 3 of them,
// clamped to 0.75–3×; within 5% of 1× is shown as said. With 5+ of them whose middle half (25–75%) spans
// 1.5× or more, the band shows that span as a range. Keep the two in step if either changes.

export const CAL_KEEP = 30;
export const CAL_MIN_SAMPLES = 3;
export const CAL_MIN_RATIO = 0.75;
export const CAL_MAX_RATIO = 3;
export const CAL_MATCH = 2;
export const RANGE_Q = [0.25, 0.75];
export const RANGE_MIN_N = 5;
export const RANGE_MIN_WIDTH = 1.5;
/** The headline numbers cover this many most recent tasks. */
export const RECENT_N = 30;
/** The trend compares the last TREND_N tasks with the TREND_N before them. */
export const TREND_N = 15;
/** The rolling median line in the chart: trailing window of this many tasks. */
export const ROLL_N = 9;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Quantile linear between the items' midpoints ((i + 0.5) / n): the mod's weightedQuantile with equal weights. */
export function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  if (n === 1) return s[0];
  const t = Math.min(Math.max(q, 0.5 / n), 1 - 0.5 / n);
  const pos = t * n - 0.5;
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < n ? s[i] + (s[i + 1] - s[i]) * f : s[n - 1];
}

const usable = (r) => r && isNum(r.first) && isNum(r.took) && r.first >= 1 && r.took > 0 && isNum(r.finishedAt);
export const shownOf = (r) => r.first * (isNum(r.factor) ? r.factor : 1);
export const isWithin = (est, actual, k = 0.25) => Math.abs(est - actual) <= k * actual;

/** The calibration the band would apply now to an estimate of `minutes`, from finished ones. */
export function factorFor(records, minutes) {
  const recent = records.filter(usable).sort((a, b) => a.finishedAt - b.finishedAt).slice(-CAL_KEEP);
  const near = recent.filter((r) => r.first >= minutes / CAL_MATCH && r.first <= minutes * CAL_MATCH);
  if (near.length < CAL_MIN_SAMPLES) return { factor: null, n: near.length, range: null, enough: false };
  const ratios = near.map((r) => r.took / r.first);
  const f = Math.min(CAL_MAX_RATIO, Math.max(CAL_MIN_RATIO, median(ratios)));
  const factor = Math.abs(f - 1) >= 0.05 ? f : null;
  let range = null;
  if (near.length >= RANGE_MIN_N) {
    const c = factor ?? 1;
    const lo = Math.min(c, Math.max(0.05, quantile(ratios, RANGE_Q[0])));
    const hi = Math.max(c, Math.min(CAL_MAX_RATIO * 2, quantile(ratios, RANGE_Q[1])));
    if (hi / lo >= RANGE_MIN_WIDTH) range = [lo, hi];
  }
  return { factor, n: near.length, range, enough: true };
}

function score(rs, est) {
  if (!rs.length) return { n: 0, within25: null, within50: null, miss: null, late: null };
  const n = rs.length;
  const logs = rs.map((r) => Math.log(r.took / est(r)));
  return {
    n,
    within25: rs.filter((r) => isWithin(est(r), r.took, 0.25)).length / n,
    within50: rs.filter((r) => isWithin(est(r), r.took, 0.5)).length / n,
    miss: Math.exp(logs.reduce((a, e) => a + Math.abs(e), 0) / n),
    late: rs.filter((r) => r.took > est(r) * 1.25).length / n,
  };
}

/**
 * Everything the section shows. -> null for no usable records, else
 * { n, total, shown, raw, typicalRatio, factorNow[], trend, points[], rolling[], recent[], since }
 */
export function summarize(records, { recentN = RECENT_N, trendN = TREND_N, rollN = ROLL_N, listN = 8 } = {}) {
  const ok = (Array.isArray(records) ? records : []).filter(usable).sort((a, b) => a.finishedAt - b.finishedAt);
  if (!ok.length) return null;
  const last = ok.slice(-recentN);
  const shown = score(last, shownOf);
  const raw = score(last, (r) => r.first);
  const typicalRatio = median(last.map((r) => r.took / r.first));
  const factorNow = [10, 30, 90].map((minutes) => ({ minutes, ...factorFor(ok, minutes) }));
  let trend = null;
  const k = Math.min(trendN, Math.floor(ok.length / 2));
  if (k >= 5) {
    const recent = score(ok.slice(-k), shownOf);
    const before = score(ok.slice(-2 * k, -k), shownOf);
    const verdict = recent.miss < before.miss * 0.9 ? 'better' : recent.miss > before.miss * 1.1 ? 'worse' : 'same';
    trend = { k, recent, before, verdict };
  }
  const points = ok.map((r) => ({ at: r.finishedAt, firstAt: r.firstAt, ratio: r.took / shownOf(r), said: r.first, shown: shownOf(r), took: r.took, factor: isNum(r.factor) ? r.factor : null, range: r.range || null, project: r.project || null, end: r.end }));
  const rolling = [];
  for (let i = Math.min(rollN, 5) - 1; i < points.length; i++) {
    const win = points.slice(Math.max(0, i - rollN + 1), i + 1);
    rolling.push({ at: points[i].at, ratio: median(win.map((p) => p.ratio)) });
  }
  return { n: last.length, total: ok.length, shown, raw, typicalRatio, factorNow, trend, points, rolling, recent: points.slice(-listN).reverse(), since: ok[0].finishedAt };
}

/** `<1m`, `45m`, `1h30m` from minutes. */
export function fmtMin(m) {
  if (!isNum(m)) return '–';
  const r = Math.round(m);
  if (r < 1) return '<1m';
  if (r < 60) return `${r}m`;
  return `${Math.floor(r / 60)}h${String(r % 60).padStart(2, '0')}m`;
}

/** `0.8×`, `1.6×`, `12×`; two decimals for a calibration factor (`0.75×`). */
export function fmtRatio(r, digits = 1) {
  if (!isNum(r)) return '–';
  const x = r >= 10 ? String(Math.round(r)) : r.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return `${x}×`;
}

/** "work takes ~0.7× the estimate" / "estimates run ~1.4× long", as the eta band words it. */
export function ratioPhrase(r) {
  if (!isNum(r)) return '';
  return r >= 1 ? `estimates run ~${fmtRatio(r)} long` : `work takes ~${fmtRatio(r)} the estimate`;
}

export const fmtShare = (p) => (isNum(p) ? `${Math.round(p * 100)}%` : '–');
