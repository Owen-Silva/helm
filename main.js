// Helm: Electron main process. Hosts the UI over HTTP + WebSocket (main/server.js) so the
// desktop window and the phone (over Tailscale) run the same UI, routes RPC (main/rpc.js),
// and owns the window, tray, notifications, settings, files and the overnight queue.
//
// Flags:
//   --test                hidden window, throwaway profile under %TEMP%, port 0, no tray/notifications
//   --profile=<name>      test profile name (default "default") -> %TEMP%\helm-test-<name>
//   --capture=<file.png>  (test) capture the rendered window to a PNG once the UI has loaded
//   --port=<n>            listen port (default 4871; test default 0 = any free port)
//   --fallback-engine     force the stand-in engine (main/engine-fallback.js)
//   --hidden              start in the tray without showing the window (e.g. at login)
//   --session=<id>        show the window on that session (also from a second launch)
//   --quick               open the quick-prompt box (also from a second launch)
//   --test-desktop        (test) real desktop behaviour in the throwaway profile: tray, close-to-tray,
//                         global hotkey, Tailscale bind; used by tools/desktop-check.js
//   --exit-when-ready     (test) exit once ready (installed builds: after loading the downloaded SDK);
//                         used by the installer's CI install test
//   --sdk-capture=<png>   (test, installed builds) capture the "Getting Helm ready" window when it finishes
//
// The user runs it as dist/Helm/Helm.exe "<this folder>" (tools/make-exe.js: Electron renamed and
// stamped with ui/assets/icon.ico), so Windows shows Helm's own name and icon everywhere.
// Owner: lane host (B).
const { app, BrowserWindow, Menu, shell, dialog, screen, globalShortcut, session: esession, nativeTheme } = require('electron');
const electron = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('./package.json');
// lane installer: a build made by the Windows installer (main/distribution.js), never a checkout or the make-exe
// launcher. Only then: the Claude Agent SDK is downloaded on first run (main/sdk-setup.js) and updates come from
// GitHub releases (main/release-check.js). Everything else runs exactly as in a checkout.
const INSTALLED = require('./main/distribution').isInstalledBuild({ pkg, appDir: __dirname, resourcesPath: process.resourcesPath });

// ---------- flags + profile (before anything touches userData) ----------
const argv = process.argv.slice(1);
const flag = (name) => argv.includes('--' + name);
const opt = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const TEST = flag('test');
if (!TEST) delete process.env.HELM_TEST_EXTERNAL_DIRS; // test-only extra Elsewhere folders (main/engine/external.js)
// test-only (main/update.js): watch this repo instead of Helm's own, let a --test run really relaunch
// itself, and shorter timings ({"pollMs","quietMs","gateMs","confirmMs","inputQuietMs"} JSON)
if (!TEST) for (const k of ['HELM_TEST_UPDATE_REPO', 'HELM_TEST_ALLOW_RESTART', 'HELM_TEST_UPDATE_TIMING']) delete process.env[k];
const flags = {
  test: TEST,
  profile: (opt('profile') || 'default').replace(/[^A-Za-z0-9_-]/g, ''),
  capture: opt('capture'),
  port: opt('port') != null ? Number(opt('port')) : TEST ? 0 : 4871,
  fallbackEngine: flag('fallback-engine'),
  hidden: flag('hidden'),
  testDesktop: TEST && flag('test-desktop'),
  // test-only: let this --test run set up tailnet HTTPS for real, on this one https port (never 443),
  // pointed at its own loopback port (main/https.js). Without it a test run never changes tailscale serve.
  testHttpsPort: TEST && /^\d{2,5}$/.test(opt('test-https-port') || '') && Number(opt('test-https-port')) !== 443 ? Number(opt('test-https-port')) : null,
};
const DESKTOP = !TEST || flags.testDesktop; // tray, close-to-tray, global hotkey, Tailscale
const { launcherExe, loginItemOptions, createLoginItem, parseLaunchArgs } = require('./main/launch');
const launchArgs = parseLaunchArgs(argv);
const ICON_DIR = path.join(__dirname, 'ui', 'assets');
const ICON_ICO = path.join(ICON_DIR, 'icon.ico');
const helmExe = () => launcherExe(__dirname, process.execPath);

app.setName('Helm');
// --test (but not --test-desktop) renders in a REAL shown window parked far off-screen instead of a
// never-shown one: a show:false window got ~1 frame a second from the compositor and test.capture
// returned the previous frame (measured 2026-10-08: 1 fps / stale -> 60 fps / fresh). Occlusion
// tracking is off so a locked or covered screen can't throttle it either. The user's window is untouched.
const OFFSCREEN_TEST_WINDOW = TEST && !flags.testDesktop;
if (OFFSCREEN_TEST_WINDOW) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const AUMID = 'com.owensilva.helm';
app.setAppUserModelId(AUMID);

// Helm launched from inside a Claude Code terminal inherits that session's identity; the
// claude processes Helm starts must be fresh top-level sessions, not children of it.
const INHERITED_CLAUDE_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT'];
const strippedEnv = INHERITED_CLAUDE_ENV.filter((k) => k in process.env);
for (const k of strippedEnv) delete process.env[k];

// `electron . --install-shortcut`: Start Menu "Helm" shortcut carrying the AUMID (Windows
// attributes toasts to it and groups the taskbar button). Runs and exits; no window.
if (flag('install-shortcut')) {
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Helm.lnk');
  // Target Helm.exe when it's built (its own icon resource), else this Electron + icon.ico.
  const exe = helmExe();
  const stamped = path.basename(exe).toLowerCase() === 'helm.exe';
  const icon = stamped ? exe : fs.existsSync(ICON_ICO) ? ICON_ICO : exe;
  const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
    target: exe, args: `"${__dirname}"`, cwd: __dirname, appUserModelId: AUMID,
    description: 'Helm: desktop + phone deck for Claude Code', icon, iconIndex: 0,
  });
  let back = {};
  try { back = shell.readShortcutLink(lnk); } catch {}
  console.log(ok ? `HELM_SHORTCUT ${JSON.stringify({ lnk, target: back.target || exe, args: back.args, icon: back.icon || icon, appUserModelId: back.appUserModelId || null })}` : 'HELM_SHORTCUT_FAILED');
  app.exit(ok ? 0 : 1);
}
const userDataDir = TEST ? path.join(os.tmpdir(), 'helm-test-' + flags.profile) : path.join(app.getPath('appData'), 'Helm');
fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

// ---------- log ----------
const logDir = path.join(userDataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'main.log');
try { if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch {}
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  if (TEST || !app.isPackaged) console.log(line);
}
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

if (!app.requestSingleInstanceLock()) {
  // a restart's relaunch must never land here (performRestart releases the lock before it exits); say so if it does
  if (fs.existsSync(path.join(userDataDir, 'restart.json'))) log('restart: another Helm still holds the single-instance lock; this relaunch exits');
  app.quit(); process.exit(0);
}

// A restart (main/update.js auto, Settings / chip / palette / tray / phone) leaves restart.json for the
// next process: the commit(s) it restarted into (the "Helm restarted" toast) and how the window was
// (hidden in the tray stays hidden; shown-but-not-focused does not steal focus). Read once, then removed.
const RESTART_FILE = path.join(userDataDir, 'restart.json');
const BOOTED_AT = Date.now();
let restartedFrom = null;
try {
  const r = JSON.parse(fs.readFileSync(RESTART_FILE, 'utf8'));
  if (r && typeof r.at === 'number' && BOOTED_AT - r.at < 5 * 60_000) restartedFrom = r;
} catch {}
try { fs.rmSync(RESTART_FILE, { force: true }); } catch {}
let bootWindowMode = restartedFrom ? restartedFrom.window : null; // first window only
if (restartedFrom) log(`restarted (${restartedFrom.auto ? 'update' : `by ${restartedFrom.by || 'hand'}`}) from ${String(restartedFrom.from || '').slice(0, 7)} into ${String(restartedFrom.to || '').slice(0, 7)}; window ${restartedFrom.window}`);

