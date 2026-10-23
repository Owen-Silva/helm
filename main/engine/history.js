// Past-sessions history index (PROTOCOL "HistoryEntry").
// Scans ~/.claude/projects/<slug>/<sessionId>.jsonl (one level only; subagent transcripts under
// <slug>/<sessionId>/subagents/ are never touched). Big transcripts are read HEAD (64 KB) + TAIL
// (128 KB) only; files <= 1 MB are read whole so messageCount can be exact.
// Incremental: an entry is reused while the file's mtimeMs + size are unchanged; the index is
// persisted to cacheFile (tmp + rename) whenever it changes.
// Owner: lane engine.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const CACHE_VERSION = 1;
const DEFAULTS = {
  headBytes: 64 * 1024,
  tailBytes: 128 * 1024,
  fullReadMaxBytes: 1024 * 1024,
  minRefreshMs: 5000,
  fileTimeoutMs: 10000,
  concurrency: 16,
};

// cwd at or under the OS temp dir (case-insensitive on Windows)
function isTempCwd(cwd, tempDir = os.tmpdir()) {
  if (!cwd || !tempDir) return false;
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(cwd);
  const t = norm(tempDir);
  return c === t || c.startsWith(t + path.sep);
}

// ---------- line parsing ----------

function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// One text candidate -> prompt string or null.
function promptFromText(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('<bash-')) {
    // A prompt Helm sent with `!` runs in front (shell-run.js): the typed part is the prompt.
    const sh = require('./shell-run').splitShellBlocks(text);
    return sh && sh.rest.trim() ? promptFromText(sh.rest) : null;
  }
  if (text.startsWith('<')) {
    const cm = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
    if (!cm || !cm[1]) return null;
    let p = cm[1].startsWith('/') ? cm[1] : '/' + cm[1];
    const am = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    if (am && am[1].trim()) p += ' ' + am[1].trim();
    return p;
  }
  return text;
}

// A parsed `user` line -> the real prompt text, or null (meta, sidechain, tool result, reminder...).
function realPrompt(o) {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary) return null;
  const m = o.message;
  if (!m) return null;
  const c = m.content;
  if (typeof c === 'string') return promptFromText(c);
  if (!Array.isArray(c)) return null;
  for (const b of c) {
    if (b && b.type === 'text') {
      const p = promptFromText(b.text);
      if (p) return p;
    }
  }
  return null;
}

function parseLines(text, { dropFirst, dropLast }) {
  const parts = text.split('\n');
  if (dropFirst) parts.shift();
  if (dropLast) parts.pop();
  const out = [];
  for (const line of parts) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o);
    } catch { /* tolerate bad / partial lines */ }
  }
  return out;
}

async function readRange(fh, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, start + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return buf.subarray(0, off).toString('utf8');
}

function lastOf(lines, pick) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = pick(lines[i]);
    if (v) return v;
  }
  return null;
}

function firstOf(lines, pick) {
  for (const o of lines) {
    const v = pick(o);
    if (v) return v;
  }
  return null;
}

const pickCustomTitle = (o) => (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim() ? collapse(o.customTitle) : null);
const pickAiTitle = (o) => (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim() ? collapse(o.aiTitle) : null);
const pickLastPrompt = (o) => (o.type === 'last-prompt' && typeof o.lastPrompt === 'string' && o.lastPrompt.trim() ? o.lastPrompt : null);
const pickCwd = (o) => (typeof o.cwd === 'string' && o.cwd ? o.cwd : null);

function projectOf(cwd, slug) {
  if (cwd) {
    const segs = cwd.split(/[\\/]+/).filter(Boolean);
    if (segs.length) return segs[segs.length - 1];
  }
  return slug;
}

// Parse one transcript file -> HistoryEntry or null (no prompt and no title).
async function parseTranscript(file, st, opts) {
  const size = st.size;
  const fh = await fsp.open(file, 'r');
  let head, tail, full = false;
  try {
    if (size <= opts.fullReadMaxBytes || size <= opts.headBytes + opts.tailBytes) {
      const all = parseLines(await readRange(fh, 0, size), { dropFirst: false, dropLast: false });
      head = all;
      tail = all;
      full = size <= opts.fullReadMaxBytes;
    } else {
      head = parseLines(await readRange(fh, 0, opts.headBytes), { dropFirst: false, dropLast: true });
      tail = parseLines(await readRange(fh, size - opts.tailBytes, opts.tailBytes), { dropFirst: true, dropLast: false });
    }
  } finally {
    await fh.close().catch(() => {});
  }

  const firstPromptRaw = firstOf(head, realPrompt) || lastOf(tail, pickLastPrompt) || lastOf(head, pickLastPrompt);
  const firstPrompt = firstPromptRaw ? collapse(firstPromptRaw).slice(0, 300) || null : null;
  const customTitle = lastOf(tail, pickCustomTitle) || lastOf(head, pickCustomTitle);
  const aiTitle = lastOf(tail, pickAiTitle) || lastOf(head, pickAiTitle);
  if (!firstPrompt && !customTitle && !aiTitle) return null;

  const title = customTitle || aiTitle || firstPrompt.slice(0, 80) || '(untitled)';
  const cwd = firstOf(head, pickCwd) || firstOf(tail, pickCwd) || null;
  const slug = path.basename(path.dirname(file));

  let lastActivity = 0;
  for (const o of tail) {
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (Number.isFinite(t) && t > lastActivity) lastActivity = t;
    }
  }
  if (!lastActivity) lastActivity = Math.round(st.mtimeMs);

  let messageCount = null;
  if (full) {
    let prompts = 0;
    const ids = new Set();
    for (const o of head) {
      if (o.type === 'user') { if (realPrompt(o)) prompts++; }
      else if (o.type === 'assistant' && !o.isSidechain) {
        const id = (o.message && o.message.id) || o.uuid;
        if (id) ids.add(id);
      }
    }
    messageCount = prompts + ids.size;
  }

  return {
    claudeSessionId: path.basename(file, '.jsonl'),
    cwd,
    project: projectOf(cwd, slug),
    title,
    firstPrompt,
    lastActivity,
    messageCount,
    sizeBytes: size,
    transcriptPath: file,
  };
}

