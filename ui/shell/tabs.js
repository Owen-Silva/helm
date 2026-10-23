// Session tabs in the top strip (lane tabs, 2026-10-08). Desktop only: the phone keeps its own list screen.
// The user asked: "put sessions up here as like tabs kinda like claude in terminal so i can just have all the ones
// im using up here instead of on the sidebar".
// - Opening a session from ANYWHERE (sidebar, Past, palette, toast, notification, helm:// link, Deck, split)
//   makes it a tab: one effect watches activeId, so no call site has to know about tabs. New tabs go at the end.
// - Closing a tab takes it off the strip. It never stops, archives or deletes the session; it does close the
//   session's claude.exe if nothing is running in it (sessions.release, lane tabrelease; busy = once idle).
//   × (hover + active tab), middle-click, Ctrl+W. The active tab hands over to its right, else left, neighbour;
//   no tabs = the home view. In split view, closing a pane's tab closes that pane; in 4 corners it empties that
//   corner (the layout stays). Drag a tab down onto a pane to show it there (lane quad).
// - Drag to reorder (5 px threshold, so clicks stay clicks). Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+1..8 pick,
//   Ctrl+9 = last (the digits are routed here from shell/index.js useShortcuts on desktop).
// - Persisted in localStorage 'helm.tabs' ({ ids, active }); sessions that no longer exist drop out. Startup
//   lands on Home with every tab restored and none active (lane home, store.js helloPick); a reconnect keeps the tab on screen.
// - Status dots reuse displayStatus and the shared pulse clock (.dot.live, sidebar.js): no timers here.
// Pure rules: ui/lib/tab-state.js (tested in test/host/tab-state.test.js). Styles: ui/shell/tabs.css.
import { signal, effect, batch } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { sessions, activeId, ready, selectSession, externalView, helloPick, appInfo, rpc, isMock } from '../lib/store.js';
import { displayStatus, isAgentsOnly, agentsLabel, agentsRunningOf } from '../lib/session-status.js';
import { STORAGE_KEY, parse, serialize, openTab, neighborOf, prune, cycle, tabForDigit, startChoice,
  slotLefts, dragBounds, dragTarget, dragOffsets, placeTab, onScreen, releaseOnClose } from '../lib/tab-state.js';
import { view, isPhone, openSession, newSessionOpen, goHome } from './state.js';
import { split, closePane, shownPaneIds, provideTabs, dragSession, dropOver, dropOnPane } from './split.js';
import { cx, mod } from './util.js';

function load() { try { return parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; } }
const saved0 = load();                       // null = tabs never used here: the default startup pick becomes tab 1
export const tabIds = signal(saved0 ? saved0.ids : []);
provideTabs(() => tabIds.peek());   // lane quad: picking 4 corners fills them with the tabs in strip order
let savedActive = saved0 ? saved0.active : null;
let everUsed = !!saved0;
let lastWritten = '';

const live = () => ready.value && !isPhone.value;

// Startup / reconnect: Home (lane home: Helm starts there, desktop and phone; the tabs stay in the bar, none
// active), else the saved active tab, or nothing when every tab was closed.
helloPick.fn = (list, current) => {
  const onHome = view.peek() === 'home';
  if (isPhone.peek() && !onHome) return undefined;
  const exists = new Set((list || []).map((s) => s.id));
  return startChoice({ onHome, saved: everUsed ? { ids: tabIds.peek(), active: savedActive } : null, current, exists });
};

function addTabs(want) {
  const ids = tabIds.peek();
  let next = ids;
  for (const id of want) if (id && !next.includes(id)) next = openTab({ ids: next }, id).ids;
  if (next !== ids) tabIds.value = next;
}

