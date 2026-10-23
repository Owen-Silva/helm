'use strict';
// Round 3 engine features: sessions.fork (edit & resend), Session.eta, tail-first transcript
// paging (TranscriptPager + sessions.history), streamed-text coalescing, external.* wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { TranscriptPager, readTranscriptPage, findLineByUuid } = require('../../main/engine/pager');
const { loadTranscript, slugFor } = require('../../main/engine/transcript');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(turn, opts = {}) {
  const userDataDir = opts.userDataDir || tmp('helm-r3-');
  const cwd = opts.cwd || tmp('helm-r3cwd-');
  const projectsDir = opts.projectsDir || tmp('helm-r3proj-');
  const etaDir = opts.etaDir || tmp('helm-r3eta-');
  const events = [];
  const sdk = createFakeSdk(turn, { projectsDir });
  const engine = createEngine({ userDataDir, emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir, statuslineDir: tmp('helm-r3sl-'), etaDir, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error('timed out waiting');
  };
  return { engine, m: engine.methods, events, sdk, waitFor, userDataDir, cwd, projectsDir, etaDir };
}

// ---------- transcript fixtures ----------
let tsBase = Date.parse('2026-10-01T10:00:00Z');
const ts = () => new Date((tsBase += 1000)).toISOString();
const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 5 };

function builder(sessionId, cwd) {
  const lines = [];
  let last = null;
  let n = 0;
  const push = (o) => {
    const uuid = o.uuid || `${sessionId.slice(0, 4)}-${++n}`;
    lines.push({ parentUuid: last, isSidechain: false, sessionId, cwd, timestamp: ts(), ...o, uuid });
    last = uuid;
    return uuid;
  };
  return {
    lines,
    user: (text, uuid) => push({ type: 'user', uuid, message: { role: 'user', content: text } }),
    text: (msgId, text) => push({ type: 'assistant', message: { id: msgId, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }], usage } }),
    tool: (msgId, id, name, input) => push({ type: 'assistant', message: { id: msgId, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage } }),
    result: (id, content) => push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }),
  };
}

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function transcriptPath(projectsDir, cwd, id) {
  return path.join(projectsDir, slugFor(cwd), `${id}.jsonl`);
}

// A long session: `turns` prompts, each with a Bash call whose result is padded so small windows
// split turns (and tool_use/tool_result pairs) across window boundaries; every 7th turn runs an
// Agent whose subagent transcript (with its own tool) sits in <id>/subagents/.
function bigTranscript(projectsDir, cwd, id, { turns = 60, pad = 1500 } = {}) {
  const b = builder(id, cwd);
  const file = transcriptPath(projectsDir, cwd, id);
  const subDir = path.join(path.dirname(file), id, 'subagents');
  for (let t = 0; t < turns; t++) {
    b.user(`prompt number ${t}`);
    b.text(`m${t}a`, `Working on ${t}`);
    b.tool(`m${t}a`, `tu_${t}`, 'Bash', { command: `echo ${t}` });
    b.result(`tu_${t}`, `out ${t} ` + 'x'.repeat(pad));
    if (t % 7 === 3) {
      const ag = `ag_${t}`;
      b.tool(`m${t}b`, ag, 'Agent', { description: `lane ${t}`, prompt: 'go', subagent_type: 'opus-high' });
      const sb = builder(id, cwd);
      sb.text(`s${t}a`, `sub thinking ${t}`);
      sb.tool(`s${t}a`, `stu_${t}`, 'Read', { file_path: `f${t}.txt` });
      sb.result(`stu_${t}`, 'file body ' + 'y'.repeat(pad));
      sb.text(`s${t}b`, `sub done ${t}`);
      for (const l of sb.lines) l.isSidechain = true;
      writeJsonl(path.join(subDir, `agent-a${t}f.jsonl`), sb.lines);
      fs.writeFileSync(path.join(subDir, `agent-a${t}f.meta.json`), JSON.stringify({ agentType: 'opus-high', description: `lane ${t}`, toolUseId: ag }));
      b.result(ag, `report ${t}`);
    }
    b.text(`m${t}c`, `Done with ${t}`);
  }
  writeJsonl(file, b.lines);
  return file;
}

const sig = (i) => [i.type, i.toolUseId || '', i.status || '', i.text || '', i.parentToolUseId || '', typeof i.result === 'string' ? i.result.length : ''].join('|');

