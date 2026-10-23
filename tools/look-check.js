require('./lowcpu-optional'); // FIRST: caps CPU + one browser (Electron counts) machine-wide
// Look Sync integration check against the REAL app (lane look-sync, 2026-10-10). Invisible to the user:
// `electron <app> --test --profile=<unique>` (off-screen window, throwaway profile in %TEMP%, port 0) with
// LOOK_SYNC_DIR = a fresh temp folder and HELM_TEST_WALLPAPER = a temp copy of a bundled photo, so the user's real
// %APPDATA%\look-sync and Windows wallpaper are never read or written. The shared file is driven from outside
// with ~/look-sync/fake-writer.js (always --dir). The phone view is opened in headless Chromium (playwright-core).
// Stops the app BY PID only, then deletes every temp folder it made.
//
// Usage: node tools/look-check.js [--app=<helm dir>] [--out=<dir for screenshots>] [--keep]
// Prints `  ok  name` / `  FAIL name :: detail`, then `look-check: N passed, M failed`; exit 1 on any failure.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const APP = path.resolve(arg('app', path.join(__dirname, '..')));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'claude', 'looksync-helm', 'look-check')));
const KEEP = process.argv.includes('--keep');
const WS = require(path.join(APP, 'node_modules', 'ws'));
const electronExe = require(path.join(APP, 'node_modules', 'electron'));
const FAKE_WRITER = path.join(process.env.LOOK_SYNC_DIR || path.join(os.homedir(), 'look-sync'), 'fake-writer.js'); // the look-sync project's test writer
const BG_DIR = path.join(APP, 'ui', 'assets', 'backgrounds');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const note = (s) => console.log('    ' + s);
const J = (v) => JSON.stringify(v);
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function rpcClient(port, token) {
  const ws = new WS(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error('ws ' + r.statusCode))); });
  let id = 1; const pending = new Map(); const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); p && p(m); }
    else events.push({ ...m, t: Date.now() });
  });
  return {
    ws, events,
    call(method, params = {}, ms = 20000) {
      return new Promise((resolve, reject) => {
        const i = id++; const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, ms);
        pending.set(i, (m) => { clearTimeout(t); resolve(m); });
        ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      });
    },
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = 'lookchk' + process.pid + '-' + Date.now().toString(36);
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  const lookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-looksync-check-'));
  const wallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-test-wallpaper-'));
  const stills = path.join(lookDir, 'stills');
  const wall1 = path.join(stills, 'wall-1.jpg'), wall2 = path.join(stills, 'wall-2.jpg');
  const lookFile = path.join(lookDir, 'look.json');
  const testWallpaper = path.join(wallDir, 'TranscodedWallpaper');
  fs.copyFileSync(path.join(BG_DIR, 'misty-lake.jpg'), testWallpaper);

  // an OLD settings.json (blur/dim, no glass, no mode, no lookSync) -> the migration runs in the real app
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), J({ background: { kind: 'image', file: 'snow-peak.jpg', blur: 5, dim: 0.5 }, theme: 'dark' }));

  // the fake writer (another app) on the temp look folder; returns how long the process took
  const writer = (args, app = 'quartz') => {
    const t0 = Date.now();
    try {
      const out = execFileSync(process.execPath, [FAKE_WRITER, '--dir', lookDir, '--app', app, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, out: out.trim(), ms: Date.now() - t0 };
    } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message), ms: Date.now() - t0 }; }
  };
  const readLook = () => { try { return JSON.parse(fs.readFileSync(lookFile, 'utf8')); } catch { return null; } };

  // seed Mantle's desktop record BEFORE launch: the still is a copy of snow-peak.jpg
  fs.mkdirSync(stills, { recursive: true });
  fs.copyFileSync(path.join(BG_DIR, 'snow-peak.jpg'), wall1);
  const seed = writer(['desktop', 'builtin:snow-peak', path.join(BG_DIR, 'snow-peak.jpg'), wall1], 'mantle');
  if (!seed.ok) throw new Error('fake writer could not seed the desktop record: ' + seed.out);

  const env = { ...process.env, LOOK_SYNC_DIR: lookDir, HELM_TEST_WALLPAPER: testWallpaper };
  const child = spawn(electronExe, [APP, '--test', '--profile=' + profile], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  console.log(`started electron pid ${child.pid} (profile ${userData}, LOOK_SYNC_DIR ${lookDir})`);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  let c = null, browser = null;
  try {
    let ready = null; const deadline = Date.now() + 45000;
    while (!ready && Date.now() < deadline) {
      const m = /HELM_READY (\{.*\})/.exec(log);
      if (m) ready = JSON.parse(m[1]);
      else if (child.exitCode !== null) throw new Error('electron exited early:\n' + log.slice(-1500));
      else await sleep(250);
    }
    if (!ready) throw new Error('no HELM_READY within 45 s:\n' + log.slice(-1500));
    const { port, token } = ready;
    const cookie = `helm_key=${token}`;
    c = await rpcClient(port, token);
    const ev = async (js) => { const r = await c.call('test.eval', { js }); if (r.error) throw new Error('test.eval: ' + J(r.error)); return r.result; };
    // poll a page expression until pred(value) or the time runs out; ms counts from the call
    const pollPage = async (js, pred, ms = 1000, every = 50) => {
      const t0 = Date.now(); let v;
      for (;;) {
        v = await ev(js);
        if (pred(v)) return { ok: true, ms: Date.now() - t0, v };
        if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0, v };
        await sleep(every);
      }
    };
    const waitEvent = async (from, pred, ms = 1500, since = Date.now()) => {
      const t0 = since;
      for (;;) {
        const e = c.events.slice(from).find(pred);
        if (e) return { ok: true, e, ms: e.t - t0 };
        if (Date.now() - t0 > ms) return { ok: false, e: null, ms: Date.now() - t0 };
        await sleep(20);
      }
    };
    const lookEvent = (st) => (e) => e.event === 'look.updated' && e.data && e.data.sync && st(e.data);
    const settingsNow = async () => (await c.call('settings.get')).result || {};
    const VAR = (k) => `getComputedStyle(document.documentElement).getPropertyValue(${J(k)}).trim()`;
    const BGURL = `import('/shell/state.js').then((m) => m.background.value.url)`;
    const BG = `(() => { const b = document.querySelector('.bg'); return b ? { lined: b.dataset.lined, tx: b.dataset.tx, ty: b.dataset.ty, blurs: b.dataset.blurs, canvas: !!b.querySelector('canvas'), linedEl: !!b.querySelector('.bg-lined') } : null; })()`;

    // wait for the shell
    const up = await pollPage(`!!document.querySelector('.app .strip, .app.phone')`, (v) => v === true, 20000, 200);
    if (!up.ok) throw new Error('the shell never rendered');
    await pollPage(`import('/lib/store.js').then((m) => !!(m.ready.value && m.look.value))`, (v) => v === true, 10000, 100);

    // ---------- 1. migration in the real app ----------
    const hello = (await c.call('app.hello')).result || {};
    const s0 = hello.settings || {};
    const g0 = (s0.glass || {}).dark || {};
    check('1 migration: background.mode desktop, file kept, glass.dark = old blur/dim',
      s0.background && s0.background.mode === 'desktop' && s0.background.file === 'snow-peak.jpg' && g0.blurPx === 5 && g0.dim === 0.5 && g0.panel === 0,
      J({ background: s0.background, glassDark: g0, lookSync: s0.lookSync }));

    // ---------- 2. desktop follow ----------
    const d0 = (hello.look || {}).desktop || {};
    const lf0 = readLook();
    const rev0 = lf0 && lf0.desktop ? lf0.desktop.rev : null;
    check('2 desktop: app.hello look.desktop source mantle, url /bg/desktop?v=m<rev>',
      d0.source === 'mantle' && d0.url === `/bg/desktop?v=m${d0.rev}` && d0.rev === rev0, J({ source: d0.source, url: d0.url, rev: d0.rev, fileRev: rev0, reason: d0.reason }));
    if (d0.url) {
      const r = await get(port, d0.url, { cookie });
      const same = r.body.equals(fs.readFileSync(wall1));
      check('2 desktop: GET the url -> 200 image/jpeg, bytes equal the still', r.status === 200 && /^image\/jpeg/.test(r.headers['content-type'] || '') && same,
        J({ status: r.status, type: r.headers['content-type'], bytes: r.body.length, same }));
    } else check('2 desktop: GET the url -> 200 image/jpeg, bytes equal the still', false, 'no url');
    const noAuth = await get(port, '/bg/desktop?v=x');
    check('2 desktop: /bg/desktop without the key -> 401', noAuth.status === 401, 'status ' + noAuth.status);
    const pageUrl0 = await ev(BGURL);
    check('2 desktop: the page paints the desktop url', pageUrl0 === d0.url, J(pageUrl0));
    fs.copyFileSync(path.join(BG_DIR, 'forest.jpg'), wall2);
    let n = c.events.length;
    const w2 = writer(['desktop', 'builtin:forest', path.join(BG_DIR, 'forest.jpg'), wall2], 'mantle');
    const evD = await waitEvent(n, (e) => e.event === 'look.updated' && e.data && e.data.desktop && e.data.desktop.url && e.data.desktop.url !== d0.url, 1500);
    const pgD = await pollPage(BGURL, (v) => !!v && v !== pageUrl0, 1000);
    const d1 = evD.e ? evD.e.data.desktop : {};
    check('2 desktop: a new Mantle record -> look.updated with the new url', w2.ok && evD.ok && d1.source === 'mantle' && /^\/bg\/desktop\?v=m\d+$/.test(d1.url || ''),
      J({ writer: w2.ok ? 'ok' : w2.out, url: d1.url, ms: evD.ms }));
    check('2 desktop: the page background url changes within 1 s', pgD.ok && pgD.v === d1.url, `${pgD.ms} ms after the writer exited (writer took ${w2.ms} ms); url ${pgD.v}`);
    if (d1.url) {
      const r = await get(port, d1.url, { cookie });
      check('2 desktop: the new url serves the new still', r.status === 200 && r.body.equals(fs.readFileSync(wall2)), J({ status: r.status, bytes: r.body.length }));
    }

    // ---------- 3. synced values applied in the PAGE within 1 s ----------
    let w = writer(['set', 'glass.dark.dim', '0.62']);
    let p = await pollPage(VAR('--bg-dim'), (v) => v === '0.62', 1000);
    check('3 synced: glass.dark.dim 0.62 -> --bg-dim 0.62 in the page within 1 s', w.ok && p.ok, `${p.ms} ms after the writer exited (writer ${w.ms} ms); --bg-dim ${J(p.v)}${w.ok ? '' : '; writer: ' + w.out}`);
    w = writer(['set', 'theme', 'light']);
    p = await pollPage(`document.documentElement.dataset.theme || null`, (v) => v === 'light', 1000);
    check('3 synced: theme light -> html[data-theme=light] within 1 s', w.ok && p.ok, `${p.ms} ms; data-theme ${J(p.v)}`);
    // Light look un-held (CONTRACT "Light look", decided 2026-10-14): the light theme paints the shared glass.light
    // (the seed's {12, .45, 0}) under a WHITE wash; no guard.light here, so the wash is glass.light.dim.
    {
      const lv = await ev(`(async () => { const st = (await import('/lib/store.js')).settings.value; const cs = getComputedStyle(document.documentElement);
        return { blur: cs.getPropertyValue('--bg-blur').trim(), dim: cs.getPropertyValue('--bg-dim').trim(), panel: cs.getPropertyValue('--glass-panel').trim(), wash: getComputedStyle(document.querySelector('.bg-wash')).backgroundColor, dark: st.glass.dark, light: st.glass.light }; })()`);
      check('3 light theme paints glass.light (blur, dim, panel) under a white wash', lv.blur === `${lv.light.blurPx}px` && Number(lv.dim) === lv.light.dim
        && Number(lv.panel) === lv.light.panel && /^rgba\(255, 255, 255, /.test(lv.wash || ''), J(lv));
    }
    w = writer(['set', 'accent', '30']);
    p = await pollPage(`import('/lib/store.js').then((m) => ({ acc: ${VAR('--accent')}, want: m.settings.value?.accentTokens?.light?.acc || null, hue: m.settings.value?.accentHue }))`,
      (v) => v && v.hue === 30 && !!v.want && v.acc === v.want, 1000);
    check('3 synced: accent 30 -> --accent = accentTokens.light.acc within 1 s', w.ok && p.ok, `${p.ms} ms; ${J(p.v)}`);
    w = writer(['set', 'theme', 'dark']);
    p = await pollPage(`document.documentElement.dataset.theme || null`, (v) => v === 'dark', 1000);
    check('3 synced: theme dark again -> html[data-theme=dark] within 1 s', w.ok && p.ok, `${p.ms} ms; data-theme ${J(p.v)}`);
    const dimBack = await ev(VAR('--bg-dim'));
    check('3 synced: back on dark the dark glass dim (0.62) shows again', dimBack === '0.62', '--bg-dim ' + J(dimBack));

    // ---------- 4. publishing ----------
    let t0 = Date.now();
    const set4 = await c.call('settings.set', { glass: { dark: { blurPx: 9 } } });
    let lf = null;
    while (Date.now() - t0 <= 1000) {
      lf = readLook();
      if (lf && lf.look && lf.look.glass && lf.look.glass.v && lf.look.glass.v.dark.blurPx === 9 && lf.writer && lf.writer.app === 'helm') break;
      await sleep(25);
    }
    const pubOk = !!(lf && lf.look && lf.look.glass && lf.look.glass.v.dark.blurPx === 9 && lf.writer && lf.writer.app === 'helm');
    check('4 publish: settings.set glass.dark.blurPx 9 -> look.json glass.v.dark.blurPx 9, writer helm, within 1 s', !set4.error && pubOk,
      `${Date.now() - t0} ms; ${J({ error: set4.error, blurPx: lf && lf.look && lf.look.glass && lf.look.glass.v.dark.blurPx, writer: lf && lf.writer && lf.writer.app, rev: lf && lf.rev })}`);
    const blur9 = await pollPage(VAR('--bg-blur'), (v) => v === '9px', 1000);
    check('4 publish: the page shows --bg-blur 9px', blur9.ok, J(blur9.v));

    // ---------- 5. the switch ----------
    n = c.events.length;
    t0 = Date.now();
    await c.call('settings.set', { lookSync: { enabled: false } });
    const off = await waitEvent(n, lookEvent((d) => d.sync.state === 'off'), 1500, t0);
    check('5 switch: off -> look.updated sync.state off', off.ok, off.ok ? `${off.ms} ms` : J(c.events.slice(n).filter((e) => e.event === 'look.updated').map((e) => e.data.sync)));
    w = writer(['set', 'glass.dark.dim', '0.7']);
    await sleep(600);
    const sOff = await settingsNow();
    const dimOff = await ev(VAR('--bg-dim'));
    check('5 switch: while off a shared change is NOT applied (600 ms)', w.ok && sOff.glass.dark.dim === 0.62 && dimOff === '0.62', J({ writer: w.ok, settingsDim: sOff.glass.dark.dim, page: dimOff }));
    n = c.events.length;
    t0 = Date.now();
    await c.call('settings.set', { lookSync: { enabled: true } });
    const on = await waitEvent(n, lookEvent((d) => d.sync.state === 'ok' && /Now matching the others/.test(d.sync.reason || '')), 1500);
    const dimOn = await pollPage(VAR('--bg-dim'), (v) => v === '0.7', 1000);
    const sOn = await settingsNow();
    check('5 switch: on again -> the shared value is adopted (dim 0.7 in settings + page)', sOn.glass.dark.dim === 0.7 && dimOn.ok, `${Date.now() - t0} ms; ${J({ settingsDim: sOn.glass.dark.dim, page: dimOn.v })}`);
    check('5 switch: on again -> status reason "Now matching the others"', on.ok, on.ok ? J(on.e.data.sync.reason) : J(c.events.slice(n).filter((e) => e.event === 'look.updated').map((e) => e.data.sync)));
    const lineOn = await ev(`import('/shell/state.js').then(async (m) => { m.go('settings'); for (let i = 0; i < 40 && !document.querySelector('#set-appearance .look-status'); i++) await new Promise((r) => setTimeout(r, 50)); const el = document.querySelector('#set-appearance .look-status'); return el ? el.textContent : null; })`);
    note('Appearance status line after switching on: ' + J(lineOn));
    await ev(`import('/shell/state.js').then((m) => { m.go('home'); return true; })`);

    // ---------- 7. lining up after a move (desktop window) ----------
    const win = await ev(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
    const expect = (cx, cy, monW, monH) => ({ tx: Math.min(0, Math.max(Math.ceil(win.w - monW), Math.round(0 - cx))), ty: Math.min(0, Math.max(Math.ceil(win.h - monH), Math.round(0 - cy))) });
    const place = (cx, cy, monW, monH) => ({ content: { x: cx, y: cy, width: win.w, height: win.h }, display: { x: 0, y: 0, width: monW, height: monH, scaleFactor: win.dpr } });
    // In the page: ask for the placement over the page's own WS (test plumbing: WS -> main -> IPC), timestamp when
    // the placement IPC arrives (a second helmNative.onPlacement listener) and when .bg shows the expected offsets
    // (MutationObserver), and count the frames (rAF timestamps) between the two: that is Helm's own response.
    // A clamped move whose offsets do not change lands when it arrives (no mutation): checked 2 frames later.
    const MOVE = (pl, e, limitMs) => `(async () => {
      const t = await import('/lib/transport.js');
      const want = () => { const b = document.querySelector('.bg'); return !!b && b.dataset.lined === '1' && b.dataset.tx === '${e.tx}' && b.dataset.ty === '${e.ty}'; };
      const already = want();
      let tArrive = null, tLand = null, unchanged = false; const frames = [];
      const off = window.helmNative.onPlacement(() => { if (tArrive === null) tArrive = performance.now(); });
      const mo = new MutationObserver(() => { if (tLand === null && tArrive !== null && want()) tLand = performance.now(); });
      mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-tx', 'data-ty', 'data-lined'] });
      let running = true; const tick = (ts) => { frames.push(ts); if (running) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const t0 = performance.now();
      const call = t.rpc('test.placement', ${J(pl)});
      while (tLand === null && performance.now() - t0 < ${limitMs}) {
        await new Promise((r) => setTimeout(r, 8));
        if (already && tArrive !== null && frames.filter((f) => f > tArrive).length >= 2) { unchanged = want(); if (unchanged) tLand = tArrive; break; }
      }
      running = false; mo.disconnect(); try { off && off(); } catch {}
      await call.catch(() => {});
      const b = document.querySelector('.bg');
      return { hit: tLand !== null, unchanged, framesAfterIpc: tArrive !== null && tLand !== null ? frames.filter((f) => f > tArrive && f <= tLand).length : null,
        ipcMs: tArrive === null ? null : Math.round(tArrive - t0), landMs: tArrive !== null && tLand !== null ? +(tLand - tArrive).toFixed(1) : null,
        totalMs: tLand === null ? null : Math.round(tLand - t0), lined: b && b.dataset.lined, tx: b && b.dataset.tx, ty: b && b.dataset.ty,
        blurs: b && +b.dataset.blurs, canvas: !!(b && b.querySelector('.bg-photo.bg-lined canvas')) };
    })()`;
    const b7 = await ev(BG);
    note(`window ${win.w}x${win.h} @${win.dpr}; .bg before: ${J(b7)}`);
    let e7 = expect(200, 100, 1920, 1080);
    const first = await ev(MOVE(place(200, 100, 1920, 1080), e7, 4000));
    check('7 lined: placement (200,100) on 1920x1080 -> data-lined 1, tx -200, ty -100, canvas in the layer', first.hit && first.canvas && e7.tx === -200 && e7.ty === -100,
      `${first.framesAfterIpc} frames / ${first.landMs} ms after the placement arrived (includes the one blur render); ${J(first)}`);
    const blursA = first.blurs;
    const moves = []; let x = 200;
    for (let i = 0; i < 10; i++) {
      x += 37;
      const e = expect(x, 100, 1920, 1080);
      const r = await ev(MOVE(place(x, 100, 1920, 1080), e, 1500));
      moves.push({ x, want: e.tx, ...r });
    }
    const maxFrames = Math.max(...moves.map((m) => (m.framesAfterIpc == null ? 99 : m.framesAfterIpc)));
    const allHit = moves.every((m) => m.hit);
    check('7 lined: 10 moves (x += 37) each land on the expected offset', allHit,
      moves.map((m) => `x${m.x}->${m.tx}${m.unchanged ? '(clamped)' : ''}${m.hit ? '' : '(want ' + m.want + ')'}`).join(' '));
    check('7 lined: each move lands within ~2 frames of the placement arriving', allHit && maxFrames <= 2,
      `frames after the IPC per move ${J(moves.map((m) => m.framesAfterIpc))}, ms after the IPC ${J(moves.map((m) => m.landMs))}, test plumbing (page WS -> main -> IPC) ms ${J(moves.map((m) => m.ipcMs))}`);
    const blursB = (await ev(BG)).blurs;
    check('7 lined: data-blurs does not grow while moving', +blursB === blursA, `before ${blursA}, after ${blursB}`);
    const e8 = expect(x, 100, 2560, 1440);
    const big = await ev(MOVE(place(x, 100, 2560, 1440), e8, 4000));
    await sleep(600);
    const blursC = +(await ev(BG)).blurs;
    check('7 lined: a new monitor size (2560x1440) -> exactly one new blur', big.hit && blursC === +blursB + 1, `blurs ${blursB} -> ${blursC}; ${big.framesAfterIpc} frames / ${big.landMs} ms after the placement arrived; tx ${big.tx} ty ${big.ty}`);
    await c.call('test.placement', {});
    await sleep(300);
    note('.bg after test.placement {}: ' + J(await ev(BG)));
    // NOT probed here: a real move (window.moveTo) of the off-screen --test window gets clamped ONTO the screen
    // (seen 2026-10-10: x -20007 -> -7), which the user would see. Real moves are wired in main.js (win.on('move', sendPlacement)).

    // ---------- 10. shared top-band darkening (look-sync CONTRACT "desktop.guard") ----------
    // Mantle publishes one dark alpha; in the dark theme, following the desktop, Helm's wash (--bg-dim) is that alpha.
    // The fake writer cannot publish a guard, so Mantle is played in-process with Helm's vendored module (same dir).
    const GD = `import('/lib/store.js').then((m) => m.settings.value.glass.dark)`;
    let gd = await ev(GD);
    const mantleLS = require(path.join(APP, 'main', 'look-sync.js')).create({ app: 'mantle', dir: lookDir, enabled: true });
    const publishGuard = (dark, extra = {}) => mantleLS.publishDesktop({ ok: true, reason: null, id: 'builtin:forest', type: 'builtin', title: 'builtin:forest',
      file: path.join(BG_DIR, 'forest.jpg'), still: wall2, stillSize: null, ...(dark ? { guard: { dark } } : {}), ...extra });
    const g10 = await publishGuard({ alpha: 0.8, contrast: 4.3, dim: gd.dim, blurPx: gd.blurPx, region: { topDip: 0, heightDip: 144 }, monitor: [1920, 1080] });
    p = await pollPage(VAR('--bg-dim'), (v) => v === '0.8', 1500);
    check('10 guard: a fresh guard (alpha .80) -> --bg-dim 0.8 in dark + desktop', g10.ok && p.ok, `${p.ms} ms; --bg-dim ${J(p.v)}; glass ${J(gd)}${g10.ok ? '' : '; publish: ' + g10.reason}`);
    w = writer(['set', 'theme', 'light']);
    p = await pollPage(VAR('--bg-dim'), (v) => Number(v) === gd.dim, 1000);
    check('10 guard: light theme ignores it (--bg-dim = the dark dim)', w.ok && p.ok, `--bg-dim ${J(p.v)}, dim ${gd.dim}`);
    writer(['set', 'theme', 'dark']);
    p = await pollPage(VAR('--bg-dim'), (v) => v === '0.8', 1000);
    check('10 guard: dark again -> 0.8', p.ok, `--bg-dim ${J(p.v)}`);
    // stale: Mantle worked it out for another dim -> the dim, with the reason in look state
    const g10s = await publishGuard({ alpha: 0.8, contrast: 4.3, dim: 0.5, blurPx: gd.blurPx });
    p = await pollPage(VAR('--bg-dim'), (v) => Number(v) === gd.dim, 1500);
    const st10 = await ev(`import('/lib/store.js').then((m) => ({ guard: m.look.value.desktop.guard, reason: m.look.value.desktop.guardReason }))`);
    check('10 guard: a stale guard (dim .50 vs the glass) falls back to the dim with a reason', g10s.ok && p.ok && st10.guard === null && /out of date/.test(st10.reason || ''), J({ page: p.v, ...st10 }));
    await publishGuard({ alpha: 0.8, contrast: 4.3, dim: gd.dim, blurPx: gd.blurPx });   // fresh again for the phone (8)
    await pollPage(VAR('--bg-dim'), (v) => v === '0.8', 1500);

    // ---------- 8. the phone view is NOT lined up (headless Chromium) ----------
    try {
      const { chromium } = require(path.join(APP, 'node_modules', 'playwright-core'));
      browser = await chromium.launch();
      const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/?key=${token}`, { waitUntil: 'load' });
      await page.waitForSelector('.app.phone', { timeout: 20000 });
      await page.waitForFunction(() => { const el = document.querySelector('.bg-photo'); return el && /url\(/.test(getComputedStyle(el).backgroundImage); }, null, { timeout: 10000 });
      const ph = await page.evaluate(() => {
        const b = document.querySelector('.bg'), el = document.querySelector('.bg-photo'), cs = getComputedStyle(el);
        return { lined: b.dataset.lined, canvas: !!b.querySelector('canvas'), linedEl: !!b.querySelector('.bg-lined'), filter: cs.filter, size: cs.backgroundSize, pos: cs.backgroundPosition, image: cs.backgroundImage, native: typeof window.helmNative };
      });
      const want = await ev(BGURL);
      check('8 phone: .bg not lined up, no canvas, no lined layer', ph.lined !== '1' && !ph.canvas && !ph.linedEl, J({ lined: ph.lined, canvas: ph.canvas, linedEl: ph.linedEl, helmNative: ph.native }));
      check('8 phone: .bg-photo = CSS blur filter + cover-fit desktop url', /blur\(9px\)/.test(ph.filter) && ph.size === 'cover' && !!want && ph.image.includes(want),
        J({ filter: ph.filter, size: ph.size, pos: ph.pos, image: ph.image.slice(0, 120), want }));
      const phDim = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-dim').trim());
      check('8 phone: the wash follows the shared darkening (--bg-dim 0.8)', phDim === '0.8', '--bg-dim ' + J(phDim));
      // Settings > Appearance at 393 and 320
      await page.evaluate(() => import('/shell/state.js').then((m) => { m.go('settings'); }));
      await page.waitForSelector('#set-appearance .look-status', { timeout: 10000 });
      const shot = async (wpx) => {
        await page.setViewportSize({ width: wpx, height: wpx === 320 ? 700 : 852 });
        await sleep(400);
        await page.evaluate(() => document.querySelector('#set-appearance').scrollIntoView({ block: 'start' }));
        await sleep(300);
        const ov = await page.evaluate(() => {
          const els = [document.documentElement, document.querySelector('.view-scroll'), document.querySelector('#set-appearance')].filter(Boolean);
          const over = els.map((e) => ({ el: e.id || e.className || e.tagName, sw: e.scrollWidth, cw: e.clientWidth }));
          const wide = [...document.querySelectorAll('#set-appearance *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).slice(0, 4).map((e) => (e.className || e.tagName) + ' right ' + Math.round(e.getBoundingClientRect().right));
          return { over, wide, line: document.querySelector('#set-appearance .look-status')?.textContent || null };
        });
        const file = path.join(OUT, `appearance-${wpx}.png`);
        await page.screenshot({ path: file });
        // the section is taller than a phone screen: a second shot with the sync row + status line in view
        await page.evaluate(() => document.querySelector('#set-appearance .look-status').scrollIntoView({ block: 'center' }));
        await sleep(300);
        const file2 = path.join(OUT, `appearance-${wpx}-sync.png`);
        await page.screenshot({ path: file2 });
        return { ...ov, file: file + ' + ' + path.basename(file2) };
      };
      const s393 = await shot(393);
      const s320 = await shot(320);
      const lay320 = await page.evaluate(() => {
        const r = (s) => { const e = document.querySelector('#set-appearance ' + s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
        return { info: r('.look-desk-info'), open: r('.look-desk-open') };
      });
      const over320 = !!lay320.info && !!lay320.open && lay320.info.l < lay320.open.r && lay320.open.l < lay320.info.r && lay320.info.t < lay320.open.b && lay320.open.t < lay320.info.b;
      check('8 phone: at 320 the wallpaper status lines and the Mantle button do not overlap', !!lay320.info && !over320, J(lay320));
      const fits = (s) => s.over.every((o) => o.sw <= o.cw) && !s.wide.length;
      check('8 phone: Settings > Appearance has no horizontal overflow at 393', fits(s393), J({ over: s393.over, wide: s393.wide }));
      check('8 phone: Settings > Appearance has no horizontal overflow at 320', fits(s320), J({ over: s320.over, wide: s320.wide }));
      note(`screenshots: ${s393.file} | ${s320.file}`);
      note('phone status line: ' + J(s320.line));
      check('8 phone: no page errors', !errors.length, errors.slice(0, 3).join(' | '));
    } catch (e) {
      check('8 phone: headless Chromium run', false, String(e && e.message || e).split('\n')[0]);
    } finally {
      if (browser) { try { await browser.close(); } catch {} browser = null; }
    }

    // ---------- 6. status states visible in the UI ----------
    await ev(`import('/shell/state.js').then((m) => { m.go('settings'); return true; })`);
    const LINE = `(() => { const el = document.querySelector('#set-appearance .look-status'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`;
    n = c.events.length;
    w = writer(['corrupt']);
    const cor = await waitEvent(n, lookEvent((d) => d.sync.state === 'corrupt'), 2000);
    const corReason = cor.ok ? cor.e.data.sync.reason : null;
    check('6 status: corrupt file -> look.updated sync.state corrupt with a reason', cor.ok && !!corReason, cor.ok ? `${cor.ms} ms; ${J(corReason)}` : 'no corrupt event');
    p = await pollPage(LINE, (v) => !!v && !!corReason && v.includes(corReason), 1000);
    check('6 status: the Appearance status line shows the corrupt reason', p.ok, J(p.v));
    await c.call('test.capture', { file: path.join(OUT, 'settings-corrupt.png'), waitMs: 300 }).catch(() => {});
    n = c.events.length;
    w = writer(['newer']);
    const nw = await waitEvent(n, lookEvent((d) => d.sync.state === 'newer'), 2000);
    const nwReason = nw.ok ? nw.e.data.sync.reason : null;
    check('6 status: newer schema -> look.updated sync.state newer', nw.ok, nw.ok ? `${nw.ms} ms; ${J(nwReason)}` : 'no newer event');
    p = await pollPage(LINE, (v) => !!v && /newer version/i.test(v) && (!nwReason || v.includes(nwReason)), 1000);
    check('6 status: the Appearance status line shows the newer state', p.ok, J(p.v));
    await c.call('test.capture', { file: path.join(OUT, 'settings-newer.png'), waitMs: 300 }).catch(() => {});
    // put a good file back: remove the bad one, Mantle publishes its desktop again
    n = c.events.length;
    try { fs.rmSync(lookFile, { force: true }); } catch {}
    await sleep(400);
    w = writer(['desktop', 'builtin:forest', path.join(BG_DIR, 'forest.jpg'), wall2], 'mantle');
    const rec = await waitEvent(n, lookEvent((d) => d.sync.state === 'ok' && d.desktop && d.desktop.source === 'mantle'), 3000);
    check('6 status: a good file again -> state ok, desktop from mantle', w.ok && rec.ok,
      rec.ok ? `${rec.ms} ms` : J({ writer: w.out, last: c.events.slice(n).filter((e) => e.event === 'look.updated').map((e) => ({ state: e.data.sync.state, reason: e.data.sync.reason, desktop: e.data.desktop && e.data.desktop.source })).slice(-2) }));
    // the fake writer's record has no guard: the dim, and the Appearance status says why
    gd = await ev(GD);   // the file was rebuilt above: the glass may be back on the seed
    const GLINE = `(() => { const el = document.querySelector('#set-appearance .look-guard'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`;
    p = await pollPage(GLINE, (v) => !!v && /your dim/.test(v) && /hasn't shared a darkening/.test(v), 1500);
    const dim6 = await ev(VAR('--bg-dim'));
    check('10 guard: no guard -> the dim, and Settings > Appearance says why', p.ok && Number(dim6) === gd.dim, J({ line: p.v, dim: dim6 }));
    await publishGuard({ alpha: 0.8, contrast: 4.3, dim: gd.dim, blurPx: gd.blurPx });
    p = await pollPage(GLINE, (v) => !!v && /Darkening 0\.80, shared with Mantle/.test(v), 1500);
    check('10 guard: a fresh guard -> the status line says it is shared', p.ok, J(p.v));
    const lay10 = await ev(`(() => { const d = document.querySelector('#set-appearance .look-desk'); d.scrollIntoView({ block: 'center' });
      const r = (s) => { const e = d.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      const rb = d.getBoundingClientRect(); return { info: r('.look-desk-info'), open: r('.look-desk-open'), row: { l: rb.left, r: rb.right, t: rb.top, b: rb.bottom } }; })()`);
    const hit = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
    check('10 guard: desktop: the status lines and the Mantle button do not overlap', !!lay10.info && !hit(lay10.info, lay10.open) && (!lay10.open || lay10.open.r <= lay10.row.r + 0.5), J(lay10));
    await c.call('test.capture', { file: path.join(OUT, 'settings-guard.png'), waitMs: 300 }).catch(() => {});
    await ev(`import('/shell/state.js').then((m) => { m.go('home'); return true; })`);

    // ---------- 9. own mode still works ----------
    await c.call('test.placement', place(200, 100, 1920, 1080));   // a valid placement: own mode must still not line up
    const set9 = await c.call('settings.set', { background: { mode: 'own' } });
    const own = await pollPage(`import('/shell/state.js').then((m) => ({ url: m.background.value.url, lined: document.querySelector('.bg')?.dataset.lined, image: getComputedStyle(document.querySelector('.bg-photo')).backgroundImage.slice(0, 120), filter: getComputedStyle(document.querySelector('.bg-photo')).filter }))`,
      (v) => v && v.url === '/bg/snow-peak.jpg' && v.lined !== '1', 1500);
    await sleep(300);
    const own2 = await ev(BG);
    check('9 own: mode own -> url /bg/snow-peak.jpg, not lined up (even with a placement)', !set9.error && own.ok && own2.lined !== '1' && !own2.canvas, J({ error: set9.error, ...own.v, after300ms: own2 }));
    const dim9 = await pollPage(VAR('--bg-dim'), (v) => Number(v) === gd.dim, 1000);
    check('10 guard: own picture ignores the (fresh) shared darkening: --bg-dim = the dim', dim9.ok, `--bg-dim ${J(dim9.v)}, dim ${gd.dim}`);
    await c.call('test.placement', {});

    // ---------- the log ----------
    const logTxt = (() => { try { return fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8'); } catch { return ''; } })();
    check('log: no renderer crash', !/renderer gone/.test(logTxt));
    // scoped to what this check drives (settings / look / app / test); others (e.g. the engine's sessions.models
    // starting a real Claude Code in a throwaway profile) are listed, not counted
    const rpcErr = logTxt.match(/rpc \S+ (failed|threw).*/g) || [];
    const mine = rpcErr.filter((l) => /^rpc (settings|look|app|test)\./.test(l));
    check('log: no rpc internal errors from settings / look / app / test calls', !mine.length, mine.slice(0, 3).join(' | '));
    const others = rpcErr.filter((l) => !mine.includes(l));
    if (others.length) note(`other rpc errors in the log (not counted): ${others.length}x, e.g. ${others[0].slice(0, 140)}`);
    const lookLines = (logTxt.match(/\[look\].*/g) || []);
    note(`[look] log lines: ${lookLines.length}; last: ${J(lookLines.slice(-3))}`);
  } catch (e) {
    check('look-check ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    try { c && c.ws.close(); } catch {}
    killTree(child.pid);
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    if (!KEEP) {
      await sleep(500);
      for (const d of [userData, lookDir, wallDir]) for (let i = 0; i < 10; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(300); } }
      const left = [userData, lookDir, wallDir].filter((d) => fs.existsSync(d));
      if (left.length) console.log('    WARNING: could not delete ' + left.join(', '));
    } else console.log(`    kept ${userData} ${lookDir} ${wallDir}`);
  }
  console.log(`\nlook-check: ${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error('look-check crashed:', e && e.stack || e); process.exitCode = 2; });
