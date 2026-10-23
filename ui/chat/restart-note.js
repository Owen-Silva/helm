// The restart note card (lane restart): at the end of a conversation that the last Helm restart (or quit) cut
// off. Model + words: ui/lib/restart-note.js. Continue = sessions.continueAfterRestart; Dismiss =
// sessions.dismissRestartNote. Any message the user sends to the session also clears it (the engine tells Claude
// what stopped with that message, the same <helm-note> as an explicit Stop).
import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { rpc, toast } from '../lib/store.js';
import { restartNoteModel, continueHint, RESTART_NOTE_SHOWN } from '../lib/restart-note.js';
import { fmtTime } from './util.js';

export function RestartNote({ s }) {
  const [busy, setBusy] = useState(null); // null | 'continue' | 'dismiss'
  const [all, setAll] = useState(false);
  const note = s && s.restartNote;
  const m = restartNoteModel(note, fmtTime);
  if (!m) return null;
  const live = s.status === 'working' || s.status === 'waiting';
  const shown = all ? m.items : m.items.slice(0, RESTART_NOTE_SHOWN);
  const hidden = m.items.length - shown.length;
  const act = async (kind) => {
    setBusy(kind);
    try {
      if (kind === 'continue') {
        const r = await rpc('sessions.continueAfterRestart', { id: s.id });
        if (r && r.action !== 'continued') toast({ title: 'Nothing was sent', body: r.message });
      } else await rpc('sessions.dismissRestartNote', { id: s.id });
    } catch (e) {
      toast({ title: kind === 'continue' ? 'Could not continue' : 'Could not dismiss', error: e, kind: 'error' });
    } finally { setBusy(null); }
  };
  return html`<section class="restart-note" role="region" aria-label=${m.headline} data-at=${note.at}>
    <div class="rn-head">
      <span class="rn-glyph" aria-hidden="true"><${Icon} name="refresh" size=${15} /></span>
      <div class="rn-text">
        <div class="rn-title">${m.headline}</div>
        ${m.facts.length ? html`<div class="rn-facts">${m.facts.join(' · ')}</div>` : null}
      </div>
    </div>
    ${shown.length ? html`<ul class="rn-list" aria-label="What stopped">
      ${shown.map((x) => html`<li class="rn-row" data-kind=${x.kind}>
        <span class="rn-dot" aria-hidden="true"></span>
        <span class="rn-name" title=${x.name}>${x.name}</span>
        ${x.tag ? html`<span class="rn-tag">${x.tag}</span>` : null}
        <span class="rn-kind">${x.kind === 'agent' ? 'Agent' : 'Task'}${x.id ? html` · <span class="mono" title=${`Agent id ${x.id}`}>${x.id.slice(0, 7)}</span>` : null}</span>
      </li>`)}
      ${hidden > 0 ? html`<li class="rn-more"><button type="button" class="rn-link" onClick=${() => setAll(true)}>Show all ${m.items.length}</button></li>` : null}
      ${m.more > 0 && (all || hidden <= 0) ? html`<li class="rn-more muted">and ${m.more} more not listed</li>` : null}
    </ul>` : null}
    <div class="rn-actions">
      <button type="button" class="btn sm btn-primary" data-act="restart-continue" onClick=${() => act('continue')} disabled=${!!busy || live}
        title=${live ? 'This session is working again' : continueHint(note)}>
        ${busy === 'continue' ? html`<span class="spinner sm" aria-hidden="true"></span>` : html`<${Icon} name="play" size=${13} />`}Continue</button>
      <button type="button" class="btn sm btn-ghost" data-act="restart-dismiss" onClick=${() => act('dismiss')} disabled=${!!busy}>Dismiss</button>
      <span class="rn-hint">${live ? 'Working again' : continueHint(note)}</span>
    </div>
  </section>`;
}
