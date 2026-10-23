// Active hours (main/activity.js): line skimming, the counting rule, union vs sum, local-day
// split, the incremental cache and the activity.summary shape. Synthetic transcripts in a temp
// projects folder; never reads ~/.claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createActivity, runScan, summarize, _internal: A } = require('../../main/activity');

const MIN = 60 * 1000;
// Fixed local times (timezone-agnostic: built with the local Date constructor).
const DAY1 = new Date(2026, 9, 7, 10, 0, 0).getTime(); // Oct 7, 10:00 local
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();  // Oct 8, 12:00 local
const at = (base, min) => new Date(base + min * MIN).toISOString();
const TEMP = path.join(os.tmpdir(), 'helm-activity-fake-temp');

let seq = 0;
// Real Claude Code key order: parentUuid, isSidechain, type, message, uuid, timestamp, ..., cwd.
function line(o) { return JSON.stringify(o) + '\n'; }
function prompt(base, min, { cwd = 'C:\\code\\storefront', text = 'SECRET PROMPT do the thing', side = false } = {}) {
  return line({ parentUuid: null, isSidechain: side, type: 'user', message: { role: 'user', content: text }, uuid: 'u' + seq++, timestamp: at(base, min), cwd, sessionId: 's' });
}
function asst(base, min, { stop = 'tool_use', uses = [], side = false, cwd = 'C:\\code\\storefront' } = {}) {
  const content = uses.length ? uses.map(([id, name]) => ({ type: 'tool_use', id, name, input: { command: 'echo "hi" \\ there' } })) : [{ type: 'text', text: 'done "quoted" {braces} [x]' }];
  return line({ parentUuid: 'p', isSidechain: side, type: 'assistant', message: { model: 'm', id: 'msg', type: 'message', role: 'assistant', content, stop_reason: stop }, uuid: 'a' + seq++, timestamp: at(base, min), cwd });
}
function result(base, min, ids, { side = false } = {}) {
  return line({ parentUuid: 'p', isSidechain: side, type: 'user', message: { role: 'user', content: ids.map((id) => ({ tool_use_id: id, type: 'tool_result', content: 'x'.repeat(5000) + '"\\"}]' })) }, uuid: 'r' + seq++, timestamp: at(base, min), toolUseResult: { stdout: '{"type":"user","timestamp":"2020-01-01T00:00:00Z"}', nested: { a: [1, 2, { b: 'c' }] } }, cwd: 'C:\\code\\storefront' });
}
function sys(base, min, subtype) {
  return line({ parentUuid: 'p', isSidechain: false, type: 'system', subtype, durationMs: 1, timestamp: at(base, min), uuid: 'y' + seq++, cwd: 'C:\\code\\storefront' });
}
function attachment(base, min) {
  return line({ parentUuid: 'p', isSidechain: false, attachment: { type: 'user', content: 'not a prompt' }, type: 'attachment', uuid: 'z' + seq++, timestamp: at(base, min) });
}

function tmpProjects() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-activity-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeMain(dir, slug, id, text) {
  fs.mkdirSync(path.join(dir, slug), { recursive: true });
  const f = path.join(dir, slug, id + '.jsonl');
  fs.writeFileSync(f, text);
  return f;
}
function writeSub(dir, slug, id, agent, text) {
  const d = path.join(dir, slug, id, 'subagents');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `agent-${agent}.jsonl`);
  fs.writeFileSync(f, text);
  return f;
}
async function scan(dir, cache = null, now = NOW) {
  return A.scanAll({ projectsDir: dir, cache, now, tempDir: TEMP });
}
const total = (arr) => arr.reduce((a, b) => a + b, 0);
// Feed lines straight into one Stream (no files): -> total counted ms.
function streamTotal(text, isSub = false) {
  const st = new A.Stream(null);
  for (const l of text.split('\n')) {
    if (!l) continue;
    const e = A.classify(A.skimLine(Buffer.from(l), false), isSub);
    if (e) st.event(e, A.DEFAULTS.capMs);
  }
  const iv = st.intervals();
  let t = 0;
  for (let i = 0; i < iv.length; i += 2) t += iv[i + 1] - iv[i];
  return { ms: t, st };
}