function walk(pageFn, limit) {
  let pg = pageFn({ limit });
  let all = pg.items.slice();
  let guard = 0;
  while (pg.hasMore && guard++ < 1000) {
    pg = pageFn({ before: all[0].id, limit });
    assert.ok(pg.items.length > 0, 'a page with hasMore=true before it is never empty');
    all = pg.items.concat(all);
  }
  return all;
}

// ---------- pager ----------
test('pager: every page walked with tiny windows equals a whole-file parse (tools across windows, subagents)', () => {
  const projectsDir = tmp('helm-r3p-');
  const cwd = 'C:\\fake\\proj';
  const file = bigTranscript(projectsDir, cwd, 'aaaa1111-0000-0000-0000-000000000001');
  const full = loadTranscript(file).items;
  for (const windowBytes of [2048, 9000, 1 << 20]) {
    const p = new TranscriptPager(file, { windowBytes });
    const all = walk((o) => p.page(o), 37);
    assert.strictEqual(new Set(all.map((i) => i.id)).size, all.length, `no duplicate ids (window ${windowBytes})`);
    assert.deepStrictEqual(all.map(sig), full.map(sig), `same items in the same order (window ${windowBytes})`);
    assert.ok(!all.some((i) => i.type === 'tool' && i.status === 'running'), 'no tool left running by a window boundary');
  }
  // Ids are a function of the file, not of the window size or the cache.
  const a = walk((o) => new TranscriptPager(file, { windowBytes: 3000 }).page(o), 50).map((i) => i.id);
  const b = walk((o) => new TranscriptPager(file, { windowBytes: 50000 }).page(o), 50).map((i) => i.id);
  assert.deepStrictEqual(a, b);
});

test('pager: `before` from an earlier reader works in a fresh one; appends show up and keep ids', () => {
  const projectsDir = tmp('helm-r3p-');
  const cwd = 'C:\\fake\\proj';
  const id = 'aaaa1111-0000-0000-0000-000000000002';
  const file = bigTranscript(projectsDir, cwd, id, { turns: 30 });
  const p1 = new TranscriptPager(file, { windowBytes: 4096 });
  const first = p1.page({ limit: 40 });
  const second = p1.page({ before: first.items[0].id, limit: 40 });
  const fresh = new TranscriptPager(file, { windowBytes: 4096 });
  const again = fresh.page({ before: second.items[0].id, limit: 40 });
  const ref = p1.page({ before: second.items[0].id, limit: 40 });
  assert.deepStrictEqual(again.items.map((i) => i.id), ref.items.map((i) => i.id));
  assert.strictEqual(again.hasMore, ref.hasMore);

  // Append a turn (as a live terminal session would): the module-cached reader picks it up.
  const before = readTranscriptPage(file, { limit: 20 });
  const b = builder(id, cwd);
  b.user('one more prompt');
  b.tool('mz', 'tu_z', 'Bash', { command: 'ls' });
  fs.appendFileSync(file, b.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  let after = readTranscriptPage(file, { limit: 20 });
  const tail = after.items.slice(-2);
  assert.strictEqual(tail[0].text, 'one more prompt');
  assert.strictEqual(tail[1].status, 'running');
  const kept = new Set(after.items.map((i) => i.id));
  for (const it of before.items.slice(2)) assert.ok(kept.has(it.id), 'older ids unchanged after an append');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'r-z', parentUuid: null, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_z', content: 'listing' }] } }) + '\n');
  after = readTranscriptPage(file, { limit: 20 });
  assert.strictEqual(after.items[after.items.length - 1].status, 'done');
  // A half-written last line is ignored until it is complete.
  fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"par');
  const partial = readTranscriptPage(file, { limit: 20 });
  assert.strictEqual(partial.items[partial.items.length - 1].status, 'done');
  assert.ok(findLineByUuid(file, 'r-z'));
  assert.strictEqual(findLineByUuid(file, 'nope'), null);
});

test('pager: a long subagent transcript shows its newest part and says so', () => {
  const projectsDir = tmp('helm-r3p-');
  const cwd = 'C:\\fake\\proj';
  const file = bigTranscript(projectsDir, cwd, 'aaaa1111-0000-0000-0000-000000000003', { turns: 5, pad: 3000 });
  const p = new TranscriptPager(file, { subTailBytes: 3500 });
  const items = walk((o) => p.page(o), 500);
  const note = items.find((i) => i.type === 'system' && i.parentToolUseId === 'ag_3');
  assert.ok(note && /not shown/.test(note.text), 'cut note under the Agent card');
  assert.ok(items.some((i) => i.parentToolUseId === 'ag_3' && i.text === 'sub done 3'), 'newest subagent step kept');
});

// ---------- sessions.history over the pager ----------
test('sessions.history: newest page first, `before` pages to the start, same ids after a restart', async () => {
  const h = harness(async function* () {});
  const id = 'bbbb2222-0000-0000-0000-000000000001';
  const file = bigTranscript(h.projectsDir, h.cwd, id, { turns: 200, pad: 6000 });
  const s = await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: id });
  const page = (o) => h.m['sessions.history']({ id: s.id, ...o });
  const first = await page({ limit: 50 });
  assert.strictEqual(first.items.length, 50);
  assert.strictEqual(first.hasMore, true);
  const es = h.engine._internal.sessions.get(s.id);
  assert.ok(es.pager && es.pager.hasOlder(), 'opened from the tail, not the whole file');
  let all = first.items.slice();
  let pg = first;
  const pages = [first];
  while (pg.hasMore) {
    pg = await page({ before: all[0].id, limit: 50 });
    pages.push(pg);
    all = pg.items.concat(all);
  }
  assert.strictEqual(new Set(all.map((i) => i.id)).size, all.length, 'no duplicates');
  assert.deepStrictEqual(all.map(sig), loadTranscript(file).items.map(sig), 'no gaps');
  assert.strictEqual(pages[pages.length - 1].hasMore, false);

  // Restart: a new engine on the same userData resolves an old `before` id without the earlier pages.
  await h.engine.shutdown();
  const events = [];
  const engine2 = createEngine({ userDataDir: h.userDataDir, emit: (e, d) => events.push({ e, d }), log: () => {}, sdk: createFakeSdk(async function* () {}), claudePath: null, projectsDir: h.projectsDir, statuslineDir: tmp('helm-r3sl-'), etaDir: h.etaDir, external: false });
  const deep = pages[3];
  const again = await engine2.methods['sessions.history']({ id: s.id, before: deep.items[0].id, limit: 50 });
  assert.deepStrictEqual(again.items.map((i) => i.id), pages[4].items.map((i) => i.id));
  await engine2.shutdown();
});

