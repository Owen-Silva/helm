// Quick prompt: a global hotkey (settings.quickPromptHotkey, default Control+Alt+Space) toggles a
// small frameless always-on-top box (ui/quick/) that sends a prompt to an open session or starts
// a new one in a project, without bringing the main window up.
//  - quickTargets / routeQuickPrompt: pure, tested in test/host/quick.test.js
//  - createHotkey: register / re-register / unregister with globalShortcut; a taken or invalid
//    accelerator is logged and surfaced through onError (a `notify` info event), never thrown
//  - createQuickWindow: the BrowserWindow itself (lazy, reused, hidden on blur and Esc)
//  - quickMethods: the quick.* RPC methods the box calls over the WebSocket
// Owner: lane host (B).
const path = require('path');

function rpcError(message, code) { return Object.assign(new Error(message), { code }); }

const DEFAULT_HOTKEY = 'Control+Alt+Space';
// path.win32.basename splits on both '\' and '/', so a Windows project path names itself on any OS (CI runs Linux too)
const projectName = (cwd) => path.win32.basename(String(cwd || '').replace(/[\\/]+$/, '')) || String(cwd || '');
const sameDir = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();

/**
 * Everything the box can send to: open sessions (most recently active first), then
 * "New session in <project>" for each settings project (defaults.cwd when there are none).
 * -> { targets: [{ id, kind, label, detail, sessionId?, cwd? }], defaultId }
 */
function quickTargets({ sessions = [], projects = [], defaultCwd = null, lastTarget = null } = {}) {
  const open = sessions.filter((s) => s && s.id && s.status !== 'closed')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const targets = open.map((s) => ({
    id: 'session:' + s.id, kind: 'session', sessionId: s.id,
    label: s.title || 'Untitled session',
    detail: [s.project || projectName(s.cwd), s.status && s.status !== 'idle' ? s.status : null].filter(Boolean).join(' · '),
  }));
  const dirs = [];
  for (const p of projects || []) if (p && typeof p.cwd === 'string' && p.cwd && !dirs.some((d) => sameDir(d.cwd, p.cwd))) dirs.push({ cwd: p.cwd, name: p.name || projectName(p.cwd) });
  if (!dirs.length && defaultCwd) dirs.push({ cwd: defaultCwd, name: projectName(defaultCwd) });
  for (const d of dirs) targets.push({ id: 'project:' + d.cwd, kind: 'project', cwd: d.cwd, label: `New session in ${d.name}`, detail: d.cwd });
  const firstProject = targets.find((t) => t.kind === 'project');
  const defaultId = (lastTarget && targets.some((t) => t.id === lastTarget) && lastTarget) || (firstProject || targets[0] || {}).id || null;
  return { targets, defaultId };
}

/**
 * Decide the RPC for a quick prompt. target = "session:<id>" | "project:<cwd>".
 * -> { method: 'sessions.send', params: { id, text } } | { method: 'sessions.create', params: { cwd, prompt } }
 * Throws bad_params (empty text, unknown target, unknown session or project).
 */
function routeQuickPrompt({ target, text, sessions = [], projects = [], defaultCwd = null }) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw rpcError('type a prompt first', 'bad_params');
  if (body.length > 100_000) throw rpcError('prompt is too long', 'bad_params');
  const t = String(target || '');
  if (t.startsWith('session:')) {
    const id = t.slice(8);
    const s = sessions.find((x) => x && x.id === id);
    if (!s) throw rpcError('that session is gone; pick another', 'bad_params');
    return { method: 'sessions.send', params: { id, text: body }, sessionId: id, title: s.title || 'Untitled session' };
  }
  if (t.startsWith('project:')) {
    const cwd = t.slice(8);
    const known = (projects || []).some((p) => p && sameDir(p.cwd, cwd)) || (defaultCwd && sameDir(defaultCwd, cwd));
    if (!cwd || !known) throw rpcError('unknown project; pick one from the list', 'bad_params');
    return { method: 'sessions.create', params: { cwd, prompt: body }, sessionId: null, title: `new session in ${projectName(cwd)}` };
  }
  throw rpcError('pick where to send it', 'bad_params');
}

/**
 * Global hotkey. apply(accel) is called at boot and on every settings.updated; it only
 * touches globalShortcut when the accelerator changed ('' or null disables).
 * -> { apply(accel) -> { ok, accelerator, error? } | null (unchanged), current(), dispose() }
 */
