// ETA (session.eta from the user's eta mod). Owner: lane shell (C).
// One shared clock that ticks at most every 30 s, and only while some session (Helm or terminal) is working
// with an ETA; nothing runs when everything is idle.
import { signal, computed, effect } from '@preact/signals';
import { html } from '../lib/html.js';
import { sessions, externalSessions } from '../lib/store.js';
import { cx } from './util.js';
import { etaInfo as etaInfoAt, ETA_BASIS } from '../lib/eta-info.js';
export { ETA_BASIS };

export const etaNow = signal(Date.now());
const anyLive = computed(() => sessions.value.some((s) => s.status === 'working' && s.eta?.etaAt)
  || externalSessions.value.some((x) => x.active && x.eta?.state === 'working' && x.eta?.etaAt));
let timer = 0;
effect(() => {
  const live = anyLive.value;
  if (live && !timer) { etaNow.value = Date.now(); timer = setInterval(() => { etaNow.value = Date.now(); }, 30_000); }
  else if (!live && timer) { clearInterval(timer); timer = 0; }
});

// null unless the session is working and the mod gave an ETA (ui/lib/eta-info.js). Reads the 30 s tick so callers
// re-render, and uses the real time.
export function etaInfo(eta, working, now = (etaNow.value, Date.now())) {
  return etaInfoAt(eta, working, now);
}

// Header phrase: "~14 min left · step 2/4" (or "over by 3m" in the warning tone). The clock time ("done 4:32")
// lives in the tooltip, and in the text for screen readers. The session header builds its own pieces from
// etaInfo (header.js); this one serves the terminal-session header (elsewhere.js).
export function EtaLine({ eta, working }) {
  const e = etaInfo(eta, working);
  if (!e) return null;
  return html`<span class=${cx('sh-eta tnum', e.over && 'over')} title=${e.title}>
    <span class="sh-eta-left">${e.long}</span>${e.step ? html`<span class="sh-eta-dim"> · ${e.step}</span>` : null}${!e.over && e.done ? html`<span class="sr-only">, done ${e.done}</span>` : null}
  </span>`;
}

// Sidebar: compact "~14m" next to the status.
export function EtaChip({ eta, working }) {
  const e = etaInfo(eta, working);
  if (!e) return null;
  return html`<span class=${cx('srow-eta tnum', e.over && 'over')} title=${`${e.over ? e.long : `${e.long}, done ${e.done}`}${e.step ? ` · ${e.step}` : ''}\n${e.basis}`}>${e.short}</span>`;
}
