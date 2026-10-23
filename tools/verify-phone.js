// Phone lane check in the REAL app, invisible to the user: Helm.exe --test (hidden window, throwaway
// profile, free port), then
//   P1 phone.status answers with the full shape from the real probes (PowerShell firewall read,
//      tailscale status); a second call inside 60 s is served from the cache (fast)
//   P2 the manifest + every icon load in the page under the real CSP: fetched with credentials
//      "omit" like a browser fetches a manifest, decoded at their declared sizes
//   P3 index.html wiring: manifest link, apple-touch-icon 180, theme-color follows the theme,
//      phone.js loaded (openFind / attentionStep / healthItems exported and behaving)
//   P4 Settings -> Phone renders the checklist from the real phone.status (captured to .shots/phone)
//   P5 zero console errors / CSP violations from the whole run (test.console)
// Stops the app BY PID (taskkill /T on the child it started), never by name.
// Usage: node tools/verify-phone.js [--exe=dist/Helm/Helm.exe] [--shots=.shots/phone]
// Owner: lane phone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const EXE = path.resolve(ROOT, arg('exe') || 'dist/Helm/Helm.exe');
const SHOTS = path.resolve(ROOT, arg('shots') || '.shots/phone');
const profile = 'vphone' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, reason) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${reason ? ' :: ' + reason : ''}`); };
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

async function start() {
  const child = spawn(EXE, ['.', '--test', '--profile=' + profile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const m = /HELM_READY (\{.*\})/.exec(out);
    if (m) {
      const ready = JSON.parse(m[1]);
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      let id = 1; const pending = new Map();
      ws.on('message', (raw) => { const msg = JSON.parse(String(raw)); if (msg.type === 'result' && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
      const call = (method, params = {}, timeout = 60000) => new Promise((resolve, reject) => {
        const i = id++;
        const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, timeout);
        pending.set(i, (r) => { clearTimeout(t); if (r.error) reject(new Error(`${method}: ${r.error.message}`)); else resolve(r.result); });
        ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      });
      return { child, ready, ws, call };
    }
    if (child.exitCode !== null) throw new Error('app exited early:\n' + out.slice(-2000));
    await sleep(250);
  }
  killTree(child.pid);
  throw new Error('no HELM_READY within 60 s:\n' + out.slice(-2000));
}

const PAGE_CHECKS = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.app'); i++) await sleep(100);
  const link = document.querySelector('link[rel="manifest"]');
  out.manifestHref = link && link.getAttribute('href');
  const r = await fetch('/manifest.webmanifest', { credentials: 'omit', cache: 'no-store' });
  out.manifestStatus = r.status; out.manifestType = r.headers.get('content-type');
  const m = await r.json();
  out.manifest = { name: m.name, short_name: m.short_name, display: m.display, start_url: m.start_url, theme: m.theme_color, bg: m.background_color };
  const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res({ src, w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res({ src, error: true }); im.src = src; });
  const touch = document.querySelector('link[rel="apple-touch-icon"]');
  out.icons = await Promise.all([...m.icons.map((i) => load(i.src).then((x) => ({ ...x, sizes: i.sizes, purpose: i.purpose }))), load(touch.getAttribute('href')).then((x) => ({ ...x, sizes: touch.getAttribute('sizes'), purpose: 'apple-touch' }))]);
  const meta = document.querySelector('meta[name="theme-color"]');
  out.themeColor = meta && meta.getAttribute('content');
  out.bgToken = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const ph = await import('/shell/phone.js');
  out.exports = ['openFind', 'FindButton', 'PhoneHealth', 'healthItems', 'attentionStep', 'copyText'].filter((k) => typeof ph[k] === 'function');
  const prev = new Map([['a', 'working'], ['b', 'waiting']]);
  out.attention = ph.attentionStep([{ id: 'a', status: 'waiting' }, { id: 'b', status: 'waiting' }, { id: 'c', status: 'idle' }], prev);
  out.attentionSeed = ph.attentionStep([{ id: 'a', status: 'waiting' }], null);
  out.title = document.title;
  return out;
})()`;

