// Unit tests for ui/lib/home-model.js: the Home screen's pure rules (lane home).
// ESM importing only pure modules, so require(esm) loads it directly (same as session-header.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { greetingFor, fmtMinutes, homeCards, glanceCounts, cardStatus, pctText } = require('../../ui/lib/home-model.js');

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 8, 21, 0, 0);

test('greetingFor: morning 5-11, afternoon 12-16, evening 17-4 (local hour)', () => {
  assert.equal(greetingFor(5), 'Good morning');
  assert.equal(greetingFor(11), 'Good morning');
  assert.equal(greetingFor(12), 'Good afternoon');
  assert.equal(greetingFor(16), 'Good afternoon');
  assert.equal(greetingFor(17), 'Good evening');
  assert.equal(greetingFor(21), 'Good evening');
  assert.equal(greetingFor(23), 'Good evening');
  assert.equal(greetingFor(0), 'Good evening');
  assert.equal(greetingFor(4), 'Good evening');
  assert.equal(greetingFor(24 + 9), 'Good morning');    // wraps
  assert.equal(greetingFor(-1), 'Good evening');         // 23
  assert.equal(greetingFor('x'), 'Hello');
  assert.equal(greetingFor(undefined), 'Hello');
});

test('fmtMinutes: minute resolution, never seconds', () => {
  assert.equal(fmtMinutes(0), '<1m');
  assert.equal(fmtMinutes(59_000), '<1m');
  assert.equal(fmtMinutes(4 * MIN + 59_000), '4m');
  assert.equal(fmtMinutes(65 * MIN), '1h 05m');
  assert.equal(fmtMinutes(-5000), '<1m');
  assert.equal(fmtMinutes(null), '');
  assert.equal(fmtMinutes('nope'), '');
});

const S = (id, extra = {}) => ({ id, title: id, project: 'p', status: 'idle', updatedAt: NOW - 5 * MIN, ...extra });

test('homeCards: tabs first in tab order, then the other active sessions in sidebar order, no repeats', () => {
  const all = [S('a'), S('b'), S('c'), S('d'), S('e')];
  const active = [S('d'), S('a'), S('e')];             // the sidebar's order
  const cards = homeCards(['c', 'a'], all, active);
  assert.deepEqual(cards.map((c) => c.s.id), ['c', 'a', 'd', 'e']);
  assert.deepEqual(cards.map((c) => c.tab), [true, true, false, false]);
});

test('homeCards: unknown tab ids drop out; archived sessions only show as open tabs; empty inputs', () => {
  const all = [S('a'), S('b', { archived: true }), S('c', { archived: true })];
  assert.deepEqual(homeCards(['x', 'b', 'b'], all, [S('a'), S('c', { archived: true })]).map((c) => c.s.id), ['b', 'a']);
  assert.deepEqual(homeCards(null, null, null), []);
  assert.deepEqual(homeCards([], all, []), []);
});

test('homeCards: uses the live session object for tab ids (fresh status)', () => {
  const all = [S('a', { status: 'working' })];
  assert.equal(homeCards(['a'], all, [S('a')])[0].s.status, 'working');
});

test('glanceCounts: agents-only counts as working; archived never counts', () => {
  const list = [
    S('w', { status: 'working' }),
    S('ag', { status: 'idle', agentsRunning: 2 }),
    S('q', { status: 'waiting' }),
    S('q2', { status: 'waiting' }),
    S('i', { status: 'idle' }),
    S('arch', { status: 'working', archived: true }),
  ];
  assert.deepEqual(glanceCounts(list), { working: 2, waiting: 2 });
  assert.deepEqual(glanceCounts([]), { working: 0, waiting: 0 });
  assert.deepEqual(glanceCounts(null), { working: 0, waiting: 0 });
});

test('cardStatus: working shows activity, turn time, agents and the eta mod estimate', () => {
  const s = S('a', { status: 'working', activity: 'Running npm test', turnStartedAt: NOW - 3 * MIN - 20_000, agentsRunning: 2,
    eta: { state: 'working', etaAt: NOW + 14 * MIN, updatedAt: NOW - 20_000 } });
  const c = cardStatus(s, NOW);
  assert.equal(c.state, 'working');
  assert.equal(c.text, 'Running npm test');
  assert.deepEqual(c.meta, ['3m', '2 agents', '14m left']);
  assert.equal(c.needsYou, false);
  assert.deepEqual(cardStatus(S('b', { status: 'working' }), NOW).meta, []);
  assert.equal(cardStatus(S('b', { status: 'working' }), NOW).text, 'Working');
});

test('cardStatus: agents only reads as working with the agent count', () => {
  const c = cardStatus(S('a', { status: 'idle', agentsRunning: 3 }), NOW);
  assert.equal(c.state, 'working');
  assert.equal(c.text, '3 agents running');
  assert.deepEqual(c.meta, []);
  assert.equal(cardStatus(S('a', { status: 'idle', agentsRunning: 1 }), NOW).text, '1 agent running');
});

test('cardStatus: waiting stands out as "Needs you" with what it waits on', () => {
  const c = cardStatus(S('a', { status: 'waiting', activity: 'Waiting for permission' }), NOW);
  assert.equal(c.state, 'waiting');
  assert.equal(c.text, 'Needs you');
  assert.deepEqual(c.meta, ['Waiting for permission']);
  assert.equal(c.needsYou, true);
  assert.deepEqual(cardStatus(S('a', { status: 'waiting' }), NOW).meta, []);
});

test('cardStatus: idle / closed say when last active; error shows the error; no session', () => {
  assert.deepEqual(cardStatus(S('a', { updatedAt: NOW - 25 * MIN }), NOW), { state: 'idle', text: 'Idle', meta: ['active 25m ago'], needsYou: false });
  assert.deepEqual(cardStatus(S('a', { status: 'closed', updatedAt: NOW - 2 * 24 * 60 * MIN }), NOW).meta, ['active 2d ago']);
  assert.equal(cardStatus(S('a', { status: 'closed' }), NOW).text, 'Stopped');
  assert.equal(cardStatus(S('a', { status: 'error', activity: 'API error: overloaded' }), NOW).text, 'API error: overloaded');
  assert.equal(cardStatus(S('a', { status: 'error' }), NOW).text, 'Stopped with an error');
  assert.equal(cardStatus(null, NOW).text, 'Idle');
});

test('cardStatus: a passed estimate says so; an idle session never shows an estimate', () => {
  const s = S('a', { status: 'working', eta: { state: 'working', etaAt: NOW - MIN } });
  assert.deepEqual(cardStatus(s, NOW).meta, ['past its estimate']);
  const idle = S('b', { status: 'idle', eta: { state: 'working', etaAt: NOW + 5 * MIN } });
  assert.deepEqual(cardStatus(idle, NOW).meta, ['active 5m ago']);
});

test('pctText: rounds and clamps; null when unknown', () => {
  assert.equal(pctText(34.4), '34%');
  assert.equal(pctText(0), '0%');
  assert.equal(pctText(140), '100%');
  assert.equal(pctText(null), null);
  assert.equal(pctText(undefined), null);
  assert.equal(pctText('x'), null);
  // like fmtPct: never "100%" short of the limit, never a silent "0%"
  assert.equal(pctText(99.6), '99%');
  assert.equal(pctText(100), '100%');
  assert.equal(pctText(0.4), '<1%');
  assert.equal(pctText(98.6), '99%');
});
