// Layout switch in the top strip (lane quad, 2026-10-09): 1 pane / 2 side by side / 4 corners, as a small icon
// segmented control left of Search. Desktop only: the phone never renders the strip. State and rules live in
// split.js (pane-layout.js); this is just the buttons. Owner: lane shell (C).
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { toast } from '../lib/store.js';
import { layout, narrow, setLayout, NARROW_PX } from './split.js';
import { mod } from './util.js';

const OPTS = [
  { n: 1, icon: 'layout-1', label: '1 pane', keys: '' },
  { n: 2, icon: 'layout-2', label: '2 side by side', keys: `${mod}+Shift+\\` },
  { n: 4, icon: 'layout-4', label: '4 corners', keys: `${mod}+Shift+4` },
];

export function LayoutSwitch() {
  const n = layout.value.n;
  const thin = narrow.value;
  const pick = (o) => {
    if (setLayout(o.n)) return;
    toast({ title: 'Open a second session first', body: '2 side by side needs two sessions. Start one with New session or open one from the sidebar.', ms: 4000 });
  };
  return html`<div class="seg sm layout-seg" role="group" aria-label="Layout">
    ${OPTS.map((o) => {
      const tip = o.n === 4 && thin ? `4 corners: the window is under ${NARROW_PX} px, so one row shows. Widen it for all 4.` : `${o.label}${o.keys ? `  ${o.keys}` : ''}`;
      return html`<button type="button" key=${o.n} aria-pressed=${n === o.n ? 'true' : 'false'} aria-label=${`Layout: ${o.label}`}
        data-tip=${tip} data-tip-pos="bottom" data-layout=${o.n} onClick=${() => pick(o)}>
        <${Icon} name=${o.icon} size=${15} stroke=${1.6} />
        ${o.n === 4 && n === 4 && thin ? html`<span class="layout-seg-note" aria-hidden="true"></span>` : null}
      </button>`;
    })}
  </div>`;
}
