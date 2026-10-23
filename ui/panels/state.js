// Inspector UI state. Owner: lane panels (E). The shell wires its rail buttons and Ctrl+\ to these.
//   inspectorPanel  — id of the open panel (one of PANELS[].id)
//   inspectorOpen   — whether the right column is shown
//   inspectorWide   — "pop out wide": the shell should size the column to ~60% of the window
// All three persist to localStorage (best effort; private windows just start fresh).
import { signal, effect } from '@preact/signals';

const IDS = ['fleet', 'changes', 'files', 'preview', 'queue', 'usage', 'railway'];

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function persist(sig, key) {
  effect(() => { const v = sig.value; try { localStorage.setItem(key, JSON.stringify(v)); } catch {} });
}

const savedPanel = load('helm.inspector.panel', 'fleet');
export const inspectorPanel = signal(IDS.includes(savedPanel) ? savedPanel : 'fleet');
export const inspectorOpen = signal(load('helm.inspector.open', true) !== false);
export const inspectorWide = signal(load('helm.inspector.wide', false) === true);
persist(inspectorPanel, 'helm.inspector.panel');
persist(inspectorOpen, 'helm.inspector.open');
persist(inspectorWide, 'helm.inspector.wide');

// Open a given panel (and the inspector). Clicking the open panel's rail button again closes it.
export function showPanel(id, { toggle = false } = {}) {
  if (toggle && inspectorOpen.value && inspectorPanel.value === id) { inspectorOpen.value = false; return; }
  inspectorPanel.value = id;
  inspectorOpen.value = true;
}
export function toggleInspector() { inspectorOpen.value = !inspectorOpen.value; }

// Panel-local persisted preferences.
export const fleetAllSessions = signal(load('helm.fleet.all', false) === true);
persist(fleetAllSessions, 'helm.fleet.all');
