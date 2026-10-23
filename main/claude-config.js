// Settings -> Claude Code: the user's CLAUDE.md files, auto-memory notes, and what the live session
// reported at init (PROTOCOL "Claude Code config"). These are REAL files, so every path is checked
// against a small allowlist here in main, never in the UI:
//   - <claudeDir>/CLAUDE.md (global instructions)
//   - <project>/CLAUDE.md, <project>/CLAUDE.local.md, <project>/.claude/CLAUDE.md for each project
//     folder Helm knows (sidebar projects + session cwds)
//   - <claudeDir>/projects/<one folder>/memory/<name>.md (directly inside, no deeper)
// A path must be absolute, contain no "." / ".." segments, no ":" past the drive, not be a UNC or
// device path, be an existing regular file with one link, and its real path (junctions and symlinks
// resolved) must be exactly where the allowlist expects it. So a junction or symlink anywhere below
// the root fails closed.
// Writes: only existing files, only when expectMtime still matches, old copy kept first in
// <profile>/claude-config-backups/<timestamp>-<name> (last 50 kept), then main/atomic.js.
// Owner: lane cc-config (host side).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

const WIN = process.platform === 'win32';
const MAX_BYTES = 1024 * 1024;          // read and write cap per file
const HEAD_BYTES = 8192;                // frontmatter lives at the top; the list reads only this much
const MAX_BACKUPS = 50;
const BACKUP_DIR = 'claude-config-backups';
const INSTRUCTION_RELS = ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')];
const INDEX_NAME = 'MEMORY.md';

function err(message, code) { return Object.assign(new Error(message), { code }); }
const bad = (m) => err(m, 'bad_params');
const denied = (m) => err(m, 'forbidden');
const key = (p) => (WIN ? String(p).toLowerCase() : String(p));
const same = (a, b) => key(a) === key(b);
const roundMtime = (st) => Math.round(st.mtimeMs);

// Claude Code names a project's folder by replacing every non-alphanumeric character with "-".
const slugOf = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

// Listing and search never touch the disk synchronously (lane helm-settings-freeze): they run in Helm's main
// process, whose thread also pumps the window. Opening ~150 memory notes with openSync took 4.7 s of main-thread
// block when they were not in the file cache (a virus scanner checks every first open), and Windows marked Helm
// "not responding". Every read on the list / search path is fs.promises, a few files at a time.
const fsp = fs.promises;

async function readHead(file, bytes = HEAD_BYTES) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close().catch(() => {}); }
}

// fn over items with at most `n` in flight; results in input order
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function unquote(v) {
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Tiny frontmatter reader: top-level `key: value`, one nested level (`metadata:` + indented keys),
 * quoted strings, and `>` / `|` block scalars. Enough for Claude Code memory files; anything else is
 * skipped rather than guessed.
 * -> { fm, body, hasFrontmatter }
 */
function parseFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fm: {}, body: src, hasFrontmatter: false };
  const fm = {};
  let parent = null;
  let block = null; // { obj, key, fold, indent, lines }
  const endBlock = () => {
    if (!block) return;
    block.obj[block.key] = block.fold ? block.lines.join(' ').replace(/\s+/g, ' ').trim() : block.lines.join('\n').trim();
    block = null;
  };
  for (const line of m[1].split(/\r?\n/)) {
    if (block) {
      const ind = /^(\s*)/.exec(line)[1].length;
      if (!line.trim() || ind > block.indent) { block.lines.push(line.trim()); continue; }
      endBlock();
    }
    const mm = /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*)|\s*)$/.exec(line);
    if (!mm) continue;
    const indent = mm[1].length;
    const k = mm[2];
    const v = (mm[3] || '').trim();
    let target;
    if (!indent) target = fm;
    else if (parent && fm[parent] && typeof fm[parent] === 'object') target = fm[parent];
    else continue;
    if (!indent) parent = null;
    if (/^[>|][+-]?$/.test(v)) { block = { obj: target, key: k, fold: v[0] === '>', indent, lines: [] }; continue; }
    if (!indent && v === '') { parent = k; fm[k] = {}; continue; }
    target[k] = unquote(v);
  }
  endBlock();
  return { fm, body: src.slice(m[0].length), hasFrontmatter: true };
}

function memoryMeta(text) {
  const { fm, body, hasFrontmatter } = parseFrontmatter(text);
  const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  return { name: str(fm.name), description: str(fm.description), type: str(fm.type || meta.type), body, hasFrontmatter };
}

