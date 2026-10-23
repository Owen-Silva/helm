// End-to-end check of Usage > Estimates (lane eta-accuracy, 2026-10-17): how accurate the eta mod's estimates are.
// Never the user's real history: the synthetic fixture test/host/fixtures/eta/history.jsonl, copied to a temp folder.
//
// Phase A, the REAL app: a hidden `electron . --test` (off-screen window, throwaway profile, its own port, empty
//   throwaway CLAUDE_CONFIG_DIR) with HELM_ETA_DIR = the temp copy. The engine's eta.accuracy reads the file
//   (async), the Usage panel's Estimates section shows it; the numbers on screen are checked against
//   ui/panels/eta-accuracy-math.js on the same fixture; hover and arrow keys read a task out; then the
//   history file is taken away (empty state), replaced by a folder (error state with the reason, on a fresh
//   mount and over a loaded copy). Light and dark shots of the section.
// Phase B, phone widths: one headless Chromium on the mock UI (tools/serve-ui.js, ?mock=1) whose eta.accuracy
//   answers the same fixture records (parsed by the engine's own parseHistory); 393x852 and 320x640, touch:
//   no horizontal overflow, nothing clipped, the narrow table drops Project/Shown. Shots in both themes.
// Guards: >= 1.5 GB free RAM, no Riot/VALORANT running, Below Normal priority (children inherit it),
//   lowcpu.js (the machine-wide one-browser lock and CPU cap); only processes it started are stopped.
// Summary line: `eta-accuracy-e2e: N passed, M failed`.
// Usage: node tools/eta-accuracy-e2e.js [--shot=<dir>] [--keep] [--only=a|b]
'use strict';
require('./lowcpu-optional'); // FIRST: optional CPU cap (see tools/lowcpu-optional.js)
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const EXE = require(path.join(ROOT, 'node_modules', 'electron'));
const KEEP = process.argv.includes('--keep');
const ONLY = arg('only');
const SHOTS = path.resolve(arg('shot') || path.join(os.tmpdir(), 'eta-accuracy-e2e-shots'));
fs.mkdirSync(SHOTS, { recursive: true });
const FIXTURE = path.join(ROOT, 'test', 'host', 'fixtures', 'eta', 'history.jsonl');
const profile = 'etaacc' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-eta-acc-e2e-'));
const etaDir = path.join(tmp, 'eta');
const cfg = path.join(tmp, 'claude');
const stamp = () => new Date().toISOString().slice(11, 23);
const note = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => { results.push({ ok: !!ok, what }); console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${what}`); return ok; };
const started = new Set();

const ours = (pid) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true }).includes(profile); } catch { return false; } };
const killTree = (pid) => { if (!ours(pid)) return; try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} };
const freeGb = () => Number(execFileSync('powershell', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)'], { encoding: 'utf8', windowsHide: true }).trim());
const gameRunning = () => execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process -Name VALORANT*,RiotClient*,League* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name'], { encoding: 'utf8', windowsHide: true }).trim();

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
function connect(port, token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    let id = 1;
    const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); } });
    const rpc = (method, params = {}) => new Promise((ok, bad) => {
      const i = id++;
      pending.set(i, (m) => (m.error ? bad(Object.assign(new Error(m.error.message), { code: m.error.code })) : ok(m.result)));
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      setTimeout(() => { if (pending.delete(i)) bad(new Error(`${method} timed out`)); }, 30000);
    });
    ws.on('close', () => { for (const [i, p] of pending) { pending.delete(i); p({ error: { message: 'connection closed', code: 'closed' } }); } });
    ws.once('open', () => res({ ws, rpc }));
    ws.once('error', rej);
  });
}
async function waitReady(child, getOut) {
  for (const end = Date.now() + 60000; Date.now() < end; await sleep(250)) {
    const m = /HELM_READY (\{.*\})/.exec(getOut());
    if (m) return JSON.parse(m[1]);
    if (child.exitCode !== null) throw new Error('app exited early:\n' + getOut().slice(-1500));
  }
  throw new Error('no HELM_READY in 60 s');
}
const ui = (c, js) => c.rpc('test.eval', { js });
async function uiWait(c, js, ms = 15000) {
  let v = null;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    v = await ui(c, js).catch(() => null);
    if (v) return v;
  }
  return v;
}

// What the section shows, read the same way in Electron and in Chromium.
const READ = `(() => {
  const head = [...document.querySelectorAll('.pn-sect-head')].find((h) => h.textContent.trim().startsWith('Estimates'));
  const wrap = document.querySelector('.pn-ea-wrap');
  if (!head || !wrap) return null;
  const txt = (sel) => [...wrap.querySelectorAll(sel)].map((e) => e.innerText.replace(/\\s+/g, ' ').trim());
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const clipped = [...wrap.querySelectorAll('.pn-us-card, .pn-ea-stat, .pn-ea-factors, .pn-ea-trend, .pn-ea-legend, td, th')].filter((e) => vis(e) && e.scrollWidth > e.clientWidth + 1 && !e.matches('td.proj')).length;
  const de = document.scrollingElement || document.documentElement;
  return {
    vals: txt('.pn-ea-val'), labs: txt('.pn-ea-lab'), dots: wrap.querySelectorAll('.pn-ea-dot').length, rows: wrap.querySelectorAll('.pn-ea-table tbody tr').length,
    roll: !!wrap.querySelector('.pn-ea-roll'), trend: txt('.pn-ea-trend')[0] || null, foot: txt('.pn-ea-foot')[0] || null, factors: txt('.pn-ea-factors')[0] || null,
    empty: txt('.pn-empty')[0] || null, error: txt('.pn-ea-error')[0] || null, stale: [...document.querySelectorAll('.pn-uh-unavail')].map((e) => e.innerText).find((t) => /Estimates/.test(t)) || null,
    loading: !!wrap.querySelector('.pn-loading'), projVisible: vis(wrap.querySelector('.pn-ea-table th.proj')), clipped,
    overflow: de.scrollWidth > de.clientWidth, theme: document.documentElement.dataset.theme,
  };
})()`;
// The inspector (and so Usage) shows inside a session: open one (Phase A makes an empty one; the mock has some).
const OPEN_USAGE = (id = null) => `Promise.all([import('/panels/state.js'), import('/shell/state.js'), import('/lib/store.js')]).then(async ([p, sh, st]) => { for (let i = 0; i < 50 && !st.sessions.value.length; i++) await new Promise((r) => setTimeout(r, 100)); const sid = ${JSON.stringify(id)} || (st.sessions.value[0] && st.sessions.value[0].id); if (sid) sh.openSession(sid); await new Promise((r) => setTimeout(r, 400)); p.showPanel('usage'); try { if (sh.isPhone.value) sh.sheetOpen.value = true; } catch {} return !!sid; })`;
const REMOUNT = `import('/panels/state.js').then(async (p) => { p.showPanel('agents'); await new Promise((r) => setTimeout(r, 300)); p.showPanel('usage'); return true; })`;
const THEME = (t) => `import('/lib/store.js').then(async (st) => { for (let i = 0; i < 60 && !st.settings.value; i++) await new Promise((r) => setTimeout(r, 50)); st.settings.value = { ...(st.settings.value || {}), theme: ${JSON.stringify(t)} }; await new Promise((r) => setTimeout(r, 350)); return document.documentElement.dataset.theme; })`;
const RECT = `(() => {
  const head = [...document.querySelectorAll('.pn-sect-head')].find((h) => h.textContent.trim().startsWith('Estimates'));
  const wrap = document.querySelector('.pn-ea-wrap');
  if (!head || !wrap) return null;
  head.scrollIntoView({ block: 'start' });
  const a = head.getBoundingClientRect(), b = wrap.getBoundingClientRect();
  const x = Math.max(0, Math.floor(Math.min(a.left, b.left)) - 8), y = Math.max(0, Math.floor(a.top) - 6);
  const w = Math.ceil(Math.max(a.right, b.right)) + 8 - x, h = Math.min(window.innerHeight - y, Math.ceil(b.bottom) + 8 - y);
  return { x, y, width: Math.min(w, window.innerWidth - x), height: h, full: Math.ceil(b.bottom) + 8 - y, inner: window.innerHeight };
})()`;
const HOVER = `(() => {
  const plot = document.querySelector('.pn-ea-plot'); const dots = [...document.querySelectorAll('.pn-ea-dot')];
  if (!plot || dots.length < 3) return null;
  const d = dots[2].getBoundingClientRect();
  plot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: d.left + d.width / 2, clientY: d.top + d.height / 2, pointerType: 'mouse' }));
  return true;
})()`;
const READOUT = `(() => { const r = document.querySelector('.pn-ea-chart-card .pn-uh-read'); return r ? r.innerText.replace(/\\s+/g, ' ') : null; })()`;

async function expected() {
  const { readEtaHistory } = require(path.join(ROOT, 'main', 'engine', 'eta-accuracy.js'));
  const M = require(path.join(ROOT, 'ui', 'panels', 'eta-accuracy-math.js'));
  const data = await readEtaHistory({ etaDir });
  const s = M.summarize(data.records);
  const f30 = s.factorNow.find((f) => f.minutes === 30);
  return { data, s, vals: [M.fmtShare(s.shown.within25), M.fmtRatio(s.typicalRatio), f30 && f30.enough && f30.factor !== null ? M.fmtRatio(f30.factor, 2) : '1×'] };
}

async function phaseA(exp) {
  const gb = freeGb();
  note(`free RAM ${gb} GB`);
  if (!(gb >= 1.5)) throw new Error(`only ${gb} GB free RAM (needs 1.5 GB): not starting Electron`);
  const port = await freePort();
  const env = { ...process.env, HELM_ETA_DIR: etaDir, CLAUDE_CONFIG_DIR: cfg, HELM_CLAUDE_DIR: cfg, HELM_CLAUDE_PROJECTS: path.join(cfg, 'projects') };
  const child = spawn(EXE, [ROOT, '--test', '--profile=' + profile, '--port=' + port], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  started.add(child.pid);
  let out = '';
  let sessId = null;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const ready = await waitReady(child, () => out);
    started.add(ready.pid);
    note(`instance up: pid ${ready.pid}`);
    const c = await connect(port, ready.token);
    await uiWait(c, `document.readyState === 'complete' && !!document.querySelector('#app')?.children.length`);

    const r0 = await c.rpc('eta.accuracy');
    check(r0 && r0.missing === false && r0.records.length === 24 && r0.bad === 1, `eta.accuracy reads the fixture copy: ${r0 && r0.records.length} records, ${r0 && r0.bad} bad line(s), ${r0 && r0.file}`);
    check(r0 && path.resolve(r0.file) === path.join(etaDir, 'history.jsonl'), 'and only the temp copy (HELM_ETA_DIR), never ~/.claude');

    const sess = await c.rpc('sessions.create', { cwd: tmp }).catch((e) => ({ error: e.message }));
    check(sess && sess.id, `an empty session to hold the inspector (no prompt, so no CLI turn): ${sess && (sess.id || sess.error)}`);
    sessId = sess && sess.id;
    await ui(c, OPEN_USAGE(sessId));
    const v = await uiWait(c, `(() => { const r = ${READ}; return r && r.vals.length === 3 ? r : null; })()`);
    check(v, 'Usage panel shows the Estimates section with three headline numbers');
    if (!v) {
      const dom = await ui(c, `(() => ({ usage: !!document.querySelector('.pn-usage'), heads: [...document.querySelectorAll('.pn-sect-head')].map((h) => h.textContent.trim().slice(0, 20)), wrap: document.querySelector('.pn-ea-wrap')?.innerText.slice(0, 200) || null }))()`).catch((e) => e.message);
      note('dom:', JSON.stringify(dom).slice(0, 500));
      const ce = await c.rpc('test.console', {}).catch(() => null);
      const bad = ce && ce.entries ? ce.entries.filter((x) => x.level === 3 || /error|warn/i.test(String(x.level))) : [];
      note('console:', JSON.stringify(bad.slice(-6).map((x) => `${x.message} @${x.source}:${x.line}`)).slice(0, 1500));
    }
    if (v) {
      check(JSON.stringify(v.vals) === JSON.stringify(exp.vals), `headline ${JSON.stringify(v.vals)} = the math on the fixture ${JSON.stringify(exp.vals)}`);
      check(v.dots === 24 && v.roll, `chart: ${v.dots} task dots and the rolling median line`);
      check(v.rows === 8, `recent tasks: ${v.rows} rows`);
      check(v.trend && /^Getting more accurate\./.test(v.trend), `trend: ${v.trend}`);
      check(v.foot && /24 finished tasks/.test(v.foot) && /1 unreadable line/.test(v.foot), `footer counts the tasks and the unreadable line: ${v.foot}`);
      check(v.factors && /30m 0\.9×/.test(v.factors) && /1h30m 0\.8×/.test(v.factors) && /10m as said/.test(v.factors), `calibration now: ${v.factors}`);
      check(!v.overflow && v.clipped === 0, `no overflow, nothing clipped at the desktop width (clipped ${v.clipped})`);
    }
    await ui(c, HOVER);
    const read1 = await uiWait(c, READOUT, 3000);
    const p2 = exp.s.points[2];
    check(read1 && read1.includes('→') && read1.includes(require(path.join(ROOT, 'ui', 'panels', 'eta-accuracy-math.js')).fmtRatio(p2.ratio)), `hover reads the third task out: ${read1}`);
    await ui(c, `(() => { const p = document.querySelector('.pn-ea-plot'); p.focus(); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return true; })()`);
    const read2 = await uiWait(c, READOUT, 3000);
    check(read2 && read2 !== read1, `arrow keys step through tasks: ${read2}`);
    await ui(c, `(() => { const p = document.querySelector('.pn-ea-plot'); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); p.blur(); return true; })()`);

    for (const t of ['light', 'dark']) {
      const got = await ui(c, THEME(t));
      check(got === t, `theme ${t}: the page is in ${got}`);
      await sleep(300);
      // Shot only: the test profile's "Desktop wallpaper" info toast sits over the list (test noise, not the panel).
      await ui(c, `(() => { const t = document.querySelector('.toasts'); if (t) t.style.visibility = 'hidden'; return true; })()`);
      const rect = await ui(c, RECT);
      if (rect && rect.full > rect.height) note(`section is ${rect.full}px, window shows ${rect.height}px of it`);
      const file = path.join(SHOTS, `helm-eta-accuracy-${t}.png`);
      const cap = rect ? await c.rpc('test.capture', { file, waitMs: 400, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).catch((e) => ({ error: e.message })) : null;
      check(cap && !cap.error && !cap.empty && fs.existsSync(file), `${t} shot ${file} (${cap && (cap.error || `${cap.width}x${cap.height}`)})`);
    }

    // Empty: the history file goes away; reload.
    fs.renameSync(path.join(etaDir, 'history.jsonl'), path.join(etaDir, 'history.moved'));
    await ui(c, `(() => { const b = document.querySelector('button[aria-label="Reload eta\\'s history"]'); if (!b) return false; b.click(); return true; })()`);
    const e1 = await uiWait(c, `(() => { const r = ${READ}; return r && r.empty ? r : null; })()`);
    check(e1 && /No finished estimates yet/.test(e1.empty) && e1.empty.includes('history.jsonl'), `empty state names the file: ${e1 && e1.empty}`);
    // Error over a loaded copy, then on a fresh mount: a folder where the file should be.
    fs.mkdirSync(path.join(etaDir, 'history.jsonl'));
    await ui(c, `(() => { const b = document.querySelector('button[aria-label="Reload eta\\'s history"]'); if (!b) return false; b.click(); return true; })()`);
    const e2 = await uiWait(c, `(() => { const r = ${READ}; return r && r.stale ? r : null; })()`);
    check(e2 && /is not a file/.test(e2.stale) && /Showing the last copy/.test(e2.stale), `error over a loaded copy says why: ${e2 && e2.stale}`);
    await ui(c, REMOUNT);
    const e3 = await uiWait(c, `(() => { const r = ${READ}; return r && r.error ? r : null; })()`);
    check(e3 && /is not a file/.test(e3.error) && /Try again/.test(e3.error), `error state on a fresh mount says why, with Try again: ${e3 && e3.error}`);
    fs.rmdirSync(path.join(etaDir, 'history.jsonl'));
    fs.renameSync(path.join(etaDir, 'history.moved'), path.join(etaDir, 'history.jsonl'));
    await ui(c, `(() => { const b = [...document.querySelectorAll('.pn-ea-error button')].find((x) => /Try again/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
    const e4 = await uiWait(c, `(() => { const r = ${READ}; return r && r.vals.length === 3 ? r : null; })()`);
    check(e4 && e4.dots === 24, 'Try again loads it once the file is back');
    const errs = await c.rpc('test.console', {}).catch(() => null);
    const pageErrors = errs && Array.isArray(errs.entries) ? errs.entries.filter((x) => (x.level === 3 || /error/i.test(String(x.level))) && /eta-accuracy|eta\.accuracy|Estimates|pn-ea/i.test(`${x.message} ${x.source}`)) : [];
    if (pageErrors.length) note('console errors:', JSON.stringify(pageErrors.slice(0, 3)).slice(0, 600));
    check(pageErrors.length === 0, `no console errors from the section (${pageErrors.length})`);
    if (sessId) await c.rpc('sessions.close', { id: sessId }).catch(() => {});
    c.ws.close();
  } finally {
    for (const pid of started) killTree(pid);
    await sleep(800);
  }
}

async function phaseB(exp) {
  const gb = freeGb();
  note(`free RAM ${gb} GB`);
  if (!(gb >= 2.5)) { check(false, `phone widths not run: only ${gb} GB free RAM (a browser needs 2.5 GB)`); return; }
  const { chromium } = require('playwright-core');
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  started.add(srv.pid);
  let browser = null;
  try {
    const url = await new Promise((res, rej) => { srv.stdout.on('data', (d) => { const m = /(http:\/\/\S+)/.exec(String(d)); if (m) res(m[1]); }); setTimeout(() => rej(new Error('serve-ui did not start')), 15000); });
    browser = await chromium.launch({});
    const body = `export function mockEtaAccuracy() { return ${JSON.stringify(exp.data)}; }\n`;
    for (const [w, h, theme] of [[393, 852, 'dark'], [393, 852, 'light'], [320, 640, 'light'], [320, 640, 'dark']]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.route('**/lib/mock-eta-accuracy.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
      await page.goto(url.includes('?') ? url : `${url}/?mock=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 15000 });
      await page.evaluate(THEME_FN, theme);
      await page.evaluate(OPEN_USAGE());
      await page.waitForFunction(`(() => { const r = ${READ}; return r && r.vals.length === 3; })()`, null, { timeout: 15000 });
      const r = await page.evaluate(READ);
      const name = `${w}-${theme}`;
      check(r.theme === theme && JSON.stringify(r.vals) === JSON.stringify(exp.vals), `${name}: headline ${JSON.stringify(r.vals)}`);
      check(!r.overflow && r.clipped === 0, `${name}: no horizontal overflow, nothing clipped (clipped ${r.clipped})`);
      check(!r.projVisible, `${name}: the narrow table drops Project and Shown`);
      check(errors.length === 0, `${name}: no page errors ${errors.join(' | ').slice(0, 200)}`);
      const sect = page.locator('.pn-ea-wrap');
      await page.locator('.pn-sect-head', { hasText: 'Estimates' }).scrollIntoViewIfNeeded();
      const file = path.join(SHOTS, `helm-eta-accuracy-${name}.png`);
      await sect.screenshot({ path: file });
      check(fs.existsSync(file), `${name}: shot ${file}`);
      await page.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    killTree(srv.pid);
    try { srv.kill(); } catch {}
  }
}
// Runs in the page (Phase B): same as THEME, as a function for page.evaluate.
async function THEME_FN(t) {
  const st = await import('/lib/store.js');
  for (let i = 0; i < 60 && !st.settings.value; i++) await new Promise((r) => setTimeout(r, 50));
  st.settings.value = { ...(st.settings.value || {}), theme: t };
  await new Promise((r) => setTimeout(r, 350));
  return document.documentElement.dataset.theme;
}

async function main() {
  const game = gameRunning();
  if (game) throw new Error(`not running while a game is: ${game}`);
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { note('could not lower priority:', e.message); }
  fs.mkdirSync(etaDir, { recursive: true });
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(etaDir, 'history.jsonl'));
  const exp = await expected();
  note(`expected headline ${JSON.stringify(exp.vals)} from ${exp.data.records.length} fixture records`);
  if (ONLY !== 'b') await phaseA(exp);
  if (ONLY !== 'a') await phaseB(exp);
}

main()
  .catch((e) => check(false, `run: ${e && e.message}`))
  .finally(() => {
    for (const pid of started) killTree(pid);
    if (!KEEP) { for (const d of [tmp, userData]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`eta-accuracy-e2e: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  });
