// What's new: a calm sheet listing the features that landed overnight and today (2026-10-08), each with a
// "Show me" that opens the real thing. Shown once automatically the first time Helm opens with this
// list (per browser profile: the desktop window and the phone each see it once), and any time from
// the palette ("What's new"), the shortcuts sheet footer and the Settings footer.
// Seen state: localStorage[SEEN_KEY] = VERSION. Bump VERSION whenever ENTRIES change.
// A failed storage read or write never shows it more than once per run (autoShown flag).
// Auto-show is skipped under automation so screenshots and tests are not covered by it: in ?mock pages,
// when navigator.webdriver is set, and in a `Helm --test` run (app.hello says `test: true`; any port, so a
// second real Helm on another port still gets it). `?whatsnew=1` lifts those (the seen key still applies; `?whatsnew=reset` clears it first).
// Owner: lane shell (C) / whats-new.
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { sessions, activeSession, fleetBySession, settings, ready, isMock, toast, appInfo, rpc } from '../lib/store.js';
import { showPanel } from '../panels/index.js';
import { fleetMode } from '../panels/fleet.js';
import { openAgent, closeAgent } from '../panels/agent-view.js';
import { go, goHome, openSession, newSessionOpen, isPhone, sheetOpen, sidebarOpen, toggleSidebar, phoneScreen, view } from './state.js';
import { focusSidebarFilter } from './sidebar.js';
import { setLayout } from './split.js';   // lane quad
import { pastOpen } from './past.js';
import { shortcutsOpen } from './shortcuts.js';
import { Modal, isMac } from './util.js';

export const VERSION = '2026-10-14';
const SEEN_KEY = 'helm.whatsNew.seen';

export const whatsNewOpen = signal(false);
export function openWhatsNew() { whatsNewOpen.value = true; }

const M = isMac ? '⌘' : 'Ctrl', S = isMac ? '⇧' : 'Shift';

// ---- "Show me" helpers ----
const later = (fn, ms = 0) => setTimeout(fn, ms);
// Run fn once `sel` exists (the target view renders on the next frame or two); give up after ~1 s.
function whenThere(sel, fn, tries = 30) {
  const el = document.querySelector(sel);
  if (el) { fn(el); return; }
  if (tries > 0) requestAnimationFrame(() => whenThere(sel, fn, tries - 1));
}

// The session to demo on: the open one, else the newest live one (preferring one with agents).
function pickSession({ agents = false } = {}) {
  const act = activeSession.value;
  const fleets = fleetBySession.value;
  const hasAgents = (s) => (fleets[s.id] || []).length > 0;
  if (act && (!agents || hasAgents(act))) return act;
  const live = sessions.value.filter((s) => !s.archived);
  return (agents && live.find(hasAgents)) || act || live[0] || sessions.value[0] || null;
}
function needSession(opts) {
  const s = pickSession(opts);
  if (!s) { toast({ title: 'Start a session first', body: 'This lives inside a session. Press New session to start one.', ms: 4000 }); newSessionOpen.value = true; return null; }
  if (activeSession.value?.id !== s.id || view.value !== 'session' || (isPhone.value && phoneScreen.value !== 'session')) openSession(s.id);
  return s;
}
function panel(id) { showPanel(id); if (isPhone.value) sheetOpen.value = true; }
// Scroll el to the top of its view and keep it there for ~1.5 s while sections above it finish loading
// (backgrounds, CLAUDE.md lists) and shift the layout. Any wheel, touch or key from the user lets go at once.
function pinInView(el, root, ms = 1500) {
  const to = () => el.isConnected && el.scrollIntoView({ block: 'start', behavior: 'auto' });
  to();
  if (typeof ResizeObserver !== 'function' || !root) return;
  const ro = new ResizeObserver(to);
  ro.observe(root);
  const stop = () => { ro.disconnect(); clearTimeout(t); for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(ev, stop, true); };
  const t = setTimeout(stop, ms);
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(ev, stop, { capture: true, passive: true });
}
function settingsAt(section) {
  go('settings');
  whenThere(`#set-${section}`, (el) => pinInView(el, el.closest('.set-wrap')));
}
// Open a menu/popover that lives in the session header of the focused pane.
function clickInHeader(sel, missing) {
  whenThere('.sess-head', () => {
    const scope = document.querySelector('.pane.focused .sess-head') || document.querySelector('.sess-head');
    const el = scope?.querySelector(sel);
    if (el) el.click(); else toast({ title: missing, ms: 3500 });
  });
}

