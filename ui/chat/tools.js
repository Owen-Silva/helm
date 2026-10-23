// Tool rows: a one-line summary per tool call, expandable to a renderer per tool.
import { useMemo } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Markdown, highlight } from '../lib/markdown.js';
import { Icon } from '../lib/icons.js';
import { activeSession, sessions, fleetBySession, pendingRequests, itemsOf, externalSessions } from '../lib/store.js';
import { CodeView, DiffView, OutputView, TodoList, JsonView, CopyBtn, diffStats } from './views.js';
import { isOpen, toggle, now, useTicker } from './state.js';
import {
  memo, basename, relPath, hostOf, resultText, resultImages, countLines, langFromPath, truncate, firstLine,
  fmtDuration, fmtElapsedShort, fmtAgentElapsed, modelName, finite, plural, splitLane, copyText,
} from './util.js';
import { ActBtn, toolCopy } from './actions.js';

// Child items of Agent/Task tools, keyed by parentToolUseId. Each ChatView refreshes its own session's map every
// render (kids.set); `map` is the merge of every rendered view's map, so two split panes (and a read-only external
// transcript) never blank each other's agent cards. Tool use ids are globally unique, so merging is safe.
export const kids = {
  map: {}, bySid: new Map(),
  set(sid, kmap) { this.bySid.delete(sid); this.bySid.set(sid, kmap); while (this.bySid.size > 4) this.bySid.delete(this.bySid.keys().next().value); this.map = Object.assign({}, ...this.bySid.values()); },
};

const SHELLS = new Set(['Bash', 'PowerShell', 'BashOutput']);
const isAgent = (name) => name === 'Agent' || name === 'Task';

function parseMcp(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? { server: m[1].replace(/^claude_ai_/, '').replace(/_/g, ' '), tool: m[2].replace(/_/g, ' ') } : null;
}
function firstString(input) {
  if (!input || typeof input !== 'object') return '';
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

// AskUserQuestion answers ({ question: answer }) the engine attaches to the finished tool.
function answersOf(item) {
  const a = item.answers ?? item.input?.answers;
  const out = {};
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    for (const [k, v] of Object.entries(a)) {
      const s = Array.isArray(v) ? v.filter(Boolean).join(', ') : v == null ? '' : String(v);
      if (s.trim()) out[k] = s;
    }
  }
  return out;
}

function grepCount(text) {
  const t = String(text || '').trim();
  if (!t || /^No (matches|files) found/i.test(t)) return 0;
  const m = /^Found (\d+) (?:files?|match(?:es)?|lines?)/i.exec(t);
  if (m) return +m[1];
  return t.split('\n').filter((l) => l.trim()).length;
}
function readRange(input, result) {
  const off = input?.offset, lim = input?.limit;
  if (off || lim) { const a = off || 1; return lim ? `${a}–${a + lim - 1}` : `from ${a}`; }
  const n = countLines(resultText(result));
  return n ? plural(n, 'line') : '';
}

const editStatsCache = new WeakMap();
function editStats(input) {
  if (!input || typeof input !== 'object') return { add: 0, del: 0 };
  let s = editStatsCache.get(input);
  if (!s) {
    const edits = Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    s = edits.reduce((acc, e) => { const d = diffStats(e.old_string, e.new_string); return { add: acc.add + d.add, del: acc.del + d.del }; }, { add: 0, del: 0 });
    editStatsCache.set(input, s);
  }
  return s;
}