test.describe('skimLine()', () => {
  test.it('reads type, timestamp, stop reason and tool ids whatever the key order, without decoding big values', () => {
    const r = A.skimLine(Buffer.from(result(DAY1, 3, ['toolu_1', 'toolu_2']).trim()), true);
    assert.equal(r.type, 'user');
    assert.equal(r.ts, at(DAY1, 3));
    assert.deepEqual(r.results, ['toolu_1', 'toolu_2']);
    assert.equal(r.cwd, 'C:\\code\\storefront');
    const a = A.skimLine(Buffer.from(asst(DAY1, 1, { uses: [['toolu_9', 'Agent'], ['toolu_8', 'Bash'], ['toolu_7', 'AskUserQuestion']] }).trim()), false);
    assert.equal(a.stop, 'tool_use');
    assert.deepEqual(a.uses, [['toolu_9', 1], ['toolu_8', 0], ['toolu_7', 2]]);
    // timestamp before type, message last
    const swapped = Buffer.from(JSON.stringify({ timestamp: at(DAY1, 0), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, type: 'user' }));
    const s = A.skimLine(swapped, false);
    assert.equal(s.textHead.startsWith('[Request interrupted'), true);
    assert.equal(A.classify(s, false).k, 4 /* END */);
  });

  test.it('ignores attachments (even with a nested "type":"user"), titles and malformed lines', () => {
    assert.equal(A.skimLine(Buffer.from(attachment(DAY1, 0).trim()), false), null);
    assert.equal(A.skimLine(Buffer.from('{"type":"ai-title","aiTitle":"x"}'), false), null);
    assert.equal(A.skimLine(Buffer.from('{"type":"user","message":{"content":"unterminated'), false), null);
    assert.equal(A.skimLine(Buffer.from('not json'), false), null);
  });
});

test.describe('counting rule (one stream)', () => {
  test.it('caps a single gap at 10 minutes, placed right after the earlier event', () => {
    const { ms, st } = streamTotal(prompt(DAY1, 0) + asst(DAY1, 1, { uses: [['t1', 'Bash']] }) + result(DAY1, 25, ['t1']) + asst(DAY1, 26, { stop: 'end_turn' }));
    assert.equal(ms, (1 + 10 + 1) * MIN);
    assert.deepEqual(st.intervals(), [DAY1, DAY1 + 11 * MIN, DAY1 + 25 * MIN, DAY1 + 26 * MIN]);
  });

  test.it('time between turns never counts; a turn ends at its last assistant message + tail', () => {
    const text = prompt(DAY1, 0) + asst(DAY1, 5, { stop: 'end_turn' }) + sys(DAY1, 5.5, 'stop_hook_summary') + sys(DAY1, 6, 'turn_duration')
      + sys(DAY1, 30, 'away_summary') + attachment(DAY1, 40)
      + prompt(DAY1, 60) + asst(DAY1, 62, { stop: 'end_turn' });
    assert.equal(streamTotal(text).ms, (6 + 2) * MIN);
  });

  test.it('a tool_result is not a new turn: the wait for the tool counts', () => {
    const text = prompt(DAY1, 0) + asst(DAY1, 2, { uses: [['t1', 'Bash']] }) + result(DAY1, 8, ['t1']) + asst(DAY1, 9, { stop: 'end_turn' });
    assert.equal(streamTotal(text).ms, 9 * MIN);
  });

  test.it('waiting on an Agent call or on the user (AskUserQuestion) does not count for that stream', () => {
    const agent = prompt(DAY1, 0) + asst(DAY1, 1, { uses: [['t1', 'Agent']] }) + result(DAY1, 20, ['t1']) + asst(DAY1, 21, { stop: 'end_turn' });
    assert.equal(streamTotal(agent).ms, 2 * MIN);
    const ask = prompt(DAY1, 0) + asst(DAY1, 1, { uses: [['q1', 'AskUserQuestion']] }) + result(DAY1, 7, ['q1']) + asst(DAY1, 8, { stop: 'end_turn' });
    assert.equal(streamTotal(ask).ms, 2 * MIN);
    // an Agent and a Bash in flight together: the Bash is work, so the gap counts
    const mixed = prompt(DAY1, 0) + asst(DAY1, 1, { uses: [['a1', 'Agent'], ['b1', 'Bash']] }) + result(DAY1, 4, ['b1']) + result(DAY1, 9, ['a1']) + asst(DAY1, 10, { stop: 'end_turn' });
    assert.equal(streamTotal(mixed).ms, 4 * MIN + 1 * MIN);
  });

  test.it('an interrupt ends the turn; a scheduled task fire starts one', () => {
    const text = prompt(DAY1, 0) + asst(DAY1, 3, { uses: [['t1', 'Bash']] })
      + line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: at(DAY1, 4) })
      + asst(DAY1, 30, { stop: 'end_turn' }) // a stray event after an interrupt opens a fresh interval at itself
      + sys(DAY1, 60, 'scheduled_task_fire') + line({ type: 'user', isMeta: true, message: { role: 'user', content: 'cron prompt' }, timestamp: at(DAY1, 60) })
      + asst(DAY1, 64, { stop: 'end_turn' });
    assert.equal(streamTotal(text).ms, 3 * MIN + 0 + 4 * MIN);
  });
});