// Any selection opens a tab (re-checked when the session lands: app.select can run first).
effect(() => {
  const id = activeId.value;
  if (!live() || !id) return;
  if (!sessions.value.some((s) => s.id === id)) return;
  addTabs([id]);
});
// Every pane's session is a tab (split panes, 4 corners; a split restored from before tabs existed included).
effect(() => {
  const sp = split.value;
  if (!live() || !sp || view.value !== 'session') return;
  const list = sessions.value;
  addTabs(sp.ids.filter((id) => list.some((s) => s.id === id)));
});

// Sessions that went away (deleted, removed) drop out. If it was the one on screen, its neighbour takes over
// (store.js nulls activeId right after removing the session, hence the microtask).
effect(() => {
  if (!ready.value) return;
  const list = sessions.value;
  const ids = tabIds.peek();
  if (!ids.length) return;
  const exists = new Set(list.map((s) => s.id));
  const cur = activeId.peek();
  const next = prune({ ids, active: cur && ids.includes(cur) ? cur : null }, exists);
  if (next.ids.length === ids.length) return;
  tabIds.value = next.ids;
  if (cur && !exists.has(cur) && next.active) {
    queueMicrotask(() => { const a = activeId.peek(); if ((!a || a === cur) && !isPhone.peek()) selectSession(next.active); });
  }
});

// Persist { ids, active }. Nothing is written until tabs have been used, so a first start keeps the default pick.
effect(() => {
  const ids = tabIds.value, a = activeId.value;
  if (!ready.value) return;
  if (a && ids.includes(a)) savedActive = a;
  if (savedActive && !ids.includes(savedActive)) savedActive = null;
  if (!everUsed && !ids.length) return;
  everUsed = true;
  const text = serialize({ ids, active: savedActive });
  if (text === lastWritten) return;
  lastWritten = text;
  try { localStorage.setItem(STORAGE_KEY, text); } catch {}
});

// lane tabrelease: tell Helm which sessions this window shows (sessions.viewing), desktop and phone alike, so
// closing a tab elsewhere never closes the CLI of a session still on a screen, and viewing a session cancels a
// pending release. A web / phone page that is hidden shows nothing. Sent only when the set changes (and again
// after a reconnect).
const pageHidden = signal(typeof document !== 'undefined' && document.visibilityState === 'hidden');
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { pageHidden.value = document.visibilityState === 'hidden'; });
const screenNow = () => onScreen({
  // lane quad: every pane on screen counts (4 corners: all of them; a narrow window draws one row of them)
  view: view.value, active: activeId.value, splitIds: split.value ? shownPaneIds.value : null, external: !!externalView.value,
  // A minimized or tray-hidden desktop window shows nothing too, so "Since you left" (recap) counts time the user
  // was away from it. (--test windows run with backgroundThrottling off and always read visible.)
  phone: isPhone.value, hidden: pageHidden.value,
});
let lastViewing = null;
effect(() => {
  if (!ready.value || isMock) { lastViewing = null; return; }
  const ids = screenNow();
  const key = ids.join(',');
  if (key === lastViewing) return;
  lastViewing = key;
  rpc('sessions.viewing', { ids }).catch(() => {});
});

// ---- actions ----
export function activateTab(id) { if (id) openSession(id); }

// lane handoff: put `id`'s tab right after `afterId`'s (the end when that has no tab). "Fresh start with handoff"
// calls it once the new session is selected (which first opened it at the end).
export function openTabAfter(id, afterId) {
  if (!id || id === afterId) return;
  const ids = tabIds.peek().filter((x) => x !== id);
  const i = ids.indexOf(afterId);
  tabIds.value = i < 0 ? [...ids, id] : [...ids.slice(0, i + 1), id, ...ids.slice(i + 1)];
}

