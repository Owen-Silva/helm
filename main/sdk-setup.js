// Installed builds only: the "Getting Helm ready" window that downloads the Claude Agent SDK on first run
// (main/sdk-fetch.js does the work; this shows it). main.js runs it before the engine starts, and only when
// main/distribution.js says this is an installed build; a checkout never gets here.
//
// - SDK already downloaded and intact: no window at all (one small hash check of the entry file).
// - Otherwise a small window shows what is downloaded and from where, a progress bar, then "Checking",
//   "Unpacking", "Loading". A failure shows the reason in plain words plus the technical detail, with
//   Try again and Quit Helm. Closing the window = Quit. Helm never starts without the SDK and never hides why.
// - --test: the same window parked off-screen; progress goes to the log (stdout in test runs); a failure
//   captures the window (capture path) and resolves { ok:false } so main.js exits 1.
// Owner: lane installer.
'use strict';
const path = require('path');
const fs = require('fs');
const { ensureSdk, sdkStatus, readPin, defaultSdkRoot, resolveRegistry, describeError } = require('./sdk-fetch');

const CH_STATE = 'sdk-setup:state';
const CH_ACTION = 'sdk-setup:action';

const mb = (n) => (n == null ? '?' : `${(n / 1048576).toFixed(1)} MB`);

/**
 * electron: the electron module; pkg: the app's package.json (helmSdk pin); log(...); test; capture: PNG path (test).
 * Resolves { ok: true, sdk, dispose } (dispose() closes the hidden window once the main window exists),
 * { ok: false, quit: true } (the user quit) or, in test runs, { ok: false, error }.
 */
async function prepareSdk({ electron, pkg, log = () => {}, test = false, capture = null, icon = null, dark = true, importer = (u) => import(u) }) {
  const { BrowserWindow, ipcMain, net, shell } = electron;
  let pin = null, pinError = null;
  try { pin = readPin(pkg); } catch (e) { pinError = e; }
  const root = defaultSdkRoot();
  if (pin) {
    const st = sdkStatus(root, pin);
    if (st.ok) { log(`sdk: ${pin.name}@${pin.version} (downloaded ${st.marker && st.marker.fetchedAt}) in ${st.dir}`); return { ok: true, sdk: st, dispose: () => {} }; }
    log(`sdk: ${pin.name}@${pin.version} needed: ${st.reason}`);
  }
  const registry = resolveRegistry();
  const host = (() => { try { return new URL(registry.url).host; } catch { return registry.url; } })();
  const base = { version: pin ? pin.version : null, name: pin ? pin.name : '@anthropic-ai/claude-agent-sdk', host, registry: registry.url, source: registry.source, dir: root };

  const win = new BrowserWindow({
    width: 560, height: 380, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'Helm', show: false, autoHideMenuBar: true, backgroundColor: dark ? '#1e1f22' : '#f4f4f5',
    ...(icon && fs.existsSync(icon) ? { icon } : {}),
    ...(test ? { x: -20000, y: -20000 } : { center: true }),
    webPreferences: { preload: path.join(__dirname, 'sdk-setup', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.setMenu(null);
  // the page's only links (Anthropic's Claude Code docs, the npm page) open in the browser; a test opens nothing
  win.webContents.setWindowOpenHandler(({ url }) => { if (!test && /^https:\/\//i.test(url)) shell.openExternal(url); else log('sdk-setup: link not opened', url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  let last = { ...base, phase: pinError ? 'failed' : 'starting', ...(pinError ? { code: pinError.code, reason: pinError.reason, detail: pinError.detail, canRetry: false } : {}) };
  const send = (s) => { last = s; if (!win.isDestroyed()) win.webContents.send(CH_STATE, s); };

  return new Promise((resolve) => {
    let busy = false, settled = false, lastLog = 0, lastPhase = '';
    const settle = (r) => { if (settled) return; settled = true; ipcMain.removeListener(CH_ACTION, onAction); resolve(r); };
    const shoot = async () => {
      if (!capture || win.isDestroyed()) return;
      try { await new Promise((r) => setTimeout(r, 400)); const img = await win.webContents.capturePage(); fs.writeFileSync(capture, img.toPNG()); log(`sdk-setup: captured ${capture}`); } catch (e) { log('sdk-setup: capture failed', e); }
    };
    const progress = (p) => {
      send({ ...base, ...p, phase: p.phase });
      const t = Date.now();
      if (p.phase !== lastPhase || t - lastLog > 1000) { lastPhase = p.phase; lastLog = t; log(`sdk: ${p.phase}${p.phase === 'downloading' ? ` ${mb(p.received)} of ${mb(p.total)}` : ''}`); }
    };
    const verify = async (url) => { const m = await importer(url); if (!m || typeof m.query !== 'function') throw new Error('the package has no query() export'); };
    const run = async () => {
      if (busy || !pin) return;
      busy = true;
      try {
        const sdk = await ensureSdk({ pin, root, registry, fetch: (u, o) => net.fetch(u, o), onProgress: progress, verify, log });
        send({ ...base, phase: 'ready', received: sdk.bytes, total: sdk.bytes });
        log(`HELM_SDK ${JSON.stringify({ phase: 'ready', version: sdk.version, dir: sdk.dir, bytes: sdk.bytes, fetched: sdk.fetched })}`);
        if (test) await shoot();
        // let "Ready" show for a moment; hidden, not closed, so no window-all-closed quit before the main window exists
        setTimeout(() => {
          if (!win.isDestroyed()) win.hide();
          settle({ ok: true, sdk, dispose: () => { if (!win.isDestroyed()) win.destroy(); } });
        }, test ? 0 : 700);
      } catch (e0) {
        const e = describeError(e0, { host });
        log(`sdk: download failed (${e.code}): ${e.reason} [${e.detail || ''}]`);
        log(`HELM_SDK_FAILED ${JSON.stringify({ code: e.code, reason: e.reason, detail: e.detail })}`);
        send({ ...base, phase: 'failed', code: e.code, reason: e.reason, detail: e.detail, canRetry: true });
        if (test) { await shoot(); settle({ ok: false, error: e }); }
      } finally { busy = false; }
    };
    function onAction(ev, action) {
      if (win.isDestroyed() || ev.sender !== win.webContents) return;
      if (action === 'retry') run();
      else if (action === 'quit') settle({ ok: false, quit: true });
      else if (action === 'hello') send(last);
    }
    ipcMain.on(CH_ACTION, onAction);
    win.on('closed', () => settle({ ok: false, quit: true }));
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      log(`sdk-setup: page failed to load (${code} ${desc})`);
      electron.dialog.showErrorBox('Helm could not start', `Helm needs to download the Claude Agent SDK, but its setup window failed to load (${desc}). Reinstall Helm.`);
      settle({ ok: false, quit: true });
    });
    win.webContents.once('did-finish-load', () => {
      send(last);
      if (test) win.showInactive(); else win.show();
      if (pinError) { log(`sdk: ${pinError.reason} [${pinError.detail}]`); if (test) shoot().then(() => settle({ ok: false, error: pinError })); return; }
      run();
    });
    win.loadFile(path.join(__dirname, 'sdk-setup', 'index.html')).catch(() => {}); // did-fail-load reports it
  });
}

module.exports = { prepareSdk, CH_STATE, CH_ACTION };
