'use strict';
// Claude Code's own on-disk transcripts → Helm items.
// Main transcript:   ~/.claude/projects/<slug>/<claudeSessionId>.jsonl
// Subagents:         ~/.claude/projects/<slug>/<claudeSessionId>/subagents/agent-<id>.jsonl
//                    + agent-<id>.meta.json { toolUseId, agentType, description, spawnDepth }
// Subagent tool calls are merged in right after the Agent/Task tool item that owns them,
// with parentToolUseId set (same as the live stream), so old sessions render nested cards.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Normalizer } = require('./normalize');

function projectsDir() {
  return process.env.HELM_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
}

// Claude Code's slug: every non-alphanumeric char of the cwd becomes '-'.
function slugFor(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

const pathCache = new Map();
function findTranscript(claudeSessionId, cwd, dir = projectsDir()) {
  // Ids are uuids: anything that could step out of the projects dir ("../x", "a\\b") finds nothing.
  if (!claudeSessionId || typeof claudeSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(claudeSessionId)) return null;
  const name = `${claudeSessionId}.jsonl`;
  const cached = pathCache.get(claudeSessionId);
  if (cached && fs.existsSync(cached)) return cached;
  if (cwd) {
    const p = path.join(dir, slugFor(cwd), name);
    if (fs.existsSync(p)) {
      pathCache.set(claudeSessionId, p);
      return p;
    }
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(dir, d, name);
    if (fs.existsSync(p)) {
      pathCache.set(claudeSessionId, p);
      return p;
    }
  }
  return null;
}

// Claude Code's own running cost for a conversation: the newest `cost-state` line in its transcript
// (the CLI writes one when a process ends and restores totalCostUSD from it on resume, so a resumed
// process's result.total_cost_usd counts on from this figure). Reads backwards in 256 KB steps, at most
// `maxBytes` from the end (cost-state sits near the tail). null when none is found.
const COST_STATE_RE = /"type":"cost-state"/;
function lastCostState(file, { sessionId = null, maxBytes = 8 * 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 256 * 1024;
    let end = size;
    let carry = ''; // the partial first line of the chunk after this one
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      carry = start > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!COST_STATE_RE.test(l)) continue;
        try {
          const j = JSON.parse(l);
          if (j && j.type === 'cost-state' && typeof j.totalCostUSD === 'number' && (!sessionId || !j.sessionId || j.sessionId === sessionId)) {
            return { totalCostUSD: j.totalCostUSD, sessionId: j.sessionId || null };
          }
        } catch {}
      }
      end = start;
    }
    if (carry && COST_STATE_RE.test(carry)) {
      try {
        const j = JSON.parse(carry);
        if (j && typeof j.totalCostUSD === 'number') return { totalCostUSD: j.totalCostUSD, sessionId: j.sessionId || null };
      } catch {}
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l || l.charCodeAt(0) !== 123 /* { */) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

function makeStore() {
  const items = [];
  const byId = new Map();
  return {
    items,
    add(item) {
      items.push(item);
      byId.set(item.id, item);
    },
    patch(id, patch, appendText) {
      const it = byId.get(id);
      if (!it) return;
      if (patch) Object.assign(it, patch);
      if (appendText) it.text = (it.text || '') + appendText;
    },
    get(id) {
      return byId.get(id) || null;
    },
  };
}

// Parse a transcript file into items. Returns { items, meta } where meta carries what the
// engine wants to know about the session (cwd, title, last usage, cost).
function loadTranscript(file, { newId, includeSubagents = true } = {}) {
  let n = 0;
  const idf = newId || (() => 'h' + ++n);
  const store = makeStore();
  const meta = { cwd: null, title: null, aiTitle: null, lastUsage: null, lastModel: null, costUsd: null, firstPrompt: null, anchors: new Map() };
  const norm = new Normalizer({
    store,
    newId: idf,
    hooks: {
      onAssistant(m) {
        const u = m.message && m.message.usage;
        if (u && !m.isSidechain) {
          meta.lastUsage = u;
          meta.lastModel = m.message.model || meta.lastModel;
        }
      },
    },
  });
  for (const j of readLines(file)) {
    if (!meta.cwd && j.cwd) meta.cwd = j.cwd;
    if (j.type === 'custom-title' && j.customTitle) meta.title = j.customTitle;
    else if (j.type === 'ai-title' && j.aiTitle) meta.aiTitle = j.aiTitle;
    else if (j.type === 'cost-state' && typeof j.totalCostUSD === 'number') meta.costUsd = j.totalCostUSD;
    norm.handleLine(j);
    // line uuid → the last item that exists once that line is applied (turn results anchor here)
    if (j.uuid && !j.isSidechain && store.items.length) meta.anchors.set(j.uuid, store.items[store.items.length - 1].id);
  }
  norm.finishStreaming();
  // A transcript that ends mid-tool (crash / still running elsewhere) keeps status running;
  // leave it: the live engine owns live state, history is a snapshot.
  let items = store.items;
  const firstUser = items.find((i) => i.type === 'user' && i.text);
  if (firstUser) meta.firstPrompt = firstUser.text;

  if (includeSubagents) {
    const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
    const children = new Map(); // parentToolUseId → [items]
    let entries = [];
    try {
      entries = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl'));
    } catch {}
    for (const f of entries) {
      let m = null;
      try {
        m = JSON.parse(fs.readFileSync(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
      } catch {}
      if (!m || !m.toolUseId) continue;
      const sub = makeStore();
      const sn = new Normalizer({ store: sub, newId: idf, forceParent: m.toolUseId, noPrompts: true });
      for (const j of readLines(path.join(subDir, f))) sn.handleLine(j);
      for (const it of sub.items) {
        const p = it.parentToolUseId;
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(it);
      }
    }
    if (children.size) {
      const out = [];
      const placed = new Set();
      const place = (it) => {
        out.push(it);
        if (it.type === 'tool' && children.has(it.toolUseId) && !placed.has(it.toolUseId)) {
          placed.add(it.toolUseId);
          for (const c of children.get(it.toolUseId)) place(c);
        }
      };
      for (const it of items) place(it);
      items = out;
    }
  }
  return { items, meta };
}

module.exports = { projectsDir, slugFor, findTranscript, loadTranscript, readLines, makeStore, lastCostState };
