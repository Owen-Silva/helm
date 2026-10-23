'use strict';
// lane steer: a message sent mid-turn reaches Claude at its next step and never interrupts; Stop is explicit and
// refused while agents run unless stopAgents; Claude is told which agents a Stop ended; the prod guard's approval
// tracking follows a mid-turn message at once; folded messages load from history.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');
const steer = require('../../main/engine/steer');
const G = require('../../main/engine/prod-guard');
const { Normalizer } = require('../../main/engine/normalize');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gate() { let open; const p = new Promise((r) => (open = r)); return { p, open }; }

// A fake CLI that FOLDS: prompts pushed while a turn runs are taken at the next "step" (fold()), echoed like
// --replay-user-messages, and listed in the result's user_message_uuids, the way claude.exe 2.1.294 does.
function harness(turn) {
  let prompt = null;
  const sdk = createFakeSdk(turn);
  const orig = sdk.query;
  sdk.query = (a) => { prompt = a.prompt; return orig(a); };
  const engine = createEngine({ userDataDir: tmp('helm-steer-'), emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: tmp('helm-steer-proj-'), statuslineDir: tmp('helm-steer-sl-') });
  const m = engine.methods;
  const folded = [];
  // inside a turn: take every prompt waiting in the input; returns frames to yield
  const fold = () => {
    const out = [];
    for (const um of prompt.buf.splice(0)) { folded.push(um); out.push({ type: 'user', isReplay: true, uuid: um.uuid, message: um.message, parent_tool_use_id: null }); }
    return out;
  };
  const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(5); } throw new Error('timed out waiting'); };
  const es = (id) => engine._internal.sessions.get(id);
  return { engine, m, sdk, fold, folded, waitFor, es };
}
const textOf = (um) => (typeof um.message.content === 'string' ? um.message.content : um.message.content.map((b) => b.text || '').join('|'));

test('a message sent mid-turn goes in at the next step: no interrupt, item pending → seen, moved after the step', async () => {
  const g = gate();
  const seen = [];
  let interrupts = 0;
  const h = harness(async function* (um, api) {
    seen.push(textOf(um));
    if (!api.state.patched) { api.state.patched = true; const q = h.sdk.calls[h.sdk.calls.length - 1].q; const i = q.interrupt; q.interrupt = async () => { interrupts++; return i(); }; }
    yield F.toolUse('m1', 'tB', 'Bash', { command: 'sleep 20' });
    await g.p; // the tool runs; the user sends now
    yield F.toolResult('tB', 'ok');
    const takes = h.fold();
    for (const f of takes) yield f;
    for (const f of F.textTurn('m2', takes.length ? 'saw: ' + textOf(takes[0]) : 'nothing')) yield f;
    yield F.result(0.01, { user_message_uuids: [um.uuid, ...takes.map((t) => t.uuid)] });
  });
  const s = await h.m['sessions.create']({ cwd: tmp('helm-steer-cwd-') });
  await h.m['sessions.send']({ id: s.id, text: 'do the work' });
  await h.waitFor(() => h.es(s.id).items.some((i) => i.type === 'tool' && i.status === 'running'));
  // The user's words in the report: "are you done?" ... and "stop" is just a message too.
  const r = await h.m['sessions.send']({ id: s.id, text: 'stop' });
  assert.deepStrictEqual([r.queued, r.delivery], [false, 'next-step']);
  const es = h.es(s.id);
  assert.strictEqual(es.byId.get(r.itemId).steer, 'pending');
  assert.strictEqual(es.pendingQueue.length, 0, 'not held in Helm\'s queue');
  g.open();
  await h.waitFor(() => es.s.status === 'idle');
  assert.strictEqual(interrupts, 0, 'a plain send never interrupts, even "stop"');
  assert.deepStrictEqual(seen, ['do the work'], 'one turn: the message was folded in, not run after');
  assert.strictEqual(textOf(h.folded[0]), 'stop');
  const it = es.byId.get(r.itemId);
  assert.strictEqual(it.steer, 'seen');
  const order = es.items.filter((i) => ['user', 'tool', 'assistant', 'result'].includes(i.type)).map((i) => i.type + (i.type === 'user' ? ':' + i.text : ''));
  assert.deepStrictEqual(order, ['user:do the work', 'tool', 'user:stop', 'assistant', 'result'], 'shown where Claude read it');
  assert.ok(/saw: stop/.test(es.items.find((i) => i.type === 'assistant').text));
  await h.engine.shutdown();
});

