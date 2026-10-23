// Shell UI state. Owner: lane shell (C). Window-level view routing, overlays, layout prefs,
// theme + background application. Other lanes may import these read-only (e.g. isPhone, view).
import { signal, effect, computed, batch } from '@preact/signals';
import { settings, sessions, activeId, selectSession, externalView, look } from '../lib/store.js';
import { mockBgUrl, on } from '../lib/transport.js';
import { washFor } from '../lib/wash.js';
import { paintedGlass } from '../lib/glass.js';   // lane wk-light: which glass paints (light look un-held)
import { sessionSplit } from './activity.js';
import { buildProjectGroups } from '../lib/session-activity.js';

function load(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
function persist(sig, key) { effect(() => { const v = sig.value; try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }); }

// 'home' | 'session' | 'history' | 'settings' | 'queue' (queue is phone-only; desktop shows it in the inspector)
//   | 'deck' (every session as a live tile: ui/deck/deck.js, lane deck)
// lane home: Helm opens on Home (greeting, glance, session cards over the unblurred wallpaper: shell/home.js).
export const view = signal('home');
export const sidebarOpen = signal(load('helm.sidebar.open', true) !== false);
export const inspectorWidth = signal(load('helm.inspector.width', 360));
export const collapsedGroups = signal(load('helm.sidebar.collapsed', {}));
persist(sidebarOpen, 'helm.sidebar.open');
persist(inspectorWidth, 'helm.inspector.width');
persist(collapsedGroups, 'helm.sidebar.collapsed');

export const paletteOpen = signal(false);
export const newSessionOpen = signal(false);   // false | true | { cwd } (preselect a project)
export const sheetOpen = signal(false);        // phone: inspector bottom sheet
export const phoneScreen = signal('list');     // phone: 'list' | 'session'

// layout breakpoint (also used by CSS: @media (max-width: 820px))
const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 820px)') : null;
export const isPhone = signal(!!mq?.matches);
mq?.addEventListener('change', (e) => { isPhone.value = e.matches; });

// ---- phone keyboard ----
// iOS keeps the layout viewport full height while the on-screen keyboard is open, so a fixed full-height
// app (and its composer) would sit behind it. Track the visual viewport (event-driven, no polling) into
// --vvh / --vvtop, which size .app.phone. Android gets the same via interactive-widget=resizes-content.
const vv = typeof window !== 'undefined' ? window.visualViewport : null;
if (vv) {
  const rootStyle = document.documentElement.style;
  let raf = 0;
  const apply = () => {
    raf = 0;
    if (Math.abs(vv.scale - 1) > 0.01) { rootStyle.removeProperty('--vvh'); rootStyle.removeProperty('--vvtop'); return; } // pinch-zoom: leave layout alone
    rootStyle.setProperty('--vvh', `${Math.round(vv.height)}px`);
    rootStyle.setProperty('--vvtop', `${Math.max(0, Math.round(vv.offsetTop))}px`);
  };
  const onChange = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  apply();
}

// ---- theme ----
const darkMq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const systemLight = signal(!!darkMq?.matches);
darkMq?.addEventListener('change', (e) => { systemLight.value = e.matches; });
export const themePref = computed(() => settings.value?.theme || 'dark');
export const resolvedTheme = computed(() => (themePref.value === 'system' ? (systemLight.value ? 'light' : 'dark') : themePref.value));
effect(() => {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme.value;
  root.dataset.themePref = themePref.value;
});

