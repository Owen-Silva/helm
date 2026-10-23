// Claude Code sessions on this machine that Helm does NOT own (the user's terminal sessions).
// PROTOCOL "Round 3 additions" -> ExternalSession, external.list / external.history /
// event external.updated.
//
// Source: <projectsDir>/<slug>/<sessionId>.jsonl (top level only; <sessionId>/subagents/*.jsonl
// are agent transcripts, never sessions, but their writes count as activity). Every list()
// stats the transcripts that could be listed; one last written before the 24 h idle window is
// re-stated at most every coldRecheckMs (most of ~/.claude/projects is weeks old: 536 of 543
// files on the user's machine, 2026-10-08), so a resumed old session shows up within ~1 min. It
// parses only the few it returns, head/tail only (history.js
// parseTranscript: 64 KB head + 128 KB tail, whole file when <= 1 MB), cached by
// path + mtime + size. A 145 MB transcript costs the same as a small one.
// Owner: lane engine-plus-ext. Node built-ins only.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const history = require('./history');
const eta = require('./eta');

const HISTORY_OPTS = {
  // Same shape as history.js DEFAULTS (parseTranscript reads headBytes/tailBytes/fullReadMaxBytes).
  headBytes: 64 * 1024,
  tailBytes: 128 * 1024,
  fullReadMaxBytes: 1024 * 1024,
  minRefreshMs: 5000,
  fileTimeoutMs: 10000,
  concurrency: 16,
};

const DEFAULTS = {
  activeMs: 90 * 1000,            // written within this -> active
  subagentCheckMs: 90 * 60 * 1000, // only look at subagent files when the main file is this fresh (lane fleet: was 30 min; lanes outlive a quiet main turn)
  idleWindowMs: 24 * 60 * 60 * 1000,
  idleLimit: 10,
  pollMs: 15 * 1000,
  // lane logs: idle back-off. A poll costs ~60-80 ms CPU on the user's ~/.claude/projects (24 project dirs, ~600
  // transcripts, measured 2026-10-14), ~0.5% of a core at 15 s. After idleAfterPolls polls in a row with no
  // active session and no change, poll every idlePollMs instead; any activity, change or external.list (a
  // screen asking) goes back to pollMs. Worst case a new terminal session shows ~1 min late after a quiet spell.
  idlePollMs: 60 * 1000,
  idleAfterPolls: 4,
  coldRecheckMs: 60 * 1000,        // re-stat a transcript older than idleWindowMs at most this often
  concurrency: 16,
};

const ID_RE = /^[A-Za-z0-9._-]+$/;

// The eta mod rewrites its snapshot at least once a minute while a session works (ui/lib/session-header.js
// ETA_STALE_MS uses the same 10 minutes).
const SNAP_FRESH_MS = 10 * 60 * 1000;
function snapFresh(snap, t) {
  return !!snap && typeof snap.updatedAt === 'number' && t - snap.updatedAt <= SNAP_FRESH_MS;
}

