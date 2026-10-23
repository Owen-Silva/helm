// Look measurement for Helm's background glass, for honest before/after checks (Look Sync).
// Starts `electron <app> --test --profile=<unique>` (off-screen window, throwaway profile in %TEMP%, port 0,
// LOOK_SYNC_DIR = a fresh temp folder), pre-seeds settings.json with snow-peak.jpg / blur 5 / dim .5 / dark,
// then measures two views: Home (the UNBLURRED copy) and the session view (the blurred layer + wash + panels).
// Per view: computed CSS (blur, dim, wash, panel, surfaces, accent, coverage) and the mean RGB of fixed rects
// in a window capture (PNG decoded here with zlib). Stops the app BY PID only, then deletes its profile.
//
// Usage: node tools/look-measure.js --app=<helm dir> [--mode=own|desktop] [--out=<dir>] [--placement=fit]
//                                   [--rects=<earlier measure.json>]   reuse that run's rects (after-run)
//                                   [--keep]                           keep the test profile + look dir
// Old code ignores background.mode, test.placement and the look file; that is reported, not fatal.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes('--' + k);
const APP = path.resolve(arg('app', path.join(__dirname, '..')));
const MODE = arg('mode', 'own');
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'claude', 'looksync-helm', 'measure-' + Date.now())));
const PLACEMENT = arg('placement');
const RECTS_FROM = arg('rects');
const KEEP = has('keep');
// lane wk-light (light look un-held): --theme=dark|light writes the shared theme first (so the first seed, now Match
// Windows, cannot pick it); --guard-dark=A / --guard-light=A publish desktop.guard.{dark,light} for the seed glass
// (desktop mode). Light runs also report ink-2 (#333A4E) contrast on the empty strip (CONTRACT "Light look").
const THEME = arg('theme', 'dark');
const GUARD_DARK = arg('guard-dark') != null ? Number(arg('guard-dark')) : null;
const GUARD_LIGHT = arg('guard-light') != null ? Number(arg('guard-light')) : null;
if (!['dark', 'light'].includes(THEME)) { console.error('--theme must be dark or light'); process.exit(2); }
if (!['own', 'desktop'].includes(MODE)) { console.error('--mode must be own or desktop'); process.exit(2); }
if (PLACEMENT && PLACEMENT !== 'fit') { console.error('--placement supports only fit'); process.exit(2); }

const WS = require(path.join(APP, 'node_modules', 'ws'));
const electronExe = require(path.join(APP, 'node_modules', 'electron'));
const BG_FILE = 'snow-peak.jpg';
const BG_SRC = path.join(APP, 'ui', 'assets', 'backgrounds', BG_FILE);
const FAKE_WRITER = path.join(process.env.LOOK_SYNC_DIR || path.join(os.homedir(), 'look-sync'), 'fake-writer.js'); // the look-sync project's test writer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

// ---------- minimal PNG decoder (8-bit RGB / RGBA, non-interlaced) ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, ct = 0, bd = 0, il = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6) || il !== 0) throw new Error(`unsupported PNG (bitDepth ${bd}, colorType ${ct}, interlace ${il})`);
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error('bad PNG filter ' + f);
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { const s = x * bpp, d = (y * w + x) * 4; px[d] = cur[s]; px[d + 1] = cur[s + 1]; px[d + 2] = cur[s + 2]; px[d + 3] = bpp === 4 ? cur[s + 3] : 255; }
    [prev, cur] = [cur, prev];
  }
  return { width: w, height: h, px };
}

// mean / median / stddev of RGB inside a device-pixel rect
function relLum(rgb) {
  const c = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (l1, l2) => +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
const INK2_LIGHT = relLum([0x33, 0x3a, 0x4e]);   // #333A4E
function stats(img, r) {
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(img.width, Math.round(r.x + r.width)), y1 = Math.min(img.height, Math.round(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const sum = [0, 0, 0], sq = [0, 0, 0], hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]; let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const d = (y * img.width + x) * 4;
    for (let k = 0; k < 3; k++) { const v = img.px[d + k]; sum[k] += v; sq[k] += v * v; hist[k][v]++; }
    n++;
  }
  const med = hist.map((h) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc * 2 >= n) return v; } return 255; });
  const mean = sum.map((s) => +(s / n).toFixed(1));
  // the 48 darkest pixels (relative luminance), as Mantle's light guard rule judges the band
  const lums = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const d = (y * img.width + x) * 4; lums.push(relLum([img.px[d], img.px[d + 1], img.px[d + 2]])); }
  lums.sort((a, b) => a - b);
  const dk = lums.slice(0, 48), darkest48Lum = dk.reduce((a, b) => a + b, 0) / dk.length;
  return { rectDevice: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, pixels: n, mean, median: med, darkest48Lum: +darkest48Lum.toFixed(4),
    sd: sq.map((s, k) => +Math.sqrt(Math.max(0, s / n - (sum[k] / n) ** 2)).toFixed(1)), css: `rgb(${mean.map(Math.round).join(',')})` };
}

