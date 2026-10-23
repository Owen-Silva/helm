// Session header: status, editable title, folder + what it is doing, session actions. Owner: lane shell (C).
// Line 2 is the session's always-visible status bar (lane header, 2026-10-08): state + how long, agents running,
// time left, todo progress, background tasks, context, folder, git. What it says is ui/lib/session-header.js
// (pure, host-tested); this file renders it. The pickers and cost stay in the composer bar (lane D); the details
// popover repeats model / effort / cost for reference.
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { computed } from '@preact/signals';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { activeSession, sessions, updateSession, toast, rpc, itemsBySession, fleetBySession } from '../lib/store.js';
import { inspectorOpen, toggleInspector } from '../panels/index.js';
import { isPhone, sheetOpen, phoneScreen } from './state.js';
import { cx, useMenu, Menu, mod, fmtCost, modelLabel, effortLabel } from './util.js';
import { split, openSplit, splitPartner, closePane, focusPane } from './split.js';
import { openFind } from './phone.js';
import { etaInfo } from './eta.js';
import { minuteTick } from './activity.js';
import { now as tickNow, useTicker } from '../chat/state.js';
import { displayStatus, isAgentsOnly, agentsLabel } from '../lib/session-status.js';
import { headerModel, itemFacts, fmtElapsed } from '../lib/session-header.js';
import { CONTEXT_HANDOFF_PCT, CONTEXT_CEILING_PCT } from '../lib/context-limits.js';
import { archiveSessions, closeSession, askDelete, copyText, sessionLink, exportSessionMarkdown, copySessionMarkdown, freshStartWithHandoff, handoffBlocked, HANDOFF_HINT } from './session-actions.js';
import { openLike } from './new-session.js';
import { openWorktrees } from './worktrees.js';   // lane helm-worktrees (H4): the git section's Worktrees button
import { StallResume } from '../lib/stall-resume.js'; // lane stall: Resume on a stalled session

const STATUS = { working: 'Working', waiting: 'Needs you', error: 'Error', idle: 'Idle', closed: 'Stopped' };

// Per-session derived data, memoised so the header re-renders only when what it shows changes (a streaming
// reply rewrites itemsBySession every flush; any session's agents rewrite fleetBySession).
const memo = new Map();   // key -> computed
function memoBy(key, read, sig) {
  let c = memo.get(key);
  if (!c) {
    let last = null, lastSig;
    c = computed(() => { const v = read(); const k = sig(v); if (k !== lastSig) { lastSig = k; last = v; } return last; });
    memo.set(key, c);
  }
  return c.value;
}
const todoSig = (t) => (t ? `${t.status}:${t.activeForm || t.content || ''}` : '');
const factsOf = (sid) => memoBy(`f:${sid}`, () => itemFacts(itemsBySession.value[sid]),
  (f) => `${f.waitingSince}|${f.lastTurnAt}|${f.todos ? f.todos.map(todoSig).join('\u0001') : '-'}`);
const fleetOf = (sid) => memoBy(`a:${sid}`, () => fleetBySession.value[sid] || null,
  (l) => (l ? l.filter((a) => a && a.status === 'running').map((a) => `${a.id}:${a.resumedAt || a.startedAt}:${a.description}`).join('|') : '-'));

