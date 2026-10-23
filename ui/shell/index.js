// Owner: lane shell (C). Exports Shell, the whole-window layout that mounts ChatView, Composer, Inspector.
//
// Desktop (> 820px): rail | strip (drag region, 40px) over a deck of floating glass panels:
//   [sidebar 272px] [main: session header + ChatView + Composer] [inspector, resizable]; on Home (home.js, the
//   start view) only the strip and the logo stay and the cards float over the unblurred wallpaper.
// Phone (<= 820px): one column: sessions list → session screen (back button); inspector as a
//   bottom sheet; bottom nav (Home, Sessions, History, Queue, Settings); it starts on Home.
// Shortcuts: Ctrl+K palette, Ctrl+N new session, Ctrl+B sidebar, Ctrl+\ inspector, Ctrl+Shift+\ split view, Ctrl+Shift+4 4 corners,
//   Ctrl+1..8 tab (Ctrl+9 last tab; the phone: sidebar order), Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+W tabs (tabs.js), Ctrl+H history, Ctrl+, settings, Ctrl+Shift+D Deck (every session as a tile), Ctrl+F find in the conversation (chat), Esc closes overlays,
//   ? or Ctrl+/ the keyboard shortcuts sheet (shortcuts.js; keep its list in step when adding one here),
//   Ctrl+Shift+H Home (home.js: greeting, glance and session cards over the unblurred wallpaper; Helm opens there).
// Split view (desktop): two .main panels side by side, each with its own header, ChatView and Composer; the
//   focused one is the active session (split.js). A read-only terminal transcript replaces the panes (elsewhere.js).
// 4 corners (lane quad): the same panes in a 2x2 .quad grid, each a full mini-session with a compact header and
//   composer; an empty corner offers "Drag a tab here" + sessions to click in. Below 1100 px only the focused
//   corner's row shows. The layout switch (1 / 2 / 4) sits in the strip (layout-switch.js).
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { leaveRef } from '../lib/motion.js';
import { Icon } from '../lib/icons.js';
import { activeSession, sessions, appInfo, loadHistory, externalView } from '../lib/store.js';
import { ChatView } from '../chat/index.js';
import { Composer } from '../composer/index.js';
import { Inspector, inspectorOpen, inspectorWide, toggleInspector } from '../panels/index.js';
import {
  view, go, goBack, goHome, homeFx, sidebarOpen, toggleSidebar, paletteOpen, newSessionOpen, sheetOpen, phoneScreen, isPhone,
  inspectorWidth, switchToIndex,
} from './state.js';
import { HomeView } from './home.js';   // lane home
import { Background, Rail, Strip, Toasts, PhoneNav, PhoneConn } from './chrome.js';
import { Sidebar, focusSidebarFilter } from './sidebar.js';
import { DeleteDialog, HandoffStatus, copyText } from './session-actions.js';
import { StopConfirmHost } from '../lib/stop.js'; // lane steer: Stop that names the agents it would stop
import { SessionHeader } from './header.js';
import { NewSessionDialog } from './new-session.js';
import { WorktreesSheet, worktreesFor } from './worktrees.js';   // lane helm-worktrees (H4): the Worktrees panel
import { HistoryView, HistoryRow, useHistory } from './history.js';
import { SettingsView } from './settings.js';
import { Palette } from './palette.js';
import { ShortcutsSheet, useShortcutsKey } from './shortcuts.js';   // `?` / Ctrl+/ shortcuts sheet (desktop)
import { WhatsNewSheet, useWhatsNewAutoShow } from './whats-new.js';   // What's new sheet, auto-shown once per list version
import { cx, mod } from './util.js';
import { split, layout, narrow, quadOn, focusPane, toggleSplit, toggleQuad, dragSession, dropOver, dropOnPane } from './split.js';
import { visibleSlots, cornerChoices } from '../lib/pane-layout.js';
import { displayStatus } from '../lib/session-status.js';
import { ExternalPane } from './elsewhere.js';
import { DeckView } from '../deck/deck.js';
import { UpdateChip } from './update.js';   // lane restart
import { switchToTab, tabIds } from './tabs.js';   // lane tabs: session tabs in the strip (Ctrl+Tab / Ctrl+W live in tabs.js)

