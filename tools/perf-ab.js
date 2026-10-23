// A/B wrapper around tools/perf-bench.js: alternates two arms run after run (so machine load hits both alike) and
// prints the median of each metric per arm. An arm is a list of extra perf-bench flags, e.g. a --patch that serves
// the pre-change version of a file:
//   node tools/perf-ab.js --runs=3 --a="--patch=.shots/patch-md-orig.json" --b="" --bench="--only=stream"
// Owner: lane smooth.
const { execFileSync } = require('child_process');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const RUNS = Number(arg('runs', 3));
const split = (s) => (s || '').split(' ').filter(Boolean);
const arms = { A: split(arg('a', '')), B: split(arg('b', '')) };
const bench = split(arg('bench', ''));

const runs = { A: [], B: [] };
for (let i = 0; i < RUNS; i++) {
  for (const k of i % 2 ? ['B', 'A'] : ['A', 'B']) {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'perf-bench.js'), '--json', ...bench, ...arms[k]], { encoding: 'utf8', timeout: 900000, maxBuffer: 1 << 24 });
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    runs[k].push(JSON.parse(line));
    process.stderr.write(`run ${i + 1} ${k} done\n`);
  }
}
const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const sections = new Set([...runs.A, ...runs.B].flatMap((r) => Object.keys(r)));
for (const sec of sections) {
  const keys = new Set([...runs.A, ...runs.B].flatMap((r) => (r[sec] && typeof r[sec] === 'object' ? Object.keys(r[sec]) : [])));
  const rows = [];
  for (const key of keys) {
    const a = med(runs.A.map((r) => r[sec] && r[sec][key])), b = med(runs.B.map((r) => r[sec] && r[sec][key]));
    if (a == null && b == null) continue;
    rows.push(`${key}=${a}->${b}`);
  }
  if (rows.length) console.log(`${sec.padEnd(15)} ${rows.join('  ')}`);
}
console.log(`perf-ab: ${RUNS} runs per arm, A=[${arms.A.join(' ')}] B=[${arms.B.join(' ')}] (A->B medians)`);
