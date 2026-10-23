// Owner: lane agent-drill (panels). The agent view: open any subagent from the Agents panel and read
// what it is actually doing: its prompt, its text, every tool call with input and result, and the
// agents it launched (click to drill deeper). Live while it runs.
//
// Data: agents.transcript { sessionId, agentId, before?, limit?, rev? } (docs/PROTOCOL.md, Round D).
// Live = a poll every 1.5 s while the agent runs and the window is visible: the engine answers
// { unchanged: true } for the same `rev` without parsing; a changed rev returns the newest items,
// merged into the list by id (ids are stable across reads).
// Items render with the conversation's own components (ToolRow from ui/chat/tools.js) so tool
// cards, diffs and markdown look exactly like the main chat.
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { html, Icon, cx, fmtDuration, fmtCost, splitLane, shortModel, dotClass, useNow } from './util.js';
import { rpc, fleetBySession, sessions } from '../lib/store.js';
import { Markdown } from '../lib/markdown.js';
import { ToolRow, kids, descendants, spinner } from '../chat/tools.js';
import { isOpen, toggle } from '../chat/state.js';
import { ActBtn, plainText } from '../chat/actions.js';
import { copyText } from '../chat/util.js';
import { ContextBar } from './fleet.js';
import { agentStateText } from '../lib/stall-limits.js';   // lane stall

// { sessionId, trail: [agentId, ...] } | null. The last id in the trail is the agent on screen.
export const agentView = signal(null);
export function openAgent(a, { from } = {}) {
  if (!a || !a.id) return;
  const cur = agentView.value;
  const trail = from && cur && cur.sessionId === a.sessionId ? [...cur.trail, a.id] : [a.id];
  agentView.value = { sessionId: a.sessionId, trail };
}
export function closeAgent() { agentView.value = null; }

const POLL_MS = 1500;
const FIRST_PAGE = 200;
const TAIL_PAGE = 60;
const isAgentName = (n) => n === 'Agent' || n === 'Task';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fetchTx = (p) => rpc('agents.transcript', p);

// The newest page replaces everything from its first item on; null = it does not overlap (reload).
function mergeTail(cur, page) {
  if (!page.length) return cur;
  if (!cur.length) return page;
  const idx = cur.findIndex((i) => i.id === page[0].id);
  return idx < 0 ? null : cur.slice(0, idx).concat(page);
}

function statusText(s) {
  return s === 'running' ? 'Running' : s === 'done' ? 'Done' : s === 'error' ? 'Failed' : s === 'stopped' ? 'Stopped' : 'Status unknown';
}

// ---------- items (markup mirrors ui/chat/index.js so chat.css styles them identically) ----------
function AssistantMsg({ item }) {
  return html`<div class=${'msg-assistant' + (item.streaming ? ' streaming' : '')} data-item-id=${item.id}>
    <${Markdown} text=${item.text || ''} class="prose" />
    ${!item.streaming && item.text ? html`<div class="msg-meta">
      <${ActBtn} icon="copy" label="Copy (markdown)" run=${() => copyText(item.text)} />
      <${ActBtn} icon="type" label="Copy as plain text" run=${() => copyText(plainText(item.text))} />
    </div>` : null}
  </div>`;
}

function Thinking({ item, sid, running, dur }) {
  const key = `${sid}:${item.id}`;
  const open = isOpen(key, false);
  const live = item.streaming && running;
  const label = item.redacted ? 'Thinking (redacted)' : live ? 'Thinking…' : dur >= 1000 ? `Thought for ${fmtDuration(dur)}` : 'Thought';
  return html`<div class=${'thinking' + (open ? ' open' : '')} data-item-id=${item.id}>
    <button type="button" class="thinking-line" aria-expanded=${open} onClick=${() => !item.redacted && toggle(key, false)}>
      ${live ? spinner() : html`<${Icon} name="thought" size=${14} />`}<span>${label}</span>
      ${item.redacted ? null : html`<span class="trow-chev"><${Icon} name="chevron-right" size=${11} /></span>`}
    </button>
    ${open && item.text ? html`<div class="thinking-text">${item.text}</div>` : null}
  </div>`;
}

