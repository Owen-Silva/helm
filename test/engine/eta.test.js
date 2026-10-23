'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mapEta, readEta, watchEta, EtaWatcher, defaultEtaDir, _internal } = require('../../main/engine/eta');

const FIX = path.join(__dirname, 'fixtures', 'eta');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const ID = 'ace0408c-5d02-498b-a1fb-1fc5076d8df5';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'helm-eta-'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

test('defaultEtaDir honours HELM_ETA_DIR', () => {
  const prev = process.env.HELM_ETA_DIR;
  process.env.HELM_ETA_DIR = 'X:\\eta';
  try { assert.strictEqual(defaultEtaDir(), 'X:\\eta'); } finally {
    if (prev === undefined) delete process.env.HELM_ETA_DIR; else process.env.HELM_ETA_DIR = prev;
  }
  if (!process.env.HELM_ETA_DIR) assert.ok(defaultEtaDir().replace(/\\/g, '/').endsWith('.claude/mods-data/eta'));
});

test('mapEta: real working snapshot -> contract shape, key order, no optional keys', () => {
  const m = mapEta(JSON.parse(fixture('working.json')));
  assert.deepStrictEqual(Object.keys(m), ['state', 'label', 'summary', 'etaAt', 'workStartedAt', 'isOverdue', 'agentsRunning', 'updatedAt']);
  assert.strictEqual(m.state, 'working');
  assert.strictEqual(m.label, '4 lanes running overnight');
  assert.strictEqual(m.etaAt, 1791449143898);
  assert.strictEqual(m.workStartedAt, 1791443958856);
  assert.strictEqual(m.updatedAt, 1791444400337);
  assert.strictEqual(m.agentsRunning, 7);
  assert.strictEqual(m.isOverdue, false);
});

test('mapEta: real ended snapshot, from JSON text too', () => {
  const m = mapEta(fixture('ended.json'));
  assert.deepStrictEqual(m, { state: 'ended', label: '', summary: '', etaAt: null, workStartedAt: null, isOverdue: false, agentsRunning: 0, updatedAt: 1791444023614 });
});

test('mapEta: plan fields (note/step/steps) pass through, step index clamped, label kept', () => {
  const base = JSON.parse(fixture('working.json'));
  const m = mapEta({ ...base, note: ' wiring ', steps: ['a', '', 'b', 3, 'c'], step: 9 });
  assert.strictEqual(m.note, 'wiring');
  assert.deepStrictEqual(m.steps, ['a', 'b', 'c']);
  assert.strictEqual(m.step, 3); // 1-based, clamped to steps.length
  assert.deepStrictEqual(Object.keys(m).slice(0, 6), ['state', 'label', 'summary', 'note', 'step', 'steps']);
  assert.strictEqual(mapEta({ ...base, step: 'b' }).step, 'b'); // a label stays a label
  assert.strictEqual(mapEta({ ...base, plan: { steps: ['x', 'y'], step: 2, note: 'n' } }).step, 2);
  assert.strictEqual(mapEta({ ...base, step: null }).step, undefined);
  assert.ok(!('note' in mapEta({ ...base, note: '   ' })));
});

test('mapEta: seconds and ISO timestamps normalise to epoch ms', () => {
  const m = mapEta({ v: 1, state: 'idle', updatedAt: 1791444400, etaAt: '2026-10-08T08:00:00.000Z', workStartedAt: '1791443958' });
  assert.strictEqual(m.updatedAt, 1791444400000);
  assert.strictEqual(m.etaAt, Date.parse('2026-10-08T08:00:00.000Z'));
  assert.strictEqual(m.workStartedAt, 1791443958000);
  assert.strictEqual(_internal.toMs('nonsense'), null);
  assert.strictEqual(_internal.toMs(-5), null);
});

test('mapEta: garbage -> null', () => {
  for (const g of [null, undefined, 42, 'nope', '', '{"v":1', [], {}, { state: 'idle' }, { updatedAt: 1 },
    { v: 2, state: 'idle', updatedAt: 1791444400337 }, { state: '', updatedAt: 1791444400337 },
    { state: 'idle', updatedAt: 'not a date' }]) {
    assert.strictEqual(mapEta(g), null, JSON.stringify(g));
  }
  const m = mapEta({ state: 'idle', updatedAt: 1791444400337, agentsRunning: -3, isOverdue: 'yes', label: 5 });
  assert.strictEqual(m.agentsRunning, 0);
  assert.strictEqual(m.isOverdue, false);
  assert.strictEqual(m.label, '');
});

