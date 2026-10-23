// Overnight queue (PROTOCOL "Queue job"). Persisted in <userData>/queue.json.
// Every minute: if no queue job is running, start the next queued job whose runAfter has
// passed and whose maxFiveHourPercent is at or above the current 5H usage. The job runs as a
// normal Helm session; when that session goes idle the job is done (summary = the last
// assistant text), on error it failed. When the batch drains, one "Queue finished" notify fires.
// Auth (main/account.js): the 5H gate is for Claude subscriptions only. With an Anthropic API key (Helm's, or
// the one Claude Code is signed in with) there is no 5-hour window (usageLimits() false), so jobs run without
// it, still one at a time; while Claude Code isn't signed in (startBlock()) the next job waits and says why.
// Owner: lane host (B).
const path = require('path');

const { writeFileAtomic, readJson } = require('./atomic');

const FIELDS = ['prompt', 'cwd', 'model', 'effort', 'permissionMode', 'runAfter', 'maxFiveHourPercent'];
const PERMISSION_MODES = ['bypassPermissions', 'default', 'acceptEdits', 'plan'];
const SUMMARY_CHARS = 400;

function badParams(message) { return Object.assign(new Error(message), { code: 'bad_params' }); }

/**
 * createQueue({ userDataDir, engine, emit, notify, getDefaults, now, setInterval, clearInterval, log, usageLimits, startBlock })
 *   engine:  { methods } (sessions.create, sessions.history, usage.get)
 *   usageLimits() -> bool  does the sign-in have 5-hour limits (default true: the gate as always; the API key: false)
 *   startBlock() -> null | { message }  why no session may start now (not signed in): the next job waits with it
 *   notify:  fn({ title, body, kind, sessionId? }) — fires a protocol `notify` event
 * -> { list(), add(job), update(p), remove(p), tick(), onEngineEvent(event, data), start(), stop() }
 */
