require('./lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// Renderer performance + memory bench in mock mode (no Electron, no engine, no API spend).
// Starts its own tools/serve-ui.js on a random port, loads /?mock=1&nolive in the CPU-capped Playwright
// Chromium (same launcher as tools/shot.js), seeds a long session through window.__helmMock and measures:
//   boot    navigation -> first sidebar row painted
//   stream  a long markdown reply streamed into a session already holding --loaded items (40 ms chunks,
//           the engine's APPEND_FLUSH_MS): frame times, long tasks, CDP script/layout/style time, heap
//   switch  --switches selections alternating the long session with the others: per-switch time to paint
//   scroll  wheel-scroll the long transcript to the top (pages in older units): frame times, layout time
//   views   Deck (with --extra sessions), Usage panel, Agents panel: time to paint, nodes
//   memory  heap (after forced GC) and DOM nodes at each phase boundary
// Usage: node tools/perf-bench.js [--loaded=1200] [--chunks=400] [--switches=20] [--extra=40] [--only=stream,switch]
// Numbers are only comparable between runs on the same machine state (the browser is CPU-capped).
// Owner: lane smooth.
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright-core');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const LOADED = Number(arg('loaded', 1200));
const CHUNKS = Number(arg('chunks', 400));
const SWITCHES = Number(arg('switches', 20));
const EXTRA = Number(arg('extra', 40));
const ONLY = (arg('only', 'boot,stream,switch,scroll,views')).split(',');
const JSON_OUT = process.argv.includes('--json');
const TRACE = process.argv.includes('--trace');
// --trace: self-time by trace event on the renderer main thread during the stream
const PROFILE = process.argv.includes('--profile');   // --profile: JS self time by function during the stream

function summarizeProfile(p) {
  const byId = new Map(p.nodes.map((n) => [n.id, n])); const self = new Map();
  const dts = p.timeDeltas; const counts = new Map();
  p.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dts[i + 1] || 0)));
  for (const [id, us] of counts) { const n = byId.get(id); const cf = n.callFrame; const k = (cf.functionName || '(anon)') + ' ' + String(cf.url).replace(/^https?:\/\/[^/]+\//, '') + ':' + (cf.lineNumber + 1); self.set(k, (self.get(k) || 0) + us); }
  const parent = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n);
  const callers = new Map();   // forced layout / style reads: who called them
  for (const [id, us] of counts) {
    const n = byId.get(id); if (!/^(get (client|offset|scroll)\w+|getBoundingClientRect|getComputedStyle|scrollIntoView)$/.test(n.callFrame.functionName)) continue;
    let pp = parent.get(id); const chain = []; while (pp && chain.length < 3) { chain.push((pp.callFrame.functionName || '(anon)') + ' ' + String(pp.callFrame.url).replace(/^https?:\/\/[^/]+\//, '') + ':' + (pp.callFrame.lineNumber + 1)); pp = parent.get(pp.id); }
    const k = n.callFrame.functionName + ' <- ' + chain.join(' <- '); callers.set(k, (callers.get(k) || 0) + us);
  }
  const out = Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, us]) => [k, Math.round(us / 1000)]));
  out.forcedLayoutCallers = Object.fromEntries([...callers].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, us]) => [k, Math.round(us / 1000)]));
  return out;
}
async function startTrace(cdp) {
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink', 'cc'], excludedCategories: ['*'] } });
}
async function stopTrace(cdp) {
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let raw = '';
  for (;;) { const c = await cdp.send('IO.read', { handle: stream, size: 1 << 20 }); raw += c.base64Encoded ? Buffer.from(c.data, 'base64').toString() : c.data; if (c.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  const evs = (JSON.parse(raw).traceEvents || JSON.parse(raw));
  const names = new Map(); for (const e of evs) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = [...names].filter(([, n]) => n === 'CrRendererMain').map(([k]) => k);
  const self = new Map();
  for (const key of main) {
    const xs = evs.filter((e) => e.ph === 'X' && `${e.pid}:${e.tid}` === key && e.dur != null).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const stack = [];
    for (const e of xs) {
      while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
      if (stack.length) stack[stack.length - 1].kids += e.dur;
      const fr = { e, end: e.ts + e.dur, kids: 0 }; stack.push(fr);
      fr.done = () => {}; e._fr = fr;
    }
    for (const e of xs) { const s = Math.max(0, e.dur - e._fr.kids); self.set(e.name, (self.get(e.name) || 0) + s); }
  }
  const onMain = (e) => main.includes(`${e.pid}:${e.tid}`);
  const ult = evs.filter((e) => e.name === 'UpdateLayoutTree' && onMain(e) && e.args);
  const lay = evs.filter((e) => e.name === 'Layout' && onMain(e) && e.args && e.args.beginData);
  const top = Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, us]) => [n, Math.round(us / 1000)]));
  top.styleRecalcs = ult.length; top.styledElements = ult.reduce((a, e) => a + (Number(e.args.elementCount) || 0), 0);
  top.layouts = lay.length; top.dirtyObjects = lay.reduce((a, e) => a + (Number(e.args.beginData.dirtyObjects) || 0), 0);
  top.avgTotalObjects = lay.length ? Math.round(lay.reduce((a, e) => a + (Number(e.args.beginData.totalObjects) || 0), 0) / lay.length) : 0;
  return top;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = /127\.0\.0\.1:(\d+)/.exec(buf); if (m) resolve({ child, port: Number(m[1]) }); });
    child.on('exit', (c) => reject(new Error('serve-ui exited ' + c)));
    setTimeout(() => reject(new Error('serve-ui did not start')), 10000);
  });
}