// "- [Title](file.md) — hook" (also *, +; -, –, — or : before the hook; an optional "title").
const INDEX_LINE = /^\s*[-*+]\s+\[([^\]]+)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)\s*(?:[—–:-]+\s*)?(.*)$/;

/** Parse MEMORY.md lines against the folder's files. -> { entries, linked:Set(key(basename)) } */
function parseIndex(text, dir, fileKeys) {
  const entries = [];
  const linked = new Set();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const m = INDEX_LINE.exec(raw);
    if (!m) return;
    const [, title, linkRaw, hook] = m;
    if (/^[a-z][a-z0-9+.-]*:/i.test(linkRaw) && !/^[a-z]:[\\/]/i.test(linkRaw)) return; // http:, mailto: ... not a memory link
    let link = linkRaw.split('#')[0];
    try { link = decodeURIComponent(link); } catch {}
    if (!link) return;
    const target = path.resolve(dir, link);
    const e = { line: i + 1, title: title.trim(), hook: hook.trim(), link: linkRaw, path: null, status: 'ok' };
    if (!same(path.dirname(target), dir) || !/\.md$/i.test(target)) e.status = 'outside';
    else if (!fileKeys.has(key(path.basename(target)))) { e.status = 'missing'; e.path = target; }
    else { e.path = fileKeys.get(key(path.basename(target))); linked.add(key(path.basename(target))); }
    entries.push(e);
  });
  return { entries, linked };
}

/**
 * createClaudeConfig({ home?, claudeDir?, profileDir, getProjectDirs, getSession, now?, maxBackups?, log? })
 *   claudeDir      Claude Code's config dir (default: $HELM_CLAUDE_DIR, else $CLAUDE_CONFIG_DIR, else ~/.claude).
 *                  Tests always pass a temp dir here.
 *   profileDir     Helm's userData dir; backups go to <profileDir>/claude-config-backups. Without it, writes refuse.
 *   getProjectDirs async () => [cwd]   project folders whose CLAUDE.md files are allowed
 *   getSession     (id) => { info, at, reason, latest } for claudeConfig.session
 * -> { list, read, write, search, session, methods }
 */
