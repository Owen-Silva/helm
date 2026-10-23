// Owner: lane panels (E). Exports Inspector (right-hand panel: fleet, changes, files, preview, queue, usage)
// and PANELS (tab registry the shell can render as rail buttons). Open/closed/wide state lives in ./state.js.
import { useRef, useLayoutEffect } from 'preact/hooks';
import { html, Icon, cx } from './util.js';
import { activeFleet, queue } from '../lib/store.js';
import { inspectorPanel, inspectorOpen, inspectorWide } from './state.js';
import { FleetPanel } from './fleet.js';
import { ChangesPanel } from './changes.js';
import { FilesPanel } from './files.js';
import { PreviewPanel } from './preview.js';
import { QueuePanel } from './queue.js';
import { UsagePanel, UsageMeter } from './usage.js';
import { RailwayPanel } from './railway.js';

export { UsageMeter };
export { inspectorPanel, inspectorOpen, inspectorWide, showPanel, toggleInspector } from './state.js';

// icon: name passed to Icon from ui/lib/icons.js (lane shell draws them).
export const PANELS = [
  { id: 'fleet', label: 'Agents', icon: 'fleet', component: FleetPanel },
  { id: 'changes', label: 'Changes', icon: 'changes', component: ChangesPanel },
  { id: 'files', label: 'Files', icon: 'files', component: FilesPanel },
  { id: 'preview', label: 'Preview', icon: 'preview', component: PreviewPanel },
  { id: 'queue', label: 'Queue', icon: 'queue', component: QueuePanel },
  { id: 'usage', label: 'Usage', icon: 'gauge', component: UsagePanel },
  { id: 'railway', label: 'Railway', icon: 'server', component: RailwayPanel },   // lane railway: deploy status + Redeploy/Restart
];

let previewVisited = false;

function tabBadge(id) {
  if (id === 'fleet') { const n = activeFleet.value.filter((a) => a.status === 'running').length; return n || null; }
  if (id === 'queue') { const n = queue.value.filter((j) => j.status === 'queued' || j.status === 'running').length; return n || null; }
  return null;
}

// The tab strip fits the column at the default width (panels.css). When the column is dragged narrower
// than that it scrolls sideways instead of clipping: the open tab is kept in view, a soft fade marks the
// side with more tabs (data-more), and a vertical mouse wheel scrolls it.
function useTabStrip(activeId) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const mark = () => {
      const max = el.scrollWidth - el.clientWidth;
      const more = [el.scrollLeft > 1 && 'left', el.scrollLeft < max - 1 && 'right'].filter(Boolean).join(' ');
      if (more) el.dataset.more = more; else delete el.dataset.more;
    };
    const reveal = () => {
      const tab = el.querySelector('.insp-tab.on');
      if (tab && el.scrollWidth > el.clientWidth) {
        const pad = 20;   // clear of the edge fade
        const box = el.getBoundingClientRect(), t = tab.getBoundingClientRect();
        const l = t.left - box.left + el.scrollLeft, r = l + t.width;
        if (l - pad < el.scrollLeft) el.scrollLeft = Math.max(0, l - pad);
        else if (r + pad > el.scrollLeft + el.clientWidth) el.scrollLeft = r + pad - el.clientWidth;
      }
      mark();
    };
    const wheel = (e) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY; e.preventDefault();
    };
    // the strip or any tab changing size (column dragged, open tab's label shown) re-checks the fit
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null;
    if (ro) { ro.observe(el); for (const t of el.children) ro.observe(t); }
    el.addEventListener('scroll', mark, { passive: true });
    el.addEventListener('wheel', wheel, { passive: false });
    el._reveal = reveal;
    return () => { ro?.disconnect(); el.removeEventListener('scroll', mark); el.removeEventListener('wheel', wheel); delete el._reveal; };
  }, []);
  useLayoutEffect(() => { ref.current?._reveal?.(); }, [activeId]);
  return ref;
}

export function Inspector({ panel: forced }) {
  const id = forced || inspectorPanel.value;
  const def = PANELS.find((p) => p.id === id) || PANELS[0];
  const Body = def.component;
  if (def.id === 'preview') previewVisited = true;
  const stripRef = useTabStrip(def.id);
  return html`<section class=${cx('insp', inspectorWide.value && 'insp-wide')} aria-label="Inspector">
    <header class="insp-head">
      <div class="insp-tabs" ref=${stripRef} role="tablist" aria-label="Inspector panels">
        ${PANELS.map((p) => {
          const on = p.id === def.id, badge = tabBadge(p.id);
          return html`<button key=${p.id} role="tab" aria-selected=${on} class=${cx('insp-tab', on && 'on')}
              title=${p.label} onClick=${() => { inspectorPanel.value = p.id; inspectorOpen.value = true; }}>
            <span class="insp-tab-ico"><${Icon} name=${p.icon} size=${15} />${badge != null && html`<span class="badge insp-tab-badge">${badge}</span>`}</span>
            <span class="insp-tab-label">${p.label}</span>
          </button>`;
        })}
      </div>
      <div class="insp-head-actions">
        <button class="icon-btn insp-wide-btn" aria-pressed=${inspectorWide.value}
          title=${inspectorWide.value ? 'Narrow inspector' : 'Pop out wide'} aria-label=${inspectorWide.value ? 'Narrow inspector' : 'Pop out wide'}
          onClick=${() => { inspectorWide.value = !inspectorWide.value; }}>
          <${Icon} name=${inspectorWide.value ? 'collapse' : 'expand'} size=${15} />
        </button>
        <button class="icon-btn insp-close-btn" title="Close inspector (Ctrl+\\)" aria-label="Close inspector" onClick=${() => { inspectorOpen.value = false; }}>
          <${Icon} name="close" size=${15} />
        </button>
      </div>
    </header>
    ${def.id !== 'preview' && html`<div class="insp-body" role="tabpanel" aria-label=${def.label} key=${def.id}><${Body} /></div>`}
    ${/* Preview stays mounted once opened so switching tabs doesn't reload the page inside it. */ ''}
    ${(def.id === 'preview' || previewVisited) && html`<div class="insp-body" role="tabpanel" aria-label="Preview" key="preview" hidden=${def.id !== 'preview'}><${PreviewPanel} /></div>`}
  </section>`;
}
