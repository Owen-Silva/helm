'use strict';
// QA finding (2026-10-08): interrupting a turn mid-tool ended calmly ("Interrupted", "Stopped
// after 8s") but the Bash row read "Failed" in error red. A tool the user stopped carries
// `interrupted: true` (status stays "error" for older readers) and renders as a neutral "Stopped";
// a tool whose CLI really died stays a plain failure.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { Normalizer } = require('../../main/engine/normalize');
const { makeStore } = require('../../main/engine/transcript');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(turn) {
  const projectsDir = tmp('helm-stproj-');
  const events = [];
  const sdk = createFakeSdk(turn, { projectsDir });
  const engine = createEngine({ userDataDir: tmp('helm-st-'), emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir, statuslineDir: tmp('helm-stsl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error('timed out waiting');
  };
  const es = (id) => engine._internal.sessions.get(id);
  return { engine, m: engine.methods, events, waitFor, cwd: tmp('helm-stcwd-'), es };
}

const toolOf = (h, sid, useId) => h.es(sid).items.find((i) => i.type === 'tool' && i.toolUseId === useId);

test('interrupting mid-tool: the error tool_result that lands during the interrupt is "stopped", not failed', async () => {
  const h = harness(async function* (um, api) {
    yield F.toolUse('m1', 'tBash', 'Bash', { command: 'node -e "setTimeout(()=>{},60000)"' });
    while (!api.state.interrupted) await sleep(5);
    yield F.toolResult('tBash', 'Interrupted by user', { isError: true });
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'run it' });
  await h.waitFor(() => toolOf(h, s.id, 'tBash'));
  await h.m['sessions.interrupt']({ id: s.id });
  await h.waitFor(() => h.es(s.id).items.some((i) => i.type === 'result'));
  const t = toolOf(h, s.id, 'tBash');
  assert.strictEqual(t.status, 'error', 'status stays "error" so older readers still see an ended tool');
  assert.strictEqual(t.interrupted, true, 'the tool is marked as stopped by the interrupt');
  assert.ok(t.endedAt, 'it has an end time');
  await h.engine.shutdown();
});

test('a tool that fails on its own (no interrupt) is still a plain failure', async () => {
  const h = harness(async function* () {
    yield F.toolUse('m1', 'tBad', 'Bash', { command: 'exit 1' });
    yield F.toolResult('tBad', 'Exit code 1', { isError: true });
    yield F.result(0.01);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'fail' });
  await h.waitFor(() => h.es(s.id).items.some((i) => i.type === 'result'));
  const t = toolOf(h, s.id, 'tBad');
  assert.strictEqual(t.status, 'error');
  assert.strictEqual(t.interrupted, undefined);
  await h.engine.shutdown();
});

test('closing a session while a tool runs marks that tool stopped, not failed', async () => {
  const h = harness(async function* (um, api) {
    yield F.toolUse('m1', 'tLong', 'Bash', { command: 'sleep 60' });
    while (!api.state.closed) await sleep(5);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => toolOf(h, s.id, 'tLong'));
  const sess = h.es(s.id);
  await sess.close({ final: false });
  await h.waitFor(() => toolOf(h, s.id, 'tLong').status !== 'running');
  const t = toolOf(h, s.id, 'tLong');
  assert.strictEqual(t.status, 'error');
  assert.strictEqual(t.interrupted, true);
  await h.engine.shutdown();
});

function recorder() {
  const store = makeStore();
  let n = 0;
  return { store, newId: () => 'x' + ++n };
}

test('history replay: an error tool_result followed by "[Request interrupted by user for tool use]" is stopped', () => {
  const r = recorder();
  const norm = new Normalizer({ store: r.store, newId: r.newId });
  const asst = (id, useId) => ({ type: 'assistant', uuid: 'a-' + id, timestamp: '2026-10-08T01:00:00Z', message: { id, content: [{ type: 'tool_use', id: useId, name: 'Bash', input: { command: 'x' } }] } });
  const result = (useId, text) => ({ type: 'user', uuid: 'r-' + useId, timestamp: '2026-10-08T01:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, is_error: true, content: text }] } });
  // A real failure earlier in the conversation stays a failure.
  norm.handleLine(asst('m0', 'tFail'));
  norm.handleLine(result('tFail', 'Exit code 2'));
  // An interrupted tool: error result, then the interrupt line.
  norm.handleLine(asst('m1', 'tStop'));
  norm.handleLine(result('tStop', "The user doesn't want to proceed with this tool use."));
  norm.handleLine({ type: 'user', uuid: 'i1', timestamp: '2026-10-08T01:00:02Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  // A tool still running when the interrupt line arrives (no result written) is stopped too.
  norm.handleLine(asst('m2', 'tOpen'));
  norm.handleLine({ type: 'user', uuid: 'i2', timestamp: '2026-10-08T01:00:03Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  const by = (u) => r.store.items.find((i) => i.toolUseId === u);
  assert.strictEqual(by('tFail').status, 'error');
  assert.strictEqual(by('tFail').interrupted, undefined, 'an earlier real failure is not relabelled');
  assert.strictEqual(by('tStop').status, 'error');
  assert.strictEqual(by('tStop').interrupted, true);
  assert.strictEqual(by('tOpen').status, 'error');
  assert.strictEqual(by('tOpen').interrupted, true);
});

test('failRunningTools without the interrupted option (Claude Code died) leaves a plain failure', () => {
  const r = recorder();
  const norm = new Normalizer({ store: r.store, newId: r.newId });
  norm.handleSdk({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'tX', name: 'Bash', input: { command: 'x' } }] } });
  norm.failRunningTools('Stopped (Claude Code exited)');
  const t = r.store.items.find((i) => i.toolUseId === 'tX');
  assert.strictEqual(t.status, 'error');
  assert.strictEqual(t.interrupted, undefined);
});

// Rewind (QA 2026-10-08): after a conversation rewind Helm still showed the forgotten messages
// unmarked. The marker item now names where the forgotten part starts, so the UI can fold it.
test('a conversation rewind marker carries rewind.fromItemId (the prompt rewound to) and conversation: true', async () => {
  let n = 0;
  const h = harness(async function* () {
    n++;
    yield* F.textTurn('m' + n, 'reply ' + n);
    yield F.result(0.01);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  for (const text of ['one', 'two']) {
    const before = h.es(s.id).items.filter((i) => i.type === 'result').length;
    await h.m['sessions.send']({ id: s.id, text });
    await h.waitFor(() => h.es(s.id).items.filter((i) => i.type === 'result').length > before && !h.es(s.id).turnActive);
  }
  const cps = await h.m['sessions.checkpoints']({ id: s.id });
  assert.ok(cps.length >= 2, `two checkpoints (got ${cps.length})`);
  const two = h.es(s.id).items.find((i) => i.type === 'user' && i.text === 'two');
  const cp = cps.find((c) => c.id === two.uuid);
  assert.ok(cp, 'the second prompt is a checkpoint');
  await h.m['sessions.rewind']({ id: s.id, checkpointId: cp.id, files: false, conversation: true });
  const items = h.es(s.id).items;
  const marker = items[items.length - 1];
  assert.strictEqual(marker.type, 'system');
  assert.match(marker.text, /Rewound to before/);
  assert.deepStrictEqual(marker.rewind, { checkpointId: cp.id, fromItemId: two.id, files: false, conversation: true });
  // Everything from that prompt up to the marker is what Claude no longer sees.
  const from = items.findIndex((i) => i.id === two.id);
  assert.ok(from >= 0 && from < items.length - 1);
  assert.ok(items.slice(from, -1).some((i) => i.type === 'assistant' && i.text === 'reply 2'));
  await h.engine.shutdown();
});
