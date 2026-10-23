'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExternalTracker, _internal } = require('../../main/engine/external');

const FIX = path.join(__dirname, 'fixtures', 'external');
const MIN = 60 * 1000;

const line = (o) => JSON.stringify(o);
function transcript(cwd, prompt) {
  return [
    line({ type: 'user', isSidechain: false, message: { role: 'user', content: prompt }, uuid: 'u1', timestamp: '2026-10-08T00:00:00.000Z', cwd, sessionId: 'x' }),
    line({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, uuid: 'a1', timestamp: '2026-10-08T00:00:05.000Z', cwd }),
  ].join('\n') + '\n';
}
const touch = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);

// Builds a projects dir + eta dir. Returns { root, projects, etaDir, NOW, put(...) }.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ext-'));
  const projects = path.join(root, 'projects');
  const etaDir = path.join(root, 'eta');
  fs.mkdirSync(projects);
  fs.mkdirSync(etaDir);
  const NOW = Date.now();
  const put = (slug, id, { cwd = 'C:\\work\\shop', prompt = `prompt ${id}`, ageMs = 0, body } = {}) => {
    const dir = path.join(projects, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, body !== undefined ? body : transcript(cwd, prompt));
    touch(file, NOW - ageMs);
    return file;
  };
  const sub = (slug, id, name, ageMs) => {
    const d = path.join(projects, slug, id, 'subagents');
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, name);
    fs.writeFileSync(f, transcript('C:\\work\\shop', 'agent work'));
    touch(f, NOW - ageMs);
  };
  const etaSnap = (id, o) => fs.writeFileSync(path.join(etaDir, id + '.json'), JSON.stringify({
    v: 1, sessionId: id, project: 'shop', cwd: 'C:/work/shop', label: '', state: 'working', summary: '',
    etaAt: null, isOverdue: false, agentsRunning: 0, workStartedAt: null, updatedAt: NOW, ...o,
  }));
  return { root, projects, etaDir, NOW, put, sub, etaSnap, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function standard(fx) {
  const S = 'C--work-shop';
  fx.put(S, 'aaa-active', { ageMs: 10 * 1000, prompt: 'Fix the login page' });
  fx.put(S, 'bbb-agents', { ageMs: 5 * MIN });
  fx.sub(S, 'bbb-agents', 'agent-1.jsonl', 20 * 1000);
  fx.sub(S, 'bbb-agents', 'agent-0.jsonl', 50 * MIN);
  fx.put(S, 'ccc-oldagents', { ageMs: 2 * 60 * MIN }); // main 2 h old: subagents not consulted
  fx.sub(S, 'ccc-oldagents', 'agent-1.jsonl', 5 * 1000);
  fx.put(S, 'ddd-owned', { ageMs: 1000 });
  fx.put('C--tmp', 'eee-temp', { ageMs: 2000, cwd: path.join(os.tmpdir(), 'scratch-xyz') });
  for (let i = 0; i < 12; i++) fx.put('C--work-other', `idle-${String(i).padStart(2, '0')}`, { ageMs: (10 + i) * MIN, cwd: 'C:\\work\\other' });
  fx.put(S, 'zzz-stale', { ageMs: 25 * 60 * MIN });
  fx.put(S, 'yyy-blank', { ageMs: 3 * MIN, body: '' }); // no prompt/title, idle -> skipped
  fx.etaSnap('aaa-active', { label: 'Shipping v2', agentsRunning: 3 });
}

test('list(): ordering, active, subagent activity, idle cutoff, owned, temp, stale, eta label', async () => {
  const fx = makeFixture();
  try {
    standard(fx);
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir, now: () => fx.NOW, isOwned: (id) => id === 'ddd-owned' });
    const list = await tr.list();
    const ids = list.map((s) => s.claudeSessionId);
    assert.deepStrictEqual(ids.slice(0, 2), ['aaa-active', 'bbb-agents'], 'active first, newest first');
    assert.ok(list.slice(0, 2).every((s) => s.active));
    assert.ok(list.slice(2).every((s) => !s.active));
    assert.strictEqual(list.length, 2 + 10, 'only the last 10 idle');
    // idle sorted newest first: idle-00..idle-09 are 10..19 min old; ccc is 2 h old (cut)
    assert.deepStrictEqual(ids.slice(2), Array.from({ length: 10 }, (_, i) => `idle-${String(i).padStart(2, '0')}`));
    for (const gone of ['ddd-owned', 'eee-temp', 'zzz-stale', 'yyy-blank', 'agent-1', 'agent-0', 'ccc-oldagents']) {
      assert.ok(!ids.includes(gone), gone);
    }

    const a = list[0];
    assert.deepStrictEqual(Object.keys(a), ['claudeSessionId', 'cwd', 'project', 'title', 'lastActivity', 'active', 'agentsRunning', 'eta', 'transcriptPath']);
    assert.strictEqual(a.title, 'Shipping v2', 'eta label overrides the transcript title');
    assert.strictEqual(a.agentsRunning, 3);
    assert.strictEqual(a.eta.label, 'Shipping v2');
    assert.strictEqual(a.cwd, 'C:\\work\\shop');
    assert.strictEqual(a.project, 'shop');
    assert.strictEqual(a.transcriptPath, path.join(fx.projects, 'C--work-shop', 'aaa-active.jsonl'));

    const b = list[1];
    assert.strictEqual(b.title, 'prompt bbb-agents', 'transcript title without eta');
    assert.strictEqual(b.eta, null);
    assert.strictEqual(b.agentsRunning, 1, 'no eta mod: agent transcripts written in the last 90 s count as running (lane fleet)');
    assert.ok(Math.abs(b.lastActivity - (fx.NOW - 20 * 1000)) < 1500, 'lastActivity from the subagent file');
  } finally {
    fx.cleanup();
  }
});