// → { icon, verb, target, mono, meta, metaNode, chip }
export function describe(item, cwd) {
  const { name, input = {}, status, result } = item;
  const running = status === 'running';
  const v = (done, ing) => (running ? ing : done);
  const file = input.file_path || input.notebook_path || input.path || '';
  switch (name) {
    case 'Bash': case 'PowerShell':
      return { icon: 'terminal', verb: v('Ran', 'Running'), target: firstLine(input.command), mono: true, title: input.description || input.command };
    case 'BashOutput': return { icon: 'terminal', verb: v('Read output', 'Reading output'), target: input.bash_id || '', mono: true };
    case 'KillShell': case 'KillBash': return { icon: 'stop', verb: 'Stopped shell', target: input.shell_id || input.bash_id || '', mono: true };
    case 'Read': return { icon: 'file', verb: v('Read', 'Reading'), target: basename(file), mono: true, meta: readRange(input, result), title: relPath(file, cwd) };
    case 'Edit': case 'MultiEdit': {
      const s = editStats(input);
      return { icon: 'pencil', verb: v('Edited', 'Editing'), target: basename(file), mono: true, title: relPath(file, cwd),
        metaNode: html`<span class="n-add">+${s.add}</span><span class="n-del">−${s.del}</span>` };
    }
    case 'Write': return { icon: 'file-plus', verb: v('Wrote', 'Writing'), target: basename(file), mono: true, meta: plural(countLines(input.content), 'line'), title: relPath(file, cwd) };
    case 'NotebookEdit': return { icon: 'pencil', verb: v('Edited notebook', 'Editing notebook'), target: basename(file), mono: true };
    case 'Grep': {
      const n = running ? null : grepCount(resultText(result));
      return { icon: 'search', verb: v('Searched', 'Searching'), target: input.pattern, mono: true, code: true,
        meta: [input.path || input.glob ? `in ${relPath(input.path || input.glob, cwd)}` : '', n == null ? '' : plural(n, 'result')].filter(Boolean).join(' · ') };
    }
    case 'Glob': {
      const n = running ? null : grepCount(resultText(result));
      return { icon: 'folder', verb: v('Found', 'Finding'), target: input.pattern, mono: true, code: true,
        meta: [input.path ? `in ${relPath(input.path, cwd)}` : '', n == null ? '' : plural(n, 'file')].filter(Boolean).join(' · ') };
    }
    case 'LS': return { icon: 'folder', verb: v('Listed', 'Listing'), target: relPath(input.path, cwd), mono: true };
    case 'WebFetch': return { icon: 'globe', verb: v('Fetched', 'Fetching'), target: hostOf(input.url), title: input.url };
    case 'WebSearch': return { icon: 'globe', verb: v('Searched the web', 'Searching the web'), target: input.query ? `“${input.query}”` : '' };
    case 'TodoWrite': {
      const t = input.todos || [];
      return { icon: 'checklist', verb: 'Updated todos', target: '', meta: `${t.filter((x) => x.status === 'completed').length} of ${t.length} done` };
    }
    case 'Skill': return { icon: 'sparkle', verb: v('Used skill', 'Using skill'), target: input.skill || input.command || input.name || '', mono: true };
    case 'AskUserQuestion': {
      const q = input.questions || [];
      const ans = Object.values(answersOf(item));
      return { icon: 'question', verb: v('Asked', 'Asking'), target: q.length ? (q[0].header || truncate(q[0].question, 60)) : 'a question',
        meta: q.length > 1 && !ans.length ? plural(q.length, 'question') : '', answer: ans.join(' · ') };
    }
    case 'ExitPlanMode': return { icon: 'map', verb: v('Proposed a plan', 'Proposing a plan'), target: '' };
    case 'EnterPlanMode': return { icon: 'map', verb: 'Entered plan mode', target: '' };
    default: {
      const mcp = parseMcp(name);
      if (mcp) return { icon: 'plug', verb: mcp.tool, target: truncate(firstLine(firstString(input)), 80), chip: mcp.server };
      return { icon: 'tool', verb: name || 'Tool', target: truncate(firstLine(firstString(input)), 80) };
    }
  }
}

