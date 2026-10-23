// Owner: lane eta-accuracy (2026-10-17). Usage > Estimates: how accurate the eta mod's estimates are.
// The user asked: "we need to add something to helm where we can see how accurate the eta mod is".
//
// Data: engine method eta.accuracy (main/engine/eta-accuracy.js) reads ~/.claude/mods-data/eta/history.jsonl
// async in the main process, once when this section mounts and on its refresh button; never a sync read.
// Math: ./eta-accuracy-math.js. States: loading (skeleton), error (says why, Try again), empty (no history
// yet, names the file), data. Unreadable lines are counted on screen, never dropped silently.
//
// Chart: one dot per finished task, actual ÷ the estimate as shown, on a log scale (1× = on time; above it
// ran long); a wash marks ±25%; a neutral line is the rolling median of the last 9. One accent, tokens only,
// so light and dark both come from tokens.css. Hover / tap / arrow keys read a task out in the card's head.
import { html, Icon, cx, Empty, Loading, SectionHead } from './util.js';
import { rpc } from '../lib/store.js';
import { useState, useEffect, useLayoutEffect, useCallback } from 'preact/hooks';
import { summarize, fmtMin, fmtRatio, fmtShare, ratioPhrase, ROLL_N, TREND_N, RECENT_N } from './eta-accuracy-math.js';

const DAY = 24 * 3600_000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtWhen = (ts) => `${fmtDay(ts)} ${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

function useWidth() {
  const [el, ref] = useState(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return undefined;
    const set = () => { const x = Math.floor(el.getBoundingClientRect().width); if (x > 0) setW(x); };
    set();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, w];
}

function reasonOf(error) {
  const msg = (error && (error.message || String(error))) || '';
  if (/unknown method|no such method|not (implemented|supported|found)/i.test(msg)) return 'This Helm has no eta.accuracy method yet (restart Helm after updating it).';
  return msg ? `Estimates couldn't load: ${msg}` : 'Estimates couldn\'t load.';
}

const shownText = (p) => (p.range ? `${fmtMin(p.range[0])}–${fmtMin(p.range[1])}` : p.factor !== null ? fmtMin(p.shown) : 'as said');

// ---- the chart: actual ÷ shown estimate per task, over time, log scale ----
const LOG_MIN = -3; // 1/8×
const LOG_MAX = 3;  // 8×
const Y_TICKS = [0.25, 0.5, 1, 2, 4];

