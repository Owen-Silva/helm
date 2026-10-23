// Pane layout (desktop only): 1 pane, 2 side by side (split view), or 4 corners. Owner: lane shell (C).
// Pure rules: ui/lib/pane-layout.js (tested in test/host/pane-layout.test.js). `layout` = { n, ids, focus };
// `split` = layout when it has more than one pane, else null (what every caller checked before 4 corners).
// The focused pane's session IS activeId, so the inspector, the palette, the keyboard and every "active
// session" consumer follow the focused pane for free. Selecting a session anywhere else (sidebar, palette,
// Ctrl+1..9, a tab) focuses the pane already showing it, else fills an empty corner, else replaces the
// focused pane. Persisted in localStorage 'helm.layout' (next to 'helm.tabs'; the old 'helm.split' is read
// once); the phone ignores it (single pane).
// Lane quad (2026-10-09), the user asked: "can you make it so i can see 4 sessions at once to? so 1 in each coner".
// - Layout switch in the top bar (1 / 2 / 4), Ctrl+Shift+\ toggles 1 <-> 2, Ctrl+Shift+4 toggles 4 corners.
// - 4 corners: the inspector hides when they open (its toggle, Ctrl+\ or a panel button brings it back as a
//   column); leaving 4 corners restores what it was before. Below 1100 px only the focused corner's row shows.
import { signal, computed, effect, batch } from '@preact/signals';
import { activeId, sessions, ready, selectSession, externalView } from '../lib/store.js';
import { inspectorOpen } from '../panels/state.js';
import { view, orderedSessions, isPhone } from './state.js';
import * as PL from '../lib/pane-layout.js';

function loadLayout() {
  try {
    const t = localStorage.getItem(PL.LAYOUT_KEY);
    if (t != null) return PL.parse(t);
    return PL.parse(localStorage.getItem(PL.LEGACY_SPLIT_KEY));   // a split saved before 4 corners
  } catch { return PL.single(); }
}
export const layout = signal(loadLayout());
let lastSaved = '';
effect(() => {
  const text = PL.serialize(layout.value);
  if (text === lastSaved) return;
  lastSaved = text;
  try { localStorage.setItem(PL.LAYOUT_KEY, text); } catch {}
});

// What every caller checked before 4 corners: the multi-pane state, or null for one pane.
export const split = computed(() => (layout.value.n > 1 ? layout.value : null));

// Narrow window: 4 corners show only the focused corner's row (the choice is kept; widen and all 4 return).
export const NARROW_PX = 1100;
const mqNarrow = typeof matchMedia === 'function' ? matchMedia(`(max-width: ${NARROW_PX - 1}px)`) : null;
export const narrow = signal(!!mqNarrow?.matches);
mqNarrow?.addEventListener?.('change', (e) => { narrow.value = e.matches; });

// The sessions on screen in the panes (tabs.js reports them as sessions.viewing).
export const shownPaneIds = computed(() => PL.shownIds(layout.value, narrow.value));
// 4 corners are what the session view shows right now (desktop)
export const quadOn = computed(() => layout.value.n === 4 && view.value === 'session' && !externalView.value && !isPhone.value);

export const dragSession = signal(null);   // session id dragged from the sidebar or a tab (drop zones show while set)
export const dropOver = signal(null);      // pane index under a dragged TAB (tabs.js hit-tests; HTML5 drags style themselves)

// tabs.js hands over its strip order (no import back: tabs.js imports this file)
let tabOrder = () => [];
export function provideTabs(fn) { tabOrder = typeof fn === 'function' ? fn : () => []; }

// the session that was active before the current one (Ctrl+Shift+\ splits with it)
export const prevActive = signal(null);
let lastActive = null;
effect(() => {
  const id = activeId.value;
  if (id === lastActive) return;
  if (lastActive) prevActive.value = lastActive;
  lastActive = id;
});

// activeId changed elsewhere -> the pane showing it takes the focus, or it goes into a pane (PL.follow).
// Not while the phone layout shows (one pane there); the panes catch up when the window is wide again.
effect(() => {
  const id = activeId.value;
  if (isPhone.value || !id) return;
  const st = layout.peek();
  const next = PL.follow(st, id);
  if (next !== st) layout.value = next;
});

// Back in the session view with nothing active (Home clears it; the rail, Ctrl+B or Esc come back without
// picking a session): the focused pane's session is active again, so the keyboard, the tab strip and the
// inspector follow it. An emptied focused corner stays empty (nothing to make active).
effect(() => {
  const st = layout.value;
  if (view.value !== 'session' || activeId.value || st.n === 1 || isPhone.value || externalView.value) return;
  const f = st.ids[st.focus];
  if (!f) return;
  queueMicrotask(() => {
    const cur = layout.peek();
    if (!activeId.peek() && view.peek() === 'session' && !externalView.peek() && cur.ids[cur.focus] === f) selectSession(f);
  });
});

// A pane's session went away: its corner empties; a 2-pane split goes back to one pane.
effect(() => {
  const st = layout.value;
  if (st.n === 1 || !ready.value) return;
  const exists = new Set(sessions.value.map((s) => s.id));
  if (PL.prune(st, exists) === st) return;
  queueMicrotask(() => {
    const cur = layout.peek();
    const next = PL.prune(cur, exists);
    if (next === cur) return;
    layout.value = next;
    if (cur.n === 2) { const alive = cur.ids.find((id) => exists.has(id)); if (alive && activeId.peek() !== alive) selectSession(alive); }
  });
});

