// Update detection + auto-restart gate (PROTOCOL "Restart + updates").
//
// Helm.exe runs this folder directly, so new code only loads when the main process restarts. Commits
// are made only after verification, so a NEW COMMIT is the update signal: HEAD resolving to a
// different commit than the one this process started on. File edits alone never count (agents edit
// for half an hour before a commit; a half-edited tree must never be loaded).
//
// - readHead(gitDir): HEAD -> loose ref -> packed-refs (or detached), straight from .git, no git process.
//   Polled every 30 s, plus fs.watch on .git and the branch's ref folder (debounced) for promptness.
// - After the last HEAD change, wait UPDATE_QUIET_MS (60 s) of quiet before acting.
// - Then the gate (restartBlockers, pure) is re-checked every 30 s; Helm restarts only when it returns
//   no reasons, re-confirmed CONFIRM_MS later with fresh state.
// Owner: lane host (B).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const POLL_MS = 30_000;
const UPDATE_QUIET_MS = 60_000;
const INPUT_QUIET_MS = 120_000;
const GATE_MS = 30_000;
const CONFIRM_MS = 3_000;
// lane restart: "Restart when finished" (a manual restart the user asked for while something runs) re-checks this often.
const DEFER_MS = 5_000;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// What Helm loads at start: the dirty check only looks here (untracked files are never loaded on their own).
const CODE_PATHS = ['main.js', 'preload.js', 'package.json', 'main', 'ui'];

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// .git folder of a work tree: a directory, or a `gitdir: <path>` file (linked worktree / submodule).
function resolveGitDir(repoDir) {
  const dotgit = path.join(repoDir, '.git');
  let st = null;
  try { st = fs.statSync(dotgit); } catch { return null; }
  if (st.isDirectory()) return dotgit;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotgit) || '');
  return m ? path.resolve(repoDir, m[1]) : null;
}

// Refs of a linked worktree live in the common dir (named by its `commondir` file).
function commonDir(gitDir) {
  const c = readText(path.join(gitDir, 'commondir'));
  return c && c.trim() ? path.resolve(gitDir, c.trim()) : gitDir;
}

function packedRef(dir, ref) {
  const text = readText(path.join(dir, 'packed-refs'));
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#' || line[0] === '^') continue;
    const sp = line.indexOf(' ');
    if (sp > 0 && line.slice(sp + 1).trim() === ref) {
      const sha = line.slice(0, sp).trim();
      return SHA.test(sha) ? sha : null;
    }
  }
  return null;
}

/**
 * readHead(gitDir) -> { sha, ref, detached } | null
 *   ref: "refs/heads/master" (null when detached); sha: null for a branch with no commits yet.
 */
function readHead(gitDir) {
  if (!gitDir) return null;
  const head = readText(path.join(gitDir, 'HEAD'));
  if (head == null) return null;
  const h = head.trim();
  if (SHA.test(h)) return { sha: h, ref: null, detached: true };
  let m = /^ref:\s*(\S+)$/.exec(h);
  if (!m) return null;
  const first = m[1];
  const common = commonDir(gitDir);
  let ref = first;
  for (let depth = 0; depth < 5; depth++) {
    // per-worktree refs (HEAD-like) sit in gitDir; branches and tags in the common dir
    const loose = readText(path.join(common, ref)) ?? readText(path.join(gitDir, ref));
    if (loose != null) {
      const v = loose.trim();
      if (SHA.test(v)) return { sha: v, ref: first, detached: false };
      m = /^ref:\s*(\S+)$/.exec(v);
      if (m) { ref = m[1]; continue; }
      return null; // a ref file being written: try again on the next poll
    }
    return { sha: packedRef(common, ref), ref: first, detached: false };
  }
  return null;
}

// A rebase / merge / cherry-pick / revert / bisect in progress moves HEAD through commits that are not a
// finished state of the tree: never restart in the middle of one.
function gitOpInProgress(gitDir) {
  if (!gitDir) return null;
  const has = (n) => fs.existsSync(path.join(gitDir, n));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

/** readCommit(gitDir, sha) -> { sha, parents, subject, time } from a LOOSE object, else null (packed). */
function readCommit(gitDir, sha) {
  if (!gitDir || !SHA.test(sha || '')) return null;
  let raw;
  try { raw = zlib.inflateSync(fs.readFileSync(path.join(commonDir(gitDir), 'objects', sha.slice(0, 2), sha.slice(2)))); } catch { return null; }
  const nul = raw.indexOf(0);
  if (nul < 0 || !raw.slice(0, nul).toString('latin1').startsWith('commit ')) return null;
  const body = raw.slice(nul + 1).toString('utf8');
  const split = body.indexOf('\n\n');
  const header = split < 0 ? body : body.slice(0, split);
  const message = split < 0 ? '' : body.slice(split + 2);
  const parents = [];
  let time = null;
  for (const line of header.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) { const t = /\s(\d+)\s[+-]\d{4}$/.exec(line); if (t) time = Number(t[1]) * 1000; }
  }
  return { sha, parents, subject: (message.split('\n').find((l) => l.trim()) || '').trim(), time };
}