const { startServer } = require('./main/server');
const { createRouter } = require('./main/rpc');
const { createFiles } = require('./main/files');
const { createSettings } = require('./main/settings');
const { createAccount } = require('./main/account');
const { createLook } = require('./main/look');
const { createTopRow, hwndOf } = require('./main/toprow');   // top-row hints to Mantle's top bar
const { createQueue } = require('./main/queue');
const { createNotifier } = require('./main/notify');
const { createBadge } = require('./main/badge');
const { loadToken, tailscaleIPv4, tailscaleDnsName } = require('./main/net');
const { createPhoneHealth } = require('./main/phone');
const { createTailnetHttps } = require('./main/https');
const { createPush, loadWebPush } = require('./main/push');
const { createQuickWindow, createHotkey, quickMethods } = require('./main/quick');
const { createTestHooks } = require('./main/test-hooks');
const { createVoice } = require('./main/voice');   // voice input: local Whisper worker (lane voice)

const UI_DIR = path.join(__dirname, 'ui');
const PREVIEW_PARTITION = 'persist:helm-preview';
const TITLEBAR_HEIGHT = 40;

let win = null;
let server = null;
let engine = null;
let settings = null;
let auth = null;      // how claude children reach Claude (main/account.js): Claude Code's own sign-in, or the user's saved API key
let queue = null;
let notifier = null;
let badge = null;     // "needs you" count: taskbar overlay + <userData>/badge.json for Mantle (main/badge.js)
let quitting = false;
let tailscaleIp = null;
// This PC's Tailscale IPv4 as last read from the adapters. os.networkInterfaces() is a synchronous walk of every
// adapter (6-110 ms measured on the user's laptop), and Settings > Phone asked for it on every open, in the same turn as
// its process starts (lane helm-settings-freeze). refreshTailscale reads it every 60 s anyway, so the checklist
// reuses that reading (same 60 s as its other checks, main/phone.js CACHE_MS); Check again reads it fresh.
let tsIpRead = null;   // { at, ip }
function tailscaleIpNow({ fresh = false } = {}) {
  if (fresh || !tsIpRead || Date.now() - tsIpRead.at > 65_000) tsIpRead = { at: Date.now(), ip: tailscaleIPv4() };
  return tsIpRead.ip;
}
let quick = null;     // quick-prompt box (main/quick.js)
let hotkey = null;    // its global hotkey
let voice = null;     // voice input engine (main/voice.js): Python worker, started on first use
let loginItem = null; // settings.launchAtLogin -> Windows login item
let tailnetHttps = null; // tailscale serve -> https://<MagicDNS name>/ for the phone (main/https.js)
let push = null;         // Web Push to the phone (main/push.js)
let look = null;         // Look Sync with Quartz + Mantle (main/look.js; ~/look-sync/CONTRACT.md)
let toprow = null;       // top-row hints to Mantle (main/toprow.js; look-sync CONTRACT "Top-row hints")
let winHwnd = null;      // the main window's decimal HWND (the hints' key)
let placementOverride = null; // test.placement: a fake window/monitor placement (the --test window is off-screen)
const knownNames = new Set(); // this PC's MagicDNS names seen so far (the server's Host guard; sticky across a failed lookup)
const token = loadToken(userDataDir);
// Test mode keeps a record of the desktop side effects for tools/desktop-check.js.
const record = { overlay: [], flash: [], selects: [], openedExternal: [], loginItem: [] };

// ---------- event hub: everything the engine and host modules emit goes to every client ----------
function hostEmit(event, data) {
  if (server) server.broadcast(event, data);
  try { settings && settings.onEngineEvent(event, data); } catch (e) { log('settings hook', e); }
  try { queue && queue.onEngineEvent(event, data); } catch (e) { log('queue hook', e); }
  try { notifier && notifier.onEngineEvent(event, data); } catch (e) { log('notifier hook', e); }
  try { badge && badge.onEngineEvent(event, data); } catch (e) { log('badge hook', e); }
  if (event === 'notify' && push) pushNotify(data);
  if (event === 'settings.updated') { applySettings(data); if (updater) updater.refresh(); }
}

// The same notices notify.js toasts on the desktop, to the phone (policy: main/push.js pushDecision).
function windowFocused() { return !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()); }
function pushNotify(n) {
  if (!settings || (settings.get().phone || {}).enabled === false) return;
  push.notify(n, { prefs: settings.get().notifications || {}, windowFocused: windowFocused() })
    .catch((e) => log('push notify', e && e.message ? e.message : e));
}

// ---------- engine (real one if lane engine's code loads, else the stand-in) ----------
let engineReason = null; // why the fallback engine runs (app.hello -> the UI banner)
function loadEngine() {
  if (flags.fallbackEngine) engineReason = 'Started with --fallback-engine';
  if (!flags.fallbackEngine) {
    try {
      const mod = require('./main/engine');
      if (typeof mod.createEngine !== 'function') throw new Error('main/engine has no createEngine export');
      return { mod, kind: 'real' };
    } catch (e) {
      const missing = e.code === 'MODULE_NOT_FOUND' && /main[\\/]engine/.test(e.message.split('\n')[0]);
      log(missing ? 'main/engine not present yet; using the fallback engine' : 'main/engine failed to load; using the fallback engine', missing ? '' : e);
      engineReason = missing ? 'main/engine is missing' : `main/engine failed to load: ${e.message.split('\n')[0]}`;
    }
  }
  return { mod: require('./main/engine-fallback'), kind: 'fallback' };
}

// ---------- window state ----------
const stateFile = path.join(userDataDir, 'window-state.json');
let winState = {};
try { winState = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch {}
function saveWinState() { try { fs.writeFileSync(stateFile, JSON.stringify(winState, null, 2)); } catch {} }

function initialBounds() {
  const b = winState.bounds;
  const def = { width: 1440, height: 900 };
  if (!b || TEST) return def;
  // keep it only if it's still mostly on a connected display
  const area = screen.getDisplayMatching(b).workArea;
  const visibleW = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const visibleH = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  if (visibleW < 200 || visibleH < 120) return def;
  return { x: b.x, y: b.y, width: Math.max(900, b.width), height: Math.max(600, b.height) };
}

// ---------- Look Sync lining up (desktop window only; the phone has no placement) ----------
// placement = { content: {x, y, width, height}, display: {x, y, width, height, scaleFactor} } in DIPs:
// the window's content area on screen and the monitor it is mostly on (where Mantle draws the wallpaper).
function windowPlacement() {
  if (placementOverride) return placementOverride;
  if (!win || win.isDestroyed()) return null;
  try {
    const content = win.getContentBounds();
    const d = screen.getDisplayMatching(win.getBounds());
    return { content, display: { ...d.bounds, scaleFactor: d.scaleFactor } };
  } catch { return null; }
}
function sendPlacement() {
  if (!win || win.isDestroyed()) return;
  const p = windowPlacement();
  if (p) win.webContents.send('helm:placement', p);
}
electron.ipcMain.handle('helm:placement-get', (e) => (win && !win.isDestroyed() && e.sender === win.webContents ? windowPlacement() : null));
// test.placement { content, display }: pretend the window sits there; {} clears it (tools/look-check.js)
async function testPlacement(p = {}) {
  placementOverride = p && p.content && p.display ? { content: { ...p.content }, display: { scaleFactor: 1, ...p.display } } : null;
  sendPlacement();
  return { placement: windowPlacement() };
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) || 0);
// renderer -> main, fire-and-forget: the main window's top row as it is about to be painted (preload helmNative.topRow)
electron.ipcMain.on('helm:toprow', (e, top) => {
  if (!toprow || !win || win.isDestroyed() || e.sender !== win.webContents || !winHwnd) return;
  toprow.set(winHwnd, top);
});
const toprowState = () => (toprow ? toprow.state() : { state: 'off', reason: 'Not started', connected: false, sent: 0, windows: 0 });

