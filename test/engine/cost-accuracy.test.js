'use strict';
// lane accuracy (2026-10-14): a session's cost is Claude Code's own cumulative figure, never Helm's sum.
// Before the fix every resume re-added the conversation's lifetime cost (the user's sessions.json: $873.39 for a
// conversation Claude Code put at $73.51, $6,646.92 vs $320.44). Transcript lines below copy the real shapes
// (cost-state is what the CLI writes when a process ends); all text is placeholder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { createEngine } = require('../../main/engine');
const { slugFor, lastCostState } = require('../../main/engine/transcript');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeTranscript(projectsDir, cwd, cid, costs) {
  const dir = path.join(projectsDir, slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const ts = '2026-10-14T20:00:00.000Z';
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: cid, cwd, timestamp: ts, message: { role: 'user', content: 'placeholder prompt' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: cid, cwd, timestamp: ts, message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'placeholder reply' }], usage: { input_tokens: 6, cache_creation_input_tokens: 2000, cache_read_input_tokens: 40000, output_tokens: 300 } } },
  ];
  for (const c of costs) {
    lines.push({ type: 'cost-state', sessionId: cid, totalCostUSD: c, totalAPIDuration: 1000, totalDuration: 2000, startTime: 1791854201918, modelUsage: { 'claude-opus-5-5': { inputTokens: 6, outputTokens: 300, cacheReadInputTokens: 40000, cacheCreationInputTokens: 2000, costUSD: c } } });
  }
  const file = path.join(dir, `${cid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function harness(turn, { userDataDir = tmp('helm-cost-'), projectsDir = tmp('helm-cproj-'), statuslineDir = tmp('helm-csl-'), cwd = tmp('helm-ccwd-') } = {}) {
  const sdk = createFakeSdk(turn);
  const engine = createEngine({ userDataDir, emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir, statuslineDir });
  const m = engine.methods;
  const session = (id) => engine._internal.sessions.get(id).publicSession();
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const hit = pred(); if (hit) return hit; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error('timed out waiting');
  };
  return { engine, m, session, waitFor, sdk, userDataDir, projectsDir, statuslineDir, cwd };
}

test('lastCostState: newest cost-state from the tail, across chunk boundaries; null when none', () => {
  const dir = tmp('helm-lcs-');
  const cid = randomUUID();
  const file = writeTranscript(dir, dir, cid, [20.02, 92.83]);
  assert.deepStrictEqual(lastCostState(file), { totalCostUSD: 92.83, sessionId: cid });
  // Push the cost-state 600 KB back from the end (3 chunks) with ordinary lines after it.
  const pad = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } });
  fs.appendFileSync(file, (pad + '\n').repeat(600));
  assert.strictEqual(lastCostState(file).totalCostUSD, 92.83);
  assert.strictEqual(lastCostState(file, { maxBytes: 100 * 1024 }), null, 'bounded scan');
  const none = writeTranscript(dir, path.join(dir, 'other'), randomUUID(), []);
  assert.strictEqual(lastCostState(none), null);
  assert.strictEqual(lastCostState(path.join(dir, 'missing.jsonl')), null);
});

test('resume: session cost = Claude Code total; turn cost = rise from the restored figure', async () => {
  const totals = [93.33, 93.5];
  let i = 0;
  const h = harness(async function* () {
    for (const f of F.textTurn('m' + i, 'ok')) yield f;
    yield F.result(totals[i++]);
  });
  const cid = randomUUID();
  writeTranscript(h.projectsDir, h.cwd, cid, [20.02, 92.83]);
  const s = await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: cid });
  assert.strictEqual(h.session(s.id).costUsd, 92.83, 'from the transcript before any turn');
  await h.m['sessions.send']({ id: s.id, text: 'one' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.session(s.id).costUsd === 93.33);
  let u = await h.m['usage.get']({});
  assert.strictEqual(u.costTodayUsd, 0.5, 'only this turn, not the $92.83 lifetime');
  await h.m['sessions.send']({ id: s.id, text: 'two' });
  await h.waitFor(() => h.session(s.id).costUsd === 93.5);
  u = await h.m['usage.get']({});
  assert.strictEqual(u.costTodayUsd, 0.67);
  const hist = await h.m['usage.history']({ days: 1 });
  assert.strictEqual(hist.costByDay.at(-1).usd, 0.67);
  await h.engine.shutdown();
});

test('a CLI restarted on the same conversation never re-adds the lifetime cost', async () => {
  // The user's case: Helm held $25 (last result) but the killed CLI's last cost-state said $20, so the next CLI
  // restored $20. Old code: base = $25, cost = $45.50, today +$20.50. Now: cost = Claude Code's $20.50.
  const h = harness(async function* () {
    for (const f of F.textTurn('m', 'ok')) yield f;
    yield F.result(20.5);
  });
  const cid = randomUUID();
  writeTranscript(h.projectsDir, h.cwd, cid, [20]);
  const s = await h.m['sessions.create']({ cwd: h.cwd, resumeClaudeSessionId: cid });
  h.engine._internal.sessions.get(s.id).s.costUsd = 25;
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => h.session(s.id).status === 'idle' && h.session(s.id).costUsd === 20.5);
  const u = await h.m['usage.get']({});
  assert.strictEqual(u.costTodayUsd, 0.5);
  await h.engine.shutdown();
});

test('cost today survives a Helm restart (persisted ledger)', async () => {
  const userDataDir = tmp('helm-cost-');
  const h = harness(async function* () { for (const f of F.textTurn('m', 'ok')) yield f; yield F.result(0.75); }, { userDataDir });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'go' });
  await h.waitFor(() => h.session(s.id).costUsd === 0.75);
  await h.engine.shutdown();
  const h2 = harness(async function* () {}, { userDataDir });
  const u = await h2.m['usage.get']({});
  assert.strictEqual(u.costTodayUsd, 0.75, 'not reset to $0 by the restart');
  assert.strictEqual(h2.session(s.id).costUsd, 0.75);
  await h2.engine.shutdown();
});

test('an inflated pre-fix cost in sessions.json is replaced by Claude Code\'s figure on load', async () => {
  const userDataDir = tmp('helm-cost-');
  const projectsDir = tmp('helm-cproj-');
  const statuslineDir = tmp('helm-csl-');
  const cwd = tmp('helm-ccwd-');
  const [a, b, c, e, g] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  writeTranscript(projectsDir, cwd, b, [12.84]);
  // The status line record (newest Claude Code figure) for a; only a transcript cost-state for b; nothing for c.
  fs.writeFileSync(path.join(statuslineDir, `${a}.json`), JSON.stringify({ receivedAt: '2026-10-15T00:48:24.108Z', session_id: a, cost: { total_cost_usd: 73.51 } }));
  // e: a terminal conversation carried on in Helm: the status line stopped at $320.44, the later CLIs' cost-state
  // reached $525.78 (the user's s_5b913c79). g: the reverse (the transcript's cost-state is older than the status line).
  fs.writeFileSync(path.join(statuslineDir, `${e}.json`), JSON.stringify({ session_id: e, cost: { total_cost_usd: 320.44 } }));
  writeTranscript(projectsDir, cwd, e, [300.1, 525.78]);
  fs.writeFileSync(path.join(statuslineDir, `${g}.json`), JSON.stringify({ session_id: g, cost: { total_cost_usd: 80.14 } }));
  writeTranscript(projectsDir, cwd, g, [61.2]);
  const base = { cwd, project: 'p', status: 'idle', model: 'opus', createdAt: 1, updatedAt: 2, title: 't' };
  fs.writeFileSync(path.join(userDataDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [
    { ...base, id: 's_a', claudeSessionId: a, costUsd: 873.394475 },
    { ...base, id: 's_b', claudeSessionId: b, costUsd: 46.729398 },
    { ...base, id: 's_c', claudeSessionId: c, costUsd: 9.5 },
    { ...base, id: 's_d', claudeSessionId: randomUUID(), costUsd: 1.25, costBasis: 'cc' },
    { ...base, id: 's_e', claudeSessionId: e, costUsd: 6646.922445 },
    { ...base, id: 's_g', claudeSessionId: g, costUsd: 959.008524 },
  ] }));
  const h = harness(async function* () {}, { userDataDir, projectsDir, statuslineDir, cwd });
  assert.strictEqual(h.session('s_a').costUsd, 73.51);
  assert.strictEqual(h.session('s_b').costUsd, 12.84);
  assert.strictEqual(h.session('s_c').costUsd, null, 'unknown, never the inflated figure');
  assert.strictEqual(h.session('s_d').costUsd, 1.25, 'a figure saved by the fixed code is kept');
  assert.strictEqual(h.session('s_e').costUsd, 525.78, 'a stale status line loses to the newer (larger) cost-state');
  assert.strictEqual(h.session('s_g').costUsd, 80.14, 'and the status line wins when it is the newer');
  await h.engine.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'sessions.json'), 'utf8')).sessions;
  assert.ok(saved.every((x) => x.costBasis === 'cc'));
});
