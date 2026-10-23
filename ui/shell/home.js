// Home screen (lane home, 2026-10-08). Owner: lane shell (C). The user asked: "i want there to be like a home scren for helm
// and the blur goes away from the backround image when you are there when you press the helm logo in the very top
// left corner"; content "glance + jump back in, and active time today too"; layout "Full wallpaper".
// - Reached by the Helm logo (top-left), Ctrl+Shift+H, the palette's "Go home", the phone's Home tab, and closing
//   the last tab. Helm opens here. Navigation and the transition live in state.js (goHome, homeFx); the clear
//   wallpaper is chrome.js Background; styles in home.css.
// - A greeting and clock, a glance row (working now, 5H / week usage, 5-hour pace, active time today, Railway),
//   then the open sessions as cards (tabs first in tab order, then the sidebar's other active sessions) and a New session card.
// - Costs nothing while it sits there: it re-renders on the shared minute tick (activity.js minuteTick, already
//   running) and reads data the app already holds. "Active today" is the Usage panel's shared Active hours copy
//   (panels/activity.js), refreshed only when older than 5 minutes; no polling of its own.
// Pure rules (greeting, card order, status line): ui/lib/home-model.js, tested in test/host/home-model.test.js.
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { rpc, on, isMock } from '../lib/transport.js';
import { recapView, RECAP_MAX } from '../lib/home-model.js';   // lane recap
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { sessions, usage, auth } from '../lib/store.js';
import { limitsOff, NO_LIMITS_CHIP, NO_LIMITS_TIP } from '../lib/usage-limits.js';   // lane prep-helm-auth-usage
import { greetingFor, homeCards, glanceCounts, cardStatus, pctText } from '../lib/home-model.js';
import { paceOf, paceChip } from '../lib/pace.js';
import { activityShared, refreshActivityIfStale, fmtHM } from '../panels/activity.js';
import { minuteTick } from './activity.js';
import { projectGroups, openSession, newSessionOpen, isPhone, go } from './state.js';
import { tabIds } from './tabs.js';
import { cx, mod } from './util.js';
import { RailwayChip } from './railway-chip.js';
import { NextUp } from './next-up.js';   // lane sched: next 3 in-session schedules, live countdowns

const ACTIVITY_MAX_AGE_MS = 5 * 60_000;

function ActiveToday() {
  const a = activityShared.value;
  const d = a.data;
  let value, title;
  if (d && d.missing) { value = '—'; title = 'No Claude Code transcripts folder on this PC, so there is no active time to count.'; }
  else if (d) { value = fmtHM(d.today && d.today.activeMs); title = 'Time today with at least one Claude working (Usage panel → Active hours).'; }
  else if (a.error) { value = 'unavailable'; title = `Active hours did not load: ${a.error.message || a.error}`; }
  else { value = '…'; title = 'Counting active time…'; }
  return html`<span class="hchip" role="listitem" title=${title}><span class="hchip-k">Active today</span><span class="hchip-v tnum">${value}</span></span>`;
}

// 5-hour PACE verdict next to the 5H/Week chips ("Under pace · resets 6:40 PM", amber "Hot · resets in 30m").
// Thresholds as the user's pace mod; the projection is the backtested fade model (ui/lib/pace.js, lane helm-pace), and a
// reading over 1 h old shows "Old reading" with no projection. No reading, or a window that already reset:
// no chip at all, never a made-up verdict. Burn and projection are in the desktop tooltip. Re-renders with
// HomeView on the shared minute tick, so "resets in 30m" counts down without a timer of its own.
const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function PaceChip({ fiveHour, now, at, aged = '' }) {
  const c = paceChip(paceOf(fiveHour, now, at ?? now), clockOf);
  if (!c) return null;
  return html`<span class=${cx('hchip', 'hchip-pace', `pace-${c.tone}`, aged && 'stale')} role="listitem" data-pace=${c.verdict} title=${aged ? `${c.title}
From the reading${aged}` : c.title}
      aria-label=${`5-hour pace: ${c.label}, ${c.reset}`}>
    <span class="hchip-v">${c.label}</span><span class="hchip-k">· ${c.reset}</span>
  </span>`;
}