const sheetLeave = leaveRef('fade', 'm');   // phone panels sheet: the scrim fades, the sheet sinks (lib/motion.js)

function useShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl || e.altKey) return;
      const k = e.key.toLowerCase();
      let hit = true;
      if (k === 'k' && !e.shiftKey) paletteOpen.value = !paletteOpen.value;
      else if (k === 'n' && !e.shiftKey) newSessionOpen.value = true;
      else if (k === 'b' && !e.shiftKey) { if (!isPhone.value) toggleSidebar(); }
      else if (e.code === 'Backslash' && e.shiftKey) { if (!isPhone.value) toggleSplit(); }
      else if (e.code === 'Digit4' && e.shiftKey) { if (!isPhone.value) toggleQuad(); }   // lane quad: 4 corners on / back
      else if (e.code === 'Backslash') { if (isPhone.value) sheetOpen.value = !sheetOpen.value; else { if (view.value !== 'session') go('session'); toggleInspector(); } }
      else if (k === 'f' && e.shiftKey) {
        // filter the session list: desktop shows the sidebar first, the phone goes to its list screen
        if (isPhone.value) { go('session'); phoneScreen.value = 'list'; } else { if (view.value !== 'session') go('session'); if (!sidebarOpen.value) toggleSidebar(); }
        setTimeout(focusSidebarFilter, 0);
      }
      else if (k === 'h' && e.shiftKey) goHome();
      else if (k === 'h') { if (view.value === 'history') goBack(); else go('history'); }
      else if (k === 'd' && e.shiftKey) { if (view.value === 'deck') goBack(); else go('deck'); }
      else if (k === ',') { if (view.value === 'settings') goBack(); else go('settings'); }
      else if (/^[1-9]$/.test(e.key) && !e.shiftKey) { if (isPhone.value) switchToIndex(+e.key - 1); else switchToTab(+e.key); }   // desktop: tabs (1..8, 9 = last)
      else hit = false;
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
}

function Welcome() {
  const { rows, loading } = useHistory('', 5);
  const none = !sessions.value.length;
  return html`<div class="welcome">
    <div class="welcome-inner">
      <div class="welcome-mark" aria-hidden="true"><${Icon} name="helm" size=${28} stroke=${1.4} /></div>
      <h1 class="welcome-title">${none ? 'Nothing running' : 'Pick a session'}</h1>
      <p class="welcome-sub">${none ? 'Start a Claude Code session in one of your projects, or resume a past one.' : 'Choose one from the sidebar, or start something new.'}</p>
      <div class="welcome-actions">
        <button class="btn btn-primary btn-lg" onClick=${() => { newSessionOpen.value = true; }}><${Icon} name="plus" size=${16} />New session</button>
        <span class="welcome-keys"><span class="kbd">${mod}</span><span class="kbd">N</span></span>
      </div>
      ${(loading || rows.length > 0) && html`<div class="welcome-recent">
        <div class="welcome-recent-head"><span class="section-label">Recent</span>
          <button class="btn btn-ghost btn-sm" onClick=${() => go('history')}>All history<${Icon} name="arrow-right" size=${13} /></button></div>
        ${loading && !rows.length ? html`<div class="welcome-loading"><span class="spinner sm"></span></div>`
          : html`<div class="hlist">${rows.map((h) => html`<${HistoryRow} key=${h.claudeSessionId} h=${h} compact />`)}</div>`}
      </div>`}
    </div>
  </div>`;
}

