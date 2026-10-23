// Unit tests for ui/lib/session-header.js: what the session header's status bar says (lane header).
// The UI module is ESM importing only ui/lib/session-status.js (also pure), so require(esm) loads it directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  fmtElapsed, fmtAgo, etaShown, ETA_STALE_MS, todoProgress, itemFacts, runningAgents, headerModel,
} = require('../../ui/lib/session-header.js');

const NOW = new Date(2026, 9, 8, 15, 0).getTime();
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const sess = (o = {}) => ({ id: 's1', title: 'T', cwd: 'C:\\p', project: 'p', status: 'idle', activity: null, turnStartedAt: null,
  agentsRunning: 0, openTasks: 0, context: null, eta: null, updatedAt: NOW - 4 * MIN, ...o });
const eta = (o = {}) => ({ state: 'working', etaAt: NOW + 14 * MIN, updatedAt: NOW - 20 * SEC, isOverdue: false, ...o });
const todos = (...st) => st.map((status, i) => ({ content: `Do ${i}`, activeForm: `Doing ${i}`, status }));

test('fmtElapsed: seconds, minutes with padded seconds, hours with padded minutes; never negative', () => {
  assert.equal(fmtElapsed(0), '0s');
  assert.equal(fmtElapsed(45 * SEC), '45s');
  assert.equal(fmtElapsed(3 * MIN + SEC), '3m 01s');
  assert.equal(fmtElapsed(59 * MIN + 59 * SEC), '59m 59s');
  assert.equal(fmtElapsed(HOUR + 4 * MIN), '1h 04m');
  assert.equal(fmtElapsed(-5 * SEC), '0s');
  assert.equal(fmtElapsed(null), '');
  assert.equal(fmtElapsed(NaN), '');
});

test('fmtAgo: minute resolution, then hours, then days', () => {
  assert.equal(fmtAgo(30 * SEC), 'just now');
  assert.equal(fmtAgo(4 * MIN + 50 * SEC), '4m ago');
  assert.equal(fmtAgo(2 * HOUR + 5 * MIN), '2h ago');
  assert.equal(fmtAgo(3 * 24 * HOUR), '3d ago');
  assert.equal(fmtAgo(-MIN), 'just now');
  assert.equal(fmtAgo(undefined), '');
});

test('etaShown: a running turn shows the mod estimate unless the mod says it is not working', () => {
  assert.equal(etaShown(sess({ status: 'working', eta: eta() }), NOW), true);
  assert.equal(etaShown(sess({ status: 'working', eta: eta({ state: undefined }) }), NOW), true);
  assert.equal(etaShown(sess({ status: 'working', eta: eta({ state: 'idle' }) }), NOW), false);
  // a running turn keeps the old rule even with an old snapshot (Helm itself knows the turn is live)
  assert.equal(etaShown(sess({ status: 'working', eta: eta({ updatedAt: NOW - HOUR }) }), NOW), true);
});

test('etaShown: never invents a time: no snapshot, no etaAt ("no estimate yet") or a bad one shows nothing', () => {
  assert.equal(etaShown(sess({ status: 'working', eta: null }), NOW), false);
  assert.equal(etaShown(sess({ status: 'working', eta: eta({ etaAt: null }) }), NOW), false);
  assert.equal(etaShown(sess({ status: 'working', eta: eta({ etaAt: 'soon' }) }), NOW), false);
  assert.equal(etaShown(sess({ status: 'working', eta: eta({ etaAt: 0 }) }), NOW), false);
});

test('etaShown: waiting on the user, idle, error and closed never show a time', () => {
  for (const status of ['waiting', 'idle', 'error', 'closed']) assert.equal(etaShown(sess({ status, eta: eta() }), NOW), false, status);
});

test('etaShown: agents-only shows it only while the mod still says working and its snapshot is fresh', () => {
  const s = (o) => sess({ status: 'idle', agentsRunning: 2, eta: eta(o) });
  assert.equal(etaShown(s({}), NOW), true);
  assert.equal(etaShown(s({ state: undefined }), NOW), false);   // no explicit word from the mod: Helm has no turn
  assert.equal(etaShown(s({ state: 'idle' }), NOW), false);
  assert.equal(etaShown(s({ updatedAt: NOW - ETA_STALE_MS - SEC }), NOW), false);
  assert.equal(etaShown(s({ updatedAt: NOW - ETA_STALE_MS + SEC }), NOW), true);
  // overdue estimates are still the mod's word ("over by 3m"), not hidden
  assert.equal(etaShown(s({ etaAt: NOW - 3 * MIN, isOverdue: true }), NOW), true);
});

test('todoProgress: done/total and the current item; nothing when empty or all done', () => {
  assert.deepEqual(todoProgress(todos('completed', 'completed', 'in_progress', 'pending')), { done: 2, total: 4, text: '2/4', current: 'Doing 2' });
  assert.deepEqual(todoProgress(todos('pending', 'pending')), { done: 0, total: 2, text: '0/2', current: '' });
  assert.equal(todoProgress(todos('completed', 'completed')), null);
  assert.equal(todoProgress([]), null);
  assert.equal(todoProgress(null), null);
  assert.equal(todoProgress([null, 3]), null);
});

