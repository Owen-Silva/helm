// Unit tests for main/queue.js (overnight queue) with a fake clock, fake timers and a fake engine.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createQueue } = require('../../main/queue.js');

const tmpRoots = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-queue-'));
  tmpRoots.push(d);
  return d;
}
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function makeEngine(o = {}) {
  const e = {
    pct: 'pct' in o ? o.pct : 10,
    reason: o.reason,
    usageThrows: false,
    createStatus: o.createStatus || 'working',
    createThrows: null,
    history: o.history || [],
    calls: { create: [], history: [], usage: 0 },
  };
  let n = 0;
  e.methods = {
    'usage.get': async () => {
      e.calls.usage++;
      if (e.usageThrows) throw new Error('boom');
      return { fiveHour: { percent: e.pct, reason: e.reason } };
    },
    'sessions.create': async (p) => {
      e.calls.create.push(p);
      if (e.createThrows) throw new Error(e.createThrows);
      return { id: 's' + (++n), status: e.createStatus, activity: 'start failed here' };
    },
    'sessions.history': async (p) => {
      e.calls.history.push(p);
      return { items: typeof e.history === 'function' ? e.history(p) : e.history };
    },
  };
  return e;
}

function setup(o = {}) {
  const dir = o.dir || mkTmp();
  const engine = o.engine || makeEngine(o.engineOpts);
  const clock = { t: o.t ?? 1_700_000_000_000 };
  const emits = [], notifies = [], intervals = [], cleared = [];
  const q = createQueue({
    userDataDir: dir, engine,
    emit: (ev, data) => emits.push({ ev, data }),
    notify: (n) => notifies.push(n),
    getDefaults: o.getDefaults || (() => ({ model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'default' })),
    now: () => clock.t,
    setInterval: (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; },
    clearInterval: (h) => cleared.push(h),
    // main/account.js: absent = a subscription (the 5H gate as always)
    ...('usageLimits' in o ? { usageLimits: o.usageLimits } : {}),
    ...('startBlock' in o ? { startBlock: o.startBlock } : {}),
  });
  return { q, dir, engine, clock, emits, notifies, intervals, cleared };
}

const job = (q, id) => q.list().find((j) => j.id === id);

describe('add()', () => {
  test('validates prompt and cwd and numeric fields', () => {
    const { q } = setup({ engineOpts: { pct: null } });
    assert.throws(() => q.add({ cwd: 'C:\\p' }), { code: 'bad_params' });
    assert.throws(() => q.add({ prompt: '   ', cwd: 'C:\\p' }), { code: 'bad_params' });
    assert.throws(() => q.add({ prompt: 'x' }), { code: 'bad_params' });
    assert.throws(() => q.add({ prompt: 'x', cwd: '' }), { code: 'bad_params' });
    assert.throws(() => q.add(), { code: 'bad_params' });
    assert.throws(() => q.add({ prompt: 'x', cwd: 'C:\\p', runAfter: 'tomorrow' }), { code: 'bad_params' });
    assert.throws(() => q.add({ prompt: 'x', cwd: 'C:\\p', maxFiveHourPercent: 101 }), { code: 'bad_params' });
    assert.throws(() => q.add({ prompt: 'x', cwd: 'C:\\p', maxFiveHourPercent: -1 }), { code: 'bad_params' });
    assert.equal(q.list().length, 0);
  });

  test('fills defaults from getDefaults, persists and emits', async () => {
    const { q, dir, emits, clock } = setup({ engineOpts: { pct: null } });
    const j = q.add({ prompt: 'do it', cwd: 'C:\\proj' });
    assert.equal(j.status, 'queued');
    assert.equal(j.model, 'claude-opus-5-5');
    assert.equal(j.effort, 'xhigh');
    assert.equal(j.permissionMode, 'default');
    assert.equal(j.runAfter, null);
    assert.equal(j.maxFiveHourPercent, 85);
    assert.equal(j.createdAt, clock.t);
    assert.match(j.id, /^q_/);
    assert.ok(emits.some((e) => e.ev === 'queue.updated' && e.data.queue.length === 1));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
    assert.equal(saved.jobs[0].id, j.id);
    await flush();
  });

  test('explicit fields win over defaults; no defaults -> bypassPermissions', async () => {
    const { q } = setup({ engineOpts: { pct: null }, getDefaults: () => null });
    const j = q.add({ prompt: 'p', cwd: 'C:\\p', model: 'm', effort: 'low', runAfter: 5, maxFiveHourPercent: 40, bogus: 1 });
    assert.equal(j.model, 'm');
    assert.equal(j.effort, 'low');
    assert.equal(j.permissionMode, 'bypassPermissions');
    assert.equal(j.runAfter, 5);
    assert.equal(j.maxFiveHourPercent, 40);
    assert.equal(j.bogus, undefined);
    const j2 = q.add({ prompt: 'p', cwd: 'C:\\p' });
    assert.equal(j2.model, null);
    assert.equal(j2.effort, null);
    await flush();
  });

  test('returned job and list() are copies', async () => {
    const { q } = setup({ engineOpts: { pct: null } });
    const j = q.add({ prompt: 'p', cwd: 'C:\\p' });
    j.prompt = 'mutated';
    q.list()[0].prompt = 'mutated too';
    assert.equal(q.list()[0].prompt, 'p');
    await flush();
  });
});

