'use strict';
// "Since you left" recap for Home (lane recap, 2026-10-09). The user gets one row per session that did something since they
// last had it on screen: how it ended, commits made, files changed, cost and time span. Zero Claude calls.
//
// How it stays cheap: nothing is re-parsed. The engine's own event stream (session.item / session.itemUpdate, the
// same events every client gets) is folded into a small per-session summary as it happens, O(1) per event; only
// tool items that can matter (git commit in Bash/PowerShell, Edit/Write/NotebookEdit/MultiEdit) are remembered
// until they finish. The summaries and every session's lastSeen live in <userData>/recap.json (written at most
// every SAVE_MS, and on close), so the recap survives a restart and the desktop and the phone share one.
//
// "Last saw it" = the last moment the session was on screen on ANY client (sessions.viewing, per WebSocket client,
// unioned by the engine). While a session is on screen nothing accumulates; when it leaves every screen its
// lastSeen becomes now and its summary starts empty. Viewing a session clears its recap.
//
// Sessions Helm already knew before this file existed start "seen now" (no recap for old history); a session
// created later starts from its creation, so a queue / scheduled run nobody watched shows up.
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonOrQuarantine } = require('./util');

const SAVE_MS = 2000;
const NOTIFY_MS = 800;
const MAX_PATHS = 200;        // distinct changed paths remembered per session (the count stops growing past it)
const MAX_PENDING = 500;      // unfinished tool items remembered across all sessions
const ERR_MAX = 140;

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const GIT_COMMIT_RE = /\bgit\b[^\n|;&]*?\bcommit\b/;
// git's own summary line: "[master 1a2b3c4] Subject", "[main (root-commit) 1a2b3c4] Subject", "[detached HEAD 1a2b3c4] …"
const COMMIT_LINE_RE = /^\[[^\]\n]*?\b([0-9a-f]{7,40})\] (.*)$/gm;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const resultText = (r) => (typeof r === 'string' ? r : r && typeof r.text === 'string' ? r.text : '');
const shortErr = (s) => {
  const line = String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return line.length > ERR_MAX ? line.slice(0, ERR_MAX - 1) + '…' : line;
};
const baseOf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

// Commits a finished shell tool made: [{ hash, subject }] (none unless the command ran `git … commit`).
function commitsIn(item) {
  if (!item || !SHELL_TOOLS.has(item.name)) return [];
  const cmd = item.input && typeof item.input.command === 'string' ? item.input.command : '';
  if (!GIT_COMMIT_RE.test(cmd)) return [];
  const out = [];
  for (const m of resultText(item.result).matchAll(COMMIT_LINE_RE)) out.push({ hash: m[1], subject: m[2].trim() });
  return out;
}

// The path a finished file tool changed, or null.
function fileOf(item) {
  if (!item || !FILE_TOOLS.has(item.name) || item.status !== 'done') return null;
  const i = item.input || {};
  const p = i.file_path || i.notebook_path || i.path;
  return typeof p === 'string' && p ? p : null;
}

const relevantTool = (item) => item && item.type === 'tool' && (FILE_TOOLS.has(item.name) || (SHELL_TOOLS.has(item.name) && GIT_COMMIT_RE.test(String((item.input && item.input.command) || ''))));
const finished = (st) => st === 'done' || st === 'error' || st === 'denied';

function emptyActs(ts) {
  return { from: ts, to: ts, items: 0, commits: 0, commitSubject: null, paths: [], fileCount: 0, costUsd: 0, error: null, stopped: false };
}

