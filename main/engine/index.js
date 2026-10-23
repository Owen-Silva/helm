'use strict';
// Helm engine: runs the REAL Claude Code (the user's claude.exe via @anthropic-ai/claude-agent-sdk)
// for every Helm session and speaks docs/PROTOCOL.md.
//
//   const { createEngine } = require('./main/engine');
//   const engine = createEngine({ userDataDir, emit, log });
//   engine.methods['sessions.send'](params) → Promise<result>
//   engine.snapshot() → { sessions, usage }       (for app.hello)
//   await engine.shutdown()                        (stops every CLI; sessions stay resumable)
//
// Options (all but userDataDir/emit optional):
//   userDataDir   where sessions.json, history-index.json and uploads/ live
//   emit(event, data)  protocol events (session.*, fleet.updated, usage.updated, files.changed, notify)
//   log(level, msg)
//   getDefaults() → { model, effort, permissionMode, cwd }   (Helm settings.defaults)
//   claudePath    claude executable (default HELM_CLAUDE_EXE or ~/.local/bin/claude.exe)
//   sdk           injected SDK module { query } (tests); default dynamic import of the real SDK
//   projectsDir   Claude Code projects dir (default ~/.claude/projects)
//   statuslineDir mission-control status line dir (usage fallback)
//   etaDir        eta mod snapshots (default ~/.claude/mods-data/eta; false = no eta)
//   external      false = don't poll for Claude Code sessions running outside Helm
//   tempDir       sessions with a cwd under it are not listed as external (default os.tmpdir(); tests)
//   getIdleCloseMs() → ms   close a session's CLI after this long idle (idle-reaper.js; 0 / absent = never)
//   getKeep() → bool  Settings "Keep sessions running through a restart" (lane detach; HELM_DETACH=1/0 overrides)
//   detach        tests: true/false overrides getKeep and HELM_DETACH; broker: false = no CLI broker at all
//   brokerExecPath  what runs broker.js (default process.execPath with ELECTRON_RUN_AS_NODE=1)
//   idleCheckMs   how often the idle reaper looks (default 60 s)
//   childEnv(env) → env  the auth provider's env for every claude child (main/account.js: ANTHROPIC_API_KEY
//                 when the user saved an API key; otherwise untouched). Default: untouched.
//   startBlock() → null | { code, message }  why no claude child may start now (not signed in): sessions.send /
//                 sessions.create / sessions.fork with a prompt, the probe and every CLI start refuse with it
//   onAuthError(text)  a session's Claude Code said it can't authenticate (main/account.js noteAuthError)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { EngineSession, PUBLIC_FIELDS } = require('./session');
const { UsageTracker } = require('./usage');
const { computeChanges } = require('./changes');
const { projectsDir: defaultProjectsDir, findTranscript, lastCostState } = require('./transcript');
const { findLineByUuid } = require('./pager');
const { createExternalTracker } = require('./external');
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }; // lane logs: see createEngine's log
const { createIdleReaper } = require('./idle-reaper');
const { jobSafe } = require('./broker-launch'); // lane detach
const { V: BROKER_V } = require('./broker');
const { MIN_CLI_VERSION } = require('./keep-compat');
const { createScheduleBoard } = require('./schedules'); // lane sched: schedules.list / cancel / dismiss
const { stallTick, resumeStalled, STALL_TICK_MS } = require('./stall'); // lane stall: stalled turns, quiet agents
const { rid, writeJsonAtomic, readJsonOrQuarantine, baseName, debounce } = require('./util');
const { nextStartTurn } = require('../start-turn');   // lane helm-settings-freeze: one process start per turn
const { VALID_MODES, CLAUDE_ID_RE } = require('./session');

// ---------- param validation (RPC params come from any connected client) ----------
const MAX_TEXT = 1_000_000; // one prompt
const MAX_SHORT = 100; // model / effort / ids
const MAX_TITLE = 500;
const MAX_ATTACHMENTS = 50;

function bad(message) {
  return err(message, 'bad_params');
}
function optStr(p, key, max) {
  const v = p[key];
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') throw bad(`${key} must be a string`);
  if (v.length > max) throw bad(`${key} is too long`);
}
function reqId(p, key = 'id') {
  const v = p[key];
  if (typeof v !== 'string' || !v || v.length > MAX_SHORT) throw bad(`${key} must be a session id`);
}
function checkMode(v) {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || !VALID_MODES.has(v)) throw err(`Unknown permission mode ${typeof v === 'string' ? v : typeof v}`, typeof v === 'string' ? 'bad_request' : 'bad_params');
}
function checkAttachments(a) {
  if (a === undefined || a === null) return;
  if (!Array.isArray(a) || a.length > MAX_ATTACHMENTS) throw bad('attachments must be a list');
  for (const x of a) {
    if (!x || typeof x !== 'object') throw bad('each attachment must be an object');
    for (const k of ['name', 'mime', 'kind', 'path', 'dataUrl']) if (x[k] != null && typeof x[k] !== 'string') throw bad(`attachment ${k} must be a string`);
  }
}
function checkClaudeId(v) {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || !CLAUDE_ID_RE.test(v)) throw bad('resumeClaudeSessionId is not a Claude session id');
}
function checkCwd(v) {
  if (v === undefined || v === null || v === '') return;
  if (typeof v !== 'string' || v.length > 4096 || v.includes('\0')) throw bad('cwd must be a folder path');
  let st = null;
  try {
    st = fs.statSync(v);
  } catch {}
  if (!st) throw err(`Folder not found: ${v}`, 'bad_request');
  if (!st.isDirectory()) throw bad(`Not a folder: ${v}`);
}
const PROBE_TTL_MS = 10 * 60 * 1000;

// defaultClaudePath(): HELM_CLAUDE_EXE or ~/.local/bin/claude.exe, null → the SDK's bundled native binary
const { defaultClaudePath, buildChildEnv } = require('../claude-cli');

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

// The env every claude child Helm starts gets (sessions, probes): the user's own, unchanged except Helm's client
// tag and the not-nested markers (main/claude-cli.js baseChildEnv; no auth variable added or removed), then what
// the auth provider adds (main/account.js: ANTHROPIC_API_KEY only when the user saved an API key). Never logged.
function claudeEnv(childEnv) { return buildChildEnv(childEnv); }

// Why no claude child may start now ({ code, message }), or null. A provider that throws blocks with its message.
function startBlock(fn) {
  if (typeof fn !== 'function') return null;
  let b;
  try { b = fn(); } catch (e) { return { code: 'auth_required', message: `Could not check the sign-in: ${(e && e.message) || e}` }; }
  if (!b) return null;
  return { code: typeof b.code === 'string' && b.code ? b.code : 'auth_required', message: String(b.message || 'Claude Code is not signed in.') };
}

