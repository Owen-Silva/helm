// Owner: lane conversation (D). Exports ChatView (transcript for the active session).
// Items → render units (tool runs collapse into "Worked for … · N tool calls" groups; subagent
// children nest under their Agent card), windowed to the last ~150 units, stick-to-bottom
// scrolling, pinned request cards, a todo strip while a turn runs, and helm:reveal handling.
// Round 3: per-pane sessions (split view), read-only external transcripts, Ctrl+F find (find.js),
// message actions (actions.js) and server-side paging ("Show earlier" → sessions.history { before }).
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'preact/hooks';
import { signal } from '@preact/signals';
import { html } from '../lib/html.js';
import { leaveRef } from '../lib/motion.js';
import { TopScrim } from '../lib/top-scrim.js';   // top-row hints: the lightbox scrim darkens the window's top row
import { Markdown } from '../lib/markdown.js';
import {
  activeSession, activeId, sessions, itemsBySession, hasMoreBySession, loadEarlier, send, toast,
  externalSessions, externalItems, externalHasMore, loadExternalEarlier, itemsOf, externalItemsOf, holdItems,
} from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { ToolRow, kids, descendants, describe, sessionBusy, spinner } from './tools.js';
import { RequestItem } from './requests.js';
import { ShellCard } from './shell.js';
import { TodoList, CopyBtn } from './views.js';
import { isOpen, toggle, setOpen, now, useTicker } from './state.js';
import { memo, fmtDuration, fmtElapsedShort, fmtCost, fmtTime, plural, basename, copyText, resultText } from './util.js';
import { FindBar, findMatches, paintHighlights, clearHighlights } from './find.js';
import { foldRewound, RewoundGroup } from './rewound.js';
import { agentsRunningOf, agentsLabel } from '../lib/session-status.js';
import { UserActions, ActsMenu, EditBox, ActionHost, ActBtn, plainText, useLongPress, editing, actsOpen } from './actions.js';
import { RestartNote } from './restart-note.js'; // lane restart: what the last Helm restart cut off here, with Continue

const PAGE = 150;
const isAgent = (n) => n === 'Agent' || n === 'Task';
const lightbox = signal(null);

// ---------------- build render units ----------------
function build(items, session, limit, hasMore = false) {
  const sid = session?.id || '_';
  const agentIds = new Set();
  for (const it of items) if (it.type === 'tool' && isAgent(it.name)) agentIds.add(it.toolUseId);
  const kmap = {}, top = [], queued = [];
  for (const it of items) {
    if (it.parentToolUseId && agentIds.has(it.parentToolUseId) && it.type !== 'request') { (kmap[it.parentToolUseId] ||= []).push(it); continue; }
    if (it.type === 'user' && it.queued) { queued.push(it); continue; }
    top.push(it);
  }
  kids.set(sid, kmap);
  const hidden = Math.max(0, top.length - limit);
  const vis = hidden ? top.slice(hidden) : top;
  let lastResult = -1;
  vis.forEach((it, i) => { if (it.type === 'result') lastResult = i; });
  const busy = !!session && (session.status === 'working' || session.status === 'waiting');

  const units = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const tools = run.items.filter((i) => i.type === 'tool');
    if (tools.length >= 2) {
      const desc = [];
      for (const t of tools) if (isAgent(t.name)) descendants(t.toolUseId, desc);
      units.push({ kind: 'group', id: run.items[0].id, items: run.items, live: run.live, desc });
    } else run.items.forEach((it) => units.push({ kind: 'item', item: it, live: run.live }));
    run = null;
  };
  vis.forEach((it, idx) => {
    const live = busy && idx > lastResult;
    if (it.type === 'tool' || (it.type === 'thinking' && run)) {
      if (!run) run = { items: [], live };
      run.items.push(it); run.live = live;
    } else { flush(); units.push({ kind: 'item', item: it, live, next: vis[idx + 1] }); }
  });
  flush();
  for (const q of queued) units.push({ kind: 'item', item: q, live: false });

  let todos = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'tool' && it.name === 'TodoWrite' && !it.parentToolUseId) { todos = it.input?.todos || null; break; }
  }
  return { units: foldRewound(units, items, hasMore), hidden, busy, todos, top };
}

