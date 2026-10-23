// Browser check for error toasts (lane helm-plainerror, 2026-10-14, P-H1): in the real UI (mock backend), a toast
// built from a raw error shows the plain line, keeps the raw text in a closed "Details" disclosure, opening it
// shows the raw text and pins the toast past its 6 s timeout, and it renders in dark and light.
// Usage: node tools/toast-details-check.js [outDir=.shots/toast-details] [--width 1280]
//   Prints "toast-details: N passed, M failed". --width sets the viewport (393 / 320 for phone widths; the
//   screenshots then end in -<width>), and the toast must fit inside it.
// Runs on cloudtest (Linux, no lowcpu there) or locally (lowcpu caps CPU + one headless browser).
try { require('./lowcpu-optional'); } catch { /* not on this machine: cloud runner */ }
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const argv = process.argv.slice(2);
const wi = argv.indexOf('--width');
const width = wi >= 0 ? Number(argv[wi + 1]) : 1280;
const outDir = argv.find((a, i) => !a.startsWith('--') && (wi < 0 || i !== wi + 1)) || path.join(__dirname, '..', '.shots', 'toast-details');
const sfx = width === 1280 ? '' : `-${width}`;
if (!(width >= 200)) { console.log('toast-details: --width needs a number of pixels'); process.exit(2); }
let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    srv.stdout.on('data', (b) => { const m = /(http:\/\/\S+)/.exec(String(b)); if (m) res(m[1]); });
    setTimeout(() => rej(new Error('serve-ui did not start')), 15000);
  });
  // HELM_SHOT_CHANNEL=chrome: the installed Chrome (a Windows cloud runner has no Playwright Chromium), as worktrees-shot.js
  const browser = await chromium.launch(process.env.HELM_SHOT_CHANNEL ? { channel: process.env.HELM_SHOT_CHANNEL } : {});
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const raw = "ENOENT: no such file or directory, open 'C:\\Users\\you\\proj\\.claude\\settings.json'";
    await page.evaluate(async (raw) => {
      const { toast } = await import('/lib/store.js');
      toast({ title: 'Could not fork', error: Object.assign(new Error(raw), { code: 'ENOENT' }), kind: 'error' });
    }, raw);
    const t = page.locator('.toast').last();
    await t.waitFor();
    check(await t.locator('.toast-body').innerText() === '"settings.json" was not found. It may have been moved or deleted.', 'body is the plain line');
    check(!(await t.locator('.toast-body').innerText()).includes('ENOENT'), 'body has no raw text');
    check(await t.locator('details.toast-details > summary').innerText() === 'Details', 'a Details disclosure is there');
    check(!(await t.locator('.toast-raw').isVisible()), 'Details starts closed');
    const fits = async (what) => { const b = await t.boundingBox(); const sw = await page.evaluate(() => document.documentElement.scrollWidth); check(b && b.x >= 0 && b.x + b.width <= width + 0.5 && sw <= width, `${what}: the toast fits the ${width}px viewport (x ${b && Math.round(b.x)}, w ${b && Math.round(b.width)}, scrollWidth ${sw})`); };
    await fits('closed');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      await page.waitForTimeout(250);
      await t.screenshot({ path: path.join(outDir, `closed-${theme}${sfx}.png`) });
    }
    await t.locator('summary').click();
    check(await t.locator('.toast-raw').isVisible(), 'clicking Details shows the raw text');
    check((await t.locator('.toast-raw').innerText()) === raw, 'the raw text is exact (incl. code)');
    await fits('open');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      await page.waitForTimeout(250);
      await t.screenshot({ path: path.join(outDir, `open-${theme}${sfx}.png`) });
      const c = await t.locator('.toast-raw').evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, font: s.fontFamily }; });
      console.log(`     ${theme}: raw color ${c.color}, bg ${c.bg}, font ${c.font.split(',')[0]}`);
    }
    await page.waitForTimeout(6800);
    check(await t.isVisible(), 'an opened toast is still there after its 6 s timeout');
    await page.evaluate(async () => { const { toast } = await import('/lib/store.js'); toast({ title: 'Unpinned', error: new Error('connect ECONNREFUSED 127.0.0.1:4871'), kind: 'error' }); });
    const u = page.locator('.toast', { hasText: 'Unpinned' });
    await u.waitFor();
    check((await u.locator('.toast-body').innerText()).startsWith('Nothing answered at 127.0.0.1:4871.'), 'second toast: ECONNREFUSED in words');
    await page.waitForTimeout(6800);
    check(!(await u.isVisible()), 'an unopened toast still times out');
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`toast-details (${width}px): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`toast-details: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