describe('tick() gating', () => {
  test('starts only when 5H usage <= maxFiveHourPercent', async () => {
    const { q, engine } = setup({ engineOpts: { pct: 90 } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p', maxFiveHourPercent: 85 });
    await flush();
    assert.equal(job(q, id).status, 'queued');
    assert.match(job(q, id).waitReason, /90%.*85%/);
    assert.equal(engine.calls.create.length, 0);

    engine.pct = 85; // exactly at the limit is allowed
    await q.tick();
    const j = job(q, id);
    assert.equal(j.status, 'running');
    assert.equal(j.waitReason, undefined);
    assert.equal(j.sessionId, 's1');
    assert.equal(engine.calls.create.length, 1);
    assert.deepEqual(engine.calls.create[0], { cwd: 'C:\\p', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'default', prompt: 'p' });
  });

  test('unknown usage keeps the job queued with a waitReason', async () => {
    const { q, engine } = setup({ engineOpts: { pct: null } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(q, id).status, 'queued');
    assert.equal(job(q, id).waitReason, '5-hour usage is unknown right now');
    engine.reason = 'usage endpoint offline';
    await q.tick();
    assert.equal(job(q, id).waitReason, 'usage endpoint offline');
    engine.usageThrows = true;
    await q.tick();
    assert.match(job(q, id).waitReason, /unavailable: boom/);
    assert.equal(engine.calls.create.length, 0);
  });

  test('runAfter in the future -> not started, waits; starts once due', async () => {
    const { q, engine, clock } = setup();
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p', runAfter: clock.t + 60_000 });
    await flush();
    assert.equal(job(q, id).status, 'queued');
    assert.match(job(q, id).waitReason, /waiting/i);
    assert.equal(engine.calls.create.length, 0);
    clock.t += 60_000;
    await q.tick();
    assert.equal(job(q, id).status, 'running');
  });

  test('a later due job runs while an earlier one waits for its runAfter', async () => {
    const { q, clock } = setup();
    const a = q.add({ prompt: 'later', cwd: 'C:\\p', runAfter: clock.t + 60_000 });
    const b = q.add({ prompt: 'now', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(q, a.id).status, 'queued');
    assert.equal(job(q, b.id).status, 'running');
  });

  test('only one job runs at a time', async () => {
    const { q, engine } = setup();
    const a = q.add({ prompt: 'a', cwd: 'C:\\p' });
    const b = q.add({ prompt: 'b', cwd: 'C:\\p' });
    await flush();
    await q.tick();
    await q.tick();
    assert.equal(job(q, a.id).status, 'running');
    assert.equal(job(q, b.id).status, 'queued');
    assert.equal(engine.calls.create.length, 1);
  });

  test('sessions.create throwing -> failed "Could not start"', async () => {
    const engine = makeEngine();
    engine.createThrows = 'no claude';
    const { q, notifies } = setup({ engine });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(q, id).status, 'failed');
    assert.equal(job(q, id).summary, 'Could not start: no claude');
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0].kind, 'error');
  });

  test('create result with status error -> failed with its activity', async () => {
    const { q } = setup({ engineOpts: { createStatus: 'error' } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(q, id).status, 'failed');
    assert.equal(job(q, id).summary, 'start failed here');
  });
});

describe('session lifecycle', () => {
  test('working then idle -> done with the last assistant text', async () => {
    const history = [
      { type: 'assistant', text: 'first answer' },
      { type: 'user', text: 'more' },
      { type: 'assistant', text: '  final answer  ' },
      { type: 'assistant', text: '   ' },
      { type: 'tool', text: 'ignored' },
    ];
    const { q, engine, clock } = setup({ engineOpts: { createStatus: 'starting', history } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    const sid = job(q, id).sessionId;
    q.onEngineEvent('session.updated', { id: sid, status: 'working' });
    assert.equal(job(q, id).status, 'running');
    clock.t += 5000;
    q.onEngineEvent('session.updated', { id: sid, status: 'idle' });
    await flush();
    const j = job(q, id);
    assert.equal(j.status, 'done');
    assert.equal(j.summary, 'final answer');
    assert.equal(j.endedAt, clock.t);
    assert.deepEqual(engine.calls.history[0], { id: sid, limit: 200 });
  });

  test('summary is trimmed to <= 400 chars', async () => {
    const { q } = setup({ engineOpts: { history: [{ type: 'assistant', text: 'x'.repeat(1000) }] } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, id).sessionId, status: 'idle' });
    await flush();
    const s = job(q, id).summary;
    assert.ok(s.length <= 400, `length ${s.length}`);
    assert.ok(s.endsWith('\u2026'));
  });

  test('no assistant text -> "Finished."', async () => {
    const { q } = setup();
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, id).sessionId, status: 'idle' });
    await flush();
    assert.equal(job(q, id).summary, 'Finished.');
  });

  test('status error -> failed', async () => {
    const { q } = setup({ engineOpts: { createStatus: 'starting' } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, id).sessionId, status: 'error', activity: 'API overloaded' });
    await flush();
    assert.equal(job(q, id).status, 'failed');
    assert.equal(job(q, id).summary, 'API overloaded');
  });

  test('idle before ever seeing working/waiting does NOT finish', async () => {
    const { q } = setup({ engineOpts: { createStatus: 'starting' } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    const sid = job(q, id).sessionId;
    q.onEngineEvent('session.updated', { id: sid, status: 'idle' });
    await flush();
    assert.equal(job(q, id).status, 'running');
    q.onEngineEvent('session.updated', { id: sid, status: 'waiting' });
    q.onEngineEvent('session.updated', { id: sid, status: 'idle' });
    await flush();
    assert.equal(job(q, id).status, 'done');
  });

  test('create result status working counts as busy', async () => {
    const { q } = setup({ engineOpts: { createStatus: 'working' } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, id).sessionId, status: 'idle' });
    await flush();
    assert.equal(job(q, id).status, 'done');
  });

  test('closed: done if it was busy, failed otherwise', async () => {
    const { q } = setup({ engineOpts: { createStatus: 'starting' } });
    const a = q.add({ prompt: 'a', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, a.id).sessionId, status: 'closed' });
    await flush();
    assert.equal(job(q, a.id).status, 'failed');
    assert.equal(job(q, a.id).summary, 'The session was closed.');
  });

  test('events for unknown sessions and other event names are ignored', async () => {
    const { q } = setup();
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: 'nope', status: 'idle' });
    q.onEngineEvent('session.created', { id: job(q, id).sessionId, status: 'idle' });
    q.onEngineEvent('session.updated', null);
    await flush();
    assert.equal(job(q, id).status, 'running');
  });

  test('the next job starts after one finishes; exactly one notify when the batch drains', async () => {
    const { q, engine, notifies } = setup({ engineOpts: { history: [{ type: 'assistant', text: 'ok' }] } });
    const a = q.add({ prompt: 'first job', cwd: 'C:\\p' });
    const b = q.add({ prompt: 'second   job\nline', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, a.id).sessionId, status: 'idle' });
    await flush();
    assert.equal(job(q, a.id).status, 'done');
    assert.equal(notifies.length, 0, 'no notify while jobs remain');
    assert.equal(job(q, b.id).status, 'running');
    assert.equal(engine.calls.create.length, 2);
    q.onEngineEvent('session.updated', { id: job(q, b.id).sessionId, status: 'error' });
    q.onEngineEvent('session.updated', { id: job(q, b.id).sessionId, status: 'idle' }); // late duplicate
    await flush();
    assert.equal(job(q, b.id).status, 'failed');
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0].title, 'Queue finished');
    assert.equal(notifies[0].kind, 'error');
    assert.match(notifies[0].body, /^1 of 2 jobs done\./);
    assert.match(notifies[0].body, /Done: first job/);
    assert.match(notifies[0].body, /Failed: second job line/);
  });

  test('single successful job -> kind done, "1 of 1 job done."', async () => {
    const { q, notifies } = setup();
    const { id } = q.add({ prompt: 'only', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, id).sessionId, status: 'idle' });
    await flush();
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0].kind, 'done');
    assert.match(notifies[0].body, /^1 of 1 job done\./);
  });
});

