require('./lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// Screenshot a Helm UI page with the existing Playwright Chromium (no browser download).
// Usage: node tools/shot.js <url> <out.png> [width=1440] [height=900] [--eval "<js run before capture>"]
// Example: node tools/shot.js "http://127.0.0.1:4870/?mock=1" .shots/home.png 1440 900
// Keep sessions short: one capture per call, browser closed right after.
const { chromium } = require('playwright-core');

(async () => {
  const args = process.argv.slice(2);
  const evalIdx = args.indexOf('--eval');
  const evalJs = evalIdx >= 0 ? args.splice(evalIdx, 2)[1] : null;
  const [url, out, w = '1440', h = '900'] = args;
  if (!url || !out) { console.error('usage: shot.js <url> <out.png> [w] [h] [--eval js]'); process.exit(2); }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url, { waitUntil: 'networkidle' });
    if (evalJs) await page.evaluate(evalJs);
    await page.waitForTimeout(400);
    require('fs').mkdirSync(require('path').dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    console.log('saved', out, errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '(no page errors)');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
