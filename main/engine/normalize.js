'use strict';
// SDK message / transcript line → Helm protocol items (docs/PROTOCOL.md "Item").
//
// One Normalizer per session transcript. It writes through a `store`:
//   store.add(item)                         append a new item (store assigns nothing; ids come from newId)
//   store.patch(itemId, patch, appendText?) shallow-merge into an existing item
//   store.get(itemId)                       current item object
// and reports side facts through optional `hooks` (usage, init, result, tasks, ...).
//
// Live stream shape (verified against claude.exe 2.1.294 + SDK 0.3.293, see test fixtures):
//   stream_event message_start → content_block_start(i) → deltas → [assistant message holding
//   ONE content block] → content_block_stop(i) → message_delta → message_stop.
//   So a final `assistant` message carries a single block; it is matched to the streamed item
//   by message.id + block type (+ tool_use id), in order.
// Transcript lines (~/.claude/projects/<slug>/<id>.jsonl) have the same message shapes with
// `uuid`, `timestamp`, `isMeta`, `isSidechain`, `toolUseResult`, plus metadata line types.

const { oneLine, truncate } = require('./util');
const { splitShellBlocks } = require('./shell-run');
const { splitNote } = require('./steer'); // lane steer: Helm's <helm-note> rides apart from the user's text

const MAX_RESULT_CHARS = 200_000;
const AGENT_NAMES = new Set(['Agent', 'Task']);
const MAX_IMAGE_DATAURL = 3_000_000;