// The inspector while 4 corners show: hidden when they open, back to what it was when they close.
const INSP_KEY = 'helm.layout.insp';
let inspBefore = (() => { try { const v = localStorage.getItem(INSP_KEY); return v == null ? null : v === '1'; } catch { return null; } })();
let wasQuad = layout.peek().n === 4;
effect(() => {
  const q = layout.value.n === 4;
  if (q === wasQuad) return;
  wasQuad = q;
  if (q) {
    inspBefore = inspectorOpen.peek();
    try { localStorage.setItem(INSP_KEY, inspBefore ? '1' : '0'); } catch {}
    inspectorOpen.value = false;
  } else {
    if (inspBefore != null) inspectorOpen.value = inspBefore;
    inspBefore = null;
    try { localStorage.removeItem(INSP_KEY); } catch {}
  }
});

const exists = (id) => !!id && sessions.value.some((s) => s.id === id);
const existsSet = () => new Set(sessions.peek().map((s) => s.id));

function toSessionView() { externalView.value = null; view.value = 'session'; }
function showFocused(st) {
  const id = PL.focusedId(st);
  if (id !== undefined && activeId.peek() !== id) selectSession(id);
}

// Open `otherId` beside the active session (side 1 = right, 0 = left) and focus it. In 4 corners: the first
// empty corner, else the corner after the focused one.
export function openSplit(otherId, side = 1) {
  const cur = activeId.value;
  toSessionView();
  if (!exists(otherId)) return false;
  const st = layout.peek();
  if (st.n === 4) {
    const i = PL.paneOf(st, otherId) >= 0 ? PL.paneOf(st, otherId) : PL.besideSlot(st);
    layout.value = PL.assign(st, i, otherId);
    if (activeId.peek() !== otherId) selectSession(otherId);
    return true;
  }
  if (!cur || cur === otherId) { selectSession(otherId); return false; }
  layout.value = { n: 2, ids: side === 1 ? [cur, otherId] : [otherId, cur], focus: side };
  selectSession(otherId);
  return true;
}

// Partner for a fresh split: the previously active session, else the next one in sidebar order.
export function splitPartner() {
  const cur = activeId.value;
  if (exists(prevActive.value) && prevActive.value !== cur) return prevActive.value;
  return orderedSessions.value.find((s) => s.id !== cur)?.id || sessions.value.find((s) => s.id !== cur)?.id || null;
}

// Switch the layout (the top bar switch, Ctrl+Shift+\ / Ctrl+Shift+4, the palette). Returns false when it
// could not (2 panes need a second session).
let beforeQuad = 1;   // Ctrl+Shift+4 goes back to this
export function setLayout(n) {
  const st = layout.peek();
  if (!PL.SIZES.includes(n)) return false;
  if (n === st.n) { toSessionView(); return true; }
  if (n === 1) {
    const keep = PL.focusedId(st) || st.ids.find(Boolean) || activeId.peek();
    batch(() => { toSessionView(); layout.value = PL.single(); if (keep && activeId.peek() !== keep) selectSession(keep); });
    return true;
  }
  if (n === 2) {
    if (st.n === 1) { const other = splitPartner(); return other ? openSplit(other, 1) : false; }
    const next = PL.toPair(st, { active: activeId.peek(), partner: splitPartner(), exists: existsSet() });
    if (next.n !== 2) return false;
    batch(() => { toSessionView(); layout.value = next; showFocused(next); });
    return true;
  }
  beforeQuad = st.n;
  const next = PL.toQuad(st, { active: view.peek() === 'session' ? activeId.peek() : null, tabs: tabOrder(), exists: existsSet() });
  batch(() => { toSessionView(); layout.value = next; showFocused(next); });
  return true;
}

export function toggleSplit() {
  const n = layout.peek().n;
  setLayout(n === 2 ? 1 : 2);
}
export function toggleQuad() {
  const n = layout.peek().n;
  if (n !== 4) { setLayout(4); return; }
  if (beforeQuad === 2 && setLayout(2)) return;
  setLayout(1);
}

export function focusPane(i) {
  const st = layout.peek();
  if (st.n === 1 || !Number.isInteger(i) || i < 0 || i >= st.n) return;
  if (st.focus !== i) layout.value = { ...st, focus: i };
  const id = st.ids[i] || null;
  if (activeId.peek() !== id) selectSession(id);   // an empty corner: nothing active until something goes in
}

// Close pane i: a 2-pane split goes back to one pane; a corner empties (the layout stays, the focus too).
// The tab stays open either way (closing the TAB is tabs.js, which calls this for a tab on screen).
export function closePane(i) {
  const st = layout.peek();
  if (st.n === 1) return;
  if (st.n === 2) {
    const keep = st.ids[1 - i];
    batch(() => { layout.value = PL.single(); if (keep && activeId.peek() !== keep) selectSession(keep); });
    return;
  }
  const gone = st.ids[i];
  const next = PL.closePane(st, i);
  if (next === st) return;
  batch(() => { layout.value = next; if (i === st.focus && gone && activeId.peek() === gone) selectSession(null); });
}

// Drop a session onto pane i (a sidebar row or a tab). Without a split, i = 1 opens it on the right; i = 0
// replaces. With panes: it goes there, swapping with the pane that already shows it.
export function dropOnPane(i, id) {
  if (!exists(id)) return;
  toSessionView();
  const st = layout.peek();
  if (st.n === 1) { if (i === 1) openSplit(id, 1); else selectSession(id); return; }
  const next = PL.assign(st, i, id);
  batch(() => { layout.value = next; if (activeId.peek() !== id) selectSession(id); });
}