// Only animate while the session is actually busy: a 'running' tool left behind on an idle
// session (interrupted turn, engine restart) must not spin or tick forever.
// `sid` picks the session (split panes render two); without it the focused (active) session is used.
// A read-only terminal transcript (sid "ext:<claudeSessionId>") is busy only while that terminal session is
// live (`active`: its transcript was written in the last ~90 s). A snapshot loaded mid-tool must not spin or
// tick once the terminal has moved on: that tool shows a calm "No result recorded" instead (NoResult below).
export const isExternalSid = (sid) => typeof sid === 'string' && sid.startsWith('ext:');
const externalLive = (sid) => !!externalSessions.value.find((x) => 'ext:' + x.claudeSessionId === sid)?.active;
const sessionOf = (sid) => (sid ? sessions.value.find((x) => x.id === sid) : activeSession.value);
export const sessionBusy = (sid) => {
  if (isExternalSid(sid)) return externalLive(sid);
  const st = sessionOf(sid)?.status; return st === 'working' || st === 'waiting';
};
// A tool with no result in a terminal transcript whose session is no longer live: no spinner, no clock.
export const noResult = (item, sid) => item.status === 'running' && isExternalSid(sid) && !externalLive(sid);
const NoResult = () => html`<span class="trow-flag noresult" title="The terminal session moved on before a result for this tool was written">No result recorded</span>`;
// A running tool that is only waiting on the user (its permission / question card is pending) shows a
// still clock, not a spinner: nothing is working until the user answers.
const pendingFor = (sid) => (sid ? (itemsOf(sid).value || []).filter((i) => i.type === 'request' && i.status === 'pending') : pendingRequests.value);
const awaitingYou = (item, sid) => item.status === 'running' && pendingFor(sid).some((r) => (r.toolUseId && r.toolUseId === item.toolUseId) || (item.name === 'AskUserQuestion' && r.kind === 'question'));
export const spinner = () => html`<span class="spinner sm" aria-hidden="true"></span>`;

function Elapsed({ from, to, sid }) {
  const live = to == null && sessionBusy(sid);
  useTicker(live);
  if (to == null && !live) return null;
  const end = live ? now.value : to;
  const ms = end - from;
  return Number.isFinite(ms) ? html`<span class="trow-time">${fmtElapsedShort(Math.max(0, ms))}</span>` : null;
}

// Agent cards time themselves like the fleet panel: (running ? now : endedAt) - startedAt, floored.
function AgentElapsed({ from, to, sid }) {
  const live = to == null && sessionBusy(sid);
  useTicker(live);
  if (to == null && !live) return null;
  const text = fmtAgentElapsed((live ? now.value : to) - from);
  return text ? html`<span class="trow-time">${text}</span>` : null;
}

// An interrupted tool (the user stopped the turn, or closed the session) ends calm, not as a failure.
const isStopped = (item) => item.status === 'error' && !!item.interrupted;
const statusKey = (item) => (isStopped(item) ? 'stopped' : item.status || 'done');

function StatusTail({ item, sid }) {
  if (noResult(item, sid)) return html`<${NoResult} />`;
  if (item.status === 'running') return html`<${Elapsed} from=${item.startedAt || item.ts} sid=${sid} />`;
  if (item.status === 'denied') return html`<span class="trow-flag denied"><${Icon} name="ban" size=${12} />Denied</span>`;
  if (isStopped(item)) return html`<span class="trow-flag stopped"><${Icon} name="square" size=${10} />Stopped</span>`;
  if (item.status === 'error') return html`<span class="trow-flag error"><${Icon} name="alert" size=${12} />Failed</span>`;
  const d = item.endedAt && item.startedAt ? item.endedAt - item.startedAt : 0;
  return d >= 2000 ? html`<span class="trow-time">${fmtDuration(d)}</span>` : null;
}

function ResultImages({ result }) {
  const imgs = resultImages(result);
  if (!imgs.length) return null;
  return html`<div class="t-imgs">${imgs.map((src) => html`<a href=${src} target="_blank" rel="noopener"><img src=${src} alt="" loading="lazy" /></a>`)}</div>`;
}

function Label({ children }) { return html`<div class="t-label">${children}</div>`; }

