// Installer CI only (tools/installer-ci-test.ps1): drives an INSTALLED Helm started with --test, over its own
// test RPC (main/test-hooks.js), to prove the UI renders from the installed files and that Settings > Helm shows
// the installed build's Updates row: the real GitHub check, then a simulated "new version" state (row + chip),
// captured at 1280, 393 and 320 px wide.
//
//   node tools/installer-ui-check.js <ready.json> <out dir> <folder holding the ws package>
//
// Prints one summary line: UI_CHECK PASS|FAIL ... Owner: lane installer.
'use strict';
const fs = require('fs');
const path = require('path');

const [readyFile, outDir, wsDir] = process.argv.slice(2);
const WebSocket = require(path.resolve(wsDir));
const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = [];
function fail(m) { console.log(`UI_CHECK FAIL: ${m}${notes.length ? ` (so far: ${notes.join(' | ')})` : ''}`); process.exit(1); }

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: `http://127.0.0.1:${ready.port}` });
    let id = 1;
    const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    ws.once('open', () => resolve({
      call: (method, params = {}) => new Promise((res, rej) => {
        const i = id++;
        const t = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timed out`)); }, 30000);
        pending.set(i, (m) => { clearTimeout(t); if (m.error) rej(Object.assign(new Error(m.error.message || JSON.stringify(m.error)), { code: m.error.code })); else res(m.result); });
        ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      }),
      close: () => ws.close(),
    }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, r) => reject(new Error(`websocket refused: HTTP ${r.statusCode}`)));
  });
}

(async () => {
  const c = await connect();
  const evalJs = (js) => c.call('test.eval', { js });
  // 1. the UI mounted from the installed files
  let nodes = 0, text = 0;
  for (let i = 0; i < 40; i++) {
    const r = await evalJs('({ nodes: document.querySelectorAll("body *").length, text: document.body.innerText.trim().length })');
    nodes = r.nodes; text = r.text;
    if (nodes > 50 && text > 20) break;
    await sleep(500);
  }
  if (nodes <= 50 || text <= 20) {
    // why: the renderer console, the page, and any resource that did not load
    const con = await c.call('test.console', {}).catch((e) => ({ entries: [`test.console failed: ${e.message}`] }));
    const page = await evalJs('({ url: location.href, html: document.documentElement.outerHTML.slice(0, 1500), bad: performance.getEntriesByType("resource").filter((e) => e.responseStatus && e.responseStatus !== 200).map((e) => `${e.responseStatus} ${e.name}`).slice(0, 20) })').catch((e) => ({ error: e.message }));
    fs.writeFileSync(path.join(outDir, 'ui-console.json'), JSON.stringify({ console: con.entries, page }, null, 2));
    console.log('console:', JSON.stringify((con.entries || []).slice(0, 12)).slice(0, 3000));
    console.log('failed resources:', JSON.stringify(page.bad || page.error));
    fail(`the UI did not render (${nodes} elements, ${text} characters of text)`);
  }
  notes.push(`UI rendered (${nodes} elements)`);
  await c.call('test.capture', { file: path.join(outDir, 'ui-home-1280.png'), waitMs: 1500 });

  // 2. Settings > Helm with the real update check (GitHub releases; no published release yet = "none")
  const rel = await c.call('app.checkUpdates');
  if (!rel || rel.mode !== 'installer' || !rel.phase) fail(`app.checkUpdates answered ${JSON.stringify(rel)}`);
  notes.push(`update check: ${rel.phase}${rel.reason ? ` (${rel.reason})` : ''}${rel.latest ? ` latest ${rel.latest.version}` : ''}`);
  await evalJs('import("/shell/update.js").then((m) => { m.openHelmSettings(); return true; })');
  await sleep(1500);
  const rowText = async () => evalJs('(() => { const r = document.querySelector(".upd-release"); return r ? r.innerText.replace(/\\s+/g, " ").trim() : null; })()');
  const real = await rowText();
  if (!real) fail('Settings > Helm has no Updates row (.upd-release)');
  notes.push(`Updates row: "${real}"`);
  const runRow = await evalJs('(() => { const r = [...document.querySelectorAll(".set-row")].find((x) => /^Running/.test(x.innerText)); return r ? r.innerText.replace(/\\s+/g, " ").trim() : null; })()');
  notes.push(`Running row: "${runRow}"`);
  const toggle = await evalJs('!![...document.querySelectorAll(".set-row")].find((x) => /Restart automatically when Helm updates/.test(x.innerText))');
  if (toggle) fail('the git-commit auto-restart toggle shows in an installed build');
  await c.call('test.capture', { file: path.join(outDir, 'ui-updates-real-1280.png'), waitMs: 500 });

  // 3. a simulated newer release: the row offers the installer, and the chip appears
  const fake = { ...rel, phase: 'available', reason: null, detail: null, checkedAt: Date.now(),
    latest: { version: '9.9.9', tag: 'v9.9.9', name: 'Helm 9.9.9', url: 'https://github.com/Owen-Silva/helm/releases', download: 'https://github.com/Owen-Silva/helm/releases/latest/download/Helm-Setup.exe', publishedAt: new Date().toISOString() } };
  await c.call('test.emit', { event: 'app.update', data: { release: fake } });
  await sleep(800);
  const avail = await rowText();
  if (!/9\.9\.9/.test(avail || '') || !/Download the installer/.test(avail || '')) fail(`the Updates row did not offer 9.9.9: "${avail}"`);
  const chip = await evalJs('(() => { const r = document.querySelector(".upd-chip"); return r ? r.innerText.replace(/\\s+/g, " ").trim() : null; })()');
  if (!chip || !/Update available/.test(chip)) fail(`no "Update available" chip (got ${JSON.stringify(chip)})`);
  notes.push(`simulated 9.9.9: row "${avail}", chip "${chip}"`);
  for (const w of [1280, 393, 320]) {
    await c.call('test.resize', { width: w, height: w === 1280 ? 800 : 760 });
    await evalJs('import("/shell/update.js").then((m) => { m.openHelmSettings(); return true; })');
    await c.call('test.capture', { file: path.join(outDir, `ui-updates-available-${w}.png`), waitMs: 1200 });
  }
  const con = await c.call('test.console', {});
  const errs = (con.entries || []).filter((e) => /error/i.test(String(e.level || e.type || '')) || /Uncaught|Failed to load/i.test(String(e.message || e.text || '')));
  fs.writeFileSync(path.join(outDir, 'ui-console.json'), JSON.stringify(con.entries || [], null, 2));
  notes.push(`console errors: ${errs.length}`);
  c.close();
  console.log(`UI_CHECK PASS: ${notes.join(' | ')}`);
  process.exit(0);
})().catch((e) => fail(e && e.stack || String(e)));