function Title({ s, editing, setEditing }) {
  const [val, setVal] = useState(s.title || '');
  const input = useRef(null);
  useEffect(() => { if (!editing) setVal(s.title || ''); }, [s.title, s.id, editing]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const commit = () => {
    setEditing(false);
    const t = val.trim();
    if (t && t !== s.title) updateSession(s.id, { title: t }).catch((e) => toast({ title: 'Rename failed', error: e, kind: 'error' }));
  };
  if (editing) {
    return html`<input ref=${input} class="sh-title-input" value=${val} maxlength="120" aria-label="Session title"
      onInput=${(e) => setVal(e.currentTarget.value)} onBlur=${commit}
      onKeyDown=${(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />`;
  }
  return html`<h1 class="sh-title truncate" title="Click to rename" onClick=${() => setEditing(true)}>${s.title || 'New session'}</h1>`;
}

// ---- Git chip (lane git-export): branch, "N changed", ↑ahead ↓behind for the session folder. ----
// git.status is read-only on the host and never fetches. Refreshed when the header shows a session
// (selection), when a turn ends (status leaves 'working') and at most every 30 s while the window is
// visible. Only rendered headers poll, so hidden or unselected sessions never do.
const gitCache = new Map();   // cwd -> { data, at }  (shared by split panes on one folder)
const gitInflight = new Map(); // cwd -> Promise
function fetchGit(cwd, maxAge) {
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < maxAge) return Promise.resolve(hit.data);
  if (gitInflight.has(cwd)) return gitInflight.get(cwd);
  const p = rpc('git.status', { cwd })
    .then((d) => { gitCache.set(cwd, { data: d, at: Date.now() }); return d; }, () => { gitCache.set(cwd, { data: null, at: Date.now() }); return null; })
    .finally(() => gitInflight.delete(cwd));
  gitInflight.set(cwd, p);
  return p;
}

