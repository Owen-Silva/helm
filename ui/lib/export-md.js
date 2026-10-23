// Session -> Markdown (session "…" menu: Export as Markdown / Copy as Markdown). Lane git-export.
// PURE and import-free so test/host/export-md.test.js can require() it: title, folder, model and date,
// then every prompt and reply in order; tool calls collapse to one-line summaries ("Ran `npm test`",
// "Edited `src/a.js` (+3 −1)"); thinking, results, init/hook noise and subagent internals are left out.

// Inline code that survives backticks inside the text (CommonMark: a longer fence, padded if needed).
export function code(s) {
  const t = String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  const runs = t.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

const clip = (s, n = 140) => { const t = String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const lines = (s) => { const t = String(s ?? ''); return t === '' ? [] : t.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'); };

// Path relative to the session folder when it is inside it (either slash, any case on Windows).
export function relPath(p, cwd) {
  const s = String(p ?? '');
  if (!cwd || !s) return s;
  const norm = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(s), base = norm(String(cwd));
  if (a.toLowerCase().startsWith(base.toLowerCase() + '/')) return a.slice(base.length + 1);
  return s;
}

// +added −removed for an old -> new replacement: lines only on one side (a multiset difference),
// so an edit that changes one line of five reads (+1 −1), not (+5 −5).
export function lineDelta(oldText, newText) {
  const a = lines(oldText), b = lines(newText);
  const count = new Map();
  for (const l of a) count.set(l, (count.get(l) || 0) + 1);
  let added = 0;
  for (const l of b) { const n = count.get(l) || 0; if (n > 0) count.set(l, n - 1); else added++; }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

const delta = ({ added, removed }) => `(+${added} −${removed})`;

/** One line for a `tool` item, e.g. "Ran `npm test`". */
export function toolSummary(item, cwd) {
  const n = item?.name || 'tool';
  const i = item?.input && typeof item.input === 'object' ? item.input : {};
  const file = (p) => code(relPath(p, cwd));
  let s;
  switch (n) {
    case 'Bash': s = `Ran ${code(clip(i.command, 160))}`; break;
    case 'PowerShell': s = `Ran ${code(clip(i.command, 160))} (PowerShell)`; break;
    case 'Edit': s = `Edited ${file(i.file_path)} ${delta(lineDelta(i.old_string, i.new_string))}`; break;
    case 'MultiEdit': {
      const d = (Array.isArray(i.edits) ? i.edits : []).reduce((acc, e) => { const x = lineDelta(e?.old_string, e?.new_string); return { added: acc.added + x.added, removed: acc.removed + x.removed }; }, { added: 0, removed: 0 });
      s = `Edited ${file(i.file_path)} ${delta(d)}`; break;
    }
    case 'Write': { const k = lines(i.content).length; s = `Wrote ${file(i.file_path)} (${k} ${k === 1 ? 'line' : 'lines'})`; break; }
    case 'NotebookEdit': s = `Edited notebook ${file(i.notebook_path)}`; break;
    case 'Read': s = `Read ${file(i.file_path)}`; break;
    case 'Grep': s = `Searched for ${code(clip(i.pattern, 80))}${i.path ? ` in ${file(i.path)}` : ''}`; break;
    case 'Glob': s = `Listed ${code(clip(i.pattern, 80))}`; break;
    case 'WebFetch': s = `Fetched ${clip(i.url, 160)}`; break;
    case 'WebSearch': s = `Searched the web for “${clip(i.query, 100)}”`; break;
    case 'TodoWrite': { const k = Array.isArray(i.todos) ? i.todos.length : 0; s = `Updated the todo list (${k} ${k === 1 ? 'item' : 'items'})`; break; }
    case 'Agent': case 'Task': s = `Ran an agent: ${clip(i.description || i.subagent_type || 'subagent', 100)}`; break;
    case 'Skill': s = `Used the ${code(i.skill || i.name || 'skill')} skill`; break;
    case 'AskUserQuestion': s = 'Asked a question'; break;
    case 'ExitPlanMode': s = 'Proposed a plan'; break;
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(n);
      s = m ? `Called ${code(m[2])} (${m[1]})` : `Used ${code(n)}`;
    }
  }
  if (item?.interrupted) s += ' (stopped)';
  else if (item?.status === 'error') s += ' (failed)';
  else if (item?.status === 'denied') s += ' (denied)';
  return s;
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtDate(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Suggested file name: "<title> <YYYY-MM-DD>.md" with characters Windows refuses removed. */
export function exportFileName(session, now = Date.now()) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const t = String(session?.title || 'Helm session').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');
  return `${t || 'Helm session'} ${day}.md`;
}

/**
 * sessionToMarkdown(session, items, { now }) -> string
 *   items: the full transcript (oldest first). Items inside a subagent (parentToolUseId) are skipped:
 *   the Agent call's own one-liner stands for them. Queued (unsent) prompts are skipped.
 */
export function sessionToMarkdown(session, items, { now = Date.now() } = {}) {
  const s = session || {};
  const cwd = s.cwd || '';
  const out = [];
  out.push(`# ${String(s.title || 'Helm session').replace(/\r?\n/g, ' ')}`, '');
  if (cwd) out.push(`- **Folder:** ${code(cwd)}`);
  if (s.model) out.push(`- **Model:** ${s.model}${s.effort ? ` (${s.effort} effort)` : ''}`);
  const started = s.createdAt || (items || []).find((i) => i && i.ts)?.ts;
  if (started) out.push(`- **Started:** ${fmtDate(started)}`);
  out.push(`- **Exported:** ${fmtDate(now)} from Helm`, '');

  let speaker = null;   // 'user' | 'assistant' (the heading currently open)
  let tools = [];       // pending tool one-liners under the assistant heading
  const flushTools = () => { if (tools.length) { out.push(tools.map((t) => `- ${t}`).join('\n'), ''); tools = []; } };
  const open = (who) => {
    if (speaker === who) return;
    flushTools();
    out.push('---', '', who === 'user' ? '## You' : '## Claude', '');
    speaker = who;
  };

  for (const it of items || []) {
    if (!it || typeof it !== 'object' || it.parentToolUseId) continue;
    switch (it.type) {
      case 'user': {
        if (it.queued) break;
        open('user');
        const text = String(it.text || '').trim();
        if (text) out.push(text, '');
        const att = (it.attachments || []).map((a) => a && a.name).filter(Boolean);
        if (att.length) out.push(`*Attached: ${att.map((n) => code(n)).join(', ')}*`, '');
        break;
      }
      case 'assistant': {
        const text = String(it.text || '').trim();
        if (!text) break;
        open('assistant');
        flushTools();
        out.push(text, '');
        break;
      }
      case 'shell': {   // a `!` run the user typed in the composer
        open('user');
        const end = it.status === 'stopped' ? 'stopped' : it.exitCode != null ? `exit ${it.exitCode}` : '';
        out.push(`Ran ${code(clip(it.command, 160))} in the shell${end ? ` (${end})` : ''}`, '');
        break;
      }
      case 'tool': {
        if (it.name === 'AskUserQuestion' || it.name === 'ExitPlanMode') break; // the request item says it better
        open('assistant');
        tools.push(toolSummary(it, cwd));
        break;
      }
      case 'request': {
        if (it.kind === 'question') {
          open('assistant');
          flushTools();
          const qs = (it.questions || []).map((q) => q && q.question).filter(Boolean);
          out.push(`> **Asked:** ${qs.join(' / ') || 'a question'}`);
          const a = answerText(it.answer);
          if (a) out.push(`>`, `> **Answer:** ${a}`);
          out.push('');
        } else if (it.kind === 'plan') {
          open('assistant');
          flushTools();
          out.push('**Proposed plan:**', '');
          const plan = String(it.plan || it.input?.plan || '').trim();
          if (plan) out.push(plan.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n'), '');
          if (it.status === 'answered') out.push(`*Plan ${planVerdict(it.answer)}.*`, '');
        }
        break;
      }
      case 'system': {
        if (it.subtype === 'compact') { flushTools(); out.push('*Conversation compacted.*', ''); }
        else if (it.subtype === 'interrupted') { flushTools(); out.push('*Stopped by you.*', ''); }
        else if (it.subtype === 'error' && it.text) { flushTools(); out.push(`*Error: ${clip(it.text, 300)}*`, ''); }
        else if (it.rewind) { flushTools(); out.push(`*${clip(it.text || 'Rewound', 200)}*`, ''); }
        break;
      }
      default: break; // thinking, result, init, hook: left out
    }
  }
  flushTools();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

function answerText(a) {
  if (a == null) return '';
  if (typeof a === 'string') return clip(a, 400);
  if (typeof a === 'object') {
    const ans = a.answers && typeof a.answers === 'object' ? a.answers : a;
    const vals = Object.values(ans).map((v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '')).filter(Boolean);
    return clip(vals.join(' / '), 400);
  }
  return '';
}
function planVerdict(a) {
  const b = a && typeof a === 'object' ? a.behavior : a;
  return b === 'deny' ? 'sent back' : 'approved';
}