// ---- per-tool detail renderers ----
function ShellDetail({ item }) {
  const { input = {}, result, status } = item;
  const ps = item.name === 'PowerShell';
  const cmd = input.command || '';
  const text = resultText(result);
  const bad = (status === 'error' && !item.interrupted) || status === 'denied';
  return html`<div class="t-detail">
    ${input.description ? html`<div class="t-desc">${input.description}</div>` : null}
    <div class=${'term' + (bad ? ' bad' : '')}>
      ${cmd ? html`<div class="term-cmd"><span class="term-prompt" aria-hidden="true">${ps ? 'PS>' : '$'}</span>
        <code class="hljs" dangerouslySetInnerHTML=${{ __html: highlight(cmd, ps ? 'powershell' : 'bash') }} /><${CopyBtn} text=${cmd} label="" /></div>` : null}
      <${OutputView} text=${text} bare=${true} tone=${!bad ? '' : status === 'error' ? 'error' : 'bad'} empty=${status === 'running' ? 'Waiting for output…' : 'No output'} />
    </div>
    <${ResultImages} result=${result} />
  </div>`;
}

function parseReadResult(text) {
  const nums = [], code = [];
  let numbered = 0;
  for (const raw of String(text || '').replace(/\n$/, '').split('\n')) {
    const m = /^\s*(\d+)(?:\t|→)(.*)$/.exec(raw);
    if (m) { numbered++; nums.push(m[1]); code.push(m[2]); } else { nums.push(''); code.push(raw); }
  }
  return numbered ? { nums, code: code.join('\n') } : { nums: false, code: String(text || '') };
}
function ReadDetail({ item, cwd }) {
  const file = item.input?.file_path || '';
  const parsed = useMemo(() => parseReadResult(resultText(item.result)), [item.result]);
  return html`<div class="t-detail">
    <${CodeView} code=${parsed.code} lang=${langFromPath(file)} numbers=${parsed.nums || true}
      head=${html`<span class="cv-path" title=${file}>${relPath(file, cwd)}</span>`} max=${24} />
    <${ResultImages} result=${item.result} />
  </div>`;
}

function EditDetail({ item, cwd }) {
  const input = item.input || {};
  const hunks = useMemo(() => (Array.isArray(input.edits) ? input.edits : [input]).map((e) => ({ old: e.old_string || '', new: e.new_string || '' })), [input]);
  const file = input.file_path || '';
  return html`<div class="t-detail">
    <${DiffView} path=${relPath(file, cwd)} hunks=${hunks} lang=${langFromPath(file)} />
    ${item.status === 'error' || item.status === 'denied' ? html`<${OutputView} text=${resultText(item.result)} tone=${isStopped(item) ? '' : 'bad'} />` : null}
  </div>`;
}

function WriteDetail({ item, cwd }) {
  const file = item.input?.file_path || '';
  return html`<div class="t-detail">
    <${CodeView} code=${item.input?.content || ''} lang=${langFromPath(file)} max=${16}
      head=${html`<span class="cv-path" title=${file}>${relPath(file, cwd)}</span><span class="cv-note">${plural(countLines(item.input?.content), 'line')}</span>`} />
    ${item.status === 'error' || item.status === 'denied' ? html`<${OutputView} text=${resultText(item.result)} tone=${isStopped(item) ? '' : 'bad'} />` : null}
  </div>`;
}

