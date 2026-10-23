// @file and /command autocomplete list, floating above the composer card. Owner: lane composer.
import { html } from '../lib/html.js';
import { useRef, useEffect } from 'preact/hooks';

function fileRow(it) {
  const i = it.rel.lastIndexOf('/');
  const base = i >= 0 ? it.rel.slice(i + 1) : it.rel;
  const dir = i >= 0 ? it.rel.slice(0, i) : '';
  return html`<span class="cmp-ac-main">${base}</span>${dir && html`<span class="cmp-ac-dim">${dir}</span>`}`;
}

function cmdRow(it) {
  return html`<span class="cmp-ac-main">/${it.name}</span>
    ${it.argumentHint && html`<span class="cmp-ac-hint">${it.argumentHint}</span>`}
    ${it.description && html`<span class="cmp-ac-dim cmp-ac-desc">${it.description}</span>`}`;
}

export function AutoMenu({ menu, onPick, onHover }) {
  const ref = useRef(null);
  const active = menu?.active ?? -1;
  useEffect(() => {
    const row = ref.current?.querySelector('.cmp-ac-row.active');
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, menu?.items]);
  if (!menu) return null;
  const { kind, items } = menu;
  const empty = items == null ? 'Searching…' : !items.length ? (kind === 'file' ? 'No matching files' : 'No matching commands') : null;
  return html`<div class=${'menu cmp-ac cmp-ac-' + kind} ref=${ref} id="cmp-ac" role="listbox"
      aria-label=${kind === 'file' ? 'Files' : 'Commands'} onMouseDown=${(e) => e.preventDefault()}>
    ${empty
      ? html`<div class="cmp-pop-empty">${empty}</div>`
      : items.map((it, i) => html`<div key=${kind + (it.rel || it.name)} id=${'cmp-ac-' + i} role="option" aria-selected=${i === active ? 'true' : 'false'}
          class=${'menu-item cmp-ac-row' + (i === active ? ' active' : '')}
          onMouseMove=${() => { if (i !== active) onHover(i); }} onClick=${() => onPick(i)}>
          ${kind === 'file' ? fileRow(it) : cmdRow(it)}
        </div>`)}
  </div>`;
}
