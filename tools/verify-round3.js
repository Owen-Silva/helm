// Round-3 verification in the REAL app: Helm.exe --test (hidden window, throwaway profile, the real
// server's CSP, the real Claude Code with a cheap model). Every check is pass/fail with its evidence;
// renderer console messages from every webContents (test.console) are collected for the whole run and
// any CSP violation / page error fails check 1. Captures land in --shots (default .shots/verify3).
// Stops only the PIDs it starts. Never touches the user's real Helm (port 4871, %APPDATA%\Helm).
//
// Usage: node tools/verify-round3.js [--only=1,2,...] [--model=claude-haiku-5-5] [--exe=dist/Helm/Helm.exe]
//                                    [--shots=.shots/verify3] [--keep] [--big=<claudeSessionId>]
//   checks: 1 CSP/console sweep, 2 real session (tools, find, fork, edit&resend, rewind ids live+reloaded),
//           3 split view streaming, 4 paging a big transcript, 5 Elsewhere, 6 ETA, 7 settings round trip,
//           8 light theme captures, 9 interrupt right after start (soak finding)
// Owner: lane final-verify.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const MODEL = arg('model') || 'claude-haiku-5-5';
const EXE = path.resolve(ROOT, arg('exe') || 'dist/Helm/Helm.exe');
const SHOTS = path.resolve(ROOT, arg('shots') || '.shots/verify3');
const ONLY = arg('only') ? new Set(arg('only').split(',').map(Number)) : null;
const KEEP = process.argv.includes('--keep');
const want = (n) => !ONLY || ONLY.has(n);
const profile = 'v3' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const repo = path.join(os.tmpdir(), 'helm-v3-' + process.pid);
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const EXT_DIR = path.join(os.tmpdir(), 'helm-v3-ext-' + process.pid);   // C5's own external transcripts
const EXT_PROMPT = 'helm verify elsewhere probe ' + process.pid;
const ETA_DIR = process.env.HELM_ETA_DIR || path.join(os.homedir(), '.claude', 'mods-data', 'eta');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';
const note = (...a) => console.log(stamp(), ...a);
const short = (o, n = 300) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s && s.length > n ? s.slice(0, n) + '…' : s; };

// ---------- results ----------
const results = [];
function record(n, name, ok, reason) {
  results.push({ n, name, ok, reason });
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} C${n} ${name}${reason ? ' :: ' + reason : ''}`);
}
function checks() {
  const fails = [], evidence = [];
  const c = (ok, what) => { if (!ok) fails.push(what); return ok; };
  c.ev = (s) => evidence.push(s);
  c.result = () => ({ ok: !fails.length, reason: fails.length ? fails.join('; ') : evidence.join('; ') });
  return c;
}
async function check(n, name, fn) {
  if (!want(Math.floor(n))) return;
  try { const r = await fn(); record(n, name, !!r.ok, r.reason || ''); }
  catch (e) { record(n, name, false, 'threw: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
}

// ---------- app ----------
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
let A = null;
async function startApp() {
  const child = spawn(EXE, ['.', '--test', '--profile=' + profile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, HELM_TEST_EXTERNAL_DIRS: EXT_DIR } });
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
      conSince = 0;   // test.console counts per process
      note(`app up: pid ${child.pid} port ${ready.port} engine ${ready.engine} exe ${path.basename(ready.exe)}`);
      return { child, ready, out: () => out, c: client(ws) };
    }
    if (child.exitCode !== null) throw new Error('app exited early:\n' + out.slice(-2000));
    await sleep(250);
  }
  killTree(child.pid);
  throw new Error('no HELM_READY within 60 s:\n' + out.slice(-2000));
}
async function stopApp() {
  if (!A) return;
  try { await drainConsole(); } catch {}
  try { A.c.ws.close(); } catch {}
  killTree(A.child.pid);
  A = null;
  await sleep(1500);
}

function client(ws) {
  let id = 1;
  const pending = new Map(), events = [], items = new Map(), sessions = new Map();
  const itemsOf = (sid) => { if (!items.has(sid)) items.set(sid, new Map()); return items.get(sid); };
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); return; }
    if (m.type !== 'event') return;
    m.t = Date.now();
    events.push(m);
    const d = m.data || {};
    if (m.event === 'session.item') itemsOf(d.sessionId).set(d.item.id, { ...d.item });
    else if (m.event === 'session.itemUpdate') {
      const it = itemsOf(d.sessionId).get(d.itemId);
      if (it) { Object.assign(it, d.patch || {}); if (d.appendText) it.text = (it.text || '') + d.appendText; }
    } else if (m.event === 'session.created' || m.event === 'session.updated') sessions.set(d.id, d);
  });
  async function call(method, params = {}, timeout = 30000) {
    const i = id++;
    const m = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, timeout);
      pending.set(i, (r) => { clearTimeout(t); resolve(r); });
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
    });
    if (m.error) throw Object.assign(new Error(`${method}: ${m.error.message}`), { code: m.error.code });
    return m.result;
  }
  async function waitFor(pred, timeout, what) {
    const end = Date.now() + timeout;
    for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(100); }
  }
  return { ws, call, events, items, sessions, itemsOf, waitFor };
}

// ---------- page driving (test.eval) ----------
// Helpers installed once per page load; every inPage(fn, ...args) call runs fn(h, ...args) in the window.
const PRELUDE = `if (!window.__v3) window.__v3 = (async () => {
  const [store, state, split, actions] = await Promise.all([import('/lib/store.js'), import('/shell/state.js'), import('/shell/split.js'), import('/chat/actions.js')]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; for (;;) { let v; try { v = pred(); } catch { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(100); } };
  const text = (el) => (el ? (el.innerText || el.textContent || '') : '');
  const setValue = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (k, o = {}, target) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }); (target || document.activeElement || document.body).dispatchEvent(e); return e.defaultPrevented; };
  const btn = (root, label) => [...(root || document).querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '').trim() === label || b.textContent.trim() === label) || null;
  const itemEl = (id, root) => (root || document).querySelector('[data-item-id="' + CSS.escape(id) + '"]');
  return { store, state, split, actions, sleep, waitFor, text, setValue, key, btn, itemEl };
})();`;
async function inPage(fn, ...args) {
  const js = `${PRELUDE}\nwindow.__v3.then((h) => (${fn})(h, ${args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ')}))`;
  return A.c.call('test.eval', { js }, 90000);
}

// ---------- console (whole run) ----------
let conSince = 0;
const conAll = []; // { phase, ...entry }
let phase = 'boot';
async function drainConsole() {
  if (!A) return [];
  const r = await A.c.call('test.console', { since: conSince });
  conSince = r.next;
  for (const e of r.entries) conAll.push({ phase, ...e });
  return r.entries;
}
const isCsp = (e) => /Content Security Policy|Refused to (execute|load|apply|evaluate|create|connect|frame)/i.test(e.message);
const isBad = (e) => e.level === 'error' || e.level === 'crash' || isCsp(e) || /Uncaught|unhandled/i.test(e.message);
async function setPhase(p) { await drainConsole(); phase = p; }

async function capture(name, sessionId, waitMs = 1500) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name);
  const r = await A.c.call('test.capture', { file, sessionId: sessionId || undefined, waitMs }, 30000);
  note(`  capture ${path.relative(ROOT, r.file)} ${r.width}x${r.height}${r.empty ? ' EMPTY' : ''}`);
  return r;
}

