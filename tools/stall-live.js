'use strict';
// Live check (lane stall, 2026-10-09): what Helm sees when the user interrupts a turn while a background
// agent runs, on a real claude.exe + claude-haiku-5-5 in a throwaway temp cwd (never the user's Helm, never
// port 4871, never %APPDATA%\Helm: the engine runs in-process with a temp userData folder).
//
//   node tools/stall-live.js            (~$0.01; about 1-2 minutes)
//   node tools/stall-live.js --resume   (Resume on a real turn, ~$0.01; see resumeMode)
//   --keep   keep the temp cwd and its ~/.claude/projects transcript (removed by default)
//
// Steps: start a turn that launches ONE background agent (sleeps in Bash) and then sleeps itself;
// once the fleet shows the agent running with its agentId, call sessions.interrupt (Helm's Stop button /
// Esc path): it must be refused ('agents_running') while the agent runs, then sessions.interrupt with
// stopAgents: true (the user's "Stop them too" confirm) stops both; then watch for 30 s. Prints every task_* / background_tasks_changed message the CLI sent,
// the agent's final fleet state (status, stopReason, endedAt), the last line of its own transcript and
// the session's agentsRunning. Summary line: `stall-live: PASS|FAIL <why>`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../main/engine');
const { projectsDir, slugFor } = require('../main/engine/transcript');
const { dropLiveTranscripts } = require('./live-cleanup');
const KEEP = process.argv.includes('--keep'); // keep the temp cwd and its ~/.claude/projects transcript

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'claude-haiku-5-5';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-stall-live-'));
  const userDataDir = path.join(root, 'ud');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const taskLogs = [];
  const t0 = Date.now();
  const rel = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const engine = createEngine({
    userDataDir,
    emit: () => {},
    log: (lvl, msg) => {
      if (/task_|background_tasks_changed|stall|interrupt/i.test(msg)) taskLogs.push(`${rel()} ${String(msg).slice(0, 400)}`);
    },
    getDefaults: () => ({ model: MODEL, permissionMode: 'bypassPermissions' }),
    etaDir: false,
    external: false,
    usageSampling: false,
  });
  const m = engine.methods;
  let verdict = 'FAIL no result';
  try {
    const s = await m['sessions.create']({ cwd, model: MODEL, permissionMode: 'bypassPermissions' });
    const es = engine._internal.sessions.get(s.id);
    // Every SDK message's type and time: is the stream ever silent while a tool runs (stall rule)?
    const seen = [];
    const onMessage = es._onMessage.bind(es);
    es._onMessage = (msg) => {
      seen.push({ t: Date.now(), k: `${msg.type}${msg.subtype ? `/${msg.subtype}` : ''}${msg.parent_tool_use_id ? '(sub)' : ''}${msg.heartbeat ? '(hb)' : ''}` });
      return onMessage(msg);
    };
    const prompt = [
      'Automated Helm test. Do not ask any questions; sub-agents of your agent may not spawn more agents.',
      'Step 1: call the Agent tool ONCE with run_in_background: true, subagent_type "general-purpose", model "haiku",',
      'description "stall probe sleeper", prompt: "Run the Bash command: sleep 120 . Then reply with the word done."',
      'Step 2: right after launching it, run the Bash command: sleep 90 . Step 3: reply ok.',
    ].join(' ');
    await m['sessions.send']({ id: s.id, text: prompt });
    // Wait for the background agent to run with a known agentId and the main turn to still be active.
    let agent = null;
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      for (const it of es.items) {
        if (it.type === 'request' && it.status === 'pending') {
          try { await m['sessions.respond']({ id: s.id, requestId: it.requestId, response: { behavior: 'allow' } }); } catch {}
        }
      }
      agent = es.fleet.list().find((a) => a.status === 'running' && a.background && a.agentId);
      if (agent && es.turnActive) break;
      await sleep(250);
    }
    if (!agent) throw new Error('no background agent started within 120 s');
    console.log(`${rel()} agent running: ${agent.description} agentId=${agent.agentId}; session status=${es.s.status}`);
    await sleep(Number(process.env.STALL_LIVE_WAIT_MS) || 4000); // the agent is in its Bash sleep (STALL_LIVE_WAIT_MS=35000 to watch stream gaps first)
    const tInt = Date.now();
    const counts = {};
    let gap = 0, gapAt = null;
    for (let i = 0; i < seen.length; i++) {
      counts[seen[i].k] = (counts[seen[i].k] || 0) + 1;
      const g = (i ? seen[i].t - seen[i - 1].t : 0);
      if (g > gap) { gap = g; gapAt = seen[i].t; }
    }
    const quietMs = tInt - (seen.length ? seen[seen.length - 1].t : tInt);
    console.log(`${rel()} stream before interrupt: ${JSON.stringify(counts)}`);
    console.log(`${rel()} longest gap between SDK messages: ${(gap / 1000).toFixed(1)}s (ending +${gapAt ? ((gapAt - t0) / 1000).toFixed(1) : '?'}s); silent for ${(quietMs / 1000).toFixed(1)}s before the interrupt`);
    // Helm's Stop: a plain interrupt is refused while an agent runs (lane steer, 'agents_running' naming it);
    // The user's "Stop them too" confirm then sends stopAgents: true.
    console.log(`${rel()} sessions.interrupt (plain)`);
    let refused = null;
    try { await m['sessions.interrupt']({ id: s.id }); } catch (e) { refused = e; }
    console.log(`${rel()} plain interrupt: ${refused ? `refused ${refused.code} "${refused.message}"` : 'NOT refused'}; agent ${(es.fleet.list().find((x) => x.id === agent.id) || {}).status}`);
    console.log(`${rel()} sessions.interrupt stopAgents: true`);
    await m['sessions.interrupt']({ id: s.id, stopAgents: true });
    await sleep(30000);
    const a = es.fleet.list().find((x) => x.id === agent.id) || {};
    const pub = es.publicSession();
    const file = path.join(projectsDir(), slugFor(cwd), String(es.s.claudeSessionId), 'subagents', `agent-${agent.agentId}.jsonl`);
    let tail = '(no transcript)';
    let mtime = null;
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      const j = JSON.parse(lines[lines.length - 1]);
      const c = j.message && j.message.content;
      tail = `${j.type} ${j.timestamp} ${JSON.stringify(Array.isArray(c) ? c.map((x) => x.text || x.type) : c).slice(0, 160)}`;
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    console.log('--- task messages ---');
    for (const l of taskLogs) console.log(l);
    console.log('--- after interrupt + 30 s ---');
    console.log(`agent: status=${a.status} stopReason=${a.stopReason || '-'} endedAt=${a.endedAt ? new Date(a.endedAt).toISOString() : '-'} lastActivityAt=${a.lastActivityAt ? new Date(a.lastActivityAt).toISOString() : '-'}`);
    console.log(`agent transcript last line: ${tail}`);
    console.log(`agent transcript written after interrupt: ${mtime != null ? (mtime > tInt + 2000 ? 'YES (still running?)' : 'no') : '?'}`);
    console.log(`session: status=${pub.status} agentsRunning=${pub.agentsRunning}`);
    const refusedOk = !!refused && refused.code === 'agents_running';
    if (refusedOk && a.status === 'stopped' && a.stopReason === 'interrupted' && pub.agentsRunning === 0) verdict = 'PASS plain Stop refused (agents_running); Stop with stopAgents: agent stopped · interrupted, agentsRunning 0';
    else verdict = `FAIL refused=${refused ? refused.code : 'no'} agent status=${a.status} stopReason=${a.stopReason || '-'} agentsRunning=${pub.agentsRunning}`;
  } catch (e) {
    verdict = `FAIL ${e.message}`;
  } finally {
    try { await engine.shutdown(); } catch {}
  }
  console.log(`stall-live: ${verdict}`);
  if (KEEP) console.log(`(--keep: temp folder ${root}; the CLI transcript is under ${path.join(projectsDir(), slugFor(cwd))})`);
  else console.log(`(cleaned up: ${dropLiveTranscripts([cwd]).length} transcript folder(s) and ${root})`);
  process.exit(0);
}


