// Command palette (Ctrl+K): switch session, new session, history, panels, snippets, theme. Owner: lane shell (C).
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { html } from '../lib/html.js';
import { leaveRef } from '../lib/motion.js';
import { TopScrim } from '../lib/top-scrim.js';   // top-row hints: the scrim darkens the window's top row
import { Icon } from '../lib/icons.js';
import { sessions, settings, saveSettings, activeSession, toast, externalSessions, appInfo, rpc, restartHelm } from '../lib/store.js';
import { archiveSessions, closeSession, askDelete, copyText, sessionLink, freshStartWithHandoff, handoffBlocked } from './session-actions.js';
import { focusSidebarFilter } from './sidebar.js';
import { layout, openSplit, toggleSplit, splitPartner, setLayout } from './split.js';
import { openExternal } from './elsewhere.js';
import { PANELS, showPanel, toggleInspector } from '../panels/index.js';
import { paletteOpen, newSessionOpen, openSession, go, goHome, toggleSidebar, sheetOpen, isPhone, sidebarOpen } from './state.js';
import { cx, ago, mod } from './util.js';
import { openPreset, openLike, presetDetail } from './new-session.js';
import { toggleShortcuts } from './shortcuts.js';
import { openWhatsNew } from './whats-new.js';
import { displayStatus } from '../lib/session-status.js';
import { restartWhenFinished } from './update.js'; // lane restart
import { newInWorktree, openWorktrees } from './worktrees.js'; // lane helm-worktrees (H4)
let restartArmed = 0;   // "Restart Helm" warned about working sessions; a second pick before this time restarts

// subsequence fuzzy score: higher is better, -1 = no match
function score(q, text) {
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 || /\W/.test(t[direct - 1]) ? 200 : 0);
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    run = i === ti ? run + 1 : 0;
    s += 10 + run * 5 - (i - ti);
    ti = i + 1;
  }
  return s;
}

