// In-CLI schedules (lane reaper). /loop and autoloop sessions sit idle for 20-30 min between ticks while their next
// tick lives INSIDE claude.exe: ScheduleWakeup (/loop dynamic mode) and CronCreate jobs ("Session-only ... dies when
// Claude exits"). Closing such a CLI as idle would silently end the loop, so the idle reaper keeps a session's CLI while
// this tracker says something is pending. The shared busyState() / restart gate does NOT use it: an update restart
// still ends in-CLI schedules (docs/PROTOCOL.md "Idle CLI close").
//
// Fed from the live tool items of the CURRENT CLI only; EngineSession resets it whenever a CLI starts or exits.
//   ScheduleWakeup { delaySeconds }  -> wake pending until the call's time + delaySeconds + WAKE_GRACE_MS (the wake
//                                       fires, then its turn makes the session busy anyway). A later call replaces
//                                       it; { stop: true } or a failed / denied call clears it.
//   CronCreate                       -> a pending cron (its id from the result: structured { id } or "job <id>")
//   CronDelete { id }                -> removes that cron (an unknown id with exactly one id-less cron removes that one)
//   createScheduleTracker({ now?, graceMs? }) -> { onToolInput(item), onToolEnd(item, structured), pending(), reset(),
//                                                  list(), drainEnded() }
//   pending() -> null | { wakeUntil: ms | null, crons: n, key, reason: 'scheduled wake-up pending ...' }
//
// lane sched (2026-10-09): one list of everything scheduled, across sessions.
//   list() -> [{ key, kind: 'wakeup'|'cron'|'loop', label, prompt, detail, nextAt, recurring, durable, cronId?,
//                expiresAt?, createdAt }] what is still due (a fired wake / one-shot cron and an auto-expired
//                recurring cron are left out; pending() above is unchanged, the reaper hold does not use list()).
//   drainEnded() -> [{ ...listItem, why: 'deleted' | 'stopped' | 'exit' }] since the last drain.
//   Every tracker change calls the module listeners (onScheduleChange), so the engine can push one event.
//   createScheduleBoard(...) is the engine side: schedules.list / schedules.cancel / schedules.dismiss + the
//   "Ended by restart" file (see docs/PROTOCOL.md "Scheduled: one list").
'use strict';

const fs = require('fs');

const WAKE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_WAKE_S = 3600; // a ScheduleWakeup with no usable delay: assume the longest
const FIRED_GRACE_MS = 60 * 1000; // a wake / one-shot this far past its time has fired: off the list
const CRON_EXPIRY_MS = 7 * 24 * 3600 * 1000; // CronCreate: recurring jobs auto-expire after 7 days
const LABEL_MAX = 90;
const PROMPT_MAX = 400;

