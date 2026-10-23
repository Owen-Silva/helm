'use strict';
// Engine tests against a fake SDK: lifecycle, streaming, requests, queueing, crash, fleet,
// persistence, files.changes, usage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function harness(turn, opts = {}) {
  const userDataDir = opts.userDataDir || tmp('helm-eng-');
  const cwd = opts.cwd || tmp('helm-cwd-');
  const events = [];
  const sdk = createFakeSdk(turn);
  const statuslineDir = opts.statuslineDir || tmp('helm-sl-');
  const engine = createEngine({
    userDataDir,
    emit: (event, data) => events.push({ event, data }),
    log: () => {},
    sdk,
    claudePath: null,
    projectsDir: opts.projectsDir || tmp('helm-proj-'),
    statuslineDir,
  });
  const m = engine.methods;
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out waiting');
  };
  const items = async (id) => (await m['sessions.history']({ id })).items;
  const session = (id) => engine._internal.sessions.get(id).publicSession();
  return { engine, m, events, sdk, waitFor, items, session, userDataDir, cwd, statuslineDir };
}

function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
}

test('create → send → streamed assistant + result; title, cost, context, status', async () => {
  const h = harness(async function* (um) {
    assert.strictEqual(um.message.content, 'reply with the word ok');
    for (const f of F.textTurn('msg1', 'ok then')) yield f;
    yield F.result(0.02);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd, model: 'claude-haiku-5-5' });
  assert.strictEqual(s.status, 'idle');
  assert.ok(s.id.startsWith('s_'));
  assert.strictEqual(s.effort, 'xhigh');
  assert.strictEqual(s.permissionMode, 'bypassPermissions');
  assert.ok(h.events.some((e) => e.event === 'session.created'));
  const r = await h.m['sessions.send']({ id: s.id, text: 'reply with the word ok' });
  assert.strictEqual(r.queued, false);
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.events.some((e) => e.event === 'session.item' && e.data.item.type === 'result'));
  const it = await h.items(s.id);
  assert.deepStrictEqual(it.map((i) => i.type), ['user', 'system', 'assistant', 'result']);
  assert.strictEqual(it[2].text, 'ok then');
  assert.strictEqual(it[2].streaming, false);
  assert.ok(h.events.some((e) => e.event === 'session.itemUpdate' && e.data.appendText), 'streamed deltas');
  assert.strictEqual(it[3].costUsd, 0.02);
  const sess = h.session(s.id);
  assert.strictEqual(sess.title, 'reply with the word ok');
  assert.strictEqual(sess.costUsd, 0.02);
  assert.strictEqual(sess.context.usedTokens, 1015);
  assert.strictEqual(sess.context.windowTokens, 1000000);
  assert.ok(sess.claudeSessionId, 'claude session id known up front');
  // Options handed to the SDK.
  const o = h.sdk.calls[0].options;
  assert.deepStrictEqual(o.settingSources, ['user', 'project', 'local']);
  assert.strictEqual(o.includePartialMessages, true);
  assert.strictEqual(o.effort, 'xhigh');
  assert.strictEqual(o.permissionMode, 'bypassPermissions');
  assert.strictEqual(o.allowDangerouslySkipPermissions, true);
  assert.strictEqual(o.sessionId, sess.claudeSessionId);
  assert.strictEqual(o.cwd, h.cwd);
  assert.strictEqual(o.model, 'claude-haiku-5-5');
  assert.ok(h.events.some((e) => e.event === 'notify' && e.data.kind === 'done'));
  const usage = await h.m['usage.get']({});
  assert.strictEqual(usage.costTodayUsd, 0.02);
  await h.engine.shutdown();
});

