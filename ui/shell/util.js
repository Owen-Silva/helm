// Shell helpers. Owner: lane shell (C).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { leaveRef } from '../lib/motion.js';
import { TopScrim } from '../lib/top-scrim.js';   // top-row hints: the scrim darkens the window's top row

export const cx = (...a) => a.filter(Boolean).join(' ');

export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d`;
  try { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch { return `${d}d`; }
}
export function agoLong(ts, now = Date.now()) {
  const a = ago(ts, now);
  if (!a) return '';
  if (a === 'now') return 'just now';
  return /\d[mhd]$/.test(a) ? `${a} ago` : a;
}
export const fmtCost = (usd) => (usd == null ? '' : usd > 0 && usd < 0.01 ? '<$0.01' : `$${(+usd).toFixed(2)}`);
export const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export const EFFORTS = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' }, { value: 'max', label: 'Max' },
];
export const MODES = [
  { value: 'default', label: 'Ask', long: 'Ask before edits and commands', icon: 'shield' },
  { value: 'acceptEdits', label: 'Accept edits', long: 'Edit files without asking', icon: 'pencil' },
  { value: 'plan', label: 'Plan', long: 'Read-only until a plan is approved', icon: 'list-todo' },
  { value: 'bypassPermissions', label: 'Bypass', long: 'Never ask (full access)', icon: 'zap' },
];
export const modeLabel = (v) => MODES.find((m) => m.value === v)?.label || v || '';
export const effortLabel = (v) => EFFORTS.find((e) => e.value === v)?.label || v || '';

// 'claude-opus-5-5' → 'Opus 5.5'; uses the models list when it has a displayName.
export function modelLabel(value, models) {
  const hit = models?.find((m) => m.value === value);
  if (hit?.displayName) return hit.displayName;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(value || '');
  if (!m) return value || '';
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

let modelsCache = null;
export function useModels(rpc) {
  const [models, setModels] = useState(modelsCache || []);
  useEffect(() => {
    if (modelsCache) return;
    rpc('sessions.models', {}).then((m) => { modelsCache = m || []; setModels(modelsCache); }).catch(() => {});
  }, []);
  return models;
}

export function debounce(fn, ms) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// Close on Escape / outside pointerdown.
export function useDismiss(open, onClose, refs) {
  useEffect(() => {
    if (!open) return;
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const down = (e) => { if (!refs.some((r) => r.current && r.current.contains(e.target))) onClose(); };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', down, true); };
  }, [open]);
}

// A menu anchored to a trigger element, positioned with fixed coords so panels can't clip it.
//   const m = useMenu();  <button ref=${m.anchor} onClick=${m.toggle}>…</button>  ${m.open && html`<${Menu} m=${m}>…<//>`}
export function useMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null), panel = useRef(null);
  const close = () => setOpen(false);
  useDismiss(open, close, [anchor, panel]);
  return { open, setOpen, toggle: () => setOpen((o) => !o), close, anchor, panel };
}
export function Menu({ m, children, align = 'start', width, class: cls }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const a = m.anchor.current, p = m.panel.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
    let top = r.bottom + 6, up = false;
    if (top + ph > innerHeight - 8) { top = Math.max(8, r.top - ph - 6); up = true; }
    // motion: the menu scales out of the corner nearest its trigger (components.css .menu, --m-origin)
    setPos({ left, top, origin: `${align === 'end' ? '100%' : '0'} ${up ? '100%' : '0'}` });
  }, [m.open]);
  const ref = useMemo(() => { const lv = leaveRef('pop', 'xs'); return (el) => { m.panel.current = el; lv(el); }; }, []);
  return html`<div ref=${ref} class=${cx('menu shell-menu', cls)} role="menu"
    style=${{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, '--m-origin': pos?.origin }}
    onClick=${(e) => { if (e.target.closest('.menu-item:not([data-keep])')) m.close(); }}>${children}</div>`;
}

// Modal shell: scrim + centred card. Esc and scrim click close.
export function Modal({ title, onClose, children, footer, width = 520, class: cls, labelledBy }) {
  const card = useRef(null);
  const leave = useMemo(() => leaveRef('fade', 'm'), []);   // the exit (lib/motion.js): scrim fades, card shrinks
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    addEventListener('keydown', key, true);
    const prev = document.activeElement;
    requestAnimationFrame(() => { const f = card.current?.querySelector('[autofocus], input, textarea, select, button.btn-primary'); f?.focus(); });
    return () => { removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, []);
  return html`<div ref=${leave} class="modal-scrim" onPointerDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}><${TopScrim} />
    <div ref=${card} class=${cx('modal', cls)} role="dialog" aria-modal="true" aria-label=${title} style=${{ '--modal-w': `${width}px` }}>
      ${title && html`<header class="modal-head"><h2>${title}</h2>
        <button class="icon-btn" aria-label="Close" onClick=${onClose}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></header>`}
      <div class="modal-body">${children}</div>
      ${footer && html`<footer class="modal-foot">${footer}</footer>`}
    </div>
  </div>`;
}

// Re-render every `ms` (relative times / elapsed clocks). Skips ticks while the window is hidden;
// ms = 0 (or null) means no timer at all, so idle views cost nothing.
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!ms) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') set((n) => n + 1); }, ms);
    return () => clearInterval(t);
  }, [ms]);
}

export const isMac = /Mac/.test(navigator.platform || '');
export const mod = isMac ? '⌘' : 'Ctrl';
