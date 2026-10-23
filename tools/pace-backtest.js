#!/usr/bin/env node
'use strict';
// Backtest of the 5-hour pace PROJECTION (Home's pace chip, the Usage panel's pace line, the user's pace mod) on
// real readings (lane helm-pace, 2026-10-14).
//
//   node tools/pace-backtest.js                      the live history: %APPDATA%/Helm/usage-history.jsonl
//   node tools/pace-backtest.js --file <jsonl>       any usage-history file (test/fixtures/pace-history.jsonl)
//   node tools/pace-backtest.js --ages 0,0.5,1,2     reading ages to test, in hours (default 0,1,2)
//   node tools/pace-backtest.js --json               machine-readable results
//
// Data: every 5H sample ({k:'s', ts, fiveHour, fiveHourResetsAt}) grouped into windows by resetsAt. A window's
// truth is its final reading (the highest %, since a window only goes up). Windows still open at the end of the
// file are left out. Readings more than 2 points below the window's running high are source glitches (one
// source reported 0 three times on Oct 8) and are dropped.
//
// For every reading at least 20 min into its window (Home's 'early' rule) and below 100%, and every age A, the
// app is assumed to be looking at that reading A hours later (now = ts + A, still before the reset) with nothing
// newer. Each method projects the % at the reset from what was known at the reading (strict walk-forward: a
// method that learns from past windows only sees windows that had reset by then). Metrics per age:
//   MAE    mean absolute error of the projected final %, in points (every reading counts once)
//   bias   mean signed error (+ = projected too high)
//   wMAE   the mean of each window's own MAE (so busy windows with many readings do not dominate)
//   fHot   readings (windows) that said "hot" (100% more than 30 min before reset) in a window that never got
//          there; missed-hot is the reverse. No real window has reached 100%, so missed-hot is always 0 here and
//          the synthetic runaways below stand in for it.
// A stale reading in real life usually means nothing was running (all 9 gaps over 15 min inside a window in the
// Oct 8-15 history gained 0 points), so the 1 h / 2 h rows, which assume work went on, are the harder case.
const fs = require('fs');
const path = require('path');

const MIN = 60_000;
const HOUR = 60 * MIN;
const WINDOW = 5 * HOUR;
const HOT_LEAD = 30 * MIN;
const EARLY = 20 * MIN;
const H = (ms) => ms / HOUR;

function loadWindows(text) {
  const rs = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && r.k === 's' && Number.isFinite(r.ts) && Number.isFinite(r.fiveHour) && Number.isFinite(r.fiveHourResetsAt)) rs.push(r);
  }
  rs.sort((a, b) => a.fiveHourResetsAt - b.fiveHourResetsAt || a.ts - b.ts);
  const clusters = [];
  for (const r of rs) {
    const c = clusters[clusters.length - 1];
    if (c && r.fiveHourResetsAt - c.last < 10 * MIN) { c.items.push(r); c.last = r.fiveHourResetsAt; } else clusters.push({ last: r.fiveHourResetsAt, items: [r] });
  }
  const dataEnd = rs.reduce((m, r) => Math.max(m, r.ts), 0);
  const windows = [];
  let glitches = 0;
  for (const c of clusters) {
    const R = c.items[Math.floor(c.items.length / 2)].fiveHourResetsAt;
    const open = R - WINDOW;
    const raw = c.items.filter((r) => r.ts >= open && r.ts < R).sort((a, b) => a.ts - b.ts);
    const pts = [];
    let high = -1;
    for (const r of raw) {
      if (r.fiveHour < high - 2) { glitches++; continue; }
      high = Math.max(high, r.fiveHour);
      pts.push({ ts: r.ts, p: r.fiveHour });
    }
    if (!pts.length || R > dataEnd) continue;           // still open when the file ends: no truth yet
    windows.push({ R, open, pts, final: high });
  }
  windows.sort((a, b) => a.R - b.R);
  return { windows, glitches, readings: windows.reduce((s, w) => s + w.pts.length, 0) };
}