// ---- in-page helpers (stringified into the page) ----
const PAGE_LIB = `
window.__bench = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const mock = () => window.__helmMock;
  function code(i, lines) { let s = ''; for (let k = 0; k < lines; k++) s += (k + 1) + '\\tconst v' + i + '_' + k + ' = require("./mod' + (k % 7) + '").call(' + k + ', "' + 'x'.repeat(k % 30) + '");\\n'; return s; }
  function mdReply(i) {
    return '## Step ' + i + ': what changed\\n\\nI traced **route ' + i + '** through the middleware. The order in \`server.js\` mounts auth before the static handler, so:\\n\\n'
      + '- \`/login\` is wrapped by \`requireAuth\` (line ' + (i % 90) + ')\\n- the redirect drops \`?next=\`\\n- tests: ' + (i * 3) + ' pass, 0 fail\\n\\n'
      + '\`\`\`js\\n' + code(i, 8) + '\`\`\`\\n\\nNext I will patch \`account.js:' + (40 + i % 50) + '\` and re-run the suite. See [the docs](https://example.com/' + i + ').';
  }
  function turn(i) {
    const t = Date.now() - (LOADED_N - i * 7) * 60000;
    return [
      { id: 'u' + i, type: 'user', ts: t, text: 'Turn ' + i + ': keep going on the redirect fix and run the tests for module ' + i + '.', attachments: [] },
      { id: 'th' + i, type: 'thinking', ts: t + 1, streaming: false, text: 'Thinking about turn ' + i + '. '.repeat(1) + 'The middleware order matters; check the router mount points before editing anything in module ' + i + '.' },
      { id: 'tr' + i, type: 'tool', ts: t + 2, toolUseId: 'toolu_r' + i, name: 'Read', status: 'done', startedAt: t + 2, endedAt: t + 300, input: { file_path: 'C:\\\\Users\\\\you\\\\code\\\\storefront\\\\src\\\\mod' + i + '.js', offset: 1, limit: 40 }, result: code(i, 40) },
      { id: 'tb' + i, type: 'tool', ts: t + 3, toolUseId: 'toolu_b' + i, name: 'Bash', status: 'done', startedAt: t + 3, endedAt: t + 4000, input: { command: 'npm test -- --grep mod' + i, description: 'Run the tests for module ' + i }, result: Array.from({ length: 20 }, (_, k) => '  ok ' + (k + 1) + ' mod' + i + ' case ' + k).join('\\n') + '\\n# pass 20\\n# fail 0' },
      { id: 'tg' + i, type: 'tool', ts: t + 4, toolUseId: 'toolu_g' + i, name: 'Grep', status: 'done', startedAt: t + 4, endedAt: t + 500, input: { pattern: 'redirect' + i, path: 'src', output_mode: 'content' }, result: 'src/a.js:' + i + ': res.redirect("/login")\\nsrc/b.js:' + (i + 1) + ': res.redirect(next)' },
      { id: 'a' + i, type: 'assistant', ts: t + 5, streaming: false, model: 'claude-opus-5-5', text: mdReply(i) },
      { id: 'r' + i, type: 'result', ts: t + 6, subtype: 'success', durationMs: 40000, costUsd: 0.12, numTurns: 4, isError: false, usage: { input: 1000, output: 800, cacheRead: 90000, cacheWrite: 3000 } },
    ];
  }
  let LOADED_N = 0;
  function seed(n, extra) {
    LOADED_N = n;
    const S = mock().state;
    const base = S.sessions[0];
    const items = []; for (let i = 0; items.length < n; i++) items.push(...turn(i));
    items.length = n;
    const long = { ...base, id: 's_long', claudeSessionId: 'bench-long', title: 'Bench: long session (' + n + ' items)', status: 'idle', activity: null, turnStartedAt: null, pinned: false, unread: 0, queued: 0, updatedAt: Date.now() + 1000, eta: null, pendingRequest: null };
    S.sessions.push(long); S.items.s_long = items;
    mock().emit('session.created', long);
    for (let k = 0; k < extra; k++) {
      const s = { ...base, id: 's_x' + k, claudeSessionId: 'bench-x' + k, title: 'Extra session ' + k, status: k % 5 === 0 ? 'working' : 'idle', activity: k % 5 === 0 ? 'Running npm test' : null, pinned: false, unread: 0, queued: 0, updatedAt: Date.now() - k * 60000, eta: null, pendingRequest: null };
      S.sessions.push(s); S.items[s.id] = turn(k).concat(turn(k + 1000));
      mock().emit('session.created', s);
    }
  }
  async function select(id) { const m = await import('/lib/store.js'); const t0 = performance.now(); m.selectSession(id); await paint(); return performance.now() - t0; }
  async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); } return null; }
  // frame + long-task recorder
  function recorder() {
    const frames = []; const longs = []; let on = true, last = performance.now();
    const loop = (t) => { if (!on) return; frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });
    let po = null; try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); }); po.observe({ type: 'longtask', buffered: false }); } catch {}
    return () => { on = false; po && po.disconnect(); const s = [...frames].sort((a, b) => a - b); const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
      return { frames: frames.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +(s[s.length - 1] || 0).toFixed(1), over33: frames.filter((f) => f > 33.4).length, over50: frames.filter((f) => f > 50).length,
        longTasks: longs.length, longTotal: Math.round(longs.reduce((a, b) => a + b, 0)), longMax: Math.round(Math.max(0, ...longs)) }; };
  }
  async function stream(sid, chunks, every) {
    const S = mock().state; const sess = S.sessions.find((s) => s.id === sid);
    const id = 'bench_stream_' + Date.now();
    mock().emit('session.updated', { ...sess, status: 'working', activity: 'Writing', turnStartedAt: Date.now() });
    mock().emit('session.item', { sessionId: sid, item: { id, type: 'assistant', ts: Date.now(), streaming: true, model: 'claude-opus-5-5', text: '' } });
    await paint();
    // a reply ~ chunks * 45 chars: paragraphs, lists and a code block every ~60 chunks
    const parts = []; let i = 0;
    while (parts.length < chunks) {
      const md = mdReply(5000 + i++) + '\\n\\n'; for (let k = 0; k < md.length && parts.length < chunks; k += 45) parts.push(md.slice(k, k + 45));
    }
    const stop = recorder(); const cost = []; let behind = 0;
    const tStart = performance.now();
    for (let k = 0; k < parts.length; k++) {
      const due = tStart + k * every; const now = performance.now(); if (now < due) await sleep(due - now); else behind++;
      const t0 = performance.now();
      mock().emit('session.itemUpdate', { sessionId: sid, itemId: id, patch: {}, appendText: parts[k] });
      await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
      cost.push(performance.now() - t0);
    }
    mock().emit('session.itemUpdate', { sessionId: sid, itemId: id, patch: { streaming: false } });
    mock().emit('session.updated', { ...sess, status: 'idle', activity: null, turnStartedAt: null });
    await paint(); await paint();
    const r = stop(); const c = [...cost].sort((a, b) => a - b);
    const third = Math.floor(c.length / 3);
    r.updates = cost.length; r.wall = Math.round(performance.now() - tStart); r.lateUpdates = behind;
    r.updMed = +c[Math.floor(c.length / 2)].toFixed(2); r.updP95 = +c[Math.floor(c.length * 0.95)].toFixed(2);
    r.updFirstThird = +(cost.slice(0, third).reduce((a, b) => a + b, 0) / third).toFixed(2);
    r.updLastThird = +(cost.slice(-third).reduce((a, b) => a + b, 0) / third).toFixed(2);
    r.replyChars = parts.join('').length;
    return r;
  }
  async function scrollTop() {
    const el = document.querySelector('.chat-scroll'); if (!el) return null;
    const stop = recorder(); const t0 = performance.now(); let steps = 0;
    const nodes0 = document.getElementsByTagName('*').length;
    while (steps < 400) { el.scrollTop = Math.max(0, el.scrollTop - 400); el.dispatchEvent(new Event('scroll')); steps++; await new Promise((r) => requestAnimationFrame(r)); if (el.scrollTop === 0) { await sleep(150); if (el.scrollTop === 0) break; } }
    const r = stop(); r.steps = steps; r.wall = Math.round(performance.now() - t0); r.nodesBefore = nodes0; r.nodesAfter = document.getElementsByTagName('*').length; r.units = el.querySelectorAll('[data-item-id]').length;
    return r;
  }
  const nodes = () => document.getElementsByTagName('*').length;
  return { seed, select, waitFor, stream, scrollTop, paint, sleep, nodes, recorder };
})(); true`;

