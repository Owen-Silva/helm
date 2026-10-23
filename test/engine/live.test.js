'use strict';
// LIVE smoke test against the user's real claude.exe (costs a few cents on claude-haiku-5-5).
// Runs only with HELM_LIVE=1:  HELM_LIVE=1 node --test test/engine/live.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');

const LIVE = process.env.HELM_LIVE === '1';
const CWD = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'helm-smoke');
const MODEL = process.env.HELM_LIVE_MODEL || 'claude-haiku-5-5';

test('live: create → send → resume → AskUserQuestion → plan → reload from disk', { skip: !LIVE && 'set HELM_LIVE=1', timeout: 600_000 }, async (t) => {
  fs.mkdirSync(CWD, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-live-'));
  const events = [];
  const logs = [];
  const engine = createEngine({ userDataDir, emit: (event, data) => events.push({ event, data }), log: (l, m) => logs.push(`${l} ${m}`) });
  const m = engine.methods;
  const sess = (id) => engine._internal.sessions.get(id).publicSession();
  const waitFor = async (pred, ms = 180_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = pred();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    const tl = events.filter((e) => e.event === 'session.item' || e.event === 'session.updated').slice(-12).map((e) => (e.data.item ? `${e.data.item.type}:${e.data.item.name || e.data.item.kind || e.data.item.subtype || ''}:${e.data.item.status || ''}` : `upd:${e.data.status}`));
    throw new Error(`timed out; timeline: ${tl.join(' > ')}; logs: ${logs.slice(-5).join(' | ')}`);
  };
  const items = async (id) => (await m['sessions.history']({ id, limit: 2000 })).items;
  const resultsSoFar = (id) => events.filter((e) => e.event === 'session.item' && e.data.sessionId === id && e.data.item.type === 'result').length;
  const turn = async (id, text) => {
    const before = resultsSoFar(id);
    const r = await m['sessions.send']({ id, text });
    await waitFor(() => resultsSoFar(id) > before && sess(id).status !== 'working');
    return r;
  };

  try {
    // 1. create + first turn
    const s = await m['sessions.create']({ cwd: CWD, model: MODEL, effort: 'low', permissionMode: 'bypassPermissions' });
    const t0 = Date.now();
    await turn(s.id, 'reply with the word ok');
    t.diagnostic(`first turn ${Date.now() - t0} ms (includes CLI start)`);
    let it = await items(s.id);
    const ok = it.find((i) => i.type === 'assistant' && /ok/i.test(i.text));
    assert.ok(ok, 'assistant replied ok: ' + JSON.stringify(it.map((i) => [i.type, i.text]).slice(0, 8)));
    assert.ok(it.some((i) => i.type === 'result' && i.costUsd > 0));
    assert.ok(events.some((e) => e.event === 'session.itemUpdate' && e.data.appendText), 'streamed text deltas');
    const init = engine._internal.lastInit();
    t.diagnostic(`init: v${init.version} model=${init.model} perm=${init.permissionMode} tools=${init.tools.length} eta=${init.tools.includes('mcp__eta__Eta')} pace=${init.tools.includes('mcp__pace__Pace')} plugins=${init.plugins.map((p) => p.name).join(',')}`);
    const s1 = sess(s.id);
    t.diagnostic(`session after turn 1: title="${s1.title}" cost=${s1.costUsd} ctx=${JSON.stringify(s1.context)} claudeSessionId=${s1.claudeSessionId}`);
    assert.ok(s1.claudeSessionId);
    assert.strictEqual(s1.status, 'idle');

    // 2. live commands/models + usage
    const cmds = await m['sessions.commands']({ id: s.id });
    const models = await m['sessions.models']({});
    t.diagnostic(`commands=${cmds.length} models=${models.map((x) => x.value).join(',')}`);
    assert.ok(cmds.length > 0 && models.length > 0);
    const u = await m['usage.get']({});
    t.diagnostic(`usage: ${JSON.stringify(u)}`);

    // 3. close → resume
    await m['sessions.close']({ id: s.id });
    assert.strictEqual(sess(s.id).status, 'closed');
    await turn(s.id, 'What single word did you reply with in your previous message? Answer with just that word.');
    it = await items(s.id);
    const last = it.filter((i) => i.type === 'assistant').pop();
    t.diagnostic(`resume answer: ${JSON.stringify(last.text)}; cost now ${sess(s.id).costUsd}`);
    assert.match(last.text, /ok/i, 'resumed conversation remembers');
    assert.strictEqual(sess(s.id).claudeSessionId, s1.claudeSessionId);

    // 4. AskUserQuestion round-trip in bypassPermissions mode
    const before = events.length;
    const send = m['sessions.send']({ id: s.id, text: 'Use the AskUserQuestion tool to ask me whether I prefer red or blue (two options, single select). After I answer, reply with just the color name.' });
    await send;
    const req = await waitFor(() => events.slice(before).find((e) => e.event === 'session.item' && e.data.item.type === 'request'));
    assert.strictEqual(req.data.item.kind, 'question');
    assert.strictEqual(sess(s.id).status, 'waiting');
    const q = req.data.item.questions[0];
    t.diagnostic(`question: ${q.question} [${q.options.map((o) => o.label).join('/')}]`);
    const blue = (q.options.find((o) => /blue/i.test(o.label)) || q.options[0]).label;
    const nRes = resultsSoFar(s.id);
    await m['sessions.respond']({ id: s.id, requestId: req.data.item.requestId, response: { answers: { [q.question]: blue } } });
    await waitFor(() => resultsSoFar(s.id) > nRes && sess(s.id).status !== 'working');
    it = await items(s.id);
    assert.match(it.filter((i) => i.type === 'assistant').pop().text, /blue/i);

    // 5. plan mode → ExitPlanMode request
    await m['sessions.update']({ id: s.id, permissionMode: 'plan' });
    const b2 = events.length;
    await m['sessions.send']({ id: s.id, text: 'Plan only: create a file named plan-ok.txt containing the word ok. Do not explore; immediately present a one-step plan with ExitPlanMode.' });
    const plan = await waitFor(() => events.slice(b2).find((e) => e.event === 'session.item' && e.data.item.type === 'request') || (resultsSoFar(s.id) > nRes + 1 && sess(s.id).status !== 'working' && 'no-request'));
    if (plan === 'no-request') {
      t.diagnostic('plan: model ended the turn without calling ExitPlanMode (not verified)');
    } else {
      t.diagnostic(`plan request kind=${plan.data.item.kind} plan=${JSON.stringify(String(plan.data.item.plan).slice(0, 120))} inputKeys=${Object.keys(plan.data.item.input || {}).join(',')}`);
      assert.strictEqual(plan.data.item.kind, 'plan');
      const nr = resultsSoFar(s.id);
      let reqItem = plan.data.item;
      for (let round = 0; round < 3 && reqItem; round++) {
        const mark = events.length;
        await m['sessions.respond']({ id: s.id, requestId: reqItem.requestId, response: { behavior: 'deny', message: 'Stop here. Make no changes and reply with the word stopped.' } });
        const next = await waitFor(() => events.slice(mark).find((e) => e.event === 'session.item' && e.data.item.type === 'request') || (resultsSoFar(s.id) > nr && sess(s.id).status !== 'working' && 'done'));
        reqItem = next === 'done' ? null : next.data.item;
        if (reqItem) t.diagnostic(`after deny the model asked again: kind=${reqItem.kind} tool=${reqItem.toolName}`);
      }
      assert.ok(resultsSoFar(s.id) > nr, 'plan turn ended');
      assert.ok(!fs.existsSync(path.join(CWD, 'plan-ok.txt')), 'denied plan made no file');
    }
    const fleet = events.filter((e) => e.event === 'fleet.updated');
    t.diagnostic(`events: ${events.length} total, fleet.updated ${fleet.length}, notify ${events.filter((e) => e.event === 'notify').length}`);

    // 6. reload: a fresh engine rebuilds the session from sessions.json + the on-disk transcript
    await engine.shutdown();
    const e2 = createEngine({ userDataDir, emit: () => {}, log: () => {} });
    const snap = e2.snapshot();
    assert.strictEqual(snap.sessions.length, 1);
    const h = await e2.methods['sessions.history']({ id: s.id, limit: 2000 });
    const users = h.items.filter((i) => i.type === 'user').map((i) => i.text);
    t.diagnostic(`reloaded ${h.items.length} items from disk; users=${users.length}; types=${[...new Set(h.items.map((i) => i.type))].join(',')}`);
    assert.ok(users.some((x) => /reply with the word ok/.test(x)));
    assert.ok(h.items.some((i) => i.type === 'tool' && i.name === 'AskUserQuestion' && i.status === 'done'));
    const cps = await e2.methods['sessions.checkpoints']({ id: s.id });
    assert.ok(cps.length >= 3);
    const hist = await e2.methods['history.search']({ q: s1.claudeSessionId.slice(0, 8), limit: 5 });
    t.diagnostic(`history.search hit: ${JSON.stringify(hist[0] && { title: hist[0].title, helmSessionId: hist[0].helmSessionId })}`);
    assert.strictEqual(hist[0] && hist[0].helmSessionId, s.id);
    await e2.shutdown();
  } finally {
    await engine.shutdown().catch(() => {});
  }
});
