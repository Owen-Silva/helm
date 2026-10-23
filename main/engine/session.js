'use strict';
// One Helm session = one Claude Code conversation. Owns (lazily) one SDK query() in
// streaming-input mode, the session's items, its pending requests, its prompt queue and its
// fleet. The CLI starts on first send (or when commands are asked for) and can be closed and
// resumed (resume: claudeSessionId) any number of times.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { Normalizer, cleanErrorText } = require('./normalize');
const { Fleet, AGENT_TOOLS } = require('./fleet');
const { createScheduleTracker } = require('./schedules');
const { findTranscript, readLines, lastCostState } = require('./transcript');
const { TranscriptPager, StitchedPager, findLineByUuid } = require('./pager');
const { readEta, watchEta } = require('./eta');
const { EDIT_TOOLS } = require('./changes');
const { PushStream, rid, baseName, oneLine, truncate, titleFromPrompt, contextFrom, learnWindow, debounce } = require('./util');
const shellRun = require('./shell-run');
const prodGuard = require('./prod-guard');
const steer = require('./steer'); // lane steer: mid-turn messages + explicit Stop
const { RESUME_PROMPT } = require('../../ui/lib/stall-limits.js'); // lane restart: Continue sends the same words as stall Resume

const { keepCompat, reinitProblem } = require('./keep-compat'); // lane detach: may a relaunched Helm re-attach to a kept CLI
const { TaskLog } = require('./task-log'); // lane logs: task_* / background_tasks_changed log lines (summary at info, JSON at debug)

const PUBLIC_FIELDS = ['id', 'claudeSessionId', 'title', 'cwd', 'project', 'status', 'model', 'effort', 'permissionMode', 'createdAt', 'updatedAt', 'costUsd', 'context', 'activity', 'turnStartedAt', 'unread', 'queued', 'pinned', 'eta', 'archived', 'lastText', 'resumedAt', 'restartNote'];
// lane restart: Session.restartNote = { at, cause: 'restart'|'quit', working, waiting, agents: [{ id, agentId, name }],
// tasks: [{ type, description }], shells, queued } — what the last Helm shutdown cut off (docs/PROTOCOL.md
// "Restart note"). Kept at most this long if the user never acts on it.
const RESTART_NOTE_MAX_AGE_MS = 3 * 24 * 3600_000;
const RESTART_NOTE_MAX_LIST = 20;
const isRestartNote = (n) => !!n && typeof n === 'object' && typeof n.at === 'number' && Number.isFinite(n.at);
const APPEND_FLUSH_MS = 40;
const INITIAL_ITEMS = 300; // items parsed from the transcript tail when a session is opened
// Deck summary (Session.lastText / Session.pendingRequest): tile-sized, so a Deck never loads histories.
const LAST_TEXT_MAX = 280;
// A send to a session unused for this long picks it back up from the sidebar's Past: it gets
// resumedAt, and the sidebar orders the active list by `resumedAt || createdAt` (start order). Mirrors
// ACTIVE_WINDOW_MS in ui/lib/session-activity.js.
const RESUME_GAP_MS = 60 * 60 * 1000;
const SUMMARY_STREAM_MS = 400; // while a reply streams, lastText reaches session.updated at most this often

// The tail of an assistant reply as one line: the end of a reply is its conclusion (and, while streaming,
// the newest words). Markdown punctuation is left in; the UI strips what it renders.
function tailText(text) {
  // fenced code reads as noise on a tile: keep the prose around it (an unclosed fence = still streaming)
  const t = oneLine(String(text || '').replace(/```[\s\S]*?(?:```|$)/g, ' ')) || oneLine(text);
  if (t.length <= LAST_TEXT_MAX) return t || null;
  const cut = t.slice(t.length - (LAST_TEXT_MAX - 1));
  const sp = cut.indexOf(' ');
  return '…' + (sp > 0 && sp < 40 ? cut.slice(sp + 1) : cut);
}

// The common simple question a Deck tile answers in one click: exactly ONE question, single-select,
// 2-4 options. `question` and each `label` are exact (they key the answer); descriptions are tile-sized.
function simpleChoice(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0] || {};
  if (q.multiSelect || typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options)) return null;
  if (q.options.length < 2 || q.options.length > 4) return null;
  const options = [];
  for (const o of q.options) {
    const label = o && typeof o.label === 'string' ? o.label : '';
    if (!label.trim()) return null;
    const d = o.description ? truncate(oneLine(o.description), 160) : '';
    options.push(d ? { label, description: d } : { label });
  }
  return { question: q.question, options };
}

// One pending request as a tile line: what is asked and the one detail the user needs to answer it.
function requestSummary(it, count) {
  const i = it.input || {};
  let title;
  let detail = null;
  let choice = null;
  if (it.kind === 'question') {
    const q = (Array.isArray(it.questions) && it.questions[0]) || (Array.isArray(i.questions) && i.questions[0]) || {};
    title = truncate(oneLine(q.question || 'Claude has a question'), 160);
    const opts = Array.isArray(q.options) ? q.options.map((o) => oneLine(o && o.label)).filter(Boolean) : [];
    if (opts.length) detail = truncate(opts.join(' · '), 160);
    choice = simpleChoice(Array.isArray(it.questions) && it.questions.length ? it.questions : i.questions);
  } else if (it.kind === 'plan') {
    title = 'A plan is ready for review';
    const first = String(it.plan || i.plan || '').split('\n').map((l) => l.replace(/^[#>*\-\s\d.]+/, '').trim()).find(Boolean);
    if (first) detail = truncate(first, 160);
  } else {
    title = it.title ? truncate(oneLine(it.title), 160) : `Allow ${it.toolName || 'this tool'}?`;
    const n = it.toolName || '';
    if ((n === 'Bash' || n === 'PowerShell') && i.command) detail = truncate(oneLine(i.command), 160);
    else if (i.file_path || i.notebook_path) detail = String(i.file_path || i.notebook_path);
    else if (i.url) detail = truncate(String(i.url), 160);
    else if (it.description) detail = truncate(oneLine(it.description), 160);
    else detail = truncate(describeTool({ name: n, input: i }), 160);
  }
  return {
    requestId: it.requestId, itemId: it.id, kind: it.kind, toolName: it.toolName || null, title, detail,
    ...(choice ? { choice } : {}),
    ...(it.parentToolUseId ? { parentToolUseId: it.parentToolUseId } : {}),
    count,
  };
}
const isMainText = (it) => it && it.type === 'assistant' && !it.parentToolUseId;
const INTERRUPT_GRACE_MS = 8000;
const STEER_START_MS = 30_000; // lane steer: a mid-turn message left for the next turn must be taken by then
// lane detach: a kept CLI must answer the re-attach (repeated initialize) by then, or Helm falls back
const REINIT_TIMEOUT_MS = Number(process.env.HELM_REINIT_TIMEOUT_MS) > 0 ? Number(process.env.HELM_REINIT_TIMEOUT_MS) : 15_000;
const CLOSE_KILL_GRACE_MS = 1500; // close() with a tool running: claude.exe gets this long to exit on its own

// claude.exe's PID comes from the SDK's onProcessSpawned option (set in _start); its process
// wrapper (private, guarded) says whether it has exited. Neither present means nothing to do.
function cliPid(q) { return (q && q._helmCli && q._helmCli.pid) || null; }
function cliExited(q) {
  const p = q && q.transport && q.transport.process;
  return !!p && (p.exitCode !== null && p.exitCode !== undefined || p.signalCode != null);
}

// Kill the CLI's process tree BY PID if it is still running after `ms` (never by name).
function killAfterGrace(q, ms, log) {
  const pid = cliPid(q);
  if (!pid) return;
  const t = setTimeout(() => {
    if (cliExited(q)) return;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (e) => { if (e && !cliExited(q)) log(`engine: taskkill ${pid} failed: ${e.message}`); });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }, ms);
  if (t.unref) t.unref();
}
const VALID_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);
// Claude session ids are uuids; this also refuses anything that could leave a folder ("../x", "a/b").
const CLAUDE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

// Shape check for a saved pending rewind (sessions.json is on disk, so it is not trusted blindly).
function validForkFrom(f) {
  if (!f || typeof f !== 'object' || typeof f.sourceId !== 'string' || !CLAUDE_ID_RE.test(f.sourceId)) return false;
  if (f.at !== null && (typeof f.at !== 'string' || !f.at || f.at.length > 200)) return false;
  if (f.shownId !== undefined && (typeof f.shownId !== 'string' || !CLAUDE_ID_RE.test(f.shownId))) return false;
  if (f.firstNew !== undefined && !validUuid(f.firstNew)) return false;
  return validMarkers(f.markers);
}
const validUuid = (u) => typeof u === 'string' && u.length > 0 && u.length <= 200;
const validMarkers = (ms) => Array.isArray(ms) && ms.every((m) => m && typeof m === 'object' && typeof m.checkpointId === 'string' && typeof m.text === 'string');

// A conversation rewind that was SENT (its fork exists), kept so history can still show what was
// rewound: { forkId, shownId, firstNew, markers }. History of `forkId` = history of `shownId` (the
// transcript the user was looking at when they rewound, itself possibly stitched), then the markers, then
// forkId's own lines from the prompt `firstNew` on (the lines before it are the copied kept part).
const MAX_REWINDS = 20;
const MAX_PENDING_SHELL = 20; // unshared `!` runs kept per session
const MAX_RUNNING_SHELL = 8;
const SHELL_FLUSH_MS = 100; // live output reaches clients at most this often
const SHELL_PERSIST_TEXT = 64 * 1024; // display text saved for a pending run (Claude's copy is in stdout/stderr)
const SHELL_ITEM_RE = /^sh_[0-9a-f]{4,32}$/;
function validPendingShell(it) {
  return !!it && typeof it === 'object' && it.type === 'shell' && typeof it.id === 'string' && SHELL_ITEM_RE.test(it.id) && typeof it.command === 'string' && it.command.length <= 100_000 && !it.shared;
}
function validRewind(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.forkId !== 'string' || !CLAUDE_ID_RE.test(r.forkId)) return false;
  if (typeof r.shownId !== 'string' || !CLAUDE_ID_RE.test(r.shownId) || r.shownId === r.forkId) return false;
  return validUuid(r.firstNew) && validMarkers(r.markers);
}

