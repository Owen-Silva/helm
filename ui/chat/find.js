// In-session search (Ctrl+F). Owner: lane conversation (D).
// Matches come from the loaded items' data (user / assistant text, tool input + output), so a match inside a
// collapsed group or agent card is still found; ChatView expands it on the way. On-screen highlighting uses
// the CSS Custom Highlight API (no DOM mutation, so React-owned markup and markdown are untouched).
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { resultText, stripAnsi } from './util.js';

const str = (v) => (typeof v === 'string' ? v : '');

export function searchableText(it) {
  if (it.type === 'user' || it.type === 'assistant') return str(it.text);
  if (it.type === 'shell') return [str(it.command), str(it.text)].filter(Boolean).join('\n'); // `!` runs
  if (it.type !== 'tool') return '';
  const i = it.input || {};
  const parts = [i.command, i.description, i.file_path, i.notebook_path, i.path, i.pattern, i.url, i.query, i.prompt,
    i.old_string, i.new_string, i.content, it.result != null ? stripAnsi(resultText(it.result)) : ''];
  if (Array.isArray(i.edits)) for (const e of i.edits) parts.push(e?.old_string, e?.new_string);
  return parts.map(str).filter(Boolean).join('\n');
}

// [{ id, occ }] in transcript order; occ = which occurrence inside that item.
export function findMatches(items, q) {
  const out = [];
  const needle = String(q || '').toLowerCase();
  if (!needle) return out;
  for (const it of items) {
    const hay = searchableText(it).toLowerCase();
    if (!hay) continue;
    let at = hay.indexOf(needle), k = 0;
    while (at >= 0 && k < 200) { out.push({ id: it.id, occ: k++ }); at = hay.indexOf(needle, at + needle.length); }
    if (out.length >= 5000) break;
  }
  return out;
}

// ---- highlights (one registry for every pane; each pane owns its ranges by key) ----
const HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
const paneRanges = new Map();
function flush() {
  if (!HL) return;
  const all = [], cur = [];
  for (const v of paneRanges.values()) { all.push(...v.all); if (v.cur) cur.push(v.cur); }
  if (all.length) CSS.highlights.set('helm-find', new Highlight(...all)); else CSS.highlights.delete('helm-find');
  if (cur.length) CSS.highlights.set('helm-find-cur', new Highlight(...cur)); else CSS.highlights.delete('helm-find-cur');
}
export function clearHighlights(key) { if (paneRanges.delete(key)) flush(); }

const SKIP = 'button.cv-copy, .msg-meta, .find-bar, script, style';
function rangesIn(root, needle, cap = 600) {
  const out = [];
  if (!root || !needle) return out;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = tw.nextNode()) && out.length < cap) {
    const hay = n.data.toLowerCase();
    let at = hay.indexOf(needle);
    while (at >= 0 && out.length < cap) {
      const r = new Range(); r.setStart(n, at); r.setEnd(n, at + needle.length); out.push(r);
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return out;
}

// Paints every visible occurrence under `root` and marks the `occ`-th one inside `target` as current.
// Returns the current Range (or null when the text is not on screen, e.g. a truncated output).
export function paintHighlights(key, root, q, target, occ) {
  if (!HL) return null;
  const all = rangesIn(root, String(q || '').toLowerCase());
  let cur = null;
  if (target) {
    const mine = all.filter((r) => target.contains(r.startContainer));
    cur = mine.length ? mine[Math.min(occ || 0, mine.length - 1)] : null;
  }
  paneRanges.set(key, { all, cur });
  flush();
  return cur;
}

export function FindBar({ q, count, index, inputRef, onInput, onStep, onClose, hasMore, onOlder, olderBusy }) {
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  const label = !q ? '' : count ? `${index + 1} of ${count}` : 'No matches';
  return html`<div class="find-bar" role="search" aria-label="Find in conversation">
    <${Icon} name="search" size=${14} class="find-ic" />
    <input ref=${inputRef} class="find-input" type="text" value=${q} placeholder="Find in conversation" aria-label="Find in conversation"
      spellcheck="false" autocomplete="off" onInput=${(e) => onInput(e.currentTarget.value)} onKeyDown=${onKey} />
    <span class=${'find-count tnum' + (q && !count ? ' none' : '')} aria-live="polite">${label}</span>
    ${hasMore ? html`<button type="button" class="find-older" onClick=${onOlder} disabled=${olderBusy}
      title="Load earlier messages and keep searching">${olderBusy ? 'Searching…' : 'Search older'}</button>` : null}
    <span class="find-sep" aria-hidden="true"></span>
    <button type="button" class="icon-btn sm" aria-label="Previous match (Shift+Enter)" title="Previous (Shift+Enter)" disabled=${!count} onClick=${() => onStep(-1)}>
      <${Icon} name="chevron-up" size=${15} /></button>
    <button type="button" class="icon-btn sm" aria-label="Next match (Enter)" title="Next (Enter)" disabled=${!count} onClick=${() => onStep(1)}>
      <${Icon} name="chevron-down" size=${15} /></button>
    <button type="button" class="icon-btn sm" aria-label="Close find (Esc)" title="Close (Esc)" onClick=${onClose}>
      <${Icon} name="x" size=${15} /></button>
  </div>`;
}
