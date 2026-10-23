'use strict';
// "Since you left" recap (lane recap): main/engine/recap.js + its engine wiring (sessions.recap / sessions.viewing).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecap, commitsIn, fileOf } = require('../../main/engine/recap');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'helm-recap-'));
let T = 1_000_000;
const clock = () => T;

function harness({ file = null, known = [], sessions = {} } = {}) {
  const events = [];
  const r = createRecap({ file, knownIds: known, now: clock, emit: (e) => events.push(e), getSession: (id) => sessions[id] || null });
  const item = (sid, it) => r.onEvent('session.item', { sessionId: sid, item: { ts: T, ...it } });
  const upd = (sid, itemId, patch) => r.onEvent('session.itemUpdate', { sessionId: sid, itemId, patch });
  return { r, item, upd, events, sessions };
}
const sess = (id, extra = {}) => ({ id, title: `T ${id}`, project: 'helm', status: 'idle', createdAt: 0, ...extra });

test('commitsIn: git commit summary lines only, from Bash/PowerShell git commit commands', () => {
  const ok = { name: 'Bash', input: { command: 'git add -A && git commit -m "x"' }, result: '[master 1a2b3c4] Fix the recap\n 2 files changed' };
  assert.deepStrictEqual(commitsIn(ok), [{ hash: '1a2b3c4', subject: 'Fix the recap' }]);
  assert.deepStrictEqual(commitsIn({ ...ok, result: { text: '[main (root-commit) abcdef0] First' } }), [{ hash: 'abcdef0', subject: 'First' }]);
  assert.deepStrictEqual(commitsIn({ ...ok, name: 'PowerShell', input: { command: 'git -C x commit -m y' } }).length, 1);
  assert.deepStrictEqual(commitsIn({ ...ok, input: { command: 'git log --oneline' } }), []);
  assert.deepStrictEqual(commitsIn({ ...ok, name: 'Read' }), []);
  assert.deepStrictEqual(commitsIn({ ...ok, result: 'nothing to commit, working tree clean' }), []);
  const two = { ...ok, input: { command: 'git commit -m a; git commit -m b' }, result: '[master 1111111] a\n[master 2222222] b' };
  assert.strictEqual(commitsIn(two).length, 2);
});

test('fileOf: finished Edit/Write/NotebookEdit paths only', () => {
  assert.strictEqual(fileOf({ name: 'Edit', status: 'done', input: { file_path: 'C:\\a\\b.js' } }), 'C:\\a\\b.js');
  assert.strictEqual(fileOf({ name: 'NotebookEdit', status: 'done', input: { notebook_path: '/x/n.ipynb' } }), '/x/n.ipynb');
  assert.strictEqual(fileOf({ name: 'Write', status: 'error', input: { file_path: 'a' } }), null);
  assert.strictEqual(fileOf({ name: 'Read', status: 'done', input: { file_path: 'a' } }), null);
});

test('accumulates outcome, commits, files, cost and span while unviewed; tools finishing later count once', () => {
  const h = harness({ sessions: { a: sess('a') } });
  T = 2_000_000;
  h.item('a', { id: 'i1', type: 'user', text: 'go' });
  h.item('a', { id: 'i2', type: 'tool', name: 'Edit', status: 'running', input: { file_path: 'C:\\r\\ui\\home.js' } });
  h.upd('a', 'i2', { status: 'done', result: 'ok' });
  h.upd('a', 'i2', { status: 'done' }); // a repeat patch must not double count
  h.item('a', { id: 'i3', type: 'tool', name: 'Write', status: 'done', input: { file_path: 'C:/r/ui/home.js' } }); // same file, other slash
  h.item('a', { id: 'i4', type: 'tool', name: 'Write', status: 'running', input: { file_path: 'C:\\r\\main\\recap.js' } });
  h.upd('a', 'i4', { status: 'denied' });
  h.item('a', { id: 'i5', type: 'tool', name: 'Bash', status: 'running', input: { command: 'git commit -am "Add recap"' } });
  h.upd('a', 'i5', { status: 'done', result: '[master 9f8e7d6] Add recap\n 3 files changed' });
  T = 2_600_000;
  h.item('a', { id: 'i6', type: 'result', costUsd: 0.25, isError: false });
  h.item('a', { id: 'i7', type: 'result', costUsd: 0.1, isError: false });
  const [row] = h.r.list();
  assert.strictEqual(row.id, 'a');
  assert.strictEqual(row.outcome, 'done');
  assert.strictEqual(row.commits, 1);
  assert.strictEqual(row.commitSubject, 'Add recap');
  assert.strictEqual(row.fileCount, 1);
  assert.deepStrictEqual(row.files, ['home.js']);
  assert.strictEqual(row.costUsd, 0.35);
  assert.strictEqual(row.from, 2_000_000);
  assert.strictEqual(row.to, 2_600_000);
});

