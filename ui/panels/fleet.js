// Owner: lane panels (E). Agents panel: the fleet tree for the active session (or all sessions),
// with context bars marked at the user's agent hand-off (32%) and hard ceiling (40%).
import { html, Icon, cx, fmtDuration, fmtCost, fmtPct, fmtAgo, splitLane, shortModel, dotClass, useNow, Empty, Loading } from './util.js';
import { activeId, activeSession, sessions, fleetBySession, itemsOf, ready, selectSession } from '../lib/store.js';
import { fleetAllSessions, inspectorPanel } from './state.js';
import { signal, effect } from '@preact/signals';
import { Timeline } from './timeline.js';
import { runSpans, peakConcurrency, ranMs, workingTree, orderTree, fleetCounts } from './timeline-math.js';
import { AgentView, agentView, openAgent } from './agent-view.js';
import { CONTEXT_HANDOFF_PCT, CONTEXT_CEILING_PCT, contextLevel } from '../lib/context-limits.js';
import { agentStateText, agentQuietMs, AGENT_QUIET_MS, fmtQuiet } from '../lib/stall-limits.js';   // lane stall

// Tree | Timeline, remembered across restarts (best effort; private windows start on Tree).
const MODE_KEY = 'helm.fleet.mode';
function loadMode() { try { return localStorage.getItem(MODE_KEY) === 'timeline' ? 'timeline' : 'tree'; } catch { return 'tree'; } }
export const fleetMode = signal(loadMode());
effect(() => { const v = fleetMode.value; try { localStorage.setItem(MODE_KEY, v); } catch {} });
// Working | All (Tree view). Working is the default EVERY time the panel opens: never persisted, and
// reset whenever the inspector switches to this panel.
export const fleetShow = signal('working');
let lastPanel = null;
effect(() => { const p = inspectorPanel.value; if (p === 'fleet' && lastPanel !== 'fleet') fleetShow.value = 'working'; lastPanel = p; });
// The user's PC lags past about this many agents at once; the summary's peak turns amber above it.
const PEAK_COMFORT = 5;

// The user's hand-off / ceiling: defined once in ui/lib/context-limits.js (the engine's alerts use the same file).
export const HANDOFF_PCT = CONTEXT_HANDOFF_PCT;
export const CEILING_PCT = CONTEXT_CEILING_PCT;
const SCALE_PCT = 50;   // the bar spans 0-50% of the window so the 32/40 marks have room

// Flatten a session's agents into tree order (depth from parentId, falling back to a.depth). opts.activity:
// running subtrees first, then finished ones newest-first (the All list); default: by start time.
export function treeOrder(agents, opts) { return orderTree(agents, opts); }

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const ctxLevel = contextLevel;

// Only rendered when the engine reported a percent; an unknown context shows nothing (no empty bar).
export function ContextBar({ ctx }) {
  const p = num(ctx?.percent);
  if (p == null) return null;
  const est = ctx.estimated === true;
  const lvl = ctxLevel(p);
  const w = Math.min(100, (p / SCALE_PCT) * 100);
  const used = num(ctx.usedTokens), win = num(ctx.windowTokens);
  const label = `${est ? '~' : ''}${fmtPct(p, 1)}`;
  const tip = `${label} of the context window used${est ? ' (estimated from token counts)' : ''}${win ? ` (${Math.round((used || 0) / 1000)}k of ${Math.round(win / 1000)}k tokens)` : ''}. Hand off at ${HANDOFF_PCT}%, hard ceiling ${CEILING_PCT}%. Bar spans 0-${SCALE_PCT}%.`;
  return html`<div class="pn-ag-ctx" title=${tip}>
    <div class=${cx('pn-meter pn-ag-meter', lvl)} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${p} aria-label="Context used">
      <span class="pn-ag-zone" style=${{ left: `${(HANDOFF_PCT / SCALE_PCT) * 100}%`, width: `${((CEILING_PCT - HANDOFF_PCT) / SCALE_PCT) * 100}%` }}></span>
      <span class="pn-meter-clip"><span class="pn-meter-fill" style=${{ transform: `translateX(${w - 100}%)` }}></span></span>
      <span class="pn-ag-line" style=${{ left: `${(CEILING_PCT / SCALE_PCT) * 100}%` }}></span>
    </div>
    <span class=${cx('pn-ag-ctx-val pn-num', lvl)}>${label}</span>
  </div>`;
}

