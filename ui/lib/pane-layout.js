// Pane layout (desktop): 1 pane, 2 side by side, or 4 corners. Pure state rules (lane quad, 2026-10-09).
// No imports, so node tests load it directly (test/host/pane-layout.test.js). ui/shell/split.js keeps the
// state in a signal and calls these.
// The user asked: "can you make it so i can see 4 sessions at once to? so 1 in each coner".
//
// State: { n: 1 | 2 | 4, ids: [sessionId | null] x n (n = 1: []), focus: index of the focused pane }.
// - The focused pane's session IS the active session (store.js activeId); with n = 1 the active session is
//   simply the one pane, so ids stays empty.
// - 2 = both panes always filled (closing one goes back to 1 pane: the split view as it always worked).
// - 4 = corners in reading order (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right). A corner can be
//   empty (null); closing a corner's tab empties that corner and the layout stays.
// - A session is in at most one pane. Putting it in another pane swaps the two panes' contents.
// - Below ~1100 px the 4 corners show only the focused corner's row (visibleSlots); the state is untouched,
//   so widening the window brings all 4 back.

export const LAYOUT_KEY = 'helm.layout';
export const LEGACY_SPLIT_KEY = 'helm.split';   // before 4 corners: { ids: [left, right], focus } | null
export const SIZES = [1, 2, 4];

const isId = (x) => typeof x === 'string' && x.length > 0 && x.length < 200;
const hasFn = (exists) => (typeof exists === 'function' ? exists : exists instanceof Set ? (id) => exists.has(id) : () => true);

export function single() { return { n: 1, ids: [], focus: 0 }; }

// Anything (parsed JSON, the pre-4-corners split shape, garbage) -> a valid state.
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return single();
  const legacy = raw.n == null && Array.isArray(raw.ids) && raw.ids.length === 2;
  const n = SIZES.includes(raw.n) ? raw.n : legacy ? 2 : 1;
  if (n === 1) return single();
  const src = Array.isArray(raw.ids) ? raw.ids : [];
  const ids = [];
  for (let i = 0; i < n; i++) { const x = src[i]; ids.push(isId(x) && !ids.includes(x) ? x : null); }
  if (n === 2 && (!ids[0] || !ids[1])) return single();   // a 2-pane split is two sessions or nothing
  const focus = Number.isInteger(raw.focus) && raw.focus >= 0 && raw.focus < n ? raw.focus : 0;
  return { n, ids, focus };
}

// localStorage text -> state (single when missing or unreadable).
export function parse(text) {
  if (typeof text !== 'string' || !text) return single();
  try { return normalize(JSON.parse(text)); } catch { return single(); }
}
export function serialize(state) { const s = normalize(state); return JSON.stringify({ v: 1, n: s.n, ids: s.ids, focus: s.focus }); }

// The focused pane's session: what activeId should be. undefined for 1 pane (no opinion), null = an empty corner.
export function focusedId(state) { return state.n > 1 ? state.ids[state.focus] || null : undefined; }

// The panes drawn right now: all of them, except 4 corners in a narrow window -> the focused corner's row.
export function visibleSlots(state, narrow = false) {
  if (!state || state.n === 1) return [];
  if (state.n === 4 && narrow) { const r = state.focus < 2 ? 0 : 2; return [r, r + 1]; }
  return state.ids.map((_, i) => i);
}
// The sessions on screen in those panes (sessions.viewing), in pane order.
export function shownIds(state, narrow = false) {
  return visibleSlots(state, narrow).map((i) => state.ids[i]).filter(isId);
}

// Switch to 4 corners. What is on screen keeps its place: a split's left / right stay the top row, a single
// pane's session goes top-left and keeps the focus. The other corners fill with the open tabs in strip order;
// any left over stay empty ("Drag a tab here").
export function toQuad(state, { active = null, tabs = [], exists } = {}) {
  const s = normalize(state);
  if (s.n === 4) return s;
  const has = hasFn(exists);
  const ok = (id) => isId(id) && has(id);
  const ids = [null, null, null, null];
  const seed = s.n === 2 ? s.ids : [active];
  seed.forEach((id, i) => { if (ok(id) && !ids.includes(id)) ids[i] = id; });
  for (const id of tabs || []) {
    if (!ok(id) || ids.includes(id)) continue;
    const j = ids.indexOf(null);
    if (j < 0) break;
    ids[j] = id;
  }
  const want = s.n === 2 ? s.ids[s.focus] : active;
  const focus = want && ids.includes(want) ? ids.indexOf(want) : 0;
  return { n: 4, ids, focus };
}

