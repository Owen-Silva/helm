// Context hand-off alerts (main/engine/fleet.js ContextAlerts): a running subagent crossing 32% of its
// context window raises ONE notify, crossing 40% raises a second, nothing repeats, and the setting off
// silences them without replaying old crossings when it comes back on. Driven by a real Fleet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Fleet, ContextAlerts, CONTEXT_HANDOFF, CONTEXT_CEILING } = require('../../main/engine/fleet');
const { windowFor } = require('../../main/engine/util');

const MODEL = 'claude-opus-5-5';
const W = windowFor(MODEL);

function rig({ enabled = () => true } = {}) {
  const fleet = new Fleet('s1', () => {});
  const sent = [];
  const alerts = new ContextAlerts({ notify: (n) => sent.push(n), enabled, sessionTitle: (id) => (id === 's1' ? 'Helm infra' : null) });
  const start = (id, description) => fleet.onToolStart({ type: 'tool', name: 'Agent', toolUseId: id, status: 'running', ts: 1, input: { description, model: MODEL } });
  const at = (id, pct) => { fleet.onUsage(id, { input_tokens: Math.round((W * pct) / 100) }, MODEL); return alerts.check('s1', fleet.list()); };
  return { fleet, alerts, sent, start, at };
}

test('thresholds are 32 and 40', () => {
  assert.equal(CONTEXT_HANDOFF, 32);
  assert.equal(CONTEXT_CEILING, 40);
});

test('crossing 32% alerts once, with the agent name and the hand-off wording', () => {
  const r = rig();
  r.start('t1', 'audit-routes');
  assert.equal(r.at('t1', 20).length, 0);
  assert.equal(r.at('t1', 31.9).length, 0);
  r.at('t1', 33.2);
  assert.equal(r.sent.length, 1);
  const n = r.sent[0];
  assert.equal(n.title, "Agent 'audit-routes' is at 33% context — hand it off");
  assert.equal(n.sessionId, 's1');
  assert.equal(n.agentId, 't1');
  assert.equal(n.threshold, 32);
  assert.equal(n.kind, 'waiting');
  assert.match(n.body, /Helm infra/);
});

test('no repeat while it stays between 32% and 40%', () => {
  const r = rig();
  r.start('t1', 'audit-routes');
  for (const p of [32, 33, 35, 39.9, 36]) r.at('t1', p);
  assert.equal(r.sent.length, 1);
});

test('40% raises a second, ceiling alert, then nothing more', () => {
  const r = rig();
  r.start('t1', 'audit-routes');
  r.at('t1', 34);
  r.at('t1', 41.4);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].title, "Agent 'audit-routes' is at 41% context — over the 40% ceiling");
  assert.equal(r.sent[1].threshold, 40);
  assert.equal(r.sent[1].kind, 'error');
  r.at('t1', 45); r.at('t1', 50);
  assert.equal(r.sent.length, 2);
});

test('jumping straight past 40% sends only the ceiling alert', () => {
  const r = rig();
  r.start('t1', 'big-read');
  r.at('t1', 10);
  r.at('t1', 44);
  assert.deepEqual(r.sent.map((n) => n.threshold), [40]);
});

test('each agent is tracked separately; finished agents never alert', () => {
  const r = rig();
  r.start('t1', 'lane-a');
  r.start('t2', 'lane-b');
  r.fleet.onUsage('t2', { input_tokens: Math.round(W * 0.35) }, MODEL);
  r.fleet.onToolEnd({ toolUseId: 't2', status: 'done', result: 'finished' });
  r.at('t1', 33);
  assert.deepEqual(r.sent.map((n) => n.agentId), ['t1']);
});

test('setting off: no alerts, and turning it back on does not replay old crossings', () => {
  let on = false;
  const r = rig({ enabled: () => on });
  r.start('t1', 'audit-routes');
  r.at('t1', 33);
  r.at('t1', 41);
  assert.equal(r.sent.length, 0);
  on = true;
  r.at('t1', 42);
  assert.equal(r.sent.length, 0);
  r.start('t3', 'fresh-lane');
  r.at('t3', 32.5);
  assert.deepEqual(r.sent.map((n) => [n.agentId, n.threshold]), [['t3', 32]]);
});

test('setting off at 32% still lets the 40% alert through once it is back on', () => {
  let on = false;
  const r = rig({ enabled: () => on });
  r.start('t1', 'audit-routes');
  r.at('t1', 33);
  on = true;
  r.at('t1', 40);
  assert.deepEqual(r.sent.map((n) => n.threshold), [40]);
});

test('estimated context from task_progress counts too; forget() resets a removed session', () => {
  const r = rig();
  r.start('t1', 'bg-lane');
  r.fleet.onTask({ subtype: 'task_progress', tool_use_id: 't1', task_id: 'k1', usage: { total_tokens: Math.round(W * 0.325) } });
  r.alerts.check('s1', r.fleet.list());
  assert.equal(r.sent.length, 1);
  r.alerts.forget('s1');
  r.alerts.check('s1', r.fleet.list());
  assert.equal(r.sent.length, 2);
});

test('an agent with no description falls back to its type, then to "An agent"', () => {
  const sent = [];
  const a = new ContextAlerts({ notify: (n) => sent.push(n) });
  a.check('s', [{ id: 'x', status: 'running', subagentType: 'opus-high', context: { percent: 32 } }, { id: 'y', status: 'running', context: { percent: 33 } }]);
  assert.deepEqual(sent.map((n) => n.title.split(' is at')[0]), ["Agent 'opus-high'", 'An agent']);
  assert.equal(sent[0].body, 'Hand off now; never cross 40%.');
});