describe('persistence', () => {
  test('a new queue on the same dir reloads jobs; running -> failed', async () => {
    const first = setup({ engineOpts: { createStatus: 'starting' } });
    const a = first.q.add({ prompt: 'runs', cwd: 'C:\\p' });
    await flush();
    const b = first.q.add({ prompt: 'waits', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(first.q, a.id).status, 'running');
    assert.equal(job(first.q, b.id).status, 'queued');

    const second = setup({ dir: first.dir, engineOpts: { pct: null } });
    const list = second.q.list();
    assert.equal(list.length, 2);
    assert.equal(job(second.q, a.id).status, 'failed');
    assert.match(job(second.q, a.id).summary, /closed while this job was running/);
    assert.equal(job(second.q, a.id).endedAt, second.clock.t);
    assert.equal(job(second.q, b.id).status, 'queued');
    assert.equal(second.q.file, path.join(first.dir, 'queue.json'));
  });

  test('corrupt queue.json -> empty queue', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'queue.json'), '{not json');
    const { q } = setup({ dir });
    assert.deepEqual(q.list(), []);
  });
});

describe('update()', () => {
  test('cancel a queued job; requeue it', async () => {
    const { q } = setup({ engineOpts: { pct: null } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.equal(q.update({ id, status: 'cancelled' }).status, 'cancelled');
    const re = q.update({ id, status: 'queued' });
    assert.equal(re.status, 'queued');
    await flush();
  });

  test('cannot cancel a running job or set running/done directly', async () => {
    const { q } = setup();
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(q, id).status, 'running');
    assert.throws(() => q.update({ id, status: 'cancelled' }), { code: 'bad_params' });
    assert.throws(() => q.update({ id, prompt: 'edited' }), { code: 'bad_params' });
    assert.equal(job(q, id).prompt, 'p');
    const other = setup({ engineOpts: { pct: null } });
    const o = other.q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.throws(() => other.q.update({ id: o.id, status: 'running' }), { code: 'bad_params' });
    assert.throws(() => other.q.update({ id: o.id, status: 'done' }), { code: 'bad_params' });
  });

  test('requeue a done/failed job clears run fields', async () => {
    const { q } = setup({ engineOpts: { history: [{ type: 'assistant', text: 'sum' }] } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    q.onEngineEvent('session.updated', { id: job(q, id).sessionId, status: 'idle' });
    await flush();
    assert.equal(job(q, id).status, 'done');
    assert.throws(() => q.update({ id, status: 'cancelled' }), { code: 'bad_params' });
    const re = q.update({ id, status: 'queued', prompt: 'again' });
    for (const k of ['summary', 'sessionId', 'waitReason', 'endedAt', 'startedAt']) assert.equal(re[k], undefined, k);
    assert.equal(re.status, 'queued');
    assert.equal(re.prompt, 'again');
  });

  test('edits are validated; unknown id -> not_found', async () => {
    const { q } = setup({ engineOpts: { pct: null } });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.throws(() => q.update({ id, prompt: '' }), { code: 'bad_params' });
    assert.throws(() => q.update({ id, maxFiveHourPercent: 500 }), { code: 'bad_params' });
    assert.equal(q.update({ id, maxFiveHourPercent: 50 }).maxFiveHourPercent, 50);
    assert.equal(q.update({ id, runAfter: null }).runAfter, null);
    assert.throws(() => q.update({ id: 'q_missing' }), { code: 'not_found' });
    await flush();
  });
});

describe('remove()', () => {
  test('removing a running job throws; queued is removed; unknown is a no-op', async () => {
    const { q } = setup();
    const a = q.add({ prompt: 'a', cwd: 'C:\\p' });
    const b = q.add({ prompt: 'b', cwd: 'C:\\p' });
    await flush();
    assert.equal(job(q, a.id).status, 'running');
    assert.throws(() => q.remove({ id: a.id }), { code: 'bad_params' });
    assert.deepEqual(q.remove({ id: b.id }), {});
    assert.equal(q.list().length, 1);
    assert.deepEqual(q.remove({ id: 'nope' }), {});
  });
});

describe('start()/stop()', () => {
  test('uses the injected interval and clears it', async () => {
    const { q, intervals, cleared, engine } = setup();
    q.start();
    q.start(); // idempotent
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 60_000);
    q.add({ prompt: 'p', cwd: 'C:\\p' });
    await flush();
    assert.equal(engine.calls.create.length, 1);
    q.stop();
    assert.deepEqual(cleared, [intervals[0]]);
    await flush();
  });
});

// ---------- review-main round: corruption recovery + field validation ----------
describe('review: persistence + validation', () => {
  test('a corrupt queue.json is kept aside, not overwritten by the next save', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'queue.json'), '{"jobs": [{"id": "q_1", "prompt": "overnight');
    const { q } = setup({ dir });
    q.add({ prompt: 'new', cwd: 'C:/x', runAfter: Date.now() + 1e9 });
    const aside = fs.readdirSync(dir).filter((f) => /^queue\.json\.bad-/.test(f));
    assert.equal(aside.length, 1);
    assert.match(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), /overnight/);
  });

  test('queue.json with a non-array jobs field (or junk entries) does not crash startup', () => {
    for (const body of ['{"jobs": {"a": 1}}', '[1,2]', 'null', '{"jobs": [null, 5, {"id": "q_ok", "prompt": "p", "cwd": "C:/x", "status": "queued"}]}']) {
      const dir = mkTmp();
      fs.writeFileSync(path.join(dir, 'queue.json'), body);
      let q;
      assert.doesNotThrow(() => { q = setup({ dir }).q; }, body);
      assert.ok(Array.isArray(q.list()), body);
      assert.ok(q.list().every((j) => j && typeof j === 'object' && typeof j.id === 'string'), body);
    }
  });

  test('model / effort / permissionMode are validated before they reach sessions.create', () => {
    const { q } = setup();
    const base = { prompt: 'p', cwd: 'C:/x' };
    for (const extra of [{ permissionMode: 'yolo' }, { permissionMode: 5 }, { model: {} }, { model: 'x'.repeat(201) }, { effort: ['high'] }, { prompt: 'x'.repeat(200_001) }, { cwd: 5 }]) {
      assert.throws(() => q.add({ ...base, ...extra }), { code: 'bad_params' }, JSON.stringify(extra).slice(0, 80));
    }
    const ok = q.add({ ...base, model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan', runAfter: Date.now() + 1e9 });
    assert.equal(ok.permissionMode, 'plan');
    assert.throws(() => q.update({ id: ok.id, permissionMode: 'yolo' }), { code: 'bad_params' });
  });
});

