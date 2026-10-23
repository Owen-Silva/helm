'use strict';
// Fleet tracking: every Agent/Task tool call in a session becomes an Agent object
// (docs/PROTOCOL.md "Agent (fleet)"). Children are tool items whose parentToolUseId is the
// agent's toolUseId; nested agents get depth = parent depth + 1.
// Context per agent = the subagent's own last API usage (assistant messages carrying
// parent_tool_use_id), falling back to task_progress usage when no message usage arrived.
//
// Lifecycle (lane fleet, 2026-10-08):
// - A background agent's Agent tool call returns at launch; it ends on a task notification
//   (live: SDK task_notification / task_updated; transcript: the "<task-notification>" user line,
//   which the normalizer turns into a "Background task <status>: Agent "<desc>" …" info item).
// - SendMessage to a stopped agent RESUMES it (tool result `resumedAgentId`, live also a
//   task_started for the same task id): it is running again; the earlier run moves to `runs`.
// - Background agents live inside the CLI process: when the CLI exits they stop with it.
// - Rebuilding from a transcript: an agent with no completion record was stopped when an earlier
//   CLI exited. Its status is "stopped" and its end is the last event in its OWN transcript
//   (`endEstimated: true`); with no transcript on disk its end stays unknown (no endedAt), never "now".
// - rebuild() keeps the live state of agents it already tracks (loading an older page of the
//   transcript must not mark running agents finished).
//
// Stopped and quiet (lane stall, 2026-10-09; thresholds in ui/lib/stall-limits.js):
// - An interrupt stops EVERY background agent of the session at once. Live, Claude Code then sends
//   task_updated {status:"killed"} + task_notification {status:"stopped"} for each (measured 2026-10-09,
//   tools/stall-live.js); the model itself is never told. Each agent's own transcript ends with a user line
//   "[Request interrupted by user…]" written that same second. Either signal → status "stopped",
//   stopReason "interrupted" (an end within INTERRUPT_WINDOW_MS of Helm's own sessions.interrupt, or the
//   marker as its transcript's last line). Other stops: stopReason "closed" / "exited" (the CLI went away).
// - sweep() (every 30 s from the engine, and 3 s after an interrupt) reads each RUNNING agent's own
//   transcript tail: the marker stops it; otherwise its last line's time is its lastActivityAt. Live stream
//   events for it (child tools, usage, task_progress, tool_progress) move lastActivityAt too. No sign of life
//   for AGENT_QUIET_MS → `quiet: true` ("No activity 12m"): maybe stalled, still running, still counted.

const fs = require('fs');
const path = require('path');
const { windowFor, contextFrom, usedTokensOf } = require('./util');
// The user's 32% / 40% rule lives in ONE file the UI also imports (pure ESM; Node 24 / Electron 44 require(esm)).
const { CONTEXT_HANDOFF_PCT, CONTEXT_CEILING_PCT } = require('../../ui/lib/context-limits.js');
const { projectsDir: defaultProjectsDir } = require('./transcript');
const { AGENT_QUIET_MS, INTERRUPT_WINDOW_MS } = require('../../ui/lib/stall-limits.js');

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const HEX_ID = '[A-Za-z0-9]{6,64}';
const AGENT_ID_RE = new RegExp(`agentId:\\s*(${HEX_ID})`);
const RESUMED_RE = new RegExp(`"resumedAgentId"\\s*:\\s*"(${HEX_ID})"`);
const OUTPUT_RE = /output_file:\s*(\S+?\.output)\b/;
const NOTIF_RE = /^Background task (\w+):\s*Agent "(.*)"/s;
const INTERRUPT_MARK = '[Request interrupted by user';   // Claude Code's line when an interrupt stops a thread
const SWEEP_AFTER_INTERRUPT_MS = 3000;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Task status word (SDK or <status> tag) → Agent status.
function endStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'completed' || v === 'done' || v === 'finished' || v === 'success') return 'done';
  if (v === 'killed' || v === 'stopped' || v === 'cancelled' || v === 'canceled' || v === 'interrupted') return 'stopped';
  return 'error';
}

function resultText(item) {
  const r = item && item.result;
  return typeof r === 'string' ? r : (r && typeof r.text === 'string' ? r.text : '');
}