function SystemLine({ item }) {
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (item.subtype === 'compact') return html`<div class="sys-divider" data-item-id=${item.id}><span>${text || 'Conversation compacted'}</span></div>`;
  if (item.subtype === 'error') return html`<div class="sys-error" data-item-id=${item.id}><${Icon} name="alert" size=${14} /><span class="sys-error-text">${text || 'Something went wrong.'}</span></div>`;
  if (!text) return null;
  return html`<div class="sys-line" data-item-id=${item.id} title=${text}>${item.subtype === 'interrupted' ? html`<${Icon} name="stop" size=${12} />` : null}${text}</div>`;
}

function ResultLine({ item }) {
  const bad = item.isError === true;
  const d = num(item.durationMs);
  return html`<div class=${'turn-end' + (bad ? ' bad' : '')} data-item-id=${item.id}>
    ${bad ? html`<${Icon} name="alert" size=${13} />` : null}<span>${d ? `Worked for ${fmtDuration(d)}` : 'Done'}</span></div>`;
}

// A follow-up the parent sent this agent (SendMessage): the first prompt is shown above, not here.
function UserLine({ item }) {
  return html`<div class="pn-av-msg" data-item-id=${item.id}>
    <div class="pn-av-label">Message from the parent</div>
    <div class="pn-av-msg-text">${item.text || ''}</div>
  </div>`;
}

function ItemRow({ it, next, sid, cwd, running }) {
  switch (it.type) {
    case 'assistant': return html`<${AssistantMsg} item=${it} />`;
    case 'thinking': return html`<${Thinking} item=${it} sid=${sid} running=${running} dur=${next ? next.ts - it.ts : 0} />`;
    case 'tool': return html`<div class="tsolo"><${ToolRow} item=${it} cwd=${cwd} sid=${sid} desc=${isAgentName(it.name) ? descendants(it.toolUseId) : undefined} /></div>`;
    case 'system': return html`<${SystemLine} item=${it} />`;
    case 'result': return html`<${ResultLine} item=${it} />`;
    case 'user': return it.text ? html`<${UserLine} item=${it} />` : null;
    default: return null;
  }
}

// ---------- header pieces ----------
function Crumbs({ trail, labelOf, onGo, onClose }) {
  return html`<nav class="pn-av-crumbs" aria-label="Agent path">
    <button type="button" class="pn-av-crumb pn-av-back" onClick=${onClose} title="Back to all agents">
      <${Icon} name="chevron-left" size=${13} /><span>Agents</span>
    </button>
    ${trail.map((id, i) => {
      const last = i === trail.length - 1;
      const { lane, text } = labelOf(id);
      return html`<span class="pn-av-sep" aria-hidden="true">/</span>
        <button type="button" key=${id} class=${cx('pn-av-crumb', last && 'on')} aria-current=${last ? 'page' : undefined}
          disabled=${last} onClick=${() => onGo(i)} title=${text || lane || id}>${lane || text || 'Agent'}</button>`;
    })}
  </nav>`;
}

function Head({ a, running, now, onReveal }) {
  const { lane, text } = splitLane(a?.description || '');
  const started = num(a?.startedAt);
  const ended = num(a?.endedAt);
  const dur = started != null ? (running ? now : ended ?? now) - started : null;
  const cost = num(a?.costUsd);
  const kind = [a?.subagentType, a?.model ? shortModel(a.model) : ''].filter(Boolean).join(' · ');
  const p = num(a?.context?.percent);
  return html`<header class="pn-av-head">
    <div class="pn-av-title">
      <span class=${cx('dot', dotClass(a?.status), running && 'live')} aria-hidden="true"></span>
      <span class="pn-av-desc" title=${text}>${text.trim() || a?.subagentType || 'Agent'}</span>
      ${onReveal && html`<button type="button" class="btn sm pn-av-reveal" onClick=${onReveal} title="Show this agent's card in the conversation">Show in chat</button>`}
    </div>
    <div class="pn-av-facts pn-num">
      ${lane && html`<span class="pn-tag">${lane}</span>`}
      <span class=${cx('pn-av-st', `st-${a?.status || 'unknown'}`, a?.quiet && 'quiet')}>${(a && (a.status === 'stopped' && a.stopReason ? agentStateText(a) : a.quiet ? `Running · ${String(agentStateText(a) || '').toLowerCase()}` : null)) || statusText(a?.status)}</span>
      ${kind && html`<span title=${a?.model || ''}>${kind}</span>`}
      ${dur != null && html`<span title="Duration">${fmtDuration(Math.max(0, dur))}</span>`}
      ${cost != null ? html`<span title="Cost the engine reported for this agent">${fmtCost(cost)}</span>`
        : html`<span class="pn-muted" title="Claude Code reports cost per session, not per subagent">cost n/a</span>`}
      ${p == null && html`<span class="pn-muted" title="No usage reported for this agent yet">context n/a</span>`}
    </div>
    ${p != null && html`<${ContextBar} ctx=${a.context} />`}
  </header>`;
}