// createRecap({ file, knownIds, getSession(id) -> public session | null, emit, now, log })
function createRecap(opts = {}) {
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const emit = opts.emit || (() => {});
  const getSession = opts.getSession || (() => null);
  const file = opts.file || null;

  const entries = new Map();   // session id -> { seen, acts: null | {...} }
  const pending = new Map();   // `${sid}\n${itemId}` -> tool item copy { name, input, status, result }
  let viewed = new Set();
  let saveTimer = null, notifyTimer = null, dirty = false;

  // ---------- load ----------
  if (file) {
    const saved = readJsonOrQuarantine(file, { sessions: {} }, (aside, e) => log('error', `engine: recap.json is corrupt (${e.message}); moved it to ${path.basename(aside)}`));
    const obj = saved && saved.sessions && typeof saved.sessions === 'object' ? saved.sessions : {};
    for (const [id, e] of Object.entries(obj)) {
      if (!e || typeof e !== 'object') continue;
      const acts = e.acts && typeof e.acts === 'object' ? { ...emptyActs(0), ...e.acts, paths: Array.isArray(e.acts.paths) ? e.acts.paths.slice(0, MAX_PATHS) : [] } : null;
      entries.set(id, { seen: num(e.seen) || 0, acts });
    }
  }
  // Sessions Helm had before the recap existed: seen now, so the first Home shows nothing stale.
  const t0 = now();
  let added = false;
  for (const id of opts.knownIds || []) if (!entries.has(id)) { entries.set(id, { seen: t0, acts: null }); added = true; }
  if (added) scheduleSave();

  // ---------- persistence + change notice ----------
  function writeNow() {
    dirty = false;
    if (!file) return;
    const out = {};
    for (const [id, e] of entries) out[id] = { seen: e.seen, acts: e.acts };
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomic(file, { version: 1, sessions: out }); } catch (e) { log('error', `engine: could not save recap.json: ${e.message}`); }
  }
  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;   // fixed delay, not a debounce: a long streaming turn still saves every SAVE_MS
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }
  function changed() {
    scheduleSave();
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; emit('recap.updated', {}); }, NOTIFY_MS);
    if (notifyTimer.unref) notifyTimer.unref();
  }

  function entryFor(sid) {
    let e = entries.get(sid);
    if (!e) {
      const s = getSession(sid);
      e = { seen: (s && num(s.createdAt)) || 0, acts: null };
      entries.set(sid, e);
    }
    return e;
  }

  // ---------- folding events ----------
  function applyTool(e, it) {
    for (const c of commitsIn(it)) {
      e.acts.commits++;
      if (!e.acts.commitSubject) e.acts.commitSubject = c.subject;
    }
    const p = fileOf(it);
    if (p) {
      const key = p.toLowerCase().replace(/\//g, '\\');
      if (!e.acts.paths.some((x) => x.toLowerCase().replace(/\//g, '\\') === key)) {
        e.acts.fileCount++;
        if (e.acts.paths.length < MAX_PATHS) e.acts.paths.push(p);
      }
    }
  }

  function onItem(sid, item, e, ts) {
    const a = e.acts;
    a.items++;
    if (ts > a.to) a.to = ts;
    if (item.type === 'result') {
      const c = num(item.costUsd);
      if (c && c > 0) a.costUsd = Math.round((a.costUsd + c) * 1e6) / 1e6;
      a.stopped = !!item.interrupted;
      a.error = item.isError ? (a.error || 'The turn ended with an error') : null;
      return;
    }
    if (item.type === 'system' && item.subtype === 'error') { a.error = shortErr(item.text) || 'Error'; return; }
    if (item.type === 'user') { a.error = null; a.stopped = false; return; }
    if (relevantTool(item)) {
      const copy = { name: item.name, input: item.input, status: item.status, result: item.result };
      if (finished(copy.status)) applyTool(e, copy);
      else {
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        pending.set(`${sid}\n${item.id}`, copy);
      }
    }
  }

  function onEvent(event, data) {
    if (!data) return;
    if (event === 'session.removed') { forget(data.id); return; }
    if (event !== 'session.item' && event !== 'session.itemUpdate') return;
    const sid = data.sessionId;
    if (typeof sid !== 'string' || viewed.has(sid)) return;
    if (event === 'session.item') {
      const item = data.item;
      if (!item || typeof item !== 'object') return;
      const e = entryFor(sid);
      const ts = num(item.ts) || now();
      if (!e.acts) e.acts = emptyActs(ts);
      onItem(sid, item, e, ts);
      changed();
      return;
    }
    // itemUpdate: only status / result patches on remembered tool items matter (streamed text is ignored).
    const patch = data.patch;
    if (!patch || (!('status' in patch) && !('result' in patch))) return;
    const key = `${sid}\n${data.itemId}`;
    const it = pending.get(key);
    if (!it) return;
    Object.assign(it, patch);
    if (!finished(it.status)) return;
    pending.delete(key);
    const e = entryFor(sid);
    if (!e.acts) e.acts = emptyActs(now());
    applyTool(e, it);   // arrived running, finished now: counted exactly once
    e.acts.to = Math.max(e.acts.to, now());
    changed();
  }

  // The sessions on screen on any client right now. Leaving every screen = seen now; on screen = recap cleared.
  function setViewing(ids) {
    const next = new Set(ids || []);
    const t = now();
    let any = false;
    for (const id of new Set([...viewed, ...next])) {
      if (viewed.has(id) === next.has(id)) continue;
      const e = entryFor(id);
      e.seen = t;
      e.acts = null;
      any = true;
    }
    for (const k of [...pending.keys()]) if (next.has(k.slice(0, k.indexOf('\n')))) pending.delete(k);
    viewed = next;
    if (any) changed();
  }

  function forget(id) {
    if (!entries.delete(id)) return;
    for (const k of [...pending.keys()]) if (k.startsWith(id + '\n')) pending.delete(k);
    changed();
  }

  // Rows for Home: sessions with activity since the user last saw them, newest first (waiting / failed lead).
  function list() {
    const rows = [];
    for (const [id, e] of entries) {
      if (!e.acts || !e.acts.items || viewed.has(id)) continue;
      const s = getSession(id);
      if (!s || s.archived) continue;
      const a = e.acts;
      let outcome;
      if (s.status === 'waiting') outcome = 'waiting';
      else if (s.status === 'working' || (num(s.agentsRunning) || 0) > 0) outcome = 'working';
      else if (s.status === 'error' || a.error) outcome = 'failed';
      else if (a.stopped) outcome = 'stopped';
      else outcome = 'done';
      rows.push({
        id, title: s.title || 'New session', project: s.project || '',
        outcome, error: outcome === 'failed' ? (a.error || shortErr(s.activity) || 'Stopped with an error') : null,
        commits: a.commits, commitSubject: a.commitSubject,
        fileCount: a.fileCount, files: a.paths.slice(0, 3).map(baseOf),
        costUsd: a.costUsd, from: a.from, to: a.to, seenAt: e.seen || null,
      });
    }
    const rank = { waiting: 0, failed: 1 };
    rows.sort((x, y) => (rank[x.outcome] ?? 2) - (rank[y.outcome] ?? 2) || y.to - x.to);
    return rows;
  }

  function close() {
    // Whatever is on screen at quit was seen just now.
    const t = now();
    for (const id of viewed) { const e = entryFor(id); e.seen = t; e.acts = null; }
    clearTimeout(saveTimer); saveTimer = null;
    clearTimeout(notifyTimer); notifyTimer = null;
    writeNow();
  }

  return { onEvent, setViewing, list, close, flush: () => { if (dirty) { clearTimeout(saveTimer); saveTimer = null; writeNow(); } }, _entries: entries, _pending: pending };
}

module.exports = { createRecap, commitsIn, fileOf };
