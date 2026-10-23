// Test-mode RPC hooks (main.js passes them to the router only with --test). Used by
// tools/e2e.js (test.capture) and tools/desktop-check.js (the Electron-only features:
// preview <webview>, notification click, overlay badge + flash, tray, close-to-tray,
// drag strip, quick prompt, login item). Never loaded in the user's real instance.
// Owner: lane host (B).
const fs = require('fs');
const path = require('path');

function rpcError(message, code) { return Object.assign(new Error(message), { code }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createTestHooks(ctx)
 *   ctx: { electron, getWindow, quick, hotkey, notifier, hostEmit, selectSession, previewPartition,
 *          record: { openedExternal, overlay, flash, selects }, userDataDir, loginItemOptions, exe, appDir, log }
 */
function createTestHooks(ctx) {
  const { electron, getWindow, quick, hotkey, notifier, hostEmit, previewPartition, record, userDataDir, log = () => {} } = ctx;
  const { webContents: allWc, session: esession, globalShortcut, app } = electron;
  const mainWin = () => { const w = getWindow(); if (!w || w.isDestroyed()) throw rpcError('no window', 'unsupported'); return w; };

  // Renderer console + load failures from EVERY webContents (main window, quick box, webviews) from the
  // first load on, so CSP violations and uncaught page errors under the real server's CSP are visible to
  // tools/verify-round3.js (test.console). Electron 44 passes one event object; older ones positional args.
  const consoleLog = [];
  let consoleBase = 0;   // index of consoleLog[0] in the overall stream (old entries get dropped)
  const watched = new WeakSet();
  const LEVELS = ['verbose', 'info', 'warning', 'error'];
  const where = (wc) => { try { return wc.getType() + ' ' + String(wc.getURL() || '').replace(/token=[^&]+/, 'token=…').replace(/^https?:\/\/127\.0\.0\.1:\d+/, ''); } catch { return '?'; } };
  const push = (wc, level, message, source, line) => {
    consoleLog.push({ t: Date.now(), wc: wc.id, where: where(wc), level, message: String(message).slice(0, 3000), source: source ? String(source).replace(/^https?:\/\/127\.0\.0\.1:\d+/, '') : '', line: line || 0 });
    if (consoleLog.length > 6000) { consoleLog.splice(0, 1000); consoleBase += 1000; }
  };
  const watch = (wc) => {
    if (!wc || watched.has(wc)) return;
    watched.add(wc);
    wc.on('console-message', (e, lvl, msg, line, src) => {
      const level = typeof e?.level === 'string' ? e.level : (LEVELS[lvl] || String(lvl));
      push(wc, level, e?.message ?? msg, e?.sourceId ?? src, e?.lineNumber ?? line);
    });
    wc.on('render-process-gone', (_e, d) => push(wc, 'crash', 'render-process-gone: ' + (d && d.reason)));
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (code !== -3) push(wc, 'error', `did-fail-load ${code} ${desc} ${String(url).replace(/token=[^&]+/, 'token=…')}${isMain ? ' (main frame)' : ''}`); });
    wc.on('preload-error', (_e, p, err) => push(wc, 'error', `preload-error ${p}: ${err && err.message}`));
  };
  for (const wc of allWc.getAllWebContents()) watch(wc);
  app.on('web-contents-created', (_e, wc) => watch(wc));

  return {
    // Console entries from index `since` on: { entries, next } (pass `next` back as `since`).
    'test.console': async (p = {}) => {
      const since = Math.max(consoleBase, Number(p.since) || 0);
      return { entries: consoleLog.slice(since - consoleBase), next: consoleBase + consoleLog.length };
    },

    // Evaluate in the main window's page (or the quick box with target:'quick'); awaits a returned promise.
    'test.eval': async (p = {}) => {
      const w = p.target === 'quick' ? quick.window() : mainWin();
      if (!w) throw rpcError('no quick window', 'unsupported');
      return w.webContents.executeJavaScript(String(p.js || 'null'), true);
    },

    'test.capture': async (p = {}) => {
      const win = mainWin();
      const out = path.resolve(String(p.file || path.join(userDataDir, 'capture.png')));
      const wc = win.webContents;
      if (p.sessionId) await wc.executeJavaScript(`import('/lib/store.js').then((m) => { m.selectSession(${JSON.stringify(String(p.sessionId))}); return true; })`);
      await sleep(Math.min(10000, p.waitMs === 0 ? 0 : (Number(p.waitMs) || 2000)));
      const r = p.rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(p.rect[k])) ? p.rect : undefined;   // optional crop (tab-drag-check)
      const img = await wc.capturePage(r);
      fs.writeFileSync(out, img.toPNG());
      const size = img.getSize();
      return { file: out, width: size.width, height: size.height, empty: img.isEmpty() };
    },

    'test.hostState': async () => {
      const w = getWindow();
      const q = quick.window();
      const tray = notifier.trayInfo ? notifier.trayInfo() : null;
      const accel = hotkey.current();
      return {
        window: w && !w.isDestroyed() ? { visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), hwnd: w.getNativeWindowHandle().readBigUInt64LE().toString() } : null,
        quick: q ? { visible: q.isVisible(), alwaysOnTop: q.isAlwaysOnTop(), bounds: q.getBounds(), url: q.webContents.getURL().replace(/token=[^&]+/, 'token=…') } : null,
        hotkey: { current: accel, registered: accel ? globalShortcut.isRegistered(accel) : false },
        tray, waiting: notifier.waitingCount(),
        // main/badge.js: flush its debounce so the overlay record is current; badge = { count, waiting, errors }
        badge: ctx.badge ? (ctx.badge.flush(), (({ count, waiting, errors }) => ({ count, waiting, errors }))(ctx.badge.state())) : null,
        overlay: record.overlay.slice(-10), flash: record.flash.slice(-10), selects: record.selects.slice(-10), openedExternal: record.openedExternal.slice(-10),
        exe: process.execPath, pid: process.pid, appName: app.getName(), userData: app.getPath('userData'),
      };
    },

    // Push an event through the same hub the engine uses (e.g. a session going "waiting").
    'test.emit': async (p = {}) => { hostEmit(String(p.event), p.data); return {}; },

    // Real input through Chromium's input pipeline (webContents.sendInputEvent): mouse / key events in order,
    // each optionally followed by `waitMs`. Used by tools/tab-drag-check.js (lane tabsmooth) to drive a tab drag.
    'test.input': async (p = {}) => {
      const wc = mainWin().webContents;
      const events = Array.isArray(p.events) ? p.events.slice(0, 2000) : [];
      for (const ev of events) {
        const { waitMs, ...e } = ev || {};
        wc.sendInputEvent(e);
        if (waitMs) await sleep(Math.min(2000, Number(waitMs) || 0));
      }
      return { sent: events.length };
    },

    // Run the exact click handler a desktop notification runs.
    'test.notificationClick': async (p = {}) => { notifier.handleClick({ title: 'test', sessionId: p.sessionId || null }); await sleep(300); return {}; },

    // Show one REAL Windows toast through the notifier's path and report whether Windows took it.
    'test.toast': async (p = {}) => {
      const r = await notifier.showToast({ title: String(p.title || 'Helm test notification'), body: String(p.body || 'Safe to ignore: a Helm self-test.'), kind: 'info', sessionId: p.sessionId || null }, { closeAfterMs: Number(p.closeAfterMs) || 1500 });
      return r;
    },

    'test.closeWindow': async () => { const w = mainWin(); w.close(); await sleep(400); const x = getWindow(); return { destroyed: !x || x.isDestroyed(), visible: !!(x && !x.isDestroyed() && x.isVisible()) }; },
    'test.showWindow': async () => { ctx.showWindow(); await sleep(300); const x = getWindow(); return { visible: !!(x && x.isVisible()) }; },

    'test.quick': async (p = {}) => {
      const a = p.action || 'state';
      if (a === 'toggle') quick.toggle(); else if (a === 'show') quick.show(); else if (a === 'hide') quick.hide();
      else if (a === 'warm') quick.warm();   // load it hidden (nothing appears on screen)
      if (a !== 'state') await sleep(Number(p.waitMs) || 600);
      const q = quick.window();
      if (!q) return { exists: false, visible: false };
      const out = { exists: true, visible: q.isVisible(), focused: q.isFocused(), alwaysOnTop: q.isAlwaysOnTop(), bounds: q.getBounds() };
      if (p.eval) out.eval = await q.webContents.executeJavaScript(String(p.eval));
      if (p.capture) { const img = await q.webContents.capturePage(); fs.writeFileSync(path.resolve(String(p.capture)), img.toPNG()); out.capture = { ...img.getSize(), empty: img.isEmpty() }; }
      return out;
    },

    // Computed -webkit-app-region of the drag strip and its buttons in the real window.
    'test.dragRegion': async () => mainWin().webContents.executeJavaScript(`(() => {
      const reg = (el) => el ? (getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion || '').trim() : null;
      const strip = document.querySelector('.strip');
      const btns = [...document.querySelectorAll('.strip .strip-btn, .strip button, .strip input, .rail .rail-btn')];
      return { strip: reg(strip), rail: reg(document.querySelector('.rail')), buttons: btns.map((b) => ({ cls: b.className, region: reg(b) })), stripHeight: strip ? strip.getBoundingClientRect().height : null };
    })()`),

    // Mount a <webview> the way ui/panels/preview.js does (plus hostile attributes the host must
    // override), load p.url, then inspect the guest from the main process.
    'test.webview': async (p = {}) => {
      const win = mainWin();
      const url = String(p.url || '');
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw rpcError('test.webview wants a 127.0.0.1 URL', 'bad_params');
      const before = new Set(allWc.getAllWebContents().map((w) => w.id));
      await win.webContents.executeJavaScript(`(() => {
        const el = document.createElement('webview');
        el.setAttribute('partition', 'persist:evil');
        el.setAttribute('nodeintegration', '');
        el.setAttribute('webpreferences', 'contextIsolation=no, sandbox=no');
        el.setAttribute('src', ${JSON.stringify(url)});
        el.id = 'helm-test-webview';
        el.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:500px;z-index:99999';
        document.body.appendChild(el);
        return true;
      })()`);
      let guest = null;
      for (let i = 0; i < 50 && !guest; i++) {
        await sleep(200);
        guest = allWc.getAllWebContents().find((w) => !before.has(w.id) && w.getType() === 'webview') || null;
      }
      if (!guest) throw rpcError('webview never attached', 'internal');
      if (guest.isLoading()) await new Promise((r) => { guest.once('did-finish-load', r); setTimeout(r, 8000); });
      await sleep(Number(p.settleMs) || 800);
      const prefs = guest.getLastWebPreferences ? guest.getLastWebPreferences() : null;
      const inside = await guest.executeJavaScript(`({ require: typeof require, process: typeof process, module: typeof module, title: document.title, text: document.body ? document.body.innerText.slice(0, 200) : '' })`);
      const img = await guest.capturePage();
      const bmp = img.toBitmap();
      let nonBlank = 0; for (let i = 0; i < bmp.length; i += 4 * 37) if (bmp[i] < 250 || bmp[i + 1] < 250 || bmp[i + 2] < 250) nonBlank++;
      if (p.capture) fs.writeFileSync(path.resolve(String(p.capture)), img.toPNG());
      const opened0 = record.openedExternal.length;
      // a target=_blank link and window.open: both must go to the (stubbed) shell.openExternal
      // separate calls: each popup consumes the click's transient activation
      await guest.executeJavaScript(`(() => { const a = document.querySelector('a[target=_blank]'); if (a) a.click(); return true; })()`, true);
      await sleep(300);
      await guest.executeJavaScript(`(() => { window.open('https://example.com/from-window-open'); return true; })()`, true);
      await sleep(800);
      const result = {
        partitionIsPreview: guest.session === esession.fromPartition(previewPartition),
        partitionIsEvil: guest.session === esession.fromPartition('persist:evil'),
        prefs: prefs ? { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, preload: prefs.preload || null } : null,
        inside, capture: { ...img.getSize(), empty: img.isEmpty(), nonBlankSamples: nonBlank },
        openedExternal: record.openedExternal.slice(opened0),
        childWindows: electron.BrowserWindow.getAllWindows().length,
      };
      await win.webContents.executeJavaScript(`document.getElementById('helm-test-webview')?.remove(), true`);
      return result;
    },

    // Real login-item round trip under a test name (HKCU Run value "HelmTest"), removed again.
    'test.loginItem': async () => {
      const opts = ctx.loginItemOptions({ enabled: true, exe: ctx.exe(), appDir: ctx.appDir, name: 'HelmTest' });
      app.setLoginItemSettings(opts);
      const on = app.getLoginItemSettings({ path: opts.path, args: opts.args, name: 'HelmTest' });
      let regValue = null;
      try { regValue = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'HelmTest'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => /HelmTest/.test(l)).trim(); } catch (e) { regValue = 'reg query failed: ' + e.message; }
      app.setLoginItemSettings({ ...opts, openAtLogin: false, enabled: false });
      const off = app.getLoginItemSettings({ path: opts.path, args: opts.args, name: 'HelmTest' });
      log('test.loginItem', JSON.stringify({ on: on.openAtLogin, off: off.openAtLogin }));
      return { options: opts, regValue, on: { openAtLogin: on.openAtLogin, executableWillLaunchAtLogin: on.executableWillLaunchAtLogin, launchItems: on.launchItems }, off: { openAtLogin: off.openAtLogin, launchItems: off.launchItems } };
    },
  };
}

module.exports = { createTestHooks };
