// Session tabs in the top strip: pure state rules (lane tabs, 2026-10-08). No imports, so node tests load it
// directly (test/host/tab-state.test.js). The UI (ui/shell/tabs.js) keeps the list in a signal and calls these.
// The user asked: "put sessions up here as like tabs kinda like claude in terminal so i can just have all the ones
// im using up here instead of on the sidebar".
// State: { ids: [sessionId, ...] in strip order, active: sessionId | null }.
// Rules: a new tab goes at the END (like a terminal's "+"); tabs never re-sort on activity; closing a tab
// only takes it off the strip (the session keeps running); closing the active tab activates its right
// neighbour, else its left one, else nothing (the home view).

export const STORAGE_KEY = 'helm.tabs';
export const MAX_TABS = 100;   // a sanity cap for what we persist, not a UI limit

const isId = (x) => typeof x === 'string' && x.length > 0 && x.length < 200;

// Anything (parsed JSON, garbage, null) -> a valid state. Drops non-string and duplicate ids.
export function normalize(raw) {
  const src = raw && typeof raw === 'object' && Array.isArray(raw.ids) ? raw.ids : [];
  const ids = [];
  for (const x of src) if (isId(x) && !ids.includes(x)) { ids.push(x); if (ids.length >= MAX_TABS) break; }
  const active = raw && isId(raw.active) && ids.includes(raw.active) ? raw.active : null;
  return { ids, active };
}

// localStorage text -> state, or null when there is none / it is unreadable ("never used tabs").
export function parse(text) {
  if (typeof text !== 'string' || !text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' && Array.isArray(v.ids) ? normalize(v) : null; } catch { return null; }
}
export function serialize(state) { const s = normalize(state); return JSON.stringify({ v: 1, ids: s.ids, active: s.active }); }

// Open (or re-activate) a tab. A tab that is already open keeps its place.
export function openTab(state, id) {
  const s = normalize(state);
  if (!isId(id)) return s;
  const ids = s.ids.includes(id) ? s.ids : [...s.ids, id].slice(-MAX_TABS);
  return { ids, active: id };
}

// The tab to show when `id` closes: the one to its right, else the one to its left, else null.
export function neighborOf(ids, id) {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

// Close a tab. Returns the new state; `active` moves to the neighbour only when the closed tab was active.
export function closeTab(state, id) {
  const s = normalize(state);
  if (!s.ids.includes(id)) return s;
  const active = s.active === id ? neighborOf(s.ids, id) : s.active;
  return { ids: s.ids.filter((x) => x !== id), active };
}

// Move tab `id` to index `to` (clamped) in the list without it.
export function moveTab(state, id, to) {
  const s = normalize(state);
  const from = s.ids.indexOf(id);
  if (from < 0) return s;
  const rest = s.ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, Math.round(Number(to)) || 0));
  if (at === from) return s;
  rest.splice(at, 0, id);
  return { ids: rest, active: s.active };
}

// Where a dragged tab lands: the number of OTHER tabs whose centre is left of the pointer.
// mids = each tab's horizontal centre in strip order (the dragged one included at `from`).
export function dropIndex(mids, x, from) {
  let to = 0;
  for (let i = 0; i < mids.length; i++) if (i !== from && mids[i] < x) to++;
  return to;
}

// ---- drag to reorder: geometry (lane tabsmooth, 2026-10-08) ----
// The user reported: "its working now it just isnt smooth i have to pull it like all the way over for it to swicth".
// The UI measures each tab's width once at drag start (strip order, the dragged tab at `from`) plus the gap
// between neighbours; everything below is arithmetic on those numbers, so a pointermove reads no layout.
// Positions are relative to the first tab's left edge.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Left edge of each tab, packed in order with `gap` between neighbours.
export function slotLefts(widths, gap = 0) {
  const out = [];
  let x = 0;
  for (const w of widths) { out.push(x); x += num(w) + num(gap); }
  return out;
}

// Left edge the dragged tab would have at each index 0..n-1, the others packed around it in their order.
export function dragSlots(widths, from, gap = 0) {
  const out = [];
  let x = 0, j = 0;
  for (let t = 0; t < widths.length; t++) {
    out.push(x);
    if (j === from) j++;
    if (j < widths.length) { x += num(widths[j]) + num(gap); j++; }
  }
  return out;
}

// How far the dragged tab may travel: from the strip's first slot to its last (it never leaves the strip).
export function dragBounds(widths, from, gap = 0) {
  if (!widths.length || from < 0 || from >= widths.length) return { min: 0, max: 0 };
  const s = dragSlots(widths, from, gap);
  return { min: 0, max: s[s.length - 1] };
}

// The index the dragged tab belongs at, given its current left edge: the slot nearest to it (Chrome's rule).
// So a neighbour moves aside the moment the dragged tab's leading edge passes that neighbour's midpoint (it
// covers half of it): half a tab of travel for equal tabs (99 px at 196 px), not the whole tab the old
// "pointer reaches the neighbour's centre" rule needed, and it holds for a narrow tab beside a wide one. It is
// a pure function of the position (no history), so jitter at a boundary can't flip-flop. A fast move can
// cross several tabs at once. Exact ties stay put.
export function dragTarget(widths, from, left, gap = 0) {
  const n = widths.length;
  if (!n || from < 0 || from >= n) return from;
  const s = dragSlots(widths, from, gap);
  const x = num(left);
  let best = from, bestD = Math.abs(x - s[from]);
  for (let t = 0; t < n; t++) {
    const d = Math.abs(x - s[t]);
    if (d < bestD - 1e-6) { best = t; bestD = d; }
  }
  return best;
}

