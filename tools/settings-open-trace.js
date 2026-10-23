// Settings open trace (lane helm-settings-freeze, 2026-10-17). Opens Settings in a hidden `--test` Helm (Electron, the
// off-screen never-activated test window, Below Normal, a throwaway profile + CLAUDE_CONFIG_DIR) and measures, per open:
//   main   the longest main-process event-loop gap (5 ms ticker in main) and every gap over 50 ms. Helm's main thread
//          also answers the window: a block of ~5 s is Windows' "not responding".
//   rend   renderer long tasks (PerformanceObserver longtask) and the time until .view-settings is painted
//   prof   a main-process CPU profile around each open: the frames with the most self time in the longest gap
// The memory folder is seeded with --notes fresh notes (default 160; fresh files are cold, like notes Claude just
// wrote: a virus scanner checks each on its first open), or with --copy-real a COPY of the real ~/.claude memory notes,
// CLAUDE.md and the Helm settings.json + backgrounds (deleted afterwards). Prints ms and code locations only.
// Usage: node tools/settings-open-trace.js [--ui-root=<another helm checkout>] [--label=x] [--opens=3] [--settle=35000]
//          [--notes=160 | --copy-real] [--max-main-ms=100] [--json=<file>]
//   Exit 1 when any open held the main thread longer than --max-main-ms. CPU-heavy: run it through the heavy-test queue.
try { require('./lowcpu-optional'); } catch { /* not on this machine */ }
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const ROOT = path.resolve(arg('ui-root', path.join(__dirname, '..')));
const LABEL = arg('label', 'run');
const OPENS = Number(arg('opens', '3')) || 3;
const SETTLE = Number(arg('settle', '35000')) || 0;   // past main/engine's 30 s SDK warm-up
const NOTES = Number(arg('notes', '160')) || 0;
const COPY_REAL = process.argv.includes('--copy-real');
const MAX_MAIN = Number(arg('max-main-ms', '100')) || 100;
const JSON_OUT = arg('json');
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

function copyTree(src, dst, filter) {
  let st; try { st = fs.statSync(src); } catch { return; }
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n), filter); }
  else if (st.isFile() && (!filter || filter(src))) fs.copyFileSync(src, dst);
}

// --notes: fresh notes in the home folder's memory (half indexed in MEMORY.md) and a few small project folders
function seedSynthetic(profile, cfg, n) {
  const slug = os.homedir().replace(/[^a-zA-Z0-9]/g, '-');
  const mem = path.join(cfg, 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), '# Global\n\nSynthetic instructions for the Settings open trace.\n');
  const index = ['# Memory', ''];
  for (let i = 0; i < n; i++) {
    const f = `note_${String(i).padStart(3, '0')}.md`;
    fs.writeFileSync(path.join(mem, f), `---\nname: Note ${i}\ndescription: "What note ${i} is about"\nmetadata:\n  type: ${i % 2 ? 'project' : 'feedback'}\n---\n\n${'Body text. '.repeat(40)}\n`);
    if (i % 2 === 0) index.push(`- [Note ${i}](${f}) — hook ${i}`);
  }
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), index.join('\n') + '\n');
  for (let p = 0; p < 12; p++) {
    const pm = path.join(cfg, 'projects', `C--proj-${p}`, 'memory');
    fs.mkdirSync(pm, { recursive: true });
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(pm, `n${i}.md`), `---\nname: P${p} note ${i}\n---\nbody\n`);
  }
  fs.mkdirSync(profile, { recursive: true });
}

