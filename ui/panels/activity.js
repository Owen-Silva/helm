// Active hours (lane activity): how long Claude actually worked, from every Claude Code transcript on
// this PC (Helm sessions, terminal sessions and every subagent). Data: activity.summary (PROTOCOL
// "activity.*"), refetched at most once a minute while the Usage panel is open (the host rescans at
// most once a minute too). Looks like the History charts above it: same cards, bars and project rows.
// All time (lane alltime): asked with { allTime: true }; the host serves the 14-day view first and
// counts every older transcript in the background, so while allTime.scanning is set this polls every
// 2 s and shows "Counting all time… N of M files" (never a blank or a 0).
import { html, cx, fmtAgo, Loading, Empty, SectionHead } from './util.js';
import { rpc } from '../lib/store.js';
import { useState, useEffect, useLayoutEffect } from 'preact/hooks';
import { signal } from '@preact/signals';

const REFETCH_MS = 60_000;
const SCANNING_MS = 2_000; // poll while the all-time count runs (the host answers from memory)
const DAYS = 14;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const localKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d, 12); };
const fmtDayShort = (k) => parseKey(k).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtDayLong = (k) => parseKey(k).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const parseMonth = (k) => { const [y, m] = String(k).split('-').map(Number); return new Date(y, m - 1, 15, 12); };
const fmtMonthShort = (k) => parseMonth(k).toLocaleDateString([], { month: 'short' });
const fmtMonthLong = (k) => parseMonth(k).toLocaleDateString([], { month: 'long', year: 'numeric' });
const monthKey = (ts) => localKey(ts).slice(0, 7);
// "Jul 16" this year, "Jul 16, 2025" before
const fmtSince = (k) => { const d = parseKey(k); return d.toLocaleDateString([], d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }); };
const scanningOf = (d) => (d?.allTime?.scanning ? d.allTime.scanning : null);

