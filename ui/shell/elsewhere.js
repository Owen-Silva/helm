// Sessions running outside Helm (terminal Claude Code). Owner: lane shell (C).
// Sidebar: a collapsible "Elsewhere" section (external.list / external.updated) with the terminal
// sessions running RIGHT NOW; idle ones are in Past (past.js). Main area: a read-only transcript
// (external.history through the normal ChatView) with "Resume in Helm" once the terminal is done.
import { signal, effect } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { externalSessions, externalView, loadExternal, createSession, toast } from '../lib/store.js';
import { isExternalRunning } from '../lib/session-activity.js';
import { ChatView } from '../chat/index.js';
import { view, phoneScreen, isPhone } from './state.js';
import { pastTerminal } from './activity.js';
import { EtaChip, EtaLine } from './eta.js';
import { cx, ago, useTick } from './util.js';

function load(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
export const elsewhereOpen = signal(load('helm.elsewhere.open', true) !== false);
effect(() => { const v = elsewhereOpen.value; try { localStorage.setItem('helm.elsewhere.open', JSON.stringify(v)); } catch {} });

export function openExternal(claudeSessionId) {
  externalView.value = claudeSessionId;
  view.value = 'session';
  phoneScreen.value = 'session';
}
export function closeExternal() {
  externalView.value = null;
  if (isPhone.value) phoneScreen.value = 'list';
}

const agentsText = (n) => (n > 0 ? `${n} agent${n === 1 ? '' : 's'}` : '');

function ExtRow({ x }) {
  const on = externalView.value === x.claudeSessionId && view.value === 'session';
  const working = x.active && x.eta?.state === 'working';
  const sub = [x.project, agentsText(x.agentsRunning)].filter(Boolean).join(' · ');
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openExternal(x.claudeSessionId); } };
  return html`<div class=${cx('srow ext-row', on && 'on')} role="button" tabindex="0" aria-current=${on ? 'true' : undefined}
      onClick=${() => openExternal(x.claudeSessionId)} onKeyDown=${onKey}
      title=${`${x.title || 'Untitled'}\n${x.cwd}\n${x.active ? 'Running in a terminal' : 'Idle in a terminal'} · read only in Helm`}>
    <span class=${cx('dot', x.active ? 'working live' : 'idle')} aria-label=${x.active ? 'Active' : 'Idle'}></span>
    <div class="srow-text">
      <div class="srow-title"><span class="truncate">${x.title || 'Untitled'}</span></div>
      <div class="srow-sub has-eta"><span class="truncate">${sub}</span><${EtaChip} eta=${x.eta} working=${working} /></div>
    </div>
    <div class="srow-meta"><span class="srow-time tnum">${x.active ? 'live' : ago(x.lastActivity)}</span></div>
  </div>`;
}

export function ElsewhereSection() {
  const list = externalSessions.value.filter(isExternalRunning);
  if (!list.length) return null;
  const open = elsewhereOpen.value;
  const live = list.length;
  return html`<section class=${cx('sgroup sgroup-elsewhere', !open && 'collapsed')} aria-label="Sessions running elsewhere">
    <div class="sgroup-head">
      <button class="sgroup-toggle" aria-expanded=${open} onClick=${() => { elsewhereOpen.value = !open; }}
        title="Claude Code sessions running in a terminal right now, outside Helm. Finished ones are in Past.">
        <${Icon} name="chevron-right" size=${12} class="sgroup-chev" />
        <span class="sgroup-name truncate">Elsewhere</span>
        <span class="sgroup-count tnum">${live ? `${live} live` : list.length}</span>
      </button>
    </div>
    ${open && html`<div class="sgroup-list">${list.map((x) => html`<${ExtRow} key=${x.claudeSessionId} x=${x} />`)}</div>`}
  </section>`;
}

export function ExternalPane() {
  const csid = externalView.value;
  // external.list only reports the running ones and the last few idle; a terminal session opened from
  // Past is named from its history entry (idle by definition, so it can be resumed).
  const h = externalSessions.value.find((e) => e.claudeSessionId === csid) ? null : pastTerminal.value.get(csid);
  const x = externalSessions.value.find((e) => e.claudeSessionId === csid) || (h ? { ...h, active: false, agentsRunning: 0, eta: null } : null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useTick(60000);
  useEffect(() => { setErr(null); loadExternal(csid).catch((e) => setErr(e)); }, [csid]);
  const phone = isPhone.value;
  const working = !!x?.active && x?.eta?.state === 'working';
  const resume = async () => {
    if (!x || busy) return;
    setBusy(true);
    try {
      await createSession({ cwd: x.cwd, resumeClaudeSessionId: x.claudeSessionId });
      externalView.value = null;
      toast({ title: 'Resumed in Helm', body: x.title || x.cwd, ms: 3000 });
    } catch (e) { setBusy(false); toast({ title: 'Could not resume', error: e, kind: 'error' }); }
  };
  return html`<div class="sess sess-ext" key=${csid}>
    <header class="sess-head">
      ${phone && html`<button class="icon-btn sh-back" aria-label="Back to sessions" onClick=${closeExternal}><${Icon} name="chevron-left" size=${20} /></button>`}
      <div class="sh-main">
        <div class="sh-line1">
          <span class=${cx('dot', x?.active ? 'working live' : 'idle')} title=${x?.active ? 'Active in a terminal' : 'Idle'}></span>
          <h1 class="sh-title sh-title-static truncate">${x?.title || 'Terminal session'}</h1>
        </div>
        <div class="sh-line2">
          <span class="sh-state">${x?.active ? 'Running in a terminal' : x ? `Terminal · last active ${ago(x.lastActivity)}` : 'Terminal session'}</span>
          ${x && x.agentsRunning > 0 && html`<span class="sh-sep" aria-hidden="true"></span><span class="sh-state">${agentsText(x.agentsRunning)}</span>`}
          ${working && html`<${EtaLine} eta=${x.eta} working=${true} />`}
          ${x?.cwd && html`<span class="sh-sep" aria-hidden="true"></span>${phone ? html`<span class="sh-proj truncate" title=${x.cwd}>${x.project}</span>` : html`<span class="sh-cwd mono truncate" title=${x.cwd}>${x.cwd}</span>`}`}
        </div>
      </div>
      <div class="sh-actions">
        ${!phone && html`<button class="icon-btn" aria-label="Close" title="Close (back to your session)" onClick=${closeExternal}><${Icon} name="x" size=${17} /></button>`}
      </div>
    </header>
    <div class="ext-banner" role="note">
      <${Icon} name="terminal" size=${14} />
      ${x?.active
        ? html`<span>Running in a terminal — read only. Helm can resume it once the terminal session goes idle.</span>`
        : html`<span class="ext-banner-text">${phone ? 'Read only until you resume it.' : 'From a terminal session — read only until you resume it in Helm.'}</span>`}
      ${x && !x.active && html`<button class="btn btn-sm btn-primary ext-resume" onClick=${resume} disabled=${busy}><${Icon} name="play" size=${14} />${busy ? 'Resuming…' : 'Resume in Helm'}</button>`}
    </div>
    ${err
      ? html`<div class="state-note ext-err">Could not load this transcript: <span class="mono">${err.message || String(err)}</span>
          <button class="btn btn-sm" onClick=${() => { setErr(null); loadExternal(csid, { refresh: true }).catch(setErr); }}>Retry</button></div>`
      : html`<div class="sess-chat"><${ChatView} external=${csid} /></div>`}
  </div>`;
}

