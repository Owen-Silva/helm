// Owner: lane panels (E). Changes panel: files this session changed (with diffs) + checkpoints (rewind).
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { structuredPatch, diffWords } from 'diff';
import { html, Icon, cx, fmtAgo, fmtWhen, basename, useNow, Loading, Empty, ErrorState, SectionHead, Modal } from './util.js';
import { activeSession, activeItems, rpc } from '../lib/store.js';
import { on } from '../lib/transport.js';
import { commentsFor, addComment, updateComment, removeComment, askAbout, selectionFields, rowKey, rangeText, CommentEditor, CommentCard, ReviewBar } from './review.js';

// ---------- shared helpers (files.js imports these too) ----------

// Like util's useAsync, but a refresh keeps the current data on screen (no loading flash on live updates).
// A deps change starts over from a loading state.
export function useLiveLoad(fn, deps) {
  const [st, setSt] = useState({ data: undefined, error: null, loading: true, refreshing: false });
  const seq = useRef(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  const load = useCallback((soft) => {
    const my = ++seq.current;
    setSt((s) => (soft && s.data !== undefined ? { ...s, refreshing: true } : { data: undefined, error: null, loading: true, refreshing: false }));
    Promise.resolve().then(() => fnRef.current()).then(
      (data) => { if (my === seq.current) setSt({ data, error: null, loading: false, refreshing: false }); },
      (error) => { if (my === seq.current) setSt({ data: undefined, error, loading: false, refreshing: false }); },
    );
  }, []);
  useEffect(() => { load(false); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, reload: () => load(false), refresh: () => load(true) };
}

// Stable trigger that runs the latest `fn` once, `ms` after the last call.
export function useDebounced(fn, ms) {
  const ref = useRef(fn); ref.current = fn;
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  return useCallback(() => { clearTimeout(t.current); t.current = setTimeout(() => ref.current(), ms); }, [ms]);
}

// Path keys for comparing Windows / POSIX paths: forward slashes, lower case, no trailing slash.
export const pathKey = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// `p` relative to `cwd` (display only), with forward slashes.
export function relTo(cwd, p) {
  const fp = String(p || '').replace(/\\/g, '/');
  const base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && fp.toLowerCase().startsWith(base.toLowerCase() + '/')) return fp.slice(base.length + 1);
  return fp;
}

// "src/middleware/" + "auth.js", with the directory dimmed and squeezed first when space runs out.
export function PathLabel({ rel, title }) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  const dir = i >= 0 ? s.slice(0, i + 1) : '';
  const base = i >= 0 ? s.slice(i + 1) : s;
  return html`<span class="pn-ch-path" title=${title || s}>${dir && html`<span class="pn-ch-path-dir">${dir}</span>`}<span class="pn-ch-path-base">${base}</span></span>`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---------- diff model ----------

const MAX_DIFF_CHARS = 2_000_000;

// Word-level marks inside paired -/+ lines, only where the lines still share most of their text.
function markWords(rows) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== 'del') { i++; continue; }
    const dels = []; const adds = [];
    while (i < rows.length && rows[i].t === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === 'add') adds.push(rows[i++]);
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const a = dels[k]; const b = adds[k];
      if (a.text.length > 400 || b.text.length > 400) continue;
      const parts = diffWords(a.text, b.text);
      const same = parts.filter((p) => !p.added && !p.removed).reduce((s, p) => s + p.value.trim().length, 0);
      if (same < 0.35 * Math.max(a.text.trim().length, b.text.trim().length)) continue;
      a.parts = parts.filter((p) => !p.added).map((p) => ({ v: p.value, hl: !!p.removed }));
      b.parts = parts.filter((p) => !p.removed).map((p) => ({ v: p.value, hl: !!p.added }));
    }
  }
}

function buildHunks(before, after) {
  const p = structuredPatch('a', 'b', before ?? '', after ?? '', '', '', { context: 3 });
  return p.hunks.map((h) => {
    const rows = [];
    let o = h.oldStart; let n = h.newStart;
    for (const l of h.lines) {
      const c = l[0]; const text = l.slice(1);
      if (c === ' ') rows.push({ t: 'ctx', o: o++, n: n++, text });
      else if (c === '-') rows.push({ t: 'del', o: o++, n: null, text });
      else if (c === '+') rows.push({ t: 'add', o: null, n: n++, text });
      // '\ No newline at end of file' markers are dropped
    }
    markWords(rows);
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, rows };
  });
}

