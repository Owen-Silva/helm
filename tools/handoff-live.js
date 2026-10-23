'use strict';
// Live check (lane handoff, 2026-10-09): "Fresh start with handoff" on a real claude.exe + claude-haiku-5-5 in a
// throwaway temp cwd. The engine runs in-process with a temp userData folder: never the user's Helm, never port 4871,
// never %APPDATA%\Helm.
//
//   node tools/handoff-live.js          (~$0.01; under a minute)
//
// Steps: one setup turn that gives the session some work to know about; sessions.handoff (the visible prompt, the
// turn's final text back); then sessions.create with the returned folder / model / effort / permission mode, which
// is what the UI does before prefilling the box. Also cancels a second handoff mid-turn (sessions.handoffCancel).
// Summary line: `handoff-live: N passed, M failed` (+ the handoff text and its word count).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../main/engine');
const { HANDOFF_PROMPT } = require('../main/engine/handoff');
const { dropLiveTranscripts } = require('./live-cleanup');

const MODEL = 'claude-haiku-5-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-handoff-live-'));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const engine = createEngine({
    userDataDir: path.join(root, 'ud'),
    emit: () => {},
    log: () => {},
    getDefaults: () => ({ model: MODEL, permissionMode: 'default' }),
    etaDir: false,
    external: false,
    usageSampling: false,
  });
  const m = engine.methods;
  let pass = 0, fail = 0;
  const check = (ok, what, extra = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` (${extra})` : ''}`); };
  const es = (id) => engine._internal.sessions.get(id);
  try {
    const a = await m['sessions.create']({ cwd, model: MODEL, effort: 'low', permissionMode: 'acceptEdits' });
    await m['sessions.send']({ id: a.id, text: 'Context for later, no tools needed: we are building calc.js. Done: add() and its 3 tests pass. Left: sub() and mul(). Files: calc.js, calc.test.js. Reply with just "noted".' });
    for (let t = Date.now(); es(a.id).s.status !== 'idle' && Date.now() - t < 90_000;) await sleep(250);
    check(es(a.id).s.status === 'idle', 'setup turn finished', es(a.id).s.status);

    const t0 = Date.now();
    const r = await m['sessions.handoff']({ id: a.id });
    const words = r.text.split(/\s+/).filter(Boolean).length;
    check(typeof r.text === 'string' && r.text.length > 20, 'handoff text came back', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    check(words <= 320, 'handoff is compact', `${words} words`);
    check(/sub|mul/i.test(r.text), 'handoff names the work left');
    check(r.from.cwd === cwd && r.from.model === MODEL && r.from.effort === 'low' && r.from.permissionMode === 'acceptEdits', 'source settings returned', JSON.stringify({ ...r.from, cwd: undefined, id: undefined, title: undefined }));
    const prompts = es(a.id).items.filter((it) => it.type === 'user').map((it) => it.text);
    check(prompts[prompts.length - 1] === HANDOFF_PROMPT, 'the handoff prompt is a visible user item');

    const b = await m['sessions.create']({ cwd: r.from.cwd, model: r.from.model, effort: r.from.effort, permissionMode: r.from.permissionMode });
    check(b.id !== a.id && b.cwd === cwd && b.model === MODEL && b.effort === 'low' && b.permissionMode === 'acceptEdits', 'new session: same folder, model, effort, permissions');
    check(es(b.id).items.length === 0 && es(b.id).s.status === 'idle', 'new session has nothing sent');

    // cancel mid-turn
    const p = m['sessions.handoff']({ id: a.id });
    for (let t = Date.now(); es(a.id).s.status !== 'working' && Date.now() - t < 10_000;) await sleep(50);
    await sleep(300);
    const c = await m['sessions.handoffCancel']({ id: a.id });
    let code = null;
    try { await p; } catch (e) { code = e.code; }
    check(c.cancelled === true && code === 'cancelled', 'cancel stops the handoff', `code ${code}`);
    for (let t = Date.now(); es(a.id).s.status === 'working' && Date.now() - t < 20_000;) await sleep(250);
    check(es(a.id).s.status !== 'working', 'old session settles after cancel', es(a.id).s.status);

    console.log('\n--- handoff text ---\n' + r.text + '\n---');
  } catch (e) {
    fail++;
    console.log('  FAIL threw: ' + (e.code ? `[${e.code}] ` : '') + e.message);
  } finally {
    await engine.shutdown();
    // both sessions ran in cwd: drop its ~/.claude/projects transcript folder, then the temp root
    console.log(`(cleaned up ${dropLiveTranscripts([cwd], { keep: false }).length} transcript folder(s))`);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log(`handoff-live: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
