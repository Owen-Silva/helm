// The Deck: every non-archived session as a live tile, so the user can see and steer the whole fleet from one
// screen. Owner: lane deck. Routing: view.value === 'deck' (ui/shell/state.js); entry points in the rail,
// the palette ("Open Deck"), Ctrl+Shift+D and the phone session list.
//
// Data: Session.lastText / Session.pendingRequest (PROTOCOL "Deck summary") paint every tile without
// loading histories. When a session's items are already loaded (opened before, or a live tile on desktop)
// the tile reads them instead: exact pending state and full-rate streaming.
// Answers on the tile: permissions (Approve / Deny) and the simple question (one single-select question,
// 2-4 options: pendingRequest.choice, ./choice.js) as one button per option plus "Other…". Anything else opens.
// Keys (focus on a tile): arrows move, Enter opens, / focuses that tile's reply box (Esc returns to the tile).
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { sessions, itemsOf, loadedOf, fleetBySession, loadHistory, respond, send, toast } from '../lib/store.js';
import { stopTurn } from '../lib/stop.js';
import { openSession, newSessionOpen, isPhone } from '../shell/state.js';
import { etaInfo } from '../shell/eta.js';
import { displayStatus, agentsRunningOf, isAgentsOnly, agentsLabel, stallText } from '../lib/session-status.js';
import { cx, ago, fmtCost, useTick, mod } from '../shell/util.js';
import { simpleChoice, questionsOf, choiceAnswer } from './choice.js';

const RANK = { waiting: 0, working: 1, error: 2, idle: 3, closed: 4 };
const STATUS_TEXT = { working: 'Working', waiting: 'Needs you', error: 'Error', idle: 'Idle', closed: 'Closed' };
const TEXT_MAX = 280;
const RECOMMENDED = /\(recommended\)\s*$/i;   // Claude's own marker for its suggested option: that button is primary
const short = (t, n = 36) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

// requestIds answered from a tile: hidden at once, before the session's next update lands
const answered = signal(new Set());
const markAnswered = (rid) => { answered.value = new Set([...answered.value, rid]); };
// which tile has keyboard focus (survives re-sorts: tracked by session id)
const focusedId = signal(null);