// Side-by-side rows: context on both sides, del/add runs paired, blank filler for the shorter run.
function pairRows(rows) {
  const out = []; let i = 0;
  while (i < rows.length) {
    if (rows[i].t === 'ctx') { out.push([rows[i], rows[i]]); i++; continue; }
    const dels = []; const adds = [];
    while (i < rows.length && rows[i].t === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === 'add') adds.push(rows[i++]);
    if (!dels.length && !adds.length) { i++; continue; }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push([dels[k] || null, adds[k] || null]);
  }
  return out;
}

const LineText = ({ row }) => (row.parts
  ? row.parts.map((p) => (p.hl ? html`<mark class="pn-ch-w">${p.v}</mark>` : p.v))
  : row.text);

const SIGN = { add: '+', del: '−', ctx: ' ' };

// ---------- diff renderers (with the review layer) ----------
// Review cards and the comment editor sit between rows at full width, so a diff renders as a stack of
// segments (each: gutter + horizontally scrolling code), split wherever a card goes. Horizontal scroll
// stays in sync across segments (per side in side-by-side). Clicks are delegated: rows carry data-h/data-r.

function useScrollSync(ref) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const onScroll = (e) => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('pn-ch-scroll')) return;
      const side = t.dataset.side || '';
      for (const el of root.querySelectorAll('.pn-ch-scroll')) {
        if (el !== t && (el.dataset.side || '') === side && el.scrollLeft !== t.scrollLeft) el.scrollLeft = t.scrollLeft;
      }
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, []);
}

// Delegated row clicks -> rv.click(hunkIndex, rowIndex, event). Shift-click must not extend a text selection.
function useRowClicks(rv) {
  const onClick = (e) => {
    if (!rv) return;
    const el = e.target.closest && e.target.closest('[data-r]');
    if (!el || !e.currentTarget.contains(el)) return;
    rv.click(Number(el.dataset.h), Number(el.dataset.r), e);
  };
  const onMouseDown = (e) => { if (rv && e.shiftKey && e.target.closest && e.target.closest('[data-r]')) e.preventDefault(); };
  return { onClick, onMouseDown };
}

function Segment({ gut, lines, two, side }) {
  return html`<div class="pn-ch-diff mono">
    <div class=${cx('pn-ch-gut', two && 'two')} aria-hidden="true">${gut}</div>
    <div class="pn-ch-scroll" data-side=${side || ''}><div class="pn-ch-lines">${lines}</div></div>
  </div>`;
}

const rowAttrs = (rv, hi, ri) => (rv ? { 'data-h': hi, 'data-r': ri } : {});

function UnifiedDiff({ hunks, rv = null }) {
  const ref = useRef(null);
  useScrollSync(ref);
  const clicks = useRowClicks(rv);
  const out = [];
  let gut = []; let lines = []; let segKey = 'seg:start';
  const flush = (next) => {
    if (gut.length) out.push(html`<${Segment} key=${segKey} two gut=${gut} lines=${lines} />`);
    gut = []; lines = []; segKey = 'seg:' + next;
  };
  hunks.forEach((h, hi) => {
    gut.push(html`<div class="pn-ch-gl pn-ch-hunk" key=${'g' + hi}><span></span><span></span></div>`);
    lines.push(html`<div class="pn-ch-ln pn-ch-hunk" key=${'l' + hi}>${h.header}</div>`);
    h.rows.forEach((r, ri) => {
      const sel = rv && rv.isSel(hi, ri);
      const has = rv && rv.hasAt(r);
      const a = rowAttrs(rv, hi, ri);
      gut.push(html`<div class=${cx('pn-ch-gl', r.t, sel && 'sel', has && 'has-c')} key=${hi + '.' + ri} ...${a}><span>${r.o ?? ''}</span><span>${r.n ?? ''}</span></div>`);
      lines.push(html`<div class=${cx('pn-ch-ln', r.t, sel && 'sel')} key=${hi + ':' + ri} ...${a}><span class="pn-ch-sign" aria-hidden="true">${SIGN[r.t]}</span><${LineText} row=${r} /></div>`);
      const blocks = rv && rv.after(hi, [r]);
      if (blocks) { flush(hi + '.' + ri); out.push(html`<div class="pn-rv-slot" key=${'slot:' + hi + '.' + ri}>${blocks}</div>`); }
    });
  });
  flush('end');
  return html`<div class=${cx('pn-ch-stack uni', rv && 'pn-rv-on')} ref=${ref} onClick=${clicks.onClick} onMouseDown=${clicks.onMouseDown}>${out}</div>`;
}

