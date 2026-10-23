'use strict';
// lane detach: the CLI broker with the REAL Agent SDK and a fake claude.exe (fixtures/fake-cli.js).
//   1. keep: a CLI started through the broker (on Windows via the job-breakaway launcher) runs a turn; the host
//      detaches mid-turn (a Helm restart) before the CLI's PreToolUse hook call; a NEW query() re-attaches to the
//      SAME process, the broker reports the CLI's verdict on the repeated initialize (reinit ok, hooks applied),
//      the new host answers the hook call, the turn and a second turn finish, cost keeps counting; then the new
//      host's pipe closes with no new intent (the first one was used up): full stop, the broker exits and removes
//      its state file, and the stop is recorded for the next Helm
//   2. refused: a CLI that does not confirm the new hooks -> reinit not ok (Helm falls back); end() stops it.
//      Two spawns for the same session (a rewind) live side by side under their own keys.
//   3. handover: a broker from an older broker.js (another stamp) is listed as not current and drains
//   4-7. The user's rule (2026-10-15): sessions survive ONLY a restart Helm performs (the restart intent). Raw CLIs
//      (no SDK): a pipe close with no intent stops every CLI and the broker; a detach with no intent ends that CLI;
//      an intent nobody re-attaches to runs out and stops everything; an intent is single-use; Quit stops all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createBrokerClient } = require('../../main/engine/broker-client');
const { STAMP, STATE_DIR, STOPS_DIR } = require('../../main/engine/broker');
const { jobSafe } = require('../../main/engine/broker-launch');
const { PushStream } = require('../../main/engine/util');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const textOf = (m) => (m.type === 'assistant' ? m.message.content.map((c) => c.text || '').join('') : m.type === 'result' ? m.result : '');
const brokerEnv = { ...process.env, HELM_BROKER_IDLE_EXIT_MS: '1500', HELM_BROKER_SWEEP_MS: '250' };
const kill = (pid) => { if (pid && alive(pid)) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } };
const stateOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_DIR, `${STAMP}.json`), 'utf8')); } catch { return null; } };

