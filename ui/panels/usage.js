// Owner: lane panels (E). Usage panel (5H window, week, cost today, per-session cost) and the tiny
// UsageMeter the shell can drop into its header or rail. Unknown fields say why; never a fake number.
import { html, Icon, cx, fmtDuration, fmtCost, fmtAgo, fmtPct, dotClass, useNow, Empty, Loading, SectionHead } from './util.js';
import { usage, sessions, ready, rpc, selectSession, activeId, auth } from '../lib/store.js';
import { limitsOff, CONSOLE_USAGE_URL, NO_LIMITS_TITLE, NO_LIMITS_TEXT, NO_LIMITS_LINK, NO_LIMITS_CHIP, NO_LIMITS_TIP } from '../lib/usage-limits.js';   // lane prep-helm-auth-usage
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { paceReadout } from './pace-math.js';
import { showPanel } from './state.js';
import { sheetOpen, isPhone, view, phoneScreen, openSession } from '../shell/state.js';
import { ActiveHoursSection } from './activity.js';
import { EtaAccuracySection } from './eta-accuracy.js';   // lane eta-accuracy: Usage > Estimates

const FIVE_H = 5 * 3600_000;
const WEEK = 7 * 24 * 3600_000;
const SOURCE_LABEL = { statusline: 'Claude Code status line', sdk: 'Claude Code SDK', estimate: 'Helm estimate (not exact)' };

function level(p) { return p == null ? '' : p >= 95 ? 'danger' : p >= 80 ? 'warn' : ''; }

// Where in its window are we? 0..100, or null when the reset time is unknown.
function evenPace(resetsAt, span, now) {
  if (!resetsAt) return null;
  const left = resetsAt - now;
  if (left <= 0 || left > span) return null;
  return ((span - left) / span) * 100;
}

// A reading nothing has refreshed for 30+ min (engine usage.stale): say how old it is and what it misses.
function staleNote(u, now = Date.now()) {
  if (!u?.stale || !isNum(u.updatedAt)) return '';
  return `Last reading ${fmtAgo(u.updatedAt, now)}: no Claude Code session has reported since, so use on claude.ai or another device after that isn't in it.`;
}
const fmtClockShort = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Today's cost note: counting began after midnight (Helm's first run, or its corrected cost record).
function costSinceNote(u) {
  return isNum(u?.costTodaySince) ? `Counted from ${fmtClockShort(u.costTodaySince)}, when Helm's cost record starts.` : '';
}

const sentence = (s) => { const t = String(s).trim(); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''; };
const isNum = (v) => typeof v === 'number' && isFinite(v);

function unknownReason(u, field) {
  if (!u) return 'No usage reading yet. Helm reads it from Claude Code once a session has run a turn.';
  if (u.reason && field !== 'cost') return sentence(u.reason);
  if (!u.source) return 'No live session has reported this yet. It arrives with Claude Code\'s status line once a session runs a turn.';
  const src = SOURCE_LABEL[u.source] || u.source;
  if (field === 'fiveHour') return `Not reported by ${src}. The 5-hour figure arrives with Claude Code's status line on a subscription plan.`;
  if (field === 'week') return `Not reported by ${src}. The weekly figure arrives with Claude Code's status line on a subscription plan.`;
  if (field === 'cost') return `Not reported by ${src} yet today.`;
  return 'Unknown.';
}

