// Owner: lane panels (E). Files panel: lazy tree of the session's folder, quick search, file viewer.
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import hljs from 'hljs';
import hljsPowershell from 'hljs-powershell';
import { html, Icon, cx, Loading, Empty, ErrorState } from './util.js';
import { activeSession, rpc, toast } from '../lib/store.js';
import { on } from '../lib/transport.js';
import { sheetOpen } from '../shell/state.js';
import { useLiveLoad, useDebounced, pathKey, relTo, PathLabel } from './changes.js';

try { if (!hljs.getLanguage('powershell')) hljs.registerLanguage('powershell', hljsPowershell); } catch { /* optional grammar */ }

const MAX_READ = 400_000;
const HL_MAX = 200_000;          // above this: plain text
const AUTO_MAX = 30_000;         // highlightAuto only for small files
const INDENT = 13;

// ---------- add to prompt (review-tools lane) ----------
// Text files go in as an @mention (relative to the session folder; a plain path outside it). Images
// (png/jpg/webp/gif up to 5 MB) attach to the composer as image attachments from files.read's dataUrl.
const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
const IMG_MAX = 5 * 1024 * 1024;
const fname = (p) => String(p || '').split(/[\\/]/).pop();
export const isAttachableImage = (p) => IMG_RE.test(String(p || ''));

export function mentionFor(cwd, path) {
  const abs = String(path || '').replace(/\\/g, '/');
  const rel = relTo(cwd, path);
  if (rel !== abs) return /\s/.test(rel) ? `"${rel}"` : '@' + rel;
  return /\s/.test(path) ? `"${path}"` : String(path);
}

// While the phone sheet covers the composer, don't focus it (that would raise the keyboard); confirm with a toast.
const covered = () => !!sheetOpen.value;

export function addToPrompt(cwd, path) {
  const text = mentionFor(cwd, path);
  window.dispatchEvent(new CustomEvent('helm:composer-insert', { detail: { text, mode: 'word', focus: !covered() } }));
  if (covered()) toast({ title: 'Added to your message', body: text, kind: 'info' });
}

export async function attachImage(path, known = null) {
  const tooBig = () => new Error(`${fname(path)} is over 5 MB; only images up to 5 MB can be attached.`);
  try {
    if (known && known.size > IMG_MAX) throw tooBig();
    const r = known && known.dataUrl ? known : await rpc('files.read', { path, maxBytes: 1 });
    if (!r || !r.dataUrl) throw (r && r.size > IMG_MAX ? tooBig() : new Error(`${fname(path)} could not be read as an image.`));
    window.dispatchEvent(new CustomEvent('helm:composer-attach', { detail: { attachments: [{ kind: 'image', name: fname(path), mime: r.mime || 'image/png', dataUrl: r.dataUrl, size: r.size }], focus: !covered() } }));
    if (covered()) toast({ title: 'Image attached to your message', body: fname(path), kind: 'info' });
  } catch (e) { toast({ title: 'Image not attached', error: e, kind: 'warn' }); }
}

// Row action: hover-revealed on desktop, always shown on touch (CSS). `entry`: { path, name, size }.
function AddBtn({ cwd, entry }) {
  const img = isAttachableImage(entry.path);
  const label = img ? 'Attach image to your message' : 'Add to prompt';
  return html`<button type="button" class="icon-btn sm pn-fi-add" aria-label=${label + ': ' + entry.name} title=${label}
    onClick=${(e) => { e.stopPropagation(); if (img) attachImage(entry.path, entry.size > IMG_MAX ? entry : null); else addToPrompt(cwd, entry.path); }}>
    <${Icon} name=${img ? 'image' : 'at'} size=${13} /></button>`;
}

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'dos', cmd: 'dos', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql', php: 'php', lua: 'lua', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
};
function langFor(path) {
  const name = String(path).split(/[\\/]/).pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const l = LANG[ext];
  return l && hljs.getLanguage(l) ? l : null;
}