async function main() {
  const { child, port } = await startServer();
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const out = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // --patch=<json>: [{ "path": "/shell/header.js", "find": "...", "replace": "..." }] applied to the SERVED copy only,
    // so a change proposed for another lane's file can be measured without editing that file.
    const patchFile = arg('patch', '');
    if (patchFile) {
      const patches = JSON.parse(require('fs').readFileSync(patchFile, 'utf8'));
      for (const p of patches) {
        await page.route(`**${p.path}`, async (route) => {
          const res = await route.fetch(); let body = await res.text();
          if (p.file) body = require('fs').readFileSync(p.file, 'utf8');   // whole-file stand-in (e.g. the pre-change version)
          else if (!body.includes(p.find)) console.error('PATCH NOT APPLIED (find text missing):', p.path);
          else body = body.split(p.find).join(p.replace);
          await route.fulfill({ response: res, body });
        });
      }
      console.log('patched (served copy only):', patches.map((p) => p.path).join(', '));
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); const m = await metrics(); return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, docNodes: await page.evaluate('document.getElementsByTagName("*").length'), listeners: m.JSEventListeners }; };
    const delta = (a, b) => ({ scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000), layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000), styleMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000), taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000), layouts: b.LayoutCount - a.LayoutCount, styles: b.RecalcStyleCount - a.RecalcStyleCount });
    const ev = (js) => page.evaluate(js);

    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/?mock=1&nolive`, { waitUntil: 'domcontentloaded' });
    // first session painted: a Home card (Helm opens on Home since lane home) or a sidebar row
    await page.waitForSelector('.sidebar-scroll .srow, .home .hcard[data-sid]', { timeout: 20000 }).catch((e) => { console.error('PAGE ERRORS:', errors.join('\n')); throw e; });
    out.boot = { wallMs: Date.now() - t0, pageMs: Math.round(await ev('performance.now()')) };
    await ev("import('/shell/state.js').then((s) => s.go('session'))");   // the rest measures the session layout, as before Home
    await page.waitForSelector('.sidebar-scroll .srow', { timeout: 20000 });
    await page.waitForTimeout(800);
    await ev(PAGE_LIB);
    out.mem0 = await heap();
    await ev(`__bench.seed(${LOADED}, ${EXTRA})`);
    await page.waitForTimeout(300);
    out.selectLongFirst = Math.round(await ev(`__bench.select('s_long')`));
    await ev(`__bench.waitFor(() => document.querySelector('.chat-scroll [data-item-id="r${Math.floor((LOADED - 1) / 7)}"], .chat-scroll [data-item-id]'))`);
    await page.waitForTimeout(800);
    out.memLongOpen = await heap();

    if (ONLY.includes('stream')) {
      const m0 = await metrics();
      if (TRACE) await startTrace(cdp);
      if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      out.stream = await ev(`__bench.stream('s_long', ${CHUNKS}, 40)`);
      if (TRACE) out.streamTrace = await stopTrace(cdp);
      if (PROFILE) out.streamProfile = summarizeProfile((await cdp.send('Profiler.stop')).profile);
      Object.assign(out.stream, delta(m0, await metrics()));
      await page.waitForTimeout(500);
      out.memAfterStream = await heap();
    }
    if (ONLY.includes('bgstream')) {
      // another (loaded) session streams while the long one is on screen: what does the visible pane pay?
      await ev(`__bench.select('s_storefront')`); await page.waitForTimeout(400);
      await ev(`__bench.select('s_long')`); await page.waitForTimeout(600);
      const m0 = await metrics();
      out.bgstream = await ev(`__bench.stream('s_storefront', ${Math.round(CHUNKS / 2)}, 40)`);
      Object.assign(out.bgstream, delta(m0, await metrics()));
    }
    if (ONLY.includes('switch')) {
      const ids = await ev(`window.__helmMock.state.sessions.filter((s) => !s.archived).map((s) => s.id).slice(0, 6)`);
      const others = ids.filter((x) => x !== 's_long');
      for (const id of others) { await ev(`__bench.select(${JSON.stringify(id)})`); await page.waitForTimeout(150); }   // first visits (history fetch)
      await ev(`__bench.select('s_long')`); await page.waitForTimeout(300);
      const m0 = await metrics(); const times = [];
      for (let k = 0; k < SWITCHES; k++) {
        const id = k % 2 ? 's_long' : others[(k / 2) % others.length];
        times.push(await ev(`__bench.select(${JSON.stringify(id)})`));
        await page.waitForTimeout(120);
      }
      const intoLong = times.filter((_, k) => k % 2), outOf = times.filter((_, k) => !(k % 2));
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.floor(s.length / 2)] || 0).toFixed(1); };
      out.switch = { n: times.length, intoLongMed: med(intoLong), intoLongMax: +Math.max(...intoLong).toFixed(1), toOtherMed: med(outOf), toOtherMax: +Math.max(...outOf).toFixed(1), ...delta(m0, await metrics()) };
      out.memAfterSwitch = await heap();
    }
    if (ONLY.includes('scroll')) {
      await ev(`__bench.select('s_long')`); await page.waitForTimeout(600);
      const m0 = await metrics();
      out.scroll = await ev(`__bench.scrollTop()`);
      Object.assign(out.scroll, delta(m0, await metrics()));
      out.memAfterScroll = await heap();
    }
    if (ONLY.includes('views')) {
      const time = async (js, sel) => { const m0 = await metrics(); const t = await ev(`(async () => { const t0 = performance.now(); await (${js}); await __bench.waitFor(() => document.querySelector(${JSON.stringify(sel)}), 8000); await __bench.paint(); return Math.round(performance.now() - t0); })()`); const d = delta(m0, await metrics()); return { ms: t, ...d, nodes: await ev('__bench.nodes()') }; };
      out.deck = await time(`import('/shell/state.js').then((m) => m.go('deck'))`, '.deck-tile, .dk-tile, [class*="deck"] [data-sid]');
      await page.waitForTimeout(400);
      out.deckBack = await time(`import('/shell/state.js').then((m) => m.go('session'))`, '.chat-scroll');
      out.usage = await time(`import('/panels/state.js').then((m) => m.showPanel('usage'))`, '.insp-body, .usage, [class*="usage"]');
      await page.waitForTimeout(400);
      out.fleet = await time(`import('/panels/state.js').then((m) => m.showPanel('fleet'))`, '.insp-body, [class*="fleet"]');
      out.memEnd = await heap();
    }
    if (ONLY.includes('evict')) {
      // open many sessions one after another, then come back to the long one: how many transcripts stay in memory,
      // and does the evicted long session come back whole?
      const ids = await ev(`window.__helmMock.state.sessions.filter((s) => s.id.startsWith('s_x')).map((s) => s.id).slice(0, 12)`);
      await ev(`__bench.select('s_long')`); await page.waitForTimeout(500);
      const unitsBefore = await ev(`document.querySelectorAll('.chat-scroll [data-item-id]').length`);
      for (const id of ids) { await ev(`__bench.select(${JSON.stringify(id)})`); await page.waitForTimeout(200); }
      const kept = await ev(`import('/lib/store.js').then((m) => Object.keys(m.itemsBySession.value).length)`);
      const h = await heap();
      const back = await ev(`(async () => { const t = await __bench.select('s_long'); await __bench.waitFor(() => document.querySelectorAll('.chat-scroll [data-item-id]').length > 20, 5000); await __bench.paint(); return Math.round(t); })()`);
      await page.waitForTimeout(400);
      const unitsAfter = await ev(`document.querySelectorAll('.chat-scroll [data-item-id]').length`);
      out.evict = { opened: ids.length + 1, keptTranscripts: kept, heapMB: h.heapMB, backToLongMs: back, unitsBefore, unitsAfter };
    }
    if (ONLY.includes('leak')) {
      // repeat each view and watch live Node objects after a forced GC (a leak shows as steady growth)
      const seq = [];
      for (let k = 0; k < 4; k++) {
        await ev(`import('/shell/state.js').then((m) => m.go('deck'))`); await page.waitForTimeout(700);
        await ev(`import('/shell/state.js').then((m) => m.go('session'))`); await page.waitForTimeout(500);
        const a = await heap(); seq.push(`deck${k}:${a.nodes}/${a.heapMB}`);
      }
      for (let k = 0; k < 4; k++) {
        await ev(`import('/panels/state.js').then((m) => m.showPanel('usage'))`); await page.waitForTimeout(700);
        await ev(`import('/panels/state.js').then((m) => m.showPanel('fleet'))`); await page.waitForTimeout(500);
        const a = await heap(); seq.push(`usage${k}:${a.nodes}/${a.heapMB}`);
      }
      for (let k = 0; k < 4; k++) {
        for (const id of ['s_storefront', 's_long']) { await ev(`__bench.select(${JSON.stringify(id)})`); await page.waitForTimeout(300); }
        const a = await heap(); seq.push(`switch${k}:${a.nodes}/${a.heapMB}`);
      }
      out.leak = { seq: seq.join(' '), docNodes: await ev('__bench.nodes()') };
    }
    out.errors = errors.slice(0, 5);
  } finally {
    await browser.close();
    child.kill();
  }
  if (JSON_OUT) { console.log(JSON.stringify(out)); return; }
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(16), typeof v === 'object' ? JSON.stringify(v) : v);
}

main().catch((e) => { console.error(e); process.exit(1); });