const END_WORD = { done: 'ended', error: 'failed', stopped: 'stopped', cancelled: 'cancelled' };

function AgentRow({ agent: a, depth, now, onPick }) {
  const { lane, text } = splitLane(a.description);
  const running = a.status === 'running';
  const started = num(a.startedAt);
  const resumed = num(a.resumedAt);
  // Running: this run's live clock. Finished: how long it really ran (never "until now").
  const elapsed = running && started ? now - (resumed || started) : null;
  const ran = running ? null : ranMs(a, now);
  const ended = num(a.endedAt);
  const est = a.endEstimated === true;
  const p = num(a.context?.percent);
  const lvl = running ? ctxLevel(p) : '';   // hand-off warnings only matter while it runs
  // lane stall: "Stopped 18:54 · interrupted" / "No activity 12m" (running, maybe stalled: still counted as running)
  const quietMs = agentQuietMs(a, now);
  const stateText = agentStateText(a, now);
  const quietTip = quietMs != null ? `No transcript write or stream event for ${fmtQuiet(quietMs)} (quiet after ${fmtQuiet(AGENT_QUIET_MS)}). It may be stalled, or waiting on one long command; it still counts as running.` : '';
  const word = END_WORD[a.status] || 'ended';
  const endTip = running
    ? (resumed ? `Resumed ${fmtAgo(resumed, now)}; first started ${fmtAgo(started, now)}` : 'Running for this long')
    : ended ? `Ran ${est ? 'about ' : ''}${fmtDuration(ran)}; ${word} ${fmtAgo(ended, now)}${est ? ' (no completion record: end taken from its own transcript)' : ''}`
      : `${word[0].toUpperCase() + word.slice(1)} with no completion record; its end time is unknown`;
  const tools = num(a.toolCount);
  const cost = num(a.costUsd);
  const model = a.model ? shortModel(a.model) : '';
  const kind = [a.subagentType, model].filter(Boolean).join(' · ');
  const title = text.trim() || a.subagentType || 'Agent';
  return html`<li class=${cx('pn-ag', `st-${a.status}`, lvl && `ctx-${lvl}`, quietMs != null && 'quiet')} style=${{ '--depth': depth }}>
    <button class="pn-ag-btn" onClick=${() => onPick(a)} title="Open this agent: its prompt, steps and tool calls">
      <div class="pn-ag-top">
        ${depth > 0 && html`<span class="pn-ag-branch" aria-hidden="true"></span>`}
        <span class=${cx('dot', dotClass(a.status), running && quietMs == null && 'live', 'pn-ag-dot')} aria-label=${a.status}></span>
        <span class="pn-ag-desc">${title}</span>
        ${elapsed != null && html`<span class="pn-ag-time pn-num" title=${endTip}>${fmtDuration(elapsed)}</span>`}
        ${ran != null && html`<span class="pn-ag-time pn-num" title=${endTip}>ran ${est ? '~' : ''}${fmtDuration(ran, { seconds: false })}</span>`}
      </div>
      <div class="pn-ag-meta">
        ${lane && html`<span class="pn-tag pn-ag-lane">${lane}</span>`}
        ${kind && html`<span class="pn-ag-type" title=${a.model || ''}>${kind}</span>`}
        ${a.background === true && html`<span class="pn-ag-bg" title="Runs in the background">background</span>`}
        ${running && resumed && html`<span class="pn-ag-bg" title=${endTip}>resumed</span>`}
        ${quietMs != null && html`<span class="pn-ag-quiet" title=${quietTip}>${stateText}</span>`}
        ${!running && html`<span class=${cx('pn-ag-ended', `st-${a.status}`, a.stopReason && `why-${a.stopReason}`)} title=${endTip}>${a.status === 'stopped' && ended ? stateText : ended ? `${word} ${fmtAgo(ended, now)}` : a.stopReason ? stateText : `${word} · end unknown`}</span>`}
        <span class="pn-ag-stats">
          <span class="pn-ag-tools pn-num">${tools > 0 ? html`${tools} tool${tools === 1 ? '' : 's'}${a.lastTool ? html` · <span class="mono">${a.lastTool}</span>` : ''}` : running && elapsed != null && elapsed < 60_000 ? 'Starting…' : ''}</span>
          ${cost > 0 && html`<span class="pn-ag-cost pn-num">${fmtCost(cost)}</span>`}
        </span>
      </div>
      <${ContextBar} ctx=${a.context} />
      ${lvl === 'danger' && html`<div class="pn-ag-alert danger">Over the ${CEILING_PCT}% ceiling. Stop it and hand off to a fresh agent.</div>`}
      ${lvl === 'warn' && html`<div class="pn-ag-alert warn">Past ${HANDOFF_PCT}%, due for a hand-off.</div>`}
    </button>
  </li>`;
}

