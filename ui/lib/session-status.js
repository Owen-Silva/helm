// Shared "how does this session read" rule (lane fleet, 2026-10-08). The user asked: "sessions should still
// say they are working if they just have agents running".
// Session.status keeps its meaning ("working" = a turn is active: Stop button, send vs queue, rewind,
// CLI restarts). This is DISPLAY only: an idle session whose agents are still running shows as working,
// with a short sub-label. Use it for dots, Working/Waiting/Error chips, headers and Deck tiles.
// Stable exports (other lanes depend on them): agentsRunningOf, displayStatus, isAgentsOnly, agentsLabel.
import { AGENT_QUIET_MS, fmtQuiet } from './stall-limits.js';

// Running agents the engine reports for a Helm session (Session.agentsRunning) or an external one
// (ExternalSession.agentsRunning); the eta mod's count while a turn runs as a fallback.
export function agentsRunningOf(s) {
  if (!s) return 0;
  const n = Number(s.agentsRunning);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const e = s.eta && Number(s.eta.agentsRunning);
  return s.status === 'working' && Number.isFinite(e) && e > 0 ? Math.floor(e) : 0;
}

// The status to SHOW: 'working' when idle with agents running; otherwise the session's own status.
export function displayStatus(s) {
  if (!s) return 'idle';
  const st = s.status || 'idle';
  return st === 'idle' && agentsRunningOf(s) > 0 ? 'working' : st;
}

// True when it shows as working only because of its agents (no turn active).
export function isAgentsOnly(s) {
  return !!s && s.status === 'idle' && agentsRunningOf(s) > 0;
}

// "1 agent running" / "3 agents running" / '' (none). Given a session with quiet agents (lane stall):
// "3 agents running · 1 quiet", or when every one is quiet "2 agents · no activity 10m+".
export function agentsLabel(n) {
  const k = typeof n === 'object' && n ? agentsRunningOf(n) : Number(n) || 0;
  if (k <= 0) return '';
  const q = typeof n === 'object' && n ? agentsQuietOf(n) : 0;
  if (q >= k) return `${k} agent${k === 1 ? '' : 's'} · no activity ${fmtQuiet(AGENT_QUIET_MS)}+`;
  return `${k} agent${k === 1 ? '' : 's'} running${q > 0 ? ` · ${q} quiet` : ''}`;
}

// lane stall (2026-10-09): running agents that have shown no sign of life for 10+ min (Session.agentsQuiet; still
// counted in agentsRunning: maybe stalled, not known to be stopped). Stopped agents are never counted at all.
export function agentsQuietOf(s) {
  const n = Number(s && s.agentsQuiet);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), agentsRunningOf(s)) : 0;
}

// The session's stall: "Stalled · 12m" while a turn is active with no stream event for 10+ min, else ''.
export { stallText, sessionStallMs } from './stall-limits.js';
