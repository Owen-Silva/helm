'use strict';
// Normalizer tests: real (anonymised) SDK frames + transcript lines → protocol items.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Normalizer, classifyUserText, toolResultValue } = require('../../main/engine/normalize');
const { loadTranscript, makeStore, slugFor } = require('../../main/engine/transcript');

const FIX = path.join(__dirname, 'fixtures');
const lines = (f) => fs.readFileSync(path.join(FIX, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function recorder() {
  const store = makeStore();
  const events = [];
  const wrapped = {
    add(it) { store.add(it); events.push(['add', it.id, it.type]); },
    patch(id, patch, appendText) { store.patch(id, patch, appendText); events.push(['patch', id, patch, appendText]); },
    get: store.get,
  };
  let n = 0;
  return { store, events, wrapped, newId: () => 'x' + ++n };
}

test('live SDK stream (captured from claude.exe 2.1.294): AskUserQuestion turn + text turn', () => {
  const r = recorder();
  const hooks = { inits: 0, results: [], rate: [] };
  const norm = new Normalizer({
    store: r.wrapped,
    newId: r.newId,
    hooks: {
      onInit: () => hooks.inits++,
      onResult: (m) => { hooks.results.push(m.total_cost_usd); return m.total_cost_usd; },
      onRateLimit: (i) => hooks.rate.push(i),
    },
  });
  for (const m of lines('sdk-stream-ask.jsonl')) norm.handleSdk(m);
  const items = r.store.items;
  const types = items.map((i) => i.type);
  // One init item even though the CLI sends init once per turn.
  assert.strictEqual(types.filter((t) => t === 'system').length, 1);
  assert.strictEqual(hooks.inits, 2);
  assert.ok(items[0].text.includes('Claude Code 2.1.294'));
  const tool = items.find((i) => i.type === 'tool');
  assert.strictEqual(tool.name, 'AskUserQuestion');
  assert.strictEqual(tool.status, 'done');
  assert.ok(Array.isArray(tool.input.questions) && tool.input.questions.length === 1, 'final input replaces the empty streamed input');
  assert.match(tool.result, /Blue/);
  assert.deepStrictEqual(Object.values(tool.answers), ['Blue']);
  const thinking = items.find((i) => i.type === 'thinking');
  assert.strictEqual(thinking.streaming, false);
  const texts = items.filter((i) => i.type === 'assistant').map((i) => i.text);
  assert.deepStrictEqual(texts, ['Blue', 'ok']);
  assert.ok(items.filter((i) => i.type === 'assistant').every((i) => i.streaming === false));
  assert.strictEqual(types.filter((t) => t === 'result').length, 2);
  assert.strictEqual(hooks.rate.length, 1);
  // Streaming text arrived as appendText patches on the same item that the final message closed.
  const okItem = items.find((i) => i.type === 'assistant' && i.text === 'ok');
  assert.ok(r.events.some((e) => e[0] === 'patch' && e[1] === okItem.id && e[3]), 'appendText deltas');
});

test('transcript fixture (anonymised real lines) parses without orphans or crashes', () => {
  const { items, meta } = loadTranscript(path.join(FIX, 'transcript-anon.jsonl'), { includeSubagents: false });
  assert.ok(items.length > 5);
  for (const it of items) {
    assert.ok(it.id && it.type && typeof it.ts === 'number', 'id/type/ts on every item');
    assert.ok(['user', 'assistant', 'thinking', 'tool', 'system', 'result', 'request'].includes(it.type));
  }
  const tools = items.filter((i) => i.type === 'tool');
  assert.ok(tools.length >= 3);
  assert.ok(tools.some((t) => t.status === 'done' && t.result), 'tool_result landed on its tool item');
  assert.ok(items.some((i) => i.type === 'user' && i.uuid), 'user prompts keep their uuid (checkpoint id)');
  assert.ok(items.some((i) => i.type === 'result'), 'turn_duration → result item');
  assert.ok(meta.cwd);
  assert.ok(meta.aiTitle);
});

test('transcript: thinking, commands, interrupts, compaction, subagent children', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-tr-'));
  const sid = '11111111-2222-4333-8444-555555555555';
  const ts = (s) => `2026-10-01T10:00:${String(s).padStart(2, '0')}.000Z`;
  const L = [
    { type: 'user', uuid: 'p1', timestamp: ts(1), cwd: 'C:\\demo', message: { role: 'user', content: '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>high</command-args>' } },
    { type: 'user', uuid: 'm1', isMeta: true, timestamp: ts(2), message: { role: 'user', content: [{ type: 'text', text: 'caveat' }] } },
    { type: 'user', uuid: 'p2', timestamp: ts(3), message: { role: 'user', content: [{ type: 'text', text: 'Spawn an agent please' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } },
    { type: 'assistant', uuid: 'a1', timestamp: ts(4), message: { id: 'msg1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'plan it', signature: 's' }], usage: { input_tokens: 5, cache_read_input_tokens: 50000, output_tokens: 3 } } },
    { type: 'assistant', uuid: 'a2', timestamp: ts(5), message: { id: 'msg1', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: '[lane:x] do it', subagent_type: 'opus-high', prompt: 'go' } }] } },
    { type: 'user', uuid: 'r1', timestamp: ts(9), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'Agent done' }] }] } },
    { type: 'assistant', uuid: 'a3', timestamp: ts(10), message: { id: 'msg2', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'sleep 99' } }] } },
    { type: 'user', uuid: 'r2', timestamp: ts(11), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: ts(12), compactMetadata: { trigger: 'manual', preTokens: 400000, postTokens: 10000 } },
    { type: 'user', uuid: 'cs', isCompactSummary: true, timestamp: ts(13), message: { role: 'user', content: 'summary...' } },
    { type: 'user', uuid: 'p3', timestamp: ts(14), message: { role: 'user', content: '<local-command-stdout>Total cost: $1.00</local-command-stdout>' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 5000, timestamp: ts(15) },
    { type: 'custom-title', customTitle: 'Agent test' },
  ];
  const projDir = path.join(dir, slugFor('C:\\demo'));
  fs.mkdirSync(path.join(projDir, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projDir, sid + '.jsonl'), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const sub = [
    { type: 'user', isSidechain: true, uuid: 's0', timestamp: ts(5), message: { role: 'user', content: 'go' } },
    { type: 'assistant', isSidechain: true, uuid: 's1', timestamp: ts(6), message: { id: 'smsg', content: [{ type: 'text', text: 'working' }] } },
    { type: 'assistant', isSidechain: true, uuid: 's2', timestamp: ts(6), message: { id: 'smsg', content: [{ type: 'tool_use', id: 'toolu_C', name: 'Edit', input: { file_path: 'C:\\demo\\a.js', old_string: 'a', new_string: 'b' } }] } },
    { type: 'user', isSidechain: true, uuid: 's3', timestamp: ts(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_C', content: 'ok' }] } },
  ];
  fs.writeFileSync(path.join(projDir, sid, 'subagents', 'agent-abc.jsonl'), sub.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(projDir, sid, 'subagents', 'agent-abc.meta.json'), JSON.stringify({ toolUseId: 'toolu_A', agentType: 'opus-high', description: 'x' }));

  const { items, meta } = loadTranscript(path.join(projDir, sid + '.jsonl'));
  const users = items.filter((i) => i.type === 'user');
  assert.deepStrictEqual(users.map((u) => u.text), ['/review high', 'Spawn an agent please']);
  assert.strictEqual(users[1].attachments[0].kind, 'image');
  assert.ok(users[1].attachments[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.ok(items.find((i) => i.type === 'thinking' && i.text === 'plan it'));
  const agentIdx = items.findIndex((i) => i.toolUseId === 'toolu_A');
  // The live stream (claude.exe 2.1.294, seen in tools/e2e.js) carries a subagent's text as
  // children of its Agent card, so the rebuilt history does too; its prompt is not a user item.
  const kidText = items[agentIdx + 1];
  assert.strictEqual(kidText.type, 'assistant');
  assert.strictEqual(kidText.text, 'working');
  assert.strictEqual(kidText.parentToolUseId, 'toolu_A');
  assert.strictEqual(items[agentIdx + 2].toolUseId, 'toolu_C', 'subagent child placed right after its Agent card');
  assert.strictEqual(items[agentIdx + 2].parentToolUseId, 'toolu_A');
  assert.strictEqual(items[agentIdx + 2].status, 'done');
  assert.ok(!items.some((i) => i.type === 'user' && i.text === 'go' && i.parentToolUseId), 'the subagent prompt is not a user item');
  assert.strictEqual(items.find((i) => i.toolUseId === 'toolu_B').status, 'error', 'interrupted tool is closed');
  assert.ok(items.some((i) => i.type === 'system' && i.subtype === 'interrupted'));
  assert.ok(items.some((i) => i.type === 'system' && i.subtype === 'compact' && /400k → 10k/.test(i.text)));
  assert.ok(items.some((i) => i.type === 'system' && i.subtype === 'info' && i.text === 'Total cost: $1.00'));
  assert.ok(!items.some((i) => i.type === 'user' && /summary|caveat/.test(i.text)), 'meta + compact summary skipped');
  assert.strictEqual(items.filter((i) => i.type === 'result').length, 1);
  assert.strictEqual(meta.title, 'Agent test');
  assert.strictEqual(meta.lastUsage.cache_read_input_tokens, 50000);
});

test('classifyUserText + toolResultValue edge cases', () => {
  assert.deepStrictEqual(classifyUserText('<system-reminder>x</system-reminder>'), { kind: 'skip' });
  assert.strictEqual(classifyUserText('<task-notification><status>completed</status><summary>Agent "x" done</summary></task-notification>').kind, 'info');
  assert.strictEqual(classifyUserText('<div>literal html prompt</div>').kind, 'prompt');
  assert.strictEqual(classifyUserText('! ls').kind, 'prompt');
  const v = toolResultValue([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } }]);
  assert.deepStrictEqual(v, { text: 'a', images: ['data:image/png;base64,QQ=='] });
  assert.ok(toolResultValue('x'.repeat(250_000)).length < 210_000, 'huge results are capped');
});

test('subagent frames (parent_tool_use_id) become children; denied results map to denied', () => {
  const r = recorder();
  const norm = new Normalizer({ store: r.wrapped, newId: r.newId });
  norm.handleSdk({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'tA', name: 'Agent', input: { description: 'd' } }] } });
  norm.handleSdk({ type: 'assistant', parent_tool_use_id: 'tA', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tB', name: 'Bash', input: { command: 'rm x' } }] } });
  norm.markDenied('tB');
  norm.handleSdk({ type: 'user', parent_tool_use_id: 'tA', message: { content: [{ type: 'tool_result', tool_use_id: 'tB', is_error: true, content: 'denied' }] } });
  const b = r.store.items.find((i) => i.toolUseId === 'tB');
  assert.strictEqual(b.parentToolUseId, 'tA');
  assert.strictEqual(b.status, 'denied');
});
