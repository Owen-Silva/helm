'use strict';
// QA finding (2026-10-08): a conversation rewind set up a pending fork that lived only in memory.
// Restart Helm before the next send and the session's history came back empty, and the next send
// started a brand-new conversation. The pending fork (`forkFrom`) is now saved with the session:
// after a restart history shows the source transcript plus the "Rewound to before…" marker, and
// the next send forks from the rewind point.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { createEngine } = require('../../main/engine');
const { slugFor } = require('../../main/engine/transcript');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const promptText = (msg) => (typeof msg.content === 'string' ? msg.content : msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));

// A fake CLI that also writes Claude Code's transcript, like the real one: user + assistant lines
// chained by parentUuid; a fork (resume + resumeSessionAt + forkSession) first copies the source up
// to resumeSessionAt into the new session's file. Each reply lists the prompts the "model" can see
// (the chain in its own transcript), so a test can tell which conversation it continued.
function cliTurn(projectsDir, cwd) {
  const dir = path.join(projectsDir, slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return async function* (um, api) {
    const o = api.options;
    const sid = o.sessionId || o.resume;
    const file = path.join(dir, sid + '.jsonl');
    if (o.forkSession && !fs.existsSync(file)) {
      const src = readJsonl(path.join(dir, o.resume + '.jsonl'));
      const i = src.findIndex((j) => j.uuid === o.resumeSessionAt);
      const kept = src.slice(0, i + 1).map((j) => ({ ...j, sessionId: sid }));
      fs.writeFileSync(file, kept.map((j) => JSON.stringify(j)).join('\n') + (kept.length ? '\n' : ''));
    }
    const lines = readJsonl(file);
    const last = [...lines].reverse().find((j) => j.uuid);
    const ts = new Date().toISOString();
    const user = { type: 'user', uuid: um.uuid, parentUuid: last ? last.uuid : null, sessionId: sid, timestamp: ts, isSidechain: false, message: um.message };
    fs.appendFileSync(file, JSON.stringify(user) + '\n');
    const seen = [...lines, user].filter((j) => j.type === 'user').map((j) => promptText(j.message));
    const msgId = 'm' + randomUUID().slice(0, 8);
    const reply = 'seen: ' + seen.join(' | ');
    yield* F.textTurn(msgId, reply);
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'u-' + msgId, parentUuid: um.uuid, sessionId: sid, timestamp: ts, isSidechain: false, message: { id: msgId, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: reply }] } }) + '\n');
    yield F.result(0.01);
  };
}

function boot(dirs) {
  const events = [];
  const sdk = createFakeSdk(cliTurn(dirs.projectsDir, dirs.cwd), { projectsDir: dirs.projectsDir });
  const engine = createEngine({ userDataDir: dirs.userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir: dirs.projectsDir, statuslineDir: dirs.statuslineDir, etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const es = (id) => engine._internal.sessions.get(id);
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error('timed out waiting');
  };
  const send = async (id, text) => {
    const before = es(id).items.filter((i) => i.type === 'result').length;
    await engine.methods['sessions.send']({ id, text });
    await waitFor(() => es(id).items.filter((i) => i.type === 'result').length > before && !es(id).turnActive);
    const replies = es(id).items.filter((i) => i.type === 'assistant');
    return replies[replies.length - 1].text;
  };
  return { engine, m: engine.methods, sdk, events, es, waitFor, send };
}

const freshDirs = () => ({ userDataDir: tmp('helm-rwp-'), projectsDir: tmp('helm-rwpproj-'), cwd: tmp('helm-rwpcwd-'), statuslineDir: tmp('helm-rwpsl-') });
const savedSession = (dirs, id) => JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'sessions.json'), 'utf8')).sessions.find((s) => s.id === id);

async function rewoundSession(dirs) {
  const a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  assert.strictEqual(await a.send(s.id, 'one'), 'seen: one');
  assert.strictEqual(await a.send(s.id, 'two'), 'seen: one | two');
  const sourceId = a.es(s.id).s.claudeSessionId;
  const two = a.es(s.id).items.find((i) => i.type === 'user' && i.text === 'two');
  await a.m['sessions.rewind']({ id: s.id, checkpointId: two.uuid, files: false, conversation: true });
  return { a, s, sourceId, two };
}