test.describe('scanAll() over a projects folder', () => {
  test.it('active time is the union, agent-hours the sum (sessions + subagents), split by project', async () => {
    const dir = tmpProjects();
    // storefront main: 10:00-10:10; helm main: 10:05-10:15; storefront subagent: 10:02-10:08
    writeMain(dir, 'C--code-storefront', 'a1', prompt(DAY1, 0) + asst(DAY1, 5, { uses: [['b', 'Bash']] }) + result(DAY1, 9, ['b']) + asst(DAY1, 10, { stop: 'end_turn' }));
    writeMain(dir, 'C--code-helm', 'h1', prompt(DAY1, 5, { cwd: 'C:\\code\\helm' }) + asst(DAY1, 15, { stop: 'end_turn', cwd: 'C:\\code\\helm' }));
    writeSub(dir, 'C--code-storefront', 'a1', 'abc', prompt(DAY1, 2, { side: true }) + asst(DAY1, 6, { side: true, uses: [['x', 'Read']] }) + result(DAY1, 7, ['x'], { side: true }) + asst(DAY1, 8, { side: true, stop: 'end_turn' }));
    const { result: r } = await scan(dir);
    const s = summarize(r, 14);
    assert.equal(s.days.length, 14);
    assert.equal(s.days[12].date, A.localDayKey(DAY1));
    assert.equal(s.days[12].activeMs, 15 * MIN);
    assert.equal(s.days[12].agentMs, (10 + 10 + 6) * MIN);
    assert.equal(s.today.activeMs, 0);
    assert.equal(s.week.activeMs, 15 * MIN);
    const storefront = s.byProject.find((p) => p.project === 'storefront');
    const helm = s.byProject.find((p) => p.project === 'helm');
    assert.equal(storefront.activeMs, 10 * MIN);
    assert.equal(storefront.agentMs, 16 * MIN);
    assert.equal(helm.activeMs, 10 * MIN);
    assert.equal(s.byProject[0].project, 'storefront'); // sorted by active time, then agent-hours
    assert.equal(r.files, 3);
  });

  test.it('splits an interval across local midnight', async () => {
    const dir = tmpProjects();
    const late = new Date(2026, 9, 7, 23, 50, 0).getTime();
    let text = prompt(late, 0);
    for (let m = 5; m <= 30; m += 5) text += asst(late, m, { stop: m === 30 ? 'end_turn' : 'tool_use', uses: m === 30 ? [] : [['t' + m, 'Bash']] }) + (m < 30 ? result(late, m + 0.5, ['t' + m]) : '');
    writeMain(dir, 'C--code-storefront', 'mid', text);
    const s = summarize((await scan(dir)).result, 2);
    assert.deepEqual(s.days.map((d) => d.date), [A.localDayKey(late), A.localDayKey(NOW)]);
    assert.equal(s.days[0].activeMs, 10 * MIN);
    assert.equal(s.days[1].activeMs, 20 * MIN);
    assert.equal(s.today.activeMs, 20 * MIN);
  });

  test.it('rescans parse only appended bytes, and match a fresh full scan', async () => {
    const dir = tmpProjects();
    const part1 = prompt(DAY1, 0) + asst(DAY1, 2, { uses: [['t1', 'Bash']] });
    const f = writeMain(dir, 'C--code-storefront', 'inc', part1);
    const first = await scan(dir);
    assert.equal(first.result.bytesRead, Buffer.byteLength(part1));
    assert.equal(summarize(first.result, 14).days[12].activeMs, 2 * MIN, 'a turn in progress counts up to its latest event');
    const part2 = result(DAY1, 6, ['t1']) + asst(DAY1, 7, { stop: 'end_turn' });
    fs.appendFileSync(f, part2);
    const second = await scan(dir, first.cache);
    assert.equal(second.result.filesRead, 1);
    assert.equal(second.result.bytesRead, Buffer.byteLength(part2), 'only the appended bytes were read');
    const fresh = await scan(dir);
    assert.deepEqual(second.result.active, fresh.result.active);
    assert.deepEqual(second.result.agent, fresh.result.agent);
    assert.equal(summarize(second.result, 14).days[12].activeMs, 7 * MIN);
    // unchanged file: nothing read
    const third = await scan(dir, second.cache);
    assert.equal(third.result.filesRead, 0);
    assert.equal(third.result.bytesRead, 0);
  });

  test.it('a rewritten file (bytes before the offset changed) is re-read from the start', async () => {
    const dir = tmpProjects();
    const f = writeMain(dir, 'C--code-storefront', 'rw', prompt(DAY1, 0) + asst(DAY1, 3, { stop: 'end_turn' }));
    const first = await scan(dir);
    fs.writeFileSync(f, prompt(DAY1, 100) + asst(DAY1, 101, { stop: 'end_turn' }) + prompt(DAY1, 200) + asst(DAY1, 205, { stop: 'end_turn' }));
    const second = await scan(dir, first.cache);
    assert.equal(summarize(second.result, 14).days[12].activeMs, 6 * MIN);
  });

  test.it('a truncated last line waits for its newline and is then counted once', async () => {
    const dir = tmpProjects();
    const full = asst(DAY1, 9, { stop: 'end_turn' });
    const cut = 40;
    const f = writeMain(dir, 'C--code-storefront', 'trunc', prompt(DAY1, 0) + asst(DAY1, 4, { uses: [['t', 'Bash']] }) + result(DAY1, 5, ['t']) + full.slice(0, cut));
    const first = await scan(dir);
    assert.equal(summarize(first.result, 14).days[12].activeMs, 5 * MIN);
    fs.appendFileSync(f, full.slice(cut));
    const second = await scan(dir, first.cache);
    assert.equal(summarize(second.result, 14).days[12].activeMs, 9 * MIN);
    assert.equal(second.result.bytesRead, Buffer.byteLength(full), 'the partial line is re-read whole, nothing else');
  });

  test.it('skips files last written before the window and a missing projects folder', async () => {
    const dir = tmpProjects();
    const f = writeMain(dir, 'C--code-storefront', 'old', prompt(DAY1, 0) + asst(DAY1, 3, { stop: 'end_turn' }));
    const old = new Date(2026, 6, 1).getTime() / 1000;
    fs.utimesSync(f, old, old);
    const { result: r } = await scan(dir);
    assert.equal(r.files, 0);
    const none = await scan(path.join(dir, 'nope'));
    assert.equal(none.result.missing, true);
    assert.equal(summarize(none.result, 14).missing, true);
  });
});

