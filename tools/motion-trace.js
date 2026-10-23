// Motion trace (lane helm-unison, 2026-10-16; spec next-week/motion-unison.md). Opens and closes Helm's pop-in
// surfaces on the mock backend (tools/serve-ui.js) in headless Chromium and, for each, reports the frames over
// 20 ms (requestAnimationFrame gaps), the longest frame, and the layouts / style recalcs during the animation
// (CDP Performance.getMetrics). Then checks interrupted motion (a close mid-entry, rapid toggles) leaves nothing
// behind, measures idle main-thread time, and with --strips saves 6-frame strips (animations paused and seeked,
// so the frames are exact) of the entries and exits.
//
// Usage: node tools/motion-trace.js [--ui=<another ui/ dir>] [--label=after] [--strips=<dir>] [--json=<file>] [--electron]
//          [--repeat=N] [--settle=ms]
//   Prints one line per surface, then `motion-trace: N surfaces, F frames over 20 ms, interrupted ok|FAIL, idle X ms/s`.
//   Exit 1 when a frame went over 20 ms or an interrupted check failed.
//   --electron (lane helm-motion2): the same surfaces in a hidden `--test` Helm (Electron, GPU compositing, its own
//   throwaway profile and CLAUDE_CONFIG_DIR, the off-screen never-activated test window; main.js OFFSCREEN_TEST_WINDOW)
//   with its window pointed at the same mock UI, so the numbers are the real renderer's. It prints the GPU feature
//   status and the idle rAF cadence first (a throttled or software window would show there), and closes the instance
//   (by its own PID only) when done.
try { require('./lowcpu-optional'); } catch { /* not on this machine */ }
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { chromium, _electron } = require('playwright-core');
const ELECTRON = process.argv.includes('--electron');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const LABEL = arg('label', 'after');
const STRIPS = arg('strips') ? path.resolve(arg('strips')) : null;
const JSON_OUT = arg('json');
const REPEAT = Math.max(1, Number(arg('repeat', '1')) || 1);
const SETTLE = Number(arg('settle', '0')) || 0;   // ms to let a freshly loaded page settle before a surface opens

const CHAT = `(async () => {
  (await import('/shell/state.js')).openSession('s_storefront');
  const st = await import('/lib/store.js');
  for (let i = 0; i < 40 && !(st.itemsBySession.value.s_storefront || []).length; i++) await new Promise((r) => setTimeout(r, 50));
})()`;
const st = (expr) => `(async () => { const s = await import('/shell/state.js'); ${expr} })()`;

