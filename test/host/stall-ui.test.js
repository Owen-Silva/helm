// lane stall (2026-10-09): what the UI says for stopped / quiet agents and stalled sessions. Pure ESM modules
// (ui/lib/stall-limits.js, session-status.js, session-header.js, panels/timeline-math.js) loaded via require(esm).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../../ui/lib/stall-limits.js');
const { agentsLabel, agentsQuietOf, agentsRunningOf, displayStatus, stallText } = require('../../ui/lib/session-status.js');
const { headerModel, runningAgents, contextWarn } = require('../../ui/lib/session-header.js');
const { isWorking, workingTree, fleetCounts } = require('../../ui/panels/timeline-math.js');
const { CONTEXT_HANDOFF_PCT, CONTEXT_CEILING_PCT } = require('../../ui/lib/context-limits.js');

const MIN = 60_000;
const NOW = new Date(2026, 9, 8, 19, 40).getTime();
const at = (h, m) => new Date(2026, 9, 8, h, m).getTime();
const sess = (o = {}) => ({ id: 's1', title: 'T', cwd: 'C:\\p', project: 'p', status: 'idle', activity: null, turnStartedAt: null, updatedAt: NOW - 5 * MIN, ...o });

test('thresholds are named constants: 10 min each', () => {
  assert.equal(L.AGENT_QUIET_MS, 10 * MIN);
  assert.equal(L.SESSION_STALL_MS, 10 * MIN);
  assert.equal(L.RESUME_PROMPT, 'Continue where you left off.');
});

test('agentStateText: "Stopped 18:54 · interrupted", other reasons, and "No activity 12m"', () => {
  assert.equal(L.agentStateText({ status: 'stopped', stopReason: 'interrupted', endedAt: at(18, 54) }), 'Stopped 18:54 · interrupted');
  assert.equal(L.agentStateText({ status: 'stopped', stopReason: 'exited', endedAt: at(9, 5) }), 'Stopped 09:05 · Claude Code exited');
  assert.equal(L.agentStateText({ status: 'stopped' }), 'Stopped');
  assert.equal(L.agentStateText({ status: 'running', quiet: true, startedAt: NOW - 30 * MIN, lastActivityAt: NOW - 12 * MIN }, NOW), 'No activity 12m');
  assert.equal(L.agentStateText({ status: 'running', quiet: true, lastActivityAt: NOW - 64 * MIN }, NOW), 'No activity 1h 04m');
  assert.equal(L.agentStateText({ status: 'running', lastActivityAt: NOW - 30 * MIN }, NOW), null, 'quiet only once the engine says so');
  assert.equal(L.agentStateText({ status: 'done', endedAt: NOW }), null);
});

test('stopped agents leave every running count; quiet ones stay running but are named', () => {
  const fleet = [
    { id: 'a', status: 'stopped', stopReason: 'interrupted', startedAt: NOW - 40 * MIN, endedAt: NOW - 30 * MIN },
    { id: 'b', status: 'stopped', stopReason: 'interrupted', startedAt: NOW - 40 * MIN, endedAt: NOW - 30 * MIN },
    { id: 'c', status: 'running', quiet: true, startedAt: NOW - 40 * MIN, lastActivityAt: NOW - 12 * MIN },
    { id: 'd', status: 'running', startedAt: NOW - 5 * MIN },
  ];
  assert.deepEqual(fleet.filter(isWorking).map((a) => a.id), ['c', 'd'], 'Agents panel Working filter / Timeline / Deck');
  assert.deepEqual(workingTree(fleet).map((a) => a.id), ['c', 'd']);
  if (typeof fleetCounts === 'function') assert.equal(fleetCounts(fleet).running, 2);
  const list = runningAgents(fleet, NOW);
  assert.deepEqual(list.map((a) => a.id), ['c', 'd']);
  assert.equal(list[0].quietMs, 12 * MIN);
  assert.equal(list[1].quietMs, null);
  // The session as the engine publishes it (agentsRunning counts running only).
  const s = sess({ status: 'idle', agentsRunning: 2, agentsQuiet: 1 });
  assert.equal(agentsRunningOf(s), 2);
  assert.equal(agentsQuietOf(s), 1);
  assert.equal(agentsLabel(s), '2 agents running · 1 quiet');
  assert.equal(agentsLabel(sess({ agentsRunning: 2, agentsQuiet: 2 })), '2 agents · no activity 10m+');
  assert.equal(agentsLabel(2), '2 agents running', 'a bare number is unchanged');
  assert.equal(displayStatus(sess({ agentsRunning: 0, agentsQuiet: 0 })), 'idle', 'interrupted agents no longer make a session look busy');
});

test('stalled session: header says "Stalled · 12m" and offers Resume; waiting / idle / short silences never', () => {
  const s = sess({ status: 'working', activity: 'Running npm run build', turnStartedAt: NOW - 19 * MIN, stalledSince: NOW - 12 * MIN });
  assert.equal(stallText(s, NOW), 'Stalled · 12m');
  const hm = headerModel(s, { now: NOW, fleet: [] });
  assert.equal(hm.state, 'working');
  assert.equal(`${hm.text} · ${hm.clock.text}`, 'Stalled · 12m');
  assert.equal(hm.stall.text, 'Stalled · 12m');
  assert.equal(hm.stall.since, NOW - 12 * MIN);
  assert.equal(headerModel({ ...s, stalledSince: null }, { now: NOW }).stall, null);
  assert.equal(headerModel({ ...s, status: 'waiting' }, { now: NOW }).stall, null, 'waiting on the user is not stalled');
  assert.equal(headerModel({ ...s, status: 'idle' }, { now: NOW }).stall, null);
  assert.equal(stallText({ ...s, stalledSince: NOW - 9 * MIN }, NOW), '', 'under the threshold (a late update) shows nothing');
});

test('the 32 / 40 context warnings still work, and only for running agents', () => {
  const fleet = [
    { id: 'a', status: 'running', quiet: true, lastActivityAt: NOW - 11 * MIN, startedAt: NOW - 30 * MIN, context: { percent: CONTEXT_CEILING_PCT + 1 } },
    { id: 'b', status: 'running', startedAt: NOW - 3 * MIN, context: { percent: CONTEXT_HANDOFF_PCT + 1 } },
    { id: 'c', status: 'stopped', stopReason: 'interrupted', endedAt: NOW - MIN, startedAt: NOW - 9 * MIN, context: { percent: 45 } },
  ];
  const w = contextWarn(fleet);
  assert.equal(w.n, 2);
  assert.equal(w.level, 'danger');
  assert.deepEqual(w.list.map((x) => x.id), ['a', 'b']);
});