// ---- candidates. ctx = { used, ts (the reading), now, R, open, hist (this window's readings up to ts), past }
// Each returns a function of a target time t (ms) -> projected %, so the same curve gives the final (t = R) and
// the hot check (t = R - 30 min).
const avgBurn = (c) => c.used / H(c.ts - c.open);
const pastRate = (c) => (c.past.length ? c.past.reduce((s, w) => s + w.final, 0) / c.past.length / 5 : null);
function ewmaBurn(c, halfLifeH) {
  const pts = [{ ts: c.open, p: 0 }, ...c.hist];
  let num = 0, den = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = H(pts[i].ts - pts[i - 1].ts);
    if (dt <= 0) continue;
    const w = Math.pow(0.5, H(c.ts - (pts[i].ts + pts[i - 1].ts) / 2) / halfLifeH);
    num += w * Math.max(0, pts[i].p - pts[i - 1].p); den += w * dt;
  }
  return den > 0 ? num / den : avgBurn(c);
}
function activeStats(pts, open, end) {   // time with the % rising (each step capped at 20 min) and its gain
  const a = [{ ts: open, p: 0 }, ...pts];
  let act = 0, gain = 0;
  for (let i = 1; i < a.length; i++) if (a[i].p > a[i - 1].p) { act += Math.min(a[i].ts - a[i - 1].ts, 20 * MIN); gain += a[i].p - a[i - 1].p; }
  return { activeH: H(act), gain, spanH: H(end - open) };
}
function at(w, t) { let p = 0; for (const x of w.pts) if (x.ts <= t) p = x.p; return p; }

function methods(pace, paceMath) {
  return {
    // Home on wk/next2 and the pace mod on a fresh reading: the window's average burn, straight to the reset.
    linear: (c) => (t) => c.used + avgBurn(c) * H(t - c.ts),
    // Home on master and the pace mod (pace.ts paceView: elapsed counted to NOW, projected from now).
    'master/mod': (c) => (t) => c.used + (c.used / H(c.now - c.open)) * H(t - c.now),
    // The Usage panel's pace line as shipped before this lane: burn from the first reading in the window.
    'panel(old)': (c) => { const f = c.hist[0]; const r = c.ts > f.ts ? Math.max(0, (c.used - f.p) / H(c.ts - f.ts)) : avgBurn(c); return (t) => c.used + r * H(t - c.ts); },
    stay: (c) => () => c.used,                                      // nothing more gets used
    ewma1h: (c) => { const r = ewmaBurn(c, 1); return (t) => c.used + r * H(t - c.ts); },
    // the burn blends toward the long-run rate (past windows) as the window ages: weight e / (e + 2 h)
    blend2h: (c) => { const b = avgBurn(c), pr = pastRate(c) ?? b, e = H(c.ts - c.open), w = e / (e + 2); return (t) => c.used + (w * b + (1 - w) * pr) * H(t - c.ts); },
    // idle-aware: the rate over active minutes only, times the expected active share (this window and past ones)
    idle: (c) => {
      const st = activeStats(c.hist, c.open, c.ts);
      if (st.activeH <= 0) return () => c.used;
      let a = 0, s = 0; for (const w of c.past) { const x = activeStats(w.pts, w.open, w.R); a += x.activeH; s += x.spanH; }
      const own = st.activeH / st.spanH, w = st.spanH / (st.spanH + 1), share = s > 0 ? w * own + (1 - w) * (a / s) : own;
      return (t) => c.used + (st.gain / st.activeH) * share * H(t - c.ts);
    },
    // empirical: the mean gain past windows made from the same point (among windows already in use there)
    empirical: (c) => {
      const e = c.ts - c.open, g = c.past.map((w) => ({ u: at(w, w.open + e), f: w.final })).filter((x) => x.u >= 1).map((x) => x.f - x.u);
      if (g.length < 3) return (t) => c.used + avgBurn(c) * H(t - c.ts);
      const mean = g.reduce((s, x) => s + x, 0) / g.length;
      return (t) => c.used + mean * H(t - c.ts) / H(c.R - c.ts);
    },
    // fade with the long-run rate learned walk-forward from past windows instead of the fixed 5%/h
    'fade(learned)': (c) => {
      const b = avgBurn(c), pr = pastRate(c) ?? b, tau = pace.BURN_FADE_MS / HOUR;
      return (t) => { const h = H(t - c.ts); return c.used + pr * h + (b - pr) * tau * (1 - Math.exp(-h / tau)); };
    },
    // SHIPPED: ui/lib/pace.js projectFrom() (Home) and ui/panels/pace-math.js (the Usage panel)
    fade: (c) => { const b = avgBurn(c); return (t) => pace.projectFrom(c.used, b, H(t - c.ts)); },
    // paceReadout() itself: its projected % for the final, its own hot verdict for the hot check
    'panel(new)': (c) => {
      const r = paceMath.paceReadout({ samples: c.hist.map((x) => ({ ts: x.ts, fiveHour: x.p, fiveHourResetsAt: c.R })), resetsAt: c.R, now: c.ts });
      if (r.state !== 'ok') return null;
      return (t) => (t >= c.R ? r.projected : r.verdict === 'hot' ? 100 : 0);
    },
  };
}