// 6h 05m · 43m · <1m · 0m (hours never roll into days: "38h 52m" reads better for a week)
export function fmtHM(ms) {
  if (!isNum(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
// Agent-hours as a plain number of hours: 16.3 · 110 · <0.1 · 0
export function fmtAgentH(ms) {
  if (!isNum(ms) || ms <= 0) return '0';
  const h = ms / 3_600_000;
  if (h >= 100) return Math.round(h).toLocaleString();
  if (h >= 0.1) return h.toFixed(1);
  return '<0.1';
}

// One shared copy, so reopening the panel shows the last numbers at once while a fresh scan runs.
const act = signal({ data: null, error: null, loading: true, at: 0 });
let users = 0;
let timer = null;
let inflight = null;
function load() {
  if (inflight) return inflight;
  act.value = { ...act.value, loading: true };
  inflight = rpc('activity.summary', { days: DAYS, allTime: true })
    .then((data) => { act.value = { data, error: null, loading: false, at: Date.now() }; })
    .catch((error) => { act.value = { ...act.value, error, loading: false, at: Date.now() }; })
    .finally(() => { inflight = null; });
  return inflight;
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    if (!users) return;
    if (typeof document === 'undefined' || !document.hidden) await load();
    schedule();
  }, scanningOf(act.value.data) ? SCANNING_MS : REFETCH_MS);
}
// lane home: Home's "Active today" chip reads this same shared copy: no second loader and no polling of its own.
// It asks for a fresh copy only when there is none or it is older than maxAgeMs (same call as the panel's, so the
// host answers it from the same scan cache); the panel's own 60 s refresh is unchanged.
export const activityShared = act;
export function refreshActivityIfStale(maxAgeMs) {
  const a = act.peek();
  if (!inflight && (!a.data || Date.now() - a.at >= maxAgeMs)) load();
}

function useActivity() {
  useEffect(() => {
    users++;
    // schedule() after the load, so a running all-time count polls every 2 s from the start
    if (!act.value.data || Date.now() - act.value.at >= REFETCH_MS) load().finally(() => { if (users) schedule(); });
    else schedule();
    return () => { if (--users === 0) { clearTimeout(timer); timer = null; } };
  }, []);
  return act.value;
}

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

function reasonOf(err) {
  const msg = err?.message || (err ? String(err) : '');
  if (err?.code === 'unknown_method' || /unknown method/i.test(msg)) return 'Active hours isn\'t available from this Helm host yet: it has no activity.summary method. Restart Helm after updating.';
  return msg ? `Active hours couldn't load. ${msg}` : 'Active hours couldn\'t load.';
}

function Headline({ today, week, all }) {
  const stat = (label, v) => html`<div class="pn-ah-stat">
    <span class="pn-us-title">${label}</span>
    <span class="pn-us-pct pn-num">${fmtHM(v?.activeMs)}</span>
    <span class="pn-ah-sub pn-num" title="Every session and agent added up: two working at once count twice">${fmtAgentH(v?.agentMs)} agent-hours</span>
  </div>`;
  return html`<div class="pn-us-card pn-ah-head">${stat('Today', today)}${stat('Last 7 days', week)}<${AllTimeStat} all=${all} /></div>`;
}

// The headline's full-width bottom row: all-time active time, agent-hours and since when; while the
// host is still counting, how far it has got (a plain bar, no animation); why when it can't.
function AllTimeStat({ all }) {
  let main, side;
  if (all?.scanning) {
    const { done = 0, total = 0 } = all.scanning;
    const pct = total > 0 ? clamp((done / total) * 100, 0, 100) : 0;
    main = html`<span class="pn-ah-counting">Counting all time…</span>`;
    side = html`<span class="pn-ah-sub pn-num">${total > 0 ? `${done.toLocaleString()} of ${total.toLocaleString()} files` : 'Listing transcripts…'}</span>
      <span class="pn-ah-progress" role="progressbar" aria-label="All-time count" aria-valuemin="0" aria-valuemax=${total || 1} aria-valuenow=${done}><span style=${{ transform: `scaleX(${pct / 100})` }}></span></span>`;
  } else if (all && isNum(all.activeMs)) {
    main = html`<span class="pn-us-pct pn-num">${fmtHM(all.activeMs)}</span>`;
    side = html`<span class="pn-ah-sub pn-num" title="Every session and agent added up: two working at once count twice">${fmtAgentH(all.agentMs)} agent-hours</span>
      <span class="pn-ah-sub">${all.since ? `since ${fmtSince(all.since)}` : 'no Claude work yet'}</span>`;
  } else {
    const why = all?.error ? `Couldn't count all time: ${all.error}` : 'This Helm host doesn\'t count all time yet. Restart Helm after updating.';
    main = html`<span class="pn-us-pct pn-num pn-muted">–</span>`;
    side = html`<span class="pn-ah-sub pn-ah-why" title=${why}>${why}</span>`;
  }
  return html`<div class="pn-ah-stat pn-ah-all">
    <div class="pn-ah-all-main"><span class="pn-us-title">All time</span>${main}</div>
    <div class="pn-ah-all-side">${side}</div>
  </div>`;
}

// One bar per day or per month (same card, bars, max label, axis and detail rows for both).
//   items: [{ key, activeMs, agentMs }]; current: index of today / this month (-1 = none)
//   nameOf(i): detail + tooltip name; first/last: axis labels; title, noun ('day' | 'month')
function Bars({ items, current, nameOf, first, last, title, noun }) {
  const [ref, measured] = useWidth();
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);
  const W = measured || 320;
  const H = 64, padT = 14;
  const n = items.length;
  const total = items.reduce((t, d) => t + (isNum(d.activeMs) ? d.activeMs : 0), 0);
  const totalAgent = items.reduce((t, d) => t + (isNum(d.agentMs) ? d.agentMs : 0), 0);
  const slot = W / n;
  const bw = clamp(slot - 6, 3, 24);
  const max = Math.max(...items.map((d) => (isNum(d.activeMs) ? d.activeMs : 0)));
  const base = H;
  const bh = (v) => (max > 0 ? (v / max) * (H - padT) : 0);
  const sel = clamp(hover ?? pin ?? (current >= 0 ? current : n - 1), 0, n - 1);
  const maxIdx = items.findIndex((d) => d.activeMs === max);
  const bar = (i, v) => {
    const h = Math.max(1, bh(v));
    const x0 = i * slot + (slot - bw) / 2, x1 = x0 + bw, top = base - h, r = Math.min(4, h, bw / 2);
    return `M${x0.toFixed(1)},${base}V${(top + r).toFixed(1)}Q${x0.toFixed(1)},${top.toFixed(1)} ${(x0 + r).toFixed(1)},${top.toFixed(1)}H${(x1 - r).toFixed(1)}Q${x1.toFixed(1)},${top.toFixed(1)} ${x1.toFixed(1)},${(top + r).toFixed(1)}V${base}Z`;
  };
  const idxAt = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp(Math.floor(((e.clientX - r.left) / (r.width || W)) * n), 0, n - 1);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPin(clamp(sel - 1, 0, n - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPin(clamp(sel + 1, 0, n - 1)); }
  };
  const d = items[sel];
  const maxX = clamp(maxIdx * slot + slot / 2, 18, W - 18);
  const parallel = d.activeMs > 0 ? d.agentMs / d.activeMs : 0;

  return html`<div class="pn-us-card pn-uh-card">
    <div class="pn-us-row">
      <span class="pn-us-title">${title}</span>
      <span class="pn-uh-aside pn-num">${fmtHM(total)} total</span>
    </div>
    <div class="pn-uh-plot pn-uh-bars" ref=${ref} tabindex="0" role="img"
      aria-label=${`${title}: ${fmtHM(total)} in total, ${fmtAgentH(totalAgent)} agent-hours. Arrow keys pick a ${noun}.`}
      onPointerMove=${(e) => (e.pointerType === 'mouse' ? setHover(idxAt(e)) : setPin(idxAt(e)))} onPointerLeave=${() => setHover(null)}
      onPointerDown=${(e) => setPin(idxAt(e))} onKeyDown=${onKey}>
      <svg class="pn-uh-svg" viewBox=${`0 0 ${W} ${H}`} width="100%" height=${H} aria-hidden="true">
        <line class="pn-uh-base" x1="0" x2=${W} y1=${base - 0.5} y2=${base - 0.5} />
        ${items.map((it, i) => isNum(it.activeMs) && it.activeMs > 0 && html`<path key=${it.key} class=${cx('pn-uh-bar', i === current && 'today', i === sel && 'sel')} d=${bar(i, it.activeMs)}>
          <title>${`${nameOf(i)}: ${fmtHM(it.activeMs)} active, ${fmtAgentH(it.agentMs)} agent-hours`}</title>
        </path>`)}
        <text class="pn-uh-maxlabel" x=${maxX} y=${base - bh(max) - 4} text-anchor="middle">${fmtHM(max)}</text>
      </svg>
      <div class="pn-uh-axis pn-uh-days" aria-hidden="true">
        <span class="first">${first}</span>
        ${n > 1 && html`<span class="last">${last}</span>`}
      </div>
    </div>
    <div class="pn-uh-detail pn-ah-detail" aria-live="polite">
      <div class="pn-us-row pn-uh-detail-head">
        <span>${nameOf(sel)}</span>
        <span class="pn-num pn-strong">${fmtHM(d.activeMs)} active</span>
      </div>
      <div class="pn-us-row pn-ah-detail-sub">
        <span>Agent-hours</span>
        <span class="pn-num">${fmtAgentH(d.agentMs)}${parallel >= 1.05 ? html`<span class="pn-muted"> · ${parallel.toFixed(1)} at once on average</span>` : ''}</span>
      </div>
    </div>
  </div>`;
}