// ---------------- items ----------------
function UserMsgImpl({ item, sid, ro }) {
  const key = `${sid}:${item.id}`;
  // a prompt Claude actually got: edit / fork / rewind apply (not one folded into a running turn: no prompt line of its own)
  const full = !ro && !item.queued && !item.cancelled && item.steer !== 'pending' && item.steer !== 'seen';
  const isEditing = full && editing.value === key;
  const lp = useLongPress(() => { if (full) actsOpen.value = key; });
  const atts = item.attachments || [];
  const imgs = atts.filter((a) => a.kind === 'image' && a.dataUrl);
  const files = atts.filter((a) => !(a.kind === 'image' && a.dataUrl));
  const cancelled = !!item.cancelled && !item.queued;
  return html`<div class=${'msg-user' + (item.queued ? ' queued' : '') + (cancelled ? ' cancelled' : '') + (item.steer && !cancelled ? ' steered' : '') + (isEditing ? ' editing' : '')} data-item-id=${item.id}>
    ${item.helmNote ? html`<div class="helm-note" title="Helm added this note for Claude to the message below"><${Icon} name="info" size=${12} /><span>${item.helmNote}</span></div>` : null}
    ${imgs.length ? html`<div class="att-imgs">${imgs.map((a) => html`<button type="button" class="att-img" title=${a.name} onClick=${() => { lightbox.value = a; }}>
      <img src=${a.dataUrl} alt=${a.name || 'image'} loading="lazy" /></button>`)}</div>` : null}
    ${files.length ? html`<div class="att-files">${files.map((a) => html`<span class="att-file" title=${a.path || a.name}>
      <${Icon} name=${a.kind === 'image' ? 'image' : 'file'} size=${13} /><span>${a.name || basename(a.path)}</span></span>`)}</div>` : null}
    ${isEditing ? html`<${EditBox} item=${item} sid=${sid} />` : item.text ? html`<div class="bubble" ...${full ? lp : {}}>${item.text}</div>` : null}
    <div class="msg-meta">
      ${item.queued ? html`<span class="queued-tag"><${Icon} name="clock" size=${12} />Queued · sends when this turn ends</span>`
        : cancelled ? html`<span class="queued-tag" title="The turn was interrupted before this prompt was sent"><${Icon} name="ban" size=${12} />Not sent</span>`
        : item.steer === 'pending' ? html`<span class="queued-tag steer-tag" data-steer="pending" title="Sent into the running turn. Nothing was stopped."><${Icon} name="clock" size=${12} />Claude reads this at its next step</span>`
        : item.steer === 'seen' ? html`<span class="steer-tag" data-steer="seen" title=${'Claude read this mid-turn, after the step it was on' + (item.seenAt ? ` (${fmtTime(item.seenAt)})` : '')}><${Icon} name="check" size=${12} />Seen mid-turn · ${fmtTime(item.ts)}</span>`
        : item.steer === 'after' ? html`<span class="steer-tag" data-steer="after" title="Claude was already finishing its reply, so this ran as the next turn"><${Icon} name="arrow-down" size=${12} />Sent after the turn · ${fmtTime(item.ts)}</span>`
        : html`<span class="msg-time">${fmtTime(item.ts)}</span>`}
      ${item.text && !isEditing ? html`<${UserActions} item=${item} sid=${sid} full=${full} />` : null}
    </div>
    ${full && actsOpen.value === key ? html`<${ActsMenu} item=${item} sid=${sid} />` : null}
  </div>`;
}
const UserMsg = memo(UserMsgImpl);

function AssistantMsgImpl({ item }) {
  return html`<div class=${'msg-assistant' + (item.streaming ? ' streaming' : '')} data-item-id=${item.id}>
    <${Markdown} text=${item.text || ''} class="prose" />
    ${!item.streaming && item.text ? html`<div class="msg-meta">
      <${ActBtn} icon="copy" label="Copy (markdown)" run=${() => copyText(item.text)} />
      <${ActBtn} icon="type" label="Copy as plain text" run=${() => copyText(plainText(item.text))} />
    </div>` : null}
  </div>`;
}
const AssistantMsg = memo(AssistantMsgImpl);

function ThinkingImpl({ item, dur, sid }) {
  const key = `${sid}:${item.id}`;
  const open = isOpen(key, false);
  const streaming = item.streaming && sessionBusy(sid);
  const label = item.redacted ? 'Thinking (redacted)' : streaming ? 'Thinking…' : dur >= 1000 ? `Thought for ${fmtDuration(dur)}` : 'Thought';
  return html`<div class=${'thinking' + (open ? ' open' : '')} data-item-id=${item.id}>
    <button type="button" class="thinking-line" aria-expanded=${open} onClick=${() => !item.redacted && toggle(key, false)}>
      ${streaming ? spinner() : html`<${Icon} name="thought" size=${14} />`}<span>${label}</span>
      ${item.redacted ? null : html`<span class="trow-chev"><${Icon} name="chevron-right" size=${11} /></span>`}
    </button>
    ${open && item.text ? html`<div class="thinking-text">${item.text}</div>` : null}
  </div>`;
}
const Thinking = memo(ThinkingImpl);

// Claude Code's internal diagnostics ("[ede_diagnostic] result_type=user …": any line led by a
// bracketed snake_case tag) never reach the transcript. The engine strips them too; this covers
// items saved before that fix.
const INTERNAL_TAG_LINE = /^\s*\[[a-z][a-z0-9]*(?:_[a-z0-9]+)+\]/;
const cleanErrorText = (s) => String(s ?? '').split(/\r?\n/).filter((l) => !INTERNAL_TAG_LINE.test(l)).join('\n').trim();

