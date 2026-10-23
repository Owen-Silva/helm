'use strict';
// lane restart: a Helm restart mid-turn (the turn, a background agent, a background task) is (1) blocked by the
// restart gate while it runs, agents counted even when the fleet lost one; (2) kept at shutdown as
// Session.restartNote; (3) shown after the next start, and Continue sends "Continue where you left off." with a
// <helm-note> naming the stopped agent and its id; (4) cleared by Continue, by any message, or by Dismiss.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');
const { restartBlockers } = require('../../main/update');
const steer = require('../../main/engine/steer');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(5); } throw new Error('timed out waiting'); };
const textOf = (um) => (typeof um.message.content === 'string' ? um.message.content : um.message.content.map((b) => b.text || '').join('|'));

function boot(dir, turn) {
  const sdk = createFakeSdk(turn);
  const engine = createEngine({ userDataDir: dir, emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: path.join(dir, 'projects'), statuslineDir: path.join(dir, 'sl') });
  return { engine, m: engine.methods, sdk, es: (id) => engine._internal.sessions.get(id) };
}
const savedSessions = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).sessions;

// The first Helm: a turn that launches a background agent and a background shell, then sits in a long Bash call.
function busyTurn() {
  return async function* (um, api) {
    yield F.toolUse('m1', 'tA', 'Agent', { description: '[lane:guard] guard work', subagent_type: 'general-purpose', run_in_background: true, prompt: 'x' });
    yield { type: 'system', subtype: 'task_started', task_id: 'aaaa1111', task_type: 'local_agent', is_backgrounded: true, tool_use_id: 'tA', description: '[lane:guard] guard work' };
    yield F.toolResult('tA', 'Async agent launched successfully.', { structured: { status: 'async_launched', agentId: 'aaaa1111' } });
    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'aaaa1111', task_type: 'local_agent', description: '[lane:guard] guard work' },
      { task_id: 'bsh1', task_type: 'local_bash', description: 'Run the suite in the cloud' },
    ] };
    yield F.toolUse('m2', 'tB', 'Bash', { command: 'sleep 600' });
    await new Promise((r) => { const iv = setInterval(() => { if (api.state.closed || api.state.interrupted) { clearInterval(iv); r(); } }, 5); });
  };
}