// the size x size window (CSS px) inside `area` with the lowest luminance variance: "mostly empty"
function quietest(img, area, scale, size = 200, step = 10) {
  const W = img.width, H = img.height, S = new Float64Array((W + 1) * (H + 1)), Q = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < W; x++) {
      const d = (y * W + x) * 4, l = 0.2126 * img.px[d] + 0.7152 * img.px[d + 1] + 0.0722 * img.px[d + 2];
      rs += l; rq += l * l;
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + rs; Q[(y + 1) * (W + 1) + x + 1] = Q[y * (W + 1) + x + 1] + rq;
    }
  }
  const box = (T, x0, y0, x1, y1) => T[y1 * (W + 1) + x1] - T[y0 * (W + 1) + x1] - T[y1 * (W + 1) + x0] + T[y0 * (W + 1) + x0];
  let best = null; const sz = Math.min(size, area.width, area.height);
  for (let y = area.y; y + sz <= area.y + area.height; y += step) for (let x = area.x; x + sz <= area.x + area.width; x += step) {
    const x0 = Math.round(x * scale), y0 = Math.round(y * scale), x1 = Math.round((x + sz) * scale), y1 = Math.round((y + sz) * scale);
    if (x1 > W || y1 > H) continue;
    const n = (x1 - x0) * (y1 - y0), m = box(S, x0, y0, x1, y1) / n, v = box(Q, x0, y0, x1, y1) / n - m * m;
    if (!best || v < best.v) best = { v, rect: { x, y, width: sz, height: sz } };
  }
  return best && best.rect;
}

// ---------- page-side probe (runs in the window via test.eval) ----------
const PROBE = `(() => {
  const root = document.documentElement, cs = getComputedStyle(root);
  const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;left:-99px;top:-99px;width:1px;height:1px';
  document.body.appendChild(probe);
  const resolve = (v) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = v; return probe.style.backgroundColor ? getComputedStyle(probe).backgroundColor : null; };
  const vars = {}; for (const k of ['--surface-1', '--surface-2', '--surface-3', '--overlay', '--accent']) vars[k] = { raw: cs.getPropertyValue(k).trim(), resolved: resolve('var(' + k + ')') };
  probe.remove();
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  const vis = (el) => el && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const photo = document.querySelector('.bg-photo'), clear = document.querySelector('.bg-clear'), wash = document.querySelector('.bg-wash');
  const panel = document.querySelector('.main.panel') || document.querySelector('.panel');
  const sidebar = document.querySelector('.sidebar.panel') || document.querySelector('.sidebar');
  const rail = document.querySelector('.rail');
  const railKids = rail ? [...rail.children].map(rect).filter(Boolean).sort((a, b) => a.y - b.y) : [];
  const app = document.querySelector('.app');
  return {
    view: (app && [...app.classList].find((c) => c.startsWith('view-'))) || null,
    appClass: app ? app.className : null,
    theme: root.dataset.theme || null,
    dpr: window.devicePixelRatio, innerWidth, innerHeight,
    bgBlur: cs.getPropertyValue('--bg-blur').trim(), bgDim: cs.getPropertyValue('--bg-dim').trim(),
    photo: photo ? { filter: getComputedStyle(photo).filter, visible: vis(photo), image: getComputedStyle(photo).backgroundImage.slice(0, 160), rect: rect(photo) } : null,
    clear: clear ? { filter: getComputedStyle(clear).filter, visible: vis(clear), opacity: getComputedStyle(clear).opacity } : null,
    canvasLayer: !!document.querySelector('.bg canvas'),
    bgLayers: [...(document.querySelector('.bg')?.children || [])].map((e) => e.tagName.toLowerCase() + '.' + [...e.classList].join('.')),
    wash: wash ? getComputedStyle(wash).backgroundColor : null,
    panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
    panelClass: panel ? panel.className : null,
    vars,
    rects: { strip: rect(document.querySelector('.strip')), stripFill: rect(document.querySelector('.strip-fill')),
      panel: rect(panel), sidebar: rect(sidebar), rail: rect(rail), railKids, home: rect(document.querySelector('.home')) },
  };
})()`;

