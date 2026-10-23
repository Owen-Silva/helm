// Which sessions the sidebar's main list shows ("active"), in what order, and which move to Past.
// Owner: lane sessions. Pure, no imports, time injected: test/host/session-activity.test.js loads it
// with require(esm).
//
// Active (main list): waiting for the user, working (including a turn that ended while its background
// agents still run), errored, pinned ("Keep in list"), or used within ACTIVE_WINDOW_MS. On top of that
// the caller passes `keep`: the open session, once it has been in the main list, never leaves it while
// it is open, and a session the user just left stays until a later minute tick (ui/shell/activity.js).
// "Used" is updatedAt: the engine bumps it for real use only (sends, turns, renames, pins, the user's
// Close), not for opening a session (sessions.markRead) or Helm stopping a CLI itself.
// Order (the user asked: "show them in the order of when they were started"): by start time, newest first,
// never by activity. Start = Session.resumedAt (set by the engine when a session is picked back up
// from Past) or createdAt. Projects: pinned first (settings order), then by their newest start.
// Past: every other Helm session that is not archived, merged with terminal transcripts
// (history.search + idle external.list entries), deduped by claudeSessionId, by last use.

// "Used in the last hour" keeps an idle session in the main list. One named constant on purpose: a
// Settings control would go in Settings -> General ("Keep idle sessions in the list for"), saved as
// settings.sidebar.activeWindowMin and passed to splitSessions as windowMs. The engine mirrors it as
// RESUME_GAP_MS (main/engine/session.js) to stamp resumedAt.
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

// Working = a turn is running, or the turn ended while background agents still run. lane:fleet's
// shared status helper is passed in as isWorking by the app; this is the same rule for a plain Session.
export function isWorkingDefault(s) {
  return !!s && (s.status === 'working' || (s.status !== 'closed' && Number(s.agentsRunning) > 0));
}

// Never got a prompt through: Claude Code never gave it a session id, and it has no reply or cost.
export function isEmptySession(s) {
  return !!s && !s.claudeSessionId && !s.lastText && !(Number(s.costUsd) > 0);
}

// When the user last used s.
export function lastUsedAt(s) {
  return Number(s.updatedAt || s.createdAt || 0);
}

// When s started, for ordering: picked back up from Past (resumedAt) or created.
export function startedAt(s) {
  return Math.max(Number(s.resumedAt) || 0, Number(s.createdAt) || 0);
}

// Why s is in the main list ('waiting' | 'working' | 'error' | 'pinned' | 'recent'), or null.
export function activeReason(s, { now = Date.now(), windowMs = ACTIVE_WINDOW_MS, isWorking = isWorkingDefault } = {}) {
  if (!s || s.archived) return null;
  if (s.status === 'waiting') return 'waiting';
  if (isWorking(s)) return 'working';
  if (s.status === 'error') return 'error';
  if (s.pinned) return 'pinned';
  if (now - lastUsedAt(s) < windowMs) return 'recent';
  return null;
}

// Splits Helm's sessions. Order is kept inside each list (the caller orders the active list itself).
// keep: Set/Map of ids that stay in the main list regardless (see the header).
// empty: inactive sessions that never got a prompt through; neither list shows them (the sidebar
// offers to delete them from Past). The open one goes to Past instead, so it is never invisible.
export function splitSessions(list, { now = Date.now(), openId = null, keep = null, windowMs = ACTIVE_WINDOW_MS, isWorking = isWorkingDefault } = {}) {
  const active = [], past = [], empty = [], archived = [];
  const o = { now, windowMs, isWorking };
  for (const s of list || []) {
    if (!s || !s.id) continue;
    if (s.archived) archived.push(s);
    else if (activeReason(s, o) || (keep && keep.has(s.id))) active.push(s);
    else if (isEmptySession(s) && s.id !== openId) empty.push(s);
    else past.push(s);
  }
  return { active, past, empty, archived };
}