function DayBars({ days }) {
  const n = days.length;
  const today = days.findIndex((d) => d.date === localKey(Date.now()));
  return html`<${Bars} items=${days.map((d) => ({ key: d.date, activeMs: d.activeMs, agentMs: d.agentMs }))} current=${today}
    nameOf=${(i) => (i === today ? 'Today' : fmtDayLong(days[i].date))}
    first=${fmtDayShort(days[0].date)} last=${today === n - 1 ? 'Today' : fmtDayShort(days[n - 1].date)}
    title=${`Active time per day · last ${n} days`} noun="day" />`;
}

function MonthBars({ months }) {
  const n = months.length;
  const cur = months.findIndex((m) => m.month === monthKey(Date.now()));
  return html`<${Bars} items=${months.map((m) => ({ key: m.month, activeMs: m.activeMs, agentMs: m.agentMs }))} current=${cur}
    nameOf=${(i) => (i === cur ? `This month (${fmtMonthShort(months[i].month)})` : fmtMonthLong(months[i].month))}
    first=${fmtMonthLong(months[0].month)} last=${cur === n - 1 ? 'This month' : fmtMonthLong(months[n - 1].month)}
    title="Active time per month · all time" noun="month" />`;
}

// Which range the projects list shows: 'days' (last 14 days) or 'all' (all time). Kept across reopen.
const projScope = signal('days');

