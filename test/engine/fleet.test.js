// Fleet lifecycle (lane fleet, 2026-10-08): agents that ended without a completion record, SendMessage
// resumes, live state surviving a rebuild, the running count, and the engine treating a session with
// running agents as busy (Session.agentsRunning, recycleClis).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Fleet, lastEventTime, endStatus } = require('../../main/engine/fleet');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const launchText = (hex, slug = 'C--work-shop', sid = 'sess-1') =>
  `Async agent launched successfully. (internal)\nagentId: ${hex} (internal ID - do not mention to user.)\n` +
  `The agent is working in the background.\noutput_file: C:\\Temp\\claude\\${slug}\\${sid}\\tasks\\${hex}.output\nDo NOT Read this file.`;

const agentItem = (id, desc, startedAt, extra = {}) => ({
  id: 'i-' + id, type: 'tool', ts: startedAt, toolUseId: id, name: 'Agent', status: 'done', startedAt, endedAt: startedAt + 30,
  input: { description: desc, subagent_type: 'opus-high', prompt: 'p', run_in_background: true }, ...extra,
});
const notif = (desc, status, ts) => ({ id: 'n-' + ts, type: 'system', subtype: 'info', ts, text: `Background task ${status}: Agent "${desc}" finished` });
const sendItem = (id, hex, ts) => ({
  id: 'i-' + id, type: 'tool', ts, toolUseId: id, name: 'SendMessage', status: 'done', startedAt: ts, endedAt: ts + 20,
  input: { to: hex, message: 'more' }, result: JSON.stringify({ success: true, message: `Resuming agent ${hex.slice(0, 7)}`, resumedAgentId: hex }),
});