test('a conversation rewind survives a restart: history keeps the marker + fold, the next send forks at the rewind point', async () => {
  const dirs = freshDirs();
  const { a, s, sourceId, two } = await rewoundSession(dirs);
  const pendingId = a.es(s.id).s.claudeSessionId;
  assert.notStrictEqual(pendingId, sourceId, 'the rewind picked a new Claude session id');
  const liveMarker = a.es(s.id).items[a.es(s.id).items.length - 1];
  await a.engine.shutdown();

  // What was saved: the pending fork, with the prompt it rewinds to and the marker text.
  const saved = savedSession(dirs, s.id);
  assert.strictEqual(saved.claudeSessionId, pendingId);
  assert.strictEqual(saved.forkFrom.sourceId, sourceId);
  const srcLines = readJsonl(path.join(dirs.projectsDir, slugFor(dirs.cwd), sourceId + '.jsonl'));
  const twoLine = srcLines.find((j) => j.uuid === two.uuid);
  assert.ok(twoLine && twoLine.parentUuid, 'the prompt is in the source transcript');
  assert.strictEqual(saved.forkFrom.at, twoLine.parentUuid);
  assert.deepStrictEqual(saved.forkFrom.markers.map((mk) => [mk.checkpointId, mk.conversation, mk.text]), [[two.uuid, true, liveMarker.text]]);

  // "Restart": a new engine on the same profile dir.
  const b = boot(dirs);
  const { items } = await b.m['sessions.history']({ id: s.id });
  const texts = items.filter((i) => i.type === 'user' || i.type === 'assistant').map((i) => i.text);
  assert.deepStrictEqual(texts, ['one', 'seen: one', 'two', 'seen: one | two'], 'history is the conversation up to the rewind, rewound part included');
  const marker = items[items.length - 1];
  assert.strictEqual(marker.type, 'system');
  assert.strictEqual(marker.subtype, 'info');
  assert.strictEqual(marker.text, liveMarker.text);
  assert.match(marker.text, /Rewound to before “two”/);
  const twoAfter = items.find((i) => i.type === 'user' && i.text === 'two');
  assert.deepStrictEqual(marker.rewind, { checkpointId: two.uuid, fromItemId: twoAfter.id, files: false, conversation: true });
  // What the UI folds (ui/chat/rewound.js): from fromItemId up to the marker.
  const from = items.findIndex((i) => i.id === marker.rewind.fromItemId);
  assert.deepStrictEqual(items.slice(from, -1).filter((i) => i.type === 'user' || i.type === 'assistant').map((i) => i.text), ['two', 'seen: one | two']);
  assert.strictEqual(b.es(s.id).publicSession().context, null, 'no context gauge from the longer source');

  // The next send continues from the rewind point: it forks the source there.
  assert.strictEqual(await b.send(s.id, 'three'), 'seen: one | three');
  assert.strictEqual(b.sdk.calls.length, 1);
  const o = b.sdk.calls[0].options;
  assert.strictEqual(o.resume, sourceId);
  assert.strictEqual(o.resumeSessionAt, twoLine.parentUuid);
  assert.strictEqual(o.forkSession, true);
  assert.strictEqual(o.sessionId, pendingId);
  assert.strictEqual(b.es(s.id).s.forkFrom, null, 'taken up once the CLI started');
  await b.engine.shutdown();
  assert.strictEqual(savedSession(dirs, s.id).forkFrom, undefined, 'nothing pending is saved any more');

  // A later restart resumes the fork itself (its own transcript), not the source. History still
  // shows the rewound part (folded by the marker) before the new turn: rewind-after-fork.test.js.
  const c = boot(dirs);
  const h3 = await c.m['sessions.history']({ id: s.id });
  assert.deepStrictEqual(h3.items.filter((i) => i.type === 'user' || i.type === 'assistant').map((i) => i.text), ['one', 'seen: one', 'two', 'seen: one | two', 'three', 'seen: one | three']);
  assert.strictEqual(await c.send(s.id, 'four'), 'seen: one | three | four');
  assert.strictEqual(c.sdk.calls[0].options.resume, pendingId);
  assert.ok(!c.sdk.calls[0].options.forkSession);
  await c.engine.shutdown();
});

test('a second rewind before sending still forks the original transcript (and both markers survive a restart)', async () => {
  const dirs = freshDirs();
  const a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  for (const t of ['one', 'two', 'three']) await a.send(s.id, t);
  const sourceId = a.es(s.id).s.claudeSessionId;
  const user = (t) => a.es(s.id).items.find((i) => i.type === 'user' && i.text === t);
  await a.m['sessions.rewind']({ id: s.id, checkpointId: user('three').uuid, files: false, conversation: true });
  await a.m['sessions.rewind']({ id: s.id, checkpointId: user('two').uuid, files: false, conversation: true });
  const f = a.es(s.id).s.forkFrom;
  assert.strictEqual(f.sourceId, sourceId, 'still the transcript with the prompts in it');
  const twoLine = readJsonl(path.join(dirs.projectsDir, slugFor(dirs.cwd), sourceId + '.jsonl')).find((j) => j.uuid === user('two').uuid);
  assert.strictEqual(f.at, twoLine.parentUuid, 'not null: a null fork point would start an empty conversation');
  await a.engine.shutdown();

  const b = boot(dirs);
  const { items } = await b.m['sessions.history']({ id: s.id });
  const markers = items.filter((i) => i.rewind);
  assert.deepStrictEqual(markers.map((m) => m.text.match(/before “(\w+)”/)[1]), ['three', 'two']);
  assert.deepStrictEqual(markers.map((m) => b.es(s.id).byId.get(m.rewind.fromItemId).text), ['three', 'two']);
  assert.strictEqual(await b.send(s.id, 'again'), 'seen: one | again');
  await b.engine.shutdown();
});

test('forking the whole conversation while a rewind is pending inherits only the kept part', async () => {
  const dirs = freshDirs();
  const { a, s } = await rewoundSession(dirs);
  const fork = await a.m['sessions.fork']({ id: s.id });
  assert.strictEqual(a.sdk.forks.length, 1);
  const { items } = await a.m['sessions.history']({ id: fork.id });
  assert.deepStrictEqual(items.filter((i) => i.type === 'user' || i.type === 'assistant').map((i) => i.text), ['one', 'seen: one']);
  await a.engine.shutdown();
});

test('a malformed saved forkFrom is dropped, not trusted', async () => {
  const dirs = freshDirs();
  const id = 'h-bad-fork';
  fs.writeFileSync(path.join(dirs.userDataDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id, cwd: dirs.cwd, claudeSessionId: randomUUID(), title: 'x', status: 'idle', forkFrom: { sourceId: '../../etc', at: 'x', markers: [] } }] }));
  const b = boot(dirs);
  assert.strictEqual(b.es(id).s.forkFrom, undefined);
  await b.m['sessions.history']({ id });
  await b.engine.shutdown();
  assert.strictEqual(savedSession(dirs, id).forkFrom, undefined);
});