function parseColor(s) {
  if (!s) return null;
  const srgb = /color\(srgb ([^)]+)\)/.exec(s);   // color-mix() results come back as color(srgb r g b / a), 0..1
  if (srgb) { const p = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

// named rects (CSS px) from the DOM for one view
function rectsFor(c, img, scale) {
  const out = {}, W = c.innerWidth;
  const s = c.rects.strip;
  if (s) {
    const right = Math.min(s.x + s.width, W - 160);
    out.strip = { x: Math.round(s.x), y: Math.round(s.y), width: Math.max(0, Math.round(right - s.x)), height: Math.round(s.height), note: 'whole strip minus the right 160 px (window controls); includes buttons/search' };
    const f = c.rects.stripFill;
    if (f && f.width > 24) out.stripEmpty = { x: Math.round(f.x) + 4, y: Math.round(s.y) + 4, width: Math.round(Math.min(f.x + f.width, W - 160) - f.x) - 8, height: Math.round(s.height) - 8, note: 'the .strip-fill gap: no text, background + wash only' };
  }
  const p = c.rects.panel;
  if (p) {
    // upper third only: the empty state's Recent list loads (async) into the lower half and would move the pick
    const q = quietest(img, { x: Math.round(p.x) + 12, y: Math.round(p.y) + 12, width: Math.round(p.width) - 24, height: Math.min(Math.round(p.height) - 24, Math.max(200, Math.round(p.height * 0.36))) }, scale);
    if (q) out.panel = { ...q, note: 'quietest 200x200 in the upper third of the main panel (min luminance variance)' };
  }
  const sb = c.rects.sidebar;
  if (sb && p && p.x - (sb.x + sb.width) >= 4) {
    const gx = sb.x + sb.width, gw = p.x - gx;
    out.gap = { x: Math.round(gx) + 2, y: Math.round(p.y) + 40, width: Math.max(1, Math.round(gw) - 4), height: Math.round(p.height) - 80, note: 'gap between sidebar and main panel: background only (panel shadows may tint it)' };
  }
  const r = c.rects.rail;
  if (r && c.rects.railKids.length) {
    let best = null, prevBottom = r.y;
    for (const k of [...c.rects.railKids, { y: r.y + r.height, height: 0 }]) { const g = k.y - prevBottom; if (!best || g > best.g) best = { g, y: prevBottom }; prevBottom = Math.max(prevBottom, k.y + k.height); }
    if (best && best.g > 80) out.rail = { x: Math.round(r.x + r.width * 0.2), y: Math.round(best.y + 30), width: Math.round(r.width * 0.6), height: Math.round(best.g - 60), note: 'largest empty run of the rail: background only' };
  }
  if (c.view === 'view-home') {
    const top = s ? Math.round(s.y + s.height) : 40;
    const q = quietest(img, { x: 0, y: top, width: W - 160, height: c.innerHeight - top }, scale, 200, 20);
    if (q) out.homeQuiet = { ...q, note: 'quietest 200x200 of the Home screen (unblurred photo, wash on top)' };
  }
  return out;
}

async function rpcClient(port, token) {
  const ws = new WS(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error('ws ' + r.statusCode))); });
  let id = 1; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); p && p(m); } });
  return {
    ws,
    call(method, params = {}, ms = 20000) {
      return new Promise((resolve, reject) => {
        const i = id++; const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, ms);
        pending.set(i, (m) => { clearTimeout(t); resolve(m); });
        ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      });
    },
  };
}

