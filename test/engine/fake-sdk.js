'use strict';
// A stand-in for @anthropic-ai/claude-agent-sdk's query(): consumes the streaming-input prompt
// and, per user message, runs `turn(userMsg, api)` (an async generator yielding SDK frames).
// api.ask(toolName, input, toolUseID) goes through options.canUseTool like the real CLI.

function createFakeSdk(turn, { initExtra = {}, projectsDir = null } = {}) {
  const calls = []; // every query() call: { options, q }
  const forks = []; // every forkSession() call: { sessionId, options, newId }
  function query({ prompt, options }) {
    // withdrawn / taken: uuids for cancelAsyncMessage (lane steer); a message is taken when its turn starts
    const state = { interrupted: false, closed: false, model: options.model, mode: options.permissionMode, flags: {}, withdrawn: new Set(), taken: new Set() };
    const replay = !!(options.extraArgs && 'replay-user-messages' in options.extraArgs);
    const api = {
      options,
      state,
      ask: (toolName, input, toolUseID) => options.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID, requestId: 'r' + toolUseID }),
    };
    let sentInit = false;
    const sessionId = options.sessionId || options.resume || 'fake-session';
    async function* run() {
      for await (const um of prompt) {
        if (state.closed) return;
        if (!sentInit) {
          sentInit = true;
          yield { type: 'system', subtype: 'init', session_id: sessionId, cwd: options.cwd, tools: ['Bash', 'Edit', 'mcp__eta__Eta'], mcp_servers: [], model: options.model || 'claude-haiku-5-5', permissionMode: options.permissionMode, slash_commands: [], skills: [], plugins: [], claude_code_version: 'fake', ...initExtra };
        }
        if (um.uuid && state.withdrawn.has(um.uuid)) continue;
        if (um.uuid) state.taken.add(um.uuid);
        state.interrupted = false;
        // like --replay-user-messages: the CLI echoes the prompt it takes (the normalizer skips these)
        if (replay && um.uuid) yield { type: 'user', isReplay: true, uuid: um.uuid, message: um.message, parent_tool_use_id: null, session_id: sessionId };
        for await (const m of turn(um, api)) {
          if (state.closed) return;
          yield { session_id: sessionId, ...m };
          if (state.interrupted) break;
        }
        if (state.interrupted) yield { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, errors: [], ...(state.interruptResult || {}), session_id: sessionId };
      }
    }
    const it = run();
    const q = {
      [Symbol.asyncIterator]: () => it,
      next: () => it.next(),
      async interrupt() { state.interrupted = true; },
      async cancelAsyncMessage(uuid) { if (state.taken.has(uuid)) return false; state.withdrawn.add(uuid); return true; },
      async setModel(m) { state.model = m; },
      async setPermissionMode(m) { state.mode = m; },
      async applyFlagSettings(f) { Object.assign(state.flags, f); },
      async supportedCommands() { return [{ name: 'compact', description: 'Compact', argumentHint: '' }]; },
      async supportedModels() { return [{ value: 'default', displayName: 'Default', description: 'd' }]; },
      async initializationResult() { return { commands: [{ name: 'probe-cmd', description: 'p', argumentHint: '' }], models: [{ value: 'm1', displayName: 'M1', description: '' }] }; },
      async rewindFiles(id) { return { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 2, id }; },
      close() { state.closed = true; },
    };
    calls.push({ options, q, state });
    return q;
  }
  // Like the SDK's forkSession: copy the transcript (up to and including upToMessageId) into a new
  // session file next to it, with fresh uuids, then a custom-title line.
  async function forkSession(sessionId, options = {}) {
    const fs = require('fs');
    const path = require('path');
    const { randomUUID } = require('crypto');
    let src = null;
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) src = p;
    }
    if (!src) throw new Error('Session ' + sessionId + ' not found');
    const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let keep = lines;
    if (options.upToMessageId) {
      const i = lines.findIndex((j) => j.uuid === options.upToMessageId);
      if (i < 0) throw new Error('Message not found');
      keep = lines.slice(0, i + 1);
    }
    const newId = randomUUID();
    const map = new Map();
    for (const j of keep) if (j.uuid) map.set(j.uuid, randomUUID());
    const out = keep.map((j) => ({ ...j, sessionId: newId, ...(j.uuid ? { uuid: map.get(j.uuid) } : {}), ...(j.parentUuid ? { parentUuid: map.get(j.parentUuid) || null } : {}) }));
    if (options.title) out.push({ type: 'custom-title', customTitle: options.title, sessionId: newId });
    fs.writeFileSync(path.join(path.dirname(src), newId + '.jsonl'), out.map((j) => JSON.stringify(j)).join('\n') + '\n');
    forks.push({ sessionId, options, newId });
    return { sessionId: newId };
  }
  return { query, calls, forks, forkSession };
}

// Small frame builders.
const F = {
  textTurn(msgId, text, { cost = 0.01, model = 'claude-haiku-5-5' } = {}) {
    return [
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: msgId, model } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 2) } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(2) } } },
      { type: 'assistant', parent_tool_use_id: null, uuid: 'u-' + msgId, message: { id: msgId, model, content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 5 } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
    ];
  },
  toolUse(msgId, id, name, input, parent = null) {
    return { type: 'assistant', parent_tool_use_id: parent, uuid: 'u-' + id, message: { id: msgId, model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 3, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 7 } } };
  },
  toolResult(id, content, { isError = false, parent = null, structured } = {}) {
    return { type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...(structured ? { tool_use_result: structured } : {}) };
  },
  result(total, extra = {}) {
    return { type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 1, total_cost_usd: total, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, modelUsage: { 'claude-haiku-5-5': { contextWindow: 1000000 } }, ...extra };
  },
};

module.exports = { createFakeSdk, F };
