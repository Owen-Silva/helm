// What the session header's status line says (lane header, 2026-10-08). The user asked: "all the info i need like how
// many agents are running, estimated time etc. to be up here and always visible".
// Pure (one import, itself pure): host-tested in test/host/session-header.test.js. ui/shell/header.js renders
// the model; its fitLine() drops whole pieces by priority when the line is too narrow.
// Every number comes from data the client already has; nothing here invents one:
//   Session        status, activity, turnStartedAt, agentsRunning, openTasks, context, eta, updatedAt
//   fleet.updated  the running agents (names, start times)
//   loaded items   the latest main-thread TodoWrite, the pending request's time, the last turn's result
import { agentsRunningOf, displayStatus, isAgentsOnly, agentsLabel } from './session-status.js';
import { CONTEXT_HANDOFF_PCT, contextLevel } from './context-limits.js';
import { sessionStallMs, agentQuietMs, fmtQuiet, SESSION_STALL_MS } from './stall-limits.js';   // lane stall

const MIN = 60_000;
// The eta mod rewrites its snapshot at least once a minute while it says "working" (core.ts `beat`). With no
// turn running, Helm has only the mod's word that work is still going, so an older snapshot is not shown.
export const ETA_STALE_MS = 10 * MIN;

const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "45s" · "3m 01s" · "1h 04m". A clock, so never negative; '' without a duration.
export function fmtElapsed(ms) {
  const v = num(ms);
  if (v == null) return '';
  const s = Math.max(0, Math.round(v / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// "just now" · "4m ago" · "2h ago" · "3d ago" (minute resolution: the header re-reads it on the shared minute tick).
export function fmtAgo(ms) {
  const v = num(ms);
  if (v == null) return '';
  const m = Math.floor(Math.max(0, v) / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// May the eta mod's snapshot (Session.eta) be shown? Its basis is the mod's own: Claude's declared estimate (the
// Eta tool, calibrated by the mod's history) or the running agents' expected finish, whichever is later. Until
// one exists etaAt is null ("no estimate yet") and the header shows no time at all, never a guess.
//   turn running              the snapshot, unless the mod says it is not working (unchanged rule)
//   no turn, agents running   only while the mod itself still says "working" (it keeps a session working until
//                             its agents finish, with their finish as etaAt) and the snapshot is fresh
//   waiting / idle / error / closed   never: a clock waiting on the user is not an estimate
export function etaShown(s, now = Date.now()) {
  const e = s && s.eta;
  if (!e || num(e.etaAt) == null || e.etaAt <= 0) return false;
  if (s.status === 'working') return !e.state || e.state === 'working';
  if (!isAgentsOnly(s) || e.state !== 'working') return false;
  const at = num(e.updatedAt);
  return at == null || now - at < ETA_STALE_MS;
}

// Todo progress from the latest main-thread TodoWrite: { done, total, text: "2/4", current }. null when there are
// none, or all are done (nothing left to track; same rule as the chat's todo strip).
export function todoProgress(todos) {
  if (!Array.isArray(todos) || !todos.length) return null;
  const list = todos.filter((t) => t && typeof t === 'object');
  if (!list.length) return null;
  const done = list.filter((t) => t.status === 'completed').length;
  if (done === list.length) return null;
  const cur = list.find((t) => t.status === 'in_progress');
  return { done, total: list.length, text: `${done}/${list.length}`, current: cur ? String(cur.activeForm || cur.content || '') : '' };
}

// One backwards pass over a session's loaded items: the latest main-thread TodoWrite's todos (null: none loaded),
// when the oldest still-pending request was raised (null: none), and when the last turn ended (its result item).
export function itemFacts(items) {
  let todos = null, waitingSince = null, lastTurnAt = null, sawTodos = false;
  if (Array.isArray(items)) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'tool') {
        if (!sawTodos && it.name === 'TodoWrite' && !it.parentToolUseId) { sawTodos = true; todos = Array.isArray(it.input?.todos) ? it.input.todos : null; }
      } else if (it.type === 'request') {
        const ts = num(it.ts);
        if (it.status === 'pending' && ts != null) waitingSince = waitingSince == null ? ts : Math.min(waitingSince, ts);
      } else if (it.type === 'result' && lastTurnAt == null) {
        lastTurnAt = num(it.ts);
      }
    }
  }
  return { todos, waitingSince, lastTurnAt };
}

// The running agents of a fleet list, oldest first: { id, lane, text, since, type }. `since` is this run's start
// (a SendMessage resume restarts it). Only status "running" counts (PROTOCOL: Agent).
export function runningAgents(fleet, now = Date.now()) {
  if (!Array.isArray(fleet)) return [];
  return fleet.filter((a) => a && a.status === 'running').map((a) => {
    const d = String(a.description || '');
    const m = /^\s*\[lane:([^\]]+)\]\s*/.exec(d);
    // quietMs (lane stall): running with no sign of life for 10+ min ("No activity 12m"), else null
    return { id: a.id, lane: m ? m[1] : null, text: m ? d.slice(m[0].length) : d, since: num(a.resumedAt) ?? num(a.startedAt), type: a.subagentType || null, quietMs: agentQuietMs(a, now) };
  }).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}

// Running agents at or past the 32% hand-off: { n, level: 'warn' | 'danger' (the worst), text, short, list } or null.
// text: "1 agent at 34%" | "2 agents at 33-41%"; list (highest first): { id, lane, text, pct, level }. The % is
// floored, as in the hand-off notification, so "32%" never shows for 31.6.
export function contextWarn(fleet) {
  if (!Array.isArray(fleet)) return null;
  const list = [];
  for (const a of fleet) {
    if (!a || a.status !== 'running') continue;
    const p = num(a.context && a.context.percent);
    if (p == null || p < CONTEXT_HANDOFF_PCT) continue;
    const d = String(a.description || '');
    const m = /^\s*\[lane:([^\]]+)\]\s*/.exec(d);
    list.push({ id: a.id, lane: m ? m[1] : null, text: (m ? d.slice(m[0].length) : d) || a.subagentType || 'agent', pct: Math.floor(p), level: contextLevel(p) });
  }
  if (!list.length) return null;
  list.sort((a, b) => b.pct - a.pct);
  const hi = list[0].pct, lo = list[list.length - 1].pct;
  const text = list.length === 1 ? `1 agent at ${hi}%` : `${list.length} agents at ${lo === hi ? `${hi}%` : `${lo}-${hi}%`}`;
  // short: the narrow form fitLine swaps in when the full one would drop the piece ("34%" | "2 at 41%")
  const short = list.length === 1 ? `${hi}%` : `${list.length} at ${hi}%`;
  return { n: list.length, level: list.some((x) => x.level === 'danger') ? 'danger' : 'warn', text, short, list };
}