// ---------- data ----------
export function deckOrder(list) {
  return list.filter((s) => !s.archived).sort((a, b) => {
    const ra = RANK[displayStatus(a)] ?? 5, rb = RANK[displayStatus(b)] ?? 5;
    if (ra !== rb) return ra - rb;
    // live tiles keep their place while they work (updatedAt moves every few seconds); the rest by recency
    return ra <= 1 ? (b.createdAt || 0) - (a.createdAt || 0) : (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function tail(text) {
  const one = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const t = one(String(text || '').replace(/```[\s\S]*?(?:```|$)/g, ' ')) || one(text);   // as the engine: fenced code dropped
  if (t.length <= TEXT_MAX) return t;
  const cut = t.slice(t.length - (TEXT_MAX - 1));
  const sp = cut.indexOf(' ');
  return '…' + (sp > 0 && sp < 40 ? cut.slice(sp + 1) : cut);
}
// tile text is plain: drop the markdown punctuation that would show as symbols
const plain = (t) => String(t || '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2')
  .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
  .replace(/(^|\s)#{1,6}\s+/g, '$1')
  .replace(/(^|\s)>\s+/g, '$1');

function lastTextOf(s, items) {
  if (items) {
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      if (it.type === 'assistant' && !it.parentToolUseId && String(it.text || '').trim()) return tail(it.text);
    }
  }
  return s.lastText || null;
}

// Same summary as the engine's (main/engine/session.js requestSummary), built from a loaded request item.
function summarize(it, count) {
  const i = it.input || {};
  const one = (v, n = 160) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  let title, detail = null, choice = null;
  if (it.kind === 'question') {
    const q = (it.questions || i.questions || [])[0] || {};
    title = one(q.question || 'Claude has a question');
    const opts = (q.options || []).map((o) => one(o?.label)).filter(Boolean);
    if (opts.length) detail = one(opts.join(' · '));
    choice = simpleChoice(questionsOf(it));
  } else if (it.kind === 'plan') {
    title = 'A plan is ready for review';
    const first = String(it.plan || i.plan || '').split('\n').map((l) => l.replace(/^[#>*\-\s\d.]+/, '').trim()).find(Boolean);
    if (first) detail = one(first);
  } else {
    title = it.title ? one(it.title) : `Allow ${it.toolName || 'this tool'}?`;
    detail = (it.toolName === 'Bash' || it.toolName === 'PowerShell') && i.command ? one(i.command)
      : i.file_path || i.notebook_path || (i.url ? one(i.url) : null) || (it.description ? one(it.description) : null);
  }
  return { requestId: it.requestId, itemId: it.id, kind: it.kind, toolName: it.toolName, title, detail, ...(choice ? { choice } : {}), count };
}

function pendingOf(s, items) {
  const done = answered.value;
  if (items) {
    const list = items.filter((i) => i.type === 'request' && i.status === 'pending' && !done.has(i.requestId));
    return list.length ? summarize(list[0], list.length) : null;
  }
  const p = s.pendingRequest;
  return p && !done.has(p.requestId) ? p : null;
}

function statusLine(s, pend) {
  if (s.status === 'waiting') return pend ? (pend.kind === 'permission' ? `Waiting for permission${pend.toolName ? `: ${pend.toolName}` : ''}` : pend.kind === 'plan' ? 'Waiting for plan approval' : 'Waiting for your answer') : s.activity || 'Needs you';
  if (s.status === 'working') return stallText(s) || s.activity || 'Working…';   // lane stall: "Stalled · 12m"
  if (s.status === 'error') return s.activity || 'Stopped with an error';
  if (isAgentsOnly(s)) return agentsLabel(s);   // idle, but its agents are still working
  return s.status === 'closed' ? 'Closed' : 'Idle';
}

function agentsRunning(s) {
  const fleet = fleetBySession.value[s.id];
  if (Array.isArray(fleet)) return fleet.filter((a) => a.status === 'running').length;
  return agentsRunningOf(s);
}

// Desktop: live tiles (working / waiting) load their transcript once, so streaming text and pending
// requests come straight from items. The phone stays on the summary fields (less to download).
const loading = new Set();
function useLiveItems(list) {
  const want = isPhone.value ? [] : list.filter((s) => (s.status === 'working' || s.status === 'waiting') && !loadedOf(s.id).value).map((s) => s.id);
  const key = want.join(',');
  useEffect(() => {
    for (const id of want) {
      if (loading.has(id)) continue;
      loading.add(id);
      loadHistory(id).catch(() => {}).finally(() => loading.delete(id));
    }
  }, [key]);
}

// ---------- keyboard ----------
const tilesIn = (root) => [...(root?.querySelectorAll('.dtile') || [])];
function focusTile(el) { if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); } }
function moveFocus(root, from, key) {
  const tiles = tilesIn(root);
  const i = tiles.indexOf(from);
  if (i < 0) return focusTile(tiles[0]);
  if (key === 'ArrowRight') return focusTile(tiles[Math.min(tiles.length - 1, i + 1)]);
  if (key === 'ArrowLeft') return focusTile(tiles[Math.max(0, i - 1)]);
  // up / down: the nearest tile in the next row, by geometry (the grid reflows with the window)
  const r = from.getBoundingClientRect();
  const cx0 = r.left + r.width / 2;
  const down = key === 'ArrowDown';
  let best = null, bestScore = Infinity;
  for (const t of tiles) {
    if (t === from) continue;
    const b = t.getBoundingClientRect();
    const dy = down ? b.top - r.top : r.top - b.top;
    if (dy <= 4) continue;
    const score = dy * 4 + Math.abs(b.left + b.width / 2 - cx0);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  if (best) focusTile(best);
}

// ---------- tile ----------
function Tile({ s }) {
  const items = itemsOf(s.id).value || null;   // this tile's session only
  const pend = s.status === 'waiting' || items ? pendingOf(s, items) : null;
  const text = lastTextOf(s, items);
  const eta = etaInfo(s.eta, s.status === 'working');
  const agents = agentsRunning(s);
  const pct = s.context?.percent;
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState(null);   // { text, tone } after a reply / answer, for a few seconds
  const noteTimer = useRef(0);
  const root = useRef(null);
  const input = useRef(null);
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const flash = (t, tone = 'ok') => { clearTimeout(noteTimer.current); setNote({ text: t, tone }); noteTimer.current = setTimeout(() => setNote(null), 2600); };
  const working = s.status === 'working';
  // one single-select question with 2-4 options: answered right here (PROTOCOL "Deck summary" choice)
  const choice = pend?.kind === 'question' && Array.isArray(pend.choice?.options) && pend.choice.options.length && pend.choice.question ? pend.choice : null;
  const hasMeta = !!eta || agents > 0 || pct != null || s.costUsd > 0 || s.queued > 0;

  const answer = async (response, label) => {
    if (!pend || busy) return;
    setBusy(true);
    try { await respond(s.id, pend.requestId, response); markAnswered(pend.requestId); flash(label); }
    catch (e) { toast({ title: 'Could not send your answer', error: e, kind: 'error' }); }
    finally { setBusy(false); }
  };
  // lane steer: asks first (naming them) when agents would stop with the turn
  const stop = () => stopTurn(s.id).then((r) => { if (r === 'stopped') flash('Stopped', 'dim'); else if (r === 'kept') flash('Kept going', 'dim'); });
  const submit = async () => {
    const body = reply.trim();
    if (!body) return;
    setReply('');
    try {
      const r = await send(s.id, body);
      flash(r?.delivery === 'next-step' ? 'Sent · Claude reads it at its next step' : r?.queued ? 'Queued for after this turn' : 'Sent');
      loadHistory(s.id).catch(() => {});   // watch the answer arrive on this tile
    } catch (e) {
      setReply((cur) => cur || body);
      toast({ title: 'Message not sent', error: e, kind: 'error' });
    }
  };
  const open = () => openSession(s.id);
  const onClick = (e) => { if (!e.target.closest('button, input, textarea, a, .dtile-reply')) open(); };
  const onKey = (e) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    else if (e.key === '/') { e.preventDefault(); input.current?.focus(); }
    else if (e.key.startsWith('Arrow')) { e.preventDefault(); moveFocus(root.current?.closest('.deck-grid'), e.currentTarget, e.key); }
  };
  const onReplyKey = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); root.current?.focus(); }
  };
  const title = s.title || 'New session';

  return html`<article ref=${root} class=${cx('dtile', `st-${displayStatus(s)}`, pend && 'has-req')} tabindex="0" data-sid=${s.id}
      aria-label=${`${title}, ${STATUS_TEXT[s.status] || s.status}. Enter opens.`}
      onClick=${onClick} onKeyDown=${onKey} onFocus=${(e) => { if (e.target === e.currentTarget) focusedId.value = s.id; }}>
    <header class="dtile-head">
      <span class=${cx('dot', displayStatus(s))} aria-hidden="true"></span>
      <h2 class="dtile-title truncate" title=${title}>${title}</h2>
      <span class="dtile-time tnum">${ago(s.updatedAt)}</span>
    </header>
    <div class="dtile-sub">
      <span class="dtile-project truncate" title=${s.cwd}>${s.project || s.cwd}</span>
      <span class="dtile-sep" aria-hidden="true">·</span>
      <span class=${cx('dtile-status truncate', `st-${displayStatus(s)}`)}>${statusLine(s, pend)}</span>
    </div>

    <p class=${cx('dtile-text', !text && 'empty')}>${text ? plain(text) : 'No reply yet'}</p>

    ${pend && html`<div class=${cx('dtile-req', `k-${pend.kind}`)} data-request-id=${pend.requestId}>
      <div class="dtile-req-head">
        <${Icon} name=${pend.kind === 'permission' ? 'shield' : pend.kind === 'plan' ? 'map' : 'help'} size=${14} />
        <span class="dtile-req-title truncate" title=${pend.title}>${pend.title}</span>
        ${pend.count > 1 && html`<span class="dtile-req-more tnum">+${pend.count - 1}</span>`}
      </div>
      ${pend.detail && !choice && html`<div class=${cx('dtile-req-detail truncate', pend.kind === 'permission' && 'mono')} title=${pend.detail}>${pend.detail}</div>`}
      ${choice ? html`<div class="dtile-req-actions dtile-choices" role="group" aria-label=${choice.question}>
        ${choice.options.map((o) => html`<button type="button" key=${o.label} class=${cx('btn btn-sm dtile-choice', RECOMMENDED.test(o.label) && 'btn-primary')} disabled=${busy}
            title=${o.description ? `${o.label}\n${o.description}` : o.label}
            onClick=${() => answer(choiceAnswer(choice, o.label), `Answered: ${short(o.label)}`)}><span class="truncate">${o.label}</span></button>`)}
        <button type="button" class="btn btn-ghost btn-sm dtile-choice-other" title="Open the session to write a different answer" onClick=${open}>Other…</button>
      </div>` : html`<div class="dtile-req-actions">
        ${pend.kind === 'permission' ? html`
          <button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => answer({ behavior: 'allow' }, `Allowed ${pend.toolName || ''}`.trim())}>Approve</button>
          <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => answer({ behavior: 'deny' }, `Denied ${pend.toolName || ''}`.trim())}>Deny</button>`
        : html`<button type="button" class="btn btn-primary btn-sm" onClick=${open}>${pend.kind === 'plan' ? 'Review plan' : 'Answer'}<${Icon} name="arrow-right" size=${13} /></button>`}
      </div>`}
    </div>`}

    <div class="dtile-spacer"></div>
    ${(hasMeta || working) && html`<footer class="dtile-foot">
      <div class="dtile-meta tnum">
        ${eta && html`<span class=${cx('dtile-m dtile-eta', eta.over && 'over')} title=${eta.title || eta.long}><${Icon} name="clock" size=${12} />${eta.short}${eta.step ? html`<span class="dtile-dim"> · ${eta.step}</span>` : null}</span>`}
        ${agents > 0 && html`<span class="dtile-m" title=${`${agents} agent${agents > 1 ? 's' : ''} running`}><${Icon} name="fleet" size=${12} />${agents}</span>`}
        ${pct != null && html`<span class=${cx('dtile-m dtile-ctx', pct >= 80 && 'hot')} title=${`Context ${pct.toFixed(1)}% used`}>
          <span class="dtile-ctx-bar" aria-hidden="true"><span style=${{ transform: `translateX(${Math.min(100, Math.max(2, pct)) - 100}%)` }}></span></span>${Math.round(pct)}%</span>`}
        ${s.costUsd > 0 && html`<span class="dtile-m" title="Claude Code's own total for this conversation (all days)">${fmtCost(s.costUsd)}</span>`}
        ${s.queued > 0 && html`<span class="dtile-m" title="Prompts waiting for this turn to end">${s.queued} queued</span>`}
      </div>
      ${working && html`<button type="button" class="btn btn-ghost btn-sm dtile-stop" onClick=${stop} title="Stop this turn (queued prompts are dropped)"><${Icon} name="stop" size=${12} />Stop</button>`}
    </footer>`}

    <div class="dtile-reply" onClick=${() => input.current?.focus()}>
      <input ref=${input} class="dtile-input" type="text" value=${reply} spellcheck="false" autocomplete="off" enterkeyhint="send"
        placeholder=${working || s.status === 'waiting' ? 'Queue a reply…' : 'Reply…'} aria-label=${`Reply to ${title}`}
        onInput=${(e) => setReply(e.currentTarget.value)} onKeyDown=${onReplyKey} />
      ${note ? html`<span class=${cx('dtile-note', note.tone)} role="status">${note.text}</span>` : null}
      <button type="button" class="icon-btn sm dtile-send" aria-label="Send" disabled=${!reply.trim()} onClick=${submit}><${Icon} name="arrow-up" size=${14} /></button>
    </div>
  </article>`;
}

