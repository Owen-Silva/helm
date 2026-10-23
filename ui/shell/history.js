// History: search past Claude Code sessions on disk and resume one. Owner: lane shell (C).
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { rpc, createSession, toast, sessions } from '../lib/store.js';
import { openSession, view, phoneScreen } from './state.js';
import { cx, agoLong, fmtBytes, debounce, useTick } from './util.js';

// includeTemp: sessions whose folder is under the OS temp dir (scratch runs, tests) are hidden unless asked for.
export function useHistory(q, limit = 50, includeTemp = false) {
  const [state, setState] = useState({ loading: true, rows: [], error: null });
  const seq = useRef(0);
  const temp = useRef(includeTemp);
  temp.current = includeTemp;
  const run = useMemo(() => debounce((query) => {
    const n = ++seq.current;
    rpc('history.search', { q: query, limit, ...(temp.current ? { includeTemp: true } : {}) })
      .then((rows) => { if (n === seq.current) setState({ loading: false, rows: rows || [], error: null }); })
      .catch((e) => { if (n === seq.current) setState({ loading: false, rows: [], error: e.message || String(e) }); });
  }, 180), []);
  useEffect(() => { setState((s) => ({ ...s, loading: true })); run(q.trim()); }, [q, includeTemp]);
  return state;
}

export async function resume(h) {
  const open = h.helmSessionId && sessions.value.find((s) => s.id === h.helmSessionId);
  if (open) { openSession(open.id); return; }
  try {
    await createSession({ cwd: h.cwd, resumeClaudeSessionId: h.claudeSessionId });
    view.value = 'session'; phoneScreen.value = 'session';
  } catch (e) { toast({ title: 'Could not resume session', error: e, kind: 'error' }); }
}

export function HistoryRow({ h, compact }) {
  const [busy, setBusy] = useState(false);
  const open = h.helmSessionId && sessions.value.some((s) => s.id === h.helmSessionId);
  const go = async () => { setBusy(true); await resume(h); setBusy(false); };
  return html`<button class=${cx('hrow', compact && 'compact')} onClick=${go} disabled=${busy} title=${h.cwd}>
    <span class="hrow-icon"><${Icon} name="history" size=${16} /></span>
    <span class="hrow-text">
      <span class="hrow-title truncate">${h.title || h.firstPrompt || 'Untitled session'}</span>
      ${!compact && h.firstPrompt && h.firstPrompt !== h.title && html`<span class="hrow-prompt truncate">${h.firstPrompt}</span>`}
      <span class="hrow-meta">
        <span class="hrow-proj">${h.project}</span>
        <span class="sep">·</span><span>${agoLong(h.lastActivity)}</span>
        ${h.messageCount != null && html`<span class="sep">·</span><span class="tnum">${h.messageCount} messages</span>`}
        ${!compact && h.sizeBytes != null && html`<span class="sep">·</span><span class="tnum">${fmtBytes(h.sizeBytes)}</span>`}
      </span>
    </span>
    <span class="hrow-go">${busy ? html`<span class="spinner sm"></span>` : open ? html`<span class="chip">Open</span>` : html`<span class="hrow-resume">Resume<${Icon} name="arrow-right" size=${14} /></span>`}</span>
  </button>`;
}

export function HistoryView() {
  useTick(60000);
  const [q, setQ] = useState('');
  const [withTemp, setWithTemp] = useState(() => { try { return localStorage.getItem('helm.history.temp') === '1'; } catch { return false; } });
  const input = useRef(null);
  const { loading, rows, error } = useHistory(q, 50, withTemp);
  const toggleTemp = () => { const v = !withTemp; setWithTemp(v); try { localStorage.setItem('helm.history.temp', v ? '1' : '0'); } catch {} };
  useEffect(() => { input.current?.focus(); }, []);
  return html`<section class="view view-history" aria-label="History">
    <header class="view-head">
      <div>
        <h1 class="view-title">History</h1>
        <p class="view-sub">Every Claude Code session on this PC. Resume one to pick up where it left off.</p>
      </div>
    </header>
    <div class="view-search">
      <${Icon} name="search" size=${16} />
      <input ref=${input} class="view-search-input" type="search" value=${q} placeholder="Search by title, prompt or project"
        aria-label="Search history" onInput=${(e) => setQ(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
      ${loading && html`<span class="spinner sm"></span>`}
      <button class=${cx('chip', 'hist-temp', withTemp && 'on')} aria-pressed=${withTemp} onClick=${toggleTemp}
        title="Also list sessions whose folder is in the temp directory (scratch and test runs)">
        <${Icon} name=${withTemp ? 'check' : 'folder'} size=${13} /><span class="hist-temp-l">Include temp folders</span><span class="hist-temp-s">Temp</span></button>
    </div>
    <div class="view-scroll">
      ${error
        ? html`<div class="state-note"><${Icon} name="alert" size=${18} /><div><strong>History search failed</strong><p>${error}</p></div></div>`
        : !loading && !rows.length
          ? html`<div class="state-note"><${Icon} name="search" size=${18} /><div><strong>${q ? 'No matches' : 'No past sessions found'}</strong><p>${q ? `Nothing matches “${q}”.` : 'Sessions appear here once Claude Code has run on this PC.'}</p></div></div>`
          : html`<div class="hlist">${rows.map((h) => html`<${HistoryRow} key=${h.claudeSessionId} h=${h} />`)}</div>`}
    </div>
  </section>`;
}