function buildCommands() {
  const out = [];
  const act = activeSession.value;
  for (const s of sessions.value) {
    out.push({ id: `s:${s.id}`, group: 'Sessions', icon: s.archived ? 'archive' : 'message', label: s.title || 'New session', detail: s.archived ? `${s.project} · archived` : s.project,
      dot: s.status, meta: ago(s.updatedAt), run: () => openSession(s.id) });
  }
  out.push(
    { id: 'new', group: 'Actions', icon: 'plus', label: 'New session', keys: [mod, 'N'], run: () => { newSessionOpen.value = true; } },
    { id: 'new-wt', group: 'Actions', icon: 'git-branch', label: 'New session in a worktree', detail: 'Its own branch wk/<name> in its own folder, beside the repo', run: () => newInWorktree(activeSession.value?.cwd) },
    ...(settings.value?.presets || []).map((p) => ({ id: `preset:${p.id}`, group: 'Actions', icon: 'bookmark', label: `New session: ${p.name}`,
      detail: presetDetail(p), run: () => openPreset(p.id) })),
    { id: 'home', group: 'Actions', icon: 'home', label: 'Go home', detail: 'Greeting, usage and your sessions over the clear wallpaper', keys: [mod, 'Shift', 'H'], run: goHome },   // lane home
    { id: 'deck', group: 'Actions', icon: 'deck', label: 'Open Deck', detail: 'Every session as a live tile', keys: [mod, 'Shift', 'D'], run: () => go('deck') },
    { id: 'history', group: 'Actions', icon: 'history', label: 'Search history', keys: [mod, 'H'], run: () => go('history') },
    { id: 'settings', group: 'Actions', icon: 'settings', label: 'Open settings', keys: [mod, ','], run: () => go('settings') },
    { id: 'sidebar', group: 'Actions', icon: 'sidebar-left', label: 'Toggle sidebar', keys: [mod, 'B'], run: toggleSidebar },
    { id: 'filter', group: 'Actions', icon: 'filter', label: 'Filter sessions', keys: [mod, 'Shift', 'F'],
      run: () => { go('session'); if (!isPhone.value && !sidebarOpen.value) toggleSidebar(); setTimeout(focusSidebarFilter, 0); } },
    { id: 'inspector', group: 'Actions', icon: 'sidebar-right', label: 'Toggle inspector', keys: [mod, '\\'], run: () => (isPhone.value ? (sheetOpen.value = !sheetOpen.value) : toggleInspector()) },
    { id: 'whats-new', group: 'Actions', icon: 'sparkle', label: "What's new", detail: 'Features added to Helm, each with Show me', run: openWhatsNew },
  );
  if (!isPhone.value) {
    out.push({ id: 'shortcuts', group: 'Actions', icon: 'keyboard', label: 'Keyboard shortcuts', keys: ['?'], run: toggleShortcuts });
    const partner = sessions.value.find((x) => x.id === splitPartner());
    const n = layout.value.n;   // lane quad: in 4 corners the Layout commands below replace this one
    if (n === 2 || (n === 1 && partner)) out.push({ id: 'split', group: 'Actions', icon: 'columns', label: n === 2 ? 'Close split view' : 'Split view',
      detail: n === 2 ? '' : `with ${partner.title || 'New session'}`, keys: [mod, 'Shift', '\\'], run: () => { go('session'); toggleSplit(); } });
    // lane quad: the layout switch's three choices
    out.push(
      { id: 'layout:1', group: 'Actions', icon: 'layout-1', label: 'Layout: 1 pane', detail: n === 1 ? 'Current' : 'One session at a time', run: () => setLayout(1) },
      { id: 'layout:2', group: 'Actions', icon: 'layout-2', label: 'Layout: 2 side by side', detail: n === 2 ? 'Current' : 'Two sessions side by side', keys: [mod, 'Shift', '\\'], run: () => setLayout(2) },
      { id: 'layout:4', group: 'Actions', icon: 'layout-4', label: 'Layout: 4 corners', detail: n === 4 ? 'Current' : 'Four sessions, one in each corner, each with its own message box', keys: [mod, 'Shift', '4'], run: () => setLayout(4) },
    );
    for (const s of sessions.value) {
      if (act && s.id === act.id) continue;
      out.push({ id: `beside:${s.id}`, group: 'Split', icon: 'columns', label: `Open beside: ${s.title || 'New session'}`, detail: s.project,
        dot: s.status, run: () => openSplit(s.id, 1) });
    }
  }
  if (act) {
    out.push(
      act.archived
        ? { id: 'unarchive', group: 'Session', icon: 'archive-restore', label: 'Unarchive this session', detail: act.title, run: () => archiveSessions([act.id], false) }
        : { id: 'archive', group: 'Session', icon: 'archive', label: 'Archive this session', detail: act.title, run: () => archiveSessions([act.id], true) },
      ...(act.status !== 'closed' ? [{ id: 'close', group: 'Session', icon: 'stop', label: 'Close this session', detail: 'Stop its CLI; it stays in the list', run: () => closeSession(act.id) }] : []),
      { id: 'delete', group: 'Session', icon: 'trash', label: 'Delete this session from Helm…', detail: 'Claude Code keeps the transcript', run: () => askDelete([act.id]) },
      { id: 'worktrees', group: 'Session', icon: 'git-branch', label: 'Worktrees of this repo', detail: `${act.project} · ahead/behind, Merge, Remove`, run: () => openWorktrees(act.cwd) },
      { id: 'like', group: 'Session', icon: 'plus', label: 'Start another like this', detail: `${act.project} · same model, effort and permissions`, run: () => openLike(act) },
      // lane handoff: off (with the reason as its detail) while the session works or waits
      ((off) => ({ id: 'handoff', group: 'Session', icon: 'file-plus', label: 'Fresh start with handoff', detail: off || 'This session writes a short handoff; a new session opens with it in the message box',
        disabled: !!off, run: () => freshStartWithHandoff(act) }))(handoffBlocked(act)),
      { id: 'copy-link', group: 'Session', icon: 'link', label: 'Copy link to this session', detail: sessionLink(act.id), run: () => copyText(sessionLink(act.id), 'Link') },
      { id: 'copy-id', group: 'Session', icon: 'hash', label: 'Copy Helm session id', detail: `helm --session=${act.id}`, run: () => copyText(act.id, 'Helm session id') },
    );
  }
  for (const x of externalSessions.value) {
    out.push({ id: `ext:${x.claudeSessionId}`, group: 'Elsewhere', icon: 'terminal', label: x.title || 'Terminal session',
      detail: `${x.project} · ${x.active ? 'running in a terminal' : 'terminal, idle'}`, dot: x.active ? 'working' : 'idle', run: () => openExternal(x.claudeSessionId) });
  }
  for (const p of PANELS) {
    out.push({ id: `panel:${p.id}`, group: 'Panels', icon: p.icon, label: `Show ${p.label.toLowerCase()}`, run: () => { go('session'); showPanel(p.id); if (isPhone.value) sheetOpen.value = true; } });
  }
  for (const sn of settings.value?.snippets || []) {
    out.push({ id: `snip:${sn.id}`, group: 'Snippets', icon: 'snippet', label: sn.name, detail: sn.text, disabled: !act,
      run: () => {
        if (!act) { toast({ title: 'Open a session first', ms: 2500 }); return; }
        go('session');
        dispatchEvent(new CustomEvent('helm:composer-insert', { detail: { text: sn.text } }));
        dispatchEvent(new CustomEvent('helm:composer-focus'));
      } });
  }
  if (appInfo.value.platform === 'electron' && !isPhone.value) {
    out.push({ id: 'devtools', group: 'Actions', icon: 'terminal', label: 'Open developer tools', detail: 'Inspect the Helm window',
      run: () => rpc('app.window', { action: 'devtools' }).catch((e) => toast({ title: 'Developer tools did not open', error: e, kind: 'error' })) });
    // Restart picks up code changes in main/ and ui/. main says what a restart now would cut off (sessions working,
    // agents, background tasks, the queue, uncommitted code): then the first pick names it and a second pick
    // within 10 s restarts anyway (app.restart force).
    const busy = sessions.value.filter((s) => displayStatus(s) === 'working').length;
    out.push({ id: 'restart', group: 'Actions', icon: 'refresh', label: 'Restart Helm', detail: busy ? `${busy} working: pick twice to restart anyway` : 'Quit and reopen to load updates',
      run: async () => {
        const failed = (e) => toast({ title: 'Helm did not restart', error: e, kind: 'error' });
        if (restartArmed > Date.now()) { restartArmed = 0; restartHelm({ force: true }).catch(failed); return; }
        try {
          const r = await restartHelm();
          if (r && r.reasons) {
            restartArmed = Date.now() + 10_000;
            toast({ title: 'Helm is still working', body: `Restarting now stops: ${r.reasons.join(' · ')}. Choose Restart Helm again within 10 seconds to restart now, or "Restart Helm when finished" to wait.`, kind: 'error', ms: 10_000 });
          }
        } catch (e) { failed(e); }
      } });
    // lane restart: wait until nothing would be cut off, then restart (UpdateState.deferred; the chip can cancel it)
    out.push({ id: 'restart-when-finished', group: 'Actions', icon: 'refresh', label: 'Restart Helm when finished', detail: 'Waits for every session, agent and task to finish',
      run: () => restartWhenFinished() });
  }
  const theme = settings.value?.theme || 'dark';
  for (const [v, l, i] of [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'Match system', 'monitor']]) {
    out.push({ id: `theme:${v}`, group: 'Theme', icon: i, label: `Theme: ${l}`, checked: theme === v,
      run: () => saveSettings({ theme: v }).catch((e) => toast({ title: 'Theme not saved', error: e, kind: 'error' })) });
  }
  return out;
}