// ---------- helpers ----------

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

function haystack(e) {
  return `${e.title || ''}\n${e.firstPrompt || ''}\n${e.cwd || ''}\n${e.project || ''}`.toLowerCase();
}

// ---------- index ----------

function createHistoryIndex({
  projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  cacheFile = null,
  log = () => {},
  ...over
} = {}) {
  const opts = { ...DEFAULTS, ...over };
  const say = (level, msg) => { try { log(level, `[history] ${msg}`); } catch { /* ignore */ } };

  let files = new Map(); // absPath -> { mtimeMs, size, entry|null }
  let loaded = false;
  let sorted = [];
  const hay = new WeakMap();
  let inflight = null;
  let lastRefreshAt = 0;

  function rebuildSorted() {
    sorted = [];
    for (const rec of files.values()) if (rec.entry) sorted.push(rec.entry);
    sorted.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  function loadCache() {
    if (loaded) return;
    loaded = true;
    if (!cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!data || data.version !== CACHE_VERSION || !data.files || typeof data.files !== 'object') return;
      for (const [p, rec] of Object.entries(data.files)) {
        if (rec && typeof rec.mtimeMs === 'number' && typeof rec.size === 'number') {
          files.set(p, { mtimeMs: rec.mtimeMs, size: rec.size, entry: rec.entry || null });
        }
      }
      rebuildSorted();
    } catch (err) {
      if (err.code !== 'ENOENT') say('warn', `cache unreadable, rebuilding: ${err.message}`);
    }
  }

  async function writeCache() {
    if (!cacheFile) return;
    const out = { version: CACHE_VERSION, files: {} };
    for (const [p, rec] of files) out.files[p] = rec;
    const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(out));
      await fsp.rename(tmp, cacheFile);
    } catch (err) {
      say('warn', `cache write failed: ${err.message}`);
      fsp.unlink(tmp).catch(() => {});
    }
  }

  async function listTranscripts() {
    let slugs;
    try {
      slugs = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') say('warn', `cannot read ${projectsDir}: ${err.message}`);
      return [];
    }
    const out = [];
    await pool(slugs.filter((d) => d.isDirectory()), opts.concurrency, async (d) => {
      const dir = path.join(projectsDir, d.name);
      try {
        for (const f of await fsp.readdir(dir, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(dir, f.name));
        }
      } catch (err) {
        say('warn', `cannot read ${dir}: ${err.message}`);
      }
    });
    return out;
  }

  async function doRefresh() {
    const t0 = performance.now();
    loadCache();
    const paths = await listTranscripts();
    const next = new Map();
    let reparsed = 0;
    let changed = false;
    await pool(paths, opts.concurrency, async (p) => {
      let st;
      try { st = await fsp.stat(p); } catch { return; }
      const prev = files.get(p);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        next.set(p, prev);
        return;
      }
      reparsed++;
      changed = true;
      try {
        const entry = await withTimeout(parseTranscript(p, st, opts), opts.fileTimeoutMs, p);
        next.set(p, { mtimeMs: st.mtimeMs, size: st.size, entry });
      } catch (err) {
        // Not cached, so it is retried on the next refresh.
        say('warn', `skip ${p}: ${err.message}`);
      }
    });
    for (const p of files.keys()) if (!next.has(p)) { changed = true; break; }
    files = next;
    rebuildSorted();
    if (changed) await writeCache();
    lastRefreshAt = Date.now();
    const ms = Math.round(performance.now() - t0);
    return { scanned: paths.length, reparsed, ms };
  }

  function refresh() {
    if (!inflight) {
      inflight = doRefresh().finally(() => { inflight = null; });
    }
    return inflight;
  }

  // includeTemp: sessions whose cwd is under the OS temp dir (test runs, scratch repos) are
  // left out unless asked for.
  async function search({ q = '', limit = 50, includeTemp = false } = {}) {
    if (inflight) await inflight;
    else if (!lastRefreshAt || Date.now() - lastRefreshAt >= opts.minRefreshMs) await refresh();
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const pool = includeTemp ? sorted : sorted.filter((e) => !isTempCwd(e.cwd, opts.tempDir));
    if (!terms.length) return pool.slice(0, n);
    const out = [];
    for (const e of pool) {
      let h = hay.get(e);
      if (h === undefined) { h = haystack(e); hay.set(e, h); }
      const id = e.claudeSessionId.toLowerCase();
      if (terms.every((t) => h.includes(t) || id.startsWith(t))) {
        out.push(e);
        if (out.length >= n) break;
      }
    }
    return out;
  }

  function entries() {
    loadCache();
    return sorted.slice();
  }

  return { search, refresh, entries };
}

module.exports = { createHistoryIndex, isTempCwd, _internal: { parseTranscript, realPrompt, projectOf } };
