// Unit tests for ui/lib/session-activity.js: the sidebar's active / Past rule (lane sessions).
// The UI module is ESM with no imports, so require(esm) loads it directly (same as export-md.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_WINDOW_MS, activeReason, splitSessions, isEmptySession, startedAt, buildProjectGroups,
  mergePast, isExternalRunning, dayGroupOf, groupByDay, isWorkingDefault,
} = require('../../ui/lib/session-activity.js');

const NOW = new Date(2026, 9, 8, 15, 0).getTime();   // local 15:00, 2026-10-08
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
let n = 0;
const sess = (o = {}) => ({ id: o.id || `s${++n}`, claudeSessionId: `c-${o.id || n}`, title: 'T', project: 'p', cwd: 'C:\\p',
  status: 'idle', pinned: false, archived: false, updatedAt: NOW - 3 * HOUR, createdAt: NOW - 4 * HOUR, ...o });
const ids = (list) => list.map((s) => s.id);

test('ACTIVE_WINDOW_MS is one hour', () => {
  assert.equal(ACTIVE_WINDOW_MS, 3600000);
});

test('activeReason: waiting, working, error, pinned, recent; idle and old is Past', () => {
  const o = { now: NOW };
  assert.equal(activeReason(sess({ status: 'waiting', updatedAt: NOW - 9 * DAY }), o), 'waiting');
  assert.equal(activeReason(sess({ status: 'working', updatedAt: NOW - 9 * DAY }), o), 'working');
  assert.equal(activeReason(sess({ status: 'error', updatedAt: NOW - 9 * DAY }), o), 'error');
  assert.equal(activeReason(sess({ pinned: true, updatedAt: NOW - 90 * DAY }), o), 'pinned');
  assert.equal(activeReason(sess({ updatedAt: NOW - 10 * MIN }), o), 'recent');
  assert.equal(activeReason(sess({ updatedAt: NOW - 2 * HOUR }), o), null);
  assert.equal(activeReason(sess({ status: 'closed', updatedAt: NOW - 2 * HOUR }), o), null);
});

test('activeReason: the window edge is exclusive and windowMs overrides it', () => {
  assert.equal(activeReason(sess({ updatedAt: NOW - HOUR + 1 }), { now: NOW }), 'recent');
  assert.equal(activeReason(sess({ updatedAt: NOW - HOUR }), { now: NOW }), null);
  assert.equal(activeReason(sess({ updatedAt: NOW - 2 * HOUR }), { now: NOW, windowMs: 3 * HOUR }), 'recent');
});

test('working includes an ended turn whose background agents still run', () => {
  const s = sess({ status: 'idle', agentsRunning: 2, updatedAt: NOW - 5 * HOUR });
  assert.equal(isWorkingDefault(s), true);
  assert.equal(activeReason(s, { now: NOW }), 'working');
  assert.equal(isWorkingDefault(sess({ status: 'closed', agentsRunning: 2 })), false);   // agents die with the CLI
  // an injected helper (lane:fleet's) wins
  assert.equal(activeReason(s, { now: NOW, isWorking: () => false }), null);
  assert.equal(activeReason(sess({ updatedAt: NOW - 5 * HOUR }), { now: NOW, isWorking: () => true }), 'working');
});

test('archived sessions are never active, even working or pinned', () => {
  assert.equal(activeReason(sess({ archived: true, pinned: true }), { now: NOW }), null);
  const r = splitSessions([sess({ id: 'a', archived: true, status: 'closed' })], { now: NOW });
  assert.deepEqual(ids(r.archived), ['a']);
  assert.equal(r.active.length + r.past.length + r.empty.length, 0);
});

test('splitSessions: keeps order, sends old idle to Past, keep wins', () => {
  const list = [
    sess({ id: 'work', status: 'working' }),
    sess({ id: 'recent', updatedAt: NOW - 5 * MIN }),
    sess({ id: 'old', updatedAt: NOW - 2 * DAY }),
    sess({ id: 'kept', updatedAt: NOW - 3 * DAY }),
    sess({ id: 'older', updatedAt: NOW - 30 * DAY }),
  ];
  const r = splitSessions(list, { now: NOW, keep: new Set(['kept']) });
  assert.deepEqual(ids(r.active), ['work', 'recent', 'kept']);
  assert.deepEqual(ids(r.past), ['old', 'older']);
  assert.deepEqual(r.empty, []);
});