const GROUP_ORDER = ['Sessions', 'Elsewhere', 'Actions', 'Session', 'Split', 'Panels', 'Snippets', 'Theme'];

export function Palette() {
  const paletteLeave = useMemo(() => leaveRef('fade', 's'), []);   // the exit (lib/motion.js): scrim fades, card shrinks
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null), list = useRef(null);
  const all = useMemo(buildCommands, [sessions.value, settings.value, externalSessions.value, layout.value]);
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      // no query: the 6 most recent sessions, then everything but the long tail of sessions
      const ss = all.filter((c) => c.group === 'Sessions').slice(0, 6);
      return [...ss, ...all.filter((c) => c.group !== 'Sessions' && c.group !== 'Split')];
    }
    return all
      .map((c) => ({ c, s: Math.max(score(query, c.label), score(query, `${c.group} ${c.label}`) - 50, c.detail ? score(query, c.detail) - 300 : -1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group))
      .slice(0, 40)
      .map((x) => x.c);
  }, [q, all]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const close = () => { paletteOpen.value = false; };
  const run = (c) => { if (!c || c.disabled) return; close(); c.run(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  // group headers only when browsing (no query) so search results stay ranked
  let lastGroup = null;
  return html`<div ref=${paletteLeave} class="modal-scrim palette-scrim" onPointerDown=${(e) => { if (e.target === e.currentTarget) close(); }}><${TopScrim} />
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="palette-input">
        <${Icon} name="search" size=${17} />
        <input ref=${input} value=${q} placeholder="Jump to a session or run a command" aria-label="Command"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant=${results[sel] ? `pc-${results[sel].id}` : undefined}
          onInput=${(e) => setQ(e.currentTarget.value)} onKeyDown=${onKey} />
        <span class="kbd">Esc</span>
      </div>
      <div ref=${list} id="palette-list" class="palette-list" role="listbox">
        ${results.length === 0 && html`<div class="palette-empty">No commands match “${q}”.</div>`}
        ${results.map((c, i) => {
          const head = !q.trim() && c.group !== lastGroup ? html`<div class="menu-label palette-group">${c.group}</div>` : null;
          lastGroup = c.group;
          return html`${head}<button id=${`pc-${c.id}`} key=${c.id} role="option" aria-selected=${i === sel} disabled=${c.disabled}
              class=${cx('menu-item palette-item', i === sel && 'active')} onMouseMove=${() => sel !== i && setSel(i)} onClick=${() => run(c)}>
            ${c.dot ? html`<span class="palette-dot"><span class=${cx('dot', c.dot)}></span></span>` : html`<${Icon} name=${c.icon} size=${16} />`}
            <span class="palette-label truncate">${c.label}</span>
            ${c.detail && html`<span class="palette-detail truncate">${c.detail}</span>`}
            <span class="palette-right">
              ${c.checked && html`<${Icon} name="check" size=${14} />`}
              ${c.meta && html`<span class="faint tnum">${c.meta}</span>`}
              ${c.keys && html`<span class="palette-keys">${c.keys.map((k) => html`<span class="kbd">${k}</span>`)}</span>`}
              ${q.trim() && html`<span class="palette-kind">${c.group.replace(/s$/, '')}</span>`}
            </span>
          </button>`;
        })}
      </div>
    </div>
  </div>`;
}
