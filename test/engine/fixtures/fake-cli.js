'use strict';
// A stand-in claude.exe for broker.test.js: speaks just enough stream-json + control protocol for the REAL Agent SDK.
// Each user message runs a turn of FAKE_STEPS steps, FAKE_STEP_MS apart; at step FAKE_HOOK_AT it calls the host's
// first PreToolUse hook (hook_callback) and waits for the answer, like a prod-guard check. Every assistant line
// names this process's pid and how many initialize requests it has seen (a re-attach must not reach the CLI).
const readline = require('readline');
const { randomUUID } = require('crypto');

const STEPS = Number(process.env.FAKE_STEPS || 4);
const STEP_MS = Number(process.env.FAKE_STEP_MS || 300);
const HOOK_AT = Number(process.env.FAKE_HOOK_AT || 2);
const VERSION = process.env.FAKE_CLI_VERSION || '2.1.295'; // reported in system init (keep-compat.js checks it)
const HOOKS_APPLIED = process.env.FAKE_HOOKS_APPLIED !== '0'; // '0': a CLI that takes a repeated initialize without confirming hooks
let cost = Number(process.env.FAKE_COST_BASE || 0); // cumulative total_cost_usd, +0.01 per turn
const sid = 'fake-' + process.pid;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inits = 0;
let hookId = null;
const waiting = new Map();
const turns = [];

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') {
    if (m.request && m.request.subtype === 'initialize') {
      inits++;
      const pre = m.request.hooks && m.request.hooks.PreToolUse;
      hookId = pre && pre[0] && pre[0].hookCallbackIds && pre[0].hookCallbackIds[0];
      // like Claude Code 2.1.29x on a repeated initialize from its stdin owner: the new hooks replace the old, and a
      // hook call still waiting for the old host is resolved here (a pending PreToolUse is denied, then retried)
      if (inits > 1) for (const [rid, w] of [...waiting]) { waiting.delete(rid); w({ subtype: 'retry' }); }
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: m.request.subtype === 'initialize' ? { commands: [], models: [], account: {}, fakePid: process.pid, ...(inits > 1 ? { hooks_applied: HOOKS_APPLIED, pending_permission_requests: [] } : {}) } : {} } });
  } else if (m.type === 'control_response') {
    const w = waiting.get(m.response && m.response.request_id);
    if (w) { waiting.delete(m.response.request_id); w(m.response); }
  } else if (m.type === 'user') {
    turns.push(m);
    if (turns.length === 1) run();
  }
}).on('close', () => {
  // FAKE_IGNORE_EOF=1: a CLI that hangs after stdin closes (the broker must kill its tree by PID)
  if (process.env.FAKE_IGNORE_EOF === '1') setInterval(() => {}, 1000);
  else process.exit(0);
});

async function run() {
  while (turns.length) {
    const t = turns[0];
    const text = typeof t.message.content === 'string' ? t.message.content : JSON.stringify(t.message.content);
    out({ type: 'system', subtype: 'init', session_id: sid, uuid: randomUUID(), tools: [], model: 'fake', cwd: process.cwd(), mcp_servers: [], claude_code_version: VERSION });
    for (let i = 1; i <= STEPS; i++) {
      await sleep(STEP_MS);
      let hook = '';
      if (i === HOOK_AT && hookId) {
        for (let tries = 0; tries < 3; tries++) {
          const rid = `cli_${process.pid}_${i}_${Date.now()}_${tries}`;
          const answered = new Promise((r) => waiting.set(rid, r));
          out({ type: 'control_request', request_id: rid, request: { subtype: 'hook_callback', callback_id: hookId, input: { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'echo hi' } }, tool_use_id: 'tu_' + i } });
          const r = await answered;
          hook += ` hook:${r.subtype}`;
          if (r.subtype !== 'retry') break;
        }
      }
      out({ type: 'assistant', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { id: `msg_${Date.now()}_${i}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: `step ${i}/${STEPS} pid ${process.pid} inits ${inits}${hook} re: ${text.slice(0, 40)}` }], stop_reason: null, usage: {} } });
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: `done pid ${process.pid} inits ${inits}`, session_id: sid, uuid: randomUUID(), total_cost_usd: (cost = Math.round((cost + 0.01) * 1e6) / 1e6), usage: {}, num_turns: 1, duration_ms: STEPS * STEP_MS, duration_api_ms: 0 });
    turns.shift();
  }
}
