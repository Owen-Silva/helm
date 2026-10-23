// Small popover menus for the composer's pickers, built on the shell's .menu / .menu-item
// primitives. Rendered into document.body (a tiny portal: ancestors with backdrop-filter would
// otherwise trap position:fixed). Desktop: anchored above the trigger. Phone: a bottom sheet over
// a scrim (tap the scrim or the grab bar to close). Esc / click outside close; arrows move focus.
// Owner: lane composer.
import { html } from '../lib/html.js';
import { render } from 'preact';
import { useRef, useMemo, useEffect, useLayoutEffect } from 'preact/hooks';
import { Icon } from '../lib/icons.js';
import { isPhone, isTouch } from './util.js';
import { leave, leaveRef } from '../lib/motion.js';

export function Portal({ children }) {
  const host = useMemo(() => { const d = document.createElement('div'); d.className = 'cmp-portal'; return d; }, []);
  useLayoutEffect(() => {
    document.body.appendChild(host);
    return () => { render(null, host); host.remove(); };
  }, []);
  useLayoutEffect(() => { render(children, host); });
  return null;
}

const OPT = '[data-opt]:not([disabled])';

export function Popover({ anchorRef, onClose, label, children, wide }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const phone = isPhone.value;
  // the exit (lib/motion.js): desktop pops back toward its trigger, the phone sheet sinks over its fading scrim
  const popRef = useMemo(() => { let last = null; return (el) => { ref.current = el; if (el) { last = el; return; } const n = last; last = null; if (isPhone.peek()) leave(n, 'drop', 'm'); else leave(n, 'pop', 's'); }; }, []);
  const scrimRef = useMemo(() => leaveRef('fade', 'm'), []);

  useLayoutEffect(() => {
    const el = ref.current, a = anchorRef.current;
    if (!el || !a) return;
    if (phone) { el.style.left = ''; el.style.bottom = ''; return; }
    const r = a.getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    el.style.bottom = Math.max(8, innerHeight - r.top + 6) + 'px';
  });

  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector('[data-opt][aria-checked="true"]') || el?.querySelector(OPT);
    if (first && !isTouch()) first.focus({ preventScroll: true });
    const close = (refocus) => { closeRef.current(); if (refocus) anchorRef.current?.focus({ preventScroll: true }); };
    // The phone scrim closes on its own click (so the tap never lands on what is underneath).
    const down = (e) => {
      if (el?.contains(e.target) || anchorRef.current?.contains(e.target) || e.target?.classList?.contains('cmp-scrim')) return;
      close(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const ae = document.activeElement;
      if (ae && ae.tagName === 'INPUT' && el.contains(ae)) return;
      const opts = [...el.querySelectorAll(OPT)];
      if (!opts.length) return;
      e.preventDefault();
      const i = opts.indexOf(ae);
      const n = e.key === 'ArrowDown' ? (i + 1) % opts.length : (i <= 0 ? opts.length - 1 : i - 1);
      opts[n].focus();
    };
    const resize = () => { if (!isPhone.value) close(false); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      removeEventListener('resize', resize);
    };
  }, []);

  return html`<${Portal}>
    ${phone && html`<div ref=${scrimRef} class="cmp-scrim" aria-hidden="true" onPointerDown=${(e) => e.preventDefault()} onClick=${() => closeRef.current()} />`}
    <div ref=${popRef} class=${'menu cmp-pop' + (phone ? ' is-sheet' : '') + (wide ? ' is-wide' : '')} role="menu" aria-label=${label}>
      ${phone && html`<button type="button" class="cmp-grab" aria-label="Close" onClick=${() => closeRef.current()}><span /></button>`}
      ${label && html`<div class="menu-label">${label}</div>`}
      ${children}
    </div>
  <//>`;
}

export function Opt({ checked, label, desc, onClick, disabled, icon, radio = true }) {
  return html`<button type="button" data-opt role=${radio ? 'menuitemradio' : 'menuitem'} aria-checked=${radio ? (checked ? 'true' : 'false') : undefined}
    class="menu-item cmp-opt" disabled=${disabled} onClick=${onClick}>
    ${icon}
    <span class="cmp-opt-text">
      <span class="cmp-opt-label">${label}</span>
      ${desc && html`<span class="menu-desc">${desc}</span>`}
    </span>
    ${radio && html`<span class="menu-check">${checked && html`<${Icon} name="check" size=${15} />`}</span>`}
  </button>`;
}