// ---------- cron (5 fields, local time, like Claude Code's CronCreate) ----------
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseField(str, lo, hi) {
  const out = new Set();
  for (const part of String(str).toLowerCase().split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) return null;
    const val = (x) => (/^\d+$/.test(x) ? Number(x) : NAMES[x] != null ? NAMES[x] : NaN);
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; } else {
      const [x, y] = m[1].split('-');
      a = val(x);
      b = y === undefined ? (m[2] ? hi : a) : val(y);
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

// Next minute matching `expr` strictly after `from` (ms). null for an invalid expression or no match within 2 years.
function nextCronFire(expr, from) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mi = parseField(f[0], 0, 59), hr = parseField(f[1], 0, 23), dom = parseField(f[2], 1, 31), mon = parseField(f[3], 1, 12);
  const dowRaw = parseField(f[4], 0, 7);
  if (!mi || !hr || !dom || !mon || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((v) => v % 7));
  const domAny = f[2].startsWith('*'), dowAny = f[4].startsWith('*');
  const dayOk = (d) => (domAny || dowAny ? dom.has(d.getDate()) && dow.has(d.getDay()) : dom.has(d.getDate()) || dow.has(d.getDay()));
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 2 * 366 * 24 * 3600 * 1000;
  for (let guard = 0; d.getTime() <= limit && guard < 100000; guard++) {
    if (!mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayOk(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hr.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!mi.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

// ---------- labels ----------
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const isLoopPrompt = (p) => /^<<autonomous-loop(-dynamic)?>>$/.test(oneLine(p)) || /^\/loop\b/.test(oneLine(p));
function labelOf(prompt) {
  const p = oneLine(prompt);
  if (/^<<autonomous-loop(-dynamic)?>>$/.test(p)) return 'Autonomous loop';
  return p ? cut(p, LABEL_MAX) : '(no prompt)';
}

// ---------- change listeners (one per engine; the tracker does not know its session) ----------
const listeners = new Set();
function onScheduleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function cronIdFrom(item, structured) {
  const s = structured && typeof structured === 'object' ? structured : null;
  if (s && typeof s.id === 'string' && s.id) return s.id;
  const text = typeof (item && item.result) === 'string' ? item.result : '';
  const m = /\bjob\s+([A-Za-z0-9_-]{4,64})\b/.exec(text);
  return m ? m[1] : null;
}

function createScheduleTracker(opts = {}) {
  const now = opts.now || Date.now;
  const graceMs = opts.graceMs == null ? WAKE_GRACE_MS : opts.graceMs;
  let wake = null;            // { toolUseId, until, at, fireAt, prompt, reason }
  const crons = new Map();    // CronCreate toolUseId -> { id | null, cron, prompt, recurring, durable, human, createdAt }
  let ended = [];
  let api = null;
  const changed = () => { for (const fn of listeners) { try { fn(api); } catch {} } };

  function wakeItem(w, t) {
    if (!w || !(w.fireAt + FIRED_GRACE_MS > t)) return null;
    const kind = isLoopPrompt(w.prompt) ? 'loop' : 'wakeup';
    return { key: `wake:${w.toolUseId}`, kind, label: labelOf(w.prompt), prompt: cut(oneLine(w.prompt), PROMPT_MAX), detail: w.reason ? cut(oneLine(w.reason), 200) : '',
      nextAt: w.fireAt, recurring: kind === 'loop', durable: false, createdAt: w.at };
  }
  function cronItem(k, c, t) {
    if (!c.cron && !c.prompt) return null;
    const recurring = c.recurring !== false;
    let nextAt;
    let expiresAt = null;
    if (recurring) {
      nextAt = nextCronFire(c.cron, t);
      expiresAt = c.createdAt + CRON_EXPIRY_MS;
      if (nextAt != null && nextAt > expiresAt) return null; // auto-expired before its next fire
    } else {
      nextAt = nextCronFire(c.cron, c.createdAt);
      if (nextAt != null && !(nextAt + FIRED_GRACE_MS > t)) return null; // fired once and deleted itself
    }
    return { key: `cron:${k}`, kind: isLoopPrompt(c.prompt) ? 'loop' : 'cron', label: labelOf(c.prompt), prompt: cut(oneLine(c.prompt), PROMPT_MAX),
      detail: c.human || c.cron || '', cron: c.cron || '', nextAt, recurring, durable: !!c.durable, cronId: c.id || null, expiresAt, createdAt: c.createdAt };
  }

  function onToolInput(it) {
    if (!it || !it.toolUseId) return;
    const input = it.input || {};
    if (it.name === 'ScheduleWakeup') {
      if (input.stop === true) {
        const was = wakeItem(wake, now());
        if (was) ended.push({ ...was, why: 'stopped' });
        wake = null;
        changed();
        return;
      }
      const d = Number(input.delaySeconds);
      const at = Number(it.ts) || now();
      const s = Number.isFinite(d) && d > 0 ? d : DEFAULT_WAKE_S;
      wake = { toolUseId: it.toolUseId, until: at + s * 1000 + graceMs, at, fireAt: at + Math.min(3600, Math.max(60, s)) * 1000,
        prompt: typeof input.prompt === 'string' ? input.prompt : '', reason: typeof input.reason === 'string' ? input.reason : '' };
      changed();
    } else if (it.name === 'CronCreate') {
      const c = crons.get(it.toolUseId) || { id: null };
      Object.assign(c, { cron: typeof input.cron === 'string' ? input.cron : '', prompt: typeof input.prompt === 'string' ? input.prompt : '',
        recurring: input.recurring !== false, durable: input.durable === true, createdAt: c.createdAt || Number(it.ts) || now() });
      crons.set(it.toolUseId, c);
      changed();
    }
    // CronDelete: the cron goes once the delete succeeds (onToolEnd)
  }

  function onToolEnd(it, structured) {
    if (!it || !it.toolUseId) return;
    const ok = it.status === 'done';
    const s = structured && typeof structured === 'object' ? structured : null;
    if (it.name === 'ScheduleWakeup') {
      if (!ok && wake && wake.toolUseId === it.toolUseId) wake = null;
      else if (ok && wake && wake.toolUseId === it.toolUseId && s && Number(s.scheduledFor) > 0) wake.fireAt = Number(s.scheduledFor);
      changed();
    } else if (it.name === 'CronCreate') {
      if (!ok) { crons.delete(it.toolUseId); changed(); return; }
      const c = crons.get(it.toolUseId) || { createdAt: Number(it.ts) || now() };
      c.id = cronIdFrom(it, structured);
      if (s && typeof s.humanSchedule === 'string') c.human = s.humanSchedule;
      if (s && typeof s.recurring === 'boolean') c.recurring = s.recurring;
      if (s && typeof s.durable === 'boolean') c.durable = s.durable;
      crons.set(it.toolUseId, c);
      changed();
    } else if (it.name === 'CronDelete' && ok) {
      const id = typeof (it.input || {}).id === 'string' ? it.input.id : null;
      let hit = null;
      for (const [k, c] of crons) if (id && c.id === id) hit = k;
      if (!hit) {
        const unknown = [...crons].filter(([, c]) => !c.id);
        if (unknown.length === 1) hit = unknown[0][0];
      }
      if (hit) {
        const was = cronItem(hit, crons.get(hit), now());
        if (was) ended.push({ ...was, why: 'deleted' });
        crons.delete(hit);
        changed();
      }
    }
  }

  function pending() {
    const t = now();
    if (wake && wake.until <= t) wake = null;
    if (!wake && !crons.size) return null;
    const parts = [];
    if (wake) parts.push(`scheduled wake-up pending until ${new Date(wake.until - graceMs).toISOString()}`);
    if (crons.size) parts.push(`${crons.size} scheduled cron job${crons.size === 1 ? '' : 's'} pending`);
    // key: what kind of hold this is (no times), so the reaper logs a hold once, not once per tick
    return { wakeUntil: wake ? wake.until : null, crons: crons.size, key: `${wake ? 'wake' : ''}${crons.size ? `cron:${crons.size}` : ''}`, reason: parts.join(', ') };
  }

  function list() {
    const t = now();
    const out = [];
    const w = wakeItem(wake, t);
    if (w) out.push(w);
    for (const [k, c] of crons) { const x = cronItem(k, c, t); if (x) out.push(x); }
    return out;
  }

  function reset() {
    const was = list();
    wake = null; crons.clear();
    if (was.length) { for (const x of was) ended.push({ ...x, why: 'exit' }); changed(); }
  }

  function drainEnded() { const e = ended; ended = []; return e; }

  api = { onToolInput, onToolEnd, pending, reset, list, drainEnded };
  return api;
}

// ---------- the engine side: one board across sessions ----------
//   createScheduleBoard({ sessions, emit, send(id, text) -> Promise<{ itemId, queued }>, file?, log?, now? })
//     -> { methods: { 'schedules.list', 'schedules.cancel', 'schedules.dismiss' }, list(), atShutdown(), stop() }
const RECENT_MS = 30 * 60 * 1000; // an ended schedule (cancelled, CLI closed) shows this long unless dismissed
const RESTART_MS = 24 * 3600 * 1000; // "Ended by restart" shows until dismissed, at most a day
const MAX_ENDED = 20;

function schedErr(message, code) { return Object.assign(new Error(message), { code }); }

function askText(x) {
  if (x.kind === 'cron' || (x.kind === 'loop' && x.key.startsWith('cron:'))) {
    return x.cronId
      ? `Please cancel the scheduled job ${x.cronId} ("${x.label}") with CronDelete, then confirm in one line. (Sent from Helm's Scheduled list.)`
      : `Please cancel the scheduled job "${x.label}" (${x.cron || x.detail}): find it with CronList and delete it with CronDelete, then confirm in one line. (Sent from Helm's Scheduled list.)`;
  }
  return 'Please stop this loop: call ScheduleWakeup with stop: true and do not schedule another wake-up, then confirm in one line. (Sent from Helm\'s Scheduled list.)';
}

function createScheduleBoard(opts = {}) {
  const { sessions, send } = opts;
  const emit = opts.emit || (() => {});
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const file = opts.file || null;
  const asks = new Map(); // global id -> { at, queued }
  let ended = [];         // [{ id, sessionId, sessionTitle, project, kind, label, detail, why, at, asked? }]
  let shuttingDown = false;
  let timer = null;

  const gid = (sessionId, key) => `${sessionId}|${key}`;
  const titleOf = (es) => (es.s && es.s.title) || 'Untitled session';
  const projectOf = (es) => (es.s && (es.s.project || String(es.s.cwd || '').split(/[\\/]/).filter(Boolean).pop())) || '';

  // Ended by restart: what was still due when the last Helm shut down (written by atShutdown). Shown once.
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = Number(raw && raw.at) || now();
      for (const x of Array.isArray(raw && raw.items) ? raw.items.slice(0, MAX_ENDED) : []) {
        if (!x || typeof x.sessionId !== 'string' || typeof x.key !== 'string') continue;
        ended.push({ id: gid(x.sessionId, x.key) + '|restart', sessionId: x.sessionId, sessionTitle: String(x.sessionTitle || ''), project: String(x.project || ''),
          kind: x.kind, label: String(x.label || ''), detail: String(x.detail || ''), recurring: !!x.recurring, why: 'restart', at });
      }
    } catch (e) { if (e.code !== 'ENOENT') log('warn', `engine: schedules-at-exit unreadable: ${e.message}`); }
    try { fs.unlinkSync(file); } catch {}
  }

  function liveItems() {
    const out = [];
    for (const es of sessions.values()) {
      if (!es || !es.schedules || typeof es.schedules.list !== 'function') continue;
      const xs = es.schedules.list();
      if (!xs.length) continue;
      let busy = null;
      try { busy = es.busyState ? es.busyState() : null; } catch { busy = null; }
      for (const x of xs) {
        const id = gid(es.s.id, x.key);
        const ask = asks.get(id);
        const closeWhy = x.durable ? 'Saved in the project (durable): it comes back the next time Claude starts in this folder, so closing does not cancel it.'
          : busy ? 'Claude is working in this session; closing its process now would stop that work.' : null;
        out.push({ ...x, id, sessionId: es.s.id, sessionTitle: titleOf(es), project: projectOf(es), others: xs.length - 1,
          askedAt: ask ? ask.at : null, askText: askText(x), canClose: !closeWhy, closeWhy });
      }
    }
    for (const id of asks.keys()) if (!out.some((x) => x.id === id)) asks.delete(id);
    return out.sort((a, b) => (a.nextAt == null ? Infinity : a.nextAt) - (b.nextAt == null ? Infinity : b.nextAt));
  }

  function list() {
    const t = now();
    ended = ended.filter((e) => t - e.at < (e.why === 'restart' ? RESTART_MS : RECENT_MS));
    return { now: t, items: liveItems(), ended: ended.slice() };
  }

  function emitSoon() {
    if (shuttingDown || timer) return;
    timer = setTimeout(() => { timer = null; if (!shuttingDown) emit('schedules.updated', list()); }, 150);
    if (timer.unref) timer.unref();
  }

  const off = onScheduleChange((tracker) => {
    if (shuttingDown) return;
    let es = null;
    for (const x of sessions.values()) if (x && x.schedules === tracker) { es = x; break; }
    if (!es) return; // another engine's session (tests run several)
    const t = now();
    for (const d of tracker.drainEnded()) {
      const why = d.why === 'exit' ? (es._schedCancelClose ? 'closed' : es.closing ? 'session-closed' : 'exited') : d.why;
      const id = gid(es.s.id, d.key);
      ended.unshift({ id: `${id}|${t}`, sessionId: es.s.id, sessionTitle: titleOf(es), project: projectOf(es), kind: d.kind, label: d.label,
        detail: d.detail, recurring: d.recurring, why, at: t, asked: asks.has(id) });
      asks.delete(id);
    }
    if (ended.length > MAX_ENDED) ended.length = MAX_ENDED;
    emitSoon();
  });

  function find(p) {
    if (!p || typeof p.sessionId !== 'string' || typeof p.key !== 'string' || p.key.length > 200) throw schedErr('sessionId and key are required', 'bad_params');
    const es = sessions.get(p.sessionId);
    if (!es) throw schedErr(`Unknown session ${p.sessionId}`, 'not_found');
    const x = es.schedules && es.schedules.list().find((y) => y.key === p.key);
    if (!x) throw schedErr('That schedule is no longer pending in this session.', 'gone');
    return { es, x };
  }

  const methods = {
    async 'schedules.list'() { return list(); },

    // how: 'ask'   -> sends this session a visible message asking Claude to cancel it (CronDelete / ScheduleWakeup
    //                 stop). Nothing is cancelled until Claude does it; the row then moves to ended ('deleted' / 'stopped').
    //      'close' -> closes the session's Claude Code process (not while it is working; never for a durable cron),
    //                 which ends EVERY in-CLI schedule of that session. The session stays and resumes on the next send.
    async 'schedules.cancel'(p = {}) {
      const how = p.how;
      if (how !== 'ask' && how !== 'close') throw schedErr('how must be "ask" or "close"', 'bad_params');
      const { es, x } = find(p);
      const id = gid(es.s.id, x.key);
      if (how === 'ask') {
        const text = askText(x);
        const r = (await send(es.s.id, text)) || {};
        asks.set(id, { at: now() });
        emitSoon();
        return { how, asked: true, queued: !!r.queued, text };
      }
      if (x.durable) throw schedErr('This job is saved in the project and comes back when Claude next starts there; ask Claude to delete it instead.', 'durable');
      const busy = es.busyState ? es.busyState() : null;
      if (busy) throw schedErr('Claude is working in this session; closing its process would stop that work. Try again when it is idle, or ask Claude to cancel.', 'busy');
      const before = es.schedules.list().length;
      es._schedCancelClose = true;
      try { await es.close({ final: false }); } finally { delete es._schedCancelClose; }
      const left = es.schedules.list().length;
      log('info', `engine: closed CLI for ${es.s.id} from the Scheduled list (${before - left} schedule(s) ended)`);
      emitSoon();
      return { how, closed: !(es.live && es.live()), ended: before - left, left };
    },

    async 'schedules.dismiss'(p = {}) {
      if (p.all === true) ended = [];
      else if (typeof p.id === 'string') ended = ended.filter((e) => e.id !== p.id);
      else throw schedErr('id or all: true is required', 'bad_params');
      emitSoon();
      return {};
    },
  };

  // Helm is stopping (quit / update restart): every non-durable in-CLI schedule ends with its claude.exe. Note what
  // was still due so the next start can say "Ended by restart" once. Synchronous: shutdown races a 4 s timeout.
  // keep: session ids whose CLI a restart keeps running (lane detach): their schedules did not end
  function atShutdown({ keep = null } = {}) {
    if (shuttingDown) return;
    const items = liveItems().filter((x) => !x.durable && !(keep && keep.has(x.sessionId)))
      .map((x) => ({ sessionId: x.sessionId, key: x.key, sessionTitle: x.sessionTitle, project: x.project, kind: x.kind, label: x.label, detail: x.detail, recurring: x.recurring }));
    shuttingDown = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    try {
      if (items.length) fs.writeFileSync(file, JSON.stringify({ at: now(), items }));
    } catch (e) { log('warn', `engine: could not note schedules at exit: ${e.message}`); }
  }

  return { methods, list, atShutdown, stop: () => { off(); if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { createScheduleTracker, createScheduleBoard, nextCronFire, onScheduleChange, WAKE_GRACE_MS };