test('list(): idle cutoff of 24 h, fewer than 10 idle, ended eta reports 0 agents, missing dir', async () => {
  const fx = makeFixture();
  try {
    fx.put('C--a', 'one', { ageMs: 23 * 60 * MIN });
    fx.put('C--a', 'two', { ageMs: 25 * 60 * MIN });
    fx.etaSnap('one', { state: 'ended', agentsRunning: 4 });
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir, now: () => fx.NOW });
    const list = await tr.list();
    assert.deepStrictEqual(list.map((s) => s.claudeSessionId), ['one']);
    assert.strictEqual(list[0].agentsRunning, 0);
    assert.strictEqual(list[0].active, false);
    const none = createExternalTracker({ projectsDir: path.join(fx.root, 'nope'), etaDir: fx.etaDir });
    assert.deepStrictEqual(await none.list(), []);
  } finally {
    fx.cleanup();
  }
});

test('list(): summaries are cached by path+mtime+size', async () => {
  const fx = makeFixture();
  try {
    const f = fx.put('C--a', 'one', { ageMs: 1000, prompt: 'first title' });
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir, now: () => fx.NOW });
    assert.strictEqual((await tr.list())[0].title, 'first title');
    fs.writeFileSync(f, transcript('C:\\work\\shop', 'second title, longer'));
    touch(f, fx.NOW - 500);
    assert.strictEqual((await tr.list())[0].title, 'second title, longer', 'reparsed after a change');
  } finally {
    fx.cleanup();
  }
});