test('broker keep: detach mid-turn, re-attach with a new SDK query (reinit verdict), then a close with no intent stops everything', { timeout: 90000 }, async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-broker-test-'));
  const broker = createBrokerClient({ stateDir, execPath: process.execPath, env: brokerEnv });
  const cliEnv = { ...process.env, FAKE_STEPS: '5', FAKE_STEP_MS: '400', FAKE_HOOK_AT: '3', FAKE_COST_BASE: '1.5' };
  let brokerPid = null;
  try {
    // 1. first host
    const hook1 = [];
    let proc1 = null;
    const in1 = new PushStream();
    const q1 = sdk.query({ prompt: in1, options: {
      pathToClaudeCodeExecutable: FAKE,
      hooks: { PreToolUse: [{ hooks: [async () => { hook1.push(Date.now()); return { continue: true }; }] }] },
      spawnClaudeCodeProcess: (o) => (proc1 = broker.spawnProcess({ key: 's1~a', sid: 's1', meta: { sdk: 'test-sdk', claudePath: null } }, { ...o, command: process.execPath, args: [FAKE], env: cliEnv })),
    } });
    in1.push({ type: 'user', message: { role: 'user', content: 'turn one' }, parent_tool_use_id: null });
    for await (const m of q1) {
      // Helm restarts after the first step: detach FIRST (engine.shutdown -> detachCli), so the SDK's close path
      // that leaving the loop runs (stdin end, kill after its grace) goes quiet instead of ending the CLI
      if (/^step 1\//.test(textOf(m))) {
        assert.ok((await broker.keepForRestart([proc1])).has(proc1), 'the broker took the restart intent');
        assert.ok(proc1.detach(), 'detached');
        break;
      }
    }
    assert.ok(proc1 && proc1.pid, 'the broker reported the CLI pid');
    const cliPid = proc1.pid;
    try { q1.close(); } catch {}
    const st = stateOf(stateDir);
    assert.ok(st && st.pid && st.v === 2 && st.stamp === STAMP, 'the broker wrote brokers/<stamp>.json');
    brokerPid = st.pid;
    const job = broker.job();
    assert.ok(job, 'the launch reported a job state');
    if (process.platform === 'win32') {
      assert.strictEqual(job.method, 'launcher', `launched by the breakaway launcher: ${JSON.stringify(job)}`);
      // in a job that allows breakaway (or none) the broker must end up outside every job
      if (!job.parentInJob || job.brokeAway) assert.strictEqual(jobSafe(job), true, JSON.stringify(job));
      else assert.strictEqual(jobSafe(job), false, `stuck in a job: reported as not safe ${JSON.stringify(job)}`);
      assert.deepStrictEqual(stateOf(stateDir).job, job, 'the job state is recorded in the state file (setjob)');
    }
    await sleep(2500); // the turn reaches its hook call (step 3) with no host attached, and blocks there
    assert.ok(alive(cliPid), 'the CLI kept running after the host let go');
    const listed = await broker.list();
    assert.strictEqual(listed.length, 1);
    const entry = listed[0];
    assert.strictEqual(entry.key, 's1~a');
    assert.strictEqual(entry.sid, 's1');
    assert.strictEqual(entry.attached, false);
    assert.strictEqual(entry.busy, true, 'mid-turn');
    assert.strictEqual(entry.pending, 1, 'one hook call waits for a host');
    assert.strictEqual(entry.cliVersion, '2.1.295', 'the CLI version from system init');
    assert.strictEqual(entry.claudeSessionId, `fake-${cliPid}`, 'the conversation id from system init');
    assert.deepStrictEqual(entry.meta, { sdk: 'test-sdk', claudePath: null }, 'the spawning Helm\'s meta comes back');
    assert.strictEqual(entry.broker.current, true);
    assert.strictEqual(entry.broker.compatible, true);

    // 2. second host re-attaches
    const hook2 = [];
    const reinits = [];
    const in2 = new PushStream();
    let proc2 = null;
    const q2 = sdk.query({ prompt: in2, options: {
      pathToClaudeCodeExecutable: FAKE,
      hooks: { PreToolUse: [{ hooks: [async () => { hook2.push(Date.now()); return { continue: true }; }] }] },
      spawnClaudeCodeProcess: () => (proc2 = broker.attachProcess(entry, { onReinit: (r) => reinits.push(r) })),
    } });
    const seen2 = [];
    const costs = [];
    let results = 0;
    let lastCost = null;
    for await (const m of q2) {
      const t = textOf(m);
      if (t) seen2.push(t);
      if (m.type === 'result') {
        costs.push(m.total_cost_usd);
        results++;
        if (results === 1) in2.push({ type: 'user', message: { role: 'user', content: 'turn two' }, parent_tool_use_id: null }); // stdin works
        else {
          lastCost = (await broker.list())[0].lastCost;
          proc2._sock.destroy(); // the new Helm goes away with no intent (crash, End task, Windows shutdown)
          break;
        }
      }
    }
    assert.strictEqual(proc2.pid, cliPid, 're-attached to the same claude process');
    assert.strictEqual(reinits.length, 1, 'one reinit verdict');
    assert.strictEqual(reinits[0].ok, true, JSON.stringify(reinits[0]));
    assert.strictEqual(reinits[0].hooksApplied, true);
    assert.strictEqual(hook1.length, 0, 'the first host never saw the hook call');
    assert.strictEqual(hook2.length, 2, 'the re-attached host answered the pending hook call and the next turn\'s');
    const steps = seen2.filter((t) => /^step /.test(t));
    assert.ok(steps.some((t) => /^step 3\/5 /.test(t) && / hook:retry hook:success re: turn one/.test(t)), `step 3 ran after the re-attached host answered: ${JSON.stringify(steps)}`);
    assert.ok(steps.some((t) => /^step 5\/5 /.test(t) && t.includes(`pid ${cliPid}`)), 'the rest of turn one came from the same process');
    assert.ok(seen2.some((t) => t === `done pid ${cliPid} inits 2`), 'turn one result');
    assert.ok(steps.some((t) => /re: turn two/.test(t)), 'turn two ran (stdin after re-attach)');
    assert.deepStrictEqual(costs, [1.51, 1.52], 'the same CLI keeps its cumulative cost counter');
    assert.strictEqual(lastCost, 1.52, 'the broker notes the last total it saw');

    // 3. the intent was used by the re-attach: this pipe close has none -> full stop within 8 s
    const t0 = Date.now();
    try { q2.close(); } catch {}
    for (const end = Date.now() + 8000; Date.now() < end && (alive(cliPid) || alive(brokerPid)); await sleep(100));
    assert.ok(!alive(cliPid), 'the CLI was stopped');
    assert.ok(!alive(brokerPid), 'the broker exited');
    assert.ok(Date.now() - t0 < 8000, `all gone in ${Date.now() - t0} ms`);
    assert.ok(!stateOf(stateDir), 'state file removed');
    const stops = broker.takeStops();
    assert.strictEqual(stops.length, 1, 'one stop recorded for the next Helm');
    assert.deepStrictEqual(stops[0].clis.map((c) => [c.key, c.sid, c.pid]), [['s1~a', 's1', cliPid]]);
    assert.match(stops[0].reason, /closed with no restart intent/);
    assert.deepStrictEqual(broker.takeStops(), [], 'read once');
    const log = fs.readFileSync(path.join(stateDir, 'logs', 'broker.log'), 'utf8');
    assert.match(log, /forwarded initialize to the CLI; replayed \d+ line\(s\); 1 control request\(s\) were pending/);
    assert.match(log, /re-initialize s1~a: success, hooks_applied true, pending_permission_requests 0/);
    assert.match(log, /restart intent: keep s1~a for 60 s/);
    assert.match(log, /restart intent for s1~a used: re-attached/);
    assert.match(log, /FULL STOP: the pipe of s1~a .*closed with no restart intent/);
  } finally {
    kill(brokerPid);
    await sleep(300);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }
});