async function once(attempt, reuse) {
  const profile = 'lookm' + process.pid + '-' + attempt + '-' + Date.now().toString(36);
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  fs.mkdirSync(OUT, { recursive: true });
  const lookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-looksync-measure-'));
  // Windows' wallpaper fallback = a temp copy of a bundled photo: the user's real TranscodedWallpaper is never read
  const wallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-test-wallpaper-'));
  const testWallpaper = path.join(wallDir, 'TranscodedWallpaper');
  fs.copyFileSync(path.join(APP, 'ui', 'assets', 'backgrounds', 'misty-lake.jpg'), testWallpaper);
  const notes = [];
  // 1. settings before launch
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ background: { kind: 'image', file: BG_FILE, blur: 5, dim: 0.5, mode: MODE }, theme: 'dark' }, null, 2));
  // 2. desktop mode: a shared look file whose desktop still is a copy of snow-peak.jpg
  if (MODE === 'desktop') {
    const stills = path.join(lookDir, 'stills'); fs.mkdirSync(stills, { recursive: true });
    const still = path.join(stills, 'wall-1.jpg'); fs.copyFileSync(BG_SRC, still);
    if (GUARD_DARK == null && GUARD_LIGHT == null) {
      const r = execFileSync(process.execPath, [FAKE_WRITER, '--dir', lookDir, '--app', 'mantle', 'desktop', 'builtin:snow-peak', BG_SRC, still], { encoding: 'utf8' });
      notes.push('fake-writer desktop: ' + r.trim());
    } else {
      // Mantle's record with desktop.guard for the seed glass (dark 5 px / .50, light 12 px / .45)
      const guard = {};
      if (GUARD_DARK != null) guard.dark = { alpha: GUARD_DARK, contrast: 4.2, dim: 0.5, blurPx: 5, region: { topDip: 0, heightDip: 100 }, monitor: [1536, 864] };
      if (GUARD_LIGHT != null) guard.light = { alpha: GUARD_LIGHT, contrast: 4.9, dim: 0.45, blurPx: 12, region: { topDip: 0, heightDip: 100 }, monitor: [1536, 864] };
      const js = `const LS = require(${JSON.stringify(path.join(path.dirname(FAKE_WRITER), 'look-sync.js'))});
        const m = LS.create({ app: 'mantle', dir: ${JSON.stringify(lookDir)}, enabled: true });
        m.publishDesktop({ ok: true, reason: null, id: 'builtin:snow-peak', type: 'builtin', title: 'Snow peak', file: ${JSON.stringify(BG_SRC)},
          still: ${JSON.stringify(still)}, stillSize: null, guard: ${JSON.stringify(guard)} }).then((r) => { console.log(JSON.stringify(r)); m.close(); process.exit(r.ok ? 0 : 1); });`;
      notes.push('desktop with guard ' + JSON.stringify(guard) + ': ' + execFileSync(process.execPath, ['-e', js], { encoding: 'utf8' }).trim());
    }
  }
  // the shared theme, written before Helm starts (else the first seed, Match Windows, decides it)
  notes.push(`shared theme ${THEME}: ` + execFileSync(process.execPath, [FAKE_WRITER, '--dir', lookDir, '--app', 'quartz', 'set', 'theme', THEME], { encoding: 'utf8' }).trim());
  const env = { ...process.env, LOOK_SYNC_DIR: lookDir, HELM_TEST_WALLPAPER: testWallpaper };
  const child = spawn(electronExe, [APP, '--test', '--profile=' + profile], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  console.error(`electron pid ${child.pid}, profile ${userData}, LOOK_SYNC_DIR ${lookDir}`);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const result = { tool: 'look-measure', at: new Date().toISOString(), app: APP, mode: MODE, placement: PLACEMENT, settingsSeed: { file: BG_FILE, blur: 5, dim: 0.5, mode: MODE, theme: 'dark' }, sharedTheme: THEME, guardDark: GUARD_DARK, guardLight: GUARD_LIGHT, notes, views: {} };
  let c = null;
  try {
    let ready = null; const deadline = Date.now() + 45000;
    while (!ready && Date.now() < deadline) {
      const m = /HELM_READY (\{.*\})/.exec(log);
      if (m) ready = JSON.parse(m[1]);
      else if (child.exitCode !== null) throw new Error('electron exited early:\n' + log.slice(-1500));
      else await sleep(250);
    }
    if (!ready) throw new Error('no HELM_READY within 45 s:\n' + log.slice(-1500));
    c = await rpcClient(ready.port, ready.token);
    const ev = async (js) => { const r = await c.call('test.eval', { js }); if (r.error) throw new Error('test.eval: ' + JSON.stringify(r.error)); return r.result; };
    // wait for the shell to render and the photo to decode
    for (let i = 0; i < 60 && !(await ev(`!!document.querySelector('.app .strip, .app.phone')`)); i++) await sleep(250);
    const imgOk = await ev(`(async () => { const el = document.querySelector('.bg-photo'); if (!el) return 'no .bg-photo'; const u = /url\\("?([^")]+)"?\\)/.exec(getComputedStyle(el).backgroundImage); if (!u) return 'no url'; const i = new Image(); i.src = u[1]; try { await i.decode(); return 'decoded ' + i.naturalWidth + 'x' + i.naturalHeight + ' ' + u[1].slice(0, 80); } catch (e) { return 'decode failed ' + u[1].slice(0, 80); } })()`);
    notes.push('background image: ' + imgOk);
    const hello = await c.call('app.hello');
    result.settingsSeen = hello.result && hello.result.settings ? { background: hello.result.settings.background, theme: hello.result.settings.theme } : { error: hello.error };
    // 3. placement
    if (PLACEMENT === 'fit') {
      const wh = await ev(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
      const r = await c.call('test.placement', { content: { x: 0, y: 0, width: wh.w, height: wh.h }, display: { x: 0, y: 0, width: wh.w, height: wh.h, scaleFactor: wh.dpr } });
      result.placement = r.error ? { error: r.error } : { result: r.result };
      if (r.error) notes.push('test.placement failed: ' + JSON.stringify(r.error));
    }
    // 4. Home first (it starts there), then the session view
    for (const [name, nav] of [['home', null], ['session', `import('/shell/state.js').then((m) => { m.go('session'); return m.view.value; })`]]) {
      if (nav) notes.push(`navigate to ${name}: ` + await ev(nav));
      await sleep(1500);
      const comp = await ev(PROBE);
      const file = path.join(OUT, `${name}.png`);
      const cap = await c.call('test.capture', { file, waitMs: 500 });
      if (cap.error) throw new Error('test.capture: ' + JSON.stringify(cap.error));
      const img = decodePng(fs.readFileSync(file));
      const scale = img.width / comp.innerWidth;
      const wash = parseColor(comp.wash), s1 = parseColor(comp.vars['--surface-1'].resolved);
      const rects = reuse && reuse.views && reuse.views[name] ? reuse.views[name].rectsCss : rectsFor(comp, img, scale);
      const pixels = {};
      for (const [k, r] of Object.entries(rects)) pixels[k] = stats(img, { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale });
      result.views[name] = {
        computed: { ...comp, washAlpha: wash ? wash.a : null, surface1Alpha: s1 ? s1.a : null,
          panelCoverage: wash && s1 ? +(1 - (1 - wash.a) * (1 - s1.a)).toFixed(4) : null },
        capture: { file, width: img.width, height: img.height, scale },
        rectsCss: rects, rectsReusedFrom: reuse ? RECTS_FROM : null, pixels,
      };
      if (comp.theme === 'light' && pixels.stripEmpty) {
        result.views[name].ink2 = { on: 'stripEmpty', vsDarkest48: contrast(INK2_LIGHT, pixels.stripEmpty.darkest48Lum),
          vsMean: contrast(INK2_LIGHT, relLum(pixels.stripEmpty.mean)) };
      }
    }
  } catch (e) {
    result.error = String(e && e.stack || e);
  } finally {
    try { c && c.ws.close(); } catch {}
    killTree(child.pid);
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    if (!KEEP) {
      await sleep(500);
      for (const d of [userData, lookDir, wallDir]) for (let i = 0; i < 10; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(300); } }
      result.cleanup = { profileRemoved: !fs.existsSync(userData), lookDirRemoved: !fs.existsSync(lookDir), wallpaperDirRemoved: !fs.existsSync(wallDir) };
    } else result.kept = { userData, lookDir, wallDir };
  }
  return result;
}