function SessionPane({ sid = null, pane = null, compact = false }) {
  const s = sid ? sessions.value.find((x) => x.id === sid) || null : activeSession.value;
  useEffect(() => { if (sid) loadHistory(sid).catch(() => {}); }, [sid]);   // the unfocused pane loads its own transcript
  if (!s) return html`<${Welcome} />`;
  return html`<div class="sess" key=${s.id}>
    <${SessionHeader} sid=${sid} pane=${pane} compact=${compact} />
    <div class="sess-chat"><${ChatView} sid=${sid} /></div>
    <div class="sess-composer"><${Composer} sid=${sid} /></div>
  </div>`;
}

// While a sidebar row is dragged: drop zones over the main area (left = here / replace, right = beside).
function DropZones({ pane }) {
  const sp = split.value;
  const zones = sp ? [{ i: pane, label: 'Show here' }] : [{ i: 0, label: 'Open here' }, { i: 1, label: 'Open side by side' }];
  const over = dropOver.value;   // a dragged TAB (tabs.js hit-tests); a sidebar row's HTML5 drag sets .over itself
  const accept = (e) => { if ([...(e.dataTransfer?.types || [])].includes('application/x-helm-session')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('over'); } };
  const leave = (e) => e.currentTarget.classList.remove('over');
  const drop = (i) => (e) => {
    e.preventDefault(); e.currentTarget.classList.remove('over');
    const id = e.dataTransfer.getData('application/x-helm-session') || dragSession.value;
    dragSession.value = null;
    if (id) dropOnPane(i, id);
  };
  return html`<div class=${cx('split-drop', sp && 'single')}>
    ${zones.map((z) => html`<div key=${z.i} data-pane=${z.i} class=${cx('split-drop-zone', over != null && over === z.i && 'over')} onDragEnter=${accept} onDragOver=${accept} onDragLeave=${leave} onDrop=${drop(z.i)}>
      <span class="split-drop-label"><${Icon} name=${z.i === 1 && !sp ? 'columns' : 'message'} size=${15} />${z.label}</span></div>`)}
  </div>`;
}

// One main panel. In split view it focuses its pane on pointer-down / focus-in (keyboard follows the pane).
function Pane({ i, focused, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el || i == null) return undefined;
    const f = () => focusPane(i);
    el.addEventListener('focusin', f);
    el.addEventListener('pointerdown', f, true);
    return () => { el.removeEventListener('focusin', f); el.removeEventListener('pointerdown', f, true); };
  }, [i]);
  return html`<main ref=${ref} class=${cx('main panel', i != null && 'pane', focused && 'focused')}>
    ${children}
    ${dragSession.value && html`<${DropZones} pane=${i} />`}
  </main>`;
}

function Mains() {
  const v = view.value;
  if (v === 'history') return html`<${Pane} key="p0"><${HistoryView} /><//>`;
  if (v === 'settings') return html`<${Pane} key="p0"><${SettingsView} /><//>`;
  if (v === 'deck') return html`<${Pane} key="p0"><${DeckView} /><//>`;
  if (externalView.value) return html`<${Pane} key="p0"><${ExternalPane} /><//>`;
  const st = layout.value;
  if (st.n === 1) return html`<${Pane} key="p0"><${SessionPane} /><//>`;
  const quad = st.n === 4;
  const slots = visibleSlots(st, narrow.value);
  const panes = slots.map((i) => html`<${Pane} key=${'p' + i} i=${i} focused=${st.focus === i}>
    ${st.ids[i] ? html`<${SessionPane} sid=${st.ids[i]} pane=${i} compact=${quad} />` : html`<${EmptyCorner} i=${i} />`}<//>`);
  if (!quad) return panes;
  return html`<div class=${cx('quad', slots.length < 4 && 'quad-row')} role="group" aria-label="4 corners">${panes}</div>`;
}

