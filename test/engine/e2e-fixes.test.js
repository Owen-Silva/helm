'use strict';
// Regression tests for engine bugs the live end-to-end run (tools/e2e.js) exposed:
//  - a queued prompt kept its insertion slot (mid previous turn) after it was sent
//  - turn results vanished when a session was rebuilt from the transcript on disk
//  - a model switch from the picker came back as a "/model …" user bubble after a restart
//  - history.search listed scratch sessions whose cwd is in the OS temp dir
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { classifyUserText } = require('../../main/engine/normalize');
const { slugFor } = require('../../main/engine/transcript');
const { createHistoryIndex, isTempCwd } = require('../../main/engine/history');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function harness(turn, opts = {}) {
  const userDataDir = opts.userDataDir || tmp('helm-eng-');
  const cwd = opts.cwd || tmp('helm-cwd-');
  const projectsDir = opts.projectsDir || tmp('helm-proj-');
  const events = [];
  const engine = createEngine({
    userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {},
    sdk: createFakeSdk(turn), claudePath: null, projectsDir, statuslineDir: tmp('helm-sl-'),
  });
  const m = engine.methods;
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const hit = pred(); if (hit) return hit; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error('timed out waiting');
  };
  const items = async (id) => (await m['sessions.history']({ id, limit: 1000 })).items;
  const session = (id) => engine._internal.sessions.get(id).publicSession();
  return { engine, m, events, waitFor, items, session, userDataDir, cwd, projectsDir };
}

test('a queued prompt (a /command mid-turn) moves to the end of the transcript when it is sent', async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const seen = [];
  const h = harness(async function* (um) {
    seen.push(um.message.content);
    if (um.message.content === 'first') await gate;
    for (const f of F.textTurn('m-' + um.message.content, 'reply ' + um.message.content)) yield f;
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'first' });
  await h.waitFor(() => seen.length === 1);
  const q = await h.m['sessions.send']({ id: s.id, text: '/second' });
  assert.strictEqual(q.queued, true);
  const queuedTs = (await h.items(s.id)).find((i) => i.id === q.itemId).ts;
  await new Promise((r) => setTimeout(r, 5));
  open();
  await h.waitFor(() => seen.length === 2 && h.session(s.id).status === 'idle');
  const it = await h.items(s.id);
  const order = it.filter((i) => ['user', 'assistant', 'result'].includes(i.type)).map((i) => i.type + ':' + (i.text || ''));
  assert.deepStrictEqual(order, ['user:first', 'assistant:reply first', 'result:', 'user:/second', 'assistant:reply /second', 'result:']);
  const sent = it.find((i) => i.id === q.itemId);
  assert.strictEqual(sent.queued, false);
  assert.ok(sent.ts > queuedTs, 'ts becomes the send time');
  const patch = h.events.find((e) => e.event === 'session.itemUpdate' && e.data.itemId === q.itemId && e.data.patch.queued === false);
  assert.ok(patch && typeof patch.data.patch.ts === 'number', 'clients get { queued: false, ts } to move it');
  await h.engine.shutdown();
});

