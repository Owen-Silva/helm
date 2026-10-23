'use strict';
// Deck summary fields on Session (lane deck): lastText (tail of the latest main-thread reply, kept
// across restarts, streamed at most every 400 ms) and pendingRequest (the oldest request waiting on
// The user, live only). See docs/PROTOCOL.md "Deck summary".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(turn, opts = {}) {
  const userDataDir = opts.userDataDir || tmp('helm-deck-');
  const cwd = tmp('helm-deckcwd-');
  const events = [];
  const engine = createEngine({
    userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk: createFakeSdk(turn), claudePath: null,
    projectsDir: tmp('helm-deckproj-'), statuslineDir: tmp('helm-decksl-'), etaDir: tmp('helm-decketa-'), external: false,
  });
  const m = engine.methods;
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error('timed out waiting');
  };
  const session = (id) => engine._internal.sessions.get(id).publicSession();
  const updates = (id) => events.filter((e) => e.event === 'session.updated' && e.data.id === id).map((e) => e.data);
  return { engine, m, events, waitFor, session, updates, userDataDir, cwd };
}

test('lastText: tail of the latest main-thread reply; subagent text never replaces it; survives a restart', async () => {
  const long = 'Start of a long reply. ' + 'word '.repeat(120) + 'and the conclusion is here.';
  const h = harness(async function* (um) {
    if (um.message.content === 'long') {
      for (const f of F.textTurn('m2', long)) yield f;
    } else {
      for (const f of F.textTurn('m1', 'All 42 tests pass.')) yield f;
      // a subagent's own reply is not the session's latest text
      yield { type: 'assistant', parent_tool_use_id: 'toolu_sub', uuid: 'u-sub', message: { id: 'msub', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'subagent chatter' }], usage: {} } };
    }
    yield F.result(0.01);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  assert.strictEqual(s.lastText, null);
  assert.strictEqual(s.pendingRequest, null);
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.strictEqual(h.session(s.id).lastText, 'All 42 tests pass.');
  await h.waitFor(() => h.updates(s.id).some((u) => u.lastText === 'All 42 tests pass.'));

  await h.m['sessions.send']({ id: s.id, text: 'long' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  const lt = h.session(s.id).lastText;
  assert.ok(lt.startsWith('…'), 'a long reply is cut at the front');
  assert.ok(lt.endsWith('and the conclusion is here.'), 'and keeps its end');
  assert.ok(lt.length <= 280, `≤ 280 chars (got ${lt.length})`);
  assert.ok(!/\s{2,}/.test(lt), 'one line');
  await h.engine.shutdown();

  // fenced code is dropped from the tile text (the prose around it stays)
  const es = h.engine._internal.sessions.get(s.id);
  es.norm.store.add({ id: 'zc', type: 'assistant', ts: Date.now(), streaming: false, text: 'Patched it:\n```js\nconst x = 1;\n```\nTests pass.' });
  assert.strictEqual(es.publicSession().lastText, 'Patched it: Tests pass.');
  es.norm.store.add({ id: 'zd', type: 'assistant', ts: Date.now(), streaming: true, text: 'Streaming:\n```js\nconst y' });
  assert.strictEqual(es.publicSession().lastText, 'Streaming:', 'an unclosed fence (still streaming) is dropped too');
  es.s.lastText = lt;   // what was saved before these synthetic items

  const saved = JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'sessions.json'), 'utf8'));
  assert.strictEqual(saved.sessions[0].lastText, lt);
  assert.ok(!('pendingRequest' in saved.sessions[0]), 'pendingRequest is never persisted');
  const h2 = harness(async function* () { yield F.result(0); }, { userDataDir: h.userDataDir });
  assert.strictEqual(h2.engine.snapshot().sessions[0].lastText, lt);
  assert.strictEqual(h2.engine.snapshot().sessions[0].pendingRequest, null);
  await h2.engine.shutdown();
});

