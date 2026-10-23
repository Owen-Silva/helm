// Owner: lane panels (E). Agents panel, Timeline mode: a Gantt of the fleet.
// One row per agent in tree order (children indented), one bar per run (startedAt to endedAt, or now
// while running; a SendMessage resume adds a run; an agent whose end is unknown gets a start tick only),
// a "now" line, a time axis whose long idle gaps are collapsed into breaks, and a running-count
// strip under the rows. Hover (mouse) or tap/click (touch, keyboard) fills the details card.
// Only the chart scrolls sideways; the label column stays put. No running animations: the panel
// re-renders on the existing 1 s useNow tick.
import { html, cx, fmtDuration, fmtCost, fmtPct, splitLane, shortModel, dotClass } from './util.js';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { spanOf, runSpans, ranMs, buildScale, timeTicks, fmtTick, concurrencySteps, peakConcurrency } from './timeline-math.js';

import { CONTEXT_HANDOFF_PCT as HANDOFF_PCT, CONTEXT_CEILING_PCT as CEILING_PCT, contextLevel } from '../lib/context-limits.js';
import { agentStateText } from '../lib/stall-limits.js';   // lane stall
const STRIP_H = 22;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function label(a) {
  const { lane, text } = splitLane(a.description);
  return { lane, text: text.trim() || a.subagentType || 'Agent' };
}

