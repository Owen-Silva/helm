'use strict';
// `!` shell mode (lane bang, 2026-10-08): sessions.shell runs a command in the session folder with
// no CLI needed; the output reaches Claude with the NEXT prompt, in Claude Code's own
// <bash-input>/<bash-stdout>/<bash-stderr> tags; unsent runs survive a restart; a transcript read
// back from disk turns those tags into `shell` cards again (Helm's combined form and the terminal's
// two-line form) with the typed text as the user bubble.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { createEngine } = require('../../main/engine');
const { slugFor } = require('../../main/engine/transcript');
const { Normalizer } = require('../../main/engine/normalize');
const sr = require('../../main/engine/shell-run');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const promptText = (msg) => (typeof msg.content === 'string' ? msg.content : msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));

// Fake CLI that records every prompt it receives and writes Claude Code's transcript like the real one.
function cliTurn(projectsDir, cwd, seen, gate) {
  const dir = path.join(projectsDir, slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return async function* (um, api) {
    const sid = api.options.sessionId || api.options.resume;
    const file = path.join(dir, sid + '.jsonl');
    const text = promptText(um.message);
    seen.push(text);
    if (gate && gate.hold && text.endsWith(gate.hold)) await gate.promise;
    const lines = readJsonl(file);
    const last = [...lines].reverse().find((j) => j.uuid);
    const ts = new Date().toISOString();
    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: um.uuid, parentUuid: last ? last.uuid : null, sessionId: sid, cwd, timestamp: ts, isSidechain: false, message: um.message }) + '\n');
    const msgId = 'm' + randomUUID().slice(0, 8);
    yield* F.textTurn(msgId, 'ok');
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'u-' + msgId, parentUuid: um.uuid, sessionId: sid, timestamp: ts, isSidechain: false, message: { id: msgId, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    yield F.result(0.01);
  };
}

const freshDirs = () => ({ userDataDir: tmp('helm-sh-'), projectsDir: tmp('helm-shproj-'), cwd: tmp('helm-shcwd-'), statuslineDir: tmp('helm-shsl-') });