test('outcome: failed with the short error, then waiting / working from live status; viewing clears it', () => {
  const h = harness({ sessions: { a: sess('a'), b: sess('b', { status: 'working' }), c: sess('c', { status: 'waiting' }) } });
  h.item('a', { id: 'r', type: 'result', isError: true });
  h.item('a', { id: 'e', type: 'system', subtype: 'error', text: 'API Error: 529 overloaded\nmore detail' });
  h.item('b', { id: 'x', type: 'assistant', text: 'hi' });
  h.item('c', { id: 'q', type: 'request', kind: 'permission' });
  const rows = h.r.list();
  assert.deepStrictEqual(rows.map((r) => r.id), ['c', 'a', 'b']); // waiting, failed, then the rest
  assert.strictEqual(rows[1].outcome, 'failed');
  assert.strictEqual(rows[1].error, 'API Error: 529 overloaded');
  assert.strictEqual(rows[2].outcome, 'working');
  // A later successful turn clears the failure.
  h.item('a', { id: 'r2', type: 'result', isError: false });
  assert.strictEqual(h.r.list().find((r) => r.id === 'a').outcome, 'done');
  // On screen: cleared, and nothing accumulates while it stays there.
  T = 5_000_000;
  h.r.setViewing(['a']);
  h.item('a', { id: 'z', type: 'assistant', text: 'seen live' });
  assert.ok(!h.r.list().some((r) => r.id === 'a'));
  // Leaving the screen = seen now; only what happens after shows.
  T = 6_000_000;
  h.r.setViewing([]);
  assert.ok(!h.r.list().some((r) => r.id === 'a'));
  h.item('a', { id: 'y', type: 'assistant', text: 'after' });
  const a = h.r.list().find((r) => r.id === 'a');
  assert.strictEqual(a.seenAt, 6_000_000);
  assert.strictEqual(a.outcome, 'done');
});

test('archived / unknown sessions are skipped; session.removed forgets', () => {
  const h = harness({ sessions: { a: sess('a', { archived: true }), b: sess('b') } });
  h.item('a', { id: '1', type: 'assistant' });
  h.item('ghost', { id: '1', type: 'assistant' });
  h.item('b', { id: '1', type: 'assistant' });
  assert.deepStrictEqual(h.r.list().map((r) => r.id), ['b']);
  h.r.onEvent('session.removed', { id: 'b' });
  assert.deepStrictEqual(h.r.list(), []);
});

test('persists lastSeen + summaries; known sessions start seen; a recap.updated notice follows changes', async () => {
  const dir = tmp();
  const file = path.join(dir, 'recap.json');
  T = 7_000_000;
  const h = harness({ file, known: ['old'], sessions: { old: sess('old'), n: sess('n', { createdAt: 6_900_000 }) } });
  h.item('n', { id: '1', type: 'tool', name: 'Write', status: 'done', input: { file_path: 'a.txt' } });
  h.r.close();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.sessions.old.seen, 7_000_000);
  assert.strictEqual(saved.sessions.old.acts, null);
  assert.strictEqual(saved.sessions.n.seen, 6_900_000);
  assert.strictEqual(saved.sessions.n.acts.fileCount, 1);
  const h2 = harness({ file, known: ['old', 'n'], sessions: h.sessions });
  assert.deepStrictEqual(h2.r.list().map((r) => [r.id, r.fileCount]), [['n', 1]]);
  h2.item('n', { id: '2', type: 'assistant' });
  await new Promise((res) => setTimeout(res, 900));
  assert.ok(h2.events.includes('recap.updated'));
  h2.r.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('engine: sessions.recap + sessions.viewing over two clients, and a restart keeps it', async () => {
  const { createEngine } = require('../../main/engine');
  const root = tmp();
  const mk = (p) => fs.mkdtempSync(path.join(root, p));
  const ud = mk('ud-');
  const cwd = mk('cwd-');
  fs.writeFileSync(path.join(ud, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 's_1', cwd, title: 'One', project: 'p', status: 'idle', createdAt: 1, updatedAt: 1 }] }));
  const opts = { userDataDir: ud, emit: () => {}, log: () => {}, sdk: {}, claudePath: null, projectsDir: mk('proj-'), statuslineDir: mk('sl-'), etaDir: false, external: false, usageSampling: false, getIdleCloseMs: () => 0 };
  const engine = createEngine(opts);
  const emit = engine._internal.ctx.emit;
  assert.deepStrictEqual((await engine.methods['sessions.recap']()).rows, []);
  const desk = { id: 1 }, phone = { id: 2 };
  await engine.methods['sessions.viewing']({ ids: ['s_1'] }, desk);
  emit('session.item', { sessionId: 's_1', item: { id: 'i1', ts: Date.now(), type: 'assistant', text: 'x' } });
  assert.deepStrictEqual((await engine.methods['sessions.recap']()).rows, []);   // on the desktop's screen
  await engine.methods['sessions.viewing']({ ids: [] }, desk);                     // desktop went Home
  emit('session.item', { sessionId: 's_1', item: { id: 'i2', ts: Date.now(), type: 'tool', name: 'Bash', status: 'done', input: { command: 'git commit -m z' }, result: '[main 0123abc] Zed' } });
  let rows = (await engine.methods['sessions.recap']()).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].commitSubject, 'Zed');
  await engine.shutdown();
  const again = createEngine(opts);
  rows = (await again.methods['sessions.recap']()).rows;
  assert.strictEqual(rows.length, 1, 'survives a restart');
  await again.methods['sessions.viewing']({ ids: ['s_1'] }, phone);                // the phone opened it
  assert.deepStrictEqual((await again.methods['sessions.recap']()).rows, []);
  again.clientClosed(phone);
  assert.deepStrictEqual((await again.methods['sessions.recap']()).rows, []);
  await again.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