function reveal(a) {
  const fire = () => window.dispatchEvent(new CustomEvent('helm:reveal', { detail: { toolUseId: a.id, sessionId: a.sessionId } }));
  if (a.sessionId && a.sessionId !== activeId.value) { selectSession(a.sessionId); setTimeout(fire, 250); } else fire();
}

// Tool items the chat already holds for each subagent: { [agentToolUseId]: { count, last } }.
// null when that session's items aren't loaded (then the engine's toolCount is all there is).
function childTools(sessionId) {
  const items = itemsOf(sessionId).value;
  if (!Array.isArray(items)) return null;
  const out = {};
  for (const it of items) {
    if (it.type !== 'tool' || !it.parentToolUseId) continue;
    const e = out[it.parentToolUseId] || (out[it.parentToolUseId] = { count: 0, last: null });
    e.count++; e.last = it.name || e.last;
  }
  return out;
}

// Tree-ordered rows with live tool counts: while running, Claude Code's in-flight count can
// overshoot, so count the child tool items the chat has instead. Once finished, the engine's
// toolCount is the final total.
function liveRows(agents, opts) {
  const kids = new Map();
  const toolsFor = (a) => {
    if (!kids.has(a.sessionId)) kids.set(a.sessionId, childTools(a.sessionId));
    return kids.get(a.sessionId);
  };
  return treeOrder(agents, opts).map(({ agent, depth }) => {
    let a = agent;
    if (a.status === 'running') {
      const k = toolsFor(a);
      const e = k && k[a.id];
      if (e && e.count > 0) a = { ...a, toolCount: e.count, lastTool: e.last || a.lastTool || null };
    }
    return { agent: a, depth };
  });
}

function AgentList({ agents, now }) {
  return html`<ul class="pn-ag-list">${liveRows(agents, { activity: true, now }).map(({ agent, depth }) =>
    html`<${AgentRow} key=${agent.id} agent=${agent} depth=${depth} now=${now} onPick=${openAgent} />`)}</ul>`;
}

