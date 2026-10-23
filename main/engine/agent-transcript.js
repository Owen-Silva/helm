'use strict';
// agents.transcript: one subagent's OWN transcript, so the user can open any agent in the fleet and read
// its prompt, text, tool calls (with inputs and results) and its nested agents.
//
// Where it is: Claude Code writes every subagent of a session, at any depth, flat into
//   ~/.claude/projects/<slug>/<claudeSessionId>/subagents/agent-<agentId>.jsonl
//   + agent-<agentId>.meta.json  { agentType, description, toolUseId, parentAgentId?, spawnDepth }
// Helm's Agent.id is the parent's Agent/Task tool_use id, so the mapping is (in order):
//   1. meta.json whose toolUseId === Agent.id (exact; written by Claude Code when the agent starts)
//   2. an agentId hint → agent-<hint>.jsonl: the "agentId: <hex>" line of the Agent tool result
//      (async launches), or the SDK task_id the fleet saw for that tool_use
//   3. a transcript with no usable meta whose first prompt equals the Agent tool input's prompt
// Nothing found → the result says why (`missing`), never an empty list that looks like "no steps".
//
// Paging reuses TranscriptPager (pager.js): tail-first windows, offset-derived ids that stay stable
// across re-reads, nested agents' steps placed under their Agent cards. Two differences:
//   - every line of a subagent file is isSidechain:true, which the Normalizer drops on a main
//     thread; lines are re-marked as main-thread before parsing;
//   - nested agents live in the SAME subagents dir (flat), not in <file>/subagents.
// Live updates are a poll: the client passes the `rev` it last saw; an unchanged file (and
// unchanged nested-agent files) answers { unchanged: true } without parsing anything.

const fs = require('fs');
const path = require('path');
const { TranscriptPager } = require('./pager');
const { findTranscript } = require('./transcript');
const { contextFrom } = require('./util');

const AGENT_NAMES = new Set(['Agent', 'Task']);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_RE = /^[A-Za-z0-9]{6,64}$/;
const SPLIT_BYTES = 512 * 1024; // a live agent's newest window is re-parsed per poll; keep it small
const PAGER_MAX = 8;
const HEAD_MAX = 1024 * 1024;

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// djb2: a short stable token for the nested-agent size signature.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The top-level `"isSidechain":true` key (always among the first keys Claude Code writes). An
// escaped quote inside a string value can never match this unescaped sequence.
function mainThread(ln) {
  const i = ln.text.indexOf('"isSidechain":true');
  if (i < 0 || i > 400) return ln;
  return { off: ln.off, text: ln.text.slice(0, i) + '"isSidechain":false' + ln.text.slice(i + 18) };
}

class AgentPager extends TranscriptPager {
  constructor(file, agentKey) {
    super(file, { subagents: true, prefix: `a${agentKey}-` });
    this.kidSig = null;
    this.prompt = undefined; // first line's prompt text, read once
  }

  _subDir() {
    return path.dirname(this.file);
  }

  _parseLines(lines) {
    return super._parseLines(lines.map(mainThread));
  }

  // Sizes of the nested agents' files whose Agent cards are parsed (their steps are inlined).
  _kidSig() {
    let s = '';
    for (const [id, it] of this.toolItem) {
      if (!AGENT_NAMES.has(it.name)) continue;
      const f = this._subagentFile(id);
      const st = f && statOf(f);
      s += `${id}:${st ? st.size : '-'};`;
    }
    return s ? hash(s) : '';
  }

  loadNewest(minItems) {
    const r = super.loadNewest(minItems);
    this.kidSig = this._kidSig();
    return r;
  }

  refresh() {
    if (!this.started) return;
    // A parent waits on its nested agent without writing a line; its card's steps still change.
    if (this._kidSig() !== this.kidSig) {
      const keep = this.subCache; // unchanged children reuse their parse (keyed by file size)
      this._reset();
      this.subCache = keep;
      return; // page() reloads the newest windows
    }
    // Start a fresh newest window once the current one is big, so a long live agent is never
    // re-parsed from far back on every poll (base refresh re-parses the newest window whole).
    const last = this.windows[this.windows.length - 1];
    if (last && last.end - last.start > SPLIT_BYTES) this.windows.push({ start: this.hi, end: this.hi, flat: [], toolIds: [], orphanIds: [] });
    super.refresh();
  }

  rev() {
    const st = statOf(this.file);
    return `${st ? st.size : 0}.${this.started ? this._kidSig() : ''}`;
  }
}

