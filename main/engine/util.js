'use strict';
// Small shared helpers for the engine (no SDK, no Electron).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function rid(prefix, bytes = 4) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}

// Write JSON atomically (tmp + rename) so a crash never leaves half a file.
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // fsync before the rename: after a power cut NTFS can otherwise keep the rename but not the data
  // (a zero-length sessions.json).
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows: rename over a file another process holds open can fail; fall back to copy.
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Like readJson, but a file that exists and does not parse is moved aside to
// <file>.bad-<ts> (so the next save cannot silently replace it) and reported via onCorrupt.
// A missing or empty file is just the fallback.
function readJsonOrQuarantine(file, fallback, onCorrupt) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    const aside = `${file}.bad-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      try {
        fs.copyFileSync(file, aside);
      } catch {}
    }
    if (onCorrupt) onCorrupt(aside, e);
    return fallback;
  }
}

// Last path segment of a Windows or POSIX path.
function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Short session title from the first prompt: first non-empty line, markdown stripped,
// cut on a word boundary near 60 chars.
function titleFromPrompt(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^```/.test(l));
  if (!line) return 'New session';
  let t = line.replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    const sp = cut.lastIndexOf(' ');
    t = (sp > 30 ? cut.slice(0, sp) : cut).replace(/[,.;:!?-]+$/, '') + '…';
  }
  return t || 'New session';
}

// Context window by model id. Learned values (from result.modelUsage.contextWindow) win.
const learnedWindows = new Map();
function learnWindow(model, tokens) {
  if (model && tokens > 0) learnedWindows.set(model, tokens);
}
function windowFor(model) {
  if (model && learnedWindows.has(model)) return learnedWindows.get(model);
  const m = String(model || '').toLowerCase();
  if (/\[1m\]/.test(m)) return 1_000_000;
  if (!m || m === 'default') return 1_000_000;
  // Claude Code 2.1.29x reports a 1M window for the 5.x family (Opus, Sonnet, Fable, Haiku).
  if (/-5-|-5$|fable|opus|sonnet/.test(m)) return 1_000_000;
  return 200_000;
}

// Context used on one request = input + cache_creation + cache_read + output of the latest assistant turn's usage,
// the same sum ~/.claude/tools/agent-context.js uses. `seenMax` = the biggest such total seen so far in this
// transcript: a request past 200k proves a 1M window (it could not have fit a 200k one), the tool's other rule.
function usedTokensOf(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}
function contextFrom(usage, model, seenMax = 0) {
  if (!usage) return null;
  const used = usedTokensOf(usage);
  if (!used) return null;
  let windowTokens = windowFor(model);
  if (windowTokens < 1_000_000 && Math.max(used, seenMax || 0) > 200_000) windowTokens = 1_000_000;
  return { usedTokens: used, windowTokens, percent: Math.round((used / windowTokens) * 1000) / 10 };
}

function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  d.flush = (...args) => {
    if (t) {
      clearTimeout(t);
      t = null;
      fn(...args);
    }
  };
  d.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  return d;
}

// Async iterable you push values into (the SDK's streaming-input prompt).
class PushStream {
  constructor() {
    this.buf = [];
    this.waiters = [];
    this.closed = false;
  }
  push(v) {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
    return true;
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

module.exports = {
  rid,
  writeJsonAtomic,
  readJson,
  readJsonOrQuarantine,
  baseName,
  oneLine,
  truncate,
  titleFromPrompt,
  windowFor,
  learnWindow,
  contextFrom,
  usedTokensOf,
  debounce,
  PushStream,
};