// at = when the reading was taken: the percent is as of then, so even pace is measured then too (lane
// integrate2: a 2 h old 99% read "24 pts ahead" against now when it was 69 pts ahead when read). stale labels it.
function WindowCard({ title, win, span, now, at = now, stale = false, reason, paceLine = false }) {
  const p = isNum(win?.percent) ? win.percent : null;
  if (p == null) {
    return html`<div class="pn-us-card">
      <div class="pn-us-row"><span class="pn-us-title">${title}</span><span class="pn-us-unknown">unknown</span></div>
      <div class="pn-us-why">${reason}</div>
    </div>`;
  }
  const lvl = level(p);
  const resetsAt = isNum(win.resetsAt) ? win.resetsAt : null;
  const pace = evenPace(resetsAt, span, at);
  const delta = pace == null ? null : p - pace;
  const left = resetsAt ? resetsAt - now : null;
  return html`<div class="pn-us-card">
    <div class="pn-us-row">
      <span class="pn-us-title">${title}</span>
      <span class=${cx('pn-us-pct pn-num', lvl)}>${fmtPct(p)}</span>
    </div>
    <div class=${cx('pn-meter pn-us-meter', lvl)} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${p} aria-label=${title + ' used'}>
      <span class="pn-meter-clip"><span class="pn-meter-fill" style=${{ transform: `translateX(${Math.min(100, p) - 100}%)` }}></span></span>
      ${pace != null && html`<span class="pn-us-pace" style=${{ left: `${pace}%` }} title=${stale ? `Even pace at the last reading: ${fmtPct(pace)}` : `Even pace: ${fmtPct(pace)} by now`}></span>`}
    </div>
    <div class="pn-us-row pn-us-sub">
      <span class="pn-num">${left == null ? 'Reset time unknown' : left <= 0 ? 'Resetting now' : `Resets in ${fmtDuration(left, { seconds: false })}`}</span>
      ${pace != null && html`<span class=${cx('pn-num', delta > 5 && 'pn-us-ahead')}>
        ${Math.abs(delta) < 1 ? 'On even pace' : delta > 0 ? `${Math.round(delta)} pts ahead of even pace${stale ? ' when read' : ''}` : `${Math.round(-delta)} pts under even pace${stale ? ' when read' : ''}`}
      </span>`}
    </div>
    ${paceLine && html`<${PaceLine} win=${win} now=${now} />`}
  </div>`;
}

// No 5-hour/weekly limits (an API key; auth.usageLimits === false): one card in place of the 5-hour and weekly windows, saying why there are none
// and where the key's spend is. The cost card and By session below stay: those are real API spend.
function NoLimitsCard() {
  return html`<div class="pn-us-card pn-us-nolimits" role="note">
    <div class="pn-us-row"><span class="pn-us-title">${NO_LIMITS_TITLE}</span></div>
    <div class="pn-us-why">${NO_LIMITS_TEXT}</div>
    <a class="btn btn-sm pn-us-console" href=${CONSOLE_USAGE_URL} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${13} />${NO_LIMITS_LINK}</a>
  </div>`;
}