function SystemImpl({ item, onRetry }) {
  const st = item.subtype;
  if (st === 'compact') return html`<div class="sys-divider" data-item-id=${item.id}><span>${item.text || 'Conversation compacted'}</span></div>`;
  if (st === 'error') {
    // An error that was nothing but diagnostics (an early interrupt, saved before the engine fix)
    // says nothing to act on: no card, no Retry.
    if (typeof item.text === 'string' && item.text.trim() && !cleanErrorText(item.text)) return null;
    return html`<div class="sys-error" data-item-id=${item.id}>
    <${Icon} name="alert" size=${14} /><span class="sys-error-text">${cleanErrorText(item.text) || 'Something went wrong.'}</span>
    <span class="grow" /><button type="button" class="btn btn-sm" onClick=${onRetry}><${Icon} name="retry" size=${13} />Retry</button></div>`;
  }
  if (st === 'interrupted') return html`<div class="sys-line" data-item-id=${item.id}><${Icon} name="stop" size=${12} />${item.text || 'Interrupted'}</div>`;
  // lane detach: a session kept running through a Helm restart (or why it could not be)
  if (st === 'kept') return html`<div class="sys-line kept" data-item-id=${item.id} title=${item.detail || item.text || ''}><${Icon} name="check" size=${12} />${item.text || 'Kept running through the restart'}</div>`;
  if (st === 'kept-failed') return html`<div class="sys-line kept-failed" data-item-id=${item.id} title=${item.text || ''}><${Icon} name="alert" size=${12} />${item.text || 'Could not keep Claude Code running through the restart'}</div>`;
  // Helm closed without a restart it performed: the broker stopped this session's CLI (the reason is the tooltip)
  if (st === 'closed-stopped') return html`<div class="sys-line closed-stopped" data-item-id=${item.id} title=${item.detail || item.text || ''}><${Icon} name="stop" size=${12} />${item.text || 'Stopped when Helm closed'}</div>`;
  // the production guard could not read prod-guard.json, so every push asks (main/engine/prod-guard.js)
  if (st === 'guard-warn') return html`<div class="sys-line guard-warn" data-item-id=${item.id} title=${item.text || ''}><${Icon} name="alert" size=${12} />${item.text || 'Production guard: prod-guard.json could not be read, so every push asks'}</div>`;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return null;
  return html`<div class=${'sys-line' + (st === 'init' ? ' init' : '')} data-item-id=${item.id} title=${text}>${text}</div>`;
}
const SystemItem = memo(SystemImpl);

