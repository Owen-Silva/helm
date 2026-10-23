'use strict';
// Soak finding (2026-10-08): interrupting a turn that had just started produced an error result
// ("Stopped after 0s · error during execution") plus a red error card holding Claude Code's internal
// "[ede_diagnostic] result_type=user …" line and a Retry button. A deliberate interrupt must end as
// a calm interrupted result, and internal diagnostic lines must never reach the transcript.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../../main/engine');
const { cleanErrorText } = require('../../main/engine/normalize');
const { createFakeSdk, F } = require('./fake-sdk');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIAG = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';

function harness(turn) {
  const projectsDir = tmp('helm-irproj-');
  const events = [];
  const sdk = createFakeSdk(turn, { projectsDir });
  const engine = createEngine({ userDataDir: tmp('helm-ir-'), emit: (event, data) => events.push({ event, data }), log: () => {}, sdk, claudePath: null, projectsDir, statuslineDir: tmp('helm-irsl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = pred();
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error('timed out waiting');
  };
  const es = (id) => engine._internal.sessions.get(id);
  return { engine, m: engine.methods, events, waitFor, cwd: tmp('helm-ircwd-'), es };
}

test('cleanErrorText drops bracketed snake_case diagnostic lines and keeps the readable rest', () => {
  assert.strictEqual(cleanErrorText(DIAG), '');
  assert.strictEqual(cleanErrorText(`API Error: 529 overloaded\n${DIAG}`), 'API Error: 529 overloaded');
  assert.strictEqual(cleanErrorText('  [some_internal_tag] x=1\nreal problem'), 'real problem');
  // Ordinary bracketed text is not a diagnostic tag.
  assert.strictEqual(cleanErrorText('[Request interrupted by user]'), '[Request interrupted by user]');
  assert.strictEqual(cleanErrorText('[error] disk full'), '[error] disk full');
  assert.strictEqual(cleanErrorText(null), '');
});

test('interrupting a turn that just started ends with an interrupted result: no error, no error card, no diagnostics', async () => {
  let started = false;
  const h = harness(async function* (um, api) {
    started = true;
    // The CLI has produced nothing yet when the interrupt lands, and answers with the error result
    // seen live: error_during_execution, 2 turns, an internal diagnostic as its only "error".
    api.state.interruptResult = { num_turns: 2, duration_ms: 300, errors: [DIAG] };
    while (!api.state.interrupted) await sleep(5);
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'start something long' });
  await h.waitFor(() => started && h.es(s.id).turnActive); // the CLI has read the prompt
  h.events.length = 0;
  await h.m['sessions.interrupt']({ id: s.id });
  await h.waitFor(() => h.es(s.id).items.some((i) => i.type === 'result'));
  await h.waitFor(() => !h.es(s.id).turnActive);

  const items = h.es(s.id).items;
  const res = items.find((i) => i.type === 'result');
  assert.strictEqual(res.isError, false, 'an interrupt is not an error');
  assert.strictEqual(res.interrupted, true, 'the result says it was interrupted');
  assert.ok(items.some((i) => i.type === 'system' && i.subtype === 'interrupted'), 'the calm Interrupted line is there');
  assert.ok(!items.some((i) => i.type === 'system' && i.subtype === 'error'), 'no error card (and so no Retry)');
  assert.ok(!JSON.stringify(items).includes('ede_diagnostic'), 'no internal diagnostic text in any item');
  assert.strictEqual(h.es(s.id).s.status, 'idle');
  assert.ok(!h.events.some((e) => e.event === 'notify' && e.data.kind === 'error'), 'no "turn failed" notification');
  await h.engine.shutdown();
});

test('a real error result keeps its card, but without the internal diagnostic line', async () => {
  let n = 0;
  const h = harness(async function* () {
    n++;
    if (n === 1) {
      yield F.result(0.01, { is_error: true, subtype: 'error_during_execution', errors: [`API Error: 529 overloaded\n${DIAG}`] });
      return;
    }
    yield F.result(0.02, { is_error: true, subtype: 'error_during_execution', errors: [DIAG] });
  });
  const s = await h.m['sessions.create']({ cwd: h.cwd });
  await h.m['sessions.send']({ id: s.id, text: 'one' });
  await h.waitFor(() => h.es(s.id).s.status === 'error');
  let errs = h.es(s.id).items.filter((i) => i.type === 'system' && i.subtype === 'error');
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].text, 'API Error: 529 overloaded');
  const res = h.es(s.id).items.find((i) => i.type === 'result');
  assert.strictEqual(res.isError, true, 'a failure that was not an interrupt is still an error');
  assert.strictEqual(res.interrupted, undefined);
  assert.ok(!/ede_diagnostic/.test(h.es(s.id).s.activity || ''), 'the sidebar activity line is clean too');

  // A failure whose only text was a diagnostic still gets a readable card.
  await h.m['sessions.send']({ id: s.id, text: 'two' });
  await h.waitFor(() => h.es(s.id).items.filter((i) => i.type === 'result').length === 2);
  errs = h.es(s.id).items.filter((i) => i.type === 'system' && i.subtype === 'error');
  assert.strictEqual(errs.length, 2);
  assert.strictEqual(errs[1].text, 'Claude Code ended the turn with an error.');
  assert.ok(!JSON.stringify(h.es(s.id).items).includes('ede_diagnostic'));
  assert.ok(!h.events.some((e) => e.event === 'notify' && /ede_diagnostic/.test(e.data.body || '')), 'notifications are clean');
  await h.engine.shutdown();
});