// The off-screen test window's inner size is not stable run to run (seen 1459x872 and 1459x844 at 125 %: Windows
// clamps the parked 1440x900 window), and the photo is centred, so a different height shifts it. With --rects the
// run relaunches (up to 4 tries) until the inner size matches the reference; a mismatch left over is flagged.
async function main() {
  const reuse = RECTS_FROM ? JSON.parse(fs.readFileSync(RECTS_FROM, 'utf8')) : null;
  const ref = reuse && reuse.views && reuse.views.session && reuse.views.session.computed;
  const sizes = []; let result;
  for (let attempt = 1; attempt <= (ref ? 4 : 1); attempt++) {
    result = await once(attempt, reuse);
    const c = result.views.session && result.views.session.computed;
    if (c) sizes.push(c.innerWidth + 'x' + c.innerHeight);
    if (!ref || result.error || (c && c.innerWidth === ref.innerWidth && c.innerHeight === ref.innerHeight)) break;
  }
  result.windowSizesTried = sizes;
  if (ref) {
    const c = result.views.session && result.views.session.computed;
    result.sizeMatchesReference = !!c && c.innerWidth === ref.innerWidth && c.innerHeight === ref.innerHeight;
    result.referenceSize = ref.innerWidth + 'x' + ref.innerHeight;
    if (!result.sizeMatchesReference) result.notes.push('WARNING: window size differs from the reference run; the photo sits at a different offset, compare with care');
  }
  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.error ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