// lead: the Working | All control (Tree view), which already carries the counts.
// mainCtx: the session's own context (Session.context) in the single-session view; neutral, it is not a subagent.
function Summary({ flat, running, hot, etaRunning, now, lead, mainCtx }) {
  if (etaRunning) return html`<div class="pn-ag-sum pn-num"><span class="pn-strong" title="Reported by the session's ETA; no agent details yet">${etaRunning} agent${etaRunning === 1 ? '' : 's'} running</span></div>`;
  // Only the time each agent really ran (an agent with no known end adds nothing, never "until now").
  const { peak } = peakConcurrency(flat.flatMap((a) => runSpans(a, now)));
  const costs = flat.map((a) => num(a.costUsd)).filter((c) => c != null);
  const cost = costs.reduce((s, c) => s + c, 0);
  const crowded = peak > PEAK_COMFORT;
  return html`<div class=${cx('pn-ag-sum pn-num', lead && 'with-lead')}>
    ${lead || html`<span class="pn-strong">${flat.length} agent${flat.length === 1 ? '' : 's'}</span>
    <span class="pn-muted"> · ${running} running</span>`}
    ${peak > 0 && html`<span class="pn-muted">${lead ? '' : ' · '}</span><span class=${cx('pn-ag-peak', crowded && 'crowded')}
      title=${crowded ? `More than ${PEAK_COMFORT} agents at once lags this PC` : `Most agents running at the same moment (comfortable up to ${PEAK_COMFORT})`}>peak ${peak} at once</span>`}
    ${costs.length > 0 && html`<span class="pn-muted"> · </span><span title="Total cost the engine reported for these agents">${fmtCost(cost)}</span>`}
    ${hot > 0 && html`<span class="pn-ag-hot"> · ${hot} past ${HANDOFF_PCT}%</span>`}
    ${mainCtx > 0 && html`<span class="pn-muted"> · </span><span class="pn-ag-main" title="This session's own context use (the main thread, not its agents)">session ${Math.floor(mainCtx)}%</span>`}
  </div>`;
}

// An opened agent (lane agent-drill) takes the whole panel; its breadcrumb leads back to the list.
export function FleetPanel() {
  const av = agentView.value;
  // Switching to another session shows that session's agents (coming back reopens this agent).
  if (av && (fleetAllSessions.value || av.sessionId === activeId.value)) return html`<div class="pn pn-fleet pn-av-host"><${AgentView} key=${av.sessionId} sessionId=${av.sessionId} trail=${av.trail} onReveal=${reveal} /></div>`;
  return html`<${FleetList} />`;
}