function SideDiff({ hunks, rv = null }) {
  const ref = useRef(null);
  useScrollSync(ref);
  const clicks = useRowClicks(rv);
  const out = [html`<div class="pn-ch-sbs pn-ch-sbs-head" key="head"><div class="pn-ch-side-head">HEAD</div><div class="pn-ch-side-head">Working tree</div></div>`];
  let cols = [{ gut: [], lines: [] }, { gut: [], lines: [] }];
  let segKey = 'seg:start';
  const flush = (next) => {
    if (cols[0].gut.length) {
      out.push(html`<div class="pn-ch-sbs" key=${segKey}>
        <div class="pn-ch-side"><${Segment} gut=${cols[0].gut} lines=${cols[0].lines} side="l" /></div>
        <div class="pn-ch-side"><${Segment} gut=${cols[1].gut} lines=${cols[1].lines} side="r" /></div>
      </div>`);
    }
    cols = [{ gut: [], lines: [] }, { gut: [], lines: [] }]; segKey = 'seg:' + next;
  };
  hunks.forEach((h, hi) => {
    const idx = new Map(h.rows.map((r, i) => [r, i]));
    for (const which of [0, 1]) {
      cols[which].gut.push(html`<div class="pn-ch-gl pn-ch-hunk" key=${'g' + hi}><span></span></div>`);
      cols[which].lines.push(html`<div class="pn-ch-ln pn-ch-hunk" key=${'l' + hi}>${which === 0 ? h.header : ' '}</div>`);
    }
    pairRows(h.rows).forEach((pair, pi) => {
      for (const which of [0, 1]) {
        const r = pair[which];
        const t = !r ? 'fill' : r.t;
        const num = !r ? '' : which === 0 ? r.o : r.n;
        const ri = r ? idx.get(r) : -1;
        const sel = r && rv && rv.isSel(hi, ri);
        const has = r && rv && rv.hasAt(r);
        const a = r ? rowAttrs(rv, hi, ri) : {};
        cols[which].gut.push(html`<div class=${cx('pn-ch-gl', t, sel && 'sel', has && 'has-c')} key=${hi + '.' + pi} ...${a}><span>${num ?? ''}</span></div>`);
        cols[which].lines.push(html`<div class=${cx('pn-ch-ln', t, sel && 'sel')} key=${hi + ':' + pi} ...${a}>${r && html`<span class="pn-ch-sign" aria-hidden="true">${SIGN[r.t]}</span>`}${r && html`<${LineText} row=${r} />`}</div>`);
      }
      const here = pair[0] === pair[1] ? [pair[0]] : pair.filter(Boolean);
      const blocks = rv && rv.after(hi, here);
      if (blocks) { flush(hi + '.' + pi); out.push(html`<div class="pn-rv-slot" key=${'slot:' + hi + '.' + pi}>${blocks}</div>`); }
    });
  });
  flush('end');
  return html`<div class=${cx('pn-ch-stack side', rv && 'pn-rv-on')} ref=${ref} onClick=${clicks.onClick} onMouseDown=${clicks.onMouseDown}>${out}</div>`;
}

// ---------- review state for one file's diff ----------