// translateX for every tab (original index order) once the dragged tab sits at `to`: the neighbours it passed
// shift by its width + gap, the rest 0; the dragged tab's own entry is the offset of its new slot (the settle).
export function dragOffsets(widths, from, to, gap = 0) {
  const n = widths.length;
  const dx = new Array(n).fill(0);
  if (!n || from < 0 || from >= n) return dx;
  const order = [];
  for (let i = 0; i < n; i++) if (i !== from) order.push(i);
  order.splice(Math.max(0, Math.min(n - 1, Math.round(num(to)))), 0, from);
  const orig = slotLefts(widths, gap);
  let x = 0;
  for (const i of order) { dx[i] = x - orig[i]; x += num(widths[i]) + num(gap); }
  return dx;
}

// Commit a drag. `order` = the tabs the strip DREW, in their new order. The strip skips a tab whose session
// hasn't loaded yet, so `order` can be a subset of state.ids: the dragged tab goes right before the drawn tab
// that now follows it (else right after the one before it) and undrawn tabs keep their places.
export function placeTab(state, id, order) {
  const s = normalize(state);
  const k = Array.isArray(order) ? order.indexOf(id) : -1;
  if (!s.ids.includes(id) || k < 0) return s;
  const rest = s.ids.filter((x) => x !== id);
  const next = order.slice(k + 1).find((x) => rest.includes(x));
  const prev = next == null ? order.slice(0, k).reverse().find((x) => rest.includes(x)) : null;
  const at = next != null ? rest.indexOf(next) : prev != null ? rest.indexOf(prev) + 1 : s.ids.indexOf(id);
  rest.splice(at, 0, id);
  return rest.every((x, i) => x === s.ids[i]) ? s : { ids: rest, active: s.active };
}

// Drop tabs whose session no longer exists. `exists` is a Set of ids or a predicate. The active tab, if it
// went, hands over to its neighbour among the survivors.
export function prune(state, exists) {
  const s = normalize(state);
  const has = typeof exists === 'function' ? exists : (id) => exists.has(id);
  const ids = s.ids.filter((id) => has(id));
  if (ids.length === s.ids.length) return s;
  let active = s.active;
  if (active && !ids.includes(active)) {
    active = null;
    const i = s.ids.indexOf(s.active);
    for (let j = i + 1; j < s.ids.length && !active; j++) if (ids.includes(s.ids[j])) active = s.ids[j];
    for (let j = i - 1; j >= 0 && !active; j--) if (ids.includes(s.ids[j])) active = s.ids[j];
  }
  return { ids, active };
}

// Ctrl+Tab (dir 1) / Ctrl+Shift+Tab (dir -1), wrapping. From no tab (or one that is not open): the first /
// last tab. null when there are no tabs.
export function cycle(ids, current, dir) {
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  if (i < 0) return dir < 0 ? ids[ids.length - 1] : ids[0];
  return ids[(i + (dir < 0 ? -1 : 1) + ids.length) % ids.length];
}

// Ctrl+1..8 = that tab, Ctrl+9 = the last tab (browser and terminal convention). null if there is none.
export function tabForDigit(ids, n) {
  const k = Number(n);
  if (!ids.length || !Number.isInteger(k) || k < 1 || k > 9) return null;
  if (k === 9) return ids[ids.length - 1];
  return ids[k - 1] ?? null;
}

// The session to show when Helm connects (app.hello). `saved` = the persisted state (null when tabs were
// never used: let the default pick happen, it becomes the first tab). `current` = the session already on
// screen (a reconnect keeps it if it is still a tab). Returns an id, null (show the home view: every tab
// was closed) or undefined (no opinion).
export function helloChoice(saved, current, exists) {
  if (!saved) return undefined;
  const s = prune(saved, exists);
  if (current && s.ids.includes(current)) return current;
  if (s.active && s.ids.includes(s.active)) return s.active;
  return s.ids[0] ?? null;
}

// lane home (2026-10-08): Helm opens on Home (the user chose "Yes, start on Home"), and a reconnect while Home shows stays
// there. `onHome` -> null (select nothing). The tab list itself is never touched here: it is restored in the bar
// with no tab active (dead tabs still drop out through prune). Otherwise the usual helloChoice.
export function startChoice({ onHome = false, saved = null, current = null, exists = new Set() } = {}) {
  if (onHome) return null;
  return helloChoice(saved, current, exists);
}

// ---- lane tabrelease: closing a tab closes the session's idle claude.exe (sessions.release) ----
// The sessions this window has on screen right now: both split panes (desktop session view), else the open
// session. Nothing while another view (Home, Settings, an external session) fills the main area, or while a
// web / phone page is hidden. Reported to Helm as sessions.viewing.
export function onScreen({ view, active, splitIds, external = false, phone = false, hidden = false } = {}) {
  if (hidden || view !== 'session' || external) return [];
  if (!phone && Array.isArray(splitIds) && splitIds.length) return [...new Set(splitIds.filter(isId))];
  return isId(active) ? [active] : [];
}

// After tab `id` closed: release its CLI only when this window no longer shows it (a split pane still can).
export function releaseOnClose(screenIds, id) {
  return isId(id) && !(Array.isArray(screenIds) && screenIds.includes(id));
}