function describeTool(it) {
  const i = it.input || {};
  const n = it.name || '';
  const base = (p) => baseName(p) || p;
  switch (n) {
    case 'Bash':
    case 'PowerShell':
      return i.description ? oneLine(i.description) : i.command ? 'Running ' + truncate(oneLine(i.command), 60) : 'Running a command';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${base(i.file_path || i.notebook_path || 'a file')}`;
    case 'Write':
      return `Writing ${base(i.file_path || 'a file')}`;
    case 'Read':
      return `Reading ${base(i.file_path || 'a file')}`;
    case 'Grep':
      return i.pattern ? `Searching for ${truncate(oneLine(i.pattern), 50)}` : 'Searching';
    case 'Glob':
      return i.pattern ? `Finding ${truncate(i.pattern, 50)}` : 'Finding files';
    case 'WebFetch':
      try {
        return `Fetching ${new URL(i.url).host}`;
      } catch {
        return 'Fetching a page';
      }
    case 'WebSearch':
      return i.query ? `Searching the web for ${truncate(oneLine(i.query), 50)}` : 'Searching the web';
    case 'Agent':
    case 'Task':
      return i.description ? `Agent: ${truncate(oneLine(i.description), 60)}` : 'Running an agent';
    case 'TodoWrite':
      return 'Updating the todo list';
    case 'AskUserQuestion':
      return 'Asking you a question';
    case 'ExitPlanMode':
      return 'Presenting a plan';
    case 'Skill':
      return `Running skill ${i.skill || i.command || ''}`.trim();
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(n);
      if (m) return `${m[1]}: ${m[2]}`;
      return n ? `Using ${n}` : 'Working';
    }
  }
}

class EngineSession {
  constructor(engine, data) {
    this.engine = engine; // { emit, log, loadSdk, claudePath, usage, userDataDir, save, projectsDir }
    this.s = data;
    this.items = [];
    this.byId = new Map();
    this.seq = 0;
    this.loaded = false;
    this.loading = null;
    this.silent = false;
    this.q = null;
    this.input = null;
    this.starting = null;
    this.turnActive = false;
    this.pendingQueue = []; // [{ item, content }]
    this.steering = new Map(); // lane steer: uuid → item id, sent into a running turn and not taken by Claude yet
    this.stopNote = null; // lane steer: { at, agents: [{ id, name }] } an explicit Stop ended; told to Claude with the next message
    // lane restart: what the last Helm shutdown cut off here (Session.restartNote, saved in sessions.json until the user
    // continues, sends anything, or dismisses it). Claude is told with the next message, the same way as stopNote.
    if (data.restartNote && !(isRestartNote(data.restartNote) && Date.now() - data.restartNote.at < RESTART_NOTE_MAX_AGE_MS)) delete data.restartNote;
    if (data.restartNote) this.stopNote = { cause: 'restart', cut: data.restartNote };
    this.turnAnchor = null; // uuid of the current turn's last main-thread message (see _recordResult)
    this.requests = new Map(); // requestId → { resolve, item, input, kind, toolUseId, opts }
    this.allowAlways = new Set();
    this.running = []; // tool item ids, start order
    this.streamingKind = null;
    this.stderrTail = [];
    this.closing = false;
    this.interrupting = false;
    this.procCostBase = null; // see _onResultCost
    this.procCostFork = null;
    this.prePlanMode = null;
    // A conversation rewind not yet taken up by a CLI lives in `s.forkFrom` (saved in sessions.json):
    // { sourceId, at, markers: [{ checkpointId, files, conversation, text, ts }] }. The next start
    // forks `sourceId` at `at`; until then history is the source transcript plus the markers.
    if (data.forkFrom !== undefined && !validForkFrom(data.forkFrom)) delete data.forkFrom;
    // Sent rewinds (validRewind) live in `s.rewinds`, also saved in sessions.json.
    if (data.rewinds !== undefined) {
      const ok = Array.isArray(data.rewinds) ? data.rewinds.filter(validRewind).slice(-MAX_REWINDS) : [];
      if (ok.length) data.rewinds = ok;
      else delete data.rewinds;
    }
    // `!` runs Claude has not seen yet (sessions.shell): saved in sessions.json as `pendingShell`, put
    // back at the end of the transcript by ensureLoaded(), sent with the next prompt (_pushToCli).
    if (data.pendingShell !== undefined) {
      const ok = Array.isArray(data.pendingShell) ? data.pendingShell.filter(validPendingShell).slice(-MAX_PENDING_SHELL) : [];
      if (ok.length) data.pendingShell = ok;
      else delete data.pendingShell;
    }
    this.shells = new Map(); // shell item id → { proc, out, err, buf, timer, stopped } while it runs
    // Background work inside the CLI that is not an agent (Bash run_in_background, Monitor, workflows,
    // MCP tasks): task_id → { type, description, since }. Live only; cleared when the CLI exits.
    // Edges (task_started / task_notification / task_updated) until the CLI sends its first
    // background_tasks_changed; from then on that level signal alone (REPLACE semantics), so a missed
    // or late edge can never wedge a task as running. Agents are the fleet's (agentsRunning).
    this.openTasks = new Map();
    this.openTasksSent = 0;
    this.agentsRunningSent = 0;
    this.agentsQuietSent = 0;
    this.tasksLevel = false;
    // lane restart: the agents the CLI itself lists as running (local_agent in its background_tasks_changed
    // level signal). The restart gate counts max(fleet, this), so an agent the fleet lost track of still blocks.
    this.cliAgents = new Map(); // task_id (= agentId) -> description
    // lane reaper: /loop ScheduleWakeup + CronCreate jobs due inside the current CLI (schedules.js; idle reaper only)
    this.schedules = createScheduleTracker();
    this.pager = null; // TranscriptPager over the transcript this session was opened from (older pages)
    this.initInfo = null;
    this.appendBuf = new Map();
    this.appendTimer = null;
    this.fleet = new Fleet(data.id, debounce(() => {
      this.engine.emit('fleet.updated', { sessionId: this.s.id, agents: this.fleet.list() });
      // lane fleet: Session.agentsRunning follows the fleet (a session with agents running reads as working)
      if (this.fleet.runningCount() !== this.agentsRunningSent || this.fleet.quietCount() !== this.agentsQuietSent) this._emitUpdated();
    }, 120));
    // lane stall: where this session's agents write their own transcripts (fleet.sweep reads their tails)
    this.fleet.sessionDir = () => { const f = this.s.claudeSessionId && findTranscript(this.s.claudeSessionId, this.s.cwd, this.engine.projectsDir); return f ? f.replace(/\.jsonl$/, '') : null; };
    // The *Sent counters record what was last EMITTED, so publicSession() (sessions.list, persistence, a test) never
    // swallows the change edge that the fleet / openTasks watchers compare against.
    this._emitUpdated = debounce(() => {
      const pub = this.publicSession();
      this.agentsRunningSent = pub.agentsRunning;
      this.agentsQuietSent = pub.agentsQuiet;
      this.openTasksSent = pub.openTasks;
      this.engine.emit('session.updated', pub);
    }, 60);
    this.norm = this._makeNormalizer();
    this.etaWatch = null;
    this.summaryTimer = null; // throttles lastText while a reply streams (_noteText)
    // Last eta snapshot (the user's eta mod) even while no CLI runs; watched live only while one does.
    this.s.eta = data.claudeSessionId && engine.etaDir !== false ? readEta(data.claudeSessionId, engine.etaDir) : null;
  }

  // ---------- eta (mods-data/eta/<claudeSessionId>.json) ----------
  _watchEta() {
    const cid = this.s.claudeSessionId;
    if (this.etaWatch && this.etaWatch.cid === cid) return;
    this._stopEta();
    if (!cid || this.engine.etaDir === false) return;
    try {
      const w = watchEta({
        claudeSessionId: cid,
        etaDir: this.engine.etaDir,
        log: this.engine.log,
        onChange: (eta) => {
          if (this.s.claudeSessionId !== cid) return;
          this.s.eta = eta;
          this._emitUpdated();
        },
      });
      w.cid = cid;
      this.etaWatch = w;
      const cur = w.current();
      if (JSON.stringify(cur === undefined ? null : cur) !== JSON.stringify(this.s.eta === undefined ? null : this.s.eta)) {
        this.s.eta = cur === undefined ? null : cur;
        this._emitUpdated();
      }
    } catch (e) {
      this.engine.log('warn', `engine: could not watch eta for ${cid}: ${e.message}`);
    }
  }

  _stopEta() {
    if (!this.etaWatch) return;
    try {
      this.etaWatch.stop();
    } catch {}
    this.etaWatch = null;
  }

  // ---------- state + events ----------
  publicSession() {
    const o = {};
    for (const k of PUBLIC_FIELDS) o[k] = this.s[k] === undefined ? null : this.s[k];
    o.pendingRequest = this._pendingSummary();
    o.agentsRunning = this.fleet ? this.fleet.runningCount() : 0;
    o.agentsQuiet = this.fleet ? this.fleet.quietCount() : 0; // lane stall: running, no activity 10m+
    o.stalledSince = this.turnActive && this.stalledSince ? this.stalledSince : null; // lane stall: main/engine/stall.js
    o.openTasks = this.openTasks ? this.openTasks.size : 0;
    return o;
  }

  // ---------- background tasks (see this.openTasks) ----------
  _taskLog() {
    if (!this.taskLogger) {
      const log = (level, msg) => this.engine.log(level, msg);
      const debugOn = () => (typeof this.engine.logEnabled === 'function' ? this.engine.logEnabled('debug') : true);
      this.taskLogger = new TaskLog({ sid: () => this.s.id, log, debugOn });
    }
    return this.taskLogger;
  }

  _noteTask(m) {
    if (!m || !m.task_id) return;
    try { this._taskLog().event(m); } catch {} // a log line never breaks the message path
    if (this.tasksLevel) return;
    if (m.subtype === 'task_started') {
      if (m.task_type === 'local_agent' || m.ambient || m.skip_transcript) return;
      this.openTasks.set(m.task_id, { type: m.task_type || null, description: truncate(oneLine(m.description || ''), 120), since: Date.now() });
    } else if (m.subtype === 'task_notification') this.openTasks.delete(m.task_id);
    else if (m.subtype === 'task_updated') {
      const st = m.patch && m.patch.status;
      if (st === 'completed' || st === 'failed' || st === 'killed' || st === 'stopped') this.openTasks.delete(m.task_id);
      else return;
    } else return;
    this._tasksChanged();
  }

  _noteBackgroundTasks(m) {
    const list = Array.isArray(m && m.tasks) ? m.tasks : [];
    try { this._taskLog().level(list); } catch {}
    this.tasksLevel = true;
    this.cliAgents = new Map(list.filter((t) => t && t.task_id && t.task_type === 'local_agent' && !t.ambient)
      .map((t) => [t.task_id, truncate(oneLine(t.description || ''), 120)]));
    const next = new Map();
    for (const t of list) {
      if (!t || !t.task_id || t.task_type === 'local_agent' || t.ambient) continue;
      next.set(t.task_id, this.openTasks.get(t.task_id) || { type: t.task_type || null, description: truncate(oneLine(t.description || ''), 120), since: Date.now() });
    }
    this.openTasks = next;
    this._tasksChanged();
  }

  _tasksChanged() {
    if (this.openTasks.size !== this.openTasksSent) this._emitUpdated();
  }

  // A new or exited CLI process: its task level starts empty (the SDK sends nothing at startup).
  _resetTasks() {
    this.tasksLevel = false;
    if (this.taskLogger) this.taskLogger.reset();
    this.cliAgents = new Map();
    if (!this.openTasks.size) return;
    this.openTasks = new Map();
    this._tasksChanged();
  }

  // What a restart (or an account recycle) would cut off in this session; null when nothing.
  busyState() {
    const waiting = !!this._pendingSummary() || this.requests.size > 0;
    const b = {
      starting: !!this.starting,
      working: this.turnActive && !waiting,
      waiting,
      compacting: !!this.compacting,
      queued: this.pendingQueue.length,
      // lane restart: the fleet's count, or the CLI's own list of running agents when that is higher (a gate
      // that misses one agent cuts it off). The CLI list is live only (cleared when the CLI exits).
      agents: Math.max(this.fleet ? this.fleet.runningCount() : 0, this.cliAgents ? this.cliAgents.size : 0),
      tasks: this.openTasks.size,
      shells: this.shells.size,
    };
    return Object.values(b).some(Boolean) ? { id: this.s.id, title: this.s.title || null, ...b } : null;
  }

  // ---------- lane restart: the restart note ----------
  // What a Helm shutdown right now cuts off here (the Session.restartNote shape), or null when nothing runs.
  cutOffState(at = Date.now(), cause = 'restart') {
    const b = this.busyState();
    if (!b) return null;
    const agents = [];
    const known = new Set();
    for (const a of this.fleet ? this.fleet.runningAgents() : []) {
      const full = this.fleet.agents.get(a.id);
      const agentId = (full && full.agentId) || null;
      if (agentId) known.add(agentId);
      agents.push({ id: a.id, agentId, name: a.name || 'agent' });
    }
    // agents only the CLI listed (the fleet lost them): named by the CLI's description
    for (const [taskId, description] of this.cliAgents || []) if (!known.has(taskId)) agents.push({ id: null, agentId: taskId, name: description || 'agent' });
    const tasks = [...this.openTasks.values()].map((t) => ({ type: t.type || null, description: t.description || '' }));
    return {
      at, cause: cause === 'quit' ? 'quit' : 'restart',
      working: !!(b.working || b.waiting || b.starting || b.compacting), waiting: !!b.waiting,
      agents: agents.slice(0, RESTART_NOTE_MAX_LIST), agentsTotal: agents.length,
      tasks: tasks.slice(0, RESTART_NOTE_MAX_LIST), shells: b.shells || 0, queued: b.queued || 0,
    };
  }

  // Helm is shutting down: keep what it cuts off for the next start (saved with the session by persist()).
  noteCutOff(at, cause) {
    const cut = this.cutOffState(at, cause);
    if (cut) this.s.restartNote = cut;
    return cut;
  }

  // sessions.continueAfterRestart: "Continue where you left off." as a Helm-written prompt; the restart note
  // rides with it as the <helm-note> (stopNote), naming the stopped agents and their ids for SendMessage.
  async continueAfterRestart() {
    if (!this.s.restartNote) return { action: 'none', reason: 'no_note', message: 'There is nothing to continue: this session has no restart note.' };
    if (this.turnActive || this.starting) return { action: 'none', reason: 'working', message: 'This session is already working again, so nothing was sent.' };
    const r = await this.send({ text: RESUME_PROMPT, origin: 'helm' });
    return { action: 'continued', itemId: (r && r.itemId) || null, prompt: RESUME_PROMPT, message: `Sent "${RESUME_PROMPT}"` };
  }

  // sessions.dismissRestartNote: the card goes; Claude still hears about the restart with the next message.
  dismissRestartNote() {
    if (!this.s.restartNote) return false;
    delete this.s.restartNote;
    this._emitUpdated();
    this.engine.save();
    return true;
  }

  // ---------- Deck summary ----------
  // The oldest request still waiting on the user (live only: requests never survive a restart).
  _pendingSummary() {
    let first = null;
    let count = 0;
    for (const r of this.requests.values()) {
      if (r.item.status !== 'pending') continue;
      count++;
      if (!first) first = r.item;
    }
    return first ? requestSummary(first, count) : null;
  }

  // A main-thread reply changed: keep lastText current. While it streams (`streaming`), the update
  // reaches session.updated at most every SUMMARY_STREAM_MS; a new or finished reply goes with the
  // caller's own touch().
  _noteText(it, streaming) {
    if (!isMainText(it)) return;
    const t = tailText(it.text);
    if (!t || t === this.s.lastText) return;
    this.s.lastText = t;
    if (!streaming || this.silent || this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      this._emitUpdated();
    }, SUMMARY_STREAM_MS);
    if (this.summaryTimer.unref) this.summaryTimer.unref();
  }

  touch(save = true) {
    this.s.updatedAt = Date.now();
    this._emitUpdated();
    if (save) this.engine.save();
  }

  nextId() {
    return 'i' + ++this.seq;
  }

  _flushAppends() {
    if (this.appendTimer) {
      clearTimeout(this.appendTimer);
      this.appendTimer = null;
    }
    if (!this.appendBuf.size) return;
    for (const [itemId, text] of this.appendBuf) {
      this.engine.emit('session.itemUpdate', { sessionId: this.s.id, itemId, patch: {}, appendText: text });
    }
    this.appendBuf.clear();
  }

  _store() {
    const self = this;
    return {
      add(item) {
        self.items.push(item);
        self.byId.set(item.id, item);
        self._noteText(item, false);
        if (self.silent) return;
        self._flushAppends();
        if (item.type !== 'user' && item.type !== 'shell') self.s.unread = (self.s.unread || 0) + 1; // `!` runs are the user's own
        self.engine.emit('session.item', { sessionId: self.s.id, item });
        self.touch(false);
      },
      patch(id, patch, appendText) {
        const it = self.byId.get(id);
        if (!it) return;
        if (patch) Object.assign(it, patch);
        if (appendText) it.text = (it.text || '') + appendText;
        if (isMainText(it) && (appendText || (patch && 'text' in patch))) self._noteText(it, true);
        if (self.silent) return;
        if (patch && Object.keys(patch).length) {
          self._flushAppends();
          self.engine.emit('session.itemUpdate', { sessionId: self.s.id, itemId: id, patch });
        }
        if (appendText) {
          self.appendBuf.set(id, (self.appendBuf.get(id) || '') + appendText);
          if (!self.appendTimer) self.appendTimer = setTimeout(() => self._flushAppends(), APPEND_FLUSH_MS);
        }
      },
      get(id) {
        return self.byId.get(id) || null;
      },
      // A queued prompt is sent only when the turn before it ends: move its item to the end so
      // the transcript order matches what Claude saw (and what the transcript on disk says).
      moveToEnd(id) {
        const i = self.items.findIndex((x) => x.id === id);
        if (i < 0 || i === self.items.length - 1) return;
        self.items.push(...self.items.splice(i, 1));
      },
    };
  }

  // A queued prompt leaves the queue: it moves to the end of the transcript and gets its send time.
  _dequeued(item) {
    this.norm.store.moveToEnd(item.id);
    this.norm.store.patch(item.id, { queued: false, ts: Date.now() });
  }

  // ---------- turn results survive a restart ----------
  // Claude Code's transcript has no result lines, so the "Worked for 28s · $0.12" rows would
  // vanish when a session is rebuilt from disk. Each live result is appended to
  // <userData>/results/<helmId>.jsonl with the uuid of the last main-thread message of its turn
  // (`after`), and ensureLoaded() puts it back after that message.
  _resultsFile() {
    return this.engine.userDataDir ? path.join(this.engine.userDataDir, 'results', `${this.s.id}.jsonl`) : null;
  }

  _recordResult(item) {
    const file = this._resultsFile();
    if (!file || !item || !this.turnAnchor) return;
    const { id, ...rest } = item;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ after: this.turnAnchor, item: rest }) + '\n');
    } catch (e) {
      this.engine.log('warn', `engine: could not record a turn result: ${e.message}`);
    }
  }

  // Put recorded turn results back after the transcript item their turn ended on.
  _mergeResults(items, anchors) {
    if (!anchors || !anchors.size || items.some((it) => it.type === 'result')) return items;
    const byItem = new Map();
    for (const r of this._readResults()) {
      const itemId = anchors.get(r.after);
      if (!itemId) continue;
      if (!byItem.has(itemId)) byItem.set(itemId, []);
      byItem.get(itemId).push(r.item);
    }
    if (!byItem.size) return items;
    const out = [];
    for (const it of items) {
      out.push(it);
      for (const r of byItem.get(it.id) || []) out.push({ ...r, type: 'result', id: this.nextId() });
    }
    return out;
  }

  _readResults() {
    const file = this._resultsFile();
    if (!file) return [];
    try {
      return readLines(file).filter((r) => r && r.after && r.item);
    } catch {
      return [];
    }
  }

  _makeNormalizer() {
    return new Normalizer({
      store: this._store(),
      newId: () => this.nextId(),
      hooks: {
        onInit: (m) => this._onInit(m),
        onResult: (m) => this._onResultCost(m),
        isInterrupting: () => this.interrupting,
        onRateLimit: (info) => this.engine.usage.onRateLimit(info),
        onToolStart: (it) => {
          this.running.push(it.id);
          this.fleet.onToolStart(it);
          this._refreshActivity();
        },
        onToolInput: (it) => {
          if (AGENT_TOOLS.has(it.name)) this.fleet.onToolInput(it);
          if (this.q) this.schedules.onToolInput(it);
          this._refreshActivity();
        },
        onToolEnd: (it, structured) => {
          this.running = this.running.filter((x) => x !== it.id);
          this.fleet.onToolEnd(it, structured);
          if (this.q) this.schedules.onToolEnd(it, structured);
          if (EDIT_TOOLS.has(it.name) && it.status === 'done') {
            const p = (it.input || {}).file_path || (it.input || {}).notebook_path;
            if (p) this.engine.emit('files.changed', { sessionId: this.s.id, path: p });
          }
          this._refreshActivity();
        },
        onTask: (m) => {
          this.fleet.onTask(m);
          this._noteTask(m);
        },
        onBackgroundTasks: (m) => this._noteBackgroundTasks(m),
        onToolProgress: (m) => this.fleet.onToolProgress(m), // lane stall: a running tool is a sign of life
        onStatus: (m) => {
          if (m.permissionMode && m.permissionMode !== this.s.permissionMode) {
            this.s.permissionMode = m.permissionMode;
            this.touch();
          }
          this.compacting = m.status === 'compacting';
          this._refreshActivity();
        },
        onTextStart: (kind, parent) => {
          if (!parent) {
            this.streamingKind = kind;
            this._refreshActivity();
          }
        },
        onStreamStart: (parent) => {
          if (!parent) this._implicitTurn();
        },
        onAssistant: (m, parent) => {
          if (!parent) this._implicitTurn();
          if (!parent && m.uuid) this.turnAnchor = m.uuid;
          const msg = m.message || {};
          // Claude Code says it can't authenticate ("Not logged in"): the auth provider looks at its sign-in
          // again (main/account.js noteAuthError), so Settings and the composer say why. Never the text of a key.
          if (m.error === 'authentication_failed' && typeof this.engine.onAuthError === 'function') {
            const said = Array.isArray(msg.content) ? msg.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join(' ') : '';
            this.engine.onAuthError(said.slice(0, 300));
          }
          if (parent) {
            this.fleet.onUsage(parent, msg.usage, msg.model);
          } else if (m.context_usage && m.context_usage.raw_max_tokens) {
            const cu = m.context_usage;
            this.s.context = { usedTokens: cu.total_tokens, windowTokens: cu.raw_max_tokens, percent: Math.round(cu.percentage * 10) / 10 };
            this.touch(false);
          } else if (msg.usage) {
            const c = contextFrom(msg.usage, msg.model || this.s.model);
            if (c) {
              this.s.context = c;
              this.touch(false);
            }
          }
        },
      },
    });
  }

  _implicitTurn() {
    // The CLI can start a turn on its own (background task finished, hook, wake-up).
    if (!this.turnActive) {
      this.turnActive = true;
      this.s.turnStartedAt = Date.now();
      if (this.s.status !== 'waiting') this.s.status = 'working';
      this.touch(false);
    }
  }

  _refreshActivity() {
    let a = null;
    const pend = [...this.requests.values()].filter((r) => r.item.status === 'pending');
    if (pend.length) {
      const r = pend[0];
      a = r.kind === 'question' ? 'Waiting for your answer' : r.kind === 'plan' ? 'Waiting for plan approval' : r.item.guard ? `Waiting for your OK: ${r.item.title}` : `Waiting for permission: ${r.item.toolName}`;
    } else if (this.compacting) a = 'Compacting the conversation';
    else if (this.running.length) {
      const its = this.running.map((id) => this.byId.get(id)).filter(Boolean);
      const top = its.filter((x) => !x.parentToolUseId);
      const agents = top.filter((x) => AGENT_TOOLS.has(x.name));
      const others = top.filter((x) => !AGENT_TOOLS.has(x.name));
      if (others.length) a = describeTool(others[others.length - 1]);
      else if (agents.length > 1) a = `${agents.length} agents running`;
      else if (agents.length) {
        const kids = its.filter((x) => x.parentToolUseId === agents[0].toolUseId);
        a = describeTool(agents[0]) + (kids.length ? ` · ${describeTool(kids[kids.length - 1])}` : '');
      } else a = describeTool(its[its.length - 1]);
    } else if (this.turnActive) a = this.streamingKind === 'thinking' ? 'Thinking' : this.streamingKind === 'text' ? 'Writing a reply' : 'Working';
    if (a !== this.s.activity) {
      this.s.activity = a;
      this.touch(false);
    }
  }

  _setStatus(st) {
    if (this.s.status !== st) {
      this.s.status = st;
      this.touch();
    }
  }

  // ---------- history ----------
  async ensureLoaded() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const own = this.s.claudeSessionId ? findTranscript(this.s.claudeSessionId, this.s.cwd, this.engine.projectsDir) : null;
      // A pending conversation rewind (e.g. across a restart): the new Claude session has no
      // transcript yet, so show the one the user was looking at, then the rewind marker(s).
      const pend = !own && this.s.forkFrom ? this.s.forkFrom : null;
      const segs = own ? this._stitchSegments(own, this.s.claudeSessionId) : pend ? this._pendingSegments(pend) : null;
      if (segs && segs.length) {
        const file = segs.length === 1 && segs[0].file ? segs[0].file : null; // a plain transcript, no rewind
        try {
          // Tail-first: only the newest windows are parsed now; history({ before }) parses older
          // ones on demand (a 145 MB transcript took 6 s to open when it was read whole). A session
          // with a rewind shows several transcripts in a row (StitchedPager), still tail-first.
          const pager = file ? new TranscriptPager(file) : new StitchedPager(segs);
          const first = pager.loadNewest(INITIAL_ITEMS);
          this.pager = pager;
          const { meta } = pager;
          this._prependLoaded(first);
          if (meta.lastUsage && !this.s.context && !pend) this.s.context = contextFrom(meta.lastUsage, meta.lastModel);
          if (meta.costUsd != null && !this.s.costUsd) this.s.costUsd = Math.round(meta.costUsd * 1e6) / 1e6;
          if (!this.s.title || this.s.titleAuto) {
            const t = meta.title || meta.aiTitle || (meta.firstPrompt && titleFromPrompt(meta.firstPrompt));
            if (t) this.s.title = t;
          }
        } catch (e) {
          this.silent = false;
          this.engine.log('warn', `engine: could not load transcript ${file || 'history (stitched after a rewind)'}: ${e.message}`);
        }
      }
      // `!` runs Claude has not seen yet, saved across a restart: after the transcript, still pending.
      for (const raw of this.s.pendingShell || []) {
        if (this.byId.has(raw.id)) continue;
        const it = { ...raw, shared: false, status: raw.status === 'running' ? 'stopped' : raw.status || 'done' };
        this.items.push(it);
        this.byId.set(it.id, it);
      }
      delete this.s.pendingShell;
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  // History segments (StitchedPager, oldest first) for the transcript `file` of Claude session `id`:
  // a transcript forked by a SENT conversation rewind (s.rewinds) shows the history the user was looking
  // at when they rewound (recursively), the rewind marker(s), then its own lines from the first prompt
  // sent after the rewind. Anything missing on disk falls back to the transcript alone (what Claude
  // sees), never to a partial stitch. Returns [{ file, floor }] when there is nothing to stitch.
  _stitchSegments(file, id) {
    const recs = (Array.isArray(this.s.rewinds) ? this.s.rewinds : []).slice();
    const f = this.s.forkFrom;
    // A fork whose CLI wrote its transcript but never reported init (it died): not converted yet.
    if (f && f.firstNew && id === this.s.claudeSessionId && !recs.some((r) => r.forkId === id)) recs.push({ forkId: id, shownId: f.shownId || f.sourceId, firstNew: f.firstNew, markers: f.markers });
    const chain = []; // newest first: { file, floor, markers? }
    const seen = new Set();
    let cur = { file, id };
    for (;;) {
      const rec = seen.has(cur.id) || seen.size >= MAX_REWINDS ? null : recs.find((r) => r.forkId === cur.id);
      seen.add(cur.id);
      const first = rec ? findLineByUuid(cur.file, rec.firstNew, { withOffset: true }) : null;
      const shown = first ? findTranscript(rec.shownId, this.s.cwd, this.engine.projectsDir) : null;
      if (!shown) {
        chain.push({ file: cur.file, floor: 0 });
        break;
      }
      chain.push({ file: cur.file, floor: first.off, markers: rec.markers });
      cur = { file: shown, id: rec.shownId };
    }
    const segs = [];
    const fileSegs = [];
    chain.reverse().forEach((c, k) => {
      if (c.markers) segs.push({ items: this._markerItems(c.markers, fileSegs, `rw${k}_`) });
      const seg = { file: c.file, floor: c.floor, prefix: k === chain.length - 1 ? 't' : `s${k}t` };
      segs.push(seg);
      fileSegs.push(seg);
    });
    return segs;
  }

  // A rewind not sent yet: the history the user was looking at, then the marker(s).
  _pendingSegments(pend) {
    const shownId = pend.shownId || pend.sourceId;
    const file = findTranscript(shownId, this.s.cwd, this.engine.projectsDir);
    const segs = file ? this._stitchSegments(file, shownId) : [];
    segs.push({ items: this._markerItems(pend.markers, segs.filter((s) => s.file), 'rwp_') });
    return segs;
  }

  // "Rewound to before…" marker items, each pointing at the prompt it rewound to (item id = the
  // prompt line's id in the segment holding it, so no parsing is needed), so the UI folds the
  // forgotten part exactly as it did before the restart. Searched newest segment first.
  _markerItems(markers, fileSegs, idPrefix) {
    return (markers || []).map((mk, j) => {
      let fromItemId = null;
      for (let i = fileSegs.length - 1; i >= 0 && !fromItemId; i--) {
        const hit = findLineByUuid(fileSegs[i].file, mk.checkpointId, { withOffset: true });
        if (hit && hit.off >= fileSegs[i].floor) fromItemId = fileSegs[i].prefix + hit.off.toString(36);
      }
      return {
        id: idPrefix + j,
        type: 'system',
        subtype: 'info',
        text: mk.text,
        ts: typeof mk.ts === 'number' ? mk.ts : Date.now(),
        rewind: { checkpointId: mk.checkpointId, fromItemId, files: !!mk.files, conversation: !!mk.conversation },
      };
    });
  }

  // The pending rewind became a real fork (its CLI started): keep what history needs to show it.
  _forkTaken() {
    const f = this.s.forkFrom;
    this.s.forkFrom = null;
    const forkId = this.s.claudeSessionId;
    const shownId = f && (f.shownId || f.sourceId);
    if (!f || !f.firstNew || !shownId || shownId === forkId) return;
    const rec = { forkId, shownId, firstNew: f.firstNew, markers: f.markers };
    if (!validRewind(rec)) return;
    this.s.rewinds = [...(this.s.rewinds || []).filter((r) => r.forkId !== forkId), rec].slice(-MAX_REWINDS);
  }

  // Put transcript items (oldest first) in front of everything loaded so far.
  _prependLoaded(list) {
    if (!list || !list.length) return 0;
    const items = this._mergeResults(list, this.pager && this.pager.anchors);
    for (const it of items) {
      // Transcript snapshot of a session no CLI is running: nothing is still running.
      if (it.type === 'tool' && it.status === 'running' && !this.q && !this.reattaching) { // lane detach: a re-attached CLI still runs it
        it.status = 'error';
        it.result = it.result || 'No result recorded (the session ended before this tool finished).';
      }
      if (it.type === 'thinking' || it.type === 'assistant') it.streaming = false;
      this.byId.set(it.id, it);
      if (it.type === 'tool' && !this.norm.toolByUseId.has(it.toolUseId)) this.norm.toolByUseId.set(it.toolUseId, it.id);
    }
    this.items = items.concat(this.items);
    this.fleet.rebuild(this.items);
    // sessions saved before lastText existed (or resumed from History) learn it from the transcript tail
    if (!this.s.lastText) {
      for (let k = this.items.length - 1; k >= 0; k--) {
        const t = isMainText(this.items[k]) ? tailText(this.items[k].text) : null;
        if (t) {
          this.s.lastText = t;
          break;
        }
      }
    }
    return items.length;
  }

  async history({ before, limit } = {}) {
    await this.ensureLoaded();
    this._flushAppends();
    const lim = Math.max(1, Math.min(Number(limit) || 300, 2000));
    let end = this.items.length;
    if (before) {
      let idx = this.items.findIndex((i) => i.id === before);
      // An id from a window not parsed yet (e.g. after a restart): parse back until it shows up.
      while (idx < 0 && this.pager && this.pager.hasOlder() && this.pager._mayBeOlder(before)) {
        this._prependLoaded(this.pager.extendOlder(lim));
        idx = this.items.findIndex((i) => i.id === before);
      }
      if (idx >= 0) end = idx;
    }
    while (end < lim && this.pager && this.pager.hasOlder()) {
      const n = this._prependLoaded(this.pager.extendOlder(lim - end));
      end += n;
    }
    const start = Math.max(0, end - lim);
    return { items: this.items.slice(start, end), hasMore: start > 0 || !!(this.pager && this.pager.hasOlder()) };
  }

  // ---------- CLI lifecycle ----------
  _ensureInput() {
    if (!this.input || this.input.closed) this.input = new PushStream();
    return this.input;
  }

  live() {
    return !!this.q;
  }

  _refuseIfBlocked() {
    const b = typeof this.engine.startBlock === 'function' ? this.engine.startBlock() : null;
    if (b) throw Object.assign(new Error(b.message), { code: b.code || 'auth_required' });
  }

  async start() {
    if (this.q) return;
    if (this.starting) return this.starting;
    // lane detach: a CLI kept through the restart may still be re-attaching; never start a second one beside it
    if (this.keepPending) {
      try { await this.keepPending; } catch {}
      if (this.q) return;
      if (this.starting) return this.starting;
    }
    // auth (main/account.js): not signed in / no readable key = no claude child; the caller shows why (a re-attach above is never blocked)
    this._refuseIfBlocked();
    // lane reaper: the first start after an idle close (idle-reaper.js) resumes the same conversation
    const idleClosedAt = this.idleClosedAt;
    this.starting = this._start();
    try {
      await this.starting;
      if (idleClosedAt) {
        this.idleClosedAt = null;
        if (this.engine.idleResumed) this.engine.idleResumed(this);
        this.engine.log('info', `engine: resumed idle-closed CLI for ${this.s.id} (closed ${Math.round((Date.now() - idleClosedAt) / 60000)} min earlier)`);
      }
    } catch (e) {
      if (idleClosedAt) this.engine.log('warn', `engine: resume of idle-closed ${this.s.id} failed: ${e.message}`);
      throw e;
    } finally {
      this.starting = null;
    }
  }

  _options() {
    const s = this.s;
    // engine claudeEnv (index.js): the user's env, not nested, plus the auth provider's (ANTHROPIC_API_KEY only
    // when the user saved an API key). Never logged.
    const env = typeof this.engine.claudeEnv === 'function' ? this.engine.claudeEnv() : { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0' };
    // Helm may be launched from inside a Claude Code terminal; don't let the child think it is nested.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const opts = {
      cwd: s.cwd,
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      // lane steer: the CLI echoes each user message (isReplay, same uuid) the moment Claude takes it, so a
      // message sent mid-turn shows "Seen mid-turn" when its turn folds it in (the normalizer skips replays).
      extraArgs: { 'replay-user-messages': null },
      enableFileCheckpointing: true,
      permissionMode: s.permissionMode || 'bypassPermissions',
      allowDangerouslySkipPermissions: true, // lets the mode switch to bypass live, too
      // Bound to the CLI it was made for: a late call from a CLI that was closed or crashed (whose
      // requests were already cancelled) is denied at once instead of waiting forever.
      canUseTool: (name, input, o) => (this.q && this.q === opts._q && !this.closing ? this._canUseTool(name, input, o) : Promise.resolve({ behavior: 'deny', message: 'Session stopped', interrupt: true })),
      env,
      stderr: (d) => {
        for (const line of String(d).split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 40) this.stderrTail.shift();
        }
      },
    };
    // lane guard: pushes to protected repos (prod-guard.json) and Railway deploys wait for the user in EVERY mode (prod-guard.js)
    opts.hooks = { ...(opts.hooks || {}), PreToolUse: [...((opts.hooks || {}).PreToolUse || []), prodGuard.createHook(this)] };
    if (this.engine.claudePath) opts.pathToClaudeCodeExecutable = this.engine.claudePath;
    if (s.model && s.model !== 'default') opts.model = s.model;
    if (s.effort) opts.effort = s.effort;
    return opts;
  }

  async _start(reattach = null) {
    this._resetTasks();
    this.schedules.reset();
    // lane detach: the uuids already in the transcript, read BEFORE the history loads, so the broker's
    // replay of the turn shows only what this Helm has not loaded (a line written in between shows twice, never zero)
    const known = reattach ? this._transcriptUuids() : null;
    this.reattaching = !!reattach;
    try { await this.ensureLoaded(); } finally { this.reattaching = false; }
    if (!this.s.cwd || !fs.existsSync(this.s.cwd)) throw new Error(`Folder not found: ${this.s.cwd}`);
    const sdk = await this.engine.loadSdk();
    const opts = this._options();
    const own = this.s.claudeSessionId && findTranscript(this.s.claudeSessionId, this.s.cwd, this.engine.projectsDir);
    if (reattach) {
      // the CLI already runs in the broker: no resume / session id flags matter (nothing is spawned)
    } else if (this.s.forkFrom && !own) {
      // Conversation rewind: a new Claude session holding the kept part of the old one. s.forkFrom
      // stays until the CLI reports init (_onMessage), so a CLI that dies first forks again.
      const { sourceId, at } = this.s.forkFrom;
      if (at) {
        opts.resume = sourceId;
        opts.resumeSessionAt = at;
        opts.forkSession = true;
      }
      opts.sessionId = this.s.claudeSessionId;
    } else if (own) {
      opts.resume = this.s.claudeSessionId;
      if (this.s.forkFrom) {
        this._forkTaken(); // the fork already has its transcript (kept as s.rewinds for history)
        this.engine.save();
      }
    } else {
      if (!this.s.claudeSessionId) this.s.claudeSessionId = randomUUID();
      opts.sessionId = this.s.claudeSessionId;
    }
    const input = this._ensureInput();
    this.stderrTail = [];
    this.closing = false;
    // The figure this CLI's cost counter starts from: a resumed CLI restores Claude Code's own total from
    // the transcript's newest cost-state line; a new conversation starts at 0, and a fork's first result
    // settles which (see _onResultCost). The turn's cost is the counter's rise from here.
    this.procCostBase = this._restoredCost(opts.resume && !opts.forkSession ? own : null);
    this.procCostFork = opts.forkSession && this.s.forkFrom ? this._restoredCost(findTranscript(this.s.forkFrom.sourceId, this.s.cwd, this.engine.projectsDir)) : null;
    this.norm.sawInit = false;
    const spawned = { pid: null }; // close() may need to end claude.exe's tree by PID
    opts.onProcessSpawned = (pid) => { spawned.pid = pid; };
    // lane detach: with "Keep sessions running through a restart" on, claude.exe lives in the CLI broker
    // (broker.js), so a Helm restart detaches from it instead of killing it. A re-attach always goes through it.
    this.brokerProc = null;
    this.replaySkip = null;
    const broker = this.engine.broker;
    if (broker && (reattach || this.engine.keepOn())) {
      const hooks = { onPid: (pid) => { spawned.pid = pid; }, onStderr: (d) => opts.stderr(d) };
      if (reattach) {
        this.replaySkip = known;
        // Cost: the same claude.exe keeps counting from where the OLD Helm last counted it (saved at detach), so
        // a turn that ended while Helm was away is counted once, by the replayed result. Without that record
        // (s.kept not saved), the transcript's newest cost state.
        const kept = this.s.kept;
        this.procCostBase = kept && typeof kept.costBase === 'number' ? kept.costBase : this._restoredCost(own);
        this.procCostFork = null;
        this.norm.sawInit = true; // the replayed init is not a new start
        let mine = null;
        hooks.onReinit = (r) => { if (this.brokerProc === mine) this._onReinit(r, reattach); };
        opts.spawnClaudeCodeProcess = (o) => (mine = this.brokerProc = broker.attachProcess(reattach, hooks, o));
      } else {
        const key = `${this.s.id}~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const meta = { sdk: this.engine.sdkVersion ? this.engine.sdkVersion() : null, claudePath: this.engine.claudePath || null };
        opts.spawnClaudeCodeProcess = (o) => (this.brokerProc = broker.spawnProcess({ key, sid: this.s.id, meta }, o, hooks));
      }
    }
    const q = sdk.query({ prompt: input, options: opts });
    Object.defineProperty(q, '_helmCli', { value: spawned, enumerable: false });
    Object.defineProperty(opts, '_q', { value: q, enumerable: false });
    this.q = q;
    if (reattach) {
      const busy = !!(reattach.busy || (reattach.turnEndedAt && reattach.detachedAt && reattach.turnEndedAt >= reattach.detachedAt));
      if (busy) {
        this.turnActive = true; // the replayed result ends it (_onTurnEnd) like any turn
        this.s.turnStartedAt = reattach.turnStartedAt || Date.now();
        this.s.status = 'working';
        this.s.activity = 'Re-attaching';
      }
      this.lastEventAt = Date.now(); // lane stall: the stall clock starts again from the re-attach
      this.awaitingReinit = true;
      clearTimeout(this.reinitTimer);
      this.reinitTimer = setTimeout(() => { if (this.awaitingReinit && this.q === q) this._keepFailed(reattach, `Claude Code did not answer the re-attach within ${Math.round(REINIT_TIMEOUT_MS / 1000)} s`, { live: true }); }, REINIT_TIMEOUT_MS);
      if (this.reinitTimer.unref) this.reinitTimer.unref();
      this.engine.log('info', `engine: re-attached ${this.s.id} to CLI pid ${reattach.pid} (busy ${busy}, ${this.replaySkip ? this.replaySkip.size : 0} transcript uuids known, cost base ${this.procCostBase})`);
    }
    this.touch();
    this._watchEta();
    this._pump(q, input);
  }

  // ---------- lane detach: keep sessions running through a Helm restart ----------
  // True when this session's claude.exe runs in a broker that a restart cannot take down (not in a job it could
  // not leave) and the pipe is up: a restart can detach from it.
  canKeep() {
    const p = this.brokerProc;
    return !!(this.q && p && !p.detached && !p.exited && p.pid && this.q._helmCli && this.engine.keepSafe && this.engine.keepSafe());
  }

  // After a restart: take over the CLI the broker kept running for this session, if it still fits (keep-compat.js).
  // Otherwise today's path: that CLI is ended and the session shows the restart note with the reason and Continue.
  async reattach(entry, here = {}) {
    if (this.q || this.starting) return false;
    const why = keepCompat(entry, { id: this.s.id, claudeSessionId: this.s.claudeSessionId, cwd: this.s.cwd }, here);
    if (why) { await this._keepFailed(entry, why, { live: false }); return false; }
    this.starting = this._start(entry);
    try { await this.starting; } catch (e) {
      this.starting = null;
      await this._keepFailed(entry, `re-attaching failed: ${e.message}`, { live: !!this.q });
      return false;
    } finally { this.starting = null; }
    return true;
  }

  // The broker's verdict on the repeated initialize (sent before the CLI's response reaches the SDK).
  _onReinit(r, entry) {
    if (!this.awaitingReinit) return;
    this.awaitingReinit = false;
    clearTimeout(this.reinitTimer);
    const problem = reinitProblem(r);
    if (problem) { this._keepFailed(entry, problem, { live: true }); return; }
    const kept = this.s.kept;
    const at = (kept && kept.at) || entry.detachedAt || null;
    const away = at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
    const awayText = away == null ? '' : away < 90 ? `${away} s` : `${Math.round(away / 60)} min`;
    // only a restart Helm performs keeps a CLI (broker.js restart intent): any other close stops it
    const text = 'Kept running through the restart';
    this.norm.system('kept', text, undefined, { detail: `Claude Code (pid ${entry.pid}) kept running${awayText ? ` for ${awayText}` : ''} without Helm, and Helm re-attached to it. Nothing was stopped.` });
    if (this.s.activity === 'Re-attaching') this.s.activity = null;
    if (kept) delete this.s.kept;
    this.engine.log('info', `engine: kept ${this.s.id} through the restart (pid ${entry.pid}, ${awayText || '?'} without Helm, hooks applied in ${r.ms} ms${r.pending ? `, ${r.pending} permission request(s) re-armed` : ''})`);
    this._emitUpdated();
    this.engine.save();
  }

  // Keeping failed (compat check, the CLI refused the re-attach, no answer, or it ended while Helm was away):
  // stop that CLI and fall back to the restart note + Continue, with the reason in the note and the conversation.
  async _keepFailed(entry, reason, { live = false } = {}) {
    this.awaitingReinit = false;
    clearTimeout(this.reinitTimer);
    const kept = this.s.kept || null;
    const at = (kept && kept.at) || (entry && entry.detachedAt) || Date.now();
    // what stops: the live state when Helm had attached (rebuilt from the replay), else what the old Helm saw
    let note = live ? this.cutOffState(at, 'restart') : null;
    if (!note && kept && kept.note) note = { ...kept.note };
    if (!note && entry && !entry.exited && entry.busy) note = { at, cause: 'restart', working: true, waiting: false, agents: [], agentsTotal: 0, tasks: [], shells: 0, queued: 0 };
    if (!note && entry && entry.exited && entry.busy && kept) note = { at, cause: 'restart', working: true, waiting: false, agents: [], agentsTotal: 0, tasks: [], shells: 0, queued: 0 };
    this.engine.log('warn', `engine: could not keep ${this.s.id} through the restart: ${reason}${entry && entry.pid ? ` (CLI pid ${entry.pid})` : ''}; ${note ? 'restart note shown' : 'nothing was running'}`);
    if (live && this.q) {
      const q = this.q;
      this.closing = true;
      try { q.close(); } catch {}
      this._onExit(null, this.input);
      this.s.status = 'idle';
    }
    if (kept) delete this.s.kept;
    if (entry && entry.broker && !entry.exited && this.engine.broker) await this.engine.broker.end(entry, `Helm could not re-attach: ${reason}`);
    // the line belongs at the end of the loaded conversation (a later history load would drop it otherwise)
    try { await this.ensureLoaded(); } catch {}
    if (note) {
      const prev = this.s.restartNote; // `!` runs / queued messages the old Helm noted at detach
      note.at = at;
      note.cause = 'restart';
      note.reason = String(reason).slice(0, 300);
      if (prev) { note.shells = Math.max(Number(note.shells) || 0, Number(prev.shells) || 0); note.queued = Math.max(Number(note.queued) || 0, Number(prev.queued) || 0); }
      this.s.restartNote = note;
      this.stopNote = { cause: 'restart', cut: note };
    }
    this.norm.system('kept-failed', `Could not keep Claude Code running through the restart: ${reason}.${note ? ' What stopped is listed below, with Continue.' : ' Nothing was running; your next message starts it again.'}`);
    this._emitUpdated();
    this.engine.save();
  }

  // The broker stopped this session's CLI because Helm closed without a restart it performed (closed, crashed, ended
  // in Task Manager, Windows shutdown or sign-out) or no Helm re-attached in time (broker.js full stop). Say so
  // plainly in the conversation; when a restart note already lists what stopped (a quit noted it), that is enough.
  // stop: { at, reason, cli: { pid, busy, pending } }
  async noteStoppedWhenClosed(stop) {
    if (!stop || this.s.restartNote) return false;
    const c = stop.cli || {};
    try { await this.ensureLoaded(); } catch {}
    const what = c.busy ? 'mid-turn' : c.pending ? 'while it waited for an answer' : 'while idle';
    this.norm.system('closed-stopped', 'Stopped when Helm closed', undefined, { detail: `Claude Code${c.pid ? ` (pid ${c.pid})` : ''} was stopped ${what}: ${stop.reason || 'Helm closed'}. Only a restart Helm does itself keeps sessions running. Your next message starts it again.` });
    this.engine.log('info', `engine: ${this.s.id} was stopped when Helm closed (pid ${c.pid || '?'}, ${what}): ${stop.reason}`);
    this._emitUpdated();
    this.engine.save();
    return true;
  }

  // Helm is restarting with keeping on. Leave claude.exe running in the broker; this Helm lets go of it without the
  // exit path (no "Claude Code exited", no agents marked stopped). Saved with the session (s.kept): when and which
  // CLI, the cost base for the re-attach, and today's restart note in case the re-attach fails. `!` runs and
  // Helm-side queued messages belong to this Helm and still stop: they get a restart note of their own.
  detachCli(at = Date.now()) {
    const q = this.q;
    if (!q || !this.canKeep()) return false;
    const p = this.brokerProc;
    const note = this.cutOffState(at, 'restart');
    const costBase = this.procCostBase;
    const shells = this.shells.size;
    const queued = this.pendingQueue.length;
    if (!p.detach()) return false;
    this.s.kept = { at, key: p.key || null, pid: p.pid, costBase: typeof costBase === 'number' ? costBase : null, note: note || null };
    if (shells || queued) this.s.restartNote = { at, cause: 'restart', working: false, waiting: false, agents: [], agentsTotal: 0, tasks: [], shells, queued };
    this.q = null; // _pump sees a different q and skips _onExit
    this._stopEta();
    this.engine.log('info', `engine: detached ${this.s.id} from CLI pid ${p.pid} (turn ${this.turnActive ? 'running' : 'idle'}, cost base ${costBase})`);
    return true;
  }

  _transcriptUuids() {
    const out = new Set();
    try {
      const f = this.s.claudeSessionId && findTranscript(this.s.claudeSessionId, this.s.cwd, this.engine.projectsDir);
      if (!f) return out;
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = /"uuid":"([^"]+)"/.exec(l);
        if (m) out.add(m[1]);
      }
    } catch {}
    return out;
  }

  async _pump(q, input) {
    let err = null;
    try {
      for await (const m of q) {
        if (this.q !== q) break;
        try {
          this._onMessage(m);
        } catch (e) {
          this.engine.log('error', `engine: message handling failed (${m && m.type}): ${e.stack || e.message}`);
        }
      }
    } catch (e) {
      err = e;
    }
    if (this.q === q) this._onExit(err, input);
  }

  // lane handoff: one-shot waiters for the end of the turn in flight (main/engine/handoff.js). Called once per
  // turn end, CLI exit or failed start with { interrupted, failed, error, result }; the list is emptied first.
  _settleTurn(info) {
    const list = this.turnWaiters;
    if (!list || !list.length) return;
    this.turnWaiters = [];
    for (const fn of list) { try { fn(info); } catch (e) { this.engine.log('warn', `engine: turn waiter failed: ${e.message}`); } }
  }

  _onExit(err, input) {
    const expected = this.closing;
    this._settleTurn({ interrupted: !!(expected || this.interrupting), failed: !expected, error: expected ? 'The session was closed' : (err && err.message) || 'Claude Code exited unexpectedly', result: null });
    this.q = null;
    this._stopEta();
    if (input) input.close();
    if (this.input === input) this.input = null;
    this._flushAppends();
    this.norm.finishStreaming();
    this.norm.failRunningTools(expected ? 'Stopped (session closed)' : 'Stopped (Claude Code exited)', { interrupted: expected || this.interrupting });
    this.running = [];
    this.fleet.stopAll('error', expected ? 'closed' : 'exited');
    this._resetTasks();
    this.schedules.reset(); // in-CLI schedules die with it
    // An interrupt the CLI never answered must not outlive it: its grace timer would end the NEXT
    // CLI's turn, and the flag would hide that turn's failure.
    this.interrupting = false;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    // lane steer: mid-turn messages the CLI had not taken die with it
    for (const id of this.steering.values()) this.norm.store.patch(id, { steer: null, cancelled: true });
    this.steering.clear();
    clearTimeout(this.steerTimer);
    for (const r of this.requests.values()) this._cancelRequest(r, 'Session stopped');
    this.turnActive = false;
    this.streamingKind = null;
    this.compacting = false;
    this.s.turnStartedAt = null;
    this.s.activity = null;
    if (expected) {
      this.closing = false;
      // Helm stopped it (close / quit): not use, so updatedAt stays (close() touches for the user's Close).
      this._emitUpdated();
      this.engine.save();
      return;
    }
    const tail = this.stderrTail.slice(-8).join('\n');
    const why = err ? err.message || String(err) : 'Claude Code exited unexpectedly';
    this.norm.system('error', `${why}${tail ? `\n${tail}` : ''}\nSend again to restart it (the conversation resumes).`);
    this.s.status = 'error';
    this.s.activity = truncate(oneLine(why), 80);
    this.touch();
    this.engine.notify({ title: this.s.title || 'Session', body: `Claude Code stopped: ${truncate(oneLine(why), 120)}`, sessionId: this.s.id, kind: 'error' });
    this.engine.log('warn', `engine: session ${this.s.id} CLI exited: ${why}`);
  }

  _onMessage(m) {
    this.lastEventAt = Date.now(); // lane stall: any SDK message is a sign of life (stall.js)
    if (this.stalledSince) { this.stalledSince = null; this._emitUpdated(); }
    // lane detach: a replayed message the history already loaded from the transcript
    if (this.replaySkip && m && m.uuid && m.type !== 'result' && this.replaySkip.has(m.uuid)) return;
    if (m.session_id && m.session_id !== this.s.claudeSessionId && m.type === 'system' && m.subtype === 'init') {
      this.s.claudeSessionId = m.session_id;
      this._watchEta();
      this.touch();
    }
    if (this.s.forkFrom && m.type === 'system' && m.subtype === 'init') {
      this._forkTaken(); // the CLI took up the pending rewind: its own transcript holds it now (s.rewinds keeps the fold)
      this.touch();
    }
    // lane steer: a message sent mid-turn was taken by Claude (its replay echo, or the turn's result lists it)
    if (this.steering.size) {
      if (m.type === 'user' && m.isReplay && m.uuid && this.steering.has(m.uuid)) this._steerTaken(m.uuid);
      if (m.type === 'result' && Array.isArray(m.user_message_uuids)) for (const u of m.user_message_uuids) if (this.steering.has(u)) this._steerTaken(u);
    }
    this.norm.handleSdk(m);
    if (m.type === 'result') {
      const res = this.items.slice(-3).reverse().find((it) => it.type === 'result');
      this._recordResult(res);
      this._onTurnEnd(m);
    }
  }

  _onInit(m) {
    this.initInfo = { tools: m.tools || [], model: m.model, permissionMode: m.permissionMode, version: m.claude_code_version, plugins: m.plugins || [], mcpServers: m.mcp_servers || [], slashCommands: m.slash_commands || [] };
    this.engine.onInit(this, this.initInfo);
    if (m.permissionMode && m.permissionMode !== this.s.permissionMode) {
      this.s.permissionMode = m.permissionMode;
      this.touch();
    }
  }

  // Claude Code's own running total for a conversation, from its transcript's newest cost-state; 0 when
  // there is none (a new conversation's counter starts at 0).
  _restoredCost(file) {
    if (!file) return 0;
    const st = lastCostState(file);
    return st ? st.totalCostUSD : 0;
  }

  // result.total_cost_usd is Claude Code's cumulative cost for the conversation (a resumed CLI restores the
  // prior total from the transcript's cost-state; checked on the user's transcripts 2026-10-14). The session's
  // cost IS that figure, never Helm's own sum. The turn's cost is how far the counter rose since this CLI's
  // last result (the first result: since the restored figure). Before 2026-10-14 Helm added the restored
  // total on top of its own copy whenever the CLI restored less than Helm held, so each resume re-added the
  // conversation's lifetime cost (one session showed $6,647 where Claude Code said $320).
  _onResultCost(m) {
    const total = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    for (const [model, mu] of Object.entries(m.modelUsage || {})) learnWindow(model, mu.contextWindow);
    if (total == null) return null;
    const r6 = (n) => Math.round(n * 1e6) / 1e6;
    if (this.procCostFork != null) {
      // A fork: the CLI either carried the source's total over or started a fresh counter.
      this.procCostBase = this.procCostFork > 0 && total + 1e-9 >= this.procCostFork ? this.procCostFork : 0;
      this.procCostFork = null;
    }
    // A counter below its base: the CLI restored less than the transcript said, or started fresh. Count the
    // turn from 0 rather than invent a figure.
    const base = this.procCostBase != null && total + 1e-9 >= this.procCostBase ? this.procCostBase : 0;
    const delta = Math.max(0, r6(total - base));
    this.procCostBase = total;
    this.s.costUsd = r6(total);
    this.s.costBasis = 'cc';
    this.engine.usage.addCost(delta, { sessionId: this.s.id, project: this.s.project });
    return delta;
  }

  _onTurnEnd(m) {
    this._flushAppends();
    this.turnActive = false;
    this.streamingKind = null;
    this.compacting = false;
    this.s.turnStartedAt = null;
    const wasInterrupt = this.interrupting;
    this.interrupting = false;
    clearTimeout(this.interruptTimer);
    // Anything still marked running in the main thread did not finish in this turn.
    const pendingReq = [...this.requests.values()].some((r) => r.item.status === 'pending');
    const failed = m.is_error && !wasInterrupt;
    const why = failed ? cleanErrorText((m.errors && m.errors[0]) || m.result || '') : '';
    this._settleTurn({ interrupted: wasInterrupt, failed: !!failed, error: why, result: typeof m.result === 'string' ? m.result : null });
    // lane steer: messages sent mid-turn that this turn did not take (Claude was already writing its reply)
    // run as the CLI's next turn on their own: say so, and stay working instead of flashing "Done".
    // One already carried into this turn ('after') and still unconfirmed was its prompt: done with it.
    const left = [];
    for (const [u, id] of [...this.steering]) {
      if ((this.norm.store.get(id) || {}).steer === 'after') this.steering.delete(u);
      else left.push(id);
    }
    for (const id of left) this.norm.store.patch(id, { steer: 'after' });
    if (left.length && this.q && !wasInterrupt) {
      const t0 = Date.now();
      this.turnActive = true;
      this.s.turnStartedAt = t0;
      this.s.status = pendingReq ? 'waiting' : 'working';
      this.s.activity = 'Starting';
      // Safety net: if the CLI shows no sign of that turn at all, end it here rather than look busy forever.
      clearTimeout(this.steerTimer);
      this.steerTimer = setTimeout(() => {
        const still = [...this.steering].filter(([, id]) => left.includes(id));
        if (this.turnActive && still.length === left.length) {
          this.engine.log('warn', `engine: ${this.s.id} mid-turn message(s) not taken by the CLI within ${STEER_START_MS / 1000}s`);
          for (const [u] of still) this.steering.delete(u); // stay tagged 'after'; never loop back here
          this._onTurnEnd({ is_error: false });
        }
      }, STEER_START_MS);
      if (this.steerTimer.unref) this.steerTimer.unref();
    } else if (this.pendingQueue.length && this.q) {
      const next = this.pendingQueue.shift();
      this.s.queued = this.pendingQueue.length;
      this._dequeued(next.item);
      this._pushToCli(next.item, next.content);
    } else {
      this.s.status = pendingReq ? 'waiting' : failed ? 'error' : 'idle';
      this._refreshActivity();
      if (failed) this.s.activity = truncate(oneLine(why || 'The turn failed'), 80);
      if (!wasInterrupt) {
        this.engine.notify({
          title: this.s.title || 'Session',
          body: failed ? `Turn failed${why ? `: ${truncate(oneLine(why), 120)}` : ''}` : `Done${m.duration_ms ? ` in ${Math.round(m.duration_ms / 1000)}s` : ''}`,
          sessionId: this.s.id,
          kind: failed ? 'error' : 'done',
        });
      }
    }
    this.touch();
  }

  // ---------- sending ----------
  _sdkContent(text, attachments) {
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!atts.length) return text;
    const blocks = [];
    const fileRefs = [];
    for (const a of atts) {
      const isImage = a.kind === 'image' || /^image\//.test(a.mime || '');
      let dataUrl = a.dataUrl;
      let p = a.path;
      if (isImage) {
        if (!dataUrl && p) {
          try {
            const buf = fs.readFileSync(p);
            dataUrl = `data:${a.mime || 'image/png'};base64,${buf.toString('base64')}`;
          } catch {}
        }
        const m = dataUrl && /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (m) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
          continue;
        }
      }
      if (!p && dataUrl) p = this._saveUpload(a.name || 'file', dataUrl);
      if (p) fileRefs.push(p);
    }
    const t = text + (fileRefs.length ? `\n\n${fileRefs.map((p) => `[Attached file: ${p}]`).join('\n')}` : '');
    return [{ type: 'text', text: t || ' ' }, ...blocks];
  }

  _saveUpload(name, dataUrl) {
    try {
      const m = /^data:([^;]*);base64,(.*)$/s.exec(dataUrl);
      if (!m) return null;
      const dir = path.join(this.engine.userDataDir, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${String(name).replace(/[^\w.\- ]+/g, '_').slice(0, 80)}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      return file;
    } catch (e) {
      this.engine.log('warn', `engine: upload save failed: ${e.message}`);
      return null;
    }
  }

  // origin: 'user' = the user typed it (a client send RPC); 'helm' or missing = Helm-generated / internal.
  async send({ text, attachments, origin }) {
    await this.ensureLoaded();
    text = String(text == null ? '' : text);
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!text.trim() && !atts.length) throw Object.assign(new Error('Nothing to send'), { code: 'empty' });
    // auth (main/account.js): with no CLI running and not signed in, refuse before the message is stored, so the
    // composer keeps the text and says why (code auth_required)
    if (!this.q && !this.starting && !this.keepPending) this._refuseIfBlocked();
    // Picked back up from Past (or Archived): idle/closed, not pinned, no agents running, unused for an
    // hour. Read before anything below touches updatedAt (adding the item does).
    const resumed = (this.s.status === 'idle' || this.s.status === 'closed') && !this.turnActive && !this.s.pinned
      && !(this.fleet && this.fleet.runningCount() > 0) && Date.now() - (this.s.updatedAt || 0) >= RESUME_GAP_MS;
    let content = this._sdkContent(text, atts);
    // Prompts left queued by a crash go first once the CLI is restarted.
    if (!this.turnActive && this.pendingQueue.length) {
      const head = this.pendingQueue.shift();
      this.s.queued = this.pendingQueue.length;
      this._dequeued(head.item);
      this._pushToCli(head.item, head.content);
    }
    // lane steer: mid-turn, the message goes to Claude at its next step (after the current tool call), never
    // interrupting. Helm's own queue is only the fallback for when that cannot work right now.
    const steering = this.turnActive && this._canSteer(text);
    const queued = this.turnActive && !steering;
    // lane steer: an explicit Stop ended background agents; Claude is told with this message (shown apart from it).
    const helmNote = this._takeStopNote();
    if (helmNote) content = steer.withNote(content, helmNote);
    // lane restart: any message after a restart note (Continue or the user's own) is the follow-up; the note goes.
    if (this.s.restartNote) { delete this.s.restartNote; this._emitUpdated(); this.engine.save(); }
    const publicAtts = atts.map((a) => ({ kind: a.kind || (/^image\//.test(a.mime || '') ? 'image' : 'file'), name: a.name || baseName(a.path) || 'file', mime: a.mime || null, ...(a.dataUrl && a.dataUrl.length < 3_000_000 ? { dataUrl: a.dataUrl } : {}), ...(a.path ? { path: a.path } : {}) }));
    const item = { id: this.nextId(), type: 'user', ts: Date.now(), text, attachments: publicAtts, uuid: randomUUID(), ...(queued ? { queued: true } : {}), ...(steering ? { steer: 'pending' } : {}), ...(helmNote ? { helmNote } : {}) };
    this.norm.store.add(item);
    prodGuard.noteSend(this, item, origin); // lane guard: the user's typed prompts can pre-approve a push
    // lane steer: a queued prompt reaches Claude later, but a "don't push" in it takes the approval back now.
    if (queued) prodGuard.noteQueued(this, item);
    if (this.s.titleAuto !== false && (!this.s.title || this.s.title === 'New session') && text.trim()) {
      this.s.title = titleFromPrompt(text);
      this.s.titleAuto = true;
    }
    if (resumed) this.s.resumedAt = Date.now();
    if (this.s.status === 'error' || this.s.status === 'closed') this.s.status = 'idle';
    if (this.s.archived) this.s.archived = false; // writing to an archived session brings it back
    if (queued) {
      this.pendingQueue.push({ item, content });
      this.s.queued = this.pendingQueue.length;
      this.touch();
      return { itemId: item.id, queued: true, delivery: 'queued' };
    }
    if (steering) {
      this._steer(item, content);
      return { itemId: item.id, queued: false, delivery: 'next-step' };
    }
    this._pushToCli(item, content);
    return { itemId: item.id, queued: false, delivery: 'now' };
  }

  // ---------- lane steer: mid-turn messages, explicit Stop ----------
  // Can a message go into the running turn now? Not while the CLI is starting, stopping or compacting, not into
  // a turn Helm itself is waiting on (handoff), and not a /command (the CLI runs those as a turn of their own).
  _canSteer(text) {
    return !!(this.q && this.input && !this.starting && !this.interrupting && !this.closing && !this.compacting
      && !(this.turnWaiters && this.turnWaiters.length) && !steer.isCommand(text));
  }

  _steer(item, content) {
    const shared = this._takeShellContext(); // `!` runs ride along, as with any prompt
    if (shared) content = shellRun.prependContext(content, shared.text);
    prodGuard.notePushed(this, item); // lane guard: it is in Claude's hands now (a "don't push" revokes at once)
    this.steering.set(item.uuid, item.id);
    this.touch();
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: item.uuid });
  }

  // Claude took a mid-turn message: mid-turn ('seen') or as the turn after ('after'). It moves to where Claude
  // read it, after the step it was folded in at.
  _steerTaken(uuid) {
    const id = this.steering.get(uuid);
    this.steering.delete(uuid);
    const it = id && this.norm.store.get(id);
    if (!it) return;
    this.norm.store.moveToEnd(id);
    this.norm.store.patch(id, { steer: it.steer === 'after' ? 'after' : 'seen', seenAt: Date.now() });
  }

  // The note for the next message after an explicit Stop ended agents: only those that really stopped.
  _takeStopNote() {
    const n = this.stopNote;
    if (!n) return null;
    this.stopNote = null;
    if (n.cause === 'restart') return steer.restartNoteText(n.cut); // lane restart: everything there stopped with the old Helm
    const gone = n.agents.filter((a) => { const x = this.fleet.agents.get(a.id); return !x || x.status !== 'running'; });
    return steer.stopNoteText(n.at, gone.map((a) => a.name));
  }

  _pushToCli(item, content) {
    // `!` runs since the last prompt ride along, in Claude Code's own tags (shell-run.js). Taken here,
    // not in send(): a queued prompt picks up what finished while it waited, and nothing goes twice.
    const shared = this._takeShellContext();
    if (shared) content = shellRun.prependContext(content, shared.text);
    prodGuard.notePushed(this, item); // lane guard: the user's prompt reaches Claude now (before lastText moves on)
    this.turnActive = true;
    this.turnAnchor = item.uuid || null;
    // The first prompt into a pending rewind fork: where the fork's own lines start (see _stitchSegments).
    if (this.s.forkFrom && !this.s.forkFrom.firstNew && item.uuid) this.s.forkFrom.firstNew = item.uuid;
    this.s.turnStartedAt = Date.now();
    this.s.status = 'working';
    this.streamingKind = null;
    this.s.activity = 'Starting';
    this.touch();
    this._ensureInput().push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: item.uuid });
    if (!this.q) {
      this.start().catch((e) => {
        // The prompt never reached Claude: its `!` runs are still unseen.
        if (shared) for (const id of shared.ids) this.norm.store.patch(id, { shared: false });
        this.turnActive = false;
        this.s.turnStartedAt = null;
        this.s.status = 'error';
        this.s.activity = truncate(oneLine(e.message), 80);
        if (this.input) this.input.close();
        this.input = null;
        this.norm.system('error', `Could not start Claude Code: ${e.message}`);
        this._settleTurn({ interrupted: false, failed: true, error: `Could not start Claude Code: ${e.message}`, result: null });
        this.touch();
        this.engine.log('error', `engine: start failed for ${this.s.id}: ${e.stack || e.message}`);
      });
    }
  }

  // Start the CLI (no prompt) if it is not running, e.g. to list commands.
  async warm() {
    await this.start();
  }

  // lane steer: Claude Code's interrupt stops EVERY running agent of the session, silently. Only an explicit
  // Stop that the user confirmed with the agents named passes stopAgents: true; anything else is refused while
  // agents run (code 'agents_running', data.agents = [{ id, name, background }]).
  async interrupt({ stopAgents = false } = {}) {
    if (this.q && this.turnActive && !stopAgents) {
      const agents = this.fleet.runningAgents();
      if (agents.length) {
        throw Object.assign(new Error(`Stop also stops ${steer.agentsPhrase(agents)}. Confirm to stop them too.`), { code: 'agents_running', data: { agents } });
      }
    }
    const cancelled = this.pendingQueue.splice(0);
    for (const p of cancelled) this.norm.store.patch(p.item.id, { queued: false, cancelled: true });
    this.s.queued = 0;
    for (const r of this.requests.values()) this._cancelRequest(r, 'Interrupted');
    if (this.starting) {
      try {
        await this.starting;
      } catch {}
    }
    if (!this.q || !this.turnActive) {
      this.touch();
      return {};
    }
    this.interrupting = true;
    const now = Date.now();
    this.fleet.onInterrupt(now); // lane stall: agents Claude Code stops now were stopped by this interrupt
    // lane steer: Stop means stop: mid-turn messages Claude has not taken yet are withdrawn (else they would
    // run after the interrupt). One the CLI already dequeued stays tracked; its result or echo settles it.
    let withdrawn = 0;
    for (const [uuid, id] of [...this.steering]) {
      let ok = false;
      try { ok = typeof this.q.cancelAsyncMessage === 'function' && (await this.q.cancelAsyncMessage(uuid)) === true; } catch {}
      if (ok) {
        this.steering.delete(uuid);
        this.norm.store.patch(id, { steer: null, cancelled: true });
        withdrawn++;
      }
    }
    const killed = this.fleet.runningAgents();
    if (killed.length) this.stopNote = { at: now, agents: killed };
    const notSent = cancelled.length + withdrawn;
    const parts = ['Interrupted.'];
    if (killed.length) parts.push(`Also stopped ${steer.agentsPhrase(killed)}.`);
    if (notSent) parts.push(`${notSent} message${notSent > 1 ? 's were' : ' was'} not sent.`);
    this.norm.system('interrupted', parts.length > 1 ? parts.join(' ') : 'Interrupted');
    try {
      await this.q.interrupt();
    } catch (e) {
      this.engine.log('warn', `engine: interrupt failed: ${e.message}`);
    }
    // If the CLI never sends the closing result, end the turn locally.
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (this.interrupting && this.turnActive) {
        this.norm.finishStreaming();
        this.norm.failRunningTools('Stopped', { interrupted: true });
        this._onTurnEnd({ is_error: false });
      }
    }, INTERRUPT_GRACE_MS);
    this.touch();
    return { stoppedAgents: killed.map((a) => a.name) };
  }

  // quiet (the idle reaper): only the CLI goes; the session keeps its status and activity line as shown.
  async close({ final = true, quiet = false } = {}) {
    const shown = quiet && !final ? { status: this.s.status, activity: this.s.activity } : null;
    for (const p of this.pendingQueue.splice(0)) this.norm.store.patch(p.item.id, { queued: false, cancelled: true });
    this.s.queued = 0;
    for (const r of this.requests.values()) this._cancelRequest(r, 'Session closed');
    if (this.starting) {
      try {
        await this.starting;
      } catch {}
    }
    const q = this.q;
    if (q) {
      this.closing = true;
      // A running tool keeps claude.exe alive for ~5 s after stdin closes (it is still aborting the
      // tool's process tree; measured live 2026-10-08), and the SDK only force-kills claude.exe 2 s +
      // 5 s later on Windows, leaving the tool's own children behind. When a tool was running, end
      // the CLI's process tree by PID after a short grace. Idle closes (SessionEnd hooks) are left alone.
      const toolRunning = [...this.norm.toolByUseId.values()].some((id) => (this.norm.store.get(id) || {}).status === 'running');
      if (toolRunning) killAfterGrace(q, CLOSE_KILL_GRACE_MS, (m) => this.engine.log('warn', m));
      if (this.q === q) {
        try {
          q.close();
        } catch {}
        this._onExit(null, this.input);
      }
    }
    this.s.status = final ? 'closed' : this.s.status === 'error' ? 'error' : 'idle';
    this.s.activity = null;
    this.s.turnStartedAt = null;
    if (shown && (shown.status === 'idle' || shown.status === 'error')) Object.assign(this.s, shown);
    // updatedAt = last used: the user's Close counts; Helm stopping the CLI itself (quit, account switch,
    // delete, rewind) does not, or every session with a live CLI would look just used after a restart.
    if (final) this.touch();
    else { this._emitUpdated(); this.engine.save(); }
    return {};
  }

  // ---------- requests (canUseTool) ----------
  _canUseTool(toolName, input, opts = {}) {
    const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission';
    // a production-guard request (prod-guard.js) is never covered by "Allow for this session"
    if (kind === 'permission' && !opts.guard && this.allowAlways.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const toolItem = opts.toolUseID ? this.norm.toolItem(opts.toolUseID) : null;
    const requestId = rid('req_');
    const item = {
      id: this.nextId(),
      type: 'request',
      ts: Date.now(),
      requestId,
      kind,
      toolName,
      input: input || {},
      status: 'pending',
      ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
      ...(toolItem && toolItem.parentToolUseId ? { parentToolUseId: toolItem.parentToolUseId } : {}),
      ...(kind === 'question' ? { questions: (input && input.questions) || [] } : {}),
      ...(kind === 'plan' ? { plan: (input && (input.plan || input.planContent)) || '' } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.decisionReason ? { reason: opts.decisionReason } : {}),
      ...(opts.blockedPath ? { blockedPath: opts.blockedPath } : {}),
      ...(opts.guard ? { guard: opts.guard } : {}),
    };
    return new Promise((resolve) => {
      const r = { resolve, item, input: input || {}, kind, toolUseId: opts.toolUseID, opts };
      this.requests.set(requestId, r);
      this.norm.store.add(item);
      if (opts.signal) {
        if (opts.signal.aborted) return this._cancelRequest(r, 'Cancelled');
        opts.signal.addEventListener('abort', () => this._cancelRequest(r, 'Cancelled'), { once: true });
      }
      this.s.status = 'waiting';
      this._refreshActivity();
      this.touch();
      const body = kind === 'question' ? truncate(oneLine(((input && input.questions) || [])[0]?.question || 'Claude has a question'), 140) : kind === 'plan' ? 'A plan is ready for review'
        : opts.guard ? `${opts.title}: ${truncate(oneLine((input && input.command) || toolName), 100)}` : `Allow ${toolName}? ${truncate(oneLine(describeTool({ name: toolName, input })), 100)}`;
      this.engine.notify({ title: this.s.title || 'Session', body, sessionId: this.s.id, kind: 'waiting' });
    });
  }

  _cancelRequest(r, why) {
    if (!this.requests.has(r.item.requestId)) return;
    this.requests.delete(r.item.requestId);
    if (r.item.status === 'pending') this.norm.store.patch(r.item.id, { status: 'cancelled' });
    try {
      r.resolve({ behavior: 'deny', message: why || 'Cancelled', interrupt: true });
    } catch {}
    this._afterRequest();
  }

  _afterRequest() {
    const stillPending = [...this.requests.values()].some((x) => x.item.status === 'pending');
    if (!stillPending && this.s.status === 'waiting') this.s.status = this.turnActive ? 'working' : 'idle';
    this._refreshActivity();
    this.touch();
  }

  async respond({ requestId, response }) {
    const r = this.requests.get(requestId);
    if (!r) throw Object.assign(new Error('No pending request with that id (already answered or cancelled)'), { code: 'not_found' });
    const resp = response || {};
    let result;
    if (r.kind === 'question') {
      if (resp.behavior === 'deny') result = { behavior: 'deny', message: resp.message || 'The user declined to answer.' };
      else {
        const answers = {};
        for (const [k, v] of Object.entries(resp.answers || {})) answers[k] = Array.isArray(v) ? v.join(', ') : String(v);
        result = { behavior: 'allow', updatedInput: { ...r.input, answers, ...(resp.annotations ? { annotations: resp.annotations } : {}) } };
        prodGuard.noteAnswer(this, r.item, answers); // lane guard: "Push to master now?" → "Yes"
      }
    } else if (r.kind === 'plan') {
      if (resp.behavior === 'allow') {
        const mode = resp.mode || (this.prePlanMode && this.prePlanMode !== 'plan' ? this.prePlanMode : 'default');
        result = { behavior: 'allow', updatedInput: r.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
        this.s.permissionMode = mode;
      } else {
        result = { behavior: 'deny', message: resp.message || 'The user rejected the plan. Ask what to change.' };
      }
    } else if (resp.behavior === 'allow') {
      result = { behavior: 'allow', updatedInput: r.input };
      if (resp.always && !r.item.guard) { // a production-guard card only ever allows once
        this.allowAlways.add(r.item.toolName);
        if (Array.isArray(r.opts.suggestions) && r.opts.suggestions.length) result.updatedPermissions = r.opts.suggestions;
      }
    } else {
      result = { behavior: 'deny', message: resp.message || 'The user denied this action.' };
      if (r.toolUseId) this.norm.markDenied(r.toolUseId);
    }
    if (result.behavior === 'deny' && r.toolUseId) this.norm.denied.add(r.toolUseId);
    this.requests.delete(requestId);
    this.norm.store.patch(r.item.id, { status: 'answered', answer: resp });
    r.resolve(result);
    this._afterRequest();
    return {};
  }

  // ---------- live settings ----------
  async update(p) {
    const s = this.s;
    if (typeof p.title === 'string' && p.title.trim()) {
      s.title = p.title.trim();
      s.titleAuto = false;
    }
    if (typeof p.pinned === 'boolean') s.pinned = p.pinned;
    if (p.model !== undefined && p.model !== s.model) {
      s.model = p.model || null;
      if (this.q) {
        await this.q.setModel(s.model && s.model !== 'default' ? s.model : undefined);
        // the transcript records this switch ("Set model to …"); show it live too
        this.norm.system('info', `Set model to ${s.model || 'default'}`);
      }
    }
    if (p.effort !== undefined && p.effort !== s.effort) {
      s.effort = p.effort || null;
      if (this.q && this.q.applyFlagSettings) await this.q.applyFlagSettings({ effortLevel: s.effort || null });
    }
    if (p.permissionMode !== undefined && p.permissionMode !== s.permissionMode) {
      if (p.permissionMode === 'plan' && s.permissionMode !== 'plan') this.prePlanMode = s.permissionMode;
      s.permissionMode = p.permissionMode;
      if (this.q) await this.q.setPermissionMode(s.permissionMode);
    }
    this.touch();
    return this.publicSession();
  }

  markRead() {
    // Not touch(): updatedAt means "last used" (the sidebar's active list and Past go by it), and every
    // open calls markRead, so looking at a session must not move it. Still broadcast + save the unread.
    this.s.unread = 0;
    this._emitUpdated();
    this.engine.save();
    return {};
  }

  // ---------- commands / models ----------
  async commands() {
    if (!this.q) return null;
    const list = await this.q.supportedCommands();
    return (list || []).map((c) => ({ name: c.name, description: c.description || '', argumentHint: c.argumentHint || '' }));
  }

  // ---------- checkpoints ----------
  async checkpoints() {
    await this.ensureLoaded();
    const out = [];
    let cur = null;
    for (const it of this.items) {
      // lane steer: a message folded into a running turn has no prompt line of its own to rewind to
      if (it.type === 'user' && it.uuid && !it.queued && !it.cancelled && it.steer !== 'seen' && it.steer !== 'pending') {
        cur = { id: it.uuid, itemId: it.id, ts: it.ts, text: truncate(oneLine(it.text), 120), files: [] };
        out.push(cur);
      } else if (cur && it.type === 'tool' && EDIT_TOOLS.has(it.name) && it.status === 'done') {
        const p = (it.input || {}).file_path || (it.input || {}).notebook_path;
        if (p && !cur.files.includes(p)) cur.files.push(p);
      }
    }
    return out.reverse();
  }

  async rewind({ checkpointId, files, conversation }) {
    await this.ensureLoaded();
    if (this.turnActive) throw Object.assign(new Error('Stop the current turn before rewinding'), { code: 'busy' });
    // Rewinding the conversation restarts the CLI, and its background agents die with it.
    const agentsLive = conversation && this.q ? this.fleet.runningCount() : 0;
    if (agentsLive) throw Object.assign(new Error(`${agentsLive} agent${agentsLive === 1 ? ' is' : 's are'} still running; wait for ${agentsLive === 1 ? 'it' : 'them'} (or stop the session) before rewinding the conversation`), { code: 'busy' });
    const userItem = this.items.find((i) => i.type === 'user' && i.uuid === checkpointId);
    if (!userItem) throw Object.assign(new Error('Unknown checkpoint'), { code: 'not_found' });
    const notes = [];
    if (files) {
      await this.start();
      const res = await this.q.rewindFiles(checkpointId);
      if (!res || !res.canRewind) throw Object.assign(new Error(`Cannot rewind files: ${(res && res.error) || 'no checkpoint data'}`), { code: 'rewind_failed' });
      notes.push(`files restored (${(res.filesChanged || []).length} changed, +${res.insertions || 0} −${res.deletions || 0})`);
    }
    let fork = null;
    if (conversation) {
      const dir = this.engine.projectsDir;
      // A fork whose CLI wrote its transcript but never reported init is a real fork now: record it.
      if (this.s.forkFrom && this.s.forkFrom.firstNew && findTranscript(this.s.claudeSessionId, this.s.cwd, dir)) this._forkTaken();
      const pend = this.s.forkFrom;
      // The transcript to fork: the session's own, or (a rewind still pending) the one it forks from.
      let sourceId = this.s.claudeSessionId;
      let file = findTranscript(sourceId, this.s.cwd, dir);
      if (!file && pend) {
        sourceId = pend.sourceId;
        file = findTranscript(sourceId, this.s.cwd, dir);
      }
      let at = null;
      if (file) {
        let line = findLineByUuid(file, checkpointId);
        // A prompt from before an earlier rewind's fork lives in a transcript this view was opened from
        // (a stitched history lists them all, newest first).
        const older = this.pager ? this.pager.files || [this.pager.file] : [];
        for (const f of older) {
          if (line || !f || f === file) continue;
          line = findLineByUuid(f, checkpointId);
          if (line) sourceId = path.basename(f, '.jsonl');
        }
        if (!line) throw Object.assign(new Error('That prompt is not in the transcript on disk yet'), { code: 'not_found' });
        at = line.parentUuid || null;
      }
      if (this.q) await this.close({ final: false });
      // shownId: the history the user is looking at (kept, rewound part folded, under the new markers) once
      // the fork exists. Rewinding again before sending keeps the earlier marker(s) under it too.
      const ownFile = findTranscript(this.s.claudeSessionId, this.s.cwd, dir);
      const shownId = ownFile ? this.s.claudeSessionId : pend ? pend.shownId || pend.sourceId : sourceId;
      const markers = pend ? pend.markers : [];
      fork = { sourceId, shownId, at, markers };
      this.s.claudeSessionId = randomUUID();
      this.s.context = null;
      notes.push('conversation rewound (Claude no longer sees anything from this prompt on)');
    }
    // `rewind` lets the UI mark what Claude no longer sees: items from fromItemId up to this marker.
    const text = `Rewound to before “${truncate(oneLine(userItem.text), 80)}”: ${notes.join('; ')}.`;
    const marker = this.norm.system('info', text, undefined, {
      rewind: { checkpointId, fromItemId: userItem.id, files: !!files, conversation: !!conversation },
    });
    if (fork) {
      // Saved with the session, so a restart before the next send still forks here (and shows this marker).
      fork.markers = [...fork.markers, { checkpointId, files: !!files, conversation: true, text, ts: (marker && marker.ts) || Date.now() }];
      this.s.forkFrom = fork;
    }
    this.touch();
    return {};
  }

  // ---------- `!` shell runs (sessions.shell / sessions.shellStop, shell-run.js) ----------
  // Independent of the CLI: works with no CLI, an idle one, or mid-turn. Output streams into a
  // `shell` item; Claude sees it with the next prompt sent to the CLI (_pushToCli).
  async shell({ command }) {
    await this.ensureLoaded();
    command = String(command == null ? '' : command);
    if (!command.trim()) throw Object.assign(new Error('Type a command after !'), { code: 'bad_request' });
    if (!fs.existsSync(this.s.cwd)) throw Object.assign(new Error(`Folder not found: ${this.s.cwd}`), { code: 'bad_request' });
    if (this.shells.size >= MAX_RUNNING_SHELL) throw Object.assign(new Error(`${MAX_RUNNING_SHELL} commands are already running here`), { code: 'busy' });
    const sh = (this.engine.pickShell || shellRun.pickShell)();
    const now = Date.now();
    const item = { id: rid('sh_', 4), type: 'shell', ts: now, command, cwd: this.s.cwd, shell: sh.kind, text: '', stdout: '', stderr: '', exitCode: null, status: 'running', startedAt: now, endedAt: null, shared: false };
    this.norm.store.add(item);
    const run = { proc: null, out: new shellRun.StreamBuf(), err: new shellRun.StreamBuf(), buf: '', timer: null, stopped: false };
    this.shells.set(item.id, run);
    run.proc = shellRun.runShell({
      command,
      cwd: this.s.cwd,
      shell: sh,
      onData: (kind, text) => this._shellData(item.id, kind, text),
      onExit: (r) => this._shellExit(item.id, r),
    });
    this.touch();
    return { itemId: item.id };
  }

  async shellStop({ itemId }) {
    const run = this.shells.get(itemId);
    if (!run) {
      const it = this.byId.get(itemId);
      if (it && it.type === 'shell') return {}; // already finished
      throw Object.assign(new Error('Unknown command'), { code: 'not_found' });
    }
    run.stopped = true;
    run.proc.stop();
    return {};
  }

  // Stop every running command (session deleted, Helm quitting). The items say "stopped" right away
  // so a save that follows keeps them pending as stopped runs.
  killShells() {
    for (const [id, run] of this.shells) {
      run.stopped = true;
      try {
        run.proc.stop();
      } catch {}
      const it = this.byId.get(id);
      if (it) Object.assign(it, { status: 'stopped', endedAt: Date.now() });
    }
  }

  _shellData(id, kind, text) {
    const run = this.shells.get(id);
    if (!run) return;
    run[kind === 'stderr' ? 'err' : 'out'].push(text);
    run.buf += text;
    if (!run.timer) run.timer = setTimeout(() => this._shellFlush(id), SHELL_FLUSH_MS);
  }

  _shellFlush(id) {
    const run = this.shells.get(id);
    const it = this.byId.get(id);
    if (!run || !it) return;
    clearTimeout(run.timer);
    run.timer = null;
    if (!run.buf) return;
    const add = run.buf;
    run.buf = '';
    if ((it.text || '').length + add.length > shellRun.DISPLAY_MAX) {
      // Keep the last ~1 MB for the card: one replacing patch instead of an append.
      this.norm.store.patch(id, { text: ((it.text || '') + add).slice(-shellRun.DISPLAY_MAX), clipped: true });
    } else {
      this.norm.store.patch(id, null, add);
    }
  }

  _shellExit(id, { code, signal, error }) {
    const run = this.shells.get(id);
    if (!run) return;
    this._shellFlush(id);
    this.shells.delete(id);
    const it = this.byId.get(id);
    if (!it) return;
    let stderr = run.err.context();
    if (error) stderr = [stderr, `Could not run the command: ${error.message}`].filter(Boolean).join('\n');
    const status = run.stopped ? 'stopped' : error ? 'error' : 'done';
    const patch = { stdout: run.out.context(), stderr, exitCode: typeof code === 'number' ? code : null, status, endedAt: Date.now() };
    if (signal && !run.stopped) patch.signal = signal;
    if (error && !it.text) patch.text = `Could not run the command: ${error.message}`;
    this.norm.store.patch(id, patch);
    this.touch(); // saves: a finished run waiting for the next prompt survives a restart
  }

  // Finished `!` runs Claude has not seen: their context text, marked shared. null when none.
  _takeShellContext() {
    const runs = this.items.filter((it) => it.type === 'shell' && !it.shared && it.status !== 'running');
    if (!runs.length) return null;
    const text = runs.map((it) => shellRun.shellContextBlock(it)).join('\n');
    for (const it of runs) this.norm.store.patch(it.id, { shared: true });
    return { text, ids: runs.map((it) => it.id) };
  }

  // What sessions.json keeps for `!` runs not sent yet (see constructor / ensureLoaded).
  pendingShellForSave() {
    if (!this.loaded) return this.s.pendingShell || [];
    return this.items
      .filter((it) => it.type === 'shell' && !it.shared)
      .slice(-MAX_PENDING_SHELL)
      .map((it) => {
        const o = { ...it, status: it.status === 'running' ? 'stopped' : it.status };
        // Saved mid-run (Helm going down): what Claude gets is what arrived so far.
        const run = this.shells.get(it.id);
        if (run) Object.assign(o, { status: 'stopped', stdout: run.out.context(), stderr: run.err.context(), endedAt: o.endedAt || Date.now() });
        if ((o.text || '').length > SHELL_PERSIST_TEXT) Object.assign(o, { text: o.text.slice(-SHELL_PERSIST_TEXT), clipped: true });
        return o;
      });
  }
}

module.exports = { EngineSession, describeTool, PUBLIC_FIELDS, VALID_MODES, CLAUDE_ID_RE };