// open / close: page-side expressions. sel: what to crop for the strip. phone: 393 x 852 touch.
const SURFACES = [
  { name: 'dialog', open: st('s.newSessionOpen.value = true;'), close: st('s.newSessionOpen.value = false;'), sel: '.modal' },
  { name: 'palette', open: st('s.paletteOpen.value = true;'), close: st('s.paletteOpen.value = false;'), sel: '.palette' },
  { name: 'menu', setup: CHAT, open: `(() => { const b = [...document.querySelectorAll('.sess-head [aria-haspopup]')].find((e) => e.getBoundingClientRect().width > 0); b && b.click(); })()`,
    close: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`, sel: '.shell-menu', pad: 40 },
  { name: 'toast', open: `(async () => { (await import('/lib/store.js')).toast({ title: 'Copied', body: 'Folder path', ms: 600000 }); })()`,
    close: `(async () => { const s = await import('/lib/store.js'); s.toasts.value = []; })()`, sel: '.toast', pad: 24 },
  { name: 'inspector-tab', setup: CHAT, open: `(() => { const t = [...document.querySelectorAll('.insp-tab:not(.on)')][1]; t && t.click(); })()`, sel: '.insp' },
  { name: 'home', setup: CHAT, open: st('s.goHome();'), close: st("s.openSession('s_storefront');"), settle: 900 },   // no strip: its JS timer runs on while animations are paused
  // the message-row highlight (chat/index.js flash(): a jump to a tool row or agent card); recalcs show whether it
  // repaints on the main thread every frame (a background animation) or only composites (an opacity overlay)
  { name: 'row-flash', setup: CHAT, open: `(() => { const n = document.querySelector('.chat .trow, .chat .agent'); if (!n) return; n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash'); })()`, settle: 1800 },
  { name: 'sheet', phone: true, setup: CHAT, open: st('s.sheetOpen.value = true;'), close: st('s.sheetOpen.value = false;'), sel: '.sheet', pad: 0 },
];

// ---- Electron: one hidden --test Helm, its single window reused for every surface ----
let E = null;   // { app, pid, page, cdp, errors, dirs }
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
async function startElectron() {
  const ROOT = path.join(__dirname, '..');
  const EXE = require(path.join(ROOT, 'node_modules', 'electron'));
  const profile = 'mt' + process.pid;
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  const cfg = path.join(os.tmpdir(), 'helm-motion-cfg-' + process.pid);   // empty: no sessions, no credentials
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HELM_|^LOOK_SYNC/.test(k)));
  Object.assign(env, { CLAUDE_CONFIG_DIR: cfg, HELM_CLAUDE_DIR: cfg, HELM_CLAUDE_PROJECTS: path.join(cfg, 'projects') });
  const app = await _electron.launch({ executablePath: EXE, args: [ROOT, '--test', '--profile=' + profile, '--port=' + (await freePort())], cwd: ROOT, env, timeout: 90000 });
  const pid = app.process().pid;
  try { execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = 'BelowNormal' }`], { stdio: 'ignore', windowsHide: true }); } catch {}
  // the main window (not the quick box): the first page whose URL is not the quick prompt's
  let page = null;
  for (const end = Date.now() + 60000; !page && Date.now() < end;) {
    page = app.windows().find((p) => !/quick/i.test(p.url())) || null;
    if (!page) await app.waitForEvent('window', { timeout: 5000 }).catch(() => {});
  }
  if (!page) throw new Error('no Helm window in 60 s');
  const bw = await app.browserWindow(page);
  const info = await app.evaluate(({ app: a, BrowserWindow, screen }, url) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url) || BrowserWindow.getAllWindows()[0];
    const d = screen.getDisplayMatching(w.getBounds());
    return { gpu: a.getGPUFeatureStatus(), bounds: w.getBounds(), visible: w.isVisible(), focusable: w.isFocusable(), display: { scale: d.scaleFactor, hz: d.displayFrequency, bounds: d.bounds } };
  }, page.url());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  E = { app, pid, page, bw, cdp, errors: [], dirs: [userData, cfg], info };
  page.on('pageerror', (e) => E.errors.push(String(e).slice(0, 200)));
  return E;
}
async function stopElectron() {
  if (!E) return;
  const { app, pid, dirs } = E; E = null;
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, 0); execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
// desktop = the 1280 x 860 content size of the Chromium pass; phone = 393 x 852 with touch (the window's 900 px
// minimum is lifted for it); the window stays where the test instance put it (off-screen)
async function sizeElectron(phone) {
  await E.bw.evaluate((w, ph) => { w.setMinimumSize(300, 400); w.setContentSize(ph ? 393 : 1280, ph ? 852 : 860); }, !!phone);
  await E.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!phone, maxTouchPoints: phone ? 5 : 1 });
}
// is the hidden window really drawing at the display's rate? 1.5 s of idle rAF gaps
async function cadence(page) {
  const ts = await page.evaluate(() => new Promise((r) => { const t = []; const f = (x) => { t.push(x); if (t.length < 2 || x - t[0] < 1500) requestAnimationFrame(f); else r(t); }; requestAnimationFrame(f); }));
  const g = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  return { frames: g.length, median: Math.round(g[g.length >> 1] * 100) / 100, p95: Math.round(g[Math.floor(g.length * 0.95)] * 100) / 100, over20: g.filter((x) => x > 20).length };
}
async function webglRenderer(page) {
  return page.evaluate(() => { try { const gl = document.createElement('canvas').getContext('webgl'); const x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { return 'none: ' + e.message; } });
}

async function newPage(browser, base, phone) {
  if (E) {
    await sizeElectron(phone);
    const page = E.page, errors = (E.errors = []);
    await page.emulateMedia({ reducedMotion: null });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 15000 });
    // a navigation that swapped the renderer process detaches the CDP session: open a fresh one (and its touch override)
    try { await E.cdp.send('Performance.enable'); } catch {
      E.cdp = await page.context().newCDPSession(page); await E.cdp.send('Performance.enable');
      await E.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!phone, maxTouchPoints: phone ? 5 : 1 });
    }
    if (process.argv.includes('--no-blur')) await page.addStyleTag({ content: '*, *::before, *::after { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }' });
    return { ctx: { close: async () => {} }, page, cdp: E.cdp, errors };
  }
  const ctx = await browser.newContext(phone ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 15000 });
  // --no-blur (diagnostic): headless Chromium composites in software, where every backdrop-filter frame is CPU work;
  // with the blur off, what is left is the motion itself
  if (process.argv.includes('--no-blur')) await page.addStyleTag({ content: '*, *::before, *::after { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  return { ctx, page, cdp, errors };
}
const metrics = async (cdp) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

// one measured phase: start a rAF recorder, run the action, record for `ms`, return frame gaps + layout deltas
async function measure(page, cdp, action, ms) {
  await page.evaluate(() => { window.__mt = []; const tick = (t) => { window.__mt.push(t); if (window.__mtOn) requestAnimationFrame(tick); }; window.__mtOn = true; requestAnimationFrame(tick); });
  await page.waitForTimeout(60);
  const m0 = await metrics(cdp);
  await page.evaluate(action);
  await page.waitForTimeout(ms);
  const m1 = await metrics(cdp);
  const ts = await page.evaluate(() => { window.__mtOn = false; return window.__mt; });
  const gaps = ts.slice(1).map((t, i) => t - ts[i]);
  return {
    frames: gaps.length, over20: gaps.filter((g) => g > 20).length, worst: Math.round(Math.max(0, ...gaps) * 10) / 10,
    layouts: m1.LayoutCount - m0.LayoutCount, recalcs: m1.RecalcStyleCount - m0.RecalcStyleCount,
    layoutMs: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 10000) / 10, taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 10000) / 10,
  };
}

// 6 exact frames: run the action, wait one frame so the CSS animations exist, pause every animation, then seek
async function strip(page, action, sel, pad, times, file) {
  await page.evaluate(action);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { window.__anims = document.getAnimations(); window.__anims.forEach((a) => a.pause()); r(); })));
  const shots = [];
  let clip = null;
  for (const t of times) {
    await page.evaluate((ms) => { for (const a of window.__anims) { try { a.currentTime = ms; } catch {} } }, t);
    await page.waitForTimeout(40);
    if (!clip) {
      clip = sel ? await page.evaluate(([s, p]) => {
        const el = [...document.querySelectorAll(s)].pop(); if (!el) return null;
        const r = el.getBoundingClientRect(); const x = Math.max(0, r.left - p), y = Math.max(0, r.top - p);
        return { x, y, width: Math.min(innerWidth - x, r.width + 2 * p), height: Math.min(innerHeight - y, r.height + 2 * p) };
      }, [sel, pad]) : null;
      if (!clip) clip = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
    }
    shots.push({ t, png: (await page.screenshot({ clip })).toString('base64') });
  }
  await page.evaluate(() => { for (const a of window.__anims || []) { try { a.finish(); } catch {} } window.__anims = null; });
  if (STRIPS) pendingStrips.push({ shots, file, w: clip.width });   // composed at the end (Electron has one window)
}
const pendingStrips = [];

async function compose(browser, shots, file, w) {
  if (E) {   // the test window itself: its device pixel ratio is the display's, so the shots are at that scale
    const p = E.page;
    await sizeElectron(false);
    await p.setContent(`<body style="margin:0;padding:12px;background:#8a8d91;font:600 13px Segoe UI,system-ui,sans-serif;color:#fff">${shots.map((s) =>
      `<div style="margin:0 0 4px">t = ${s.t} ms</div><img style="display:block;margin:0 0 12px;width:${Math.ceil(w)}px;box-shadow:0 0 0 1px rgba(0,0,0,.25)" src="data:image/png;base64,${s.png}">`).join('')}</body>`);
    await p.waitForTimeout(150);
    fs.mkdirSync(STRIPS, { recursive: true });
    const h = await p.evaluate(() => document.body.scrollHeight);
    await p.screenshot({ path: path.join(STRIPS, file), fullPage: true, clip: { x: 0, y: 0, width: Math.min(1280, Math.ceil(w) + 24), height: h } });
    return;
  }
  const ctx = await browser.newContext({ viewport: { width: Math.max(320, Math.ceil(w) + 24), height: 400 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(`<body style="margin:0;padding:12px;background:#8a8d91;font:600 13px Segoe UI,system-ui,sans-serif;color:#fff">${shots.map((s) =>
    `<div style="margin:0 0 4px">t = ${s.t} ms</div><img style="display:block;margin:0 0 12px;box-shadow:0 0 0 1px rgba(0,0,0,.25)" src="data:image/png;base64,${s.png}">`).join('')}</body>`);
  await p.waitForTimeout(100);
  fs.mkdirSync(STRIPS, { recursive: true });
  await p.screenshot({ path: path.join(STRIPS, file), fullPage: true });
  await ctx.close();
}

// interrupted: a close 60 ms into the entry, and 7 rapid toggles; nothing may be left (or left open) after 900 ms
async function interrupted(page) {
  return page.evaluate(async () => {
    const s = await import('/shell/state.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    s.newSessionOpen.value = true; await wait(60); s.newSessionOpen.value = false; await wait(20);
    const g = document.querySelector('.modal-scrim.m-leave');
    out.midClose = { copy: !!g, from: g ? Number(getComputedStyle(g).opacity).toFixed(2) : null };
    await wait(900);
    out.midClose.left = document.querySelectorAll('.m-leave').length; out.midClose.open = document.querySelectorAll('.modal-scrim').length;
    for (let i = 0; i < 7; i++) { s.paletteOpen.value = !s.paletteOpen.value; await wait(35); }
    await wait(900);
    out.toggles = { open: document.querySelectorAll('.modal-scrim:not(.m-leave)').length, left: document.querySelectorAll('.m-leave').length, visible: s.paletteOpen.value };
    s.paletteOpen.value = false; await wait(600);
    out.toggles.after = document.querySelectorAll('.modal-scrim, .m-leave').length;
    return out;
  });
}

(async () => {
  const env = arg('ui') ? { ...process.env, HELM_UI_DIR: path.resolve(arg('ui')) } : process.env;
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], env });
  const base = await new Promise((res, rej) => {
    srv.stdout.on('data', (b) => { const m = /(http:\/\/\S+)/.exec(String(b)); if (m) res(m[1]); });
    setTimeout(() => rej(new Error('serve-ui did not start')), 15000);
  });
  const browser = ELECTRON ? null : await chromium.launch();
  const report = { label: LABEL, method: ELECTRON ? 'electron' : 'headless-chromium', surfaces: [], interrupted: null, idle: null };
  let bad = 0;
  try {
    if (ELECTRON) {
      await startElectron();
      await sizeElectron(false);
      await E.page.goto(base, { waitUntil: 'networkidle' });
      report.electron = { ...E.info, webgl: await webglRenderer(E.page), cadence: await cadence(E.page), dpr: await E.page.evaluate(() => devicePixelRatio) };
      const x = report.electron;
      console.log(`electron: pid ${E.pid}; window ${JSON.stringify(x.bounds)} visible ${x.visible} focusable ${x.focusable}; display ${x.display.hz} Hz x${x.display.scale}, dpr ${x.dpr}`);
      console.log(`electron: gpu_compositing ${x.gpu.gpu_compositing}, rasterization ${x.gpu.rasterization}, webgl "${x.webgl}"`);
      console.log(`electron: idle rAF ${x.cadence.frames} frames in 1.5 s, median ${x.cadence.median} ms, p95 ${x.cadence.p95} ms, ${x.cadence.over20} over 20 ms`);
    }
    for (const sf of SURFACES) {
      // --repeat=N: N fresh loads per surface; the row is the MEDIAN run (by frames over 20 ms, then layouts), the
      // others are listed, so one scheduling hiccup on a busy machine does not read as the motion's cost
      const runs = [];
      let ctx, page, cdp, errors;
      for (let r = 0; r < REPEAT; r++) {
        if (r) await ctx.close();
        ({ ctx, page, cdp, errors } = await newPage(browser, base, sf.phone));
        await page.waitForTimeout(SETTLE);   // the page's own load-in (Home's entry, data arriving) is not the surface's
        if (sf.setup) { await page.evaluate(sf.setup); await page.waitForTimeout(Math.max(500, SETTLE)); }
        const i1 = await measure(page, cdp, sf.open, sf.settle || 700);
        const o1 = sf.close ? await measure(page, cdp, sf.close, sf.settle || 500) : null;
        runs.push({ in: i1, out: o1 });
      }
      const med = (k) => { const v = runs.map((x) => x[k]).filter(Boolean).sort((a, b) => a.over20 - b.over20 || a.layouts - b.layouts); return v.length ? v[(v.length - 1) >> 1] : null; };
      const inn = med('in'), out = med('out');
      const row = { name: sf.name, in: inn, out, errors, runs: REPEAT > 1 ? runs : undefined };
      report.surfaces.push(row);
      bad += inn.over20 + (out ? out.over20 : 0);
      const all = (k) => (REPEAT > 1 ? ` [runs ${runs.map((x) => x[k] && x[k].over20).join('/')}]` : '');
      console.log(`${sf.name.padEnd(14)} in: ${inn.over20} over 20 ms${all('in')} (worst ${inn.worst} ms, ${inn.frames} frames), ${inn.layouts} layouts / ${inn.recalcs} recalcs, task ${inn.taskMs} ms` +
        (out ? ` | out: ${out.over20} over 20 ms${all('out')} (worst ${out.worst}), ${out.layouts} layouts / ${out.recalcs} recalcs, task ${out.taskMs} ms` : '') + (errors.length ? ` | errors: ${errors.join('; ')}` : ''));
      if (STRIPS && sf.sel !== undefined && sf.name !== 'inspector-tab') {
        if (sf.close) { await page.evaluate(sf.close); await page.waitForTimeout(700); }
        await strip(page, sf.open, sf.sel, sf.pad ?? 32, [0, 40, 80, 140, 220, 440], `helm-motion-${sf.name}-in-${LABEL}.png`);
        if (sf.close && LABEL !== 'before') {
          await page.waitForTimeout(300);
          await strip(page, sf.close, `.m-leave ${sf.sel}, ${sf.sel}.m-leave`, sf.pad ?? 32, [0, 30, 60, 100, 150, 200], `helm-motion-${sf.name}-out-${LABEL}.png`);
        }
      }
      await ctx.close();
    }
    const { ctx, page, cdp } = await newPage(browser, base, false);
    await page.evaluate(CHAT); await page.waitForTimeout(3000);
    const a = await metrics(cdp); await page.waitForTimeout(10000); const b = await metrics(cdp);
    report.idle = { taskMsPerS: Math.round((b.TaskDuration - a.TaskDuration) * 1000 / 10 * 100) / 100, layouts: b.LayoutCount - a.LayoutCount, recalcs: b.RecalcStyleCount - a.RecalcStyleCount };
    if (LABEL !== 'before') {
      report.interrupted = await interrupted(page);
      const i = report.interrupted;
      i.ok = i.midClose.copy && i.midClose.left === 0 && i.midClose.open === 0 && i.toggles.left === 0 && i.toggles.open === (i.toggles.visible ? 1 : 0) && i.toggles.after === 0;
      if (!i.ok) bad++;
    }
    await ctx.close();
    // reduced motion: every running animation should be an opacity fade of 120 ms (entry and exit)
    {
      const rctx = E ? { close: async () => { await E.page.emulateMedia({ reducedMotion: null }); } } : await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
      const rp = E ? E.page : await rctx.newPage();
      if (E) { await sizeElectron(false); await rp.emulateMedia({ reducedMotion: 'reduce' }); }
      await rp.goto(base, { waitUntil: 'networkidle' });
      await rp.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 15000 });
      report.reduced = await rp.evaluate(async () => {
        const s = await import('/shell/state.js');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const list = () => document.getAnimations().filter((x) => x.playState === 'running').map((x) => `${x.animationName}:${x.effect.getTiming().duration}`);
        s.newSessionOpen.value = true; await wait(30); const inn = list();
        await wait(300); s.newSessionOpen.value = false; await wait(20); const out = list();
        await wait(400);
        return { in: inn, out, left: document.querySelectorAll('.m-leave').length };
      });
      const r = report.reduced, okR = [...r.in, ...r.out].every((x) => /^m-(in|out)-fade:120$/.test(x)) && r.in.length > 0 && r.left === 0;
      r.ok = LABEL === 'before' ? null : okR;
      if (LABEL !== 'before' && !okR) bad++;
      await rctx.close();
    }
    for (const st of pendingStrips) await compose(browser, st.shots, st.file, st.w);
  } finally {
    if (browser) await browser.close();
    await stopElectron();
    srv.kill();
  }
  const i = report.interrupted;
  console.log(`idle (chat view, 10 s): ${report.idle.taskMsPerS} ms main-thread per s, ${report.idle.layouts} layouts, ${report.idle.recalcs} recalcs`);
  if (i) console.log(`interrupted: close at 60 ms -> copy ${i.midClose.copy} from opacity ${i.midClose.from}, ${i.midClose.left} left, ${i.midClose.open} open; 7 toggles -> ${i.toggles.open} open (palette ${i.toggles.visible ? 'shown' : 'hidden'}), ${i.toggles.left} left, ${i.toggles.after} after close`);
  if (report.reduced) console.log(`reduced motion: in [${report.reduced.in.join(', ')}] out [${report.reduced.out.join(', ')}], ${report.reduced.left} left${report.reduced.ok === false ? ' FAIL' : ''}`);
  console.log(`motion-trace (${LABEL}): ${report.surfaces.length} surfaces, ${report.surfaces.reduce((n, r) => n + r.in.over20 + (r.out ? r.out.over20 : 0), 0)} frames over 20 ms, interrupted ${i ? (i.ok ? 'ok' : 'FAIL') : 'n/a'}, idle ${report.idle.taskMsPerS} ms/s`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 2; });