// ---------- live turns ----------
const spend = { results: 0 };
const itemList = (sid) => [...A.c.itemsOf(sid).values()];
function autoAllow(sid, handled) {
  for (const it of itemList(sid)) {
    if (it.type !== 'request' || it.status !== 'pending' || handled.has(it.requestId)) continue;
    handled.add(it.requestId);
    const response = it.kind === 'question' ? { answers: Object.fromEntries((it.questions || []).map((q) => [q.question, ((q.options || [])[0] || { label: 'No' }).label])) } : { behavior: 'allow' };
    A.c.call('sessions.respond', { id: sid, requestId: it.requestId, response }).catch(() => {});
  }
}
async function waitResult(sid, before, timeout = 180000) {
  const handled = new Set();
  const res = await A.c.waitFor(() => { autoAllow(sid, handled); return itemList(sid).find((it) => it.type === 'result' && !before.has(it.id)); }, timeout, 'result in ' + sid);
  await A.c.waitFor(() => { const s = A.c.sessions.get(sid); return s && s.status !== 'working'; }, 20000, 'idle').catch(() => {});
  if (typeof res.costUsd === 'number') spend.results += res.costUsd;
  return res;
}
async function turn(sid, text, timeout) {
  const before = new Set(A.c.itemsOf(sid).keys());
  await A.c.call('sessions.send', { id: sid, text });
  const result = await waitResult(sid, before, timeout);
  return { result, items: itemList(sid).filter((it) => !before.has(it.id)) };
}
const textOf = (items) => items.filter((it) => it.type === 'assistant').map((it) => it.text || '').join('\n');

function makeRepo() {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'The first word is alpha.\nThe second line stays.\n');
  fs.writeFileSync(path.join(repo, 'app.js'), "console.log('hello');\n");
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=v3@helm.local', '-c', 'user.name=helm v3', 'add', '.');
  git('-c', 'user.email=v3@helm.local', '-c', 'user.name=helm v3', 'commit', '-q', '-m', 'init');
}
const projectDirFor = (cwd) => path.join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, '-'));

// ======================================================================
const S = {}; // shared state between checks: sessions, items

