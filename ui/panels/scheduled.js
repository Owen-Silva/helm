// Scheduled (lane sched, 2026-10-09): one list of every in-session schedule, across sessions. Each one lives INSIDE a
// session's claude.exe (a /loop ScheduleWakeup or a CronCreate job; main/engine/schedules.js tracks them from the tool
// calls), so Helm cannot delete it directly. The two honest ways to cancel, each behind a confirm:
//   Ask Claude to cancel  sends that session a visible message asking Claude to run CronDelete / stop the loop. Nothing
//                         is cancelled until Claude does it; the row says it was asked, then moves to Ended (or says
//                         Claude finished without cancelling it).
//   Close process         closes the session's Claude Code process (only while it is idle; never for a durable cron),
//                         which ends EVERY schedule in that session. The session stays and resumes on the next send.
// Shown as a section at the top of the Queue panel (queue.js: "things that run later" already live there) and, the
// next three, as the Home "Next up" card (ui/shell/next-up.js). Countdowns ride the shared 1 s ticker
// (chat/state.js now / useTicker: one visibility-aware timer for every live clock). Styles: ./scheduled.css.
// Data: schedules.list on mount and on every reconnect, then the schedules.updated event; mock: ui/lib/mock-schedules.js.
import { signal } from '@preact/signals';
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, cx, fmtDuration, fmtAgo, SectionHead, Modal } from './util.js';
import { rpc, on, onStatus, isMock } from '../lib/transport.js';
import { sessions, selectSession } from '../lib/store.js';
import { now as tickNow, useTicker } from '../chat/state.js';

export const schedState = signal({ loaded: false, items: [], ended: [], error: null });

const call = async (method, params) => (isMock ? (await import('../lib/mock-schedules.js')).mockSchedules(method, params, apply) : rpc(method, params));

let refetchTimer = null;
function apply(d) {
  if (!d || !Array.isArray(d.items)) return;
  schedState.value = { loaded: true, items: d.items, ended: Array.isArray(d.ended) ? d.ended : [], error: null };
  // A recurring cron's next time moves once it fires, and nothing else changes then: one timer at the soonest fire
  // (not a poll) fetches the list again.
  clearTimeout(refetchTimer);
  const soon = Math.min(...d.items.map((x) => (typeof x.nextAt === 'number' ? x.nextAt : Infinity)));
  if (isFinite(soon)) refetchTimer = setTimeout(load, Math.min(2 ** 31 - 1, Math.max(2000, soon - Date.now() + 3000)));
}
let busy = false, again = false;
async function load() {
  if (busy) { again = true; return; }
  busy = true;
  try { apply(await call('schedules.list', {})); } catch (e) { schedState.value = { ...schedState.value, loaded: true, error: e }; }
  finally { busy = false; if (again) { again = false; load(); } }
}
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  if (!isMock) { on('schedules.updated', apply); onStatus((st) => { if (st === 'open') load(); }); }
  load();
}
export function useSchedules() { useEffect(wire, []); return schedState.value; }