test('lastText streams: a long reply reaches session.updated while it is still streaming (throttled)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness(async function* () {
    const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
    yield ev({ type: 'message_start', message: { id: 'ms', model: 'claude-haiku-5-5' } });
    yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Halfway through the ' } });
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'migration now' } });
    await gate; // the reply is still streaming here
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '. Done.' } });
    yield { type: 'assistant', parent_tool_use_id: null, uuid: 'u-ms', message: { id: 'ms', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Halfway through the migration now. Done.' }], usage: {} } };
    yield ev({ type: 'content_block_stop', index: 0 });
    yield ev({ type: 'message_stop' });
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'migrate' });
  const mid = await h.waitFor(() => h.updates(s.id).find((u) => u.lastText === 'Halfway through the migration now'), 2000);
  assert.strictEqual(mid.status, 'working', 'emitted mid-stream');
  // throttled: the two deltas did not each produce their own update
  assert.ok(!h.updates(s.id).some((u) => u.lastText === 'Halfway through the'), 'deltas coalesce');
  release();
  await h.waitFor(() => h.session(s.id).status === 'idle');
  await h.waitFor(() => h.updates(s.id).some((u) => u.lastText === 'Halfway through the migration now. Done.'));
  await h.engine.shutdown();
});

test('pendingRequest: permission, question and plan summaries; cleared when answered', async () => {
  const questions = [{ question: 'Which name for the view?', header: 'Name', multiSelect: false, options: [{ label: 'Deck', description: '' }, { label: 'Fleet', description: '' }] }];
  const h = harness(async function* (um, api) {
    const k = um.message.content;
    if (k === 'perm') {
      yield F.toolUse('m1', 't1', 'Bash', { command: 'npm   test\n  -- --watch=false', description: 'Run tests' });
      const r = await api.ask('Bash', { command: 'npm   test\n  -- --watch=false', description: 'Run tests' }, 't1');
      yield F.toolResult('t1', r.behavior === 'allow' ? 'ok' : 'denied', { isError: r.behavior !== 'allow' });
    } else if (k === 'ask') {
      yield F.toolUse('m2', 'tq', 'AskUserQuestion', { questions });
      const r = await api.ask('AskUserQuestion', { questions }, 'tq');
      yield F.toolResult('tq', JSON.stringify(r.updatedInput.answers));
    } else {
      yield F.toolUse('m3', 'tp', 'ExitPlanMode', { plan: '# Ship the Deck\n1. Tiles' });
      const r = await api.ask('ExitPlanMode', { plan: '# Ship the Deck\n1. Tiles' }, 'tp');
      yield F.toolResult('tp', r.behavior);
    }
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd, permissionMode: 'default' });

  await h.m['sessions.send']({ id: s.id, text: 'perm' });
  const p = await h.waitFor(() => h.session(s.id).pendingRequest);
  assert.strictEqual(h.session(s.id).status, 'waiting');
  assert.deepStrictEqual({ kind: p.kind, toolName: p.toolName, title: p.title, detail: p.detail, count: p.count },
    { kind: 'permission', toolName: 'Bash', title: 'Allow Bash?', detail: 'npm test -- --watch=false', count: 1 });
  assert.ok(p.requestId && p.itemId, 'carries requestId (for sessions.respond) and itemId');
  await h.waitFor(() => h.updates(s.id).some((u) => u.pendingRequest && u.pendingRequest.requestId === p.requestId)); // reaches session.updated
  await h.m['sessions.respond']({ id: s.id, requestId: p.requestId, response: { behavior: 'allow' } });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.strictEqual(h.session(s.id).pendingRequest, null);
  await h.waitFor(() => h.updates(s.id).at(-1).pendingRequest === null); // the cleared summary is broadcast

  await h.m['sessions.send']({ id: s.id, text: 'ask' });
  const q = await h.waitFor(() => h.session(s.id).pendingRequest);
  assert.strictEqual(q.kind, 'question');
  assert.strictEqual(q.title, 'Which name for the view?');
  assert.strictEqual(q.detail, 'Deck · Fleet');
  assert.deepStrictEqual(q.choice, { question: 'Which name for the view?', options: [{ label: 'Deck' }, { label: 'Fleet' }] });
  await h.m['sessions.respond']({ id: s.id, requestId: q.requestId, response: { answers: { 'Which name for the view?': 'Deck' } } });
  await h.waitFor(() => h.session(s.id).status === 'idle');

  await h.m['sessions.send']({ id: s.id, text: 'plan' });
  const pl = await h.waitFor(() => h.session(s.id).pendingRequest);
  assert.strictEqual(pl.kind, 'plan');
  assert.strictEqual(pl.title, 'A plan is ready for review');
  assert.strictEqual(pl.detail, 'Ship the Deck');
  assert.ok(!('choice' in pl) && !('choice' in p), 'plan and permission summaries never carry a choice');
  await h.m['sessions.interrupt']({ id: s.id });
  await h.waitFor(() => h.session(s.id).pendingRequest === null && h.session(s.id).status !== 'waiting');
  await h.engine.shutdown();
});