// ---------- fork / edit & resend ----------
function forkFixture(h) {
  const id = 'cccc3333-0000-0000-0000-000000000001';
  const b = builder(id, h.cwd);
  b.user('first prompt', 'u-1');
  b.text('m1', 'reply one');
  b.user('second prompt', 'u-2');
  b.tool('m2', 'tu_1', 'Bash', { command: 'ls' });
  b.result('tu_1', 'a.txt');
  b.text('m2', 'reply two');
  writeJsonl(transcriptPath(h.projectsDir, h.cwd, id), b.lines);
  return id;
}

test('sessions.fork: edit & resend forks before the prompt, keeps history, sends the new text; source untouched', async () => {
  const h = harness(async function* (um) {
    for (const f of F.textTurn('mx', `echo: ${um.message.content}`)) yield f;
    yield F.result(0.01);
  });
  const cid = forkFixture(h);
  const src = await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: cid });
  await h.m['sessions.update']({ id: src.id, title: 'Fix login' });
  const srcItems = (await h.m['sessions.history']({ id: src.id })).items;
  const second = srcItems.find((i) => i.type === 'user' && i.text === 'second prompt');
  const fork = await h.m['sessions.fork']({ id: src.id, itemId: second.id, text: 'second prompt, edited' });
  assert.notStrictEqual(fork.id, src.id);
  assert.strictEqual(fork.title, 'Fix login (fork)');
  assert.strictEqual(fork.cwd, h.cwd);
  assert.strictEqual(h.sdk.forks.length, 1);
  assert.strictEqual(h.sdk.forks[0].sessionId, cid);
  assert.strictEqual(h.sdk.forks[0].options.upToMessageId, 'cccc-1', 'forked at the reply before the edited prompt');
  assert.ok(h.events.some((e) => e.event === 'session.created' && e.data.id === fork.id));
  await h.waitFor(() => h.engine._internal.sessions.get(fork.id).publicSession().status === 'idle' && h.sdk.calls.length === 1);
  const q = h.sdk.calls[0].options;
  assert.strictEqual(q.resume, h.sdk.forks[0].newId, 'the fork CLI resumes the forked transcript');
  const items = (await h.m['sessions.history']({ id: fork.id })).items;
  const texts = items.filter((i) => i.type === 'user' || i.type === 'assistant').map((i) => i.text);
  assert.deepStrictEqual(texts, ['first prompt', 'reply one', 'second prompt, edited', 'echo: second prompt, edited']);
  // Source: same items, no CLI started for it.
  const srcAfter = (await h.m['sessions.history']({ id: src.id })).items;
  assert.deepStrictEqual(srcAfter.map((i) => i.id), srcItems.map((i) => i.id));
  assert.strictEqual(h.engine._internal.sessions.get(src.id).live(), false);
  // The fork survives a restart with its inherited history (the transcript is on disk).
  await h.engine.shutdown();
  const engine2 = createEngine({ userDataDir: h.userDataDir, emit: () => {}, log: () => {}, sdk: createFakeSdk(async function* () {}), claudePath: null, projectsDir: h.projectsDir, statuslineDir: tmp('helm-r3sl-'), etaDir: h.etaDir, external: false });
  // (The fake CLI writes no transcript, so only the inherited part is on disk here.)
  const again = (await engine2.methods['sessions.history']({ id: fork.id })).items.filter((i) => i.type === 'user' || i.type === 'assistant').map((i) => i.text);
  assert.deepStrictEqual(again, ['first prompt', 'reply one']);
  assert.strictEqual(engine2.snapshot().sessions.find((x) => x.id === fork.id).title, 'Fix login (fork)');
  await engine2.shutdown();
});