function createClaudeConfig(opts = {}) {
  const home = opts.home || os.homedir();
  const claudeDir = path.resolve(opts.claudeDir || process.env.HELM_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const projectsDir = path.join(claudeDir, 'projects');
  const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : null;
  const backupDir = profileDir ? path.join(profileDir, BACKUP_DIR) : null;
  const getProjectDirs = opts.getProjectDirs || (async () => []);
  const getSession = opts.getSession || (() => null);
  const now = opts.now || Date.now;
  const maxBackups = opts.maxBackups || MAX_BACKUPS;
  const log = opts.log || (() => {});

  const realOrNull = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };   // one file, on open / save
  const realAsync = (p) => fsp.realpath(p).catch(() => null);   // same semantics as realpathSync.native

  // Absolute, existing directories, deduped (case-insensitive on Windows), at most 200, in the order given.
  async function projectDirs() {
    let raw = [];
    try { raw = (await getProjectDirs()) || []; } catch (e) { log('claudeConfig: project list failed', e && e.message); }
    const seen = new Set();
    const cand = [];
    for (const p of raw) {
      if (typeof p !== 'string' || !p || p.length > 1000 || !path.isAbsolute(p) || p.includes('\0')) continue;
      const abs = path.resolve(p);
      if (seen.has(key(abs))) continue;
      seen.add(key(abs));
      cand.push(abs);
    }
    const out = [];
    for (let i = 0; i < cand.length && out.length < 200; i += 16) {
      const batch = cand.slice(i, i + 16);
      const dirs = await Promise.all(batch.map((abs) => fsp.stat(abs).then((st) => st.isDirectory(), () => false)));
      batch.forEach((abs, j) => { if (dirs[j] && out.length < 200) out.push(abs); });
    }
    return out;
  }

  // ---------- the allowlist ----------
  // Lexical first (which allowed slot is this?), then the filesystem (is it really there, unlinked?).
  async function resolveAllowed(p) {
    if (typeof p !== 'string' || !p) throw bad('path is required');
    if (p.length > 1024 || p.includes('\0')) throw bad('path is not valid');
    if (/^[\\/]{2}/.test(p)) throw denied('Network and device paths are not allowed.');
    if (!path.isAbsolute(p)) throw denied('The path must be absolute.');
    const segs = p.split(/[\\/]+/);
    if (segs.includes('..') || segs.includes('.')) throw denied('Paths with ".." or "." are not allowed.');
    if (WIN && p.slice(2).includes(':')) throw denied('Alternate data streams are not allowed.');
    const abs = path.resolve(p);

    let slot = null; // { kind, scope, base, rel, project?, slug? }
    if (same(abs, path.join(claudeDir, 'CLAUDE.md'))) slot = { kind: 'instructions', scope: 'global', base: claudeDir, rel: 'CLAUDE.md', project: null };
    if (!slot) {
      const dir = path.dirname(abs);
      const name = path.basename(abs);
      if (same(path.basename(dir), 'memory') && same(path.dirname(path.dirname(dir)), projectsDir) && /^.+\.md$/i.test(name)) {
        const slug = path.basename(path.dirname(dir));
        slot = { kind: 'memory', scope: 'memory', base: claudeDir, rel: path.join('projects', slug, 'memory', name), slug };
      }
    }
    if (!slot) {
      for (const proj of await projectDirs()) {
        const rel = INSTRUCTION_RELS.find((r) => same(abs, path.join(proj, r)));
        if (rel) { slot = { kind: 'instructions', scope: 'project', base: proj, rel, project: proj }; break; }
      }
    }
    if (!slot) throw denied('Helm only opens CLAUDE.md files and Claude Code memory notes.');

    let st;
    try { st = fs.lstatSync(abs); } catch (e) {
      if (e.code === 'ENOENT') throw err('That file does not exist (it may have been moved or deleted).', 'not_found');
      throw err(`Could not read that file: ${e.message}`, 'io');
    }
    if (st.isSymbolicLink()) throw denied('Links are not allowed: this file is a symlink or junction.');
    if (!st.isFile()) throw denied('That path is not a regular file.');
    if (st.nlink > 1) throw denied('That file has more than one hard link, so Helm will not touch it.');
    const realBase = realOrNull(slot.base);
    const real = realOrNull(abs);
    if (!realBase || !real || !same(real, path.join(realBase, slot.rel))) {
      throw denied('That path goes through a link that points somewhere else, so Helm will not open it.');
    }
    return { abs, real, st, ...slot };
  }

  // ---------- list ----------
  // Everything here awaits fs.promises (see readHead): the main thread only parses, the disk work (and the virus
  // scanner's first-open check) happens on libuv's pool. FILES_AT_ONCE / FOLDERS_AT_ONCE keep that pool free
  // enough for the rest of Helm (transcripts, history) while a list runs.
  const FILES_AT_ONCE = 6;
  const FOLDERS_AT_ONCE = 2;
  async function fileInfo(file) {
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      return { size: st.size, mtime: roundMtime(st) };
    } catch { return null; }
  }

  // A note's frontmatter, re-read only when its size or mtime changed: opening Settings again costs one lstat per
  // note. Keyed by path; notes no longer listed drop out after each list.
  const metaCache = new Map();   // key(path) -> { size, mtime, meta: { name, description, type } }
  async function metaOf(file, touched) {
    const info = await fileInfo(file);
    const k = key(file);
    if (touched) touched.add(k);
    if (!info) { metaCache.delete(k); return null; }
    const c = metaCache.get(k);
    if (c && c.size === info.size && c.mtime === info.mtime) return { ...info, ...c.meta };
    let m = { name: '', description: '', type: '' };
    try { const mm = memoryMeta(await readHead(file)); m = { name: mm.name, description: mm.description, type: mm.type }; } catch {}
    metaCache.set(k, { size: info.size, mtime: info.mtime, meta: m });
    return { ...info, ...m };
  }

  async function listInstructions(projects) {
    const seenReal = new Set();
    const gPath = path.join(claudeDir, 'CLAUDE.md');
    const g = await fileInfo(gPath);
    const global = { path: gPath, scope: 'global', rel: 'CLAUDE.md', project: null, exists: !!g, ...(g || {}) };
    if (g) { const r = await realAsync(gPath); if (r) seenReal.add(key(r)); }
    // each project's candidate files (info + real path), a few projects at a time; deduped below in project order
    const found = await mapLimit(projects, FILES_AT_ONCE, async (proj) => {
      const rows = [];
      for (const rel of INSTRUCTION_RELS) {
        const file = path.join(proj, rel);
        const info = await fileInfo(file);
        if (info) rows.push({ rel, file, info, real: await realAsync(file) });
      }
      return { proj, rows, realBase: rows.length ? await realAsync(proj) : null };
    });
    const out = [];
    for (const { proj, rows, realBase } of found) {
      const files = [];
      for (const { rel, file, info, real: r } of rows) {
        if (!r || seenReal.has(key(r))) continue; // the home folder's .claude/CLAUDE.md IS the global file
        // a linked file would be refused by read; list it with the reason instead of hiding it
        const linked = !realBase || !same(r, path.join(realBase, rel));
        seenReal.add(key(r));
        files.push({ path: file, scope: 'project', rel: rel.replace(/\\/g, '/'), project: proj, exists: true, ...info, ...(linked ? { blocked: 'Goes through a link that points elsewhere; Helm will not open it.' } : {}) });
      }
      out.push({ cwd: proj, name: path.basename(proj) || proj, files });
    }
    return { global, projects: out };
  }

  // one <projects>/<slug>: { skip } | { empty: true } | { folder } | null (no memory folder)
  async function memoryFolder(d, labels, touched) {
    if (!d.isDirectory()) return d.isSymbolicLink() ? { skip: { slug: d.name, reason: 'link' } } : null;
    const dir = path.join(projectsDir, d.name, 'memory');
    let dst;
    try { dst = await fsp.lstat(dir); } catch { return null; }
    if (dst.isSymbolicLink() || !dst.isDirectory()) return { skip: { slug: d.name, reason: dst.isSymbolicLink() ? 'link' : 'not a folder' } };
    let names = [];
    try { names = (await fsp.readdir(dir, { withFileTypes: true })).filter((f) => f.isFile() && /^.+\.md$/i.test(f.name)).map((f) => f.name); } catch { return null; }
    if (!names.length) return { empty: true };
    const fileKeys = new Map(names.map((n) => [key(n), path.join(dir, n)]));
    const indexName = names.find((n) => same(n, INDEX_NAME));
    const indexPath = path.join(dir, indexName || INDEX_NAME);
    let entries = [];
    let linked = new Set();
    let index = null;
    if (indexName) {
      const info = await fileInfo(indexPath);
      let text = '';
      try { text = await fsp.readFile(indexPath, 'utf8'); } catch {}
      ({ entries, linked } = parseIndex(text, dir, fileKeys));
      index = { path: indexPath, exists: true, ...(info || {}), lines: text.split(/\r?\n/).length };
    }
    const ok = entries.filter((e) => e.status === 'ok');
    const okMeta = await mapLimit(ok, FILES_AT_ONCE, (e) => metaOf(e.path, touched));
    ok.forEach((e, i) => Object.assign(e, { file: okMeta[i] }));
    const rest = names.filter((n) => !same(n, INDEX_NAME) && !linked.has(key(n))).sort((a, b) => a.localeCompare(b));
    const restMeta = await mapLimit(rest, FILES_AT_ONCE, (n) => metaOf(path.join(dir, n), touched));
    const unindexed = rest.map((n, i) => ({ path: path.join(dir, n), file: n, ...(restMeta[i] || {}) }));
    return {
      folder: {
        slug: d.name, dir, project: labels.get(key(d.name)) || null, isHome: same(d.name, slugOf(home)),
        index: index || { path: indexPath, exists: false },
        entries, unindexed,
        fileCount: names.length,
        broken: entries.filter((e) => e.status !== 'ok').length,
      },
    };
  }

  async function listMemory(projects) {
    const labels = new Map(projects.map((p) => [key(slugOf(p)), p]));
    if (!labels.has(key(slugOf(home)))) labels.set(key(slugOf(home)), home);
    let dirents = [];
    try { dirents = await fsp.readdir(projectsDir, { withFileTypes: true }); } catch { return { folders: [], emptyFolders: 0, skipped: [] }; }
    const touched = new Set();
    const rows = await mapLimit(dirents, FOLDERS_AT_ONCE, (d) => memoryFolder(d, labels, touched));
    const folders = [];
    const skipped = [];
    let emptyFolders = 0;
    for (const r of rows) {
      if (!r) continue;
      if (r.skip) skipped.push(r.skip);
      else if (r.empty) emptyFolders++;
      else folders.push(r.folder);
    }
    for (const k of [...metaCache.keys()]) if (!touched.has(k)) metaCache.delete(k);
    folders.sort((a, b) => (b.isHome - a.isHome) || (b.fileCount - a.fileCount) || a.slug.localeCompare(b.slug));
    return { folders, emptyFolders, skipped };
  }

  async function list() {
    const projects = await projectDirs();
    const [instructions, memory] = await Promise.all([listInstructions(projects), listMemory(projects)]);
    return { claudeDir, home, instructions, memory, backupDir, writable: !!backupDir };
  }

  // ---------- read ----------
  async function read(p = {}) {
    const r = await resolveAllowed(p.path);
    if (r.st.size > MAX_BYTES) throw err(`That file is ${(r.st.size / 1048576).toFixed(1)} MB; Helm opens files up to 1 MB.`, 'too_large');
    const text = fs.readFileSync(r.abs, 'utf8').replace(/^﻿/, '');
    const out = { path: r.abs, kind: r.kind, scope: r.scope, project: r.project || null, text, size: r.st.size, mtime: roundMtime(r.st), crlf: /\r\n/.test(text) };
    if (r.kind === 'memory') {
      const m = memoryMeta(text);
      out.slug = r.slug;
      out.frontmatter = { name: m.name, description: m.description, type: m.type, present: m.hasFrontmatter };
      out.body = m.body;
    }
    return out;
  }

  // ---------- backups ----------
  function backupName(r) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const tag = r.kind === 'memory' ? `${r.slug}-memory`
      : r.scope === 'global' ? 'global'
        : `${path.basename(r.project) || 'project'}${r.rel.includes('.claude') ? '-dotclaude' : ''}`;
    const safe = `${tag}-${path.basename(r.abs)}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-140);
    return `${stamp}-${safe}`;
  }

  function pruneBackups() {
    let names = [];
    try { names = fs.readdirSync(backupDir).filter((n) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/.test(n)).sort(); } catch { return 0; }
    let removed = 0;
    for (const n of names.slice(0, Math.max(0, names.length - maxBackups))) {
      try { fs.rmSync(path.join(backupDir, n), { force: true }); removed++; } catch (e) { log('claudeConfig: prune failed', n, e.message); }
    }
    return removed;
  }

  // ---------- write ----------
  async function write(p = {}) {
    if (typeof p.text !== 'string') throw bad('text must be a string');
    if (typeof p.expectMtime !== 'number' || !Number.isFinite(p.expectMtime)) throw bad('expectMtime is required (the mtime you got from claudeConfig.read)');
    if (!backupDir) throw err('Helm has no profile folder to keep a backup in, so it will not save.', 'unsupported');
    const r = await resolveAllowed(p.path);
    const current = roundMtime(r.st);
    if (current !== Math.round(p.expectMtime)) {
      throw Object.assign(err('This file changed on disk since you opened it. Reload it to see the new version, then make your edit again.', 'conflict'), { mtime: current });
    }
    let old;
    try { old = fs.readFileSync(r.abs); } catch (e) { throw err(`Could not read the current file to back it up: ${e.message}`, 'io'); }
    // keep the file's own line endings and BOM (the textarea always hands back "\n")
    const oldText = old.toString('utf8');
    let text = p.text;
    if (/\r\n/.test(oldText) && !/\r\n/.test(text)) text = text.replace(/\n/g, '\r\n');
    if (oldText.charCodeAt(0) === 0xfeff && text.charCodeAt(0) !== 0xfeff) text = '﻿' + text;
    const data = Buffer.from(text, 'utf8');
    if (data.length > MAX_BYTES) throw err('That is more than 1 MB; Helm saves files up to 1 MB.', 'too_large');

    // backup first; no backup, no write
    let backup;
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      let name = backupName(r);
      for (let i = 2; fs.existsSync(path.join(backupDir, name)); i++) name = `${backupName(r)}.${i}`;
      backup = path.join(backupDir, name);
      fs.writeFileSync(backup, old, { flag: 'wx' });
    } catch (e) {
      throw err(`Could not keep a backup (${e.message}), so nothing was saved.`, 'io');
    }
    // re-check right before the write: a save from the terminal in between must not be lost
    const again = fs.lstatSync(r.abs);
    if (roundMtime(again) !== current || again.size !== r.st.size) {
      throw Object.assign(err('This file changed on disk since you opened it. Reload it to see the new version, then make your edit again.', 'conflict'), { mtime: roundMtime(again) });
    }
    writeFileAtomic(r.abs, data);
    const st = fs.statSync(r.abs);
    const pruned = pruneBackups();
    log(`claudeConfig: saved ${r.abs} (${data.length} bytes), backup ${path.basename(backup)}`);
    return { path: r.abs, mtime: roundMtime(st), size: st.size, backup, backupName: path.basename(backup), pruned };
  }

  // ---------- search (memory notes: name, description, body) ----------
  async function search(p = {}) {
    const q = typeof p.q === 'string' ? p.q.trim().toLowerCase() : '';
    if (!q) return { q: '', results: [] };
    if (q.length > 200) throw bad('q is too long');
    const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 500);
    const { folders } = await listMemory(await projectDirs());
    const results = [];
    for (const f of folders) {
      const files = [...f.entries.filter((e) => e.status === 'ok').map((e) => e.path), ...f.unindexed.map((u) => u.path), ...(f.index.exists ? [f.index.path] : [])];
      for (const file of files) {
        let text;
        try { const st = await fsp.lstat(file); if (!st.isFile() || st.size > MAX_BYTES) continue; text = await fsp.readFile(file, 'utf8'); } catch { continue; }
        const m = memoryMeta(text);
        let where = null;
        if (path.basename(file).toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) where = 'name';
        else if (m.description.toLowerCase().includes(q)) where = 'description';
        else {
          const i = m.body.toLowerCase().indexOf(q);
          if (i >= 0) {
            const s = Math.max(0, i - 50);
            where = 'body';
            results.push({ path: file, slug: f.slug, where, snippet: (s > 0 ? '…' : '') + m.body.slice(s, i + q.length + 70).replace(/\s+/g, ' ').trim() + '…' });
            if (results.length >= limit) return { q, results, capped: true };
            continue;
          }
        }
        if (where) results.push({ path: file, slug: f.slug, where });
        if (results.length >= limit) return { q, results, capped: true };
      }
    }
    return { q, results };
  }

  // ---------- live session (read-only, from the engine) ----------
  async function session(p = {}) {
    const id = typeof p.id === 'string' && p.id ? p.id : null;
    const s = (await getSession(id)) || {};
    return { id, info: s.info || null, at: s.at || null, reason: s.reason || null, latest: s.latest || null };
  }

  const methods = {
    'claudeConfig.list': () => list(),
    'claudeConfig.read': (p) => read(p),
    'claudeConfig.write': (p) => write(p),
    'claudeConfig.search': (p) => search(p),
    'claudeConfig.session': (p) => session(p),
  };

  return { list, read, write, search, session, methods, claudeDir, backupDir, _resolveAllowed: resolveAllowed };
}

/**
 * Engine accessor for claudeConfig.session, READ-ONLY. main/engine exposes init info only through
 * `_internal` (sessions Map of EngineSession with .initInfo, and lastInit()). The stand-in engine has
 * neither, so this explains why instead of failing.
 */
function engineSessionReader(engine) {
  const clean = (info) => {
    if (!info || typeof info !== 'object') return null;
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
      model: info.model || null,
      permissionMode: info.permissionMode || null,
      version: info.version || null,
      tools: arr(info.tools).map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean),
      plugins: arr(info.plugins).map((pl) => (typeof pl === 'string' ? { name: pl } : { name: pl && pl.name, path: pl && pl.path })).filter((pl) => pl.name),
      mcpServers: arr(info.mcpServers).map((m) => ({ name: m && m.name, status: (m && m.status) || 'unknown' })).filter((m) => m.name),
      slashCommands: arr(info.slashCommands).map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean),
    };
  };
  return (id) => {
    const internal = engine && engine._internal;
    if (!internal || !internal.sessions) return { reason: 'The stand-in engine is running, so Claude Code is not connected and has nothing to report.' };
    const last = typeof internal.lastInit === 'function' ? internal.lastInit() : null;
    const latest = last ? { info: clean(last), at: last.at || null } : null;
    if (!id) return { reason: 'No session is selected.', latest };
    const es = internal.sessions.get(id);
    if (!es) return { reason: 'That session is not in Helm any more.', latest };
    if (!es.initInfo) return { reason: 'This session has not started Claude Code yet. Send it a message and its setup shows up here.', latest };
    return { info: clean(es.initInfo), at: es.initAt || null };
  };
}

module.exports = { createClaudeConfig, engineSessionReader, parseFrontmatter, memoryMeta, parseIndex, slugOf, INSTRUCTION_RELS };
