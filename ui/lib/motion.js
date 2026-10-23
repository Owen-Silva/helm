// Shared motion, the JS half (lane helm-unison, 2026-10-16; spec next-week/motion-unison.md). The curves and
// durations are CSS tokens (styles/tokens.css --m-*), and every pop-in is a plain CSS animation on its surface
// (styles/components.css "motion"). This file adds the one thing CSS cannot do: an EXIT for a surface that
// Preact unmounts.
//
// leaveRef(kind, size) returns a stable callback ref. Preact calls it with null while the element is still in
// the document (before it removes it). At that moment the helper notes where the element is and what every
// running animation inside it is showing; in a microtask (after Preact has removed it, before the next frame)
// it puts the SAME node back where it was as an inert, aria-hidden, role-less leaving copy (class .m-leave),
// and CSS plays the exit from wherever the entry had got to. The copy removes itself when its exit ends.
//
// The live tree never keeps it: the surface's state, focus return and every "is a dialog open" check
// (document.querySelector('.modal-scrim'), [role=dialog]) see it gone at once. The copy has no role and is
// inert; the few class selectors that ask "is one open" skip it with :not(.m-leave) (OPEN below).
//
// Interrupted: a close during the entry leaves from the entry's current opacity and transform, not from 1; an
// open during an exit mounts a fresh element (the leaving copy is not reused) and the two cross for <= 200 ms.

export const OPEN = ':not(.m-leave)';
const SIZES = { xs: 240, s: 320, m: 440, l: 560 };   // backstop only: CSS owns the real durations
const leaving = new Set();

export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

function snapshot(node) {
  const at = [];
  let list = [];
  try { list = node.getAnimations ? node.getAnimations({ subtree: true }) : []; } catch {}
  for (const a of list) {
    const el = a.effect && a.effect.target;
    if (!el || (a.effect.pseudoElement)) continue;
    const cs = getComputedStyle(el);
    at.push([el, cs.opacity, cs.transform, cs.translate, cs.scale]);
  }
  return at;
}

function place(node) {
  // an in-flow surface (a toast in its column) leaves from where it sat, out of the flow, so the rest close up.
  // Viewport coordinates, not offsets: a bottom-anchored column shrinks when one leaves, and would carry the copy.
  const cs = getComputedStyle(node);
  if (cs.position === 'fixed' || cs.position === 'absolute') return null;
  const r = node.getBoundingClientRect();
  return { left: r.left, top: r.top, width: node.offsetWidth, height: node.offsetHeight };
}

function pin(node, box) {
  Object.assign(node.style, { position: 'fixed', margin: '0', left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px', zIndex: '70' });
}

function repin(node, box) {
  // an ancestor with a transform / filter is the containing block of a fixed child: correct once, by the drift
  const r = node.getBoundingClientRect();
  const dx = box.left - r.left, dy = box.top - r.top;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { node.style.left = (box.left + dx) + 'px'; node.style.top = (box.top + dy) + 'px'; }
}

function stripRoles(node) {
  node.removeAttribute('role'); node.removeAttribute('aria-modal'); node.removeAttribute('id');
  for (const el of node.querySelectorAll('[role], [id], [aria-modal]')) { el.removeAttribute('role'); el.removeAttribute('id'); el.removeAttribute('aria-modal'); }
}

/** Give a node that Preact is unmounting RIGHT NOW (still in the document) its exit. leaveRef wraps this. */
export function leave(node, kind, size) {
  if (!node || !node.isConnected || leaving.has(node)) return;
  const parent = node.parentNode;
  const next = node.nextSibling;
  // a portal host (a div straight under <body>) is removed with its content; the copy then goes on <body>
  const fallback = parent && parent.parentNode === document.body ? document.body : null;
  let at, box;
  try { at = snapshot(node); box = place(node); } catch { return; }
  queueMicrotask(() => {
    if (node.isConnected) return;   // Preact kept it after all (a re-parent): nothing to do
    const into = parent && parent.isConnected ? parent : fallback;
    if (!into) return;              // the whole region went (a screen change): no exit to show
    for (const [el, o, t, tr, sc] of at) {
      el.style.opacity = o;
      el.style.transform = t === 'none' ? '' : t;
      if (tr && tr !== 'none') el.style.translate = tr;
      if (sc && sc !== 'none') el.style.scale = sc;
    }
    if (box) pin(node, box);
    stripRoles(node);
    node.setAttribute('aria-hidden', 'true');
    node.inert = true;
    node.classList.add('m-leave', `m-leave-${kind}`, `m-out-${size}`);
    leaving.add(node);
    let done = false;
    const end = (e) => {
      if (e && (e.target !== node || !String(e.animationName || '').startsWith('m-out'))) return;
      if (done) return; done = true;
      node.removeEventListener('animationend', end);
      leaving.delete(node);
      node.remove();
    };
    node.addEventListener('animationend', end);
    setTimeout(end, (SIZES[size] || 440) + 400);   // a hidden window never ends the animation: the copy still goes
    if (into === parent && next && next.parentNode === parent) parent.insertBefore(node, next);
    else into.appendChild(node);
    if (box) repin(node, box);
  });
}

/** A stable callback ref that gives the element it is set on an exit when Preact unmounts it.
 *  kind: fade (scrims, lightbox) | pop (menus, popovers, dialogs' own card) | drop (toasts, sheets)
 *  size: xs | s | m | l (the --m-dur-* it entered with; the exit is ~45% of it) */
export function leaveRef(kind = 'fade', size = 'm') {
  let node = null;
  return (el) => {
    if (el) { node = el; return; }
    const n = node; node = null;
    leave(n, kind, size);
  };
}

/** leaveRef for keyed lists (toasts, handoff cards): refFor(key) is stable per key until that item leaves. */
export function leaveRefs(kind = 'drop', size = 's') {
  const refs = new Map();
  return (key) => {
    let r = refs.get(key);
    if (!r) {
      const inner = leaveRef(kind, size);
      r = (el) => { inner(el); if (!el) refs.delete(key); };
      refs.set(key, r);
    }
    return r;
  };
}

/** test hook: how many leaving copies are on screen right now */
export const leavingCount = () => leaving.size;