test('empty sessions: active while recent, then hidden (or Past while open)', () => {
  const blank = (o) => sess({ claudeSessionId: null, title: 'New session', costUsd: 0, lastText: null, ...o });
  assert.equal(isEmptySession(blank()), true);
  assert.equal(isEmptySession(blank({ lastText: 'hi' })), false);
  assert.equal(isEmptySession(blank({ costUsd: 0.02 })), false);
  assert.equal(isEmptySession(sess()), false);
  const fresh = blank({ id: 'fresh', updatedAt: NOW - 5 * MIN });
  const stale = blank({ id: 'stale', updatedAt: NOW - 2 * DAY });
  const open = blank({ id: 'open', updatedAt: NOW - 2 * DAY });
  const r = splitSessions([fresh, stale, open], { now: NOW, openId: 'open' });
  assert.deepEqual(ids(r.active), ['fresh']);
  assert.deepEqual(ids(r.empty), ['stale']);
  assert.deepEqual(ids(r.past), ['open']);
});

test('isExternalRunning: active transcript or agents still running', () => {
  assert.equal(isExternalRunning({ active: true, agentsRunning: 0 }), true);
  assert.equal(isExternalRunning({ active: false, agentsRunning: 2 }), true);
  assert.equal(isExternalRunning({ active: false, agentsRunning: 0 }), false);
});

test('mergePast: dedupes by claudeSessionId against every Helm session, drops running and empty', () => {
  const helmPast = sess({ id: 'h1', claudeSessionId: 'c-h1', updatedAt: NOW - 2 * HOUR });
  const helmActive = sess({ id: 'h2', claudeSessionId: 'c-h2', status: 'working' });
  const helmArch = sess({ id: 'h3', claudeSessionId: 'c-h3', archived: true });
  const history = [
    { claudeSessionId: 'c-h2', title: 'own transcript (active)', lastActivity: NOW - 1 * MIN, messageCount: 9 },
    { claudeSessionId: 't-run', title: 'running in a terminal', lastActivity: NOW - 2 * MIN, messageCount: 4 },
    { claudeSessionId: 'c-h1', title: 'own transcript (past)', lastActivity: NOW - 2 * HOUR, messageCount: 9 },
    { claudeSessionId: 't-1', title: 'terminal one', lastActivity: NOW - 3 * HOUR, messageCount: 12 },
    { claudeSessionId: 't-open', title: 'open in Helm', lastActivity: NOW - 4 * HOUR, messageCount: 3, helmSessionId: 's_x' },
    { claudeSessionId: 't-0', title: 'no messages', lastActivity: NOW - 5 * HOUR, messageCount: 0 },
    { claudeSessionId: 'c-h3', title: 'archived transcript', lastActivity: NOW - 6 * HOUR, messageCount: 2 },
    { claudeSessionId: 't-big', title: 'too big to count', lastActivity: NOW - 7 * DAY, messageCount: null },
  ];
  const external = [
    { claudeSessionId: 't-run', active: true, agentsRunning: 0, lastActivity: NOW - 20000 },
    { claudeSessionId: 't-idle', title: 'idle terminal', project: 'p', active: false, agentsRunning: 0, lastActivity: NOW - 90 * MIN },
    { claudeSessionId: 't-1', title: 'terminal one', active: false, agentsRunning: 0, lastActivity: NOW - 3 * HOUR },
  ];
  const rows = mergePast({ helm: [helmPast], history, external, allSessions: [helmPast, helmActive, helmArch] });
  assert.deepEqual(rows.map((r) => r.key), ['t:t-idle', 'h:h1', 't:t-1', 't:t-big']);
  assert.equal(rows[1].s, helmPast);
  assert.equal(rows[0].h.title, 'idle terminal');
});

test('mergePast: q filters Helm rows and external extras; server results pass through', () => {
  const a = sess({ id: 'a', title: 'Fix login redirect', project: 'Storefront', updatedAt: NOW - 2 * HOUR });
  const b = sess({ id: 'b', title: 'Tray icon', project: 'helm', updatedAt: NOW - 3 * HOUR });
  const external = [{ claudeSessionId: 'x1', title: 'Pricing copy', project: 'Storefront', active: false, lastActivity: NOW - HOUR },
    { claudeSessionId: 'x2', title: 'Clock drift', project: 'mantle', active: false, lastActivity: NOW - HOUR }];
  const history = [{ claudeSessionId: 'srv', title: 'matched on the server by its prompt', lastActivity: NOW - DAY, messageCount: 5 }];
  const rows = mergePast({ helm: [a, b], history, external, allSessions: [a, b], q: 'storefront' });
  assert.deepEqual(rows.map((r) => r.key), ['t:x1', 'h:a', 't:srv']);
});

test('mergePast: with more history pages, older Helm rows wait for their page', () => {
  const recent = sess({ id: 'r', updatedAt: NOW - 2 * HOUR });
  const ancient = sess({ id: 'z', updatedAt: NOW - 60 * DAY });
  const history = [{ claudeSessionId: 't1', lastActivity: NOW - HOUR, messageCount: 3 }, { claudeSessionId: 't2', lastActivity: NOW - 5 * DAY, messageCount: 3 }];
  const more = mergePast({ helm: [recent, ancient], history, allSessions: [recent, ancient], historyHasMore: true });
  assert.deepEqual(more.map((r) => r.key), ['t:t1', 'h:r', 't:t2']);
  const all = mergePast({ helm: [recent, ancient], history, allSessions: [recent, ancient], historyHasMore: false });
  assert.deepEqual(all.map((r) => r.key), ['t:t1', 'h:r', 't:t2', 'h:z']);
});