function fmtClock(t) {
  if (t == null) return '—';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Details({ a, now, onReveal, onOpen }) {
  if (!a) return html`<div class="pn-tl-detail empty">Hover or tap a bar for its lane, model, tools, context and cost.</div>`;
  const { lane, text } = label(a);
  const sp = spanOf(a, now);
  const dur = ranMs(a, now);
  const runs = runSpans(a, now).length;
  const ctx = a.context || null;
  const p = num(ctx?.percent);
  const lvl = contextLevel(p);
  const used = num(ctx?.usedTokens), win = num(ctx?.windowTokens);
  const tools = num(a.toolCount);
  const cost = num(a.costUsd);
  const model = [a.subagentType, a.model ? shortModel(a.model) : ''].filter(Boolean).join(' · ');
  const statusText = a.status === 'running' ? 'Running' : a.status === 'error' ? 'Error' : a.status === 'done' ? 'Done'
    : a.status === 'stopped' ? (a.stopReason ? agentStateText(a, now) : 'Stopped (no completion record)') : (a.status || 'Unknown');
  const quietText = a.status === 'running' ? agentStateText(a, now) : null;   // lane stall: "No activity 12m"
  const endText = a.status === 'running' ? 'now' : sp?.unknownEnd ? 'end unknown' : fmtClock(sp?.end);
  return html`<div class=${cx('pn-tl-detail', `st-${a.status}`)} aria-live="polite">
    <div class="pn-tl-detail-head">
      <span class=${cx('dot', dotClass(a.status), 'pn-ag-dot')} aria-hidden="true"></span>
      <span class="pn-tl-detail-title" title=${text}>${text}</span>
      <button type="button" class="btn sm pn-tl-reveal" onClick=${() => onReveal(a)} title="Show this agent in the conversation">Show in chat</button>
      ${onOpen && html`<button type="button" class="btn sm pn-tl-open" onClick=${() => onOpen(a)} title="Open this agent: its prompt, steps and tool calls">Open</button>`}
    </div>
    <dl class="pn-tl-dl">
      <dt>Lane</dt><dd>${lane ? html`<span class="pn-tag">${lane}</span>` : html`<span class="pn-muted">none</span>`}</dd>
      <dt>Status</dt><dd class=${cx('pn-tl-st', a.status)}>${statusText}${quietText ? html`<span class="pn-ag-quiet"> · ${quietText}</span>` : ''}${a.background === true ? html`<span class="pn-muted"> · background</span>` : ''}</dd>
      <dt>Model</dt><dd title=${a.model || ''}>${model || html`<span class="pn-muted">not reported</span>`}</dd>
      <dt>Ran</dt><dd class="pn-num">${dur != null ? `${a.endEstimated ? '~' : ''}${fmtDuration(dur)}` : '—'}<span class="pn-muted"> · ${fmtClock(sp?.start)}–${endText}${runs > 1 ? ` · ${runs} runs (resumed)` : ''}</span></dd>
      <dt>Tools</dt><dd class="pn-num">${tools != null ? tools : '—'}${a.lastTool ? html`<span class="pn-muted"> · last </span><span class="mono">${a.lastTool}</span>` : ''}</dd>
      <dt>Context</dt><dd class=${cx('pn-num', lvl && `pn-tl-${lvl}`)}>${p == null ? html`<span class="pn-muted">not reported yet</span>`
        : html`${ctx.estimated ? '~' : ''}${fmtPct(p, 1)}${win ? html`<span class="pn-muted"> · ${Math.round((used || 0) / 1000)}k of ${Math.round(win / 1000)}k tokens</span>` : ''}`}</dd>
      <dt>Cost</dt><dd class="pn-num">${cost != null ? fmtCost(cost) : html`<span class="pn-muted">not reported</span>`}</dd>
    </dl>
  </div>`;
}

// groups: [{ session, rows: [{ agent, depth }] }]; `all` shows a session header per group.
export function Timeline({ groups, all, now, onReveal, onOpen, onOpenSession, activeSessionId }) {
  const scrollRef = useRef(null);
  const pinRight = useRef(true);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState(null);
  const [sel, setSel] = useState(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const agents = groups.flatMap((g) => g.rows.map((r) => r.agent));
  // Bars span first start to end; the running count and peak use only the time agents really ran.
  const spans = agents.map((a) => spanOf(a, now)).filter(Boolean);
  const runs = agents.flatMap((a) => runSpans(a, now));
  const scale = buildScale([...spans, { start: now, end: now }], { width: w || 240, minWidth: 200 });

  // Keep the newest end in view when the chart is wider than the panel (unless the user scrolled back).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinRight.current && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
  });
  const onScroll = (e) => { const el = e.currentTarget; pinRight.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4; };

  const shownId = hover || sel;
  const shown = shownId ? agents.find((a) => a.id === shownId) || null : null;
  const pick = (id) => setSel((cur) => (cur === id ? null : id));
  const enter = (id) => (e) => { if (e.pointerType === 'mouse') setHover(id); };

  if (!scale) return null;
  const nowX = scale.x(now);
  const ticks = timeTicks(scale, { minPx: 64 }).filter((tk) => Math.abs(tk.x - nowX) > 34);
  const steps = concurrencySteps(runs);
  const { peak } = peakConcurrency(runs);

  const labels = [];
  const tracks = [];
  for (const g of groups) {
    if (all) {
      const s = g.session;
      const run = g.rows.filter((r) => r.agent.status === 'running').length;
      labels.push(html`<button type="button" key=${`h-${s.id}`} class=${cx('pn-tl-ghead', s.id === activeSessionId && 'on')} onClick=${() => onOpenSession(s.id)} title=${`Open ${s.title || s.project || 'this session'}`}>
        <span class=${cx('dot', dotClass(s.status))} aria-hidden="true"></span>
        <span class="pn-tl-gtitle">${s.title || s.project || 'Untitled'}</span>
        <span class="pn-tl-gcount pn-num">${run}/${g.rows.length}</span>
      </button>`);
      tracks.push(html`<div key=${`h-${s.id}`} class="pn-tl-ghead-track"></div>`);
    }
    for (const { agent: a, depth } of g.rows) {
      const { lane, text } = label(a);
      const sp = spanOf(a, now);
      const on = a.id === shownId;
      // context % on the row; amber / red only while it runs (as in the Tree), finished ones stay neutral
      const ctxP = num(a.context?.percent);
      const ctxLvl = a.status === 'running' ? contextLevel(ctxP) : '';
      labels.push(html`<button type="button" key=${a.id} class=${cx('pn-tl-lab', on && 'on', `st-${a.status}`)} style=${{ '--depth': depth }}
        onPointerEnter=${enter(a.id)} onClick=${() => pick(a.id)} aria-pressed=${a.id === sel} title=${text}>
        ${depth > 0 && html`<span class="pn-tl-branch" aria-hidden="true"></span>`}
        <span class=${cx('dot', dotClass(a.status), 'pn-ag-dot')} aria-label=${a.status}></span>
        <span class="pn-tl-name">${lane || text}</span>
        ${ctxP != null && html`<span class=${cx('pn-tl-ctx pn-num', ctxLvl)} title=${`${fmtPct(ctxP, 1)} of the context window used${ctxLvl === 'danger' ? `: over the ${CEILING_PCT}% ceiling` : ctxLvl === 'warn' ? `: past ${HANDOFF_PCT}%, hand it off` : ''}`}>${Math.floor(ctxP)}%</span>`}
      </button>`);
      const rs = runSpans(a, now);
      const bar = (rs.length ? rs : sp ? [{ start: sp.start, end: sp.start }] : []).map((r, i) => {
        const x0 = scale.x(r.start), x1 = scale.x(r.end);
        return html`<span key=${i} class=${cx('pn-tl-bar', `st-${a.status}`, !rs.length && 'unknown')} style=${{ left: `${x0}px`, width: `${Math.max(2, x1 - x0)}px` }}></span>`;
      });
      tracks.push(html`<div key=${a.id} class=${cx('pn-tl-track', on && 'on')} onPointerEnter=${enter(a.id)} onClick=${() => pick(a.id)}>${bar}</div>`);
    }
  }

  // Running-count strip: a step area; the stretches at the peak are drawn a shade darker.
  let area = '', peakRects = [];
  if (steps.length) {
    const y = (n) => STRIP_H - 2 - (peak ? (n / peak) * (STRIP_H - 6) : 0);
    let d = `M${scale.x(steps[0].t).toFixed(1)},${STRIP_H}`;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const x = scale.x(s.t);
      d += ` H${x.toFixed(1)} V${y(s.n).toFixed(1)}`;
      if (s.n === peak && peak > 0 && steps[i + 1]) {
        const x2 = scale.x(steps[i + 1].t);
        peakRects.push(html`<rect x=${x} y=${y(peak)} width=${Math.max(1, x2 - x)} height=${STRIP_H - y(peak)} class="pn-tl-peak" />`);
      }
    }
    d += ` V${STRIP_H} Z`;
    area = d;
  }

  return html`<div class="pn-tl" onPointerLeave=${() => setHover(null)}>
    <div class="pn-tl-chart">
      <div class="pn-tl-labels">
        <div class="pn-tl-axis-lab">Agent</div>
        ${labels}
        <div class="pn-tl-strip-lab" title="How many agents ran at once">At once</div>
      </div>
      <div class="pn-tl-scroll" ref=${scrollRef} onScroll=${onScroll}>
        <div class="pn-tl-canvas" style=${{ width: `${scale.width}px` }}>
          <div class="pn-tl-axis" aria-hidden="true">
            ${ticks.map((tk) => html`<span key=${tk.t} class=${cx('pn-tl-tick', (tk.x < 24 || tk.edge) && 'start')} style=${{ left: `${tk.x}px` }}>${fmtTick(tk.t, tk.step)}</span>`)}
            <span class="pn-tl-now-lab" style=${{ left: `${nowX}px` }}>now</span>
            ${scale.breaks.map((b, i) => {
              const gap = scale.segments[i + 1].t0 - scale.segments[i].t1;
              return html`<span key=${`b${i}`} class="pn-tl-axis-break" style=${{ left: `${b.x}px`, width: `${b.w}px` }} title=${`${fmtDuration(gap, { seconds: false })} with no agents running, collapsed`}></span>`;
            })}
          </div>
          <div class="pn-tl-grid" aria-hidden="true">
            ${ticks.map((tk) => html`<span key=${tk.t} class="pn-tl-gridline" style=${{ left: `${tk.x}px` }}></span>`)}
            ${scale.breaks.map((b, i) => html`<span key=${`b${i}`} class="pn-tl-break" style=${{ left: `${b.x}px`, width: `${b.w}px` }}></span>`)}
            <span class="pn-tl-now" style=${{ left: `${nowX}px` }}></span>
          </div>
          ${tracks}
          <svg class="pn-tl-strip" width=${scale.width} height=${STRIP_H + 8} role="img" aria-label=${`At most ${peak} agent${peak === 1 ? '' : 's'} at once`}>
            <g transform="translate(0,8)">${area && html`<path d=${area} class="pn-tl-area" />`}
            ${peakRects}</g>
          </svg>
        </div>
      </div>
    </div>
    <${Details} a=${shown} now=${now} onReveal=${onReveal} onOpen=${onOpen} />
  </div>`;
}
