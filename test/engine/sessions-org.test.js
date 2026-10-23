'use strict';
// Session lifecycle (archive / unarchive / delete from Helm) and the usage.history wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function harness(turn, opts = {}) {
  const userDataDir = opts.userDataDir || tmp('helm-org-');
  const cwd = opts.cwd || tmp('helm-orgcwd-');
  const projectsDir = opts.projectsDir || tmp('helm-orgproj-');
  const events = [];
  const sdk = createFakeSdk(turn);
  const engine = createEngine({
    userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null,
    projectsDir, statuslineDir: tmp('helm-orgsl-'), external: false, usageSampling: false,
  });
  const m = engine.methods;
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out waiting');
  };
  const session = (id) => engine._internal.sessions.get(id).publicSession();
  return { engine, m, events, sdk, waitFor, session, userDataDir, cwd, projectsDir };
}

const okTurn = async function* () {
  for (const f of F.textTurn('m', 'ok')) yield f;
  yield F.result(0.25);
};

test('archive: stops the CLI, hides via archived flag, persists, unarchive, send brings it back', async () => {
  const userDataDir = tmp('helm-org-');
  const h = harness(okTurn, { userDataDir });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  assert.strictEqual(s.archived, false);
  await h.m['sessions.send']({ id: s.id, text: 'hello' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.engine._internal.sessions.get(s.id).live());

  const a = await h.m['sessions.archive']({ id: s.id, archived: true });
  assert.strictEqual(a.archived, true);
  assert.strictEqual(a.status, 'closed', 'archiving stops the CLI');
  assert.ok(h.sdk.calls[0].state.closed, 'CLI closed');
  assert.strictEqual(h.engine._internal.sessions.get(s.id).live(), false);
  await h.waitFor(() => h.events.some((e) => e.event === 'session.updated' && e.data.id === s.id && e.data.archived === true));
  await assert.rejects(h.m['sessions.archive']({ id: s.id, archived: 'yes' }), /archived must be a boolean/);
  await assert.rejects(h.m['sessions.archive']({ id: 's_nope' }), /Unknown session/);
  await h.engine.shutdown();

  // survives a restart
  const h2 = harness(okTurn, { userDataDir, cwd: h.cwd });
  assert.strictEqual(h2.engine.snapshot().sessions[0].archived, true);
  const u = await h2.m['sessions.archive']({ id: s.id, archived: false });
  assert.strictEqual(u.archived, false);
  assert.strictEqual(u.status, 'closed', 'unarchive does not start a CLI');
  await h2.m['sessions.archive']({ id: s.id }); // archived defaults to true
  assert.strictEqual(h2.session(s.id).archived, true);
  // writing to an archived session resumes it and brings it back to the list
  await h2.m['sessions.send']({ id: s.id, text: 'again' });
  assert.strictEqual(h2.session(s.id).archived, false);
  await h2.waitFor(() => h2.session(s.id).status === 'idle');
  await h2.engine.shutdown();
});

test('delete from Helm: drops the record + session.removed, never touches the Claude Code transcript', async () => {
  const userDataDir = tmp('helm-org-');
  const h = harness(okTurn, { userDataDir });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  const keep = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'hello' });
  await h.waitFor(() => h.session(s.id).status === 'idle');
  // a stand-in transcript where Claude Code keeps it: delete must leave it alone
  const tdir = path.join(h.projectsDir, 'C--fake');
  fs.mkdirSync(tdir, { recursive: true });
  const transcript = path.join(tdir, 'abc.jsonl');
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  const before = fs.readdirSync(h.projectsDir, { recursive: true }).sort();

  await h.m['sessions.delete']({ id: s.id });
  assert.ok(h.events.some((e) => e.event === 'session.removed' && e.data.id === s.id));
  const n = h.events.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!h.events.slice(n).some((e) => e.event === 'session.updated' && e.data.id === s.id), 'no late update resurrects it');
  assert.deepStrictEqual(h.engine.snapshot().sessions.map((x) => x.id), [keep.id]);
  await assert.rejects(h.m['sessions.send']({ id: s.id, text: 'x' }), /Unknown session/);
  await assert.rejects(h.m['sessions.delete']({ id: s.id }), /Unknown session/);
  assert.deepStrictEqual(fs.readdirSync(h.projectsDir, { recursive: true }).sort(), before, 'transcripts untouched');
  assert.ok(fs.existsSync(transcript));
  await h.engine.shutdown();

  const h2 = harness(okTurn, { userDataDir, cwd: h.cwd });
  assert.deepStrictEqual(h2.engine.snapshot().sessions.map((x) => x.id), [keep.id], 'gone after a restart too');
  await h2.engine.shutdown();
});

test('usage.history: result cost lands in costByDay under the session project', async () => {
  const h = harness(okTurn);
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'hello' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.session(s.id).costUsd === 0.25);
  const r = await h.m['usage.history']({ days: 2 });
  assert.ok(Array.isArray(r.samples));
  const today = r.costByDay[r.costByDay.length - 1];
  assert.strictEqual(today.usd, 0.25);
  assert.strictEqual(today.byProject[s.project], 0.25);
  await assert.rejects(h.m['usage.history']({ days: 'all' }), /days must be a number/);
  assert.ok(fs.existsSync(path.join(h.userDataDir, 'usage-history.jsonl')), 'written to <userData>/usage-history.jsonl');
  await h.engine.shutdown();
});