test('broker refused: a CLI that does not confirm the hooks -> reinit not ok; end() stops it; two keys per session', { timeout: 60000 }, async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-broker-test-'));
  // plain Node launch here (the launcher is covered above): faster, and the job state is then unknown
  const broker = createBrokerClient({ stateDir, execPath: process.execPath, env: brokerEnv, launch: (o) => require('../../main/engine/broker-launch').launchBroker({ ...o, useLauncher: false }) });
  const cliEnv = { ...process.env, FAKE_STEPS: '1', FAKE_STEP_MS: '50', FAKE_HOOK_AT: '0', FAKE_HOOKS_APPLIED: '0' };
  let brokerPid = null;
  const extra = [];
  try {
    let proc1 = null;
    const in1 = new PushStream();
    const q1 = sdk.query({ prompt: in1, options: {
      pathToClaudeCodeExecutable: FAKE,
      spawnClaudeCodeProcess: (o) => (proc1 = broker.spawnProcess({ key: 's2~a', sid: 's2', meta: {} }, { ...o, command: process.execPath, args: [FAKE], env: cliEnv })),
    } });
    in1.push({ type: 'user', message: { role: 'user', content: 'one' }, parent_tool_use_id: null });
    for await (const m of q1) if (m.type === 'result') { assert.ok((await broker.keepForRestart([proc1])).has(proc1)); proc1.detach(); break; }
    try { q1.close(); } catch {}
    brokerPid = stateOf(stateDir).pid;
    assert.strictEqual(jobSafe(broker.job()), process.platform === 'win32' ? null : true, 'plain Node launch: job state unknown on Windows');

    // a second CLI for the same session (a rewind starting while the old one still exits) gets its own key
    const p2 = broker.spawnProcess({ key: 's2~b', sid: 's2', meta: {} }, { command: process.execPath, args: [FAKE], cwd: process.cwd(), env: cliEnv });
    for (const end = Date.now() + 5000; Date.now() < end && !p2.pid; await sleep(50));
    assert.ok(p2.pid && p2.pid !== proc1.pid, 'both CLIs run side by side');
    extra.push(p2.pid);
    assert.ok((await broker.keepForRestart([p2])).has(p2));
    p2.detach();

    const entry = (await broker.list()).find((e) => e.key === 's2~a');
    const reinits = [];
    const q2 = sdk.query({ prompt: new PushStream(), options: {
      pathToClaudeCodeExecutable: FAKE,
      spawnClaudeCodeProcess: () => broker.attachProcess(entry, { onReinit: (r) => reinits.push(r) }),
    } });
    const it = q2[Symbol.asyncIterator]();
    const first = it.next().catch(() => null);
    for (const end = Date.now() + 8000; Date.now() < end && !reinits.length; await sleep(50));
    assert.strictEqual(reinits.length, 1, 'the verdict arrived');
    assert.strictEqual(reinits[0].ok, false, 'hooks not confirmed -> not ok');
    assert.strictEqual(reinits[0].hooksApplied, false);

    // Helm falls back: it ends the CLI through the broker (before its own query closes stdin)
    const r = await broker.end(entry, 'test: hooks not applied');
    assert.strictEqual(r && r.found, true);
    try { q2.close(); } catch {}
    await first;
    for (const end = Date.now() + 8000; Date.now() < end && alive(entry.pid); await sleep(100));
    assert.ok(!alive(entry.pid), 'end() stopped the CLI');
    const log = fs.readFileSync(path.join(stateDir, 'logs', 'broker.log'), 'utf8');
    assert.match(log, /re-initialize s2~a: success, hooks_applied false/);
    assert.match(log, /end s2~a .*test: hooks not applied/);
  } finally {
    for (const p of extra) kill(p);
    kill(brokerPid);
    await sleep(300);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }
});