const short = (sha) => (sha ? sha.slice(0, 7) : null);

// git with a timeout; resolves { ok, out, err }
function git(repoDir, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoDir, ...args], { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (err, out, stderr) => {
      resolve({ ok: !err, out: String(out || ''), err: err ? String(stderr || err.message).trim().split('\n')[0] : null });
    });
  });
}

/**
 * commitsBetween(repoDir, gitDir, from, to, max) -> [{ sha, short, subject }] newest first.
 * Walks first parents through loose objects; one `git log` when an object is packed or the walk
 * does not reach `from` (a reset / branch switch: then just the new HEAD).
 */
async function commitsBetween(repoDir, gitDir, from, to, max = 10) {
  const out = [];
  let cur = to;
  for (let i = 0; cur && cur !== from && i < max; i++) {
    const c = readCommit(gitDir, cur);
    if (!c) { out.length = 0; break; }
    out.push({ sha: c.sha, short: short(c.sha), subject: c.subject });
    cur = c.parents[0] || null;
    if (!cur && from) { out.length = 0; break; } // root reached without meeting `from`: not a descendant
  }
  if (out.length) return out;
  const range = from ? [`${from}..${to}`] : [to];
  let r = await git(repoDir, ['log', '--format=%H%x09%s', '-n', String(max), ...range]);
  if (!r.ok || !r.out.trim()) r = await git(repoDir, ['log', '--format=%H%x09%s', '-n', '1', to]);
  if (!r.ok) return [{ sha: to, short: short(to), subject: '' }];
  return r.out.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, short: short(sha), subject: s.join('\t') }; });
}

// Uncommitted edits to tracked files Helm loads (main.js, preload.js, package.json, main/, ui/).
async function dirtyFiles(repoDir) {
  const r = await git(repoDir, ['status', '--porcelain=v1', '-uno', '--', ...CODE_PATHS]);
  if (!r.ok) return { error: r.err || 'git status failed' };
  return { files: r.out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) };
}

// ---------- the gate ----------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * restartBlockers(st, { manual, strict }) -> [reason] (empty = clear to restart). Pure.
 * st = {
 *   sessions: [{ working, waiting, starting, compacting, queued, agents, tasks, shells, keep }],  // engine.busy()
 *   queueRunning: n, gitOp: 'rebase'|null, dirty: { files } | { error } | null,
 *   now, lastInputAt, inputQuietMs, attachments: n, autoRestart: bool,
 * }
 * manual (Restart button / tray / palette): only what a restart would cut off or load half-done; the
 * person pressing it is the input, sees the composer, and asked for it whatever the setting says.
 */
function restartBlockers(st, { manual = false, strict = false } = {}) {
  // lane detach: a session whose claude.exe a restart keeps running (keep: true, "Keep sessions running through a
  // restart") is not cut off: its turn, agents and background tasks do not hold the restart back. Helm's own
  // `!` runs, queued messages and questions waiting on the user still do. strict ("Restart when finished") counts all.
  const ss = (Array.isArray(st.sessions) ? st.sessions : []).map((s) => (s && s.keep && !strict ? { ...s, working: false, compacting: false, agents: 0, tasks: 0 } : s));
  const count = (k) => ss.filter((s) => s && s[k]).length;
  const sum = (k) => ss.reduce((a, s) => a + (s && Number(s[k]) > 0 ? Number(s[k]) : 0), 0);
  const out = [];
  if (!manual && st.autoRestart === false) out.push('automatic restart is off');
  let n;
  if ((n = count('working'))) out.push(`${plural(n, 'session', 'sessions')} working`);
  if ((n = count('waiting'))) out.push(`${plural(n, 'session', 'sessions')} waiting on you`);
  if ((n = count('starting'))) out.push(`${plural(n, 'session', 'sessions')} starting`);
  if ((n = count('compacting'))) out.push(`${plural(n, 'session', 'sessions')} compacting`);
  if ((n = sum('queued'))) out.push(`${plural(n, 'queued message', 'queued messages')}`);
  if ((n = sum('agents'))) out.push(`${plural(n, 'agent', 'agents')} running`);
  if ((n = sum('tasks'))) out.push(`${plural(n, 'background task', 'background tasks')} running`);
  if ((n = sum('shells'))) out.push(`${plural(n, '! command', '! commands')} running`);
  if (st.queueRunning > 0) out.push('the overnight queue is running a job');
  if (st.gitOp) out.push(`a git ${st.gitOp} is in progress`);
  if (st.dirty && st.dirty.error) out.push(`could not check for uncommitted changes (${st.dirty.error})`);
  else if (st.dirty && st.dirty.files && st.dirty.files.length) {
    const f = st.dirty.files;
    out.push(`uncommitted changes in ${f[0]}${f.length > 1 ? ` and ${f.length - 1} more` : ''}`);
  }
  if (!manual) {
    if ((n = Number(st.attachments) || 0)) out.push(`${plural(n, 'unsent attachment', 'unsent attachments')} in the composer`);
    const quiet = st.inputQuietMs ?? INPUT_QUIET_MS;
    const since = st.lastInputAt ? st.now - st.lastInputAt : Infinity;
    if (since < quiet) out.push(`you used Helm ${since < 60_000 ? `${Math.max(1, Math.round(since / 1000))} s` : `${Math.round(since / 60_000)} min`} ago`);
  }
  return out;
}