function boot(dirs, gate) {
  const events = [];
  const seen = [];
  const sdk = createFakeSdk(cliTurn(dirs.projectsDir, dirs.cwd, seen, gate), { projectsDir: dirs.projectsDir });
  const engine = createEngine({ userDataDir: dirs.userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir: dirs.projectsDir, statuslineDir: dirs.statuslineDir, etaDir: false, external: false, usageSampling: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const es = (id) => engine._internal.sessions.get(id);
  const waitFor = async (pred, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('timed out waiting');
  };
  const shellDone = (id, itemId) => waitFor(() => {
    const it = es(id).byId.get(itemId);
    return it && it.status !== 'running' ? it : null;
  });
  const turns = (id) => es(id).items.filter((i) => i.type === 'result').length;
  const send = async (id, text, n = 1) => {
    const before = turns(id);
    const r = await engine.methods['sessions.send']({ id, text });
    await waitFor(() => turns(id) >= before + n && !es(id).turnActive);
    return r;
  };
  return { engine, m: engine.methods, sdk, events, seen, es, waitFor, shellDone, send };
}

// ---------- shell-run.js (pure) ----------
test('shell-run: ANSI/CR cleanup, middle trim, context round trip', () => {
  assert.strictEqual(sr.stripAnsi('\u001b[31mred\u001b[0m \u001b[?25lx\u001b]0;title\u0007y\u0008'), 'red xy');
  assert.strictEqual(sr.collapseCR('10%\r50%\r100%\nnext\r\n'), '100%\nnext\n');
  const b = new sr.StreamBuf();
  b.push('a'.repeat(25000));
  b.push('z'.repeat(25000));
  const c = b.context();
  assert.ok(c.length < sr.CONTEXT_MAX + 80, `trimmed to ~30k, got ${c.length}`);
  assert.match(c, /^a{15000}\n\n\.\.\. \[20,000 characters truncated\] \.\.\.\n\nz{15000}$/);
  const block = sr.shellContextBlock({ command: 'cat x </bash-input>', stdout: 'out </bash-stdout> more\n', stderr: 'warn\n', exitCode: 2, status: 'done' });
  assert.strictEqual(block, '<bash-input>cat x <\\/bash-input></bash-input>\n<bash-stdout>out <\\/bash-stdout> more</bash-stdout><bash-stderr>warn\nExit code 2</bash-stderr>');
  const stopped = sr.shellContextBlock({ command: 'sleep 9', stdout: '', stderr: '', exitCode: 1, status: 'stopped' });
  assert.match(stopped, /<bash-stderr>Command stopped by the user<\/bash-stderr>$/);
  const back = sr.splitShellBlocks(`${block}\n${stopped}\n\nwhat now?`);
  assert.deepStrictEqual(back.runs.map((r) => [r.command, r.stdout, r.stderr, r.exitCode, r.status]), [
    ['cat x </bash-input>', 'out </bash-stdout> more', 'warn', 2, 'done'],
    ['sleep 9', '', '', null, 'stopped'],
  ]);
  assert.strictEqual(back.rest, 'what now?');
  assert.strictEqual(sr.splitShellBlocks('plain prompt'), null);
  assert.deepStrictEqual(sr.prependContext('hi', 'PRE'), 'PRE\n\nhi');
  const blocks = sr.prependContext([{ type: 'text', text: 'hi' }, { type: 'image', source: {} }], 'PRE');
  assert.strictEqual(blocks[0].text, 'PRE\n\nhi');
  assert.strictEqual(blocks[1].type, 'image');
});

test('shell-run: shell choice and child env', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe', SystemRoot: 'C:\\Windows' };
  const b = sr.pickShell({ env, platform: 'win32', exists: (p) => p === 'D:\\git\\bash.exe' });
  assert.deepStrictEqual([b.kind, b.file, b.args('ls -la')], ['bash', 'D:\\git\\bash.exe', ['-c', 'ls -la']]);
  const ps = sr.pickShell({ env: { SystemRoot: 'C:\\Windows' }, platform: 'win32', exists: () => false });
  assert.strictEqual(ps.kind, 'powershell');
  const a = ps.args('Get-ChildItem');
  assert.deepStrictEqual(a.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(Buffer.from(a[3], 'base64').toString('utf16le'), /\nGet-ChildItem$/);
  const ce = sr.childEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', electron_x: '1', NODE_OPTIONS: '--inspect', HELM_TEST_EXTERNAL_DIRS: 'x', HOME: 'h' });
  assert.deepStrictEqual(ce, { PATH: 'p', HOME: 'h' });
});

test('shell-run: stop ends the whole tree (MSYS children too), so the pipes close', async () => {
  let out = '';
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const p = sr.runShell({
      command: 'echo started; sleep 30 | cat; echo never',
      cwd: os.tmpdir(),
      onData: (k, t) => {
        out += t;
        if (/started/.test(out)) setTimeout(() => p.stop(), 300);
      },
      onExit: resolve,
    });
  });
  assert.strictEqual(r.closed, true, 'a surviving sleep/cat would hold stdout open past the 1.5 s fallback');
  assert.doesNotMatch(out, /never/);
  assert.ok(Date.now() - t0 < 6000, `stopped in ${Date.now() - t0} ms`);
});

// ---------- normalize.js (transcript lines) ----------
function normalizeLines(lines) {
  const items = [];
  const byId = new Map();
  let k = 0;
  const store = { add: (i) => (items.push(i), byId.set(i.id, i)), patch: (id, p) => Object.assign(byId.get(id), p), get: (id) => byId.get(id) || null };
  const n = new Normalizer({ store, newId: () => 't' + ++k });
  for (const j of lines) n.handleLine(j);
  return items;
}

