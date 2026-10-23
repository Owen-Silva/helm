// Reusable detail views: highlighted code, diffs, command output, todo checklists, JSON.
import { useState, useMemo } from 'preact/hooks';
import { diffLines } from 'diff';
import { html } from '../lib/html.js';
import { highlightLines, escapeHtml } from '../lib/markdown.js';
import { Icon } from '../lib/icons.js';
import { stripAnsi, countLines, copyText, plural } from './util.js';

function CopyBtn({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  const onClick = (e) => { e.stopPropagation(); copyText(text).then((ok) => { setDone(ok); setTimeout(() => setDone(false), 1400); }); };
  return html`<button type="button" class="cv-copy" onClick=${onClick} title="Copy" aria-label="Copy">
    <${Icon} name=${done ? 'check' : 'copy'} size=${13} />${label ? html`<span>${done ? 'Copied' : label}</span>` : null}
  </button>`;
}

// Highlighted code with an optional line-number gutter. `numbers`: array of labels per line,
// true for 1..n from `start`, or false. Collapses past `max` lines.
export function CodeView({ code, lang, start = 1, numbers = true, max = 18, head, copy = true, wrap = false }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => highlightLines(String(code ?? '').replace(/\n$/, ''), lang), [code, lang]);
  const shown = all || lines.length <= max + 4 ? lines : lines.slice(0, max);
  const nums = Array.isArray(numbers) ? numbers : numbers ? lines.map((_, i) => String(start + i)) : null;
  return html`<div class=${'cv' + (wrap ? ' wrap' : '')}>
    ${head || copy ? html`<div class="cv-head">${head || html`<span class="cv-lang">${lang || 'text'}</span>`}<span class="grow" />${copy ? html`<${CopyBtn} text=${code} label="" />` : null}</div>` : null}
    <div class="cv-body">
      ${nums ? html`<div class="cv-gutter" aria-hidden="true">${shown.map((_, i) => html`<div>${nums[i] || ' '}</div>`)}</div>` : null}
      <pre class="cv-code hljs"><code>${shown.map((l) => html`<div class="cv-line" dangerouslySetInnerHTML=${{ __html: l || ' ' }} />`)}</code></pre>
    </div>
    ${shown.length < lines.length ? html`<button type="button" class="cv-more" onClick=${() => setAll(true)}>Show all ${lines.length} lines</button>` : null}
  </div>`;
}

// ---- diffs ----
const CONTEXT = 3;
// old_string/new_string rarely end in a newline; normalise so the last line isn't a false change
const nl = (t) => { const s = String(t ?? ''); return s && !s.endsWith('\n') ? s + '\n' : s; };
export function diffStats(oldText, newText) {
  let add = 0, del = 0;
  for (const part of diffLines(nl(oldText), nl(newText))) {
    const n = countLines(part.value);
    if (part.added) add += n; else if (part.removed) del += n;
  }
  return { add, del };
}