// Is this transcript line Claude Code's interrupt marker ("[Request interrupted by user]" / "… for tool use]")?
function isInterruptLine(j) {
  if (!j || j.type !== 'user' || !j.message) return false;
  const c = j.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '';
  return String(text).trimStart().startsWith(INTERRUPT_MARK);
}

// The tail of a transcript (.jsonl): { t: the newest line's `timestamp` (else the file's mtime), interrupted: the
// newest line is the interrupt marker }; null when the file is missing.
function tailInfo(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, 256 * 1024);
    if (len > 0) {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l || l[0] !== '{') continue;
        try {
          const j = JSON.parse(l);
          const t = Date.parse(j.timestamp);
          if (isNum(t)) return { t, interrupted: isInterruptLine(j) };
        } catch {}
      }
    }
    return { t: isNum(st.mtimeMs) ? Math.round(st.mtimeMs) : null, interrupted: false };
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

// Last event time in a transcript (.jsonl) file: the newest line's `timestamp`, else the file's mtime.
function lastEventTime(file) {
  const i = tailInfo(file);
  return i ? i.t : null;
}

class Fleet {
  constructor(sessionId, onChange) {
    this.sessionId = sessionId;
    this.onChange = onChange; // () => void (debounced by the caller)
    this.agents = new Map(); // toolUseId → Agent
    this._ctxPeak = new Map(); // toolUseId → biggest request total seen (proves a 1M window past 200k)
    this.taskToTool = new Map(); // task_id (= Claude Code agentId for agents) → toolUseId
    this.outputFiles = new Map(); // toolUseId → output_file path from an async launch result
    this.projectsDir = null; // override for tests; default ~/.claude/projects (or HELM_CLAUDE_PROJECTS)
    this.sessionDir = null; // () => "<projects>/<slug>/<claudeSessionId>" (set by the session) or null
    this.interruptAt = null; // when Helm last interrupted this session's turn (sessions.interrupt)
    this._sweepTimer = null;
  }