// lane quad: a corner with nothing in it. Drag a tab (or a sidebar row) here, or click one of the open tabs not
// on screen / recent sessions; New session lands here too (this corner has the focus once clicked).
function EmptyCorner({ i }) {
  const st = layout.value;
  const list = sessions.value;
  const byId = new Map(list.map((s) => [s.id, s]));
  const recent = list.filter((s) => !s.archived).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((s) => s.id);
  const ids = cornerChoices({ shown: st.ids, tabs: tabIds.value, recent, limit: 5 });
  return html`<div class="corner-empty">
    <div class="corner-empty-inner">
      <div class="corner-empty-title"><${Icon} name="layout-4" size=${15} />Drag a tab here</div>
      ${ids.length > 0 && html`<div class="corner-empty-sub">or pick a session</div>
      <div class="corner-list" role="list">
        ${ids.map((id) => { const s = byId.get(id); if (!s) return null; const ds = displayStatus(s);
          return html`<button type="button" key=${id} role="listitem" class="corner-row" title=${`${s.title || 'New session'}\n${s.cwd || ''}`} onClick=${() => dropOnPane(i, id)}>
            <span class=${cx('dot', ds, ds === 'working' && 'live')}></span>
            <span class="corner-row-title truncate">${s.title || 'New session'}</span>
            <span class="corner-row-sub truncate">${s.project || ''}</span>
          </button>`; })}
      </div>`}
      <button type="button" class="btn btn-ghost btn-sm corner-new" onClick=${() => { focusPane(i); newSessionOpen.value = true; }}><${Icon} name="plus" size=${14} />New session</button>
    </div>
  </div>`;
}

