// Railway status store, shared by the Railway panel and the Home chip (PROTOCOL "Railway").
// main/railway.js polls only while a lease is alive: useRailwayWatch(kind) renews one with
// railway.status { watch } every 25 s (panel) or 2 min (chip) while it is mounted AND the window is
// visible, and asks once more the moment the window comes back. railway.changed pushes every change.
// Owner: lane railway.
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { rpc, on } from './transport.js';

export const railwayState = signal(null);     // railway.status answer, or null before the first one
export const railwayRpcError = signal(null);  // the RPC itself failed (old host without railway.*, socket down)

on('railway.changed', (v) => { if (v && typeof v === 'object') railwayState.value = v; });

const RENEW_MS = { panel: 25_000, chip: 120_000 };

export async function pingRailway(watch, refresh = false) {
  try {
    const v = await rpc('railway.status', { ...(watch ? { watch } : {}), ...(refresh ? { refresh: true } : {}) });
    if (v && typeof v === 'object') railwayState.value = v;
    railwayRpcError.value = null;
  } catch (e) {
    railwayRpcError.value = e || new Error('railway.status failed');
  }
}

export function useRailwayWatch(kind) {
  useEffect(() => {
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) pingRailway(kind); };
    tick();
    const t = setInterval(tick, RENEW_MS[kind] || RENEW_MS.chip);
    const vis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [kind]);
}

// Only ever called from the confirm dialog's button: confirm: true is the dialog's say-so.
export async function railwayAct(kind, svc) {
  const res = await rpc(kind === 'restart' ? 'railway.restart' : 'railway.redeploy', {
    serviceId: svc.serviceId,
    environmentId: svc.environmentId,
    deploymentId: kind === 'restart' ? svc.restartId : svc.deploymentId,
    confirm: true,
  });
  pingRailway(null);
  return res;
}