function Prompt({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return html`<section class="pn-av-prompt"><div class="pn-av-label">Prompt</div><div class="pn-muted pn-av-note">The transcript has no prompt line.</div></section>`;
  const long = text.length > 360 || text.split('\n').length > 5;
  return html`<section class="pn-av-prompt">
    <div class="pn-av-label">Prompt
      <span class="grow"></span>
      <${ActBtn} icon="copy" label="Copy prompt" run=${() => copyText(text)} />
    </div>
    <div class=${cx('pn-av-prompt-text', long && !open && 'clamp')}>${text}</div>
    ${long && html`<button type="button" class="pn-av-more" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Show less' : 'Show all'}</button>`}
  </section>`;
}

function Children({ list, onOpen, now }) {
  if (!list.length) return null;
  return html`<section class="pn-av-kids">
    <div class="pn-av-label">Agents it launched <span class="pn-muted pn-num">${list.length}</span></div>
    <ul>${list.map((c) => {
      const { lane, text } = splitLane(c.description || '');
      const st = num(c.startedAt);
      const d = st != null ? (c.status === 'running' ? now : num(c.endedAt) ?? now) - st : null;
      return html`<li key=${c.id}><button type="button" class="pn-av-kid" onClick=${() => onOpen(c)} title="Open this agent">
        <span class=${cx('dot', dotClass(c.status), c.status === 'running' && 'live')} aria-label=${c.status}></span>
        ${lane && html`<span class="pn-tag">${lane}</span>`}
        <span class="pn-av-kid-desc">${text.trim() || c.subagentType || 'Agent'}</span>
        ${d != null && html`<span class="pn-muted pn-num">${fmtDuration(Math.max(0, d))}</span>`}
        <${Icon} name="chevron-right" size=${12} />
      </button></li>`;
    })}</ul>
  </section>`;
}

// ---------- the view ----------
export function AgentView({ sessionId, trail, onReveal }) {
  const agentId = trail[trail.length - 1];
  const fleet = fleetBySession.value[sessionId] || [];
  const session = sessions.value.find((s) => s.id === sessionId) || null;
  const [d, setD] = useState({ loading: true, items: [], hasMore: false });
  const [olderBusy, setOlderBusy] = useState(false);
  const [pill, setPill] = useState(false);
  const scroller = useRef(null);
  const atBottom = useRef(true);
  const prepend = useRef(null);
  const gen = useRef(0);
  const dRef = useRef(d); dRef.current = d;

  const fa = fleet.find((a) => a.id === agentId) || null;
  const a = fa ? { ...(d.agent || {}), ...fa, context: fa.context || d.agent?.context || null } : d.agent || null;
  const running = (a?.status || '') === 'running';
  const now = useNow(1000, running);

  async function load() {
    const g = ++gen.current;
    try {
      const r = await fetchTx({ sessionId, agentId, limit: FIRST_PAGE });
      if (g !== gen.current) return;
      atBottom.current = true;
      setD({ loading: false, items: r.items || [], hasMore: !!r.hasMore, agent: r.agent || null, prompt: r.prompt || null, file: r.file || null, missing: r.missing || null, rev: r.rev || null, error: null });
    } catch (e) {
      if (g !== gen.current) return;
      setD((x) => ({ ...x, loading: false, error: e?.message || String(e) }));
    }
  }

  useEffect(() => { setD({ loading: true, items: [], hasMore: false }); setPill(false); load(); return () => { gen.current++; }; }, [sessionId, agentId]);

  // Live: poll while it runs (and once more when it stops, for the final lines).
  const pollWhile = running || (d.missing && !d.file && a?.status === 'running');
  useEffect(() => {
    if (d.loading) return undefined;
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden) return;
      const cur = dRef.current;
      if (cur.missing || cur.error) { await load(); return; }
      const nestedRunning = cur.items.some((i) => i.type === 'tool' && isAgentName(i.name) && i.status === 'running');
      const limit = nestedRunning ? Math.min(Math.max(cur.items.length, TAIL_PAGE), 300) : TAIL_PAGE;
      const g = gen.current;
      try {
        const r = await fetchTx({ sessionId, agentId, rev: cur.rev || undefined, limit });
        if (stop || g !== gen.current) return;
        if (r.unchanged) { if (r.agent) setD((x) => ({ ...x, agent: r.agent })); return; }
        const merged = mergeTail(dRef.current.items, r.items || []);
        if (!merged) { await load(); return; }
        setD((x) => ({ ...x, items: merged, agent: r.agent || x.agent, prompt: x.prompt || r.prompt || null, rev: r.rev || null, missing: r.missing || null, file: r.file || x.file }));
      } catch {}
    };
    if (!pollWhile) { tick(); return () => { stop = true; }; }
    const t = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [sessionId, agentId, pollWhile, d.loading]);

  async function loadEarlier() {
    const first = d.items[0];
    if (!first || olderBusy) return;
    setOlderBusy(true);
    try {
      const r = await fetchTx({ sessionId, agentId, before: first.id, limit: FIRST_PAGE });
      const el = scroller.current;
      if (el) prepend.current = el.scrollHeight - el.scrollTop;
      setD((x) => {
        const have = new Set(x.items.map((i) => i.id));
        return { ...x, items: (r.items || []).filter((i) => !have.has(i.id)).concat(x.items), hasMore: !!r.hasMore };
      });
    } catch (e) {
      setD((x) => ({ ...x, error: e?.message || String(e) }));
    } finally { setOlderBusy(false); }
  }

  // Follow the tail while at the bottom; keep the reading position when older items arrive.
  // The tail pin is coalesced to one write per frame (like ui/chat/index.js pinSoon): a synchronous
  // scrollTop write after a render waits ~1 s for the compositor in an unshown window, and it is
  // skipped if the user scrolled up before the frame. Restoring the position after a prepend stays
  // synchronous (a user action, and deferring it would make the list jump).
  const pinRaf = useRef(0);
  const pinSoon = () => {
    if (pinRaf.current) return;
    pinRaf.current = requestAnimationFrame(() => {
      pinRaf.current = 0;
      const el = scroller.current;
      if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    });
  };
  useEffect(() => () => cancelAnimationFrame(pinRaf.current), []);
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (prepend.current != null) { el.scrollTop = el.scrollHeight - prepend.current; prepend.current = null; return; }
    if (atBottom.current) pinSoon();
  }, [d.items, d.loading]);
  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (pill === atBottom.current) setPill(!atBottom.current);
  };
  const toLatest = () => { const el = scroller.current; if (!el) return; atBottom.current = true; el.scrollTop = el.scrollHeight; setPill(false); };

  // Nested agents' steps belong under their cards (same split as the chat's build()).
  const items = d.items;
  const agentIds = new Set(items.filter((i) => i.type === 'tool' && isAgentName(i.name)).map((i) => i.toolUseId));
  const kmap = {};
  const top = [];
  for (const it of items) {
    if (it.parentToolUseId && agentIds.has(it.parentToolUseId)) (kmap[it.parentToolUseId] ||= []).push(it);
    else top.push(it);
  }
  kids.set(`agent:${agentId}`, kmap);

  // Its own nested agents: the fleet's (they carry status/context) plus any Agent card the fleet lacks.
  const kidsList = fleet.filter((x) => x.parentId === agentId);
  for (const it of top) {
    if (it.type !== 'tool' || !isAgentName(it.name) || kidsList.some((x) => x.id === it.toolUseId)) continue;
    kidsList.push({ id: it.toolUseId, sessionId, description: it.input?.description || '', subagentType: it.input?.subagent_type || null,
      status: it.status === 'running' ? 'running' : it.status === 'error' ? (it.interrupted ? 'stopped' : 'error') : 'done', startedAt: it.startedAt || it.ts, endedAt: it.endedAt || null });
  }
  const openChild = (c) => openAgent({ id: c.id, sessionId }, { from: agentId });
  // Clicking a nested Agent card's head (the chat component) drills into it as well.
  const onBodyClick = (e) => {
    const head = e.target.closest && e.target.closest('.agent-head');
    const card = head && head.closest('.agent[data-tool-use-id]');
    if (card && card.dataset.toolUseId && card.dataset.toolUseId !== agentId) openChild({ id: card.dataset.toolUseId });
  };

  const labelOf = (id) => {
    const x = fleet.find((y) => y.id === id) || (id === agentId ? a : null) || items.find((i) => i.toolUseId === id && i.type === 'tool')?.input;
    return splitLane(x?.description || '');
  };
  const goTo = (i) => { const cur = agentView.value; if (cur) agentView.value = { ...cur, trail: cur.trail.slice(0, i + 1) }; };
  const cwd = session?.cwd || '';

  let body;
  if (d.loading) body = html`<div class="pn-av-state"><span class="spinner sm" aria-hidden="true"></span>Reading the agent's transcript…</div>`;
  else if (d.error && !items.length) body = html`<div class="pn-av-state bad" role="alert">
      <${Icon} name="alert" size=${14} /><div><div class="pn-strong">Could not load this agent</div><div class="pn-av-note">${d.error}</div>
      <button type="button" class="btn sm pn-av-retry" onClick=${load}>Retry</button></div></div>`;
  else if (d.missing) body = html`<div class="pn-av-state warn" role="status">
      <${Icon} name="alert" size=${14} /><div><div class="pn-strong">Transcript not found</div><div class="pn-av-note">${d.missing}</div>
      ${running ? html`<div class="pn-av-note pn-muted">Still running: checking again every ${POLL_MS / 1000} s.</div>` : null}</div></div>`;
  else body = html`
    ${d.hasMore && html`<div class="pn-av-older"><button type="button" class="btn sm" disabled=${olderBusy} onClick=${loadEarlier}>${olderBusy ? 'Loading…' : 'Load earlier steps'}</button></div>`}
    ${!top.length && html`<div class="pn-av-state" role="status">${running ? html`${spinner()}No steps yet. It has only just started.` : 'No steps in this transcript.'}</div>`}
    <div class="pn-av-items">${top.map((it, i) => html`<${ItemRow} key=${it.id} it=${it} next=${top[i + 1]} sid=${sessionId} cwd=${cwd} running=${running} />`)}</div>
    ${running && top.length > 0 && html`<div class="pn-av-live pn-muted">${spinner()}Working${a?.lastTool ? html` · <span class="mono">${a.lastTool}</span>` : ''}</div>`}
    ${d.error && html`<div class="pn-av-note bad" role="alert">${d.error}</div>`}`;

  return html`<div class="pn-av">
    <div class="pn-av-bar">
      <${Crumbs} trail=${trail} labelOf=${labelOf} onGo=${goTo} onClose=${closeAgent} />
    </div>
    <${Head} a=${a || { id: agentId, status: 'unknown' }} running=${running} now=${now} onReveal=${onReveal && fa ? () => onReveal(fa) : null} />
    <div class="pn-av-scroll" ref=${scroller} onScroll=${onScroll} onClick=${onBodyClick}>
      ${!d.loading && !d.error && !d.missing && html`<${Prompt} text=${d.prompt} />`}
      <${Children} list=${kidsList} onOpen=${openChild} now=${now} />
      ${body}
      ${d.file && html`<div class="pn-av-file mono" title=${d.file}>${d.file}</div>`}
    </div>
    ${pill && !d.loading && items.length > 0 && html`<button type="button" class="btn sm pn-av-latest" onClick=${toLatest}>
      <${Icon} name="arrow-down" size=${13} />Jump to latest</button>`}
  </div>`;
}