function InspectorColumn() {
  const wrap = useRef(null);
  const startDrag = (e) => {
    e.preventDefault();
    const el = wrap.current; if (!el) return;
    const startX = e.clientX, startW = el.getBoundingClientRect().width;
    const max = Math.max(320, Math.round(innerWidth * 0.6));
    el.classList.add('resizing');
    const move = (ev) => { const w = Math.round(Math.min(max, Math.max(280, startW + (startX - ev.clientX)))); el.style.width = `${w}px`; };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      el.classList.remove('resizing');
      inspectorWidth.value = Math.round(Math.min(max, Math.max(280, startW + (startX - ev.clientX))));
      if (inspectorWide.value) inspectorWide.value = false;
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const width = inspectorWide.value ? 'min(60vw, calc(100vw - 520px))' : `${inspectorWidth.value}px`;
  return html`<aside ref=${wrap} class="insp-col panel" style=${{ width }}>
    <div class="insp-resize" role="separator" aria-orientation="vertical" aria-label="Resize inspector"
      onPointerDown=${startDrag} onDblClick=${() => { inspectorWidth.value = 360; }}></div>
    <${Inspector} />
  </aside>`;
}

// app.hello said engine: 'fallback': sessions are not real Claude Code. Persistent, with the reason + log path.
function EngineBanner() {
  const a = appInfo.value;
  if (a.engine !== 'fallback') return null;
  const why = String(a.engineReason || 'The real engine did not load').trim();
  return html`<div class="engine-banner" role="alert">
    <${Icon} name="alert" size=${16} />
    <div class="engine-banner-text">
      <strong>Helm is running its stand-in engine.</strong> ${why}${/[.!?]$/.test(why) ? '' : '.'} Sessions here do not run Claude Code.
      ${a.logPath && html`<div class="engine-banner-log mono truncate" title=${a.logPath}>Log: ${a.logPath}</div>`}
    </div>
    ${a.logPath && html`<button class="btn btn-sm" onClick=${() => copyText(a.logPath, 'Log path')}><${Icon} name="copy" size=${14} />Copy log path</button>`}
  </div>`;
}

function Desktop() {
  const v = view.value;
  const home = v === 'home';
  const fx = homeFx.value;   // lane home: 'to' = the layout slides away, 'from' = it slides back in (home.css)
  const showInsp = v === 'session' && inspectorOpen.value && !!activeSession.value && !externalView.value;
  return html`<div class=${cx('app desktop', `view-${v}`, split.value && v === 'session' && !externalView.value && 'is-split', quadOn.value && 'is-quad',sidebarOpen.value ? 'with-sidebar' : 'no-sidebar', showInsp && 'with-insp', appInfo.value.platform === 'electron' && 'is-electron', appInfo.value.engine === 'fallback' && 'has-banner', home && 'on-home', fx === 'to' && 'fx-to-home', fx === 'from' && 'fx-from-home')}>
    <${Background} />
    <${Rail} />
    <${Strip} />
    <${EngineBanner} />
    ${home ? html`<${HomeView} />` : html`<div class="deck">
      ${sidebarOpen.value && v === 'session' && html`<${Sidebar} />`}
      <${Mains} />
      ${showInsp && html`<${InspectorColumn} />`}
    </div>`}
  </div>`;
}

function Phone() {
  const v = view.value;
  const inExternal = v === 'session' && phoneScreen.value === 'session' && !!externalView.value;
  const inSession = !inExternal && v === 'session' && phoneScreen.value === 'session' && !!activeSession.value;
  let screen;
  if (v === 'home') screen = html`<${HomeView} />`;   // lane home: the phone starts here too
  else if (v === 'history') screen = html`<${HistoryView} />`;
  else if (v === 'settings') screen = html`<${SettingsView} />`;
  else if (v === 'deck') screen = html`<${DeckView} />`;
  else if (v === 'queue') screen = html`<section class="view view-queue"><${Inspector} panel="queue" /></section>`;
  else if (inExternal) screen = html`<${ExternalPane} />`;
  else if (inSession) screen = html`<${SessionPane} />`;
  else screen = html`<div class="plist">
    <header class="plist-head">
      <button type="button" class="plist-mark" aria-label="Home" onClick=${goHome}><${Icon} name="helm" size=${22} stroke=${1.5} /></button>
      <h1>Helm</h1>
      <span class="grow"></span>
      ${sessions.value.some((s) => !s.archived) && html`<button class="icon-btn plist-deck" aria-label="Deck: every session as a tile" onClick=${() => go('deck')}><${Icon} name="deck" size=${19} stroke=${1.5} /></button>`}
      <button class="btn btn-primary" onClick=${() => { newSessionOpen.value = true; }}><${Icon} name="plus" size=${16} />New</button>
    </header>
    ${sessions.value.length ? html`<${Sidebar} />` : html`<${Welcome} />`}
  </div>`;
  return html`<div class=${cx('app phone', `view-${v}`, (inSession || inExternal) && 'in-session', v === 'home' && 'on-home')}>
    <${Background} />
    <${PhoneConn} />
    ${!inSession && !inExternal && html`<${EngineBanner} />`}
    ${!inSession && !inExternal && html`<${UpdateChip} />`}
    <main class="pscreen">${screen}</main>
    ${!inSession && !inExternal && html`<${PhoneNav} />`}
    ${sheetOpen.value && inSession && html`<div ref=${sheetLeave} class="sheet-scrim" onPointerDown=${(e) => { if (e.target === e.currentTarget) sheetOpen.value = false; }}>
      <div class="sheet" role="dialog" aria-label="Panels">
        <button class="sheet-grab" aria-label="Close panels" onClick=${() => { sheetOpen.value = false; }}><span></span></button>
        <${Inspector} />
      </div>
    </div>`}
  </div>`;
}

export function Shell() {
  useShortcuts();
  useShortcutsKey();
  useWhatsNewAutoShow();
  // phone: Esc / browser back closes the sheet first
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && sheetOpen.value) { sheetOpen.value = false; e.preventDefault(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`<${isPhone.value ? Phone : Desktop} />
    ${newSessionOpen.value && html`<${NewSessionDialog} />`}
    ${worktreesFor.value && html`<${WorktreesSheet} />`}
    ${paletteOpen.value && html`<${Palette} />`}
    <${ShortcutsSheet} />
    <${WhatsNewSheet} />
    <${DeleteDialog} />
    <${HandoffStatus} />
    <${StopConfirmHost} />
    <${Toasts} />`;
}