const LONG = { working: 'Working', waiting: 'Needs you', error: 'Stopped with an error', idle: 'Idle', closed: 'Stopped' };
const SHORT = { working: 'Working', waiting: 'Needs you', error: 'Error' };

// The header's status model. `facts` = itemFacts(items); `fleet` = the session's Agent list.
// {
//   state:   displayStatus (dot and colour): working | waiting | error | idle | closed
//   text:    the lead piece: what it is doing now ("Running npm test"), "3 agents running", "Idle", ...
//   short:   its narrow form ("Working", "Needs you", "3 agents"), or null
//   clock:   { text, title, live } detail after the lead: the turn's run time, time waiting on the user, how long the
//            oldest running agent has run, or for idle/closed how long ago it was last active; null when unknown
//   agents:  { n, text: "3 agents", list } while a turn is active or waiting (agents-only says it in the lead)
//   eta:     true when the eta mod's estimate may be shown (etaShown)
//   todo:    todoProgress while a turn is active; tasks: { n, text: "1 task" }; context: { pct, text: "21% context" }
//   ctxWarn: contextWarn(fleet): running agents at or past the 32% hand-off ("1 agent at 34%"), or null
// }
export function headerModel(s, { now = Date.now(), fleet = null, facts = null } = {}) {
  if (!s) return null;
  const f = facts || {};
  const state = displayStatus(s);
  const n = agentsRunningOf(s);
  const agentsOnly = isAgentsOnly(s);
  const list = runningAgents(fleet, now);
  const stallMs = sessionStallMs(s, now);
  let text = s.activity || LONG[s.status] || s.status || 'Idle';
  let short = SHORT[state] && SHORT[state] !== text ? SHORT[state] : null;
  let clock = null;
  const ts = (v) => { const t = num(v); return t != null && t > 0 ? t : null; };

  if (agentsOnly) {
    text = agentsLabel(n);
    short = plural(n, 'agent');
    const since = list.length ? list[0].since : null;
    if (since != null) clock = { text: fmtElapsed(now - since), title: `Oldest running agent has run ${fmtElapsed(now - since)}`, live: true };
  } else if (stallMs != null) {
    // lane stall: a turn is active but Claude Code has sent nothing for 10+ min ("Stalled · 12m" + Resume)
    text = 'Stalled';
    short = null;
    clock = { text: fmtQuiet(stallMs), title: `No stream event from Claude Code for ${fmtQuiet(stallMs)} (stalled after ${fmtQuiet(SESSION_STALL_MS)} of silence)`, live: false };
  } else if (s.status === 'working') {
    const t = ts(s.turnStartedAt);
    if (t) clock = { text: fmtElapsed(now - t), title: `This turn has run ${fmtElapsed(now - t)}`, live: true };
  } else if (s.status === 'waiting') {
    const t = ts(f.waitingSince);
    if (t) clock = { text: fmtElapsed(now - t), title: `Waiting on you for ${fmtElapsed(now - t)}`, live: true };
  } else if (s.status === 'error') {
    text = s.activity || LONG.error;
  } else {
    // idle / closed: when it was last used. The last turn's end when its result is loaded, else Session.updatedAt
    // (last used: turns, sends, the user's own edits; never Helm's own housekeeping).
    const turn = ts(f.lastTurnAt), used = ts(s.updatedAt);
    const at = turn || used;
    if (at) {
      const ago = fmtAgo(now - at);
      clock = { text: turn ? `last turn ${ago}` : `active ${ago}`, title: `${turn ? 'Last turn ended' : 'Last used'} ${ago}`, live: false };
    }
    text = s.status === 'closed' ? LONG.closed : LONG.idle;
    short = null;
  }

  const busy = state === 'working' || state === 'waiting';
  const tasksN = Math.max(0, Math.floor(num(s.openTasks) || 0));
  const pctRaw = num(s.context && s.context.percent);
  const pct = pctRaw == null || pctRaw <= 0 ? null : Math.min(100, Math.round(pctRaw));
  return {
    state, text, short, clock,
    agents: n > 0 && !agentsOnly ? { n, text: plural(n, 'agent'), list } : null,
    agentList: list,
    // lane stall: { ms, text: "Stalled · 12m", since } while stalled (the header offers Resume), else null
    stall: stallMs == null ? null : { ms: stallMs, text: `Stalled · ${fmtQuiet(stallMs)}`, since: s.stalledSince },
    eta: etaShown(s, now),
    // same rule as the chat's todo strip: only while a turn is active (agents-only has no turn; its todos are the
    // finished turn's and may never be updated again)
    todo: s.status === 'working' || s.status === 'waiting' ? todoProgress(f.todos) : null,
    tasks: tasksN > 0 ? { n: tasksN, text: plural(tasksN, 'task') } : null,
    context: pct == null ? null : { pct, text: `${pct}% context` },
    ctxWarn: contextWarn(fleet),
    busy,
  };
}