export function UsagePanel() {
  const u = usage.value;
  const noLimits = limitsOff(auth.value);   // no 5-hour/weekly limits (an API key): no 5H / week windows; cost stays (lib/usage-limits.js)
  // Tick only while a reset countdown is on screen.
  const counting = !noLimits && [u?.fiveHour, u?.week].some((w) => isNum(w?.percent) && isNum(w?.resetsAt) && w.resetsAt > Date.now());
  const now = useNow(30_000, counting);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const refresh = async () => {
    setBusy(true); setErr(null);
    try { usage.value = await rpc('usage.get', {}); } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (!ready.value) return html`<div class="pn"><${Loading} label="Connecting…" /></div>`;

  const readAt = isNum(u?.updatedAt) ? Math.min(u.updatedAt, now) : now; // the percents are as of this
  const costed = sessions.value.filter((s) => isNum(s.costUsd) && s.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
  const maxCost = costed.length ? costed[0].costUsd : 0;
  const totalSessions = costed.reduce((t, s) => t + s.costUsd, 0);
  const helmOnly = u?.costTodayScope === 'helm';
  const cost = isNum(u?.costTodayUsd) ? u.costTodayUsd : null;
  const srcLabel = u?.source ? (SOURCE_LABEL[u.source] || u.source) : null;

  return html`<div class="pn pn-usage">
    <div class="pn-bar">
      <span class="pn-bar-grow">
        ${srcLabel ? html`<span title=${u.source}>${srcLabel}</span>${isNum(u.updatedAt) && html`<span class="pn-muted"> · updated ${fmtAgo(u.updatedAt, now)}</span>`}`
          : html`<span class="pn-muted">No live reading yet</span>`}
      </span>
      <button class="icon-btn" title="Refresh usage" aria-label="Refresh usage" disabled=${busy} onClick=${refresh}>${busy ? html`<span class="spinner sm" aria-hidden="true"></span>` : html`<${Icon} name="refresh" size=${15} />`}</button>
    </div>
    ${err && html`<div class="pn-note pn-note-warn" role="alert">Couldn't refresh: ${err.message || String(err)}</div>`}
    ${u?.source === 'estimate' && html`<div class="pn-note">These are Helm's estimates from token counts, not Claude's own meter.</div>`}
    ${u?.stale && !noLimits && html`<div class="pn-note pn-note-warn" role="status">${staleNote(u, now)}</div>`}

    <div class="pn-us-cards">
      ${noLimits ? html`<${NoLimitsCard} />` : html`
      <${WindowCard} title="5-hour window" win=${u?.fiveHour} span=${FIVE_H} now=${now} at=${readAt} stale=${!!u?.stale} reason=${unknownReason(u, 'fiveHour')} paceLine />
      <${WindowCard} title="This week" win=${u?.week} span=${WEEK} now=${now} at=${readAt} stale=${!!u?.stale} reason=${unknownReason(u, 'week')} />`}
      <div class="pn-us-card">
        <div class="pn-us-row">
          <span class="pn-us-title">${helmOnly ? 'Helm sessions today' : 'Cost today'}</span>
          ${cost != null ? html`<span class="pn-us-pct pn-num">${fmtCost(cost)}</span>` : html`<span class="pn-us-unknown">unknown</span>`}
        </div>
        ${cost == null ? html`<div class="pn-us-why">${unknownReason(u, 'cost')}</div>`
          : helmOnly && html`<div class="pn-us-why">Only what sessions run in Helm cost, from Claude Code's own figures. Claude Code used elsewhere isn't counted.${costSinceNote(u) ? ' ' + costSinceNote(u) : ''}</div>`}
      </div>
    </div>

    <${UsageHistorySection} noLimits=${noLimits} />
    <${EtaAccuracySection} />
    <${ActiveHoursSection} />

    <${SectionHead} title="By session">${costed.length ? html`<span class="pn-num" title="Each session's whole cost so far (Claude Code's own total for the conversation, all days), not today's">${fmtCost(totalSessions)} across ${costed.length}</span>` : null}<//>
    ${costed.length ? html`<ul class="pn-us-sessions">
      ${costed.map((s) => html`<li key=${s.id}>
        <button class=${cx('pn-us-sess', s.id === activeId.value && 'on')} onClick=${() => selectSession(s.id)} title=${s.title || ''}>
          <span class=${cx('dot', dotClass(s.status))}></span>
          <span class="pn-us-sess-name"><span class="pn-us-sess-title">${s.title || 'Untitled'}</span>${s.project && html`<span class="pn-us-sess-proj">${s.project}</span>`}</span>
          <span class="pn-us-sess-bar"><span style=${{ width: `${maxCost ? (s.costUsd / maxCost) * 100 : 0}%` }}></span></span>
          <span class="pn-us-sess-cost pn-num">${fmtCost(s.costUsd)}</span>
        </button>
      </li>`)}
    </ul>` : html`<${Empty} icon="gauge" title="No session costs yet">Each session's cost comes from Claude Code's result messages after a turn finishes.<//>`}
  </div>`;
}

// Compact meters for the sidebar footer / rail: "5H 37%" and "Week 15%", each with a mini bar, side
// by side (stacked when `compact`). One click target → onClick, or by default the Usage panel. The
// weekly meter is left out (never a blank or 0%) while Claude Code hasn't reported it; the tooltip
// then says why. Reset times are in the tooltip.
function openUsagePanel() {
  // The Usage panel lives in the inspector beside a session: bring one up first if none is on screen.
  const id = activeId.value || [...sessions.value].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]?.id;
  if (id && (view.value !== 'session' || (isPhone.value && phoneScreen.value !== 'session') || activeId.value !== id)) openSession(id);
  showPanel('usage');
  if (isPhone.value) sheetOpen.value = true;
}
function MiniMeter({ label, p, compact, stale }) {
  return html`<span class=${cx('pn-umeter', compact && 'compact', level(p), stale && 'stale')}>
    <span class="pn-umeter-label">${label}</span>
    <span class="pn-umeter-val pn-num">${p == null ? '—' : fmtPct(p)}</span>
    <span class="pn-umeter-bar"><span style=${{ transform: `translateX(${(p == null ? 0 : Math.min(100, p)) - 100}%)` }}></span></span>
  </span>`;
}
export function UsageMeter({ onClick, compact = false }) {
  if (limitsOff(auth.value)) {   // no 5-hour/weekly limits (an API key): no windows to meter. One quiet label + the reason; still opens the Usage panel (cost).
    return html`<button type="button" class=${cx('pn-umeters', compact && 'compact')} title=${NO_LIMITS_TIP} aria-label=${`${NO_LIMITS_TIP} Opens the Usage panel.`}
        onClick=${onClick || openUsagePanel}>
      <span class=${cx('pn-umeter pn-umeter-nolimits', compact && 'compact')}>
        <span class="pn-umeter-label">${NO_LIMITS_CHIP.key}</span><span class="pn-umeter-val">${compact ? 'API' : NO_LIMITS_CHIP.value}</span>
      </span>
    </button>`;
  }
  const u = usage.value;
  const now = Date.now();
  const p5 = isNum(u?.fiveHour?.percent) ? u.fiveHour.percent : null;
  const pw = isNum(u?.week?.percent) ? u.week.percent : null;
  const resets = (w) => {
    const left = isNum(w?.resetsAt) ? w.resetsAt - now : null;
    return left != null && left > 0 ? `, resets in ${fmtDuration(left, { seconds: false })}` : '';
  };
  const tip5 = p5 == null ? `5-hour usage unknown. ${unknownReason(u, 'fiveHour')}` : `5-hour window ${fmtPct(p5)} used${resets(u.fiveHour)}.`;
  const tipW = pw == null ? `Weekly usage not shown. ${unknownReason(u, 'week')}` : `Week ${fmtPct(pw)} used${resets(u.week)}.`;
  const aged = staleNote(u, now);
  const tip = `${tip5} ${tipW}${aged ? ` ${aged}` : ''}`;
  return html`<button type="button" class=${cx('pn-umeters', compact && 'compact')} title=${tip} aria-label=${`${tip} Opens the Usage panel.`}
      onClick=${onClick || openUsagePanel}>
    <${MiniMeter} label="5H" p=${p5} compact=${compact} stale=${!!aged} />
    ${pw != null && html`<${MiniMeter} label="Week" p=${pw} compact=${compact} stale=${!!aged} />`}
  </button>`;
}

// ---- History: usage.history (5H over 24 h, week over 7 days, cost per day over 14 days) ----
// Data comes from the engine's UsageHistory log. If the method is missing or fails, one quiet line
// says why; never a fake chart. Charts are drawn 1:1 in pixels (viewBox = measured width) so the
// 2px line and hairlines stay crisp at any panel width.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GAP_MS = 20 * MIN; // samples further apart than this mean Helm wasn't running: break the line
const REFETCH_MS = 60_000;

const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDayClock = (ts) => `${new Date(ts).toLocaleDateString([], { weekday: 'short' })} ${fmtClock(ts)}`;
const localKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d, 12); };
const fmtDayShort = (k) => parseKey(k).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtDayLong = (k) => parseKey(k).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Measured content width of an element (ResizeObserver); keeps the last non-zero width while hidden.
// Returns a callback ref so it still attaches when the element mounts after an empty state.
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

// Fetch usage.history on mount and when the usage signal changes, at most once a minute. One shared
// copy: the History section and the 5-hour pace line read the same samples (one fetch, not two).
const hist = signal({ data: null, error: null, loading: true });
let histLast = 0;
let histTimer = null;
let histUsers = 0;
async function loadUsageHistory() {
  histLast = Date.now();
  try {
    const data = await rpc('usage.history', { days: 14 });
    hist.value = { data, error: null, loading: false };
  } catch (error) {
    hist.value = { data: hist.value.data, error, loading: false };
  }
}
function useUsageHistory() {
  useEffect(() => {
    histUsers++;
    return () => { if (--histUsers === 0 && histTimer) { clearTimeout(histTimer); histTimer = null; } };
  }, []);
  const u = usage.value;
  useEffect(() => {
    const wait = histLast + REFETCH_MS - Date.now();
    if (wait <= 0) { loadUsageHistory(); return; }
    if (!histTimer) histTimer = setTimeout(() => { histTimer = null; if (histUsers) loadUsageHistory(); }, wait);
  }, [u]);
  return hist.value;
}

// ---- Pace line under the 5-hour bar (lane deck-pace): burn rate since the window opened, projected %
// at reset, and a calm verdict. Math in ./pace-math.js (test/host/pace.test.js).
const VERDICT_TIP = 'Burn rate from the first reading in this window to now. The projection assumes it eases to a typical 5%/h within the hour. '
  + 'Under pace: the window ends with room to spare. On pace: it runs out near the end. Hot: 100% would land more than 30 min before reset.';
function PaceLine({ win, now }) {
  const st = useUsageHistory();
  if (!st.data) {
    if (st.loading) return null;
    return html`<div class="pn-us-paceline muted" role="status">No pace: usage history isn't available.</div>`;
  }
  const r = paceReadout({ samples: st.data.samples, resetsAt: win.resetsAt, now, live: { percent: win.percent, at: usage.value?.updatedAt } });
  if (r.state !== 'ok') return html`<div class="pn-us-paceline muted" role="status">${r.text}</div>`;
  const [rate, middle, word] = r.parts;
  return html`<div class=${cx('pn-us-paceline', `v-${r.verdict}`)} role="status" title=${VERDICT_TIP}
      aria-label=${`Pace: ${rate.replace('%/h', ' percent an hour')}, ${middle}, ${word}`}>
    <span class="pn-num">${rate}</span><span class="pn-us-pacesep" aria-hidden="true">·</span><span class="pn-num">${middle}</span><span class="pn-us-pacesep" aria-hidden="true">·</span><span class="pn-us-verdict">${word}</span>
  </div>`;
}

function unavailableReason(err) {
  const msg = err?.message || (err ? String(err) : '');
  if (/unknown method|not (implemented|supported|found)|no such method|usage\.history/i.test(msg)) return 'Usage history isn\'t available from this engine yet.';
  return msg ? `Usage history couldn't load: ${msg}` : 'Usage history couldn\'t load.';
}

// Index of the sample nearest to time t (samples ascending by ts).
function nearest(pts, t) {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].ts < t) lo = mid; else hi = mid; }
  return Math.abs(pts[lo].ts - t) <= Math.abs(pts[hi].ts - t) ? lo : hi;
}