test('sessions.fork: whole conversation without itemId; first prompt = fresh session; bad item rejected', async () => {
  const h = harness(async function* (um) {
    for (const f of F.textTurn('my', `ok ${um.message.content}`)) yield f;
    yield F.result(0.01);
  });
  const cid = forkFixture(h);
  const src = await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: cid });
  const whole = await h.m['sessions.fork']({ id: src.id });
  assert.strictEqual(h.sdk.forks.length, 1);
  assert.strictEqual(h.sdk.forks[0].options.upToMessageId, undefined);
  const wItems = (await h.m['sessions.history']({ id: whole.id })).items;
  assert.deepStrictEqual(wItems.filter((i) => i.type === 'user').map((i) => i.text), ['first prompt', 'second prompt']);
  assert.ok(wItems.some((i) => i.type === 'tool' && i.toolUseId === 'tu_1' && i.status === 'done'));
  assert.strictEqual(h.sdk.calls.length, 0, 'no prompt → no CLI started');
  assert.match(whole.title, /\(fork\)$/);

  const srcItems = (await h.m['sessions.history']({ id: src.id })).items;
  const firstPrompt = srcItems.find((i) => i.type === 'user');
  const fresh = await h.m['sessions.fork']({ id: src.id, itemId: firstPrompt.id, text: 'start over' });
  assert.strictEqual(h.sdk.forks.length, 1, 'nothing before the first prompt: no transcript copy');
  await h.waitFor(() => h.sdk.calls.length === 1 && h.engine._internal.sessions.get(fresh.id).publicSession().status === 'idle');
  assert.strictEqual(h.sdk.calls[0].options.resume, undefined);
  const fItems = (await h.m['sessions.history']({ id: fresh.id })).items;
  assert.deepStrictEqual(fItems.filter((i) => i.type === 'user').map((i) => i.text), ['start over']);

  const reply = srcItems.find((i) => i.type === 'assistant');
  await assert.rejects(h.m['sessions.fork']({ id: src.id, itemId: reply.id }), (e) => e.code === 'bad_request');
  await assert.rejects(h.m['sessions.fork']({ id: 'nope' }), (e) => e.code === 'not_found');
  await h.engine.shutdown();
});