function createHotkey({ globalShortcut, onTrigger, onError = () => {}, log = () => {} }) {
  let wanted;          // last accelerator apply() was asked for (undefined = never)
  let registered = null;
  function apply(accel) {
    const a = typeof accel === 'string' ? accel.trim() : '';
    if (a === wanted) return null;
    wanted = a;
    if (registered) { try { globalShortcut.unregister(registered); } catch {} registered = null; }
    if (!a) { log('quick prompt hotkey off'); return { ok: true, accelerator: null }; }
    let ok = false, invalid = null;
    try { ok = !!globalShortcut.register(a, onTrigger); } catch (e) { invalid = e.message || String(e); }
    if (ok) { registered = a; log(`quick prompt hotkey ${a}`); return { ok: true, accelerator: a }; }
    const error = invalid ? `"${a}" is not a valid shortcut` : `${a} is already used by another app`;
    log(`quick prompt hotkey failed: ${error}${invalid ? ` (${invalid})` : ''}`);
    try { onError(error, a); } catch {}
    return { ok: false, accelerator: a, error };
  }
  return {
    apply,
    current: () => registered,
    dispose() { if (registered) { try { globalShortcut.unregister(registered); } catch {} registered = null; } wanted = undefined; },
  };
}

/**
 * The box. createQuickWindow({ BrowserWindow, screen, url(), icon, preload, test, log })
 * -> { toggle(), show(), hide(), warm() (load it hidden), isVisible(), window() }
 */
function createQuickWindow({ BrowserWindow, screen, url, icon, preload, backgroundColor = '#1d1f22', hideOnBlur = true, log = () => {} }) {
  let win = null;
  const W = 640, H = 196;

  function create() {
    win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Helm quick prompt',
      icon, backgroundColor, roundedCorners: true,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('blur', () => { if (hideOnBlur && win && !win.isDestroyed() && win.isVisible()) win.hide(); });
    win.on('closed', () => { win = null; });
    win.webContents.on('render-process-gone', (_e, d) => log('quick prompt renderer gone', d.reason));
    win.loadURL(url());
  }

  function place() {
    const pt = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(pt).workArea;
    win.setBounds({ x: Math.round(area.x + (area.width - W) / 2), y: Math.round(area.y + area.height * 0.24), width: W, height: H });
  }

  function show() {
    if (!win || win.isDestroyed()) create();
    place();
    const go = () => { if (!win || win.isDestroyed()) return; win.show(); win.focus(); win.webContents.focus(); };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go); else go();
  }
  function hide() { if (win && !win.isDestroyed()) win.hide(); }
  function isVisible() { return !!(win && !win.isDestroyed() && win.isVisible()); }
  function toggle() { if (isVisible() && win.isFocused()) hide(); else show(); }

  function warm() { if (!win || win.isDestroyed()) create(); }

  return { show, hide, toggle, warm, isVisible, window: () => (win && !win.isDestroyed() ? win : null) };
}

/**
 * quick.* RPC methods (PROTOCOL "Round 3 additions" / quick prompt). The window ones are only
 * for the desktop app's own windows (client.platform 'electron').
 */
function quickMethods({ engine, settings, quick, selectSession, log = () => {} }) {
  let lastTarget = null;
  const desktopOnly = (client) => { if (!client || client.platform !== 'electron') throw rpcError('the quick prompt is desktop-only', 'unsupported'); };
  async function state() {
    const snap = (await engine.snapshot()) || {};
    const s = settings.get();
    return { sessions: snap.sessions || [], projects: s.projects || [], defaultCwd: (s.defaults && s.defaults.cwd) || null };
  }
  return {
    'quick.targets': async () => {
      const st = await state();
      return { ...quickTargets({ ...st, lastTarget }), hotkey: settings.get().quickPromptHotkey || '' };
    },
    'quick.send': async (p = {}) => {
      const st = await state();
      const r = routeQuickPrompt({ target: p.target, text: p.text, ...st });
      const fn = engine.methods && engine.methods[r.method];
      if (typeof fn !== 'function') throw rpcError(`engine has no ${r.method}`, 'unsupported');
      const out = await fn(r.params, null);
      lastTarget = r.sessionId ? 'session:' + r.sessionId : String(p.target);
      if (r.method === 'sessions.create') {
        const id = out && out.id;
        if (id) lastTarget = 'session:' + id;
        log(`quick prompt -> new session ${id} in ${r.params.cwd}`);
        return { sessionId: id || null, title: (out && out.title) || r.title, created: true };
      }
      log(`quick prompt -> ${r.sessionId}${out && out.queued ? ' (queued)' : ''}`);
      return { sessionId: r.sessionId, title: r.title, created: false, queued: !!(out && out.queued) };
    },
    'quick.hide': async (_p, client) => { desktopOnly(client); quick.hide(); return {}; },
    'quick.open': async (p = {}, client) => {
      desktopOnly(client);
      quick.hide();
      selectSession(typeof p.sessionId === 'string' ? p.sessionId : null);
      return {};
    },
  };
}

module.exports = { DEFAULT_HOTKEY, quickTargets, routeQuickPrompt, createHotkey, createQuickWindow, quickMethods };