test('history(): not_found for unknown / owned / bad ids; pages through readPage', async () => {
  const fx = makeFixture();
  try {
    const file = fx.put('C--a', 'sess-1', { ageMs: 1000 });
    fx.put('C--a', 'mine', { ageMs: 1000 });
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}` }));
    const calls = [];
    const readPage = async (f, { before, limit }) => {
      calls.push({ f, before, limit });
      let end = items.length;
      if (before) end = items.findIndex((x) => x.id === before);
      const start = Math.max(0, end - limit);
      return { items: items.slice(start, end), hasMore: start > 0 };
    };
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir, readPage, isOwned: (id) => id === 'mine' });
    for (const id of ['nope', 'mine', '../C--a/sess-1', '', undefined]) {
      await assert.rejects(tr.history({ claudeSessionId: id }), (e) => e.code === 'not_found', String(id));
    }
    // found without a prior list() (directory search)
    const p1 = await tr.history({ claudeSessionId: 'sess-1', limit: 3 });
    assert.deepStrictEqual(p1.items.map((x) => x.id), ['i4', 'i5', 'i6']);
    assert.strictEqual(p1.hasMore, true);
    const p2 = await tr.history({ claudeSessionId: 'sess-1', before: 'i4', limit: 3 });
    assert.deepStrictEqual(p2.items.map((x) => x.id), ['i1', 'i2', 'i3']);
    const p3 = await tr.history({ claudeSessionId: 'sess-1', before: 'i1', limit: 3 });
    assert.deepStrictEqual(p3.items.map((x) => x.id), ['i0']);
    assert.strictEqual(p3.hasMore, false);
    assert.strictEqual(calls[0].f, file);
  } finally {
    fx.cleanup();
  }
});

test('history(): default readPage (pager.js) on a fixture transcript', async () => {
  const fx = makeFixture();
  try {
    fx.put('C--work-shop', 'real-1', { body: fs.readFileSync(path.join(FIX, 'session.jsonl'), 'utf8') });
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir });
    const page = await tr.history({ claudeSessionId: 'real-1', limit: 50 });
    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1);
    assert.strictEqual(typeof page.hasMore, 'boolean');
  } finally {
    fx.cleanup();
  }
});

test('external.updated: only on change and only while something is active (plus the go-idle transition)', async () => {
  const fx = makeFixture();
  try {
    standard(fx);
    let now = fx.NOW;
    const events = [];
    const tr = createExternalTracker({
      projectsDir: fx.projects, etaDir: fx.etaDir, now: () => now, isOwned: (id) => id === 'ddd-owned',
      emit: (ev, data) => events.push({ ev, data }),
    });
    await tr.refresh();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].ev, 'external.updated');
    assert.strictEqual(events[0].data.sessions[0].claudeSessionId, 'aaa-active');

    await tr.refresh();
    assert.strictEqual(events.length, 1, 'unchanged -> no emit');

    // a write that only moves lastActivity -> no emit
    now += 5000;
    touch(path.join(fx.projects, 'C--work-shop', 'aaa-active.jsonl'), now - 1000);
    await tr.refresh();
    assert.strictEqual(events.length, 1, 'lastActivity alone is not a change');

    // eta heartbeat (updatedAt only) -> no emit; agents count -> emit
    fx.etaSnap('aaa-active', { label: 'Shipping v2', agentsRunning: 3, updatedAt: now });
    await tr.refresh();
    assert.strictEqual(events.length, 1, 'eta.updatedAt alone is not a change');
    fx.etaSnap('aaa-active', { label: 'Shipping v2', agentsRunning: 1, updatedAt: now });
    await tr.refresh();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].data.sessions[0].agentsRunning, 1);

    // everything goes idle -> one emit for the transition
    now += 10 * MIN;
    await tr.refresh();
    assert.strictEqual(events.length, 3, 'transition to idle is emitted');
    assert.ok(events[2].data.sessions.every((s) => !s.active));

    // idle and changed -> still no emit
    fx.etaSnap('aaa-active', { label: 'Renamed while idle', updatedAt: now });
    await tr.refresh();
    assert.strictEqual(events.length, 3, 'no emits while nothing is active');

    // start()/stop() leave no handle behind (the test process must exit)
    tr.start();
    tr.stop();
  } finally {
    fx.cleanup();
  }
});

test('poll never throws: a throwing emit / isOwned / log is contained', async () => {
  const fx = makeFixture();
  try {
    fx.put('C--a', 'one', { ageMs: 1000 });
    const tr = createExternalTracker({
      projectsDir: fx.projects, etaDir: fx.etaDir,
      emit: () => { throw new Error('emit boom'); },
      isOwned: () => { throw new Error('owned boom'); },
      log: () => { throw new Error('log boom'); },
    });
    await tr.refresh();
    assert.strictEqual((await tr.list()).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('signature ignores lastActivity and eta.updatedAt', () => {
  const s = { claudeSessionId: 'a', cwd: 'c', project: 'p', title: 't', lastActivity: 1, active: true, agentsRunning: 0, eta: { state: 'idle', updatedAt: 1 }, transcriptPath: 'f' };
  assert.strictEqual(_internal.signature([s]), _internal.signature([{ ...s, lastActivity: 2, eta: { state: 'idle', updatedAt: 9 } }]));
  assert.notStrictEqual(_internal.signature([s]), _internal.signature([{ ...s, title: 'u' }]));
});

// lane accuracy (2026-10-14): a terminal closed mid-work leaves its eta snapshot at "working, N agents"
// for good. The user's eta folder had four, 4 h to 6 days old. Their count must not show as running agents.
test('a stale eta snapshot never counts as running agents', async () => {
  const fx = makeFixture();
  try {
    const S = 'C--work-shop';
    fx.put(S, 'fresh-1', { ageMs: 10 * 1000 });
    fx.put(S, 'stale-1', { ageMs: 5 * MIN });
    fx.etaSnap('fresh-1', { agentsRunning: 2, updatedAt: fx.NOW - 2 * MIN });
    fx.etaSnap('stale-1', { agentsRunning: 1, updatedAt: fx.NOW - 245 * MIN });
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir, now: () => fx.NOW, isOwned: () => false });
    const list = await tr.list();
    const by = Object.fromEntries(list.map((s) => [s.claudeSessionId, s]));
    assert.strictEqual(by['fresh-1'].agentsRunning, 2);
    assert.strictEqual(by['stale-1'].agentsRunning, 0);
  } finally {
    fx.cleanup();
  }
});

// lane logs: the poll backs off while nothing is active and nothing changes; activity, a change or wake()
// (external.list) brings the fast poll back.
test('idle back-off: pollMs -> idlePollMs after idleAfterPolls quiet polls; activity or wake() resets it', async () => {
  const fx = makeFixture();
  try {
    let now = fx.NOW;
    fx.put('C--work-shop', 'old-1', { ageMs: 30 * MIN });
    const tr = createExternalTracker({ projectsDir: fx.projects, etaDir: fx.etaDir, now: () => now, emit: () => {}, pollMs: 15000, idlePollMs: 60000, idleAfterPolls: 4 });
    assert.strictEqual(tr.pollDelay(), 15000);
    for (let i = 0; i < 4; i++) await tr.refresh(); // first poll is a change (nothing seen yet), then 3 quiet
    assert.strictEqual(tr.pollDelay(), 15000, 'not yet: 3 quiet polls');
    await tr.refresh();
    assert.strictEqual(tr.pollDelay(), 60000, '4 quiet polls -> slow');
    tr.wake();
    assert.strictEqual(tr.pollDelay(), 15000, 'external.list wakes it');
    for (let i = 0; i < 4; i++) await tr.refresh();
    assert.strictEqual(tr.pollDelay(), 60000);
    const f = fx.put('C--work-shop', 'new-1', { ageMs: 0 }); // a terminal session starts writing
    await tr.refresh();
    assert.strictEqual(tr.pollDelay(), 15000, 'an active session -> fast');
    for (let i = 0; i < 6; i++) await tr.refresh();
    assert.strictEqual(tr.pollDelay(), 15000, 'stays fast while it is active');
    now += 10 * MIN; touch(f, fx.NOW);
    for (let i = 0; i < 5; i++) await tr.refresh();
    assert.strictEqual(tr.pollDelay(), 60000, 'quiet again -> slow');
    tr.start(); tr.wake(); tr.stop(); // no handle left behind
  } finally {
    fx.cleanup();
  }
});