test('AskUserQuestion round-trip: request item, waiting, respond → answers reach the tool', async () => {
  let got = null;
  const questions = [{ question: 'Red or blue?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }];
  const h = harness(async function* (um, api) {
    yield F.toolUse('m1', 'tq', 'AskUserQuestion', { questions });
    got = await api.ask('AskUserQuestion', { questions }, 'tq');
    yield F.toolResult('tq', `answered ${JSON.stringify(got.updatedInput.answers)}`, { structured: { answers: got.updatedInput.answers } });
    for (const f of F.textTurn('m2', 'Blue')) yield f;
    yield F.result(0.01);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'ask me' });
  const req = await h.waitFor(() => h.events.find((e) => e.event === 'session.item' && e.data.item.type === 'request'));
  const ri = req.data.item;
  assert.strictEqual(ri.kind, 'question');
  assert.deepStrictEqual(ri.questions, questions);
  assert.strictEqual(ri.status, 'pending');
  assert.strictEqual(h.session(s.id).status, 'waiting');
  assert.strictEqual(h.session(s.id).activity, 'Waiting for your answer');
  assert.ok(h.events.some((e) => e.event === 'notify' && e.data.kind === 'waiting'));
  await h.m['sessions.respond']({ id: s.id, requestId: ri.requestId, response: { answers: { 'Red or blue?': 'Blue' } } });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.deepStrictEqual(got, { behavior: 'allow', updatedInput: { questions, answers: { 'Red or blue?': 'Blue' } } });
  const it = await h.items(s.id);
  assert.strictEqual(it.find((i) => i.type === 'request').status, 'answered');
  assert.strictEqual(it.find((i) => i.type === 'tool').status, 'done');
  await assert.rejects(h.m['sessions.respond']({ id: s.id, requestId: ri.requestId, response: {} }), /No pending request/);
  await h.engine.shutdown();
});

test('permission deny → tool denied; allow always → later calls skip the prompt; plan → mode', async () => {
  const results = [];
  const h = harness(async function* (um, api) {
    if (um.message.content === 'deny') {
      yield F.toolUse('m1', 't1', 'Bash', { command: 'rm -rf x', description: 'Delete x' });
      const r = await api.ask('Bash', { command: 'rm -rf x' }, 't1');
      results.push(r);
      yield F.toolResult('t1', r.message, { isError: true });
    } else if (um.message.content === 'always') {
      for (const id of ['t2', 't3']) {
        yield F.toolUse('m' + id, id, 'WebFetch', { url: 'https://example.com' });
        const r = await api.ask('WebFetch', { url: 'https://example.com' }, id);
        results.push(r);
        yield F.toolResult(id, 'fetched');
      }
    } else {
      yield F.toolUse('mp', 'tp', 'ExitPlanMode', { plan: '# Plan\n1. do it' });
      const r = await api.ask('ExitPlanMode', { plan: '# Plan\n1. do it' }, 'tp');
      results.push(r);
      yield F.toolResult('tp', 'approved');
    }
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd, permissionMode: 'default' });
  const pending = async (n) => (await h.waitFor(() => h.events.filter((e) => e.event === 'session.item' && e.data.item.type === 'request')[n])).data.item;

  await h.m['sessions.send']({ id: s.id, text: 'deny' });
  const r1 = await pending(0);
  assert.strictEqual(r1.kind, 'permission');
  assert.strictEqual(h.session(s.id).activity, 'Waiting for permission: Bash');
  await h.m['sessions.respond']({ id: s.id, requestId: r1.requestId, response: { behavior: 'deny', message: 'never' } });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.deepStrictEqual(results[0], { behavior: 'deny', message: 'never' });
  assert.strictEqual((await h.items(s.id)).find((i) => i.toolUseId === 't1').status, 'denied');

  await h.m['sessions.send']({ id: s.id, text: 'always' });
  const r2 = await pending(1);
  await h.m['sessions.respond']({ id: s.id, requestId: r2.requestId, response: { behavior: 'allow', always: true } });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[2].behavior, 'allow');
  assert.strictEqual(h.events.filter((e) => e.event === 'session.item' && e.data.item.type === 'request').length, 2, 'second WebFetch was not asked');

  await h.m['sessions.send']({ id: s.id, text: 'plan' });
  const r3 = await pending(2);
  assert.strictEqual(r3.kind, 'plan');
  assert.strictEqual(r3.plan, '# Plan\n1. do it');
  await h.m['sessions.respond']({ id: s.id, requestId: r3.requestId, response: { behavior: 'allow', mode: 'acceptEdits' } });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.deepStrictEqual(results[3].updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.strictEqual(h.session(s.id).permissionMode, 'acceptEdits');
  await h.engine.shutdown();
});

// lane steer: a plain message mid-turn goes to Claude at its next step (test/engine/steer.test.js). Helm's own
// queue is the fallback, e.g. a /command, which the CLI runs as a turn of its own.
test('queueing: a /command during a turn is queued and goes out after the result; interrupt cancels queued and mid-turn sends', async () => {
  const g = gate();
  const seen = [];
  const h = harness(async function* (um) {
    seen.push(um.message.content);
    if (um.message.content === 'first') {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'mf' } } };
      await g.p;
    }
    for (const f of F.textTurn('m-' + um.message.content, 'done ' + um.message.content)) yield f;
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'first' });
  await h.waitFor(() => seen.length === 1);
  const r2 = await h.m['sessions.send']({ id: s.id, text: '/second' });
  assert.strictEqual(r2.queued, true);
  assert.strictEqual(h.session(s.id).queued, 1);
  let it = await h.items(s.id);
  assert.strictEqual(it.find((i) => i.id === r2.itemId).queued, true);
  assert.deepStrictEqual(seen, ['first'], '/second not sent while the turn runs');
  g.open();
  await h.waitFor(() => seen.length === 2 && h.session(s.id).status === 'idle');
  assert.deepStrictEqual(seen, ['first', '/second']);
  it = await h.items(s.id);
  assert.strictEqual(it.find((i) => i.id === r2.itemId).queued, false);
  assert.strictEqual(h.session(s.id).queued, 0);
  await h.engine.shutdown();

  // Interrupt: queued prompts are cancelled, not sent.
  const g2 = gate();
  const seen2 = [];
  const h2 = harness(async function* (um) {
    seen2.push(um.message.content);
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'x' } } };
    await g2.p;
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
    yield F.result(0);
  });
  const s2 = await h2.m['sessions.create']({ cwd: h2.cwd });
  await h2.m['sessions.send']({ id: s2.id, text: 'long' });
  await h2.waitFor(() => seen2.length === 1);
  const q = await h2.m['sessions.send']({ id: s2.id, text: 'later' });
  assert.strictEqual(q.delivery, 'next-step', 'a plain message goes into the running turn');
  const q2 = await h2.m['sessions.send']({ id: s2.id, text: '/later' });
  assert.strictEqual(q2.queued, true);
  await h2.m['sessions.interrupt']({ id: s2.id });
  g2.open();
  await h2.waitFor(() => h2.session(s2.id).status === 'idle');
  const it2 = await h2.items(s2.id);
  const later = it2.find((i) => i.id === q.itemId);
  assert.ok(!later.queued);
  assert.strictEqual(later.cancelled, true, 'withdrawn from the CLI (cancelAsyncMessage)');
  const later2 = it2.find((i) => i.id === q2.itemId);
  assert.strictEqual(later2.queued, false);
  assert.strictEqual(later2.cancelled, true);
  assert.match(it2.find((i) => i.type === 'system' && i.subtype === 'interrupted').text, /2 messages were not sent/);
  assert.ok(it2.some((i) => i.type === 'system' && i.subtype === 'interrupted'));
  assert.deepStrictEqual(seen2, ['long']);
  await h2.engine.shutdown();
});

