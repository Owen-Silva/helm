// Browser check + screenshots for worktrees (lane helm-worktrees, 2026-10-14, H4): the New session dialog's
// worktree part and the Worktrees panel, in the real UI on the mock backend (ui/lib/mock-worktrees.js), dark and
// light, at one width per run.
// Usage: node tools/worktrees-shot.js [outDir=.shots/worktrees] [--width 1280]
//   Prints "worktrees-shot: N passed, M failed". Screenshots end in -<theme>-<width>.png.
//   HELM_SHOT_CHANNEL=chrome uses the installed Chrome (a cloud runner without Playwright's own Chromium).
// Runs on cloudtest or locally (lowcpu caps CPU + one headless browser).
try { require('./lowcpu-optional'); } catch { /* not on this machine: cloud runner */ }
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const argv = process.argv.slice(2);
const wi = argv.indexOf('--width');
const width = wi >= 0 ? Number(argv[wi + 1]) : 1280;
const outDir = argv.find((a, i) => !a.startsWith('--') && (wi < 0 || i !== wi + 1)) || path.join(__dirname, '..', '.shots', 'worktrees');
let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const HELM_WT = 'C:\\Users\\you\\helm-wt\\pace';

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve-ui.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    srv.stdout.on('data', (b) => { const m = /(http:\/\/\S+)/.exec(String(b)); if (m) res(m[1]); });
    setTimeout(() => rej(new Error('serve-ui did not start')), 15000);
  });
  const browser = await chromium.launch(process.env.HELM_SHOT_CHANNEL ? { channel: process.env.HELM_SHOT_CHANNEL } : {});
  try {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      await page.waitForTimeout(500);
      const tag = `${theme}-${width}`;
      const fits = async (sel, what) => {
        const b = await page.locator(sel).first().boundingBox();
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        check(!!b && b.x >= -0.5 && b.x + b.width <= width + 0.5 && sw <= width, `${tag}: ${what} fits the window (x ${b && Math.round(b.x)}, w ${b && Math.round(b.width)}, page ${sw})`);
      };
      const shot = async (sel, name) => { await page.waitForTimeout(250); await page.locator(sel).first().screenshot({ path: path.join(outDir, `${name}-${tag}.png`) }); };

      // 1. New session in a worktree, from a session in ~/helm-wt/pace
      await page.evaluate(async (cwd) => { (await import('/shell/worktrees.js')).newInWorktree(cwd); }, HELM_WT);
      await page.locator('.wt-base').waitFor({ timeout: 5000 });
      check(await page.locator('.wt-toggle input').isChecked(), `${tag}: the worktree part opens switched on`);
      check(await page.locator('.wt-base').inputValue() === 'wk/pace', `${tag}: the base defaults to the folder's own branch (wk/pace)`);
      check(await page.locator('.wt-deps [aria-pressed="true"]').innerText() === 'Copy dependencies (real copy)', `${tag}: 717 MB node_modules defaults to Copy`);
      await page.locator('.wt-name-input').fill('pace');
      check((await page.locator('.wt-sec .wt-err').innerText()).includes('The branch wk/pace already exists'), `${tag}: a taken name says so`);
      await page.locator('.wt-name-input').fill('bad/name');
      check((await page.locator('.wt-sec .wt-err').innerText()).includes('Use letters, numbers'), `${tag}: a bad name says what is allowed`);
      await page.locator('.wt-name-input').fill('fix-login');
      check(await page.locator('.wt-sec .wt-err').count() === 0, `${tag}: a good name clears the error`);
      check((await page.locator('.wt-where').innerText()).endsWith('helm-wt\\fix-login'), `${tag}: the folder preview is <repo>-wt\\<name>`);
      check((await page.locator('.newsess .btn-primary').last().innerText()).includes('Create worktree and start'), `${tag}: the start button says it creates the worktree`);
      await fits('.modal.newsess', 'New session dialog');
      await shot('.modal.newsess', 'dialog');
      // storefront: a 1.5 GB node_modules defaults to Install, with the reason
      await page.locator('.ns-path .input').fill('C:\\Users\\you\\code\\storefront');
      await page.waitForFunction(() => /Install/.test(document.querySelector('.wt-deps [aria-pressed="true"]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      check((await page.locator('.wt-deps [aria-pressed="true"]').innerText()).startsWith('Install'), `${tag}: a 1.5 GB node_modules defaults to Install`);
      check((await page.locator('.wt-sec .wt-note').last().innerText()).includes('Copy is off by default'), `${tag}: and says why Copy is off`);
      await shot('.modal.newsess', 'dialog-storefront');
      // a folder outside any repo says so in words
      await page.locator('.ns-path .input').fill('C:\\Users\\you\\Desktop');
      await page.locator('.wt-sec .wt-err').waitFor({ timeout: 5000 });
      check((await page.locator('.wt-sec .wt-err').innerText()).includes('is not inside a git repository'), `${tag}: a non-repo folder says why`);
      // create + copy + start, back on helm
      await page.locator('.ns-path .input').fill(HELM_WT);
      await page.locator('.wt-name-input').waitFor({ timeout: 5000 });
      await page.locator('.wt-name-input').fill('fix-login');
      await page.waitForTimeout(150);
      await page.locator('.newsess .btn-primary').last().click();
      await page.locator('.modal.newsess').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
      const made = await page.evaluate(async () => (await import('/lib/store.js')).sessions.value.find((s) => /fix-login$/.test(s.cwd))?.cwd || null);
      check(made === 'C:\\Users\\you\\helm-wt\\fix-login', `${tag}: Create worktree and start opened a session in the new folder (${made})`);

      // 2. the Worktrees panel for Helm's repo
      await page.evaluate(async () => { (await import('/shell/worktrees.js')).openWorktrees('C:\\Users\\you\\helm'); });
      await page.locator('.wt-item').first().waitFor({ timeout: 5000 });
      check(await page.locator('.wt-item').count() === 6, `${tag}: main + 5 worktrees listed`);
      const row = (n) => page.locator(`.wt-item[data-wt="${n}"]`);
      check((await row('pace').locator('.wt-meta').innerText()).includes('6 ahead · 0 behind master'), `${tag}: ahead / behind its base`);
      check((await row('worktrees').innerText()).includes('4 changed'), `${tag}: the dirty flag`);
      check(await row('worktrees').locator('[data-act="merge"]').isDisabled(), `${tag}: Merge is off while dirty`);
      check((await row('worktrees').locator('.wt-why').innerText()).includes('4 uncommitted changes. Commit or discard them first'), `${tag}: and says why`);
      check((await row('restart').locator('.wt-why').innerText()).includes('would conflict in 2 files'), `${tag}: a conflict is named before the click`);
      check((await row('voice').innerText()).includes('node_modules is a link'), `${tag}: a junctioned node_modules is flagged`);
      check((await row('pace').locator('.wt-sessions').innerText()).includes('Tray icon audit'), `${tag}: the session using a worktree is listed`);
      await fits('.modal.wt-sheet', 'Worktrees panel');
      await shot('.modal.wt-sheet', 'panel');
      // Merge into Helm's own master: warning, then a second confirm
      await row('pace').locator('[data-act="merge"]').click();
      check((await row('pace').locator('.wt-confirm').innerText()).includes("Merging into Helm's own master restarts Helm and stops running sessions."), `${tag}: the restart warning shows in the confirm`);
      await row('pace').locator('[data-act="merge-go"]').click();
      await row('pace').locator('[data-act="merge-restart"]').waitFor({ timeout: 3000 });
      await row('pace').locator('.wt-confirm').scrollIntoViewIfNeeded();
      check(true, `${tag}: Merge asks a second time (Merge and restart Helm)`);
      await shot('.modal.wt-sheet', 'panel-merge2');
      await row('pace').locator('[data-act="merge-restart"]').click();
      await page.locator('.toast', { hasText: 'Merged wk/pace into master' }).waitFor({ timeout: 5000 });
      check(true, `${tag}: the merge reports itself`);
      // Remove a dirty worktree: Discard must be ticked
      await row('worktrees').locator('[data-act="remove"]').click();
      await row('worktrees').locator('.wt-confirm').scrollIntoViewIfNeeded();
      check(await row('worktrees').locator('[data-act="remove-go"]').isDisabled(), `${tag}: Remove is off until Discard changes is ticked`);
      check((await row('worktrees').locator('.wt-confirm').innerText()).includes('needs "Discard changes" ticked'), `${tag}: and says so`);
      await shot('.modal.wt-sheet', 'panel-remove');
      await row('worktrees').locator('.wt-check input').first().check();
      await row('worktrees').locator('[data-act="remove-go"]').click();
      await page.locator('.toast', { hasText: 'Removed worktrees' }).waitFor({ timeout: 5000 });
      await row('worktrees').waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
      check(await row('worktrees').count() === 0, `${tag}: the removed worktree leaves the list`);
      await page.evaluate(async () => { (await import('/shell/worktrees.js')).worktreesFor.value = null; });
      // storefront: the production refusal, before any click
      await page.evaluate(async () => { (await import('/shell/worktrees.js')).openWorktrees('C:\\Users\\you\\code\\storefront'); });
      await page.locator('.wt-item[data-wt="login-fix"]').waitFor({ timeout: 5000 });
      check(await row('login-fix').locator('[data-act="merge"]').isDisabled(), `${tag}: Merge into storefront master is off`);
      check((await row('login-fix').locator('.wt-why').innerText()).includes('storefront master is production'), `${tag}: with the production guard's words`);
      await shot('.modal.wt-sheet', 'panel-storefront');
      check(errors.length === 0, `${tag}: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
      await page.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`worktrees-shot: ${pass} passed, ${fail} failed (width ${width})`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`worktrees-shot: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