// Selection { hi, a, b } (hunk index, anchor row, moving row), the open editor, and the comments anchored
// in this file. Returns makeRv(showEditor) so the panel and the side-by-side modal share one state
// (only the visible one renders the editor).
function useReviewLayer({ sid, path, rel, hunks, onAsked }) {
  const [sel, setSel] = useState(null);
  const [editId, setEditId] = useState(null);
  const draftRef = useRef('');
  const now = useNow(60_000, false);
  const all = commentsFor(sid);
  const mine = useMemo(() => all.filter((c) => pathKey(c.path) === pathKey(path)), [all, path]);

  const { byAnchor, outdated } = useMemo(() => {
    const keys = new Set();
    (hunks || []).forEach((h) => h.rows.forEach((r) => keys.add(rowKey(r))));
    const m = new Map(); const old = [];
    for (const c of mine) {
      if (!keys.has(c.anchor)) { old.push(c); continue; }
      if (!m.has(c.anchor)) m.set(c.anchor, []);
      m.get(c.anchor).push(c);
    }
    return { byAnchor: m, outdated: old };
  }, [mine, hunks]);

  useEffect(() => { setSel(null); setEditId(null); draftRef.current = ''; }, [sid, path]);

  const lo = sel ? Math.min(sel.a, sel.b) : -1;
  const hi2 = sel ? Math.max(sel.a, sel.b) : -1;
  const selRows = sel && hunks?.[sel.hi] ? hunks[sel.hi].rows.slice(lo, hi2 + 1) : null;
  const selLast = selRows ? selRows[selRows.length - 1] : null;
  const fields = () => selectionFields(path, rel, selRows);
  const reset = () => { setSel(null); draftRef.current = ''; };

  const click = (hunk, ri, e) => {
    const s = window.getSelection ? window.getSelection() : null;
    if (s && !s.isCollapsed && String(s).trim()) return;            // selecting text to copy, not commenting
    if (e.shiftKey && sel && sel.hi === hunk) { setSel({ ...sel, b: ri }); return; }
    if (sel && sel.hi === hunk && sel.a === ri && sel.b === ri) { if (!draftRef.current.trim()) reset(); return; }
    setSel({ hi: hunk, a: ri, b: ri });
    setEditId(null);
  };

  const card = (c) => (c.id === editId
    ? html`<${CommentEditor} key=${'edit:' + c.id} editing side=${c.side} label=${`${c.rel}:${rangeText(c)}`} initial=${c.body}
        onSave=${(body) => { updateComment(sid, c.id, body); setEditId(null); }} onCancel=${() => setEditId(null)} />`
    : html`<${CommentCard} key=${c.id} c=${c} now=${now} onEdit=${() => { setEditId(c.id); reset(); }} onDelete=${() => removeComment(sid, c.id)} />`);

  const editor = () => {
    const f = fields();
    return html`<${CommentEditor} key=${'new:' + sel.hi + ':' + lo + '-' + hi2} side=${f.side} label=${`${rel}:${rangeText(f)}`} initial=${draftRef.current} draftRef=${draftRef}
      onSave=${(body) => { addComment(sid, { ...f, body }); reset(); }}
      onAsk=${(q) => { askAbout(f, q); reset(); onAsked?.(); }}
      onCancel=${reset} />`;
  };

  const makeRv = (showEditor) => (sid && hunks?.length ? {
    isSel: (h, ri) => !!sel && sel.hi === h && ri >= lo && ri <= hi2,
    hasAt: (r) => byAnchor.has(rowKey(r)),
    click,
    after: (h, rows) => {
      const blocks = [];
      for (const r of rows) for (const c of byAnchor.get(rowKey(r)) || []) blocks.push(card(c));
      if (showEditor && selLast && sel.hi === h && rows.includes(selLast)) blocks.push(editor());
      return blocks.length ? blocks : null;
    },
  } : null);

  const outdatedBlock = outdated.length ? html`<div class="pn-rv-outdated">
    <div class="pn-rv-od-head pn-muted">${outdated.length === 1 ? 'This comment no longer matches the diff' : `${outdated.length} comments no longer match the diff`}</div>
    ${outdated.map(card)}
  </div>` : null;

  return { makeRv, outdatedBlock, count: mine.length, selecting: !!sel };
}