function evaluate(windows, { ages = [0, 1, 2], pace, paceMath, only = null } = {}) {
  const M = methods(pace, paceMath);
  const names = only || Object.keys(M);
  const res = {};
  for (const n of names) { res[n] = {}; for (const A of ages) res[n][A] = { n: 0, abs: 0, err: 0, fHot: 0, fHotWin: new Set(), mHot: 0, perWin: new Map() }; }
  windows.forEach((w, wi) => {
    const trulyHot = w.pts.some((x) => x.p >= 100 && x.ts < w.R - HOT_LEAD);
    w.pts.forEach((r, i) => {
      if (r.ts - w.open < EARLY || r.p >= 100) return;
      const past = windows.filter((x) => x.R <= r.ts);
      for (const A of ages) {
        const now = r.ts + A * HOUR;
        if (now >= w.R) continue;
        const c = { used: r.p, ts: r.ts, now, R: w.R, open: w.open, hist: w.pts.slice(0, i + 1), past };
        for (const n of names) {
          const f = M[n](c);
          if (!f) continue;
          const fin = f(w.R), hot = f(w.R - HOT_LEAD) >= 100, s = res[n][A];
          s.n++; s.abs += Math.abs(fin - w.final); s.err += fin - w.final;
          if (hot && !trulyHot) { s.fHot++; s.fHotWin.add(wi); }
          if (!hot && trulyHot) s.mHot++;
          const pw = s.perWin.get(wi) || [0, 0]; pw[0] += Math.abs(fin - w.final); pw[1]++; s.perWin.set(wi, pw);
        }
      }
    });
  });
  const out = {};
  for (const n of names) {
    out[n] = {};
    for (const A of ages) {
      const s = res[n][A];
      out[n][A] = s.n ? {
        n: s.n, mae: s.abs / s.n, bias: s.err / s.n,
        wmae: [...s.perWin.values()].reduce((a, v) => a + v[0] / v[1], 0) / s.perWin.size,
        falseHot: s.fHot, falseHotWindows: s.fHotWin.size, missedHot: s.mHot,
      } : { n: 0 };
    }
  }
  return out;
}

// The shipped chip itself (paceOf), fed exactly what Home gets: { percent, resetsAt } and the reading's time.
function evaluateChip(windows, pace, ages = [0, 1, 2]) {
  const out = {};
  for (const A of ages) {
    let n = 0, shown = 0, abs = 0, err = 0, fHot = 0;
    for (const w of windows) for (const r of w.pts) {
      if (r.ts - w.open < EARLY || r.p >= 100) continue;
      const now = r.ts + A * HOUR;
      if (now >= w.R) continue;
      n++;
      const p = pace.paceOf({ percent: r.p, resetsAt: w.R }, now, r.ts);
      if (!p || p.projectedFinal == null) continue;
      shown++; abs += Math.abs(p.projectedFinal - w.final); err += p.projectedFinal - w.final;
      if (p.verdict === 'hot') fHot++;
    }
    out[A] = { n, shown, mae: shown ? abs / shown : null, bias: shown ? err / shown : null, falseHot: fHot };
  }
  return out;
}

// Synthetic runaways (no real window has one): when does each method first say hot, and how long before 100%?
const RUNAWAYS = [
  ['steady 25%/h', () => 25],
  ['steady 33%/h', () => 33],
  ['10%/h, then 40%/h from 2 h', (e) => (e < 2 ? 10 : 40)],
];
function runaways(pace, paceMath, names) {
  const M = methods(pace, paceMath);
  return RUNAWAYS.map(([label, rateAt]) => {
    const pts = []; let p = 0, hit = null;
    for (let t = 5 * MIN; t < WINDOW; t += 5 * MIN) { p += rateAt(H(t - 2.5 * MIN)) / 12; if (hit == null && p >= 100) hit = t; pts.push({ ts: t, p: Math.min(100, Math.floor(p)) }); }
    const first = {};
    for (const n of names) {
      first[n] = null;
      for (let i = 0; i < pts.length; i++) {
        const r = pts[i]; if (r.ts < EARLY || r.p >= 100) continue;
        const f = M[n]({ used: r.p, ts: r.ts, now: r.ts, R: WINDOW, open: 0, hist: pts.slice(0, i + 1), past: [] });
        if (f && f(WINDOW - HOT_LEAD) >= 100) { first[n] = r.ts; break; }
      }
    }
    return { label, hitAt: hit, firstHot: first };
  });
}

