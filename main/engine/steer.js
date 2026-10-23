'use strict';
// Mid-turn messages and explicit Stop (lane steer, 2026-10-09).
//
// A message the user sends while a turn runs goes straight into the CLI's streaming input. Claude Code folds it
// into the running turn after the current tool call (a `queued_command` attachment in the transcript; with
// --replay-user-messages the CLI echoes the message, same uuid, the moment Claude takes it), the way the
// terminal does. Measured live on claude.exe 2.1.294 / SDK 0.3.293 (tools/steer-live.js): the agent the
// turn had launched kept running, and Claude quoted the message at its next step, before the turn ended.
// If Claude was already writing its final reply, the CLI runs the message as a turn of its own right after.
// Item.steer: 'pending' (sent, not taken yet) → 'seen' (taken mid-turn) | 'after' (ran as the next turn).
//
// An interrupt stops EVERY running agent of the session and the model is never told (lane stall). So
// sessions.interrupt refuses while agents run unless the caller passes stopAgents: true (the user confirmed a
// dialog naming them), and the next message to the session carries a short Helm note naming the agents
// that Stop ended. The note rides as its own text block, wrapped in <helm-note> so the transcript parser
// shows it as a small line (Item.helmNote), never inside the user's bubble.

const NOTE_RE = /^\s*<helm-note>([\s\S]*?)<\/helm-note>\s*/;

const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// "Helm: your Stop at 18:54 also stopped background agents: guard, recap. They are not running."
function stopNoteText(at, names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return null;
  const one = list.length === 1;
  return `Helm: your Stop at ${hhmm(at)} also stopped ${one ? 'a background agent' : 'background agents'}: ${list.join(', ')}. ${one ? 'It is' : 'They are'} not running.`;
}

// lane restart: what a Helm restart (or quit) cut off in this session, for Claude (rides as the same <helm-note>).
// cut = { at, cause: 'restart'|'quit', working, agents: [{ name, agentId? }], tasks: [{ description }], shells, queued }
// "Helm: Helm restarted at 17:34 while you were working, which ended your turn. It also stopped background agents:
//  guard (agent a12…), recap. They are not running; SendMessage to an agent id resumes it with its context."
function restartNoteText(cut) {
  if (!cut || !cut.at) return null;
  const agents = Array.isArray(cut.agents) ? cut.agents.filter(Boolean) : [];
  const tasks = Array.isArray(cut.tasks) ? cut.tasks.filter(Boolean) : [];
  const shells = Number(cut.shells) > 0 ? Number(cut.shells) : 0;
  const queued = Number(cut.queued) > 0 ? Number(cut.queued) : 0;
  if (!cut.working && !agents.length && !tasks.length && !shells && !queued) return null;
  const what = cut.cause === 'quit' ? `Helm was closed at ${hhmm(cut.at)}` : `Helm restarted at ${hhmm(cut.at)}`;
  const parts = [`Helm: ${what}${cut.working ? ' while you were working, which ended your turn before it finished' : ''}.`];
  // lane detach: keeping the session running through the restart was on but failed
  if (typeof cut.reason === 'string' && cut.reason.trim()) parts.push(`(Helm tried to keep Claude Code running through the restart but could not: ${cut.reason.trim()}.)`);
  if (agents.length) {
    const one = agents.length === 1;
    const names = agents.map((a) => (a.agentId ? `${a.name || 'agent'} (agent ${a.agentId})` : a.name || 'agent'));
    parts.push(`It ${cut.working ? 'also ' : ''}stopped ${one ? 'a background agent' : `${agents.length} background agents`}: ${names.join(', ')}. ${one ? 'It is' : 'They are'} not running; SendMessage to an agent id resumes it with its context.`);
  }
  if (tasks.length) parts.push(`Background ${tasks.length === 1 ? 'task' : 'tasks'} that stopped: ${tasks.map((t) => t.description || t.type || 'task').join('; ')}.`);
  if (shells) parts.push(`${shells === 1 ? 'A ! command' : `${shells} ! commands`} stopped too.`);
  if (queued) parts.push(`${queued === 1 ? 'A queued message was' : `${queued} queued messages were`} not sent.`);
  return parts.join(' ');
}

// SDK user content (string or blocks) with the note as a separate first text block.
function withNote(content, note) {
  if (!note) return content;
  const block = { type: 'text', text: `<helm-note>${note}</helm-note>` };
  if (typeof content === 'string') return [block, { type: 'text', text: content || ' ' }];
  return [block, ...(Array.isArray(content) ? content : [])];
}

// Transcript text → { note, rest }: a leading <helm-note>…</helm-note> comes off the user's text.
function splitNote(text) {
  const m = NOTE_RE.exec(String(text || ''));
  if (!m) return { note: null, rest: text };
  return { note: m[1].trim() || null, rest: String(text).slice(m[0].length) };
}

// User-facing summary of agents an interrupt would stop: "2 agents: guard, recap".
function agentsPhrase(agents) {
  const names = (agents || []).map((a) => (a && a.name) || 'agent');
  const n = names.length;
  const shown = names.slice(0, 4).join(', ') + (n > 4 ? `, +${n - 4} more` : '');
  return `${n} agent${n === 1 ? '' : 's'}: ${shown}`;
}

// A slash command goes after the turn (the CLI runs commands as their own turn); everything else steers.
const isCommand = (text) => /^\s*\/[A-Za-z]/.test(String(text || ''));

module.exports = { stopNoteText, restartNoteText, withNote, splitNote, agentsPhrase, isCommand, NOTE_RE };