test('CLI crash → error item + status error; next send restarts and resumes', async () => {
  let n = 0;
  const h = harness(async function* () {
    n++;
    if (n === 1) {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'c1' } } };
      throw new Error('Claude Code process exited with code 3');
    }
    for (const f of F.textTurn('c2', 'back')) yield f;
    yield F.result(0.03);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'one' });
  await h.waitFor(() => h.session(s.id).status === 'error');
  let it = await h.items(s.id);
  assert.ok(it.some((i) => i.type === 'system' && i.subtype === 'error' && /exited with code 3/.test(i.text)));
  assert.ok(h.events.some((e) => e.event === 'notify' && e.data.kind === 'error'));
  await h.m['sessions.send']({ id: s.id, text: 'two' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.sdk.calls.length === 2);
  it = await h.items(s.id);
  assert.strictEqual(it[it.length - 1].type, 'result');
  assert.strictEqual(h.sdk.calls[1].options.sessionId, h.session(s.id).claudeSessionId);
  await h.engine.shutdown();
});

test('fleet: Agent tool + subagent children and usage → fleet.updated with depth, toolCount, context', async () => {
  const h = harness(async function* () {
    yield F.toolUse('m1', 'tA', 'Agent', { description: '[lane:x] build', subagent_type: 'opus-high', prompt: 'p' });
    yield F.toolUse('m2', 'tB', 'Agent', { description: 'nested', subagent_type: 'opus-high', prompt: 'q' }, 'tA');
    yield F.toolUse('m3', 'tC', 'Edit', { file_path: path.join(os.tmpdir(), 'x.js'), old_string: 'a', new_string: 'b' }, 'tB');
    yield { type: 'assistant', parent_tool_use_id: 'tB', message: { id: 'm4', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, cache_read_input_tokens: 99999, output_tokens: 0 } } };
    yield F.toolResult('tC', 'ok', { parent: 'tB' });
    yield F.toolResult('tB', 'nested done', { parent: 'tA' });
    yield F.toolResult('tA', 'all done');
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  await new Promise((r) => setTimeout(r, 200));
  const last = [...h.events].reverse().find((e) => e.event === 'fleet.updated');
  assert.ok(last);
  const agents = last.data.agents;
  const A = agents.find((a) => a.id === 'tA');
  const B = agents.find((a) => a.id === 'tB');
  assert.strictEqual(A.depth, 0);
  assert.strictEqual(A.description, '[lane:x] build');
  assert.strictEqual(A.subagentType, 'opus-high');
  assert.strictEqual(B.depth, 1);
  assert.strictEqual(B.parentId, 'tA');
  assert.strictEqual(B.toolCount, 1);
  assert.strictEqual(B.lastTool, 'Edit');
  assert.strictEqual(B.context.usedTokens, 100000);
  assert.strictEqual(B.context.percent, 10);
  assert.ok(agents.every((a) => a.status === 'done'));
  assert.ok(h.events.some((e) => e.event === 'files.changed'));
  await h.engine.shutdown();
});

test('persistence: sessions.json survives a restart; update/markRead/close; commands/models', async () => {
  const userDataDir = tmp('helm-eng-');
  const h = harness(async function* () {
    for (const f of F.textTurn('m', 'ok')) yield f;
    yield F.result(0.5);
  }, { userDataDir });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'hello there' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  const cmds = await h.m['sessions.commands']({ id: s.id });
  assert.deepStrictEqual(cmds, [{ name: 'compact', description: 'Compact', argumentHint: '' }]);
  const up = await h.m['sessions.update']({ id: s.id, title: 'Renamed', pinned: true, model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' });
  assert.strictEqual(up.title, 'Renamed');
  const st = h.sdk.calls[0].state;
  assert.strictEqual(st.model, 'claude-opus-5-5');
  assert.strictEqual(st.mode, 'plan');
  assert.strictEqual(st.flags.effortLevel, 'high');
  assert.ok(h.session(s.id).unread > 0);
  await h.m['sessions.markRead']({ id: s.id });
  assert.strictEqual(h.session(s.id).unread, 0);
  await h.m['sessions.close']({ id: s.id });
  assert.strictEqual(h.session(s.id).status, 'closed');
  await h.engine.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'sessions.json'), 'utf8'));
  assert.strictEqual(saved.sessions[0].title, 'Renamed');

  const h2 = harness(async function* () { yield F.result(0.6); }, { userDataDir });
  const snap = h2.engine.snapshot();
  assert.strictEqual(snap.sessions.length, 1);
  assert.strictEqual(snap.sessions[0].title, 'Renamed');
  assert.strictEqual(snap.sessions[0].costUsd, 0.5);
  assert.strictEqual(snap.sessions[0].pinned, true);
  assert.ok('usage' in snap);
  // Not live → commands come from a probe CLI (initializationResult), models too.
  const c2 = await h2.m['sessions.commands']({ id: s.id });
  assert.deepStrictEqual(c2.map((c) => c.name), ['probe-cmd']);
  assert.ok(h2.sdk.calls[0].options.persistSession === false);
  assert.ok(h2.sdk.calls[0].state.closed, 'probe closed');
  const models = await h2.m['sessions.models']({});
  assert.ok(models.length >= 1);
  await assert.rejects(h2.m['sessions.send']({ id: 'nope', text: 'x' }), /Unknown session/);
  await h2.engine.shutdown();
});

