// Idle CLI reaper. Every live session keeps its own claude.exe running until Helm quits, and an idle one still holds
// ~290-450 MB working set / ~500-680 MB commit (measured 2026-10-08: tools/cli-coldstart.js for a fresh CLI, the user's
// live CLIs through tools/proc-sample.js). This closes a session's CLI once it has been idle for `idleMs`; the session
// stays resumable and the next send starts a fresh CLI with resume (cold start ~3 s measured, inside the gap a send
// after a long idle already pays, since the prompt cache has expired by then).
//
// Never closes a CLI that is doing anything: the caller's isBusy(es) is the same per-session check the restart gate
// (main/update.js restartBlockers via engine.busy()) and recycleClis use: turn running, starting, compacting, queued
// prompts, a pending permission / question, background agents or tasks, `!` runs. It is checked again right before
// the close. Idle = no use (s.updatedAt: every send, turn end, item and CLI start bumps it) and no other activity
// (es.lastActiveAt: e.g. The user typing a draft for it) within idleMs.
// The close is quiet: it must not bump updatedAt (that would reorder the sidebar) or change the visible status.
// isHeld(es) (reaper-only, schedules.js) keeps an idle CLI whose /loop wake-up or cron job is still due inside it.
//
// Release (lane tabrelease, the user closing a session's tab): release(es) closes an idle, not-held CLI right away (the
// same quiet close); a busy or held one is MARKED and every sweep closes it as soon as it is idle, not held and not on
// screen (isVisible), without waiting for idleMs (and even when idleMs is 0 = Never: the tab close is explicit).
// unmark(es) (re-opened, viewed on the phone, sent a message) drops the mark; the normal idle window applies again.
//
//   createIdleReaper({ sessions, isBusy, isHeld, isVisible, idleMs, everyMs, now, log, setInterval, clearInterval })
//     -> { sweep(), stop(), setEvery(ms), noteResume(es), stats(), release(es) -> Promise<{ action, reason? }>,
//          unmark(es), isMarked(es) }
//   release action: 'closed' (CLI closed now) | 'marked' (closes once idle) | 'none' (no CLI running)
//   sessions: Map/iterable of engine sessions with live(), closing, close({ final, quiet }), s.updatedAt and an
//   optional es.lastActiveAt (ms)
//   idleMs: ms, or a function returning it (read on every sweep: the Settings choice); 0 / null = never close
//   stats() -> { closed, released, resumed, lastClosedAt } since this process started (closed includes released)
// Owner: lane reaper (engine wiring: main/engine/index.js).
'use strict';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_EVERY_MS = 60 * 1000;