test('itemFacts: latest main-thread TodoWrite, oldest pending request, last result', () => {
  const items = [
    { id: 'a', type: 'tool', name: 'TodoWrite', ts: NOW - 30 * MIN, input: { todos: todos('pending') } },
    { id: 'b', type: 'result', ts: NOW - 20 * MIN },
    { id: 'c', type: 'tool', name: 'TodoWrite', ts: NOW - 10 * MIN, input: { todos: todos('completed', 'in_progress') } },
    { id: 'd', type: 'tool', name: 'TodoWrite', ts: NOW - 9 * MIN, parentToolUseId: 'toolu_x', input: { todos: todos('pending') } },
    { id: 'e', type: 'request', status: 'pending', ts: NOW - 5 * MIN },
    { id: 'f', type: 'request', status: 'answered', ts: NOW - 8 * MIN },
    { id: 'g', type: 'request', status: 'pending', ts: NOW - 2 * MIN },
    { id: 'h', type: 'result', ts: NOW - MIN },
  ];
  const f = itemFacts(items);
  assert.equal(f.todos.length, 2);           // c, not the subagent's d
  assert.equal(f.todos[1].status, 'in_progress');
  assert.equal(f.waitingSince, NOW - 5 * MIN);
  assert.equal(f.lastTurnAt, NOW - MIN);
  assert.deepEqual(itemFacts(undefined), { todos: null, waitingSince: null, lastTurnAt: null });
  assert.deepEqual(itemFacts([null, { type: 'text' }]), { todos: null, waitingSince: null, lastTurnAt: null });
});

test('runningAgents: running only, oldest first, lane tag split off, a resume restarts the clock', () => {
  const list = runningAgents([
    { id: 'a1', status: 'done', description: '[lane:x] old', startedAt: NOW - HOUR },
    { id: 'a2', status: 'running', description: '[lane:audit] audit redirects', startedAt: NOW - 9 * MIN, subagentType: 'opus-high' },
    { id: 'a3', status: 'running', description: 'plain task', startedAt: NOW - 20 * MIN, resumedAt: NOW - 2 * MIN },
    { id: 'a4', status: 'running', description: '[lane:docs] changelog', startedAt: NOW - 12 * MIN },
  ]);
  assert.deepEqual(list.map((a) => a.id), ['a4', 'a2', 'a3']);
  assert.equal(list[1].lane, 'audit');
  assert.equal(list[1].text, 'audit redirects');
  assert.equal(list[2].lane, null);
  assert.equal(list[2].since, NOW - 2 * MIN);
  assert.deepEqual(runningAgents(null), []);
});

test('headerModel: working with 3 agents, an ETA and todos', () => {
  const s = sess({ status: 'working', activity: 'Running npm test', turnStartedAt: NOW - (3 * MIN + SEC), agentsRunning: 3, openTasks: 1,
    context: { usedTokens: 212000, windowTokens: 1000000, percent: 21.2 }, eta: eta() });
  const m = headerModel(s, { now: NOW, facts: { todos: todos('completed', 'completed', 'in_progress', 'pending') } });
  assert.equal(m.state, 'working');
  assert.equal(m.text, 'Running npm test');
  assert.equal(m.short, 'Working');
  assert.deepEqual({ text: m.clock.text, live: m.clock.live }, { text: '3m 01s', live: true });
  assert.equal(m.agents.text, '3 agents');
  assert.equal(m.eta, true);
  assert.equal(m.todo.text, '2/4');
  assert.equal(m.tasks.text, '1 task');
  assert.equal(m.context.text, '21% context');
});

test('headerModel: waiting on the user counts from the pending request, never shows a time left', () => {
  const s = sess({ status: 'waiting', activity: 'Waiting for your answer', turnStartedAt: NOW - 6 * MIN, eta: eta() });
  const m = headerModel(s, { now: NOW, facts: { waitingSince: NOW - (2 * MIN + 10 * SEC), todos: todos('pending') } });
  assert.equal(m.state, 'waiting');
  assert.equal(m.text, 'Waiting for your answer');
  assert.equal(m.short, 'Needs you');
  assert.equal(m.clock.text, '2m 10s');
  assert.equal(m.eta, false);
  assert.equal(m.todo.text, '0/1');     // a waiting turn is still a turn: same rule as the chat's todo strip
  // pending request not loaded: no clock rather than the turn's (which would read as time waiting)
  assert.equal(headerModel(s, { now: NOW, facts: {} }).clock, null);
});