function createEngine(options = {}) {
  const userDataDir = options.userDataDir || path.join(os.homedir(), '.helm');
  const emitRaw = options.emit || (() => {});
  // lane logs: one level gate for every engine line. debug < info < warn < error; default info, or
  // options.logLevel / HELM_LOG_LEVEL (e.g. HELM_LOG_LEVEL=debug brings back the full task_* JSON). Lines
  // under the level are dropped before they reach main.log; unknown levels always pass.
  const logSink = options.log || ((level, msg) => (level === 'error' ? console.error(msg) : undefined));
  let logMin = LOG_LEVELS[String(options.logLevel || process.env.HELM_LOG_LEVEL || '').toLowerCase()] || LOG_LEVELS.info;
  const logEnabled = (level) => !(LOG_LEVELS[level] < logMin);
  const log = (level, msg) => { if (logEnabled(level)) logSink(level, msg); };
  const getDefaults = options.getDefaults || (() => ({}));
  const projectsDir = options.projectsDir || defaultProjectsDir();
  const sessionsFile = path.join(userDataDir, 'sessions.json');
  fs.mkdirSync(userDataDir, { recursive: true });

  let usageHistory = null; // set below once usage exists; samples every usage change
  let recap = null; // lane recap: "Since you left" on Home (recap.js), fed from this same event stream
  const emit = (event, data) => {
    if (event === 'usage.updated' && usageHistory) usageHistory.sample(data);
    if (recap) { try { recap.onEvent(event, data); } catch (e) { log('error', `engine: recap ${event} failed: ${e.message}`); } }
    try {
      emitRaw(event, data);
    } catch (e) {
      log('error', `engine: emit ${event} failed: ${e.message}`);
    }
  };

  // lane detach: Settings > Helm "Keep sessions running through a restart" (options.getKeep), default off.
  // HELM_DETACH=1 / =0 overrides the setting; options.detach (tests) overrides both when set.
  const keepOn = () => {
    if (options.detach !== undefined) return !!options.detach;
    if (process.env.HELM_DETACH === '1') return true;
    if (process.env.HELM_DETACH === '0') return false;
    try { return !!(options.getKeep && options.getKeep()); } catch { return false; }
  };
  let sdkVer;
  const sdkVersion = () => {
    if (sdkVer !== undefined) return sdkVer;
    if (options.sdkVersion !== undefined) return (sdkVer = options.sdkVersion);
    try { sdkVer = JSON.parse(fs.readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version || null; } catch { sdkVer = null; }
    return sdkVer;
  };

  let sdkPromise = null;
  const loadSdk = () => {
    if (options.sdk) return Promise.resolve(options.sdk);
    if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
    return sdkPromise;
  };
  // lane helm-settings-freeze: importing the SDK compiles ~1.2 MB of ESM on the main thread (180-400 ms measured).
  // Before any session has started, the first Settings open paid that inside sessions.models (the probe). Load it
  // once Helm has been up a while instead; a session starting first loads it anyway.
  if (!options.sdk && options.prewarmSdk !== false) {
    const warm = setTimeout(() => { loadSdk().catch((e) => log('warn', `engine: loading the Claude Agent SDK failed: ${e && e.message}`)); }, 30_000);
    if (warm.unref) warm.unref();
  }

  const usage = new UsageTracker({ emit, statuslineDir: options.statuslineDir, now: options.now });
  // Usage history (usage.history): 5H/week samples every ~5 min and on every change, plus cost per
  // session per day from result messages. <userData>/usage-history.jsonl, bounded to 14 days.
  try {
    const { UsageHistory } = require('./usage-history');
    usageHistory = new UsageHistory({ file: path.join(userDataDir, 'usage-history.jsonl'), now: options.now, log });
    const addCost = usage.addCost.bind(usage);
    usage.addCost = (deltaUsd, meta = {}) => {
      // Ledger first: the usage.updated that addCost publishes reads today's cost from it.
      if (deltaUsd > 0) usageHistory.addCost({ usd: deltaUsd, sessionId: meta.sessionId || null, project: meta.project || null });
      addCost(deltaUsd);
    };
    usage.costLedger = usageHistory; // cost today survives a Helm restart
    if (options.usageSampling !== false) usageHistory.start(() => usage.get());
  } catch (e) {
    usageHistory = null;
    log('error', `engine: usage history is off: ${e.message}`);
  }
  const sessions = new Map(); // id → EngineSession
  const probeCache = new Map(); // cwd key → { at, commands, models }
  const probeInflight = new Map();
  let modelsCache = null;
  let lastInit = null;
  let history = null;

  const persist = () => {
    const list = [...sessions.values()].map((es) => {
      const o = { ...es.publicSession(), titleAuto: es.s.titleAuto !== false };
      // A conversation rewind the next send has not taken up yet (see EngineSession.rewind).
      if (es.s.forkFrom) o.forkFrom = es.s.forkFrom;
      // Sent conversation rewinds: what history stitches back in (marker + rewound fold) after a restart.
      if (es.s.rewinds && es.s.rewinds.length) o.rewinds = es.s.rewinds;
      if (es.s.costBasis) o.costBasis = es.s.costBasis; // costUsd is Claude Code's own figure (see the load below)
      // lane detach: a CLI the last restart kept running (session.js detachCli): the next Helm re-attaches to it
      if (es.s.kept) o.kept = es.s.kept;
      // `!` runs Claude has not seen yet: the next prompt sends them, even after a restart.
      const pendingShell = es.pendingShellForSave();
      if (pendingShell.length) o.pendingShell = pendingShell;
      // Live state never survives a restart.
      if (o.status === 'working' || o.status === 'waiting') o.status = 'idle';
      o.activity = null;
      o.turnStartedAt = null;
      o.queued = 0;
      delete o.eta; // re-read from the eta mod's file on load
      delete o.pendingRequest; // live only: requests never survive a restart (lastText is kept)
      delete o.agentsRunning; // live only: agents die with the CLI
      delete o.openTasks; // live only: background tasks die with the CLI too
      if (!o.restartNote) delete o.restartNote; // lane restart: kept only while there is one
      return o;
    });
    try {
      writeJsonAtomic(sessionsFile, { version: 1, sessions: list });
    } catch (e) {
      log('error', `engine: could not save sessions.json: ${e.message}`);
    }
  };
  const save = debounce(persist, 400);

  const ctx = {
    emit,
    log,
    logEnabled, // lane logs: skip building debug-only JSON at info
    loadSdk,
    usage,
    userDataDir,
    projectsDir,
    etaDir: options.etaDir,
    pickShell: options.pickShell, // tests: which shell `!` runs use (default shell-run.js pickShell)
    claudePath: options.claudePath !== undefined ? options.claudePath : defaultClaudePath(),
    // auth (main/account.js): the env every claude child gets, why none may start right now, and a session's
    // own "not signed in" error (the provider looks at Claude Code's sign-in again)
    claudeEnv: () => claudeEnv(options.childEnv),
    startBlock: () => startBlock(options.startBlock),
    onAuthError: (text) => { if (typeof options.onAuthError === 'function') { try { options.onAuthError(text); } catch {} } },
    save: () => save(),
    notify: (n) => emit('notify', n),
    onInit: (es, info) => {
      lastInit = { ...info, at: Date.now() };
    },
    // lane detach: with keepOn(), new CLIs run in a detached broker process (broker.js) so a Helm restart detaches
    // from running turns instead of killing them. The client always exists: a relaunched Helm re-attaches to what a
    // broker kept even if the setting was turned off since.
    broker: options.broker === false ? null : require('./broker-client').createBrokerClient({ stateDir: userDataDir, execPath: options.brokerExecPath || process.execPath, log: (lvl, m) => log(lvl, m) }),
    keepOn: () => keepOn(),
    // false when the broker sits in a Windows job it could not leave (broker-launch.js): a restart may take it down
    keepSafe: () => { const b = ctx.broker; return !!b && jobSafe(b.job()) !== false; },
    sdkVersion: () => sdkVersion(),
  };

  // Claude Code's own cost for a conversation: the LARGER of its status line record (rewritten after every
  // turn of an interactive terminal run) and the newest cost-state line in its transcript (written when any CLI
  // ends, Helm's included). Both are the same conversation's running total, which only grows, so the larger is
  // the newer. The status line alone went stale once a terminal conversation was carried on in Helm (no status
  // line there): s_5b913c79 read $320.44 from a 10-08 record while its 10-10 cost-state said $525.78.
  // null when neither exists.
  function claudeCodeCost(s) {
    let sl = null;
    let cs = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(usage.dir, `${s.claudeSessionId}.json`), 'utf8'));
      if (j && j.cost && typeof j.cost.total_cost_usd === 'number' && (!j.session_id || j.session_id === s.claudeSessionId)) sl = j.cost.total_cost_usd;
    } catch {}
    try {
      const f = findTranscript(s.claudeSessionId, s.cwd, projectsDir);
      const st = f ? lastCostState(f) : null;
      if (st && typeof st.totalCostUSD === 'number') cs = st.totalCostUSD;
    } catch {}
    if (sl == null) return cs;
    if (cs == null) return sl;
    return Math.max(sl, cs);
  }

  // ---------- load persisted sessions ----------
  const saved = readJsonOrQuarantine(sessionsFile, { sessions: [] }, (aside, e) => {
    log('error', `engine: sessions.json is corrupt (${e.message}); moved it to ${path.basename(aside)} and started with no sessions`);
  });
  for (const raw of Array.isArray(saved && saved.sessions) ? saved.sessions : []) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.cwd !== 'string') continue;
    const s = { ...raw };
    if (s.status === 'working' || s.status === 'waiting') s.status = 'idle';
    Object.assign(s, { activity: null, turnStartedAt: null, queued: 0, archived: s.archived === true });
    // A cost saved before 2026-10-14 is Helm's own sum, which re-added the conversation's lifetime cost on
    // every resume (inflated up to 20x). Replace it with Claude Code's figure; unknown (null) when there is none.
    if (s.costBasis !== 'cc' && s.costUsd != null) {
      const cc = s.claudeSessionId ? claudeCodeCost(s) : null;
      s.costUsd = cc == null ? null : Math.round(cc * 1e6) / 1e6;
      s.costBasis = 'cc';
    }
    sessions.set(s.id, new EngineSession(ctx, s));
  }
  // lane recap: lastSeen + what each session did since, in <userData>/recap.json (sessions.recap)
  try {
    recap = require('./recap').createRecap({
      file: path.join(userDataDir, 'recap.json'), knownIds: [...sessions.keys()], emit, log, now: options.now,
      getSession: (id) => { const es = sessions.get(id); return es && !es.removed ? es.publicSession() : null; },
    });
  } catch (e) {
    recap = null;
    log('error', `engine: recap is off: ${e.message}`);
  }

  function get(id) {
    if (typeof id !== 'string' || !id || id.length > MAX_SHORT) throw bad('id must be a session id');
    const es = sessions.get(id);
    if (!es) throw err(`Unknown session ${id}`, 'not_found');
    return es;
  }

  // Not signed in / no readable key (main/account.js): say so instead of starting a claude child that cannot reach Claude.
  function refuseIfBlocked() {
    const b = ctx.startBlock();
    if (b) throw err(b.message, b.code);
  }

  function newSessionData(p) {
    const d = getDefaults() || {};
    const cwd = p.cwd || d.cwd || os.homedir();
    const permissionMode = p.permissionMode || d.permissionMode || 'bypassPermissions';
    if (!VALID_MODES.has(permissionMode)) throw err(`Unknown permission mode ${permissionMode}`, 'bad_request');
    const now = Date.now();
    return {
      id: rid('s_', 4),
      claudeSessionId: p.resumeClaudeSessionId || null,
      title: 'New session',
      titleAuto: true,
      cwd,
      project: baseName(cwd),
      status: 'idle',
      model: p.model || d.model || null,
      effort: p.effort || d.effort || 'xhigh',
      permissionMode,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      costBasis: 'cc', // a new conversation: Claude Code's counter starts at 0 (resumes fill it from the transcript)
      context: null,
      activity: null,
      turnStartedAt: null,
      unread: 0,
      queued: 0,
      pinned: false,
      archived: false,
    };
  }

  function getHistory() {
    if (!history) {
      const { createHistoryIndex } = require('./history');
      history = createHistoryIndex({ projectsDir, cacheFile: path.join(userDataDir, 'history-index.json'), log });
    }
    return history;
  }

  // A throwaway CLI (no prompt, nothing persisted) to read commands/models when no session
  // in that folder is running.
  async function probe(cwd) {
    const key = cwd.toLowerCase();
    const hit = probeCache.get(key);
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit;
    if (probeInflight.has(key)) return probeInflight.get(key);
    const blocked = ctx.startBlock();
    if (blocked) throw err(blocked.message, blocked.code);
    const run = (async () => {
      await nextStartTurn();   // its claude.exe start gets a turn of its own (main/start-turn.js)
      const sdk = await loadSdk();
      const { PushStream } = require('./util');
      const input = new PushStream();
      const env = ctx.claudeEnv();
      const q = sdk.query({
        prompt: input,
        options: {
          cwd,
          settingSources: ['user', 'project', 'local'],
          persistSession: false,
          env,
          ...(ctx.claudePath ? { pathToClaudeCodeExecutable: ctx.claudePath } : {}),
        },
      });
      let startTimer = null;
      try {
        const init = await Promise.race([q.initializationResult(), new Promise((_, rej) => (startTimer = setTimeout(() => rej(new Error('Claude Code did not start within 30s')), 30000)))]);
        const out = { at: Date.now(), commands: init.commands || [], models: init.models || [] };
        probeCache.set(key, out);
        if (out.models.length) modelsCache = out.models;
        return out;
      } finally {
        clearTimeout(startTimer);
        input.close();
        try {
          q.close();
        } catch {}
      }
    })();
    probeInflight.set(key, run);
    try {
      return await run;
    } finally {
      probeInflight.delete(key);
    }
  }

  // Claude Code sessions on this machine that Helm does not own (the user's terminal sessions).
  const ownedIds = () => {
    const set = new Set();
    for (const es of sessions.values()) {
      if (es.s.claudeSessionId) set.add(es.s.claudeSessionId);
      if (es.pager && es.pager.file) set.add(path.basename(es.pager.file, '.jsonl'));
    }
    return set;
  };
  const external = createExternalTracker({ projectsDir, etaDir: options.etaDir || undefined, isOwned: (cid) => ownedIds().has(cid), emit, log, ...(options.tempDir ? { tempDir: options.tempDir } : {}) });
  if (options.external !== false) external.start();

  // lane reaper: close a session's CLI once it is truly idle (es.busyState(), the restart gate's own check,
  // says nothing is running) for the Settings window. The session stays listed as it was and resumes on
  // its next send / rewind / anything needing the CLI (EngineSession.start counts + logs that).
  // lane tabrelease: which sessions each connected client has on screen (sessions.viewing): the desktop's tab +
  // split panes, a phone / web page's open session while it is visible. A release never closes one still on screen.
  const viewers = new Map(); // client key -> Set(session id)
  const clientKey = (client) => (client && client.id != null ? String(client.id) : 'local');
  const viewedBy = (id, exceptKey) => {
    for (const [k, ids] of viewers) if (k !== exceptKey && ids.has(id)) return k;
    return null;
  };
  // lane recap: every session on any client's screen (lastSeen / recap clear)
  const syncRecapViewing = () => { if (recap) recap.setViewing([...viewers.values()].flatMap((ids) => [...ids])); };
  const reaper = createIdleReaper({
    sessions,
    isBusy: (es) => !!es.busyState(),
    isVisible: (es) => !!viewedBy(es.s.id),
    // reaper-only: a /loop wake-up or cron job still due inside the CLI (schedules.js). Not in busyState(), so
    // the restart gate is not blocked forever by a cron; an update restart still ends in-CLI schedules.
    isHeld: (es) => (es.schedules ? es.schedules.pending() : null),
    idleMs: () => (options.getIdleCloseMs ? options.getIdleCloseMs() : 0),
    everyMs: options.idleCheckMs,
    log,
  });
  ctx.idleResumed = () => reaper.noteResume();
  // lane stall: every 30 s, stalled turns (Session.stalledSince) and each running agent's own transcript (stall.js)
  const stallTimer = setInterval(() => { for (const es of sessions.values()) stallTick(es); }, options.stallTickMs || STALL_TICK_MS);
  if (stallTimer.unref) stallTimer.unref();
  // lane sched: every pending in-CLI schedule across sessions (schedules.js createScheduleBoard). "Ask Claude to
  // cancel" goes through sessions.send (visible in the transcript); `schedules-at-exit.json` feeds "Ended by restart".
  const board = createScheduleBoard({ sessions, emit, log, file: path.join(userDataDir, 'schedules-at-exit.json'),
    // origin 'helm': Helm wrote this text, not the user, so the production guard neither grants nor revokes on it
    send: (id, text) => methods['sessions.send']({ id, text, origin: 'helm' }) });
  const idleInfo = () => ({
    idleMs: options.getIdleCloseMs ? Number(options.getIdleCloseMs()) || 0 : 0,
    ...reaper.stats(),
    live: [...sessions.values()].filter((es) => es.live()).length,
  });

  const mapCommands = (list) => (list || []).map((c) => ({ name: c.name, description: c.description || '', argumentHint: c.argumentHint || '' }));

  // Create (and register) a Helm session; resumes load their transcript first. No prompt is sent.
  async function buildSession(p) {
    const data = newSessionData(p);
    if (!fs.existsSync(data.cwd)) throw err(`Folder not found: ${data.cwd}`, 'bad_request');
    if (p.resumeClaudeSessionId && !p.cwd) {
      // Take cwd/title from the transcript index when the caller only knows the id (with a cwd,
      // ensureLoaded() reads the title from the transcript itself; the index can take seconds
      // to build cold).
      try {
        const h = (await getHistory().search({ q: p.resumeClaudeSessionId, limit: 1 }))[0];
        if (h && h.claudeSessionId === p.resumeClaudeSessionId) {
          if (!p.cwd && h.cwd && fs.existsSync(h.cwd)) {
            data.cwd = h.cwd;
            data.project = baseName(h.cwd);
          }
          if (h.title) data.title = h.title;
        }
      } catch {}
    }
    const es = new EngineSession(ctx, data);
    sessions.set(data.id, es);
    if (p.resumeClaudeSessionId) await es.ensureLoaded();
    emit('session.created', es.publicSession());
    save();
    return es;
  }
  const resumeInflight = new Map(); // resumeClaudeSessionId → Promise<EngineSession>

  const methods = {
    async 'sessions.create'(p = {}) {
      if (!p || typeof p !== 'object') throw bad('params must be an object');
      checkClaudeId(p.resumeClaudeSessionId);
      checkCwd(p.cwd);
      checkMode(p.permissionMode);
      optStr(p, 'model', MAX_SHORT);
      optStr(p, 'effort', MAX_SHORT);
      optStr(p, 'prompt', MAX_TEXT);
      checkAttachments(p.attachments);
      // not signed in / no readable key (main/account.js): refused before a session is made, so nothing half-made is left behind
      if (p.prompt || (p.attachments && p.attachments.length)) refuseIfBlocked();
      const cid = p.resumeClaudeSessionId || null;
      // Two clients resuming the same Claude session at once (double tap, phone + desktop) must get
      // ONE Helm session: two CLIs resuming one transcript would interleave writes into it.
      let es = cid ? [...sessions.values()].find((x) => x.s.claudeSessionId === cid) : null;
      if (!es && cid && resumeInflight.has(cid)) es = await resumeInflight.get(cid);
      if (!es) {
        const pending = buildSession(p);
        if (cid) {
          resumeInflight.set(cid, pending);
          pending.then(
            () => resumeInflight.delete(cid),
            () => resumeInflight.delete(cid),
          );
        }
        es = await pending;
      }
      if (p.prompt || (p.attachments && p.attachments.length)) await es.send({ text: p.prompt || '', attachments: p.attachments, origin: p.origin === 'helm' ? 'helm' : 'user' });
      return es.publicSession();
    },

    // A new session holding the source's conversation up to (not including) the prompt itemId, or
    // all of it. The SDK's forkSession copies the transcript into a new session file right away, so
    // the fork shows (and keeps, across restarts) the inherited items before its CLI ever starts.
    async 'sessions.fork'(p = {}) {
      optStr(p, 'itemId', MAX_SHORT);
      optStr(p, 'text', MAX_TEXT);
      checkAttachments(p.attachments);
      if (p.text || (p.attachments && p.attachments.length)) refuseIfBlocked();
      const src = get(p.id);
      await src.ensureLoaded();
      let item = null;
      if (p.itemId) {
        item = src.byId.get(p.itemId);
        if (!item || item.type !== 'user') throw err('Fork from one of your prompts', 'bad_request');
        if (item.queued || item.cancelled || !item.uuid) throw err('That prompt has not been sent yet', 'bad_request');
        // lane steer: folded into a running turn, so the transcript has no prompt line to fork at
        if (item.steer === 'seen' || item.steer === 'pending') throw err('That message was sent mid-turn; fork from the prompt that started the turn', 'bad_request');
      } else if (src.turnActive) {
        throw err('Stop the current turn before forking the whole conversation', 'busy');
      }
      const data = newSessionData({ cwd: src.s.cwd, model: src.s.model, effort: src.s.effort, permissionMode: src.s.permissionMode });
      if (!fs.existsSync(data.cwd)) throw err(`Folder not found: ${data.cwd}`, 'bad_request');
      data.title = `${src.s.title || 'New session'} (fork)`;
      data.titleAuto = false;
      // The prompt can live in the current transcript or, after a conversation rewind, in the one
      // the session was opened from.
      const files = [];
      const cur = src.s.claudeSessionId ? findTranscript(src.s.claudeSessionId, src.s.cwd, projectsDir) : null;
      if (cur) files.push(cur);
      if (src.pager && src.pager.file && src.pager.file !== cur) files.push(src.pager.file);
      let from = null; // { sourceId, upTo } — upTo undefined = whole conversation
      if (item) {
        for (const file of files) {
          const line = findLineByUuid(file, item.uuid);
          if (!line) continue;
          from = { sourceId: path.basename(file, '.jsonl'), upTo: line.parentUuid || null };
          break;
        }
        if (!from && files.length) throw err('That prompt is not in the transcript on disk yet', 'not_found');
        if (from && from.upTo === null) from = null; // forking at the first prompt: nothing to inherit
      } else if (cur) {
        from = { sourceId: src.s.claudeSessionId, upTo: undefined };
      } else if (src.s.forkFrom && src.s.forkFrom.at) {
        // A conversation rewind not sent yet: the whole conversation is the kept part of its source.
        from = { sourceId: src.s.forkFrom.sourceId, upTo: src.s.forkFrom.at };
      }
      if (from) {
        const sdk = await loadSdk();
        if (typeof sdk.forkSession !== 'function') throw err('This Claude Agent SDK cannot fork sessions', 'unsupported');
        const r = await sdk.forkSession(from.sourceId, { ...(from.upTo ? { upToMessageId: from.upTo } : {}), title: data.title });
        if (!r || !r.sessionId) throw err('Claude Code did not return the forked session', 'fork_failed');
        data.claudeSessionId = r.sessionId;
      }
      const es = new EngineSession(ctx, data);
      sessions.set(data.id, es);
      await es.ensureLoaded();
      if (data.titleAuto === false) es.s.title = data.title;
      emit('session.created', es.publicSession());
      save();
      if (p.text || (p.attachments && p.attachments.length)) await es.send({ text: p.text || '', attachments: p.attachments, origin: p.origin === 'helm' ? 'helm' : 'user' });
      return es.publicSession();
    },

    async 'sessions.history'(p = {}) {
      optStr(p, 'before', MAX_SHORT);
      return get(p.id).history({ before: p.before, limit: p.limit });
    },

    async 'sessions.send'(p = {}) {
      optStr(p, 'text', MAX_TEXT);
      checkAttachments(p.attachments);
      reaper.unmark(get(p.id)); // lane tabrelease: in use again, the normal idle window applies
      // origin 'helm' = a send Helm generated itself (handoff, stall Resume); anything else from a client is the user
      return get(p.id).send({ text: p.text, attachments: p.attachments, origin: p.origin === 'helm' ? 'helm' : 'user' });
    },

    // `!` shell mode: run a command in the session folder; Claude sees it with the next prompt.
    async 'sessions.shell'(p = {}) {
      optStr(p, 'command', 100_000); // same cap sessions.json accepts for a pending run
      reaper.unmark(get(p.id));
      return get(p.id).shell({ command: p.command });
    },

    async 'sessions.shellStop'(p = {}) {
      reqId(p, 'itemId');
      return get(p.id).shellStop({ itemId: p.itemId });
    },

    // lane steer: refused with code 'agents_running' (data.agents) while agents run, unless stopAgents: true
    // (the user confirmed a Stop that names them; ui/lib/stop.js).
    async 'sessions.interrupt'(p = {}) {
      if (p.stopAgents !== undefined && typeof p.stopAgents !== 'boolean') throw bad('stopAgents must be a boolean');
      return get(p.id).interrupt({ stopAgents: p.stopAgents === true });
    },

    // lane restart: the restart note's Continue / dismiss (PROTOCOL "Restart note")
    async 'sessions.continueAfterRestart'(p = {}) {
      return get(p.id).continueAfterRestart();
    },

    'sessions.dismissRestartNote'(p = {}) {
      return { dismissed: get(p.id).dismissRestartNote() };
    },

    // lane stall: the user confirmed Resume on a stalled session (stall.js resumeStalled; refuses unless stalled now)
    async 'sessions.resumeStalled'(p = {}) {
      return resumeStalled(get(p.id), { stopAgents: p.stopAgents === true }); // lane steer: agents named in the confirm
    },

    async 'sessions.respond'(p = {}) {
      reqId(p, 'requestId');
      const r = p.response;
      if (r != null && (typeof r !== 'object' || Array.isArray(r))) throw bad('response must be an object');
      // A plan approval's mode becomes the session's permission mode: only known modes.
      if (r && r.mode != null && (typeof r.mode !== 'string' || !VALID_MODES.has(r.mode))) throw bad(`Unknown permission mode ${typeof r.mode === 'string' ? r.mode : typeof r.mode}`);
      optStr(r || {}, 'message', MAX_TEXT);
      return get(p.id).respond({ requestId: p.requestId, response: p.response });
    },

    async 'sessions.update'(p = {}) {
      if (p.permissionMode !== undefined && !VALID_MODES.has(p.permissionMode)) throw err(`Unknown permission mode ${p.permissionMode}`, 'bad_request');
      optStr(p, 'model', MAX_SHORT);
      optStr(p, 'effort', MAX_SHORT);
      optStr(p, 'title', MAX_TITLE);
      return get(p.id).update(p);
    },

    async 'sessions.close'(p = {}) {
      return get(p.id).close({ final: true });
    },

    // Archive: out of the main list (the UI shows an Archived group), CLI stopped, still resumable.
    // Sending to an archived session brings it back (session.js send()).
    async 'sessions.archive'(p = {}) {
      if (p.archived !== undefined && typeof p.archived !== 'boolean') throw bad('archived must be a boolean');
      const es = get(p.id);
      const archived = p.archived !== false;
      if (archived && (es.live() || es.starting)) await es.close({ final: true });
      es.s.archived = archived;
      // Send it now, not on the 60 ms debounce: the list should move with the reply.
      es._emitUpdated();
      if (es._emitUpdated.flush) es._emitUpdated.flush();
      save();
      return { ...es.publicSession(), archived };
    },

    // Delete from Helm: drops Helm's record only. Claude Code's transcript under ~/.claude/projects
    // is never touched, so the session can still be found in History and resumed.
    async 'sessions.delete'(p = {}) {
      const es = get(p.id);
      if (es.live() || es.starting) await es.close({ final: false }).catch(() => {});
      es.killShells();
      es.removed = true;
      if (es._emitUpdated.cancel) es._emitUpdated.cancel();
      es._emitUpdated = () => {}; // a late exit/eta tick must not resurrect it in the UI
      try { es._stopEta(); } catch {}
      sessions.delete(es.s.id);
      emit('session.removed', { id: es.s.id });
      save();
      return {};
    },

    async 'sessions.commands'(p = {}) {
      const es = get(p.id);
      if (es.live()) {
        const list = await es.commands();
        if (list) return list;
      }
      const out = await probe(es.s.cwd);
      return mapCommands(out.commands);
    },

    async 'sessions.models'() {
      if (modelsCache) return modelsCache;
      const liveOne = [...sessions.values()].find((es) => es.live());
      if (liveOne) {
        try {
          modelsCache = await liveOne.q.supportedModels();
          return modelsCache;
        } catch {}
      }
      const out = await probe(os.homedir());
      return out.models;
    },

    async 'sessions.checkpoints'(p = {}) {
      return get(p.id).checkpoints();
    },

    async 'sessions.rewind'(p = {}) {
      optStr(p, 'checkpointId', MAX_SHORT);
      return get(p.id).rewind({ checkpointId: p.checkpointId, files: !!p.files, conversation: !!p.conversation });
    },

    async 'sessions.markRead'(p = {}) {
      return get(p.id).markRead();
    },

    ...board.methods, // lane sched: schedules.list / schedules.cancel / schedules.dismiss

    // lane reaper: Settings -> Helm ("N idle sessions closed"). { idleMs, closed, resumed, lastClosedAt, live }
    async 'sessions.idleStats'() {
      return idleInfo();
    },

    // lane detach: Settings > Helm "Keep sessions running through a restart" status line.
    // -> { on, override: 'on'|'off'|null, safe: true|false|null, job, kept: n (live sessions a restart would keep),
    //      brokers: [{ pid, stamp, v, current, draining, job, clis, attached, orphaned }] }
    async 'sessions.keepStatus'() {
      const b = ctx.broker;
      let brokers = [];
      if (b) { try { brokers = await b.status(); } catch (e) { log('warn', `engine: broker status failed: ${e.message}`); } }
      const job = b ? b.job() : null;
      const override = options.detach !== undefined ? (options.detach ? 'on' : 'off') : process.env.HELM_DETACH === '1' ? 'on' : process.env.HELM_DETACH === '0' ? 'off' : null;
      return { on: keepOn(), override, safe: b ? jobSafe(job) : false, job, kept: [...sessions.values()].filter((es) => es.canKeep()).length, brokers };
    },

    // lane tabrelease: the user closed this session's tab. Idle (and no /loop wake-up or cron due) -> its claude.exe
    // closes now, quietly (same close as the idle reaper; the next send resumes). Busy or schedule-held -> marked:
    // the reaper closes it once idle. Still on another client's screen -> nothing (the idle window applies).
    // The caller only sends this when the session is no longer on its own screen (ui/lib/tab-state.js stillShown).
    // -> { action: 'closed' | 'marked' | 'kept' | 'none', reason? }
    async 'sessions.release'(p = {}, client) {
      const es = get(p.id);
      const me = clientKey(client);
      const mine = viewers.get(me);
      if (mine) mine.delete(es.s.id);
      syncRecapViewing();
      const other = viewedBy(es.s.id, me);
      if (other) { reaper.unmark(es); return { action: 'kept', reason: 'open on another screen' }; }
      return reaper.release(es);
    },

    // lane tabrelease: the sessions this client has on screen now (replaces its last report; [] = none). Viewing a
    // session clears a pending release, so re-opening a closed tab (or the phone opening it) keeps the CLI.
    async 'sessions.viewing'(p = {}, client) {
      if (!Array.isArray(p.ids) || p.ids.length > 8 || p.ids.some((x) => typeof x !== 'string' || !x || x.length > MAX_SHORT)) throw bad('ids must be a list of up to 8 session ids');
      const ids = new Set(p.ids);
      const key = clientKey(client);
      if (ids.size) viewers.set(key, ids); else viewers.delete(key);
      for (const id of ids) { const es = sessions.get(id); if (es) reaper.unmark(es); }
      syncRecapViewing();
      return {};
    },

    // lane recap: Home's "Since you left" rows, from recap.js's running summaries (no transcript reads).
    // -> { rows: [{ id, title, project, outcome, error, commits, commitSubject, fileCount, files, costUsd, from, to, seenAt }] }
    async 'sessions.recap'() {
      return { rows: recap ? recap.list() : [] };
    },

    async 'history.search'(p = {}) {
      optStr(p, 'q', 1000);
      const list = await getHistory().search({ q: p.q || '', limit: p.limit || 50, includeTemp: p.includeTemp === true });
      const byClaude = new Map();
      for (const es of sessions.values()) if (es.s.claudeSessionId) byClaude.set(es.s.claudeSessionId, es.s.id);
      return list.map((h) => ({ ...h, ...(byClaude.has(h.claudeSessionId) ? { helmSessionId: byClaude.get(h.claudeSessionId) } : {}) }));
    },

    async 'external.list'() {
      external.wake(); // lane logs: a screen is asking, so leave the idle back-off
      return external.list();
    },

    async 'external.history'(p = {}) {
      return external.history({ claudeSessionId: p.claudeSessionId, before: p.before, limit: p.limit });
    },

    // One subagent's own transcript (lane agent-drill; main/engine/agent-transcript.js).
    async 'agents.transcript'(p = {}) {
      return require('./agent-transcript').agentTranscript(get(p.sessionId), p, projectsDir);
    },

    async 'usage.get'() {
      return usage.get();
    },

    async 'usage.history'(p = {}) {
      if (p.days !== undefined && !(typeof p.days === 'number' && Number.isFinite(p.days))) throw bad('days must be a number');
      if (!usageHistory) throw err('Usage history is not available (see the Helm log)', 'unavailable');
      return usageHistory.history({ days: p.days === undefined ? 1 : p.days });
    },

    // lane eta-accuracy: the eta mod's finished-task history (Usage > Estimates). Async read, read-only.
    async 'eta.accuracy'() {
      if (options.etaDir === false) throw err('The eta mod is off in this Helm (no eta folder)', 'unavailable');
      return require('./eta-accuracy').readEtaHistory({ etaDir: options.etaDir || undefined });
    },

    async 'files.changes'(p = {}) {
      const es = get(p.sessionId || p.id);
      await es.ensureLoaded();
      return computeChanges(es.items, es.s.cwd);
    },
  };
  // lane handoff: sessions.handoff / sessions.handoffCancel ("Fresh start with handoff", main/engine/handoff.js)
  Object.assign(methods, require('./handoff').createHandoff({ get, onSend: (es) => reaper.unmark(es), log }).methods);

  // Params come straight from any client: null / a list / a string must not crash a method.
  // The router passes the calling client second (sessions.release / sessions.viewing use it).
  for (const [name, fn] of Object.entries(methods)) {
    methods[name] = function (p, client) {
      if (p !== undefined && (p === null || typeof p !== 'object' || Array.isArray(p))) return Promise.reject(bad('params must be an object'));
      return fn.call(methods, p, client);
    };
  }

  // lane detach: after a (re)start, re-attach every session whose CLI a broker kept running. keep-compat.js decides
  // whether it still fits; when it does not (or the CLI is gone), the session shows the restart note with the
  // reason and Continue. Sessions the last Helm kept (s.kept) wait for this pass before any new start. A CLI kept
  // for a session this Helm does not know is ended at the broker's restart deadline. A session whose CLI a broker
  // stopped because Helm closed (brokers/stopped) says so: "Stopped when Helm closed". Then brokers from an older
  // broker.js drain (no new CLIs; they exit after their last one).
  let keepPass = null;
  async function reattachKept() {
    const b = ctx.broker;
    let list = null;
    if (b) { try { list = await b.list(); } catch (e) { log('warn', `engine: broker list failed: ${e.message}`); } }
    const here = { v: BROKER_V, sdkVersion: sdkVersion(), claudePath: ctx.claudePath || null, minCliVersion: MIN_CLI_VERSION };
    const all = list || [];
    // what a broker stopped because Helm closed (crash, End task, Windows shutdown, a missed restart deadline)
    const stopped = new Map(); // sid -> { at, reason, cli }
    if (b) { try { for (const r of b.takeStops()) for (const c of r.clis) if (c && c.sid) stopped.set(c.sid, { at: r.at, reason: r.reason, cli: c }); } catch (e) { log('warn', `engine: reading broker stops failed: ${e.message}`); } }
    if (stopped.size) log('info', `engine: ${stopped.size} session(s) were stopped by the broker when Helm closed`);
    let kept = 0, failed = 0;
    for (const es of sessions.values()) {
      if (es.removed) continue;
      const k = es.s.kept;
      const mine = all.filter((e) => e.sid === es.s.id);
      let entry = null;
      if (k && k.key) entry = mine.find((e) => e.key === k.key) || null;
      if (!entry) entry = mine.filter((e) => !e.exited && !e.eofAt && !e.ending).sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))[0] || null;
      try {
        const stop = stopped.get(es.s.id) || null;
        if (!entry) {
          if (k) { failed++; await es._keepFailed(null, stop ? stop.reason : list ? 'the process that kept it running is gone' : 'Helm could not reach the process that kept it running', { live: false }); }
          else if (stop) await es.noteStoppedWhenClosed(stop);
          continue;
        }
        if (!k && entry.exited) continue; // nothing was promised (Helm crashed); the CLI ended on its own
        if (await es.reattach(entry, here)) kept++; else failed++;
      } catch (e) { failed++; log('warn', `engine: re-attach ${es.s.id} failed: ${e.message}`); }
    }
    for (const e of all) if (!e.exited && !sessions.has(e.sid)) log('warn', `engine: broker CLI pid ${e.pid} belongs to no known session (${e.sid}); the broker ends it at its restart deadline`);
    if (kept || failed) log('info', `engine: re-attach pass: ${kept} kept, ${failed} fell back to the restart note`);
    if (b) { try { await b.drainOld(); } catch (e) { log('warn', `engine: broker drain failed: ${e.message}`); } }
  }
  if (ctx.broker || [...sessions.values()].some((es) => es.s.kept)) { // ctx.broker also reads brokers/stopped
    keepPass = new Promise((resolve) => setTimeout(() => { reattachKept().catch((e) => log('warn', `engine: re-attach pass failed: ${e.message}`)).finally(resolve); }, 0));
    // a broker may hold a CLI for any session (Helm crashed): hold every start until the pass has looked
    let brokersExist = false;
    try { brokersExist = fs.readdirSync(path.join(userDataDir, 'brokers')).some((n) => n.endsWith('.json')); } catch {}
    for (const es of sessions.values()) if (es.s.kept || brokersExist) es.keepPending = keepPass;
    keepPass.then(() => { for (const es of sessions.values()) es.keepPending = null; });
  }

  function snapshot() {
    const list = [...sessions.values()].map((es) => es.publicSession()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { sessions: list, usage: usage.get() };
  }

  // cause: 'restart' (main.js performRestart) | 'quit'. lane restart: before anything is closed, each session
  // keeps what this shutdown cuts off (Session.restartNote: the turn, agents with their ids, tasks, `!` runs).
  async function shutdown({ cause = 'quit' } = {}) {
    const at = Date.now();
    let cutAny = false;
    // lane detach: only a restart Helm performs keeps CLIs (cause 'restart', keeping on): the broker is told first
    // (the restart intent, broker.js "keep", 60 s, single-use), then each kept CLI's pipe detaches and the relaunched
    // Helm re-attaches. Anything else is a quit: every CLI closes, and the brokers end whatever is left and exit.
    // A crash, End task or a Windows shutdown never gets here: the pipes close with no intent and the broker
    // ends every CLI by itself (the next start says "Stopped when Helm closed").
    const detached = new Set();
    if (ctx.broker && cause === 'restart' && keepOn()) {
      const can = [...sessions.values()].filter((es) => { try { return es.canKeep(); } catch { return false; } });
      let confirmed = new Set();
      if (can.length) { try { confirmed = await ctx.broker.keepForRestart(can.map((es) => es.brokerProc)); } catch (e) { log('warn', `engine: restart intent failed: ${e.message}`); } }
      for (const es of can) {
        if (!confirmed.has(es.brokerProc)) continue;
        try { if (es.detachCli(at)) detached.add(es); } catch (e) { log('warn', `engine: detach ${es.s.id} failed: ${e.message}`); }
      }
      if (can.length) log('info', `engine: restart detached ${detached.size} of ${can.length} keepable CLI(s); they keep running in the broker`);
      if (detached.size) cutAny = true;
    }
    for (const es of sessions.values()) {
      if (detached.has(es)) continue;
      try {
        const cut = es.noteCutOff(at, cause);
        if (cut) cutAny = true;
        if (cut) log('info', `engine: ${cause} cuts off ${es.s.id}: ${cut.working ? 'turn, ' : ''}${cut.agentsTotal} agent(s), ${cut.tasks.length} task(s), ${cut.shells} ! run(s), ${cut.queued} queued`);
      } catch (e) { log('warn', `engine: restart note for ${es.s.id} failed: ${e.message}`); }
    }
    // Saved now, not only at the end: main.js gives shutdown 4 s, and closing busy CLIs can take that long.
    if (cutAny) persist();
    // lane sched: note what was still scheduled ("Ended by restart" next start), before CLIs close. A kept CLI's
    // schedules keep running in it, so they are not noted.
    board.atShutdown({ keep: new Set([...detached].map((es) => es.s.id)) });
    for (const es of sessions.values()) es.killShells(); // `!` runs: process trees by PID, kept as stopped
    external.stop();
    reaper.stop();
    clearInterval(stallTimer); // lane stall
    if (usageHistory) usageHistory.stop();
    await Promise.all([...sessions.values()].filter((es) => es.live() || es.starting).map((es) => es.close({ final: false }).catch(() => {})));
    // nothing kept: every broker ends what is left (a CLI that ignored stdin EOF) and exits now, not 30 s later
    if (ctx.broker && !detached.size) { try { await ctx.broker.shutdownAll(cause === 'restart' ? 'Helm restarted without keeping sessions' : 'Helm quit'); } catch {} }
    save.cancel();
    persist();
    if (recap) recap.close();
  }

  // lane account: after a sign-in, sign-out or account switch, running CLIs still hold the old
  // credentials. Close every idle live CLI (resumable: the next send starts a fresh one on the new
  // account) and report the ones mid-turn, so the caller can call again once they finish.
  function recycleClis() {
    const closed = [];
    const busy = [];
    for (const es of sessions.values()) {
      if (!es.live() && !es.starting) continue;
      // Running agents, background shells / tasks and `!` runs live inside (or beside) the CLI: closing it would kill them.
      if (es.busyState()) { busy.push(es.s.id); continue; }
      closed.push(es.s.id);
      es.close({ final: false }).catch((e) => log('warn', `engine: recycle ${es.s.id} failed: ${e.message}`));
    }
    return { closed, busy };
  }

  // lane restart: what a Helm restart would cut off, per session (only sessions with something running).
  // [{ id, title, starting, working, waiting, compacting, queued, agents, tasks, shells }]
  // lane detach: keep = a restart now would keep this session's CLI running (keeping on, CLI in a safe broker), so
  // its turn, agents and tasks do not hold a restart back (main/update.js restartBlockers).
  function busy() {
    const out = [];
    const on = keepOn();
    for (const es of sessions.values()) { const b = es.busyState(); if (b) out.push(on && es.canKeep() ? { ...b, keep: true } : b); }
    return out;
  }

  return {
    methods,
    snapshot,
    // Settings > Claude Code's allowlist (main/rpc.js getProjectDirs): the folders only, no status line read
    sessionCwds: () => [...sessions.values()].map((es) => es.s.cwd),
    shutdown,
    recycleClis,
    busy,
    // lane tabrelease: a client disconnected; whatever it had on screen is no longer viewed (main.js onClient)
    clientClosed(client) {
      viewers.delete(clientKey(client));
      syncRecapViewing();
    },
    // lane reaper: the user is typing a draft for this session (main.js app.input): counts as activity
    noteActivity(id) {
      const es = typeof id === 'string' && sessions.get(id);
      if (es) es.lastActiveAt = Date.now();
    },
    // lane reaper, --test only (main.js test.idleClose): the window/check override + per-session CLI state
    idleReaper: {
      sweep: () => reaper.sweep(),
      setEvery: (ms) => reaper.setEvery(ms),
      info: () => ({
        ...idleInfo(),
        sessions: [...sessions.values()].map((es) => ({ id: es.s.id, live: es.live(), pid: (es.q && es.q._helmCli && es.q._helmCli.pid) || null, busy: !!es.busyState(), releasePending: reaper.isMarked(es), idleClosedAt: es.idleClosedAt || null, lastActiveAt: es.lastActiveAt || null, held: (es.schedules && es.schedules.pending()) || null })),
      }),
    },
    // lane logs: 'debug' | 'info' | 'warn' | 'error' (unknown: unchanged) -> the level now in force
    setLogLevel(level) { const n = LOG_LEVELS[String(level || '').toLowerCase()]; if (n) logMin = n; return Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === logMin); },
    // Not part of the host contract; handy for tests and diagnostics.
    _internal: { sessions, ctx, external, lastInit: () => lastInit, probe, newId: randomUUID, PUBLIC_FIELDS },
  };
}

module.exports = { createEngine };
