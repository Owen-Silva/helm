// files.tree / files.read / files.search / files.diff / files.pickFolder (PROTOCOL "RPC methods").
// Git-aware where the folder is a repo; plain filesystem otherwise.
// Owner: lane host (B).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const HIDDEN = new Set(['.git', 'node_modules']);
const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.turbo']);
const READ_CAP = 512 * 1024;
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.jsx': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.json': 'application/json', '.md': 'text/markdown',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.scss': 'text/x-scss', '.py': 'text/x-python',
  '.ps1': 'text/x-powershell', '.psm1': 'text/x-powershell', '.sh': 'text/x-sh', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.xml': 'text/xml', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.csv': 'text/csv', '.sql': 'text/x-sql',
  '.cs': 'text/x-csharp', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.c': 'text/x-c', '.h': 'text/x-c',
  '.cpp': 'text/x-c++', '.toml': 'text/x-toml', '.ini': 'text/plain', '.env': 'text/plain', '.prisma': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
};
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|x-icon)$/;

function err(message, code = 'bad_params') { return Object.assign(new Error(message), { code }); }

// Read-only git, safe to point at any folder:
//  --no-optional-locks   `git status` otherwise rewrites .git/index under index.lock, which races
//                        a `git commit` Claude is running in the same repo ("index.lock exists")
//  core.fsmonitor=false  a folder's own .git/config can name a command for git to run on status
const GIT_SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off'];
function git(cwd, args, { maxBuffer = 32 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_SAFE, ...args], { cwd, maxBuffer, encoding, windowsHide: true, timeout: 20_000 },
      (e, stdout) => (e ? reject(e) : resolve(stdout)));
  });
}

// Both caches are keyed by every folder the UI asks about; keep them bounded (oldest out first).
const CACHE_MAX = 200;
function cacheSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

// Repo root for a directory, or null. Cached briefly: the tree panel asks for every folder it opens.
const rootCache = new Map();
async function repoRoot(dir) {
  const hit = rootCache.get(dir);
  if (hit && Date.now() - hit.t < 10_000) return hit.root;
  let root = null;
  try { root = path.resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim()); } catch {}
  cacheSet(rootCache, dir, { root, t: Date.now() });
  return root;
}

function requirePath(p, name = 'path') {
  if (typeof p !== 'string' || !p.trim()) throw err(`${name} is required`);
  if (p.includes('\0')) throw err(`bad ${name}`);
  return path.resolve(p);
}

const toPosix = (p) => p.split(path.sep).join('/');

// Long form of p: realpathSync.native on its nearest existing ancestor, the rest re-joined (p may be a
// deleted file). Expands Windows 8.3 short names (C:\Users\RUNNER~1\...) and resolves links.
function longPath(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail); } catch {}
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = up;
  }
}

// p relative to the repo root git reported, posix-style. git answers in long form, so a short-form (8.3)
// cwd climbs out with '../'; only then are both sides normalised, so paths that already line up never change.
function repoRel(root, p) {
  const rel = path.relative(root, p);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  return toPosix(path.relative(longPath(root), longPath(p)));
}

// `git status --porcelain=v1 -z` -> Map(repo-relative posix path -> status letter)
//   '?' untracked, 'A' added, 'D' deleted, 'R' renamed, 'M' modified, 'U' conflicted
async function gitStatusMap(root) {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const map = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const rel = rec.slice(3);
    let st;
    if (xy === '??') st = '?';
    else if (xy.includes('U') || xy === 'AA' || xy === 'DD') st = 'U';
    else if (xy.includes('R')) { st = 'R'; i++; } // the next record is the rename source
    else if (xy.includes('A')) st = 'A';
    else if (xy.includes('D')) st = 'D';
    else st = 'M';
    map.set(rel.replace(/\/$/, ''), st);
  }
  return map;
}

