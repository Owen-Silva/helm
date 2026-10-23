'use strict';
// "Fresh start with handoff" (lane handoff, 2026-10-09). The user picks it from the session menu or the palette;
// nothing here runs on its own.
//
//   sessions.handoff { id }        sends the session ONE visible prompt asking for a compact handoff, waits for
//                                  that turn to end and resolves { text, from: { id, title, cwd, model, effort,
//                                  permissionMode } } with the turn's final assistant text. The UI then opens the
//                                  new session itself (sessions.create) and prefills its message box, unsent.
//   sessions.handoffCancel { id }  stops a handoff in flight: interrupts its turn; sessions.handoff rejects with
//                                  code 'cancelled'.
//
// Failures reject with a code the UI shows: busy (a turn is running, or a handoff already is), interrupted (the
// turn was stopped some other way), failed (the turn errored or the CLI died; message = why), empty (the reply
// had no text).

const HANDOFF_PROMPT = [
  'Write a compact handoff so a fresh session can pick this work up.',
  'Under about 250 words, no preamble, no sign-off. Four short sections: Done, Left, Files (the paths that matter),',
  'Test state (exact summary lines, or "not run"). Write it from what you already know; don\'t run tools.',
  'Reply with the handoff only.',
].join(' ');

const MAX_HANDOFF_CHARS = 20_000; // a runaway reply is cut; the composer still gets something reviewable

function codeErr(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The turn's final assistant text: the SDK result's `result` when present, else the main-thread assistant text
// after the handoff prompt, from the last tool call on (subagent text and thinking are skipped).
function finalText(items, userItemId, result) {
  if (typeof result === 'string' && result.trim()) return result.trim();
  const list = Array.isArray(items) ? items : [];
  const at = list.findIndex((it) => it && it.id === userItemId);
  if (at < 0) return '';
  let parts = [];
  for (const it of list.slice(at + 1)) {
    if (!it || it.parentToolUseId) continue;
    if (it.type === 'assistant') { if (typeof it.text === 'string' && it.text.trim()) parts.push(it.text.trim()); }
    else if (it.type === 'tool') parts = [];
  }
  return parts.join('\n\n');
}

function clip(text) {
  return text.length > MAX_HANDOFF_CHARS ? text.slice(0, MAX_HANDOFF_CHARS).trimEnd() + '\n…' : text;
}

// get(id) -> EngineSession (throws not_found); onSend(es) runs before the prompt goes (the reaper unmark).
function createHandoff({ get, onSend = () => {}, log = () => {} }) {
  const inflight = new Map(); // session id -> { cancelled }

  async function handoff(p = {}) {
    const es = get(p.id);
    const id = es.s.id;
    if (inflight.has(id)) throw codeErr('A handoff is already being written for this session', 'busy');
    await es.ensureLoaded();
    if (es.turnActive || es.s.status === 'working' || es.s.status === 'waiting') {
      throw codeErr('This session is working. Wait for it to finish, or stop it, then try again.', 'busy');
    }
    const job = { cancelled: false };
    inflight.set(id, job);
    try {
      let waiter = null;
      const settled = new Promise((resolve) => { waiter = resolve; });
      es.turnWaiters = es.turnWaiters || [];
      es.turnWaiters.push(waiter);
      onSend(es);
      let sent;
      try {
        // origin 'helm': Helm wrote this prompt, not the user (the guard lane's push guard only trusts the user's own).
        sent = await es.send({ text: HANDOFF_PROMPT, origin: 'helm' });
      } catch (e) {
        es.turnWaiters = (es.turnWaiters || []).filter((fn) => fn !== waiter);
        throw e;
      }
      if (sent && sent.queued) {
        // Something started a turn between the check and the send: take the prompt back out of the queue
        // (that other turn keeps running).
        log('warn', `engine: handoff for ${id} queued behind another turn; withdrawn`);
        es.turnWaiters = (es.turnWaiters || []).filter((fn) => fn !== waiter);
        es.pendingQueue = es.pendingQueue.filter((q) => q.item.id !== sent.itemId);
        es.s.queued = es.pendingQueue.length;
        es.norm.store.patch(sent.itemId, { queued: false, cancelled: true });
        es.touch();
        throw codeErr('This session started working. Try again when it is idle.', 'busy');
      }
      const info = await settled;
      if (job.cancelled) throw codeErr('Handoff cancelled', 'cancelled');
      if (info.interrupted) throw codeErr('The handoff turn was interrupted before it finished', 'interrupted');
      if (info.failed) throw codeErr(info.error ? `The handoff turn failed: ${info.error}` : 'The handoff turn failed', 'failed');
      const text = finalText(es.items, sent && sent.itemId, info.result);
      if (!text) throw codeErr('Claude replied without any handoff text', 'empty');
      log('info', `engine: handoff written for ${id} (${text.length} chars)`);
      const s = es.s;
      return { text: clip(text), from: { id, title: s.title || 'New session', cwd: s.cwd, model: s.model || null, effort: s.effort || null, permissionMode: s.permissionMode || null } };
    } finally {
      inflight.delete(id);
    }
  }

  async function cancel(p = {}) {
    const es = get(p.id);
    const job = inflight.get(es.s.id);
    if (!job) return { cancelled: false };
    // lane steer: refused ('agents_running', data.agents) while agents run unless the user confirmed stopAgents; then
    // the job is not cancelled (the refusal comes before anything is touched).
    job.cancelled = true;
    try {
      await es.interrupt({ stopAgents: p.stopAgents === true });
    } catch (e) {
      job.cancelled = false;
      throw e;
    }
    return { cancelled: true };
  }

  return {
    methods: {
      'sessions.handoff': handoff,
      'sessions.handoffCancel': cancel,
    },
    inflight,
  };
}

module.exports = { createHandoff, finalText, HANDOFF_PROMPT, MAX_HANDOFF_CHARS };