// Fixed long-run rate, chosen on the first half of the windows and tested on the second half.
function splitHalf(windows, pace, paceMath) {
  const half = Math.floor(windows.length / 2);
  const rate = windows.slice(0, half).reduce((s, w) => s + w.final, 0) / half / 5;
  const tau = pace.BURN_FADE_MS / HOUR;
  const fixed = { ...pace, projectFrom: (u, b, h) => u + rate * h + (b - rate) * tau * (1 - Math.exp(-h / tau)) };
  const test = windows.slice(half);
  const a = evaluate(test, { ages: [0], pace: fixed, paceMath, only: ['fade', 'linear'] });
  const b = evaluate(test, { ages: [0], pace, paceMath, only: ['fade'] });
  return { firstHalfRate: rate, testWindows: test.length, fadeFirstHalfRate: a.fade[0], fadeShipped: b.fade[0], linear: a.linear[0] };
}

module.exports = { loadWindows, evaluate, evaluateChip, runaways, splitHalf, methods };

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const file = arg('--file') || path.join(process.env.APPDATA || '', 'Helm', 'usage-history.jsonl');
  const ages = (arg('--ages') || '0,1,2').split(',').map(Number);
  const pace = require('../ui/lib/pace.js');
  const paceMath = require('../ui/panels/pace-math.js');
  const data = loadWindows(fs.readFileSync(file, 'utf8'));
  const { windows } = data;
  const table = evaluate(windows, { ages, pace, paceMath });
  const chip = evaluateChip(windows, pace, ages);
  const names = Object.keys(table);
  const run = runaways(pace, paceMath, ['linear', 'master/mod', 'panel(old)', 'fade', 'panel(new)']);
  const split = splitHalf(windows, pace, paceMath);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ file, windows: windows.length, readings: data.readings, glitches: data.glitches, table, chip, runaways: run, split }, null, 2) + '\n');
    process.exit(0);
  }
  const f1 = (x) => (x == null ? '-' : (Math.round(x * 10) / 10).toFixed(1));
  const first = new Date(Math.min(...windows.map((w) => w.open))).toISOString().slice(0, 10);
  const last = new Date(Math.max(...windows.map((w) => w.R))).toISOString().slice(0, 10);
  console.log(`${file}\n${windows.length} finished windows (${first} to ${last}), ${data.readings} readings, ${data.glitches} glitch readings dropped`);
  console.log(`finals: ${windows.map((w) => w.final).join(' ')}`);
  console.log('\nmethod         ' + ages.map((A) => `| ${A}h old: n     MAE  bias  wMAE  fHot(win)`).join(' '));
  for (const n of names) {
    console.log(n.padEnd(15) + ages.map((A) => {
      const s = table[n][A];
      return s.n ? `| ${String(s.n).padStart(13)} ${f1(s.mae).padStart(5)} ${f1(s.bias).padStart(5)} ${f1(s.wmae).padStart(5)} ${String(s.falseHot).padStart(5)}(${s.falseHotWindows})` : '| -';
    }).join(' '));
  }
  console.log('\nHome chip (paceOf as shipped; readings over the age limit are not projected):');
  for (const A of ages) { const s = chip[A]; console.log(`  ${A}h old: projected ${s.shown} of ${s.n}, MAE ${f1(s.mae)}, bias ${f1(s.bias)}, false hot ${s.falseHot}`); }
  console.log('\nSynthetic runaways: first "hot" (minutes into the window) and the warning before 100%:');
  for (const r of run) {
    console.log(`  ${r.label} (100% at ${Math.round(r.hitAt / MIN)}m): ` + Object.entries(r.firstHot).map(([n, t]) => `${n} ${t == null ? 'never' : `${Math.round(t / MIN)}m (${Math.round((r.hitAt - t) / MIN)}m ahead)`}`).join(', '));
  }
  console.log(`\nOut of sample: long-run rate from the first ${windows.length - split.testWindows} windows = ${f1(split.firstHalfRate)}%/h; on the last ${split.testWindows}:`
    + ` fade(that rate) MAE ${f1(split.fadeFirstHalfRate.mae)} bias ${f1(split.fadeFirstHalfRate.bias)}, fade(5%/h) MAE ${f1(split.fadeShipped.mae)}, linear MAE ${f1(split.linear.mae)}`);
}