test('not taken mid-turn → "after": the session stays working through the next turn; /commands use Helm\'s queue', async () => {
  const g = gate();
  const seen = [];
  const h = harness(async function* (um) {
    seen.push(textOf(um));
    if (seen.length === 1) await g.p; // no fold: Claude is writing its final reply
    for (const f of F.textTurn('m' + seen.length, 'reply ' + seen.length)) yield f;
    yield F.result(0.01, { user_message_uuids: [um.uuid] });
  });
  const s = await h.m['sessions.create']({ cwd: tmp('helm-steer-cwd-') });
  await h.m['sessions.send']({ id: s.id, text: 'first' });
  await h.waitFor(() => seen.length === 1);
  const r = await h.m['sessions.send']({ id: s.id, text: 'are you done?' });
  const c = await h.m['sessions.send']({ id: s.id, text: '/compact' });
  assert.strictEqual(r.delivery, 'next-step');
  assert.deepStrictEqual([c.queued, c.delivery], [true, 'queued'], 'a /command waits for the turn');
  const es = h.es(s.id);
  const statuses = [];
  const t = setInterval(() => statuses.push(es.s.status), 1);
  g.open();
  await h.waitFor(() => seen.length === 3 && es.s.status === 'idle');
  clearInterval(t);
  assert.deepStrictEqual(seen, ['first', 'are you done?', '/compact']);
  assert.strictEqual(es.byId.get(r.itemId).steer, 'after');
  while (statuses.length && statuses[statuses.length - 1] === 'idle') statuses.pop(); // the end itself
  assert.ok(!statuses.includes('idle'), 'never flashed idle between the turns');
  await h.engine.shutdown();
});

test('Stop: refused while agents run (names them), stopAgents stops; withdraws untaken messages; Claude is told next time', async () => {
  const g = gate();
  const seen = [];
  const h = harness(async function* (um, api) {
    seen.push(textOf(um));
    if (seen.length > 1) { for (const f of F.textTurn('mz', 'ok')) yield f; yield F.result(0.01); return; }
    yield F.toolUse('m1', 'tA', 'Agent', { description: '[lane:guard] guard work', subagent_type: 'general-purpose', run_in_background: true, prompt: 'x' });
    yield { type: 'system', subtype: 'task_started', task_id: 'aaaa1111', task_type: 'local_agent', is_backgrounded: true, tool_use_id: 'tA', description: '[lane:guard] guard work' };
    yield F.toolResult('tA', 'Async agent launched successfully.', { structured: { status: 'async_launched', agentId: 'aaaa1111' } });
    yield F.toolUse('m2', 'tB', 'Bash', { command: 'sleep 30' });
    await Promise.race([g.p, new Promise((r) => { const iv = setInterval(() => { if (api.state.interrupted) { clearInterval(iv); r(); } }, 2); })]);
    if (api.state.interrupted) {
      yield { type: 'system', subtype: 'task_updated', task_id: 'aaaa1111', patch: { status: 'killed', end_time: Date.now() } };
      yield { type: 'system', subtype: 'task_notification', task_id: 'aaaa1111', status: 'stopped', tool_use_id: 'tA' };
    }
  });
  const s = await h.m['sessions.create']({ cwd: tmp('helm-steer-cwd-') });
  await h.m['sessions.send']({ id: s.id, text: 'launch' });
  const es = h.es(s.id);
  await h.waitFor(() => es.fleet.runningCount() === 1 && es.items.some((i) => i.type === 'tool' && i.name === 'Bash' && i.status === 'running'));
  const mid = await h.m['sessions.send']({ id: s.id, text: 'also do X' });
  await assert.rejects(h.m['sessions.interrupt']({ id: s.id }), (e) => e.code === 'agents_running' && e.data.agents[0].name === 'guard' && /Stop also stops 1 agent: guard/.test(e.message));
  assert.ok(es.turnActive && es.fleet.runningCount() === 1 && es.steering.size === 1, 'the refusal touched nothing');
  await assert.rejects(h.m['sessions.interrupt']({ id: s.id, stopAgents: 'yes' }), (e) => e.code === 'bad_request' || /boolean/.test(e.message));
  const r = await h.m['sessions.interrupt']({ id: s.id, stopAgents: true });
  assert.deepStrictEqual(r.stoppedAgents, ['guard']);
  await h.waitFor(() => !es.turnActive && es.fleet.runningCount() === 0);
  assert.strictEqual(es.byId.get(mid.itemId).cancelled, true, 'the untaken mid-turn message was withdrawn');
  assert.match(es.items.find((i) => i.type === 'system' && i.subtype === 'interrupted').text, /Also stopped 1 agent: guard\. 1 message was not sent\./);
  // the next message carries Helm's note, apart from the user's text
  const nx = await h.m['sessions.send']({ id: s.id, text: 'what happened?' });
  await h.waitFor(() => seen.length === 2);
  assert.strictEqual(seen[1].split('|')[1], 'what happened?');
  assert.match(seen[1].split('|')[0], /^<helm-note>Helm: your Stop at \d\d:\d\d also stopped a background agent: guard\. It is not running\.<\/helm-note>$/);
  const item = es.byId.get(nx.itemId);
  assert.strictEqual(item.text, 'what happened?');
  assert.match(item.helmNote, /also stopped a background agent: guard/);
  await h.waitFor(() => es.s.status === 'idle');
  const again = await h.m['sessions.send']({ id: s.id, text: 'thanks' });
  assert.ok(!es.byId.get(again.itemId).helmNote, 'told once');
  await h.engine.shutdown();
});