function buildRows(oldText, newText, lang) {
  const o = nl(oldText), n = nl(newText);
  const oh = highlightLines(o.replace(/\n$/, ''), lang), nh = highlightLines(n.replace(/\n$/, ''), lang);
  let oi = 0, ni = 0;
  const rows = [];
  for (const part of diffLines(o, n)) {
    const k = countLines(part.value);
    for (let j = 0; j < k; j++) {
      if (part.added) rows.push({ t: 'add', h: nh[ni++] ?? '', n: ni });
      else if (part.removed) rows.push({ t: 'del', h: oh[oi++] ?? '', o: oi });
      else { rows.push({ t: 'ctx', h: nh[ni++] ?? '', o: ++oi, n: ni }); }
    }
  }
  // fold long unchanged runs
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== 'ctx') { out.push(rows[i++]); continue; }
    let j = i; while (j < rows.length && rows[j].t === 'ctx') j++;
    const run = rows.slice(i, j);
    const lead = i === 0 ? 0 : CONTEXT, tail = j === rows.length ? 0 : CONTEXT;
    if (run.length > lead + tail + 2) {
      out.push(...run.slice(0, lead), { t: 'fold', count: run.length - lead - tail, rows: run.slice(lead, run.length - tail) }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

function DiffRows({ rows }) {
  const [unfolded, setUnfolded] = useState({});
  const list = [];
  rows.forEach((r, i) => {
    if (r.t === 'fold') {
      if (unfolded[i]) r.rows.forEach((x) => list.push(x));
      else list.push({ ...r, i });
    } else list.push(r);
  });
  return html`<div class="dv-rows">${list.map((r) => r.t === 'fold'
    ? html`<button type="button" class="dv-fold" onClick=${() => setUnfolded({ ...unfolded, [r.i]: true })}>${plural(r.count, 'unchanged line')}</button>`
    : html`<div class=${'dv-row ' + r.t}><span class="dv-sign" aria-hidden="true">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''}</span><span class="dv-code" dangerouslySetInnerHTML=${{ __html: r.h || ' ' }} /></div>`)}</div>`;
}

// hunks: [{ old, new }]
export function DiffView({ path, hunks, lang, max = 60 }) {
  const [all, setAll] = useState(false);
  const data = useMemo(() => hunks.map((h) => buildRows(h.old, h.new, lang)), [hunks, lang]);
  const stats = useMemo(() => hunks.reduce((s, h) => { const d = diffStats(h.old, h.new); return { add: s.add + d.add, del: s.del + d.del }; }, { add: 0, del: 0 }), [hunks]);
  const total = data.reduce((s, r) => s + r.length, 0);
  let budget = all ? Infinity : max;
  return html`<div class="dv">
    ${path ? html`<div class="dv-head"><${Icon} name="file" size=${13} /><span class="dv-path" title=${path}>${path}</span>
      <span class="grow" /><span class="n-add">+${stats.add}</span><span class="n-del">−${stats.del}</span></div>` : null}
    <div class="dv-body hljs">
      ${data.map((rows, i) => {
        if (budget <= 0) return null;
        const take = rows.slice(0, budget); budget -= take.length;
        return html`${i > 0 ? html`<div class="dv-sep" aria-hidden="true">⋯</div>` : null}<${DiffRows} rows=${take} />`;
      })}
    </div>
    ${!all && total > max ? html`<button type="button" class="cv-more" onClick=${() => setAll(true)}>Show full diff</button>` : null}
  </div>`;
}

// ---- command output ----
const HEAD = 6, TAIL = 14;
export function OutputView({ text, tone = '', max = 20, empty = 'No output', bare = false }) {
  const [all, setAll] = useState(false);
  const clean = useMemo(() => stripAnsi(text).replace(/\r(?!\n)/g, '\n').replace(/\s+$/, ''), [text]);
  if (!clean) return html`<div class=${'ov ov-empty' + (bare ? ' bare' : '')}>${empty}</div>`;
  const lines = clean.split('\n');
  // Head and tail scale with `max` (20 → 6 + 14), so a fold always hides at least 5 lines; the
  // toggle never offers 0 (it used to with max < 20: fixed 6 + 14 shown, fold past max + 4).
  const head = Math.min(HEAD, Math.max(2, Math.round(max * 0.3)));
  const tail = Math.max(1, Math.min(TAIL, max - head));
  const hidden = lines.length - head - tail;
  const fold = !all && lines.length > max + 4 && hidden > 0;
  return html`<div class=${'ov ' + tone + (bare ? ' bare' : '')}>
    <pre class="ov-pre">${fold ? lines.slice(0, head).join('\n') : clean}</pre>
    ${fold ? html`<button type="button" class="ov-fold" onClick=${() => setAll(true)}>Show ${hidden} hidden ${hidden === 1 ? 'line' : 'lines'}</button>
      <pre class="ov-pre">${lines.slice(-tail).join('\n')}</pre>` : null}
    <${CopyBtn} text=${clean} label="" />
  </div>`;
}

// ---- todos ----
export function TodoList({ todos = [], compact = false }) {
  return html`<ul class=${'todo' + (compact ? ' compact' : '')}>${todos.map((t) => html`<li class=${'todo-' + t.status}>
    <${Icon} name=${t.status === 'completed' ? 'circle-check' : t.status === 'in_progress' ? 'circle-dot' : 'circle'} size=${14} />
    <span>${t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span></li>`)}</ul>`;
}

// ---- JSON ----
export function JsonView({ value, max = 24 }) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  return html`<${CodeView} code=${text ?? ''} lang=${typeof value === 'string' ? '' : 'json'} numbers=${false} max=${max} />`;
}

export { CopyBtn, escapeHtml };