// Put `!` in the open session's composer (only when it is empty) and focus it.
function composerBang() {
  if (!needSession()) return;
  whenThere('.cmp-ta', () => {
    const ta = document.querySelector('.pane.focused .cmp-ta') || document.querySelector('.cmp-ta');
    if (!ta) return;
    if (!ta.value) { ta.value = '!'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  });
}
function usageAt(title) {
  if (!needSession()) return; panel('usage');
  whenThere('.pn-sect-title', () => {
    const h = [...document.querySelectorAll('.pn-sect-title')].find((x) => x.textContent.trim() === title);
    h?.scrollIntoView({ block: 'start' });
  });
}

const ENTRIES = [
  { id: 'voice', icon: 'mic', title: 'Talk instead of typing', keys: ['Ctrl', 'M'],   // lane voice (composer/voice.js)
    body: 'The mic in the message box, or Ctrl+M: tap to start and tap again to stop, or hold Ctrl+M while you talk and let go. Whisper turns it into text on this PC and puts it at the cursor for you to check; nothing is sent and no audio is kept. Esc throws a take away.',
    phoneBody: 'Tap the mic in the message box to talk, tap again to stop, or hold it while you talk. Your PC turns it into text and puts it in the box for you to check; nothing is sent and no audio is kept.',
    show: () => { if (!needSession()) return; whenThere('.cmp-mic', () => { const el = document.querySelector('.pane.focused .cmp-mic') || document.querySelector('.cmp-mic'); el?.focus(); }); } },
  { id: 'look-sync', icon: 'monitor', title: 'Helm, Quartz and Mantle look the same',
    body: 'Helm now shows your desktop wallpaper behind its glass, lined up with the screen, so it looks see-through to the desktop. Change the theme, accent, blur, dim or see-through in any of the three apps and the other two follow. Settings → Appearance has the switch, a status line, and "Own picture" if you want Helm different.' },
  { id: 'steer', icon: 'send', title: 'Messages mid-turn never stop anything',
    body: 'Send a message while Claude is working and it reads it at its next step; nothing is interrupted and background agents keep running. Send never turns into Stop, Esc only closes menus, and an empty Enter does nothing. Stop is its own button, asks first when agents are running and names them, and Claude is told which agents it stopped.' },
  { id: 'prod-guard', icon: 'shield', title: 'Production guard',
    body: 'Helm stops and asks before a Claude session pushes a protected branch or repo (the ones you list in prod-guard.json in the Helm data folder) or runs a Railway deploy, even in Bypass mode. If your last message already said to push or deploy, it goes through and the chat notes it. Settings → Safety turns it off.' },
  { id: 'stopped-agents', icon: 'stop', title: 'Stopped and stalled, shown honestly',
    body: 'Agents a Stop ended show "Stopped · interrupted" and leave every running count; an agent silent for 10 minutes shows "No activity". A turn with no word from Claude Code for 10 minutes shows "Stalled" with a Resume that asks first.' },
  { id: 'recap', icon: 'history', title: 'Since you left',
    body: 'Home lists what each session did while you were away: finished, failed, waiting on you or still working, plus commits, files changed, cost and when. Opening a session clears its line, on desktop and phone.' },
  { id: 'scheduled', icon: 'clock', title: 'Everything scheduled, in one place',
    body: 'Home shows what is next up (a /loop tick, a cron job) with a live countdown, and the Queue panel lists every schedule across your sessions. Cancel by asking Claude in that session or by closing its process; Helm says if a restart ended any.' },
  { id: 'handoff', icon: 'copy', title: 'Fresh start with handoff',
    body: `From a session's menu or ${M}+K: that session writes a short handoff (done, left, files, test state), then a new session opens beside it with the same folder, model, effort and permissions, the handoff waiting in its message box for you to check and send.` },
  { id: 'badge', icon: 'bell', title: 'A number on the taskbar', desktopOnly: true,
    body: 'Helm\'s taskbar icon shows how many sessions need you: waiting on an answer or a permission, plus ones that stopped on an error (an error counts until you open that session).' },
  { id: 'corners', icon: 'layout-4', title: '4 corners', keys: [M, S, '4'], desktopOnly: true,   // lane quad
    body: `See four sessions at once, one in each corner, each with its own message box. Pick 4 in the layout switch next to Search at the top, or press ${M}+Shift+4. Drag a tab down onto a corner to put it there; if it is already in another corner the two swap. Closing a corner's tab empties that corner. The right panel hides while the corners show; ${M}+\\ brings it back.`,
    show: () => setLayout(4) },
  { id: 'home', icon: 'home', title: 'Home', keys: [M, S, 'H'],
    body: `Helm now opens on Home: what is working, your usage, and a card for each open session to jump back in. The wallpaper shows clear there. Get back to it with the Helm logo at the top left or ${M}+Shift+H.`,
    phoneBody: 'Helm now opens on Home: what is working, your usage, and a card for each open session to jump back in. Tap Home in the bottom bar to get back to it.',
    show: () => goHome() },
  { id: 'pace', icon: 'gauge', title: 'Pace on Home',
    body: 'Next to the 5H chip, Home says whether you are under pace, on pace or hot, and when the window resets. Hot (amber) means you would hit 100% more than 30 minutes before the reset. Hover it for the burn rate and the projection.',
    phoneBody: 'Next to the 5H chip, Home says whether you are under pace, on pace or hot, and when the window resets. Hot (amber) means you would hit 100% more than 30 minutes before the reset.',
    show: () => goHome() },
  { id: 'railway', icon: 'server', title: 'Railway',
    body: 'Live deploy status for your Railway projects, in its own panel and as a chip on Home. Redeploy or Restart a service from there; each asks you to confirm first. Click the Railway chip on Home to open it.',
    // the panel lives beside a session; with none open, Home's Railway chip opens it in a dialog
    show: () => { if (pickSession()) { needSession(); panel('railway'); } else goHome(); } },
  { id: 'tabs', icon: 'sessions', title: 'Session tabs', keys: ['Ctrl', 'Tab'], desktopOnly: true,
    body: `Every session you open becomes a tab in the top bar. Closing a tab never stops the session. Drag a tab to reorder: it follows your pointer and the others slide out of the way. Ctrl+Tab moves between tabs, Ctrl+1 to 9 picks one, Ctrl+W closes one.`,
    show: () => { needSession(); } },
  { id: 'statusline', icon: 'info', title: 'Status line',
    body: 'The session header now always shows what is going on: state and turn time, agents running, an estimate when there is a real one, the current step, todos and context. Click it for the full details.',
    show: () => { needSession(); } },
  { id: 'https', icon: 'lock', title: 'Phone over HTTPS, with notifications',
    body: 'Settings, Phone, Turn on HTTPS serves Helm to your phone over https on your tailnet only. Open the https link on the phone, add it to the home screen, then tap Turn on notifications to get a ping when a session needs you, finishes or errors.',
    phoneBody: 'Open Helm from its https link and tap Turn on notifications in Settings, Phone to get a ping when a session needs you, finishes or errors. Add it to your home screen to open it like an app.',
    show: () => settingsAt('phone') },
  { id: 'restart', icon: 'refresh', title: 'Restart, and updates on their own',
    body: 'Settings, Helm shows the version running and has a Restart Helm button (the tray menu has one too). When a new version is committed, Helm restarts by itself once nothing is running and you have not used it for 2 minutes, then tells you what changed. Turn that off in the same place.',
    show: () => settingsAt('helm') },
  { id: 'past', icon: 'history', title: 'Active sessions + Past',
    body: 'The sidebar now lists only active sessions, newest started first, and they no longer move around: working (agents included), waiting for you, errored, or used in the last hour. Everything else, your old terminal sessions included, is in Past at the bottom. Search it, open one, and send a message to carry on. "Keep in list" in a session\'s menu pins it.',
    phoneBody: 'The list now shows only active sessions. Everything else, your old terminal sessions included, is in Past at the bottom: search it, open one, and send a message to carry on.',
    show: () => {
      go('session');
      if (isPhone.value) phoneScreen.value = 'list'; else if (!sidebarOpen.value) toggleSidebar();
      pastOpen.value = true;
      whenThere('.sgroup-past .past-body', (el) => el.closest('.sgroup-past').scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } },
  { id: 'bang', icon: 'terminal', title: 'Shell commands with !', keys: ['!'],
    body: 'Start a message with ! to run a shell command in the session folder, like "! git status". The output shows in the conversation and Claude sees it with your next message.',
    show: composerBang },
  { id: 'account', icon: 'key', title: 'Settings, Account',
    body: 'See how Helm\'s sessions sign in to Claude, and change it right there, on the PC or the phone.',
    show: () => settingsAt('account') },
  { id: 'activity', icon: 'clock', title: 'Active hours',
    body: 'See how long Claude actually spent working: today, this week and the last 14 days, wall-clock time and agent-hours, split by project.',
    show: () => usageAt('Active hours') },
  { id: 'deck', icon: 'deck', title: 'Deck', keys: [M, S, 'D'],
    body: 'Every session as a live tile. Approve or deny, stop, or reply from the tile without opening the session.',
    show: () => go('deck') },
  { id: 'agent', icon: 'fleet', title: 'Agent drill-in',
    body: 'Click any agent in the Agents panel to read its own transcript as it runs, nested agents included.',
    show: () => {
      const s = needSession({ agents: true }); if (!s) return;
      fleetMode.value = 'tree';
      const list = fleetBySession.value[s.id] || [];
      const a = list.find((x) => x.status === 'running') || list[0];
      if (a) openAgent(a); else { closeAgent(); toast({ title: 'No agents in this session yet', body: 'When it spawns one, click it in the Agents panel.', ms: 4000 }); }
      panel('fleet');
    } },
  { id: 'timeline', icon: 'clock', title: 'Fleet timeline',
    body: 'Agents panel, Timeline: a Gantt of when each agent ran, with the peak number running at once.',
    show: () => { if (!needSession({ agents: true })) return; closeAgent(); fleetMode.value = 'timeline'; panel('fleet'); } },
  { id: 'handoff', icon: 'bell', title: 'Context hand-off alerts',
    body: 'A notification when a running agent passes 32% of its context window, and again at the 40% ceiling. Switch it off in Settings, Notifications.',
    show: () => settingsAt('notify') },
  { id: 'claude', icon: 'file-text', title: 'Settings, Claude Code',
    body: 'Read and edit your CLAUDE.md files and memory notes; saves keep a backup and broken MEMORY.md lines are flagged. Shows MCP server status for the live session.',
    show: () => settingsAt('claude') },
  { id: 'presets', icon: 'bookmark', title: 'Launch presets',
    body: 'Save a folder, model, effort and permission mode as a preset and start it in one click. "Start another like this" in the session menu copies the open session.',
    show: () => { newSessionOpen.value = true; } },
  { id: 'git', icon: 'git-branch', title: 'Git chip',
    body: 'Branch, changed files and ahead/behind for the session folder, in the session header. Click it for details. Read-only; it never fetches.',
    show: () => { if (needSession()) clickInHeader('.sh-git', 'This session\'s folder is not a git repository'); } },
  { id: 'export', icon: 'download', title: 'Export or copy as Markdown',
    body: 'From the session menu: prompts, replies and one-line tool summaries as a .md file or on the clipboard. Thinking is left out.',
    show: () => { if (needSession()) clickInHeader('[aria-label="Session actions"]', 'Session menu not found'); } },
  { id: 'organise', icon: 'archive', title: 'Archive, select and filter',
    body: `Archive sessions instead of deleting them, ${isMac ? '⌘' : 'Ctrl'}-click or Shift-click to act on several, and filter the sidebar by text or status. Pin or rename a project from its group menu.`,
    phoneBody: 'Archive sessions instead of deleting them and filter the list by text or status. Pin or rename a project from its group menu.',
    keys: [M, S, 'F'],
    show: () => {
      go('session');
      if (isPhone.value) phoneScreen.value = 'list'; else if (!sidebarOpen.value) toggleSidebar();
      later(focusSidebarFilter);
    } },
  { id: 'usage', icon: 'gauge', title: 'Usage history',
    body: 'Usage panel, History: the 5-hour window over 24 hours, the week over 7 days, and cost per day for 14 days.',
    show: () => {
      if (!needSession()) return; panel('usage');
      whenThere('.pn-sect-title', () => {
        const h = [...document.querySelectorAll('.pn-sect-title')].find((x) => x.textContent.trim() === 'History');
        h?.scrollIntoView({ block: 'start' });
      });
    } },
  { id: 'rewind', icon: 'rewind', title: 'Rewind survives restarts',
    body: 'Rewind to a message and it still holds after Helm restarts. A tool you interrupt now shows Stopped, not Failed.',
    show: () => { if (needSession()) panel('changes'); } },
  { id: 'shortcuts', icon: 'keyboard', title: 'Keyboard shortcuts', keys: ['?'], desktopOnly: true,
    body: `Every shortcut on one sheet. Press ? anywhere outside a text field, or ${M}+/.`,
    show: () => { shortcutsOpen.value = true; } },
  { id: 'phone', icon: 'phone', title: 'Phone',
    body: 'Add Helm to your phone\'s home screen to open it like an app. Settings, Phone checks the firewall, Tailscale and the port, with the fix for anything failing.',
    show: () => settingsAt('phone') },
];

function Entry({ e, phone, onShow }) {
  return html`<li class="wn-item">
    <span class="wn-icon" aria-hidden="true"><${Icon} name=${e.icon} size=${16} /></span>
    <div class="wn-text">
      <div class="wn-title-row">
        <h3 class="wn-title">${e.title}</h3>
        ${!phone && e.keys && html`<span class="wn-keys">${e.keys.map((k) => html`<span class="kbd">${k}</span>`)}</span>`}
      </div>
      <p class="wn-body">${(phone && e.phoneBody) || e.body}</p>
    </div>
    <button class="btn btn-sm wn-show" data-wn=${e.id} onClick=${() => onShow(e)} aria-label=${`Show me: ${e.title}`}>Show me</button>
  </li>`;
}

export function WhatsNewSheet() {
  if (!whatsNewOpen.value) return null;
  const phone = isPhone.value;
  const close = () => { whatsNewOpen.value = false; };
  // Close first, then open the feature once the sheet (and its focus restore) is gone.
  const onShow = (e) => { close(); later(() => { try { e.show(); } catch (err) { toast({ title: `Could not open ${e.title}`, error: err, kind: 'error' }); } }, 30); };
  const list = ENTRIES.filter((e) => !(phone && e.desktopOnly));
  return html`<${Modal} title="What's new in Helm" onClose=${close} width=${640} class=${phone ? 'wn-modal wn-phone' : 'wn-modal'}
      footer=${html`<span class="hint wn-foot-note">Reopen this from the command palette any time.</span><span class="grow"></span>
        <button class="btn btn-primary btn-sm" onClick=${close}>Done</button>`}>
    <p class="wn-lede">${list.length} things landed while you were away. Each "Show me" opens the real thing.</p>
    <ol class="wn-list">${list.map((e) => html`<${Entry} key=${e.id} e=${e} phone=${phone} onShow=${onShow} />`)}</ol>
  <//>`;
}

// ---- auto-show once per VERSION ----
let autoShown = false;   // this run already showed it (covers storage that throws)
// `--test` runs flag themselves in app.hello. The store keeps only some hello fields in appInfo, so when
// `test` is not there, ask once. Only reached when the sheet is unseen for this VERSION, so normally once per VERSION.
async function isTestRun() {
  const known = appInfo.value?.test;
  if (typeof known === 'boolean') return known;
  try { return !!(await rpc('app.hello', {}))?.test; } catch { return true; }   // cannot tell: stay quiet
}
export function useWhatsNewAutoShow() {
  const live = ready.value && !!settings.value;
  useEffect(() => {
    if (!live || autoShown) return;
    autoShown = true;
    let force = null;
    try { force = new URLSearchParams(location.search).get('whatsnew'); } catch {}
    if (force === 'reset') { try { localStorage.removeItem(SEEN_KEY); } catch {} }
    let seen = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch {}
    if (seen === VERSION) return;
    if (!force && (isMock || navigator.webdriver)) return;
    (force ? Promise.resolve(false) : isTestRun()).then((test) => {
      if (test) return;
      try { localStorage.setItem(SEEN_KEY, VERSION); } catch {}
      whatsNewOpen.value = true;
    });
  }, [live]);
}