// ---------- diff view (replaces the list) ----------

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function DiffView({ sid, cwd, change, onBack, onOpenComment }) {
  const [wide, setWide] = useState(false);
  const d = useLiveLoad(() => rpc('files.diff', { cwd, path: change.path }), [cwd, change.path]);
  const refresh = useDebounced(() => d.refresh(), 300);
  useEffect(() => on('files.changed', (ev) => { if (ev && pathKey(ev.path) === pathKey(change.path)) refresh(); }), [change.path, refresh]);

  const model = useMemo(() => {
    if (!d.data) return null;
    const { before, after } = d.data;
    if ((before?.length || 0) + (after?.length || 0) > MAX_DIFF_CHARS) return { tooBig: true };
    return { hunks: buildHunks(before, after) };
  }, [d.data]);

  const rel = change.rel || relTo(cwd, change.path);
  const review = useReviewLayer({ sid, path: change.path, rel, hunks: model?.hunks, onAsked: () => setWide(false) });

  let body;
  if (d.loading) body = html`<${Loading} label="Loading diff…" />`;
  else if (d.error) body = html`<${ErrorState} title="Could not load the diff" error=${d.error} onRetry=${d.reload} />`;
  else if (model?.tooBig) body = html`<${Empty} icon="diff" title="Diff too large to show">This file is over 2 MB; open it in your editor instead.<//>`;
  else if (!model?.hunks.length) body = html`<div class="pn-ch-diffwrap">${review.outdatedBlock}<${Empty} icon="diff" title="No differences">The file on disk matches git HEAD.<//></div>`;
  else {
    body = html`<div class="pn-ch-diffwrap">
      ${!review.count && !review.selecting && html`<div class="pn-rv-hint pn-muted">${coarse() ? 'Tap a line to comment' : 'Click a line to comment · Shift-click for a range'}</div>`}
      ${review.outdatedBlock}
      <${UnifiedDiff} hunks=${model.hunks} rv=${review.makeRv(!wide)} />
    </div>`;
  }

  const hasReview = commentsFor(sid).length > 0;
  return html`<div class="pn pn-ch">
    <div class="pn-bar pn-ch-dbar">
      <button class="icon-btn sm" aria-label="Back to changes" title="Back" onClick=${onBack}><${Icon} name="arrow-left" size=${15} /></button>
      <span class=${cx('pn-tag', STATUS_TONE[change.status])} title=${STATUS_WORD[change.status] || change.status}>${change.status}</span>
      <span class="pn-bar-grow pn-ch-dpath mono"><${PathLabel} rel=${rel} title=${change.path} /></span>
      <span class="pn-ch-stat pn-num"><span class="add">+${change.additions ?? 0}</span><span class="del">−${change.deletions ?? 0}</span></span>
      <button class="icon-btn sm" aria-label="Side-by-side view" title="Side-by-side" disabled=${!model?.hunks?.length} onClick=${() => setWide(true)}><${Icon} name="expand" size=${14} /></button>
    </div>
    ${body}
    <${ReviewBar} sid=${sid} onOpen=${onOpenComment} />
    ${wide && model?.hunks && html`<${Modal} wide title=${rel} onClose=${() => setWide(false)}
        footer=${hasReview ? html`<${ReviewBar} sid=${sid} flat onOpen=${(c) => { setWide(false); onOpenComment?.(c); }} onSent=${() => setWide(false)} />` : null}>
      <${SideDiff} hunks=${model.hunks} rv=${review.makeRv(true)} />
    <//>`}
  </div>`;
}

// ---------- rewind ----------

const MODES = [
  { id: 'files', label: 'Files only' },
  { id: 'conversation', label: 'Conversation only' },
  { id: 'both', label: 'Both' },
];

// The forgotten messages stay in Helm's view, folded into a dimmed row (ui/chat/rewound.js).
const FOLD = 'they stay below, dimmed and collapsed as rewound.';

function rewindSentence(cp, mode, cwd) {
  const at = clock(cp.ts);
  const files = (cp.files || []).map((f) => relTo(cwd, f));
  const list = files.length <= 4 ? files.join(', ') : `${files.slice(0, 4).join(', ')} and ${files.length - 4} more`;
  const filesPart = files.length
    ? `Restores ${plural(files.length, 'file')} to how ${files.length === 1 ? 'it was' : 'they were'} at ${at}: ${list}.`
    : 'No files were recorded at this checkpoint, so nothing on disk changes.';
  if (mode === 'files') return files.length ? `${filesPart} Edits made after that point are lost. The conversation is not touched.` : filesPart;
  if (mode === 'conversation') return `Claude forgets this prompt and everything after it; ${FOLD} Files on disk are not touched.`;
  return files.length
    ? `${filesPart} Claude also forgets this prompt and everything after it; ${FOLD} Edits after that point are lost.`
    : `Claude forgets this prompt and everything after it; ${FOLD} ${filesPart}`;
}

export function RewindModal({ session, cp, onClose, onDone }) {
  const [mode, setMode] = useState('files');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await rpc('sessions.rewind', { id: session.id, checkpointId: cp.id, files: mode !== 'conversation', conversation: mode !== 'files' });
      onDone(`Rewound ${mode === 'both' ? 'files and conversation' : mode === 'files' ? 'files' : 'the conversation'} to ${clock(cp.ts)}.`);
    } catch (e) { setErr(e); setBusy(false); }
  };
  const footer = html`
    <button class="btn btn-ghost" onClick=${onClose} disabled=${busy}>Cancel</button>
    <button class="btn btn-danger" onClick=${go} disabled=${busy}>${busy ? 'Rewinding…' : 'Rewind'}</button>`;
  return html`<${Modal} title=${`Rewind to ${fmtWhen(cp.ts)}`} onClose=${busy ? undefined : onClose} footer=${footer}>
    <div class="pn-ch-rw">
      <div class="seg pn-ch-rw-seg" role="radiogroup" aria-label="What to rewind">
        ${MODES.map((m) => html`<button key=${m.id} role="radio" aria-checked=${mode === m.id} aria-pressed=${mode === m.id} onClick=${() => setMode(m.id)}>${m.label}</button>`)}
      </div>
      <p class="pn-ch-rw-say">${rewindSentence(cp, mode, session.cwd)}</p>
      ${err && html`<div class="pn-ch-rw-err" role="alert"><strong>Rewind failed.</strong> <span class="mono">${err.message || String(err)}</span></div>`}
    </div>
  <//>`;
}