export function closeTabById(id) {
  const ids = tabIds.peek();
  if (!ids.includes(id)) return;
  const sp = split.peek();
  batch(() => {
    tabIds.value = ids.filter((x) => x !== id);
    if (sp && sp.ids.includes(id)) { closePane(sp.ids.indexOf(id)); return; }   // the other pane stays on screen
    if (activeId.peek() === id) {
      const next = neighborOf(ids, id);
      if (next) selectSession(next);
      else if (view.peek() === 'session' && !externalView.peek()) goHome();   // lane home: the last tab closed -> Home
      else selectSession(null);
    }
  });
  // lane tabrelease: no longer on this screen -> Helm closes its claude.exe if idle (else once idle). Never
  // interrupts anything; a session another client still shows is left alone (main/engine/index.js).
  if (!isMock && releaseOnClose(screenNow(), id)) rpc('sessions.release', { id }).catch(() => {});
}

// Ctrl+1..9 on desktop (shell/index.js). Returns true when a tab was picked.
export function switchToTab(n) { const id = tabForDigit(tabIds.peek(), n); if (id) activateTab(id); return !!id; }
export function cycleTab(dir) { const id = cycle(tabIds.peek(), activeId.peek(), dir); if (id) activateTab(id); return !!id; }

// ---- view ----
function setFade(el) {
  const v = (el.scrollLeft > 1 ? 'l' : '') + (el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 'r' : '');
  if ((el.dataset.fade || '') !== v) { if (v) el.dataset.fade = v; else delete el.dataset.fade; }
}
const STATUS_TEXT = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle', error: 'Stopped with an error', closed: 'Stopped' };

// ---- drag to reorder (lane tabsmooth, 2026-10-08) ----
// The user reported: "its working now it just isnt smooth i have to pull it like all the way over for it to swicth".
// Was: the pressed tab never moved; every frame re-read every tab's rect and re-sorted the list only once the
// POINTER reached the next tab's centre (a whole tab of travel), then the tabs jumped to their new places.
// Now, Chrome's model:
// - past 5 px the tab lifts and follows the pointer 1:1 (a transform; no re-render per move, rAF-throttled);
// - a neighbour slides aside (150 ms transform) once the dragged tab covers half of it (tab-state.js
//   dragTarget: nearest slot, mixed widths included; a fast move passes several at once);
// - release: the tab slides into its slot, THEN the order commits once (tabIds -> localStorage 'helm.tabs');
// - Esc, window blur, pointercancel, or the tab vanishing mid-drag: everything slides back, nothing is saved;
// - near a visible edge of an overflowing strip, the strip scrolls; reduced motion: no slides, same live swaps.
// Layout is read once at drag start (again only if the tab list itself changes mid-drag); per frame it is
// arithmetic + transform writes. The classes come from dragTabId, so a session update re-rendering a tab
// mid-drag keeps them, and preact never sets `style`, so the transforms survive it too. A drag is never a click.
const dragTabId = signal(null);   // the tab being dragged or settling: .reordering on the strip, .lifted on it
let drag = null;                  // the live press / drag / settle: { stop(now) }
const SLIDE_MS = 150, EDGE = 40, EDGE_SPEED = 16, THRESHOLD = 5;
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const tx = (el, px) => { el.style.transform = Math.abs(px) >= 0.05 ? `translateX(${Math.round(px * 10) / 10}px)` : ''; };
function swallowClick() {   // the click that follows a drag's pointerup (same task) must not activate the tab
  const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  addEventListener('click', stop, true);
  setTimeout(() => removeEventListener('click', stop, true), 0);
}
// A drag cancelled while the button is still held (Esc, blur): its eventual release is not a click either. A
// new press first means that release happened elsewhere, so the guard goes away without eating anything.
function swallowClickAfterRelease(pid) {
  const off = () => { removeEventListener('pointerup', up, true); removeEventListener('pointerdown', off, true); };
  const up = (ev) => { if (ev.pointerId === pid) { off(); swallowClick(); } };
  addEventListener('pointerup', up, true);
  addEventListener('pointerdown', off, true);
}

