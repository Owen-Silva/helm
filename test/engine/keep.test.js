'use strict';
// lane detach: the engine's keep-through-restart state machine over the fake SDK (no real broker or CLI):
//   1. keeping on but the CLI is not in a broker: the gate and the restart note work exactly as before
//   2. a session whose CLI the broker holds (canKeep): the gate lets a restart through (strict "Restart when
//      finished" still waits), shutdown detaches it and saves s.kept (cost base + today's note), no restart note,
//      its schedules are not noted as ended
//   3. the next Helm finds no broker for it: the fallback restart note carries the reason and what stopped,
//      a "could not keep" line shows in the conversation, s.kept is gone, Continue tells Claude why
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');
const { restartBlockers, keptWork } = require('../../main/update');
const steer = require('../../main/engine/steer');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(5); } throw new Error('timed out waiting'); };
const textOf = (um) => (typeof um.message.content === 'string' ? um.message.content : um.message.content.map((b) => b.text || '').join('|'));
const savedSessions = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).sessions;

function boot(dir, turn, extra = {}) {
  const sdk = createFakeSdk(turn);
  const engine = createEngine({ userDataDir: dir, emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: path.join(dir, 'projects'), statuslineDir: path.join(dir, 'sl'), detach: true, ...extra });
  return { engine, m: engine.methods, sdk, es: (id) => engine._internal.sessions.get(id) };
}

// a turn that launches a background agent, then sits in a long Bash call
function busyTurn() {
  return async function* (um, api) {
    yield F.toolUse('m1', 'tA', 'Agent', { description: '[lane:guard] guard work', subagent_type: 'general-purpose', run_in_background: true, prompt: 'x' });
    yield { type: 'system', subtype: 'task_started', task_id: 'aaaa1111', task_type: 'local_agent', is_backgrounded: true, tool_use_id: 'tA', description: '[lane:guard] guard work' };
    yield F.toolResult('tA', 'Async agent launched successfully.', { structured: { status: 'async_launched', agentId: 'aaaa1111' } });
    yield F.toolUse('m2', 'tB', 'Bash', { command: 'sleep 600' });
    await new Promise((r) => { const iv = setInterval(() => { if (api.state.closed || api.state.interrupted) { clearInterval(iv); r(); } }, 5); });
  };
}

