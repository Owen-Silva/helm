'use strict';
// Stalled sessions and quiet / interrupt-stopped agents (lane stall, 2026-10-09). Thresholds: ui/lib/stall-limits.js.
//
// stallTick(es)  every STALL_TICK_MS from the engine, per session:
//   - fleet.sweep(): each running agent's own transcript tail (interrupt marker → stopped; quiet → maybe stalled)
//   - Session.stalledSince: a turn is active (status "working": nothing waits on the user) and Helm has received NO
//     SDK message for SESSION_STALL_MS. Any message clears it at once (session.js _onMessage). Real signal only:
//     Claude Code streams tokens, tool_progress heartbeats and subagent messages while it works, and a tool call
//     cannot run past Bash's 10-minute cap, so ten silent minutes mean the stream is hung ("stalled 600s").
//
// resumeStalled(es)  sessions.resumeStalled, only after the user confirms in the UI; never automatic.
//   Refuses unless the session is stalled right now (a turn that started streaming again is left alone). Then:
//   1. interrupt the hung turn (Helm's own sessions.interrupt path; the CLI answers with a result, or Helm's
//      8 s grace timer ends the turn locally);
//   2. if the CLI sent nothing at all after the interrupt it is wedged: close it (the next send starts a fresh
//      claude.exe on the same conversation);
//   3. send RESUME_PROMPT ("Continue where you left off.") with origin 'helm' (a Helm-written prompt, never
//      counted as the user's own words by the production guard).
//   Result: { action: 'continued' | 'none' | 'failed', restarted, reason?, message, itemId?, prompt }.

const { SESSION_STALL_MS, RESUME_PROMPT } = require('../../ui/lib/stall-limits.js');

const STALL_TICK_MS = 30_000;
const RESUME_WAIT_MS = 10_000; // > session.js INTERRUPT_GRACE_MS (8 s): the turn has ended one way or the other

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When the current turn's stream went silent (the last SDK message, or the turn's start), if it has been
// silent for SESSION_STALL_MS; else null.
function stallSince(es, now = Date.now()) {
  if (!es || !es.q || !es.turnActive || !es.s || es.s.status !== 'working') return null;
  const last = Math.max(isNum(es.lastEventAt) ? es.lastEventAt : 0, isNum(es.s.turnStartedAt) ? es.s.turnStartedAt : 0);
  return last > 0 && now - last >= SESSION_STALL_MS ? last : null;
}

function stallTick(es, now = Date.now()) {
  if (!es) return;
  try {
    if (es.fleet && es.fleet.runningCount() > 0) es.fleet.sweep(now);
  } catch {}
  const since = stallSince(es, now);
  if (since !== (es.stalledSince || null)) {
    es.stalledSince = since;
    if (es._emitUpdated) es._emitUpdated();
  }
}

// stopAgents (lane steer): the user's confirm named the running agents this interrupt stops; without it, a session
// with agents running is refused (code 'agents_running', data.agents) and nothing is touched.
async function resumeStalled(es, { waitMs = RESUME_WAIT_MS, now = Date.now(), stopAgents = false } = {}) {
  const base = { prompt: RESUME_PROMPT, restarted: false };
  if (!es.turnActive || es.s.status !== 'working') {
    return { ...base, action: 'none', reason: 'not_working', message: 'This session is not working any more, so there was nothing to resume.' };
  }
  if (stallSince(es, now) == null) {
    return { ...base, action: 'none', reason: 'not_stalled', message: 'Claude Code is streaming again, so nothing was changed.' };
  }
  const t0 = Date.now();
  await es.interrupt({ stopAgents });
  const until = Date.now() + waitMs;
  while (es.turnActive && Date.now() < until) await sleep(100);
  const answered = isNum(es.lastEventAt) && es.lastEventAt >= t0;
  let restarted = false;
  if (!answered && es.q) {
    await es.close({ final: false });
    restarted = true;
  }
  if (es.turnActive) {
    return { ...base, restarted, action: 'failed', reason: 'turn_still_active', message: 'The hung turn did not stop, so nothing was sent. Try Stop, then send a message.' };
  }
  const r = await es.send({ text: RESUME_PROMPT, origin: 'helm' });
  return {
    ...base,
    restarted,
    action: 'continued',
    itemId: (r && r.itemId) || null,
    message: restarted
      ? `Claude Code did not answer the interrupt, so Helm restarted it and sent "${RESUME_PROMPT}"`
      : `Interrupted the stalled turn and sent "${RESUME_PROMPT}"`,
  };
}

module.exports = { stallTick, stallSince, resumeStalled, STALL_TICK_MS, RESUME_WAIT_MS };