async function tree({ cwd, path: p } = {}) {
  const dir = requirePath(p || cwd, 'cwd');
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) { throw err(e.code === 'ENOENT' ? `no such folder: ${dir}` : e.message, e.code === 'ENOENT' ? 'not_found' : 'io'); }
  entries = entries.filter((d) => !HIDDEN.has(d.name)).slice(0, 5000);

  let status = null, root = null;
  try { root = await repoRoot(dir); if (root) status = await gitStatusMap(root); } catch { status = null; }
  const dirRel = status && root ? repoRel(root, dir) : ''; // once per folder, not per entry

  const rows = await Promise.all(entries.map(async (d) => {
    const full = path.join(dir, d.name);
    let st = null;
    try { st = await fsp.stat(full); } catch {}
    const isDir = st ? st.isDirectory() : d.isDirectory();
    const row = { name: d.name, path: full, dir: isDir, size: st && !isDir ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    if (status && root) {
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
      if (status.has(rel)) row.gitStatus = status.get(rel);
      else if (isDir) {
        const prefix = rel + '/';
        for (const [k, v] of status) if (k.startsWith(prefix)) { row.gitStatus = v === '?' ? '?' : 'M'; break; }
      }
    }
    return row;
  }));
  rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.dir ? -1 : 1));
  return rows;
}