function timeTicks(t0, t1, kind) {
  const out = [];
  const d = new Date(t0);
  if (kind === 'hours') {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    while (d.getHours() % 6) d.setHours(d.getHours() + 1);
    for (; d.getTime() < t1; d.setHours(d.getHours() + 6)) out.push({ t: d.getTime(), label: d.toLocaleTimeString([], { hour: 'numeric' }) });
  } else {
    d.setHours(12, 0, 0, 0); // label each day at its noon
    if (d.getTime() < t0) d.setDate(d.getDate() + 1);
    for (; d.getTime() < t1; d.setDate(d.getDate() + 1)) out.push({ t: d.getTime(), label: d.toLocaleDateString([], { weekday: 'short' }) });
  }
  return out;
}

// One percent line over a time span: wash + 2px line, reset hairlines, end dot + value, crosshair.
function LineHistory({ title, samples, field, resetField, span, now, tickKind, fmtTime, emptyText }) {
  const [ref, measured] = useWidth();
  const [hi, setHi] = useState(null);
  const touchTimer = useRef(null);
  useEffect(() => () => clearTimeout(touchTimer.current), []);
  const W = measured || 320;
  const H = 56, padT = 6, padR = 40;
  const iw = Math.max(40, W - padR);
  const t1 = now, t0 = now - span;
  const pts = samples.filter((s) => isNum(s[field]) && s.ts >= t0 && s.ts <= t1);
  const x = (t) => ((t - t0) / span) * iw;
  const base = H - 0.5;
  const y = (p) => padT + (1 - clamp(p, 0, 100) / 100) * (base - padT);
  const gapMs = Math.max(GAP_MS, (span / iw) * 4); // a gap narrower than ~4px isn't visible anyway

  const segs = [];
  const resets = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i], prev = pts[i - 1];
    if (prev) {
      const rA = prev[resetField], rB = s[resetField];
      const moved = isNum(rA) && isNum(rB) && Math.abs(rA - rB) >= MIN && rA <= s.ts + MIN;
      const dropped = prev[field] - s[field] > 20;
      if (moved || dropped) { resets.push(isNum(rA) && rA > prev.ts && rA <= s.ts ? rA : s.ts); cur = null; }
      if (s.ts - prev.ts > gapMs) cur = null;
    }
    if (!cur) { cur = []; segs.push(cur); }
    cur.push(s);
  }
  const P = (s) => `${x(s.ts).toFixed(1)},${y(s[field]).toFixed(1)}`;
  const line = segs.map((g) => `M${g.map(P).join('L')}`).join('');
  const area = segs.filter((g) => g.length > 1).map((g) => `M${x(g[0].ts).toFixed(1)},${base}L${g.map(P).join('L')}L${x(g[g.length - 1].ts).toFixed(1)},${base}Z`).join('');
  const lone = segs.filter((g) => g.length === 1).map((g) => g[0]);
  const lastPt = pts[pts.length - 1];
  const peak = pts.reduce((m, s) => Math.max(m, s[field]), 0);
  const ticks = timeTicks(t0, t1, tickKind).filter((k) => x(k.t) > 16 && x(k.t) < iw - 16);
  const h = hi != null && pts[hi] ? pts[hi] : null;

  const pick = (e) => {
    if (!pts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / (r.width || W));
    setHi(nearest(pts, t0 + (clamp(px, 0, iw) / iw) * span));
  };
  // Touch / pen: tap or drag scrubs like hover; the readout clears itself a few seconds later.
  const onTouchish = (e) => {
    pick(e);
    clearTimeout(touchTimer.current);
    if (e.pointerType !== 'mouse') touchTimer.current = setTimeout(() => setHi(null), 4000);
  };
  const onKey = (e) => {
    if (!pts.length) return;
    const step = e.shiftKey ? 12 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHi((i) => clamp((i ?? pts.length) - step, 0, pts.length - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setHi((i) => clamp((i ?? pts.length - 2) + step, 0, pts.length - 1)); }
    else if (e.key === 'Escape') setHi(null);
  };

  if (!pts.length) {
    return html`<div class="pn-us-card pn-uh-card">
      <div class="pn-us-row"><span class="pn-us-title">${title}</span></div>
      <div class="pn-us-why">${emptyText}</div>
    </div>`;
  }
  const label = `${title}: latest ${fmtPct(lastPt[field])}, peak ${fmtPct(peak)}${resets.length ? `, ${resets.length} reset${resets.length > 1 ? 's' : ''}` : ''}. Arrow keys step through readings.`;
  return html`<div class="pn-us-card pn-uh-card">
    <div class="pn-us-row">
      <span class="pn-us-title">${title}</span>
      ${h ? html`<span class="pn-uh-read pn-num" aria-live="polite">${fmtTime(h.ts)} · <b>${fmtPct(h[field])}</b></span>`
        : html`<span class="pn-uh-aside pn-num">peak ${fmtPct(peak)}</span>`}
    </div>
    <div class="pn-uh-plot" ref=${ref} tabindex="0" role="img" aria-label=${label}
      onPointerMove=${onTouchish} onPointerDown=${onTouchish}
      onPointerLeave=${(e) => e.pointerType === 'mouse' && setHi(null)} onKeyDown=${onKey} onBlur=${() => setHi(null)}>
      <svg class="pn-uh-svg" viewBox=${`0 0 ${W} ${H}`} width="100%" height=${H} aria-hidden="true">
        <line class="pn-uh-base" x1="0" x2=${iw} y1=${base} y2=${base} />
        ${resets.map((t) => { const rx = Math.round(x(t)) + 0.5; return html`<line class="pn-uh-reset" x1=${rx} x2=${rx} y1=${padT - 2} y2=${base} />`; })}
        <path class="pn-uh-area" d=${area} />
        <path class="pn-uh-line" d=${line} />
        ${lone.map((s) => html`<circle class="pn-uh-lone" cx=${x(s.ts)} cy=${y(s[field])} r="1.5" />`)}
        <circle class="pn-uh-end" cx=${x(lastPt.ts)} cy=${y(lastPt[field])} r="3.5" />
        <text class="pn-uh-endlabel" x=${iw + 7} y=${clamp(y(lastPt[field]), 9, H - 4)} dominant-baseline="middle">${fmtPct(lastPt[field])}</text>
        ${h && html`<g class="pn-uh-hover">
          <line class="pn-uh-cross" x1=${Math.round(x(h.ts)) + 0.5} x2=${Math.round(x(h.ts)) + 0.5} y1="0" y2=${base} />
          <circle class="pn-uh-dot" cx=${x(h.ts)} cy=${y(h[field])} r="4" />
        </g>`}
      </svg>
      <div class="pn-uh-axis" aria-hidden="true">
        ${ticks.map((k) => html`<span style=${{ left: `${x(k.t)}px` }}>${k.label}</span>`)}
      </div>
    </div>
  </div>`;
}