test('files.changes from Edit/Write items (non-git cwd) and checkpoints/rewind', async () => {
  const cwd = tmp('helm-cwd-');
  const fa = path.join(cwd, 'a.js');
  const fb = path.join(cwd, 'b.txt');
  fs.writeFileSync(fa, 'x\ny\n');
  fs.writeFileSync(fb, '1\n2\n3\n');
  const h = harness(async function* () {
    yield F.toolUse('m1', 'e1', 'Edit', { file_path: fa, old_string: 'a\nb', new_string: 'a\nc\nd' });
    yield F.toolResult('e1', 'The file has been updated successfully.');
    yield F.toolUse('m2', 'w1', 'Write', { file_path: fb, content: '1\n2\n3\n' });
    yield F.toolResult('w1', 'File created successfully at: ' + fb);
    yield F.toolUse('m3', 'e2', 'Edit', { file_path: fa, old_string: 'zz', new_string: 'q' });
    yield F.toolResult('e2', 'String not found', { isError: true });
    yield F.result(0);
  }, { cwd });
  const s = await h.m['sessions.create']({ cwd });
  await h.m['sessions.send']({ id: s.id, text: 'edit things' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  const ch = await h.m['files.changes']({ sessionId: s.id });
  const a = ch.find((c) => c.path === fa);
  const b = ch.find((c) => c.path === fb);
  assert.deepStrictEqual([a.status, a.additions, a.deletions, a.touchedBy], ['M', 2, 1, ['e1']]);
  assert.deepStrictEqual([b.status, b.additions, b.rel], ['A', 3, 'b.txt']);
  const cps = await h.m['sessions.checkpoints']({ id: s.id });
  assert.strictEqual(cps.length, 1);
  assert.deepStrictEqual(cps[0].files.sort(), [fa, fb].sort());
  await h.m['sessions.rewind']({ id: s.id, checkpointId: cps[0].id, files: true, conversation: false });
  const it = await h.items(s.id);
  assert.ok(/Rewound to before/.test(it[it.length - 1].text));
  await h.engine.shutdown();
});

test('usage: statusline fallback, then sdk rate_limit_event wins; unknown → nulls with reason', async () => {
  const sl = tmp('helm-sl-');
  const h0 = harness(async function* () {}, { statuslineDir: sl });
  const u0 = await h0.m['usage.get']({});
  assert.strictEqual(u0.fiveHour, null);
  assert.strictEqual(u0.source, null);
  assert.ok(u0.reason);
  await h0.engine.shutdown();

  const resets = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(sl, 'a.json'), JSON.stringify({ receivedAt: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: 12, resets_at: resets }, seven_day: { used_percentage: 3, resets_at: resets + 86400 } } }));
  const h = harness(async function* () {
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: resets }, seven_day: { utilization: 0.04, resetsAt: resets + 86400 } } } };
    yield F.result(0);
  }, { statuslineDir: sl });
  const u1 = await h.m['usage.get']({});
  assert.strictEqual(u1.source, 'statusline');
  assert.deepStrictEqual(u1.fiveHour, { percent: 12, resetsAt: resets * 1000 });
  assert.strictEqual(u1.week.percent, 3);
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'x' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  const u2 = await h.m['usage.get']({});
  assert.strictEqual(u2.source, 'sdk');
  assert.strictEqual(u2.fiveHour.percent, 25);
  assert.ok(h.events.some((e) => e.event === 'usage.updated' && e.data.source === 'sdk'));
  await h.engine.shutdown();
});
