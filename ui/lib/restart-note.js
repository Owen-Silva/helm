// The restart note (lane restart, 2026-10-15). A Helm restart (or quit) ends every claude.exe it hosts: the turn
// in progress, its background agents, background tasks and `!` runs all stop, and nothing brings them back. At
// shutdown the engine keeps, per session, what it cut off (Session.restartNote, main/engine/session.js
// cutOffState). After the next start that session shows this note at the end of its conversation:
//   "Helm restarted at 5:34 PM: 5 agents stopped" + the agent list + Continue / Dismiss.
// Continue = sessions.continueAfterRestart: sends "Continue where you left off." and Claude gets a <helm-note>
// naming what stopped, with each agent's id (SendMessage resumes an agent with its own context).
// Pure ESM with no imports: the UI imports it and node tests require() it.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const clock24 = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const RESTART_NOTE_SHOWN = 5; // list rows before "Show all"

// note (Session.restartNote) -> null | {
//   headline: 'Helm restarted at 5:34 PM: 5 agents stopped', facts: ['Claude was mid-turn', ...],
//   items: [{ kind: 'agent'|'task', name, tag, id }], total, more }
// fmt: the UI's clock (ui/chat/util.js fmtTime); 24 h by default.
export function restartNoteModel(note, fmt = clock24) {
  if (!note || typeof note.at !== 'number' || !Number.isFinite(note.at)) return null;
  const agents = Array.isArray(note.agents) ? note.agents.filter(Boolean) : [];
  const tasks = Array.isArray(note.tasks) ? note.tasks.filter(Boolean) : [];
  const nAgents = Math.max(agents.length, Number(note.agentsTotal) || 0);
  const shells = Number(note.shells) > 0 ? Number(note.shells) : 0;
  const queued = Number(note.queued) > 0 ? Number(note.queued) : 0;
  const working = !!note.working;
  if (!working && !nAgents && !tasks.length && !shells && !queued) return null;
  const what = `${note.cause === 'quit' ? 'Helm closed' : 'Helm restarted'} at ${fmt(note.at)}`;
  // the headline names the biggest loss: agents, else the turn, else tasks / `!` runs / queued messages
  const lead = nAgents ? `${plural(nAgents, 'agent', 'agents')} stopped`
    : working ? (note.waiting ? 'the turn waiting on you ended' : 'the turn in progress stopped')
      : tasks.length ? `${plural(tasks.length, 'background task', 'background tasks')} stopped`
        : shells ? `${plural(shells, '! command', '! commands')} stopped`
          : `${plural(queued, 'queued message', 'queued messages')} not sent`;
  const facts = [];
  // lane detach: "Keep sessions running through a restart" was on but Helm could not re-attach: say why
  if (typeof note.reason === 'string' && note.reason.trim()) facts.push(`Helm could not keep it running: ${note.reason.trim()}`);
  if (nAgents && working) facts.push(note.waiting ? 'The turn waiting on you ended' : 'The turn in progress stopped');
  if ((nAgents || working) && tasks.length) facts.push(`${plural(tasks.length, 'background task', 'background tasks')} stopped`);
  if ((nAgents || working || tasks.length) && shells) facts.push(`${plural(shells, '! command', '! commands')} stopped`);
  if ((nAgents || working || tasks.length || shells) && queued) facts.push(`${plural(queued, 'queued message was', 'queued messages were')} not sent`);
  const items = [
    ...agents.map((a) => {
      const raw = String(a.name || 'agent');
      const m = /^\s*\[lane:([^\]]+)\]\s*(.*)$/.exec(raw);
      return { kind: 'agent', name: m ? (m[2] || m[1]) : raw, tag: m ? m[1] : null, id: a.agentId || null };
    }),
    ...tasks.map((t) => ({ kind: 'task', name: String(t.description || t.type || 'Background task'), tag: null, id: null })),
  ];
  return { headline: `${what}: ${lead}`, facts, items, total: items.length, more: Math.max(0, nAgents - agents.length) };
}

// What Continue tells the user it will do (the button's title and the hint under it).
export function continueHint(note) {
  const n = note && Array.isArray(note.agents) ? Math.max(note.agents.length, Number(note.agentsTotal) || 0) : 0;
  return n
    ? `Sends "Continue where you left off." with the stopped ${n === 1 ? 'agent\'s id' : 'agents\' ids'}, so Claude can pick ${n === 1 ? 'it' : 'them'} back up.`
    : 'Sends "Continue where you left off." Claude is told what the restart stopped.';
}