// ---- background (one blurred layer; values live-previewable while a slider drags) ----
// Look Sync (PROTOCOL "Look Sync"): background.mode 'desktop' paints the desktop wallpaper still (/bg/desktop),
// lined up with the screen on the desktop window; 'own' paints the picked file as before. Blur / dim / panel
// come from settings.glass for the theme showing now (shared with Quartz + Mantle while lookSync is on).
export const bgUrl = (file) => (file ? mockBgUrl(file) || `/bg/${encodeURIComponent(file)}` : null);
export const bgPreview = signal(null);   // { mode?, file?, blur?, dim?, panel?, theme? } overrides while editing in Settings (blur/dim/panel: glass[theme])
// lining up needs the window's screen position: only the desktop window has it (preload.js), never the phone
export const canLineUp = typeof window !== 'undefined' && typeof window.helmNative?.onPlacement === 'function';
// Each theme paints its own synced glass (look-sync CONTRACT "Light look", decided 2026-10-14: the light look is
// un-held): glass.dark in dark, glass.light in light, blur + dim + panel shift alike (ui/lib/glass.js). A slider
// preview carries the theme it was made in (bgPreview.theme) and only shows while that theme does.
export const glass = computed(() => paintedGlass(settings.value, resolvedTheme.value, bgPreview.value));
export const background = computed(() => {
  const st = settings.value?.background || {};
  const pv = bgPreview.value || {};
  const mode = pv.mode || st.mode || 'own';   // a host without Look Sync has no mode: its picture is the own one
  const file = pv.file !== undefined ? pv.file : (st.file ?? null);
  const desktop = look.value?.desktop || null;
  const url = mode === 'desktop' ? desktop?.url || null : bgUrl(file);
  const g = glass.value;
  const wash = washFor(g, mode, desktop);   // following the desktop: Mantle's shared top band for this theme (ui/lib/wash.js)
  return { kind: 'image', mode, file, url, blur: g.blurPx, dim: wash.dim, setDim: g.dim, wash, panel: g.panel, desktop, lineUp: mode === 'desktop' && !!url && canLineUp };
});
effect(() => {
  const b = background.value, s = document.documentElement.style;
  s.setProperty('--bg-blur', `${Math.max(0, +b.blur || 0)}px`);
  s.setProperty('--bg-dim', String(Math.min(0.95, Math.max(0, +b.dim || 0))));
  // panel: added to --surface-1..3 and --overlay alphas (tokens.css); 0 = the tokens exactly as authored
  s.setProperty('--glass-panel', String(Math.min(0.15, Math.max(-0.3, +b.panel || 0))));
});
// accent: settings.accentHue null keeps tokens.css; a hue paints the host-derived tokens (accent.js) for this theme
const ACCENT_VARS = { acc: '--accent', strong: '--accent-strong', on: '--accent-text', soft: '--accent-soft', line: '--accent-line' };
effect(() => {
  const tk = settings.value?.accentTokens?.[resolvedTheme.value === 'light' ? 'light' : 'dark'] || null;
  const s = document.documentElement.style;
  for (const [k, v] of Object.entries(ACCENT_VARS)) { if (tk && tk[k]) s.setProperty(v, tk[k]); else s.removeProperty(v); }
});

// ---- navigation helpers ----
export function openSession(id) {
  externalView.value = null;   // leave a read-only terminal transcript, if one is open
  selectSession(id);
  view.value = 'session';
  phoneScreen.value = 'session';
}
// Where a view toggle (Ctrl+H / Ctrl+, / Ctrl+Shift+D, the rail) returns to: Home when that is where the user came from.
let backTo = 'session';
export function go(v) {
  if (v === 'home') { goHome(); return; }
  const cur = view.peek();
  if (cur !== v && (cur === 'home' || cur === 'session')) backTo = cur;
  view.value = v;
  if (v !== 'session') phoneScreen.value = 'list';
}
export function goBack() {
  if (backTo === 'home' && !activeId.peek() && !externalView.peek()) goHome();
  else go('session');
}
// On Home the sidebar is hidden with everything else, so its toggle (strip button, Ctrl+B) leaves Home with it shown.
export function toggleSidebar() {
  if (view.peek() === 'home' && !isPhone.peek()) { go('session'); sidebarOpen.value = true; return; }
  sidebarOpen.value = !sidebarOpen.value;
}