test('a restart mid-turn: the gate blocks it; after a forced restart the note names what stopped; Continue resumes', async () => {
  const dir = tmp('helm-restart-note-');
  const a = boot(dir, busyTurn());
  const s = await a.m['sessions.create']({ cwd: tmp('helm-restart-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'launch the guard lane' });
  const es = a.es(s.id);
  await waitFor(() => es.fleet.runningCount() === 1 && es.openTasks.size === 1 && es.items.some((i) => i.type === 'tool' && i.name === 'Bash' && i.status === 'running'));

  // (1) the gate: what a manual restart (and so also the automatic one) would cut off
  const busy = a.engine.busy();
  assert.strictEqual(busy.length, 1);
  assert.deepStrictEqual([busy[0].working, busy[0].agents, busy[0].tasks], [true, 1, 1]);
  assert.deepStrictEqual(restartBlockers({ sessions: busy }, { manual: true }), ['1 session working', '1 agent running', '1 background task running']);

  // (2) The user restarts anyway: shutdown keeps the cut-off with the session
  await a.engine.shutdown({ cause: 'restart' });
  const saved = savedSessions(dir).find((x) => x.id === s.id);
  assert.ok(saved.restartNote, 'restartNote saved in sessions.json');
  const n = saved.restartNote;
  assert.strictEqual(n.cause, 'restart');
  assert.strictEqual(n.working, true);
  assert.deepStrictEqual(n.agents.map((x) => [x.name, x.agentId]), [['guard', 'aaaa1111']]);
  assert.deepStrictEqual(n.tasks.map((t) => t.description), ['Run the suite in the cloud']);
  assert.strictEqual(saved.status, 'idle');

  // (3) the next Helm: the session carries the note; Continue sends the resume prompt with the helm-note
  const prompts = [];
  const b = boot(dir, async function* (um) {
    prompts.push(um);
    for (const f of F.textTurn('m9', 'Resuming guard with SendMessage.')) yield f;
    yield F.result(0.01);
  });
  const snap = await b.engine.snapshot();
  const s2 = snap.sessions.find((x) => x.id === s.id);
  assert.ok(s2.restartNote && s2.restartNote.agents.length === 1, 'the UI gets restartNote with the session');
  assert.strictEqual(s2.status, 'idle');
  const r = await b.m['sessions.continueAfterRestart']({ id: s.id });
  assert.strictEqual(r.action, 'continued');
  assert.strictEqual(r.prompt, 'Continue where you left off.');
  await waitFor(() => prompts.length === 1 && b.es(s.id).s.status === 'idle');
  const sent = textOf(prompts[0]);
  const note = steer.splitNote(sent.split('|')[0]).note;
  assert.ok(note, 'a <helm-note> rides first: ' + sent);
  assert.match(note, /^Helm: Helm restarted at \d\d:\d\d while you were working, which ended your turn/);
  assert.match(note, /guard \(agent aaaa1111\)/);
  assert.match(note, /SendMessage to an agent id resumes it/);
  assert.match(note, /Run the suite in the cloud/);
  assert.strictEqual(sent.split('|').pop(), 'Continue where you left off.');
  const item = b.es(s.id).byId.get(r.itemId);
  assert.strictEqual(item.text, 'Continue where you left off.');
  assert.strictEqual(item.helmNote, note, 'shown as the small Helm note line, not in the bubble');
  // (4) the note is gone (live and saved), and Continue twice sends nothing
  assert.strictEqual(b.es(s.id).publicSession().restartNote, null);
  await waitFor(() => !savedSessions(dir).find((x) => x.id === s.id).restartNote, 2000);
  const again = await b.m['sessions.continueAfterRestart']({ id: s.id });
  assert.strictEqual(again.action, 'none');
  assert.strictEqual(prompts.length, 1);
  await b.engine.shutdown({ cause: 'restart' });
  assert.ok(!savedSessions(dir).find((x) => x.id === s.id).restartNote, 'an idle session gets no note');
});

test('Dismiss hides the note; Claude still hears about the restart with the next message; a quit says so', async () => {
  const dir = tmp('helm-restart-dismiss-');
  const a = boot(dir, busyTurn());
  const s = await a.m['sessions.create']({ cwd: tmp('helm-restart-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'go' });
  await waitFor(() => a.es(s.id).fleet.runningCount() === 1);
  await a.engine.shutdown(); // a plain quit
  assert.strictEqual(savedSessions(dir).find((x) => x.id === s.id).restartNote.cause, 'quit');
  const prompts = [];
  const b = boot(dir, async function* (um) { prompts.push(um); for (const f of F.textTurn('m9', 'ok')) yield f; yield F.result(0.01); });
  assert.deepStrictEqual(await b.m['sessions.dismissRestartNote']({ id: s.id }), { dismissed: true });
  assert.strictEqual(b.es(s.id).publicSession().restartNote, null);
  await b.m['sessions.send']({ id: s.id, text: 'what happened?' });
  await waitFor(() => prompts.length === 1);
  const sent = textOf(prompts[0]);
  assert.match(sent, /^<helm-note>Helm: Helm was closed at \d\d:\d\d while you were working/);
  assert.match(sent, /\|what happened\?$/);
  await b.engine.shutdown();
});

test('the gate counts agents the CLI lists even when the fleet never saw them, after the turn ended too', async () => {
  const dir = tmp('helm-restart-cli-agents-');
  const a = boot(dir, async function* () {
    // no Agent tool_use reached Helm (a lost frame): only the CLI's own level signal names the agent
    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bbbb2222', task_type: 'local_agent', description: 'Rank the backlog' }] };
    for (const f of F.textTurn('m1', 'launched')) yield f;
    yield F.result(0.01);
  });
  const s = await a.m['sessions.create']({ cwd: tmp('helm-restart-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'go' });
  const es = a.es(s.id);
  await waitFor(() => es.s.status === 'idle' && es.cliAgents.size === 1);
  assert.strictEqual(es.fleet.runningCount(), 0, 'the fleet lost it');
  const busy = a.engine.busy();
  assert.deepStrictEqual(busy.map((b) => [b.working, b.agents]), [[false, 1]], 'still blocks with the turn over');
  assert.deepStrictEqual(restartBlockers({ sessions: busy, autoRestart: true, now: 0 }), ['1 agent running']);
  assert.deepStrictEqual(a.engine.recycleClis().busy, [s.id], 'an account switch leaves it alone too');
  await a.engine.shutdown({ cause: 'restart' });
  const n = savedSessions(dir).find((x) => x.id === s.id).restartNote;
  assert.deepStrictEqual(n.agents, [{ id: null, agentId: 'bbbb2222', name: 'Rank the backlog' }]);
  assert.strictEqual(n.working, false);
});

test('restartNoteText: the turn, agents with ids, tasks, ! runs, queued; nothing -> null', () => {
  const at = new Date(2026, 9, 14, 17, 34).getTime();
  assert.strictEqual(steer.restartNoteText(null), null);
  assert.strictEqual(steer.restartNoteText({ at, working: false, agents: [], tasks: [] }), null);
  assert.strictEqual(steer.restartNoteText({ at, cause: 'restart', working: true, agents: [], tasks: [] }),
    'Helm: Helm restarted at 17:34 while you were working, which ended your turn before it finished.');
  assert.strictEqual(steer.restartNoteText({ at, cause: 'restart', working: false, agents: [{ name: 'guard', agentId: 'a1' }, { name: 'recap' }], tasks: [{ description: 'cloud run' }], shells: 1, queued: 2 }),
    'Helm: Helm restarted at 17:34. It stopped 2 background agents: guard (agent a1), recap. They are not running; SendMessage to an agent id resumes it with its context. Background task that stopped: cloud run. A ! command stopped too. 2 queued messages were not sent.');
});
