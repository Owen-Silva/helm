require('./lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// End-to-end check of tailnet HTTPS + the installable phone app, on the user's real tailnet certificate:
//  1. starts an isolated `electron . --test --test-https-port=8443` (own profile, own port; never the user's Helm)
//  2. as the desktop window over loopback: phone.status -> phone.httpsOn (real `tailscale serve` on 8443 ->
//     this test's port) -> the serve config keeps every other handler
//  3. headless Chromium with phone emulation opens https://<MagicDNS>:8443/?key=…: the WebSocket connects
//     through the proxy as a 'web' client from the tailnet address, the service worker controls the page,
//     Chrome reports no installability errors, and the push switch is tried
//  4. phone.httpsOff -> the serve config is back to exactly what it was; the test instance is stopped
// Usage: node tools/verify-https.js [--keep-profile]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const TS = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
const HTTPS_PORT = 8443;
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const serveCfg = () => JSON.parse(execFileSync(TS, ['serve', 'status', '--json'], { encoding: 'utf8' }) || '{}');
const keysOf = (cfg) => Object.keys(cfg.Web || {}).sort().join(',') + '|' + Object.keys(cfg.TCP || {}).sort().join(',');

(async () => {
  const before = serveCfg();
  if ((before.TCP || {})[HTTPS_PORT]) throw new Error(`port ${HTTPS_PORT} is already in tailscale serve; not touching it`);
  const profile = 'https-e2e-' + process.pid;
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')), ['.', '--test', '--profile=' + profile, `--test-https-port=${HTTPS_PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let ready = null;
  for (let i = 0; i < 450 && !ready; i++) { const m = /HELM_READY (\{.*\})/.exec(out); if (m) ready = JSON.parse(m[1]); else await new Promise((r) => setTimeout(r, 100)); }
  if (!ready) throw new Error('no HELM_READY:\n' + out.slice(-1500));
  console.log(`test Helm pid ${child.pid} on 127.0.0.1:${ready.port}`);
  let ws, browser;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}`, headers: { 'user-agent': 'Mozilla/5.0 Electron/44.4.3 (verify-https)' } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0;
    const call = (method, params = {}) => new Promise((resolve) => {
      const my = ++id; const on = (raw) => { const m = JSON.parse(String(raw)); if (m.id === my) { ws.off('message', on); resolve(m); } };
      ws.on('message', on); ws.send(JSON.stringify({ id: my, type: 'rpc', method, params }));
    });
    const st0 = (await call('phone.status', { refresh: true })).result;
    record('phone.status has https + push', !!(st0 && st0.https && st0.push), `https.state=${st0 && st0.https && st0.https.state} certs=${st0 && st0.https && st0.https.certs}`);
    const t0 = Date.now();
    const on = await call('phone.httpsOn');
    const s = on.result || {};
    record('phone.httpsOn -> live, self-check answered over the real certificate', s.state === 'live' && s.probe && s.probe.ok, on.error ? on.error.message : `${s.url} -> ${s.target} in ${Date.now() - t0} ms, probe=${JSON.stringify(s.probe && { ok: s.probe.ok, status: s.probe.status, error: s.probe.error })}`);
    const mid = serveCfg();
    const mine = mid.Web && mid.Web[`${s.domain}:${HTTPS_PORT}`];
    record('serve config: our 8443 handler added, everything else kept', !!mine && mine.Handlers['/'].Proxy === `http://127.0.0.1:${ready.port}` && Object.keys(before.Web || {}).every((k) => JSON.stringify(mid.Web[k]) === JSON.stringify(before.Web[k])) && !mid.AllowFunnel, keysOf(mid));

    // ---- the phone: headless Chromium, Android Chrome emulation, real https
    const { chromium } = require('playwright-core');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    const origin = `${s.url}`;
    await ctx.grantPermissions(['notifications'], { origin });
    const resp = await page.goto(`${origin}/?key=${ready.token}`, { waitUntil: 'networkidle', timeout: 60000 });
    record('phone page loads over https', resp && resp.status() === 200, `status ${resp && resp.status()}, url key stripped: ${!page.url().includes('key=')}`);
    const secure = await page.evaluate(() => ({ secure: window.isSecureContext, proto: location.protocol }));
    record('secure context', secure.secure && secure.proto === 'https:');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload({ waitUntil: 'networkidle' });
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/'); return { scope: r && r.scope, active: !!(r && r.active), controlled: !!navigator.serviceWorker.controller }; });
    record('service worker active and controlling the page', sw.active && sw.controlled, JSON.stringify(sw));
    const cdp = await ctx.newCDPSession(page);
    const inst = await cdp.send('Page.getInstallabilityErrors').catch((e) => ({ error: e.message }));
    const mf = await cdp.send('Page.getAppManifest').catch((e) => ({ error: e.message }));
    record('Chrome: no installability errors', Array.isArray(inst.installabilityErrors) && inst.installabilityErrors.length === 0, JSON.stringify(inst.installabilityErrors || inst.error));
    record('manifest parses without errors', Array.isArray(mf.errors) && mf.errors.length === 0, `${mf.url || ''} errors=${JSON.stringify(mf.errors || mf.error)}`);
    const log = () => { try { return fs.readdirSync(path.join(userData, 'logs')).map((f) => fs.readFileSync(path.join(userData, 'logs', f), 'utf8')).join('\n'); } catch { return ''; } };
    const lines = log().split('\n').filter((l) => /client open: web via (cookie|key)/.test(l) && /tailnet https proxy/.test(l));
    record('server saw the phone as web, from its tailnet address, via the https proxy', lines.length > 0, (lines[0] || 'no such log line').replace(/^.*client open/, 'client open'));
    record('log never holds the Tailscale identity headers', !/tailscale-user-login|@gmail\.com/i.test(log()));
    // push: Settings, Phone, Turn on notifications
    await page.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true })));
    await page.waitForSelector('[data-push]', { timeout: 15000 }).catch(() => {});
    const before2 = await page.getAttribute('[data-push]', 'data-push').catch(() => null);
    const btn = await page.$('[data-push] button.btn-primary');
    if (btn) await btn.click();
    await page.waitForFunction(() => { const e = document.querySelector('[data-push]'); return e && !['busy', 'checking'].includes(e.dataset.push); }, null, { timeout: 30000 }).catch(() => {});
    const pushOut = await page.evaluate(() => { const e = document.querySelector('[data-push]'); return e ? { state: e.dataset.push, text: e.querySelector('.ph-detail').textContent } : null; });
    record('push switch: shown on the phone page', !!pushOut, `before=${before2} after=${pushOut && pushOut.state}: ${pushOut && pushOut.text}`);
    const pst = (await call('phone.status')).result.push;
    console.log(`INFO  host push status: available=${pst.available} subscribed=${pst.count}`);
    if (pst.count) { const t = (await call('push.test')).result; console.log(`INFO  push.test: ${JSON.stringify(t)}`); }
    fs.mkdirSync(path.join(ROOT, '.shots'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, '.shots', 'https-phone-393.png') });
    record('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
    await browser.close(); browser = null;

    const off = await call('phone.httpsOff');
    const after = serveCfg();
    record('phone.httpsOff -> serve config exactly as before', !off.error && JSON.stringify(after) === JSON.stringify(before), off.error ? off.error.message : keysOf(after));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { ws && ws.close(); } catch {}
    const leftover = serveCfg();
    if ((leftover.TCP || {})[HTTPS_PORT]) { try { execFileSync(TS, ['serve', '--yes', `--https=${HTTPS_PORT}`, 'off']); console.log('cleanup: removed the 8443 handler'); } catch (e) { console.log('cleanup FAILED: run tailscale serve --https=8443 off', e.message); } }
    try { process.kill(child.pid); } catch {}
    if (!process.argv.includes('--keep-profile')) setTimeout(() => { try { fs.rmSync(userData, { recursive: true, force: true }); } catch {} }, 1500);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 2000);
})().catch((e) => { console.error(e); process.exit(1); });
