'use strict';
// Correctness/security review of main/engine (2026-10-08): each test proves one bug that was fixed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createEngine } = require('../../main/engine');
const { findTranscript } = require('../../main/engine/transcript');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(turn, opts = {}) {
  const userDataDir = opts.userDataDir || tmp('helm-rv-');
  const cwd = opts.cwd || tmp('helm-rvcwd-');
  const projectsDir = opts.projectsDir || tmp('helm-rvproj-');
  const events = [];
  const logs = [];
  const sdk = opts.sdk || createFakeSdk(turn, { projectsDir });
  const engine = createEngine({ userDataDir, emit: (event, data) => events.push({ event, data }), log: (level, msg) => logs.push({ level, msg }), sdk, claudePath: null, projectsDir, statuslineDir: tmp('helm-rvsl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
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
  return { engine, m: engine.methods, events, logs, sdk, waitFor, userDataDir, cwd, projectsDir, es };
}

function writeTranscript(projectsDir, cwd, sessionId) {
  const dir = path.join(projectsDir, String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', uuid: 'a1', parentUuid: null, sessionId, cwd, timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'hello there' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', sessionId, cwd, timestamp: '2026-10-01T10:00:01Z', message: { id: 'm1', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ];
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('sessions.json: a corrupt file is moved aside (not silently overwritten with an empty list)', async () => {
  for (const bad of ['{"version":1,"sessions":[{"id":"s_1","cwd":"C:\\\\x","tit', 'garbage{', '']) {
    const userDataDir = tmp('helm-rvcorrupt-');
    fs.writeFileSync(path.join(userDataDir, 'sessions.json'), bad);
    const h = harness(async function* () {}, { userDataDir });
    await h.m['sessions.create']({ cwd: h.cwd }); // triggers a save
    await h.engine.shutdown();
    const kept = fs.readdirSync(userDataDir).filter((f) => f.startsWith('sessions.json.bad-'));
    if (bad === '') {
      assert.strictEqual(kept.length, 0, 'an empty file has nothing worth keeping');
      continue;
    }
    assert.strictEqual(kept.length, 1, `corrupt file kept aside (${JSON.stringify(bad).slice(0, 20)})`);
    assert.strictEqual(fs.readFileSync(path.join(userDataDir, kept[0]), 'utf8'), bad);
    assert.ok(h.logs.some((l) => l.level === 'error' && /sessions\.json/.test(l.msg)), 'the corruption is logged as an error');
    // The new file is valid and holds the session created after startup.
    const now = JSON.parse(fs.readFileSync(path.join(userDataDir, 'sessions.json'), 'utf8'));
    assert.strictEqual(now.sessions.length, 1);
  }
});

test('sessions.json: a valid file whose sessions field is not an array does not crash startup', async () => {
  const userDataDir = tmp('helm-rvshape-');
  fs.writeFileSync(path.join(userDataDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: { a: 1 } }));
  const h = harness(async function* () {}, { userDataDir });
  assert.deepStrictEqual(h.engine.snapshot().sessions, []);
  await h.engine.shutdown();
});

test('interrupt, then the CLI goes away before its result: the next turn is not treated as interrupted', async () => {
  let n = 0;
  let release;
  const h = harness(async function* () {
    n++;
    if (n === 1) {
      yield F.toolUse('m1', 't1', 'Bash', { command: 'sleep 100' });
      await new Promise((r) => (release = r)); // the CLI never answers the interrupt
      return;
    }
    yield F.result(0, { is_error: true, subtype: 'error_during_execution', errors: ['API overloaded'] });
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'one' });
  await h.waitFor(() => h.es(s.id).running.length === 1);
  await h.m['sessions.interrupt']({ id: s.id });
  await h.m['sessions.close']({ id: s.id }); // or a crash: either way no result ever comes
  release();
  assert.strictEqual(h.es(s.id).interrupting, false, 'interrupting cleared when the CLI goes away');
  h.events.length = 0;
  await h.m['sessions.send']({ id: s.id, text: 'two' });
  await h.waitFor(() => h.es(s.id).s.status !== 'working');
  assert.strictEqual(h.es(s.id).s.status, 'error', 'a failed turn after the stale interrupt is reported as an error');
  assert.ok(h.events.some((e) => e.event === 'notify' && e.data.kind === 'error'), 'and notified');
  await h.engine.shutdown();
});

test('canUseTool from a CLI that was already closed resolves deny at once (no leaked promise, no stuck "waiting")', async () => {
  let release;
  let late = null;
  const h = harness(async function* (um, api) {
    yield F.toolUse('m1', 't1', 'Bash', { command: 'rm x' });
    await new Promise((r) => (release = r));
    late = api.ask('Bash', { command: 'rm x' }, 't1');
    await late;
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd, permissionMode: 'default' });
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => release);
  await h.m['sessions.close']({ id: s.id });
  release();
  await h.waitFor(() => late);
  const r = await Promise.race([late, sleep(500).then(() => 'hung')]);
  assert.notStrictEqual(r, 'hung', 'the permission promise resolves');
  assert.strictEqual(r.behavior, 'deny');
  assert.strictEqual(h.es(s.id).requests.size, 0);
  assert.strictEqual(h.es(s.id).s.status, 'closed');
  await h.engine.shutdown();
});

test('two concurrent sessions.create resumes of the same Claude session make ONE Helm session', async () => {
  const h = harness(async function* () {});
  const cid = '11111111-2222-3333-4444-555555555555';
  writeTranscript(h.projectsDir, h.cwd, cid);
  const [a, b] = await Promise.all([h.m['sessions.create']({ resumeClaudeSessionId: cid }), h.m['sessions.create']({ resumeClaudeSessionId: cid })]);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(h.engine._internal.sessions.size, 1);
  // with a cwd too (ensureLoaded is the await there)
  const cid2 = '11111111-2222-3333-4444-666666666666';
  writeTranscript(h.projectsDir, h.cwd, cid2);
  const [c, d] = await Promise.all([h.m['sessions.create']({ resumeClaudeSessionId: cid2, cwd: h.cwd }), h.m['sessions.create']({ resumeClaudeSessionId: cid2, cwd: h.cwd })]);
  assert.strictEqual(c.id, d.id);
  assert.strictEqual(h.engine._internal.sessions.size, 2);
  await h.engine.shutdown();
});

test('resumeClaudeSessionId / findTranscript refuse path traversal', async () => {
  const h = harness(async function* () {});
  // a .jsonl outside the slug folder, reachable with ../
  fs.writeFileSync(path.join(h.projectsDir, 'outside.jsonl'), JSON.stringify({ type: 'user', uuid: 'x', message: { role: 'user', content: 'secret' } }) + '\n');
  assert.strictEqual(findTranscript('../outside', h.cwd, h.projectsDir), null);
  assert.strictEqual(findTranscript('..\\outside', h.cwd, h.projectsDir), null);
  for (const bad of ['../outside', '..\\outside', 'a/b', '..', '', 42, { x: 1 }]) {
    await assert.rejects(h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: bad }), (e) => e.code === 'bad_params', `rejects ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(h.engine._internal.sessions.size, 0);
  await h.engine.shutdown();
});

test('sessions.respond: plan approval with an unknown mode is rejected and the request stays answerable', async () => {
  let result = null;
  const h = harness(async function* (um, api) {
    yield F.toolUse('mp', 'tp', 'ExitPlanMode', { plan: '# Plan' });
    result = await api.ask('ExitPlanMode', { plan: '# Plan' }, 'tp');
    yield F.toolResult('tp', 'ok');
    yield F.result(0);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd, permissionMode: 'plan' });
  await h.m['sessions.send']({ id: s.id, text: 'plan it' });
  const req = (await h.waitFor(() => h.events.find((e) => e.event === 'session.item' && e.data.item.type === 'request'))).data.item;
  await assert.rejects(h.m['sessions.respond']({ id: s.id, requestId: req.requestId, response: { behavior: 'allow', mode: 'rootMode' } }), (e) => e.code === 'bad_params');
  assert.strictEqual(h.es(s.id).s.permissionMode, 'plan');
  await h.m['sessions.respond']({ id: s.id, requestId: req.requestId, response: { behavior: 'allow', mode: 'acceptEdits' } });
  await h.waitFor(() => result);
  assert.strictEqual(result.updatedPermissions[0].mode, 'acceptEdits');
  await h.engine.shutdown();
});

test('probe(): its 30 s start-up timeout is cleared once the CLI answers (no timer left keeping the process alive)', async () => {
  const h = harness(async function* () {});
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before = timers();
  await h.engine._internal.probe(h.cwd);
  assert.strictEqual(timers(), before);
  await h.engine.shutdown();
});

test('RPC params are validated: bad types / sizes / folders → bad_params, nothing reaches the SDK', async () => {
  const h = harness(async function* () {
    yield F.result(0);
  });
  const file = path.join(h.cwd, 'f.txt');
  fs.writeFileSync(file, 'x');
  const bad = [
    { cwd: 42 },
    { cwd: { a: 1 } },
    { cwd: file }, // not a directory
    { cwd: h.cwd, permissionMode: { a: 1 } },
    { cwd: h.cwd, model: { a: 1 } },
    { cwd: h.cwd, model: 'x'.repeat(200) },
    { cwd: h.cwd, effort: ['xhigh'] },
    { cwd: h.cwd, prompt: { a: 1 } },
    { cwd: h.cwd, prompt: 'x'.repeat(1_100_000) },
    { cwd: h.cwd, attachments: 'nope' },
  ];
  for (const p of bad) await assert.rejects(h.m['sessions.create'](p), (e) => e.code === 'bad_params', `create ${JSON.stringify(p).slice(0, 60)}`);
  assert.strictEqual(h.engine._internal.sessions.size, 0);
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await assert.rejects(h.m['sessions.send']({ id: s.id, text: { a: 1 } }), (e) => e.code === 'bad_params');
  await assert.rejects(h.m['sessions.send']({ id: s.id, text: 'x'.repeat(1_100_000) }), (e) => e.code === 'bad_params');
  await assert.rejects(h.m['sessions.send']({ id: s.id, text: 'hi', attachments: [null] }), (e) => e.code === 'bad_params');
  await assert.rejects(h.m['sessions.send']({ id: { toString: () => s.id }, text: 'hi' }), (e) => e.code === 'bad_params' || e.code === 'not_found');
  await assert.rejects(h.m['sessions.update']({ id: s.id, model: { a: 1 } }), (e) => e.code === 'bad_params');
  await assert.rejects(h.m['sessions.update']({ id: s.id, effort: 'x'.repeat(200) }), (e) => e.code === 'bad_params');
  await assert.rejects(h.m['sessions.update']({ id: s.id, title: 'x'.repeat(5000) }), (e) => e.code === 'bad_params');
  await assert.rejects(h.m['history.search']({ q: { a: 1 } }), (e) => e.code === 'bad_params');
  assert.strictEqual(h.sdk.calls.length, 0);
  // still works with good params
  await h.m['sessions.send']({ id: s.id, text: 'hi' });
  await h.waitFor(() => h.es(s.id).s.status === 'idle' && h.sdk.calls.length === 1);
  await h.engine.shutdown();
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('files.changes: git runs without optional locks (never rewrites .git/index) and with fsmonitor off', { skip: !hasGit && 'git not installed' }, async () => {
  const repo = tmp('helm-rvgit-');
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  const f = path.join(repo, 'a.txt');
  fs.writeFileSync(f, 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  // Stat-dirty but content-identical: a plain `git status` refreshes and rewrites the index.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(f, future, future);
  // A planted fsmonitor hook must never run.
  const marker = path.join(repo, 'fsmonitor-ran');
  g('config', 'core.fsmonitor', `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(marker)}`);
  const idx = path.join(repo, '.git', 'index');
  const before = { bytes: fs.readFileSync(idx), mtime: fs.statSync(idx).mtimeMs };
  const { computeChanges } = require('../../main/engine/changes');
  const items = [{ type: 'tool', name: 'Edit', status: 'done', input: { file_path: f, old_string: 'one', new_string: 'one' } }];
  await computeChanges(items, repo);
  assert.ok(fs.readFileSync(idx).equals(before.bytes), '.git/index bytes unchanged');
  assert.strictEqual(fs.statSync(idx).mtimeMs, before.mtime, '.git/index not rewritten');
  assert.ok(!fs.existsSync(marker), 'fsmonitor hook did not run');
});
