// Home chip: one quiet line of Railway deploy status ("Railway · all live", amber "Railway · storefront
// building", red "Railway · api failed"). Clicking it opens the Railway panel: the inspector tab on
// the desktop when a session is open (that is where the right-hand panel lives), otherwise the same
// panel in a dialog (phone, or no session). Styles: ./railway-chip.css (loaded via panels.css).
// Mounted from home.js by the main session:
//   import { RailwayChip } from './railway-chip.js';
//   <${RailwayChip} />            (inside .home-glance, after <${ActiveToday} />)
// Owner: lane railway.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { cx, Modal } from '../panels/util.js';
import { showPanel } from '../panels/state.js';
import { RailwayPanel } from '../panels/railway.js';
import { railwayState, railwayRpcError, useRailwayWatch } from '../lib/railway.js';
import { chipSummary } from '../lib/railway-model.js';
import { activeSession, externalView } from '../lib/store.js';
import { go, isPhone } from './state.js';

// true when the inspector tab could be shown; false means the caller shows its own dialog.
export function openRailwayPanel() {
  showPanel('railway');
  if (isPhone.value || !activeSession.value || externalView.value) return false;
  go('session');
  return true;
}

export function RailwayChip() {
  useRailwayWatch('chip');
  const [dialog, setDialog] = useState(false);
  const s = chipSummary(railwayState.value, Date.now(), railwayRpcError.value);
  if (s.hidden) return null;
  const rest = s.text.replace(/^Railway · /, '');
  return html`<span class="rw-chip-wrap" role="listitem">
    <button type="button" class=${cx('hchip', 'rw-chip', `rw-${s.tone}`)} title=${s.title || ''} data-act="railway-chip"
      aria-label=${`${s.text}. Open the Railway panel`} onClick=${() => { if (!openRailwayPanel()) setDialog(true); }}>
      ${(s.tone === 'busy' || s.tone === 'bad' || s.tone === 'error') && html`<span class="rw-chip-dot" aria-hidden="true"></span>`}
      <span class="hchip-k">Railway</span><span class="rw-chip-v">${rest}</span>
    </button>
    ${dialog && html`<${Modal} title="Railway" onClose=${() => setDialog(false)}><div class="rw-chip-sheet"><${RailwayPanel} /></div><//>`}
  </span>`;
}