function themeColors(theme) {
  const dark = theme === 'light' ? false : theme === 'dark' ? true : nativeTheme.shouldUseDarkColors;
  return dark ? { bg: '#1d1f22', symbol: '#e4e5e7' } : { bg: '#f4f6fa', symbol: '#0b0e1a' };   // light = island ground + ink (look-sync "Light look")
}

function isOwnUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' && x.hostname === '127.0.0.1' && server && Number(x.port) === server.port; } catch { return false; }
}
function openExternal(u) {
  try {
    const x = new URL(u);
    if (!['http:', 'https:', 'mailto:'].includes(x.protocol)) return;
    if (TEST) { record.openedExternal.push(x.href); log('openExternal (test, not opened):', x.href); return; } // never open the user's browser from a test
    shell.openExternal(x.href);
  } catch {}
}

// Bring the window up on a session: the window's own store selects it, and every client gets
// `app.select` (PROTOCOL events) so a UI that listens for it follows too.
function selectSession(id) {
  showWindow();
  if (!id || typeof id !== 'string') return;
  if (TEST) record.selects.push(id);
  if (server) server.broadcast('app.select', { sessionId: id });
  const w = win;
  if (!w || w.isDestroyed()) return;
  const run = () => w.webContents.executeJavaScript(`import('/lib/store.js').then((m) => { m.selectSession(${JSON.stringify(id)}); return true; })`)
    .catch((e) => log('select session in window failed:', e.message));
  // a window that is still booting picks its own session after app.hello; select after that
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(run, 1500)); else run();
}

function createWindow() {
  const colors = themeColors(settings.get().theme);
  // Off-screen test window: no monitor at -20000, no taskbar button (skipTaskbar), never activated
  // (focusable:false = WS_EX_NOACTIVATE), and out of Alt+Tab / Task View (type toolbar = WS_EX_TOOLWINDOW).
  const offscreenTest = OFFSCREEN_TEST_WINDOW ? { x: -20000, y: -20000, skipTaskbar: true, focusable: false, type: 'toolbar' } : {};
  win = new BrowserWindow({
    ...initialBounds(), ...offscreenTest,
    minWidth: 900, minHeight: 600,
    show: false,
    title: 'Helm',
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : notifier && notifier.appIcon ? notifier.appIcon.img : undefined,
    backgroundColor: colors.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: colors.symbol, height: TITLEBAR_HEIGHT },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
      backgroundThrottling: !TEST,
    },
  });
  if (OFFSCREEN_TEST_WINDOW) win.showInactive();
  // Top-row hints: until the page paints, the window shows its backgroundColor; the renderer replaces this hint
  // with the real row in the same task as its first paint (ui/shell/toprow.js)
  winHwnd = hwndOf(win);
  if (toprow && winHwnd) toprow.set(winHwnd, { kind: 'flat', rgb: hexRgb(colors.bg) });
  // maximize() also SHOWS a hidden window: a --hidden start (login item, a restart while in the tray)
  // maximizes when it is first shown instead (showWindow)
  const startHidden = flags.hidden || bootWindowMode === 'hidden';
  if (winState.maximized && !TEST && !startHidden) win.maximize();
  // "Pin to taskbar" on the running window stores THIS command (not a bare Helm.exe), with Helm's icon.
  if (process.platform === 'win32' && !TEST) {
    try { win.setAppDetails({ appId: AUMID, appIconPath: ICON_ICO, relaunchCommand: `"${process.execPath}" "${__dirname}"`, relaunchDisplayName: 'Helm' }); } catch (e) { log('setAppDetails failed:', e.message); }
  }

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!isOwnUrl(url)) { e.preventDefault(); openExternal(url); } });
  wc.on('will-attach-webview', (_e, prefs, params) => {
    // The Preview pane's <webview>: no node, no preload, its own partition, always.
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    // Electron copies params.partition into webPreferences BEFORE this event, so the partition
    // must be forced here (setting params.partition alone did nothing: desktop-check caught a
    // <webview partition="persist:evil"> getting its own session).
    prefs.partition = PREVIEW_PARTITION;
    params.partition = PREVIEW_PARTITION;
    // Let link clicks that open a new window (target=_blank, window.open after a click) reach the
    // window-open handler below, which denies them and hands http(s) links to the real browser.
    // Without this a <webview> without `allowpopups` drops them silently.
    prefs.disablePopups = false;
  });
  wc.on('render-process-gone', (_e, d) => log('renderer gone', d.reason));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || quitting) return;
    log('load failed', code, desc, url);
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(windowUrl()); }, 1500);
  });
  wc.on('before-input-event', (e, input) => {
    // a key in the desktop window is the user's input for the auto-restart gate even if the page runs older
    // UI code that does not report app.input (pointer and phone input come from the UI)
    if (input.type === 'keyDown') lastInputAt = Date.now();
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) { wc.toggleDevTools(); e.preventDefault(); }
  });

  // After a restart the window comes back the way it was: shown-but-not-focused (the user was in another app)
  // or minimized must not steal focus; hidden in the tray stays hidden (startHidden).
  const mode = bootWindowMode;
  bootWindowMode = null;
  if (!TEST && !startHidden) win.once('ready-to-show', () => {
    if (mode === 'shown' || mode === 'minimized') { win.showInactive(); if (mode === 'minimized') win.minimize(); }
    else win.show();
  });

  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      winState.maximized = win.isMaximized();
      if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) winState.bounds = win.getBounds();
      saveWinState();
    }, 400);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('focus', () => { win.flashFrame(false); if (look) look.refresh(); });  // fs.watch can drop events
  // Look Sync lining up: the window's content area + its monitor, sent on every move/resize (the UI
  // moves its pre-blurred wallpaper layer per animation frame; it never re-blurs for a move)
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, sendPlacement);
  win.webContents.on('did-finish-load', sendPlacement);
  // maximize / fullscreen change the geometry, not the look: the same TOP again with a new seq, at once (a lined-up
  // 'cols' row that moves with the screen is re-sent by the renderer when its new placement lands)
  for (const ev of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => { if (toprow && winHwnd) toprow.resend(winHwnd); });

  win.on('close', (e) => {
    if (quitting || !DESKTOP) return;
    e.preventDefault();
    hideToTray();
  });
  win.on('closed', () => { if (toprow && winHwnd) toprow.forget(winHwnd); winHwnd = null; win = null; });

  win.loadURL(windowUrl());
}

function windowUrl() { return `http://127.0.0.1:${server.port}/?token=${token}`; }

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  winState.maximized = win.isMaximized();
  if (!win.isMaximized() && !win.isMinimized()) winState.bounds = win.getBounds();
  win.hide();
  if (!winState.trayHintShown && !TEST) {
    winState.trayHintShown = true;
    notifier && notifier.info('Helm is still running', 'Sessions keep working in the background. Right-click the tray icon to quit.');
  }
  saveWinState();
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); if (badge) badge.refreshWindow(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible() && winState.maximized && !win.isMaximized() && !TEST) win.maximize();
  win.show();
  win.focus();
  win.flashFrame(false);
}

function quit() { quitting = true; app.quit(); }