test('prod guard: a mid-turn "don\'t push" revokes at once; a queued one revokes too; origin helm stays neutral', async () => {
  const g = gate();
  const h = harness(async function* () { await g.p; for (const f of F.textTurn('m', 'ok')) yield f; yield F.result(0.01); });
  const s = await h.m['sessions.create']({ cwd: tmp('helm-steer-cwd-') });
  const es = h.es(s.id);
  await h.m['sessions.send']({ id: s.id, text: 'commit and push it' });
  assert.ok(G.priorApproval(es, { approvable: 'all' }), 'approved by the prompt that started the turn');
  await h.waitFor(() => es.q);
  await h.m['sessions.send']({ id: s.id, text: 'Continue where you left off.', origin: 'helm' });
  assert.ok(G.priorApproval(es, { approvable: 'all' }), 'a Helm-written send changes nothing');
  await h.m['sessions.send']({ id: s.id, text: "wait, don't push yet" });
  assert.strictEqual(G.priorApproval(es, { approvable: 'all' }), null, 'revoked the moment the user sent it');
  // queue fallback (a /command) cannot grant, but takes an approval back at once
  const x = { uuid: 'q-1', text: 'push it' };
  G.noteSend(es, x, 'user');
  G.notePushed(es, x);
  assert.ok(G.priorApproval(es, { approvable: 'all' }));
  await h.m['sessions.send']({ id: s.id, text: '/review do not push' });
  assert.strictEqual(G.priorApproval(es, { approvable: 'all' }), null);
  g.open();
  await h.engine.shutdown();
});

test('history: a folded mid-turn message (queued_command) loads as a seen user item; <helm-note> comes off the text', () => {
  const items = [];
  const byId = new Map();
  let k = 0;
  const store = { add: (i) => (items.push(i), byId.set(i.id, i)), patch: (id, p) => Object.assign(byId.get(id), p), get: (id) => byId.get(id) || null };
  const n = new Normalizer({ store, newId: () => 't' + ++k });
  const add = (j) => n.handleLine(j);
  add({ type: 'attachment', uuid: 'a1', timestamp: '2026-10-09T19:30:20.812Z', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'Mid-turn note. Codeword: X.' }], source_uuid: 'src-1', commandMode: 'prompt' } });
  add({ type: 'attachment', uuid: 'a2', timestamp: '2026-10-09T19:30:21.000Z', attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>', commandMode: 'task-notification', origin: { kind: 'task-notification' } } });
  add({ type: 'user', uuid: 'u2', timestamp: '2026-10-09T19:31:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '<helm-note>Helm: your Stop at 18:54 also stopped background agents: guard, recap. They are not running.</helm-note>' }, { type: 'text', text: 'carry on' }] } });
  const users = items.filter((i) => i.type === 'user');
  assert.strictEqual(users.length, 2, 'task notifications are not prompts');
  assert.deepStrictEqual([users[0].text, users[0].steer, users[0].uuid], ['Mid-turn note. Codeword: X.', 'seen', 'src-1']);
  assert.strictEqual(users[1].text, 'carry on');
  assert.match(users[1].helmNote, /guard, recap\. They are not running\.$/);
});

test('steer helpers', () => {
  assert.strictEqual(steer.stopNoteText(new Date(2026, 9, 9, 18, 54).getTime(), ['guard', 'recap']), 'Helm: your Stop at 18:54 also stopped background agents: guard, recap. They are not running.');
  assert.strictEqual(steer.stopNoteText(Date.now(), []), null);
  assert.deepStrictEqual(steer.splitNote('plain'), { note: null, rest: 'plain' });
  assert.strictEqual(steer.agentsPhrase([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }]), '5 agents: a, b, c, d, +1 more');
  assert.ok(steer.isCommand('/compact') && !steer.isCommand('stop') && !steer.isCommand('/ not a command'));
});
