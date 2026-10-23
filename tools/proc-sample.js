// Read-only process-tree sampler: CPU and memory of a process and its descendants over time.
// Reads OS counters only (Get-Process / Win32_Process); never attaches, never sends input, never kills.
// Safe to point at the user's running Helm (main PID) because it only reads counters.
//   node tools/proc-sample.js --pid=<root pid> [--secs=120] [--every=5]
// Prints one line per process at the end: role, avg CPU % of ONE core over the window, working set and
// private bytes (first -> last, MB), plus the tree totals. Roles come from the Chromium --type= switch.
// Owner: lane smooth.
const { execFileSync } = require('child_process');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const ROOT = Number(arg('pid', 0));
const SECS = Number(arg('secs', 120));
const EVERY = Number(arg('every', 5));
if (!ROOT) { console.error('usage: proc-sample.js --pid=<root> [--secs=120] [--every=5]'); process.exit(2); }

const PS = `$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$keep = @{}; $keep[${ROOT}] = $true
for ($i = 0; $i -lt 6; $i++) { foreach ($p in $all) { if ($keep.ContainsKey([int]$p.ParentProcessId)) { $keep[[int]$p.ProcessId] = $true } } }
$out = foreach ($p in $all) { if ($keep.ContainsKey([int]$p.ProcessId)) { $g = Get-Process -Id $p.ProcessId
  if ($g) { $t = 'main'; if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; if ($p.CommandLine -match '--utility-sub-type=([\\w\\.]+)') { $t = $t + ':' + $Matches[1] }
    [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = $p.Name; role = $t; cpu = $g.TotalProcessorTime.TotalSeconds; ws = $g.WorkingSet64; priv = $g.PrivateMemorySize64 } } } }
@($out) | ConvertTo-Json -Compress`;

function sample() {
  const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const list = JSON.parse(raw.trim() || '[]');
  return { at: Date.now(), procs: Array.isArray(list) ? list : [list] };
}

(async () => {
  const samples = [];
  const until = Date.now() + SECS * 1000;
  while (true) {
    samples.push(sample());
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, EVERY * 1000));
  }
  const first = samples[0], last = samples[samples.length - 1];
  const dt = (last.at - first.at) / 1000;
  const mb = (b) => Math.round(b / 1048576);
  const byPid = new Map(first.procs.map((p) => [p.pid, p]));
  let tot = { cpu: 0, ws0: 0, ws1: 0, pv0: 0, pv1: 0 };
  console.log(`window ${dt.toFixed(0)} s, ${samples.length} samples, root ${ROOT}`);
  for (const p of last.procs) {
    const f = byPid.get(p.pid) || p;
    const cpu = dt > 0 ? ((p.cpu - f.cpu) / dt) * 100 : 0;
    const peakWs = Math.max(...samples.map((s) => (s.procs.find((x) => x.pid === p.pid) || {}).ws || 0));
    tot.cpu += cpu; tot.ws0 += f.ws; tot.ws1 += p.ws; tot.pv0 += f.priv; tot.pv1 += p.priv;
    console.log(`${String(p.pid).padStart(6)} ${p.name.padEnd(12)} ${p.role.padEnd(34)} cpu ${cpu.toFixed(2).padStart(6)}%  ws ${mb(f.ws)}->${mb(p.ws)} MB (peak ${mb(peakWs)})  priv ${mb(f.priv)}->${mb(p.priv)} MB`);
  }
  console.log(`TOTAL cpu ${tot.cpu.toFixed(2)}% of one core  ws ${mb(tot.ws0)}->${mb(tot.ws1)} MB  priv ${mb(tot.pv0)}->${mb(tot.pv1)} MB`);
})().catch((e) => { console.error(e); process.exit(1); });