function tsOf(x, fallback) {
  if (x && x.timestamp) {
    const t = Date.parse(x.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return fallback != null ? fallback : Date.now();
}

function stripAnsi(s) {
  return String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

// Claude Code appends internal diagnostics to some error results ("[ede_diagnostic] result_type=user
// last_content_type=n/a stop_reason=null"). They mean nothing to a user: drop every line that starts
// with a bracketed snake_case tag. Returns '' when nothing readable is left.
const INTERNAL_TAG_LINE = /^\s*\[[a-z][a-z0-9]*(?:_[a-z0-9]+)+\]/;
function cleanErrorText(s) {
  return String(s == null ? '' : s)
    .split(/\r?\n/)
    .filter((l) => !INTERNAL_TAG_LINE.test(l))
    .join('\n')
    .trim();
}

function capText(s) {
  s = String(s == null ? '' : s);
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n… [${s.length - MAX_RESULT_CHARS} more characters not shown]` : s;
}

function imageDataUrl(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    const url = `data:${src.media_type || 'image/png'};base64,${src.data}`;
    return url.length <= MAX_IMAGE_DATAURL ? url : null;
  }
  if (src.type === 'url' && src.url) return src.url;
  return null;
}

// tool_result.content → string | { text, images }
function toolResultValue(content) {
  if (content == null) return '';
  if (typeof content === 'string') return capText(content);
  if (Array.isArray(content)) {
    const texts = [];
    const images = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') texts.push(b.text || '');
      else if (b.type === 'image') {
        const u = imageDataUrl(b);
        if (u) images.push(u);
      } else if (b.type === 'tool_reference' && b.tool_name) texts.push(`[tool ${b.tool_name}]`);
    }
    const text = capText(texts.join('\n'));
    return images.length ? { text, images } : text;
  }
  return capText(typeof content === 'object' ? JSON.stringify(content) : String(content));
}

// user message content → { text, attachments }
function userContent(content) {
  if (typeof content === 'string') return { text: content, attachments: [] };
  const texts = [];
  const attachments = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') texts.push(b.text || '');
      else if (b.type === 'image') {
        const dataUrl = imageDataUrl(b);
        attachments.push({ kind: 'image', name: 'image', mime: (b.source && b.source.media_type) || 'image/png', ...(dataUrl ? { dataUrl } : {}) });
      } else if (b.type === 'document') {
        attachments.push({ kind: 'file', name: (b.title || 'document'), mime: (b.source && b.source.media_type) || 'application/pdf' });
      }
    }
  }
  return { text: texts.join('\n'), attachments };
}

function tag(text, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1] : null;
}

// Classify a user text (Claude Code wraps local commands and notifications in pseudo-tags).
// → { kind: 'prompt'|'info'|'interrupted'|'skip', text }
function classifyUserText(text) {
  const t = String(text || '');
  const s = t.trimStart();
  if (!s) return { kind: 'skip' };
  if (s.startsWith('[Request interrupted by user')) return { kind: 'interrupted', text: s.replace(/^\[|\]$/g, '') };
  if (!s.startsWith('<')) return { kind: 'prompt', text: t };
  const cmd = tag(s, 'command-name');
  // `/model` lines are how the CLI records a model switch (Helm's picker calls setModel, which
  // writes one); the "Set model to …" stdout line after it is the readable record.
  if (cmd != null && /^\/?model$/.test(cmd.trim())) return { kind: 'skip' };
  if (cmd != null) {
    const args = tag(s, 'command-args');
    return { kind: 'prompt', text: oneLine(`${cmd.startsWith('/') ? cmd : '/' + cmd} ${args || ''}`) };
  }
  const out = tag(s, 'local-command-stdout');
  if (out != null) {
    const clean = stripAnsi(out).trim();
    return clean ? { kind: 'info', text: clean } : { kind: 'skip' };
  }
  const bashIn = tag(s, 'bash-input');
  if (bashIn != null) return { kind: 'prompt', text: '! ' + bashIn };
  const bashOut = tag(s, 'bash-stdout');
  if (bashOut != null) {
    const err = tag(s, 'bash-stderr');
    const clean = stripAnsi([bashOut, err].filter(Boolean).join('\n')).trim();
    return clean ? { kind: 'info', text: clean } : { kind: 'skip' };
  }
  if (s.startsWith('<task-notification>')) {
    const summary = tag(s, 'summary');
    const status = tag(s, 'status');
    // taskToolUseId / taskStatus let the fleet match the notification to its agent exactly.
    const extra = { ...(tag(s, 'tool-use-id') ? { taskToolUseId: tag(s, 'tool-use-id') } : {}), ...(status ? { taskStatus: status } : {}) };
    return summary ? { kind: 'info', text: `Background task ${status || 'finished'}: ${oneLine(summary)}`, extra } : { kind: 'skip' };
  }
  if (/^<(system-reminder|local-command-caveat|user-prompt-submit-hook|command-message|command-args)>/.test(s)) return { kind: 'skip' };
  return { kind: 'prompt', text: t };
}

class Normalizer {
  constructor({ store, newId, hooks = {}, forceParent = null, toolsOnly = false, noPrompts = false, now = () => Date.now() }) {
    this.store = store;
    this.newId = newId;
    this.hooks = hooks;
    this.now = now;
    // Subagent transcripts: every item belongs to this Agent tool_use; only tool blocks kept.
    this.forceParent = forceParent;
    this.toolsOnly = toolsOnly;
    // noPrompts: keep tools + assistant text/thinking but no user/system lines (a subagent's own
    // transcript: its prompt is the Agent tool input; its text is what streamed live as children)
    this.noPrompts = noPrompts;
    this.toolByUseId = new Map(); // toolUseId → itemId
    this.streams = new Map(); // message.id → [{ itemId, type, toolUseId, final }]
    this.blockIndex = new Map(); // `${message.id}:${index}` → itemId
    this.currentMsg = new Map(); // parent key → message.id being streamed
    this.denied = new Set(); // toolUseIds the user denied
    this.recentErrTools = []; // history: tool items whose error result may belong to an interrupt
    this.sawInit = false;
  }

  // ---------- shared helpers ----------
  _add(item) {
    if (!item.id) item.id = this.newId();
    if (!item.ts) item.ts = this.now();
    if (this.forceParent && item.type === 'tool' && !item.parentToolUseId) item.parentToolUseId = this.forceParent;
    this.store.add(item);
    return item;
  }

  _parent(p) {
    return p || this.forceParent || undefined;
  }

  toolItem(toolUseId) {
    const id = this.toolByUseId.get(toolUseId);
    return id ? this.store.get(id) : null;
  }

  _startTool(block, parent, ts) {
    const existing = this.toolItem(block.id);
    if (existing) return existing; // callers patch the final input themselves
    const item = this._add({
      type: 'tool',
      ts,
      toolUseId: block.id,
      name: block.name,
      input: block.input || {},
      status: 'running',
      result: '',
      startedAt: ts,
      ...(this._parent(parent) ? { parentToolUseId: this._parent(parent) } : {}),
    });
    this.toolByUseId.set(block.id, item.id);
    if (this.hooks.onToolStart) this.hooks.onToolStart(item);
    return item;
  }

  markDenied(toolUseId) {
    this.denied.add(toolUseId);
    const it = this.toolItem(toolUseId);
    if (it && it.status === 'running') this.store.patch(it.id, { status: 'denied', endedAt: this.now() });
  }

  _toolResult(block, ts, structured) {
    const it = this.toolItem(block.tool_use_id);
    if (!it) return null;
    let status = block.is_error ? 'error' : 'done';
    if (block.is_error && this.denied.has(block.tool_use_id)) status = 'denied';
    const patch = { status, result: toolResultValue(block.content), endedAt: ts };
    // An error result that lands while an interrupt is in flight is the interrupt, not a failure.
    if (status === 'error') {
      if (this.hooks.isInterrupting && this.hooks.isInterrupting()) patch.interrupted = true;
      this.recentErrTools.push(it.id);
    }
    if (structured && it.name === 'AskUserQuestion' && structured.answers) patch.answers = structured.answers;
    // A finished subagent's tool_result is its report wrapped in a harness hand-back note meant
    // for the model; the structured result carries the report alone, which is what the user reads.
    if (structured && AGENT_NAMES.has(it.name) && status === 'done' && Array.isArray(structured.content)) {
      const report = structured.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
      if (report.trim()) patch.result = capText(report);
    }
    this.store.patch(it.id, patch);
    const updated = this.store.get(it.id);
    if (this.hooks.onToolEnd) this.hooks.onToolEnd(updated, structured || null);
    return updated;
  }

  // Shell blocks parsed from one transcript user line (splitShellBlocks) → `shell` items, already
  // shared (they are in what Claude saw). Output with no input in the same line belongs to the run
  // before it (a terminal `!` writes `<bash-input>` and `<bash-stdout>` as two user lines).
  _shellBlocks(sh, j, ts) {
    const show = (r) => [r.stdout, r.stderr].filter((x) => x && x.trim()).join('\n');
    for (const r of sh.runs) {
      const item = this._add({
        type: 'shell',
        ts,
        command: r.command,
        cwd: j.cwd || null,
        shell: null,
        text: show(r),
        stdout: r.stdout,
        stderr: r.stderr,
        // Helm writes input and output together and marks a failure with "Exit code N"; a terminal
        // `!` line has no exit code on record.
        exitCode: r.exitCode != null ? r.exitCode : r.hasOutput && r.status === 'done' ? 0 : null,
        status: r.status,
        startedAt: ts,
        endedAt: ts,
        shared: true,
      });
      this.lastShell = item.id;
    }
    if (!sh.orphan) return;
    const prev = !sh.runs.length && this.lastShell ? this.store.get(this.lastShell) : null;
    if (prev && !prev.text && !prev.stdout && !prev.stderr) {
      const o = sh.orphan;
      this.store.patch(prev.id, { text: show(o), stdout: o.stdout, stderr: o.stderr, status: o.status, ...(o.exitCode != null ? { exitCode: o.exitCode } : {}), endedAt: ts });
    } else {
      const clean = show(sh.orphan).trim();
      if (clean) this.system('info', clean, ts); // its input is in an older page: plain text, as before
    }
  }

  system(subtype, text, ts, extra) {
    return this._add({ type: 'system', subtype, text: String(text || ''), ts: ts || this.now(), ...(extra || {}) });
  }

  // Close every streaming text/thinking item (turn ended, interrupted or crashed).
  finishStreaming() {
    for (const list of this.streams.values()) {
      for (const s of list) {
        if (!s.final && (s.type === 'text' || s.type === 'thinking')) {
          this.store.patch(s.itemId, { streaming: false });
          s.final = true;
        }
      }
    }
    this.streams.clear();
    this.blockIndex.clear();
    this.currentMsg.clear();
  }

  // Mark still-running tools as ended. A stop the user asked for (interrupt, session closed) carries
  // `interrupted: true` and renders as a neutral "Stopped"; status stays "error" so older readers
  // still see a finished tool. Without the flag (Claude Code died) it is a real failure.
  failRunningTools(reason, { interrupted = false } = {}) {
    for (const itemId of this.toolByUseId.values()) {
      const it = this.store.get(itemId);
      if (it && it.status === 'running') {
        this.store.patch(itemId, { status: 'error', result: it.result || reason || 'Stopped', endedAt: this.now(), ...(interrupted ? { interrupted: true } : {}) });
      }
    }
  }

  // History: the CLI writes an interrupted tool's error tool_result first, then a
  // "[Request interrupted by user for tool use]" line. Flag those results as the interrupt.
  _markRecentInterrupted() {
    for (const itemId of this.recentErrTools || []) {
      const it = this.store.get(itemId);
      if (it && it.status === 'error' && !it.interrupted) this.store.patch(itemId, { interrupted: true });
    }
    this.recentErrTools = [];
  }

  // ---------- assistant content ----------
  _assistantBlocks(msg, parent, ts, opts = {}) {
    const m = msg.message || {};
    const msgId = m.id || msg.uuid;
    const list = this.streams.get(msgId) || [];
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
        const s = list.find((x) => x.type === 'tool_use' && x.toolUseId === b.id);
        if (s) s.final = true;
        const it = this._startTool(b, parent, ts);
        if (b.input && Object.keys(b.input).length) {
          this.store.patch(it.id, { input: b.input });
          if (this.hooks.onToolInput) this.hooks.onToolInput(this.store.get(it.id));
        }
        continue;
      }
      if (this.toolsOnly) continue;
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
        const type = b.type === 'text' ? 'text' : 'thinking';
        const text = b.type === 'text' ? b.text || '' : b.thinking || '';
        const s = list.find((x) => x.type === type && !x.final);
        if (s) {
          s.final = true;
          const patch = { text, streaming: false };
          if (b.type === 'redacted_thinking') patch.redacted = true;
          this.store.patch(s.itemId, patch);
          continue;
        }
        if (type === 'text' && !text.trim()) continue;
        if (type === 'thinking' && !text.trim() && b.type !== 'redacted_thinking') continue;
        if (type === 'text' && opts.apiError) {
          const clean = cleanErrorText(text);
          if (clean) this.system('error', clean, ts);
          continue;
        }
        if (type === 'text') {
          this._add({ type: 'assistant', ts, text, streaming: false, model: m.model || null, ...(this._parent(parent) ? { parentToolUseId: this._parent(parent) } : {}) });
        } else {
          this._add({ type: 'thinking', ts, text, streaming: false, ...(b.type === 'redacted_thinking' ? { redacted: true } : {}), ...(this._parent(parent) ? { parentToolUseId: this._parent(parent) } : {}) });
        }
      } else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result' || b.type === 'mcp_tool_result') {
        this._toolResult({ tool_use_id: b.tool_use_id, content: b.content, is_error: !!b.is_error }, ts);
      }
    }
  }

  // ---------- live SDK messages ----------
  handleSdk(msg) {
    if (!msg || typeof msg !== 'object') return;
    const now = this.now();
    const parent = msg.parent_tool_use_id || null;
    switch (msg.type) {
      case 'stream_event':
        return this._streamEvent(msg.event || {}, parent, now);
      case 'assistant': {
        this.recentErrTools = [];
        this._assistantBlocks(msg, parent, now, { apiError: !!msg.error });
        if (this.hooks.onAssistant) this.hooks.onAssistant(msg, parent);
        return;
      }
      case 'user': {
        if (msg.isReplay) return;
        const content = msg.message && msg.message.content;
        if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
          for (const b of content) if (b && b.type === 'tool_result') this._toolResult(b, now, msg.tool_use_result);
          return;
        }
        if (this.toolsOnly) return;
        // The CLI only echoes synthetic user messages (our own prompts are not replayed).
        // ("[Request interrupted by user]" echoes are skipped: the session adds its own marker.)
        const { text } = userContent(content);
        const c = classifyUserText(text);
        if (c.kind === 'info') this.system('info', c.text, now, c.extra);
        return;
      }
      case 'result': {
        this.finishStreaming();
        const cost = this.hooks.onResult ? this.hooks.onResult(msg) : msg.total_cost_usd;
        const u = msg.usage || {};
        // A turn the user stopped on purpose (sessions.interrupt) ends with an error result from the
        // CLI ("error_during_execution" when it was cut off early). It is not a failure: the session
        // already added its "Interrupted" line, so the result is marked interrupted, never isError,
        // and no error card follows.
        const interrupted = !!(this.hooks.isInterrupting && this.hooks.isInterrupting());
        this._add({
          type: 'result',
          ts: now,
          durationMs: msg.duration_ms || 0,
          costUsd: cost == null ? null : cost,
          numTurns: msg.num_turns || 0,
          isError: !!msg.is_error && !interrupted,
          usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 },
          subtype: msg.subtype,
          ...(interrupted ? { interrupted: true } : {}),
        });
        if (!interrupted && msg.subtype !== 'success' && Array.isArray(msg.errors) && msg.errors.length) {
          this.system('error', cleanErrorText(msg.errors.join('\n')) || 'Claude Code ended the turn with an error.', now);
        }
        return;
      }
      case 'system':
        return this._systemSdk(msg, now);
      case 'rate_limit_event':
        if (this.hooks.onRateLimit) this.hooks.onRateLimit(msg.rate_limit_info);
        return;
      case 'tool_progress':
        if (this.hooks.onToolProgress) this.hooks.onToolProgress(msg);
        return;
      case 'auth_status':
        if (msg.error) this.system('error', `Authentication: ${msg.error}`, now);
        return;
      default:
        return;
    }
  }

  _streamEvent(ev, parent, now) {
    const pkey = parent || '';
    switch (ev.type) {
      case 'message_start': {
        const id = ev.message && ev.message.id;
        if (id) {
          this.currentMsg.set(pkey, id);
          if (!this.streams.has(id)) this.streams.set(id, []);
          this._streamModel = (ev.message && ev.message.model) || this._streamModel;
        }
        if (this.hooks.onStreamStart) this.hooks.onStreamStart(parent);
        return;
      }
      case 'content_block_start': {
        const msgId = this.currentMsg.get(pkey);
        if (!msgId) return;
        const cb = ev.content_block || {};
        const list = this.streams.get(msgId);
        const key = `${msgId}:${ev.index}`;
        if (cb.type === 'text') {
          if (this.toolsOnly) return;
          const it = this._add({ type: 'assistant', ts: now, text: cb.text || '', streaming: true, model: this._streamModel || null, ...(this._parent(parent) ? { parentToolUseId: this._parent(parent) } : {}) });
          list.push({ itemId: it.id, type: 'text', final: false });
          this.blockIndex.set(key, it.id);
          if (this.hooks.onTextStart) this.hooks.onTextStart('text', parent);
        } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
          if (this.toolsOnly) return;
          const it = this._add({ type: 'thinking', ts: now, text: cb.thinking || '', streaming: cb.type === 'thinking', ...(cb.type === 'redacted_thinking' ? { redacted: true } : {}), ...(this._parent(parent) ? { parentToolUseId: this._parent(parent) } : {}) });
          list.push({ itemId: it.id, type: 'thinking', final: cb.type !== 'thinking' });
          this.blockIndex.set(key, it.id);
          if (this.hooks.onTextStart) this.hooks.onTextStart('thinking', parent);
        } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
          const it = this._startTool({ id: cb.id, name: cb.name, input: cb.input && Object.keys(cb.input).length ? cb.input : {} }, parent, now);
          list.push({ itemId: it.id, type: 'tool_use', toolUseId: cb.id, final: false });
          this.blockIndex.set(key, it.id);
        }
        return;
      }
      case 'content_block_delta': {
        const msgId = this.currentMsg.get(pkey);
        const itemId = msgId && this.blockIndex.get(`${msgId}:${ev.index}`);
        if (!itemId) return;
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) this.store.patch(itemId, null, d.text);
        else if (d.type === 'thinking_delta' && d.thinking) this.store.patch(itemId, null, d.thinking);
        return;
      }
      default:
        return;
    }
  }

  _systemSdk(msg, now) {
    switch (msg.subtype) {
      case 'init': {
        if (this.hooks.onInit) this.hooks.onInit(msg);
        if (this.sawInit) return;
        this.sawInit = true;
        const mcp = (msg.mcp_servers || []).filter((s) => s.status === 'connected').length;
        const parts = [
          `Claude Code ${msg.claude_code_version || ''}`.trim(),
          msg.model,
          msg.cwd,
          `${(msg.tools || []).length} tools`,
          `${mcp} MCP servers`,
          `${(msg.skills || []).length} skills`,
        ];
        if ((msg.plugins || []).length) parts.push(`${msg.plugins.length} plugins`);
        const errs = (msg.plugin_errors || []).map((e) => `${e.plugin}: ${e.message}`);
        this.system('init', parts.filter(Boolean).join(' · ') + (errs.length ? `\nPlugin errors: ${errs.join('; ')}` : ''), now);
        return;
      }
      case 'compact_boundary': {
        const md = msg.compact_metadata || {};
        const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
        this.system('compact', `Conversation compacted (${md.trigger || 'auto'}${md.pre_tokens ? `, ${k(md.pre_tokens)}${md.post_tokens ? ' → ' + k(md.post_tokens) : ''} tokens` : ''})`, now);
        if (this.hooks.onCompact) this.hooks.onCompact(md);
        return;
      }
      case 'status':
        if (this.hooks.onStatus) this.hooks.onStatus(msg);
        return;
      case 'api_retry': {
        const why = msg.error_status ? `${msg.error_status} ${msg.error || ''}` : msg.error || 'no response';
        this.system('info', `API error (${String(why).trim()}), retrying in ${Math.round((msg.retry_delay_ms || 0) / 1000)}s (attempt ${msg.attempt}/${msg.max_retries})`, now);
        return;
      }
      case 'hook_response':
        if (msg.outcome === 'error' || (msg.exit_code && msg.exit_code !== 0)) {
          const out = stripAnsi(msg.stderr || msg.output || msg.stdout || '').trim();
          this.system('hook', `Hook ${msg.hook_name} failed${msg.exit_code != null ? ` (exit ${msg.exit_code})` : ''}${out ? ': ' + truncate(out, 2000) : ''}`, now);
        }
        return;
      case 'local_command_output':
        if (msg.content) this.system('info', stripAnsi(msg.content).trim(), now);
        return;
      case 'informational':
      case 'notification': {
        const text = msg.text || msg.message || msg.content || msg.title;
        if (text) this.system('info', stripAnsi(String(text)).trim(), now);
        return;
      }
      case 'permission_denied': {
        const id = msg.tool_use_id;
        if (id) this.markDenied(id);
        return;
      }
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        if (this.hooks.onTask) this.hooks.onTask(msg);
        return;
      case 'background_tasks_changed': // level signal: the full set of live background tasks (REPLACE)
        if (this.hooks.onBackgroundTasks) this.hooks.onBackgroundTasks(msg);
        return;
      default:
        return;
    }
  }

  // ---------- on-disk transcript lines ----------
  handleLine(j) {
    if (!j || typeof j !== 'object') return;
    if (j.isSidechain && !this.forceParent) return;
    const ts = tsOf(j);
    switch (j.type) {
      case 'user': {
        const content = j.message && j.message.content;
        if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
          for (const b of content) if (b && b.type === 'tool_result') this._toolResult(b, ts, j.toolUseResult);
          return;
        }
        if (this.toolsOnly || this.noPrompts) return;
        if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return;
        const uc = userContent(content);
        const { attachments } = uc;
        let { text } = uc;
        // `!` runs: Helm prepends them to the next prompt; a terminal writes input and output as
        // two lines of their own. Either way they become `shell` cards (shell-run.js).
        const sh = splitShellBlocks(text);
        if (sh) {
          this._shellBlocks(sh, j, ts);
          if (!sh.rest.trim() && !attachments.length) return;
          text = sh.rest;
        }
        const sn = splitNote(text);
        if (sn.note) text = sn.rest;
        const c = classifyUserText(text);
        if (c.kind === 'prompt' || (c.kind === 'skip' && attachments.length)) {
          this.recentErrTools = [];
          this._add({ type: 'user', ts, text: c.kind === 'prompt' ? c.text : '', attachments, ...(j.uuid ? { uuid: j.uuid } : {}), ...(sn.note ? { helmNote: sn.note } : {}) });
        } else if (c.kind === 'info') this.system('info', c.text, ts, c.extra);
        else if (c.kind === 'interrupted') {
          this._markRecentInterrupted();
          this.failRunningTools('Interrupted', { interrupted: true });
          this.system('interrupted', 'Interrupted', ts);
        }
        return;
      }
      case 'assistant':
        this.recentErrTools = [];
        this._assistantBlocks(j, null, ts, { apiError: !!j.isApiErrorMessage });
        if (this.hooks.onAssistant) this.hooks.onAssistant(j, this.forceParent);
        return;
      // lane steer: a message the user sent mid-turn, folded into the running turn after a tool call. Claude Code
      // writes it as a queued_command attachment, not a user line. Task notifications fold the same way: skipped.
      case 'attachment': {
        const a = j.attachment;
        if (this.toolsOnly || this.noPrompts || !a || a.type !== 'queued_command') return;
        if ((a.commandMode && a.commandMode !== 'prompt') || (a.origin && a.origin.kind)) return;
        const uc = userContent(a.prompt);
        let text = uc.text;
        const sh = splitShellBlocks(text);
        if (sh) {
          this._shellBlocks(sh, j, ts);
          text = sh.rest;
        }
        const sn = splitNote(text);
        if (sn.note) text = sn.rest;
        if (!String(text || '').trim() && !uc.attachments.length) return;
        this._add({ type: 'user', ts, text, attachments: uc.attachments, steer: 'seen', ...(a.source_uuid ? { uuid: a.source_uuid } : {}), ...(sn.note ? { helmNote: sn.note } : {}) });
        return;
      }
      case 'system': {
        if (this.toolsOnly || this.noPrompts) return;
        if (j.subtype === 'compact_boundary') {
          const md = j.compactMetadata || {};
          const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
          this.system('compact', `Conversation compacted (${md.trigger || 'auto'}${md.preTokens ? `, ${k(md.preTokens)}${md.postTokens ? ' → ' + k(md.postTokens) : ''} tokens` : ''})`, ts);
        } else if (j.subtype === 'turn_duration') {
          this._add({ type: 'result', ts, durationMs: j.durationMs || 0, costUsd: null, numTurns: null, isError: false, usage: null });
        } else if (j.subtype === 'local_command' && j.content) {
          const c = classifyUserText(j.content);
          if (c.kind === 'info') this.system('info', c.text, ts, c.extra);
        } else if (j.subtype === 'informational' && j.content) {
          this.system('info', stripAnsi(j.content).trim(), ts);
        } else if (j.subtype === 'stop_hook_summary' && Array.isArray(j.hookErrors) && j.hookErrors.length) {
          this.system('hook', `Stop hook error: ${truncate(j.hookErrors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; '), 2000)}`, ts);
        } else if (j.subtype === 'api_error' && j.error && !(j.retryAttempt < j.maxRetries)) {
          this.system('error', `API error: ${cleanErrorText(j.error.formatted || j.error.message || '')}`, ts);
        }
        return;
      }
      default:
        return;
    }
  }
}

module.exports = { Normalizer, toolResultValue, userContent, classifyUserText, stripAnsi, cleanErrorText };