// ---------- words ----------
const KIND = { loop: 'Loop', cron: 'Cron', wakeup: 'Wake-up' };
export const kindLabel = (k) => KIND[k] || 'Scheduled';
export function untilText(at, now) {
  if (typeof at !== 'number') return 'time unknown';
  const d = at - now;
  if (d <= 0) return 'due now';
  return `in ${fmtDuration(d, { seconds: d < 3_600_000 })}`;
}
export const clockText = (at) => (typeof at === 'number' ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
function dayClock(at) {
  if (typeof at !== 'number') return '';
  const d = new Date(at), today = new Date();
  return d.toDateString() === today.toDateString() ? clockText(at) : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${clockText(at)}`;
}
const WHY = {
  deleted: 'Cancelled by Claude (CronDelete)',
  stopped: 'Loop stopped by Claude',
  closed: "Ended: Helm closed this session's Claude process",
  'session-closed': 'Ended: the session was closed',
  exited: 'Ended: Claude Code exited',
  restart: 'Ended by restart',
};
const WHY_TITLE = {
  restart: 'Helm restarted (an update, or a quit and reopen). In-session schedules live inside Claude Code and end with it; ask Claude to set it up again if you still want it.',
  exited: 'The Claude Code process for this session stopped, and its in-session schedules with it.',
};
const repeatText = (x) => (x.kind === 'loop' && x.key.startsWith('wake:') ? 'next tick' : x.recurring ? 'repeats' : 'once');

// What became of an "Ask Claude to cancel" (the row itself goes to Ended when Claude really cancels it).
function askState(x, now) {
  const s = sessions.value.find((y) => y.id === x.sessionId);
  if (s && (s.status === 'working' || s.status === 'waiting')) return { tone: 'busy', text: `Asked Claude to cancel ${fmtAgo(x.askedAt, now)} · Claude is on it` };
  if (s && s.updatedAt > x.askedAt + 1500) return { tone: 'warn', text: 'Claude finished, and it is still scheduled' };
  return { tone: 'busy', text: `Asked Claude to cancel ${fmtAgo(x.askedAt, now)}` };
}

// ---------- rows ----------
function ConfirmAsk({ x, onClose, onDone }) {
  const [state, setState] = useState({ busy: false, err: null });
  const go = async () => {
    setState({ busy: true, err: null });
    try { const r = await call('schedules.cancel', { sessionId: x.sessionId, key: x.key, how: 'ask' }); onDone(r && r.queued ? 'Sent. Claude reads it after the turn it is on.' : 'Sent to Claude.'); onClose(); }
    catch (e) { setState({ busy: false, err: e }); }
  };
  return html`<${Modal} title="Ask Claude to cancel?" onClose=${onClose} footer=${html`
      <button type="button" class="btn btn-ghost" onClick=${onClose}>Keep it</button>
      <button type="button" class="btn btn-primary" data-act="sched-ask-confirm" disabled=${state.busy} onClick=${go}>${state.busy ? 'Sending…' : 'Send message'}</button>`}>
    <p class="sch-confirm-p">Helm sends this message to <b>${x.sessionTitle}</b> as you. It shows in that session's transcript, and nothing is cancelled until Claude does it:</p>
    <blockquote class="sch-quote">${x.askText}</blockquote>
    <p class="sch-confirm-p sch-dim">This row then shows whether it went.</p>
    ${state.err && html`<div class="pn-q-err" role="alert">${state.err.message || String(state.err)}</div>`}
  <//>`;
}

function ConfirmClose({ x, onClose, onDone }) {
  const [state, setState] = useState({ busy: false, err: null });
  const all = schedState.value.items.filter((y) => y.sessionId === x.sessionId);
  const go = async () => {
    setState({ busy: true, err: null });
    try {
      const r = await call('schedules.cancel', { sessionId: x.sessionId, key: x.key, how: 'close' });
      onDone(r && r.left === 0 ? `Closed. ${r.ended} schedule${r.ended === 1 ? '' : 's'} ended.` : `Closed, but ${r.left} still listed.`);
      onClose();
    } catch (e) { setState({ busy: false, err: e }); }
  };
  return html`<${Modal} title="Close this session's Claude process?" onClose=${onClose} footer=${html`
      <button type="button" class="btn btn-ghost" onClick=${onClose}>Keep it</button>
      <button type="button" class="btn btn-danger" data-act="sched-close-confirm" disabled=${state.busy} onClick=${go}>${state.busy ? 'Closing…' : 'Close process'}</button>`}>
    <p class="sch-confirm-p">This closes the Claude Code process behind <b>${x.sessionTitle}</b>. Every schedule inside it ends${all.length > 1 ? `, all ${all.length}:` : ':'}</p>
    <ul class="sch-confirm-list">${all.map((y) => html`<li key=${y.id}>${kindLabel(y.kind)} · ${y.label}</li>`)}</ul>
    <p class="sch-confirm-p sch-dim">The session stays. Your next message starts Claude again, in context, without these schedules.</p>
    ${state.err && html`<div class="pn-q-err" role="alert">${state.err.message || String(state.err)}</div>`}
  <//>`;
}

function Row({ x, now }) {
  const [ask, setAsk] = useState(null); // 'ask' | 'close'
  const [note, setNote] = useState(null);
  const s = sessions.value.find((y) => y.id === x.sessionId);
  const working = s && (s.status === 'working' || s.status === 'waiting');
  const closeWhy = x.closeWhy || (working ? 'Claude is working in this session; closing its process now would stop that work.' : null);
  const a = x.askedAt ? askState(x, now) : null;
  return html`<li class=${cx('sch-row', `k-${x.kind}`)} data-sched=${x.key}>
    <div class="sch-top">
      <span class="sch-kind">${kindLabel(x.kind)}</span>
      <span class="sch-rep">${repeatText(x)}</span>
      ${x.durable && html`<span class="sch-rep" title="Saved in the project: survives restarts">saved</span>`}
      <span class="sch-when tnum" title=${dayClock(x.nextAt)}>${untilText(x.nextAt, now)}<span class="sch-clock">${dayClock(x.nextAt)}</span></span>
    </div>
    <div class="sch-label" title=${x.prompt}>${x.label}</div>
    ${x.detail && html`<div class="sch-detail" title=${x.cron ? `${x.detail} (${x.cron})` : x.detail}>${x.detail}</div>`}
    <div class="sch-meta">
      <button type="button" class="sch-sess" title="Open this session" onClick=${() => selectSession(x.sessionId)}>${x.sessionTitle}</button>
      ${x.project && html`<span class="sch-dot-sep">${x.project}</span>`}
    </div>
    ${a && html`<div class=${cx('sch-asked', `t-${a.tone}`)} role="status">${a.text}</div>`}
    ${note && !a && html`<div class="sch-asked t-busy" role="status">${note}</div>`}
    <div class="pn-q-row-actions sch-actions">
      <span class="pn-q-created"></span>
      <button type="button" class="btn btn-ghost sm" data-act="sched-ask" onClick=${() => setAsk('ask')}
        title="Send this session a message asking Claude to cancel it">${x.askedAt ? 'Ask again' : 'Ask Claude to cancel'}</button>
      <button type="button" class="btn btn-ghost sm pn-q-danger" data-act="sched-close" disabled=${!!closeWhy} onClick=${() => setAsk('close')}
        title=${closeWhy || `Close the Claude process: ends ${x.others ? `all ${x.others + 1} schedules` : 'every schedule'} in this session`}>Close process</button>
    </div>
    ${ask === 'ask' && html`<${ConfirmAsk} x=${x} onClose=${() => setAsk(null)} onDone=${setNote} />`}
    ${ask === 'close' && html`<${ConfirmClose} x=${x} onClose=${() => setAsk(null)} onDone=${setNote} />`}
  </li>`;
}

function EndedRow({ e, now }) {
  return html`<li class=${cx('sch-row sch-ended', `why-${e.why}`)} data-ended=${e.why}>
    <div class="sch-top">
      <span class="sch-kind">${kindLabel(e.kind)}</span>
      <span class="sch-why" title=${WHY_TITLE[e.why] || ''}>${WHY[e.why] || 'Ended'}</span>
      <span class="sch-when tnum">${fmtAgo(e.at, now)}</span>
      <button type="button" class="icon-btn sch-x" aria-label="Dismiss" title="Dismiss" onClick=${() => call('schedules.dismiss', { id: e.id }).catch(() => {})}><${Icon} name="close" size=${13} /></button>
    </div>
    <div class="sch-label">${e.label}</div>
    <div class="sch-meta"><button type="button" class="sch-sess" onClick=${() => selectSession(e.sessionId)}>${e.sessionTitle}</button>${e.detail && html`<span class="sch-dot-sep">${e.detail}</span>`}</div>
  </li>`;
}

// The Scheduled section (top of the Queue panel; also the Home card's "See all" dialog on the phone / with no session).
export function ScheduledSection({ always = false }) {
  const st = useSchedules();
  const live = st.items.length > 0;
  useTicker(live);
  const now = live ? tickNow.value : Date.now();
  if (!st.loaded || (st.error && !live)) return always ? html`<div class="pn-note">${st.error ? 'The schedule list is not available here.' : 'Loading…'}</div>` : null;
  if (!live && !st.ended.length) {
    return always ? html`<div class="sch"><${SectionHead} title="Scheduled in sessions" /><div class="pn-note">Nothing scheduled. A /loop or a cron job Claude sets up in a session shows here.</div></div>` : null;
  }
  return html`<div class="sch" aria-label="Scheduled in sessions">
    ${live && html`<${SectionHead} title="Scheduled in sessions"><span class="pn-num">${st.items.length}</span><//>
      <div class="pn-note sch-note">These live inside each session's Claude Code, so a Helm restart ends them (saved ones excepted).</div>
      <ul class="pn-q-list sch-list">${st.items.map((x) => html`<${Row} key=${x.id} x=${x} now=${now} />`)}</ul>`}
    ${st.ended.length > 0 && html`<${SectionHead} title="Ended">
        <button type="button" class="btn btn-ghost sm" onClick=${() => call('schedules.dismiss', { all: true }).catch(() => {})}>Clear</button><//>
      <ul class="pn-q-list sch-list">${st.ended.map((e) => html`<${EndedRow} key=${e.id} e=${e} now=${now} />`)}</ul>`}
  </div>`;
}

export function ScheduledDialog({ onClose }) {
  return html`<${Modal} title="Scheduled" wide onClose=${onClose}><div class="pn sch-dialog"><${ScheduledSection} always /></div><//>`;
}