test('broker handover: a broker from an older broker.js is listed as not current and drains', { timeout: 30000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-broker-test-'));
  const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-broker-old-'));
  // the "old" broker: the same code with one more line, so another STAMP (pipe name + state file)
  const oldJs = path.join(codeDir, 'broker.js');
  fs.writeFileSync(oldJs, fs.readFileSync(require.resolve('../../main/engine/broker'), 'utf8') + '\n// an older broker.js\n');
  const child = spawn(process.execPath, [oldJs, stateDir], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...brokerEnv, HELM_BROKER_IDLE_EXIT_MS: '600000' } });
  child.unref();
  const oldPid = child.pid;
  try {
    let old = null;
    for (const end = Date.now() + 8000; Date.now() < end && !old; await sleep(100)) {
      try { old = fs.readdirSync(path.join(stateDir, STATE_DIR)).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(stateDir, STATE_DIR, n), 'utf8'))).find((s) => s.pid === oldPid) || null; } catch {}
    }
    assert.ok(old, 'the old broker wrote its state file');
    assert.notStrictEqual(old.stamp, STAMP, 'another stamp');
    const broker = createBrokerClient({ stateDir, execPath: process.execPath, env: brokerEnv });
    assert.strictEqual(broker.running(), false, 'an older broker is not this Helm\'s broker');
    const st = await broker.status();
    assert.deepStrictEqual(st.map((b) => [b.pid, b.current, b.draining]), [[oldPid, false, false]]);
    assert.deepStrictEqual(await broker.drainOld(), [oldPid]);
    const after = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_DIR, `${old.stamp}.json`), 'utf8'));
    assert.strictEqual(after.draining, true, 'state file says draining');
    assert.deepStrictEqual(await broker.drainOld(), [], 'asked once');
    const log = fs.readFileSync(path.join(stateDir, 'logs', 'broker.log'), 'utf8');
    assert.match(log, /draining: a newer broker takes new CLIs/);
  } finally {
    kill(oldPid);
    await sleep(300);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(codeDir, { recursive: true, force: true }); } catch {}
  }
});