  // Running agents that have shown no sign of life for AGENT_QUIET_MS (Session.agentsQuiet).
  quietCount() {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === 'running' && a.quiet === true) n++;
    return n;
  }

  // lane steer: the agents an interrupt would stop right now (Claude Code stops EVERY running agent of the
  // session), top-level first: [{ id, name, background }]. `name` is what the user reads in "Stop also stops 2
  // agents: guard, recap": the "[lane:x]" tag ("guard"), else the description, else the subagent type.
  runningAgents() {
    const out = [];
    for (const a of this.agents.values()) if (a.status === 'running') out.push(a);
    out.sort((x, y) => (x.depth || 0) - (y.depth || 0) || (x.startedAt || 0) - (y.startedAt || 0));
    return out.map((a) => ({ id: a.id, name: agentShortName(a), background: !!a.background }));
  }

  // A sign of life for a running agent at time t. Changes only lastActivityAt (no event of its own) unless it
  // ends a quiet spell; returns true when `quiet` was cleared (the caller emits).
  _touch(a, t = Date.now()) {
    if (!a || a.status !== 'running' || !isNum(t)) return false;
    if (!isNum(a.lastActivityAt) || t > a.lastActivityAt) a.lastActivityAt = t;
    if (a.quiet === true) { delete a.quiet; return true; }
    return false;
  }

  // Helm interrupted the turn: agents Claude Code stops in the next INTERRUPT_WINDOW_MS were stopped by it.
  // A sweep shortly after catches any agent whose transcript got the interrupt marker but no task event.
  onInterrupt(t = Date.now()) {
    this.interruptAt = t;
    clearTimeout(this._sweepTimer);
    this._sweepTimer = setTimeout(() => { this._sweepTimer = null; this.sweep(); }, SWEEP_AFTER_INTERRUPT_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  _interruptedRecently(now = Date.now()) {
    return isNum(this.interruptAt) && now - this.interruptAt >= -1000 && now - this.interruptAt <= INTERRUPT_WINDOW_MS;
  }

  dispose() {
    clearTimeout(this._sweepTimer);
    this._sweepTimer = null;
  }

  // An agent's own transcript: <projects>/<slug>/<claudeSessionId>/subagents/agent-<agentId>.jsonl, from the
  // session's directory when known, else the path async launches revealed (_endProbeFiles).
  _ownFiles(a) {
    const out = [];
    let dir = null;
    try { dir = typeof this.sessionDir === 'function' ? this.sessionDir() : this.sessionDir; } catch {}
    if (a.agentId && dir) out.push(path.join(dir, 'subagents', `agent-${a.agentId}.jsonl`));
    for (const f of this._endProbeFiles(a)) if (!out.includes(f)) out.push(f);
    return out;
  }

  // tailInfo, re-read only when the file's size or mtime changed since the last sweep (a stat per agent per tick).
  _tailCached(f) {
    let st = null;
    try { st = fs.statSync(f); } catch { this._tails && this._tails.delete(f); return null; }
    const c = (this._tails || (this._tails = new Map())).get(f);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.info;
    const info = tailInfo(f);
    this._tails.set(f, { size: st.size, mtimeMs: st.mtimeMs, info });
    return info;
  }

  // Every running agent: its own transcript's tail. The interrupt marker as its newest line (written after this
  // run started) stops it ("interrupted"); otherwise the newest line's time is a sign of life. No sign of life
  // for AGENT_QUIET_MS → quiet. Returns true when anything changed (and emits).
  sweep(now = Date.now()) {
    let changed = false;
    for (const a of this.agents.values()) {
      if (a.status !== 'running') continue;
      const from = isNum(a.resumedAt) ? a.resumedAt : a.startedAt;
      for (const f of this._ownFiles(a)) {
        const info = this._tailCached(f);
        if (!info || !isNum(info.t)) continue;
        if (isNum(from) && info.t < from - 1000) break;   // nothing written in this run yet
        if (info.interrupted) {
          this._end(a, 'stopped', info.t, false, 'interrupted');
          changed = true;
        } else if (!isNum(a.lastActivityAt) || info.t > a.lastActivityAt) a.lastActivityAt = info.t;
        break;
      }
      if (a.status !== 'running') continue;
      const last = isNum(a.lastActivityAt) ? a.lastActivityAt : from;
      const quiet = isNum(last) && now - last >= AGENT_QUIET_MS;
      if (quiet !== (a.quiet === true)) {
        if (quiet) a.quiet = true;
        else delete a.quiet;
        changed = true;
      }
    }
    if (changed) this.onChange();
    return changed;
  }

  isAgentTool(name) {
    return AGENT_TOOLS.has(name);
  }

  list() {
    return [...this.agents.values()];
  }

  // Agents genuinely running now (the session's agentsRunning).
  runningCount() {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === 'running') n++;
    return n;
  }

  _byAgentId(hex) {
    const t = hex && this.taskToTool.get(hex);
    return (t && this.agents.get(t)) || null;
  }

  _learnAgentId(a, hex) {
    if (!hex || typeof hex !== 'string') return;
    a.agentId = hex;
    this.taskToTool.set(hex, a.id);
  }

  // Back to running (SendMessage resume / task_started on a stopped agent). The finished run
  // moves to `runs` so durations and the timeline's peak count only the time it really ran.
  _resume(a, t) {
    if (a.status === 'running') return false;
    const prevStart = isNum(a.resumedAt) ? a.resumedAt : a.startedAt;
    if (isNum(prevStart) && isNum(a.endedAt)) {
      (a.runs || (a.runs = [])).push({ startedAt: prevStart, endedAt: a.endedAt, ...(a.endEstimated ? { estimated: true } : {}) });
    }
    a.status = 'running';
    a.resumedAt = isNum(t) ? t : Date.now();
    a.lastActivityAt = a.resumedAt;
    a.background = true;
    delete a.endedAt;
    delete a.endEstimated;
    delete a.stopReason;
    delete a.quiet;
    return true;
  }

  // reason (status "stopped" only): 'interrupted' | 'closed' | 'exited'. Live ends Claude Code reports as
  // killed/stopped right after Helm's own interrupt pass `live: true` and get 'interrupted'.
  _end(a, status, t, estimated = false, reason = null, live = false) {
    a.status = status;
    if (isNum(t)) a.endedAt = t;
    else delete a.endedAt;
    if (estimated) a.endEstimated = true;
    else delete a.endEstimated;
    delete a.quiet;
    const why = status !== 'stopped' ? null : live && this._interruptedRecently() ? 'interrupted' : reason;
    if (why) a.stopReason = why;
    else delete a.stopReason;
  }

  onToolStart(item) {
    if (AGENT_TOOLS.has(item.name)) {
      if (this.agents.has(item.toolUseId)) return;
      const parent = item.parentToolUseId ? this.agents.get(item.parentToolUseId) : null;
      const input = item.input || {};
      this.agents.set(item.toolUseId, {
        id: item.toolUseId,
        sessionId: this.sessionId,
        parentId: item.parentToolUseId || null,
        depth: parent ? parent.depth + 1 : 0,
        description: input.description || '',
        subagentType: input.subagent_type || null,
        model: input.model || null,
        status: item.status === 'running' ? 'running' : item.status === 'error' ? 'error' : 'done',
        startedAt: item.startedAt || item.ts,
        context: null,
        toolCount: 0,
        lastTool: null,
        background: !!input.run_in_background,
      });
      this.onChange();
      return;
    }
    const a = item.parentToolUseId && this.agents.get(item.parentToolUseId);
    if (a) {
      a.toolCount += 1;
      a.lastTool = item.name;
      this._touch(a, isNum(item.startedAt) ? item.startedAt : isNum(item.ts) ? item.ts : Date.now());
      this.onChange();
    }
  }

  // SDK tool_progress (a tool still running; heartbeats included): a sign of life for the agent running it.
  onToolProgress(msg) {
    if (!msg) return;
    const a = (msg.parent_tool_use_id && this.agents.get(msg.parent_tool_use_id)) || this._byAgentId(msg.task_id);
    if (a && this._touch(a)) this.onChange();
  }

  // The Agent tool_use input arrives complete only with the final assistant message.
  onToolInput(item) {
    const a = this.agents.get(item.toolUseId);
    if (!a || !item.input) return;
    a.description = item.input.description || a.description;
    a.subagentType = item.input.subagent_type || a.subagentType;
    a.model = item.input.model || a.model;
    a.background = !!item.input.run_in_background || a.background;
    this.onChange();
  }

  // structured: the tool_use_result (a finished Agent carries totalToolUseCount, the CLI's own
  // final count; in-flight task_progress counts can run ahead of it; an async launch carries agentId).
  // fromHistory: a transcript item (no live clock: a missing endedAt stays unknown, never "now").
  onToolEnd(item, structured = null, fromHistory = false) {
    if (item.name === 'SendMessage') return this._onSendMessage(item, structured, fromHistory);
    const a = this.agents.get(item.toolUseId);
    if (!a) {
      const p = !fromHistory && item.parentToolUseId && this.agents.get(item.parentToolUseId);
      if (p && this._touch(p)) this.onChange();
      return;
    }
    if (structured && typeof structured.totalToolUseCount === 'number') a.toolCount = structured.totalToolUseCount;
    const text = resultText(item);
    this._learnAgentId(a, (structured && typeof structured.agentId === 'string' && structured.agentId) || (AGENT_ID_RE.exec(text.slice(0, 4000)) || [])[1]);
    const out = OUTPUT_RE.exec(text.slice(0, 4000));
    if (out) this.outputFiles.set(a.id, out[1]);
    // A background agent's tool call returns at launch; it ends on task_notification.
    const launchedOnly = a.background || (structured && structured.status === 'async_launched') ||
      /async agent launched|running in the background|launched successfully/i.test(text.slice(0, 400));
    if (item.status !== 'done' || !launchedOnly) {
      // Stopped by the user / a session close, or no result recorded because the CLI went away: not a failure.
      const stopped = item.interrupted === true || (fromHistory && item.status !== 'done' && !isNum(item.endedAt));
      const status = item.status === 'done' ? 'done' : stopped ? 'stopped' : 'error';
      // History: interrupted = a "[Request interrupted by user…]" line stopped it. Live: Helm's interrupt, else a close.
      const why = item.interrupted === true ? (fromHistory ? 'interrupted' : 'closed') : null;
      this._end(a, status, isNum(item.endedAt) ? item.endedAt : fromHistory ? null : Date.now(), false, why, !fromHistory);
    } else {
      a.background = true;
      // Replayed launch (onToolStart saw the item's final "done"): it runs until its notification.
      if (fromHistory) { a.status = 'running'; delete a.endedAt; }
    }
    this.onChange();
  }

  // SendMessage → an agent: `resumedAgentId` means a stopped agent runs again.
  _onSendMessage(item, structured, fromHistory) {
    if (item.status !== 'done') return;
    const hex = (structured && typeof structured.resumedAgentId === 'string' && structured.resumedAgentId) ||
      (RESUMED_RE.exec(resultText(item).slice(0, 2000)) || [])[1];
    const a = this._byAgentId(hex);
    if (!a) return;
    const t = isNum(item.endedAt) ? item.endedAt : isNum(item.ts) ? item.ts : fromHistory ? null : Date.now();
    if (this._resume(a, t)) this.onChange();
  }

  onUsage(parentToolUseId, usage, model) {
    const a = parentToolUseId && this.agents.get(parentToolUseId);
    if (!a || !usage) return;
    const used = usedTokensOf(usage);
    if (!used) return;
    // Same numbers as ~/.claude/tools/agent-context.js: the latest request's total over the window, where a
    // request past 200k seen earlier in this agent proves a 1M window (_ctxPeak lives off the protocol object).
    const peak = Math.max(this._ctxPeak.get(a.id) || 0, used);
    this._ctxPeak.set(a.id, peak);
    a.context = contextFrom(usage, model || a.model, peak);
    this._touch(a);
    this.onChange();
  }

  // A task event names its agent by tool_use_id (the Agent call) and task_id (the agentId). A resumed
  // agent's events may carry a different tool_use_id (the SendMessage call), so an unknown tool_use_id
  // falls back to the task_id, and never re-points the task_id away from its agent.
  _agentForTask(msg) {
    const byTool = msg.tool_use_id && this.agents.get(msg.tool_use_id);
    if (byTool) {
      if (msg.task_id) this._learnAgentId(byTool, msg.task_id);
      return byTool;
    }
    return this._byAgentId(msg.task_id);
  }

  onTask(msg) {
    const a = this._agentForTask(msg);
    if (!a) return;
    if (msg.subtype === 'task_started') {
      if (msg.is_backgrounded) a.background = true;
      if (msg.subagent_type && !a.subagentType) a.subagentType = msg.subagent_type;
      if (a.status !== 'running') this._resume(a, Date.now());
    } else if (msg.subtype === 'task_progress') {
      this._touch(a);
      if (msg.last_tool_name) a.lastTool = msg.last_tool_name;
      if (msg.usage && msg.usage.tool_uses > a.toolCount) a.toolCount = msg.usage.tool_uses;
      if (!a.context && msg.usage && msg.usage.total_tokens) {
        const windowTokens = windowFor(a.model);
        a.context = { usedTokens: msg.usage.total_tokens, windowTokens, percent: Math.round((msg.usage.total_tokens / windowTokens) * 1000) / 10, estimated: true };
      }
    } else if (msg.subtype === 'task_updated') {
      const st = msg.patch && msg.patch.status;
      if (st === 'completed' || st === 'failed' || st === 'killed') this._end(a, endStatus(st), (msg.patch && msg.patch.end_time) || Date.now(), false, null, true);
    } else if (msg.subtype === 'task_notification') {
      // The killed task_updated came first: keep its end time (the notification only confirms it).
      const keepEnd = a.status !== 'running' && isNum(a.endedAt) && endStatus(msg.status) === a.status;
      this._end(a, endStatus(msg.status), keepEnd ? a.endedAt : Date.now(), false, keepEnd ? a.stopReason || null : null, !keepEnd);
      if (msg.usage && msg.usage.tool_uses > a.toolCount) a.toolCount = msg.usage.tool_uses;
    }
    this.onChange();
  }

  // Session ended / CLI died: nothing is running any more. Background agents run inside the CLI
  // process, so they stop with it too ("stopped": no completion record, not a failure).
  // reason: why the CLI went away ('closed' by Helm / the user, 'exited' on its own); an interrupt just before wins.
  stopAll(status = 'error', reason = null) {
    let changed = false;
    const now = Date.now();
    for (const a of this.agents.values()) {
      if (a.status === 'running') {
        this._end(a, a.background ? 'stopped' : status, now, false, reason, true);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  // Transcript notification item (normalizer: "Background task <status>: Agent "<desc>" …"). Prefers
  // explicit `taskToolUseId` / `taskStatus` fields when the normalizer provides them.
  _historyNotification(it, keep) {
    let a = null, status = it.taskStatus || null;
    if (it.taskToolUseId) a = this.agents.get(it.taskToolUseId) || null;
    if (!a) {
      const m = NOTIF_RE.exec(String(it.text || ''));
      if (!m) return;
      status = status || m[1];
      const desc = norm(m[2]);
      for (const x of this.agents.values()) {
        if (norm(x.description) !== desc || keep.has(x.id)) continue;
        if (isNum(x.startedAt) && isNum(it.ts) && x.startedAt > it.ts) continue;
        if (x.status === 'running' || !a) a = x;   // the latest running one with that description
      }
    }
    if (!a || keep.has(a.id)) return;
    this._end(a, endStatus(status), isNum(it.ts) ? it.ts : null);
  }

  // Where an agent's own transcript lives: <projects>/<slug>/<claudeSessionId>/subagents/agent-<id>.jsonl.
  // The slug and session id come from any async launch's output_file (…\<slug>\<sessionId>\tasks\<id>.output).
  _endProbeFiles(a) {
    const files = [];
    let dirParts = null;
    for (const p of [this.outputFiles.get(a.id), ...this.outputFiles.values()]) {
      if (!p) continue;
      const parts = String(p).split(/[\\/]+/);
      const ti = parts.lastIndexOf('tasks');
      if (ti >= 2) { dirParts = [parts[ti - 2], parts[ti - 1]]; break; }
    }
    if (a.agentId && dirParts) {
      const root = this.projectsDir || defaultProjectsDir();
      files.push(path.join(root, dirParts[0], dirParts[1], 'subagents', `agent-${a.agentId}.jsonl`));
    }
    if (this.outputFiles.get(a.id)) files.push(this.outputFiles.get(a.id));
    return files;
  }

  // { t, interrupted } from the agent's own transcript tail (this run), or null.
  _probeTail(a) {
    const from = isNum(a.resumedAt) ? a.resumedAt : a.startedAt;
    for (const f of this._ownFiles(a)) {
      const info = tailInfo(f);
      if (info && isNum(info.t) && (!isNum(from) || info.t >= from)) return info;
    }
    return null;
  }

  _probeEnd(a) {
    const info = this._probeTail(a);
    return info ? info.t : null;
  }

  // Rebuild from history items (resumed / old sessions, or an older page loaded). Agents already
  // tracked keep their live state; the rest are replayed from the transcript.
  rebuild(items) {
    const prev = this.agents;
    const keep = new Set();
    this.agents = new Map();
    const quiet = this.onChange;
    this.onChange = () => {};
    try {
      for (const it of items || []) {
        if (!it) continue;
        if (it.type === 'system') {
          this._historyNotification(it, keep);
          continue;
        }
        if (it.type !== 'tool') continue;
        if (AGENT_TOOLS.has(it.name) && prev.has(it.toolUseId)) {
          if (!this.agents.has(it.toolUseId)) {
            this.agents.set(it.toolUseId, prev.get(it.toolUseId));
            keep.add(it.toolUseId);
          }
          continue;
        }
        if (it.parentToolUseId && keep.has(it.parentToolUseId)) continue;   // live counts already include it
        if (it.name === 'SendMessage') {
          const hex = (RESUMED_RE.exec(resultText(it).slice(0, 2000)) || [])[1];
          const target = this._byAgentId(hex);
          if (target && keep.has(target.id)) continue;
        }
        this.onToolStart(it);
        if (it.status !== 'running') this.onToolEnd(it, null, true);
      }
      // Anything tracked live but absent from these items stays.
      for (const [id, a] of prev) if (!this.agents.has(id)) this.agents.set(id, a);
      // A replayed agent with no completion record was stopped when an earlier CLI exited (live agents
      // are the kept ones). Its end: the last event in its own transcript, else unknown.
      for (const a of this.agents.values()) {
        if (keep.has(a.id)) continue;
        if (a.status === 'running' && a.background) {
          // The interrupt marker as its last line: stopped by an interrupt, at that exact time.
          const info = this._probeTail(a);
          const t = info ? info.t : null;
          this._end(a, 'stopped', t, isNum(t) && !info.interrupted, info && info.interrupted ? 'interrupted' : null);
        } else if (a.status !== 'running' && !isNum(a.endedAt)) {
          const t = this._probeEnd(a);
          if (isNum(t)) { a.endedAt = t; a.endEstimated = true; }
        }
      }
    } finally {
      this.onChange = quiet;
    }
    this.onChange();
  }
}

// ---------- context hand-off alerts ----------
// The user's rule: a subagent hands off at 32% of its context window and never crosses 40%.
// ContextAlerts watches fleet lists (the `fleet.updated` payload) and calls notify() ONCE per
// agent per threshold: first at 32% ("hand it off"), again at 40% ("over the ceiling").
// An agent first seen already past 40% gets only the 40% alert. With enabled() false the
// crossings are still recorded silently, so switching the setting back on never replays old ones.
// The numbers come from ui/lib/context-limits.js, the one place they live.
const CONTEXT_HANDOFF = CONTEXT_HANDOFF_PCT;
const CONTEXT_CEILING = CONTEXT_CEILING_PCT;

// "Agent 'lane:x'" from a "[lane:x] …" description (the user's briefs start with a unique lane tag), else
// "Agent '<description>'", else "Agent '<subagentType>'", else "An agent".
function agentLabel(a) {
  const d = String((a && a.description) || '').replace(/\s+/g, ' ').trim();
  const lane = /^\[(lane:[^\]]+)\]/.exec(d);
  const name = lane ? lane[1] : d || String((a && a.subagentType) || '').trim();
  return name ? `Agent '${name.length > 60 ? name.slice(0, 59) + '…' : name}'` : 'An agent';
}

// lane steer: a short name for confirms and Helm's note to Claude ("guard", "Add autocorrect everywhere in Quartz").
function agentShortName(a) {
  const d = String((a && a.description) || '').replace(/\s+/g, ' ').trim();
  const lane = /^\[lane:([^\]]+)\]/.exec(d);
  const name = lane ? lane[1].trim() : d || String((a && a.subagentType) || '').trim() || 'agent';
  return name.length > 48 ? name.slice(0, 47) + '…' : name;
}

class ContextAlerts {
  // notify(n): n = { title, body, sessionId, kind, source: 'context', agentId, threshold }
  // enabled(): settings.notifyContextHandoff; sessionTitle(id): optional, names the session in the body
  constructor({ notify, enabled = () => true, sessionTitle = () => null } = {}) {
    this.notify = notify;
    this.enabled = enabled;
    this.sessionTitle = sessionTitle;
    this.fired = new Map(); // `${sessionId}\n${agentId}` -> highest threshold already alerted (32 | 40)
  }

  check(sessionId, agents) {
    const out = [];
    for (const a of Array.isArray(agents) ? agents : []) {
      if (!a || !a.id || a.status !== 'running') continue;
      const pct = a.context && Number(a.context.percent);
      if (!Number.isFinite(pct) || pct < CONTEXT_HANDOFF) continue;
      const key = sessionId + '\n' + a.id;
      const prev = this.fired.get(key) || 0;
      const threshold = pct >= CONTEXT_CEILING ? CONTEXT_CEILING : CONTEXT_HANDOFF;
      if (threshold <= prev) continue;
      this.fired.set(key, threshold);
      let on = true;
      try { on = this.enabled() !== false; } catch { on = true; }
      if (!on) continue;
      const shown = Math.floor(pct);
      const title = threshold === CONTEXT_CEILING
        ? `${agentLabel(a)} is at ${shown}% context — over the ${CONTEXT_CEILING}% ceiling`
        : `${agentLabel(a)} is at ${shown}% context — hand it off`;
      let st = null;
      try { st = this.sessionTitle(sessionId); } catch {}
      const body = (st ? `In "${st}". ` : '') + (threshold === CONTEXT_CEILING
        ? 'Stop it and continue with a fresh agent.'
        : `Hand off now; never cross ${CONTEXT_CEILING}%.`);
      const n = { title, body, sessionId, kind: threshold === CONTEXT_CEILING ? 'error' : 'waiting', source: 'context', agentId: a.id, threshold };
      out.push(n);
      try { this.notify && this.notify(n); } catch {}
    }
    return out;
  }

  forget(sessionId) {
    for (const k of this.fired.keys()) if (k.startsWith(sessionId + '\n')) this.fired.delete(k);
  }
}

module.exports = { Fleet, AGENT_TOOLS, lastEventTime, tailInfo, endStatus, ContextAlerts, CONTEXT_HANDOFF, CONTEXT_CEILING, agentShortName };