function useGitStatus(s) {
  const cwd = s?.cwd || null, status = s?.status, sid = s?.id;
  const [st, setSt] = useState(() => (cwd && gitCache.get(cwd)?.data) || null);
  const cur = useRef(cwd);
  cur.current = cwd;
  const load = (maxAge) => { if (cwd) fetchGit(cwd, maxAge).then((d) => { if (cur.current === cwd) setSt(d); }); };
  useEffect(() => { setSt((cwd && gitCache.get(cwd)?.data) || null); load(2000); }, [cwd, sid]);
  const was = useRef(status);
  useEffect(() => { if (was.current === 'working' && status !== 'working') load(0); was.current = status; }, [status]);
  useEffect(() => {
    if (!cwd) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(29_000); }, 30_000);
    const vis = () => { if (document.visibilityState === 'visible') load(30_000); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [cwd]);
  return st;
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return m < 60 ? `${m}m ago` : h < 24 ? `${h}h ago` : d < 60 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

function upstreamText(g) {
  if (g.detached) return 'detached HEAD';
  if (!g.upstream) return 'no upstream';
  if (g.ahead == null) return 'upstream gone';
  return '';
}

// ---- Line 2: the session's status bar, one clean line that fits the header's OWN width ----
// Pieces sit left to right as live state first, then place; they are PLACED most important first, and one that
// does not fit in the room left drops WHOLE (no per-piece ellipsis), while a smaller, less important one may
// still use that room. Priority (data-p):
//   1 lead     what it is doing ("Running npm test"), "Waiting for your answer", "3 agents running", the error,
//              "Idle" (caps at 40ch; short form "Working" / "Needs you" / "3 agents" / "Error")
//   2 agents   "3 agents" while a turn runs or waits (agents-only says it in the lead)
//   2.5 ctx    "1 agent at 34%": running agents at or past the 32% hand-off, amber; red once one passes 40%
//   3 ETA      "~14 min left" (or "over by 3m"): the eta mod's estimate only (session-header.js etaShown)
//   4 clock    "· 3m 01s" turn time / time waiting on the user / oldest agent's run; idle: "· last turn 4m ago"
//   5 todos    "2/4"
//   6 folder   project name (the full path is in the tooltip and the details popover)
//   7 tasks    "1 task" (background shells, monitors, workflows in the CLI)
//   8 context  "21% context"
//   9 git      branch
//  10 ETA step "· step 2/4"
//  11 git      "3 changed ↑2" / "detached HEAD" / "no upstream"
// A detail piece (clock, step, git counts) shows only with its head. The lead never drops; when the full lead
// would cost one of pieces 2-4 (the always-wanted ones: agents, time left, how long) or is too wide alone, it
// takes its short form instead, and only if that alone is still too wide does it ellipsize.
// Fitting runs after every render and on resize of the line itself (ResizeObserver), so split view and the
// inspector re-fit it, not just the viewport. Nothing is lost: the whole line is one button whose tooltip
// and popover ("details") carry every piece, including the "done 5:43" clock time and the full path.
const KEEP_P = 4;   // pieces at or above this priority are worth the lead's short form
function fitLine(line) {
  const info = line?.firstElementChild;
  if (!info || !line.clientWidth) return;
  const items = [...info.children].filter((el) => el.dataset.p);
  line.setAttribute('data-measure', '');   // nothing shrinks, nothing is dropped: natural widths
  for (const el of items) { el.removeAttribute('data-off'); el.removeAttribute('data-anchor'); el.removeAttribute('data-compact'); }
  const cs = getComputedStyle(line);
  // 1px of slack: widths are fractional, and any overflow at all, even 0.3px, puts an ellipsis on the anchor
  const avail = line.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 1;
  const order = items.map((el) => ({ el, p: Number(el.dataset.p), w: el.getBoundingClientRect().width })).sort((a, b) => a.p - b.p);
  if (!order.length) { line.removeAttribute('data-measure'); return; }
  // padding + chevron; each piece's width already includes its own leading separator
  const frame = info.getBoundingClientRect().width - order.reduce((n, it) => n + it.w, 0);
  // most important first: a piece shows if it fits in what is left; a detail (· 3m 01s, · step 2/4, 3 changed)
  // only shows after its own head, which always sits right before it
  const place = () => {
    const off = new Set();
    let used = frame;
    order.forEach((it, i) => {
      const sub = it.el.classList.contains('sh-dot') || it.el.classList.contains('sh-sp');
      const headOff = sub && off.has(it.el.previousElementSibling);
      if (i === 0 || (!headOff && used + it.w <= avail)) used += it.w;
      else off.add(it.el);
    });
    return off;
  };
  const lead = order[0];
  const essentials = order.filter((it) => it.p <= KEEP_P);
  const kept = (off) => essentials.filter((it) => !off.has(it.el)).length;
  // more always-wanted pieces win; at equal counts the more important ones do (e.g. the 2.5 context warning
  // over the time left on a 320px phone)
  const score = (off) => essentials.reduce((n, it) => (off.has(it.el) ? n : n + 1 + (KEEP_P + 1 - it.p) / 100), 0);
  const hasShort = (it) => !!it.el.querySelector(':scope > .sh-short');
  // short forms on exactly `set` (the lead "Working", the ETA "~14m left"); re-measure what changed
  const setCompact = (set) => {
    for (const it of order) {
      if (!hasShort(it) || set.includes(it) === it.el.hasAttribute('data-compact')) continue;
      if (set.includes(it)) it.el.setAttribute('data-compact', ''); else it.el.removeAttribute('data-compact');
      it.w = it.el.getBoundingClientRect().width;
    }
  };
  let off = place(), chosen = [];
  const leadWide = frame + lead.w > avail;
  // A short form has to earn its place: the lead alone is too wide, or it brings back an always-wanted piece.
  // Stages, least change first: the lead's short form, then the always-wanted pieces' short forms as well.
  if (leadWide || kept(off) < essentials.length) {
    for (const stage of [[lead], [lead, ...essentials]]) {
      const set = stage.filter(hasShort);
      if (!set.length || set.length === chosen.length) continue;
      setCompact(set);
      const off2 = place();
      if (score(off2) > score(off) || (leadWide && !chosen.includes(lead) && set.includes(lead))) { chosen = set; off = off2; }
      if (kept(off) === essentials.length && (!leadWide || chosen.includes(lead) || !hasShort(lead))) break;
    }
    setCompact(chosen);
  }
  lead.el.setAttribute('data-anchor', '');
  for (const el of off) el.setAttribute('data-off', '');
  line.removeAttribute('data-measure');
}

const folderName = (s) => s.project || String(s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || s.cwd || '';

const agentLine = (a, now) => `${a.lane ? `${a.lane}: ` : ''}${a.text || a.type || 'agent'}${a.since ? ` (${fmtElapsed(now - a.since)})` : ''}`;
const MAX_AGENTS_LISTED = 6;
const tokens = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`);

function SessionLine({ s, hm, compact = false }) {
  const g = useGitStatus(s);
  const m = useMenu();
  const line = useRef(null);
  useLayoutEffect(() => { fitLine(line.current); });
  useEffect(() => {
    const el = line.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => fitLine(el));
    ro.observe(el);
    document.fonts?.ready?.then(() => { if (el.isConnected) fitLine(el); });
    return () => ro.disconnect();
  }, []);

  const now = Date.now();
  const e = hm.eta ? etaInfo(s.eta, true) : null;
  const repo = g && g.isRepo ? g : null;
  const ab = !repo || repo.ahead == null ? '' : [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ');
  const up = repo ? upstreamText(repo) : '';
  const dirty = repo?.dirty ? `${repo.dirty} changed` : '';
  const gitParts = repo ? [repo.detached ? `detached at ${repo.branch}` : repo.branch, dirty || 'clean', ab || up || (repo.upstream ? `up to date with ${repo.upstream}` : '')].filter(Boolean) : [];
  const clock = hm.clock;
  const status = `${hm.text}${clock ? ` · ${clock.text}` : ''}`;
  const agents = hm.agentList;
  const agentsTip = agents.length ? agents.slice(0, MAX_AGENTS_LISTED).map((a) => agentLine(a, now)).join('\n') + (agents.length > MAX_AGENTS_LISTED ? `\n+${agents.length - MAX_AGENTS_LISTED} more` : '') : '';
  const todoTip = hm.todo ? `${hm.todo.done} of ${hm.todo.total} todos done${hm.todo.current ? `; now: ${hm.todo.current}` : ''}` : '';
  const tasksTip = hm.tasks ? `${hm.tasks.n} background task${hm.tasks.n === 1 ? '' : 's'} running (shell, monitor or workflow)` : '';
  const cw = hm.ctxWarn;
  const cwLine = (a) => `${a.lane ? `${a.lane}: ` : ''}${a.text} at ${a.pct}%`;
  const cwTip = cw ? [
    cw.level === 'danger' ? `Over the ${CONTEXT_CEILING_PCT}% context ceiling: stop and hand off` : `Past ${CONTEXT_HANDOFF_PCT}% context: hand off`,
    ...cw.list.slice(0, MAX_AGENTS_LISTED).map(cwLine),
    cw.n > MAX_AGENTS_LISTED ? `+${cw.n - MAX_AGENTS_LISTED} more` : '',
  ].filter(Boolean).join('\n') : '';
  const ctxTip = hm.context ? `Context ${hm.context.pct}% used${s.context?.usedTokens && s.context?.windowTokens ? ` (${tokens(s.context.usedTokens)} of ${tokens(s.context.windowTokens)} tokens, as of Claude's latest reply: input + cache + output)` : ''}` : '';
  const tip = [
    status,
    hm.agents && `${hm.agents.text} running`,
    cw && cwTip,
    e && e.phrase,
    todoTip, tasksTip, ctxTip,
    s.cwd,
    repo && gitParts.join(' · '),
    repo && (repo.lastCommit ? `Last commit: ${repo.lastCommit.subject} (${ago(repo.lastCommit.ts)})` : 'No commits yet'),
  ].filter(Boolean).join('\n');

  return html`<div ref=${line} class="sh-line2 sh-fit">
    <button ref=${m.anchor} type="button" class="sh-info" aria-haspopup="dialog" aria-expanded=${m.open}
      aria-label=${`Session details: ${tip.replace(/\n/g, '; ')}`} title=${m.open ? null : tip}
      onClick=${(ev) => { ev.stopPropagation(); m.toggle(); }}>
      <span class=${cx('sh-i sh-state', `st-${hm.state}`, hm.stall && 'stalled')} data-p="1"><span class="sh-t sh-long">${hm.text}</span>${hm.short ? html`<span class="sh-t sh-short">${hm.short}</span>` : null}</span>
      ${clock && html`<span class=${cx('sh-i sh-dot sh-clock', clock.live ? 'tnum' : 'sh-ago')} data-p="4" title=${clock.title}>${clock.text}</span>`}
      ${hm.agents && html`<span class="sh-i sh-g sh-agents tnum" data-p="2" title=${agentsTip}><${Icon} name="fleet" size=${12} /><span class="sh-t">${hm.agents.text}</span></span>`}
      ${cw && html`<span class=${cx('sh-i sh-g sh-ctxwarn tnum', cw.level)} data-p="2.5" title=${cwTip}><${Icon} name="gauge" size=${12} /><span class="sh-t sh-long">${cw.text}</span><span class="sh-t sh-short">${cw.short}</span></span>`}
      ${e && html`<span class=${cx('sh-i sh-g sh-eta tnum', e.over && 'over')} data-p="3"><span class="sh-t sh-long sh-eta-left">${e.long}</span>${!e.over ? html`<span class="sh-t sh-short sh-eta-left">${e.short} left</span>` : null}${!e.over && e.done ? html`<span class="sr-only">, done ${e.done}</span>` : null}</span>`}
      ${e?.step && html`<span class="sh-i sh-dot sh-eta-step tnum" data-p="10">${e.step}</span>`}
      ${hm.todo && html`<span class="sh-i sh-g sh-todo tnum" data-p="5" title=${todoTip}><${Icon} name="checklist" size=${12} /><span class="sh-t">${hm.todo.text}</span></span>`}
      ${hm.tasks && html`<span class="sh-i sh-g sh-tasks tnum" data-p="7" title=${tasksTip}><${Icon} name="terminal" size=${12} /><span class="sh-t">${hm.tasks.text}</span></span>`}
      ${hm.context && html`<span class="sh-i sh-g sh-ctx tnum" data-p=${compact ? '1.5' : '8'} title=${ctxTip}><${Icon} name="gauge" size=${12} /><span class="sh-t">${hm.context.text}</span></span>`}
      ${s.cwd && html`<span class="sh-i sh-g sh-folder" data-p="6"><${Icon} name="folder" size=${12} /><span class="sh-t">${folderName(s)}</span></span>`}
      ${repo && html`<span class="sh-i sh-g sh-git" data-git data-p="9"><${Icon} name="git-branch" size=${12} /><span class="sh-t sh-git-branch mono">${repo.branch || '(no branch)'}</span></span>`}
      ${repo && (dirty || ab || up) && html`<span class="sh-i sh-sp sh-git-x tnum" data-p="11">${dirty && html`<span class="sh-git-dirty">${dirty}</span>`}${ab && html`<span class="sh-git-ab">${ab}</span>`}${!ab && up && html`<span class="sh-git-up">${up}</span>`}</span>`}
      <span class="sh-more" aria-hidden="true"><${Icon} name="chevron-down" size=${12} /></span>
    </button>
    ${m.open && html`<${Menu} m=${m} class="sh-pop">
      <div class="gp-row gp-head"><span class=${cx('dot', hm.state)}></span><span class=${cx('gp-status', `st-${hm.state}`)}>${status}</span></div>
      ${agents.length > 0 && html`<div class="gp-row gp-agents"><span class="gp-k">Agents</span><span><span class="tnum">${agentsLabel(agents.length)}</span>
        ${agents.slice(0, MAX_AGENTS_LISTED).map((a) => html`<span class="gp-block gp-agent"><span class="truncate" title=${a.text}>${a.lane ? html`<span class="mono gp-dim">${a.lane} </span>` : null}${a.text || a.type || 'agent'}</span>${a.since ? html`<span class="gp-dim tnum"> ${fmtElapsed(now - a.since)}</span>` : null}</span>`)}
        ${agents.length > MAX_AGENTS_LISTED && html`<span class="gp-block gp-dim">+${agents.length - MAX_AGENTS_LISTED} more (Fleet panel)</span>`}</span></div>`}
      ${!agents.length && hm.agents && html`<div class="gp-row"><span class="gp-k">Agents</span><span class="tnum">${hm.agents.text} running</span></div>`}
      ${cw && html`<div class="gp-row gp-ctxwarn"><span class="gp-k">Hand-off</span><span><span class=${cx('tnum gp-cw', cw.level)}>${cw.text}${cw.level === 'danger' ? ` · over the ${CONTEXT_CEILING_PCT}% ceiling` : ' · hand off'}</span>
        ${cw.list.slice(0, MAX_AGENTS_LISTED).map((a) => html`<span class="gp-block gp-agent"><span class="truncate" title=${a.text}>${a.lane ? html`<span class="mono gp-dim">${a.lane} </span>` : null}${a.text}</span><span class=${cx('tnum gp-cw', a.level)}> ${a.pct}%</span></span>`)}
        ${cw.n > MAX_AGENTS_LISTED && html`<span class="gp-block gp-dim">+${cw.n - MAX_AGENTS_LISTED} more (Agents panel)</span>`}</span></div>`}
      ${e && html`<div class="gp-row"><span class="gp-k">ETA</span><span class=${cx('tnum', e.over && 'gp-over')}>${e.long}${!e.over && e.done ? html`<span class="gp-dim"> · done ${e.done}</span>` : null}</span></div>`}
      ${e?.stepOf && html`<div class="gp-row"><span class="gp-k">Step</span><span><span class="tnum">${e.stepOf}</span>${e.stepLabel ? html`<span class="gp-dim"> · ${e.stepLabel}</span>` : null}</span></div>`}
      ${e && (e.label || e.summary) && html`<div class="gp-row"><span class="gp-k">Plan</span><span>${e.label || e.summary}${e.label && e.summary ? html`<span class="gp-dim gp-block">${e.summary}</span>` : null}</span></div>`}
      ${e?.note && html`<div class="gp-row"><span class="gp-k">Note</span><span class="gp-dim">${e.note}</span></div>`}
      ${hm.todo && html`<div class="gp-row"><span class="gp-k">Todos</span><span><span class="tnum">${hm.todo.done} of ${hm.todo.total} done</span>${hm.todo.current ? html`<span class="gp-dim gp-block">${hm.todo.current}</span>` : null}</span></div>`}
      ${hm.tasks && html`<div class="gp-row"><span class="gp-k">Tasks</span><span class="tnum">${hm.tasks.text} in the background</span></div>`}
      ${hm.context && html`<div class="gp-row"><span class="gp-k">Context</span><span class="tnum">${ctxTip.replace(/^Context /, '')}</span></div>`}
      ${s.model && html`<div class="gp-row"><span class="gp-k">Model</span><span>${modelLabel(s.model)}${s.effort ? html`<span class="gp-dim"> · ${effortLabel(s.effort)}</span>` : null}${s.costUsd > 0 ? html`<span class="gp-dim tnum" title="Claude Code's own total for this conversation (all days, agents included)"> · ${fmtCost(s.costUsd)}</span>` : null}</span></div>`}
      ${s.cwd && html`<div class="gp-row"><span class="gp-k">Folder</span><span class="gp-path mono">${s.cwd}</span></div>`}
      ${g && !g.isRepo && html`<div class="gp-row"><span class="gp-k">Git</span><span class="gp-dim">Not a git repository</span></div>`}
      ${repo && html`<div class="gp-sec">
        <div class="gp-row gp-branch"><${Icon} name="git-branch" size=${13} /><span class="mono truncate">${repo.branch || '(no branch)'}</span>
          ${repo.upstream && html`<span class="gp-dim truncate">→ <span class="mono">${repo.upstream}</span></span>`}</div>
        <div class="gp-row"><span class="gp-k">Changes</span><span>${repo.dirty ? `${repo.dirty} changed${repo.staged ? ` · ${repo.staged} staged` : ''}${repo.untracked ? ` · ${repo.untracked} untracked` : ''}` : 'Clean'}</span></div>
        <div class="gp-row"><span class="gp-k">Upstream</span><span>${up || (repo.ahead || repo.behind ? `${repo.ahead} ahead · ${repo.behind} behind` : 'Up to date')}</span></div>
        <div class="gp-row gp-commit"><span class="gp-k">Last commit</span>${repo.lastCommit
          ? html`<span class="gp-subj" title=${repo.lastCommit.subject}>${repo.lastCommit.subject}<span class="gp-dim"> · ${ago(repo.lastCommit.ts)}</span></span>`
          : html`<span class="gp-dim">No commits yet</span>`}</div>
        <div class="gp-foot gp-dim">Against the last fetch; Helm never fetches.</div>
        <button class="btn btn-sm btn-ghost gp-wt" onClick=${() => { m.close?.(); openWorktrees(s.cwd); }}><${Icon} name="git-branch" size=${13} />Worktrees…</button>
      </div>`}
    <//>`}
  </div>`;
}

// `sid` / `pane`: split view renders one header per pane (pane = 0 | 1); without them, the active session.
// `compact` (lane quad, 4 corners): a smaller title and padding; the status line keeps state + context first;
// × empties the corner (the tab stays open); only the top-right corner carries the inspector toggle.
export function SessionHeader({ sid = null, pane = null, compact = false } = {}) {
  const s = sid ? sessions.value.find((x) => x.id === sid) || null : activeSession.value;
  const [editing, setEditing] = useState(false);
  const m = useMenu();
  // Clocks ride the app's shared timers, never one of their own: the 1 s ticker (ui/chat/state.js; runs only
  // while some view needs it AND the window is visible) while it works or waits, else the minute tick that
  // already runs for the sidebar (ui/shell/activity.js) for "last turn 4m ago". Reading .value subscribes.
  const shown = s ? displayStatus(s) : 'idle';
  const live = shown === 'working' || shown === 'waiting';
  useTicker(live);
  void (live ? tickNow.value : minuteTick.value);
  if (!s) return null;
  const hm = headerModel(s, { now: Date.now(), fleet: fleetOf(s.id), facts: factsOf(s.id) });
  const phone = isPhone.value;
  const busy = s.status === 'working' || s.status === 'waiting';
  const inSplit = pane != null && !!split.value;
  const partner = !phone && !inSplit ? sessions.value.find((x) => x.id === splitPartner()) : null;
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => toast({ title: `${what} copied`, body: text, ms: 2500 }), (e) => toast({ title: 'Copy failed', error: e, kind: 'error' }));
  const paneLabel = compact ? 'Empty this corner' : 'Close this pane';
  return html`<header class=${cx('sess-head sh-bar', compact && 'sh-compact')}>
    ${phone && html`<button class="icon-btn sh-back" aria-label="Back to sessions" onClick=${() => { phoneScreen.value = 'list'; }}><${Icon} name="chevron-left" size=${20} /></button>`}
    <div class="sh-main">
      <div class="sh-line1">
        <span class=${cx('dot', displayStatus(s), displayStatus(s) === 'working' && 'live')} title=${isAgentsOnly(s) ? agentsLabel(s) : STATUS[s.status] || s.status}></span>
        <${Title} s=${s} editing=${editing} setEditing=${setEditing} />
      </div>
      <${SessionLine} s=${s} hm=${hm} compact=${compact} />
    </div>
    <div class="sh-actions">
      ${hm.stall && html`<${StallResume} s=${s} stall=${hm.stall} compact=${compact || phone} />`}
      <button ref=${m.anchor} class="icon-btn" aria-label="Session actions" aria-haspopup="menu" aria-expanded=${m.open} title="Session actions" onClick=${m.toggle}>
        <${Icon} name="more" size=${17} /></button>
      ${m.open && html`<${Menu} m=${m} align="end">
        <button class="menu-item" data-act="find" onClick=${() => { if (inSplit) focusPane(pane); setTimeout(openFind, 0); }} title=${phone ? 'Find in conversation' : `Find in conversation (${mod}+F)`}>
          <${Icon} name="search" size=${15} />Find in conversation</button>
        <button class="menu-item" onClick=${() => setEditing(true)}><${Icon} name="pencil" size=${15} />Rename</button>
        <button class="menu-item" onClick=${() => updateSession(s.id, { pinned: !s.pinned })}><${Icon} name="pin" size=${15} />${s.pinned ? 'Unpin' : 'Keep in list'}</button>
        ${partner && html`<button class="menu-item" onClick=${() => openSplit(partner.id, 1)} title=${`Show “${partner.title || 'New session'}” beside this one (${mod}+Shift+\\)`}>
          <${Icon} name="columns" size=${15} /><span class="truncate">Split with ${partner.title || 'New session'}</span></button>`}
        ${inSplit && html`<button class="menu-item" onClick=${() => closePane(pane)}><${Icon} name=${compact ? 'layout-4' : 'columns'} size=${15} />${paneLabel}</button>`}
        <button class="menu-item" data-act="start-like" onClick=${() => openLike(s)} title="New session with this folder, model, effort and permission mode">
          <${Icon} name="plus" size=${15} />Start another like this</button>
        ${(() => { const off = handoffBlocked(s); return html`<button class="menu-item" data-act="handoff" aria-disabled=${off ? 'true' : undefined} title=${off || HANDOFF_HINT}
          onClick=${() => freshStartWithHandoff(s)}><${Icon} name="file-plus" size=${15} />Fresh start with handoff</button>`; })()}
        <div class="menu-sep"></div>
        <button class="menu-item" onClick=${() => copy(s.cwd, 'Folder path')}><${Icon} name="folder" size=${15} />Copy folder path</button>
        <button class="menu-item" data-act="copy-link" onClick=${() => copyText(sessionLink(s.id), 'Link')} title="helm:// link that opens Helm on this session"><${Icon} name="link" size=${15} />Copy link</button>
        <button class="menu-item" onClick=${() => copyText(s.id, 'Helm session id')} title=${`For helm --session=${s.id}`}><${Icon} name="hash" size=${15} />Copy Helm session id</button>
        ${s.claudeSessionId && html`<button class="menu-item" onClick=${() => copy(s.claudeSessionId, 'Session id')}><${Icon} name="copy" size=${15} />Copy Claude session id</button>`}
        <div class="menu-sep"></div>
        <button class="menu-item" data-act="export-md" onClick=${() => exportSessionMarkdown(s)} title="Prompts, replies and one-line tool summaries; thinking left out">
          <${Icon} name="download" size=${15} />Export as Markdown…</button>
        <button class="menu-item" data-act="copy-md" onClick=${() => copySessionMarkdown(s)}><${Icon} name="copy" size=${15} />Copy as Markdown</button>
        <div class="menu-sep"></div>
        ${s.archived
          ? html`<button class="menu-item" onClick=${() => archiveSessions([s.id], false)}><${Icon} name="archive-restore" size=${15} />Unarchive</button>`
          : html`<button class="menu-item" onClick=${() => archiveSessions([s.id], true)}><${Icon} name="archive" size=${15} />Archive</button>`}
        ${s.status !== 'closed' && html`<button class="menu-item" onClick=${() => closeSession(s.id)} title="Stop the CLI now; the session stays in the list">
          <${Icon} name="stop" size=${15} />${busy ? 'Stop and close' : 'Close'}</button>`}
        <button class="menu-item danger" onClick=${() => askDelete([s.id])}><${Icon} name="trash" size=${15} />Delete from Helm…</button>
      <//>`}
      ${inSplit && html`<button class="icon-btn sh-pane-x" aria-label=${compact ? 'Empty this corner' : 'Close pane'} title=${compact ? 'Empty this corner (the tab stays open)' : 'Close pane'} onClick=${(e) => { e.stopPropagation(); closePane(pane); }}><${Icon} name="x" size=${compact ? 15 : 17} /></button>`}
      ${inSplit && (compact ? pane !== 1 : pane === 0) ? null : phone
        ? html`<button class="icon-btn" aria-label="Open panels" onClick=${() => { sheetOpen.value = true; }}><${Icon} name="panel-bottom" size=${19} /></button>`
        : html`<button class="icon-btn" aria-pressed=${inspectorOpen.value} aria-label="Toggle inspector" title=${`Inspector (${mod}+\\)`} onClick=${toggleInspector}><${Icon} name="sidebar-right" size=${17} /></button>`}
    </div>
  </header>`;
}
