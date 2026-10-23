'use strict';
// lane logs: task_* / background_tasks_changed log lines. At info: one short summary line per background task
// state change and every failure, no JSON; a foreground Bash call that completes logs nothing. At debug: the
// full JSON of every event (the old line). The engine's log level gate (createEngine logLevel / setLogLevel).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { TaskLog } = require('../../main/engine/task-log');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(5); } throw new Error('timed out waiting'); };

const N = 5;
const sys = (o) => ({ type: 'system', ...o });
// A burst: N background shells start, the CLI's level signal after each, then they all complete
// (task_updated completed + task_notification completed per task, as the CLI sends them); plus N foreground
// Bash calls that start and complete, one foreground call that fails, and one background agent that is killed.
function* burst() {
  const live = [];
  for (let i = 0; i < N; i++) {
    const id = `bg${i}`;
    yield sys({ subtype: 'task_started', task_id: id, task_type: 'local_bash', is_backgrounded: true, tool_use_id: `toolu_${i}`, description: `Wait for build ${i}` });
    live.push({ task_id: id, task_type: 'local_bash', description: `Wait for build ${i}` });
    yield sys({ subtype: 'background_tasks_changed', tasks: live.slice() });
    yield sys({ subtype: 'background_tasks_changed', tasks: live.slice() }); // a repeat: same set
  }
  for (let i = 0; i < N; i++) {
    yield sys({ subtype: 'task_started', task_id: `fg${i}`, task_type: 'local_bash', is_backgrounded: false, tool_use_id: `toolu_f${i}`, description: `ls ${i}` });
    yield sys({ subtype: 'task_progress', task_id: `fg${i}` });
    yield sys({ subtype: 'task_notification', task_id: `fg${i}`, status: 'completed', tool_use_id: `toolu_f${i}` });
  }
  yield sys({ subtype: 'task_started', task_id: 'fgX', task_type: 'local_bash', is_backgrounded: false, description: 'npm test' });
  yield sys({ subtype: 'task_notification', task_id: 'fgX', status: 'failed' });
  yield sys({ subtype: 'task_started', task_id: 'ag1', task_type: 'local_agent', is_backgrounded: true, description: 'Audit the logs' });
  yield sys({ subtype: 'task_updated', task_id: 'ag1', patch: { status: 'failed', end_time: 1, error: 'Agent stalled: no progress for 600s' } });
  yield sys({ subtype: 'task_notification', task_id: 'ag1', status: 'failed' });
  for (let i = 0; i < N; i++) {
    yield sys({ subtype: 'task_updated', task_id: `bg${i}`, patch: { status: 'completed', end_time: 2 } });
    yield sys({ subtype: 'task_notification', task_id: `bg${i}`, status: 'completed' });
  }
  yield sys({ subtype: 'background_tasks_changed', tasks: [] });
}

async function runBurst(logLevel) {
  const dir = tmp('helm-tasklog-');
  const lines = [];
  const sdk = createFakeSdk(async function* () {
    for (const m of burst()) yield m;
    for (const f of F.textTurn('m1', 'done')) yield f;
    yield F.result(0.01);
  });
  const engine = createEngine({
    userDataDir: dir, emit: () => {}, log: (level, msg) => lines.push({ level, msg }), sdk, claudePath: null,
    projectsDir: path.join(dir, 'projects'), statuslineDir: path.join(dir, 'sl'), external: false, ...(logLevel ? { logLevel } : {}),
  });
  const s = await engine.methods['sessions.create']({ cwd: tmp('helm-tasklog-cwd-') });
  await engine.methods['sessions.send']({ id: s.id, text: 'go' });
  const es = engine._internal.sessions.get(s.id);
  await waitFor(() => es.s.status === 'idle' && lines.some((l) => / background tasks 0$/.test(l.msg)));
  await engine.shutdown();
  return lines.filter((l) => / (task_\w+|background_tasks_changed|background tasks) /.test(l.msg) || / background tasks \d+/.test(l.msg));
}

