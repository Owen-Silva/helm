// Settings -> Claude Code: the user's CLAUDE.md files, auto-memory notes (with index health) and what the
// selected session's Claude Code reported at init. Reads/writes go through claudeConfig.* (main/claude-config.js
// enforces the path allowlist, the mtime check and the backup). Saving needs an explicit Save click.
// Owner: lane cc-config.
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { Markdown } from '../lib/markdown.js';
import { rpc, activeId, activeSession } from '../lib/store.js';
import { cx, fmtBytes, agoLong } from './util.js';
import { copyText } from './phone.js';

const tilde = (p, home) => (p && home && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p || '');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const meta = (size, mtime) => [size != null && fmtBytes(size), mtime && `edited ${agoLong(mtime)}`].filter(Boolean).join(' · ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const folderLabel = (f, home) => (f.isHome ? 'Home' : f.project ? baseName(f.project) : f.slug);
const issues = (f) => f.broken + f.unindexed.length + (f.index.exists ? 0 : 1);

// ---------------------------------------------------------------- instructions
function Instructions({ data, onOpen }) {
  const { global: g, projects } = data.instructions;
  const home = data.home;
  const withFiles = projects.filter((p) => p.files.length);
  const without = projects.filter((p) => !p.files.length);
  const fileRow = (f, title, openTitle) => f.blocked
    ? html`<div class="cc-item blocked" key=${f.path}>
        <div class="cc-item-main"><span class="cc-item-title">${title}</span><span class="cc-item-sub">${f.blocked}</span></div>
        <span class="chip warn">Not opened</span>
      </div>`
    : html`<button class="cc-item" key=${f.path} onClick=${() => onOpen({ path: f.path, title: openTitle || `${baseName(f.project)} · ${f.rel}` })}>
        <div class="cc-item-main"><span class="cc-item-title">${title}</span><span class="cc-item-sub mono truncate" title=${f.path}>${tilde(f.path, home)}</span></div>
        <span class="cc-item-meta">${meta(f.size, f.mtime)}</span>
        <${Icon} name="chevron-right" size=${14} class="cc-chev" />
      </button>`;
  return html`<div class="cc-list">
    <div class="cc-group"><span>Global</span><span class="hint">Applies to every session</span></div>
    ${g.exists ? fileRow(g, 'CLAUDE.md', 'Global CLAUDE.md')
      : html`<div class="cc-item empty"><div class="cc-item-main"><span class="cc-item-title">No global CLAUDE.md</span><span class="cc-item-sub mono">${tilde(g.path, home)} does not exist</span></div></div>`}
    ${withFiles.map((p) => html`<div key=${p.cwd}>
      <div class="cc-group"><span>${p.name}</span><span class="hint mono truncate" title=${p.cwd}>${tilde(p.cwd, home)}</span></div>
      ${p.files.map((f) => fileRow(f, f.rel))}
    </div>`)}
    ${without.length > 0 && html`<p class="cc-foot">No CLAUDE.md, CLAUDE.local.md or .claude/CLAUDE.md in ${without.map((p) => p.name).join(', ')}.</p>`}
    ${!projects.length && html`<p class="cc-foot">Project folders show up here once Helm has a session in them.</p>`}
  </div>`;
}

// ---------------------------------------------------------------- memory
function healthNote(f) {
  const out = [];
  if (!f.index.exists) out.push(html`<p class="cc-health warn"><${Icon} name="alert" size=${14} /><span>No MEMORY.md in this folder, so none of these notes are indexed.</span></p>`);
  const bad = f.entries.filter((e) => e.status !== 'ok');
  if (bad.length) {
    const say = (e) => (e.status === 'missing' ? `line ${e.line} links to ${e.link}, which does not exist` : `line ${e.line} links to ${e.link}, which is outside the memory folder`);
    out.push(html`<p class="cc-health danger"><${Icon} name="x-circle" size=${14} /><span>MEMORY.md has ${plural(bad.length, 'broken line')}: ${bad.length <= 3 ? bad.map(say).join('; ') : `${bad.slice(0, 2).map(say).join('; ')}; and ${bad.length - 2} more (marked below)`}.</span></p>`);
  }
  if (f.unindexed.length) {
    const names = f.unindexed.map((u) => u.file);
    out.push(html`<p class="cc-health warn"><${Icon} name="alert" size=${14} /><span>${plural(names.length, 'note is', 'notes are')} missing from MEMORY.md, so ${names.length === 1 ? 'it is' : 'they are'} not in the index Claude Code loads: ${names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`}.</span></p>`);
  }
  if (!out.length) out.push(html`<p class="cc-health ok"><${Icon} name="check-circle" size=${14} /><span>Index OK: all ${plural(f.entries.length, 'note')} listed and every link works.</span></p>`);
  return out;
}

function Memory({ data, q, setQ, slug, setSlug, onOpen }) {
  const { folders, emptyFolders, skipped } = data.memory;
  const home = data.home;
  const [body, setBody] = useState(null);           // { q, results } from claudeConfig.search (body matches)
  const [searchErr, setSearchErr] = useState(null);
  const query = q.trim().toLowerCase();
  useEffect(() => {
    if (!query) { setBody(null); setSearchErr(null); return undefined; }
    // the search reads the notes asynchronously in main, so an older query can answer after a newer one: only the
    // query still typed applies its answer
    let live = true;
    const t = setTimeout(() => rpc('claudeConfig.search', { q: query }).then((r) => { if (live) { setBody(r); setSearchErr(null); } }, (e) => { if (live) setSearchErr(e.message); }), 220);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  const hits = useMemo(() => new Map((body && body.q === query ? body.results : []).map((r) => [r.path.toLowerCase(), r])), [body, query]);
  const match = (strs, p) => !query || strs.some((s) => String(s || '').toLowerCase().includes(query)) || (p && hits.has(p.toLowerCase()));
  const filter = (f) => ({
    entries: f.entries.filter((e) => match([e.title, e.hook, e.link, e.file?.name, e.file?.description, e.file?.type], e.status === 'ok' && e.path)),
    unindexed: f.unindexed.filter((u) => match([u.file, u.name, u.description, u.type], u.path)),
  });
  if (!folders.length) {
    return html`<div class="state-note"><${Icon} name="info" size=${16} /><div><strong>No memory notes yet</strong><p>Claude Code keeps them in ${tilde(data.claudeDir, home)}/projects/*/memory/.</p></div></div>`;
  }
  const f = folders.find((x) => x.slug === slug) || folders[0];
  const shown = filter(f);
  const snippet = (p) => { const h = p && hits.get(p.toLowerCase()); return h && h.where === 'body' ? h.snippet : null; };
  const noteRow = (key, path, title, sub, type, flag) => html`<button class="cc-item" key=${key} onClick=${() => onOpen({ path, title })}>
    <div class="cc-item-main">
      <span class="cc-item-title">${title}</span>
      ${sub && html`<span class="cc-item-sub clamp">${sub}</span>`}
      ${snippet(path) && html`<span class="cc-item-snip">${snippet(path)}</span>`}
    </div>
    ${flag}
    ${type && html`<span class="chip cc-type">${type}</span>`}
    <${Icon} name="chevron-right" size=${14} class="cc-chev" />
  </button>`;
  return html`<div class="cc-mem">
    <div class="cc-tools">
      <label class="cc-search">
        <${Icon} name="search" size=${15} />
        <input class="view-search-input" type="search" value=${q} placeholder="Search notes: name, description, text" aria-label="Search memory notes"
          onInput=${(e) => setQ(e.currentTarget.value)} />
        ${q && html`<button class="icon-btn sm" aria-label="Clear search" onClick=${() => setQ('')}><${Icon} name="x" size=${14} /></button>`}
      </label>
      ${folders.length > 1 && html`<div class="cc-folders" role="group" aria-label="Memory folder">
        ${folders.map((x) => {
          const n = query ? (() => { const s = filter(x); return s.entries.length + s.unindexed.length; })() : x.fileCount;
          return html`<button key=${x.slug} class="chip" aria-pressed=${x.slug === f.slug} title=${x.project || x.slug} onClick=${() => setSlug(x.slug)}>
            ${folderLabel(x, home)}<span class="cc-count">${n}</span>${issues(x) > 0 && html`<span class="cc-flag" aria-label="has index problems"></span>`}
          </button>`;
        })}
      </div>`}
    </div>
    <div class="cc-folder-head">
      <div class="cc-folder-id"><span class="cc-folder-name">${f.isHome ? 'Home' : f.project ? baseName(f.project) : f.slug}</span><span class="hint mono truncate" title=${f.dir}>${tilde(f.dir, home)}</span></div>
      ${f.index.exists && html`<button class="btn btn-sm" onClick=${() => onOpen({ path: f.index.path, title: `MEMORY.md · ${folderLabel(f, home)}` })}><${Icon} name="file-text" size=${14} />MEMORY.md</button>`}
    </div>
    ${healthNote(f)}
    ${searchErr && html`<p class="cc-health danger"><${Icon} name="x-circle" size=${14} /><span>Text search failed: ${searchErr}. Name and description matches still show.</span></p>`}
    <div class="cc-list">
      ${shown.entries.map((e) => e.status === 'ok'
        ? noteRow(`i${e.line}`, e.path, e.title, e.hook, e.file?.type)
        : html`<button class="cc-item broken" key=${`i${e.line}`} title="Open MEMORY.md to fix this line" onClick=${() => onOpen({ path: f.index.path, title: `MEMORY.md · ${folderLabel(f, home)}` })}>
            <div class="cc-item-main"><span class="cc-item-title">${e.title}</span>
              <span class="cc-item-sub">Line ${e.line} links to <span class="mono">${e.link}</span>, ${e.status === 'missing' ? 'which does not exist' : 'outside the memory folder'}. Open MEMORY.md to fix it.</span></div>
            <span class="chip danger">${e.status === 'missing' ? 'Missing file' : 'Outside folder'}</span>
            <${Icon} name="chevron-right" size=${14} class="cc-chev" />
          </button>`)}
      ${shown.unindexed.length > 0 && html`<div class="cc-group"><span>Not in MEMORY.md</span><span class="hint">${plural(shown.unindexed.length, 'note')}</span></div>`}
      ${shown.unindexed.map((u) => noteRow(u.path, u.path, u.name || u.file, u.description || u.file, u.type, html`<span class="chip warn">Not indexed</span>`))}
      ${query && !shown.entries.length && !shown.unindexed.length && html`<p class="cc-foot">No notes in this folder match “${q.trim()}”.</p>`}
    </div>
    ${(emptyFolders > 0 || skipped.length > 0) && html`<p class="cc-foot">
      ${emptyFolders > 0 && `${plural(emptyFolders, 'empty memory folder')} hidden. `}
      ${skipped.length > 0 && `${plural(skipped.length, 'folder')} skipped because ${skipped.length === 1 ? 'it is a link' : 'they are links'} pointing elsewhere: ${skipped.map((s) => s.slug).join(', ')}.`}
    </p>`}
  </div>`;
}

// ---------------------------------------------------------------- live session
function InitInfo({ info }) {
  const [allTools, setAllTools] = useState(false);
  const mcp = info.mcpServers || [];
  const tone = (s) => (s === 'connected' ? 'ok' : s === 'failed' ? 'danger' : '');
  const connected = mcp.filter((m) => m.status === 'connected').length;
  const tools = info.tools || [];
  return html`<div class="cc-init">
    <div class="cc-kv">
      <div><span class="hint">Model</span><span class="mono">${info.model || '—'}</span></div>
      <div><span class="hint">Permission mode</span><span class="mono">${info.permissionMode || '—'}</span></div>
      <div><span class="hint">Claude Code</span><span class="mono">${info.version || '—'}</span></div>
    </div>
    <div class="cc-group"><span>MCP servers</span><span class="hint">${mcp.length ? `${connected} of ${mcp.length} connected` : 'none'}</span></div>
    ${mcp.length ? html`<div class="cc-mcp">${mcp.map((m) => html`<div class="cc-mcp-row" key=${m.name}>
        <span class=${cx('dot', tone(m.status) === 'ok' && 'ok', tone(m.status) === 'danger' && 'error', !tone(m.status) && 'idle')}></span>
        <span class="mono truncate">${m.name}</span>
        <span class=${cx('chip', tone(m.status))}>${m.status}</span>
      </div>`)}</div>`
      : html`<p class="cc-foot">No MCP servers reported.</p>`}
    <div class="cc-group"><span>Plugins</span><span class="hint">${(info.plugins || []).length}</span></div>
    <div class="cc-chips">${(info.plugins || []).map((p) => html`<span class="chip" key=${p.name} title=${p.path || ''}>${p.name}</span>`)}${!(info.plugins || []).length && html`<span class="hint">None</span>`}</div>
    <div class="cc-group"><span>Slash commands</span><span class="hint">${(info.slashCommands || []).length}</span></div>
    <div class="cc-chips">${(info.slashCommands || []).map((c) => html`<span class="chip mono" key=${c}>/${c}</span>`)}${!(info.slashCommands || []).length && html`<span class="hint">None</span>`}</div>
    <div class="cc-group"><span>Tools</span><span class="hint">${tools.length}</span></div>
    <div class="cc-chips">
      ${(allTools ? tools : tools.slice(0, 12)).map((t) => html`<span class="chip mono" key=${t}>${t}</span>`)}
      ${tools.length > 12 && html`<button class="chip" onClick=${() => setAllTools(!allTools)}>${allTools ? 'Show fewer' : `+${tools.length - 12} more`}</button>`}
    </div>
  </div>`;
}

function LiveSession() {
  const id = activeId.value;
  const s = activeSession.value;
  const [r, setR] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setR(null);
    rpc('claudeConfig.session', { id: id || undefined }).then((x) => live && setR(x), (e) => live && setR({ error: e.message }));
    return () => { live = false; };
  }, [id, n]);
  if (!r) return html`<div class="state-note"><span class="spinner"></span>Asking the engine…</div>`;
  if (r.error) return html`<p class="cc-health danger"><${Icon} name="x-circle" size=${14} /><span>Could not read the session setup: ${r.error}</span></p>`;
  return html`<div class="cc-live">
    <div class="cc-folder-head">
      <div class="cc-folder-id"><span class="cc-folder-name">${s ? s.title || 'Untitled session' : 'No session selected'}</span>${s && html`<span class="hint mono truncate">${s.cwd}</span>`}</div>
      <button class="btn btn-sm btn-ghost" onClick=${() => setN(n + 1)}><${Icon} name="refresh" size=${14} />Refresh</button>
    </div>
    ${r.info ? html`<p class="cc-foot top">What Claude Code reported when this session started. Read-only.</p><${InitInfo} info=${r.info} />`
      : html`<p class="cc-health"><${Icon} name="info" size=${14} /><span>${r.reason || 'Nothing reported yet.'}</span></p>
        ${r.latest && r.latest.info && html`<p class="cc-foot top">Showing what the most recent session reported${r.latest.at ? ` ${agoLong(r.latest.at)}` : ''} instead.</p><${InitInfo} info=${r.latest.info} />`}`}
  </div>`;
}

// ---------------------------------------------------------------- one file: view, edit, save
function FileView({ target, data, onBack }) {
  const { path, title } = target;
  const [doc, setDoc] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);         // { backupName }
  const [conflict, setConflict] = useState(null);   // message
  const [saveErr, setSaveErr] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const ta = useRef(null);
  const load = () => rpc('claudeConfig.read', { path }).then((d) => { setDoc(d); setLoadErr(null); return d; }, (e) => { setLoadErr(e.message || String(e)); return null; });
  useEffect(() => { load(); }, [path]);
  useEffect(() => { if (editing && ta.current) ta.current.focus(); }, [editing]);
  useEffect(() => { if (!discard) return undefined; const t = setTimeout(() => setDiscard(false), 3000); return () => clearTimeout(t); }, [discard]);

  const dirty = editing && doc && draft !== doc.text;
  const startEdit = () => { setDraft(doc.text); setEditing(true); setSaved(null); setConflict(null); setSaveErr(null); };
  const cancel = () => {
    if (dirty && !discard) { setDiscard(true); return; }
    setEditing(false); setDiscard(false); setConflict(null); setSaveErr(null);
  };
  const save = async () => {
    if (!dirty) { setEditing(false); return; }
    setSaving(true); setConflict(null); setSaveErr(null);
    try {
      const res = await rpc('claudeConfig.write', { path, text: draft, expectMtime: doc.mtime });
      await load();
      setEditing(false); setDiscard(false);
      setSaved({ backupName: res.backupName || '' });
    } catch (e) {
      if (e && e.code === 'conflict') setConflict(e.message);
      else setSaveErr((e && e.message) || String(e));
    } finally { setSaving(false); }
  };
  const reload = async () => { const d = await load(); if (d) { setDraft(d.text); setConflict(null); } };
  const copyDraft = async () => { if (await copyText(draft)) { setCopied(true); setTimeout(() => setCopied(false), 1600); } };

  const head = html`<div class="cc-file-head">
    <button class="icon-btn" aria-label="Back to the list" title="Back" onClick=${() => { if (dirty && !discard) { setDiscard(true); return; } onBack(); }}><${Icon} name="chevron-left" size=${16} /></button>
    <div class="cc-file-id">
      <span class="cc-file-title truncate">${title}</span>
      <span class="hint mono truncate" title=${path}>${tilde(path, data.home)}${doc ? ` · ${meta(doc.size, doc.mtime)}` : ''}</span>
    </div>
    <div class="cc-file-actions">
      ${saved && !editing && html`<span class="cc-saved" title=${saved.backupName ? `Old version kept as ${saved.backupName}` : ''}><${Icon} name="check" size=${14} />Saved · backup kept</span>`}
      ${editing
        ? html`<button class="btn btn-sm btn-ghost" onClick=${cancel}>${discard ? 'Discard changes?' : 'Cancel'}</button>
            <button class="btn btn-sm btn-primary" disabled=${saving || !dirty} onClick=${save}>${saving ? 'Saving…' : 'Save'}</button>`
        : doc && html`<button class="btn btn-sm" onClick=${startEdit}><${Icon} name="pencil" size=${14} />Edit</button>`}
    </div>
  </div>`;

  if (loadErr && !doc) return html`<div class="cc-file">${head}<p class="cc-health danger"><${Icon} name="x-circle" size=${14} /><span>Could not open this file: ${loadErr}</span></p></div>`;
  if (!doc) return html`<div class="cc-file">${head}<div class="state-note"><span class="spinner"></span>Opening…</div></div>`;
  const fm = doc.kind === 'memory' && doc.frontmatter;
  return html`<div class="cc-file">
    ${head}
    ${conflict && html`<div class="cc-health danger cc-conflict" role="alert"><${Icon} name="alert" size=${14} />
      <span>${conflict}</span>
      <span class="cc-conflict-actions">
        <button class="btn btn-sm" onClick=${copyDraft}><${Icon} name=${copied ? 'check' : 'copy'} size=${14} />${copied ? 'Copied' : 'Copy my edit'}</button>
        <button class="btn btn-sm" onClick=${reload}><${Icon} name="refresh" size=${14} />Reload (drops my edit)</button>
      </span>
    </div>`}
    ${saveErr && html`<p class="cc-health danger" role="alert"><${Icon} name="x-circle" size=${14} /><span>Not saved: ${saveErr}</span></p>`}
    ${editing
      ? html`<div class="cc-editor">
          <textarea ref=${ta} class="cc-textarea mono" spellcheck="false" aria-label=${`Edit ${title}`} value=${draft}
            onInput=${(e) => { setDraft(e.currentTarget.value); setDiscard(false); }}></textarea>
          <p class="cc-foot">${dirty ? 'Unsaved changes.' : 'No changes yet.'} Save keeps a copy of the old file in ${tilde(data.backupDir || 'the Helm profile', data.home)} (last 50 kept).${doc.crlf ? ' Windows line endings are kept.' : ''}</p>
        </div>`
      : html`<div class="cc-doc">
          ${fm && html`<dl class="cc-fm">
            ${fm.present ? html`
              <div><dt>Name</dt><dd>${fm.name || html`<span class="hint">not set</span>`}</dd></div>
              <div><dt>Description</dt><dd>${fm.description || html`<span class="hint">not set</span>`}</dd></div>
              <div><dt>Type</dt><dd>${fm.type ? html`<span class="chip cc-type">${fm.type}</span>` : html`<span class="hint">not set</span>`}</dd></div>`
              : html`<div><dt>Frontmatter</dt><dd class="hint">None. This note has no name, description or type.</dd></div>`}
          </dl>`}
          <${Markdown} text=${fm ? doc.body : doc.text} class="prose cc-md" />
          ${!(fm ? doc.body : doc.text).trim() && html`<p class="cc-foot">This file is empty.</p>`}
        </div>`}
  </div>`;
}

// ---------------------------------------------------------------- section body
const TABS = [{ id: 'instructions', label: 'Instructions' }, { id: 'memory', label: 'Memory' }, { id: 'session', label: 'Live session' }];

export function ClaudeCodeSettings() {
  const [tab, setTab] = useState('instructions');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);           // { path, title }
  const [q, setQ] = useState('');
  const [slug, setSlug] = useState(null);
  const top = useRef(null);
  const load = () => rpc('claudeConfig.list').then((d) => { setData(d); setErr(null); }, (e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);
  const go = (t) => { setOpen(t); requestAnimationFrame(() => top.current && top.current.scrollIntoView({ block: 'nearest' })); };
  const back = () => { setOpen(null); load(); };
  const memIssues = data ? data.memory.folders.reduce((n, f) => n + issues(f), 0) : 0;

  let body;
  if (open && data) body = html`<${FileView} target=${open} data=${data} onBack=${back} />`;
  else if (tab === 'session') body = html`<${LiveSession} />`;
  else if (err) body = html`<p class="cc-health danger"><${Icon} name="x-circle" size=${14} /><span>Could not read your Claude Code setup: ${err}</span><button class="btn btn-sm" onClick=${load}>Try again</button></p>`;
  else if (!data) body = html`<div class="state-note"><span class="spinner"></span>Reading your Claude Code setup…</div>`;
  else if (tab === 'memory') body = html`<${Memory} data=${data} q=${q} setQ=${setQ} slug=${slug} setSlug=${setSlug} onOpen=${go} />`;
  else body = html`<${Instructions} data=${data} onOpen=${go} />`;

  return html`<div class="cc" ref=${top}>
    ${!open && html`<div class="cc-tabs" role="group" aria-label="Claude Code view">
      ${TABS.map((t) => html`<button key=${t.id} class="chip" aria-pressed=${tab === t.id} onClick=${() => setTab(t.id)}>
        ${t.label}${t.id === 'memory' && memIssues > 0 && html`<span class="cc-flag" aria-label=${`${memIssues} index problems`}></span>`}
      </button>`)}
    </div>`}
    ${body}
  </div>`;
}
