// Explicit Stop (lane steer, 2026-10-09). Claude Code's interrupt stops EVERY background agent of the session and
// the model is never told, so a Stop that would take agents with it asks first and names them:
//   "Stop also stops 2 agents: guard, recap"  [Keep going] [Stop all]
// The engine refuses an interrupt while agents run unless stopAgents: true (error code 'agents_running',
// data.agents = [{ id, name }]), so every caller goes through here: the composer's Stop, the Deck tile's Stop,
// handoff Cancel. Esc and Enter never stop anything (ui/composer/index.js).
//   stopTurn(sid)                      → 'stopped' | 'kept' | 'failed'
//   confirmAgentsThen(call, opts)      call(stopAgents) is retried with true once the user picks "Stop all"
//   <StopConfirmHost />                mounted once (ui/shell/index.js)
import { signal } from '@preact/signals';
import { html } from './html.js';
import { Icon } from './icons.js';
import { rpc, toast, fleetBySession, sessions } from './store.js';
import { Modal } from '../shell/util.js';

export const stopAsk = signal(null); // { title, lead, agents: [name], verb, resolve }

// Running agents Helm knows of for a session, top-level first (names as the engine's agentShortName).
export function runningAgentNames(sid) {
  const list = (fleetBySession.value[sid] || []).filter((a) => a && a.status === 'running');
  list.sort((x, y) => (x.depth || 0) - (y.depth || 0) || (x.startedAt || 0) - (y.startedAt || 0));
  return list.map(agentName);
}
export function agentName(a) {
  const d = String((a && a.description) || '').replace(/\s+/g, ' ').trim();
  const lane = /^\[lane:([^\]]+)\]/.exec(d);
  const n = lane ? lane[1].trim() : d || String((a && (a.subagentType || a.name)) || '').trim() || 'agent';
  return n.length > 48 ? n.slice(0, 47) + '…' : n;
}
export function agentsLine(names) {
  const n = names.length;
  return `Stop also stops ${n} agent${n === 1 ? '' : 's'}: ${names.slice(0, 4).join(', ')}${n > 4 ? `, +${n - 4} more` : ''}`;
}

// Resolves true (Stop all) or false (Keep going / closed).
export function askStopAgents(names, { title = 'Stop this turn?', verb = 'Stop all', lead = '' } = {}) {
  if (stopAsk.value && stopAsk.value.resolve) stopAsk.value.resolve(false);
  return new Promise((resolve) => { stopAsk.value = { names, title, verb, lead, resolve }; });
}

// call(stopAgents): an RPC that may be refused with 'agents_running'. Asks (names from the refusal, else Helm's
// fleet) and retries with stopAgents true. → { ok, result } | { ok: false, kept: true }
export async function confirmAgentsThen(call, opts = {}) {
  try {
    return { ok: true, result: await call(false) };
  } catch (e) {
    if (e.code !== 'agents_running') throw e;
    const names = (e.data && Array.isArray(e.data.agents) ? e.data.agents.map((a) => a.name || 'agent') : []);
    const go = await askStopAgents(names.length ? names : ['background agents'], opts);
    if (!go) return { ok: false, kept: true };
    return { ok: true, result: await call(true) };
  }
}

export async function stopTurn(sid) {
  const s = sessions.value.find((x) => x.id === sid);
  const lead = s ? `“${s.title || 'New session'}” is still working.` : '';
  try {
    // Ask before the first call when Helm already sees agents; the engine's refusal covers the rest.
    const known = runningAgentNames(sid);
    if (known.length) {
      const go = await askStopAgents(known, { lead });
      if (!go) return 'kept';
      await rpc('sessions.interrupt', { id: sid, stopAgents: true });
      return 'stopped';
    }
    const r = await confirmAgentsThen((stopAgents) => rpc('sessions.interrupt', { id: sid, ...(stopAgents ? { stopAgents: true } : {}) }), { lead });
    return r.ok ? 'stopped' : 'kept';
  } catch (e) {
    toast({ title: 'Could not stop', error: e, kind: 'error' });
    return 'failed';
  }
}

export function StopConfirmHost() {
  const a = stopAsk.value;
  if (!a) return null;
  const done = (v) => { stopAsk.value = null; a.resolve(v); };
  return html`<${Modal} title=${a.title} onClose=${() => done(false)} width=${440} class="confirm-modal stop-confirm"
    footer=${html`<button class="btn btn-ghost" data-act="keep-going" onClick=${() => done(false)}>Keep going</button>
      <button class="btn btn-danger" data-act="stop-all" onClick=${() => done(true)}><${Icon} name="stop" size=${14} />${a.verb}</button>`}>
    ${a.lead ? html`<p>${a.lead}</p>` : null}
    <p class="stop-agents-line"><strong>${agentsLine(a.names)}</strong></p>
    <p class="confirm-note">Claude Code stops every running agent of a session when its turn is stopped, and they do not come back. Helm tells Claude which ones stopped with your next message.</p>
  <//>`;
}