// ---------- view ----------
function Empty() {
  const archived = sessions.value.filter((s) => s.archived).length;
  return html`<div class="deck-empty">
    <div class="deck-empty-mark" aria-hidden="true"><${Icon} name="deck" size=${26} stroke=${1.4} /></div>
    <h2 class="deck-empty-title">The deck is clear</h2>
    <p class="deck-empty-sub">Every session you start shows up here as a live tile: what it is doing, what it needs from you, and a box to reply without opening it.</p>
    <div class="deck-empty-actions">
      <button class="btn btn-primary" onClick=${() => { newSessionOpen.value = true; }}><${Icon} name="plus" size=${15} />New session</button>
      <span class="deck-keys"><span class="kbd">${mod}</span><span class="kbd">N</span></span>
    </div>
    ${archived > 0 && html`<p class="deck-empty-note">${archived} archived session${archived > 1 ? 's are' : ' is'} kept in the sidebar's Archived group.</p>`}
  </div>`;
}

function Counts({ list }) {
  const n = (st) => list.filter((s) => displayStatus(s) === st).length;
  const parts = [[n('waiting'), 'waiting', 'need you', 'needs you'], [n('working'), 'working', 'working', 'working'], [n('error'), 'error', 'errors', 'error'],
    [list.length - n('waiting') - n('working') - n('error'), 'idle', 'idle', 'idle']].filter((p) => p[0] > 0);
  return html`<p class="deck-counts tnum">${parts.map(([c, st, many, one], i) => html`${i ? html`<span class="dtile-sep" aria-hidden="true">·</span>` : null}<span class="deck-count"><span class=${cx('dot', st)} aria-hidden="true"></span>${c} ${c === 1 ? one : many}</span>`)}</p>`;
}

export function DeckView() {
  useTick(30000);
  const list = deckOrder(sessions.value);
  useLiveItems(list);
  const grid = useRef(null);
  const phone = isPhone.value;
  // desktop: land on the last focused tile (or the first), so arrows work straight away
  useEffect(() => {
    if (phone) return;
    const tiles = tilesIn(grid.current);
    const t = tiles.find((x) => x.dataset.sid === focusedId.value) || tiles[0];
    if (t && !grid.current.contains(document.activeElement)) t.focus({ preventScroll: false });
  }, []);
  // arrows / Enter / "/" also work when focus is on the deck itself rather than a tile
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('.dtile, input, textarea, button')) return;
    if (e.key.startsWith('Arrow') || e.key === '/' || e.key === 'Enter') {
      const t = tilesIn(grid.current).find((x) => x.dataset.sid === focusedId.value) || tilesIn(grid.current)[0];
      if (t) { e.preventDefault(); focusTile(t); }
    }
  };
  return html`<section class=${cx('view view-deck', phone && 'is-phone')} aria-label="Deck" onKeyDown=${onKey}>
    <header class="deck-head">
      <div class="deck-head-text">
        <h1 class="view-title">Deck</h1>
        ${list.length ? html`<${Counts} list=${list} />` : html`<p class="view-sub">Every session at a glance.</p>`}
      </div>
      ${!phone && list.length > 0 && html`<div class="deck-hints" aria-hidden="true">
        <span><span class="kbd">↑↓←→</span> move</span>
        <span><span class="kbd">Enter</span> open</span>
        <span><span class="kbd">/</span> reply</span>
      </div>`}
      ${list.length > 0 && html`<button class="btn btn-sm deck-new" onClick=${() => { newSessionOpen.value = true; }} aria-label="New session"><${Icon} name="plus" size=${14} />${phone ? null : 'New'}</button>`}
    </header>
    <div class="deck-scroll">
      ${list.length ? html`<div ref=${grid} class="deck-grid">${list.map((s) => html`<${Tile} key=${s.id} s=${s} />`)}</div>` : html`<${Empty} />`}
    </div>
  </section>`;
}
