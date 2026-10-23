'use strict';
// lane handoff: sessions.handoff / sessions.handoffCancel over the real engine + fake SDK, and finalText.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { createFakeSdk, F } = require('./fake-sdk');
const { finalText, HANDOFF_PROMPT } = require('../../main/engine/handoff');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('finalText: SDK result wins; else main-thread assistant text after the last tool; subagent text skipped', () => {
  const items = [
    { id: 'a', type: 'assistant', text: 'older reply' },
    { id: 'u', type: 'user', text: 'handoff please' },
    { id: 'b', type: 'assistant', text: 'Let me check.' },
    { id: 't', type: 'tool', name: 'Bash' },
    { id: 'c', type: 'assistant', text: 'sub text', parentToolUseId: 'x' },
    { id: 'th', type: 'thinking', text: 'hmm' },
    { id: 'd', type: 'assistant', text: 'Done: A' },
    { id: 'e', type: 'assistant', text: 'Left: B' },
  ];
  assert.strictEqual(finalText(items, 'u', '  From result  '), 'From result');
  assert.strictEqual(finalText(items, 'u', null), 'Done: A\n\nLeft: B');
  assert.strictEqual(finalText(items, 'u', ''), 'Done: A\n\nLeft: B');
  assert.strictEqual(finalText(items, 'missing', null), '');
  assert.strictEqual(finalText([{ id: 'u', type: 'user' }, { id: 't', type: 'tool' }], 'u', null), '');
});

test('engine: sessions.handoff sends one visible prompt and resolves the reply; busy / cancel / interrupted / failed / empty reject with codes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-handoff-'));
  const mk = (p) => fs.mkdtempSync(path.join(root, p));
  let gate = null;
  let mode = 'ok';
  const sdk = createFakeSdk(async function* (um, api) {
    const text = JSON.stringify(um.message && um.message.content);
    if (!text.includes('compact handoff')) {
      if (text.includes('slow')) await new Promise((r) => { gate = r; });
      for (const f of F.textTurn('m' + Math.random(), 'ok')) yield f;
      yield F.result(0.01);
      return;
    }
    if (mode === 'hang') {
      await new Promise((r) => { gate = r; });
      if (api.state.interrupted) return;
    }
    if (mode === 'error') { yield F.result(0.01, { is_error: true, subtype: 'error_during_execution', errors: ['API overloaded'] }); return; }
    if (mode === 'empty') { yield F.result(0.01); return; }
    for (const f of F.textTurn('m' + Math.random(), 'Done: built X\nLeft: Y\nFiles: a.js\nTest state: 3/3 pass')) yield f;
    yield F.result(0.01, mode === 'result' ? { result: 'Handoff from result field' } : {});
  }, { projectsDir: mk('proj-') });
  const engine = createEngine({ userDataDir: mk('ud-'), emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: mk('proj2-'), statuslineDir: mk('sl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), getIdleCloseMs: () => 0 });
  const m = engine.methods;
  const es = (id) => engine._internal.sessions.get(id);
  const until = async (pred, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 4000) throw new Error('timed out: ' + what); await sleep(5); } };
  const openGate = () => { const g = gate; gate = null; if (g) g(); };
  const rejects = async (p, code) => { try { await p; } catch (e) { assert.strictEqual(e.code, code, `${code}: got ${e.code} ${e.message}`); return e; } assert.fail(`expected ${code}`); };
  try {
    const cwd = mk('cwd-');
    const a = await m['sessions.create']({ cwd, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'acceptEdits' });

    // ok: one visible user item with the prompt; reply text + the source session's settings
    const sends = [];
    const realSend = es(a.id).send.bind(es(a.id));
    es(a.id).send = (o) => { sends.push(o); return realSend(o); };
    const r = await m['sessions.handoff']({ id: a.id });
    assert.deepStrictEqual(sends, [{ text: HANDOFF_PROMPT, origin: 'helm' }], 'Helm-written prompt is marked origin helm');
    delete es(a.id).send;
    assert.strictEqual(r.text, 'Done: built X\nLeft: Y\nFiles: a.js\nTest state: 3/3 pass');
    assert.deepStrictEqual(r.from, { id: a.id, title: es(a.id).s.title, cwd, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'acceptEdits' });
    const users = es(a.id).items.filter((it) => it.type === 'user');
    assert.strictEqual(users.length, 1);
    assert.strictEqual(users[0].text, HANDOFF_PROMPT);
    assert.strictEqual(es(a.id).s.status, 'idle');
    assert.deepStrictEqual(es(a.id).turnWaiters, []);

    // the SDK result's text is the turn's final text when present
    mode = 'result';
    assert.strictEqual((await m['sessions.handoff']({ id: a.id })).text, 'Handoff from result field');

    // busy: a turn is running
    mode = 'ok';
    await m['sessions.send']({ id: a.id, text: 'slow one' });
    await until(() => gate, 'slow turn running');
    await rejects(m['sessions.handoff']({ id: a.id }), 'busy');
    openGate();
    await until(() => es(a.id).s.status === 'idle', 'slow turn done');

    // cancel: interrupts the handoff turn; a second handoff while one is in flight is busy
    mode = 'hang';
    const p = m['sessions.handoff']({ id: a.id });
    await until(() => gate, 'handoff turn running');
    await rejects(m['sessions.handoff']({ id: a.id }), 'busy');
    assert.deepStrictEqual(await m['sessions.handoffCancel']({ id: a.id }), { cancelled: true });
    openGate();
    await rejects(p, 'cancelled');
    assert.deepStrictEqual(await m['sessions.handoffCancel']({ id: a.id }), { cancelled: false });
    await until(() => es(a.id).s.status === 'idle', 'idle after cancel');

    // interrupted some other way (the Stop button)
    const p2 = m['sessions.handoff']({ id: a.id });
    await until(() => gate, 'handoff turn running 2');
    await m['sessions.interrupt']({ id: a.id });
    openGate();
    await rejects(p2, 'interrupted');
    await until(() => es(a.id).s.status === 'idle', 'idle after interrupt');

    // the turn errors
    mode = 'error';
    const e = await rejects(m['sessions.handoff']({ id: a.id }), 'failed');
    assert.match(e.message, /API overloaded/);

    // no text in the reply
    mode = 'empty';
    await rejects(m['sessions.handoff']({ id: a.id }), 'empty');

    // the CLI dies mid-turn
    mode = 'hang';
    const p3 = m['sessions.handoff']({ id: a.id });
    await until(() => gate, 'handoff turn running 3');
    es(a.id)._onExit(new Error('boom'), es(a.id).input);
    await rejects(p3, 'failed');
    openGate();

    // unknown session
    await rejects(m['sessions.handoff']({ id: 'nope' }), 'not_found');
  } finally {
    await engine.shutdown();
  }
});
