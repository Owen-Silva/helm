// 5-hour PACE verdict for Home's glance row (lane pace, 2026-10-08). Pure: no imports, so node tests load it
// directly (test/host/home-pace.test.js).
//
// Thresholds follow the user's pace mod (~/.claude/mods/pace/hooks/pace.ts paceView()). The PROJECTION does not
// (lane helm-pace, 2026-10-14): the mod's straight line (the window's average burn carried to the reset) was
// backtested on every real 5H reading in usage-history.jsonl (28 finished windows, Oct 8-15; tool:
// tools/pace-backtest.js, pinned by test/host/pace-backtest.test.js). It ran 6.6 points HIGH on average (mean
// error 19.4 points) and said "hot" in 5 of 28 windows, while no window ever reached 100%: the user's burn comes in
// bursts (a round of agents) that end. So the current burn now FADES to a long-run rate:
//   projection(h)  = used + LONG_RUN * h + (burn - LONG_RUN) * FADE * (1 - e^(-h / FADE))   h = hours from the reading
//   LONG_RUN       = 5%/h (25 points per window: the user's average window in the backtest; 4 or 6 change the error <0.3)
//   FADE           = 0.5 h (the burn's excess over 5%/h halves about every 21 minutes)
// Backtest: mean error 12.1 points (fresh reading) / 14.7 (1 h old) / 17.4 (2 h old), against 19.4 / 24.1 / 30.0
// for the straight line, and 0 false "hot" readings against 116. The cost: a burn that never lets up is called hot
// later (synthetic runaways: 35-45 min before 100% instead of 3-4 h; a late surge 20 min instead of 40); no real
// window has burned like that.
// The window opened at resetsAt - 5h. Burn = the AVERAGE since the window opened (used / elapsed hours), so Home
// still needs only the one usage reading the app already holds.
//   burnPerHour    = used / elapsedHours (at the reading)
//   projectedFinal = projection(hours from the reading to the reset)
//   hitInMs        = from now until the projection reaches 100% (null when it does not before the reset)
//   hot            = 100% lands more than 30m before the reset
//   under          = otherwise, at least one round of 3 agents (6 pts) left after the 5-pt main-session margin
//   on             = the rest (the window gets used up near its end)
//   early          = under 20m into the window: the average is too noisy to project, so no burn or projection
//   stale          = the reading is over MAX_BASIS_AGE_MS old: no projection (see below)
//   pinned         = already at 100%
// Missing data (no reading, no five-hour window, or its reset already passed) -> null: Home shows no chip,
// never a made-up verdict.
// Note: the Usage panel's pace line (ui/panels/pace-math.js) measures its own burn from samples but projects
// with the same projectFrom().

const MIN = 60_000;
const HOUR = 60 * MIN;
export const WINDOW_MS = 5 * HOUR;
export const PCT_PER_ROUND_OF_3 = 6;
export const MARGIN_PCT = 5;
export const HOT_LEAD_MS = 30 * MIN;
export const MIN_ELAPSED_FOR_BURN_MS = 20 * MIN;
export const EVEN_PACE_PER_HOUR = 100 / (WINDOW_MS / HOUR);   // 20%/h
export const LONG_RUN_PER_HOUR = 5;
export const BURN_FADE_MS = 30 * MIN;
// A reading older than this is not projected. In the backtest the mean error grows from 12.1 points (fresh) to
// 14.7 at 1 h old (+2.6, under half a round of 3 agents) and 16.0 at 1.5 h (+3.9, over it).
export const MAX_BASIS_AGE_MS = 60 * MIN;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The 5H % expected `hours` after a reading of `used` with the window's average burn `burnPerHour`.
export function projectFrom(used, burnPerHour, hours) {
  const h = Math.max(0, hours), fade = BURN_FADE_MS / HOUR;
  return used + LONG_RUN_PER_HOUR * h + (burnPerHour - LONG_RUN_PER_HOUR) * fade * (1 - Math.exp(-h / fade));
}