// ---------- id → file ----------
const dirScans = new Map(); // subagents dir → { key, byTool: Map(toolUseId → file), noMeta: [file] }

function scanDir(dir) {
  const st = statOf(dir);
  if (!st) return null;
  const key = String(st.mtimeMs);
  const hit = dirScans.get(dir);
  if (hit && hit.key === key) return hit;
  const byTool = new Map();
  const noMeta = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const metas = new Set(names.filter((f) => f.endsWith('.meta.json')));
  for (const f of names) {
    if (!/^agent-[A-Za-z0-9]+\.jsonl$/.test(f)) continue;
    const metaName = f.replace(/\.jsonl$/, '.meta.json');
    let m = null;
    if (metas.has(metaName)) {
      try {
        m = JSON.parse(fs.readFileSync(path.join(dir, metaName), 'utf8'));
      } catch {}
    }
    if (m && typeof m.toolUseId === 'string') byTool.set(m.toolUseId, path.join(dir, f));
    else noMeta.push(path.join(dir, f));
  }
  const out = { key, byTool, noMeta };
  dirScans.set(dir, out);
  if (dirScans.size > 32) dirScans.delete(dirScans.keys().next().value);
  return out;
}

// The first line of a transcript (the agent's prompt), read without loading the file.
function headLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (total < HEAD_MAX) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : n)));
      total += n;
      if (nl >= 0) break;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function promptOf(j) {
  const c = j && j.type === 'user' && j.message && j.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return null;
}

// hints: { agentIds: [hex], prompt }
function resolveAgentFile(dir, toolUseId, hints = {}) {
  const scan = scanDir(dir);
  if (!scan) return { file: null, via: null };
  const exact = scan.byTool.get(toolUseId);
  if (exact && fs.existsSync(exact)) return { file: exact, via: 'meta' };
  for (const h of hints.agentIds || []) {
    if (!HEX_RE.test(h)) continue;
    const f = path.join(dir, `agent-${h}.jsonl`);
    if (fs.existsSync(f)) {
      // A meta that names a DIFFERENT tool_use wins over the hint (the hint was for another agent).
      let m = null;
      try {
        m = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      } catch {}
      if (!m || !m.toolUseId || m.toolUseId === toolUseId) return { file: f, via: 'agentId' };
    }
  }
  const want = typeof hints.prompt === 'string' ? hints.prompt.trim() : '';
  if (want) {
    for (const f of scan.noMeta) {
      const p = promptOf(headLine(f));
      if (p && p.trim() === want) return { file: f, via: 'prompt' };
    }
  }
  return { file: null, via: null };
}

// What the live session knows about this tool_use that can point at the file.
function hintsFrom(es, toolUseId) {
  const agentIds = [];
  let prompt = null;
  let item = null;
  const items = (es && Array.isArray(es.items) && es.items) || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.type === 'tool' && it.toolUseId === toolUseId) {
      item = it;
      break;
    }
  }
  if (item) {
    if (item.input && typeof item.input.prompt === 'string') prompt = item.input.prompt;
    const text = typeof item.result === 'string' ? item.result : (item.result && item.result.text) || '';
    const m = /agentId:\s*([A-Za-z0-9]{6,64})/.exec(text);
    if (m) agentIds.push(m[1]);
  }
  const t2t = es && es.fleet && es.fleet.taskToTool;
  if (t2t && typeof t2t.forEach === 'function') t2t.forEach((tool, task) => { if (tool === toolUseId && typeof task === 'string') agentIds.push(task); });
  return { agentIds, prompt, item };
}

// ---------- pagers ----------
const pagers = new Map(); // file → AgentPager (LRU)