// Test hook: HELM_TEST_EXTERNAL_DIRS (path.delimiter-separated) adds extra projects folders to
// scan, so tools/verify-round3.js can show a transcript it writes itself instead of depending on
// the terminal session that launched it. main.js deletes the variable unless --test, so a real
// Helm never reads it.
function testExtraDirs() {
  const v = process.env.HELM_TEST_EXTERNAL_DIRS;
  return v ? v.split(path.delimiter).filter(Boolean) : [];
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

function notFound(id) {
  const err = new Error(`no external session ${id}`);
  err.code = 'not_found';
  return err;
}

// Stable signature for change detection: everything but the clocks (lastActivity and the
// eta snapshot's updatedAt move on every write/heartbeat without anything visible changing).
function signature(sessions) {
  return JSON.stringify(sessions.map((s) => {
    let e = null;
    if (s.eta) { e = { ...s.eta }; delete e.updatedAt; }
    return [s.claudeSessionId, s.cwd, s.project, s.title, s.active, s.agentsRunning, e, s.transcriptPath];
  }));
}

function createExternalTracker({
  projectsDir,
  etaDir,
  isOwned = () => false,
  emit = () => {},
  log = () => {},
  now = Date.now,
  readPage,
  tempDir,
  ...over
} = {}) {
  const dir = projectsDir || require('./transcript').projectsDir();
  const dirs = [dir, ...testExtraDirs().filter((d) => path.resolve(d) !== path.resolve(dir))];
  const etaFolder = etaDir || eta.defaultEtaDir();
  const opts = { ...DEFAULTS, ...over };
  const say = (lvl, msg) => { try { log(lvl, `external: ${msg}`); } catch { /* ignore */ } };
  const owned = (id) => { try { return !!isOwned(id); } catch { return false; } };

  const summaries = new Map(); // path -> { mtimeMs, size, entry|null }
  const known = new Map();     // claudeSessionId -> transcript path (from the last scan)
  const cold = new Map();      // path -> { mtimeMs, size, checkedAt } for transcripts older than idleWindowMs
  let timer = null;
  let polling = false;
  let lastSig = null;
  let quietPolls = 0; // lane logs: polls in a row with nothing active and nothing changed
  let lastAnyActive = false;

  async function slugDirs() {
    const out = [];
    for (const root of dirs) {
      try {
        for (const d of await fsp.readdir(root, { withFileTypes: true })) if (d.isDirectory()) out.push(path.join(root, d.name));
      } catch (err) {
        if (err.code !== 'ENOENT') say('warn', `cannot read ${root}: ${err.message}`);
      }
    }
    return out;
  }

  async function scan() {
    const subs = await slugDirs();
    if (!subs.length) return [];
    const files = [];
    await pool(subs, opts.concurrency, async (sub) => {
      try {
        for (const f of await fsp.readdir(sub, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(sub, f.name));
        }
      } catch (err) {
        say('warn', `cannot read ${sub}: ${err.message}`);
      }
    });
    const out = [];
    const t = now();
    const toStat = [];
    for (const file of files) {
      const c = cold.get(file);
      if (c && t - c.checkedAt < opts.coldRecheckMs && t >= c.checkedAt) out.push({ file, id: path.basename(file, '.jsonl'), mtimeMs: c.mtimeMs, size: c.size }); // never parsed: outside the idle window
      else toStat.push(file);
    }
    await pool(toStat, opts.concurrency, async (file) => {
      let st;
      try { st = await fsp.stat(file); } catch { cold.delete(file); return; }
      if (t - st.mtimeMs > opts.idleWindowMs) cold.set(file, { mtimeMs: st.mtimeMs, size: st.size, checkedAt: t });
      else cold.delete(file);
      out.push({ file, id: path.basename(file, '.jsonl'), mtimeMs: st.mtimeMs, size: st.size, st });
    });
    if (cold.size > files.length + 64) {
      const live = new Set(files);
      for (const k of cold.keys()) if (!live.has(k)) cold.delete(k);
    }
    return out;
  }

  // Newest mtime among <slugDir>/<id>/subagents/*.jsonl, or 0.
  // { newest: mtime of the newest agent transcript, live: agent transcripts written within activeMs of t }
  async function newestSubagent(file, id, t = now()) {
    const sdir = path.join(path.dirname(file), id, 'subagents');
    let names;
    try { names = await fsp.readdir(sdir); } catch { return { newest: 0, live: 0 }; }
    let newest = 0, live = 0;
    await pool(names.filter((n) => n.endsWith('.jsonl')), opts.concurrency, async (n) => {
      try {
        const st = await fsp.stat(path.join(sdir, n));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (t - st.mtimeMs <= opts.activeMs) live++;
      } catch { /* vanished */ }
    });
    return { newest, live };
  }

  async function summaryOf(e) {
    const prev = summaries.get(e.file);
    if (prev && prev.mtimeMs === e.mtimeMs && prev.size === e.size) return prev.entry;
    let entry = null;
    try {
      entry = await history._internal.parseTranscript(e.file, e.st, HISTORY_OPTS);
    } catch (err) {
      say('warn', `skip ${e.file}: ${err.message}`);
      return null; // not cached: retried next time
    }
    summaries.set(e.file, { mtimeMs: e.mtimeMs, size: e.size, entry });
    return entry;
  }

  async function list() {
    const t = now();
    const all = await scan();
    known.clear();
    for (const e of all) if (!owned(e.id)) known.set(e.id, e.file);

    const recent = all.filter((e) => !owned(e.id) && t - e.mtimeMs <= opts.idleWindowMs);
    await pool(recent, opts.concurrency, async (e) => {
      let last = e.mtimeMs;
      e.agentsLive = 0;
      if (t - e.mtimeMs <= opts.subagentCheckMs) {
        const sub = await newestSubagent(e.file, e.id, t);
        last = Math.max(last, sub.newest);
        e.agentsLive = sub.live;
      }
      e.lastActivity = Math.round(last);
      e.active = t - last <= opts.activeMs;
    });
    recent.sort((a, b) => (b.active - a.active) || (b.lastActivity - a.lastActivity));

    const out = [];
    let idle = 0;
    for (const e of recent) {
      if (!e.active && idle >= opts.idleLimit) break;
      const s = await summaryOf(e);
      const snap = eta.readEta(e.id, etaFolder);
      // A transcript with no prompt and no title (fresh/blank) is listed only while active.
      if (!s && !e.active) continue;
      const cwd = (s && s.cwd) || null;
      if (cwd && history.isTempCwd(cwd, tempDir)) continue;
      const slug = path.basename(path.dirname(e.file));
      const label = snap && snap.label ? snap.label : '';
      out.push({
        claudeSessionId: e.id,
        cwd,
        project: (s && s.project) || slug,
        title: label || (s && s.title) || '(untitled)',
        lastActivity: e.lastActivity,
        active: e.active,
        // The eta mod's count, or (no mod / it lags) agent transcripts written in the last activeMs. The mod's
        // count only while its snapshot is fresh: a terminal closed mid-work leaves "working, 1 agent" on disk
        // for good (the user's eta folder held such snapshots 4 h to 6 days old, 2026-10-14).
        agentsRunning: Math.max(snapFresh(snap, t) && snap.state !== 'ended' ? snap.agentsRunning || 0 : 0, e.agentsLive || 0),
        eta: snap,
        transcriptPath: e.file,
      });
      if (!e.active) idle++;
    }

    // Drop cached summaries of files no longer present.
    if (summaries.size > 2 * all.length + 64) {
      const live = new Set(all.map((e) => e.file));
      for (const k of summaries.keys()) if (!live.has(k)) summaries.delete(k);
    }
    return out;
  }

  async function locate(id) {
    if (known.has(id)) {
      const f = known.get(id);
      try { await fsp.access(f); return f; } catch { known.delete(id); }
    }
    for (const sub of await slugDirs()) {
      const f = path.join(sub, id + '.jsonl');
      try {
        if ((await fsp.stat(f)).isFile()) { known.set(id, f); return f; }
      } catch { /* not here */ }
    }
    return null;
  }

  async function historyOf({ claudeSessionId, before, limit } = {}) {
    const id = String(claudeSessionId || '');
    if (!id || !ID_RE.test(id) || id === '.' || id === '..' || owned(id)) throw notFound(id);
    const file = await locate(id);
    if (!file) throw notFound(id);
    const page = readPage || require('./pager').readTranscriptPage;
    return await page(file, { before, limit });
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const sessions = await list();
      const anyActive = sessions.some((s) => s.active);
      const sig = signature(sessions);
      const changed = sig !== lastSig;
      lastSig = sig;
      if (changed && (anyActive || lastAnyActive)) {
        try { emit('external.updated', { sessions }); } catch (err) { say('warn', `emit: ${err.message}`); }
      }
      lastAnyActive = anyActive;
      quietPolls = anyActive || changed ? 0 : quietPolls + 1;
    } catch (err) {
      say('warn', `poll failed: ${err.message}`);
    } finally {
      polling = false;
    }
  }

  const pollDelay = () => (quietPolls >= opts.idleAfterPolls ? Math.max(opts.idlePollMs, opts.pollMs) : opts.pollMs);
  let running = false;
  let armedMs = 0;
  function arm(ms) {
    if (timer) clearTimeout(timer);
    armedMs = ms;
    timer = setTimeout(() => {
      timer = null;
      poll().catch(() => {}).finally(() => { if (running && !timer) arm(pollDelay()); });
    }, ms);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    poll().catch(() => {});
    arm(opts.pollMs);
  }

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // Someone is looking (external.list): back to the fast poll at once.
  function wake() {
    quietPolls = 0;
    if (running && timer && armedMs > opts.pollMs) arm(opts.pollMs);
  }

  return { list, history: historyOf, start, stop, refresh: poll, wake, pollDelay };
}

module.exports = { createExternalTracker, _internal: { signature, HISTORY_OPTS, DEFAULTS } };
