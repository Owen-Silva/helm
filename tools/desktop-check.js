// Real-Electron check of the desktop-only features, through dist/Helm/Helm.exe (tools/make-exe.js)
// in a throwaway --test profile with --test-desktop (tray, close-to-tray, global hotkey and the
// Tailscale bind are live; toasts only when asked; shell.openExternal is stubbed).
// VISIBLE: it shows the Helm window, the quick-prompt box and one toast, and presses Ctrl+Alt+Space
// once. Run it when the user is away. Everything it opens is closed BY PID at the end.
// Usage: node tools/desktop-check.js [--exe=<path>] [--shots=<dir>]
// Owner: lane host (B).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const EXE = arg('exe') || path.join(ROOT, 'dist', 'Helm', 'Helm.exe');
const SHOTS = path.resolve(arg('shots') || path.join(ROOT, '.shots'));
const profile = 'desk' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const PS = path.join(__dirname, 'desktop-win.ps1');
fs.mkdirSync(SHOTS, { recursive: true });

let passes = 0, failures = 0;
const notes = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok  ' + name); } else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
const ps = (...a) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, ...a], { encoding: 'utf8', timeout: 30000 }).trim();

function launch(extra = []) {
  const args = [ROOT, '--test', '--test-desktop', '--fallback-engine', `--profile=${profile}`, ...extra];
  return spawn(EXE, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
}
function waitReady(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('no HELM_READY in 60 s:\n' + buf.slice(-1500))), 60000);
    const onData = (d) => { buf += d; const m = /HELM_READY (\{.*\})/.exec(buf); if (m) { clearTimeout(t); resolve(JSON.parse(m[1])); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('exited ' + c + ':\n' + buf.slice(-1500))); });
  });
}
function client(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const c = { ws, events: [], open: false, n: 0, pending: new Map() };
    c.rpc = (method, params = {}) => new Promise((res) => { const id = ++c.n; c.pending.set(id, res); ws.send(JSON.stringify({ id, type: 'rpc', method, params })); setTimeout(() => { if (c.pending.delete(id)) res({ error: { code: 'timeout' } }); }, 30000); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'result' || m.id) { const f = c.pending.get(m.id); if (f) { c.pending.delete(m.id); f(m); } }
      if (m.type === 'event') c.events.push(m);
    });
    ws.on('open', () => { c.open = true; resolve(c); });
    ws.on('error', () => resolve(c));
    ws.on('unexpected-response', (_q, res) => { c.status = res.statusCode; resolve(c); });
  });
}
function get(url, headers = {}) {
  return new Promise((resolve) => {
    http.get(url, { headers }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); })
      .on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}
const R = (m) => (m && m.result !== undefined ? m.result : null);
const E = (m) => JSON.stringify((m && m.error) || m);