async function c7Settings() {
  await setPhase('settings');
  const k = checks();
  const c = A.c;
  const s0 = await c.call('settings.get');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/assets/backgrounds/catalog.json'), 'utf8'));
  k(catalog.length >= 23, 'catalog has ' + catalog.length);
  const missing = catalog.filter((x) => !s0.backgrounds.includes(x.file)).map((x) => x.file);
  k(!missing.length, 'catalog files not in settings.backgrounds: ' + missing.join(','));
  const thumbsMissing = catalog.filter((x) => !fs.existsSync(path.join(ROOT, 'ui/assets/backgrounds/thumbs', x.file))).map((x) => x.file);
  k(!thumbsMissing.length, 'thumbs missing: ' + thumbsMissing.join(','));
  // bundled photo via the RPC
  const pick = catalog.find((x) => x.file !== s0.background.file).file;
  const s1 = await c.call('settings.set', { background: { file: pick } });
  k(s1.background.file === pick, 'settings.set background -> ' + s1.background.file);
  // upload a small PNG (a real 1x1 PNG)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const s2 = await c.call('settings.uploadBackground', { name: 'verify upload.png', dataUrl: 'data:image/png;base64,' + png });
  const up = s2.background.file;
  k(/^verify-upload(-\d+)?\.png$/.test(up || ''), 'upload file name ' + up);
  k(s2.backgrounds.includes(up), 'upload not listed');
  k(fs.existsSync(path.join(userData, 'backgrounds', up || 'x')), 'upload not on disk');
  let bad = null;
  try { await c.call('settings.uploadBackground', { name: 'x.png', dataUrl: 'data:image/png;base64,AAAA' }); } catch (e) { bad = e.code; }
  k(bad === 'bad_params', 'bogus upload -> ' + bad);
  const served = await inPage(async (h, f) => { const r = await fetch('/bg/' + encodeURIComponent(f)); return { status: r.status, type: r.headers.get('content-type') }; }, up);
  k(served.status === 200 && /image\/png/.test(served.type), 'upload served ' + short(served));
  k.ev(`bundled ${pick} + upload ${up} served ${served.status}`);

  // launch at login ON then OFF: a test run records what it would write (never the user's Run key) ...
  await c.call('settings.set', { launchAtLogin: true });
  await sleep(300);
  const recOn = await c.call('test.loginRecord');
  await c.call('settings.set', { launchAtLogin: false });
  await sleep(300);
  const recOff = await c.call('test.loginRecord');
  const lastOn = recOn[recOn.length - 1], lastOff = recOff[recOff.length - 1];
  k(lastOn && lastOn.openAtLogin === true, 'login ON record ' + short(lastOn));
  k(lastOff && lastOff.openAtLogin === false, 'login OFF record ' + short(lastOff));
  // ... plus one REAL HKCU Run round trip under the test-only name "HelmTest", removed again
  const li = await c.call('test.loginItem', {}, 20000);
  let after = 'absent';
  try { execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'HelmTest'], { stdio: 'ignore' }); after = 'PRESENT'; } catch {}
  // getLoginItemSettings drops switches (--hidden) when it parses the Run value back, so its openAtLogin
  // reads false for our args (see desktop-check.js); judge by the Run value + launchItems.
  k(/Helm\.exe" "[^"]+helm" --hidden$/i.test(li.regValue || '') && (li.on.launchItems || []).some((x) => x.name === 'HelmTest'), 'real login item not written: ' + short(li.regValue));
  k(!(li.off.launchItems || []).some((x) => x.name === 'HelmTest') && after === 'absent', `real login item not removed (reg ${after})`);
  k.ev(`login item on/off recorded; HelmTest reg ${after} after`);

  // hotkey: change, reject junk, restore
  const hk0 = s0.quickPromptHotkey;
  const h1 = await c.call('settings.set', { quickPromptHotkey: 'Control+Alt+Shift+H' });
  k(h1.quickPromptHotkey === 'Control+Alt+Shift+H', 'hotkey set -> ' + h1.quickPromptHotkey);
  let hbad = null;
  try { await c.call('settings.set', { quickPromptHotkey: 'a\nb' }); } catch (e) { hbad = e.code; }
  k(hbad === 'bad_params', 'bad hotkey -> ' + hbad);
  const h2 = await c.call('settings.set', { quickPromptHotkey: hk0 });
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  k(h2.quickPromptHotkey === hk0 && onDisk.quickPromptHotkey === hk0, `hotkey restore -> ${h2.quickPromptHotkey} / disk ${onDisk.quickPromptHotkey}`);

  // the settings UI: gallery categories, thumbnails, picking a photo changes the background.
  // Look Sync: a fresh profile follows the desktop wallpaper and has no picker; the gallery is "Own picture".
  const own = await c.call('settings.set', { background: { mode: 'own' } });
  k(own.background.mode === 'own', 'background.mode own -> ' + own.background.mode);
  const g = await inPage(async (h) => {
    h.state.go('settings');
    const gal = await h.waitFor(() => document.querySelector('.gal-opt:not(.add)') && document.querySelectorAll('.chip').length > 1, 8000);
    const out = { opened: !!gal, cats: [] };
    const chips = [...document.querySelectorAll('.chip')].filter((b) => b.closest('section, div') && b.parentElement.querySelector('.chip'));
    const galChips = chips.filter((b) => b.parentElement === chips[0].parentElement);
    for (const ch of galChips) {
      ch.click();
      await h.sleep(500);
      const tiles = [...document.querySelectorAll('.gal-opt:not(.add)')];
      const imgs = tiles.map((t) => t.querySelector('img')).filter(Boolean);
      for (const im of imgs) im.loading = 'eager';   // the hidden window never scrolls lazy tiles into view
      await h.waitFor(() => imgs.every((im) => im.complete), 6000);
      out.cats.push({ label: ch.textContent.trim(), pressed: ch.getAttribute('aria-pressed'), tiles: tiles.length, loaded: imgs.filter((im) => im.complete && im.naturalWidth > 0).length, imgs: imgs.length, thumbs: imgs.filter((im) => /\/thumbs\//.test(im.src)).length });
    }
    galChips[0].click();   // back to All
    await h.sleep(300);
    const cur = h.store.settings.value.background.file;
    const tile = [...document.querySelectorAll('.gal-opt:not(.add)')].find((t) => t.getAttribute('aria-checked') !== 'true' && /\/thumbs\//.test(t.querySelector('img')?.src || ''));
    const want = tile && decodeURIComponent((tile.querySelector('img').src.split('/thumbs/')[1] || ''));
    tile && tile.click();
    const changed = await h.waitFor(() => h.store.settings.value.background.file === want && (document.querySelector('.bg-photo')?.style.backgroundImage || '').includes(encodeURIComponent(want)), 6000);
    out.pick = { from: cur, want, changed: !!changed, layer: (document.querySelector('.bg-photo')?.style.backgroundImage || '').slice(0, 120) };
    return out;
  });
  k(g.opened, 'settings gallery never rendered');
  k(g.cats.length >= 3, 'category chips ' + g.cats.length);
  for (const cat of g.cats) {
    k(cat.tiles > 0, `category ${cat.label}: no tiles`);
    k(cat.loaded === cat.imgs, `category ${cat.label}: ${cat.loaded}/${cat.imgs} images loaded`);
  }
  k(g.pick.changed, 'picking a photo did not change the background: ' + short(g.pick));
  k.ev(`${g.cats.length} chips (${g.cats.map((x) => `${x.label}:${x.loaded}/${x.tiles}`).join(' ')}); pick ${g.pick.want} -> layer updated`);
  await capture('c7-settings-gallery.png');
  const cons = (await drainConsole()).filter(isBad);
  k(!cons.length, 'console errors in settings: ' + short(cons.map((e) => e.message), 400));
  await inPage(async (h) => { h.state.go('session'); return true; });
  return k.result();
}

async function c2Session() {
  await setPhase('session');
  const k = checks();
  const c = A.c;
  const s = await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' });
  S.a = s.id;
  await inPage(async (h, id) => { h.state.openSession(id); return true; }, S.a);
  const t1 = await turn(S.a, 'In notes.txt change the word alpha to omega (use the Edit tool). Then run `git diff --stat` with the Bash tool and tell me its output in one short line.');
  const tl = t1.items.filter((it) => it.type === 'tool');
  k(tl.some((it) => /Edit|Write|MultiEdit/.test(it.name) && it.status === 'done'), 'no finished edit tool: ' + short(tl.map((t) => t.name + ':' + t.status)));
  k(tl.some((it) => it.name === 'Bash' && it.status === 'done'), 'no finished Bash tool');
  k(/omega/.test(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')), 'notes.txt not edited');
  k(t1.result && !t1.result.isError, 'result isError');
  const dom = await inPage(async (h, id) => {
    await h.waitFor(() => document.querySelector('.turn-end'), 5000);
    const main = document.querySelector('main.main');
    const toolsEls = main.querySelectorAll('[class*="tool"]');
    return { tools: toolsEls.length, turnEnd: h.text(main.querySelector('.turn-end')).trim(), user: main.querySelectorAll('.msg-user').length, asst: main.querySelectorAll('.msg-assistant').length, text: h.text(main).slice(0, 4000) };
  }, S.a);
  k(dom.user === 1 && dom.asst >= 1 && dom.tools > 0, 'DOM rows ' + short({ user: dom.user, asst: dom.asst, tools: dom.tools }));
  k(/Edit|Update|notes\.txt/.test(dom.text) && /git diff|Bash/i.test(dom.text), 'tool rows not visible in text');
  k(dom.turnEnd.length > 0, 'no result row');
  k.ev(`turn1 tools ${tl.map((t) => t.name).join(',')}; result row "${dom.turnEnd.slice(0, 60)}"`);
  // open the edit row so the diff renders, then capture
  const diff = await inPage(async (h) => {
    const head = document.querySelector('main.main .tgroup-head[aria-expanded="false"]');
    if (head) { head.click(); await h.sleep(500); }
    const rows = [...document.querySelectorAll('main.main .trow-line')];
    const edit = rows.find((b) => /^(Edit|Update)/.test(b.textContent.trim()) && /notes\.txt/.test(b.textContent) && b.getAttribute('aria-expanded') !== 'true');
    if (edit) edit.click();
    await h.sleep(600);
    const d = document.querySelector('main.main .dv');
    return { group: !!head, rows: rows.map((r) => r.textContent.trim().slice(0, 40)), diff: !!d, text: h.text(d).slice(0, 200) };
  });
  k(diff.diff && /alpha|omega/.test(diff.text), 'diff not rendered: ' + short(diff));
  await capture('c2-turn1.png', S.a);

  const t2 = await turn(S.a, 'Reply with exactly: second turn ok');
  k(/second turn ok/i.test(textOf(t2.items)), 'turn 2 reply ' + short(textOf(t2.items), 80));
  // ids: the UI store vs the engine's checkpoints (live)
  const ids = await inPage(async (h, id) => {
    const its = h.store.itemsBySession.value[id] || [];
    return { users: its.filter((i) => i.type === 'user').map((i) => ({ id: i.id, text: (i.text || '').slice(0, 40) })), dup: its.length - new Set(its.map((i) => i.id)).size };
  }, S.a);
  const cps = await c.call('sessions.checkpoints', { id: S.a });
  const uiUsers = ids.users.map((u) => u.id);
  k(ids.dup === 0, 'duplicate item ids in the store: ' + ids.dup);
  k(cps.length === 2 && cps.every((cp) => uiUsers.includes(cp.itemId)), `live checkpoint itemIds ${short(cps.map((x) => x.itemId))} vs UI ${short(uiUsers)}`);
  S.users = ids.users;
  S.cpsLive = cps.map((x) => ({ id: x.id, itemId: x.itemId }));
  k.ev(`live checkpoint ids match UI (${uiUsers.join(',')})`);

  // Ctrl+F
  const f = await inPage(async (h) => {
    const main = document.querySelector('main.main');
    main.querySelector('.msg-user')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    h.key('f', { ctrlKey: true }, document.body);
    const input = await h.waitFor(() => document.querySelector('main.main .find-input'), 3000);
    if (!input) return { open: false };
    h.setValue(input, 'omega');
    await h.sleep(500);
    const t0 = Date.now();
    const painted = await h.waitFor(() => CSS.highlights && CSS.highlights.has('helm-find') && CSS.highlights.get('helm-find').size > 0, 4000);
    const cur = CSS.highlights?.get('helm-find-cur');
    const r0 = cur && [...cur][0];
    return { open: true, paintMs: painted ? Date.now() - t0 : -1, curText: r0 ? r0.toString() : null, curVisible: r0 ? (() => { const b = r0.getBoundingClientRect(); const m = document.querySelector('main.main').getBoundingClientRect(); return b.height > 0 && b.top >= m.top && b.bottom <= m.bottom; })() : null, bar: h.text(document.querySelector('main.main .find-count')).trim(), hl: typeof CSS !== 'undefined' && CSS.highlights ? [...CSS.highlights.keys()] : [] };
  });
  k(f.open, 'find bar did not open');
  k(f.open && /^[1-9]\d* of [1-9]/.test(f.bar) && f.hl.includes('helm-find'), 'find count/paint ' + short(f));   // typing jumps to the NEWEST match
  k(f.open && /omega/i.test(f.curText || '') && f.curVisible, 'current match not painted in view ' + short(f));
  await capture('c2-find.png');
  k.ev(`find "${f.bar}" painted in ${f.paintMs} ms, current "${f.curText}" in view ${f.curVisible}`);
  await inPage(async (h) => { h.key('Escape', {}, document.querySelector('main.main input') || document.body); return true; });

  // Fork from the second user message (UI button)
  const second = ids.users[1];
  const fk = await inPage(async (h, sid, itemId) => {
    const el = h.itemEl(itemId);
    const b = el && h.btn(el, 'Fork from here');
    if (!b) return { err: 'no Fork button', html: el ? el.outerHTML.slice(0, 300) : null };
    const before = h.store.sessions.value.length;
    b.click();
    const s = await h.waitFor(() => h.store.sessions.value.length > before && h.store.activeId.value !== sid && h.store.activeSession.value, 15000);
    if (!s) return { err: 'fork never opened' };
    await h.waitFor(() => (h.store.itemsBySession.value[s.id] || []).length, 8000);
    await h.sleep(800);
    const main = document.querySelector('main.main');
    const ta = main.querySelector('textarea');
    return { id: s.id, title: s.title, items: (h.store.itemsBySession.value[s.id] || []).map((i) => i.type), domUsers: main.querySelectorAll('.msg-user').length, draft: ta ? ta.value : null, hasOmega: /omega/.test(h.text(main)) };
  }, S.a, second.id);
  k(!fk.err, 'fork: ' + short(fk));
  if (!fk.err) {
    S.fork = fk.id;
    k(/\(fork\)$/.test(fk.title || ''), 'fork title ' + fk.title);
    k(fk.domUsers === 1 && fk.hasOmega, `fork view shows ${fk.domUsers} user msgs, omega ${fk.hasOmega}`);
    k(/second turn ok/.test(fk.draft || ''), 'fork draft ' + short(fk.draft));
    await capture('c2-fork.png', S.fork);
    const tf = await turn(S.fork, 'Which word did you change alpha to in notes.txt? Answer with that one word only.');
    k(/omega/i.test(textOf(tf.items)), 'fork answer not in context: ' + short(textOf(tf.items), 80));
    k.ev(`fork ${fk.title} answered "${textOf(tf.items).trim().slice(0, 30)}"`);
  }

  // Edit & resend the second message (UI inline editor)
  await inPage(async (h, id) => { h.state.openSession(id); await h.sleep(800); return true; }, S.a);
  const er = await inPage(async (h, sid, itemId) => {
    const el = h.itemEl(itemId);
    const b = el && h.btn(el, 'Edit & resend');
    if (!b) return { err: 'no Edit button' };
    b.click();
    const ta = await h.waitFor(() => document.querySelector('.msg-edit-ta'), 3000);
    if (!ta) return { err: 'editor did not open' };
    h.setValue(ta, 'Which word did you change alpha to in notes.txt? Answer with that one word only.');
    await h.sleep(200);
    const before = h.store.sessions.value.length;
    h.btn(ta.closest('.msg-edit'), 'Send').click();
    const s = await h.waitFor(() => h.store.sessions.value.length > before && h.store.activeId.value !== sid && h.store.activeSession.value, 15000);
    return s ? { id: s.id, title: s.title } : { err: 'edit & resend never opened a session' };
  }, S.a, second.id);
  k(!er.err, 'edit&resend: ' + short(er));
  if (!er.err) {
    S.edit = er.id;
    const res = await waitResult(S.edit, new Set());
    const its = (await c.call('sessions.history', { id: S.edit })).items;
    const prompts = its.filter((i) => i.type === 'user').map((i) => i.text);
    k(prompts.length === 2 && /Which word/.test(prompts[1]) && !prompts.some((p) => /second turn ok/.test(p)), 'edit prompts ' + short(prompts));
    k(/omega/i.test(textOf(its)), 'edit answer not in context: ' + short(textOf(its).slice(-80)));
    k(res && !res.isError, 'edit result error');
    await capture('c2-edit-resend.png', S.edit);
    k.ev(`edit&resend answered "${textOf(its).trim().slice(-30)}"`);
  }

  // Rewind to here on the FIRST message (it has the edit's checkpoint): files only -> notes.txt back to alpha
  await inPage(async (h, id) => { h.state.openSession(id); await h.sleep(800); return true; }, S.a);
  const first = ids.users[0];
  const rw = await inPage(async (h, sid, itemId) => {
    const el = h.itemEl(itemId);
    const b = el && h.btn(el, 'Rewind to here');
    if (!b) return { err: 'no Rewind button' };
    const toasts0 = h.store.toasts.value.length;
    b.click();
    const dlg = await h.waitFor(() => h.btn(document, 'Files only'), 5000);
    if (!dlg) return { err: 'rewind dialog did not open', toasts: h.store.toasts.value.slice(toasts0).map((t) => t.title) };
    dlg.click();
    await h.sleep(200);
    const go = [...document.querySelectorAll('button.btn-danger')].find((x) => x.textContent.trim() === 'Rewind');
    go.click();
    const done = await h.waitFor(() => h.store.toasts.value.slice(toasts0).find((t) => /Rewound|failed/i.test(t.title)) || document.querySelector('.pn-ch-rw-err'), 30000);
    return { done: done ? (done.title ? done.title + ': ' + (done.body || '') : 'error: ' + h.text(done)) : null };
  }, S.a, first.id);
  k(!rw.err, 'rewind: ' + short(rw));
  if (!rw.err) {
    k(/Rewound/.test(rw.done || ''), 'rewind result ' + short(rw.done));
    k(/alpha/.test(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')), 'notes.txt not restored to alpha');
    k.ev('rewind files -> ' + short(rw.done, 80));
  }
  return k.result();
}

// Reload: same profile, new process. History ids vs checkpoint itemIds after a restart.
async function c2Reloaded() {
  const k = checks();
  await stopApp();
  A = await startApp();
  await setPhase('reloaded');
  const h = await A.c.call('sessions.history', { id: S.a });
  const users = h.items.filter((i) => i.type === 'user').map((i) => i.id);
  const cps = await A.c.call('sessions.checkpoints', { id: S.a });
  k(cps.length >= 2 && cps.every((cp) => users.includes(cp.itemId)), `reloaded checkpoint itemIds ${short(cps.map((x) => x.itemId))} vs history ${short(users)}`);
  const ui = await inPage(async (hh, id) => {
    hh.state.openSession(id);
    await hh.waitFor(() => (hh.store.itemsBySession.value[id] || []).length, 8000);
    return (hh.store.itemsBySession.value[id] || []).filter((i) => i.type === 'user').map((i) => i.id);
  }, S.a);
  k(cps.every((cp) => ui.includes(cp.itemId)), `reloaded UI ids ${short(ui)}`);
  // the Rewind button must find a checkpoint after the reload too (no "No checkpoint" toast)
  const rw = await inPage(async (hh, itemId) => {
    await hh.sleep(800);
    const el = hh.itemEl(itemId);
    const b = el && hh.btn(el, 'Rewind to here');
    if (!b) return { err: 'no Rewind button' };
    const t0 = hh.store.toasts.value.length;
    b.click();
    const dlg = await hh.waitFor(() => hh.btn(document, 'Files only'), 5000);
    const toasts = hh.store.toasts.value.slice(t0).map((t) => t.title);
    if (dlg) hh.btn(document, 'Cancel')?.click();
    return { dialog: !!dlg, toasts };
  }, ui[0]);
  k(rw.dialog, 'rewind after reload: ' + short(rw));
  k.ev(`reloaded ids match (${users.join(',')}), rewind dialog opens`);
  return k.result();
}

async function c3Split() {
  await setPhase('split');
  const k = checks();
  const c = A.c;
  const b = await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' });
  S.b = b.id;
  if (!S.a) S.a = (await c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' })).id;
  const left = S.a, right = S.b;
  const ok = await inPage(async (h, l, r) => { h.state.openSession(l); await h.sleep(500); const x = h.split.openSplit(r, 1); await h.sleep(800); return { x, panes: document.querySelectorAll('main.main.pane').length, split: h.split.split.value }; }, left, right);
  k(ok.panes === 2, 'split panes ' + short(ok));
  // Warm both CLIs before the race: a fresh session's first turn spawns claude.exe (SessionStart
  // hooks, MCP), which once landed the right pane's stream ~10 s after the left one's.
  for (const sid of [right, left]) if (!itemList(sid).some((it) => it.type === 'result')) await turn(sid, 'Reply with the single word ready.', 120000);
  const N = 300;   // ~3-4 s of haiku stream per pane (120 lines was ~1.4 s)
  const words = [['apple', 'banana'], ['cherry', 'damson']];
  let a = null;
  for (let attempt = 0; attempt < words.length; attempt++) {
    a = await c3Race(left, right, N, words[attempt][0], words[attempt][1], attempt);
    // Retry once, with fresh words, only when the API itself staggered the streams: both sessions
    // were 'working' together, yet one stream began after the other had already ended.
    if (a.overlapMs > 0 || !a.staggered || attempt === words.length - 1) break;
    note(`  C3 attempt ${attempt + 1}: the API staggered the two streams (left ${short(a.wl)} right ${short(a.wr)}, start gap ${a.gapMs} ms); RETRYING once with fresh words`);
    k.ev(`attempt 1 RETRIED: the API staggered the streams by ${a.gapMs} ms`);
  }
  const { wl, wr, overlapMs, samples, fin, both, midL, midR, bothWorkingAt, wa, wb, shot } = a;
  k(bothWorkingAt != null, 'the two sessions never reported working at the same time');
  k(overlapMs > 0, `stream windows do not overlap: left ${short(wl)} right ${short(wr)}${a.staggered ? ' (API staggered both attempts)' : ''}`);
  k(both > 0, 'never saw both panes streaming and growing at once in the DOM (' + samples.length + ' samples)');
  k(samples.every((x) => !x.a[1] && !x.b[0]), 'cross-talk: ' + short(samples.filter((x) => x.a[1] || x.b[0]).slice(0, 2)));
  k(fin.a[0] >= N - 5 && fin.b[1] >= N - 5, 'final counts ' + short(fin));
  k(midL > 0 && midR > 0, `panes never seen mid-stream (left ${midL}, right ${midR})`);
  if (!shot) await capture('c3-split-final.png');
  k.ev(`words ${wa}/${wb}; WS stream overlap ${overlapMs} ms (${wl && wl[2]}/${wr && wr[2]} deltas, streams ${wl ? wl[1] - wl[0] : '-'}/${wr ? wr[1] - wr[0] : '-'} ms); DOM ${samples.length} samples, ${both} with both panes streaming and growing, mid-stream left ${midL} right ${midR}; final ${fin.a[0]}/${fin.b[1]}, cross 0`);
  return k.result();
}

// One race: both sends at once, an in-page DOM sampler every 50 ms, stream windows from the WS deltas.
// Measurement starts only once BOTH sessions report 'working'.
async function c3Race(left, right, N, wa, wb, attempt) {
  const c = A.c;
  const bl = new Set(c.itemsOf(left).keys()), br = new Set(c.itemsOf(right).keys());
  const prompt = (w) => `Write the numbers 1 to ${N}, one per line, each followed by a space and the word ${w}. No other text.`;
  await inPage(async (h, wa, wb) => {
    const count = (s, w) => (s.match(new RegExp('\\b' + w + '\\b', 'g')) || []).length;
    window.__v3split = [];
    clearInterval(window.__v3splitT);
    window.__v3splitT = setInterval(() => {
      const panes = [...document.querySelectorAll('main.main.pane')];
      const t = panes.map((p) => h.text(p));
      window.__v3split.push({ t: Date.now(), a: t.map((s) => count(s, wa)), b: t.map((s) => count(s, wb)), streaming: panes.map((p) => !!p.querySelector('.msg-assistant.streaming')) });
      if (window.__v3split.length > 6000) clearInterval(window.__v3splitT);
    }, 50);
    return true;
  }, wa, wb);
  const ev0 = c.events.length;
  await Promise.all([c.call('sessions.send', { id: left, text: prompt(wa) }), c.call('sessions.send', { id: right, text: prompt(wb) })]);
  let shot = false;
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    const s = await inPage(async () => window.__v3split[window.__v3split.length - 1] || null);
    if (!shot && s && s.streaming[0] && s.streaming[1] && s.a[0] > 5 && s.b[1] > 5) { await capture(`c3-split-streaming${attempt ? '-retry' : ''}.png`, null, 100); shot = true; }
    const lDone = itemList(left).some((it) => it.type === 'result' && !bl.has(it.id));
    const rDone = itemList(right).some((it) => it.type === 'result' && !br.has(it.id));
    if (lDone && rDone) break;
    await sleep(250);
  }
  for (const sid of [left, right]) { const r = itemList(sid).find((it) => it.type === 'result' && !(sid === left ? bl : br).has(it.id)); if (r && typeof r.costUsd === 'number') spend.results += r.costUsd; }
  await c.waitFor(() => [left, right].every((sid) => { const s = c.sessions.get(sid); return s && s.status !== 'working'; }), 20000, 'both idle').catch(() => {});
  await sleep(1000);
  const all = await inPage(async () => { clearInterval(window.__v3splitT); return window.__v3split; });
  const evs = c.events.slice(ev0);
  const status = { [left]: null, [right]: null };
  let bothWorkingAt = null;
  for (const e of evs) {
    if ((e.event === 'session.updated' || e.event === 'session.created') && e.data && e.data.id in status) status[e.data.id] = e.data.status;
    if (bothWorkingAt == null && status[left] === 'working' && status[right] === 'working') bothWorkingAt = e.t;
  }
  const win = (sid) => { const ts = evs.filter((e) => e.event === 'session.itemUpdate' && e.data.sessionId === sid && e.data.appendText).map((e) => e.t); return ts.length ? [Math.min(...ts), Math.max(...ts), ts.length] : null; };
  const wl = win(left), wr = win(right);
  const overlapMs = wl && wr && bothWorkingAt != null ? Math.min(wl[1], wr[1]) - Math.max(wl[0], wr[0], bothWorkingAt) : -1;
  const gapMs = wl && wr ? Math.abs(wl[0] - wr[0]) : -1;
  const staggered = !!(bothWorkingAt != null && wl && wr && overlapMs <= 0);
  const samples = all.filter((x) => bothWorkingAt == null || x.t >= bothWorkingAt);
  // A "both" sample: both panes streaming, and BOTH panes' text grew over the preceding 500 ms.
  let both = 0;
  for (const x of samples) {
    if (!(x.streaming[0] && x.streaming[1] && x.a[0] > 0 && x.b[1] > 0)) continue;
    const back = samples.find((y) => y.t >= x.t - 500 && y.t < x.t);
    if (back && back.a[0] < x.a[0] && back.b[1] < x.b[1]) both++;
  }
  const midL = samples.filter((x) => x.a[0] > 0 && x.a[0] < N - 20).length, midR = samples.filter((x) => x.b[1] > 0 && x.b[1] < N - 20).length;
  const fin = all[all.length - 1] || { a: [0, 0], b: [0, 0] };
  return { wl, wr, overlapMs, gapMs, staggered, samples, fin, both, midL, midR, bothWorkingAt, wa, wb, shot };
}

async function c4Paging() {
  await setPhase('paging');
  const k = checks();
  const big = arg('big') || pickBig();
  if (!big) return { ok: false, reason: 'no big transcript found' };
  const t0 = Date.now();
  const p1 = await A.c.call('external.history', { claudeSessionId: big.id }, 60000);
  const ms = Date.now() - t0;
  k(ms < 3000, `first page took ${ms} ms`);
  k(p1.items.length > 0 && p1.hasMore, `first page ${p1.items.length} items, hasMore ${p1.hasMore}`);
  const ui = await inPage(async (h, id) => {
    const els = await import('/shell/elsewhere.js');
    els.openExternal(id);
    await h.waitFor(() => (h.store.externalItems.value[id] || []).length, 15000);
    await h.sleep(800);
    const out = { first: h.store.externalItems.value[id].length, clicks: [] };
    for (let i = 0; i < 4; i++) {
      const b = [...document.querySelectorAll('main.main button')].find((x) => /^Show earlier/.test(x.textContent.trim()));
      if (!b) { out.clicks.push('no button'); break; }
      const n0 = h.store.externalItems.value[id].length, d0 = document.querySelectorAll('main.main [data-item-id]').length;
      b.click();
      await h.waitFor(() => h.store.externalItems.value[id].length > n0 || document.querySelectorAll('main.main [data-item-id]').length > d0, 8000);
      await h.sleep(300);
      out.clicks.push(`${b.textContent.trim()}: store ${n0}->${h.store.externalItems.value[id].length}, dom ${d0}->${document.querySelectorAll('main.main [data-item-id]').length}`);
    }
    const its = h.store.externalItems.value[id];
    const dom = [...document.querySelectorAll('main.main [data-item-id]')].map((e) => e.dataset.itemId);
    out.dupStore = its.length - new Set(its.map((i) => i.id)).size;
    out.dupDom = dom.length - new Set(dom).size;
    out.banner = h.text(document.querySelector('.ext-banner')).slice(0, 120);
    out.resume = !!h.btn(document, 'Resume in Helm');
    return out;
  }, big.id);
  k(ui.dupStore === 0 && ui.dupDom === 0, `duplicate ids store ${ui.dupStore} dom ${ui.dupDom}`);
  k(ui.clicks.length >= 2 && ui.clicks.every((x) => /store \d+->\d+, dom \d+->\d+/.test(x)), 'show earlier: ' + short(ui.clicks));
  const grew = ui.clicks.filter((x) => { const m = /store (\d+)->(\d+), dom (\d+)->(\d+)/.exec(x); return m && (+m[2] > +m[1] || +m[4] > +m[3]); }).length;
  k(grew >= 2, 'show earlier did not grow the view: ' + short(ui.clicks));
  await capture('c4-paging.png');
  const cons = (await drainConsole()).filter((e) => isBad(e) || /same key|duplicate key/i.test(e.message));
  k(!cons.length, 'console during paging: ' + short(cons.map((e) => e.message), 300));
  k.ev(`${big.id.slice(0, 8)} ${(big.size / 1e6).toFixed(0)} MB: page1 ${p1.items.length} items in ${ms} ms; ${ui.clicks.join(' | ')}`);
  await inPage(async () => { (await import('/shell/elsewhere.js')).closeExternal(); return true; });
  return k.result();
}
function pickBig() {
  const dir = path.join(PROJECTS, os.homedir().replace(/[^A-Za-z0-9]/g, '-')); // Claude Code's project-dir slug for the home folder
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const st = fs.statSync(path.join(dir, f));
      if (Date.now() - st.mtimeMs < 3600e3) continue;      // not a live one
      if (st.size > 20e6 && st.size < 80e6 && (!best || st.size > best.size)) best = { id: f.slice(0, -6), size: st.size };
    }
  } catch {}
  return best;
}

// C5 shows a terminal session that the check writes itself, so it never depends on the session
// that launched the verifier (its transcript goes quiet during a long tool call, so after 90 s
// it reads as idle). The app is started with HELM_TEST_EXTERNAL_DIRS=EXT_DIR (honoured only
// under --test, main/engine/external.js), and C5 appends to EXT_DIR/<slug>/<id>.jsonl
// right before it looks. The cwd is a made-up non-temp path: Elsewhere hides temp-dir sessions.
function writeExtTranscript() {
  const id = require('crypto').randomUUID();
  const cwd = 'C:\\helm-v3-elsewhere-' + process.pid;
  const dir = path.join(EXT_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const ts = (ms) => new Date(Date.now() - ms).toISOString();
  const lines = [
    { type: 'user', isSidechain: false, message: { role: 'user', content: EXT_PROMPT }, uuid: 'v3-u1', timestamp: ts(4000), cwd, sessionId: id },
    { type: 'assistant', message: { id: 'v3-m1', role: 'assistant', content: [{ type: 'text', text: 'Looking at it now.' }] }, uuid: 'v3-a1', parentUuid: 'v3-u1', timestamp: ts(2000), cwd, sessionId: id },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { id, file, cwd };
}

async function c5Elsewhere() {
  await setPhase('elsewhere');
  const k = checks();
  const ext = writeExtTranscript();
  const me = ext.id;
  const list = await A.c.call('external.list', {}, 30000);
  const mine = list.find((x) => x.claudeSessionId === me);
  k(mine && mine.active, `fresh external transcript ${me.slice(0, 8)} ${mine ? 'listed, active=' + mine.active : 'NOT listed (is HELM_TEST_EXTERNAL_DIRS honoured?)'} (${list.length} listed)`);
  const ui = await inPage(async (h, id) => {
    await h.store.refreshExternal();
    await h.sleep(600);
    const rows = [...document.querySelectorAll('.ext-row')];
    const x = h.store.externalSessions.value.find((s) => s.claudeSessionId === id);
    const row = rows.find((r) => x && h.text(r).includes((x.title || '').slice(0, 20)));
    if (!row) return { rows: rows.length, found: false, titles: rows.map((r) => h.text(r).slice(0, 40)) };
    row.click();
    await h.waitFor(() => (h.store.externalItems.value[id] || []).length, 15000);
    await h.sleep(1200);
    const main = document.querySelector('main.main');
    return { rows: rows.length, found: true, view: h.store.externalView.value, items: main.querySelectorAll('[data-item-id]').length, banner: h.text(document.querySelector('.ext-banner')).slice(0, 160), resume: !!h.btn(document, 'Resume in Helm'), composer: !!main.querySelector('textarea') };
  }, me);
  k(ui.found, 'Elsewhere row for the external session not found: ' + short(ui));
  if (ui.found) {
    k(ui.view === me && ui.items > 0, `read-only view: view ${ui.view && ui.view.slice(0, 8)}, ${ui.items} items`);
    k(!ui.resume, 'Resume offered while active');
    k(!ui.composer, 'read-only view shows a composer');
    k.ev(`fresh transcript ${me.slice(0, 8)} active; ${ui.rows} rows; read-only view ${ui.items} items; banner "${ui.banner.slice(0, 70)}"; resume ${ui.resume}`);
  }
  await capture('c5-elsewhere.png');
  await inPage(async () => { (await import('/shell/elsewhere.js')).closeExternal(); return true; });
  return k.result();
}

async function c6Eta() {
  await setPhase('eta');
  const k = checks();
  if (!S.a && !S.b) S.b = (await A.c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' })).id;
  const sid = S.b || S.a;
  // a turn that stays "working" for ~40 s, so the UI's working gate is open
  const before = new Set(A.c.itemsOf(sid).keys());
  await inPage(async (h, id) => { h.split.closePane && h.split.split.value && h.split.closePane(1); h.state.openSession(id); return true; }, sid);
  await A.c.call('sessions.send', { id: sid, text: 'Run this exact command with the Bash tool and nothing else: node -e \"setTimeout(() => {}, 40000)\"   Then reply: done.' });
  await A.c.waitFor(() => (A.c.sessions.get(sid) || {}).status === 'working', 20000, 'working');
  const csid = (await A.c.waitFor(() => A.c.sessions.get(sid)?.claudeSessionId, 20000, 'claudeSessionId').catch(() => null));
  if (!csid) return { ok: false, reason: 'no claudeSessionId for ' + sid };
  S.etaFile = path.join(ETA_DIR, csid + '.json');
  fs.mkdirSync(ETA_DIR, { recursive: true });
  const snap = (state) => ({ v: 1, sessionId: csid, project: 'helm-v3', cwd: repo, label: 'Verifying ETA display', state, summary: 'fixture', etaAt: Date.now() + 10 * 60e3, isOverdue: false, agentsRunning: 0, workStartedAt: Date.now() - 30e3, updatedAt: Date.now() });
  // the mod in that session writes the same file: keep writing ours until the UI shows it
  let seen = null;
  const end = Date.now() + 20000;
  while (Date.now() < end && !seen) {
    fs.writeFileSync(S.etaFile, JSON.stringify(snap('working')));
    await sleep(700);
    const r = await inPage(async (h, id) => ({ header: h.text(document.querySelector('.sh-eta')), chip: h.text(document.querySelector('.srow:not(.ext-row) .srow-eta')), eta: h.store.sessions.value.find((s) => s.id === id)?.eta }), sid);
    if (r.header && r.chip) seen = r;
  }
  k(seen, 'ETA never shown in header + sidebar');
  if (seen) {
    k(/~(9|10) ?m(in)? left/.test(seen.header) && /done/.test(seen.header), 'header ETA text ' + seen.header);
    await capture('c6-eta.png', null, 300);
  }
  let gone = null;
  const end2 = Date.now() + 15000;
  while (Date.now() < end2 && !gone) {
    fs.writeFileSync(S.etaFile, JSON.stringify(snap('ended')));
    await sleep(700);
    const r = await inPage(async (h, id) => ({ header: !!document.querySelector('.sh-eta'), chip: !!document.querySelector('.srow:not(.ext-row) .srow-eta'), ui: (h.store.sessions.value.find((x) => x.id === id) || {}).eta }), sid);
    let disk = null; try { disk = JSON.parse(fs.readFileSync(S.etaFile, 'utf8')); } catch {}
    S.etaTrace = (S.etaTrace || []).concat([{ h: r.header, c: r.chip, ui: r.ui && r.ui.state, uiEta: r.ui && r.ui.etaAt, ws: ((A.c.sessions.get(sid) || {}).eta || {}).state, disk: disk && disk.state, diskEta: disk && disk.etaAt, diskSum: disk && disk.summary }]);
    if (!r.header && !r.chip) gone = r;
  }
  k(gone, 'ETA still shown after state ended: ' + short(S.etaTrace.slice(-3), 600));
  k.ev(`shown "${seen && seen.header.trim()}" / chip "${seen && seen.chip.trim()}", gone after ended`);
  await waitResult(sid, before, 120000).catch((e) => k(false, 'sleep turn: ' + e.message));
  try { fs.rmSync(S.etaFile, { force: true }); } catch {}
  return k.result();
}

async function c1Sweep() {
  await setPhase('sweep');
  const k = checks();
  const sid = S.a;
  const r = await inPage(async (h, id, other) => {
    const out = {};
    h.state.openSession(id); await h.sleep(600);
    h.state.go('history'); out.history = !!(await h.waitFor(() => document.querySelector('main.main') && /history/i.test(h.text(document.querySelector('main.main')).slice(0, 400)), 4000)); await h.sleep(500);
    h.state.go('session'); await h.sleep(300);
    h.state.paletteOpen.value = true; out.palette = !!(await h.waitFor(() => document.querySelector('[role=dialog] input, .palette input'), 3000));
    const pin = document.querySelector('.palette input, [role=dialog] input'); if (pin) { h.setValue(pin, 'set'); await h.sleep(300); }
    h.state.paletteOpen.value = false; await h.sleep(300);
    // message actions: hover row buttons + the phone long-press menu + the inline editor (cancelled)
    const u = document.querySelector('main.main .msg-user');
    out.actBtns = u ? [...u.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean) : [];
    if (u) {
      h.actions.actsOpen.value = `${id}:${u.dataset.itemId}`; await h.sleep(400);
      out.menu = [...document.querySelectorAll('.msg-acts-menu [role=menuitem]')].map((b) => b.textContent.trim());
      h.actions.actsOpen.value = null;
      h.btn(u, 'Edit & resend')?.click(); await h.sleep(300); out.editor = !!document.querySelector('.msg-edit-ta');
      h.btn(document.querySelector('.msg-edit'), 'Cancel')?.click(); await h.sleep(200);
      const cp = h.btn(u, 'Copy'); out.copy = !!cp;
    }
    // split + find in a pane
    if (other) { h.split.openSplit(other, 1); await h.sleep(800); out.panes = document.querySelectorAll('main.main.pane').length; }
    h.key('f', { ctrlKey: true }, document.body); await h.sleep(400);
    out.find = !!document.querySelector('main.main .find-input');
    h.key('Escape', {}, document.activeElement); await h.sleep(200);
    return out;
  }, sid, S.b || S.fork || null);
  k(r.history, 'history view');
  k(r.palette, 'palette');
  k(['Copy', 'Edit & resend', 'Fork from here', 'Rewind to here'].every((x) => r.actBtns.includes(x)), 'hover actions ' + short(r.actBtns));
  k((r.menu || []).length === 4, 'long-press menu ' + short(r.menu));
  k(r.editor, 'inline editor');
  k(!S.b || r.panes === 2, 'split panes ' + r.panes);
  k(r.find, 'find bar in split');
  await capture('c1-split-find.png');
  // quick window: load it hidden, inspect, capture
  const q = await A.c.call('test.quick', { action: 'warm', waitMs: 2500, eval: `(async () => { await new Promise((r) => setTimeout(r, 1500)); const t = document.querySelector('textarea, input'); const sel = document.querySelector('select, [role=listbox], [role=combobox], button'); return { input: !!t, ctl: !!sel, text: (document.body.innerText || '').slice(0, 200) }; })()`, capture: path.join(SHOTS, 'c1-quick.png') }, 30000);
  k(q.exists && q.eval && q.eval.input, 'quick window ' + short(q));
  note('  quick ' + short(q, 200));
  k.ev(`history/palette/actions(${r.actBtns.length})/menu/editor/split/find/quick ok`);
  await drainConsole();
  return k.result();
}

async function c8Light() {
  await setPhase('light');
  const k = checks();
  await A.c.call('settings.set', { theme: 'light' });
  await sleep(800);
  const t = await inPage(async (h) => ({ theme: document.documentElement.dataset.theme || document.documentElement.className, bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color }));
  k(/light/.test(t.theme || ''), 'theme attr ' + short(t));
  if (S.b) {
    const sp = await inPage(async (h, l, r) => { h.state.go('session'); h.state.openSession(l); await h.sleep(400); const ok = h.split.openSplit(r, 1); const n = await h.waitFor(() => document.querySelectorAll('main.main.pane').length === 2, 4000); return { ok, panes: document.querySelectorAll('main.main.pane').length, n: !!n }; }, S.a, S.b);
    k(sp.panes === 2, 'light split panes ' + short(sp));
    await capture('c8-light-split.png');
  }
  await inPage(async (h) => { if (h.split.split.value) h.split.closePane(1); await h.sleep(300); return true; });
  await capture('c8-light-main.png', S.a);
  // loading=lazy tiles: a never-shown test window may not run lazy loading, so record what loaded on its
  // own, then load them eagerly for the capture
  const lz = await inPage(async (h) => {
    h.state.go('settings');
    await h.waitFor(() => document.querySelector('.gal-opt img'), 5000);
    await h.sleep(2500);
    const imgs = [...document.querySelectorAll('.gal-opt img')].slice(0, 8);
    const own = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
    for (const i of imgs) i.loading = 'eager';
    await h.waitFor(() => imgs.every((i) => i.complete), 5000);
    return { visibility: document.visibilityState, own, after: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, n: imgs.length };
  });
  k(lz.after === lz.n, 'light settings thumbnails ' + short(lz));
  note('  light settings lazy thumbs ' + short(lz));
  await capture('c8-light-settings.png');
  await inPage(async (h) => { h.state.go('session'); return true; });
  await A.c.call('settings.set', { theme: 'dark' });
  k.ev('captured light main/settings/split: ' + short(t));
  return k.result();
}

// Soak finding: interrupting a turn that just started must read as a calm "Interrupted", never as an
// error card with internal diagnostics.
async function c9Interrupt() {
  await setPhase('interrupt');
  const k = checks();
  const sid = S.a || (await A.c.call('sessions.create', { cwd: repo, model: MODEL, permissionMode: 'bypassPermissions' })).id;
  await inPage(async (h, id) => { if (h.split.split.value) h.split.closePane(1); h.state.openSession(id); return true; }, sid);
  const before = new Set(A.c.itemsOf(sid).keys());
  await A.c.call('sessions.send', { id: sid, text: 'Write a 300-word story about a lighthouse.' });
  await A.c.waitFor(() => (A.c.sessions.get(sid) || {}).status === 'working', 20000, 'working');
  await sleep(300);
  await A.c.call('sessions.interrupt', { id: sid });
  const res = await waitResult(sid, before, 60000).catch(() => null);
  await sleep(1500);
  const fresh = itemList(sid).filter((it) => !before.has(it.id));
  const errs = fresh.filter((it) => it.type === 'system' && it.subtype === 'error');
  const leaked = fresh.filter((it) => /\[[a-z]+_[a-z_]+\]/.test(String(it.text || '') + String(it.error || '') + String(it.result || '')));
  k(res, 'no result after interrupt');
  k(res && !res.isError, 'result isError ' + short(res && { isError: res.isError, subtype: res.subtype, interrupted: res.interrupted }));
  k(!errs.length, 'error items: ' + short(errs.map((e) => e.text)));
  k(!leaked.length, 'internal tags leaked: ' + short(leaked.map((e) => e.text || e.error), 200));
  const dom = await inPage(async (h) => { await h.sleep(500); const m = document.querySelector('main.main'); const ends = m.querySelectorAll('.turn-end'); const last = ends[ends.length - 1]; return { sysErr: m.querySelectorAll('.sys-error').length, bad: !!(last && last.classList.contains('bad')), end: h.text(last).trim(), lines: [...m.querySelectorAll('.sys-line')].slice(-2).map((x) => h.text(x).trim()), diag: /ede_diagnostic/.test(h.text(m)) }; });
  k(!dom.sysErr && !dom.bad && !dom.diag, 'UI shows an error: ' + short(dom));
  await capture('c9-interrupt.png', sid);
  k.ev(`result ${short({ isError: res && res.isError, interrupted: res && res.interrupted })}; row "${dom.end}"; lines ${short(dom.lines)}`);
  return k.result();
}

// ======================================================================
async function main() {
  if (!fs.existsSync(EXE)) throw new Error('missing ' + EXE + ' (node tools/make-exe.js)');
  makeRepo();
  note(`exe ${EXE}\n  repo ${repo}\n  profile ${userData}\n  model ${MODEL}`);
  A = await startApp();
  if (A.ready.engine !== 'real') throw new Error('engine is ' + A.ready.engine);
  await A.c.call('settings.set', { defaults: { model: MODEL, permissionMode: 'bypassPermissions', cwd: repo } });
  await sleep(2500);   // UI boot
  await drainConsole();
  // Self-test of the collector AND the CSP: an injected inline script must be refused and the refusal
  // must reach test.console. (Excluded from the verdict below by its phase.)
  phase = 'selftest';
  const blocked = await inPage(async (h) => { const s = document.createElement('script'); s.textContent = 'window.__v3inline = 1'; document.head.appendChild(s); await h.sleep(300); s.remove(); return window.__v3inline !== 1; });
  await sleep(300);
  const st = (await drainConsole()).filter(isCsp);
  record(0, 'CSP is live + console collector works (injected inline script refused and logged)', blocked && st.length > 0, `blocked ${blocked}, logged ${st.length}: ${short(st[0] && st[0].message, 160)}`);
  phase = 'boot';

  await check(7, 'settings + gallery round trip (real server)', c7Settings);
  const needSession = [1, 2, 3, 6, 8].some(want);
  if (needSession) await check(2, 'real session: tools/diff/result, Ctrl+F, fork, edit & resend, rewind (live ids)', c2Session);
  if (want(2) && S.a) await check(2.5, 'checkpoint ids after a reload + rewind dialog', c2Reloaded);
  if (want(3)) await check(3, 'split view, two sessions streaming at once', c3Split);
  await check(4, 'paging a big transcript read-only', c4Paging);
  await check(5, 'Elsewhere: a fresh external session, read-only view, no Resume while active', c5Elsewhere);
  if (want(6)) await check(6, 'ETA fixture shows, then hides on ended', c6Eta);
  if (want(9)) await check(9, 'interrupt right after start reads "Interrupted", no error card / diagnostics', c9Interrupt);
  if (S.a) await check(8, 'light theme captures', c8Light);
  if (S.a || want(1)) await check(1, 'UI sweep: history, palette, actions, split, find, quick window', c1Sweep);

  // C1 verdict: every console entry over the whole run
  await drainConsole();
  const bad = conAll.filter((e) => e.phase !== 'selftest' && isBad(e));
  const csp = bad.filter(isCsp);
  const warn = conAll.filter((e) => e.level === 'warning');
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, 'console.json'), JSON.stringify(conAll, null, 1));
  record(1.5, 'no CSP violations / page errors in any webContents (whole run)', !bad.length,
    bad.length ? `${bad.length} bad (${csp.length} CSP): ` + short(bad.slice(0, 4).map((e) => `[${e.phase}/${e.where.slice(0, 30)}] ${e.message}`), 700)
      : `${conAll.length} console entries, ${warn.length} warnings, 0 CSP, 0 errors (console.json)`);
  if (warn.length) note('  warnings: ' + short([...new Set(warn.map((e) => e.message.slice(0, 120)))].slice(0, 5), 600));
}

(async () => {
  let crashed = null;
  try { await main(); } catch (e) { crashed = e; console.error('verify crashed:', e.stack || e.message); }
  finally {
    if (A) {
      try {
        const txt = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
        const bad = txt.split('\n').filter((l) => /error|threw|failed|unhandled/i.test(l)).slice(-12);
        if (bad.length) { console.log('\n--- main.log error lines (last 12) ---'); for (const l of bad) console.log('  ' + l.slice(0, 260)); }
      } catch {}
      await stopApp();
    }
    if (S.etaFile) try { fs.rmSync(S.etaFile, { force: true }); } catch {}
    // the eta mod inside each scratch session wrote its own snapshot: remove the ones for this run's repo
    try {
      for (const f of fs.readdirSync(ETA_DIR)) {
        if (!f.endsWith('.json')) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(ETA_DIR, f), 'utf8')); if (path.resolve(String(j.cwd || '.')).toLowerCase() === repo.toLowerCase()) fs.rmSync(path.join(ETA_DIR, f), { force: true }); } catch {}
      }
    } catch {}
    if (!KEEP) {
      for (const p of [userData, repo, projectDirFor(repo), EXT_DIR]) try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    } else console.log(`kept: ${repo}  ${userData}  ${projectDirFor(repo)}  ${EXT_DIR}`);
  }
  console.log('\n=== verify-round3 summary ===');
  for (const r of results.sort((a, b) => a.n - b.n)) console.log(`C${String(r.n).padEnd(4)} ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  :: ${short(r.reason, 400)}`);
  const pass = results.filter((r) => r.ok).length;
  console.log(`live spend: $${spend.results.toFixed(4)} (sum of result items)`);
  console.log(`verify-round3: ${pass} passed, ${results.length - pass} failed${crashed ? ', CRASHED' : ''}`);
  process.exitCode = crashed ? 2 : results.length - pass ? 1 : 0;
})();