const SETTINGS_CHECKS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = await import('/shell/state.js');
  st.go('settings');
  let rows = [];
  for (let i = 0; i < 300; i++) { rows = [...document.querySelectorAll('.ph-item')]; if (rows.length >= 4) break; await sleep(100); }
  const sec = document.getElementById('set-phone');
  if (sec) sec.scrollIntoView();
  await sleep(300);
  return {
    sum: (document.querySelector('.ph-health-sum') || {}).textContent || null,
    rows: rows.map((r) => ({ id: r.dataset.check, state: r.className.replace('ph-item', '').trim(), title: (r.querySelector('.ph-title') || {}).textContent })),
    startupShown: !!document.getElementById('set-startup'),
  };
})()`;

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('no exe at ' + EXE);
  fs.mkdirSync(SHOTS, { recursive: true });
  const A = await start();
  console.log(`app up: pid ${A.child.pid} port ${A.ready.port}`);
  try {
    // P1
    try {
      const t0 = Date.now();
      const s = await A.call('phone.status', {}, 60000);
      const first = Date.now() - t0;
      const t1 = Date.now();
      await A.call('phone.status');
      const second = Date.now() - t1;
      const keys = ['tailscaleUp', 'boundAddresses', 'port', 'expectedPort', 'portIsFallback', 'firewallRule', 'httpsAvailable', 'magicDnsName', 'url'];
      const missing = keys.filter((k) => !(k in s));
      const ok = !missing.length && s.expectedPort === 4871 && ['present', 'missing', 'unknown'].includes(s.firewallRule)
        && Array.isArray(s.boundAddresses) && s.boundAddresses.includes('127.0.0.1') && s.port === A.ready.port && second < 1000;
      record('P1 phone.status shape + cache', ok, `missing=[${missing}] firewall=${s.firewallRule} (${s.firewallDetail}) tailscaleUp=${s.tailscaleUp} https=${s.httpsAvailable} dns=${s.magicDnsName} port=${s.port} fallback=${s.portIsFallback} first=${first}ms cached=${second}ms`);
    } catch (e) { record('P1 phone.status shape + cache', false, e.message); }

    // P2 + P3
    try {
      const r = await A.call('test.eval', { js: PAGE_CHECKS }, 60000);
      const bad = r.icons.filter((i) => i.error || `${i.w}x${i.h}` !== i.sizes);
      record('P2 manifest + icons load under the real CSP', r.manifestStatus === 200 && /manifest\+json/.test(r.manifestType) && r.manifest.display === 'standalone' && r.icons.length === 4 && !bad.length,
        `status=${r.manifestStatus} type=${r.manifestType} icons=${r.icons.map((i) => `${i.purpose}:${i.w}x${i.h}`).join(',')} bad=${JSON.stringify(bad)}`);
      const att = r.attention;
      record('P3 index.html wiring + phone.js', r.manifestHref === '/manifest.webmanifest' && r.themeColor.toLowerCase() === r.bgToken.toLowerCase() && r.exports.length === 6
        && att.count === 2 && att.started.join() === 'a' && r.attentionSeed.started.length === 0 && r.title === 'Helm',
        `theme-color=${r.themeColor} --bg=${r.bgToken} exports=${r.exports.length}/6 attention=${JSON.stringify(att)} title=${r.title} (desktop window: no count)`);
    } catch (e) { record('P2/P3 page checks', false, e.message); }

    // P4
    try {
      const s = await A.call('test.eval', { js: SETTINGS_CHECKS }, 60000);
      // (re-)open Settings right before the capture: a reload in between (another lane saving a ui/ file) resets the view
      await A.call('test.eval', { js: "import('/shell/state.js').then(async (m) => { m.go('settings'); for (let i = 0; i < 50 && !document.getElementById('set-phone'); i++) await new Promise((r) => setTimeout(r, 100)); document.getElementById('set-phone')?.scrollIntoView(); return true; })" });
      const cap = await A.call('test.capture', { file: path.join(SHOTS, 'real-settings-phone.png'), waitMs: 1500 }, 30000);
      const ids = s.rows.map((r) => r.id);
      record('P4 Settings -> Phone checklist from the real status', ['tailscale', 'port', 'firewall', 'phone', 'https'].every((k) => ids.includes(k)) && s.startupShown && !cap.empty,
        `${s.sum} | ${s.rows.map((r) => `${r.id}:${r.state}`).join(' ')} | startup shown on desktop=${s.startupShown} | shot ${path.relative(ROOT, cap.file)} ${cap.width}x${cap.height}`);
    } catch (e) { record('P4 settings checklist', false, e.message); }

    // P5
    try {
      // prove the console pipe is live: a warning (not counted as bad) must come through
      await A.call('test.eval', { js: "console.warn('verify-phone probe'); true" });
      await sleep(500);
      const c = await A.call('test.console', { since: 0 });
      if (!c.entries.some((e) => /verify-phone probe/.test(e.message))) throw new Error('test.console did not see the probe warning: the console check would be blind');
      const isCsp = (e) => /Content Security Policy|Refused to (execute|load|apply|evaluate|create|connect|frame)/i.test(e.message);
      const bad = c.entries.filter((e) => e.level === 'error' || e.level === 'crash' || isCsp(e) || /Uncaught|unhandled/i.test(e.message));
      record('P5 zero console errors / CSP violations', bad.length === 0, `${c.entries.length} console entries, ${bad.length} bad${bad.length ? ': ' + bad.slice(0, 5).map((e) => e.message.slice(0, 160)).join(' | ') : ''}`);
    } catch (e) { record('P5 console', false, e.message); }
  } finally {
    try { A.ws.close(); } catch {}
    killTree(A.child.pid);
    try { fs.rmSync(path.join(os.tmpdir(), 'helm-test-' + profile), { recursive: true, force: true }); } catch {}
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify-phone: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
