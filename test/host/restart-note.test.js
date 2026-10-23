// lane restart: the restart note's words (ui/lib/restart-note.js), the card the UI shows at the end of a
// conversation that a Helm restart (or quit) cut off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restartNoteModel, continueHint, RESTART_NOTE_SHOWN } = require('../../ui/lib/restart-note.js');

const at = new Date(2026, 9, 14, 17, 34).getTime();
const fmt = () => '5:34 PM';

test('headline: "Helm restarted at hh:mm: N agents stopped"; facts name the rest', () => {
  const m = restartNoteModel({ at, cause: 'restart', working: true, agents: [{ name: 'guard', agentId: 'a122809973b846dfa' }, { name: 'Portfolio hero scroll hand-off' }], agentsTotal: 2, tasks: [{ description: 'Run the suite in the cloud' }], shells: 1, queued: 1 }, fmt);
  assert.equal(m.headline, 'Helm restarted at 5:34 PM: 2 agents stopped');
  assert.deepEqual(m.facts, ['The turn in progress stopped', '1 background task stopped', '1 ! command stopped', '1 queued message was not sent']);
  assert.deepEqual(m.items.map((x) => [x.kind, x.name, x.id]), [['agent', 'guard', 'a122809973b846dfa'], ['agent', 'Portfolio hero scroll hand-off', null], ['task', 'Run the suite in the cloud', null]]);
  assert.equal(m.more, 0);
  assert.equal(restartNoteModel({ at, working: true, agents: [] }, () => '17:34').headline, 'Helm restarted at 17:34: the turn in progress stopped');
  assert.equal(restartNoteModel({ at, working: true, waiting: true, agents: [] }, fmt).headline, 'Helm restarted at 5:34 PM: the turn waiting on you ended');
  assert.equal(restartNoteModel({ at, cause: 'quit', agents: [{ name: 'x' }] }, fmt).headline, 'Helm closed at 5:34 PM: 1 agent stopped');
  assert.equal(restartNoteModel({ at, tasks: [{ description: 'a' }, { description: 'b' }] }, fmt).headline, 'Helm restarted at 5:34 PM: 2 background tasks stopped');
});

test('a lane tag splits off; a capped list says how many more; nothing to say -> null', () => {
  const m = restartNoteModel({ at, agents: [{ name: '[lane:guard] guard work' }], agentsTotal: 23 }, fmt);
  assert.deepEqual([m.items[0].name, m.items[0].tag], ['guard work', 'guard']);
  assert.equal(m.headline, 'Helm restarted at 5:34 PM: 23 agents stopped');
  assert.equal(m.more, 22);
  assert.equal(restartNoteModel(null), null);
  assert.equal(restartNoteModel({ at: 'x' }), null);
  assert.equal(restartNoteModel({ at, working: false, agents: [], tasks: [] }), null);
  assert.ok(RESTART_NOTE_SHOWN >= 3);
});

test('Continue says what it sends and that Claude gets the agent ids', () => {
  assert.equal(continueHint({ agents: [{ name: 'a' }, { name: 'b' }] }), 'Sends "Continue where you left off." with the stopped agents\' ids, so Claude can pick them back up.');
  assert.equal(continueHint({ agents: [{ name: 'a' }] }), 'Sends "Continue where you left off." with the stopped agent\'s id, so Claude can pick it back up.');
  assert.equal(continueHint({ working: true, agents: [] }), 'Sends "Continue where you left off." Claude is told what the restart stopped.');
});
