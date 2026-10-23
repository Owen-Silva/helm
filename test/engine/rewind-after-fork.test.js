'use strict';
// QA gap (2026-10-08): once a conversation rewind was SENT, the fork existed and a later restart (or
// history reload) showed only the fork's own transcript: the kept items plus the new turn. The
// "Rewound to before…" marker and the folded rewound items were gone, unlike before the restart.
// The engine now keeps the sent rewind (s.rewinds: forkId, shownId, firstNew, markers) and stitches
// history tail-first across transcripts (StitchedPager): what the user saw, the marker(s), the new turns.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { createEngine } = require('../../main/engine');
const { slugFor } = require('../../main/engine/transcript');
const { StitchedPager } = require('../../main/engine/pager');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const promptText = (msg) => (typeof msg.content === 'string' ? msg.content : msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));

// Same fake CLI as rewind-persist.test.js: writes Claude Code's transcript; a fork copies the source
// up to resumeSessionAt first. Each reply lists the prompts the "model" can see.
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
  const sdk = createFakeSdk(cliTurn(dirs.projectsDir, dirs.cwd), { projectsDir: dirs.projectsDir });
  const engine = createEngine({ userDataDir: dirs.userDataDir, emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: dirs.projectsDir, statuslineDir: dirs.statuslineDir, etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const es = (id) => engine._internal.sessions.get(id);
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return;
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
  const rewindTo = (id, text) => {
    const u = es(id).items.find((i) => i.type === 'user' && i.text === text);
    return engine.methods['sessions.rewind']({ id, checkpointId: u.uuid, files: false, conversation: true });
  };
  return { engine, m: engine.methods, sdk, es, send, rewindTo };
}

const freshDirs = () => ({ userDataDir: tmp('helm-rwf-'), projectsDir: tmp('helm-rwfproj-'), cwd: tmp('helm-rwfcwd-'), statuslineDir: tmp('helm-rwfsl-') });
const savedSession = (dirs, id) => JSON.parse(fs.readFileSync(path.join(dirs.userDataDir, 'sessions.json'), 'utf8')).sessions.find((s) => s.id === id);

// The transcript as the UI reads it: messages as text, markers as "[rewound: <prompt>]", and the
// ids ui/chat/rewound.js folds (fromItemId up to each marker).
function view(items) {
  const at = new Map(items.map((it, i) => [it.id, i]));
  const folded = new Set();
  items.forEach((m, mi) => {
    if (!(m.rewind && m.rewind.conversation)) return;
    const from = at.get(m.rewind.fromItemId);
    assert.ok(from != null && from < mi, `marker ${m.text} points at a loaded item before it`);
    for (let i = from; i < mi; i++) folded.add(items[i].id);
  });
  const rows = items.filter((i) => i.type === 'user' || i.type === 'assistant' || i.rewind)
    .map((i) => (i.rewind ? `[rewound: ${i.text.match(/before “([^”]+)”/)[1]}]` : (folded.has(i.id) ? '~' : '') + i.text));
  return rows;
}

test('after the rewind is sent, a restart still shows the marker, the folded rewound part and the new turn, in order', async () => {
  const dirs = freshDirs();
  const a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  await a.send(s.id, 'one');
  await a.send(s.id, 'two');
  const sourceId = a.es(s.id).s.claudeSessionId;
  await a.rewindTo(s.id, 'two');
  const forkId = a.es(s.id).s.claudeSessionId;
  assert.strictEqual(await a.send(s.id, 'three'), 'seen: one | three', 'Claude sees only the kept part');
  const live = view(a.es(s.id).items);
  assert.deepStrictEqual(live, ['one', 'seen: one', '~two', '~seen: one | two', '[rewound: two]', 'three', 'seen: one | three']);
  await a.engine.shutdown();

  const saved = savedSession(dirs, s.id);
  assert.strictEqual(saved.forkFrom, undefined, 'nothing pending');
  assert.strictEqual(saved.rewinds.length, 1);
  assert.strictEqual(saved.rewinds[0].forkId, forkId);
  assert.strictEqual(saved.rewinds[0].shownId, sourceId);
  const three = readJsonl(path.join(dirs.projectsDir, slugFor(dirs.cwd), forkId + '.jsonl')).find((j) => j.type === 'user' && promptText(j.message) === 'three');
  assert.strictEqual(saved.rewinds[0].firstNew, three.uuid);

  // Restart: exactly what the user saw before it.
  const b = boot(dirs);
  const { items, hasMore } = await b.m['sessions.history']({ id: s.id });
  assert.strictEqual(hasMore, false);
  assert.deepStrictEqual(view(items), live);
  const marker = items.find((i) => i.rewind);
  assert.strictEqual(marker.subtype, 'info');
  assert.strictEqual(b.es(s.id).byId.get(marker.rewind.fromItemId).text, 'two');
  assert.strictEqual(new Set(items.map((i) => i.id)).size, items.length, 'ids are unique across stitched transcripts');

  // Claude's context is still the fork: the next send resumes it, not the source.
  assert.strictEqual(await b.send(s.id, 'four'), 'seen: one | three | four');
  assert.strictEqual(b.sdk.calls[0].options.resume, forkId);
  assert.ok(!b.sdk.calls[0].options.forkSession);
  await b.engine.shutdown();

  // And once more after that turn.
  const c = boot(dirs);
  const h = await c.m['sessions.history']({ id: s.id });
  assert.deepStrictEqual(view(h.items), [...live, 'four', 'seen: one | three | four']);
  await c.engine.shutdown();
});

test('two rewinds, each sent: both markers and folds survive a restart, oldest first', async () => {
  const dirs = freshDirs();
  const a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  await a.send(s.id, 'one');
  await a.send(s.id, 'two');
  await a.rewindTo(s.id, 'two');
  assert.strictEqual(await a.send(s.id, 'three'), 'seen: one | three');
  await a.rewindTo(s.id, 'three');
  assert.strictEqual(await a.send(s.id, 'four'), 'seen: one | four');
  const live = view(a.es(s.id).items);
  assert.deepStrictEqual(live, ['one', 'seen: one', '~two', '~seen: one | two', '[rewound: two]', '~three', '~seen: one | three', '[rewound: three]', 'four', 'seen: one | four']);
  await a.engine.shutdown();
  assert.strictEqual(savedSession(dirs, s.id).rewinds.length, 2);

  const b = boot(dirs);
  const { items } = await b.m['sessions.history']({ id: s.id });
  assert.deepStrictEqual(view(items), live);
  // Paging with a small limit walks back through every transcript in the same order.
  const pages = [];
  let before;
  for (let n = 0; n < 50; n++) {
    const r = await b.m['sessions.history']({ id: s.id, before, limit: 3 });
    pages.unshift(...r.items);
    if (!r.hasMore || !r.items.length) break;
    before = r.items[0].id;
  }
  assert.deepStrictEqual(pages.map((i) => i.id), items.map((i) => i.id));
  await b.engine.shutdown();
});

test('a rewind sent, then rewound again before sending: the new pending fork keeps the earlier fold too', async () => {
  const dirs = freshDirs();
  const a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  await a.send(s.id, 'one');
  await a.send(s.id, 'two');
  await a.rewindTo(s.id, 'two');
  await a.send(s.id, 'three');
  await a.rewindTo(s.id, 'three');
  const live = view(a.es(s.id).items);
  await a.engine.shutdown();
  const b = boot(dirs);
  const { items } = await b.m['sessions.history']({ id: s.id });
  assert.deepStrictEqual(view(items), live);
  assert.deepStrictEqual(live, ['one', 'seen: one', '~two', '~seen: one | two', '[rewound: two]', '~three', '~seen: one | three', '[rewound: three]']);
  assert.strictEqual(await b.send(s.id, 'five'), 'seen: one | five');
  await b.engine.shutdown();
});

test('StitchedPager reads tail-first: the newest segment first, older ones only on demand', () => {
  const dir = tmp('helm-stitch-');
  const line = (uuid, type, text) => JSON.stringify(type === 'user'
    ? { type, uuid, parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }
    : { type, uuid, parentUuid: null, timestamp: new Date().toISOString(), message: { id: 'm' + uuid, role: 'assistant', model: 'x', content: [{ type: 'text', text }] } });
  const A = path.join(dir, 'a.jsonl');
  const B = path.join(dir, 'b.jsonl');
  fs.writeFileSync(A, [line('a1', 'user', 'one'), line('a2', 'assistant', 'r1'), line('a3', 'user', 'two'), line('a4', 'assistant', 'r2')].join('\n') + '\n');
  const kept = [line('a1', 'user', 'one'), line('a2', 'assistant', 'r1')].join('\n') + '\n';
  fs.writeFileSync(B, kept + [line('b1', 'user', 'three'), line('b2', 'assistant', 'r3')].join('\n') + '\n');
  const marker = { id: 'rw1_0', type: 'system', subtype: 'info', text: 'Rewound', ts: 1 };
  const p = new StitchedPager([{ file: A, floor: 0, prefix: 's0t' }, { items: [marker] }, { file: B, floor: Buffer.byteLength(kept), prefix: 't' }]);
  const first = p.loadNewest(1);
  assert.deepStrictEqual(first.map((i) => i.text), ['three', 'r3'], 'only the fork’s own lines, not its copied kept part');
  assert.ok(p.hasOlder());
  assert.ok(p._mayBeOlder('s0t0'));
  assert.ok(!p.segs[0].pager.started, 'the source is not parsed yet');
  assert.deepStrictEqual(p.extendOlder(1).map((i) => i.id), ['rw1_0']);
  assert.deepStrictEqual(p.extendOlder(1).map((i) => i.text), ['one', 'r1', 'two', 'r2']);
  assert.ok(!p.hasOlder());
  assert.deepStrictEqual(p.items.map((i) => i.text), ['one', 'r1', 'two', 'r2', 'Rewound', 'three', 'r3']);
  assert.ok(p.items.every((i) => i.id.startsWith('s0t') || i.id.startsWith('t') || i.id === 'rw1_0'));
  assert.deepStrictEqual(p.files, [B, A]);
});

test('malformed saved rewinds are dropped, and a missing source falls back to the fork alone', async () => {
  const dirs = freshDirs();
  const a = boot(dirs);
  const s = await a.m['sessions.create']({ cwd: dirs.cwd });
  await a.send(s.id, 'one');
  await a.send(s.id, 'two');
  const sourceId = a.es(s.id).s.claudeSessionId;
  await a.rewindTo(s.id, 'two');
  await a.send(s.id, 'three');
  await a.engine.shutdown();
  // The source transcript is gone (deleted by hand): history is the fork's transcript, whole.
  fs.unlinkSync(path.join(dirs.projectsDir, slugFor(dirs.cwd), sourceId + '.jsonl'));
  const file = path.join(dirs.userDataDir, 'sessions.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.sessions.find((x) => x.id === s.id).rewinds.push({ forkId: '../x', shownId: 'y', firstNew: 'z', markers: [] });
  fs.writeFileSync(file, JSON.stringify(data));
  const b = boot(dirs);
  assert.strictEqual(b.es(s.id).s.rewinds.length, 1, 'the bad record is dropped');
  const { items } = await b.m['sessions.history']({ id: s.id });
  assert.deepStrictEqual(view(items), ['one', 'seen: one', 'three', 'seen: one | three']);
  await b.engine.shutdown();
});