function Projects({ rows, days, allRows }) {
  const allReady = Array.isArray(allRows);
  const scope = projScope.value === 'all' && allReady ? 'all' : 'days';
  const list = (scope === 'all' ? allRows : rows).filter((p) => isNum(p.agentMs) && p.agentMs > 0);
  if (!list.length && scope === 'days' && !allReady) return null;
  const shown = list.length <= 6 ? list : list.slice(0, 5);
  const rest = list.length > 6 ? list.slice(5) : [];
  const top = Math.max(...shown.map((p) => p.activeMs || 0), 1);
  const tip = (p) => `${p.cwd || p.project}\n${fmtHM(p.activeMs)} active, ${fmtAgentH(p.agentMs)} agent-hours`;
  return html`<div class="pn-us-card pn-uh-card">
    <div class="pn-us-row">
      <span class="pn-us-title">Top projects<span class="pn-ah-title-extra"> · active time</span></span>
      <div class="seg sm pn-ah-scope" role="group" aria-label="Projects over">
        <button type="button" aria-pressed=${scope === 'days'} onClick=${() => { projScope.value = 'days'; }} title=${`Active time per project in the last ${days} days`}>${days} days</button>
        <button type="button" aria-pressed=${scope === 'all'} disabled=${!allReady} onClick=${() => { projScope.value = 'all'; }}
          title=${allReady ? 'Active time per project, all time' : 'Still counting all time'}>All time</button>
      </div>
    </div>
    ${!list.length && html`<div class="pn-us-why">${scope === 'all' ? 'No project has any Claude work yet.' : `No project has Claude work in the last ${days} days.`}</div>`}
    <ul class="pn-uh-projects pn-ah-projects">
      ${shown.map((p) => html`<li key=${p.cwd || p.project} title=${tip(p)}>
        <span class="pn-uh-proj-name">${p.project}</span>
        <span class="pn-uh-proj-bar"><span style=${{ width: `${Math.min(100, ((p.activeMs || 0) / top) * 100)}%` }}></span></span>
        <span class="pn-uh-proj-cost pn-num">${fmtHM(p.activeMs)}</span>
      </li>`)}
      ${rest.length > 0 && html`<li class="more" title=${rest.map((p) => `${p.project}: ${fmtHM(p.activeMs)}`).join('\n')}>
        <span class="pn-uh-proj-name">${rest.length} more</span>
        <span class="pn-uh-proj-bar"><span style=${{ width: '0%' }}></span></span>
        <span class="pn-uh-proj-cost pn-num">${fmtHM(rest.reduce((t, p) => t + (p.activeMs || 0), 0))}</span>
      </li>`}
    </ul>
    <div class="pn-us-why">A project's time is the union of its own sessions and agents, so projects worked on side by side can add up to more than the total.</div>
  </div>`;
}

function HowCounted({ capMs, windowDays }) {
  const cap = Math.round((capMs || 600_000) / 60_000);
  return html`<details class="pn-ah-how">
    <summary>How this is counted</summary>
    <p><b>Active time</b> is wall-clock time when at least one Claude was working. <b>Agent-hours</b> add up every
      session and agent, so three agents working for an hour count as three.</p>
    <p>Helm reads every Claude Code transcript on this PC (Helm sessions, terminal sessions and subagents),
      read-only: the days use the ones written in the last ${windowDays || 30} days, and all time uses every one still
      there. Claude Code deletes old transcripts (its cleanupPeriodDays setting), so all time starts at the oldest one
      it kept. A turn counts from your prompt through Claude's last message of
      that turn; the time between turns never counts. Inside a turn, a silence longer than ${cap} minutes counts as
      ${cap} minutes (that is a permission prompt or a stall, not work). Time a session spends waiting on its own
      agents, or on your answer to Claude's question, isn't counted for that session. A turn still running counts up
      to its latest step. Days are your local days.</p>
  </details>`;
}