test('a task_* burst at info: N summary lines per background edge, every failure, no JSON', async () => {
  const got = await runBurst();
  assert.ok(got.every((l) => l.level === 'info'), 'nothing under info reaches the sink');
  assert.ok(got.every((l) => !l.msg.includes('{')), 'no JSON at info');
  const msgs = got.map((l) => l.msg.replace(/^engine: s_\w+ /, ''));
  const started = msgs.filter((m) => m.startsWith('task_started'));
  assert.strictEqual(started.filter((m) => / bg\d /.test(m)).length, N, 'N background starts');
  assert.match(started[0], /^task_started bg0 local_bash bg "Wait for build 0"$/);
  assert.ok(!msgs.some((m) => /\bfg\d\b/.test(m)), 'a foreground Bash call that completed logs nothing');
  assert.strictEqual(msgs.filter((m) => /^task_(updated|notification) bg\d completed$/.test(m)).length, N, 'one end line per background task');
  assert.ok(msgs.includes('task_notification fgX failed'), 'a foreground failure is kept');
  assert.ok(msgs.includes('task_updated ag1 failed: Agent stalled: no progress for 600s'), 'the error text is kept');
  assert.ok(!msgs.includes('task_notification ag1 failed'), 'the same failure is not said twice');
  const levels = msgs.filter((m) => m.startsWith('background tasks'));
  assert.deepStrictEqual(levels, [1, 2, 3, 4, 5].map((n) => `background tasks ${n} (${n} local_bash)`).concat(['background tasks 0']), 'a repeated set is not logged again');
  assert.strictEqual(got.length, N + 1 + N + 1 + 1 + (N + 1), `summary lines: ${got.length}`);
});

test('the same burst at debug: the full JSON of every event (the old line) as well', async () => {
  const got = await runBurst('debug');
  const debug = got.filter((l) => l.level === 'debug');
  const json = debug.filter((l) => /^engine: s_\w+ (task_\w+|background_tasks_changed) [[{]/.test(l.msg));
  const events = [...burst()].length;
  assert.strictEqual(json.length, events, 'one JSON line per event, task_progress included');
  assert.ok(json.some((l) => l.msg.includes('"subtype":"task_started","task_id":"fg0","task_type":"local_bash","is_backgrounded":false')));
  assert.ok(json.some((l) => /background_tasks_changed \[\{"task_id":"bg0"/.test(l.msg)));
  assert.strictEqual(got.filter((l) => l.level === 'info').length, N + 1 + N + 1 + 1 + (N + 1), 'info lines unchanged at debug');
});

test('engine log level: default info, logLevel / setLogLevel; warn and error always pass at info', async () => {
  const dir = tmp('helm-loglevel-');
  const lines = [];
  const engine = createEngine({ userDataDir: dir, emit: () => {}, log: (level, msg) => lines.push(level), sdk: createFakeSdk(async function* () {}), claudePath: null, projectsDir: path.join(dir, 'p'), statuslineDir: path.join(dir, 'sl'), external: false });
  const log = engine._internal.ctx.log;
  for (const lv of ['debug', 'info', 'warn', 'error', 'custom']) log(lv, 'x');
  assert.deepStrictEqual(lines, ['info', 'warn', 'error', 'custom']);
  assert.strictEqual(engine._internal.ctx.logEnabled('debug'), false);
  assert.strictEqual(engine.setLogLevel('DEBUG'), 'debug');
  assert.strictEqual(engine.setLogLevel('nonsense'), 'debug', 'an unknown level changes nothing');
  lines.length = 0; log('debug', 'x');
  assert.deepStrictEqual(lines, ['debug']);
  assert.strictEqual(engine.setLogLevel('error'), 'error');
  lines.length = 0; for (const lv of ['info', 'warn', 'error']) log(lv, 'x');
  assert.deepStrictEqual(lines, ['error']);
  await engine.shutdown();
});

test('TaskLog: no JSON is built when debug is off; a task with no end status is surfaced; reset re-logs the set', () => {
  const out = [];
  let built = 0;
  const tl = new TaskLog({ sid: () => 's_1', log: (l, m) => out.push(`${l} ${m}`), debugOn: () => false });
  const m = { subtype: 'task_started', task_id: 't1', task_type: 'local_bash', is_backgrounded: false, get description() { built++; return 'x'; } };
  tl.event(m);
  assert.strictEqual(built, 0, 'foreground start at info: nothing built');
  assert.deepStrictEqual(out, []);
  tl.event({ subtype: 'task_notification', task_id: 't1' });
  assert.deepStrictEqual(out, ['info engine: s_1 task_notification t1 ?'], 'an end with no status is not assumed fine');
  tl.event({ subtype: 'task_updated', task_id: 't2', patch: { is_backgrounded: true }, description: 'long build' });
  assert.strictEqual(out.at(-1), 'info engine: s_1 task_updated t2 backgrounded "long build"');
  tl.event({ subtype: 'task_updated', task_id: 't2', patch: { status: 'completed' } });
  assert.strictEqual(out.at(-1), 'info engine: s_1 task_updated t2 completed', 'a backgrounded call ends at info');
  tl.level([]); tl.level([]);
  tl.reset(); tl.level([]);
  assert.deepStrictEqual(out.filter((l) => l.includes('background tasks')), ['info engine: s_1 background tasks 0', 'info engine: s_1 background tasks 0']);
});