test('readEta: good, missing, empty, partial, malformed, traversal', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ID + '.json'), fixture('working.json'));
    assert.strictEqual(readEta(ID, dir).agentsRunning, 7);
    assert.strictEqual(readEta('missing-id', dir), null);
    fs.writeFileSync(path.join(dir, 'empty.json'), '');
    assert.strictEqual(readEta('empty', dir), null);
    fs.writeFileSync(path.join(dir, 'partial.json'), fixture('partial.json'));
    assert.strictEqual(readEta('partial', dir), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '[1,2,3]');
    assert.strictEqual(readEta('bad', dir), null);
    assert.strictEqual(readEta('../x', dir), null);
    assert.strictEqual(readEta('', dir), null);
    assert.strictEqual(readEta(ID, path.join(dir, 'nope')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchEta: emits on create/change, keeps last good on corrupt write, null on delete, stop() clean', async () => {
  const dir = tmpDir();
  const file = path.join(dir, ID + '.json');
  const seen = [];
  const w = watchEta({ claudeSessionId: ID, etaDir: dir, onChange: (v) => seen.push(v), pollMs: 200, debounceMs: 30 });
  try {
    assert.strictEqual(w.current(), null);
    // created after the watcher started (watch is on the directory)
    fs.writeFileSync(file, fixture('working.json'));
    assert.ok(await until(() => seen.length === 1), 'emit on create');
    assert.strictEqual(seen[0].agentsRunning, 7);

    // same content rewritten -> no emit
    fs.writeFileSync(file, fixture('working.json'));
    await sleep(500);
    assert.strictEqual(seen.length, 1, 'no emit when unchanged');

    // corrupt / partial write -> keep last good, no emit
    fs.writeFileSync(file, fixture('partial.json'));
    await sleep(500);
    assert.strictEqual(seen.length, 1, 'no emit on partial');
    assert.strictEqual(w.current().agentsRunning, 7, 'last good kept');

    // writer finishes -> new value
    const next = { ...JSON.parse(fixture('working.json')), agentsRunning: 2, updatedAt: 1791444500000 };
    fs.writeFileSync(file, JSON.stringify(next));
    assert.ok(await until(() => seen.length === 2), 'emit on change');
    assert.strictEqual(seen[1].agentsRunning, 2);

    // other files in the dir do not matter
    fs.writeFileSync(path.join(dir, 'other.json'), fixture('ended.json'));
    await sleep(400);
    assert.strictEqual(seen.length, 2);

    fs.unlinkSync(file);
    assert.ok(await until(() => seen.length === 3), 'emit on delete');
    assert.strictEqual(seen[2], null);
    assert.strictEqual(w.current(), null);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EtaWatcher: initial value is read sync; poll fallback works without fs.watch; dir created later', async () => {
  const root = tmpDir();
  const dir = path.join(root, 'eta'); // does not exist yet: fs.watch fails, poll carries it
  const seen = [];
  const w = new EtaWatcher({ claudeSessionId: ID, etaDir: dir, onChange: (v) => seen.push(v), pollMs: 100, debounceMs: 10 });
  try {
    assert.strictEqual(w.current(), null);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ID + '.json'), fixture('working.json'));
    assert.ok(await until(() => seen.length === 1), 'poll picked it up');
    w.stop();
    const w2 = new EtaWatcher({ claudeSessionId: ID, etaDir: dir, onChange: () => assert.fail('no initial emit') });
    assert.strictEqual(w2.current().label, '4 lanes running overnight');
    w2.stop();
    const got = [];
    const w3 = new EtaWatcher({ claudeSessionId: ID, etaDir: dir, emitInitial: true, onChange: (v) => got.push(v) });
    w3.stop();
    assert.strictEqual(got.length, 1);
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watchEta: a throwing onChange does not break the watcher; bad id is inert', async () => {
  const dir = tmpDir();
  let calls = 0;
  const w = watchEta({ claudeSessionId: ID, etaDir: dir, pollMs: 100, debounceMs: 10, onChange: () => { calls++; throw new Error('boom'); } });
  const bad = watchEta({ claudeSessionId: '../evil', etaDir: dir, onChange: () => assert.fail() });
  try {
    fs.writeFileSync(path.join(dir, ID + '.json'), fixture('working.json'));
    assert.ok(await until(() => calls === 1));
    fs.writeFileSync(path.join(dir, ID + '.json'), fixture('ended.json'));
    assert.ok(await until(() => calls === 2));
    assert.strictEqual(bad.current(), null);
  } finally {
    w.stop();
    bad.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
