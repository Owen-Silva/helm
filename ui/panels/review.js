// Owner: lane review-tools. Review comments on diff lines (Changes panel + its side-by-side modal).
// Comments live per session in localStorage (helm.review.<sessionId>) until sent or cleared.
// "Send review" composes ONE prompt into the active session's composer (never auto-sent):
// a short header, then per comment `path:line(-line)` + the quoted diff lines + the comment.
// "Ask about this" puts a question about one selection into the composer the same way.
import { signal } from '@preact/signals';
import { useState, useRef, useEffect } from 'preact/hooks';
import { html, Icon, cx, fmtAgo } from './util.js';
import { toast } from '../lib/store.js';
import { sheetOpen } from '../shell/state.js';

// ---------- store ----------

const KEY = (sid) => 'helm.review.' + sid;
const cache = {};                       // { [sid]: [Comment] } loaded lazily from localStorage
export const reviewVersion = signal(0); // read it in render to re-render on any change

function load(sid) {
  try { const v = JSON.parse(localStorage.getItem(KEY(sid)) || '[]'); return Array.isArray(v) ? v.filter((c) => c && c.id && c.path) : []; } catch { return []; }
}
function persist(sid, list) {
  try { if (list.length) localStorage.setItem(KEY(sid), JSON.stringify(list)); else localStorage.removeItem(KEY(sid)); } catch { /* private window / quota: comments stay in memory */ }
}

/** Comments for a session (subscribes the caller to changes). */
export function commentsFor(sid) {
  reviewVersion.value; // eslint-disable-line no-unused-expressions
  if (!sid) return [];
  if (!cache[sid]) cache[sid] = load(sid);
  return cache[sid];
}
function write(sid, list) { cache[sid] = list; persist(sid, list); reviewVersion.value++; }

let seq = 0;
const newId = () => 'c' + Date.now().toString(36) + (seq++).toString(36);

export function addComment(sid, c) { const full = { ...c, id: newId(), ts: Date.now() }; write(sid, [...commentsFor(sid), full]); return full; }
export function updateComment(sid, id, body) { write(sid, commentsFor(sid).map((c) => (c.id === id ? { ...c, body, ts: Date.now() } : c))); }
export function removeComment(sid, id) { write(sid, commentsFor(sid).filter((c) => c.id !== id)); }
export function clearReview(sid) { write(sid, []); }

// ---------- diff rows -> comment fields ----------

/** Stable key of a diff row within one file's diff (old:new line numbers). */
export const rowKey = (r) => `${r.o ?? ''}:${r.n ?? ''}`;

/** Line range a selection covers: new-file numbers when it has any, else old (deleted-only) numbers. */
export function lineRange(rows) {
  const ns = rows.map((r) => r.n).filter((x) => x != null);
  const nums = ns.length ? ns : rows.map((r) => r.o).filter((x) => x != null);
  if (!nums.length) return { side: 'new', a: 0, b: 0 };
  return { side: ns.length ? 'new' : 'old', a: Math.min(...nums), b: Math.max(...nums) };
}

/** Comment fields (minus body/id/ts) for selected rows of one file. */
export function selectionFields(path, rel, rows) {
  const r = lineRange(rows);
  const last = rows[rows.length - 1];
  return {
    path, rel, side: r.side, a: r.a, b: r.b,
    anchor: rowKey(last),
    lines: rows.map((x) => ({ t: x.t, text: x.text })),
  };
}

export const rangeText = (c) => (c.a === c.b ? `${c.a}` : `${c.a}-${c.b}`);
export const locText = (c) => `${c.rel}:${rangeText(c)}${c.side === 'old' ? ' (removed lines, numbered as in HEAD)' : ''}`;

// ---------- prompt text ----------

const MAX_QUOTE = 40;
const SIGNS = { add: '+', del: '-', ctx: ' ' };