function seed(profile, cfg) {
  if (!COPY_REAL) return seedSynthetic(profile, cfg, NOTES);
  const home = os.homedir();
  const realCfg = path.join(home, '.claude');
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  try { fs.copyFileSync(path.join(realCfg, 'CLAUDE.md'), path.join(cfg, 'CLAUDE.md')); } catch {}
  for (const slug of fs.readdirSync(path.join(realCfg, 'projects'))) {
    const mem = path.join(realCfg, 'projects', slug, 'memory');
    if (fs.existsSync(mem)) copyTree(mem, path.join(cfg, 'projects', slug, 'memory'), (f) => /\.md$/i.test(f));
    else fs.mkdirSync(path.join(cfg, 'projects', slug), { recursive: true });
  }
  const realProf = path.join(process.env.APPDATA, 'Helm');
  fs.mkdirSync(profile, { recursive: true });
  try {
    const s = JSON.parse(fs.readFileSync(path.join(realProf, 'settings.json'), 'utf8'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(s));
  } catch (e) { console.log('settings copy failed:', e.message); }
  copyTree(path.join(realProf, 'backgrounds'), path.join(profile, 'backgrounds'));
}

// self time per frame inside [t0, t1] (µs, profile clock) -> top n "fn file:line ms"
function hotFrames(prof, t0, t1, n = 8) {
  const byId = new Map(prof.nodes.map((x) => [x.id, x]));
  const self = new Map();
  let t = prof.startTime;
  for (let i = 0; i < prof.samples.length; i++) {
    t += prof.timeDeltas[i];
    if (t < t0 || t > t1) continue;
    const node = byId.get(prof.samples[i]);
    const dt = (prof.timeDeltas[i + 1] || 0) / 1000;
    const cf = node.callFrame;
    const where = `${cf.functionName || '(anon)'} ${cf.url ? cf.url.replace(/^.*[\\/](main|ui|node_modules)[\\/]/, '$1/') : ''}:${cf.lineNumber + 1}`;
    self.set(where, (self.get(where) || 0) + dt);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, ms]) => `${Math.round(ms)} ms ${w}`);
}
// the Helm (main/) frames on the stacks sampled inside [t0, t1], by sample time
function helmStacks(prof, t0, t1, n = 8) {
  const byId = new Map(prof.nodes.map((x) => [x.id, x]));
  const parent = new Map();
  for (const x of prof.nodes) for (const c of x.children || []) parent.set(c, x.id);
  const hits = new Map();
  let t = prof.startTime;
  for (let i = 0; i < prof.samples.length; i++) {
    t += prof.timeDeltas[i];
    if (t < t0 || t > t1) continue;
    const dt = (prof.timeDeltas[i + 1] || 0) / 1000;
    const seen = new Set();
    for (let id = prof.samples[i]; id != null; id = parent.get(id)) {
      const cf = byId.get(id).callFrame;
      if (!/[\\/](main|main\.js)/.test(cf.url || '') || /node_modules/.test(cf.url)) continue;
      const where = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*[\\/](main[\\/]|main\.js)/, (m, a) => a)}:${cf.lineNumber + 1}`;
      if (seen.has(where)) continue;
      seen.add(where);
      hits.set(where, (hits.get(where) || 0) + dt);
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, ms]) => `${Math.round(ms)} ms ${w}`);
}

(async () => {
  const tag = 'sf' + process.pid;
  const profileName = tag;
  const userData = path.join(os.tmpdir(), 'helm-test-' + profileName);
  const cfg = path.join(os.tmpdir(), 'helm-sf-cfg-' + process.pid);
  seed(userData, cfg);
  const EXE = require(path.join(ROOT, 'node_modules', 'electron'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HELM_|^LOOK_SYNC|^CLAUDE_CODE|^CLAUDECODE/.test(k)));
  Object.assign(env, { CLAUDE_CONFIG_DIR: cfg, HELM_CLAUDE_DIR: cfg, HELM_CLAUDE_PROJECTS: path.join(cfg, 'projects') });
  const app = await _electron.launch({ executablePath: EXE, args: [ROOT, '--test', '--profile=' + profileName, '--port=' + (await freePort())], cwd: ROOT, env, timeout: 90000 });
  const pid = app.process().pid;
  const report = { label: LABEL, root: path.basename(ROOT), opens: [] };
  try {
    try { execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = 'BelowNormal' }`], { stdio: 'ignore', windowsHide: true }); } catch {}
    let page = null;
    for (const end = Date.now() + 60000; !page && Date.now() < end;) {
      page = app.windows().find((p) => !/quick/i.test(p.url())) || null;
      if (!page) await app.waitForEvent('window', { timeout: 5000 }).catch(() => {});
    }
    if (!page) throw new Error('no Helm window in 60 s');
    await page.waitForFunction(() => !!document.querySelector('.view, .home, main'), null, { timeout: 60000 }).catch(() => {});
    // main: gap ticker + CPU profiler (inspector session inside the main process)
    await app.evaluate(async () => {
      const req = process.mainModule.require;
      const { performance } = req('perf_hooks');
      const g = global.__sf = { last: performance.now(), gaps: [], max: 0, since: performance.now() };
      g.timer = setInterval(() => { const n = performance.now(); const d = n - g.last; if (d > 50) g.gaps.push([Math.round(g.last - g.since), Math.round(d)]); if (d > g.max) g.max = d; g.last = n; }, 5);
      const inspector = req('inspector');
      g.session = new inspector.Session();
      g.session.connect();
      g.post = (m, p) => new Promise((res, rej) => g.session.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
      await g.post('Profiler.enable');
      await g.post('Profiler.setSamplingInterval', { interval: 500 });
      return true;
    });
    // idle after boot (the SDK warm-up lands here): the gaps over 50 ms while nothing is clicked
    await sleep(SETTLE);
    report.idleAfterBoot = await app.evaluate(() => ({ settleMs: Math.round(process.mainModule.require('perf_hooks').performance.now() - global.__sf.since), max: Math.round(global.__sf.max), gaps: global.__sf.gaps.slice(0, 40) })).catch((e) => ({ error: e.message }));
    console.log(`${LABEL} idle after boot: max gap ${report.idleAfterBoot.max} ms; gaps>50 ${JSON.stringify(report.idleAfterBoot.gaps)}`);
    await page.evaluate(() => {
      window.__lt = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: false }); } catch {}
    });
    for (let i = 0; i < OPENS; i++) {
      await app.evaluate(async () => { const g = global.__sf; const { performance } = process.mainModule.require('perf_hooks'); g.gaps = []; g.max = 0; g.since = performance.now(); g.last = performance.now(); await g.post('Profiler.start'); g.profT0 = performance.now(); return true; });
      const r = await page.evaluate(async () => {
        window.__lt = [];
        const st = await import('/shell/state.js');
        const t0 = performance.now();
        st.go('settings');
        for (let k = 0; k < 400 && !document.querySelector('.view-settings'); k++) await new Promise((x) => setTimeout(x, 5));
        await new Promise((x) => requestAnimationFrame(() => requestAnimationFrame(x)));
        return { paintMs: Math.round(performance.now() - t0), t0: Math.round(t0) };
      });
      await sleep(12000); // every row's RPCs answer (phone.status's PowerShell firewall check takes ~3 s)
      const m = await app.evaluate(async () => {
        const g = global.__sf;
        const { profile } = await g.post('Profiler.stop');
        return { max: Math.round(g.max), gaps: g.gaps.slice(0, 40), profile: JSON.stringify(profile) };
      });
      const lt = await page.evaluate((t0) => window.__lt.map(([s, d]) => [s - t0, d]), r.t0);
      const prof = JSON.parse(m.profile);
      // the longest gap in profile time: the ticker's [startMs, durMs] are relative to the open (g.since ~ profile start)
      const big = m.gaps.slice().sort((a, b) => b[1] - a[1])[0];
      let hot = [], helm = [];
      if (big) {
        const t0 = prof.startTime + (big[0]) * 1000;
        const t1 = t0 + big[1] * 1000 + 20000;
        hot = hotFrames(prof, t0, t1);
        helm = helmStacks(prof, t0, t1);
      }
      const all = helmStacks(prof, prof.startTime, prof.endTime, 10);
      const o = { open: i + 1, paintMs: r.paintMs, mainMaxGapMs: m.max, mainGapsOver50: m.gaps, rendererLongTasks: lt, longestGapHotFrames: hot, longestGapHelmFrames: helm, helmFramesWholeWindow: all };
      report.opens.push(o);
      console.log(`${LABEL} open ${i + 1}: paint ${r.paintMs} ms; main max gap ${m.max} ms; gaps>50 ${JSON.stringify(m.gaps)}; renderer long tasks ${JSON.stringify(lt)}`);
      if (hot.length) console.log(`  hot in longest gap: ${hot.join(' | ')}`);
      if (helm.length) console.log(`  helm frames in longest gap: ${helm.join(' | ')}`);
      console.log(`  helm frames over the whole open: ${all.join(' | ')}`);
      await page.evaluate(async () => { const st = await import('/shell/state.js'); st.go('home'); });
      await sleep(3000);
    }
    const worst = Math.max(...report.opens.map((o) => o.mainMaxGapMs));
    const worstLt = Math.max(0, ...report.opens.flatMap((o) => o.rendererLongTasks.map((x) => x[1])));
    report.summary = { worstMainGapMs: worst, worstRendererLongTaskMs: worstLt, maxMainMs: MAX_MAIN, ok: worst <= MAX_MAIN };
    if (worst > MAX_MAIN) process.exitCode = 1;
    console.log(`freeze-trace ${LABEL}: ${OPENS} opens, worst main gap ${worst} ms, worst renderer long task ${worstLt} ms`);
  } catch (e) {
    console.log(`freeze-trace ${LABEL}: FAILED ${e.message}`);
    report.error = e.message;
    process.exitCode = 1;
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(8000)]);
    try { process.kill(pid, 0); execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    await sleep(800);
    for (const d of [userData, cfg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  }
})();
