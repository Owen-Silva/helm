// Sidebar: projects → sessions. Owner: lane shell (C); filter, multi-select, archive, project menu: lane sessions-org.
import { signal, computed } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { activeId, updateSession, toast, sessions, externalView, settings, saveSettings } from '../lib/store.js';
import { projectGroups, archivedSessions, collapsedGroups, openSession, newSessionOpen, view, isPhone, orderedSessions } from './state.js';
import { cx, ago, useTick, useMenu, Menu, mod } from './util.js';
import { UsageMeter } from '../panels/index.js';
import { split, openSplit, dragSession } from './split.js';
import { EtaChip, etaInfo } from './eta.js';
import { ElsewhereSection } from './elsewhere.js';
import { PastSection, pastOpen } from './past.js';
import { displayStatus, isAgentsOnly, agentsLabel, stallText } from '../lib/session-status.js';
import { archiveSessions, closeSession, askDelete, copyText, sessionLink } from './session-actions.js';

const STATUS_TEXT = { working: 'Working', waiting: 'Needs you', error: 'Error', idle: 'Idle', closed: 'Closed' };
const ARCHIVED_KEY = '__archived';

// ---- filter (Ctrl+Shift+F focuses the box) ----
export const sidebarQuery = signal('');
export const statusFilter = signal([]);           // [] = any status; else e.g. ['working', 'waiting']
const filterFocus = signal(0);
export function focusSidebarFilter() { filterFocus.value++; }
const CHIPS = [{ status: 'working', label: 'Working' }, { status: 'waiting', label: 'Waiting' }, { status: 'error', label: 'Error' }];
const filtering = computed(() => !!sidebarQuery.value.trim() || statusFilter.value.length > 0);
function matches(s) {
  const st = statusFilter.value;
  if (st.length && !st.includes(displayStatus(s))) return false;
  const q = sidebarQuery.value.trim().toLowerCase();
  if (!q) return true;
  const hay = `${s.title || ''}\n${s.project || ''}\n${s.cwd || ''}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// ---- multi-select (Ctrl/Cmd-click toggles, Shift-click selects a range) ----
export const selected = signal([]);               // session ids
let anchorId = null;
const clearSelection = () => { if (selected.value.length) selected.value = []; anchorId = null; };
const visibleOrder = signal([]);                  // ids in the order the sidebar shows them right now

function onRowClick(e, s) {
  if (!isPhone.value && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const cur = new Set(selected.value);
    // the first Ctrl-click also picks up the open session, the way a file list does (only from the same
    // section: an open live session never joins a selection of archived ones, or the other way round)
    const open = activeId.value && activeId.value !== s.id && visibleOrder.value.includes(activeId.value) ? sessions.value.find((x) => x.id === activeId.value) : null;
    if (!cur.size && open && !!open.archived === !!s.archived) cur.add(open.id);
    if (cur.has(s.id)) cur.delete(s.id); else cur.add(s.id);
    selected.value = [...cur];
    anchorId = s.id;
    return;
  }
  if (!isPhone.value && e.shiftKey) {
    e.preventDefault();
    const order = visibleOrder.value;
    const from = order.indexOf(anchorId || activeId.value);
    const to = order.indexOf(s.id);
    if (to < 0) return;
    const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    selected.value = order.slice(a, b + 1);
    return;
  }
  clearSelection();
  anchorId = s.id;
  openSession(s.id);
}

function subline(s) {
  if (s.status === 'waiting') return s.activity || 'Waiting for your answer';
  if (s.status === 'working') return stallText(s) || s.activity || 'Working…';   // lane stall: "Stalled · 12m"
  if (s.status === 'error') return s.activity || 'Stopped with an error';
  if (isAgentsOnly(s)) return agentsLabel(s);   // idle, but its agents are still working
  if (s.restartNote) return restartSubline(s.restartNote);   // lane restart: cut off by the last restart; Continue is inside
  return null;
}

// "Stopped by restart · 5 agents" | "Stopped by restart"
function restartSubline(n) {
  const a = Math.max((n.agents || []).length, Number(n.agentsTotal) || 0);
  return `Stopped by ${n.cause === 'quit' ? 'quit' : 'restart'}${a ? ` · ${a} agent${a === 1 ? '' : 's'}` : ''}`;
}

// inPast: the row sits in Past (past.js): it shows its project instead of a status line, and the time
// of last use (`at`). Opening it does not pull it into the main list (markRead leaves updatedAt).
export function SessionRow({ s, inPast = false, at = null }) {
  const phone = isPhone.value;
  const active = !phone && s.id === activeId.value && view.value === 'session' && !externalView.value;
  const sp = split.value;
  const beside = !phone && !!sp && view.value === 'session' && !externalView.value && !active && sp.ids.includes(s.id);   // the other split pane
  const picked = selected.value.includes(s.id);
  const eta = s.status === 'working' && etaInfo(s.eta, true) ? html`<${EtaChip} eta=${s.eta} working=${true} />` : null;
  const m = useMenu();
  const sub = subline(s);
  const index = s.archived ? -1 : orderedSessions.value.findIndex((x) => x.id === s.id);
  // "<source title> (fork)": the suffix was truncated away in the row, so a fork looked identical to its
  // source. Show a branch mark up front instead (the full title stays in the tooltip).
  const forkTitle = / \(fork\)$/.test(s.title || '') ? s.title.replace(/( \(fork\))+$/, '') : null;
  // No count badge in the row (the user): the right side is always the relative time; unread shows only as
  // the bold title (.srow.unread). The rail / taskbar badges are separate and unchanged.
  const click = (e) => onRowClick(e, s);
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(e); } };
  const act = (fn) => (e) => { e.stopPropagation(); m.setOpen(false); fn(); };
  const live = s.status === 'working' || s.status === 'waiting';
  return html`<div class=${cx('srow', `st-${s.status}`, active && 'on', beside && 'beside', picked && 'picked', s.unread > 0 && 'unread', s.archived && 'archived')}
      role="button" tabindex="0" aria-current=${active ? 'true' : undefined} aria-selected=${picked ? 'true' : undefined} data-sid=${s.id}
      draggable=${phone || s.archived ? undefined : 'true'}
      onDragStart=${phone ? undefined : (e) => { e.dataTransfer.setData('application/x-helm-session', s.id); e.dataTransfer.setData('text/plain', s.title || s.id); e.dataTransfer.effectAllowed = 'move'; dragSession.value = s.id; }}
      onDragEnd=${phone ? undefined : () => { dragSession.value = null; }}
      onMouseDown=${(e) => { if (e.shiftKey) e.preventDefault(); }}
      onClick=${click} onKeyDown=${onKey}
      onContextMenu=${(e) => { e.preventDefault(); m.setOpen(true); }}
      title=${`${s.title}\n${s.cwd}${phone && index >= 0 && index < 9 ? `\n${mod}+${index + 1}` : ''}${phone ? '' : '\nCtrl-click or Shift-click to select several'}`}>
    <span class=${cx('dot', displayStatus(s), displayStatus(s) === 'working' && 'live')} aria-label=${isAgentsOnly(s) ? agentsLabel(s) : STATUS_TEXT[s.status] || s.status}></span>
    <div class="srow-text">
      <div class="srow-title">
        ${s.pinned && !s.archived && html`<${Icon} name="pin" size=${11} class="srow-pin" />`}
        ${forkTitle && html`<${Icon} name="git-branch" size=${11} class="srow-pin" title="Fork" />`}
        <span class="truncate">${forkTitle || s.title || 'New session'}</span>
      </div>
      ${s.archived || inPast ? html`<div class="srow-sub truncate">${s.project}</div>`
        : sub && eta ? html`<div class="srow-sub has-eta"><span class="truncate">${sub}</span>${eta}</div>`
        : sub ? html`<div class="srow-sub truncate">${sub}</div>`
        : null}
    </div>
    <div class="srow-meta">
      <span class="srow-time tnum">${ago(at ?? s.updatedAt)}</span>
      <button ref=${m.anchor} class="icon-btn sm srow-more" aria-label="Session actions"
        onClick=${(e) => { e.stopPropagation(); m.toggle(); }}><${Icon} name="more" size=${14} /></button>
    </div>
    ${m.open && html`<${Menu} m=${m} align="end" class="srow-menu">
      ${!s.archived && html`<button class="menu-item" data-act="pin" onClick=${act(() => updateSession(s.id, { pinned: !s.pinned }))}
        title=${s.pinned ? 'Let it move to Past once it has been idle for an hour' : 'Pinned: stays in the list even when idle'}>
        <${Icon} name="pin" size=${15} />${s.pinned ? 'Unpin' : 'Keep in list'}</button>`}
      ${!phone && !active && !beside && !s.archived && html`<button class="menu-item" onClick=${act(() => openSplit(s.id, 1))}>
        <${Icon} name="columns" size=${15} />Open side by side</button>`}
      <div class="menu-sep"></div>
      <button class="menu-item" onClick=${act(() => copyText(s.cwd, 'Folder path'))}><${Icon} name="folder" size=${15} />Copy folder path</button>
      <button class="menu-item" data-act="copy-link" onClick=${act(() => copyText(sessionLink(s.id), 'Link'))} title="helm:// link that opens Helm on this session">
        <${Icon} name="link" size=${15} />Copy link</button>
      <button class="menu-item" onClick=${act(() => copyText(s.id, 'Helm session id'))} title=${`For helm --session=${s.id}`}><${Icon} name="hash" size=${15} />Copy Helm session id</button>
      ${s.claudeSessionId && html`<button class="menu-item" onClick=${act(() => copyText(s.claudeSessionId, 'Claude session id'))}><${Icon} name="copy" size=${15} />Copy Claude session id</button>`}
      <div class="menu-sep"></div>
      ${s.archived
        ? html`<button class="menu-item" data-act="unarchive" onClick=${act(() => archiveSessions([s.id], false))}><${Icon} name="archive-restore" size=${15} />Unarchive</button>`
        : html`<button class="menu-item" data-act="archive" onClick=${act(() => archiveSessions([s.id], true))}><${Icon} name="archive" size=${15} />Archive</button>`}
      ${s.status !== 'closed' && html`<button class="menu-item" data-act="close" onClick=${act(() => closeSession(s.id))} title="Stop the CLI now; the session stays in the list">
        <${Icon} name="stop" size=${15} />${live ? 'Stop and close' : 'Close'}</button>`}
      <button class="menu-item danger" data-act="delete" onClick=${act(() => askDelete([s.id]))}><${Icon} name="trash" size=${15} />Delete from Helm…</button>
    <//>`}
  </div>`;
}

const normKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
function saveProject(g, patch) {
  const projects = [...(settings.value?.projects || [])];
  const i = projects.findIndex((p) => normKey(p.cwd) === g.key);
  if (i >= 0) projects[i] = { ...projects[i], ...patch };
  else projects.push({ cwd: g.cwd, name: g.name, pinned: false, ...patch });
  return saveSettings({ projects }).catch((e) => toast({ title: 'Could not save the project', error: e, kind: 'error' }));
}

function GroupName({ g, onDone }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const commit = () => { const v = ref.current?.value.trim(); onDone(); if (v && v !== g.name) saveProject(g, { name: v.slice(0, 80) }); };
  return html`<input ref=${ref} class="sgroup-rename" value=${g.name} aria-label="Project name" maxlength="80"
    onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); } }}
    onBlur=${commit} />`;
}

function Group({ g, list, forceOpen }) {
  const collapsed = !forceOpen && !!collapsedGroups.value[g.key];
  const [renaming, setRenaming] = useState(false);
  const m = useMenu();
  const toggle = () => { collapsedGroups.value = { ...collapsedGroups.value, [g.key]: !collapsedGroups.value[g.key] }; };
  const waiting = list.filter((s) => s.status === 'waiting').length;
  const act = (fn) => (e) => { e.stopPropagation(); m.setOpen(false); fn(); };
  return html`<section class=${cx('sgroup', collapsed && 'collapsed', g.pinned && 'pinned')} data-project=${g.key}>
    <div class="sgroup-head" onContextMenu=${(e) => { e.preventDefault(); m.setOpen(true); }}>
      ${renaming ? html`<div class="sgroup-toggle editing"><${Icon} name="chevron-right" size=${12} class="sgroup-chev" /><${GroupName} g=${g} onDone=${() => setRenaming(false)} /></div>`
        : html`<button class="sgroup-toggle" aria-expanded=${!collapsed} onClick=${toggle} title=${g.cwd}>
        <${Icon} name="chevron-right" size=${12} class="sgroup-chev" />
        <span class="sgroup-name truncate">${g.name}</span>
        ${g.pinned && html`<${Icon} name="pin" size=${10} class="sgroup-pin" aria-label="Pinned project" />`}
        ${collapsed && waiting > 0 && html`<span class="dot waiting" aria-label=${`${waiting} waiting`}></span>`}
        ${collapsed && !waiting && list.length > 0 && html`<span class="sgroup-count tnum">${list.length}</span>`}
      </button>`}
      <button ref=${m.anchor} class="icon-btn sm sgroup-more" aria-label=${`${g.name} project actions`} title="Project actions"
        onClick=${(e) => { e.stopPropagation(); m.toggle(); }}><${Icon} name="more" size=${14} /></button>
      <button class="icon-btn sm sgroup-add" aria-label=${`New session in ${g.name}`} title=${`New session in ${g.name}`}
        onClick=${() => { newSessionOpen.value = { cwd: g.cwd }; }}><${Icon} name="plus" size=${14} /></button>
      ${m.open && html`<${Menu} m=${m} align="end" class="sgroup-menu">
        <button class="menu-item" data-act="pin-project" onClick=${act(() => saveProject(g, { pinned: !g.pinned }))}>
          <${Icon} name="pin" size=${15} />${g.pinned ? 'Unpin project' : 'Pin project to top'}</button>
        <button class="menu-item" data-act="rename-project" onClick=${act(() => setRenaming(true))}><${Icon} name="pencil" size=${15} />Rename…</button>
        <button class="menu-item" onClick=${act(() => copyText(g.cwd, 'Folder path'))}><${Icon} name="folder" size=${15} />Copy folder path</button>
        ${list.length > 0 && html`<div class="menu-sep"></div>
          <button class="menu-item" onClick=${act(() => archiveSessions(list.filter((s) => s.status !== 'working' && s.status !== 'waiting').map((s) => s.id), true))}
            disabled=${list.every((s) => s.status === 'working' || s.status === 'waiting')}>
            <${Icon} name="archive" size=${15} />Archive idle sessions here</button>`}
      <//>`}
    </div>
    ${!collapsed && html`<div class="sgroup-list">
      ${list.length
        ? list.map((s) => html`<${SessionRow} key=${s.id} s=${s} />`)
        : html`<div class="sgroup-empty">No active sessions</div>`}
    </div>`}
  </section>`;
}

function ArchivedGroup({ list, forceOpen }) {
  const collapsed = !forceOpen && collapsedGroups.value[ARCHIVED_KEY] !== false;   // collapsed unless opened
  const toggle = () => { collapsedGroups.value = { ...collapsedGroups.value, [ARCHIVED_KEY]: !collapsed }; };
  return html`<section class=${cx('sgroup sgroup-archived', collapsed && 'collapsed')}>
    <div class="sgroup-head">
      <button class="sgroup-toggle" aria-expanded=${!collapsed} onClick=${toggle} title="Archived sessions: their CLI is stopped; open one to read it, send a message to bring it back">
        <${Icon} name="chevron-right" size=${12} class="sgroup-chev" />
        <${Icon} name="archive" size=${12} class="sgroup-icon" />
        <span class="sgroup-name truncate">Archived</span>
        <span class="sgroup-count tnum">${list.length}</span>
      </button>
    </div>
    ${!collapsed && html`<div class="sgroup-list">${list.map((s) => html`<${SessionRow} key=${s.id} s=${s} />`)}</div>`}
  </section>`;
}

function FilterBar() {
  const ref = useRef(null);
  useEffect(() => { if (filterFocus.value) { ref.current?.focus(); ref.current?.select(); } }, [filterFocus.value]);
  const counts = {};
  for (const s of sessions.value) if (!s.archived) { const ds = displayStatus(s); counts[ds] = (counts[ds] || 0) + 1; }
  const toggle = (st) => { const cur = statusFilter.value; statusFilter.value = cur.includes(st) ? cur.filter((x) => x !== st) : [...cur, st]; };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (sidebarQuery.value) sidebarQuery.value = ''; else ref.current?.blur();
    } else if (e.key === 'Enter') {
      const first = visibleOrder.value[0];
      if (first) { e.preventDefault(); clearSelection(); openSession(first); }
    } else if (e.key === 'ArrowDown') {
      const row = ref.current?.closest('.sidebar')?.querySelector('.sidebar-scroll .srow');
      if (row) { e.preventDefault(); row.focus(); }
    }
  };
  return html`<div class="sfilter" role="search">
    <label class="sfilter-box">
      <${Icon} name="search" size=${13} class="sfilter-icon" />
      <input ref=${ref} id="sidebar-filter" type="search" class="sfilter-input" placeholder="Filter sessions" autocomplete="off" spellcheck="false"
        aria-label=${`Filter sessions by title, project or folder (${mod}+Shift+F)`}
        value=${sidebarQuery.value} onInput=${(e) => { sidebarQuery.value = e.currentTarget.value; }} onKeyDown=${onKey} />
      ${sidebarQuery.value
        ? html`<button class="icon-btn xs sfilter-clear" aria-label="Clear filter" onClick=${() => { sidebarQuery.value = ''; ref.current?.focus(); }}><${Icon} name="x" size=${12} /></button>`
        : !isPhone.value && html`<span class="sfilter-kbd" aria-hidden="true">${mod}+⇧+F</span>`}
    </label>
    <div class="sfilter-chips" role="group" aria-label="Show only">
      ${CHIPS.map((c) => html`<button key=${c.status} class=${cx('chip', 'sfilter-chip', `st-${c.status}`, statusFilter.value.includes(c.status) && 'on')}
        aria-pressed=${statusFilter.value.includes(c.status)} onClick=${() => toggle(c.status)}>
        <span class=${cx('dot', c.status)} aria-hidden="true"></span>${c.label}${counts[c.status] ? html`<span class="tnum sfilter-n">${counts[c.status]}</span>` : null}
      </button>`)}
    </div>
  </div>`;
}

function BulkBar() {
  const ids = selected.value.filter((id) => sessions.value.some((s) => s.id === id));
  if (!ids.length) return null;
  const list = ids.map((id) => sessions.value.find((s) => s.id === id));
  const allArchived = list.every((s) => s.archived);
  const done = () => { selected.value = []; };
  return html`<div class="sbulk" role="toolbar" aria-label="Selected sessions">
    <span class="sbulk-n tnum">${ids.length} selected</span>
    <span class="grow"></span>
    ${allArchived
      ? html`<button class="btn btn-sm" data-act="bulk-unarchive" onClick=${() => archiveSessions(ids, false).then(done)}><${Icon} name="archive-restore" size=${14} />Unarchive</button>`
      : html`<button class="btn btn-sm" data-act="bulk-archive" onClick=${() => archiveSessions(ids.filter((id) => !sessions.value.find((s) => s.id === id)?.archived), true).then(done)}><${Icon} name="archive" size=${14} />Archive</button>`}
    <button class="icon-btn sm" aria-label="Delete selected from Helm" title="Delete from Helm…" onClick=${() => askDelete(ids)}><${Icon} name="trash" size=${14} /></button>
    <button class="icon-btn sm" aria-label="Clear selection" title="Clear selection (Esc)" onClick=${done}><${Icon} name="x" size=${14} /></button>
  </div>`;
}

export function Sidebar() {
  useTick(60000); // relative times are in minutes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && selected.value.length && !document.querySelector('.modal-scrim:not(.m-leave)')) clearSelection(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const f = filtering.value;
  const order = [];
  const groups = [];
  for (const g of projectGroups.value) {
    const list = f ? g.sessions.filter(matches) : g.sessions;
    if (f && !list.length) continue;
    if (f || !collapsedGroups.value[g.key]) order.push(...list.map((s) => s.id));
    groups.push(html`<${Group} key=${g.key} g=${g} list=${list} forceOpen=${f} />`);
  }
  // Past (past.js) holds every inactive session and, at its bottom, the Archived group. The filter's
  // text searches Past too (forced open); the status chips hide it (nothing in Past is working,
  // waiting or errored).
  const textQ = sidebarQuery.value.trim();
  const chips = statusFilter.value.length > 0;
  const pastShown = !chips && (!!textQ || pastOpen.value);
  const archived = f ? archivedSessions.value.filter(matches) : archivedSessions.value;
  if (archived.length && pastShown && (f || collapsedGroups.value[ARCHIVED_KEY] === false)) order.push(...archived.map((s) => s.id));
  if (visibleOrder.peek().join() !== order.join()) queueMicrotask(() => { visibleOrder.value = order; });
  const hasAny = sessions.value.length > 0;
  return html`<aside class="sidebar panel" aria-label="Sessions">
    <div class="sidebar-head">
      <h2 class="sidebar-title">Sessions</h2>
      <button class="btn btn-sm sidebar-new" onClick=${() => { newSessionOpen.value = true; }} title=${`New session (${mod}+N)`}>
        <${Icon} name="plus" size=${14} />New
      </button>
    </div>
    ${hasAny && html`<${FilterBar} />`}
    <nav class="sidebar-scroll">
      ${groups}
      ${f && !groups.length && html`<div class="sidebar-nomatch">
        <p>${textQ && !chips ? 'No active sessions match.' : 'No sessions match.'}</p>
        <button class="btn btn-sm btn-ghost" onClick=${() => { sidebarQuery.value = ''; statusFilter.value = []; }}>Clear filter</button>
      </div>`}
      ${!f && !groups.length && html`<div class="sidebar-empty">
        <p>${hasAny ? 'No active sessions.' : 'No sessions yet.'}</p>
        <button class="btn btn-sm" onClick=${() => { newSessionOpen.value = true; }}><${Icon} name="plus" size=${14} />${hasAny ? 'New session' : 'Start one'}</button>
      </div>`}
      ${!f && html`<${ElsewhereSection} />`}
      ${!chips && html`<${PastSection} Row=${SessionRow} query=${textQ}
        archived=${archived.length > 0 ? html`<${ArchivedGroup} list=${archived} forceOpen=${f} />` : null} />`}
    </nav>
    <${BulkBar} />
    <footer class="sidebar-foot"><${UsageMeter} /></footer>
  </aside>`;
}

// ---- shared pulse clock: live status dots + spinners (see components.css "pulse") ----
// A CSS `infinite` animation, even a stepped one, keeps the compositor producing ~60 frames a
// second for as long as it is on screen: one 8 px live dot cost ~4% of a core (GPU + renderer,
// measured 2026-10-08), and the user's terminal sessions keep an Elsewhere dot live all day. Instead
// ONE timer flips attributes on <html> only while a live dot or spinner exists and the window is
// visible: a dot step every 800 ms, a spinner tick every 250 ms (each frame costs ~0.7% of a core here, so
// 8 ticks a second was ~6%; spinners only show while work runs).
// A MutationObserver wakes it when one appears; when none remain it stops; hidden = stopped.
const DOT_MS = 800, SPIN_MS = 250;
const rootEl = document.documentElement;
const liveDots = document.getElementsByClassName('dot live');   // live collections: no re-query
const spinners = document.getElementsByClassName('spinner');
let pulseTimer = 0;
function setAttr(name, v) { if (rootEl.getAttribute(name) !== v) rootEl.setAttribute(name, v); }
function pulseTick() {
  pulseTimer = 0;
  if (document.hidden) return;
  const spin = spinners.length > 0, dots = liveDots.length > 0;
  if (!spin && !dots) return;
  const t = Date.now();
  if (dots) setAttr('data-pulse', String(Math.floor(t / DOT_MS) % 2));
  if (spin) setAttr('data-spin', String(Math.floor(t / SPIN_MS) % 8));
  const period = spin ? SPIN_MS : DOT_MS;
  pulseTimer = setTimeout(pulseTick, period - (t % period) + 2);
}
function pulseWake() { if (!pulseTimer && !document.hidden) pulseTimer = setTimeout(pulseTick, 0); }
if (typeof MutationObserver === 'function') {
  new MutationObserver(pulseWake).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(pulseTimer); pulseTimer = 0; } else pulseWake();
});
pulseWake();