test('headerModel: idle is quiet: no counts, last turn from the result item, else last used', () => {
  const s = sess({ status: 'idle', context: { percent: 4.1 }, updatedAt: NOW - 25 * MIN });
  const m = headerModel(s, { now: NOW, facts: { lastTurnAt: NOW - 4 * MIN } });
  assert.equal(m.state, 'idle');
  assert.equal(m.text, 'Idle');
  assert.equal(m.short, null);
  assert.deepEqual({ text: m.clock.text, live: m.clock.live }, { text: 'last turn 4m ago', live: false });
  assert.equal(m.agents, null);
  assert.equal(m.eta, false);
  assert.equal(m.tasks, null);
  assert.equal(m.todo, null);
  assert.equal(m.context.text, '4% context');
  assert.equal(headerModel(s, { now: NOW, facts: {} }).clock.text, 'active 25m ago');
  assert.equal(headerModel(sess({ status: 'idle', updatedAt: null }), { now: NOW }).clock, null);
  assert.equal(headerModel(sess({ status: 'closed' }), { now: NOW }).text, 'Stopped');
});

test('headerModel: agents-only reads as working, says the count in the lead, clocks the oldest agent', () => {
  const fleet = [
    { id: 'a1', status: 'running', description: '[lane:a] one', startedAt: NOW - 12 * MIN - 4 * SEC },
    { id: 'a2', status: 'running', description: '[lane:b] two', startedAt: NOW - 2 * MIN },
  ];
  const s = sess({ status: 'idle', agentsRunning: 2, eta: eta() });
  const m = headerModel(s, { now: NOW, fleet, facts: { todos: todos('completed', 'pending') } });
  assert.equal(m.todo, null);             // no turn: the finished turn's todos are not live progress
  assert.equal(m.state, 'working');
  assert.equal(m.text, '2 agents running');
  assert.equal(m.short, '2 agents');
  assert.equal(m.clock.text, '12m 04s');
  assert.equal(m.agents, null);           // not repeated after the lead
  assert.equal(m.agentList.length, 2);
  assert.equal(m.eta, true);
  // fleet not loaded yet: the count still shows (Session.agentsRunning), no clock
  const n = headerModel(sess({ status: 'idle', agentsRunning: 1 }), { now: NOW });
  assert.equal(n.text, '1 agent running');
  assert.equal(n.clock, null);
});

test('headerModel: items that do not apply disappear rather than show zeros', () => {
  const m = headerModel(sess({ status: 'working', activity: null, turnStartedAt: null, openTasks: 0, context: { percent: 0 } }), { now: NOW });
  assert.equal(m.text, 'Working');
  assert.equal(m.short, null);            // nothing shorter to fall back to
  assert.equal(m.clock, null);
  assert.equal(m.agents, null);
  assert.equal(m.tasks, null);
  assert.equal(m.context, null);
  assert.equal(m.todo, null);
  const err = headerModel(sess({ status: 'error', activity: 'API error: overloaded' }), { now: NOW });
  assert.deepEqual([err.state, err.text, err.short, err.clock], ['error', 'API error: overloaded', 'Error', null]);
  assert.equal(headerModel(null), null);
});

// ---- running agents at or past the user's 32% / 40% context rule (lane ctxwarn) ----
const { contextWarn } = require('../../ui/lib/session-header.js');
const ag = (id, pct, o = {}) => ({ id, status: 'running', description: `[lane:${id}] work`, context: pct == null ? null : { percent: pct }, ...o });

test('contextWarn: only running agents at or past 32%; amber, red once one passes 40%; floored %', () => {
  assert.equal(contextWarn(null), null);
  assert.equal(contextWarn([ag('a', 12), ag('b', 31.9), ag('c', null)]), null);
  assert.equal(contextWarn([ag('a', 45, { status: 'done' })]), null, 'finished agents never warn');
  const one = contextWarn([ag('a', 12), ag('b', 33.6)]);
  assert.deepEqual({ n: one.n, level: one.level, text: one.text, short: one.short }, { n: 1, level: 'warn', text: '1 agent at 33%', short: '33%' });
  assert.deepEqual(one.list, [{ id: 'b', lane: 'b', text: 'work', pct: 33, level: 'warn' }]);
  const two = contextWarn([ag('a', 34), ag('b', 41.2, { description: 'no tag here' })]);
  assert.equal(two.text, '2 agents at 34-41%');
  assert.equal(two.short, '2 at 41%');
  assert.equal(two.level, 'danger');
  assert.deepEqual(two.list.map((x) => [x.id, x.lane, x.text, x.pct, x.level]), [['b', null, 'no tag here', 41, 'danger'], ['a', 'a', 'work', 34, 'warn']]);
  assert.equal(contextWarn([ag('a', 40), ag('b', 40.5)]).text, '2 agents at 40%');
  assert.equal(contextWarn([ag('a', 32)]).level, 'warn', 'exactly 32 is the hand-off');
  assert.equal(contextWarn([ag('a', 40)]).level, 'danger', 'exactly 40 is over the ceiling');
});

test('headerModel carries ctxWarn from the fleet', () => {
  const s = sess({ status: 'working', agentsRunning: 2, turnStartedAt: NOW - MIN });
  assert.equal(headerModel(s, { now: NOW, fleet: [ag('a', 12)] }).ctxWarn, null);
  assert.equal(headerModel(s, { now: NOW, fleet: [ag('a', 12), ag('b', 41)] }).ctxWarn.text, '1 agent at 41%');
});