function SearchDetail({ item, cwd }) {
  const { input = {} } = item;
  const text = resultText(item.result).trim();
  const lines = text && !/^No (matches|files) found/i.test(text) ? text.split('\n').filter((l) => l.trim() && !/^Found \d+ /i.test(l)) : [];
  const rows = lines.slice(0, 200).map((l) => {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (m && !/^[a-z]:$/i.test(m[1])) return { file: relPath(m[1], cwd), line: m[2], text: m[3] };
    const m2 = /^([a-z]:[\\/].+?):(\d+):(.*)$/i.exec(l);
    if (m2) return { file: relPath(m2[1], cwd), line: m2[2], text: m2[3] };
    return { file: relPath(l, cwd) };
  });
  const opts = [input.glob && `glob ${input.glob}`, input.type && `type ${input.type}`, input.output_mode, input['-i'] && 'case-insensitive', input.multiline && 'multiline'].filter(Boolean);
  return html`<div class="t-detail">
    <div class="t-kv"><span>Pattern</span><code>${input.pattern}</code>${input.path ? html`<span>in</span><code>${relPath(input.path, cwd)}</code>` : null}
      ${opts.length ? html`<span class="t-dim">${opts.join(' · ')}</span>` : null}</div>
    ${rows.length ? html`<div class="t-results">${rows.map((r) => html`<div class="t-res">
      <span class="t-res-file">${r.file}</span>${r.line ? html`<span class="t-res-line">${r.line}</span><span class="t-res-text">${r.text.trim()}</span>` : null}</div>`)}
      ${lines.length > 200 ? html`<div class="t-dim">+${lines.length - 200} more</div>` : null}</div>`
      : html`<div class="ov ov-empty">${item.status === 'running' ? 'Searching…' : 'No results'}</div>`}
  </div>`;
}

function WebDetail({ item }) {
  const { input = {} } = item;
  const text = resultText(item.result);
  return html`<div class="t-detail">
    ${input.url ? html`<div class="t-kv"><span>URL</span><a href=${input.url} target="_blank" rel="noopener noreferrer">${input.url}</a></div>` : null}
    ${input.query ? html`<div class="t-kv"><span>Query</span><span>${input.query}</span></div>` : null}
    ${input.prompt ? html`<div class="t-desc">${input.prompt}</div>` : null}
    ${text ? html`<div class="t-md clamp"><${Markdown} text=${truncate(text, 6000)} /></div>` : html`<div class="ov ov-empty">${item.status === 'running' ? 'Fetching…' : 'No content'}</div>`}
  </div>`;
}

function SkillDetail({ item }) {
  const { input = {} } = item;
  const text = resultText(item.result);
  return html`<div class="t-detail">
    ${input.args ? html`<div class="t-kv"><span>Args</span><code>${input.args}</code></div>` : null}
    ${text ? html`<${OutputView} text=${text} max=${10} />` : null}
  </div>`;
}

function QuestionToolDetail({ item }) {
  const qs = item.input?.questions || [];
  const ans = answersOf(item);
  const extra = Object.keys(ans).filter((k) => !qs.some((q) => q.question === k));
  const text = resultText(item.result);
  return html`<div class="t-detail">
    ${qs.map((q) => html`<div class="t-qa"><div class="t-desc">${q.question}</div>
      ${ans[q.question] ? html`<div class="t-answer"><${Icon} name="check" size=${13} /><span>${ans[q.question]}</span></div>` : null}</div>`)}
    ${extra.map((k) => html`<div class="t-qa"><div class="t-desc">${k}</div><div class="t-answer"><${Icon} name="check" size=${13} /><span>${ans[k]}</span></div></div>`)}
    ${!Object.keys(ans).length && text ? html`<${OutputView} text=${text} max=${10} />` : null}
  </div>`;
}

function PlanToolDetail({ item }) {
  return html`<div class="t-detail"><div class="t-md"><${Markdown} text=${item.input?.plan || resultText(item.result)} /></div></div>`;
}