test.describe('createActivity() / activity.summary', () => {
  test.it('returns the PROTOCOL shape, keeps the cache free of prompt text, reports work in progress as live', async () => {
    const dir = tmpProjects();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-activity-profile-'));
    test.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const live = NOW - 30 * MIN;
    writeMain(dir, 'C--code-storefront', 'live', prompt(live, 0) + asst(live, 9, { uses: [['t', 'Bash']] }) + result(live, 18, ['t']) + asst(live, 25, { uses: [['u', 'Bash']] }));
    writeMain(dir, 'C--code-storefront', 'done', prompt(live, 0) + asst(live, 10, { stop: 'end_turn' }));
    const act = createActivity({ profileDir: profile, projectsDir: dir, useWorker: false, now: () => NOW });
    const s = await act.methods['activity.summary']({ days: 7 });
    assert.equal(s.days.length, 7);
    assert.deepEqual(Object.keys(s.days[0]).sort(), ['activeMs', 'agentMs', 'date']);
    assert.equal(s.today.activeMs, 25 * MIN);
    assert.equal(s.today.agentMs, 35 * MIN);
    assert.equal(s.live.workingNow, 1);
    assert.equal(s.byProject[0].project, 'storefront');
    assert.equal(typeof s.scannedAt, 'number');
    assert.equal(typeof s.scanMs, 'number');
    assert.equal(s.files, 2);
    const cacheText = fs.readFileSync(path.join(profile, 'activity-cache.json'), 'utf8');
    assert.equal(cacheText.includes('SECRET'), false, 'no prompt text in the cache');
    await assert.rejects(act.summary({ days: 0 }), { code: 'bad_params' });
    await assert.rejects(act.summary({ days: 31 }), { code: 'bad_params' });
    // within a minute the previous scan is reused
    const again = await act.summary({ days: 14 });
    assert.equal(again.scannedAt, s.scannedAt);
  });

  test.it('scans in a worker thread with the same result as inline', async () => {
    const dir = tmpProjects();
    writeMain(dir, 'C--code-storefront', 'w', prompt(DAY1, 0) + asst(DAY1, 4, { stop: 'end_turn' }));
    const inline = await createActivity({ projectsDir: dir, useWorker: false, now: () => NOW }).summary({ days: 14 });
    let logged = null;
    const worker = await createActivity({ projectsDir: dir, useWorker: true, now: () => NOW, log: (...a) => { logged = a.join(' '); } }).summary({ days: 14 });
    assert.equal(logged, null, 'the worker ran (no inline fallback)');
    assert.deepEqual(worker.days, inline.days);
    assert.deepEqual(worker.byProject, inline.byProject);
  });

  test.it('rpcHandler is lazy and validates params', async () => {
    const { rpcHandler } = require('../../main/activity');
    const h = rpcHandler({ settings: {}, log: () => {} });
    await assert.rejects(h({ days: 'x' }), { code: 'bad_params' });
  });

  test.it('runScan persists and reloads the cache', async () => {
    const dir = tmpProjects();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-activity-profile-'));
    test.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const cachePath = path.join(profile, 'activity-cache.json');
    writeMain(dir, 'C--code-storefront', 'p', prompt(DAY1, 0) + asst(DAY1, 4, { stop: 'end_turn' }));
    const a = await runScan({ projectsDir: dir, cachePath, now: NOW, tempDir: TEMP });
    assert.equal(a.result.filesRead, 1);
    const b = await runScan({ projectsDir: dir, cachePath, now: NOW, tempDir: TEMP });
    assert.equal(b.result.filesRead, 0, 'the saved cache was reused');
    assert.deepEqual(b.result.active, a.result.active);
  });
});