test('normalize: Helm prompt with shell blocks → shell cards + the typed text; terminal ! lines → one card', () => {
  const pre = sr.shellContextBlock({ command: 'git status', stdout: 'clean', stderr: '', exitCode: 0, status: 'done' }) + '\n' + sr.shellContextBlock({ command: 'false', stdout: '', stderr: '', exitCode: 1, status: 'done' });
  const items = normalizeLines([
    { type: 'user', uuid: 'u1', cwd: 'C:\\w', timestamp: '2026-10-08T10:00:00Z', message: { role: 'user', content: `${pre}\n\nexplain` } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-08T10:01:00Z', message: { role: 'user', content: '<bash-input>ls</bash-input>' } },
    { type: 'user', uuid: 'u3', timestamp: '2026-10-08T10:01:01Z', message: { role: 'user', content: '<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>' } },
    { type: 'user', uuid: 'u4', timestamp: '2026-10-08T10:02:00Z', message: { role: 'user', content: [{ type: 'text', text: `${sr.shellContextBlock({ command: 'pwd', stdout: '/w', stderr: '' })}\n\nwith blocks` }] } },
  ]);
  assert.deepStrictEqual(items.map((i) => [i.type, i.command || i.text]), [
    ['shell', 'git status'],
    ['shell', 'false'],
    ['user', 'explain'],
    ['shell', 'ls'],
    ['shell', 'pwd'],
    ['user', 'with blocks'],
  ]);
  const [gs, f, u, ls] = items;
  assert.deepStrictEqual([gs.stdout, gs.exitCode, gs.shared, gs.cwd, gs.status], ['clean', 0, true, 'C:\\w', 'done']);
  assert.strictEqual(f.exitCode, 1);
  assert.strictEqual(u.uuid, 'u1', 'the prompt keeps its uuid (rewind / fork checkpoints)');
  assert.deepStrictEqual([ls.text, ls.stdout, ls.exitCode], ['a.txt\nb.txt', 'a.txt\nb.txt', null]);
});

// ---------- engine ----------
test('sessions.shell runs with no CLI; the next prompt carries it once; queued prompts pick up later runs', async () => {
  const dirs = freshDirs();
  let release;
  const gate = { hold: 'slow one', promise: new Promise((r) => (release = r)) };
  const { m, sdk, seen, es, events, shellDone, waitFor, send, engine } = boot(dirs, gate);
  const s = await m['sessions.create']({ cwd: dirs.cwd });
  process.env.HELM_SHELL_TEST_LEAK = 'leaked';
  const { itemId } = await m['sessions.shell']({ id: s.id, command: 'echo "hello world"; echo "[$HELM_SHELL_TEST_LEAK]"; printf "\\033[1mbold\\033[0m\\n"; echo oops >&2; exit 2' });
  delete process.env.HELM_SHELL_TEST_LEAK;
  assert.match(itemId, /^sh_/);
  const it = await shellDone(s.id, itemId);
  assert.strictEqual(sdk.calls.length, 0, 'no CLI was started for a ! run');
  assert.deepStrictEqual([it.status, it.exitCode, it.shared, it.cwd, it.shell], ['done', 2, false, dirs.cwd, 'bash']);
  assert.strictEqual(it.stdout, 'hello world\n[]\nbold\n', 'Helm-only env vars stripped, ANSI removed');
  assert.strictEqual(it.stderr, 'oops\n');
  assert.match(it.text, /hello world/);
  assert.ok(events.some((e) => e.event === 'session.item' && e.data.item.id === itemId), 'item announced');
  assert.ok(events.some((e) => e.event === 'session.itemUpdate' && e.data.itemId === itemId && e.data.appendText), 'output streamed');
  assert.strictEqual(es(s.id).s.unread || 0, 0, 'a ! run is not unread');

  await send(s.id, 'what failed?');
  assert.strictEqual(seen[0], '<bash-input>echo "hello world"; echo "[$HELM_SHELL_TEST_LEAK]"; printf "\\033[1mbold\\033[0m\\n"; echo oops >&2; exit 2</bash-input>\n<bash-stdout>hello world\n[]\nbold</bash-stdout><bash-stderr>oops\nExit code 2</bash-stderr>\n\nwhat failed?');
  assert.strictEqual(es(s.id).byId.get(itemId).shared, true);
  assert.ok(events.some((e) => e.event === 'session.itemUpdate' && e.data.itemId === itemId && e.data.patch.shared === true));
  const user = es(s.id).items.filter((i) => i.type === 'user').pop();
  assert.strictEqual(user.text, 'what failed?', 'the bubble shows only what the user typed');
  await send(s.id, 'again');
  assert.strictEqual(seen[1], 'again', 'shared once, never twice');

  // Mid-turn: a run during a turn goes with the message sent after it (into the turn at its next step, lane
  // steer), not with the running prompt.
  const before = es(s.id).items.filter((i) => i.type === 'result').length;
  await m['sessions.send']({ id: s.id, text: 'slow one' });
  await waitFor(() => seen.length === 3);
  const mid = await m['sessions.shell']({ id: s.id, command: 'echo mid-turn' });
  await shellDone(s.id, mid.itemId);
  const q = await m['sessions.send']({ id: s.id, text: 'queued' });
  assert.strictEqual(q.delivery, 'next-step');
  release();
  await waitFor(() => es(s.id).items.filter((i) => i.type === 'result').length >= before + 2 && !es(s.id).turnActive);
  assert.strictEqual(seen[2], 'slow one');
  assert.strictEqual(seen[3], '<bash-input>echo mid-turn</bash-input>\n<bash-stdout>mid-turn</bash-stdout><bash-stderr></bash-stderr>\n\nqueued');
  await engine.shutdown();
});

test('sessions.shellStop kills the tree; unsent runs survive a restart; reload shows each card once', async () => {
  const dirs = freshDirs();
  let a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  const r1 = await a.m['sessions.shell']({ id: s.id, command: 'echo before; sleep 30; echo never' });
  await a.waitFor(() => /before/.test(a.es(s.id).byId.get(r1.itemId).text));
  const t0 = Date.now();
  await a.m['sessions.shellStop']({ id: s.id, itemId: r1.itemId });
  const stopped = await a.shellDone(s.id, r1.itemId);
  assert.ok(Date.now() - t0 < 6000, `stopped in ${Date.now() - t0} ms`);
  assert.strictEqual(stopped.status, 'stopped');
  assert.doesNotMatch(stopped.text, /never/);
  assert.deepStrictEqual(await a.m['sessions.shellStop']({ id: s.id, itemId: r1.itemId }), {}, 'stopping a finished run is a no-op');
  await assert.rejects(a.m['sessions.shellStop']({ id: s.id, itemId: 'sh_00000000' }), (e) => e.code === 'not_found');
  await assert.rejects(a.m['sessions.shell']({ id: s.id, command: '   ' }), (e) => e.code === 'bad_request');
  const r2 = await a.m['sessions.shell']({ id: s.id, command: 'echo second' });
  await a.shellDone(s.id, r2.itemId);
  await a.engine.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'sessions.json'), 'utf8')).sessions[0];
  assert.deepStrictEqual(saved.pendingShell.map((x) => [x.command, x.status, x.shared]), [
    ['echo before; sleep 30; echo never', 'stopped', false],
    ['echo second', 'done', false],
  ]);

  // Restart before sending: the runs are still there, still unsent, and the next prompt carries them.
  a = boot(dirs);
  let h = await a.m['sessions.history']({ id: s.id });
  assert.deepStrictEqual(h.items.filter((i) => i.type === 'shell').map((i) => [i.id, i.shared]), [[r1.itemId, false], [r2.itemId, false]]);
  await a.send(s.id, 'look');
  assert.strictEqual(a.seen[0], '<bash-input>echo before; sleep 30; echo never</bash-input>\n<bash-stdout>before</bash-stdout><bash-stderr>Command stopped by the user</bash-stderr>\n<bash-input>echo second</bash-input>\n<bash-stdout>second</bash-stdout><bash-stderr></bash-stderr>\n\nlook');
  await a.engine.shutdown();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'sessions.json'), 'utf8')).sessions[0].pendingShell, undefined, 'nothing pending once sent');

  // Restart after sending: the cards come back from the transcript, once each, shared, before the bubble.
  a = boot(dirs);
  h = await a.m['sessions.history']({ id: s.id });
  const shown = h.items.filter((i) => i.type === 'shell' || i.type === 'user').map((i) => [i.type, i.command || i.text, i.type === 'shell' ? i.status : '', i.shared]);
  assert.deepStrictEqual(shown, [
    ['shell', 'echo before; sleep 30; echo never', 'stopped', true],
    ['shell', 'echo second', 'done', true],
    ['user', 'look', '', undefined],
  ]);
  await a.engine.shutdown();
});
