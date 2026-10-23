'use strict';
// agents.transcript: Agent.id (tool_use id) → subagents/agent-<hex>.jsonl, paged like sessions.history.
// Fixture lines copy the SHAPES of Claude Code 2.1.29x subagent transcripts (no real content).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { agentTranscript, resolveAgentFile } = require('../../main/engine/agent-transcript');

const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const CWD = 'C:\\Users\\tester\\proj';
let seq = 0;

function line(agentId, type, s, extra) {
  return { parentUuid: null, isSidechain: true, agentId, type, uuid: `${agentId}-${++seq}`, timestamp: iso(s), cwd: CWD, sessionId: 'x', version: '2.1.294', ...extra };
}
const prompt = (a, text, s = 0) => line(a, 'user', s, { promptId: 'p1', message: { role: 'user', content: text } });
const text = (a, mid, t, s) => line(a, 'assistant', s, { requestId: 'r', message: { id: mid, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: t }], usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 40 } } });
const toolUse = (a, mid, id, name, input, s) => line(a, 'assistant', s, { message: { id: mid, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (a, id, content, s, extra = {}) => line(a, 'user', s, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult: extra.structured || {} });
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-agent-tx-'));
  const projects = path.join(root, 'projects');
  const sid = `11111111-2222-3333-4444-${String(++seq).padStart(12, '0')}`;
  const slug = path.join(projects, 'C--Users-tester-proj');
  const sub = path.join(slug, sid, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(slug, `${sid}.jsonl`), jsonl([{ type: 'user', isSidechain: false, message: { role: 'user', content: 'go' }, uuid: 'm1', timestamp: iso(0), cwd: CWD }]));

  // aaa111: the agent under test (meta names its tool_use); it launches nested agent bbb222.
  fs.writeFileSync(path.join(sub, 'agent-aaa111aaa111.meta.json'), JSON.stringify({ agentType: 'opus-high', description: '[lane:one] list files', toolUseId: 'toolu_A', spawnDepth: 1 }));
  fs.writeFileSync(path.join(sub, 'agent-aaa111aaa111.jsonl'), jsonl([
    prompt('aaa111aaa111', 'List the files in this folder.'),
    text('aaa111aaa111', 'msg_1', 'Looking at the folder.', 1),
    toolUse('aaa111aaa111', 'msg_1', 'toolu_bash1', 'Bash', { command: 'ls', description: 'List files' }, 2),
    toolResult('aaa111aaa111', 'toolu_bash1', 'a.txt\nb.txt', 3),
    toolUse('aaa111aaa111', 'msg_2', 'toolu_N', 'Agent', { description: '[lane:two] count lines', prompt: 'Count lines.', subagent_type: 'general-purpose' }, 4),
  ]));
  fs.writeFileSync(path.join(sub, 'agent-bbb222bbb222.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: '[lane:two] count lines', toolUseId: 'toolu_N', parentAgentId: 'aaa111aaa111', spawnDepth: 2 }));
  fs.writeFileSync(path.join(sub, 'agent-bbb222bbb222.jsonl'), jsonl([
    prompt('bbb222bbb222', 'Count lines.', 5),
    toolUse('bbb222bbb222', 'msg_n1', 'toolu_wc', 'Bash', { command: 'wc -l a.txt' }, 6),
  ]));
  // ccc333: no meta at all (prompt match); ddd444: no meta (agentId hint from the tool result).
  fs.writeFileSync(path.join(sub, 'agent-ccc333ccc333.jsonl'), jsonl([prompt('ccc333ccc333', 'Unique prompt for C.'), text('ccc333ccc333', 'msg_c', 'C here.', 1)]));
  fs.writeFileSync(path.join(sub, 'agent-ddd444ddd444.jsonl'), jsonl([prompt('ddd444ddd444', 'Prompt D.'), text('ddd444ddd444', 'msg_d', 'D here.', 1)]));
  const es = { s: { id: 's_t', claudeSessionId: sid, cwd: CWD }, items: [], fleet: null };
  return { root, projects, sid, sub, es };
}

test('meta.json toolUseId maps Agent.id to its transcript; prompt is separate; nested agent steps sit under its card', () => {
  const f = makeFixture();
  const r = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_A' }, f.projects);
  assert.strictEqual(r.via, 'meta');
  assert.ok(r.file.endsWith('agent-aaa111aaa111.jsonl'));
  assert.strictEqual(r.prompt, 'List the files in this folder.');
  assert.ok(!r.items.some((i) => i.type === 'user'), 'the prompt is not repeated as a user item');
  const kinds = r.items.map((i) => (i.type === 'tool' ? `${i.type}:${i.name}` : i.type));
  assert.deepStrictEqual(kinds, ['assistant', 'tool:Bash', 'tool:Agent', 'tool:Bash']);
  const bash = r.items[1];
  assert.strictEqual(bash.status, 'done');
  assert.strictEqual(bash.result, 'a.txt\nb.txt');
  assert.deepStrictEqual(bash.input, { command: 'ls', description: 'List files' });
  assert.ok(!bash.parentToolUseId, "the agent's own steps are top-level in its view");
  const nestedStep = r.items[3];
  assert.strictEqual(nestedStep.parentToolUseId, 'toolu_N');
  assert.strictEqual(r.items[2].status, 'running');
  assert.strictEqual(r.agent.description, '[lane:one] list files');
  assert.strictEqual(r.agent.subagentType, 'opus-high');
  assert.strictEqual(r.agent.model, 'claude-haiku-5-5');
  assert.strictEqual(r.agent.transcriptId, 'aaa111aaa111');
  assert.ok(r.agent.context && r.agent.context.usedTokens === 5050);
  assert.strictEqual(r.hasMore, false);
  assert.ok(typeof r.rev === 'string' && r.rev);
});

test('ids are stable across reads, and the live fleet agent wins for the header', () => {
  const f = makeFixture();
  const a = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_A' }, f.projects);
  const live = { id: 'toolu_A', sessionId: 's_t', status: 'running', description: '[lane:one] list files', subagentType: 'opus-high', context: { usedTokens: 1, windowTokens: 2, percent: 50 }, startedAt: T0 };
  const es = { ...f.es, fleet: { agents: new Map([['toolu_A', live]]), taskToTool: new Map() } };
  const b = agentTranscript(es, { sessionId: 's_t', agentId: 'toolu_A' }, f.projects);
  assert.deepStrictEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
  assert.strictEqual(b.agent.status, 'running');
  assert.strictEqual(b.agent.context.percent, 50);
});

test('agentId hint from the Agent tool result maps a transcript that has no meta', () => {
  const f = makeFixture();
  f.es.items = [{ id: 'x', type: 'tool', toolUseId: 'toolu_D', name: 'Agent', status: 'done', input: { prompt: 'something else' },
    result: 'Async agent launched successfully.\nagentId: ddd444ddd444 (internal ID)' }];
  const r = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_D' }, f.projects);
  assert.strictEqual(r.via, 'agentId');
  assert.deepStrictEqual(r.items.map((i) => i.text), ['D here.']);
});

test('SDK task_id seen by the fleet is an agentId hint too', () => {
  const f = makeFixture();
  f.es.fleet = { agents: new Map(), taskToTool: new Map([['ddd444ddd444', 'toolu_T']]) };
  const r = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_T' }, f.projects);
  assert.strictEqual(r.via, 'agentId');
});

test('a hint never steals a transcript whose meta names another tool_use', () => {
  const f = makeFixture();
  f.es.items = [{ id: 'x', type: 'tool', toolUseId: 'toolu_Z', name: 'Agent', status: 'done', input: {}, result: 'agentId: aaa111aaa111' }];
  const r = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_Z' }, f.projects);
  assert.strictEqual(r.file, null);
  assert.match(r.missing, /No transcript/);
});

test('first-prompt match maps a transcript with no meta and no hint', () => {
  const f = makeFixture();
  f.es.items = [{ id: 'x', type: 'tool', toolUseId: 'toolu_C', name: 'Agent', status: 'running', input: { prompt: 'Unique prompt for C.' }, result: '' }];
  const r = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_C' }, f.projects);
  assert.strictEqual(r.via, 'prompt');
  assert.strictEqual(r.agent.status, 'running');
  assert.deepStrictEqual(r.items.map((i) => i.text), ['C here.']);
  assert.strictEqual(resolveAgentFile(f.sub, 'toolu_C', {}).file, null, 'without the prompt there is nothing to match');
});

test('unmatched agent and missing transcript say why instead of returning a silent empty list', () => {
  const f = makeFixture();
  const a = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_unknown' }, f.projects);
  assert.deepStrictEqual(a.items, []);
  assert.strictEqual(a.file, null);
  assert.match(a.missing, /No transcript in .*subagents matches this agent/);
  const b = agentTranscript({ s: { id: 's2', claudeSessionId: null, cwd: CWD }, items: [] }, { agentId: 'toolu_A' }, f.projects);
  assert.match(b.missing, /not started Claude Code/);
  const c = agentTranscript({ s: { id: 's3', claudeSessionId: '99999999-0000-0000-0000-000000000000', cwd: CWD }, items: [] }, { agentId: 'toolu_A' }, f.projects);
  assert.match(c.missing, /No Claude Code transcript/);
});

test('bad params are rejected', () => {
  const f = makeFixture();
  for (const p of [{}, { agentId: '../x' }, { agentId: 5 }, { agentId: 'toolu_A', before: 7 }, { agentId: 'toolu_A', rev: {} }]) {
    assert.throws(() => agentTranscript(f.es, p, f.projects), (e) => e.code === 'bad_params');
  }
});

test('live poll: unchanged rev is cheap; appended lines and results show up; nested growth changes rev', () => {
  const f = makeFixture();
  const file = path.join(f.sub, 'agent-aaa111aaa111.jsonl');
  const r1 = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_A' }, f.projects);
  const same = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_A', rev: r1.rev }, f.projects);
  assert.strictEqual(same.unchanged, true);
  assert.strictEqual(same.rev, r1.rev);
  assert.ok(same.agent && same.agent.id === 'toolu_A');

  // The nested agent writes a step while its parent waits: the parent's rev must change.
  fs.appendFileSync(path.join(f.sub, 'agent-bbb222bbb222.jsonl'), jsonl([toolResult('bbb222bbb222', 'toolu_wc', '2 a.txt', 7)]));
  const r2 = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_A', rev: r1.rev }, f.projects);
  assert.ok(!r2.unchanged);
  assert.notStrictEqual(r2.rev, r1.rev);
  const wc = r2.items.find((i) => i.toolUseId === 'toolu_wc');
  assert.strictEqual(wc.status, 'done');
  assert.deepStrictEqual(r2.items.map((i) => i.id), r1.items.map((i) => i.id), 'ids unchanged by the re-read');

  // The agent itself finishes the nested call and replies.
  fs.appendFileSync(file, jsonl([
    toolResult('aaa111aaa111', 'toolu_N', [{ type: 'text', text: 'agentId: bbb222bbb222' }], 8, { structured: { status: 'completed', content: [{ type: 'text', text: '2 lines.' }] } }),
    text('aaa111aaa111', 'msg_3', 'done', 9),
  ]));
  const r3 = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_A', rev: r2.rev }, f.projects);
  assert.strictEqual(r3.items.find((i) => i.toolUseId === 'toolu_N').status, 'done');
  assert.strictEqual(r3.items.find((i) => i.toolUseId === 'toolu_N').result, '2 lines.');
  assert.strictEqual(r3.items[r3.items.length - 1].text, 'done');
  assert.deepStrictEqual(r3.items.slice(0, r1.items.length).map((i) => i.id), r1.items.map((i) => i.id));
});

test('tail-first paging with before, like sessions.history', () => {
  const f = makeFixture();
  const lines = [prompt('eee555eee555', 'Many steps.')];
  for (let k = 0; k < 30; k++) lines.push(text('eee555eee555', `msg_${k}`, `step ${k}`, k + 1));
  fs.writeFileSync(path.join(f.sub, 'agent-eee555eee555.jsonl'), jsonl(lines));
  fs.writeFileSync(path.join(f.sub, 'agent-eee555eee555.meta.json'), JSON.stringify({ toolUseId: 'toolu_E', agentType: 'x', description: 'many' }));
  const a = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_E', limit: 10 }, f.projects);
  assert.deepStrictEqual(a.items.map((i) => i.text), Array.from({ length: 10 }, (_, k) => `step ${20 + k}`));
  assert.strictEqual(a.hasMore, true);
  const b = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_E', limit: 10, before: a.items[0].id }, f.projects);
  assert.deepStrictEqual(b.items.map((i) => i.text), Array.from({ length: 10 }, (_, k) => `step ${10 + k}`));
  const c = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_E', limit: 10, before: b.items[0].id }, f.projects);
  assert.deepStrictEqual(c.items.map((i) => i.text), Array.from({ length: 10 }, (_, k) => `step ${k}`));
  assert.strictEqual(c.hasMore, false);
  assert.strictEqual(c.prompt, 'Many steps.');
});

test('a long live agent: polls after the newest window passes 512 KB parse only the appended lines', () => {
  const f = makeFixture();
  const file = path.join(f.sub, 'agent-fff666fff666.jsonl');
  fs.writeFileSync(path.join(f.sub, 'agent-fff666fff666.meta.json'), JSON.stringify({ toolUseId: 'toolu_F' }));
  const big = 'x'.repeat(40 * 1024);
  const lines = [prompt('fff666fff666', 'Big.')];
  for (let k = 0; k < 16; k++) {
    lines.push(toolUse('fff666fff666', `m${k}`, `toolu_r${k}`, 'Read', { file_path: `f${k}` }, k));
    lines.push(toolResult('fff666fff666', `toolu_r${k}`, big, k));
  }
  fs.writeFileSync(file, jsonl(lines));
  const r1 = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_F', limit: 100 }, f.projects);
  assert.strictEqual(r1.items.length, 16);
  // Grow the newest window past 512 KB with live appends, ending on a tool still running.
  const more = [];
  for (let k = 16; k < 30; k++) {
    more.push(toolUse('fff666fff666', `m${k}`, `toolu_r${k}`, 'Read', { file_path: `f${k}` }, k));
    more.push(toolResult('fff666fff666', `toolu_r${k}`, big, k));
  }
  more.push(toolUse('fff666fff666', 'mz', 'toolu_last', 'Bash', { command: 'echo' }, 40));
  fs.appendFileSync(file, jsonl(more));
  const r2 = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_F', limit: 100, rev: r1.rev }, f.projects);
  assert.strictEqual(r2.items.length, 31);
  assert.strictEqual(r2.items[30].status, 'running');
  const pager = require('../../main/engine/agent-transcript')._internal.pagers.get(file);
  // Its result lands after the split: parsed as a new window, still closing the tool.
  fs.appendFileSync(file, jsonl([toolResult('fff666fff666', 'toolu_last', 'ok', 41)]));
  const r3 = agentTranscript(f.es, { sessionId: 's_t', agentId: 'toolu_F', limit: 100, rev: r2.rev }, f.projects);
  const newest = pager.windows[pager.windows.length - 1];
  assert.ok(newest.end - newest.start < 4096, `only the appended line was parsed (window of ${newest.end - newest.start} bytes)`);
  const last = r3.items[r3.items.length - 1];
  assert.strictEqual(last.toolUseId, 'toolu_last');
  assert.strictEqual(last.status, 'done', 'a result in a later window still closes its tool');
  assert.strictEqual(last.result, 'ok');
  assert.deepStrictEqual(r3.items.map((i) => i.id), r2.items.map((i) => i.id));
});