// Hours after the reading until projectFrom() reaches `target`, or null when it does not within `maxHours`.
// The projection only rises (its rate is a mix of two non-negative rates), so a bisection finds it.
export function hoursUntil(used, burnPerHour, target, maxHours) {
  if (used >= target) return 0;
  if (!(maxHours > 0) || projectFrom(used, burnPerHour, maxHours) < target) return null;
  let lo = 0, hi = maxHours;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (projectFrom(used, burnPerHour, mid) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

// fiveHour = usage.fiveHour ({ percent, resetsAt }) -> null, or
//   { verdict: 'under'|'on'|'hot'|'early'|'stale'|'pinned', used, resetsAt, elapsedMs, remainingMs, basisAgeMs,
//     burnPerHour, projectedFinal, hitInMs, hitBeforeResetMs }   (the last four null when early or stale)
// `at` = when the reading was taken (usage.updatedAt). The burn rate is the reading's percent over the time
// the window had run AT THAT MOMENT: dividing an hours-old reading by the time elapsed until now (as before
// 2026-10-14) understated the burn. The projection runs from the reading to the reset; hitInMs counts from now.
// basisAgeMs = how old that reading is; the chip says so, and over MAX_BASIS_AGE_MS nothing is projected.
export function paceOf(fiveHour, now = Date.now(), at = now) {
  const used = num(fiveHour && fiveHour.percent);
  const resetsAt = num(fiveHour && fiveHour.resetsAt);
  const t = num(now);
  if (used == null || resetsAt == null || t == null) return null;
  const rawRemaining = resetsAt - t;
  if (rawRemaining <= 0) return null;                       // the mod's 'reset': waiting for a fresh reading
  const readAt = Math.min(t, num(at) ?? t);
  const sinceReading = t - readAt;
  const remainingMs = Math.min(rawRemaining, WINDOW_MS);
  const elapsedMs = WINDOW_MS - Math.min(resetsAt - readAt, WINDOW_MS);
  const common = { used, resetsAt, elapsedMs, remainingMs, basisAgeMs: sinceReading };
  const none = { burnPerHour: null, projectedFinal: null, hitInMs: null, hitBeforeResetMs: null };
  if (used >= 100) return { ...common, verdict: 'pinned', burnPerHour: null, projectedFinal: 100, hitInMs: 0, hitBeforeResetMs: remainingMs };
  if (sinceReading > MAX_BASIS_AGE_MS) return { ...common, verdict: 'stale', ...none };
  if (elapsedMs < MIN_ELAPSED_FOR_BURN_MS) return { ...common, verdict: 'early', ...none };
  const burnPerHour = used / (elapsedMs / HOUR);
  const hoursLeft = (remainingMs + sinceReading) / HOUR;   // from the reading to the reset
  const projectedFinal = projectFrom(used, burnPerHour, hoursLeft);
  const hitH = hoursUntil(used, burnPerHour, 100, hoursLeft);
  const hitInMs = hitH === null ? null : Math.max(0, hitH * HOUR - sinceReading);
  const hitBeforeResetMs = hitInMs === null ? null : remainingMs - hitInMs;
  const spare = 100 - MARGIN_PCT - projectedFinal;
  const verdict = hitBeforeResetMs !== null && hitBeforeResetMs > HOT_LEAD_MS ? 'hot' : spare >= PCT_PER_ROUND_OF_3 ? 'under' : 'on';
  return { ...common, verdict, burnPerHour, projectedFinal, hitInMs, hitBeforeResetMs };
}

// The mod's duration format: `4h29m`, `41m`, `<1m`.
export function fmtDuration(ms) {
  const m = Math.floor(Math.max(0, num(ms) ?? 0) / MIN);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60), r = m % 60;
  return h > 0 ? `${h}h${String(r).padStart(2, '0')}m` : `${r}m`;
}
const fmtPct = (n) => `${Math.round(n * 10) / 10}%`;
const fmtRate = (r) => `${(Math.round(r * 10) / 10).toFixed(1)}%/h`;

const LABEL = { under: 'Under pace', on: 'On pace', hot: 'Hot', early: 'Early', stale: 'Old reading', pinned: 'Limit reached' };
const ofReading = (p) => `reading ${fmtDuration(p.basisAgeMs)} old`;

// The Home chip. p = paceOf(...); clock(ms) formats a wall-clock time (Home passes toLocaleTimeString).
// -> null (no chip), or { verdict, tone: 'quiet'|'neutral'|'warn', label, reset, title }
//   reset  "resets in 30m" inside the last hour, else "resets 6:40 PM"
//   title  the tooltip: the mod's /pace breakdown in short (used, elapsed, burn, projection, verdict)
export function paceChip(p, clock) {
  if (!p) return null;
  const reset = p.remainingMs < HOUR || typeof clock !== 'function' ? `resets in ${fmtDuration(p.remainingMs)}` : `resets ${clock(p.resetsAt)}`;
  // used and elapsed are as of the reading; "resets in" counts from now, so an old reading says so
  const asOf = p.basisAgeMs >= MIN ? ' at the reading' : '';
  const lines = [`5-hour ${fmtPct(p.used)} used · ${fmtDuration(p.elapsedMs)} elapsed${asOf} · resets in ${fmtDuration(p.remainingMs)}`];
  if (p.verdict === 'pinned') {
    lines.push('Limit reached: hold new agents until the window resets');
  } else if (p.verdict === 'stale') {
    lines.push(`Not projected: the reading is ${fmtDuration(p.basisAgeMs)} old (the limit is ${fmtDuration(MAX_BASIS_AGE_MS)})`);
  } else if (p.verdict === 'early') {
    lines.push(`Burn not projected yet (needs ${fmtDuration(MIN_ELAPSED_FOR_BURN_MS)} of the window; ${fmtDuration(p.elapsedMs)} so far)`);
  } else {
    lines.push(`Burn ${fmtRate(p.burnPerHour)} so far (even pace is ${fmtRate(EVEN_PACE_PER_HOUR)})`);
    lines.push(p.verdict === 'hot'
      ? `Projection 100% in ${fmtDuration(p.hitInMs)}, ${fmtDuration(p.hitBeforeResetMs)} before reset (${ofReading(p)})`
      : `Projection about ${fmtPct(Math.round(Math.min(100, p.projectedFinal)))} at reset (${ofReading(p)})`);
    lines.push(`Assumes the burn eases to a typical ${fmtRate(LONG_RUN_PER_HOUR)} within the hour`);
  }
  lines.push(`Hot = 100% lands more than ${fmtDuration(HOT_LEAD_MS)} before reset`);
  const tone = p.verdict === 'hot' || p.verdict === 'pinned' ? 'warn' : p.verdict === 'under' || p.verdict === 'early' || p.verdict === 'stale' ? 'quiet' : 'neutral';
  return { verdict: p.verdict, tone, label: LABEL[p.verdict], reset, title: lines.join('\n') };
}