test('dayGroupOf / groupByDay: local calendar days', () => {
  const today9 = new Date(2026, 9, 8, 9, 0).getTime();
  const yest23 = new Date(2026, 9, 7, 23, 59).getTime();
  const sixDays = new Date(2026, 9, 2, 12, 0).getTime();
  const twentyDays = new Date(2026, 8, 18, 12, 0).getTime();
  const old = new Date(2026, 5, 1).getTime();
  assert.equal(dayGroupOf(today9, NOW), 'Today');
  assert.equal(dayGroupOf(yest23, NOW), 'Yesterday');
  assert.equal(dayGroupOf(sixDays, NOW), 'Previous 7 days');
  assert.equal(dayGroupOf(twentyDays, NOW), 'Previous 30 days');
  assert.equal(dayGroupOf(old, NOW), 'Older');
  const groups = groupByDay([today9, yest23, sixDays, old].map((at, i) => ({ key: String(i), at })), NOW);
  assert.deepEqual(groups.map((g) => [g.label, g.rows.length]), [['Today', 1], ['Yesterday', 1], ['Previous 7 days', 1], ['Older', 1]]);
});

test('startedAt: resumedAt (picked back up from Past) wins over createdAt', () => {
  assert.equal(startedAt({ createdAt: 100 }), 100);
  assert.equal(startedAt({ createdAt: 100, resumedAt: 500 }), 500);
  assert.equal(startedAt({ createdAt: 100, resumedAt: null }), 100);
});

test('buildProjectGroups: start order inside a project, projects by newest start, pinned projects first', () => {
  const list = [
    sess({ id: 'a1', cwd: 'C:/a', project: 'a', createdAt: NOW - 50 * MIN }),
    sess({ id: 'b1', cwd: 'C:/b', project: 'b', createdAt: NOW - 10 * MIN }),
    sess({ id: 'a2', cwd: 'C:/a', project: 'a', createdAt: NOW - 5 * MIN }),
    sess({ id: 'c1', cwd: 'C:/c/', project: 'c', createdAt: NOW - 3 * DAY, resumedAt: NOW - 1 * MIN }),   // picked back up from Past
    sess({ id: 'a3', cwd: 'C:/A', project: 'a', createdAt: NOW - 90 * MIN, pinned: true }),   // pinned: no jump to the top
  ];
  const projects = [{ cwd: 'C:/pin', name: 'Pinned project', pinned: true }, { cwd: 'C:/b', name: 'b', pinned: false }];
  const g = buildProjectGroups(list, projects);
  assert.deepEqual(g.map((x) => x.key), ['c:/pin', 'c:/c', 'c:/a', 'c:/b']);
  assert.deepEqual(g.find((x) => x.key === 'c:/a').sessions.map((s) => s.id), ['a2', 'a1', 'a3']);
  assert.equal(g[0].sessions.length, 0, 'a pinned project shows even with nothing active');
});

test('order never changes on activity, status, unread, updatedAt or pin changes', () => {
  const base = [
    sess({ id: 'x1', cwd: 'C:/x', createdAt: NOW - 40 * MIN }),
    sess({ id: 'y1', cwd: 'C:/y', createdAt: NOW - 30 * MIN }),
    sess({ id: 'x2', cwd: 'C:/x', createdAt: NOW - 20 * MIN }),
    sess({ id: 'y2', cwd: 'C:/y', createdAt: NOW - 10 * MIN }),
  ];
  const shape = (list) => buildProjectGroups(list).map((g) => `${g.key}:${g.sessions.map((s) => s.id).join(',')}`).join(' | ');
  const want = shape(base);
  const churn = [
    (s, i) => ({ ...s, updatedAt: NOW + i * 1000 }),
    (s, i) => ({ ...s, status: ['working', 'waiting', 'error', 'idle'][i % 4], activity: 'Running npm test' }),
    (s, i) => ({ ...s, unread: 10 - i, lastText: 'done' }),
    (s, i) => ({ ...s, pinned: i % 2 === 0, agentsRunning: i }),
  ];
  for (const f of churn) {
    assert.equal(shape(base.map(f)), want);
    assert.equal(shape(base.map(f).reverse()), want, 'input order (the store sorts by activity) does not matter');
  }
  // only a new start moves things: a new session in project x puts x first
  assert.ok(shape([...base, sess({ id: 'x3', cwd: 'C:/x', createdAt: NOW })]).startsWith('c:/x:x3,x2,x1 |'));
});