function mimeOf(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function read({ path: p, maxBytes } = {}) {
  const file = requirePath(p);
  let st;
  try { st = await fsp.stat(file); } catch (e) { throw err(e.code === 'ENOENT' ? `no such file: ${file}` : e.message, e.code === 'ENOENT' ? 'not_found' : 'io'); }
  if (st.isDirectory()) throw err('that is a folder', 'bad_params');
  const cap = Math.max(1, Math.min(Number(maxBytes) || READ_CAP, READ_CAP));
  const mime = mimeOf(file);
  // Images come back as a data URL (capped) so the Files panel can show them.
  if (IMAGE_MIME.test(mime)) {
    if (st.size > 5 * 1024 * 1024) return { path: file, text: '', truncated: true, mime, binary: true, size: st.size };
    const buf = await fsp.readFile(file);
    return { path: file, text: '', truncated: false, mime, binary: true, size: st.size, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    if (len) await fh.read(buf, 0, len, 0);
    if (looksBinary(buf)) return { path: file, text: '', truncated: st.size > cap, mime, binary: true, size: st.size };
    let text = buf.toString('utf8');
    if (st.size > cap) text = text.replace(/�$/, ''); // a multi-byte char cut at the cap
    return { path: file, text, truncated: st.size > cap, mime: mime === 'application/octet-stream' ? 'text/plain' : mime, size: st.size };
  } finally { await fh.close(); }
}

// Candidate list for @mentions: git ls-files in a repo (tracked + untracked, .gitignore respected),
// otherwise a capped walk.
const listCache = new Map();
async function listFiles(cwd) {
  const hit = listCache.get(cwd);
  if (hit && Date.now() - hit.t < 15_000) return hit.files;
  let files = null;
  const root = await repoRoot(cwd);
  if (root) {
    try {
      const out = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']);
      files = out.split('\0').filter(Boolean); // relative to cwd (git ls-files is cwd-relative)
      // tracked files deleted on disk are still in the index; don't offer them as @mentions
      const gone = new Set((await git(cwd, ['ls-files', '-z', '--deleted']).catch(() => '')).split('\0').filter(Boolean));
      if (gone.size) files = files.filter((x) => !gone.has(x));
    } catch { files = null; }
  }
  if (!files) files = await walk(cwd, 20_000, 12);
  cacheSet(listCache, cwd, { files, t: Date.now() });
  return files;
}

async function walk(base, cap, maxDepth) {
  const out = [];
  const queue = [['', 0]];
  while (queue.length && out.length < cap) {
    const [rel, depth] = queue.shift();
    let ents;
    try { ents = await fsp.readdir(path.join(base, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { if (!WALK_SKIP.has(d.name) && depth < maxDepth) queue.push([r, depth + 1]); }
      else if (d.isFile()) { out.push(r); if (out.length >= cap) break; }
    }
  }
  return out;
}

// Higher is better; -1 = no match. Basename hits beat path hits; prefix and word-start bonuses;
// subsequence (fuzzy) matches score lowest.
function score(rel, q) {
  const lower = rel.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  let s = -1;
  const bi = base.indexOf(q);
  if (bi >= 0) s = 1000 - bi * 2 + (bi === 0 ? 200 : 0) + (base === q ? 300 : 0);
  else {
    const pi = lower.indexOf(q);
    if (pi >= 0) s = 500 - Math.min(pi, 200) + (pi === 0 || lower[pi - 1] === '/' ? 50 : 0);
    else {
      let j = 0, gaps = 0, last = -1;
      for (let i = 0; i < lower.length && j < q.length; i++) {
        if (lower[i] === q[j]) { if (last >= 0) gaps += i - last - 1; last = i; j++; }
      }
      if (j === q.length) s = 200 - Math.min(gaps, 190);
    }
  }
  if (s < 0) return s;
  return s - rel.length / 100 - (rel.split('/').length - 1);
}

async function search({ cwd, q, limit } = {}) {
  const dir = requirePath(cwd, 'cwd');
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const files = await listFiles(dir);
  const query = String(q || '').trim().toLowerCase().replace(/\\/g, '/');
  let ranked;
  if (!query) ranked = files.slice(0, lim).map((rel) => ({ rel, s: 0 }));
  else {
    ranked = [];
    for (const rel of files) { const s = score(rel, query); if (s >= 0) ranked.push({ rel, s }); }
    ranked.sort((a, b) => b.s - a.s);
    ranked = ranked.slice(0, lim);
  }
  return ranked.map(({ rel }) => ({ path: path.join(dir, ...rel.split('/')), rel }));
}

async function diff({ cwd, path: p } = {}) {
  const base = cwd ? requirePath(cwd, 'cwd') : null;
  if (typeof p !== 'string' || !p) throw err('path is required');
  const file = base ? path.resolve(base, p) : path.resolve(p);
  let after = '';
  try { after = (await read({ path: file })).text; } catch (e) { if (e.code !== 'not_found') throw e; }
  let before = '';
  const root = await repoRoot(fs.existsSync(path.dirname(file)) ? path.dirname(file) : base || path.dirname(file)).catch(() => null);
  if (root) {
    const rel = repoRel(root, file);
    if (!rel.startsWith('../')) {
      try {
        const buf = await git(root, ['show', `HEAD:${rel}`], { encoding: 'buffer' });
        before = looksBinary(buf) ? '' : buf.subarray(0, READ_CAP).toString('utf8');
      } catch { before = ''; } // untracked / new file / no commits yet
    }
  }
  return { path: file, before, after };
}

function createFiles({ getWindow, dialog } = {}) {
  async function pickFolder(_params, client) {
    if (!dialog || (client && client.platform !== 'electron')) throw err('the folder picker needs the desktop app', 'unsupported');
    const win = getWindow && getWindow();
    const r = await dialog.showOpenDialog(win || undefined, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' });
    return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] };
  }
  // files.saveText (lane git-export): native "Save as" for text the UI built (session export as Markdown).
  // Desktop window only; the file goes wherever the user picks in the dialog, never a path the client names.
  async function saveText(params, client) {
    if (!dialog || (client && client.platform !== 'electron')) throw err('saving a file needs the desktop app', 'unsupported');
    const { suggestedName, text } = params || {};
    if (typeof text !== 'string') throw err('text is required');
    if (Buffer.byteLength(text, 'utf8') > SAVE_TEXT_CAP) throw err('text is too large to save (20 MB max)', 'too_large');
    const name = safeFileName(suggestedName);
    const md = path.extname(name).toLowerCase() === '.md';
    const win = getWindow && getWindow();
    const r = await dialog.showSaveDialog(win || undefined, {
      title: 'Save as', defaultPath: name,
      filters: md ? [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { path: null };
    await fsp.writeFile(r.filePath, text, 'utf8');
    return { path: r.filePath };
  }
  return { tree, read, search, diff, pickFolder, saveText };
}

const SAVE_TEXT_CAP = 20 * 1024 * 1024;
// A bare file name for the save dialog: no folders, no characters Windows refuses, no reserved device names.
function safeFileName(n) {
  let s = typeof n === 'string' ? n : '';
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  if (s.length > 120) { const ext = path.extname(s).slice(0, 10); s = s.slice(0, 120 - ext.length).trim() + ext; }
  return s || 'export.md';
}

module.exports = { createFiles, tree, read, search, diff, score, gitStatusMap, git, requirePath, safeFileName, _caches: { rootCache, listCache, CACHE_MAX } };