// Start order, newest first; ties by id so the order never depends on the input order.
export function byStart(a, b) {
  return startedAt(b) - startedAt(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export const projectKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

// Project groups for the main list: settings.projects pinned ones first (in settings order, shown
// even when empty), then every other project with sessions, by its newest session's start. Sessions
// inside a group by start. Nothing here reads status, activity, unread or updatedAt, so a project or
// a row only moves when a session starts (or is picked back up from Past).
export function buildProjectGroups(list, projects = []) {
  const groups = [];
  const byKey = new Map();
  const add = (key, name, cwd, pinned) => { const g = { key, name, cwd, pinned, sessions: [] }; groups.push(g); byKey.set(key, g); return g; };
  for (const p of [...projects].sort((a, b) => (b.pinned === true) - (a.pinned === true))) {
    const key = projectKey(p.cwd);
    if (!byKey.has(key)) add(key, p.name || p.cwd, p.cwd, !!p.pinned);
  }
  for (const s of list || []) {
    const key = projectKey(s.cwd);
    (byKey.get(key) || add(key, s.project || s.cwd, s.cwd, false)).sessions.push(s);
  }
  for (const g of groups) g.sessions.sort(byStart);
  const newest = (g) => (g.sessions.length ? startedAt(g.sessions[0]) : 0);
  const pinned = groups.filter((g) => g.pinned);
  const rest = groups.filter((g) => !g.pinned && g.sessions.length)
    .sort((a, b) => newest(b) - newest(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...pinned, ...rest];
}

// A terminal session counts as running (Elsewhere) while its transcript is being written or its
// background agents still run; anything else from a terminal is Past.
export function isExternalRunning(x) {
  return !!x && (!!x.active || Number(x.agentsRunning) > 0);
}

const termsOf = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
export function matchesQuery(fields, q) {
  const terms = termsOf(q);
  if (!terms.length) return true;
  const hay = fields.filter(Boolean).join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// Past rows, newest use first: Helm's inactive sessions (helm) merged with terminal transcripts
// (history: one or more history.search pages; external: external.list, of which the idle ones count).
// A transcript is dropped when ANY Helm session owns it (allSessions, archived included: an archived
// session stays out of Past, and a Helm session's own transcript is never a second row), when it is
// running in a terminal right now (Elsewhere shows it), or when it has no messages.
// q filters Helm rows and the external extras the way history.search filters transcripts (the server
// already filtered `history`). historyHasMore: older history pages exist; Helm rows older than the
// oldest loaded transcript wait for that page, so loading more only ever appends at the bottom.
// Row: { kind: 'helm', key, at, s } | { kind: 'term', key, at, h }.
export function mergePast({ helm = [], history = [], external = [], allSessions = [], q = '', historyHasMore = false } = {}) {
  const owned = new Set();
  for (const s of allSessions) if (s && s.claudeSessionId) owned.add(s.claudeSessionId);
  for (const s of helm) if (s && s.claudeSessionId) owned.add(s.claudeSessionId);
  const running = new Set();
  for (const x of external) if (isExternalRunning(x)) running.add(x.claudeSessionId);
  let cutoff = -Infinity;
  if (historyHasMore && history.length) cutoff = Math.min(...history.map((h) => Number(h.lastActivity) || 0));
  const rows = [];
  const seen = new Set();
  const addTerm = (h, filter) => {
    const id = h && h.claudeSessionId;
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (owned.has(id) || h.helmSessionId || running.has(id) || h.messageCount === 0) return;
    if (filter && !matchesQuery([h.title, h.firstPrompt, h.project, h.cwd], q)) return;
    const at = Number(h.lastActivity) || 0;
    if (at < cutoff) return;
    rows.push({ kind: 'term', key: 't:' + id, at, h });
  };
  for (const h of history) addTerm(h, false);
  for (const x of external) if (!isExternalRunning(x)) addTerm(x, true);
  for (const s of helm) {
    if (!s || !matchesQuery([s.title, s.project, s.cwd], q)) continue;
    const at = lastUsedAt(s);
    if (at < cutoff) continue;
    rows.push({ kind: 'helm', key: 'h:' + s.id, at, s });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}

// Day buckets for Past, by local calendar day relative to now. Labels in display order.
export const DAY_GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
export function dayGroupOf(ts, now = Date.now()) {
  const d = new Date(now);
  const daysBack = (n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  if (ts >= daysBack(0)) return 'Today';
  if (ts >= daysBack(1)) return 'Yesterday';
  if (ts >= daysBack(7)) return 'Previous 7 days';
  if (ts >= daysBack(30)) return 'Previous 30 days';
  return 'Older';
}
// rows (newest first) -> [{ label, rows }] with empty buckets left out.
export function groupByDay(rows, now = Date.now()) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const label = dayGroupOf(r.at, now);
    if (!cur || cur.label !== label) { cur = { label, rows: [] }; out.push(cur); }
    cur.rows.push(r);
  }
  return out;
}