function RatioChart({ points, rolling }) {
  const [ref, measured] = useWidth();
  const [hi, setHi] = useState(null);
  const W = measured || 320;
  const H = 148, padT = 8, padB = 8, padR = 34, padL = 6;
  const iw = Math.max(60, W - padR - padL);
  const t0 = points[0].at;
  const t1 = Math.max(points[points.length - 1].at, t0 + DAY);
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * iw;
  const y = (r) => padT + (1 - (clamp(Math.log2(r), LOG_MIN, LOG_MAX) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (H - padT - padB);
  const yBandTop = y(1.25), yBandBot = y(0.75);
  const roll = rolling.length > 1 ? `M${rolling.map((p) => `${x(p.at).toFixed(1)},${y(p.ratio).toFixed(1)}`).join('L')}` : '';
  const days = Math.max(1, Math.round((t1 - t0) / DAY));
  const tickEvery = days > 20 ? 7 : days > 8 ? 3 : 1;
  const xticks = [];
  const d0 = new Date(t0); d0.setHours(12, 0, 0, 0);
  for (let t = d0.getTime(), i = 0; t <= t1 && i < 60; t += tickEvery * DAY, i++) if (x(t) > padL + 18 && x(t) < padL + iw - 18) xticks.push(t);
  const h = hi != null ? points[hi] : null;

  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = W / (r.width || W);
    const px = (e.clientX - r.left) * sx, py = (e.clientY - r.top) * sx;
    let best = -1, bd = Infinity;
    points.forEach((p, i) => { const d = (x(p.at) - px) ** 2 + ((y(p.ratio) - py) * 0.6) ** 2; if (d < bd) { bd = d; best = i; } });
    setHi(best >= 0 ? best : null);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHi((i) => clamp((i ?? points.length) - 1, 0, points.length - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setHi((i) => clamp((i ?? points.length - 2) + 1, 0, points.length - 1)); }
    else if (e.key === 'Escape') setHi(null);
  };
  const late = points.filter((p) => p.ratio > 1.25).length;
  const label = `Each finished task's actual time divided by the estimate eta showed, ${points.length} tasks since ${fmtDay(t0)}; ${late} ran more than 25% long. Arrow keys step through tasks.`;

  return html`<div class="pn-us-card pn-ea-chart-card">
    <div class="pn-us-row">
      <span class="pn-us-title">Actual ÷ estimate, per task</span>
      ${h ? html`<span class="pn-uh-read pn-num" aria-live="polite">${fmtWhen(h.at)} · ${fmtMin(h.shown)} → ${fmtMin(h.took)} · <b>${fmtRatio(h.ratio)}</b></span>`
        : html`<span class="pn-uh-aside pn-num">${points.length} tasks</span>`}
    </div>
    <div class="pn-uh-plot pn-ea-plot" ref=${ref} tabindex="0" role="img" aria-label=${label}
      onPointerMove=${pick} onPointerDown=${pick} onPointerLeave=${(e) => e.pointerType === 'mouse' && setHi(null)}
      onKeyDown=${onKey} onBlur=${() => setHi(null)}>
      <svg class="pn-uh-svg" viewBox=${`0 0 ${W} ${H}`} width="100%" height=${H} aria-hidden="true">
        <rect class="pn-ea-band" x=${padL} y=${yBandTop} width=${iw} height=${Math.max(1, yBandBot - yBandTop)} rx="2" />
        ${Y_TICKS.filter((r) => r !== 1).map((r) => html`<line class="pn-ea-grid" x1=${padL} x2=${padL + iw} y1=${Math.round(y(r)) + 0.5} y2=${Math.round(y(r)) + 0.5} />`)}
        <line class="pn-ea-one" x1=${padL} x2=${padL + iw} y1=${Math.round(y(1)) + 0.5} y2=${Math.round(y(1)) + 0.5} />
        ${Y_TICKS.map((r) => html`<text class="pn-ea-ytick" x=${padL + iw + 6} y=${y(r)} dominant-baseline="middle">${fmtRatio(r, 2)}</text>`)}
        ${points.map((p, i) => html`<circle key=${i} class=${cx('pn-ea-dot', p.ratio > 1.25 && 'late', i === hi && 'sel')} cx=${x(p.at)} cy=${y(p.ratio)} r=${i === hi ? 5 : 4} />`)}
        ${roll && html`<path class="pn-ea-roll" d=${roll} />`}
        ${h && html`<line class="pn-uh-cross" x1=${Math.round(x(h.at)) + 0.5} x2=${Math.round(x(h.at)) + 0.5} y1=${padT} y2=${H - padB} />`}
      </svg>
      <div class="pn-uh-axis" aria-hidden="true">
        ${xticks.map((t) => html`<span key=${t} style=${{ left: `${x(t)}px` }}>${fmtDay(t)}</span>`)}
      </div>
    </div>
    <div class="pn-ea-legend" aria-hidden="true">
      <span><i class="pn-ea-key-dot"></i>a task</span>
      <span><i class="pn-ea-key-line"></i>median of the last ${ROLL_N}</span>
      <span><i class="pn-ea-key-band"></i>within ±25%</span>
    </div>
  </div>`;
}

function TrendLine({ trend }) {
  if (!trend) return html`<div class="pn-us-why">Trend needs 10 finished tasks; there are fewer so far.</div>`;
  const { recent, before, verdict, k } = trend;
  const head = verdict === 'better' ? 'Getting more accurate' : verdict === 'worse' ? 'Less accurate lately' : 'About as accurate as before';
  return html`<div class=${cx('pn-ea-trend', verdict)} role="status">
    <${Icon} name=${verdict === 'better' ? 'check' : verdict === 'worse' ? 'alert' : 'minus'} size=${14} />
    <span><b>${head}.</b> Typical miss ${fmtRatio(before.miss)} → ${fmtRatio(recent.miss)}, within ±25% ${fmtShare(before.within25)} → ${fmtShare(recent.within25)} (last ${k} tasks against the ${k} before).</span>
  </div>`;
}

function Headline({ s }) {
  const fNow = s.factorNow.find((f) => f.minutes === 30);
  const factorText = (f) => (!f.enough ? `as said (${f.n} similar)` : f.factor === null ? 'as said' : fmtRatio(f.factor, 2));
  return html`<div class="pn-us-card pn-ea-head">
    <div class="pn-ea-stats">
      <div class="pn-ea-stat"><span class="pn-ea-val pn-num">${fmtShare(s.shown.within25)}</span><span class="pn-ea-lab">within ±25%</span></div>
      <div class="pn-ea-stat"><span class="pn-ea-val pn-num">${fmtRatio(s.typicalRatio)}</span><span class="pn-ea-lab">typical took ÷ said</span></div>
      <div class="pn-ea-stat"><span class="pn-ea-val pn-num">${fNow && fNow.enough && fNow.factor !== null ? fmtRatio(fNow.factor, 2) : '1×'}</span><span class="pn-ea-lab">factor now (30m)</span></div>
    </div>
    <div class="pn-us-why">
      Last ${s.n} finished estimates: as eta showed them, ${fmtShare(s.shown.within25)} landed within ±25% and ${fmtShare(s.shown.within50)} within ±50% (as said: ${fmtShare(s.raw.within25)} / ${fmtShare(s.raw.within50)}).
      ${' '}Typically ${ratioPhrase(s.typicalRatio)}.
    </div>
    <div class="pn-ea-factors">
      <span class="pn-ea-factors-lab">Calibration now</span>
      ${s.factorNow.map((f) => html`<span key=${f.minutes} class="pn-ea-factor pn-num" title=${`${f.n} similar finished estimates (within 2× of ${fmtMin(f.minutes)}) among the last 30`}>
        ${fmtMin(f.minutes)} <b>${factorText(f)}</b>${f.range ? html`<span class="pn-ea-range"> · range ${fmtRatio(f.range[0])}–${fmtRatio(f.range[1])}</span>` : null}
      </span>`)}
    </div>
  </div>`;
}

function RecentList({ rows }) {
  return html`<div class="pn-us-card pn-ea-list-card">
    <div class="pn-us-row"><span class="pn-us-title">Recent tasks</span><span class="pn-uh-aside">newest first</span></div>
    <table class="pn-ea-table">
      <thead><tr><th>Finished</th><th class="proj">Project</th><th class="r">Said</th><th class="r shown">Shown</th><th class="r">Took</th><th class="r">Ratio</th></tr></thead>
      <tbody>
        ${rows.map((p, i) => html`<tr key=${i}>
          <td class="when pn-num">${fmtWhen(p.at)}</td>
          <td class="proj" title=${p.project || ''}>${p.project || '–'}</td>
          <td class="r pn-num">${fmtMin(p.said)}</td>
          <td class="r shown pn-num">${shownText(p)}</td>
          <td class="r pn-num">${fmtMin(p.took)}</td>
          <td class=${cx('r pn-num ratio', p.ratio > 1.25 ? 'late' : p.ratio < 0.75 ? 'early' : 'on')}>${fmtRatio(p.ratio)}</td>
        </tr>`)}
      </tbody>
    </table>
  </div>`;
}

export function EtaAccuracySection() {
  const [st, setSt] = useState({ loading: true, data: null, error: null });
  const load = useCallback(async () => {
    setSt((s) => ({ ...s, loading: true }));
    try {
      const data = await rpc('eta.accuracy', {});
      setSt({ loading: false, data, error: null });
    } catch (error) {
      setSt((s) => ({ loading: false, data: s.data, error }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const d = st.data;
  const s = d && Array.isArray(d.records) ? summarize(d.records) : null;
  let body;
  if (!d && st.loading) body = html`<${Loading} label="Loading estimates…" />`;
  else if (!d) {
    body = html`<div class="pn-ea-error" role="alert">
      <span>${reasonOf(st.error)}</span>
      <button class="btn sm" onClick=${load}>Try again</button>
    </div>`;
  } else if (!s) {
    body = html`<${Empty} icon="history" title="No finished estimates yet">
      The eta mod writes one line to ${html`<span class="mono">${d.file || 'history.jsonl'}</span>`} each time a task it estimated finishes. Accuracy shows here after the first.
    <//>`;
  } else {
    body = html`<div class="pn-us-cards pn-ea">
      <${Headline} s=${s} />
      <${RatioChart} points=${s.points} rolling=${s.rolling} />
      <${TrendLine} trend=${s.trend} />
      <${RecentList} rows=${s.recent} />
      <div class="pn-us-why pn-ea-foot">
        ${s.total} finished tasks since ${fmtDay(s.since)}; headline numbers are the last ${Math.min(RECENT_N, s.total)}, the trend the last ${Math.min(TREND_N, Math.floor(s.total / 2))} against the ones before.
        ${d.bad ? html` <b>${d.bad} unreadable line${d.bad === 1 ? '' : 's'}</b> in the history file skipped.` : null}
      </div>
    </div>`;
  }
  return html`<${SectionHead} title="Estimates">
      <button class="icon-btn" title="Reload eta's history" aria-label="Reload eta's history" disabled=${st.loading} onClick=${load}>${st.loading && d ? html`<span class="spinner sm" aria-hidden="true"></span>` : html`<${Icon} name="refresh" size=${14} />`}</button>
    <//>
    ${st.error && d && html`<div class="pn-uh-unavail" role="status">${reasonOf(st.error)} Showing the last copy.</div>`}
    <div class=${cx('pn-ea-wrap', st.loading && d && 'refetch')}>${body}</div>`;
}
