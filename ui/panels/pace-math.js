// Owner: lane deck-pace. Pure pace math for the Usage panel's 5-hour card (one pure import, so node:test
// loads it directly: test/host/pace.test.js).
//
// The user paces the 5-hour limit to run out near the END of the window: neither idle nor pinned early.
// paceReadout() turns the usage.history samples of the current window into one calm line:
//   "7.2%/h · about 36% at reset · under pace"
//
// paceReadout({ samples, resetsAt, now, live?, span?, hotMarginMs?, onPaceAt? })
//   samples  usage.history samples [{ ts, fiveHour, fiveHourResetsAt? }] (any order, any window)
//   resetsAt when the current 5-hour window resets (ms); the window opened at resetsAt - span
//   live     optional { percent, at }: the live reading, used as the newest point when it is newer
// -> { state: 'unknown', text }                      no reset time (or it is not inside one window)
// -> { state: 'few', n, text }                       fewer than 2 readings in this window (or < 5 min apart)
// -> { state: 'ok', n, rate, projected, hitAt, verdict: 'under'|'on'|'hot', text, parts: [rate, middle, verdict word] }
//      rate      %/h from the first reading in this window to the newest (never negative)
//      projected % at reset: projectFrom() in ../lib/pace.js, the rate easing to a typical 5%/h (lane helm-pace:
//                carrying the rate straight to the reset ran high in the backtest, tools/pace-backtest.js).
//                Can exceed 100: the text caps it
//      hitAt     when the projection reaches 100% (ms), or null when it does not before reset
//      verdict   hot = 100% lands more than hotMarginMs (30 min) before reset;
//                on  = otherwise projected >= onPaceAt (85%): the window gets used up near the end;
//                under = below that.

import { projectFrom, hoursUntil } from '../lib/pace.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const FIVE_H = 5 * HOUR;
export const HOT_MARGIN_MS = 30 * MIN;
export const ON_PACE_AT = 85;
const MIN_SPAN_MS = 5 * MIN;          // two readings closer than this say nothing about a rate
const RESET_SLOP_MS = 10 * MIN;       // a sample's own fiveHourResetsAt further off than this = another window

const isNum = (v) => typeof v === 'number' && isFinite(v);

export function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`;
}

const fmtRate = (r) => `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}%/h`;

// Readings that belong to the window ending at resetsAt, oldest first.
export function windowPoints(samples, resetsAt, now, span = FIVE_H) {
  const start = resetsAt - span;
  return (Array.isArray(samples) ? samples : [])
    .filter((s) => s && isNum(s.ts) && isNum(s.fiveHour) && s.ts >= start && s.ts <= now
      && (!isNum(s.fiveHourResetsAt) || Math.abs(s.fiveHourResetsAt - resetsAt) <= RESET_SLOP_MS))
    .map((s) => ({ ts: s.ts, p: s.fiveHour }))
    .sort((a, b) => a.ts - b.ts);
}

export function paceReadout({ samples, resetsAt, now, live = null, span = FIVE_H, hotMarginMs = HOT_MARGIN_MS, onPaceAt = ON_PACE_AT } = {}) {
  if (!isNum(resetsAt) || !isNum(now)) return { state: 'unknown', text: 'No pace yet: the reset time is unknown.' };
  if (resetsAt <= now || resetsAt - now > span) return { state: 'unknown', text: 'No pace yet: the window is resetting.' };
  const pts = windowPoints(samples, resetsAt, now, span);
  const n = pts.length;
  const few = (why) => ({ state: 'few', n, text: why });
  if (n < 2) {
    return few(`Not enough readings for a pace yet (${n === 0 ? 'none' : 'one'} in this window; Helm records one every 5 minutes).`);
  }
  const first = pts[0];
  let end = pts[n - 1];
  if (live && isNum(live.percent) && isNum(live.at) && live.at > end.ts && live.at <= now && live.at >= resetsAt - span) end = { ts: live.at, p: live.percent };
  if (end.ts - first.ts < MIN_SPAN_MS) return few('Not enough readings for a pace yet (the first ones in this window are minutes apart).');

  const rate = Math.max(0, (end.p - first.p) / ((end.ts - first.ts) / HOUR));
  const hoursLeft = (resetsAt - end.ts) / HOUR;
  const projected = projectFrom(end.p, rate, hoursLeft);
  const hitH = hoursUntil(end.p, rate, 100, hoursLeft);
  const hitAt = hitH === null ? null : end.ts + hitH * HOUR;
  const hot = hitAt != null && hitAt < resetsAt - hotMarginMs;
  const verdict = hot ? 'hot' : projected >= onPaceAt ? 'on' : 'under';
  let middle;
  if (hot && end.p >= 100) middle = `at 100% with ${fmtLeft(resetsAt - end.ts)} left`;
  else if (hot) middle = `100% about ${fmtLeft(resetsAt - hitAt)} before reset`;
  else middle = `about ${Math.round(Math.min(100, projected))}% at reset`;
  const word = verdict === 'hot' ? 'hot' : verdict === 'on' ? 'on pace' : 'under pace';
  return { state: 'ok', n, rate, projected, hitAt, verdict, text: `${fmtRate(rate)} · ${middle} · ${word}`, parts: [fmtRate(rate), middle, word] };
}
