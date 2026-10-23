// The user's agent context rule, in ONE place: a subagent hands off at 32% of its context window and never
// crosses 40% (~/.claude/CLAUDE.md "Agent context ceiling"; measured today by ~/.claude/tools/agent-context.js).
// Pure ESM with no imports, so the UI imports it and the engine require()s it (Node 24 / Electron 44
// require(esm)): main/engine/fleet.js (ContextAlerts), ui/panels/fleet.js + timeline.js, ui/lib/session-header.js.
export const CONTEXT_HANDOFF_PCT = 32;   // amber: "hand off"
export const CONTEXT_CEILING_PCT = 40;   // red: "over the ceiling"

// percent (number) -> 'danger' (>= 40) | 'warn' (>= 32) | '' (below, or unknown)
export function contextLevel(pct) {
  const p = typeof pct === 'number' ? pct : pct == null || pct === '' ? NaN : Number(pct);
  if (!Number.isFinite(p)) return '';
  return p >= CONTEXT_CEILING_PCT ? 'danger' : p >= CONTEXT_HANDOFF_PCT ? 'warn' : '';
}

// The words for a level, for tooltips and the header popover.
export function contextLevelText(level) {
  return level === 'danger' ? `over the ${CONTEXT_CEILING_PCT}% ceiling` : level === 'warn' ? 'hand off' : '';
}