function createQueue(opts) {
  const { userDataDir, engine, emit = () => {}, notify = () => {}, log = () => {} } = opts;
  const now = opts.now || Date.now;
  const setI = opts.setInterval || setInterval;
  const clearI = opts.clearInterval || clearInterval;
  const getDefaults = opts.getDefaults || (() => ({}));
  const usageLimits = () => { try { return typeof opts.usageLimits === 'function' ? opts.usageLimits() !== false : true; } catch { return true; } };
  const startBlock = () => { try { return typeof opts.startBlock === 'function' ? opts.startBlock() || null : null; } catch (e) { return { message: 'Could not check the sign-in: ' + e.message }; } };
  const file = path.join(userDataDir, 'queue.json');
  let jobs = [];
  let batch = [];        // job ids finished since the queue last drained
  let timer = null;
  let ticking = false;
  const watch = new Map(); // sessionId -> { jobId, sawBusy }

  const loaded = readJson(file);
  if (loaded.status === 'ok') {
    const raw = loaded.value && Array.isArray(loaded.value.jobs) ? loaded.value.jobs : [];
    jobs = raw.filter((j) => j && typeof j === 'object' && !Array.isArray(j) && typeof j.id === 'string');
  } else if (loaded.status === 'corrupt') log('queue.json unreadable, starting empty:', loaded.error, loaded.movedTo ? `(kept as ${loaded.movedTo})` : '');
  // A job that was running when Helm stopped lost its CLI process with it.
  for (const j of jobs) if (j.status === 'running') { j.status = 'failed'; j.summary = 'Helm was closed while this job was running. Open its session to resume it.'; j.endedAt = now(); }

  function save() {
    try { writeFileAtomic(file, JSON.stringify({ jobs }, null, 2)); } catch (e) { log('queue save failed:', e.message); }
  }
  function changed() { save(); emit('queue.updated', { queue: list() }); }
  function list() { return structuredClone(jobs); }
  const find = (id) => jobs.find((j) => j.id === id);

  function clean(p, partial) {
    const out = {};
    for (const k of FIELDS) if (p[k] !== undefined) out[k] = p[k];
    if (!partial || 'prompt' in out) if (typeof out.prompt !== 'string' || !out.prompt.trim()) throw badParams('a queued job needs a prompt');
    if (!partial || 'cwd' in out) if (typeof out.cwd !== 'string' || !out.cwd.trim()) throw badParams('a queued job needs a cwd');
    if ('prompt' in out && out.prompt.length > 200_000) throw badParams('the prompt is too long');
    if ('cwd' in out && out.cwd.length > 1000) throw badParams('cwd is too long');
    for (const k of ['model', 'effort']) if (out[k] != null && (typeof out[k] !== 'string' || out[k].length > 200)) throw badParams(`${k} must be a short string`);
    if (out.permissionMode != null && !PERMISSION_MODES.includes(out.permissionMode)) throw badParams(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
    if (out.runAfter != null && !Number.isFinite(out.runAfter)) throw badParams('runAfter must be a timestamp (ms) or null');
    if (out.maxFiveHourPercent != null && !(Number.isFinite(out.maxFiveHourPercent) && out.maxFiveHourPercent >= 0 && out.maxFiveHourPercent <= 100)) throw badParams('maxFiveHourPercent must be 0..100');
    return out;
  }

  function add(p = {}) {
    const d = getDefaults() || {};
    const fields = clean(p, false);
    const job = {
      id: 'q_' + now().toString(36) + Math.random().toString(36).slice(2, 6),
      prompt: fields.prompt, cwd: fields.cwd,
      model: fields.model || d.model || null, effort: fields.effort || d.effort || null,
      permissionMode: fields.permissionMode || d.permissionMode || 'bypassPermissions',
      runAfter: fields.runAfter ?? null,
      maxFiveHourPercent: fields.maxFiveHourPercent ?? 85,
      status: 'queued', createdAt: now(),
    };
    jobs.push(job);
    changed();
    setImmediate(() => tick().catch(() => {}));
    return structuredClone(job);
  }

  function update(p = {}) {
    const job = find(p.id);
    if (!job) throw Object.assign(new Error('no such job'), { code: 'not_found' });
    const fields = clean(p, true);
    if (p.status !== undefined) {
      // The user can cancel or re-queue; running/done/failed are set by the queue itself.
      if (p.status === 'cancelled' && job.status === 'queued') job.status = 'cancelled';
      else if (p.status === 'queued' && ['cancelled', 'failed', 'done'].includes(job.status)) {
        job.status = 'queued'; delete job.summary; delete job.sessionId; delete job.waitReason; delete job.endedAt; delete job.startedAt;
      } else if (p.status !== job.status) throw badParams(`can't change a ${job.status} job to ${p.status}`);
    }
    if (job.status === 'running' && Object.keys(fields).length) throw badParams('a running job can\'t be edited');
    Object.assign(job, fields);
    changed();
    setImmediate(() => tick().catch(() => {}));
    return structuredClone(job);
  }

  function remove(p = {}) {
    const i = jobs.findIndex((j) => j.id === p.id);
    if (i < 0) return {};
    if (jobs[i].status === 'running') throw badParams('that job is running; interrupt its session first');
    jobs.splice(i, 1);
    changed();
    return {};
  }

  async function fiveHourPercent() {
    try {
      const u = await engine.methods['usage.get']({});
      const pct = u && u.fiveHour && u.fiveHour.percent;
      return Number.isFinite(pct) ? { pct } : { why: (u && u.fiveHour && u.fiveHour.reason) || '5-hour usage is unknown right now' };
    } catch (e) { return { why: '5-hour usage is unavailable: ' + e.message }; }
  }

  function setWait(job, why) {
    if (job.waitReason === why) return false;
    if (why == null) delete job.waitReason; else job.waitReason = why;
    return true;
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (jobs.some((j) => j.status === 'running')) { if (engine.snapshot) await checkStalled(); return; }
      const t = now();
      const ready = jobs.filter((j) => j.status === 'queued');
      if (!ready.length) return;
      let dirty = false;
      for (const j of ready) if (j.runAfter && j.runAfter > t) dirty = setWait(j, `waiting until ${new Date(j.runAfter).toLocaleString()}`) || dirty;
      const due = ready.filter((j) => !j.runAfter || j.runAfter <= t);
      if (!due.length) { if (dirty) changed(); return; }
      const job = due[0];
      const blocked = startBlock();
      if (blocked) { if (setWait(job, String(blocked.message || 'Sessions cannot start right now')) || dirty) changed(); return; }
      if (usageLimits()) {
        const u = await fiveHourPercent();
        if (u.pct == null) { if (setWait(job, u.why) || dirty) changed(); return; }
        if (u.pct > (job.maxFiveHourPercent ?? 85)) {
          if (setWait(job, `5-hour usage is ${Math.round(u.pct)}%, above this job's ${job.maxFiveHourPercent}% limit`) || dirty) changed();
          return;
        }
      }
      await startJob(job);
    } finally { ticking = false; }
  }

  async function startJob(job) {
    delete job.waitReason;
    job.status = 'running';
    job.startedAt = now();
    changed();
    try {
      const create = engine.methods['sessions.create'];
      if (!create) throw new Error('the engine has no sessions.create');
      const s = await create({ cwd: job.cwd, model: job.model || undefined, effort: job.effort || undefined, permissionMode: job.permissionMode || undefined, prompt: job.prompt });
      job.sessionId = s && s.id;
      watch.set(job.sessionId, { jobId: job.id, sawBusy: !!s && ['working', 'waiting'].includes(s.status) });
      changed();
      if (s && s.status === 'error') await finish(job, 'failed', s.activity || 'the session failed to start');
    } catch (e) {
      await finish(job, 'failed', 'Could not start: ' + e.message);
    }
  }

  async function lastAssistantText(sessionId) {
    try {
      const h = await engine.methods['sessions.history']({ id: sessionId, limit: 200 });
      const items = (h && h.items) || [];
      for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'assistant' && items[i].text && items[i].text.trim()) return items[i].text.trim();
    } catch {}
    return null;
  }

  const trim = (s) => (s.length > SUMMARY_CHARS ? s.slice(0, SUMMARY_CHARS - 1).trimEnd() + '…' : s);

  async function finish(job, status, fallback) {
    if (job.status !== 'running') return;
    if (job.sessionId) watch.delete(job.sessionId);
    const text = job.sessionId ? await lastAssistantText(job.sessionId) : null;
    job.status = status;
    job.endedAt = now();
    job.summary = trim(text || fallback || (status === 'done' ? 'Finished.' : 'Failed.'));
    batch.push(job.id);
    changed();
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
      const done = batch.map(find).filter(Boolean);
      batch = [];
      const ok = done.filter((j) => j.status === 'done').length;
      const lines = done.map((j) => `${j.status === 'done' ? 'Done' : 'Failed'}: ${j.prompt.replace(/\s+/g, ' ').slice(0, 60)}`);
      notify({ title: 'Queue finished', body: `${ok} of ${done.length} job${done.length === 1 ? '' : 's'} done.\n${lines.join('\n')}`.slice(0, 900), kind: ok === done.length ? 'done' : 'error' });
    } else setImmediate(() => tick().catch(() => {}));
  }

  function safeFinish(job, status, fallback) { finish(job, status, fallback).catch((e) => log('queue finish failed:', e.message)); }

  // A session that never reported working/waiting (e.g. its turn ended before we were watching)
  // would leave the job running forever; after 2 minutes, trust the engine snapshot instead.
  async function checkStalled() {
    const t = now();
    for (const [sid, w] of watch) {
      const job = find(w.jobId);
      if (!job || job.status !== 'running' || w.sawBusy || t - (job.startedAt || t) < 120_000) continue;
      try {
        const snap = await engine.snapshot();
        const s = ((snap && snap.sessions) || []).find((x) => x.id === sid);
        if (!s) await finish(job, 'failed', 'The session disappeared.');
        else if (s.status === 'idle' || s.status === 'closed') await finish(job, 'done');
        else if (s.status === 'error') await finish(job, 'failed', s.activity || 'The session hit an error.');
        else w.sawBusy = true;
      } catch {}
    }
  }

  function onEngineEvent(event, data) {
    if (event !== 'session.updated' || !data) return;
    const w = watch.get(data.id);
    if (!w) return;
    const job = find(w.jobId);
    if (!job || job.status !== 'running') { watch.delete(data.id); return; }
    if (data.status === 'working' || data.status === 'waiting') w.sawBusy = true;
    else if (data.status === 'idle' && w.sawBusy) safeFinish(job, 'done');
    else if (data.status === 'error') safeFinish(job, 'failed', data.activity || 'The session hit an error.');
    else if (data.status === 'closed') safeFinish(job, w.sawBusy ? 'done' : 'failed', 'The session was closed.');
  }

  function start(intervalMs = 60_000) {
    if (timer) return;
    timer = setI(() => tick().catch((e) => log('queue tick failed:', e.message)), intervalMs);
    if (timer && timer.unref) timer.unref();
    setImmediate(() => tick().catch(() => {}));
  }
  function stop() { if (timer) clearI(timer); timer = null; }

  return { list, add, update, remove, tick, onEngineEvent, start, stop, file };
}

module.exports = { createQueue };