// Switch to 2 side by side. From 4: the focused corner plus the next filled corner, in corner order (else
// `partner`). From 1: `active` on the left, `partner` on the right, focused (the Ctrl+Shift+\ split). Returns
// single when there are not two sessions to show.
export function toPair(state, { active = null, partner = null, exists } = {}) {
  const s = normalize(state);
  if (s.n === 2) return s;
  const has = hasFn(exists);
  const ok = (id) => isId(id) && has(id);
  if (s.n === 1) return ok(active) && ok(partner) && active !== partner ? { n: 2, ids: [active, partner], focus: 1 } : single();
  const filled = s.ids.map((id, i) => ({ id, i })).filter((x) => ok(x.id));
  const f = ok(s.ids[s.focus]) ? s.focus : filled.length ? filled[0].i : -1;
  if (f < 0) return ok(active) && ok(partner) && active !== partner ? { n: 2, ids: [active, partner], focus: 0 } : single();
  const keep = s.ids[f];
  const other = filled.find((x) => x.i > f) || filled.find((x) => x.i !== f);
  if (other) return other.i > f ? { n: 2, ids: [keep, other.id], focus: 0 } : { n: 2, ids: [other.id, keep], focus: 1 };
  return ok(partner) && partner !== keep ? { n: 2, ids: [keep, partner], focus: 0 } : single();
}

// Put session `id` in pane `i` and focus it. Already in another pane: the two swap (in 4 corners an empty
// corner swaps too, so the session moves and leaves its old corner empty).
export function assign(state, i, id) {
  const s = normalize(state);
  if (s.n === 1 || !isId(id) || !Number.isInteger(i) || i < 0 || i >= s.n) return s;
  const ids = [...s.ids];
  const j = ids.indexOf(id);
  if (j === i) return s.focus === i ? s : { ...s, focus: i };
  if (j >= 0) ids[j] = ids[i];
  ids[i] = id;
  if (s.n === 2 && (!ids[0] || !ids[1])) return single();
  return { n: s.n, ids, focus: i };
}

// Close pane i: a 2-pane split goes back to one pane (the caller shows the other session); a corner empties
// and the 4 corners stay (the focus stays on it).
export function closePane(state, i) {
  const s = normalize(state);
  if (s.n === 1 || !Number.isInteger(i) || i < 0 || i >= s.n) return s;
  if (s.n === 2) return single();
  if (!s.ids[i]) return s;
  const ids = [...s.ids]; ids[i] = null;
  return { ...s, ids };
}

// The pane showing `id`, or -1.
export function paneOf(state, id) { return isId(id) && state && state.n > 1 ? state.ids.indexOf(id) : -1; }

// Close whichever pane shows `id` (its tab closed). Not shown: unchanged.
export function removeId(state, id) {
  const i = paneOf(state, id);
  return i < 0 ? normalize(state) : closePane(state, i);
}

// Sessions that no longer exist drop out: their corner empties; a 2-pane split with one gone goes back to one
// pane. Returns the same object when nothing changed.
export function prune(state, exists) {
  if (!state || state.n === 1) return state;
  const has = hasFn(exists);
  if (state.ids.every((id) => !id || has(id))) return state;
  if (state.n === 2) return single();
  return { ...state, ids: state.ids.map((id) => (id && has(id) ? id : null)) };
}

// The active session changed somewhere else (sidebar, palette, a tab, Ctrl+1..9, a notification): the pane
// that already shows it takes the focus. Not shown: it goes into the focused pane when that is an empty
// corner, else into the first empty corner (nothing on screen is pushed out while there is room), else it
// replaces the focused pane (the split view rule).
export function follow(state, id) {
  if (!state || state.n === 1 || !isId(id)) return state;
  if (state.ids[state.focus] === id) return state;
  const j = state.ids.indexOf(id);
  if (j >= 0) return { ...state, focus: j };
  let i = state.focus;
  if (state.ids[i]) { const e = state.ids.indexOf(null); if (e >= 0) i = e; }
  const ids = [...state.ids]; ids[i] = id;
  return { ...state, ids, focus: i };
}

// "Open beside" in 4 corners: the first empty corner, else the corner after the focused one (wrapping).
export function besideSlot(state) {
  if (!state || state.n !== 4) return -1;
  const e = state.ids.indexOf(null);
  return e >= 0 ? e : (state.focus + 1) % 4;
}

// What an empty corner offers to click into it: open tabs not on screen (strip order), then other recent
// sessions (`recent`, newest first), up to `limit`.
export function cornerChoices({ shown = [], tabs = [], recent = [], limit = 5 } = {}) {
  const out = [];
  const skip = new Set(shown.filter(isId));
  for (const id of [...tabs, ...recent]) {
    if (out.length >= limit) break;
    if (!isId(id) || skip.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