function writeAgentTranscript(projects, hex, lastTs, slug = 'C--work-shop', sid = 'sess-1') {
  const dir = path.join(projects, slug, sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', timestamp: new Date(lastTs - 20 * MIN).toISOString(), message: { role: 'user', content: 'go' } },
    { type: 'assistant', timestamp: new Date(lastTs).toISOString(), message: { role: 'assistant', content: [] } },
  ];
  fs.writeFileSync(path.join(dir, `agent-${hex}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('endStatus maps task words to Agent statuses', () => {
  assert.strictEqual(endStatus('completed'), 'done');
  assert.strictEqual(endStatus('failed'), 'error');
  assert.strictEqual(endStatus('killed'), 'stopped');
});

test('lastEventTime: newest timestamp line, mtime fallback, null when missing', () => {
  const d = tmp('helm-fleet-');
  const f = path.join(d, 'a.jsonl');
  fs.writeFileSync(f, JSON.stringify({ timestamp: new Date(T0).toISOString() }) + '\n' + JSON.stringify({ timestamp: new Date(T0 + MIN).toISOString() }) + '\n{broken\n');
  assert.strictEqual(lastEventTime(f), T0 + MIN);
  const g = path.join(d, 'b.output');
  fs.writeFileSync(g, 'plain text');
  assert.ok(Math.abs(lastEventTime(g) - Date.now()) < 60_000);
  assert.strictEqual(lastEventTime(path.join(d, 'nope.jsonl')), null);
});

test('rebuild: a background agent with no completion record is "stopped", ending at its own last transcript event', () => {
  const projects = tmp('helm-fleet-proj-');
  writeAgentTranscript(projects, 'aaaa1111bbbb2222', T0 + 34 * MIN);
  const f = new Fleet('s1', () => {});
  f.projectsDir = projects;
  f.rebuild([
    agentItem('tA', '[lane:a] audit', T0, { result: launchText('aaaa1111bbbb2222') }),
    agentItem('tB', '[lane:b] build', T0 + MIN, { result: launchText('cccc3333dddd4444') }),   // no transcript on disk
    agentItem('tC', '[lane:c] check', T0 + 2 * MIN, { result: launchText('eeee5555ffff6666') }),
    notif('[lane:c] check', 'completed', T0 + 22 * MIN),
  ]);
  const [A, B, C] = ['tA', 'tB', 'tC'].map((id) => f.agents.get(id));
  assert.strictEqual(A.status, 'stopped');
  assert.strictEqual(A.endedAt, T0 + 34 * MIN, 'end = last event of its own transcript, never now');
  assert.strictEqual(A.endEstimated, true);
  assert.strictEqual(A.agentId, 'aaaa1111bbbb2222');
  assert.strictEqual(B.status, 'stopped');
  assert.strictEqual(B.endedAt, undefined, 'no transcript: end unknown, not now');
  assert.strictEqual(C.status, 'done');
  assert.strictEqual(C.endedAt, T0 + 22 * MIN, 'end = the task notification');
  assert.strictEqual(C.endEstimated, undefined);
  assert.strictEqual(f.runningCount(), 0);
});

test('rebuild keeps live state: loading an older page must not finish running agents', () => {
  const f = new Fleet('s1', () => {});
  const launch = agentItem('tA', 'live one', T0, { result: launchText('aaaa1111bbbb2222') });
  f.onToolStart({ ...launch, status: 'running' });
  f.onToolEnd(launch, { status: 'async_launched', agentId: 'aaaa1111bbbb2222' });
  f.onTask({ subtype: 'task_progress', tool_use_id: 'tA', task_id: 'aaaa1111bbbb2222', usage: { total_tokens: 1000, tool_uses: 7 } });
  assert.strictEqual(f.runningCount(), 1);
  const older = agentItem('tOld', 'older', T0 - 60 * MIN, { result: launchText('9999aaaa9999aaaa') });
  f.rebuild([older, launch]);
  const A = f.agents.get('tA');
  assert.strictEqual(A.status, 'running');
  assert.strictEqual(A.toolCount, 7);
  assert.strictEqual(f.agents.get('tOld').status, 'stopped');
  assert.strictEqual(f.runningCount(), 1);
  assert.deepStrictEqual([...f.agents.keys()], ['tOld', 'tA'], 'transcript order');
});

test('SendMessage resume (live): running again, the earlier run kept in runs, notifications by task id', () => {
  const f = new Fleet('s1', () => {});
  const launch = agentItem('tA', 'resumable', T0, { result: launchText('aaaa1111bbbb2222') });
  f.onToolStart({ ...launch, status: 'running' });
  f.onToolEnd(launch, { status: 'async_launched', agentId: 'aaaa1111bbbb2222' });
  f.onTask({ subtype: 'task_notification', tool_use_id: 'tA', task_id: 'aaaa1111bbbb2222', status: 'completed' });
  const A = f.agents.get('tA');
  assert.strictEqual(A.status, 'done');
  const firstEnd = A.endedAt;
  f.onToolEnd(sendItem('tS', 'aaaa1111bbbb2222', T0 + 50 * MIN), { success: true, resumedAgentId: 'aaaa1111bbbb2222' });
  assert.strictEqual(A.status, 'running');
  assert.strictEqual(A.resumedAt, T0 + 50 * MIN + 20);
  assert.strictEqual(A.endedAt, undefined);
  assert.deepStrictEqual(A.runs, [{ startedAt: T0, endedAt: firstEnd }]);
  assert.strictEqual(f.runningCount(), 1);
  // Its events may name the SendMessage call: the task id still finds the agent and is not re-pointed.
  f.onTask({ subtype: 'task_started', tool_use_id: 'tS', task_id: 'aaaa1111bbbb2222' });
  f.onTask({ subtype: 'task_notification', tool_use_id: 'tS', task_id: 'aaaa1111bbbb2222', status: 'killed' });
  assert.strictEqual(A.status, 'stopped');
  assert.strictEqual(f.taskToTool.get('aaaa1111bbbb2222'), 'tA');
});

test('task_started for a finished agent (resume seen only through the SDK) counts it as running', () => {
  const f = new Fleet('s1', () => {});
  const launch = agentItem('tA', 'x', T0, { result: launchText('aaaa1111bbbb2222') });
  f.onToolStart({ ...launch, status: 'running' });
  f.onToolEnd(launch, null);
  f.onTask({ subtype: 'task_notification', tool_use_id: 'tA', task_id: 'aaaa1111bbbb2222', status: 'completed' });
  f.onTask({ subtype: 'task_started', task_id: 'aaaa1111bbbb2222' });
  assert.strictEqual(f.agents.get('tA').status, 'running');
  assert.strictEqual(f.runningCount(), 1);
});

test('rebuild replays a SendMessage resume and its later notification', () => {
  const f = new Fleet('s1', () => {});
  f.rebuild([
    agentItem('tA', 'twice', T0, { result: launchText('aaaa1111bbbb2222') }),
    notif('twice', 'completed', T0 + 10 * MIN),
    sendItem('tS', 'aaaa1111bbbb2222', T0 + 30 * MIN),
    notif('twice', 'completed', T0 + 45 * MIN),
  ]);
  const A = f.agents.get('tA');
  assert.strictEqual(A.status, 'done');
  assert.strictEqual(A.resumedAt, T0 + 30 * MIN + 20);
  assert.strictEqual(A.endedAt, T0 + 45 * MIN);
  assert.deepStrictEqual(A.runs, [{ startedAt: T0, endedAt: T0 + 10 * MIN }]);
});

test('stopAll: background agents stop with the CLI ("stopped"), foreground ones take the given status', () => {
  const f = new Fleet('s1', () => {});
  const bg = agentItem('tA', 'bg', T0, { result: launchText('aaaa1111bbbb2222') });
  f.onToolStart({ ...bg, status: 'running' });
  f.onToolEnd(bg, null);
  f.onToolStart({ ...agentItem('tB', 'fg', T0), status: 'running', input: { description: 'fg' } });
  f.stopAll('error');
  assert.strictEqual(f.agents.get('tA').status, 'stopped');
  assert.ok(f.agents.get('tA').endedAt > 0);
  assert.strictEqual(f.agents.get('tB').status, 'error');
  assert.strictEqual(f.runningCount(), 0);
});

test('engine: an idle session with a background agent running reports agentsRunning and is busy for recycleClis', async () => {
  const userDataDir = tmp('helm-eng-');
  const cwd = tmp('helm-cwd-');
  const events = [];
  const sdk = createFakeSdk(async function* () {
    yield F.toolUse('m1', 'tA', 'Agent', { description: '[lane:x] long job', subagent_type: 'opus-high', prompt: 'p', run_in_background: true });
    yield F.toolResult('tA', launchText('aaaa1111bbbb2222'), { structured: { isAsync: true, status: 'async_launched', agentId: 'aaaa1111bbbb2222' } });
    yield F.result(0);
  });
  const engine = createEngine({ userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir: tmp('helm-proj-'), statuslineDir: tmp('helm-sl-') });
  const m = engine.methods;
  const s = await m['sessions.create']({ cwd });
  await m['sessions.send']({ id: s.id, text: 'go' });
  const es = engine._internal.sessions.get(s.id);
  const t0 = Date.now();
  while (es.publicSession().status !== 'idle' && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 200));
  const pub = es.publicSession();
  assert.strictEqual(pub.status, 'idle', 'status keeps meaning "a turn is active"');
  assert.strictEqual(pub.agentsRunning, 1);
  const upd = [...events].reverse().find((e) => e.event === 'session.updated' && e.data.id === s.id);
  assert.strictEqual(upd.data.agentsRunning, 1, 'session.updated carries agentsRunning');
  if (es.live()) {
    const r = engine.recycleClis();
    assert.ok(r.busy.includes(s.id), 'running agents keep the CLI open');
    assert.ok(!r.closed.includes(s.id));
  }
  es.fleet.onTask({ subtype: 'task_notification', task_id: 'aaaa1111bbbb2222', status: 'completed' });
  // Poll, don't sleep a fixed 250 ms: under a loaded full-suite run the 120 ms + 60 ms debounces can land later.
  const lastUpd = () => [...events].reverse().find((e) => e.event === 'session.updated' && e.data.id === s.id);
  // Read publicSession() mid-wait on purpose: it must not swallow the change edge (it once set the sent counters).
  assert.strictEqual(es.publicSession().agentsRunning, 0);
  const t1 = Date.now();
  while (lastUpd().data.agentsRunning !== 0 && Date.now() - t1 < 3000) await new Promise((r) => setTimeout(r, 10));
  const upd2 = lastUpd();
  assert.strictEqual(upd2.data.agentsRunning, 0, 'the agent finishing re-publishes the session');
  await engine.shutdown();
});