const windowCtl = {
  // the off-screen test window must never be maximized onto the user's monitor (or minimized into a throttled state)
  minimize: () => { if (OFFSCREEN_TEST_WINDOW) return log('window.minimize ignored (off-screen test window)'); win && win.minimize(); },
  maximize: () => { if (OFFSCREEN_TEST_WINDOW) return log('window.maximize ignored (off-screen test window)'); win && (win.isMaximized() ? win.unmaximize() : win.maximize()); },
  close: () => hideToTray(),
  devtools: () => win && win.webContents.toggleDevTools(),
  // older palette path (app.window { action: 'restart' }); the UI now calls app.restart. Checked like it (lane restart).
  restart: () => windowRestart(),
};

// ---------- restart + updates (main/update.js; PROTOCOL "Restart + updates") ----------
const { createUpdater, restartBlockers: blockersOf, keptWork, gitOpInProgress, dirtyFiles } = require('./main/update');
const UPDATE_REPO = (TEST && process.env.HELM_TEST_UPDATE_REPO) || __dirname;
let updateTiming = {};
try { if (TEST && process.env.HELM_TEST_UPDATE_TIMING) updateTiming = JSON.parse(process.env.HELM_TEST_UPDATE_TIMING) || {}; } catch {}
let updater = null;
let releaseCheck = null; // lane installer: main/release-check.js, installed builds only
let restarting = false;
// The user's input in any Helm window or the phone (app.input, throttled by the UI) and unsent composer
// attachments per desktop client (attachments are not saved like drafts, so a restart would drop them).
let lastInputAt = 0;
const clientAttachments = new Map(); // client -> count

// Idle CLI close (main/engine/idle-reaper.js): Settings "Close idle sessions after" (minutes, 0 = never).
// A --test run can override the window in ms (test.idleClose; tools/e2e.js S18).
let testIdleMs = null;
function idleCloseMs() {
  if (testIdleMs !== null) return testIdleMs;
  const min = settings ? Number(settings.get().closeIdleAfterMin) : NaN;
  return (Number.isFinite(min) && min >= 0 ? min : 15) * 60_000;
}
// test.idleClose({ idleMs?, everyMs?, sweep? }) -> engine.idleReaper.info(): { idleMs, closed, resumed, sessions: [{ id, live, pid, busy }] }
async function testIdleClose(p = {}) {
  if (!engine || !engine.idleReaper) throw Object.assign(new Error('this engine has no idle reaper'), { code: 'unsupported' });
  if (p.idleMs !== undefined) testIdleMs = p.idleMs === null ? null : Math.max(0, Number(p.idleMs) || 0);
  if (p.everyMs !== undefined) engine.idleReaper.setEvery(Number(p.everyMs));
  if (p.sweep) engine.idleReaper.sweep();
  return engine.idleReaper.info();
}

// Engines without busy() (the stand-in): read what it can from the snapshot.
async function busySessions() {
  if (engine && typeof engine.busy === 'function') return engine.busy();
  const snap = (engine && (await engine.snapshot())) || {};
  return (snap.sessions || []).filter((s) => s.status === 'working' || s.status === 'waiting' || s.agentsRunning > 0 || s.queued > 0)
    .map((s) => ({ id: s.id, working: s.status === 'working', waiting: s.status === 'waiting', agents: s.agentsRunning || 0, queued: s.queued || 0 }));
}

// Every reason not to restart right now (empty = clear). manual: the Restart button / tray / palette.
// strict ("Restart when finished"): sessions a restart would keep running count too (lane detach).
async function restartReasons({ manual = false, strict = false } = {}) {
  return (await restartState({ manual, strict })).reasons;
}
// -> { reasons, kept }: kept = what keeps running through a restart now (lane detach; [] when keeping is off)
async function restartState({ manual = false, strict = false } = {}) {
  const gitDir = updater && updater.gitDir;
  let attachments = 0;
  for (const n of clientAttachments.values()) attachments += n;
  const sessions = await busySessions();
  const reasons = blockersOf({
    sessions,
    queueRunning: queue ? queue.list().filter((j) => j.status === 'running').length : 0,
    gitOp: gitOpInProgress(gitDir),
    dirty: gitDir ? await dirtyFiles(UPDATE_REPO) : null,
    now: Date.now(), lastInputAt, inputQuietMs: updateTiming.inputQuietMs, attachments,
    autoRestart: !settings || settings.get().autoRestart !== false,
  }, { manual, strict });
  return { reasons, kept: strict ? [] : keptWork({ sessions }) };
}

// lane detach: Settings > Helm "Keep sessions running through a restart" (default off). HELM_DETACH=1 / =0 overrides.
function keepThroughRestart() {
  if (process.env.HELM_DETACH === '1') return true;
  if (process.env.HELM_DETACH === '0') return false;
  return !!(settings && settings.get().keepSessionsThroughRestart === true);
}

// Quit through the normal path (shutdown closes every CLI; sessions resume on their next send) and
// start again. Returns false when this run may not restart (a --test run without the test switch).
// forced: the reasons the user confirmed past ("Restart now" while something ran), logged so a cut-off is traceable.
function performRestart({ auto = false, by = 'desktop', to = null, commits = null, forced = null, deferred = false } = {}) {
  if (TEST && !process.env.HELM_TEST_ALLOW_RESTART) { log(`restart (${by}) ignored (--test)`); return false; }
  if (restarting) return true;
  restarting = true;
  const p = updater && updater.pendingInfo();
  const windowMode = !win || win.isDestroyed() || !win.isVisible() ? 'hidden' : win.isMinimized() ? 'minimized' : win.isFocused() ? 'focused' : 'shown';
  const info = {
    at: Date.now(), auto, by, window: windowMode,
    from: updater ? updater.running.sha : null,
    to: to || (p && p.to) || (updater ? updater.running.sha : null),
    commits: (commits || (p && p.commits) || []).slice(0, 10),
  };
  try { fs.writeFileSync(RESTART_FILE, JSON.stringify(info)); } catch (e) { log('restart.json not written', e); }
  log(`restart (${auto ? 'update' : by}${deferred ? ', when finished' : ''}) -> ${String(info.to || '').slice(0, 7)}; window ${windowMode}${forced && forced.length ? `; confirmed past: ${forced.join(' · ')}` : ''}`);
  hostEmit('app.restarting', { at: info.at, auto, by });
  // the relaunched Helm comes back hidden if it was in the tray; launch links are not replayed
  // (a relative app folder such as "." becomes absolute: the relaunch need not start in this cwd)
  const args = process.argv.slice(1).filter((a) => a !== '--hidden' && !/^helm:/i.test(a))
    .map((a) => (!a.startsWith('-') && path.resolve(a) === path.resolve(__dirname) ? __dirname : a));
  if (windowMode === 'hidden') args.push('--hidden');
  setTimeout(() => { log('restart: relaunch', JSON.stringify([process.execPath, ...args])); app.relaunch({ execPath: process.execPath, args }); quit(); }, 300); // let the RPC answer and the event go out first
  return true;
}

