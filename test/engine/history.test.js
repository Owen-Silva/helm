'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoryIndex } = require('../../main/engine/history');

const T0 = Date.parse('2026-08-10T10:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const CWD = 'C:\\Users\\tester\\Downloads\\Storefront';

const user = (text, min, extra = {}) => ({
  parentUuid: null, isSidechain: false, type: 'user',
  message: { role: 'user', content: text }, uuid: `u-${min}-${Math.random()}`, timestamp: iso(min), cwd: CWD, sessionId: 'x', ...extra,
});
const asst = (id, min, text = 'ok') => ({
  type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] }, uuid: `a-${min}-${Math.random()}`, timestamp: iso(min), cwd: CWD,
});
const toolResult = (min) => ({
  type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Should not be a prompt' }] }, timestamp: iso(min), cwd: CWD,
});
const jsonl = (lines) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-hist-'));
  const projects = path.join(root, 'projects');
  const slugA = path.join(projects, 'C--Users-tester-Downloads-Storefront');
  const slugB = path.join(projects, 'C--Users-tester-helm');
  fs.mkdirSync(slugA, { recursive: true });
  fs.mkdirSync(slugB, { recursive: true });
  const w = (dir, id, lines) => { const p = path.join(dir, `${id}.jsonl`); fs.writeFileSync(p, typeof lines === 'string' ? lines : jsonl(lines)); return p; };

  // 1. normal: custom-title + ai-title (custom wins, last custom wins). messageCount = 2 prompts + 2 assistant ids.
  w(slugA, 'aaaa1111-normal', [
    { type: 'permission-mode', permissionMode: 'default', sessionId: 'x' },
    user('Build the launch readiness checklist', 1),
    asst('msg_1', 2, 'part one'), asst('msg_1', 2.1, 'part two'),
    toolResult(3),
    { type: 'ai-title', aiTitle: 'Readiness work', sessionId: 'x' },
    { type: 'custom-title', customTitle: 'Old name', sessionId: 'x' },
    user('and the second step', 4),
    asst('msg_2', 5),
    'this is {not json',
    { type: 'custom-title', customTitle: 'Launch readiness checklist', sessionId: 'x' },
  ]);
  // 2. only ai-title
  w(slugA, 'bbbb2222-aionly', [
    user('Replace my personal operating system', 10),
    asst('msg_b', 11),
    { type: 'ai-title', aiTitle: 'Personal OS replacement', sessionId: 'x' },
    { type: 'ai-title', aiTitle: 'Personal operating system replacement', sessionId: 'x' },
  ]);
  // 3. only a prompt (title derived, truncated to 80)
  const longPrompt = 'Please   refactor\n\nthe   queue module ' + 'so it handles retries '.repeat(30);
  w(slugB, 'cccc3333-promptonly', [user(longPrompt, 20), asst('msg_c', 21)]);
  // 4. meta + system reminder first, then the real prompt (as text blocks)
  w(slugB, 'dddd4444-meta', [
    user('<local-command-caveat>Caveat: ignore</local-command-caveat>', 30, { isMeta: true }),
    user('<system-reminder>be nice</system-reminder>', 30.5),
    user([{ type: 'text', text: '<task-notification>done</task-notification>' }], 30.7),
    user('Summary of earlier', 30.8, { isCompactSummary: true }),
    toolResult(30.9),
    user([{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'Fix the flaky websocket test' }], 31),
    asst('msg_d', 32),
  ]);
  // 5. <command-name> session
  w(slugB, 'eeee5555-command', [
    user('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>main.js high</command-args>', 40),
    asst('msg_e', 41),
  ]);
  // 6. metadata-only (excluded)
  w(slugB, 'ffff6666-metaonly', [
    { type: 'permission-mode', permissionMode: 'default', sessionId: 'x' },
    { type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
    user('<local-command-stdout></local-command-stdout>', 50),
  ]);
  // 7. big file (> 1 MB): prompt in head, a custom-title ONLY in the middle, ai-title + latest timestamp in the tail.
  //    If it were fully read, the middle custom-title would win; head/tail-only reading yields the tail ai-title.
  const big = [user('Analyse the big log', 60)];
  const filler = 'lorem ipsum '.repeat(90);
  for (let i = 0; i < 1400; i++) big.push(asst(`msg_big_${i}`, 61 + i * 0.01, filler));
  big.push({ type: 'custom-title', customTitle: 'Middle Title Should Not Be Seen', sessionId: 'x' });
  for (let i = 0; i < 1400; i++) big.push(asst(`msg_big2_${i}`, 80 + i * 0.01, filler));
  big.push({ type: 'ai-title', aiTitle: 'Tail Title', sessionId: 'x' });
  big.push(asst('msg_last', 200));
  const bigPath = w(slugA, 'gggg7777-big', big);
  // 8. subagent transcript (excluded: two levels down)
  const sub = path.join(slugA, 'aaaa1111-normal', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  w(sub, 'agent-zzz', [user('Subagent prompt should never appear', 70), { type: 'custom-title', customTitle: 'Subagent', sessionId: 'x' }]);
  // 9. last-prompt fallback: no real prompt, has last-prompt line
  w(slugB, 'hhhh8888-lastprompt', [
    user('<system-reminder>only reminders</system-reminder>', 90),
    { type: 'last-prompt', lastPrompt: 'Continue the migration', leafUuid: 'l', sessionId: 'x' },
  ]);
  // 10. no cwd anywhere -> project = slug dir name, lastActivity = mtime
  w(slugB, 'iiii9999-nocwd', [{ type: 'user', message: { role: 'user', content: 'No cwd here' } }]);

  return { root, projects, slugA, slugB, bigPath, cache: path.join(root, 'userdata', 'history-index.json'), w };
}

test('history index over synthetic transcripts', async (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const idx = createHistoryIndex({ projectsDir: fx.projects, cacheFile: fx.cache, minRefreshMs: 0 });

  const r1 = await idx.refresh();
  assert.strictEqual(r1.scanned, 9, 'top-level .jsonl files only');
  assert.strictEqual(r1.reparsed, 9);

  const all = await idx.search({ q: '' });
  const byId = Object.fromEntries(all.map((e) => [e.claudeSessionId, e]));

  await t.test('exclusions', () => {
    assert.strictEqual(all.length, 8);
    assert.ok(!byId['ffff6666-metaonly'], 'metadata-only excluded');
    assert.ok(!all.some((e) => e.claudeSessionId.startsWith('agent-')), 'subagent excluded');
    assert.ok(!all.some((e) => /Subagent/.test(e.title + e.firstPrompt)));
  });

  await t.test('normal session fields', () => {
    const e = byId['aaaa1111-normal'];
    assert.deepStrictEqual(Object.keys(e).sort(), ['claudeSessionId', 'cwd', 'firstPrompt', 'lastActivity', 'messageCount', 'project', 'sizeBytes', 'title', 'transcriptPath'].sort());
    assert.strictEqual(e.title, 'Launch readiness checklist');
    assert.strictEqual(e.firstPrompt, 'Build the launch readiness checklist');
    assert.strictEqual(e.cwd, CWD);
    assert.strictEqual(e.project, 'Storefront');
    assert.strictEqual(e.lastActivity, Date.parse(iso(5)));
    assert.strictEqual(e.messageCount, 4);
    assert.strictEqual(e.sizeBytes, fs.statSync(e.transcriptPath).size);
    assert.strictEqual(e.transcriptPath, path.join(fx.slugA, 'aaaa1111-normal.jsonl'));
  });

  await t.test('title sources', () => {
    assert.strictEqual(byId['bbbb2222-aionly'].title, 'Personal operating system replacement');
    const p = byId['cccc3333-promptonly'];
    assert.ok(p.firstPrompt.startsWith('Please refactor the queue module so it handles retries'));
    assert.ok(!/\s{2,}|\n/.test(p.firstPrompt), 'whitespace collapsed');
    assert.strictEqual(p.firstPrompt.length, 300);
    assert.strictEqual(p.title, p.firstPrompt.slice(0, 80));
    assert.strictEqual(byId['dddd4444-meta'].firstPrompt, 'Fix the flaky websocket test');
    assert.strictEqual(byId['dddd4444-meta'].messageCount, 2);
    assert.strictEqual(byId['eeee5555-command'].firstPrompt, '/review main.js high');
    assert.strictEqual(byId['eeee5555-command'].title, '/review main.js high');
    assert.strictEqual(byId['hhhh8888-lastprompt'].firstPrompt, 'Continue the migration');
    const nc = byId['iiii9999-nocwd'];
    assert.strictEqual(nc.cwd, null);
    assert.strictEqual(nc.project, 'C--Users-tester-helm');
    assert.strictEqual(nc.lastActivity, Math.round(fs.statSync(nc.transcriptPath).mtimeMs));
  });

  await t.test('big file is read head + tail only', () => {
    const e = byId['gggg7777-big'];
    assert.ok(fs.statSync(fx.bigPath).size > 1024 * 1024, 'fixture is > 1 MB');
    assert.strictEqual(e.title, 'Tail Title', 'middle custom-title was never read');
    assert.strictEqual(e.messageCount, null);
    assert.strictEqual(e.firstPrompt, 'Analyse the big log');
    assert.strictEqual(e.lastActivity, Date.parse(iso(200)));
    assert.strictEqual(e.cwd, CWD);
  });

  await t.test('sort order newest first', () => {
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].lastActivity >= all[i].lastActivity);
    assert.strictEqual(all[0].claudeSessionId, 'iiii9999-nocwd', 'mtime fallback = now, newest');
    assert.strictEqual(all[1].claudeSessionId, 'gggg7777-big');
  });

  await t.test('query matching and limit', async () => {
    const ids = async (q, limit) => (await idx.search({ q, limit })).map((e) => e.claudeSessionId);
    assert.deepStrictEqual(await ids('LAUNCH checklist'), ['aaaa1111-normal']);
    assert.deepStrictEqual(await ids('websocket flaky'), ['dddd4444-meta']);
    assert.deepStrictEqual(await ids('launch websocket'), [], 'all terms must match');
    assert.deepStrictEqual(await ids('/review'), ['eeee5555-command']);
    assert.deepStrictEqual(await ids('bbbb22'), ['bbbb2222-aionly'], 'session id prefix');
    assert.deepStrictEqual(await ids('2222'), [], 'session id is prefix match only');
    const storefront = await ids('storefront');
    assert.ok(storefront.length >= 4 && storefront.includes('gggg7777-big'), 'matches cwd/project');
    assert.deepStrictEqual(await ids('downloads\\storefront'), storefront, 'cwd path matches');
    assert.strictEqual((await idx.search({ q: '', limit: 3 })).length, 3);
    assert.strictEqual((await idx.search({ q: 'storefront', limit: 2 })).length, 2);
    assert.strictEqual((await idx.search({})).length, 8);
  });

  await t.test('incremental refresh and cache', async () => {
    const r2 = await idx.refresh();
    assert.strictEqual(r2.reparsed, 0);
    assert.strictEqual(r2.scanned, 9);

    fs.appendFileSync(path.join(fx.slugB, 'dddd4444-meta.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'Websocket fix', sessionId: 'x' }) + '\n');
    const r3 = await idx.refresh();
    assert.strictEqual(r3.reparsed, 1);
    assert.strictEqual(idx.entries().find((e) => e.claudeSessionId === 'dddd4444-meta').title, 'Websocket fix');

    fs.unlinkSync(path.join(fx.slugB, 'eeee5555-command.jsonl'));
    const r4 = await idx.refresh();
    assert.strictEqual(r4.reparsed, 0);
    assert.strictEqual(r4.scanned, 8);
    assert.ok(!idx.entries().some((e) => e.claudeSessionId === 'eeee5555-command'), 'deleted file dropped');
    assert.strictEqual(idx.entries().length, 7);

    // cache file round trip
    assert.ok(fs.existsSync(fx.cache));
    const disk = JSON.parse(fs.readFileSync(fx.cache, 'utf8'));
    assert.strictEqual(disk.version, 1);
    assert.strictEqual(Object.keys(disk.files).length, 8, 'includes the excluded metadata-only file as null');
    assert.ok(!fs.readdirSync(path.dirname(fx.cache)).some((f) => f.endsWith('.tmp')), 'no tmp left');

    const idx2 = createHistoryIndex({ projectsDir: fx.projects, cacheFile: fx.cache, minRefreshMs: 0 });
    assert.strictEqual(idx2.entries().length, 7, 'entries() serves the loaded cache without scanning');
    const r5 = await idx2.refresh();
    assert.strictEqual(r5.reparsed, 0);
    assert.deepStrictEqual(idx2.entries(), idx.entries());

    // unchanged refresh does not rewrite the cache
    const m1 = fs.statSync(fx.cache).mtimeMs;
    await idx2.refresh();
    assert.strictEqual(fs.statSync(fx.cache).mtimeMs, m1);
  });
});

test('search throttles refresh to once per window', async (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const idx = createHistoryIndex({ projectsDir: fx.projects, cacheFile: fx.cache });
  assert.strictEqual((await idx.search({ q: '' })).length, 8);
  fx.w(fx.slugB, 'jjjj0000-new', [user('Brand new session', 300)]);
  assert.strictEqual((await idx.search({ q: '' })).length, 8, 'served from memory inside 5 s');
  await idx.refresh();
  assert.strictEqual((await idx.search({ q: 'brand new' }))[0].claudeSessionId, 'jjjj0000-new');
});

test('missing projects dir yields empty index', async () => {
  const idx = createHistoryIndex({ projectsDir: path.join(os.tmpdir(), 'helm-hist-missing-' + process.pid), cacheFile: null });
  assert.deepStrictEqual(await idx.search({ q: '' }), []);
  assert.deepStrictEqual(await idx.refresh().then((r) => r.scanned), 0);
});

const REAL = path.join(os.homedir(), '.claude', 'projects');
test('real ~/.claude/projects: cold refresh, warm search < 300 ms', { skip: !fs.existsSync(REAL) && 'no ~/.claude/projects' }, async (t) => {
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-hist-real-')), 'history-index.json');
  t.after(() => fs.rmSync(path.dirname(cache), { recursive: true, force: true }));
  const idx = createHistoryIndex({ cacheFile: cache });
  const cold = await idx.refresh();
  t.diagnostic(`cold refresh: scanned=${cold.scanned} reparsed=${cold.reparsed} ms=${cold.ms} entries=${idx.entries().length}`);
  assert.ok(idx.entries().length > 0);

  let s = performance.now();
  const recent = await idx.search({ q: '', limit: 50 });
  const msRecent = performance.now() - s;
  s = performance.now();
  const storefront = await idx.search({ q: 'storefront' });
  const msStorefront = performance.now() - s;
  t.diagnostic(`warm search '' ${msRecent.toFixed(1)} ms (${recent.length}), 'storefront' ${msStorefront.toFixed(1)} ms (${storefront.length})`);
  assert.ok(recent.length > 0);
  assert.ok(msRecent < 300, `warm search took ${msRecent} ms`);
  assert.ok(msStorefront < 300, `warm storefront search took ${msStorefront} ms`);

  // warm restart from the cache file: an incremental refresh that only reparses changed files
  const idx2 = createHistoryIndex({ cacheFile: cache });
  const w = await idx2.refresh();
  t.diagnostic(`restart refresh from cache: scanned=${w.scanned} reparsed=${w.reparsed} ms=${w.ms}`);
  assert.ok(w.reparsed <= 5, 'only live sessions reparsed');
});
