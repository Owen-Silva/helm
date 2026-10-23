// Rewound messages. After a conversation rewind (Changes panel or "Rewind to here"), Claude no
// longer sees the prompt it rewound to or anything after it, but Helm still has those items. The
// engine's marker (a system/info item carrying `rewind: { fromItemId, conversation }`, see
// PROTOCOL.md) names where the forgotten part starts; it ends at the marker. Those units fold into
// one calm, collapsed "N messages rewound · show" row and render dimmed when opened.
// Owner: lane fixes. Hooked into ui/chat/index.js (build() → foldRewound, Unit → RewoundGroup).
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { isOpen, toggle } from './state.js';
import { plural } from './util.js';

const isMarker = (it) => it && it.type === 'system' && it.rewind && it.rewind.conversation && it.rewind.fromItemId;

// Item ids Claude no longer sees, from every conversation-rewind marker in `items`.
// `older`: the history has older pages not loaded yet, so a marker whose prompt is not loaded folds
// from the top (its prompt is further up; after a restart the marker can arrive before that page).
export function rewoundIds(items, older = false) {
  const out = new Set();
  if (!Array.isArray(items) || !items.some(isMarker)) return out;
  const at = new Map(items.map((it, i) => [it.id, i]));
  items.forEach((m, mi) => {
    if (!isMarker(m)) return;
    let from = at.get(m.rewind.fromItemId);
    if (from == null && older) from = 0;
    if (from == null || from >= mi) return;
    for (let i = from; i < mi; i++) out.add(items[i].id);
  });
  return out;
}

const unitIds = (u) => (u.kind === 'group' ? u.items.map((i) => i.id) : u.item ? [u.item.id] : []);
const unitItems = (u) => (u.kind === 'group' ? u.items : u.item ? [u.item] : []);

// Fold runs of units whose items are all rewound into { kind: 'rewound', id, units, messages, steps }.
// `items` is the session's full item list (the markers may sit outside the visible window).
export function foldRewound(units, items, older = false) {
  const gone = rewoundIds(items, older);
  if (!gone.size) return units;
  const out = [];
  let run = null;
  const flush = () => { if (run) { out.push(run); run = null; } };
  for (const u of units) {
    const ids = unitIds(u);
    if (ids.length && ids.every((id) => gone.has(id))) {
      if (!run) run = { kind: 'rewound', id: 'rw-' + ids[0], units: [], messages: 0, steps: 0 };
      run.units.push(u);
      for (const it of unitItems(u)) {
        if (it.type === 'user' || it.type === 'assistant') run.messages++;
        else run.steps++;
      }
    } else {
      flush();
      out.push(u);
    }
  }
  flush();
  return out;
}

export function rewoundLabel(u) {
  return u.messages ? plural(u.messages, 'message') : plural(u.steps || u.units.length, 'step');
}

// `renderUnit(unit)` renders one inner unit the way the transcript normally does.
export function RewoundGroup({ u, sid, renderUnit }) {
  const key = `${sid}:${u.id}`;
  const open = isOpen(key, false);
  return html`<div class=${'rewound' + (open ? ' open' : '')} data-rewound=${u.units.length}>
    <button type="button" class="rewound-head" aria-expanded=${open} onClick=${() => toggle(key, false)}
      title="Claude no longer sees these: the conversation was rewound to before them">
      <span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>
      <${Icon} name="rewind" size=${13} />
      <span>${rewoundLabel(u)} rewound</span>
      <span class="rewound-act">· ${open ? 'hide' : 'show'}</span>
    </button>
    ${open ? html`<div class="rewound-body" aria-label="Rewound messages">${u.units.map((x) => renderUnit(x))}</div>` : null}
  </div>`;
}