// Tray "Restart Helm": no UI to confirm in, so a native dialog names what would be cut off.
async function trayRestart() {
  const { reasons, kept } = await restartState({ manual: true });
  if (!reasons.length && kept.length) {
    // lane detach: nothing would be cut off, but work is running: restart under it, or wait for it
    const r = await dialog.showMessageBox({
      type: 'info', title: 'Restart Helm', message: 'Sessions keep running through the restart', buttons: ['Restart now', 'Restart when finished', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
      detail: `Still running: ${kept.join(', ')}. With "Keep sessions running through a restart" on, Helm restarts around them and re-attaches; nothing is stopped.\n\n"Restart when finished" waits until nothing is running at all.`,
    });
    if (r.response === 1) { if (updater) updater.restartWhenIdle({ by: 'tray' }); return; }
    if (r.response !== 0) return;
  } else if (reasons.length) {
    const r = await dialog.showMessageBox({
      type: 'warning', title: 'Restart Helm', message: 'Helm is still working', buttons: ['Restart when finished', 'Restart now', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
      detail: `Restarting now stops: ${reasons.join(', ')}.${kept.length ? `\nKept running through it: ${kept.join(', ')}.` : ''}\n\n"Restart when finished" waits until nothing is running. After a restart now, each session that was cut off lists what stopped, with Continue.`,
    });
    if (r.response === 0) { if (updater) updater.restartWhenIdle({ by: 'tray' }); return; }
    if (r.response !== 1) return;
  }
  performRestart({ auto: false, by: 'tray', forced: reasons });
}

// The legacy app.window { action: 'restart' } path goes through the same check as app.restart (it used to restart
// with no check at all).
async function windowRestart() {
  const reasons = await restartReasons({ manual: true });
  if (reasons.length) throw Object.assign(new Error(`Helm is busy: ${reasons.join(' · ')}`), { code: 'busy', reasons });
  performRestart({ auto: false, by: 'desktop' });
}

const restartMethods = {
  // lane installer: 'Check now' in Settings > Helm. Installed builds only; a checkout updates with git.
  'app.checkUpdates': async () => {
    if (!releaseCheck) throw Object.assign(new Error('Helm checks GitHub releases only when it was installed with the installer; this copy is a git checkout.'), { code: 'not_installed' });
    return releaseCheck.check();
  },
  // { force?, whenIdle?, cancel? } -> { restarting: true } | { deferred: true, reasons } | { cancelled }, or error
  // `busy` naming what a restart would cut off. whenIdle: "Restart when finished" (waits on the same check).
  'app.restart': async (p, client) => {
    const by = client && client.platform === 'electron' ? 'desktop' : 'phone';
    if (p && p.cancel === true) return { cancelled: !!(updater && updater.cancelWhenIdle()) };
    const reasons = await restartReasons({ manual: true });
    if (reasons.length && p && p.whenIdle === true) {
      if (!updater) throw Object.assign(new Error('Helm cannot wait to restart yet (still starting)'), { code: 'unsupported' });
      updater.restartWhenIdle({ by });
      return { restarting: false, deferred: true, reasons };
    }
    if (reasons.length && !(p && p.force === true)) throw Object.assign(new Error(`Helm is busy: ${reasons.join(' · ')}`), { code: 'busy', reasons });
    if (!performRestart({ auto: false, by, forced: reasons })) throw Object.assign(new Error('This test run does not restart itself'), { code: 'unsupported' });
    return { restarting: true };
  },
  // -> { reasons } what a restart now would cut off (the Restart button's confirm)
  // kept: what keeps running through it (lane detach: "Keep sessions running through a restart"); the confirm
  // offers "Restart when finished" for those too
  'app.restartCheck': async () => { const { reasons, kept } = await restartState({ manual: true }); return { reasons, kept }; },
  // The user's input (keys, pointer, typing) from any window or the phone, throttled by the UI
  'app.input': async (p, client) => {
    if (!p || p.input !== false) lastInputAt = Date.now();
    // typing a draft for a session keeps its CLI from being closed as idle (main/engine/idle-reaper.js)
    if (p && typeof p.draft === 'string' && engine && typeof engine.noteActivity === 'function') engine.noteActivity(p.draft);
    if (client && client.platform === 'electron' && p && p.attachments !== undefined) {
      const n = Math.max(0, Math.min(99, Number(p.attachments) | 0));
      if (n) clientAttachments.set(client, n); else clientAttachments.delete(client);
    }
    return {};
  },
  'app.updateState': async () => updater ? updater.state() : null,
};

// ---------- phone: health, tailnet https, push (PROTOCOL "Phone over HTTPS", "Push") ----------
function rpcErr(message, code) { return Object.assign(new Error(message), { code }); }
const desktopOnly = (client, what) => { if (!client || client.platform !== 'electron') throw rpcErr(`${what} is only available in the desktop app`, 'unsupported'); };
function phoneMethods(phoneHealth) {
  const httpsStatus = (force) => tailnetHttps.status({ probe: true, force }).catch((e) => ({ state: 'unknown', detail: String(e && e.message || e) }));
  return {
    // { refresh? } -> the checklist inputs (main/phone.js) + https (main/https.js) + push (main/push.js)
    //   + this client's own transport ({ secure, proxied }) so the phone can tell which link it came in on
    'phone.status': async (p, client) => {
      const [health, https] = await Promise.all([phoneHealth.status({ refresh: !!(p && p.refresh) }), httpsStatus(!!(p && p.refresh))]);
      return { ...health, https, push: push.status(), client: { secure: !!(client && client.secure), proxied: !!(client && client.proxied) } };
    },
    // -> https status; sets up `tailscale serve --bg --https=<443|8443> http://127.0.0.1:<port>` (desktop window only)
    'phone.httpsOn': async (_p, client) => {
      desktopOnly(client, 'Turning on HTTPS');
      const s = await tailnetHttps.enable();
      await refreshTailscale().catch((e) => log('tailscale', e));
      return s;
    },
    // -> https status; `tailscale serve --https=<port> off` for Helm's own handler only (desktop window only)
    'phone.httpsOff': async (_p, client) => {
      desktopOnly(client, 'Turning off HTTPS');
      const s = await tailnetHttps.disable();
      await refreshTailscale().catch((e) => log('tailscale', e));
      return s;
    },
    // { visible } from a phone page: no push while one is open and visible
    'phone.visible': async (p, client) => { if (client && client.platform !== 'electron') push.setVisible(client.id, !!(p && p.visible)); return {}; },
    // -> { publicKey } the VAPID key the phone's service worker subscribes with
    'push.key': async () => ({ publicKey: push.publicKey() }),
    // { subscription: PushSubscription.toJSON(), label? } -> { id, subscribed, count }
    'push.subscribe': async (p, client) => {
      if (client && client.platform === 'electron') throw rpcErr('the desktop app does not take push; it shows its own notifications', 'unsupported');
      if (client && !client.secure) throw rpcErr('push needs the https link (Settings, Phone)', 'unsupported');
      return push.subscribe(p && p.subscription, { label: p && p.label });
    },
    // { endpoint } (the phone itself) or { id } (Settings list) -> { removed, count }
    'push.unsubscribe': async (p) => push.unsubscribe((p && (p.id || p.endpoint)) || ''),
    // -> { sent, failed, removed, results: [{ id, ok, status?, error? }] } a test push to every subscribed phone
    'push.test': async () => {
      const st = push.status();
      if (!st.available) throw rpcErr(`Push is unavailable: ${st.reason}`, 'unavailable');
      if (!st.count) throw rpcErr('No phone has turned on notifications yet. On the phone, open the https link and tap Turn on notifications.', 'no_subscribers');
      const r = await push.send({ title: 'Helm test notification', body: 'Push from your PC works. Tap to open Helm.', kind: 'test', tag: 'helm-test' }, { ttl: 300, urgency: 'high' });
      return { sent: r.sent, failed: r.failed, removed: r.removed, results: r.results.map(({ id, ok, status, error }) => ({ id, ok, status: status || null, error: error || null })) };
    },
  };
}

// ---------- settings side effects ----------
let lastTheme = null;
let lastPhoneEnabled = null;
function applySettings(s) {
  if (!s) return;
  if (hotkey && DESKTOP) hotkey.apply(s.quickPromptHotkey);
  if (loginItem) loginItem.apply(s.launchAtLogin);
  if (s.theme !== lastTheme) {
    lastTheme = s.theme;
    if (win && !win.isDestroyed()) {
      const c = themeColors(s.theme);
      try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: c.symbol, height: TITLEBAR_HEIGHT }); win.setBackgroundColor(c.bg); } catch {}
    }
  }
  const enabled = !(s.phone && s.phone.enabled === false);
  if (lastPhoneEnabled !== null && enabled !== lastPhoneEnabled) refreshTailscale().catch((e) => log('tailscale refresh', e));
  lastPhoneEnabled = enabled;
}
nativeTheme.on('updated', () => { if (settings && settings.get().theme === 'system') { lastTheme = null; applySettings(settings.get()); } });