// --resume: Resume on a real turn. The turn runs a foreground Bash sleep; the stream's clock is moved back 11 min
// (Helm cannot wait ten real minutes), stallTick must then publish stalledSince, and sessions.resumeStalled must
// interrupt the real CLI and send "Continue where you left off." (origin helm), which Claude then answers.
async function resumeMode() {
  const { stallTick } = require('../main/engine/stall');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-stall-resume-'));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const engine = createEngine({ userDataDir: path.join(root, 'ud'), emit: () => {}, log: () => {}, getDefaults: () => ({ model: MODEL, permissionMode: 'bypassPermissions' }), etaDir: false, external: false, usageSampling: false });
  const m = engine.methods;
  let verdict = 'FAIL no result';
  try {
    const s = await m['sessions.create']({ cwd, model: MODEL, permissionMode: 'bypassPermissions' });
    const es = engine._internal.sessions.get(s.id);
    await m['sessions.send']({ id: s.id, text: 'Automated Helm test, do not ask questions. Run this Bash command in the FOREGROUND (not run_in_background): sleep 40 . Then reply with the single word ok.' });
    const until = Date.now() + 90000;
    while (Date.now() < until && !(es.turnActive && es.items.some((it) => it.type === 'tool' && it.name === 'Bash' && it.status === 'running'))) await sleep(200);
    if (!es.turnActive) throw new Error('the turn ended before the Bash call ran');
    es.lastEventAt = Date.now() - 11 * 60_000;
    es.s.turnStartedAt = Date.now() - 12 * 60_000;
    stallTick(es);
    const stalled = es.publicSession().stalledSince;
    console.log(`stalledSince published: ${stalled ? new Date(stalled).toISOString() : 'NO'}`);
    const r = await m['sessions.resumeStalled']({ id: s.id });
    console.log(`resumeStalled: ${JSON.stringify(r)}`);
    const t1 = Date.now();
    while (Date.now() - t1 < 60000 && (es.turnActive || !es.items.some((it) => it.type === 'result' && it.ts > t1))) await sleep(250);
    const tail = es.items.slice(-8).map((it) => `${it.type}${it.subtype ? '/' + it.subtype : ''}${it.interrupted ? '(interrupted)' : ''}: ${String(it.text || it.name || '').replace(/\s+/g, ' ').slice(0, 70)}`);
    console.log(tail.join('\n'));
    const sentOk = es.items.some((it) => it.type === 'user' && it.text === 'Continue where you left off.');
    const replied = es.items.some((it) => it.type === 'assistant' && it.ts > t1);
    verdict = stalled && r.action === 'continued' && sentOk && replied ? `PASS resume ${r.restarted ? 'restarted the CLI' : 'interrupted the turn'}, sent the prompt, Claude answered` : `FAIL stalled=${!!stalled} action=${r.action} sent=${sentOk} replied=${replied}`;
  } catch (e) {
    verdict = `FAIL ${e.message}`;
  } finally {
    try { await engine.shutdown(); } catch {}
  }
  console.log(`stall-live --resume: ${verdict}`);
  if (!KEEP) console.log(`(cleaned up: ${dropLiveTranscripts([cwd]).length} transcript folder(s) and ${root})`);
  process.exit(0);
}

if (process.argv.includes('--resume')) resumeMode();
else main();