// Auth (main/account.js): the 5H gate belongs to Claude subscriptions. The API key has no 5-hour window
// (usageLimits() false): jobs run without the gate, still one at a time. No key (startBlock): the job waits, says why.
describe('auth: API key vs subscription', () => {
  const NO_KEY = { code: 'auth_required', message: 'No Anthropic API key: add one in Settings > Account.' };

  test('subscription (usageLimits true, the default): the 5H gate is exactly as before', async () => {
    for (const usageLimits of [undefined, () => true]) {
      const { q, engine } = setup({ engineOpts: { pct: null }, ...(usageLimits ? { usageLimits } : {}) });
      const { id } = q.add({ prompt: 'p', cwd: 'C:\p', maxFiveHourPercent: 50 });
      await flush();
      assert.equal(job(q, id).waitReason, '5-hour usage is unknown right now');
      engine.pct = 60;
      await q.tick();
      assert.match(job(q, id).waitReason, /60%.*50%/);
      engine.pct = 40;
      await q.tick();
      assert.equal(job(q, id).status, 'running');
      assert.ok(engine.calls.usage >= 3, 'usage was read for the gate');
    }
  });

  test('API key (usageLimits false): unknown 5H usage does not hold the job; it runs, one at a time', async () => {
    const { q, engine } = setup({ engineOpts: { pct: null }, usageLimits: () => false, startBlock: () => null });
    const a = q.add({ prompt: 'a', cwd: 'C:\p', maxFiveHourPercent: 10 });
    const b = q.add({ prompt: 'b', cwd: 'C:\p' });
    await flush();
    assert.equal(job(q, a.id).status, 'running');
    assert.equal(job(q, a.id).waitReason, undefined);
    assert.equal(job(q, b.id).status, 'queued', 'the next waits for the running one');
    assert.equal(engine.calls.create.length, 1);
    assert.equal(engine.calls.usage, 0, 'no 5H read at all');
    await q.tick();
    assert.equal(engine.calls.create.length, 1, 'still one at a time');
  });

  test('API key missing (startBlock): the job waits with the reason, then runs once a key is set', async () => {
    let block = NO_KEY;
    const { q, engine } = setup({ engineOpts: { pct: null }, usageLimits: () => false, startBlock: () => block });
    const { id } = q.add({ prompt: 'p', cwd: 'C:\p' });
    await flush();
    assert.equal(job(q, id).status, 'queued');
    assert.equal(job(q, id).waitReason, NO_KEY.message);
    assert.equal(engine.calls.create.length, 0, 'not failed: never tried');
    block = null;
    await q.tick();
    assert.equal(job(q, id).status, 'running');
    assert.equal(job(q, id).waitReason, undefined);
  });
});