// 14 slim bars, one per local day; tap/hover a bar for its per-project breakdown underneath.
function CostHistory({ days, costSince }) {
  const [ref, measured] = useWidth();
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);
  const W = measured || 320;
  const H = 64, padT = 14;
  const n = days.length;
  const today = days.findIndex((d) => d.day === localKey(Date.now()));
  const total = days.reduce((t, d) => t + (isNum(d.usd) ? d.usd : 0), 0);

  const unknownDays = days.filter((d) => d.unknown).length;
  const sinceText = isNum(costSince) ? new Date(costSince).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + fmtClock(costSince) : '';
  const unknownNote = unknownDays ? `Before ${sinceText || 'the fix'}: unknown. Helm's earlier records counted a resumed session's whole cost again, so they are not shown.` : '';
  if (!n || total <= 0) {
    return html`<div class="pn-us-card pn-uh-card">
      <div class="pn-us-row"><span class="pn-us-title">Cost per day · last ${n || 14} days</span></div>
      <div class="pn-us-why">No costs recorded${unknownDays ? ` since ${sinceText}` : ` in the last ${n || 14} days`}. Helm logs each session's cost when a turn finishes.${unknownNote ? ' ' + unknownNote : ''}</div>
    </div>`;
  }
  const slot = W / n;
  const bw = clamp(slot - 6, 3, 24);
  const max = Math.max(...days.map((d) => (isNum(d.usd) ? d.usd : 0)));
  const base = H;
  const bh = (v) => (max > 0 ? (v / max) * (H - padT) : 0);
  const sel = hover ?? pin ?? (today >= 0 ? today : n - 1);
  const maxIdx = days.findIndex((d) => d.usd === max);

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

  const d = days[sel];
  const entries = Object.entries(d.byProject || {}).filter(([, v]) => isNum(v) && v > 0).sort((a, b) => b[1] - a[1]);
  // Top 4 projects + the rest folded into one row (five or fewer: all shown, no "1 more").
  const rows = entries.length <= 5 ? entries : entries.slice(0, 4);
  if (entries.length > 5) rows.push([`${entries.length - 4} more`, entries.slice(4).reduce((t, [, v]) => t + v, 0), true]);
  const dayName = (i) => (i === today ? 'Today' : fmtDayLong(days[i].day));
  const maxX = clamp(maxIdx * slot + slot / 2, 18, W - 18);

  return html`<div class="pn-us-card pn-uh-card">
    <div class="pn-us-row">
      <span class="pn-us-title">Cost per day · last ${n} days</span>
      <span class="pn-uh-aside pn-num" title=${unknownDays ? `Total of the ${n - unknownDays} days with a reliable record` : 'Total of these days'}>${fmtCost(total)} total</span>
    </div>
    ${unknownNote && html`<div class="pn-us-why">${unknownNote}</div>`}
    <div class="pn-uh-plot pn-uh-bars" ref=${ref} tabindex="0" role="img"
      aria-label=${`Cost per day for the last ${n} days, ${fmtCost(total)} in total. Arrow keys pick a day.`}
      onPointerMove=${(e) => (e.pointerType === 'mouse' ? setHover(idxAt(e)) : setPin(idxAt(e)))} onPointerLeave=${() => setHover(null)}
      onPointerDown=${(e) => setPin(idxAt(e))} onKeyDown=${onKey}>
      <svg class="pn-uh-svg" viewBox=${`0 0 ${W} ${H}`} width="100%" height=${H} aria-hidden="true">
        <line class="pn-uh-base" x1="0" x2=${W} y1=${base - 0.5} y2=${base - 0.5} />
        ${days.map((day, i) => isNum(day.usd) && day.usd > 0 && html`<path class=${cx('pn-uh-bar', i === today && 'today', i === sel && 'sel')} d=${bar(i, day.usd)} />`)}
        <text class="pn-uh-maxlabel" x=${maxX} y=${base - bh(max) - 4} text-anchor="middle">${fmtCost(max)}</text>
      </svg>
      <div class="pn-uh-axis pn-uh-days" aria-hidden="true">
        <span class="first">${fmtDayShort(days[0].day)}</span>
        <span class="last">${today === n - 1 ? 'Today' : fmtDayShort(days[n - 1].day)}</span>
      </div>
    </div>
    <div class="pn-uh-detail" aria-live="polite">
      <div class="pn-us-row pn-uh-detail-head">
        <span>${dayName(sel)}</span>
        <span class="pn-num pn-strong">${d.unknown ? 'unknown' : fmtCost(d.usd)}</span>
      </div>
      ${d.partial && isNum(d.since) && html`<div class="pn-us-why">From ${fmtClock(d.since)}, when Helm's corrected cost record starts.</div>`}
      ${rows.length ? html`<ul class="pn-uh-projects">
        ${rows.map(([name, v, more]) => html`<li key=${name} class=${cx(more && 'more')}>
          <span class="pn-uh-proj-name" title=${name}>${name}</span>
          <span class="pn-uh-proj-bar"><span style=${{ width: `${d.usd > 0 ? Math.min(100, (v / d.usd) * 100) : 0}%` }}></span></span>
          <span class="pn-uh-proj-cost pn-num">${fmtCost(v)}</span>
        </li>`)}
      </ul>` : html`<div class="pn-us-why">${d.unknown ? 'No reliable record for this day (see above).' : 'No cost recorded this day.'}</div>`}
    </div>
  </div>`;
}

function UsageHistorySection({ noLimits = false }) {
  const st = useUsageHistory();
  const now = Date.now();
  let body;
  if (!st.data && st.loading) body = html`<${Loading} label="Loading history…" />`;
  else if (!st.data) body = html`<div class="pn-uh-unavail" role="status">${unavailableReason(st.error)}</div>`;
  else {
    const samples = (Array.isArray(st.data.samples) ? st.data.samples : []).filter((s) => s && isNum(s.ts)).sort((a, b) => a.ts - b.ts);
    const costs = (Array.isArray(st.data.costByDay) ? st.data.costByDay : []).filter((d) => d && typeof d.day === 'string');
    if ((noLimits || !samples.length) && !costs.some((d) => isNum(d.usd) && d.usd > 0)) {
      body = noLimits ? html`<${Empty} icon="history" title="No cost history yet">Each day's cost comes from Claude Code's result messages after a turn finishes. With an API key there are no 5-hour or weekly readings to chart.<//>`
        : html`<${Empty} icon="history" title="No history yet">Helm records a reading every 5 minutes while Claude Code is reporting fresh ones.<//>`;
    } else if (noLimits) {   // no 5-hour/weekly limits (an API key): cost per day only (no 5H / week windows to chart)
      body = html`<div class="pn-us-cards pn-uh"><${CostHistory} days=${costs} costSince=${st.data.costSince} /></div>`;
    } else {
      body = html`<div class="pn-us-cards pn-uh">
        <${LineHistory} title="5-hour window · last 24 h" samples=${samples} field="fiveHour" resetField="fiveHourResetsAt"
          span=${DAY} now=${now} tickKind="hours" fmtTime=${fmtClock}
          emptyText="No 5-hour readings in the last 24 hours. Helm records a reading every 5 minutes while Claude Code is reporting fresh ones." />
        <${LineHistory} title="Week · last 7 days" samples=${samples} field="week" resetField="weekResetsAt"
          span=${7 * DAY} now=${now} tickKind="days" fmtTime=${fmtDayClock}
          emptyText="No weekly readings in the last 7 days. Helm records a reading every 5 minutes while Claude Code is reporting fresh ones." />
        <${CostHistory} days=${costs} costSince=${st.data.costSince} />
      </div>`;
    }
  }
  return html`<${SectionHead} title="History" />
    ${st.error && st.data && html`<div class="pn-uh-unavail" role="status">${unavailableReason(st.error)} Showing the last copy.</div>`}
    ${body}`;
}