function quote(lines) {
  let body = lines.map((l) => (SIGNS[l.t] ?? ' ') + l.text);
  if (body.length > MAX_QUOTE) body = [...body.slice(0, 24), `  … ${body.length - 34} lines omitted …`, ...body.slice(-10)];
  const longest = Math.max(2, ...body.map((l) => Math.max(0, ...(l.match(/`+/g) || []).map((m) => m.length))));
  const fence = '`'.repeat(longest + 1);
  return `${fence}diff\n${body.join('\n')}\n${fence}`;
}

const byLocation = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : (a.a - b.a) || (a.ts - b.ts));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One prompt for a whole review. */
export function composeReview(list) {
  const sorted = [...list].sort(byLocation);
  const files = new Set(sorted.map((c) => c.rel)).size;
  const head = `Review of the current changes: ${plural(sorted.length, 'comment')} on ${plural(files, 'file')}. `
    + 'Please address each one. Quoted lines are from the diff against git HEAD (+ added, - removed).';
  const parts = sorted.map((c, i) => `${i + 1}. ${locText(c)}\n${quote(c.lines)}\n${String(c.body || '').trim()}`);
  return `${head}\n\n${parts.join('\n\n')}`;
}

/** A question about one selection; `question` empty -> a sensible default the user can edit. */
export function composeAsk(fields, question) {
  const changed = fields.lines.some((l) => l.t !== 'ctx');
  const q = String(question || '').trim() || (changed ? 'Why was this changed, and does anything about it look wrong?' : 'What does this code do?');
  return `${q}\n\n${locText(fields)}\n${quote(fields.lines)}`;
}

// ---------- actions that reach the composer ----------

function toComposer(text) {
  window.dispatchEvent(new CustomEvent('helm:composer-insert', { detail: { text, mode: 'append' } }));
  if (sheetOpen.value) sheetOpen.value = false;      // phone: drop the sheet so the composer is in view
}

export function sendReview(sid) {
  const list = commentsFor(sid);
  if (!list.length) return;
  toComposer(composeReview(list));
  clearReview(sid);
  toast({ title: 'Review added to the message box', body: `${plural(list.length, 'comment')}. Edit it if you like, then send.`, kind: 'info' });
}

export function askAbout(fields, question) { toComposer(composeAsk(fields, question)); }

// ---------- UI pieces ----------

const isCoarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Inline editor under the selected lines. */
export function CommentEditor({ label, side = 'new', initial = '', draftRef, editing, onSave, onAsk, onCancel }) {
  const [text, setText] = useState(initial);
  const ta = useRef(null);
  useEffect(() => { const el = ta.current; if (el) { el.focus({ preventScroll: false }); const n = el.value.length; el.setSelectionRange(n, n); } }, []);
  const set = (v) => { setText(v); if (draftRef) draftRef.current = v; };
  const save = () => { if (text.trim()) onSave(text.trim()); };
  const onKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };
  return html`<div class="pn-rv-ed" data-side=${side} role="group" aria-label=${'Comment on ' + label} onClick=${(e) => e.stopPropagation()}>
    <div class="pn-rv-ed-head"><${Icon} name="message" size=${12} /><span class="mono">${label}</span></div>
    <textarea ref=${ta} class="textarea pn-rv-ta" rows="3" value=${text} placeholder=${editing ? 'Edit comment' : 'Leave a comment, or ask about these lines'}
      aria-label="Comment" onInput=${(e) => set(e.currentTarget.value)} onKeyDown=${onKey}></textarea>
    <div class="pn-rv-ed-foot">
      ${!editing && html`<button type="button" class="btn btn-ghost btn-sm pn-rv-ask" onClick=${() => onAsk(text)} title="Put a question about these lines in the message box">Ask about this</button>`}
      <span class="pn-rv-grow"></span>
      ${!isCoarse() && html`<span class="pn-rv-kbd pn-muted">Ctrl+Enter</span>`}
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onCancel}>Cancel</button>
      <button type="button" class="btn btn-primary btn-sm pn-rv-save" disabled=${!text.trim()} onClick=${save}>${editing ? 'Save' : 'Comment'}</button>
    </div>
  </div>`;
}

/** A saved comment, shown inline under the line it is anchored to. */
export function CommentCard({ c, now, onEdit, onDelete }) {
  return html`<div class="pn-rv-card" data-comment=${c.id} data-side=${c.side} onClick=${(e) => e.stopPropagation()}>
    <div class="pn-rv-card-head">
      <span class="pn-rv-loc mono">${c.side === 'old' ? 'removed ' : ''}${c.a === c.b ? 'line' : 'lines'} ${rangeText(c)}</span>
      <span class="pn-muted">${fmtAgo(c.ts, now)}</span>
      <span class="pn-rv-grow"></span>
      <button type="button" class="icon-btn sm" aria-label="Edit comment" title="Edit" onClick=${onEdit}><${Icon} name="pencil" size=${13} /></button>
      <button type="button" class="icon-btn sm" aria-label="Delete comment" title="Delete" onClick=${onDelete}><${Icon} name="trash" size=${13} /></button>
    </div>
    <div class="pn-rv-body">${c.body}</div>
  </div>`;
}

/**
 * Review bar: count across files, expandable list, Clear (two-step) and Send review.
 * `onOpen(comment)` jumps to that file's diff; `onSent` runs after Send review; `flat` = modal footer styling.
 */
export function ReviewBar({ sid, onOpen, onSent, flat }) {
  const list = commentsFor(sid);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!confirm) return undefined; const t = setTimeout(() => setConfirm(false), 3500); return () => clearTimeout(t); }, [confirm]);
  useEffect(() => { if (!list.length) { setOpen(false); setConfirm(false); } }, [list.length]);
  if (!sid || !list.length) return null;
  const files = new Set(list.map((c) => c.rel)).size;
  const sorted = [...list].sort(byLocation);
  return html`<div class=${cx('pn-rv-bar', flat && 'flat', open && 'open')} role="region" aria-label="Review">
    ${open && html`<ul class="pn-rv-list">${sorted.map((c) => html`<li key=${c.id}>
      <button type="button" class="pn-rv-item" onClick=${() => onOpen?.(c)} title=${'Open ' + c.rel}>
        <span class="pn-rv-item-loc mono">${c.rel}:${rangeText(c)}</span>
        <span class="pn-rv-item-body">${c.body}</span>
      </button>
      <button type="button" class="icon-btn sm" aria-label=${'Delete comment on ' + c.rel + ':' + rangeText(c)} title="Delete" onClick=${() => removeComment(sid, c.id)}><${Icon} name="x" size=${12} /></button>
    </li>`)}</ul>`}
    <div class="pn-rv-row">
      <button type="button" class="pn-rv-count" aria-expanded=${open} onClick=${() => setOpen(!open)} title=${open ? 'Hide comments' : 'Show comments'}>
        <span class="pn-rv-title">Review</span>
        <span class="pn-rv-n pn-num">${list.length}</span>
        <span class="pn-muted pn-rv-meta" title=${plural(list.length, 'comment') + ' on ' + plural(files, 'file')}>${plural(files, 'file')}</span>
        <${Icon} name=${open ? 'chevron-down' : 'chevron-up'} size=${12} class="pn-muted" />
      </button>
      <span class="pn-rv-grow"></span>
      <button type="button" class=${cx('btn btn-ghost btn-sm', confirm && 'pn-rv-danger')} onClick=${() => { if (confirm) { clearReview(sid); setConfirm(false); } else setConfirm(true); }}>${confirm ? `Clear ${list.length}?` : 'Clear'}</button>
      <button type="button" class="btn btn-primary btn-sm pn-rv-send" onClick=${() => { sendReview(sid); onSent?.(); }} title="Put the review in the message box (you send it)">Send review</button>
    </div>
  </div>`;
}