// ---- Home (lane home, 2026-10-08) ----
// goHome(): the Helm logo, Ctrl+Shift+H, the palette's "Go home", the phone's Home tab, closing the last tab.
// While Home shows, no session is active (desktop: no tab is), so the tab strip, palette and inspector all agree.
// homeFx drives the brief transition (classes on .app, keyframes in shell/home.css):
//   'to'   the layout slides away and the clear wallpaper fades in (HOME_TO_MS), then Home commits
//   'from' just left Home: the panels slide back in and the clear wallpaper fades out (HOME_FROM_MS)
// Only opacity/transform animate (compositor-only); the wallpaper blur is never animated: shell/chrome.js
// cross-fades an unblurred copy over the blurred layer, and the blurred one is hidden while Home shows.
// The shared motion tokens (styles/tokens.css): the way out is a leave (--m-dur-s x .45 on --m-accel), the way
// back is an arrival (--m-dur-s on --m-spring); size class s because the panels travel only 8-20 px. Keep these
// equal to home.css.
export const HOME_TO_MS = 144;
export const HOME_FROM_MS = 320;
export const homeFx = signal(null);   // null | 'to' | 'from'
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reducedMotion = () => !!reduceMq?.matches;
let fxTimer = 0;
let fxSeq = 0;
function setFx(kind, ms, then) {
  clearTimeout(fxTimer);
  const seq = ++fxSeq;
  homeFx.value = kind;
  fxTimer = setTimeout(() => { if (seq !== fxSeq) return; fxTimer = 0; then(); }, ms);
}
function commitHome() {
  batch(() => {
    clearTimeout(fxTimer); fxSeq++;
    homeFx.value = null;
    view.value = 'home';
    phoneScreen.value = 'list';
    externalView.value = null;
    if (!isPhone.peek() && activeId.peek()) selectSession(null);
  });
}
export function goHome() {
  if (view.peek() === 'home' || homeFx.peek() === 'to') return;   // already there (or on the way): a no-op
  if (reducedMotion() || isPhone.peek() || typeof document === 'undefined' || document.hidden) { commitHome(); return; }
  // anything opened meanwhile (a tab, a card, a notification) wins: the layout simply stays
  toSnap = [activeId.peek(), externalView.peek()];
  setFx('to', HOME_TO_MS, commitHome);
}
let toSnap = null;
function cancelTo() { clearTimeout(fxTimer); fxSeq++; homeFx.value = null; }
effect(() => {   // a session opened during the 'to' phase (tab, Ctrl+Tab, notification) cancels it at once
  const a = activeId.value, x = externalView.value;
  if (homeFx.peek() === 'to' && toSnap && (a !== toSnap[0] || x !== toSnap[1])) cancelTo();
});
// Leaving Home (any route: a tab, a card, Ctrl+Tab, Ctrl+1-9, the palette, a notification) plays the way back in.
// Navigating away during the 'to' phase cancels it.
let viewPrev = view.peek();
effect(() => {
  const v = view.value;
  const was = viewPrev;
  viewPrev = v;
  if (was === v) return;
  if (v === 'home') return;
  if (homeFx.peek() === 'to') cancelTo();
  if (was === 'home' && !reducedMotion() && !isPhone.peek()) setFx('from', HOME_FROM_MS, () => { homeFx.value = null; });
});

// Sessions in the order the sidebar shows them (start order inside each group). Ctrl+1..9 uses this.
export const orderedSessions = signal([]);
export function switchToIndex(i) { const s = orderedSessions.value[i]; if (s) openSession(s.id); }

// Projects for grouping: settings.projects first (pinned, then listed order), then any extra
// projects that only exist on sessions, by most recent activity.
// Archived sessions live in their own collapsed group at the end of the sidebar, not in projects.
export const archivedSessions = computed(() => sessions.value.filter((s) => s.archived));
// lane sessions: only active sessions (idle ones move to Past, activity.js), in START order (the user: the
// list kept moving). Projects: pinned first, then by newest session start; never by activity.
export const projectGroups = computed(() => buildProjectGroups(sessionSplit.value.active, settings.value?.projects || []));
effect(() => {
  const out = [];
  for (const g of projectGroups.value) if (!collapsedGroups.value[g.key]) out.push(...g.sessions);
  orderedSessions.value = out;
});

// keep the phone on the list screen when the active session disappears
effect(() => { if (!activeId.value && phoneScreen.value === 'session') phoneScreen.value = 'list'; });

// Host asks a client to show a session (quick-prompt window, notification click). The desktop window is
// already selected host-side; this makes the phone (and any other client) follow.
// A just-created session may land (session.created) a moment after the select event, so retry briefly.
on('app.select', ({ sessionId } = {}) => {
  if (!sessionId) return;
  let tries = 0;
  const go = () => { if (sessions.value.some((s) => s.id === sessionId)) openSession(sessionId); else if (tries++ < 10) setTimeout(go, 200); };
  go();
});