// lane quad: a tab dragged DOWN out of the strip (session view) goes to a pane instead of reordering: drop
// zones show over the panes (split.js dragSession), the one under the pointer lights up (dropOver, one
// elementFromPoint per frame), and the release puts the session there (dropOnPane: swaps with the pane that
// already shows it). Back up into the strip = reordering again. Anywhere else = nothing changes.
const DOWN = 14;   // px below the tab row before a drag means "to a pane"
function press(e, id, strip) {
  const pid = e.pointerId, x0 = e.clientX, y0 = e.clientY;
  const downAt = view.peek() === 'session' && !externalView.peek() ? strip.getBoundingClientRect().bottom + DOWN : Infinity;
  let x = x0, y = y0, on = false, raf = 0, attached = true, landed = false, toPane = false;
  let g = null, ids0 = null, to = -1, grab = 0, cur = 0;
  let viewL = 0, viewW = 0, scroll = 0, scrollMax = 0, ownScroll = 0;

  const fade = () => {   // the edge fades, from cached numbers (setFade would read layout)
    const v = (scroll > 1 ? 'l' : '') + (scroll < scrollMax - 1 ? 'r' : '');
    if ((strip.dataset.fade || '') !== v) { if (v) strip.dataset.fade = v; else delete strip.dataset.fade; }
  };

  // The only layout reads of a drag. again = mid-drag (the tab list changed): transitions stay off until the
  // next frame, so the neighbours snap to their new places instead of sliding back from zero.
  function measure(again) {
    const els = [...strip.children].filter((el) => el.classList.contains('tab'));
    const from = els.findIndex((el) => el.dataset.sid === id);
    if (from < 0) return false;
    for (const el of els) { el.style.transition = 'none'; el.style.transform = ''; }
    const sr = strip.getBoundingClientRect();
    viewL = sr.left + strip.clientLeft; viewW = strip.clientWidth;
    scroll = strip.scrollLeft; scrollMax = Math.max(0, strip.scrollWidth - viewW);
    const rects = els.map((el) => el.getBoundingClientRect());
    const rearm = () => { for (const el of els) el.style.transition = ''; };   // styled without one above: nothing animates back
    if (again) requestAnimationFrame(rearm); else rearm();
    const n = els.length, widths = rects.map((r) => r.width);
    const gap = n > 1 ? Math.max(0, (rects[n - 1].right - rects[0].left - widths.reduce((a, b) => a + b, 0)) / (n - 1)) : 0;
    g = { els, count: strip.childElementCount, ids: els.map((el) => el.dataset.sid), widths, gap, from, lefts: slotLefts(widths, gap),
      base: rects[0].left - viewL + scroll, bounds: dragBounds(widths, from, gap), dx: new Array(n).fill(0) };
    to = from; cur = 0;
    return true;
  }

  function frame() {
    raf = 0;
    if (!on || landed) return;
    // a tab opened / closed, or a session loaded and its tab appeared, mid-drag (rare): measure again.
    // childElementCount and isConnected are not layout reads.
    if (tabIds.peek() !== ids0 || strip.childElementCount !== g.count || !g.els[g.from].isConnected) {
      ids0 = tabIds.peek();
      if (!ids0.includes(id) || !measure(true)) { stop(true); return; }
    }
    if ((y >= downAt) !== toPane) setToPane(!toPane);
    if (toPane) { overPane(); return; }
    let v = 0;
    if (scrollMax > 0) {   // pointer near (or past) a visible edge of an overflowing strip: scroll it
      const rel = x - viewL;
      const k = rel < EDGE ? -Math.min(1, (EDGE - rel) / EDGE) : rel > viewW - EDGE ? Math.min(1, (rel - viewW + EDGE) / EDGE) : 0;
      if (k) {
        const next = Math.max(0, Math.min(scrollMax, scroll + Math.sign(k) * Math.max(1, Math.round(EDGE_SPEED * Math.abs(k)))));
        if (next !== scroll) { v = next - scroll; scroll = next; ownScroll++; strip.scrollLeft = next; fade(); }
      }
    }
    const { widths, gap, from, bounds, els, lefts } = g;
    const left = Math.max(bounds.min, Math.min(bounds.max, x - viewL + scroll - g.base - grab));
    cur = left - lefts[from];
    tx(els[from], cur);
    const t = dragTarget(widths, from, left, gap);
    if (t !== to) {
      to = t;
      const dx = dragOffsets(widths, from, t, gap);
      for (let i = 0; i < els.length; i++) if (i !== from && dx[i] !== g.dx[i]) { g.dx[i] = dx[i]; tx(els[i], dx[i]); }
    }
    if (v) raf = requestAnimationFrame(frame);   // keep scrolling while the pointer rests at the edge
  }

  // lane quad: in / out of "to a pane". Going in, the tab and its neighbours go home (no reorder).
  function setToPane(v) {
    toPane = v;
    if (v) {
      for (let i = 0; i < g.els.length; i++) if (i !== g.from && g.dx[i]) { g.dx[i] = 0; tx(g.els[i], 0); }
      to = g.from; cur = 0; tx(g.els[g.from], 0);
      dragSession.value = id;
    } else batch(() => { dragSession.value = null; dropOver.value = null; });
  }
  function overPane() {
    const z = document.elementFromPoint(x, y)?.closest?.('.split-drop-zone[data-pane]');
    const i = z ? Number(z.dataset.pane) : null;
    if (dropOver.peek() !== i) dropOver.value = i;
  }
  function endToPane() {
    if (!toPane) return;
    toPane = false;
    batch(() => { dragSession.value = null; dropOver.value = null; });
  }

  function begin() {
    ids0 = tabIds.peek();
    if (!measure()) return false;
    on = true;
    grab = (x0 - viewL + scroll) - (g.base + g.lefts[g.from]);
    try { g.els[g.from].setPointerCapture(pid); } catch {}   // hover stays on the lifted tab while others slide under
    addEventListener('keydown', onKey, true);
    strip.addEventListener('scroll', onScroll, { passive: true });
    dragTabId.value = id;
    return true;
  }

  function detach() {
    if (!attached) return;
    attached = false;
    removeEventListener('pointermove', onMove, true); removeEventListener('pointerup', onUp, true);
    removeEventListener('pointercancel', onCancel, true); removeEventListener('blur', onBlur);
    removeEventListener('keydown', onKey, true); strip.removeEventListener('scroll', onScroll);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    try { const el = g && g.els[g.from]; if (el && el.hasPointerCapture(pid)) el.releasePointerCapture(pid); } catch {}
  }

  // The order commits here, after the slide, in the same task that clears every transform: the DOM moves in
  // preact's microtask render before the next paint, so nothing jumps.
  function land(commit) {
    if (landed) return;
    landed = true;
    detach();
    endToPane();
    if (drag === api) drag = null;
    if (!g) return;
    const { els } = g;
    let order = null;
    if (commit && to !== g.from) { order = g.ids.filter((x) => x !== id); order.splice(to, 0, id); }
    for (const el of els) { el.style.transition = 'none'; el.style.transform = ''; }
    batch(() => {
      if (order) {
        const ids = tabIds.peek(), next = placeTab({ ids }, id, order).ids;
        if (next.length !== ids.length || next.some((x, i) => x !== ids[i])) tabIds.value = next;
      }
      dragTabId.value = null;
    });
    // re-arm the CSS transitions once a frame has been styled without them
    requestAnimationFrame(() => requestAnimationFrame(() => { for (const el of els) el.style.transition = ''; if (strip.isConnected) setFade(strip); }));
  }

  // Slide the dragged tab to `px` (its new slot, or home), then land. Neighbours slide via the CSS transition.
  function settle(px, commit) {
    const el = g.els[g.from];
    if (reducedMotion() || Math.abs(px - cur) < 0.5 || !el.isConnected) { land(commit); return; }
    el.style.transition = `transform ${SLIDE_MS}ms var(--ease)`;
    cur = px; tx(el, px);
    const timer = setTimeout(() => land(commit), SLIDE_MS + 80);
    el.addEventListener('transitionend', function te(ev) {
      if (ev.target !== el || ev.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', te); clearTimeout(timer); land(commit);
    });
  }

  // now = true: no slide (unmount, the dragged tab vanished, another press while this one settles).
  function stop(now, commit = false) {
    if (landed) return;
    if (!on) { detach(); landed = true; if (drag === api) drag = null; return; }
    if (attached) {   // a live drag: cancel it
      detach();
      endToPane();
      for (let i = 0; i < g.els.length; i++) if (i !== g.from && g.dx[i]) { g.dx[i] = 0; tx(g.els[i], 0); }
      to = g.from;
    }
    if (now) land(commit); else settle(0, false);
  }

  function drop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    frame();   // the release point may not have had its frame yet
    if (landed) return;   // the tab vanished in that frame (stop(true) already cleaned up)
    if (toPane) {   // lane quad: onto a pane (dropOnPane), or nowhere: nothing changes
      const i = dropOver.peek();
      swallowClick();
      land(false);
      if (i != null) dropOnPane(i, id);
      return;
    }
    detach();
    swallowClick();
    settle(dragOffsets(g.widths, g.from, to, g.gap)[g.from], true);
  }

  function onMove(ev) {
    if (ev.pointerId !== pid) return;
    x = ev.clientX; y = ev.clientY;
    if (!on) {
      if (Math.abs(x - x0) < THRESHOLD && y < downAt) return;   // under 5 px (and still on the strip) a press is still a click
      if (!begin()) { stop(true); return; }
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function onUp(ev) { if (ev.pointerId !== pid) return; if (on) drop(); else stop(true); }
  function onCancel(ev) { if (ev.pointerId === pid) stop(false); }
  function onBlur() { const was = on && attached; stop(false); if (was) swallowClickAfterRelease(pid); }
  function onKey(ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    stop(false); swallowClickAfterRelease(pid);
  }
  function onScroll() {   // our own auto-scroll is already in `scroll`; anything else (wheel, keep-in-view) is read
    if (ownScroll > 0) { ownScroll--; return; }
    scroll = strip.scrollLeft; fade();
    if (!raf) raf = requestAnimationFrame(frame);
  }

  addEventListener('pointermove', onMove, true); addEventListener('pointerup', onUp, true);
  addEventListener('pointercancel', onCancel, true); addEventListener('blur', onBlur);
  // a drop still settling lands with this press's commit (stop(now) on a settle = land with the drop's result)
  const api = { stop: (now) => { if (!attached && on && !landed) land(true); else stop(now); } };
  return api;
}

function Tab({ s, on, beside, lifted, onDown }) {
  const ds = displayStatus(s);
  const agents = agentsRunningOf(s);
  const fork = / \(fork\)$/.test(s.title || '');
  const title = (fork ? s.title.replace(/( \(fork\))+$/, '') : s.title) || 'New session';
  const state = isAgentsOnly(s) ? agentsLabel(s) : (STATUS_TEXT[ds] || ds) + (agents ? ` · ${agentsLabel(agents)}` : '');
  const close = (e) => { e.stopPropagation(); e.preventDefault(); closeTabById(s.id); };
  return html`<div class=${cx('tab', `st-${ds}`, on && 'on', beside && 'beside', !on && s.unread > 0 && 'unread', lifted && 'lifted')}
      role="tab" tabindex=${on ? 0 : -1} aria-selected=${on ? 'true' : 'false'} data-sid=${s.id}
      title=${`${s.title || 'New session'}\n${s.cwd || ''}\n${state}`}
      onPointerDown=${(e) => onDown(e, s.id)}
      onClick=${() => activateTab(s.id)}
      onMouseDown=${(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick=${(e) => { if (e.button === 1) close(e); }}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(s.id); } else if (e.key === 'Delete') close(e); }}>
    <span class=${cx('dot', ds, ds === 'working' && 'live')} aria-label=${state}></span>
    ${fork && html`<${Icon} name="git-branch" size=${11} class="tab-fork" />`}
    <span class="tab-title">${title}</span>
    ${agents > 0 && html`<span class="tab-agents tnum" aria-label=${agentsLabel(agents)}><${Icon} name="bot" size=${11} />${agents}</span>`}
    <button class="tab-x" tabindex="-1" aria-label=${`Close tab: ${title}`} onPointerDown=${(e) => e.stopPropagation()} onClick=${close}><${Icon} name="x" size=${12} /></button>
  </div>`;
}

export function TabStrip() {
  const ids = tabIds.value;
  const byId = new Map(sessions.value.map((s) => [s.id, s]));
  const act = activeId.value;
  const onSession = view.value === 'session' && !externalView.value;
  const sp = onSession ? split.value : null;
  const scroller = useRef(null);
  const dragging = dragTabId.value;

  // keep the active tab in view (scroll the strip only, never the page)
  useEffect(() => {
    const el = scroller.current;
    const t = el && act ? el.querySelector(`.tab[data-sid="${CSS.escape(act)}"]`) : null;
    if (t) {
      const l = t.offsetLeft, r = l + t.offsetWidth;
      if (l < el.scrollLeft) el.scrollLeft = l - 8;
      else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth + 8;
    }
    if (el) setFade(el);
  }, [act, ids.length]);
  // fade an edge that has more tabs beyond it: on scroll and on resize only (event-driven, no timers)
  useEffect(() => {
    const el = scroller.current; if (!el) return undefined;
    const f = () => { if (!dragTabId.peek()) setFade(el); };   // a drag keeps the fade itself, from cached numbers
    el.addEventListener('scroll', f, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(f) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', f); ro?.disconnect(); };
  }, []);

  // Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+W (the digits come from shell/index.js)
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || isPhone.peek()) return;
      let hit = false;
      if (e.key === 'Tab') hit = cycleTab(e.shiftKey ? -1 : 1);
      else if (e.key.toLowerCase() === 'w' && !e.shiftKey && view.peek() === 'session' && !externalView.peek()) {
        const id = activeId.peek();   // only the tab shown as active (not one hidden behind History or Elsewhere)
        if (id && tabIds.peek().includes(id)) { closeTabById(id); hit = true; }
      }
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);

  // vertical wheel scrolls the strip sideways (only when it overflows)
  const onWheel = (e) => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    el.scrollLeft += d;
    e.preventDefault();
  };

  // drag to reorder (press() above). A drop still settling lands before a new press starts.
  const onDown = (e, id) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    if (drag) drag.stop(true);
    const el = scroller.current; if (!el) return;
    drag = press(e, id, el);
  };
  useEffect(() => () => { if (drag) drag.stop(true); }, []);   // strip unmounted mid-drag: land, no slide

  return html`<div class="tabs">
    <div class=${cx('tabs-scroll', dragging && 'reordering')} role="tablist" aria-label="Open sessions" ref=${scroller} onWheel=${onWheel}>
      ${ids.map((id) => {
        const s = byId.get(id);
        return s ? html`<${Tab} key=${id} s=${s} on=${onSession && id === act} beside=${!!sp && id !== act && sp.ids.includes(id)} lifted=${dragging === id} onDown=${onDown} />` : null;
      })}
    </div>
    <button class="icon-btn sm tabs-new" aria-label="New session" data-tip=${`New session  ${mod}+N`} data-tip-pos="bottom"
      onClick=${() => { newSessionOpen.value = true; }}><${Icon} name="plus" size=${15} /></button>
  </div>`;
}
