// What does it cost to (re)start an idle session's claude.exe? Starts the real CLI through the Agent SDK the way
// the engine's probe does (settingSources user/project/local, so hooks, MCP servers, skills and mods load), waits for
// initializationResult() (no prompt is sent: no API call, no spend, nothing persisted), samples the CLI's memory,
// then closes it and confirms the PID is gone. One CLI at a time.
//   node tools/cli-coldstart.js [--runs=3] [--cwd=C:\Users\you\helm] [--hold=8]   (hold: seconds to sample memory)
// Owner: lane smooth.
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const RUNS = Number(arg('runs', 3));
const CWD = arg('cwd', path.join(__dirname, '..'));
const HOLD = Number(arg('hold', 8));
const CLAUDE = arg('claude', path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function childClaude() {
  const ps = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -eq 'claude.exe' } | ForEach-Object { $g = Get-Process -Id $_.ProcessId; '{0} {1} {2}' -f $_.ProcessId, $g.WorkingSet64, $g.PrivateMemorySize64 }`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
  if (!out) return null;
  const [pid, ws, priv] = out.split(/\s+/).map(Number);
  return { pid, ws: Math.round(ws / 1048576), priv: Math.round(priv / 1048576) };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

(async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { PushStream } = require('../main/engine/util');
  const res = [];
  for (let i = 0; i < RUNS; i++) {
    const input = new PushStream();
    const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm-bench/0.1.0' };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const t0 = Date.now();
    const q = sdk.query({ prompt: input, options: { cwd: CWD, settingSources: ['user', 'project', 'local'], persistSession: false, env, pathToClaudeCodeExecutable: CLAUDE } });
    let pid = null;
    try {
      const init = await Promise.race([q.initializationResult(), sleep(60000).then(() => { throw new Error('no init in 60 s'); })]);
      const tInit = Date.now() - t0;
      const atInit = childClaude(); pid = atInit && atInit.pid;
      let peak = atInit || { ws: 0, priv: 0 };
      for (let s = 0; s < HOLD; s++) { await sleep(1000); const c = childClaude(); if (c && c.ws > peak.ws) peak = c; }
      const settled = childClaude();
      res.push({ tInit, atInit, settled, peakWs: peak.ws, commands: (init.commands || []).length, models: (init.models || []).length });
      console.log(`run ${i + 1}: spawn -> initialized ${tInit} ms; claude.exe ws ${atInit && atInit.ws} MB priv ${atInit && atInit.priv} MB at init, ${settled && settled.ws}/${settled && settled.priv} MB after ${HOLD} s idle (peak ws ${peak.ws})`);
    } finally {
      input.close(); try { q.close(); } catch {}
      for (let k = 0; k < 40 && pid && alive(pid); k++) await sleep(100);
      if (pid && alive(pid)) { console.log(`  pid ${pid} still alive after close; ending it by PID`); try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    }
    await sleep(1500);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`cli-coldstart: median spawn->initialized ${med(res.map((r) => r.tInit))} ms over ${res.length} runs; idle claude.exe ~${med(res.map((r) => r.settled ? r.settled.ws : 0))} MB ws / ${med(res.map((r) => r.settled ? r.settled.priv : 0))} MB private`);
})().catch((e) => { console.error(e); process.exit(1); });