function createIdleReaper(opts = {}) {
  const sessions = opts.sessions;
  const isBusy = opts.isBusy || (() => true);
  const idleOpt = opts.idleMs == null ? DEFAULT_IDLE_MS : opts.idleMs;
  const idleMsNow = () => {
    try { return Number(typeof idleOpt === 'function' ? idleOpt() : idleOpt) || 0; } catch { return 0; }
  };
  let everyMs = opts.everyMs || DEFAULT_EVERY_MS;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const setI = opts.setInterval || setInterval;
  const clearI = opts.clearInterval || clearInterval;
  const closing = new Set();
  const counts = { closed: 0, released: 0, resumed: 0, lastClosedAt: null };
  const marked = new Set(); // sessions released while busy / held: close once idle (lane tabrelease)
  const isVisible = opts.isVisible || (() => false);
  // isHeld(es) -> null | { key, reason }: idle, but something inside the CLI is still due (schedules.js: a /loop
  // ScheduleWakeup or a CronCreate job). Reaper-only; the restart gate does not use it.
  const isHeld = opts.isHeld || (() => null);
  const heldLogged = new Map(); // es -> hold key last logged (one line per hold change, not one per sweep)

  const busyOf = (es) => {
    try { return !!isBusy(es); } catch { return true; } // when in doubt, leave it running
  };
  const heldOf = (es) => {
    try { return isHeld(es) || null; } catch { return { key: 'error', reason: 'schedule check failed' }; }
  };
  const visibleOf = (es) => {
    try { return !!isVisible(es); } catch { return true; }
  };
  const lastActive = (es) => Math.max(Number(es.lastActiveAt) || 0, Number(es.s && es.s.updatedAt) || 0);

  // The quiet close shared by the idle window and a release. stillOk() is re-checked at the close itself: nothing
  // may have started since the caller looked. -> Promise<boolean> (closed)
  function closeQuietly(es, stillOk, line) {
    closing.add(es);
    return Promise.resolve()
      .then(() => {
        if (!es.live() || es.closing || busyOf(es) || heldOf(es) || !stillOk()) return false;
        return Promise.resolve(es.close({ final: false, quiet: true })).then(() => true);
      })
      .then((did) => {
        if (!did) return false;
        counts.closed++;
        counts.lastClosedAt = now();
        es.idleClosedAt = counts.lastClosedAt;
        log('info', line());
        return true;
      })
      .catch((e) => { log('warn', `engine: idle close ${es.s && es.s.id} failed: ${e.message}`); return false; })
      .finally(() => closing.delete(es));
  }

  // Marked sessions (released while busy / held): close the moment they are idle, not held and not on screen.
  function sweepMarked(closed) {
    for (const es of [...marked]) {
      if (!es || typeof es.live !== 'function' || !es.live()) { marked.delete(es); continue; } // CLI gone: nothing to release
      if (es.closing || closing.has(es) || busyOf(es) || heldOf(es) || visibleOf(es)) continue;
      closed.push(es.s && es.s.id);
      closeQuietly(es, () => marked.has(es) && !visibleOf(es), () => `engine: closed CLI for ${es.s && es.s.id} released on tab close (now idle)`)
        .then((did) => { if (did) { counts.released++; marked.delete(es); } });
    }
  }

  function sweep() {
    const closed = [];
    if (marked.size) sweepMarked(closed);
    const idleMs = idleMsNow();
    if (!(idleMs > 0)) return closed;
    const t = now();
    const seen = new Set();
    for (const es of sessions.values ? sessions.values() : sessions) {
      if (!es || typeof es.live !== 'function' || !es.live() || es.closing || closing.has(es)) continue;
      if (marked.has(es) || busyOf(es)) continue; // a marked one is sweepMarked's (it closes it sooner)
      const last = lastActive(es);
      if (!last || t - last < idleMs) continue;
      const held = heldOf(es);
      if (held) {
        seen.add(es);
        const key = held.key || held.reason;
        if (heldLogged.get(es) !== key) {
          heldLogged.set(es, key);
          log('info', `engine: kept idle CLI for ${es.s && es.s.id}: ${held.reason || key}`);
        }
        continue;
      }
      closed.push(es.s && es.s.id);
      closeQuietly(es, () => lastActive(es) === last && !marked.has(es),
        () => `engine: closed idle CLI for ${es.s && es.s.id} after ${Math.round((t - last) / 60000)} min idle (window ${Math.round(idleMs / 60000)} min)`);
    }
    // A hold that is over (or whose CLI is gone) is forgotten, so the next one logs; one that only paused while a
    // loop tick ran stays, so a /loop session logs once, not once per tick.
    for (const es of heldLogged.keys()) if (!seen.has(es) && (!es.live() || !heldOf(es))) heldLogged.delete(es);
    return closed;
  }

  // A function window can be switched on later (Settings), so its timer always runs; a fixed 0 means never.
  const enabled = typeof idleOpt === 'function' || idleMsNow() > 0;
  let timer = null;
  function arm() {
    if (timer) clearI(timer);
    timer = enabled || marked.size ? setI(sweep, everyMs) : null;
    if (timer && timer.unref) timer.unref();
  }
  arm();

  // The user closed this session's tab (the caller has already checked it is not on screen anywhere).
  async function release(es) {
    if (!es || typeof es.live !== 'function') return { action: 'none', reason: 'no such session' };
    if (!es.live() && !es.starting) { marked.delete(es); return { action: 'none', reason: 'no CLI running' }; }
    const held = heldOf(es);
    if (es.closing || closing.has(es) || es.starting || busyOf(es) || held) {
      const reason = held ? (held.reason || held.key) : es.closing || closing.has(es) ? 'already closing' : 'still working';
      if (!marked.has(es)) {
        marked.add(es);
        log('info', `engine: ${es.s && es.s.id} released on tab close; CLI kept until idle (${reason})`);
      }
      if (!timer) { timer = setI(sweep, everyMs); if (timer && timer.unref) timer.unref(); } // a fixed "never" window has no timer
      return { action: 'marked', reason };
    }
    marked.delete(es);
    const did = await closeQuietly(es, () => true, () => `engine: closed CLI for ${es.s && es.s.id}: released on tab close`);
    if (did) { counts.released++; return { action: 'closed' }; }
    // something started between the check and the close: keep it, close once idle
    if (es.live()) { marked.add(es); return { action: 'marked', reason: 'still working' }; }
    return { action: 'none', reason: 'no CLI running' };
  }

  return {
    release,
    unmark: (es) => marked.delete(es),
    isMarked: (es) => marked.has(es),
    sweep,
    stop: () => { if (timer) clearI(timer); timer = null; },
    // tests: sweep more often (the --test idle override)
    setEvery: (ms) => { if (Number(ms) > 0) { everyMs = Number(ms); arm(); } },
    // the session's next CLI start after an idle close (EngineSession.start)
    noteResume: () => { counts.resumed++; },
    stats: () => ({ ...counts }),
  };
}

module.exports = { createIdleReaper, DEFAULT_IDLE_MS };
