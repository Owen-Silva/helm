'use strict';
// sessions.markRead clears unread WITHOUT bumping updatedAt (lane sessions, 2026-10-08). updatedAt means
// "last used": the sidebar keeps sessions used in the last hour in its main list and moves the rest to
// Past, so merely opening an old session (every open calls markRead) must not count as use, on the
// desktop and the phone alike.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(turn, userDataDir = tmp('helm-mr-')) {
  const events = [];
  const engine = createEngine({
    userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk: createFakeSdk(turn), claudePath: null,
    projectsDir: tmp('helm-mrproj-'), statuslineDir: tmp('helm-mrsl-'), external: false, usageSampling: false,
  });
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return; await sleep(5); }
    throw new Error('timed out waiting');
  };
  const session = (id) => engine._internal.sessions.get(id).publicSession();
  return { engine, m: engine.methods, events, waitFor, session, userDataDir };
}

const okTurn = async function* () {
  for (const f of F.textTurn('m', 'ok')) yield f;
  yield F.result(0.1);
};

test('markRead clears unread, broadcasts and persists it, and leaves updatedAt alone', async () => {
  const h = harness(okTurn);
  const s = await h.m['sessions.create']({ cwd: tmp('helm-mrcwd-') });
  await h.m['sessions.send']({ id: s.id, text: 'hello' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.session(s.id).unread > 0);
  const before = h.session(s.id).updatedAt;
  await sleep(25);
  h.events.length = 0;
  await h.m['sessions.markRead']({ id: s.id });
  const after = h.session(s.id);
  assert.strictEqual(after.unread, 0);
  assert.strictEqual(after.updatedAt, before, 'opening a session is not using it');
  const upd = () => h.events.filter((e) => e.event === 'session.updated' && e.data.id === s.id && e.data.unread === 0);
  await h.waitFor(() => upd().length > 0, 1000).catch(() => {});   // session.updated is debounced (60 ms)
  assert.ok(upd().length >= 1, 'session.updated is still broadcast so other clients clear their unread');
  assert.strictEqual(upd().at(-1).data.updatedAt, before);
  // a second open of an already-read session changes nothing either
  await sleep(10);
  await h.m['sessions.markRead']({ id: s.id });
  assert.strictEqual(h.session(s.id).updatedAt, before);
  await h.engine.shutdown();

  const saved = JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'sessions.json'), 'utf8')).sessions.find((x) => x.id === s.id);
  assert.strictEqual(saved.unread, 0, 'unread 0 survives a restart');
  assert.strictEqual(saved.updatedAt, before, 'quitting Helm (its CLI stopped) is not use either');
});

test('real use still bumps updatedAt (send, update)', async () => {
  const h = harness(okTurn);
  const s = await h.m['sessions.create']({ cwd: tmp('helm-mrcwd-') });
  const t0 = h.session(s.id).updatedAt;
  await sleep(15);
  await h.m['sessions.send']({ id: s.id, text: 'hello' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  const t1 = h.session(s.id).updatedAt;
  assert.ok(t1 > t0, 'a turn counts as use');
  await sleep(15);
  await h.m['sessions.update']({ id: s.id, pinned: true });
  assert.ok(h.session(s.id).updatedAt > t1, 'pinning counts as use');
  await h.engine.shutdown();
});

test('resumedAt: a send after an hour unused stamps it (start order in the sidebar); recent or pinned sends do not', async () => {
  const h = harness(okTurn);
  const s = await h.m['sessions.create']({ cwd: tmp('helm-mrcwd-') });
  await h.m['sessions.send']({ id: s.id, text: 'first' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.strictEqual(h.session(s.id).resumedAt, null, 'a fresh session is ordered by createdAt');
  await h.m['sessions.send']({ id: s.id, text: 'again, right away' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  assert.strictEqual(h.session(s.id).resumedAt, null, 'recent use is not a resume');
  const es = h.engine._internal.sessions.get(s.id);
  es.s.updatedAt = Date.now() - 2 * 60 * 60 * 1000;   // unused for two hours: it sits in Past
  const t0 = Date.now();
  await h.m['sessions.send']({ id: s.id, text: 'picking this back up' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  const r = h.session(s.id).resumedAt;
  assert.ok(r >= t0 && r <= Date.now(), 'resumedAt = when it was picked back up');
  // a pinned session never left the list: no resume stamp
  const p = await h.m['sessions.create']({ cwd: tmp('helm-mrcwd-') });
  await h.m['sessions.update']({ id: p.id, pinned: true });
  h.engine._internal.sessions.get(p.id).s.updatedAt = Date.now() - 2 * 60 * 60 * 1000;
  await h.m['sessions.send']({ id: p.id, text: 'pinned one' });
  await h.waitFor(() => h.session(p.id).status === 'idle');
  assert.strictEqual(h.session(p.id).resumedAt, null);
  await h.engine.shutdown();
  const h2 = harness(okTurn, h.userDataDir);
  assert.strictEqual(h2.engine.snapshot().sessions.find((x) => x.id === s.id).resumedAt, r, 'resumedAt survives a restart');
  await h2.engine.shutdown();
});