test('turn results survive a restart (sidecar anchored to the transcript)', async () => {
  const userDataDir = tmp('helm-eng-');
  const projectsDir = tmp('helm-proj-');
  const cwd = tmp('helm-cwd-');
  const h = harness(async function* () {
    for (const f of F.textTurn('m1', 'hello')) yield f;
    yield F.result(0.02);
  }, { userDataDir, projectsDir, cwd });
  const s = await h.m['sessions.create']({ cwd });
  await h.m['sessions.send']({ id: s.id, text: 'hi' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.session(s.id).claudeSessionId);
  const live = await h.items(s.id);
  const userItem = live.find((i) => i.type === 'user');
  const csid = h.session(s.id).claudeSessionId;
  await h.engine.shutdown();
  assert.ok(fs.existsSync(path.join(userDataDir, 'results', `${s.id}.jsonl`)), 'result recorded');

  // what Claude Code writes for that turn (no result line)
  const dir = path.join(projectsDir, slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${csid}.jsonl`), [
    { type: 'user', uuid: userItem.uuid, parentUuid: null, isSidechain: false, message: { role: 'user', content: 'hi' }, timestamp: ts, cwd, sessionId: csid },
    { type: 'assistant', uuid: 'u-m1', parentUuid: userItem.uuid, isSidechain: false, message: { id: 'm1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: ts, cwd, sessionId: csid },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const h2 = harness(async function* () {}, { userDataDir, projectsDir, cwd });
  const back = await h2.items(s.id);
  assert.deepStrictEqual(back.map((i) => i.type), ['user', 'assistant', 'result']);
  const r = back[2];
  assert.strictEqual(r.costUsd, 0.02);
  assert.strictEqual(r.durationMs, 1234);
  assert.ok(r.usage && r.usage.output === 5);
  assert.strictEqual(new Set(back.map((i) => i.id)).size, 3, 'ids stay unique');
  await h2.engine.shutdown();
});

test('model switch: no "/model" user bubble from the transcript; a live switch adds an info item', async () => {
  const cmd = '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-haiku-4-5-20251001</command-args>';
  assert.strictEqual(classifyUserText(cmd).kind, 'skip');
  assert.deepStrictEqual(classifyUserText('<local-command-stdout>Set model to `x`</local-command-stdout>'), { kind: 'info', text: 'Set model to `x`' });
  assert.strictEqual(classifyUserText('<command-name>/compact</command-name><command-args></command-args>').text, '/compact', 'other commands still show');

  const h = harness(async function* () {
    for (const f of F.textTurn('m1', 'ok')) yield f;
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'hi' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  await h.m['sessions.update']({ id: s.id, model: 'claude-haiku-4-5-20251001' });
  const it = await h.items(s.id);
  assert.ok(it.some((i) => i.type === 'system' && i.subtype === 'info' && /Set model to claude-haiku-4-5-20251001/.test(i.text)));
  await h.engine.shutdown();
});

test('history.search leaves out temp-dir sessions unless includeTemp', async () => {
  const fakeTemp = path.join('C:\\', 'FakeTemp');
  assert.strictEqual(isTempCwd(path.join(fakeTemp, 'helm-e2e-1'), fakeTemp), true);
  assert.strictEqual(isTempCwd(fakeTemp, fakeTemp), true);
  assert.strictEqual(isTempCwd(fakeTemp + '2\\x', fakeTemp), false, 'a sibling with the same prefix is not temp');
  assert.strictEqual(isTempCwd(null, fakeTemp), false);
  if (process.platform === 'win32') assert.strictEqual(isTempCwd(path.join(fakeTemp.toUpperCase(), 'x'), fakeTemp), true);

  const root = tmp('helm-hist-');
  const projects = path.join(root, 'projects');
  const write = (cwd, id, text) => {
    const dir = path.join(projects, slugFor(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u' + id, parentUuid: null, isSidechain: false, message: { role: 'user', content: text }, timestamp: ts, cwd, sessionId: id }) + '\n');
  };
  write('C:\\Users\\tester\\proj', 'real-1', 'PELICAN real work');
  write(path.join(fakeTemp, 'helm-e2e-9'), 'temp-1', 'PELICAN scratch run');
  const idx = createHistoryIndex({ projectsDir: projects, cacheFile: null, tempDir: fakeTemp });
  const plain = await idx.search({ q: 'pelican' });
  assert.deepStrictEqual(plain.map((e) => e.claudeSessionId), ['real-1']);
  const all = await idx.search({ q: 'pelican', includeTemp: true });
  assert.deepStrictEqual(all.map((e) => e.claudeSessionId).sort(), ['real-1', 'temp-1']);
  const recent = await idx.search({ q: '' });
  assert.ok(!recent.some((e) => e.claudeSessionId === 'temp-1'), 'empty query too');
});

test('a finished Agent shows its report (not the hand-back wrapper) and the CLI final tool count', async () => {
  const wrapped = '[Subagent hand-back] The text below is the final report of a subagent...\n    sub-agent-ok';
  const h = harness(async function* () {
    yield F.toolUse('m1', 'tA', 'Agent', { description: 'echo', subagent_type: 'general-purpose', prompt: 'p' });
    yield F.toolUse('m2', 'tB', 'Bash', { command: 'echo sub-agent-ok' }, 'tA');
    // in-flight progress can count ahead of the real number
    yield { type: 'system', subtype: 'task_progress', tool_use_id: 'tA', task_id: 'k1', usage: { tool_uses: 2, total_tokens: 100 }, last_tool_name: 'Bash' };
    yield F.toolResult('tB', 'sub-agent-ok', { parent: 'tA' });
    yield F.toolResult('tA', [{ type: 'text', text: wrapped }], { structured: { status: 'completed', totalToolUseCount: 1, totalTokens: 28666, content: [{ type: 'text', text: 'sub-agent-ok' }] } });
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  await new Promise((r) => setTimeout(r, 200));
  const it = await h.items(s.id);
  const ag = it.find((i) => i.type === 'tool' && i.name === 'Agent');
  assert.strictEqual(ag.result, 'sub-agent-ok');
  const last = [...h.events].reverse().find((e) => e.event === 'fleet.updated');
  const A = last.data.agents.find((a) => a.id === 'tA');
  assert.strictEqual(A.toolCount, 1);
  assert.strictEqual(A.status, 'done');
  await h.engine.shutdown();
});

test('history rebuild keeps a subagent\'s text (not its prompt) as children of the Agent item', async () => {
  const { loadTranscript } = require('../../main/engine/transcript');
  const dir = tmp('helm-sub-');
  const main = path.join(dir, 'S1.jsonl');
  const ts = new Date().toISOString();
  const L = (o) => JSON.stringify({ timestamp: ts, isSidechain: false, ...o });
  fs.writeFileSync(main, [
    L({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }),
    L({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tA', name: 'Agent', input: { prompt: 'do it', subagent_type: 'general-purpose' } }] } }),
    L({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'wrapped' }] }, toolUseResult: { content: [{ type: 'text', text: 'sub-agent-ok' }], totalToolUseCount: 1 } }),
  ].join('\n') + '\n');
  const sub = path.join(dir, 'S1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'tA' }));
  const S = (o) => JSON.stringify({ timestamp: ts, isSidechain: true, ...o });
  fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), [
    S({ type: 'user', uuid: 's0', message: { role: 'user', content: 'do it' } }),
    S({ type: 'assistant', uuid: 's1', message: { id: 'sm1', content: [{ type: 'tool_use', id: 'tB', name: 'Bash', input: { command: 'echo sub-agent-ok' } }] } }),
    S({ type: 'user', uuid: 's2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tB', content: 'sub-agent-ok' }] } }),
    S({ type: 'assistant', uuid: 's3', message: { id: 'sm2', content: [{ type: 'text', text: 'sub-agent-ok' }] } }),
  ].join('\n') + '\n');
  const { items } = loadTranscript(main);
  const kids = items.filter((i) => i.parentToolUseId === 'tA');
  assert.deepStrictEqual(kids.map((i) => i.type + ':' + (i.name || i.text)), ['tool:Bash', 'assistant:sub-agent-ok']);
  assert.ok(!items.some((i) => i.type === 'user' && i.text === 'do it'), 'the subagent prompt is not a user bubble');
  assert.strictEqual(items.find((i) => i.name === 'Agent').result, 'sub-agent-ok', 'report from toolUseResult in history too');
});
