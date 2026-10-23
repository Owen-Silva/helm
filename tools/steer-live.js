'use strict';
// Live check (lane steer, 2026-10-09): a message the user sends mid-turn reaches Claude at its next step and never
// stops the background agent the turn launched. Real claude.exe + claude-haiku-5-5, in-process engine, temp
// userData + temp cwd (never the user's Helm, port 4871 or %APPDATA%\Helm). About $0.01, 2-3 minutes.
//   node tools/steer-live.js [--keep]   (--keep: leave the temp cwd and its ~/.claude/projects transcript)
// 1 a turn launches ONE background agent (12 x sleep 12 in Bash) and then sleeps 20 + 20 itself
// 2 mid-turn, through Helm's real sessions.send: a message with a codeword → delivery 'next-step', no interrupt
// 3 Claude quotes the codeword BEFORE the turn's result; the item ends 'seen'
// 4 the agent is still running afterwards and its own transcript kept growing
// 5 a plain sessions.interrupt is refused (agents_running, names the agent); stopAgents: true stops it
// Summary line: `steer-live: N passed, M failed` (+ live spend).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../main/engine');
const { projectsDir, slugFor } = require('../main/engine/transcript');
const { dropLiveTranscripts } = require('./live-cleanup');
const KEEP = process.argv.includes('--keep'); // keep the temp cwd and its ~/.claude/projects transcript

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'claude-haiku-5-5';
const CODE = 'TEAL-' + Math.floor(Math.random() * 900 + 100);

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-steer-live-'));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const t0 = Date.now();
  const rel = (t = Date.now()) => `+${((t - t0) / 1000).toFixed(1)}s`;
  const engine = createEngine({ userDataDir: path.join(root, 'ud'), emit: () => {}, log: () => {}, getDefaults: () => ({ model: MODEL, permissionMode: 'bypassPermissions' }), etaDir: false, external: false, usageSampling: false });
  const m = engine.methods;
  const checks = [];
  const check = (name, ok, ev) => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${ev}`); };
  let es = null;
  try {
    const s = await m['sessions.create']({ cwd, model: MODEL, permissionMode: 'bypassPermissions' });
    es = engine._internal.sessions.get(s.id);
    let interrupts = 0;
    let codeAt = null;
    let resultAt = null;
    const onMessage = es._onMessage.bind(es);
    es._onMessage = (msg) => {
      if (msg.type === 'assistant' && !msg.parent_tool_use_id && !codeAt && JSON.stringify(msg.message.content).includes(CODE)) codeAt = Date.now();
      if (msg.type === 'result' && !resultAt) resultAt = Date.now();
      return onMessage(msg);
    };
    const prompt = [
      'Automated Helm test. Do not ask any questions; sub-agents of your agent may not spawn more agents.',
      'Step 1: call the Agent tool ONCE with run_in_background: true, subagent_type "general-purpose", model "haiku",',
      'description "steer live worker", prompt: "Run the Bash command sleep 12 , twelve times, as twelve separate Bash calls one after the other. Then reply with the word done."',
      'Step 2: right after launching it, run the Bash command: sleep 20 . Step 3: run the Bash command: sleep 20 . Step 4: reply with one short line.',
      'If the user sends you any message while you work, then in your very next text output quote any codeword it contains, and carry on with the steps.',
    ].join(' ');
    await m['sessions.send']({ id: s.id, text: prompt });
    let agent = null;
    const until = Date.now() + 150000;
    while (Date.now() < until) {
      agent = es.fleet.list().find((a) => a.status === 'running' && a.background && a.agentId);
      if (agent && es.turnActive && es.items.some((it) => it.type === 'tool' && it.name === 'Bash' && it.status === 'running' && !it.parentToolUseId)) break;
      await sleep(250);
    }
    if (!agent) throw new Error('no background agent within 150 s');
    if (es.q) { const qi = es.q.interrupt.bind(es.q); es.q.interrupt = async (...a) => { interrupts++; return qi(...a); }; }
    const file = path.join(projectsDir(), slugFor(cwd), String(es.s.claudeSessionId), 'subagents', `agent-${agent.agentId}.jsonl`);
    const lines = () => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').length; } catch { return 0; } };
    await sleep(2000);
    const before = lines();
    const tSend = Date.now();
    const r = await m['sessions.send']({ id: s.id, text: `Mid-turn note: the codeword is ${CODE}. Keep going.` });
    check('1 mid-turn send', r.delivery === 'next-step' && !r.queued, `sessions.send → ${JSON.stringify(r)} at ${rel(tSend)}; agent ${agent.description} running`);
    const until2 = Date.now() + 150000;
    while (Date.now() < until2 && (es.turnActive || !resultAt)) await sleep(250);
    const item = es.byId.get(r.itemId) || {};
    check('2 seen before the turn ended', !!codeAt && !!resultAt && codeAt < resultAt && item.steer === 'seen', `codeword quoted ${codeAt ? rel(codeAt) : 'never'}, turn result ${resultAt ? rel(resultAt) : 'never'}, item.steer=${item.steer}`);
    check('3 no interrupt', interrupts === 0, `q.interrupt calls: ${interrupts}`);
    await sleep(15000);
    const a2 = es.fleet.list().find((x) => x.id === agent.id) || {};
    const after = lines();
    check('4 agent survived', a2.status === 'running' && after > before, `agent status=${a2.status}; its transcript ${before} → ${after} lines since the send`);
    if (a2.status === 'running') {
      await m['sessions.send']({ id: s.id, text: 'Run the Bash command: sleep 30 . Then reply ok.' });
      const u3 = Date.now() + 60000;
      while (Date.now() < u3 && !(es.turnActive && es.items.some((it) => it.type === 'tool' && it.name === 'Bash' && it.status === 'running' && !it.parentToolUseId))) await sleep(250);
      let refused = null;
      try { await m['sessions.interrupt']({ id: s.id }); } catch (e) { refused = e; }
      const still = (es.fleet.list().find((x) => x.id === agent.id) || {}).status;
      const rs = await m['sessions.interrupt']({ id: s.id, stopAgents: true });
      await sleep(8000);
      const a3 = es.fleet.list().find((x) => x.id === agent.id) || {};
      check('5 explicit Stop', !!refused && refused.code === 'agents_running' && still === 'running' && a3.status === 'stopped', `plain interrupt → ${refused ? refused.code + ' "' + refused.message + '"' : 'not refused'}; agent ${still} after the refusal; stopAgents → ${JSON.stringify(rs)}, agent ${a3.status}/${a3.stopReason || '-'}`);
    } else check('5 explicit Stop', false, 'skipped: the agent was not running');
  } catch (e) {
    check('run', false, e.stack || e.message);
  } finally {
    try { await engine.shutdown(); } catch {}
  }
  const pass = checks.filter(Boolean).length;
  console.log(`steer-live: ${pass} passed, ${checks.length - pass} failed (live spend $${es ? (es.s.costUsd || 0).toFixed(4) : '?'}; temp ${root})`);
  if (KEEP) console.log(`(--keep: the CLI transcript is under ${path.join(projectsDir(), slugFor(cwd))})`);
  else console.log(`(cleaned up: ${dropLiveTranscripts([cwd]).length} transcript folder(s) and ${root})`);
  process.exit(0);
}
main();
