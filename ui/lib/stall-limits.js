// Stopped and stalled, in ONE place (lane stall, 2026-10-09). The user pressed Esc, every background agent in that
// session stopped silently, and the user was told "4 agents running" for 45 minutes when none were. Helm now says:
//   an agent stopped by an interrupt   "Stopped 18:54 · interrupted"       (Agent.status 'stopped', stopReason)
//   a running agent gone quiet          "No activity 12m"                   (Agent.quiet, lastActivityAt; maybe stalled)
//   a working session with no stream    "Stalled · 12m" + Resume            (Session.stalledSince)
// Pure ESM with no imports, so the UI imports it and the engine require()s it (Node 24 / Electron 44 require(esm)):
// main/engine/fleet.js + stall.js, ui/lib/session-status.js + session-header.js, ui/panels/*.
export const AGENT_QUIET_MS = 10 * 60_000;     // running agent with no transcript write / stream event this long
export const SESSION_STALL_MS = 10 * 60_000;   // working session (turn active, nothing waiting on the user) with no SDK message this long
export const INTERRUPT_WINDOW_MS = 15_000;     // an agent Claude Code stops this soon after Helm's interrupt was stopped by it
export const RESUME_PROMPT = 'Continue where you left off.';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pad = (n) => String(n).padStart(2, '0');

// "18:54" (local, 24h, like the timeline's ticks).
export function fmtClock(t) {
  const v = num(t);
  if (v == null) return '';
  const d = new Date(v);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "12m" · "1h 04m" (whole minutes: these states are measured in minutes and re-read on the minute tick).
export function fmtQuiet(ms) {
  const v = num(ms);
  if (v == null) return '';
  const m = Math.max(0, Math.floor(v / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

export const STOP_REASON_TEXT = { interrupted: 'interrupted', closed: 'session closed', exited: 'Claude Code exited' };

// How long a running agent has been quiet (ms), or null. The engine sets `quiet` only after AGENT_QUIET_MS with no
// transcript write and no stream event for it; the minutes count from its last sign of life.
export function agentQuietMs(a, now = Date.now()) {
  if (!a || a.status !== 'running' || a.quiet !== true) return null;
  const last = num(a.lastActivityAt) ?? num(a.resumedAt) ?? num(a.startedAt);
  return last == null ? null : Math.max(AGENT_QUIET_MS, now - last);
}

// One line for an agent's honest state, or null when there is nothing to add to Running / Done / Failed:
//   "Stopped 18:54 · interrupted" | "Stopped 18:54" | "Stopped · interrupted" | "No activity 12m"
export function agentStateText(a, now = Date.now()) {
  if (!a) return null;
  if (a.status === 'stopped') {
    const at = fmtClock(a.endedAt);
    const why = STOP_REASON_TEXT[a.stopReason] || '';
    return `Stopped${at ? ` ${at}` : ''}${why ? ` · ${why}` : ''}`;
  }
  const q = agentQuietMs(a, now);
  return q == null ? null : `No activity ${fmtQuiet(q)}`;
}

// A working session's stall (ms since its last stream event), or null. Session.stalledSince is set by the engine
// only while a turn is active and nothing waits on the user; this re-checks both so a late update never shows one.
export function sessionStallMs(s, now = Date.now()) {
  const since = s && num(s.stalledSince);
  if (since == null || s.status !== 'working') return null;
  return now - since >= SESSION_STALL_MS ? now - since : null;
}

// "Stalled · 12m" | ''
export function stallText(s, now = Date.now()) {
  const ms = sessionStallMs(s, now);
  return ms == null ? '' : `Stalled · ${fmtQuiet(ms)}`;
}
