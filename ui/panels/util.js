// Shared helpers for the inspector panels. Owner: lane panels (E).
import { html } from '../lib/html.js';
import { TopScrim } from '../lib/top-scrim.js';   // top-row hints: the scrim darkens the window's top row
import { render } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { leaveRef } from '../lib/motion.js';
import { Icon } from '../lib/icons.js';

export { html, Icon };

// ---- formatting ----
export function fmtDuration(ms, { seconds = true } = {}) {
  if (ms == null || !isFinite(ms)) return '—';
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  if (m > 0) return seconds ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  return seconds ? `${s}s` : '<1m';
}
export function fmtCost(usd) {
  if (usd == null || !isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  // Cents, as Claude Code's own /cost shows them ($116.56 was "$117": rounded up a whole dollar).
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = now - ts;
  if (d < 45_000) return 'just now';
  // Whole units elapsed (floor), like every clock: 90 min is "1h ago", never "2h ago".
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
export function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const tom = new Date(now); tom.setDate(now.getDate() + 1);
  if (d.toDateString() === tom.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
// Whole percents never round a live meter to a limit it has not reached: 0.4 is "<1%" (not 0%), 99.6 is "99%"
// (not 100%: Claude Code still allows work until the window is really full).
export function fmtPct(p, digits = 0) {
  if (p == null || !isFinite(p)) return '—';
  const v = +p;
  if (digits === 0 && v > 0 && v < 1) return '<1%';
  if (digits === 0 && v > 99 && v < 100) return '99%';
  return `${v.toFixed(digits)}%`;
}
export function basename(p) { if (!p) return ''; const parts = String(p).split(/[\\/]+/).filter(Boolean); return parts[parts.length - 1] || p; }
export function shortModel(m) {
  if (!m) return '';
  const x = String(m).replace(/^claude-/, '').replace(/\[1m\]$/, '');
  const [fam, ...v] = x.split('-');
  return fam ? fam[0].toUpperCase() + fam.slice(1) + (v.length ? ' ' + v.join('.') : '') : m;
}
// "[lane:audit] audit other redirects" → { lane: 'audit', text: 'audit other redirects' }
export function splitLane(desc) {
  const m = /^\s*\[lane:([^\]]+)\]\s*/.exec(desc || '');
  return m ? { lane: m[1], text: (desc || '').slice(m[0].length) } : { lane: null, text: desc || '' };
}
export const cx = (...a) => a.filter(Boolean).join(' ');

// Panel statuses → the shell's .dot classes (components.css): working | waiting | error | ok | idle | closed.
const DOT = { running: 'working', working: 'working', queued: 'waiting', waiting: 'waiting', failed: 'error', error: 'error', done: 'ok', cancelled: 'closed', stopped: 'closed', closed: 'closed' };
export const dotClass = (status) => DOT[status] || 'idle';

// ---- hooks ----
// Current time. Ticks every `ms` only while `active` (something on screen is running or counting
// down) and the window is visible; no idle timers. When inactive it is read fresh on each render,
// and a re-render is forced when the window becomes visible again so "5m ago" is never stale for long.
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(Date.now());
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const v = () => { setVisible(!document.hidden); if (!document.hidden) setNow(Date.now()); };
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, []);
  useEffect(() => {
    if (!active || !visible) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active, visible]);
  return active && visible ? now : Date.now();
}

// Run an async loader keyed by deps. Returns { data, error, loading, reload }.
export function useAsync(fn, deps) {
  const [st, setSt] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    setSt((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve().then(fn).then(
      (data) => { if (my === seq.current) setSt({ data, error: null, loading: false }); },
      (error) => { if (my === seq.current) setSt({ data: undefined, error, loading: false }); },
    );
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { ...st, reload: run };
}

// ---- state blocks (every panel uses these for loading / empty / error) ----
// Loading is a skeleton of the rows that are coming (lane helm-premium): the panel keeps its shape instead of a
// spinner in a void, and the label stays as a quiet caption (it can carry real information: "the first scan takes
// about 10 seconds"). The skeleton is static apart from one slow opacity breath on a single layer.
export function Loading({ label = 'Loading…' }) {
  return html`<div class="pn-state pn-loading" role="status">
    <div class="pn-skel" aria-hidden="true">${[0, 1, 2, 3].map((i) => html`<div key=${i} class="pn-skel-row"><i class="pn-skel-dot"></i><i class="pn-skel-bar"></i></div>`)}</div>
    <span class="pn-skel-label">${label}</span>
  </div>`;
}
export function Empty({ title, children, icon }) {
  return html`<div class="pn-state pn-empty">
    ${icon && html`<span class="pn-state-mark" aria-hidden="true"><${Icon} name=${icon} size=${18} class="pn-state-icon" /></span>`}
    <div class="pn-state-title">${title}</div>
    ${children && html`<div class="pn-state-body">${children}</div>`}
  </div>`;
}
export function ErrorState({ title = 'Something went wrong', error, onRetry }) {
  const msg = error?.message || (typeof error === 'string' ? error : '');
  return html`<div class="pn-state pn-error" role="alert">
    <div class="pn-state-title">${title}</div>
    ${msg && html`<div class="pn-state-body mono">${msg}</div>`}
    ${onRetry && html`<button class="btn sm pn-retry" onClick=${onRetry}>Try again</button>`}
  </div>`;
}

// Panel section header: small caps-ish label with optional right-side content.
export function SectionHead({ title, children }) {
  return html`<div class="pn-sect-head"><span class="pn-sect-title">${title}</span>${children && html`<span class="pn-sect-aside">${children}</span>`}</div>`;
}

// Render children into a <div> on <body> so fixed overlays escape the inspector column
// (a transformed / filtered ancestor would otherwise trap position: fixed).
export function Portal({ children }) {
  const host = useRef(null);
  if (!host.current && typeof document !== 'undefined') host.current = document.createElement('div');
  useLayoutEffect(() => { document.body.appendChild(host.current); return () => { render(null, host.current); host.current.remove(); }; }, []);
  useLayoutEffect(() => { render(children, host.current); });
  return null;
}

// Modal dialog (used by confirm + wide views). Escape and backdrop click close it.
export function Modal({ title, onClose, wide, children, footer }) {
  const leave = useMemo(() => leaveRef('fade', 'm'), []);   // the exit (lib/motion.js): scrim fades, card shrinks
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return html`<${Portal}><div ref=${leave} class="pn-modal-scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}><${TopScrim} />
    <div class=${cx('pn-modal', wide && 'pn-modal-wide')} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="pn-modal-head">
        <span class="pn-modal-title">${title}</span>
        <button class="icon-btn" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="close" size=${16} /></button>
      </div>
      <div class="pn-modal-body">${children}</div>
      ${footer && html`<div class="pn-modal-foot">${footer}</div>`}
    </div>
  </div><//>`;
}