function FleetList() {
  const all = fleetAllSessions.value;
  const mode = fleetMode.value;
  const fleets = fleetBySession.value;
  const session = activeSession.value;
  const groups = all
    ? sessions.value.map((s) => ({ session: s, agents: fleets[s.id] || [] })).filter((g) => g.agents.length)
    : session ? [{ session, agents: fleets[session.id] || [] }] : [];
  const flat = groups.flatMap((g) => g.agents);
  const running = flat.filter((a) => a.status === 'running').length;
  const hot = flat.filter((a) => a.status === 'running' && (a.context?.percent ?? 0) >= HANDOFF_PCT).length;
  // 1 s while something runs (live clocks); 30 s otherwise so "ended 4h ago" stays true.
  const now = useNow(running > 0 ? 1000 : 30_000, true);
  const show = fleetShow.value;
  const counts = fleetCounts(flat);
  // Working (default): only running agents (plus their parents for the tree). Tree view only: the
  // Timeline is about when agents ran, so it always shows them all.
  const working = mode === 'tree' && show === 'working';
  const lead = mode === 'tree' && flat.length > 0 ? html`<div class="seg sm pn-ag-show" role="group" aria-label="Which agents">
      <button type="button" aria-pressed=${show === 'working'} onClick=${() => { fleetShow.value = 'working'; }} title="Only agents running right now">Working <span class="pn-num">${counts.running}</span></button>
      <button type="button" aria-pressed=${show === 'all'} onClick=${() => { fleetShow.value = 'all'; }} title="Every agent: running first, then finished ones newest first">All <span class="pn-num">${counts.total}</span></button>
    </div>` : null;
  const shownGroups = working ? groups.map((g) => ({ ...g, every: g.agents, agents: workingTree(g.agents) })).filter((g) => g.agents.length) : groups;
  // No fleet events yet (agents run outside Helm's view, e.g. background lanes): the eta mod still counts them.
  const etaRunning = !all && !flat.length && session?.status === 'working' ? (session.eta?.agentsRunning || 0) : 0;

  let body;
  if (!ready.value) body = html`<${Loading} label="Connecting…" />`;
  else if (!all && !session) body = html`<${Empty} icon="fleet" title="No session selected">Pick a session to see the agents it has spawned.<//>`;
  else if (!flat.length) body = html`<${Empty} icon="fleet" title=${all ? 'No agents in any session' : 'No agents yet'}>
      Subagents this ${all ? 'machine runs' : 'session spawns'} appear here with their context use, tools and cost.<//>`;
  else if (mode === 'timeline') body = html`<${Timeline} now=${now} all=${all} onReveal=${reveal} onOpen=${openAgent} onOpenSession=${selectSession}
      activeSessionId=${activeId.value} groups=${groups.map((g) => ({ session: g.session, rows: liveRows(g.agents) }))} />`;
  else if (working && !shownGroups.length) body = html`<div class="pn-state pn-empty pn-ag-none">
      <span class="pn-state-mark" aria-hidden="true"><${Icon} name="fleet" size=${18} class="pn-state-icon" /></span>
      <div class="pn-state-title">No agents working right now</div>
      <button type="button" class="btn sm pn-ag-showall" onClick=${() => { fleetShow.value = 'all'; }}>Show all (${counts.finished} finished)</button>
    </div>`;
  else if (!all) body = html`<${AgentList} agents=${shownGroups[0].agents} now=${now} />`;
  else body = shownGroups.map((g) => html`<section class="pn-ag-group" key=${g.session.id}>
      <button class=${cx('pn-ag-group-head', g.session.id === activeId.value && 'on')} onClick=${() => selectSession(g.session.id)} title="Open this session">
        <span class=${cx('dot', dotClass(g.session.status))}></span>
        <span class="pn-ag-group-title">${g.session.title || g.session.project || 'Untitled'}</span>
        ${g.session.project && html`<span class="pn-ag-group-proj">${g.session.project}</span>`}
        <span class="pn-ag-group-count pn-num">${(g.every || g.agents).filter((a) => a.status === 'running').length}/${(g.every || g.agents).length}</span>
      </button>
      <${AgentList} agents=${g.agents} now=${now} />
    </section>`);

  return html`<div class=${cx('pn pn-fleet', `mode-${mode}`)}>
    <div class="pn-bar">
      <div class="seg sm pn-ag-mode" role="group" aria-label="Agents view">
        <button type="button" aria-pressed=${mode === 'tree'} onClick=${() => { fleetMode.value = 'tree'; }} title="Agents as a tree with context bars">Tree</button>
        <button type="button" aria-pressed=${mode === 'timeline'} onClick=${() => { fleetMode.value = 'timeline'; }} title="Agents on a timeline: when each ran, and how many at once">Timeline</button>
      </div>
      <span class="pn-bar-grow"></span>
      <button type="button" class="pn-switch" role="switch" aria-checked=${all} title="List the agents of every session"
        onClick=${() => { fleetAllSessions.value = !all; }}>
        <span class="toggle" aria-checked=${all} aria-hidden="true"></span>
        All sessions
      </button>
    </div>
    ${(flat.length > 0 || etaRunning > 0) && html`<${Summary} flat=${flat} running=${running} hot=${hot} etaRunning=${etaRunning} now=${now} lead=${lead} mainCtx=${!all && session ? num(session.context?.percent) : null} />`}
    ${body}
    ${mode === 'tree' && shownGroups.some((g) => g.agents.some((a) => num(a.context?.percent) != null)) && html`<div class="pn-ag-legend">
      <span><span class="pn-ag-legend-zone"></span>${HANDOFF_PCT}% hand-off</span>
      <span><span class="pn-ag-legend-line"></span>${CEILING_PCT}% ceiling</span>
      <span>bar = 0-${SCALE_PCT}% of window</span>
    </div>`}
    ${mode === 'timeline' && flat.length > 0 && html`<div class="pn-ag-legend pn-tl-legend">
      <span><span class="pn-tl-key st-running"></span>running</span>
      <span><span class="pn-tl-key st-done"></span>done</span>
      <span><span class="pn-tl-key st-error"></span>error</span>
      ${flat.some((x) => x.status === 'stopped') && html`<span><span class="pn-tl-key st-stopped"></span>stopped</span>`}
    </div>`}
  </div>`;
}