function pagerFor(file) {
  let p = pagers.get(file);
  if (p) {
    pagers.delete(file);
    pagers.set(file, p);
    return p;
  }
  p = new AgentPager(file, path.basename(file, '.jsonl').replace(/^agent-/, ''));
  pagers.set(file, p);
  while (pagers.size > PAGER_MAX) pagers.delete(pagers.keys().next().value);
  return p;
}

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The Agent object the header shows: the live fleet's when it has one, filled in from disk.
function agentInfo(es, toolUseId, file, pager, hints) {
  const live = es && es.fleet && es.fleet.agents && es.fleet.agents.get(toolUseId);
  const a = live ? { ...live } : { id: toolUseId, sessionId: es && es.s ? es.s.id : null, parentId: null, depth: 0, description: '', subagentType: null, status: 'unknown', startedAt: null, context: null, toolCount: null, lastTool: null };
  const meta = file ? readMeta(file) : null;
  if (meta) {
    if (!a.description && meta.description) a.description = meta.description;
    if (!a.subagentType && meta.agentType) a.subagentType = meta.agentType;
  }
  if (hints && hints.item && !live) {
    const it = hints.item;
    a.status = it.status === 'running' ? 'running' : it.status === 'error' ? 'error' : 'done';
    a.startedAt = it.startedAt || it.ts || null;
    if (it.endedAt) a.endedAt = it.endedAt;
    if (it.input) {
      if (!a.description) a.description = it.input.description || '';
      if (!a.subagentType) a.subagentType = it.input.subagent_type || null;
      if (!a.model && it.input.model) a.model = it.input.model;
    }
  }
  if (pager && pager.started) {
    const lm = pager.meta.lastModel;
    if (lm && !a.model) a.model = lm;
    const u = pager.meta.lastUsage;
    if (!a.context && u) {
      const c = contextFrom(u, lm || a.model);   // the same sum and window rule as the live fleet
      if (c) a.context = c;
    }
  }
  if (file) a.transcriptId = path.basename(file, '.jsonl').replace(/^agent-/, '');
  return a;
}

// agentTranscript(es, { sessionId, agentId, before?, limit?, rev? }, projectsDir)
//   → { items, hasMore, agent, file, prompt, rev, via } | { unchanged: true, rev, agent }
//   | { items: [], hasMore: false, agent, file: null, missing: "why" }
function agentTranscript(es, p = {}, projectsDir) {
  const agentId = p.agentId;
  if (typeof agentId !== 'string' || !ID_RE.test(agentId)) throw err('agentId must be an Agent tool_use id', 'bad_params');
  if (p.before !== undefined && p.before !== null && (typeof p.before !== 'string' || p.before.length > 200)) throw err('before must be an item id', 'bad_params');
  if (p.rev !== undefined && p.rev !== null && (typeof p.rev !== 'string' || p.rev.length > 100)) throw err('rev must be a string', 'bad_params');
  const limit = Math.max(1, Math.min(Number(p.limit) || 200, 1000));
  const hints = hintsFrom(es, agentId);
  const s = (es && es.s) || {};
  const none = (missing) => ({ items: [], hasMore: false, agent: agentInfo(es, agentId, null, null, hints), file: null, missing });

  if (!s.claudeSessionId) return none('This session has not started Claude Code yet, so no agent transcript exists.');
  const main = findTranscript(s.claudeSessionId, s.cwd, projectsDir);
  if (!main) return none(`No Claude Code transcript for session ${s.claudeSessionId} under ${projectsDir}.`);
  const dir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
  const { file, via } = resolveAgentFile(dir, agentId, hints);
  if (!file) {
    const why = statOf(dir)
      ? `No transcript in ${dir} matches this agent (no meta.json names ${agentId}${hints.agentIds.length ? `, no agent-${hints.agentIds[0]}.jsonl` : ''}${hints.prompt ? ', no prompt match' : ''}). It may not have written its first line yet.`
      : `This session has no subagent transcripts yet (${dir} does not exist).`;
    return none(why);
  }

  const pager = pagerFor(file);
  if (p.rev && !p.before && pager.started) {
    pager.refresh(); // cheap when nothing changed: a stat per file
    if (pager.started) {
      const rev = pager.rev();
      if (rev === p.rev) return { unchanged: true, rev, agent: agentInfo(es, agentId, file, pager, hints) };
    }
  }
  const page = pager.page({ before: p.before || undefined, limit });
  // The first line is the prompt; the view shows it on its own, above the steps.
  const promptId = `${pager.prefix}0`;
  const items = page.items.filter((it) => !(it.id === promptId && it.type === 'user'));
  // Only the prompt left before this page: nothing earlier to load.
  let hasMore = page.hasMore;
  if (hasMore && pager.lo === 0 && items.length && pager.items[0] && pager.items[0].id === promptId && pager.items[1] === items[0]) hasMore = false;
  // What the agent actually received (its first line) beats the Agent tool input.
  if (pager.prompt === undefined) pager.prompt = promptOf(headLine(file)) || null;
  const prompt = pager.prompt || hints.prompt || null;
  return { items, hasMore, agent: agentInfo(es, agentId, file, pager, hints), file, prompt, rev: pager.rev(), via };
}

module.exports = { agentTranscript, resolveAgentFile, AgentPager, _internal: { mainThread, headLine, pagers, dirScans } };