// lane detach: what keeps running through a restart now (sessions with keep: true) -> [phrase]. Pure.
function keptWork(st) {
  const ss = (Array.isArray(st && st.sessions) ? st.sessions : []).filter((s) => s && s.keep);
  const sum = (k) => ss.reduce((a, s) => a + (Number(s[k]) > 0 ? Number(s[k]) : 0), 0);
  const out = [];
  let n;
  if ((n = ss.filter((s) => s.working || s.compacting).length)) out.push(`${plural(n, 'session', 'sessions')} working`);
  if ((n = sum('agents'))) out.push(`${plural(n, 'agent', 'agents')}`);
  if ((n = sum('tasks'))) out.push(`${plural(n, 'background task', 'background tasks')}`);
  return out;
}

const waitingText = (reasons) => (reasons && reasons.length ? `waiting: ${reasons.join(' · ')}` : '');

/**
 * createUpdater({ repoDir, emit, log, getBlockers, restart, isAutoRestart, extra?, timing?, clock?, timers?, watch? })
 *   extra: () => fields merged into state() (main.js: bootedAt + the restart this process came from)
 *   getBlockers({ manual }) -> Promise<[reason]>   (main.js: engine + queue + input + dirty tree)
 *   restart({ auto, commits, to }) -> performs the relaunch (main.js)
 *   clock: () => ms; timers: { setTimeout, clearTimeout, setInterval, clearInterval } (tests inject both)
 * -> { start(), stop(), state(), check(), gate(), gitDir, running }
 * Emits `app.update` (state) whenever the state changes.
 */
