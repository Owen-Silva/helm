// Conversation-lane UI state: expand/collapse overrides and a shared 1s clock for elapsed times.
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

// Expansion: one signal per key, value null = "use the default", true/false = the user's choice.
const opens = new Map();
export function openSig(key) {
  let s = opens.get(key);
  if (!s) { s = signal(null); opens.set(key, s); }
  return s;
}
export function isOpen(key, def) { const v = openSig(key).value; return v == null ? !!def : v; }
export function toggle(key, def) { const s = openSig(key); s.value = !(s.value == null ? !!def : s.value); }
export function setOpen(key, v) { openSig(key).value = v; }

// One shared ticking clock; only runs while at least one component needs it AND the window is
// visible (a hidden/minimized window re-rendered every elapsed clock once a second for nothing).
export const now = signal(Date.now());
let users = 0, timer = null;
const hidden = () => typeof document !== 'undefined' && document.hidden;
function syncTimer() {
  const want = users > 0 && !hidden();
  if (want && !timer) { now.value = Date.now(); timer = setInterval(() => { now.value = Date.now(); }, 1000); }
  else if (!want && timer) { clearInterval(timer); timer = null; }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', syncTimer);
export function useTicker(active) {
  useEffect(() => {
    if (!active) return undefined;
    users++;
    syncTimer();
    return () => { users--; syncTimer(); };
  }, [active]);
}