test.describe('all time (phase 2)', () => {
  const JUL = new Date(2026, 6, 3, 9, 0, 0).getTime(); // Jul 3, 09:00 local: outside the 30-day window
  const age = (f, ms) => fs.utimesSync(f, ms / 1000, ms / 1000);
  const Booking = 'C:\\code\\booking';
  // A turn from `from` to `to` minutes with a step every 5 minutes (no gap reaches the 10-minute cap).
  const turn = (base, from, to, o = {}) => {
    let out = prompt(base, from, o);
    for (let m = from + 5; m < to; m += 5) out += asst(base, m, { ...o, uses: [['t' + m, 'Bash']] }) + result(base, m, ['t' + m]);
    return out + asst(base, to, { ...o, stop: 'end_turn' });
  };

  test.it('adds every older transcript: union / sum, since, months and projects', async () => {
    const dir = tmpProjects();
    age(writeMain(dir, 'C--code-booking', 'old', turn(JUL, 0, 20, { cwd: Booking })), JUL + 864e5);
    writeMain(dir, 'C--code-storefront', 'a', prompt(DAY1, 0) + asst(DAY1, 10, { stop: 'end_turn' }));
    writeMain(dir, 'C--code-storefront', 'b', prompt(DAY1, 5) + asst(DAY1, 15, { stop: 'end_turn' }));
    const progress = [];
    let windowAt = null;
    const out = await A.scanAll({
      projectsDir: dir, cache: null, now: NOW, tempDir: TEMP,
      onWindow: (r) => { windowAt = progress.length; assert.equal(r.files, 2); },
      onProgress: (d, n) => progress.push([d, n]),
    });
    assert.equal(windowAt, 0, 'the window is handed back before phase 2 reports anything');
    assert.equal(out.result.files, 2, 'the 14-day view still only counts the window');
    const a = out.allTime;
    assert.equal(a.activeMs, 20 * MIN + 15 * MIN, 'union: July 20m + Oct 0..15m');
    assert.equal(a.agentMs, 20 * MIN + 20 * MIN, 'sum: the two Oct sessions overlap');
    assert.equal(a.since, '2026-07-03');
    assert.deepEqual(a.byMonth.map((m) => m.month), ['2026-07', '2026-08', '2026-09', '2026-10'], 'zero months included');
    assert.deepEqual(a.byMonth.map((m) => m.activeMs), [20 * MIN, 0, 0, 15 * MIN]);
    assert.deepEqual(a.byProject.map((p) => [p.project, p.activeMs, p.agentMs]), [['booking', 20 * MIN, 20 * MIN], ['storefront', 15 * MIN, 20 * MIN]]);
    assert.equal(a.files, 3);
    assert.deepEqual(progress[0], [2, 3]);
    assert.deepEqual(progress[progress.length - 1], [3, 3]);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0], 'progress only grows');
  });

  test.it('splits months across a year boundary', async () => {
    const mb = A.monthBounds(new Date(2025, 11, 15).getTime(), new Date(2026, 1, 10).getTime());
    assert.deepEqual(mb.keys, ['2025-12', '2026-01', '2026-02']);
    const nye = new Date(2025, 11, 31, 23, 50).getTime();
    assert.deepEqual(A.addToDays([nye, nye + 20 * MIN], mb, [0, 0, 0]), [10 * MIN, 10 * MIN, 0]);
    const dir = tmpProjects();
    age(writeMain(dir, 'C--code-storefront', 'nye', turn(nye, 0, 20)), nye + 3600e3);
    const now = new Date(2026, 1, 10, 12).getTime();
    const { allTime } = await scan(dir, null, now);
    assert.deepEqual(allTime.byMonth, [
      { month: '2025-12', activeMs: 10 * MIN, agentMs: 10 * MIN },
      { month: '2026-01', activeMs: 10 * MIN, agentMs: 10 * MIN },
      { month: '2026-02', activeMs: 0, agentMs: 0 },
    ]);
    assert.equal(allTime.since, '2025-12-31');
    // a bogus ancient timestamp can't make hundreds of bars
    const capped = A.monthBounds(0, now, 120);
    assert.equal(capped.keys.length, 120);
    assert.equal(capped.keys[119], '2026-02');
  });

  test.it('activity.summary({ allTime: true }) serves the window first, then all time; scanning has { done, total }', async () => {
    const dir = tmpProjects();
    for (let i = 0; i < 12; i++) age(writeMain(dir, 'C--code-booking', 'old' + i, prompt(JUL, i * 30, { cwd: Booking }) + asst(JUL, i * 30 + 10, { stop: 'end_turn' })), JUL + 864e5);
    writeMain(dir, 'C--code-storefront', 'a', prompt(DAY1, 0) + asst(DAY1, 10, { stop: 'end_turn' }));
    const act = createActivity({ projectsDir: dir, useWorker: false, now: () => NOW, opts: { allTimeConcurrency: 1, progressMs: 0 } });
    const first = await act.summary({ days: 14, allTime: true });
    assert.equal(first.days[12].activeMs, 10 * MIN, 'the 14-day view is ready');
    assert.deepEqual(Object.keys(first.allTime), ['scanning'], 'all time is still counting: no numbers yet');
    assert.deepEqual(Object.keys(first.allTime.scanning).sort(), ['done', 'total']);
    assert.ok(first.allTime.scanning.done <= first.allTime.scanning.total);
    await act.whenIdle();
    const second = await act.summary({ days: 14, allTime: true });
    assert.equal(second.scannedAt, first.scannedAt, 'no rescan within a minute');
    assert.equal(second.allTime.scanning, undefined);
    assert.equal(second.allTime.activeMs, 12 * 10 * MIN + 10 * MIN);
    assert.equal(second.allTime.since, '2026-07-03');
    assert.equal(second.allTime.files, 13);
    assert.equal((await act.summary({ days: 14 })).allTime, undefined, 'only when asked');
    await assert.rejects(act.summary({ allTime: 'yes' }), { code: 'bad_params' });
  });

  test.it('the worker streams window, progress and all time like inline', async () => {
    const dir = tmpProjects();
    age(writeMain(dir, 'C--code-booking', 'old', turn(JUL, 0, 20, { cwd: Booking })), JUL + 864e5);
    writeMain(dir, 'C--code-storefront', 'a', prompt(DAY1, 0) + asst(DAY1, 10, { stop: 'end_turn' }));
    const inline = createActivity({ projectsDir: dir, useWorker: false, now: () => NOW });
    await inline.summary({ allTime: true });
    await inline.whenIdle();
    let logged = null;
    const worker = createActivity({ projectsDir: dir, useWorker: true, now: () => NOW, log: (...a) => { logged = a.join(' '); } });
    await worker.summary({ allTime: true });
    await worker.whenIdle();
    assert.equal(logged, null, 'no fallback, no error');
    const wa = (await worker.summary({ allTime: true })).allTime;
    const ia = (await inline.summary({ allTime: true })).allTime;
    for (const k of ['activeMs', 'agentMs', 'since', 'byMonth', 'byProject', 'files']) assert.deepEqual(wa[k], ia[k], k);
    assert.equal(wa.activeMs, 30 * MIN);
  });

  test.it('the cache keeps older files, so a rescan reads nothing; a v1 cache is dropped; a deleted file leaves it', async () => {
    const dir = tmpProjects();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-activity-profile-'));
    test.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const cachePath = path.join(profile, 'activity-cache.json');
    const f = writeMain(dir, 'C--code-booking', 'old', turn(JUL, 0, 20, { cwd: Booking, text: 'SECRET old prompt' }));
    age(f, JUL + 864e5);
    writeMain(dir, 'C--code-storefront', 'a', prompt(DAY1, 0) + asst(DAY1, 10, { stop: 'end_turn' }));
    fs.writeFileSync(cachePath, JSON.stringify({ v: 1, capMs: A.DEFAULTS.capMs, files: { [f]: { size: 1, mtimeMs: 1, off: 0, h: '', cwd: null, st: {} } } }));
    const a = await runScan({ projectsDir: dir, cachePath, now: NOW, tempDir: TEMP });
    assert.equal(a.allTime.filesRead, 2, 'the v1 cache was dropped: everything read once');
    const text = fs.readFileSync(cachePath, 'utf8');
    assert.equal(JSON.parse(text).v, A.RULE_VERSION);
    assert.ok(text.includes('old.jsonl'), 'the older file is cached');
    assert.equal(text.includes('SECRET'), false, 'no prompt text in the cache');
    const b = await runScan({ projectsDir: dir, cachePath, now: NOW, tempDir: TEMP });
    assert.equal(b.allTime.filesRead, 0, 'nothing re-read');
    assert.equal(b.allTime.bytesRead, 0);
    assert.deepEqual(b.allTime.byMonth, a.allTime.byMonth);
    fs.unlinkSync(f);
    const c = await runScan({ projectsDir: dir, cachePath, now: NOW, tempDir: TEMP });
    assert.equal(c.allTime.files, 1);
    assert.equal(fs.readFileSync(cachePath, 'utf8').includes('old.jsonl'), false, 'a deleted file leaves the cache');
  });
});