// The user prompt a checkpoint belongs to (its item, or the nearest user message before it).
function promptFor(items, itemId) {
  const i = items.findIndex((x) => x.id === itemId);
  if (i < 0) return null;
  for (let k = i; k >= 0; k--) if (items[k].type === 'user' && items[k].text) return items[k].text;
  return null;
}

function Checkpoints({ session, cps, onRewound }) {
  const [target, setTarget] = useState(null);
  const now = useNow(60_000, false);   // relative times refresh on render / window focus; no idle timer
  const items = activeItems.value;
  let body;
  if (cps.loading) body = html`<${Loading} label="Loading checkpoints…" />`;
  else if (cps.error) body = html`<${ErrorState} title="Checkpoints unavailable" error=${cps.error} onRetry=${cps.reload} />`;
  else if (!cps.data?.length) body = html`<p class="pn-ch-cp-empty">No checkpoints yet. Claude Code saves one before each turn that edits files; this session hasn't edited anything since it started (or file checkpointing is off).</p>`;
  else {
    const list = [...cps.data].sort((a, b) => b.ts - a.ts);
    body = html`<ul class="pn-ch-cps">${list.map((cp) => {
      const files = (cp.files || []).map((f) => relTo(session.cwd, f));
      const names = files.slice(0, 3).map(basename).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '');
      const prompt = promptFor(items, cp.itemId);
      return html`<li class="pn-ch-cp" key=${cp.id}>
        <div class="pn-ch-cp-main">
          <div class="pn-ch-cp-when"><span>${fmtWhen(cp.ts)}</span><span class="pn-muted">${fmtAgo(cp.ts, now)}</span></div>
          ${prompt && html`<div class="pn-ch-cp-prompt" title=${prompt}>${prompt}</div>`}
          <div class="pn-ch-cp-files pn-muted" title=${files.join('\n')}>${files.length ? html`<span class="pn-num">${plural(files.length, 'file')}</span> · <span class="mono">${names}</span>` : 'No files recorded'}</div>
        </div>
        <button class="btn btn-sm pn-ch-cp-btn" onClick=${() => setTarget(cp)}><${Icon} name="rewind" size=${13} />Rewind…</button>
      </li>`;
    })}</ul>`;
  }
  return html`<div class="pn-ch-cpsect">
    <${SectionHead} title="Checkpoints">${cps.data?.length ? html`<span class="pn-num">${cps.data.length}</span>` : null}<//>
    ${body}
    ${target && html`<${RewindModal} session=${session} cp=${target} onClose=${() => setTarget(null)} onDone=${(msg) => { setTarget(null); onRewound(msg); }} />`}
  </div>`;
}

// ---------- panel ----------

const STATUS_TONE = { A: 'ok', D: 'danger', M: 'pn-ch-m' };
const STATUS_WORD = { A: 'Added', D: 'Deleted', M: 'Modified' };