// No 5-hour/weekly limits (an API key; auth.usageLimits === false): no 5-hour or weekly window, so no 5H / Week / pace chips. One chip in their
// place says so, the reason in its tooltip (lane prep-helm-auth-usage; text in lib/usage-limits.js).
function NoLimitsChip() {
  return html`<span class="hchip hchip-nolimits" role="listitem" title=${NO_LIMITS_TIP} aria-label=${NO_LIMITS_TIP}>
    <span class="hchip-v">${NO_LIMITS_CHIP.key}</span><span class="hchip-k">· ${NO_LIMITS_CHIP.value}</span>
  </span>`;
}

const agoShort = (ms) => { const m = Math.max(1, Math.floor(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

function Glance({ now }) {
  const { working, waiting } = glanceCounts(sessions.value);
  const u = usage.value;
  const p5 = pctText(u && u.fiveHour && u.fiveHour.percent);
  const pw = pctText(u && u.week && u.week.percent);
  // An old reading (engine usage.stale) is dimmed and says its age: claude.ai use since then isn't in it.
  const aged = u && u.stale && typeof u.updatedAt === 'number' ? ` as of ${agoShort(now - u.updatedAt)} ago (no Claude Code session has reported since)` : '';
  return html`<div class="home-glance" role="list" aria-label="At a glance">
    <span class="hchip" role="listitem" title="Sessions working now (running agents count)">
      <span class=${cx('dot', working ? 'working' : 'idle')} aria-hidden="true"></span>
      <span class="hchip-v tnum">${working}</span><span class="hchip-k">working</span>
    </span>
    ${waiting > 0 && html`<span class="hchip warn" role="listitem" title="Sessions waiting on you">
      <span class="dot waiting" aria-hidden="true"></span>
      <span class="hchip-v tnum">${waiting}</span><span class="hchip-k">${waiting === 1 ? 'needs you' : 'need you'}</span>
    </span>`}
    ${limitsOff(auth.value) ? html`<${NoLimitsChip} />` : html`
    <span class=${cx('hchip', aged && 'stale')} role="listitem" title=${p5 ? `5-hour window ${p5} used${aged}` : '5-hour usage not reported yet'}>
      <span class="hchip-k">5H</span><span class="hchip-v tnum">${p5 || '—'}</span>
    </span>
    ${pw && html`<span class=${cx('hchip', aged && 'stale')} role="listitem" title=${`Week ${pw} used${aged}`}><span class="hchip-k">Week</span><span class="hchip-v tnum">${pw}</span></span>`}
    <${PaceChip} fiveHour=${u && u.fiveHour} now=${now} aged=${aged} at=${u && typeof u.updatedAt === 'number' ? u.updatedAt : now} />`}
    <${ActiveToday} />
    <${RailwayChip} />
  </div>`;
}

// ---------- "Since you left" (lane recap, 2026-10-09) ----------
// One row per session that did something since the user last had it on screen (any client): outcome, commits, files,
// cost, time span. The engine keeps the summaries (main/engine/recap.js, sessions.recap; zero Claude calls); Home
// fetches them when it mounts, when the engine says they changed (recap.updated) and on the minute tick. Hidden
// entirely when there is nothing to recap, or when the engine has no recap (fallback engine).
const recapRows = signal(null);
let recapBusy = false, recapAgain = false;
async function loadRecap() {
  if (recapBusy) { recapAgain = true; return; }
  recapBusy = true;
  try {
    const r = isMock ? (await import('../lib/mock-recap.js')).mockRecap() : await rpc('sessions.recap', {});
    recapRows.value = Array.isArray(r && r.rows) ? r.rows : [];
  } catch { if (recapRows.value == null) recapRows.value = []; }   // fallback engine / a blip: keep what we had
  finally {
    recapBusy = false;
    if (recapAgain) { recapAgain = false; loadRecap(); }
  }
}

function RecapRow({ r }) {
  const label = [r.title, r.project, r.lead, r.error, ...r.pieces.map((p) => [p.text, p.detail].filter(Boolean).join(' '))].filter(Boolean).join(', ');
  return html`<li class="hrecap-li"><button type="button" class=${cx('hrecap-row', `oc-${r.outcome}`)} data-sid=${r.id}
      onClick=${() => openSession(r.id)} title=${r.error ? `${r.title}\n${r.error}` : r.title} aria-label=${label}>
    <span class="hrecap-head">
      <span class=${cx('dot', r.state, r.state === 'working' && 'live')} aria-hidden="true"></span>
      <span class="hrecap-title">${r.title}</span>
      <span class="hrecap-proj">${r.project}</span>
      <span class="hrecap-out">${r.lead}</span>
    </span>
    ${(r.error || r.pieces.length > 0) && html`<span class="hrecap-line">
      ${r.error && html`<span class="hrecap-err">${r.error}</span>`}
      ${[r.pieces.filter((p) => p.k === 'commits' || p.k === 'files'), r.pieces.filter((p) => p.k !== 'commits' && p.k !== 'files')].map((g, gi) => g.length > 0 && html`<span class=${cx('hrecap-g', gi ? 'g-when' : 'g-what')}>
        ${g.map((p) => html`<span class=${cx('hrecap-p', `p-${p.k}`)}><span class="tnum">${p.text}</span>${p.detail && html`<span class="hrecap-d">${p.detail}</span>`}</span>`)}
      </span>`)}
    </span>`}
  </button></li>`;
}

function SinceYouLeft({ tick }) {
  const [all, setAll] = useState(false);
  useEffect(() => on('recap.updated', () => loadRecap()), []);
  useEffect(() => { loadRecap(); }, [tick]);
  const v = recapView(recapRows.value, sessions.value, { clockOf, showAll: all });
  if (!v.total) return null;
  return html`<section class="hrecap" aria-label="Since you left">
    <h2 class="home-label hrecap-label">Since you left</h2>
    <ul class="hrecap-list">
      ${v.rows.map((r) => html`<${RecapRow} key=${r.id} r=${r} />`)}
    </ul>
    ${(v.more > 0 || (all && v.total > RECAP_MAX)) && html`<button type="button" class="hrecap-more" onClick=${() => setAll(!all)}>
      ${all ? 'Show fewer' : `+${v.more} more`}</button>`}
  </section>`;
}

function Card({ s, now }) {
  const st = cardStatus(s, now);
  const title = s.title || 'New session';
  const line = [st.text, ...st.meta].join(' · ');
  return html`<button type="button" class=${cx('hcard', `st-${st.state}`, st.needsYou && 'needs-you')} data-sid=${s.id}
      onClick=${() => openSession(s.id)} title=${`${title}\n${s.cwd || s.project || ''}`} aria-label=${`${title}, ${s.project || ''}: ${line}`}>
    <span class="hcard-head">
      <span class=${cx('dot', st.state, st.state === 'working' && 'live')} aria-hidden="true"></span>
      <span class="hcard-title">${title}</span>
    </span>
    <span class="hcard-proj">${s.project || ''}</span>
    <span class="hcard-line"><span class="hcard-text">${st.text}</span>${st.meta.map((m) => html`<span class="hcard-meta">${m}</span>`)}</span>
  </button>`;
}

export function HomeView() {
  const tick = minuteTick.value;   // the clock and "25m ago" move on the shared minute tick
  useEffect(() => { refreshActivityIfStale(ACTIVITY_MAX_AGE_MS); }, [tick]);
  const now = Date.now();
  const d = new Date(now);
  const phone = isPhone.value;
  const cards = homeCards(phone ? [] : tabIds.value, sessions.value, projectGroups.value.flatMap((g) => g.sessions));
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return html`<section class="home" aria-label="Home">
    <div class="home-inner">
      <header class="home-hello">
        <h1 class="home-greet">${greetingFor(d.getHours())}</h1>
        <p class="home-when"><time class="home-clock tnum" dateTime=${d.toISOString()}>${clock}</time><span class="home-date">${date}</span></p>
      </header>
      <${Glance} now=${now} />
      <${SinceYouLeft} tick=${tick} />
      <${NextUp} />
      <h2 class="home-label">${cards.length ? 'Jump back in' : 'Start something'}</h2>
      <div class="home-cards">
        ${cards.map(({ s }) => html`<${Card} key=${s.id} s=${s} now=${now} />`)}
        <button type="button" class="hcard hcard-new" onClick=${() => { newSessionOpen.value = true; }} aria-label="New session">
          <span class="hcard-plus" aria-hidden="true"><${Icon} name="plus" size=${16} /></span>
          <span class="hcard-title">New session</span>
          ${!phone && html`<span class="hcard-keys" aria-hidden="true"><span class="kbd">${mod}</span><span class="kbd">N</span></span>`}
        </button>
      </div>
      ${!cards.length && html`<p class="home-empty">Nothing open right now. Start a session, or pick up a past one in
        <button type="button" class="home-link" onClick=${() => go('history')}>History</button>.</p>`}
    </div>
  </section>`;
}