function GenericDetail({ item }) {
  const mcp = parseMcp(item.name);
  const text = resultText(item.result);
  return html`<div class="t-detail">
    ${mcp ? html`<div class="t-kv"><span>Server</span><span>${mcp.server}</span><span>Tool</span><code>${item.name}</code></div>` : null}
    <${Label}>Input<//>
    <${JsonView} value=${item.input ?? {}} max=${16} />
    ${text ? html`<${Label}>Result<//><${OutputView} text=${text} tone=${item.status === 'error' && !isStopped(item) ? 'bad' : ''} max=${16} />` : null}
    <${ResultImages} result=${item.result} />
  </div>`;
}

function Detail({ item, cwd, sid }) {
  const n = item.name;
  if (SHELLS.has(n)) return html`<${ShellDetail} item=${item} />`;
  if (n === 'Read') return html`<${ReadDetail} item=${item} cwd=${cwd} />`;
  if (n === 'Edit' || n === 'MultiEdit') return html`<${EditDetail} item=${item} cwd=${cwd} />`;
  if (n === 'Write') return html`<${WriteDetail} item=${item} cwd=${cwd} />`;
  if (n === 'Grep' || n === 'Glob' || n === 'LS') return html`<${SearchDetail} item=${item} cwd=${cwd} />`;
  if (n === 'WebFetch' || n === 'WebSearch') return html`<${WebDetail} item=${item} />`;
  if (n === 'TodoWrite') return html`<div class="t-detail"><${TodoList} todos=${item.input?.todos || []} /></div>`;
  if (n === 'Skill') return html`<${SkillDetail} item=${item} />`;
  if (n === 'AskUserQuestion') return html`<${QuestionToolDetail} item=${item} />`;
  if (n === 'ExitPlanMode') return html`<${PlanToolDetail} item=${item} />`;
  return html`<${GenericDetail} item=${item} sid=${sid} />`;
}

// ---- the row ----
function ToolRowImpl({ item, cwd, sid }) {
  if (isAgent(item.name)) return html`<${AgentCard} item=${item} cwd=${cwd} sid=${sid} />`;
  // No result recorded: past-tense verb ("Ran", not "Running"); nothing is running any more.
  const d = describe(noResult(item, sid) ? { ...item, status: 'done' } : item, cwd);
  const key = `${sid}:${item.id}`;
  const def = item.status === 'running' && SHELLS.has(item.name) && !noResult(item, sid);
  const open = isOpen(key, def);
  const cls = `trow is-${statusKey(item)}${open ? ' open' : ''}`;
  const tc = toolCopy(item);
  return html`<div class=${cls} data-tool-use-id=${item.toolUseId} data-item-id=${item.id}>
    <button type="button" class="trow-line" aria-expanded=${open} onClick=${() => toggle(key, def)} title=${d.title || ''}>
      <span class="trow-ic">${awaitingYou(item, sid) ? html`<${Icon} name="clock" size=${14} title="Waiting for you" />` : item.status === 'running' && sessionBusy(sid) ? spinner() : html`<${Icon} name=${d.icon} size=${14} />`}</span>
      <span class="trow-verb">${d.verb}</span>
      ${d.chip ? html`<span class="trow-chip">${d.chip}</span>` : null}
      ${d.target ? html`<span class=${'trow-target' + (d.mono ? ' mono' : '') + (d.code ? ' code' : '')}>${d.target}</span>` : null}
      ${d.meta ? html`<span class="trow-meta">${d.meta}</span>` : null}
      ${d.metaNode ? html`<span class="trow-meta">${d.metaNode}</span>` : null}
      ${d.answer ? html`<span class="trow-answer" title=${d.answer}><${Icon} name="check" size=${12} /><span>${d.answer}</span></span>` : null}
      <span class="grow" />
      <${StatusTail} item=${item} sid=${sid} />
      <span class="trow-chev"><${Icon} name="chevron-right" size=${12} /></span>
    </button>
    ${tc ? html`<${ActBtn} icon="copy" label=${tc.label} cls="trow-copy" run=${() => copyText(tc.text)} />` : null}
    ${open ? html`<${Detail} item=${item} cwd=${cwd} sid=${sid} />` : null}
  </div>`;
}

const arrEq = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));
// A read-only terminal transcript re-renders its rows with the view: its items do not change when the terminal
// session goes live or idle, but the row's spinner / clock / "No result recorded" do (sessionBusy).
export const ToolRow = memo(ToolRowImpl, (a, b) => a.item === b.item && a.cwd === b.cwd && a.sid === b.sid && arrEq(a.desc, b.desc) && !isExternalSid(b.sid));

export function descendants(toolUseId, out = []) {
  for (const c of kids.map[toolUseId] || []) { out.push(c); if (c.type === 'tool' && isAgent(c.name)) descendants(c.toolUseId, out); }
  return out;
}

function AgentCard({ item, cwd, sid }) {
  const { input = {} } = item;
  const { lane, rest } = splitLane(input.description || '');
  const children = (kids.map[item.toolUseId] || []).filter((c) => c.type === 'tool');
  const keyKids = `${sid}:${item.id}:kids`, keyPrompt = `${sid}:${item.id}:prompt`, keyRes = `${sid}:${item.id}:res`;
  const running = item.status === 'running';
  const animate = running && sessionBusy(sid);
  // The fleet store's agent (id === toolUseId) carries model + timing; prefer it so card and fleet agree.
  const fa = (fleetBySession.value?.[sid] || []).find((a) => a && a.id === item.toolUseId) || null;
  const model = modelName(fa?.model || input.model);
  const kind = fa?.subagentType || input.subagent_type || 'general-purpose';
  const started = finite(fa?.startedAt) ?? finite(item.startedAt) ?? finite(item.ts);
  const ended = finite(fa?.endedAt) ?? finite(item.endedAt);
  const kidsOpen = isOpen(keyKids, false);
  const promptOpen = isOpen(keyPrompt, false);
  const resOpen = isOpen(keyRes, false);
  const text = resultText(item.result);
  const runningKid = running ? [...children].reverse().find((c) => c.status === 'running') : null;
  const nTools = descendants(item.toolUseId).filter((c) => c.type === 'tool').length;
  return html`<div class=${'agent is-' + statusKey(item)} data-tool-use-id=${item.toolUseId} data-item-id=${item.id}>
    <div class="agent-head">
      <span class="agent-ic">${animate ? spinner() : html`<${Icon} name="agent" size=${15} />`}</span>
      <div class="agent-title">
        <div class="agent-desc">${lane ? html`<span class="agent-lane">${lane}</span>` : null}<span>${rest || 'Subagent'}</span></div>
        <div class="agent-sub">
          <span>${kind}</span>
          ${model ? html`<span title=${fa?.model || input.model}>${model}</span>` : null}
          ${noResult(item, sid) ? html`<${NoResult} />` : isStopped(item) ? html`<span class="trow-flag stopped">Stopped</span>` : item.status === 'error' ? html`<span class="trow-flag error">Failed</span>` : item.status === 'denied' ? html`<span class="trow-flag denied">Denied</span>` : null}
        </div>
      </div>
      <span class="grow" />
      ${started != null && !noResult(item, sid) ? html`<${AgentElapsed} from=${started} to=${running ? null : ended} sid=${sid} />` : null}
    </div>
    <div class="agent-actions">
      ${input.prompt ? html`<button type="button" class="agent-tog" aria-expanded=${promptOpen} onClick=${() => toggle(keyPrompt, false)}>
        <${Icon} name="chevron-right" size=${11} />Prompt</button>` : null}
      ${children.length ? html`<button type="button" class="agent-tog" aria-expanded=${kidsOpen} onClick=${() => toggle(keyKids, false)}>
        <${Icon} name="chevron-right" size=${11} />${plural(nTools, 'tool call')}</button>` : null}
    </div>
    ${promptOpen ? html`<div class="agent-prompt">${input.prompt}</div>` : null}
    ${kidsOpen ? html`<div class="agent-kids">${children.map((c) => html`<${ToolRow} key=${c.id} item=${c} cwd=${cwd} sid=${sid}
        desc=${isAgent(c.name) ? descendants(c.toolUseId) : undefined} />`)}</div>`
      : runningKid ? html`<div class="agent-kids live"><${ToolRow} item=${runningKid} cwd=${cwd} sid=${sid} /></div>` : null}
    ${text ? html`<div class=${'agent-result' + (resOpen ? '' : ' clamp')} onClick=${() => !resOpen && toggle(keyRes, false)}>
      <${Markdown} text=${text} /></div>` : null}
  </div>`;
}
