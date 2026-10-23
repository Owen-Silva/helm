// Resume for a stalled session (lane stall, 2026-10-09). Shown in the session header only while the session is
// stalled (Session.stalledSince: a turn is active and Claude Code has sent nothing for 10+ min). Never automatic:
// The user confirms first, and the result is shown as a toast. The engine (main/engine/stall.js resumeStalled)
// refuses if the turn started streaming again in the meantime.
import { useState } from 'preact/hooks';
import { html } from './html.js';
import { Icon } from './icons.js';
import { rpc, toast } from './store.js';
import { Modal } from '../shell/util.js';
import { RESUME_PROMPT } from './stall-limits.js';
import { runningAgentNames, agentsLine, confirmAgentsThen } from './stop.js'; // lane steer: name the agents it stops

export function StallResume({ s, stall, compact = false }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!s || !stall) return null;
  const close = () => setAsking(false);
  const go = async () => {
    setAsking(false);
    setBusy(true);
    try {
      // The modal named the running agents, so Resume carries stopAgents; one the engine still finds (started
      // since) gets the shared named-agents confirm.
      const named = runningAgentNames(s.id).length > 0;
      const c = await confirmAgentsThen((all) => rpc('sessions.resumeStalled', { id: s.id, ...(all || named ? { stopAgents: true } : {}) }), { title: 'Resume this stalled session?', verb: 'Stop them and resume' });
      if (!c.ok) { toast({ title: 'Nothing changed', body: 'The stalled turn and its agents were left running.' }); return; }
      const r = c.result;
      if (r && r.action === 'continued') toast({ title: r.restarted ? 'Restarted and resumed' : 'Resumed', body: r.message });
      else if (r && r.action === 'none') toast({ title: 'Nothing to resume', body: r.message });
      else toast({ title: 'Could not resume', body: (r && r.message) || 'No answer from the engine.', kind: 'error' });
    } catch (e) {
      toast({ title: 'Could not resume', error: e, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return html`<button type="button" class="btn btn-ghost btn-sm sh-resume" data-act="resume-stalled" disabled=${busy} aria-label="Resume this stalled session"
      title=${`${stall.text}: Claude Code has sent nothing for ${stall.text.replace(/^Stalled · /, '')}. Stop the hung turn and ask Claude to continue (asks first).`}
      onClick=${(e) => { e.stopPropagation(); setAsking(true); }}>
      <${Icon} name="play" size=${12} />${compact ? null : html`<span>${busy ? 'Resuming…' : 'Resume'}</span>`}
    </button>
    ${asking && html`<${Modal} title="Resume this stalled session?" onClose=${close} width=${460} class="confirm-modal stall-confirm"
      footer=${html`<button class="btn btn-ghost" onClick=${close}>Cancel</button>
        <button class="btn btn-primary" data-act="confirm-resume" onClick=${go}><${Icon} name="play" size=${14} />Resume</button>`}>
      <p class="stall-lead"><strong>${s.title || 'New session'}</strong> has been working with no word from Claude Code for ${stall.text.replace(/^Stalled · /, '')}. The stream is probably hung.</p>
      <ol class="stall-steps">
        <li>Stop the hung turn, the same as the Stop button.</li>
        <li>If Claude Code does not answer within a few seconds, restart it on this same conversation.</li>
        <li>Send <q>${RESUME_PROMPT}</q> as a new message, marked as sent by Helm.</li>
      </ol>
      ${runningAgentNames(s.id).length ? html`<p class="stop-agents-line"><strong>${agentsLine(runningAgentNames(s.id)).replace(/^Stop/, 'Resume')}</strong>. Helm tells Claude which ones stopped.</p>` : null}
      <p class="confirm-note">Background agents of this session stop with the turn. Whatever step was mid-way is not redone automatically; Claude picks up from the conversation.</p>
    <//>`}`;
}