export function ChangesPanel() {
  const session = activeSession.value;
  const sid = session?.id || null;
  const cwd = session?.cwd || '';
  const [open, setOpen] = useState(null);       // change row being viewed
  const [note, setNote] = useState(null);

  const ch = useLiveLoad(() => (sid ? rpc('files.changes', { sessionId: sid }) : []), [sid]);
  const cps = useLiveLoad(() => (sid ? rpc('sessions.checkpoints', { id: sid }) : []), [sid]);
  const refreshAll = useDebounced(() => { ch.refresh(); cps.refresh(); }, 300);

  useEffect(() => { setOpen(null); setNote(null); }, [sid]);
  useEffect(() => {
    if (!sid) return undefined;
    const offs = [
      on('files.changed', (d) => { if (!d?.sessionId || d.sessionId === sid) refreshAll(); }),
      on('session.item', (d) => { if (d?.sessionId === sid) refreshAll(); }),
    ];
    return () => offs.forEach((off) => off?.());
  }, [sid, refreshAll]);

  if (!session) return html`<div class="pn"><${Empty} icon="changes" title="No session selected">Pick a session to see the files it changed.<//></div>`;
  // Review bar item -> that file's diff, then bring its card into view once the diff has rendered.
  const openComment = (c) => {
    const row = (ch.data || []).find((r) => pathKey(r.path) === pathKey(c.path)) || { path: c.path, rel: c.rel, status: 'M' };
    setOpen(row);
    let tries = 0;
    const seek = () => {
      const el = document.querySelector(`[data-comment="${c.id}"]`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
      else if (++tries < 20) setTimeout(seek, 80);
    };
    setTimeout(seek, 30);
  };

  if (open) return html`<${DiffView} sid=${sid} cwd=${cwd} change=${open} onBack=${() => setOpen(null)} onOpenComment=${openComment} />`;

  const rows = ch.data || [];
  const add = rows.reduce((s, r) => s + (r.additions || 0), 0);
  const del = rows.reduce((s, r) => s + (r.deletions || 0), 0);

  let list;
  if (ch.loading) list = html`<${Loading} label="Loading changes…" />`;
  else if (ch.error) list = html`<${ErrorState} title="Could not load changes" error=${ch.error} onRetry=${ch.reload} />`;
  else if (!rows.length) list = html`<${Empty} icon="changes" title="No changes yet">Files this session writes appear here.<//>`;
  else {
    list = html`<ul class="pn-ch-list">${rows.map((r) => html`<li key=${r.path}>
      <button class="pn-ch-row" onClick=${() => setOpen(r)} title=${r.path}>
        <span class=${cx('pn-tag', 'pn-ch-st', STATUS_TONE[r.status])} aria-label=${STATUS_WORD[r.status] || r.status}>${r.status}</span>
        <span class="pn-ch-rpath mono"><${PathLabel} rel=${r.rel || relTo(cwd, r.path)} title=${r.path} /></span>
        <span class="pn-ch-stat pn-num">${r.status !== 'D' || r.additions ? html`<span class="add">+${r.additions ?? 0}</span>` : null}${r.status !== 'A' || r.deletions ? html`<span class="del">−${r.deletions ?? 0}</span>` : null}</span>
      </button>
    </li>`)}</ul>`;
  }

  return html`<div class="pn pn-ch">
    <div class="pn-bar">
      <span class="pn-bar-grow">${ch.data
        ? html`<span class="pn-ch-sum"><span class="pn-num">${plural(rows.length, 'file')}</span> changed${rows.length ? html` · <span class="pn-ch-stat pn-num"><span class="add">+${add}</span><span class="del">−${del}</span></span>` : ''}</span>`
        : 'Changes'}</span>
      <button class=${cx('icon-btn sm', (ch.refreshing || cps.refreshing) && 'pn-ch-busy')} aria-label="Refresh" title="Refresh" onClick=${() => { ch.refresh(); cps.refresh(); }}><${Icon} name="refresh" size=${14} /></button>
    </div>
    ${note && html`<div class="pn-note pn-ch-okn" role="status"><span>${note}</span><button class="icon-btn sm" aria-label="Dismiss" onClick=${() => setNote(null)}><${Icon} name="close" size=${12} /></button></div>`}
    ${list}
    <${Checkpoints} session=${session} cps=${cps} onRewound=${(msg) => { setNote(msg); ch.refresh(); cps.refresh(); }} />
    <${ReviewBar} sid=${sid} onOpen=${openComment} />
  </div>`;
}