// ---------- eta ----------
test('Session.eta: snapshot on load, live updates while the CLI runs, garbage ignored, null when absent', async () => {
  const h = harness(async function* () {
    for (const f of F.textTurn('me', 'fine')) yield f;
    yield F.result(0.01);
  });
  const cid = 'dddd4444-0000-0000-0000-000000000001';
  const now = Date.now();
  fs.writeFileSync(path.join(h.etaDir, `${cid}.json`), JSON.stringify({ v: 1, sessionId: cid, project: 'p', cwd: h.cwd, label: 'Earlier', state: 'ended', summary: 'done before', etaAt: null, isOverdue: false, agentsRunning: 0, workStartedAt: null, updatedAt: now - 60000 }));
  const s = await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: cid });
  assert.strictEqual(s.eta.state, 'ended');
  assert.strictEqual(s.eta.label, 'Earlier');
  const plain = await h.m['sessions.create']({ cwd: h.cwd });
  assert.strictEqual(plain.eta, null, 'no snapshot → null');

  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => h.engine._internal.sessions.get(s.id).etaWatch);
  const mark = h.events.length;
  fs.writeFileSync(path.join(h.etaDir, `${cid}.json`), '{"v":1,"state":"work'); // mid-write
  await sleep(300);
  fs.writeFileSync(path.join(h.etaDir, `${cid}.json`), JSON.stringify({ v: 1, sessionId: cid, project: 'p', cwd: h.cwd, label: 'Building fork', state: 'working', summary: '', etaAt: now + 600000, isOverdue: false, agentsRunning: 2, workStartedAt: now, updatedAt: now }));
  const upd = await h.waitFor(() => h.events.slice(mark).find((e) => e.event === 'session.updated' && e.data.id === s.id && e.data.eta && e.data.eta.state === 'working'), 8000);
  assert.strictEqual(upd.data.eta.agentsRunning, 2);
  assert.strictEqual(upd.data.eta.etaAt, now + 600000);
  assert.ok(!h.events.slice(mark).some((e) => e.event === 'session.updated' && e.data.id === s.id && e.data.eta === null), 'a half-written file never blanks the eta');
  await h.m['sessions.close']({ id: s.id });
  assert.strictEqual(h.engine._internal.sessions.get(s.id).etaWatch, null, 'watcher stopped with the CLI');
  await h.engine.shutdown();
});

// ---------- streaming coalescing ----------
test('streamed text: deltas coalesce into few itemUpdate events per item, in order, flushed before the item closes', async () => {
  const words = Array.from({ length: 60 }, (_, i) => `w${i} `);
  const full = words.join('');
  const h = harness(async function* () {
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'mc', model: 'claude-haiku-5-5' } } };
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
    for (const w of words) yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } };
    yield { type: 'assistant', parent_tool_use_id: null, uuid: 'u-mc', message: { id: 'mc', model: 'claude-haiku-5-5', content: [{ type: 'text', text: full }], usage } };
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } };
    yield F.result(0.01);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'stream please' });
  await h.waitFor(() => h.engine._internal.sessions.get(s.id).publicSession().status === 'idle' && h.events.some((e) => e.event === 'session.item' && e.data.item.type === 'result'));
  const item = h.events.find((e) => e.event === 'session.item' && e.data.item.type === 'assistant').data.item;
  const ups = h.events.filter((e) => e.event === 'session.itemUpdate' && e.data.itemId === item.id);
  const appends = ups.filter((e) => e.data.appendText);
  assert.ok(appends.length <= 3, `60 deltas → ${appends.length} appendText events`);
  const closeIdx = ups.findIndex((e) => e.data.patch && e.data.patch.streaming === false);
  assert.ok(closeIdx >= 0, 'item closed');
  assert.ok(ups.slice(closeIdx + 1).every((e) => !e.data.appendText), 'no text after the close patch');
  const streamed = appends.map((e) => e.data.appendText).join(''); // the item opened with ''
  const final = ups[closeIdx].data.patch.text;
  assert.strictEqual(final !== undefined ? final : streamed, full);
  assert.strictEqual(streamed, full, 'appended text in order adds up to the message');
  await h.engine.shutdown();
});

// ---------- external.* wiring ----------
test('external.list / external.history exclude Helm-owned sessions', async () => {
  const h = harness(async function* () {});
  const mine = forkFixture(h);
  const theirs = 'eeee5555-0000-0000-0000-000000000001';
  const b = builder(theirs, h.cwd);
  b.user('terminal prompt');
  b.text('t1', 'terminal reply');
  writeJsonl(transcriptPath(h.projectsDir, h.cwd, theirs), b.lines);
  await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: mine });
  const list = await h.m['external.list']({});
  const ids = list.map((x) => x.claudeSessionId);
  assert.ok(ids.includes(theirs), 'terminal session listed');
  assert.ok(!ids.includes(mine), 'Helm session left out');
  const ext = list.find((x) => x.claudeSessionId === theirs);
  assert.strictEqual(ext.active, true);
  const hist = await h.m['external.history']({ claudeSessionId: theirs });
  assert.deepStrictEqual(hist.items.map((i) => i.text), ['terminal prompt', 'terminal reply']);
  await assert.rejects(h.m['external.history']({ claudeSessionId: mine }), (e) => e.code === 'not_found');
  await h.engine.shutdown();
});
