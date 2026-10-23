'use strict';
// lane stall (2026-10-09): agents stopped by an interrupt, quiet agents, stalled sessions and Resume.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Fleet, tailInfo } = require('../../main/engine/fleet');
const { stallTick, stallSince, resumeStalled } = require('../../main/engine/stall');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const MIN = 60_000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let limits;
test.before(async () => { limits = await import('../../ui/lib/stall-limits.js'); });

const line = (o) => JSON.stringify(o) + '\n';
const asst = (t) => line({ type: 'assistant', isSidechain: true, timestamp: new Date(t).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
const mark = (t, text = '[Request interrupted by user]') => line({ type: 'user', isSidechain: true, timestamp: new Date(t).toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } });

// A fleet whose session dir holds subagents/agent-<id>.jsonl files.
function fleetWithDir() {
  const dir = tmp('helm-stall-sess-');
  fs.mkdirSync(path.join(dir, 'subagents'));
  const changes = [];
  const f = new Fleet('s1', () => changes.push(1));
  f.sessionDir = () => dir;
  const write = (hex, text) => fs.writeFileSync(path.join(dir, 'subagents', `agent-${hex}.jsonl`), text);
  return { f, dir, write, changes };
}

function launch(f, id, hex, t) {
  f.onToolStart({ toolUseId: id, name: 'Agent', status: 'running', startedAt: t, ts: t, input: { description: `[lane:${id}] job`, run_in_background: true } });
  f.onToolEnd({ toolUseId: id, name: 'Agent', status: 'done', startedAt: t, endedAt: t + 50, result: 'Async agent launched successfully.' }, { status: 'async_launched', agentId: hex });
  return f.agents.get(id);
}

test('tailInfo: the interrupt marker as the last line (both wordings); a normal line is not one', () => {
  const dir = tmp('helm-stall-tail-');
  const a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl'), c = path.join(dir, 'c.jsonl');
  const t = Date.UTC(2026, 9, 8, 18, 54, 46);
  fs.writeFileSync(a, asst(t - 5000) + mark(t));
  fs.writeFileSync(b, asst(t - 5000) + mark(t, '[Request interrupted by user for tool use]'));
  fs.writeFileSync(c, mark(t - 9000) + asst(t));
  assert.deepStrictEqual(tailInfo(a), { t, interrupted: true });
  assert.deepStrictEqual(tailInfo(b), { t, interrupted: true });
  assert.deepStrictEqual(tailInfo(c), { t, interrupted: false });
  assert.strictEqual(tailInfo(path.join(dir, 'missing.jsonl')), null);
});

test('live: Claude Code stopping agents right after Helm\'s interrupt = stopped · interrupted; later kills are not', () => {
  const { f } = fleetWithDir();
  const now = Date.now();
  const a = launch(f, 'tA', 'aaaa1111', now - 60_000);
  const b = launch(f, 'tB', 'bbbb2222', now - 60_000);
  const c = launch(f, 'tC', 'cccc3333', now - 60_000);
  assert.strictEqual(f.runningCount(), 3);
  // A kill with no interrupt before it (Claude's own TaskStop): stopped, no reason.
  f.onTask({ subtype: 'task_updated', task_id: 'cccc3333', patch: { status: 'killed', end_time: now - 1000 } });
  assert.strictEqual(c.status, 'stopped');
  assert.strictEqual(c.stopReason, undefined);
  f.onInterrupt(Date.now());
  // What the CLI sent on a real interrupt (tools/stall-live.js, 2026-10-09): killed, then stopped, same ms.
  f.onTask({ subtype: 'task_updated', task_id: 'aaaa1111', patch: { status: 'killed', end_time: now + 5 } });
  f.onTask({ subtype: 'task_notification', task_id: 'aaaa1111', status: 'stopped', tool_use_id: 'tA' });
  f.onTask({ subtype: 'task_notification', task_id: 'bbbb2222', status: 'stopped', tool_use_id: 'tB' });
  f.dispose();
  assert.strictEqual(a.status, 'stopped');
  assert.strictEqual(a.stopReason, 'interrupted');
  assert.strictEqual(a.endedAt, now + 5, 'the notification keeps the killed end time');
  assert.strictEqual(b.status, 'stopped');
  assert.strictEqual(b.stopReason, 'interrupted');
  assert.strictEqual(f.runningCount(), 0, 'they leave the running count');
  assert.match(limits.agentStateText(a), /^Stopped \d\d:\d\d · interrupted$/);
});

test('sweep: the interrupt marker in a running agent\'s own transcript stops it at that second', () => {
  const { f, write, changes } = fleetWithDir();
  const t0 = Date.now() - 5 * MIN;
  const a = launch(f, 'tA', 'aaaa1111', t0);
  const b = launch(f, 'tB', 'bbbb2222', t0);
  const stopAt = t0 + 3 * MIN;
  write('aaaa1111', asst(t0 + MIN) + mark(stopAt));
  write('bbbb2222', asst(t0 + 2 * MIN));
  changes.length = 0;
  assert.strictEqual(f.sweep(), true);
  assert.strictEqual(a.status, 'stopped');
  assert.strictEqual(a.stopReason, 'interrupted');
  assert.strictEqual(a.endedAt, stopAt);
  assert.strictEqual(a.endEstimated, undefined, 'the marker time is exact');
  assert.strictEqual(b.status, 'running');
  assert.strictEqual(b.lastActivityAt, t0 + 2 * MIN, 'its newest line is its last sign of life');
  assert.strictEqual(b.quiet, undefined);
  assert.ok(changes.length > 0, 'emits');
  // A marker from BEFORE a SendMessage resume does not stop the new run.
  f._resume(a, Date.now());
  f.sweep();
  assert.strictEqual(a.status, 'running');
});

test('quiet: no transcript write or stream event for 10 min = "No activity", still running; any sign of life clears it', () => {
  const { f, write } = fleetWithDir();
  const now = Date.now();
  const a = launch(f, 'tA', 'aaaa1111', now - 30 * MIN);
  write('aaaa1111', asst(now - 12 * MIN));
  f.sweep(now - 3 * MIN);
  assert.strictEqual(a.quiet, undefined, '9 minutes is not quiet yet');
  f.sweep(now);
  assert.strictEqual(a.quiet, true);
  assert.strictEqual(a.status, 'running', 'maybe stalled, not stopped');
  assert.strictEqual(f.runningCount(), 1);
  assert.strictEqual(f.quietCount(), 1);
  assert.strictEqual(limits.agentStateText(a, now), 'No activity 12m');
  assert.strictEqual(limits.AGENT_QUIET_MS, 10 * MIN);
  // A tool_progress heartbeat for it ends the quiet spell.
  f.onToolProgress({ type: 'tool_progress', parent_tool_use_id: 'tA', tool_use_id: 'x', elapsed_time_seconds: 3 });
  assert.strictEqual(a.quiet, undefined);
  assert.strictEqual(f.quietCount(), 0);
  // No transcript at all: quiet counts from its start.
  const b = launch(f, 'tB', 'bbbb2222', now - 11 * MIN);
  f.sweep(now);
  assert.strictEqual(b.quiet, true);
  f.onToolStart({ toolUseId: 'c1', name: 'Bash', parentToolUseId: 'tB', status: 'running', startedAt: now, ts: now, input: {} });
  assert.strictEqual(b.quiet, undefined, 'a child tool is a sign of life');
});

test('rebuild: a replayed background agent whose transcript ends with the marker is stopped · interrupted', () => {
  const { f, write } = fleetWithDir();
  const t0 = Date.UTC(2026, 9, 8, 18, 0, 0);
  write('aaaa1111', asst(t0 + MIN) + mark(t0 + 54 * MIN));
  write('bbbb2222', asst(t0 + 2 * MIN));
  const items = [
    { type: 'tool', toolUseId: 'tA', name: 'Agent', status: 'done', startedAt: t0, endedAt: t0 + 50, ts: t0, input: { description: 'a', run_in_background: true }, result: 'Async agent launched successfully.\nagentId: aaaa1111 (internal)' },
    { type: 'tool', toolUseId: 'tB', name: 'Agent', status: 'done', startedAt: t0, endedAt: t0 + 50, ts: t0, input: { description: 'b', run_in_background: true }, result: 'Async agent launched successfully.\nagentId: bbbb2222 (internal)' },
  ];
  f.rebuild(items);
  const a = f.agents.get('tA'), b = f.agents.get('tB');
  assert.strictEqual(a.status, 'stopped');
  assert.strictEqual(a.stopReason, 'interrupted');
  assert.strictEqual(a.endedAt, t0 + 54 * MIN);
  assert.strictEqual(a.endEstimated, undefined);
  assert.strictEqual(b.status, 'stopped');
  assert.strictEqual(b.stopReason, undefined, 'no marker: stopped with no completion record, reason unknown');
  assert.strictEqual(b.endEstimated, true);
});

test('stopAll: the CLI going away says why (closed / exited); an interrupt just before wins', () => {
  const { f } = fleetWithDir();
  const now = Date.now();
  const a = launch(f, 'tA', 'aaaa1111', now - MIN);
  f.stopAll('error', 'closed');
  assert.strictEqual(a.stopReason, 'closed');
  assert.strictEqual(limits.agentStateText({ ...a, endedAt: Date.UTC(2026, 9, 8, 1, 54) }).replace(/\d\d:\d\d/, 'HH:MM'), 'Stopped HH:MM · session closed');
  const b = launch(f, 'tB', 'bbbb2222', now - MIN);
  f.onInterrupt();
  f.stopAll('error', 'exited');
  f.dispose();
  assert.strictEqual(b.stopReason, 'interrupted');
});

// ---------- sessions: stalledSince + Resume ----------

function fakeSession({ status = 'working', lastEventAt, turnStartedAt, answer = true } = {}) {
  const calls = [];
  const es = {
    q: {}, turnActive: status === 'working' || status === 'waiting',
    s: { status, turnStartedAt },
    lastEventAt,
    fleet: null,
    stalledSince: null,
    emits: 0,
    _emitUpdated() { this.emits++; },
    async interrupt() {
      calls.push('interrupt');
      setTimeout(() => { if (answer) this.lastEventAt = Date.now(); this.turnActive = false; this.s.status = 'idle'; }, 20);
      return {};
    },
    async close(o) { calls.push(['close', o]); this.q = null; },
    async send(p) { calls.push(['send', p]); return { itemId: 'u9', queued: false }; },
  };
  return { es, calls };
}

test('stallSince / stallTick: working + no SDK message for 10 min = stalledSince; waiting or idle never', () => {
  const now = Date.now();
  const { es } = fakeSession({ lastEventAt: now - 12 * MIN, turnStartedAt: now - 20 * MIN });
  assert.strictEqual(stallSince(es, now - 3 * MIN), null, '9 minutes is not a stall');
  stallTick(es, now);
  assert.strictEqual(es.stalledSince, now - 12 * MIN);
  assert.strictEqual(es.emits, 1);
  stallTick(es, now + 1000);
  assert.strictEqual(es.emits, 1, 'no repeat emit while it stays stalled');
  assert.strictEqual(limits.stallText({ status: 'working', stalledSince: es.stalledSince }, now), 'Stalled · 12m');
  assert.strictEqual(limits.SESSION_STALL_MS, 10 * MIN);
  const w = fakeSession({ status: 'waiting', lastEventAt: now - 60 * MIN }).es;
  assert.strictEqual(stallSince(w, now), null, 'waiting on the user is not a stall');
  const i = fakeSession({ status: 'idle', lastEventAt: now - 60 * MIN }).es;
  assert.strictEqual(stallSince(i, now), null);
  es.lastEventAt = now; // a message arrived
  stallTick(es, now + 2000);
  assert.strictEqual(es.stalledSince, null);
});

test('resumeStalled: refuses a turn that is streaming; interrupts + sends "Continue where you left off." with origin helm', async () => {
  const now = Date.now();
  const ok = fakeSession({ lastEventAt: now - 2 * MIN, turnStartedAt: now - 20 * MIN });
  const r0 = await resumeStalled(ok.es);
  assert.strictEqual(r0.action, 'none');
  assert.strictEqual(r0.reason, 'not_stalled');
  assert.deepStrictEqual(ok.calls, [], 'a healthy turn is never touched');

  const hung = fakeSession({ lastEventAt: now - 15 * MIN, turnStartedAt: now - 20 * MIN });
  const r1 = await resumeStalled(hung.es, { waitMs: 2000 });
  assert.strictEqual(r1.action, 'continued');
  assert.strictEqual(r1.restarted, false);
  assert.strictEqual(r1.itemId, 'u9');
  assert.deepStrictEqual(hung.calls, ['interrupt', ['send', { text: 'Continue where you left off.', origin: 'helm' }]]);

  // The CLI never answers the interrupt: it is closed, and the send starts a fresh one.
  const dead = fakeSession({ lastEventAt: now - 15 * MIN, turnStartedAt: now - 20 * MIN, answer: false });
  const r2 = await resumeStalled(dead.es, { waitMs: 2000 });
  assert.strictEqual(r2.action, 'continued');
  assert.strictEqual(r2.restarted, true);
  assert.deepStrictEqual(dead.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['interrupt', 'close', 'send']);
  assert.deepStrictEqual(dead.calls[1][1], { final: false });
});

test('engine: a hung turn shows stalledSince on the session; Helm\'s interrupt stops its background agent as interrupted', async () => {
  const userDataDir = tmp('helm-stall-ud-');
  const cwd = tmp('helm-stall-cwd-');
  const events = [];
  const sdk = createFakeSdk(async function* (um, api) {
    yield F.toolUse('m1', 'tA', 'Agent', { description: '[lane:x] long job', subagent_type: 'opus-high', prompt: 'p', run_in_background: true });
    yield F.toolResult('tA', 'Async agent launched successfully.\nagentId: aaaa1111bbbb (internal)', { structured: { isAsync: true, status: 'async_launched', agentId: 'aaaa1111bbbb' } });
    yield { type: 'system', subtype: 'task_started', task_id: 'aaaa1111bbbb', task_type: 'local_agent', is_backgrounded: true, tool_use_id: 'tA', description: '[lane:x] long job' };
    while (!api.state.interrupted && !api.state.closed) await sleep(10);   // hangs until interrupted
    yield { type: 'system', subtype: 'task_updated', task_id: 'aaaa1111bbbb', patch: { status: 'killed', end_time: Date.now() } };
    yield { type: 'system', subtype: 'task_notification', task_id: 'aaaa1111bbbb', status: 'stopped', tool_use_id: 'tA' };
  });
  const engine = createEngine({ userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir: tmp('helm-stall-proj-'), statuslineDir: tmp('helm-stall-sl-'), etaDir: false, external: false, usageSampling: false });
  try {
    const m = engine.methods;
    const s = await m['sessions.create']({ cwd });
    await m['sessions.send']({ id: s.id, text: 'go' });
    const es = engine._internal.sessions.get(s.id);
    const t0 = Date.now();
    while (es.fleet.runningCount() < 1 && Date.now() - t0 < 3000) await sleep(5);
    assert.strictEqual(es.publicSession().status, 'working');
    assert.strictEqual(es.publicSession().stalledSince, null);
    // Ten silent minutes (the clock moved, not the stream).
    stallTick(es, Date.now() + 11 * MIN);
    const pub = es.publicSession();
    assert.ok(pub.stalledSince > 0, 'stalledSince is published');
    assert.strictEqual(pub.agentsQuiet, 1, 'its agent has been quiet just as long');
    await sleep(150);
    const upd = [...events].reverse().find((e) => e.event === 'session.updated' && e.data.id === s.id);
    assert.ok(upd.data.stalledSince > 0, 'session.updated carries stalledSince');
    // The user presses Stop. With an agent running, a plain interrupt is refused (lane steer) and names it.
    await assert.rejects(m['sessions.interrupt']({ id: s.id }), (e) => e.code === 'agents_running' && e.data.agents.length === 1);
    assert.ok(es.turnActive && es.fleet.runningCount() === 1, 'a refused Stop touches nothing');
    // He confirms "Stop all".
    await m['sessions.interrupt']({ id: s.id, stopAgents: true });
    const t1 = Date.now();
    while ((es.turnActive || es.fleet.runningCount()) && Date.now() - t1 < 3000) await sleep(5);
    await sleep(200);
    const a = es.fleet.list()[0];
    assert.strictEqual(a.status, 'stopped');
    assert.strictEqual(a.stopReason, 'interrupted');
    const after = es.publicSession();
    assert.strictEqual(after.agentsRunning, 0);
    assert.strictEqual(after.agentsQuiet, 0);
    assert.strictEqual(after.stalledSince, null);
    const fl = [...events].reverse().find((e) => e.event === 'fleet.updated' && e.data.sessionId === s.id);
    assert.strictEqual(fl.data.agents[0].stopReason, 'interrupted', 'fleet.updated carries stopReason');
  } finally {
    await engine.shutdown();
  }
});