// result.subtype → a short human reason ("error_max_turns" → "hit the turn limit")
const RESULT_REASON = {
  error_during_execution: 'error during execution', error_max_turns: 'hit the turn limit',
  error_max_budget_usd: 'hit the budget limit', error_max_structured_output_retries: 'could not produce valid output',
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// `agents`: background agents still running, passed only to the latest turn's line once that turn has ended.
function ResultImpl({ item, agents = 0 }) {
  const u = item.usage || {};
  const tok = (v) => (num(v) == null ? '?' : num(v).toLocaleString());
  const tip = `Input ${tok(u.input)} · output ${tok(u.output)} · cache read ${tok(u.cacheRead)} · cache write ${tok(u.cacheWrite)} tokens`;
  const st = typeof item.subtype === 'string' ? item.subtype : '';
  // A turn the user interrupted (engine sets interrupted: true) is a calm muted line: the
  // "Interrupted" system line above already says why; no alert, no error reason.
  const stopped = item.interrupted === true;
  const bad = !stopped && (item.isError === true || st.startsWith('error'));
  const dur = fmtDuration(num(item.durationMs));
  const parts = [bad || stopped ? (dur ? `Stopped after ${dur}` : 'Stopped') : (dur ? `Worked for ${dur}` : 'Done')];
  if (bad) parts.push(RESULT_REASON[st] || (st.startsWith('error_') ? st.slice(6).replace(/_/g, ' ') : 'error'));
  if (num(item.numTurns)) parts.push(plural(item.numTurns, 'turn'));
  const cost = stopped && !(num(item.costUsd) > 0) ? null : fmtCost(num(item.costUsd));
  if (cost) parts.push(cost);
  return html`<div class=${'turn-end' + (bad ? ' bad' : '')} data-item-id=${item.id} title=${tip}>
    ${bad ? html`<${Icon} name="alert" size=${13} />` : null}<span>${parts.join(' · ')}</span>${agents > 0 ? html`<span class="turn-end-agents"><span class="dot working live"></span>${agentsLabel(agents)}</span>` : null}</div>`;
}
const ResultItem = memo(ResultImpl);

// ---------------- tool group ----------------
function GroupElapsed({ from }) { useTicker(true); return html`<span>${fmtElapsedShort(Math.max(0, now.value - from))}</span>`; }

function ToolGroupImpl({ g, sid, cwd }) {
  const key = `${sid}:g:${g.id}`;
  const open = isOpen(key, g.live);
  const tools = g.items.filter((i) => i.type === 'tool');
  const total = tools.length + g.desc.filter((d) => d.type === 'tool').length;
  const start = Math.min(...g.items.map((i) => i.startedAt || i.ts));
  const end = Math.max(...g.items.map((i) => i.endedAt || i.ts));
  const files = new Set(tools.filter((t) => ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t.name)).map((t) => t.input?.file_path || t.input?.notebook_path));
  const runningTool = [...tools].reverse().find((t) => t.status === 'running');
  const latest = runningTool || (g.live ? tools[tools.length - 1] : null);
  const issues = tools.filter((t) => t.status === 'denied' || (t.status === 'error' && !t.interrupted)).length;
  const liveDesc = g.live && latest ? describe(latest, cwd) : null;
  const waitingOnYou = g.live && sessions.value.find((x) => x.id === sid)?.status === 'waiting'; // a request card below needs the user: nothing is working
  return html`<div class=${'tgroup' + (open ? ' open' : '') + (g.live ? ' live' : '')}>
    <button type="button" class="tgroup-head" aria-expanded=${open} onClick=${() => toggle(key, g.live)}>
      ${g.live ? (waitingOnYou ? html`<${Icon} name="clock" size=${13} />` : spinner()) : html`<span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>`}
      ${g.live ? html`<span class="tgroup-title">${waitingOnYou ? 'Waiting for you' : html`Working · <${GroupElapsed} from=${start} />`}</span>
          <span class="tgroup-meta">· ${plural(total, 'tool call')}${files.size ? ` · ${plural(files.size, 'file')} changed` : ''}</span>`
        // Not "Worked for …": the turn's result row says that, with the turn's real duration.
        : html`<span class="tgroup-title">${plural(total, 'tool call')}</span>
          <span class="tgroup-meta">${files.size ? `· ${plural(files.size, 'file')} changed ` : ''}· ${fmtDuration(Math.max(end - start, 0)) || '1s'}</span>`}
      ${issues ? html`<span class="trow-flag denied">${issues} blocked</span>` : null}
      ${!open && liveDesc ? html`<span class="tgroup-now">${liveDesc.verb} ${liveDesc.target}</span>` : null}
      ${g.live ? html`<span class="grow" /><span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>` : null}
    </button>
    ${open ? html`<div class="tgroup-body">${g.items.map((it, i) => (it.type === 'tool'
        ? html`<${ToolRow} key=${it.id} item=${it} cwd=${cwd} sid=${sid} desc=${isAgent(it.name) ? descendants(it.toolUseId) : undefined} />`
        : html`<${Thinking} key=${it.id} item=${it} sid=${sid} dur=${(g.items[i + 1]?.ts ?? it.ts) - it.ts} />`))}</div>`
      : runningTool ? html`<div class="tgroup-body peek"><${ToolRow} item=${runningTool} cwd=${cwd} sid=${sid}
          desc=${isAgent(runningTool.name) ? descendants(runningTool.toolUseId) : undefined} /></div>` : null}
  </div>`;
}
const arrEq = (a, b) => a === b || (a && b && a.length === b.length && a.every((x, i) => x === b[i]));
const ToolGroup = memo(ToolGroupImpl, (a, b) => a.sid === b.sid && a.cwd === b.cwd && a.g.live === b.g.live && arrEq(a.g.items, b.g.items) && arrEq(a.g.desc, b.g.desc));

function Unit({ u, sid, cwd, ro, onRetry, agents }) {
  if (u.kind === 'rewound') return html`<${RewoundGroup} u=${u} sid=${sid} renderUnit=${(x) => html`<${Unit} key=${x.kind === 'group' ? 'g' + x.id : x.item.id} u=${x} sid=${sid} cwd=${cwd} ro=${ro} onRetry=${onRetry} />`} />`;
  if (u.kind === 'group') return html`<${ToolGroup} g=${u} sid=${sid} cwd=${cwd} />`;
  const it = u.item;
  switch (it.type) {
    case 'user': return html`<${UserMsg} item=${it} sid=${sid} ro=${ro} />`;
    case 'assistant': return html`<${AssistantMsg} item=${it} />`;
    case 'thinking': return html`<${Thinking} item=${it} sid=${sid} dur=${u.next ? u.next.ts - it.ts : 0} />`;
    case 'tool': return html`<div class="tsolo"><${ToolRow} item=${it} cwd=${cwd} sid=${sid} desc=${isAgent(it.name) ? descendants(it.toolUseId) : undefined} /></div>`;
    case 'request': return html`<${RequestItem} item=${it} sid=${sid} cwd=${cwd} />`;
    case 'system': return html`<${SystemItem} item=${it} onRetry=${onRetry} />`;
    case 'result': return html`<${ResultItem} item=${it} agents=${agents || 0} />`;
    case 'shell': return html`<${ShellCard} item=${it} sid=${sid} ro=${ro} />`;
    default: return null;
  }
}