function fmtSize(b) {
  if (b == null || !isFinite(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const sortEntries = (list) => [...(list || [])].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

const GIT_TONE = { M: 'pn-fi-gm', A: 'ok', D: 'danger', '??': 'pn-fi-gu', U: 'pn-fi-gu' };

function scrollParent(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return null;
}

// ---------- viewer ----------

function Viewer({ cwd, path, onBack }) {
  const f = useLiveLoad(() => rpc('files.read', { path, maxBytes: MAX_READ }), [path]);
  const refresh = useDebounced(() => f.refresh(), 250);
  useEffect(() => on('files.changed', (d) => { if (d && pathKey(d.path) === pathKey(path)) refresh(); }), [path, refresh]);

  const view = useMemo(() => {
    const text = f.data?.text;
    if (typeof text !== 'string') return null;
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length;
    let hl = null; let lang = null;
    if (text.length <= HL_MAX) {
      try {
        lang = langFor(path);
        if (lang) hl = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        else if (text.length <= AUTO_MAX) { const r = hljs.highlightAuto(text); if (r.relevance >= 5) { hl = r.value; lang = r.language; } }
      } catch { hl = null; }
    }
    return { text, lines, hl, lang };
  }, [f.data, path]);

  const rel = relTo(cwd, path);
  let body;
  if (f.loading) body = html`<${Loading} label="Opening file…" />`;
  else if (f.error) body = html`<${ErrorState} title="Could not open this file" error=${f.error} onRetry=${f.reload} />`;
  else if (f.data?.dataUrl) {
    body = html`<div class="pn-fi-imgwrap">
      <img class="pn-fi-img" src=${f.data.dataUrl} alt=${rel} />
      <div class="pn-muted pn-fi-imgmeta">${f.data.mime} · ${fmtSize(f.data.size)}</div>
    </div>`;
  }
  else if (!view || f.data?.binary) body = html`<${Empty} icon="file" title="No preview">${f.data?.binary && isAttachableImage(path) && f.data.size > IMG_MAX ? 'Images over 5 MB are not previewed or attached.' : f.data?.mime ? `This file (${f.data.mime}) can't be shown as text.` : "This file can't be shown as text."}<//>`;
  else if (!view.text.length) body = html`<${Empty} icon="file" title="Empty file" />`;
  else {
    const nums = Array.from({ length: view.lines }, (_, i) => i + 1).join('\n');
    body = html`<div class="pn-fi-codewrap">
      ${f.data.truncated && html`<div class="pn-note pn-note-warn pn-fi-trunc">Truncated — showing the first ${Math.round(MAX_READ / 1024)} KB.</div>`}
      <div class="pn-fi-code mono">
        <pre class="pn-fi-gut" aria-hidden="true">${nums}</pre>
        <div class="pn-fi-scroll">${view.hl
          ? html`<pre class="pn-fi-pre hljs" dangerouslySetInnerHTML=${{ __html: view.hl }}></pre>`
          : html`<pre class="pn-fi-pre">${view.text}</pre>`}</div>
      </div>
    </div>`;
  }

  return html`<div class="pn pn-fi">
    <div class="pn-bar pn-fi-vbar">
      <button class="icon-btn sm" aria-label="Back to files" title="Back" onClick=${onBack}><${Icon} name="arrow-left" size=${15} /></button>
      <span class="pn-bar-grow mono pn-fi-vpath"><${PathLabel} rel=${rel} title=${path} /></span>
      ${view && !f.data?.binary && html`<span class="pn-muted pn-num pn-fi-vmeta" title=${view.lang ? `Highlighted as ${view.lang}` : 'Plain text'}>${view.lines.toLocaleString()} lines</span>`}
      ${f.data?.dataUrl
        ? html`<button type="button" class="btn btn-ghost btn-sm pn-fi-addbtn" title="Attach this image to your message" onClick=${() => attachImage(path, f.data)}><${Icon} name="image" size=${13} />Attach</button>`
        : html`<button type="button" class="btn btn-ghost btn-sm pn-fi-addbtn" title=${'Insert ' + mentionFor(cwd, path) + ' into your message'} onClick=${() => addToPrompt(cwd, path)}><${Icon} name="at" size=${13} />Add to prompt</button>`}
      <button class=${cx('icon-btn sm', f.refreshing && 'pn-ch-busy')} aria-label="Reload file" title="Reload" onClick=${() => f.refresh()}><${Icon} name="refresh" size=${14} /></button>
    </div>
    ${body}
  </div>`;
}

// ---------- panel ----------

export function FilesPanel() {
  const session = activeSession.value;
  const sid = session?.id || null;
  const cwd = session?.cwd || '';
  const [kids, setKids] = useState({});          // { [pathKey]: { data, error, loading } }
  const [openDirs, setOpenDirs] = useState({});  // { [pathKey]: true }
  const [viewing, setViewing] = useState(null);  // file path
  const [q, setQ] = useState('');
  const [search, setSearch] = useState({ q: '', data: null, error: null, loading: false });
  const [touchedEv, setTouchedEv] = useState({}); // { [pathKey]: true } from files.changed since mount
  const rootRef = useRef(null);
  const savedScroll = useRef(0);
  const searchSeq = useRef(0);
  const kidsRef = useRef(kids); kidsRef.current = kids;

  // ---- tree loading ----
  const loadDir = useCallback((dir) => {
    const k = pathKey(dir);
    setKids((m) => ({ ...m, [k]: { ...(m[k] || {}), loading: true, error: null } }));
    rpc('files.tree', { cwd, path: dir }).then(
      (data) => setKids((m) => ({ ...m, [k]: { data: sortEntries(data), error: null, loading: false } })),
      (error) => setKids((m) => ({ ...m, [k]: { data: undefined, error, loading: false } })),
    );
  }, [cwd]);

  useEffect(() => {
    setKids({}); setOpenDirs({}); setViewing(null); setQ(''); setSearch({ q: '', data: null, error: null, loading: false });
    if (cwd) loadDir(cwd);
  }, [cwd, loadDir]);

  // ---- touched files: this session's changes + live writes ----
  const ch = useLiveLoad(() => (sid ? rpc('files.changes', { sessionId: sid }) : []), [sid]);
  const refreshCh = useDebounced(() => ch.refresh(), 400);
  useEffect(() => { setTouchedEv({}); }, [sid]);
  useEffect(() => {
    if (!sid) return undefined;
    return on('files.changed', (d) => {
      if (!d?.path || (d.sessionId && d.sessionId !== sid)) return;
      setTouchedEv((m) => (m[pathKey(d.path)] ? m : { ...m, [pathKey(d.path)]: true }));
      refreshCh();
      // refresh the listing of the folder that holds it, if loaded
      const parent = String(d.path).replace(/[\\/][^\\/]*$/, '');
      if (kidsRef.current[pathKey(parent)]) loadDir(parent);
    });
  }, [sid, refreshCh, loadDir]);

  const touched = useMemo(() => {
    const files = new Set(Object.keys(touchedEv));
    for (const c of ch.data || []) if (c?.path) files.add(pathKey(c.path));
    const dirs = new Set();
    for (const f of files) { let i = f.lastIndexOf('/'); while (i > 0) { dirs.add(f.slice(0, i)); i = f.lastIndexOf('/', i - 1); } }
    return { files, dirs };
  }, [touchedEv, ch.data]);

  // ---- search ----
  const runSearch = useDebounced(() => {
    const term = q.trim();
    if (!term || !cwd) return;
    const my = ++searchSeq.current;
    setSearch((s) => ({ ...s, q: term, loading: true, error: null }));
    rpc('files.search', { cwd, q: term, limit: 50 }).then(
      (data) => { if (my === searchSeq.current) setSearch({ q: term, data: data || [], error: null, loading: false }); },
      (error) => { if (my === searchSeq.current) setSearch({ q: term, data: null, error, loading: false }); },
    );
  }, 150);
  useEffect(() => { if (q.trim()) runSearch(); else { searchSeq.current++; setSearch({ q: '', data: null, error: null, loading: false }); } }, [q, runSearch]);

  // ---- viewer open / back, keeping the tree's scroll ----
  const openFile = (p) => {
    const sp = scrollParent(rootRef.current);
    savedScroll.current = sp ? sp.scrollTop : 0;
    setViewing(p);
    if (sp) sp.scrollTop = 0;
  };
  const backToTree = () => setViewing(null);
  useLayoutEffect(() => {
    if (viewing) return;
    const sp = scrollParent(rootRef.current);
    if (sp && savedScroll.current) sp.scrollTop = savedScroll.current;
  }, [viewing]);

  if (!session) return html`<div class="pn"><${Empty} icon="files" title="No session selected">Pick a session to browse its folder.<//></div>`;
  if (!cwd) return html`<div class="pn"><${Empty} icon="folder" title="No folder">This session has no working folder.<//></div>`;
  if (viewing) return html`<${Viewer} cwd=${cwd} path=${viewing} onBack=${backToTree} />`;

  const toggle = (e) => {
    const k = pathKey(e.path);
    if (openDirs[k]) { setOpenDirs((m) => { const n = { ...m }; delete n[k]; return n; }); return; }
    setOpenDirs((m) => ({ ...m, [k]: true }));
    if (!kids[k] || kids[k].error) loadDir(e.path);
  };

  // flatten the expanded tree into rows
  const rows = [];
  const walk = (dir, depth) => {
    const node = kids[pathKey(dir)];
    if (!node) return;
    if (node.loading && !node.data) { rows.push(html`<div class="pn-fi-sub pn-muted" style=${{ paddingLeft: `${12 + depth * INDENT + 17}px` }} key=${'ld:' + dir}>Loading…</div>`); return; }
    if (node.error) {
      rows.push(html`<div class="pn-fi-sub pn-fi-suberr" style=${{ paddingLeft: `${12 + depth * INDENT + 17}px` }} key=${'er:' + dir}>
        <span class="pn-fi-suberr-msg" title=${node.error.message}>${node.error.message || 'Could not read folder'}</span>
        <button class="btn btn-ghost btn-sm" onClick=${() => loadDir(dir)}>Retry</button></div>`);
      return;
    }
    if (depth > 0 && !node.data?.length) { rows.push(html`<div class="pn-fi-sub pn-muted" style=${{ paddingLeft: `${12 + depth * INDENT + 17}px` }} key=${'em:' + dir}>Empty folder</div>`); return; }
    for (const e of node.data || []) {
      const k = pathKey(e.path);
      const isOpen = !!openDirs[k];
      const hot = e.dir ? touched.dirs.has(k) : touched.files.has(k);
      const row = html`<button key=${k} class=${cx('pn-fi-row', e.dir && 'dir', hot && 'hot', !e.dir && hot && 'hotfile')}
          style=${{ paddingLeft: `${12 + depth * INDENT}px` }} title=${e.path} aria-expanded=${e.dir ? isOpen : undefined}
          onClick=${() => (e.dir ? toggle(e) : openFile(e.path))}>
        <span class="pn-fi-chev" aria-hidden="true">${e.dir && html`<${Icon} name=${isOpen ? 'chevron-down' : 'chevron-right'} size=${12} />`}</span>
        <${Icon} name=${e.dir ? (isOpen ? 'folder-open' : 'folder') : 'file'} size=${14} class="pn-fi-ico" />
        <span class="pn-fi-name">${e.name}</span>
        ${hot && html`<span class="pn-fi-hot" title=${e.dir ? 'Contains files this session touched' : 'Touched by this session'}></span>`}
        <span class="pn-fi-meta">
          ${e.gitStatus && html`<span class=${cx('pn-tag', 'pn-fi-git', GIT_TONE[e.gitStatus])} title=${`git: ${e.gitStatus}`}>${e.gitStatus}</span>`}
          ${!e.dir && html`<span class="pn-fi-size pn-num">${fmtSize(e.size)}</span>`}
        </span>
      </button>`;
      // files get a row action (Add to prompt / Attach image) beside the button, never nested in it
      rows.push(e.dir ? row : html`<div class="pn-fi-rowwrap" key=${k}>${row}<${AddBtn} cwd=${cwd} entry=${e} /></div>`);
      if (e.dir && isOpen) walk(e.path, depth + 1);
    }
  };

  const root = kids[pathKey(cwd)];
  let body;
  if (q.trim()) {
    if (search.error) body = html`<${ErrorState} title="Search failed" error=${search.error} onRetry=${runSearch} />`;
    else if (!search.data) body = html`<${Loading} label="Searching…" />`;
    else if (!search.data.length) body = html`<${Empty} icon="search" title="No matches">Nothing in this folder matches “${search.q}”.<//>`;
    else body = html`<div class="pn-fi-results" role="list">${search.data.map((r) => {
      const hot = touched.files.has(pathKey(r.path));
      return html`<div role="listitem" class="pn-fi-rowwrap" key=${r.path}><button class=${cx('pn-fi-row', 'pn-fi-res', hot && 'hot hotfile')} title=${r.path} onClick=${() => openFile(r.path)}>
        <${Icon} name="file" size=${14} class="pn-fi-ico" />
        <span class="pn-fi-name mono"><${PathLabel} rel=${r.rel || relTo(cwd, r.path)} title=${r.path} /></span>
        ${hot && html`<span class="pn-fi-hot" title="Touched by this session"></span>`}
      </button><${AddBtn} cwd=${cwd} entry=${{ path: r.path, name: r.rel || fname(r.path) }} /></div>`;
    })}</div>`;
  } else if (!root || (root.loading && !root.data)) body = html`<${Loading} label="Loading folder…" />`;
  else if (root.error) body = html`<${ErrorState} title="Could not read this folder" error=${root.error} onRetry=${() => loadDir(cwd)} />`;
  else if (!root.data?.length) body = html`<${Empty} icon="folder" title="Empty folder" />`;
  else { walk(cwd, 0); body = html`<div class="pn-fi-tree" role="tree">${rows}</div>`; }

  const projectName = String(cwd).split(/[\\/]/).filter(Boolean).pop() || cwd;
  return html`<div class="pn pn-fi" ref=${rootRef}>
    <div class="pn-bar pn-fi-bar">
      <label class="pn-fi-search">
        <${Icon} name="search" size=${13} class="pn-fi-search-ico" />
        <input class="input sm" type="search" placeholder=${`Find in ${projectName}`} aria-label="Find a file" value=${q}
          onInput=${(e) => setQ(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); } }} />
      </label>
      <button class="icon-btn sm" aria-label="Refresh tree" title="Refresh" onClick=${() => { loadDir(cwd); Object.keys(openDirs).forEach((k) => { const n = findPath(kids, k); if (n) loadDir(n); }); }}><${Icon} name="refresh" size=${14} /></button>
    </div>
    ${body}
  </div>`;
}

// Recover an original-cased path for a pathKey from the loaded listings (for refresh).
function findPath(kids, k) {
  for (const node of Object.values(kids)) for (const e of node.data || []) if (pathKey(e.path) === k) return e.path;
  return null;
}