export function ActiveHoursSection() {
  const st = useActivity();
  const d = st.data;
  const working = d?.live?.workingNow || 0;
  const aside = working > 0 ? html`<span class="pn-ah-live"><span class="dot working" aria-hidden="true"></span>${working} working now</span>` : null;
  const retry = html`<button type="button" class="btn sm" onClick=${() => load()} disabled=${st.loading}>${st.loading ? 'Reading…' : 'Try again'}</button>`;

  let body;
  if (!d && st.loading) {
    body = html`<${Loading} label="Reading Claude Code transcripts… The first scan reads the last 30 days and can take about 10 seconds." />`;
  } else if (!d) {
    body = html`<div class="pn-uh-unavail pn-ah-unavail" role="alert">${reasonOf(st.error)} ${retry}</div>`;
  } else if (d.missing) {
    body = html`<${Empty} icon="folder" title="No Claude Code transcripts folder">Active hours reads Claude Code's own transcripts in ${d.dir || '~/.claude/projects'}, and that folder doesn't exist on this PC.<//>`;
  } else if (!d.files && !(d.allTime && (d.allTime.scanning || d.allTime.files))) {
    body = html`<${Empty} icon="clock" title="No recent transcripts">Nothing in ${d.dir || '~/.claude/projects'} was written in the last ${d.windowDays || 30} days, so there's no Claude work to count.<//>`;
  } else {
    const days = (Array.isArray(d.days) ? d.days : []).filter((x) => x && typeof x.date === 'string');
    const any = days.some((x) => x.agentMs > 0);
    const all = d.allTime;
    const allReady = !!all && isNum(all.activeMs);
    const months = allReady && Array.isArray(all.byMonth) ? all.byMonth.filter((m) => m && typeof m.month === 'string') : [];
    const anyAll = months.some((m) => m.agentMs > 0);
    body = html`<div class="pn-us-cards pn-uh pn-ah">
      <${Headline} today=${d.today} week=${d.week} all=${all} />
      ${any ? html`<${DayBars} days=${days} />`
        : html`<div class="pn-us-card"><div class="pn-us-why">No Claude work in the last ${days.length} days: ${d.files.toLocaleString()} transcripts read, none had a turn in that time.</div></div>`}
      ${anyAll && html`<${MonthBars} months=${months} />`}
      ${(any || anyAll) && html`<${Projects} rows=${Array.isArray(d.byProject) ? d.byProject : []} days=${days.length} allRows=${allReady && Array.isArray(all.byProject) ? all.byProject : null} />`}
      <${HowCounted} capMs=${d.capMs} windowDays=${d.windowDays} />
      <div class="pn-ah-meta pn-num">${d.files.toLocaleString()} transcripts in the last ${d.windowDays || 30} days${allReady && isNum(all.files) ? ` · ${all.files.toLocaleString()} all time` : ''} · updated ${fmtAgo(d.scannedAt)}${isNum(d.scanMs) ? ` · read in ${d.scanMs < 1000 ? `${d.scanMs} ms` : `${(d.scanMs / 1000).toFixed(1)} s`}` : ''}</div>
    </div>`;
  }
  return html`<${SectionHead} title="Active hours">${aside}<//>
    ${d && st.error && html`<div class="pn-uh-unavail" role="status">Couldn't refresh: ${st.error.message || String(st.error)} Showing the last scan.</div>`}
    ${d && Array.isArray(d.warnings) && d.warnings.length > 0 && html`<div class="pn-uh-unavail" role="status">Not everything could be read (the last good copy is used): ${d.warnings.join('; ')}</div>`}
    ${body}`;
}