// Bind/unbind the Tailscale address and keep settings.phone.url current.
let lastDnsIp = null, dnsName = null;
async function refreshTailscale() {
  if (!server || !settings) return;
  const enabled = settings.get().phone.enabled !== false;
  const ip = DESKTOP ? tailscaleIpNow({ fresh: true }) : null;
  if (tailscaleIp && (ip !== tailscaleIp || !enabled)) { await server.unbindHost(tailscaleIp); log('unbound', tailscaleIp); tailscaleIp = null; }
  if (ip && enabled && !tailscaleIp) {
    if (await server.bindHost(ip)) { tailscaleIp = ip; log(`listening on Tailscale ${ip}:${server.port}`); }
  }
  if (ip && ip !== lastDnsIp) { lastDnsIp = ip; dnsName = await tailscaleDnsName(); }
  if (dnsName) knownNames.add(dnsName.toLowerCase());
  const hostName = dnsName || tailscaleIp;
  const httpUrl = enabled && tailscaleIp && hostName ? `http://${hostName}:${server.port}/?key=${token}` : null;
  // Tailnet HTTPS (tailscale serve, set up from Settings, Phone): the QR becomes https://<name>/ and the
  // plain-http link stays as the fallback. Read-only here; only phone.httpsOn / httpsOff change serve.
  let httpsBase = null;
  if (tailnetHttps && (DESKTOP || flags.testHttpsPort)) {
    const h = await tailnetHttps.refresh().catch((e) => { log('tailnet https', e); return null; });
    for (const n of tailnetHttps.names()) knownNames.add(n.toLowerCase());
    if (h && h.state === 'live' && enabled) httpsBase = h.url;
  }
  if (httpsBase) settings.setPhoneUrl(`${httpsBase}/?key=${token}`, httpUrl);
  else settings.setPhoneUrl(httpUrl);
}

// ---------- permissions ----------
function lockDownSessions() {
  const own = esession.defaultSession;
  own.setPermissionRequestHandler((wc, permission, cb, details) => {
    const fromUs = isOwnUrl(details.requestingUrl || wc.getURL());
    cb(fromUs && ['clipboard-read', 'clipboard-sanitized-write', 'media', 'fullscreen', 'notifications'].includes(permission));
  });
  const preview = esession.fromPartition(PREVIEW_PARTITION);
  preview.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  }
});

// ---------- helm:// links ----------
// helm://session/<id> and helm://quick (parsed by main/launch.js, at start and from a second launch).
// Registered for the stamped Helm.exe only, never from a test run or a bare electron.exe dev run.
function registerProtocol() {
  if (TEST || !DESKTOP) return;
  try {
    const exe = helmExe();
    if (!/helm\.exe$/i.test(exe)) return;
    if (app.isDefaultProtocolClient('helm', exe, [__dirname])) return;
    const ok = app.setAsDefaultProtocolClient('helm', exe, [__dirname]);
    log(`helm:// protocol ${ok ? 'registered' : 'NOT registered'} for ${exe}`);
  } catch (e) { log('helm:// protocol', e); }
}

