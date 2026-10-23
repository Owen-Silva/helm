'use strict';
// main.log lines for the CLI's background-task events (task_started / task_updated / task_notification /
// background_tasks_changed), one TaskLog per EngineSession.
//
// Why (lane logs, measured 2026-10-14 over 4.35 days of the user's main.log + main.log.1): these four events were
// 97% of the log, ~3,270 lines and ~925 KB a day, each with its full JSON. 78% of task_started were a
// foreground Bash call (local_bash, is_backgrounded false): every Bash tool call, already in the transcript.
//
// Policy (engine log level, index.js; default info):
//   debug  every event with its full JSON, exactly the old line (HELM_LOG_LEVEL=debug brings it back).
//   info   one short line per state change a person debugging needs:
//            - a background task or agent starts, is backgrounded, or ends (ends: once per task);
//            - EVERY failure, kill or stop, foreground or not (never dropped, error text kept);
//            - the CLI's background task set when its membership changes (not on every repeat).
//          A foreground Bash call that starts and completes normally logs nothing at info.

// The fields of a task_* / background_tasks_changed entry worth a log line (shape evidence, no prompts).
const taskShape = (m) => { const o = {}; for (const k of ['subtype', 'task_id', 'task_type', 'status', 'is_backgrounded', 'ambient', 'skip_transcript', 'tool_use_id', 'patch']) if (m && m[k] !== undefined) o[k] = m[k]; if (m && m.description) o.description = String(m.description).slice(0, 60); return o; };

const DESC_MAX = 40;
const ERROR_MAX = 160;
const SHOWN_MAX = 500; // safety cap on remembered ids (a task whose end never arrives)

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const quote = (s) => (s ? ` "${clip(s, DESC_MAX)}"` : '');
const isFail = (st) => st === 'failed' || st === 'killed' || st === 'stopped' || st === 'error';
const isEnd = (st) => st === 'completed' || isFail(st);
// Every Bash tool call: the SDK reports it as a task that starts and ends with the call.
const isForegroundBash = (m) => m.task_type === 'local_bash' && m.is_backgrounded === false;

class TaskLog {
  // sid: () => session id (read at log time); log(level, msg); debugOn: () => bool (skip building JSON when off)
  constructor({ sid, log, debugOn }) {
    this.sid = sid;
    this.log = log;
    this.debugOn = debugOn || (() => true);
    this.shown = new Map();     // task id -> { type } : started/backgrounded lines logged at info
    this.ended = new Map();     // task id -> 'ok' | 'fail' : an end already logged at info
    this.levelSig = null;       // last background-task set logged at info
  }

  _info(text) { this.log('info', `engine: ${this.sid()} ${text}`); }
  _debug(subtype, json) { if (this.debugOn()) this.log('debug', `engine: ${this.sid()} ${subtype} ${json()}`); }

  _remember(map, id, v) {
    map.delete(id); map.set(id, v);
    if (map.size > SHOWN_MAX) map.delete(map.keys().next().value);
  }

  // One task_started / task_updated / task_notification (task_progress: debug only).
  event(m) {
    if (!m || !m.task_id) return;
    this._debug(m.subtype, () => JSON.stringify(taskShape(m)));
    const id = m.task_id;
    if (m.subtype === 'task_started') {
      if (isForegroundBash(m)) return;
      this._remember(this.shown, id, { type: m.task_type || null });
      this.ended.delete(id);
      this._info(`task_started ${id} ${m.task_type || '?'}${m.is_backgrounded ? ' bg' : ''}${quote(m.description)}`);
    } else if (m.subtype === 'task_updated') {
      const p = m.patch || {};
      if (p.is_backgrounded === true && !this.shown.has(id)) {
        this._remember(this.shown, id, { type: m.task_type || null });
        this._info(`task_updated ${id} backgrounded${quote(m.description || p.description)}`);
      }
      if (isEnd(p.status)) this._end('task_updated', id, p.status, p.error);
      else if (p.error) this._info(`task_updated ${id} error: ${clip(p.error, ERROR_MAX)}`);
    } else if (m.subtype === 'task_notification') {
      this._end('task_notification', id, m.status, m.error); // no status: surfaced, not assumed fine
    }
  }

  _end(subtype, id, status, error) {
    const fail = status !== 'completed';
    const kind = fail ? 'fail' : 'ok';
    const prior = this.ended.get(id);
    if (prior === kind) return; // the same end, already said (task_updated then task_notification)
    if (!fail && !this.shown.has(id)) return; // a foreground Bash call that completed: debug only
    this._remember(this.ended, id, kind);
    this.shown.delete(id);
    this._info(`${subtype} ${id} ${status || '?'}${error ? `: ${clip(error, ERROR_MAX)}` : ''}`);
  }

  // background_tasks_changed: the full set of live background tasks (REPLACE).
  level(list) {
    const tasks = Array.isArray(list) ? list : [];
    this._debug('background_tasks_changed', () => JSON.stringify(tasks.map(taskShape)).slice(0, 600));
    const ids = tasks.filter((t) => t && t.task_id).map((t) => t.task_id).sort();
    const sig = ids.join(',');
    if (sig === this.levelSig) return;
    this.levelSig = sig;
    const byType = new Map();
    for (const t of tasks) if (t && t.task_id) byType.set(t.task_type || '?', (byType.get(t.task_type || '?') || 0) + 1);
    const parts = [...byType].map(([k, n]) => `${n} ${k}`).join(', ');
    this._info(`background tasks ${ids.length}${parts ? ` (${parts})` : ''}`);
  }

  // A new or exited CLI process: its task level starts empty.
  reset() { this.levelSig = null; }
}

module.exports = { TaskLog, taskShape, _internal: { isForegroundBash, clip } };