test('pendingRequest.choice: only one single-select question with 2-4 options; exact labels answer it', async () => {
  const opt = (label, description) => ({ label, description });
  const SUB = 'Let agents spawn sub-agents this session?';
  const cases = {
    sub: [{ question: SUB, header: 'Sub-agents', multiSelect: false, options: [opt('Yes', 'One level below them; grandchildren never spawn.'), opt('No', ''), opt('Free rein', 'Any depth, as many as they judge useful.')] }],
    two: [{ question: 'Q1?', header: 'A', multiSelect: false, options: [opt('a', ''), opt('b', '')] }, { question: 'Q2?', header: 'B', multiSelect: false, options: [opt('c', ''), opt('d', '')] }],
    multi: [{ question: 'Which?', header: 'M', multiSelect: true, options: [opt('a', ''), opt('b', '')] }],
    five: [{ question: 'Pick one', header: 'F', multiSelect: false, options: ['a', 'b', 'c', 'd', 'e'].map((l) => opt(l, '')) }],
    one: [{ question: 'Only?', header: 'O', multiSelect: false, options: [opt('a', '')] }],
  };
  const got = [];
  const h = harness(async function* (um, api) {
    const questions = cases[um.message.content];
    yield F.toolUse('m', 'tq', 'AskUserQuestion', { questions });
    const r = await api.ask('AskUserQuestion', { questions }, 'tq');
    got.push(r.updatedInput && r.updatedInput.answers);
    yield F.toolResult('tq', JSON.stringify(r.updatedInput && r.updatedInput.answers));
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd, permissionMode: 'default' });

  await h.m['sessions.send']({ id: s.id, text: 'sub' });
  const q = await h.waitFor(() => h.session(s.id).pendingRequest);
  assert.deepStrictEqual(q.choice, { question: SUB, options: [
    { label: 'Yes', description: 'One level below them; grandchildren never spawn.' }, { label: 'No' }, { label: 'Free rein', description: 'Any depth, as many as they judge useful.' }] });
  assert.strictEqual(q.detail, 'Yes · No · Free rein');
  // the UI's copy (Deck tiles that read loaded items, the mock, the stand-in engine) builds the same choice
  const { simpleChoice } = require('../../ui/deck/choice.js');
  assert.deepStrictEqual(simpleChoice(cases.sub), q.choice);
  for (const k of ['two', 'multi', 'five', 'one']) assert.strictEqual(simpleChoice(cases[k]), null, k);
  // a tile answer is the chat's shape; Claude gets it as updatedInput.answers
  await h.m['sessions.respond']({ id: s.id, requestId: q.requestId, response: { answers: { [q.choice.question]: q.choice.options[2].label } } });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.deepStrictEqual(got.at(-1), { [SUB]: 'Free rein' });

  for (const k of ['two', 'multi', 'five', 'one']) {
    await h.m['sessions.send']({ id: s.id, text: k });
    const p = await h.waitFor(() => h.session(s.id).pendingRequest);
    assert.strictEqual(p.kind, 'question', k);
    assert.ok(!('choice' in p), `${k}: no inline choice (the tile opens the session instead)`);
    const answers = Object.fromEntries(cases[k].map((x) => [x.question, x.options[0].label]));
    await h.m['sessions.respond']({ id: s.id, requestId: p.requestId, response: { answers } });
    await h.waitFor(() => h.session(s.id).status === 'idle');
  }
  await h.engine.shutdown();
});