test('keep on, CLI not in a broker: the gate and the restart note are unchanged', async () => {
  const dir = tmp('helm-keep-');
  const a = boot(dir, busyTurn());
  const s = await a.m['sessions.create']({ cwd: tmp('helm-keep-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'go' });
  const es = a.es(s.id);
  await waitFor(() => es.fleet.runningCount() === 1 && es.items.some((i) => i.type === 'tool' && i.name === 'Bash' && i.status === 'running'));
  assert.strictEqual(es.canKeep(), false, 'the fake SDK never spawned through the broker');
  const busy = a.engine.busy();
  assert.strictEqual(busy[0].keep, undefined);
  assert.deepStrictEqual(restartBlockers({ sessions: busy }, { manual: true }), ['1 session working', '1 agent running']);
  const st = await a.m['sessions.keepStatus']();
  assert.strictEqual(st.on, true);
  assert.strictEqual(st.override, 'on');
  assert.strictEqual(st.kept, 0);
  await a.engine.shutdown({ cause: 'restart' });
  const saved = savedSessions(dir).find((x) => x.id === s.id);
  assert.ok(saved.restartNote && saved.restartNote.working, 'cut off as before');
  assert.strictEqual(saved.kept, undefined);
});

test('kept through a restart, then no broker on the next start: the fallback note says why', async () => {
  const dir = tmp('helm-keep-');
  const a = boot(dir, busyTurn());
  const s = await a.m['sessions.create']({ cwd: tmp('helm-keep-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'go' });
  const es = a.es(s.id);
  await waitFor(() => es.fleet.runningCount() === 1 && es.items.some((i) => i.type === 'tool' && i.name === 'Bash' && i.status === 'running'));
  // stand in for a CLI the broker holds: a broker process handle that detaches, in a broker outside any job
  let detachedCalls = 0;
  es.brokerProc = { pid: 4242, key: `${s.id}~k1`, detached: false, exited: false, detach() { detachedCalls++; this.detached = true; return true; } };
  es.q._helmCli.pid = 4242;
  es.procCostBase = 1.25;
  a.engine._internal.ctx.keepSafe = () => true;
  assert.strictEqual(es.canKeep(), true);

  // the gate: nothing is cut off, so nothing blocks; "Restart when finished" (strict) still waits for all of it
  const busy = a.engine.busy();
  assert.strictEqual(busy[0].keep, true);
  assert.deepStrictEqual(restartBlockers({ sessions: busy }, { manual: true }), []);
  assert.deepStrictEqual(restartBlockers({ sessions: busy }, { manual: true, strict: true }), ['1 session working', '1 agent running']);
  assert.deepStrictEqual(keptWork({ sessions: busy }), ['1 session working', '1 agent']);
  // queued messages and `!` runs are Helm's own: they still hold a restart
  assert.deepStrictEqual(restartBlockers({ sessions: [{ ...busy[0], queued: 1 }] }, { manual: true }), ['1 queued message']);
  assert.strictEqual((await a.m['sessions.keepStatus']()).kept, 1);

  // the restart intent goes to the broker BEFORE the detach (broker.js "keep"); quitting is never asked
  const intents = [];
  const shutdowns = [];
  a.engine._internal.ctx.broker.keepForRestart = async (procs) => { intents.push(procs.map((p) => [p.key, p.detached])); return new Set(procs); };
  a.engine._internal.ctx.broker.shutdownAll = async (why) => { shutdowns.push(why); return []; };
  const fakeQ = es.q;
  await a.engine.shutdown({ cause: 'restart' });
  try { fakeQ.close(); } catch {} // the stand-in CLI: nothing else ends it once Helm let go
  assert.deepStrictEqual(intents, [[[`${s.id}~k1`, false]]], 'one intent, sent while the pipe was still attached');
  assert.deepStrictEqual(shutdowns, [], 'a restart that kept a CLI does not shut the broker down');
  assert.strictEqual(detachedCalls, 1, 'detached, not closed');
  const saved = savedSessions(dir).find((x) => x.id === s.id);
  assert.strictEqual(saved.restartNote, undefined, 'nothing was cut off: no restart note');
  assert.ok(saved.kept, 's.kept saved');
  assert.strictEqual(saved.kept.key, `${s.id}~k1`);
  assert.strictEqual(saved.kept.pid, 4242);
  assert.strictEqual(saved.kept.costBase, 1.25, 'the cost base the old Helm last counted');
  assert.ok(saved.kept.note && saved.kept.note.working, 'today\'s note kept for a failed re-attach');
  assert.deepStrictEqual(saved.kept.note.agents.map((x) => [x.name, x.agentId]), [['guard', 'aaaa1111']]);

  // the next Helm (setting now off: what was kept is still handled) finds no broker at all
  const prompts = [];
  const b = boot(dir, async function* (um) { prompts.push(um); for (const f of F.textTurn('m9', 'ok')) yield f; yield F.result(0.01); }, { detach: false });
  const es2 = b.es(s.id);
  assert.ok(es2.keepPending, 'starts wait for the re-attach pass');
  await waitFor(() => es2.s.restartNote && es2.s.restartNote.reason);
  const n = es2.s.restartNote;
  assert.match(n.reason, /the process that kept it running is gone/);
  assert.strictEqual(n.working, true);
  assert.strictEqual(n.agents.length, 1, 'what stopped comes from the note saved at detach');
  assert.strictEqual(es2.s.kept, undefined, 's.kept cleared');
  await es2.ensureLoaded();
  const line = es2.items.find((i) => i.type === 'system' && i.subtype === 'kept-failed');
  assert.ok(line, 'a "could not keep" line in the conversation');
  assert.match(line.text, /Could not keep Claude Code running through the restart: the process that kept it running is gone\. What stopped is listed below/);
  await waitFor(() => { const x = savedSessions(dir).find((y) => y.id === s.id); return x && !x.kept && x.restartNote && x.restartNote.reason; }, 3000);

  // Continue: Claude is told the restart stopped things AND why keeping them failed
  const r = await b.m['sessions.continueAfterRestart']({ id: s.id });
  assert.strictEqual(r.action, 'continued');
  await waitFor(() => prompts.length === 1);
  const note = steer.splitNote(textOf(prompts[0]).split('|')[0]).note;
  assert.match(note, /Helm restarted at \d\d:\d\d while you were working/);
  assert.match(note, /Helm tried to keep Claude Code running through the restart but could not: the process that kept it running is gone/);
  await b.engine.shutdown({ cause: 'quit' });
});

test('restart note model: the reason is the first fact', async () => {
  const { restartNoteModel } = await import('../../ui/lib/restart-note.js');
  const m = restartNoteModel({ at: Date.UTC(2026, 9, 15, 13, 5), cause: 'restart', working: true, agents: [], tasks: [], reason: 'Claude Code refused the re-attach (x)' }, () => '1:05 PM');
  assert.strictEqual(m.headline, 'Helm restarted at 1:05 PM: the turn in progress stopped');
  assert.deepStrictEqual(m.facts, ['Helm could not keep it running: Claude Code refused the re-attach (x)']);
});

// The user's rule (2026-10-15): only a restart Helm performs keeps a CLI. Quit never sends the intent or detaches, and
// shuts every broker down after the sessions closed.
test('quit with a keepable CLI: no intent, no detach, the brokers are shut down', async () => {
  const dir = tmp('helm-keep-');
  const a = boot(dir, busyTurn());
  const s = await a.m['sessions.create']({ cwd: tmp('helm-keep-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'go' });
  const es = a.es(s.id);
  await waitFor(() => es.items.some((i) => i.type === 'tool' && i.name === 'Bash' && i.status === 'running'));
  let detachedCalls = 0;
  es.brokerProc = { pid: 4343, key: `${s.id}~k1`, detached: false, exited: false, detach() { detachedCalls++; this.detached = true; return true; } };
  es.q._helmCli.pid = 4343;
  a.engine._internal.ctx.keepSafe = () => true;
  assert.strictEqual(es.canKeep(), true);
  const intents = [];
  const shutdowns = [];
  a.engine._internal.ctx.broker.keepForRestart = async (procs) => { intents.push(procs.length); return new Set(procs); };
  a.engine._internal.ctx.broker.shutdownAll = async (why) => { shutdowns.push(why); return []; };
  await a.engine.shutdown({ cause: 'quit' });
  assert.deepStrictEqual(intents, [], 'Quit never sends a restart intent');
  assert.strictEqual(detachedCalls, 0, 'Quit never detaches');
  assert.deepStrictEqual(shutdowns, ['Helm quit'], 'every broker is told to end what is left and exit');
  const saved = savedSessions(dir).find((x) => x.id === s.id);
  assert.strictEqual(saved.kept, undefined);
  assert.ok(saved.restartNote && saved.restartNote.cause === 'quit', 'the quit note lists what stopped');
});

test('a restart intent the broker did not confirm: the CLI is closed like any other (restart note), not detached', async () => {
  const dir = tmp('helm-keep-');
  const a = boot(dir, busyTurn());
  const s = await a.m['sessions.create']({ cwd: tmp('helm-keep-cwd-') });
  await a.m['sessions.send']({ id: s.id, text: 'go' });
  const es = a.es(s.id);
  await waitFor(() => es.items.some((i) => i.type === 'tool' && i.name === 'Bash' && i.status === 'running'));
  let detachedCalls = 0;
  es.brokerProc = { pid: 4444, key: `${s.id}~k1`, detached: false, exited: false, detach() { detachedCalls++; this.detached = true; return true; } };
  es.q._helmCli.pid = 4444;
  a.engine._internal.ctx.keepSafe = () => true;
  const shutdowns = [];
  a.engine._internal.ctx.broker.keepForRestart = async () => new Set(); // the broker could not be reached
  a.engine._internal.ctx.broker.shutdownAll = async (why) => { shutdowns.push(why); return []; };
  await a.engine.shutdown({ cause: 'restart' });
  assert.strictEqual(detachedCalls, 0);
  assert.deepStrictEqual(shutdowns, ['Helm restarted without keeping sessions']);
  const saved = savedSessions(dir).find((x) => x.id === s.id);
  assert.strictEqual(saved.kept, undefined);
  assert.ok(saved.restartNote && saved.restartNote.working, 'cut off, with the restart note');
});

// The broker stopped a CLI because Helm closed without a restart it performed (brokers/stopped/*.json):
// the next start says so in that session, once. A session the last Helm kept gets the stop's reason in its note.
test('stopped when Helm closed: the next start says so (and a kept session gets the reason)', async () => {
  const dir = tmp('helm-keep-');
  let turns = 0;
  const a = boot(dir, async function* () { for (const f of F.textTurn('m1', 'hi')) yield f; yield F.result(0.01); turns++; });
  const s1 = await a.m['sessions.create']({ cwd: tmp('helm-keep-cwd-') });
  const s2 = await a.m['sessions.create']({ cwd: tmp('helm-keep-cwd-') });
  await a.m['sessions.send']({ id: s1.id, text: 'go' });
  await waitFor(() => turns === 1 && a.es(s1.id).s.status === 'idle');
  await a.engine.shutdown({ cause: 'quit' });
  // s2 was kept by a restart whose new Helm never came (saved s.kept, like detachCli does)
  const file = path.join(dir, 'sessions.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const k2 = j.sessions.find((x) => x.id === s2.id);
  k2.kept = { at: Date.now() - 90e3, key: `${s2.id}~k`, pid: 5252, costBase: null, note: { at: Date.now() - 90e3, cause: 'restart', working: true, waiting: false, agents: [], agentsTotal: 0, tasks: [], shells: 0, queued: 0 } };
  fs.writeFileSync(file, JSON.stringify(j));
  const sdir = path.join(dir, 'brokers', 'stopped');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, '1-1-a.json'), JSON.stringify({ at: Date.now() - 5000, reason: 'the pipe of x~a (pid 5151, mid-turn) closed with no restart intent: Helm closed, crashed or was ended', broker: 1, clis: [{ key: `${s1.id}~a`, sid: s1.id, pid: 5151, busy: true, pending: 0 }] }));
  fs.writeFileSync(path.join(sdir, '2-1-b.json'), JSON.stringify({ at: Date.now() - 30000, reason: 'no Helm re-attached within 60 s of the restart', broker: 1, clis: [{ key: `${s2.id}~k`, sid: s2.id, pid: 5252, busy: true, pending: 0 }] }));

  const b = boot(dir, async function* () { for (const f of F.textTurn('m2', 'ok')) yield f; yield F.result(0.01); });
  const es1 = b.es(s1.id);
  const es2 = b.es(s2.id);
  await waitFor(() => es1.items.some((i) => i.type === 'system' && i.subtype === 'closed-stopped'));
  const line = es1.items.find((i) => i.type === 'system' && i.subtype === 'closed-stopped');
  assert.strictEqual(line.text, 'Stopped when Helm closed');
  assert.match(line.detail, /pid 5151\) was stopped mid-turn: the pipe of .* closed with no restart intent/);
  await waitFor(() => es2.s.restartNote && es2.s.restartNote.reason);
  assert.strictEqual(es2.s.restartNote.reason, 'no Helm re-attached within 60 s of the restart');
  assert.strictEqual(es2.s.kept, undefined);
  assert.deepStrictEqual(fs.readdirSync(sdir), [], 'the stop records are read once');
  assert.ok(!es2.items.some((i) => i.subtype === 'closed-stopped'), 'the kept session says it once (kept-failed), not twice');
  await b.engine.shutdown({ cause: 'quit' });
});