// ---- The user's rule: sessions survive ONLY a restart Helm performs ----
// Raw CLIs through the broker (no SDK; plain Node launch for speed). The fake CLI exits on stdin EOF unless
// FAKE_IGNORE_EOF=1 (then the broker must kill its tree 5 s later): every "all gone" bound below is 8 s.
const GONE_MS = 8000;
const rawBroker = () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-broker-test-'));
  const broker = createBrokerClient({ stateDir, execPath: process.execPath, env: brokerEnv, launch: (o) => require('../../main/engine/broker-launch').launchBroker({ ...o, useLauncher: false }) });
  return { stateDir, broker };
};
async function rawSpawn(broker, key, extraEnv = {}) {
  const p = broker.spawnProcess({ key, sid: key.split('~')[0], meta: {} }, { command: process.execPath, args: [FAKE], cwd: process.cwd(), env: { ...process.env, ...extraEnv } });
  for (const end = Date.now() + 8000; Date.now() < end && !p.pid; await sleep(25));
  assert.ok(p.pid, `${key} started`);
  return p;
}
async function rawAttach(broker, key) {
  const entry = (await broker.list()).find((e) => e.key === key);
  assert.ok(entry, `${key} listed`);
  const p = broker.attachProcess(entry);
  for (const end = Date.now() + 5000; Date.now() < end && !p.pid; await sleep(25));
  assert.strictEqual(p.pid, entry.pid, `re-attached to ${key}`);
  return p;
}
async function allGone(pids, ms = GONE_MS) {
  const t0 = Date.now();
  for (const end = t0 + ms; Date.now() < end && pids.some(alive); await sleep(50));
  return { gone: !pids.some(alive), ms: Date.now() - t0 };
}
const brokerLog = (dir) => { try { return fs.readFileSync(path.join(dir, 'logs', 'broker.log'), 'utf8'); } catch { return ''; } };
const logShows = async (dir, re, ms) => {   // poll the broker log until a line matches (true) or ms runs out (false)
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (re.test(brokerLog(dir))) return true;
  return re.test(brokerLog(dir));
};
const cleanup = async (dir, pids) => { for (const p of pids) kill(p); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

test('broker close: a pipe close with no intent stops EVERY CLI (a hung one by PID) and the broker; a detach with no intent ends that CLI', { timeout: 40000 }, async () => {
  const { stateDir, broker } = rawBroker();
  const pids = [];
  try {
    const a = await rawSpawn(broker, 'c1~a');
    const b = await rawSpawn(broker, 'c2~a', { FAKE_IGNORE_EOF: '1' }); // ignores stdin EOF
    const c = await rawSpawn(broker, 'c3~a');
    const brokerPid = stateOf(stateDir).pid;
    pids.push(a.pid, b.pid, c.pid, brokerPid);
    // a detach with no restart intent: that CLI ends, nothing else
    assert.ok(c.detach());
    assert.ok((await allGone([c.pid])).gone, 'detach without intent ended c3');
    // The OS process goes before the broker reaps it (its child 'exit' event): until then c3 is still one of the
    // broker's children, and a close now would count it in the full stop ("ending 3 CLI(s)"; seen 2026-10-16 in the
    // full engine run). Wait for the broker's own exit line, so the close below starts from 2 live CLIs.
    assert.ok(await logShows(stateDir, /exit c3~a pid \d+/, 5000), 'the broker reaped c3 before the close');
    assert.ok(alive(a.pid) && alive(b.pid) && alive(brokerPid), 'the others still run');
    // Helm goes away (crash, End task, Windows shutdown): ONE pipe closing is enough
    a._sock.destroy();
    const r = await allGone([a.pid, b.pid, brokerPid]);
    assert.ok(r.gone, `every CLI and the broker gone within ${GONE_MS} ms (took ${r.ms} ms)`);
    assert.ok(!stateOf(stateDir), 'state file removed');
    const log = brokerLog(stateDir);
    assert.match(log, /detach c3~a with no restart intent: ending it/);
    assert.match(log, /FULL STOP: the pipe of c1~a .*closed with no restart intent: Helm closed, crashed or was ended; ending 2 CLI\(s\)/);
    assert.match(log, /kill c2~a pid \d+: full stop.*still running 5 s after stdin closed/);
    const stops = broker.takeStops();
    assert.deepStrictEqual(stops.flatMap((x) => x.clis.map((cl) => cl.key)).sort(), ['c1~a', 'c2~a'], 'both recorded for the next Helm');
  } finally { await cleanup(stateDir, pids); }
});

test('broker deadline: an intent nobody re-attaches to runs out -> every CLI and the broker gone', { timeout: 30000 }, async () => {
  const { stateDir, broker } = rawBroker();
  const pids = [];
  try {
    const a = await rawSpawn(broker, 'd1~a');
    const b = await rawSpawn(broker, 'd2~a');
    const brokerPid = stateOf(stateDir).pid;
    pids.push(a.pid, b.pid, brokerPid);
    const ok = await broker.keepForRestart([a, b], 1500);
    assert.strictEqual(ok.size, 2);
    const t0 = Date.now();
    assert.ok(a.detach() && b.detach());
    await sleep(700);
    assert.ok(alive(a.pid) && alive(b.pid), 'kept while the intent runs');
    const r = await allGone([a.pid, b.pid, brokerPid], 1500 + GONE_MS);
    assert.ok(r.gone, `all gone ${Date.now() - t0} ms after the detach (deadline 1500 ms + ${GONE_MS} ms)`);
    assert.ok(Date.now() - t0 >= 1400, 'not before the deadline');
    assert.match(brokerLog(stateDir), /FULL STOP: no Helm re-attached within \d+ s of the restart; ending 2 CLI\(s\)/);
    const stops = broker.takeStops();
    assert.strictEqual(stops.length, 1);
    assert.match(stops[0].reason, /no Helm re-attached within/);
  } finally { await cleanup(stateDir, pids); }
});

test('broker intent: re-attach keeps the CLI and uses the intent up; the next close with no intent stops everything at once', { timeout: 40000 }, async () => {
  const { stateDir, broker } = rawBroker();
  const pids = [];
  try {
    const a = await rawSpawn(broker, 'e1~a');
    const b = await rawSpawn(broker, 'e2~a');
    const brokerPid = stateOf(stateDir).pid;
    pids.push(a.pid, b.pid, brokerPid);
    assert.strictEqual((await broker.keepForRestart([a, b], 60000)).size, 2);
    a.detach();
    b._sock.destroy(); // a pipe the restarting Helm closed before its detach frame: still covered by the intent
    await sleep(600);
    assert.ok(alive(a.pid) && alive(b.pid) && alive(brokerPid), 'both kept through the restart');
    // the new Helm re-attaches to e1 (its intent is used up); e2's intent still runs
    const a2 = await rawAttach(broker, 'e1~a');
    await sleep(600);
    assert.ok(alive(a.pid), 'kept after the re-attach');
    assert.match(brokerLog(stateDir), /restart intent for e1~a used: re-attached \d+ s after it was sent; 1 still to come/);
    // the new Helm goes away with no new intent: full stop NOW, not at e2's 60 s deadline
    a2._sock.destroy();
    const r = await allGone([a.pid, b.pid, brokerPid]);
    assert.ok(r.gone, `all gone within ${GONE_MS} ms of the second close (took ${r.ms} ms)`);
    assert.match(brokerLog(stateDir), /FULL STOP: the pipe of e1~a .*closed with no restart intent/);
  } finally { await cleanup(stateDir, pids); }
});

test('broker quit: stdin EOF + shutdownAll (engine Quit) -> every CLI (a hung one by PID) and the broker gone; no stop record', { timeout: 30000 }, async () => {
  const { stateDir, broker } = rawBroker();
  const pids = [];
  try {
    const a = await rawSpawn(broker, 'q1~a');
    const b = await rawSpawn(broker, 'q2~a', { FAKE_IGNORE_EOF: '1' });
    const brokerPid = stateOf(stateDir).pid;
    pids.push(a.pid, b.pid, brokerPid);
    // engine.shutdown({ cause: 'quit' }): each session closes (stdin EOF), then every broker is shut down
    a.stdin.end();
    b.stdin.end();
    await sleep(100);
    assert.deepStrictEqual(await broker.shutdownAll('Helm quit'), [brokerPid]);
    // main.js then exits: the pipes close (CLIs already ending: no full stop, no record)
    for (const p of [a, b]) { try { p._sock.destroy(); } catch {} }
    const r = await allGone([a.pid, b.pid, brokerPid]);
    assert.ok(r.gone, `all gone within ${GONE_MS} ms (took ${r.ms} ms)`);
    const log = brokerLog(stateDir);
    assert.match(log, /shutdown asked: Helm quit/);
    assert.match(log, /kill q2~a pid \d+: .*still running 5 s after stdin closed/);
    assert.doesNotMatch(log, /FULL STOP/);
    assert.deepStrictEqual(broker.takeStops(), [], 'Helm noted what a quit stopped itself');
  } finally { await cleanup(stateDir, pids); }
});
