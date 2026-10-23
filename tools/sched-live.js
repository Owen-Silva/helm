// Live check for the Scheduled list (lane sched): the REAL claude.exe on claude-haiku-5-5 through Helm's engine, in a
// throwaway userData + temp folder. Never touches the user's Helm (no Electron, no port, no %APPDATA%\Helm).
//   node tools/sched-live.js
// 1. Claude creates a session-only cron -> schedules.list shows it (kind cron, nextAt in the future).
// 2. "Ask Claude to cancel" -> Claude runs CronDelete -> the row moves to ended as 'deleted'.
// 3. Claude creates another -> "Close process" -> ended as 'closed', CLI gone.
// 4. A third, then engine.shutdown() + a new engine on the same userData -> ended as 'restart'.
// Summary line: "sched-live: N passed, M failed". About 4-5 short haiku turns.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../main/engine');

const MODEL = 'claude-haiku-5-5';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-sched-live-'));
const userDataDir = path.join(tmp, 'ud');
const cwd = path.join(tmp, 'work');
fs.mkdirSync(cwd, { recursive: true });
let passed = 0, failed = 0;
const check = (ok, what, extra = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${extra ? ` (${extra})` : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function idle(engine, id, ms = 120_000) {
  const t = Date.now();
  await wait(1500);
  while (Date.now() - t < ms) {
    const es = engine._internal.sessions.get(id);
    if (es && !es.busyState()) return true;
    await wait(500);
  }
  return false;
}
const make = (n) => `Use the CronCreate tool exactly once with cron "*/30 * * * *", prompt "sched-live tick ${n}", recurring true (not durable). Then reply with just: ok`;

(async () => {
  let engine = createEngine({ userDataDir, external: false, etaDir: false, getDefaults: () => ({ model: MODEL, effort: 'low', permissionMode: 'bypassPermissions' }) });
  try {
    const s = await engine.methods['sessions.create']({ cwd, model: MODEL, effort: 'low', permissionMode: 'bypassPermissions' });
    await engine.methods['sessions.send']({ id: s.id, text: make(1) });
    await idle(engine, s.id);
    let l = await engine.methods['schedules.list']();
    const c = l.items.find((x) => x.sessionId === s.id);
    check(c && c.kind === 'cron' && c.nextAt > Date.now() && c.recurring, 'CronCreate shows in schedules.list', c ? `${c.label} · next ${new Date(c.nextAt).toLocaleTimeString()} · id ${c.cronId}` : 'none');

    if (c) {
      const r = await engine.methods['schedules.cancel']({ sessionId: s.id, key: c.key, how: 'ask' });
      check(r.asked, 'ask sent', r.text);
      await idle(engine, s.id);
      l = await engine.methods['schedules.list']();
      check(!l.items.some((x) => x.key === c.key) && l.ended.some((e) => e.why === 'deleted' && e.asked), 'Claude cancelled it: ended as deleted');
    }

    await engine.methods['sessions.send']({ id: s.id, text: make(2) });
    await idle(engine, s.id);
    l = await engine.methods['schedules.list']();
    const c2 = l.items.find((x) => x.sessionId === s.id);
    check(!!c2, 'second cron listed');
    if (c2) {
      const r = await engine.methods['schedules.cancel']({ sessionId: s.id, key: c2.key, how: 'close' });
      l = await engine.methods['schedules.list']();
      check(r.closed && r.left === 0 && l.ended.some((e) => e.why === 'closed'), 'Close process ended it', JSON.stringify(r));
    }

    await engine.methods['sessions.send']({ id: s.id, text: make(3) });
    await idle(engine, s.id);
    l = await engine.methods['schedules.list']();
    check(l.items.length === 1, 'third cron listed before shutdown');
    await engine.shutdown();
    engine = createEngine({ userDataDir, external: false, etaDir: false });
    l = await engine.methods['schedules.list']();
    check(l.ended.some((e) => e.why === 'restart' && /tick 3/.test(e.label)), 'Ended by restart after a new engine start');
  } catch (e) {
    failed++; console.log(`FAIL threw: ${e.stack || e.message}`);
  } finally {
    try { await engine.shutdown(); } catch {}
    console.log(`sched-live: ${passed} passed, ${failed} failed`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  }
})();