// ---------- boot ----------
// A second launch (Start Menu, `helm`, the login item) focuses this one and hands over its args.
app.on('second-instance', (_e, args) => {
  const a = parseLaunchArgs(args);
  log('second launch', JSON.stringify(a));
  if (a.quick && quick) { quick.show(); return; }
  if (a.sessionId) selectSession(a.sessionId); else showWindow();
});
app.on('window-all-closed', () => { if (TEST || quitting) app.quit(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (shutdownDone) return;
  e.preventDefault();
  shutdown().finally(() => {
    shutdownDone = true;
    // a restart: free the single-instance lock now, so the relaunched Helm (started as this one exits) gets it
    if (restarting) { try { app.releaseSingleInstanceLock(); log('restart: lock released, relaunching'); } catch (e) { log('restart: releasing the lock failed', e); } }
    // app.exit, not app.quit: once will-quit was prevented, Electron 44 ignores a second app.quit() (no
    // before-quit / will-quit / quit; measured 2026-10-08), so the process stayed alive with no window after
    // Quit Helm and a restart's relaunch (which waits for this process to end) never came. Shutdown is done.
    log('exiting');
    app.exit(0);
  });
});
let shutdownDone = false;
async function shutdown() {
  log('shutting down');
  try { hotkey && hotkey.dispose(); globalShortcut.unregisterAll(); } catch {}
  try { queue && queue.stop(); } catch {}
  try { auth && auth.stop(); } catch {}   // ends a sign-in status check still running (its PID only)
  try { voice && voice.dispose(); } catch {}
  try { updater && updater.stop(); } catch {}
  try { if (toprow && winHwnd) toprow.forget(winHwnd); toprow && toprow.stop(); } catch {}   // Mantle: this window says none, then the disconnect
  try { notifier && notifier.destroy(); } catch {}
  // cause: each session cut off keeps a restart note (what stopped) for the next start (lane restart)
  try { engine && typeof engine.shutdown === 'function' && await Promise.race([Promise.resolve(engine.shutdown({ cause: restarting ? 'restart' : 'quit' })), new Promise((r) => setTimeout(r, 4000))]); } catch (e) { log('engine shutdown', e); }
  try { badge && badge.close(); } catch (e) { log('badge close', e); } // badge.json -> count 0 so Mantle hides the number
  try { server && await Promise.race([server.close(), new Promise((r) => setTimeout(r, 2000))]); } catch {}
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  lockDownSessions();

  // lane installer: an installed build has no node_modules\@anthropic-ai (its installer may not contain Anthropic's
  // software), so it downloads the pinned SDK from npm on first run, with a window that shows progress and any
  // failure's reason. A checkout skips this block entirely.
  let installedSdk = null;
  if (INSTALLED) {
    log(`installed build ${pkg.version} in ${path.dirname(process.execPath)}`);
    const r = await require('./main/sdk-setup').prepareSdk({ electron, pkg, log, test: TEST, capture: TEST ? opt('sdk-capture') : null, icon: ICON_ICO, dark: nativeTheme.shouldUseDarkColors });
    if (!r.ok) {
      log(r.quit ? 'sdk: the user quit before the Claude Agent SDK was ready' : 'sdk: not ready; a test run exits 1');
      app.exit(r.quit ? 0 : 1);
      return;
    }
    installedSdk = r;
  }

  settings = createSettings({
    userDataDir, uiBgDir: path.join(UI_DIR, 'assets', 'backgrounds'), emit: hostEmit, log,
    onLocalChange: (before, after) => { if (look) look.onLocalChange(before, after); },
    // the API key is OS-encrypted at rest when Electron can (main/settings.js createKeyStore)
    secretBox: { available: () => electron.safeStorage.isEncryptionAvailable(), encrypt: (t) => electron.safeStorage.encryptString(t), decrypt: (b) => electron.safeStorage.decryptString(b) },
  });
  // Auth (main/account.js), before the engine so every claude child gets its env: Claude Code's own sign-in
  // (the user's env passed through), or the API key the user saved in Settings > Account. Helm never signs in.
  // The engine is late-bound for the CLI restart after a key change (engine.recycleClis).
  auth = createAccount({
    settings, emit: hostEmit, log: (...a) => log('[auth]', ...a),
    engine: { get recycleClis() { return engine && typeof engine.recycleClis === 'function' ? () => engine.recycleClis() : undefined; } },
  });
  // Look Sync. A --test run never touches the user's real %APPDATA%\look-sync: LOOK_SYNC_DIR, else a folder
  // inside its throwaway profile.
  look = createLook({
    settings, emit: hostEmit, log: (...a) => log('[look]', ...a),
    dir: process.env.LOOK_SYNC_DIR || (TEST ? path.join(userDataDir, 'look-sync') : undefined),
    ...(TEST && process.env.HELM_TEST_WALLPAPER !== undefined ? { windowsWallpaper: process.env.HELM_TEST_WALLPAPER || null } : {}),
    // a --test run never starts Mantle: it only logs what it would have run
    ...(TEST ? { launch: (exe, args) => log('[look] test: would open Mantle', exe, JSON.stringify(args)) } : {}),
  }).start();
  try { electron.powerMonitor.on('resume', () => look && look.refresh()); } catch (e) { log('powerMonitor', e); }
  // Top-row hints to Mantle. A --test run never talks to the user's real Mantle: only to HELM_TOPROW_PIPE (a fake server).
  toprow = createTopRow({
    pipe: TEST ? (process.env.HELM_TOPROW_PIPE || null) : (process.env.HELM_TOPROW_PIPE || undefined),
    offReason: 'Off in test runs (no HELM_TOPROW_PIPE)',
    log: (...a) => log('[toprow]', ...a),
    onStatus: () => hostEmit('toprow.updated', toprowState()),
  }).start();
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => sendPlacement());
  lastTheme = settings.get().theme;
  lastPhoneEnabled = settings.get().phone.enabled !== false;

  const { mod, kind } = loadEngine();
  try {
    engine = await mod.createEngine({ userDataDir, emit: hostEmit, log: (...a) => log('[engine]', ...a), getDefaults: () => settings.get().defaults, getIdleCloseMs: idleCloseMs, getKeep: keepThroughRestart,
      childEnv: (env) => auth.childEnv(env), startBlock: () => auth.startBlock(), onAuthError: (text) => auth.noteAuthError(text),
      // lane installer: the downloaded SDK (a file URL outside the app folder); a checkout imports it from node_modules
      ...(installedSdk ? { sdkEntry: installedSdk.sdk.entryUrl, sdkVersion: installedSdk.sdk.version } : {}) });
  } catch (e) {
    log('engine failed to start; using the fallback engine', e);
    engineReason = `The engine failed to start: ${String((e && e.message) || e).split('\n')[0]}`;
    engine = await require('./main/engine-fallback').createEngine({ userDataDir, emit: hostEmit, log });
  }
  const engineKind = engine.kind === 'fallback' || kind === 'fallback' ? 'fallback' : 'real';
  log(`engine: ${engineKind}`);
  // Claude Code's sign-in, a few seconds after start (claude auth status: read-only, prints no secret), so the
  // composer and Settings can say "not signed in" before the first message instead of after it.
  auth.start();
  if (strippedEnv.length) log('cleared inherited Claude Code env:', strippedEnv.join(', '));

  queue = createQueue({
    userDataDir, engine, emit: hostEmit, log,
    // main/account.js: no 5H gate without 5-hour limits (an API key); not signed in = the next job waits and says why
    usageLimits: () => auth.usageLimits, startBlock: () => auth.startBlock(),
    notify: (n) => hostEmit('notify', n),
    getDefaults: () => settings.get().defaults,
  });

  notifier = createNotifier({
    electron, getWindow: () => win, showWindow, selectSession, broadcast: (ev, d) => server && server.broadcast(ev, d),
    getSettings: () => settings.get(), iconDir: ICON_DIR, onQuit: quit, onRestart: () => trayRestart().catch((e) => log('tray restart', e)), onQuickPrompt: () => quick && quick.show(),
    enableTray: DESKTOP, record: TEST ? record : null, log,
    onContextAlert: (n) => { if (push) pushNotify(n); },   // 32% / 40% agent alerts to the phone too
    overlay: false, // main/badge.js owns the taskbar overlay (waiting + unseen errors)
  });
  badge = createBadge({ electron, getWindow: () => win, userDataDir, log, record: TEST ? record : null });
  if (TEST) notifier.notify = () => {}; // never pop toasts from a test run (test.toast shows one on purpose)

  // Quick prompt: the box (lazy window over the same server + token) and its global hotkey.
  quick = createQuickWindow({
    BrowserWindow, screen, url: () => `http://127.0.0.1:${server.port}/quick/index.html?token=${token}`,
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : notifier.appIcon.img, preload: path.join(__dirname, 'preload.js'),
    backgroundColor: themeColors(settings.get().theme).bg, log,
  });
  hotkey = createHotkey({
    globalShortcut, onTrigger: () => quick.toggle(), log,
    onError: (error) => hostEmit('notify', { title: 'Quick prompt hotkey unavailable', body: `${error}. Pick another one in Settings.`, kind: 'info' }),
  });
  loginItem = createLoginItem({
    exe: helmExe, appDir: __dirname, log,
    // a test run never writes the user's Run key; it records what it would have written
    setLoginItem: TEST ? (o) => record.loginItem.push(o) : (o) => app.setLoginItemSettings(o),
  });

  const files = createFiles({ getWindow: () => win, dialog });
  // Screenshot attach: helm:capture-sources / helm:capture / helm:capture-crop (main window only)
  require('./main/capture').registerCapture({ ipcMain: electron.ipcMain, desktopCapturer: electron.desktopCapturer, screen, getWindow: () => win, log });
  const testHooks = TEST ? createTestHooks({
    electron, getWindow: () => win, showWindow, quick, hotkey, notifier, badge, hostEmit, selectSession, previewPartition: PREVIEW_PARTITION,
    record, userDataDir, loginItemOptions, exe: helmExe, appDir: __dirname, log,
  }) : null;
  // Settings -> Phone checklist (phone.status) + the one-time busy-4871 notice (main/phone.js)
  const phoneHealth = createPhoneHealth({ getServer: () => server, getSettings: () => settings.get(), getTailscaleIp: (o) => tailscaleIpNow(o), emit: hostEmit, log });
  // Tailnet HTTPS + Web Push (main/https.js, main/push.js). A --test run reads tailscale serve but never
  // changes it, unless --test-https-port names the one port it may use.
  tailnetHttps = createTailnetHttps({
    getLocalPort: () => (server ? server.port : 4871), log: (...a) => log('[https]', ...a),
    allowChange: !TEST || !!flags.testHttpsPort, ports: TEST ? (flags.testHttpsPort ? [flags.testHttpsPort] : []) : undefined,
  });
  const wp = loadWebPush();
  if (wp.error) log('push:', wp.error);
  push = createPush({
    dir: path.join(userDataDir, 'push'), webpush: wp.webpush, loadError: wp.error, log,
    getSubject: () => { const h = tailnetHttps.last(); return h && h.domain ? `https://${h.domain}` : null; },
  });
  voice = createVoice({ log });
  const router = createRouter({
    engine, files, queue, settings, windowCtl, version: pkg.version, engineKind, engineReason, logPath: logFile, log, test: TEST, emit: hostEmit, auth,
    hostMethods: { ...quickMethods({ engine, settings, quick, selectSession, log }), ...phoneMethods(phoneHealth), ...restartMethods,
      // Railway panel + Home chip (main/railway.js): the user's own `railway` CLI; a --test run stays off unless HELM_RAILWAY_CLI / HELM_RAILWAY_LIVE
      ...require('./main/railway').createRailway({ emit: hostEmit, log: (...a) => log('[railway]', ...a), test: TEST }).methods,
      ...look.methods, 'toprow.get': async () => toprowState(), ...voice.methods,
      // worktrees.* (main/worktrees.js, lane helm-worktrees): a session in its own git worktree + the Worktrees panel
      ...require('./main/worktrees').createWorktrees({ getSessions: async () => ((await engine.snapshot()) || {}).sessions || [], helmRoot: __dirname, userDataDir, log: (...a) => log('[worktrees]', ...a) }).methods },
    helloExtras: () => ({ update: updater ? updater.state() : null, look: look ? look.state() : null, toprow: toprowState() }),
    testMethods: testHooks ? { ...testHooks, 'test.loginRecord': async () => record.loginItem.slice(), 'test.idleClose': testIdleClose, 'test.placement': testPlacement,
      // lane voice (tools/voice-check.js): force the engine's unavailable state; resize to the phone layout
      'test.voice': async (p = {}) => voice.testSet(p),
      // (the window's 900x600 minimum is lifted first, test runs only, so 393 / 320 really reach the phone layout)
      'test.resize': async (p = {}) => {
        if (!win || win.isDestroyed()) return { size: null, inner: null };
        const want = Math.max(300, Number(p.width) || 1280), h = Math.max(400, Number(p.height) || 800);
        win.setMinimumSize(300, 400);
        win.setContentSize(want, h);
        await new Promise((r) => setTimeout(r, 300));
        // the frameless window's content box can differ from innerWidth by its resize border: correct once
        const inner0 = await win.webContents.executeJavaScript('innerWidth');
        if (inner0 !== want) { win.setContentSize(want - (inner0 - want), h); await new Promise((r) => setTimeout(r, 300)); }
        return { size: win.getContentSize(), inner: await win.webContents.executeJavaScript('innerWidth') };
      } } : null,
  });

  server = await startServer({
    uiDir: UI_DIR, bgDirs: settings.bgDirs, token, port: flags.port,
    bgDesktop: () => (look ? look.desktopFile() : null),   // Look Sync: /bg/desktop
    // this PC's own MagicDNS names are the allowed *.ts.net Hosts (server.js DNS-rebinding guard)
    extraHosts: () => [...knownNames],
    // phone access off also closes the tailnet https route (it arrives proxied from loopback)
    allowProxied: () => settings.get().phone.enabled !== false,
    onRpc: (client, method, params) => {
      // opening a session (desktop or phone) marks its error seen for the "needs you" badge
      if (method === 'sessions.markRead' && params && badge) { try { badge.opened(params.id); } catch (e) { log('badge opened', e); } }
      return router.handle(client, method, params);
    },
    onClient: (c, state) => {
      log(`client ${state}: ${c.platform} via ${c.auth} from ${c.remote}${c.proxied ? ` (tailnet ${c.secure ? 'https' : 'http'} proxy)` : ''}`);
      phoneHealth.onClient(c, state);
      if (state === 'close') { clientAttachments.delete(c); push.clientClosed(c.id); if (engine && typeof engine.clientClosed === 'function') engine.clientClosed(c); }
    },
    log,
  });
  log(`listening on http://127.0.0.1:${server.port}${server.portFellBack ? ` (4871 was busy)` : ''}`);

  try { const snap = await engine.snapshot(); notifier.seed(snap && snap.sessions); badge.seed(snap && snap.sessions); } catch (e) { log('snapshot failed', e); }
  await refreshTailscale().catch((e) => log('tailscale', e));
  setInterval(() => refreshTailscale().catch((e) => log('tailscale', e)), 60_000).unref();
  queue.start();

  // Update detection: a new commit on this folder's branch -> settle 60 s -> restart once nothing is running.
  updater = createUpdater({
    repoDir: UPDATE_REPO, emit: hostEmit, log, timing: updateTiming,
    getBlockers: (o) => restartReasons(o),
    restart: (i) => performRestart({ ...i, by: i && i.deferred ? i.by : 'update' }),
    isAutoRestart: () => settings.get().autoRestart !== false,
    extra: () => ({ bootedAt: BOOTED_AT, restarted: restartedFrom ? { at: restartedFrom.at, auto: !!restartedFrom.auto, by: restartedFrom.by || null, from: restartedFrom.from || null, to: restartedFrom.to || null, commits: Array.isArray(restartedFrom.commits) ? restartedFrom.commits : [] } : null,
      // lane installer: installed builds only (a checkout's state has no `release` key)
      ...(releaseCheck ? { release: releaseCheck.state() } : {}) }),
  });
  // lane installer: an installed build has no git checkout to watch, so it checks GitHub releases instead and
  // Settings > Helm says "Helm <v> is available" with a link to the installer (never a silent "updates off").
  if (INSTALLED) {
    releaseCheck = require('./main/release-check').createReleaseCheck({
      current: pkg.version, fetch: (u, o) => electron.net.fetch(u, o), log: (...a) => log('[release]', ...a),
      onChange: () => { if (updater) updater.refresh(); },
      ...(TEST ? { startDelayMs: 3_600e3 } : {}), // a test run only checks when asked (app.checkUpdates)
    });
    releaseCheck.start();
  }
  updater.start();

  createWindow();
  if (installedSdk) installedSdk.dispose(); // lane installer: the hidden setup window, once the main window exists
  badge.refreshWindow();
  if (DESKTOP) hotkey.apply(settings.get().quickPromptHotkey);
  loginItem.apply(settings.get().launchAtLogin);
  registerProtocol();
  if (launchArgs.sessionId) selectSession(launchArgs.sessionId);
  if (launchArgs.quick) quick.show();
  // Load the box in the background once things settle, so the first hotkey press is instant.
  else if (!TEST && settings.get().quickPromptHotkey) setTimeout(() => { try { quick.warm(); } catch (e) { log('quick warm', e); } }, 8000).unref?.();

  if (TEST) {
    const ready = { pid: process.pid, port: server.port, token, userDataDir, engine: engineKind, exe: process.execPath, desktop: DESKTOP,
      // lane installer: installed builds only (the installer's CI smoke test reads these)
      ...(installedSdk ? { installed: true, version: pkg.version, sdk: { version: installedSdk.sdk.version, dir: installedSdk.sdk.dir, fetched: !!installedSdk.sdk.fetched, entryUrl: installedSdk.sdk.entryUrl } } : {}) };
    fs.writeFileSync(path.join(userDataDir, 'ready.json'), JSON.stringify(ready));
    console.log('HELM_READY ' + JSON.stringify(ready));
    if (flags.capture) captureWhenRendered(flags.capture);
    // lane installer: --exit-when-ready (test only): load the SDK the engine will run, report, then exit 0, so the
    // installer's CI can launch the installed Helm and uninstall it afterwards
    if (flag('exit-when-ready')) {
      const sdkCheck = installedSdk ? import(installedSdk.sdk.entryUrl).then((m) => typeof m.query === 'function', (e) => `failed: ${e.message}`) : Promise.resolve(null);
      sdkCheck.then((query) => {
        console.log('HELM_EXIT_WHEN_READY ' + JSON.stringify({ engine: engineKind, sdkQuery: query }));
        setTimeout(() => app.exit(query === false || typeof query === 'string' ? 1 : 0), flags.capture ? 5000 : 500);
      });
    }
  }
}).catch((e) => { log('boot failed', e); dialog.showErrorBox('Helm could not start', String(e && e.stack || e)); app.exit(1); });

// Test mode: wait for the UI to load and settle, then capture it once.
function captureWhenRendered(out) {
  const wc = win.webContents;
  const go = async () => {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const img = await wc.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const size = img.getSize();
      log(`captured ${size.width}x${size.height} -> ${out}`);
      console.log('HELM_CAPTURED ' + JSON.stringify({ file: out, ...size, empty: img.isEmpty() }));
    } catch (e) { log('capture failed', e); console.log('HELM_CAPTURED ' + JSON.stringify({ error: e.message })); }
  };
  if (wc.isLoading()) wc.once('did-finish-load', go); else go();
}
