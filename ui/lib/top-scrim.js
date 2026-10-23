// Full-window scrims for the top-row hints (lane helm-toprow-hints): a modal, the palette or the lightbox darkens the
// window's top row while it is open, and Mantle's top bar should hear about it in the same task. Components drop
// <${TopScrim} /> inside their scrim element; it reads that element's painted background (the palette's scrim is
// not the modals' one) and ui/shell/toprow.js listens. No imports but preact's hooks, so any component can use it
// without an import cycle.
import { useLayoutEffect, useRef } from 'preact/hooks';
import { html } from './html.js';

const open = new Map();   // token -> { rgb, a } | null (null: unreadable, the theme's --scrim is assumed)
let listener = null;

/** the open scrims, oldest first: [{ rgb, a } | null] */
export const openScrims = () => [...open.values()];
export function onScrimChange(fn) { listener = fn; }

/** "rgba(0, 0, 0, 0.26)" / "rgb(6, 7, 8)" -> { rgb, a } or null */
export function parseScrim(s) {
  const m = /rgba?\(([^)]+)\)/.exec(String(s || ''));
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  const a = p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1;
  return { rgb: p.slice(0, 3).map((v) => Math.round(v)), a };
}

export function TopScrim() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const token = {};
    const host = ref.current && ref.current.parentElement;
    let c = null;
    try { c = host ? parseScrim(getComputedStyle(host).backgroundColor) : null; } catch {}
    open.set(token, c);
    try { listener && listener('scrim-open'); } catch {}
    return () => { open.delete(token); try { listener && listener('scrim-close'); } catch {} };
  }, []);
  return html`<span ref=${ref} hidden aria-hidden="true"></span>`;
}