// A page for the preview <webview>: coloured, titled, with a target=_blank link.
function startPage() {
  const page = '<!doctype html><title>helm-preview-test</title><body style="margin:0;background:#2f6f5a;color:#fff;font:24px sans-serif">'
    + '<h1>preview ok</h1><a id="ext" target="_blank" href="https://example.com/from-target-blank">external</a></body>';
  const srv = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function main() {
  if (!fs.existsSync(EXE)) { console.log(`no ${EXE}: run node tools/make-exe.js first`); process.exit(2); }
  const child = launch();
  const pids = [child.pid];
  let page = null;
  try {
    const ready = await waitReady(child);
    const base = `http://127.0.0.1:${ready.port}`;
    console.log(`desktop-check: ${path.basename(ready.exe)} pid ${ready.pid} port ${ready.port}`);

    // ---- identity ----
    check('runs as Helm.exe', /Helm\.exe$/i.test(ready.exe), ready.exe);
    check('process image name is Helm', ps('-Action', 'procname', '-ProcId', String(ready.pid)) === 'Helm');
    const c = await client(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { origin: base });
    check('WS opens', c.open);
    let st = R(await c.rpc('test.hostState'));
    check('app name Helm, userData is the test profile', st && st.appName === 'Helm' && /helm-test-desk/.test(st.userData), JSON.stringify(st && { appName: st.appName, userData: st.userData }));
    check('tray built from ui/assets/icon.ico', st && st.tray && /icon\.ico$/.test(st.tray.iconFile || ''), JSON.stringify(st && st.tray));
    check('tray menu has Show / Quick prompt / Quit', st && st.tray && ['Show Helm', 'Quick prompt', 'Quit Helm'].every((l) => st.tray.labels.includes(l)), JSON.stringify(st && st.tray));
    // Ctrl+Alt+Space may already belong to another app (the user's running Helm holds it). Then the right
    // behaviour is "not registered + a clash notice", and the keypress test below uses a free key so it
    // never pops the other app's quick box.
    let hotkeyTaken = false;
    if (st && st.hotkey.current === 'Control+Alt+Space' && st.hotkey.registered) check('quick-prompt hotkey registered', true);
    else {
      await c.rpc('settings.set', { quickPromptHotkey: '' });
      const n0 = c.events.length;
      await c.rpc('settings.set', { quickPromptHotkey: 'Control+Alt+Space' });
      await sleep(200);
      const clash = c.events.slice(n0).find((e) => e.event === 'notify' && /already used by another app/.test((e.data && e.data.body) || ''));
      hotkeyTaken = !!clash;
      check('quick-prompt hotkey registered (or held by another app and the clash reported)', hotkeyTaken, JSON.stringify({ hk: st && st.hotkey, clash: clash && clash.data }));
      if (hotkeyTaken) console.log('  note: Ctrl+Alt+Space is held by another app (your running Helm?); keypress test uses Ctrl+Alt+Shift+F9');
    }

    await c.rpc('test.showWindow');
    await sleep(2500); // let the UI boot
    st = R(await c.rpc('test.hostState'));
    const iconPng = path.join(SHOTS, 'desktop-window-icon.png');
    let icon = {};
    try { icon = JSON.parse(ps('-Action', 'icon', '-Hwnd', st.window.hwnd, '-Out', iconPng)); } catch (e) { icon = { error: e.message }; }
    check('window has an icon (WM_GETICON)', (icon.big || icon.small || icon.cls) && icon.saved, JSON.stringify(icon));

    // ---- drag strip ----
    const drag = R(await c.rpc('test.dragRegion'));
    check('strip is -webkit-app-region: drag', drag && drag.strip === 'drag', JSON.stringify(drag));
    check('strip buttons are no-drag', drag && drag.buttons.length > 0 && drag.buttons.filter((b) => /strip/.test(b.cls)).every((b) => b.region === 'no-drag'), JSON.stringify(drag && drag.buttons.slice(0, 6)));

    // ---- preview <webview> ----
    page = await startPage();
    const wv = await c.rpc('test.webview', { url: `http://127.0.0.1:${page.address().port}/`, capture: path.join(SHOTS, 'desktop-webview.png') });
    const w = R(wv);
    check('webview attached in persist:helm-preview (hostile partition overridden)', w && w.partitionIsPreview && !w.partitionIsEvil, E(wv));
    check('webview has no node (require/process undefined)', w && w.inside.require === 'undefined' && w.inside.process === 'undefined', JSON.stringify(w && w.inside));
    check('webview rendered the page', w && w.inside.title === 'helm-preview-test' && !w.capture.empty && w.capture.nonBlankSamples > 50, JSON.stringify(w && w.capture));
    check('webview new windows go to openExternal (stubbed), none opened', w && w.openedExternal.some((u) => /from-target-blank/.test(u)) && w.openedExternal.some((u) => /from-window-open/.test(u)), JSON.stringify(w && w.openedExternal));

    // ---- waiting badge + flash (window not focused: hide it first) ----
    await c.rpc('test.closeWindow');
    st = R(await c.rpc('test.hostState'));
    check('close hides to tray (window kept, hidden)', st.window && !st.window.visible, JSON.stringify(st.window));
    // the stand-in engine starts with some sessions already waiting; the overlay counts waiting + unseen errors (main/badge.js)
    const base0 = st.badge ? st.badge.count : st.waiting;
    await c.rpc('test.emit', { event: 'session.updated', data: { id: 's_dc1', status: 'waiting', title: 'desk check' } });
    st = R(await c.rpc('test.hostState'));
    check(`overlay badge counts the new waiting session (${base0} -> ${base0 + 1})`, st.overlay.length && st.overlay[st.overlay.length - 1].n === base0 + 1, JSON.stringify(st.overlay));
    check('flashFrame on new waiting', st.flash.some((f) => f.sessionId === 's_dc1'), JSON.stringify(st.flash));
    check('tray shows the waiting count', st.tray && st.tray.labels.includes(`${base0 + 1} waiting on you`), JSON.stringify(st.tray));
    await c.rpc('test.emit', { event: 'session.updated', data: { id: 's_dc1', status: 'idle' } });
    st = R(await c.rpc('test.hostState'));
    check('overlay badge drops back when it stops waiting', st.overlay[st.overlay.length - 1].n === base0, JSON.stringify(st.overlay));

    // ---- notification click ----
    const before = c.events.length;
    await c.rpc('test.notificationClick', { sessionId: 's_dc1' });
    st = R(await c.rpc('test.hostState'));
    check('notification click shows the window', st.window && st.window.visible, JSON.stringify(st.window));
    check('notification click selects the session (app.select broadcast)', st.selects.includes('s_dc1') && c.events.slice(before).some((e) => e.event === 'app.select' && e.data.sessionId === 's_dc1'));
    const toast = R(await c.rpc('test.toast', { closeAfterMs: 1500 }));
    check('a real Windows toast shows (AUMID com.owensilva.helm)', toast && toast.shown, JSON.stringify(toast));

    // ---- quick prompt ----
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-desk-proj-'));
    await c.rpc('settings.set', { projects: [{ cwd: proj, name: 'deskproj' }] });
    let q = R(await c.rpc('test.quick', { action: 'show', waitMs: 1500, eval: `({ options: [...document.querySelectorAll('option')].map((o) => o.textContent), focused: document.activeElement && document.activeElement.tagName, theme: document.documentElement.dataset.theme })`, capture: path.join(SHOTS, 'desktop-quick.png') }));
    check('quick box shows, always on top', q && q.visible && q.alwaysOnTop, JSON.stringify(q && { visible: q.visible, top: q.alwaysOnTop, bounds: q.bounds }));
    check('quick box lists "New session in deskproj", textarea focused', q && q.eval && q.eval.options.some((o) => /New session in deskproj/.test(o)) && q.eval.focused === 'TEXTAREA', JSON.stringify(q && q.eval));
    check('quick box rendered', q && q.capture && !q.capture.empty, JSON.stringify(q && q.capture));
    const nEv = c.events.length;
    q = R(await c.rpc('test.quick', { action: 'state', eval: `(() => { const sel = document.querySelector('select'); sel.value = [...sel.options].find((o) => /deskproj/.test(o.textContent)).value; sel.dispatchEvent(new Event('change', { bubbles: true })); const ta = document.querySelector('textarea'); ta.value = 'hello from the quick box'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()` }));
    await sleep(700);
    q = R(await c.rpc('test.quick', { action: 'state', eval: `document.querySelector('.qp-status').textContent` }));
    const created = c.events.slice(nEv).find((e) => e.event === 'session.created');
    check('Enter sends: new session created in the project', created && created.data.cwd === proj, JSON.stringify(c.events.slice(nEv).map((e) => e.event)));
    check('quick box says "Sent to …"', q && /Sent to/.test(q.eval || ''), JSON.stringify(q && q.eval));
    await sleep(1500);
    q = R(await c.rpc('test.quick', { action: 'state' }));
    check('quick box hides itself after sending', q && !q.visible, JSON.stringify(q));
    // re-open: the status line keeps the "Open in Helm" link
    await c.rpc('test.closeWindow');
    q = R(await c.rpc('test.quick', { action: 'show', waitMs: 800, eval: `(() => { const b = document.querySelector('.qp-open'); if (!b) return false; b.click(); return true; })()` }));
    await sleep(2200);
    st = R(await c.rpc('test.hostState'));
    check('"Open in Helm" shows the main window on that session', q && q.eval === true && st.window.visible && created && st.selects.includes(created.data.id), JSON.stringify({ clicked: q && q.eval, visible: st.window.visible, selects: st.selects }));
    check('quick box hidden after Open in Helm', st.quick && !st.quick.visible);
    const qs = await c.rpc('quick.send', { target: created ? 'session:' + created.data.id : 'x', text: 'follow-up via rpc' });
    check('quick.send to an open session -> sessions.send', R(qs) && R(qs).sessionId === (created && created.data.id) && R(qs).created === false, E(qs));
    const qbad = await c.rpc('quick.send', { target: 'project:C:\\not-a-project', text: 'x' });
    check('quick.send to an unknown project -> bad_params', qbad.error && qbad.error.code === 'bad_params', E(qbad));
    const qhide = await c.rpc('quick.hide');
    check('quick.hide refused for a non-window client', qhide.error && qhide.error.code === 'unsupported', E(qhide));

    // ---- hotkey: change, invalid, back, real keypress ----
    await c.rpc('settings.set', { quickPromptHotkey: 'Control+Alt+Shift+F9' });
    st = R(await c.rpc('test.hostState'));
    check('hotkey re-registers on settings change', st.hotkey.current === 'Control+Alt+Shift+F9' && st.hotkey.registered, JSON.stringify(st.hotkey));
    const nn = c.events.length;
    await c.rpc('settings.set', { quickPromptHotkey: 'Nope+Key' });
    await sleep(200);
    st = R(await c.rpc('test.hostState'));
    const warn = c.events.slice(nn).find((e) => e.event === 'notify' && e.data.kind === 'info');
    check('invalid hotkey -> notify info event, nothing registered, app alive', warn && /not a valid shortcut/.test(warn.data.body) && st.hotkey.current === null, JSON.stringify({ warn: warn && warn.data, hk: st.hotkey }));
    await c.rpc('settings.set', { quickPromptHotkey: '' });
    st = R(await c.rpc('test.hostState'));
    check('empty hotkey disables it', st.hotkey.current === null);
    await c.rpc('settings.set', { quickPromptHotkey: hotkeyTaken ? 'Control+Alt+Shift+F9' : 'Control+Alt+Space' });
    await c.rpc('test.quick', { action: 'hide' });
    ps('-Action', hotkeyTaken ? 'hotkey-f9' : 'hotkey');
    await sleep(1200);
    q = R(await c.rpc('test.quick', { action: 'state' }));
    check(`pressing ${hotkeyTaken ? 'Ctrl+Alt+Shift+F9' : 'Ctrl+Alt+Space'} opens the quick box`, q && q.visible, JSON.stringify(q));
    await c.rpc('test.quick', { action: 'hide' });

    // ---- login item ----
    const li = R(await c.rpc('test.loginItem'));
    // getLoginItemSettings drops switches (--hidden) when it parses the Run value back, so its
    // openAtLogin reads false for our args; judge by the Run value itself.
    check('login item round trip (HKCU Run "HelmTest" = Helm.exe "<project>" --hidden, then removed)', li && /Helm.exe" "[^"]+helm" --hidden$/i.test(li.regValue || '') && li.on.executableWillLaunchAtLogin && li.on.launchItems.some((x) => x.name === 'HelmTest') && !li.off.launchItems.some((x) => x.name === 'HelmTest'), JSON.stringify(li));
    await c.rpc('settings.set', { launchAtLogin: true });
    const rec = R(await c.rpc('test.loginRecord'));
    const last = rec && rec[rec.length - 1];
    check('launchAtLogin -> Helm.exe <project> --hidden (recorded in test mode)', last && last.openAtLogin && /Helm\.exe$/i.test(last.path) && last.args[0] === ROOT && last.args[1] === '--hidden', JSON.stringify(last));

    // ---- second launch hands over its args ----
    const second = launch(['--session=s_second']);
    pids.push(second.pid);
    const code = await new Promise((r) => { second.on('exit', r); setTimeout(() => r('timeout'), 20000); });
    await sleep(800);
    st = R(await c.rpc('test.hostState'));
    check('second launch exits and focuses the first', code === 0 && st.window.visible, String(code));
    check('second launch --session selects it in the first', st.selects.includes('s_second'), JSON.stringify(st.selects));

    // ---- Tailscale / phone pairing from this PC ----
    const hello = R(await c.rpc('app.hello'));
    const phoneUrl = hello && hello.settings.phone.url;
    if (!phoneUrl) notes.push('Tailscale: no phone url (Tailscale down or no 100.x address); pairing not checked');
    else {
      const u = new URL(phoneUrl);
      const ipBase = `http://${u.hostname}:${u.port}`;
      const pair = await get(`${ipBase}/?key=${ready.token}`);
      check(`phone pairing ${u.hostname}: /?key= -> 302 + cookie`, pair.status === 302 && /helm_key=/.test(pair.headers['set-cookie'] || ''), JSON.stringify({ s: pair.status, e: pair.error }));
      const cookie = (pair.headers && (pair.headers['set-cookie'] || [])[0] || '').split(';')[0];
      check('phone: / with cookie -> 200', (await get(`${ipBase}/`, { cookie })).status === 200);
      check('phone: / without cookie -> 401', (await get(`${ipBase}/`)).status === 401);
      const pc = await client(`ws://${u.hostname}:${u.port}/ws`, { cookie, origin: ipBase });
      const ph = pc.open ? R(await pc.rpc('app.hello')) : null;
      check('phone: WS via cookie opens as platform web', pc.open && ph && ph.platform === 'web', JSON.stringify({ open: pc.open, status: pc.status }));
      try { pc.ws.close(); } catch {}
    }
    try { c.ws.close(); } catch {}
  } catch (e) {
    failures++; console.log('  FAIL crashed: ' + (e && e.stack || e));
  } finally {
    for (const p of pids) killTree(p);
    if (page) page.close();
    await sleep(500);
    const log = path.join(userData, 'logs', 'main.log');
    if (fs.existsSync(log)) {
      const txt = fs.readFileSync(log, 'utf8');
      check('no renderer crash in log', !/renderer gone/.test(txt));
      check('no rpc internal errors in log', !/rpc .* threw/.test(txt), (txt.match(/rpc .* threw.*/g) || []).slice(0, 2).join(' | '));
    }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
  for (const n of notes) console.log('  note ' + n);
  console.log(`\ndesktop-check: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();