// ---------------- todo strip ----------------
function TodoStrip({ todos, sid }) {
  const key = `${sid}:todostrip`;
  const open = isOpen(key, false);
  const done = todos.filter((t) => t.status === 'completed').length;
  const cur = todos.find((t) => t.status === 'in_progress');
  return html`<div class=${'todo-strip' + (open ? ' open' : '')}>
    <button type="button" class="todo-strip-line" aria-expanded=${open} onClick=${() => toggle(key, false)}>
      <span class="todo-bar" aria-hidden="true">${todos.map((t) => html`<i class=${t.status} />`)}</span>
      <span class="todo-count">${done}/${todos.length}</span>
      <span class="todo-cur">${cur ? cur.activeForm || cur.content : done === todos.length ? 'All done' : 'Up next: ' + (todos.find((t) => t.status === 'pending')?.content || '')}</span>
      <span class="trow-chev"><${Icon} name="chevron-down" size=${12} /></span>
    </button>
    ${open ? html`<div class="todo-strip-list"><${TodoList} todos=${todos} compact=${true} /></div>` : null}
  </div>`;
}

// ---------------- empty ----------------
const SUGGESTIONS = [
  'Explain how this codebase is organised',
  'Find and fix the most likely bug in what I changed last',
  'Review my uncommitted changes',
  'Run the tests and summarise any failures',
];
function insertIntoComposer(text) { window.dispatchEvent(new CustomEvent('helm:composer-insert', { detail: { text } })); }
// transcript not loaded yet (lane helm-premium): the conversation's shape (a question, an answer, a question)
// instead of a lone spinner, so the column holds its layout and the real messages land where the eye already is
function ChatSkeleton() {
  return html`<div class="chat-skel" role="status" aria-label="Loading the conversation">
    <div class="chat-skel-user"><i style=${{ width: '46%' }}></i></div>
    <div class="chat-skel-lines"><i style=${{ width: '92%' }}></i><i style=${{ width: '84%' }}></i><i style=${{ width: '61%' }}></i></div>
    <div class="chat-skel-user"><i style=${{ width: '32%' }}></i></div>
    <div class="chat-skel-lines"><i style=${{ width: '88%' }}></i><i style=${{ width: '47%' }}></i></div>
  </div>`;
}
function Empty({ session }) {
  if (!session) return html`<div class="chat-empty"><div class="chat-empty-title">No session open</div><div class="chat-empty-sub">Pick a chat on the left, or start a new one.</div></div>`;
  return html`<div class="chat-empty">
    <div class="chat-empty-title">What should we work on in ${session.project || basename(session.cwd)}?</div>
    <div class="chat-empty-sub">${session.cwd}</div>
    <div class="chat-empty-list">${SUGGESTIONS.map((s) => html`<button type="button" class="chat-sugg" onClick=${() => insertIntoComposer(s)}>${s}</button>`)}</div>
  </div>`;
}

function Lightbox() {
  const a = lightbox.value;
  const leave = useMemo(() => leaveRef('fade', 's'), []);   // the exit (lib/motion.js)
  if (!a) return null;
  return html`<div ref=${leave} class="lightbox" onClick=${() => { lightbox.value = null; }} role="dialog" aria-label=${a.name || 'Image'}>
    <${TopScrim} /><img src=${a.dataUrl} alt=${a.name || ''} /><div class="lightbox-name">${a.name}</div></div>`;
}