function createUpdater(opts) {
  const { repoDir, emit = () => {}, log = () => {}, getBlockers, restart, isAutoRestart = () => true } = opts;
  const now = opts.clock || Date.now;
  const T = opts.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const timing = { pollMs: POLL_MS, quietMs: UPDATE_QUIET_MS, gateMs: GATE_MS, confirmMs: CONFIRM_MS, deferMs: DEFER_MS, ...(opts.timing || {}) };
  const gitDir = resolveGitDir(repoDir);
  const startHead = readHead(gitDir);
  const startCommit = startHead && startHead.sha ? readCommit(gitDir, startHead.sha) : null;
  const running = {
    sha: startHead ? startHead.sha : null, short: short(startHead && startHead.sha),
    subject: startCommit ? startCommit.subject : null, branch: startHead && startHead.ref ? startHead.ref.replace(/^refs\/heads\//, '') : null,
    startedAt: now(),
  };
  let pending = null; // { sha, short, commits, detectedAt, changedAt, settleAt, reasons, phase: 'settling'|'waiting'|'restarting' }
  let lastSeen = running.sha;
  let pollTimer = null, gateTimer = null, settleTimer = null, debounceTimer = null;
  const watchers = [];
  let checking = false, gating = false, stopped = false;
  let lastEmitted = '';
  // lane restart: the user chose "Restart when finished": { at, by, reasons, phase: 'waiting'|'restarting' }. It waits
  // for the manual gate (what a restart would cut off: sessions, agents, tasks, `!` runs, queue, git op, dirty code).
  let deferred = null;
  let deferTimer = null, deferring = false;

  function state() {
    return {
      ...(opts.extra ? opts.extra() : {}),
      running: { ...running },
      repo: repoDir,
      autoRestart: isAutoRestart() !== false,
      pending: pending ? {
        sha: pending.sha, short: pending.short, commits: pending.commits.slice(), detectedAt: pending.detectedAt,
        settleAt: pending.settleAt, phase: pending.phase, reasons: pending.reasons.slice(),
        reason: pending.phase === 'settling' ? 'waiting for commits to settle' : pending.phase === 'restarting' ? 'restarting'
          : pending.reasons.length ? waitingText(pending.reasons) : 'nothing running: confirming before restarting',
      } : null,
      deferred: deferred ? {
        at: deferred.at, by: deferred.by, phase: deferred.phase, reasons: deferred.reasons.slice(),
        reason: deferred.phase === 'restarting' ? 'restarting' : deferred.reasons.length ? waitingText(deferred.reasons) : 'nothing running: confirming before restarting',
      } : null,
    };
  }
  function publish() {
    const s = state();
    const key = JSON.stringify(s);
    if (key === lastEmitted) return;
    lastEmitted = key;
    try { emit('app.update', s); } catch (e) { log('update emit failed', e); }
  }

  // HEAD changed? (cheap: two small files). A change restarts the quiet period.
  async function check() {
    if (checking || stopped) return;
    checking = true;
    try {
      const h = readHead(gitDir);
      const sha = h && h.sha;
      if (!sha || sha === lastSeen) return;
      lastSeen = sha;
      const t = now();
      if (sha === running.sha) { // moved back to what is running (reset / checkout back): nothing to load
        log(`update: HEAD back at the running commit ${short(sha)}`);
        pending = null;
        clearGate();
        publish();
        return;
      }
      const commits = await commitsBetween(repoDir, gitDir, running.sha, sha);
      if (stopped) return;
      pending = { sha, short: short(sha), commits, detectedAt: pending ? pending.detectedAt : t, changedAt: t, settleAt: t + timing.quietMs, reasons: [], phase: 'settling' };
      log(`update: HEAD ${short(running.sha)} -> ${short(sha)} (${commits.map((c) => c.subject).join(' | ').slice(0, 300)}); settles at ${new Date(pending.settleAt).toISOString()}`);
      clearGate();
      T.clearTimeout(settleTimer);
      settleTimer = T.setTimeout(() => { settleTimer = null; if (!gateTimer) gate(); }, timing.quietMs);
      publish();
    } catch (e) { log('update check failed', e); } finally { checking = false; }
  }

  function clearGate() { if (gateTimer) { T.clearInterval(gateTimer); gateTimer = null; } }

  // Quiet period over: re-check the gate now and every gateMs until it is clear.
  async function gate() {
    if (!pending || stopped || gating) return;
    if (now() < pending.settleAt) return;
    gating = true;
    try {
      // HEAD must still be the settled commit (a change since restarts the quiet period via check()).
      const h = readHead(gitDir);
      if (!h || h.sha !== pending.sha) { await check(); return; }
      pending.phase = 'waiting';
      const reasons = await getBlockers({ manual: false });
      if (!pending || stopped) return;
      pending.reasons = reasons;
      if (!reasons.length) {
        // Re-confirm with fresh state a moment later: a send or a turn starting right now wins.
        await new Promise((r) => T.setTimeout(r, timing.confirmMs));
        const again = await getBlockers({ manual: false });
        const h2 = readHead(gitDir);
        if (!pending || stopped) return;
        if (!again.length && h2 && h2.sha === pending.sha) {
          pending.phase = 'restarting';
          pending.reasons = [];
          publish();
          log(`update: restarting into ${pending.short} (${pending.commits.map((c) => c.subject).join(' | ').slice(0, 200)})`);
          clearGate();
          const ok = await restart({ auto: true, to: pending.sha, commits: pending.commits });
          if (ok !== false) return;
          // the host declined (a --test run without the restart switch): keep waiting, say why
          pending.phase = 'waiting';
          again.push('this run cannot restart itself');
        }
        pending.reasons = again.length ? again : ['HEAD moved again'];
      }
      if (!gateTimer) gateTimer = T.setInterval(() => gate(), timing.gateMs);
      publish();
    } catch (e) { log('update gate failed', e); } finally { gating = false; }
  }

  function onFsEvent(_ev, name) {
    const n = String(name || '');
    // .git churns (index, objects, logs, lock files): only HEAD and ref files matter
    if (n && !/^(HEAD|packed-refs|ORIG_HEAD)$/.test(n) && !/^[^.]+$/.test(path.basename(n))) return;
    T.clearTimeout(debounceTimer);
    debounceTimer = T.setTimeout(() => { debounceTimer = null; check(); }, 500);
  }

  function start() {
    if (!gitDir) { log(`update: ${repoDir} is not a git work tree; update detection off`); return; }
    log(`update: watching ${gitDir} (running ${running.short || 'no commit'} on ${running.branch || 'detached HEAD'})`);
    pollTimer = T.setInterval(() => { check(); if (pending && pending.phase !== 'restarting' && now() >= pending.settleAt && !gateTimer) gate(); }, timing.pollMs);
    if (pollTimer && pollTimer.unref) pollTimer.unref();
    if (opts.watch !== false) {
      const ref = startHead && startHead.ref;
      const dirs = [gitDir, ref ? path.dirname(path.join(commonDir(gitDir), ref)) : null].filter(Boolean);
      for (const d of [...new Set(dirs)]) {
        try { const w = fs.watch(d, { persistent: false }, onFsEvent); w.on('error', () => {}); watchers.push(w); } catch (e) { log(`update: fs.watch ${d} failed (${e.code || e.message}); polling only`); }
      }
    }
  }

  // ---------- lane restart: "Restart when finished" ----------
  // restartWhenIdle({ by }): restart as soon as nothing runs at all (getBlockers({ manual: true, strict: true }) empty,
  // so sessions a restart would keep running count too), and still empty confirmMs later.
  // Re-checked every deferMs. cancelWhenIdle() takes it back. -> state()
  function clearDefer() { if (deferTimer) { T.clearInterval(deferTimer); deferTimer = null; } }
  function armDefer() { if (!deferTimer && !stopped) { deferTimer = T.setInterval(() => deferCheck(), timing.deferMs); if (deferTimer && deferTimer.unref) deferTimer.unref(); } }
  function restartWhenIdle({ by = 'desktop' } = {}) {
    if (stopped) return state();
    if (!deferred) { deferred = { at: now(), by, reasons: [], phase: 'waiting' }; log(`update: restart when finished (asked by ${by})`); }
    else deferred.by = by;
    armDefer();
    deferCheck();
    publish();
    return state();
  }
  function cancelWhenIdle() {
    if (!deferred || deferred.phase === 'restarting') return false;
    log(`update: restart when finished cancelled (asked by ${deferred.by})`);
    deferred = null;
    clearDefer();
    publish();
    return true;
  }
  async function deferCheck() {
    if (!deferred || stopped || deferring || deferred.phase === 'restarting') return;
    deferring = true;
    try {
      const reasons = await getBlockers({ manual: true, strict: true });
      if (!deferred || stopped) return;
      deferred.reasons = reasons;
      if (!reasons.length) {
        // the same re-confirm as the update gate: a send or a turn starting right now wins
        await new Promise((r) => T.setTimeout(r, timing.confirmMs));
        if (!deferred || stopped) return;
        const again = await getBlockers({ manual: true, strict: true });
        if (!deferred || stopped) return;
        if (!again.length) {
          deferred.phase = 'restarting';
          deferred.reasons = [];
          clearDefer();
          publish();
          log(`update: restarting now that nothing runs (restart when finished, asked by ${deferred.by})`);
          const ok = await restart({ auto: false, by: deferred.by, deferred: true });
          if (ok !== false) return;
          deferred.phase = 'waiting';
          again.push('this run cannot restart itself');
          armDefer();
        }
        deferred.reasons = again;
      }
      publish();
    } catch (e) { log('update: restart when finished check failed', e); } finally { deferring = false; }
  }

  function stop() {
    stopped = true;
    for (const t of [settleTimer, debounceTimer]) T.clearTimeout(t);
    if (pollTimer) T.clearInterval(pollTimer);
    clearGate();
    clearDefer();
    for (const w of watchers.splice(0)) { try { w.close(); } catch {} }
  }

  // The commit to name after a manual restart (the newest pending one, if any).
  function pendingInfo() { return pending ? { to: pending.sha, commits: pending.commits.slice() } : null; }
  function refresh() { if (deferred) deferCheck(); if (pending && pending.phase === 'waiting') gate(); else publish(); }

  return { start, stop, state, check, gate, refresh, pendingInfo, restartWhenIdle, cancelWhenIdle, deferCheck, gitDir, running };
}

module.exports = {
  createUpdater, restartBlockers, keptWork, waitingText, readHead, readCommit, resolveGitDir, gitOpInProgress, commitsBetween, dirtyFiles,
  POLL_MS, UPDATE_QUIET_MS, INPUT_QUIET_MS, GATE_MS, DEFER_MS, CODE_PATHS,
};
