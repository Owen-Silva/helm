// Sidebar "Past": every session that is not active (ui/lib/session-activity.js has the rule).
// Helm's own idle sessions and the user's old terminal sessions (history.search, the same index as the
// History view), newest first, grouped by day. Collapsed by default; searchable and paged when open
// (thousands of transcripts: never load them all). Owner: lane sessions.
// Days, not projects: when hunting an old session "when" is what the user remembers first, the search box
// covers the project, and day buckets stay put as older pages load (they only append at the bottom),
// where project groups would keep growing and reshuffling.
import { signal, effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { on } from '../lib/transport.js';
import { rpc, ready, sessions, externalSessions, externalView } from '../lib/store.js';
import { mergePast, groupByDay, matchesQuery } from '../lib/session-activity.js';
import { sessionSplit, minuteTick, pastTerminal } from './activity.js';
import { openExternal } from './elsewhere.js';
import { askDelete } from './session-actions.js';
import { view } from './state.js';
import { cx, ago } from './util.js';

const PAGE = 40;
const REFRESH_MS = 2 * 60 * 1000;

function load(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
export const pastOpen = signal(load('helm.past.open', false) === true);
effect(() => { const v = pastOpen.value; try { localStorage.setItem('helm.past.open', JSON.stringify(v)); } catch {} });
export const pastQuery = signal('');
const focusSearch = signal(0);

// Open Past with a search (the sidebar's "No sessions match" offers it).
export function searchPast(q) {
  pastQuery.value = String(q || '');
  pastOpen.value = true;
  focusSearch.value++;
}

// ---- history.search pages ----
// { q, limit, rows, hasMore, loading, error, loaded }. One page = PAGE more rows: the request asks for
// limit + 1 so hasMore is exact without a count.
const hist = signal({ q: '', limit: PAGE, rows: [], hasMore: false, loading: false, error: null, loaded: false });
let seq = 0;
let lastFetchAt = 0;
function fetchHistory(q = hist.peek().q, limit = hist.peek().limit) {
  const n = ++seq;
  lastFetchAt = Date.now();
  hist.value = { ...hist.peek(), loading: true, error: null };
  return rpc('history.search', { q, limit: limit + 1 }).then((list) => {
    if (n !== seq) return;
    const rows = Array.isArray(list) ? list : [];
    hist.value = { q, limit, rows: rows.slice(0, limit), hasMore: rows.length > limit, loading: false, error: null, loaded: true };
    const m = new Map(pastTerminal.peek());
    for (const h of rows) if (h && h.claudeSessionId) m.set(h.claudeSessionId, h);
    if (m.size > 3000) for (const k of [...m.keys()].slice(0, m.size - 3000)) m.delete(k);
    pastTerminal.value = m;
  }).catch((e) => {
    if (n !== seq) return;
    hist.value = { ...hist.peek(), q, limit, loading: false, error: e?.message || String(e) };
  });
}
// One quiet first page shortly after start, so the collapsed header has a count; again on reconnect.
let prefetched = false;
effect(() => { if (ready.value && !prefetched) { prefetched = true; setTimeout(() => { if (!hist.peek().loaded) fetchHistory('', PAGE); }, 3000); } });
on('transport.open', () => { if (hist.peek().loaded) fetchHistory(); });

function TermRow({ h, at }) {
  const on = externalView.value === h.claudeSessionId && view.value === 'session';
  const open = () => openExternal(h.claudeSessionId);
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  return html`<div class=${cx('srow ext-row past-row', on && 'on')} role="button" tabindex="0" aria-current=${on ? 'true' : undefined}
      onClick=${open} onKeyDown=${onKey} data-csid=${h.claudeSessionId}
      title=${`${h.title || 'Untitled'}\n${h.cwd || ''}\nTerminal session · read only until you continue it in Helm`}>
    <span class="dot idle" aria-label="Terminal session"></span>
    <div class="srow-text">
      <div class="srow-title"><${Icon} name="terminal" size=${11} class="srow-pin" title="From a terminal" /><span class="truncate">${h.title || 'Untitled'}</span></div>
      <div class="srow-sub truncate">${h.project || h.cwd || ''}</div>
    </div>
    <div class="srow-meta"><span class="srow-time tnum">${ago(at)}</span></div>
  </div>`;
}

function SearchBox() {
  const ref = useRef(null);
  useEffect(() => { if (focusSearch.value) requestAnimationFrame(() => { ref.current?.focus(); ref.current?.scrollIntoView({ block: 'nearest' }); }); }, [focusSearch.value]);
  const q = pastQuery.value;
  return html`<label class="sfilter-box past-search">
    <${Icon} name="search" size=${13} class="sfilter-icon" />
    <input ref=${ref} type="search" class="sfilter-input" placeholder="Search past sessions" autocomplete="off" spellcheck="false"
      aria-label="Search past sessions by title, prompt, project or folder" value=${q}
      onInput=${(e) => { pastQuery.value = e.currentTarget.value; }}
      onKeyDown=${(e) => { if (e.key === 'Escape' && pastQuery.value) { e.preventDefault(); e.stopPropagation(); pastQuery.value = ''; } }} />
    ${q && html`<button class="icon-btn xs sfilter-clear" aria-label="Clear search" onClick=${() => { pastQuery.value = ''; ref.current?.focus(); }}><${Icon} name="x" size=${12} /></button>`}
  </label>`;
}

// Loads the next page when "Show older" scrolls into view (and on click).
// One observer for the button's life (the latest onMore through a ref): re-observing on every render
// would fire again each time the sidebar re-renders while the button is in view.
function MoreButton({ onMore, busy }) {
  const ref = useRef(null);
  const fn = useRef(onMore);
  fn.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) fn.current(); }, { root: el.closest('.sidebar-scroll'), rootMargin: '80px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return html`<button ref=${ref} class="sidebar-suggest past-more" data-act="past-more" onClick=${onMore} disabled=${busy}>${busy ? 'Loading…' : 'Show older'}</button>`;
}

// Row: the sidebar's SessionRow (passed in to avoid an import cycle). query: the sidebar filter's text,
// which drives Past while set (forced open, own box hidden). archived: the Archived group, shown last.
export function PastSection({ Row, query = '', archived = null }) {
  const forced = !!query;
  const open = forced || pastOpen.value;
  const q = (forced ? query : pastQuery.value).trim();
  const h = hist.value;
  const split = sessionSplit.value;

  // fetch: on open, on a new query (debounced), and every couple of minutes while open and visible
  useEffect(() => {
    if (!open) return;
    const cur = hist.peek();
    if (cur.q === q && cur.loaded && Date.now() - lastFetchAt < REFRESH_MS) return;
    const t = setTimeout(() => fetchHistory(q, cur.q === q ? cur.limit : PAGE), cur.q === q ? 0 : 200);
    return () => clearTimeout(t);
  }, [open, q]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => { if (!document.hidden && !hist.peek().loading) fetchHistory(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [open]);

  // While a new query is in flight, keep the last page filtered locally instead of flashing empty.
  const same = h.q === q;
  const history = same ? h.rows : h.rows.filter((x) => matchesQuery([x.title, x.firstPrompt, x.project, x.cwd], q));
  const rows = mergePast({ helm: split.past, history, external: externalSessions.value, allSessions: sessions.value,
    q, historyHasMore: same && h.hasMore });
  const more = same && h.hasMore;
  const count = `${rows.length}${more ? '+' : ''}`;
  const onMore = () => { const c = hist.peek(); if (!c.loading && c.hasMore && c.q === q) fetchHistory(q, c.limit + PAGE); };
  const empty = split.empty;
  const label = forced ? 'Past sessions matching the filter' : 'Sessions not active in the last hour, and terminal sessions';

  return html`<section class=${cx('sgroup sgroup-elsewhere sgroup-past', !open && 'collapsed')} aria-label="Past sessions">
    <div class="sgroup-head">
      <button class="sgroup-toggle" aria-expanded=${open} onClick=${() => { if (!forced) pastOpen.value = !pastOpen.value; }} title=${label}>
        <${Icon} name="chevron-right" size=${12} class="sgroup-chev" />
        <span class="sgroup-name truncate">Past</span>
        ${(h.loaded || rows.length > 0) && html`<span class="sgroup-count tnum">${count}</span>`}
      </button>
    </div>
    ${open && html`<div class="past-body">
      ${!forced && html`<${SearchBox} />`}
      ${groupByDay(rows, minuteTick.value).map((g) => html`<div class="past-group" key=${g.label}>
        <div class="past-day">${g.label}</div>
        <div class="sgroup-list">${g.rows.map((r) => (r.kind === 'helm'
          ? html`<${Row} key=${r.key} s=${r.s} inPast=${true} at=${r.at} />`
          : html`<${TermRow} key=${r.key} h=${r.h} at=${r.at} />`))}</div>
      </div>`)}
      ${h.error && html`<div class="sgroup-empty past-note">Could not load terminal sessions. <button class="btn btn-sm btn-ghost past-retry" onClick=${() => fetchHistory(q)}>Retry</button></div>`}
      ${!rows.length && !h.error && html`<div class="sgroup-empty past-note">${h.loading || !h.loaded ? 'Loading…' : q ? 'No past sessions match.' : 'No past sessions.'}</div>`}
      ${more && html`<${MoreButton} onMore=${onMore} busy=${h.loading} />`}
      ${!q && empty.length > 0 && html`<button class="sidebar-suggest past-empty" data-act="delete-empty" onClick=${() => askDelete(empty.map((s) => s.id))}
        title="Sessions that never got a message. They are hidden from both lists.">
        ${empty.length} empty ${empty.length === 1 ? 'session' : 'sessions'} · Delete ${empty.length === 1 ? 'it' : 'them'}</button>`}
      ${(forced || !q) && archived}
    </div>`}
  </section>`;
}