// ---------------- the view ----------------
// Props: `sid` shows that session (split view renders two ChatViews); without it the active session.
// `external` = a terminal Claude Code session's claudeSessionId: read-only transcript, no actions but Copy.
export function ChatView({ sid: forSid = null, external = null } = {}) {
  const readOnly = !!external;
  let session, items, hasMore, more;
  if (external) {
    const ext = externalSessions.value.find((x) => x.claudeSessionId === external) || {};
    // status follows the terminal session's liveness: tool groups / thinking rows after the last result
    // animate (and their clocks tick) only while it is live; once it goes idle nothing spins or ticks.
    session = { id: 'ext:' + external, status: ext.active ? 'working' : 'idle', agentsRunning: ext.agentsRunning || 0, cwd: ext.cwd || '', project: ext.project || '', title: ext.title || '' };
    items = externalItemsOf(external).value || [];   // this transcript only (not every session's updates)
    hasMore = !!externalHasMore.value[external];
    more = () => loadExternalEarlier(external);
  } else {
    session = forSid ? sessions.value.find((x) => x.id === forSid) || null : activeSession.value;
    items = (session && itemsOf(session.id).value) || [];   // this session only: other sessions streaming don't re-render it
    hasMore = !!(session && hasMoreBySession.value[session.id]);
    more = () => (session ? loadEarlier(session.id) : Promise.resolve(0));
  }
  // not loaded yet (first open, or dropped by the bounded item cache in store.js): a spinner, not the new-chat screen
  const loaded = external ? externalItemsOf(external).value !== undefined : !session || itemsOf(session.id).value !== undefined;
  const sid = session?.id || null;
  const cwd = session?.cwd || '';
  const active = readOnly || !sid || sid === activeId.value;   // focused pane: owns Ctrl+F and helm:reveal
  const getItems = () => (external ? externalItems.value[external] || [] : (sid && itemsBySession.value[sid]) || []);

  useEffect(() => holdItems(sid), [sid]);   // a mounted transcript keeps its items (store.js bounded cache)
  const [limit, setLimit] = useState(PAGE);
  const [pill, setPill] = useState(null);          // null | 'latest' | 'request'
  const [olderBusy, setOlderBusy] = useState(false);
  const [find, setFind] = useState(null);          // null | { q, idx }
  const scroller = useRef(null), content = useRef(null), findInput = useRef(null);
  const atBottom = useRef(true);
  const seenReq = useRef(new Set());
  const lastLen = useRef(0);
  const prepend = useRef(null);
  const paneKey = useRef('p' + Math.random().toString(36).slice(2)).current;
  const built = build(items, session, limit, hasMore);
  // Once the turn has ended, the latest "Worked for …" line also says how many agents are still running.
  const agentsNow = session && session.status !== 'working' ? agentsRunningOf(session) : 0;
  let lastResultId = null;
  if (agentsNow) for (let i = built.units.length - 1; i >= 0; i--) { const x = built.units[i]; if (x.item && x.item.type === 'result') { lastResultId = x.item.id; break; } }
  const view = useRef(built); view.current = built;
  const activeRef = useRef(active); activeRef.current = active;
  const findQ = find?.q || '';
  const matches = useMemo(() => (find ? findMatches(items, findQ) : []), [!!find, findQ, items]);
  const findRef = useRef(find); findRef.current = find;
  const matchesRef = useRef(matches); matchesRef.current = matches;

  const toBottom = (smooth) => {
    const el = scroller.current; if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); else el.scrollTop = el.scrollHeight;
  };
  // Pin to the bottom at frame time, once per frame, instead of inside the render. A scrollTop write
  // outside a frame makes Blink wait for the compositor's in-flight commit (LayerTreeHost::
  // WaitForCommitCompletion). The hidden --test window gets only ~2 frames a second, so each streamed
  // delta froze the renderer up to ~1 s there (trace: 30 x ~1000 ms, 26 s chains); visible, ~1 frame.
  // rAF still runs before the frame paints, so the pinned position shows in the same frame as the text.
  const pinRaf = useRef(0);
  const pinSoon = () => {
    if (pinRaf.current) return;
    pinRaf.current = requestAnimationFrame(() => { pinRaf.current = 0; if (atBottom.current) toBottom(false); });
  };
  useEffect(() => () => cancelAnimationFrame(pinRaf.current), []);
  const pendingCardOffscreen = () => {
    const el = scroller.current; if (!el) return false;
    const box = el.getBoundingClientRect();
    for (const c of el.querySelectorAll('.req-card')) { const r = c.getBoundingClientRect(); if (r.top > box.bottom - 40 || r.bottom < box.top + 20) return true; }
    return false;
  };
  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const next = pendingCardOffscreen() ? 'request' : atBottom.current ? null : 'latest';
    setPill((p) => (p === next ? p : next));
  };

  // session switch: reset window + stick to bottom
  useLayoutEffect(() => {
    setLimit(PAGE); atBottom.current = true; lastLen.current = 0;
    seenReq.current = new Set(items.filter((i) => i.type === 'request').map((i) => i.id));
    toBottom(false); setPill(null);
  }, [sid]);

  // after every render: keep pinned to bottom, react to new user messages / requests, restore prepend offset
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (prepend.current != null) {   // keep the anchor item where it was on screen (immune to native scroll anchoring)
      const p = prepend.current, node = p.id ? el.querySelector(`[data-item-id="${CSS.escape(p.id)}"]`) : null;
      if (node) el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - p.top;
      if (!p.keep) prepend.current = null;
      lastLen.current = items.length; return;
    }
    if (items.length > lastLen.current) {
      const fresh = items.slice(lastLen.current);
      if (lastLen.current && fresh.some((i) => i.type === 'user')) atBottom.current = true;
      const req = fresh.find((i) => i.type === 'request' && i.status === 'pending' && !seenReq.current.has(i.id));
      fresh.forEach((i) => i.type === 'request' && seenReq.current.add(i.id));
      lastLen.current = items.length;
      if (req) { requestAnimationFrame(() => el.querySelector(`[data-request-id="${CSS.escape(req.requestId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); return; }
    }
    if (atBottom.current) pinSoon();
  });

  // content growth (streaming text, expanding rows, images loading) while pinned
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (atBottom.current) toBottom(false); else onScroll(); });
    ro.observe(content.current);
    if (scroller.current) ro.observe(scroller.current);   // the viewport shrinks too (task strip appears, window resize)
    return () => ro.disconnect();
  }, []);

  // Expand whatever hides an item (agent cards up the chain, its tool group, the render window), then call
  // after(node) once it is in the DOM. Used by helm:reveal and by find.
  const revealItem = (id, after, { openRow = false, query = '' } = {}) => {
    const all = getItems();
    const it = all.find((i) => i.id === id); if (!it) return;
    const byTool = new Map(all.filter((i) => i.toolUseId).map((i) => [i.toolUseId, i]));
    let topItem = it;
    while (topItem.parentToolUseId && byTool.get(topItem.parentToolUseId)) {
      const parent = byTool.get(topItem.parentToolUseId);
      setOpen(`${sid}:${parent.id}:kids`, true);
      topItem = parent;
    }
    if (openRow && it.type === 'tool') {
      if (isAgent(it.name)) {
        const q = query.toLowerCase();
        if (q && String(it.input?.prompt || '').toLowerCase().includes(q)) setOpen(`${sid}:${it.id}:prompt`, true);
        if (q && resultText(it.result).toLowerCase().includes(q)) setOpen(`${sid}:${it.id}:res`, true);
      } else setOpen(`${sid}:${it.id}`, true);
    }
    const v = view.current;
    const idx = v.top.indexOf(topItem);
    if (idx >= 0 && idx < v.hidden) setLimit((l) => l + (v.hidden - idx) + 10);
    atBottom.current = false;
    let tries = 0;
    const go = () => {
      const unit = view.current.units.find((u) => u.kind === 'group' && u.items.includes(topItem));
      if (unit && !isOpen(`${sid}:g:${unit.id}`, unit.live)) setOpen(`${sid}:g:${unit.id}`, true);
      const node = scroller.current?.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
      if (!node) { if (tries++ < 12) requestAnimationFrame(go); return; }
      after(node);
    };
    requestAnimationFrame(go);
  };
  const flash = (node) => { node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1700); };

  // helm:reveal { toolUseId, sessionId? } → expand the containing group / agent cards, scroll, flash
  useEffect(() => {
    const onReveal = (e) => {
      const id = e.detail?.toolUseId; if (!id) return;
      if (e.detail?.sessionId ? e.detail.sessionId !== sid : !activeRef.current) return;
      const it = getItems().find((i) => i.toolUseId === id); if (!it) return;
      revealItem(it.id, (node) => {
        const target = node.closest('[data-tool-use-id]') || node;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(target);
      });
    };
    window.addEventListener('helm:reveal', onReveal);
    return () => window.removeEventListener('helm:reveal', onReveal);
  }, [sid]);

  // ---- find (Ctrl+F) ----
  const paint = (scroll) => {
    const f = findRef.current, root = content.current;
    if (!f || !f.q || !root) { clearHighlights(paneKey); return; }
    const m = matchesRef.current[f.idx];
    const node = m ? root.querySelector(`[data-item-id="${CSS.escape(m.id)}"]`) : null;
    const cur = paintHighlights(paneKey, root, f.q, node, m?.occ || 0);
    if (!scroll || !node) return;
    const el = scroller.current; if (!el) return;
    const box = el.getBoundingClientRect();
    const r = cur ? cur.getBoundingClientRect() : node.getBoundingClientRect();
    atBottom.current = false;
    el.scrollTop += (r.top + Math.min(r.height, box.height) / 2) - (box.top + box.height / 2);
    if (!cur) flash(node);
  };
  const goTo = (idx, list = matchesRef.current) => {
    if (!list.length) { paint(false); return; }
    const n = ((idx % list.length) + list.length) % list.length;
    setFind((f) => (f ? { ...f, idx: n } : f));
    findRef.current = { ...(findRef.current || {}), idx: n };
    matchesRef.current = list;
    revealItem(list[n].id, () => paint(true), { openRow: true, query: findRef.current.q || '' });
  };
  const openFind = () => {
    const sel = String(globalThis.getSelection?.() || '').trim();
    const seed = sel && sel.length <= 80 && !sel.includes('\n') ? sel : null;
    setFind((f) => (f ? (seed ? { q: seed, idx: 0 } : f) : { q: seed || '', idx: 0 }));
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  };
  const closeFind = () => { setFind(null); clearHighlights(paneKey); };
  useEffect(() => {
    const onKey = (e) => {
      if (!activeRef.current || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      if (!scroller.current?.isConnected) return;
      e.preventDefault(); e.stopPropagation();
      openFind();
    };
    addEventListener('keydown', onKey, true);
    return () => { removeEventListener('keydown', onKey, true); clearHighlights(paneKey); };
  }, []);
  // typing: jump to the newest match (the bottom of the conversation is where the user usually is)
  useEffect(() => { if (find) goTo(matches.length - 1, matches); }, [findQ]);
  useEffect(() => { if (find) { setFind(null); clearHighlights(paneKey); } }, [sid]);
  // keep highlights in step with re-renders (streaming, expanding rows); no scrolling here
  useEffect(() => {
    if (!find) return undefined;
    const raf = requestAnimationFrame(() => paint(false));
    return () => cancelAnimationFrame(raf);
  });
  const searchOlder = async () => {
    if (olderBusy) return;
    setOlderBusy(true);
    const q = findQ, before = findMatches(getItems(), q).length;
    try {
      for (let k = 0; k < 10; k++) {
        const n = await more();
        if (!n) break;
        setLimit((l) => l + n);
        if (findMatches(getItems(), q).length > before) break;
      }
      const list = findMatches(getItems(), q);
      const added = list.length - before;
      if (added > 0) goTo(added - 1, list);
      else toast({ title: 'No older matches', body: `Nothing earlier in this conversation mentions “${q}”.`, ms: 3000 });
    } catch (e) { toast({ title: 'Could not load older messages', error: e, kind: 'error' }); }
    finally { setOlderBusy(false); }
  };

  const onRetry = () => {
    const last = [...getItems()].reverse().find((i) => i.type === 'user' && !i.queued);
    if (!last || !sid || readOnly) return toast({ title: 'Nothing to retry', body: 'No earlier prompt in this session.', kind: 'info' });
    atBottom.current = true;
    send(sid, last.text, last.attachments?.length ? last.attachments : undefined).catch((e) => toast({ title: 'Retry failed', error: e, kind: 'error' }));
  };
  // "Show earlier": first widen the render window; past it, load the previous page from the engine.
  // the first item at or below the top edge, and its offset from the top of the scroller
  const anchorOf = (keep) => {
    const el = scroller.current; if (!el) return null;
    const top = el.getBoundingClientRect().top;
    const node = [...el.querySelectorAll('[data-item-id]')].find((n) => n.getBoundingClientRect().bottom > top + 1);
    return node ? { id: node.dataset.itemId, top: node.getBoundingClientRect().top - top, keep } : null;
  };
  const showEarlier = async () => {
    if (built.hidden) { prepend.current = anchorOf(false); setLimit((l) => l + PAGE); return; }
    if (!hasMore || olderBusy) return;
    setOlderBusy(true);
    prepend.current = anchorOf(true);   // held across the store update and the limit bump below
    try {
      const n = await more();
      if (prepend.current) prepend.current = { ...prepend.current, keep: false };
      if (n) setLimit((l) => l + n); else prepend.current = null;
    } catch (e) { prepend.current = null; toast({ title: 'Could not load earlier messages', error: e, kind: 'error' }); }
    finally { setOlderBusy(false); }
  };
  const jump = () => {
    if (pill === 'request') {
      const el = scroller.current?.querySelector('.req-card');
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else { atBottom.current = true; toBottom(true); }
  };

  const showTodos = !readOnly && built.busy && built.todos && built.todos.length && built.todos.some((t) => t.status !== 'completed');
  const earlier = built.hidden || hasMore;
  const idx = find && matches.length ? Math.min(find.idx, matches.length - 1) : 0;
  return html`<section class=${'chat' + (showTodos ? ' has-strip' : '') + (find ? ' has-find' : '') + (readOnly ? ' read-only' : '')} aria-label="Conversation">
    ${showTodos ? html`<${TodoStrip} todos=${built.todos} sid=${sid} />` : null}
    ${find ? html`<${FindBar} q=${findQ} count=${matches.length} index=${idx} inputRef=${findInput}
      onInput=${(q) => setFind({ q, idx: 0 })} onStep=${(d) => goTo(idx + d)} onClose=${closeFind}
      hasMore=${hasMore} onOlder=${searchOlder} olderBusy=${olderBusy} />` : null}
    <div class="chat-scroll" ref=${scroller} onScroll=${onScroll}>
      <div class="chat-col" ref=${content}>
        ${earlier ? html`<button type="button" class="show-earlier" onClick=${showEarlier} disabled=${olderBusy && !built.hidden}>
          ${olderBusy && !built.hidden ? 'Loading…' : built.hidden ? `Show earlier · ${plural(built.hidden, 'item')}` : 'Show earlier'}</button>` : null}
        ${!items.length
          ? (!loaded ? html`<${ChatSkeleton} />` : readOnly ? html`<div class="chat-empty"><div class="chat-empty-sub">No messages yet.</div></div>` : html`<${Empty} session=${session} />`)
          : built.units.map((u) => html`<${Unit} key=${u.kind === 'group' ? 'g' + u.id : u.kind === 'rewound' ? u.id : u.item.id} u=${u} sid=${sid} cwd=${cwd} ro=${readOnly} onRetry=${onRetry} agents=${u.item && u.item.id === lastResultId ? agentsNow : 0} />`)}
        ${!readOnly && session && session.restartNote ? html`<${RestartNote} key=${'rn' + session.restartNote.at} s=${session} />` : null}
      </div>
    </div>
    ${pill ? html`<button type="button" class=${'chat-pill' + (pill === 'request' ? ' req' : '')} onClick=${jump}>
      <${Icon} name=${pill === 'request' ? 'question' : 'arrow-down'} size=${13} />${pill === 'request' ? 'Claude needs your answer' : 'Jump to latest'}</button>` : null}
    <${Lightbox} />
    ${readOnly ? null : html`<${ActionHost} sid=${sid} />`}
  </section>`;
}
