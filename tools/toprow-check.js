// Top-row hints, checked against real pixels (lane helm-toprow-hints).
// Starts `electron <app> --test --profile=<unique>` (off-screen window, throwaway profile, LOOK_SYNC_DIR = a fresh
// temp folder holding a Mantle desktop record for snow-peak.jpg) with HELM_TOPROW_PIPE = a FAKE Mantle pipe server
// run here (never the user's real \\.\pipe\look-sync-toprow). Then a scripted session: Home, a session view, Settings,
// the palette open / closed, own picture, "None", the light theme, Home in light. For each step:
//   - the hint the fake Mantle received last for the window, against the window's captured top pixel row
//     (capturePage, device pixels): wash = the lined-up blurred still row (read back from Helm's canvas) under
//     rgb at alpha; flat = the colour; cols = each span's mean. Error = max over spans of the max channel diff.
//   - order: seq increases per hwnd; timing: every hint arrived before the second frame after it was sent
//     (page rAF stamps, toprow.js trace) and the receive - send latency.
// Usage: node tools/toprow-check.js [--app=<helm dir>] [--out=<dir>] [--keep] [--tol=6]
// Exit 0 = every step within tol and every hint in order and in time.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const net = require('net');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes('--' + k);
const APP = path.resolve(arg('app', path.join(__dirname, '..')));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'claude', 'toprow-check', 'run-' + Date.now())));
const KEEP = has('keep');
const TOL = Number(arg('tol', 6));
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

// ---------- fake Mantle ----------
function fakeMantle(name) {
  const lines = [];
  const socks = new Set();
  const server = net.createServer((s) => {
    socks.add(s); s.on('close', () => socks.delete(s));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg = null; try { msg = JSON.parse(raw); } catch {}
        lines.push({ at: Date.now(), bytes: Buffer.byteLength(raw), msg });
      }
    });
    s.on('error', () => {});
  });
  return new Promise((res) => server.listen(name, () => res({ lines, close: () => new Promise((r) => { for (const k of socks) k.destroy(); server.close(() => r()); }) })));
}

async function rpcClient(port, token) {
  const ws = new WS(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
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

// the lined-up canvas row under row 0 (device px), straight from Helm's own blurred still
const CANVAS_ROW = `(() => {
  const bg = document.querySelector('.bg'), cv = document.querySelector('.bg-photo.bg-lined canvas');
  if (!cv || !bg) return null;
  const tx = +bg.dataset.tx || 0, ty = +bg.dataset.ty || 0, dpr = cv.width / parseFloat(cv.style.width || cv.getBoundingClientRect().width);
  const W = Math.round(innerWidth * devicePixelRatio);
  const y = Math.max(0, Math.floor((-ty + 0.5 / devicePixelRatio) * devicePixelRatio)), x0 = Math.max(0, Math.round(-tx * devicePixelRatio));
  const d = cv.getContext('2d').getImageData(x0, y, Math.min(W, cv.width - x0), 1).data;
  return Array.from(d);
})()`;

function rowStats(img, y = 0) {
  const row = [];
  for (let x = 0; x < img.width; x++) { const d = (y * img.width + x) * 4; row.push([img.px[d], img.px[d + 1], img.px[d + 2]]); }
  return row;
}
// compare a hint with the captured device row -> { err (max over spans of max channel diff), meanErr, spans }
function compare(top, row, canvasRow, nSpans) {
  const W = row.length;
  let pred;
  if (top.kind === 'flat') pred = row.map(() => top.rgb);
  else if (top.kind === 'wash') {
    if (!canvasRow) return { err: null, note: 'no lined canvas to predict the wash from' };
    pred = row.map((_, x) => { const d = Math.min(x, canvasRow.length / 4 - 1) * 4; return [0, 1, 2].map((k) => top.rgb[k] * top.alpha + canvasRow[d + k] * (1 - top.alpha)); });
  } else if (top.kind === 'cols') {
    const n = top.cols.length;
    pred = row.map((_, x) => top.cols[Math.min(n - 1, Math.floor((x * n) / W))]);
    nSpans = n;
  } else return { err: null, note: 'none: nothing to compare' };
  // compare span means (the bar paints per span; single pixels of a photo row are noisy)
  const n = Math.max(1, Math.min(nSpans, W));
  let worst = 0, sum = 0, worstAt = 0;
  for (let i = 0; i < n; i++) {
    const x0 = Math.floor((i * W) / n), x1 = Math.max(x0 + 1, Math.floor(((i + 1) * W) / n));
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let x = x0; x < x1; x++) for (let k = 0; k < 3; k++) { a[k] += row[x][k]; b[k] += pred[x][k]; }
    const e = Math.max(...[0, 1, 2].map((k) => Math.abs(a[k] - b[k]) / (x1 - x0)));
    sum += e; if (e > worst) { worst = e; worstAt = i; }
  }
  return { err: +worst.toFixed(2), meanErr: +(sum / n).toFixed(2), spans: n, worstSpan: worstAt };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pipe = `\\\\.\\pipe\\helm-toprow-check-${process.pid}-${Date.now().toString(36)}`;
  const mantle = await fakeMantle(pipe);
  const profile = 'toprow' + process.pid + '-' + Date.now().toString(36);
  const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
  const lookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-looksync-toprow-'));
  const wallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-test-wallpaper-'));
  const testWallpaper = path.join(wallDir, 'TranscodedWallpaper');
  fs.copyFileSync(path.join(APP, 'ui', 'assets', 'backgrounds', 'misty-lake.jpg'), testWallpaper);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ background: { kind: 'image', file: BG_FILE, blur: 5, dim: 0.5, mode: 'desktop' }, theme: 'dark', lookSync: { enabled: true } }, null, 2));
  const stills = path.join(lookDir, 'stills'); fs.mkdirSync(stills, { recursive: true });
  const still = path.join(stills, 'wall-1.jpg'); fs.copyFileSync(BG_SRC, still);
  execFileSync(process.execPath, [FAKE_WRITER, '--dir', lookDir, '--app', 'mantle', 'desktop', 'builtin:snow-peak', BG_SRC, still], { encoding: 'utf8' });
  const env = { ...process.env, LOOK_SYNC_DIR: lookDir, HELM_TEST_WALLPAPER: testWallpaper, HELM_TOPROW_PIPE: pipe };
  const child = spawn(electronExe, [APP, '--test', '--profile=' + profile], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  console.error(`electron pid ${child.pid}, profile ${userData}, pipe ${pipe}`);
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const result = { tool: 'toprow-check', at: new Date().toISOString(), app: APP, tol: TOL, steps: [], problems: [] };
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
    for (let i = 0; i < 60 && !(await ev(`!!document.querySelector('.app .strip')`)); i++) await sleep(250);
    await ev(`(window.__helmTopRow.trace = true)`);
    const wh = await ev(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
    await c.call('test.placement', { content: { x: 0, y: 0, width: wh.w, height: wh.h }, display: { x: 0, y: 0, width: wh.w, height: wh.h, scaleFactor: wh.dpr } });
    result.window = wh;
    await sleep(1500);
    const hello = await c.call('app.hello');
    result.lookSync = hello.result && hello.result.look ? hello.result.look.sync : null;
    result.toprowStatus = hello.result ? hello.result.toprow : null;
    const nav = (v) => `import('/shell/state.js').then((m) => { m.go(${JSON.stringify(v)}); return m.view.value; })`;
    const save = (p) => `import('/lib/store.js').then((m) => m.saveSettings(${JSON.stringify(p)})).then(() => 'saved')`;
    const palette = (on) => `import('/shell/state.js').then((m) => { m.paletteOpen.value = ${on}; return ${on}; })`;
    const steps = [
      ['home (dark, start)', null],
      ['session (dark)', nav('session')],
      ['settings (dark)', nav('settings')],
      ['palette open (dark)', palette(true)],
      ['palette closed (dark)', palette(false)],
      ['home again (dark)', nav('home')],
      ['session, own picture (dark)', `${nav('session')}.then(() => ${save({ background: { mode: 'own', file: BG_FILE } })})`],
      ['session, None background (dark)', save({ background: { mode: 'own', file: null } })],
      ['session, desktop, light', save({ background: { mode: 'desktop', file: BG_FILE }, theme: 'light' })],
      ['home (light)', nav('home')],
      ['session (dark again)', `${nav('session')}.then(() => ${save({ theme: 'dark' })})`],
    ];
    for (const [name, js] of steps) {
      const before = mantle.lines.length;
      const out = js ? await ev(js) : null;
      await sleep(1600);   // fades (300 ms), a fresh blur render, decode
      const file = path.join(OUT, name.replace(/[^a-z0-9]+/gi, '-') + '.png');
      const cap = await c.call('test.capture', { file, waitMs: 300 });
      if (cap.error) throw new Error('test.capture: ' + JSON.stringify(cap.error));
      const img = decodePng(fs.readFileSync(file));
      const canvasRow = await ev(CANVAS_ROW);
      const ring = await ev(`window.__helmTopRow.ring.slice(-40)`);
      const page = await ev(`({ view: document.querySelector('.app')?.className, dim: getComputedStyle(document.documentElement).getPropertyValue('--bg-dim').trim(), theme: document.documentElement.dataset.theme, lined: document.querySelector('.bg')?.dataset.lined, computeMs: window.__helmTopRow.computeMs })`);
      const mine = mantle.lines.filter((l) => l.msg);
      const last = mine[mine.length - 1];
      const row = rowStats(img, 0);
      const cmp = last ? compare(last.msg.top, row, canvasRow, Math.ceil(wh.w / 8)) : { err: null, note: 'no hint received' };
      const lastRing = ring[ring.length - 1] || null;
      const step = { name, action: out, hintsThisStep: mantle.lines.length - before, last: last ? { seq: last.msg.seq, kind: last.msg.top.kind, alpha: last.msg.top.alpha, rgb: last.msg.top.rgb, cols: last.msg.top.cols ? last.msg.top.cols.length : undefined, bytes: last.bytes } : null,
        why: lastRing && lastRing.why, page, capture: { file, width: img.width, height: img.height }, rowMean: [0, 1, 2].map((k) => +(row.reduce((s, p) => s + p[k], 0) / row.length).toFixed(1)), ...cmp };
      if (cmp.err == null || cmp.err > TOL) result.problems.push(`${name}: error ${cmp.err} (${cmp.note || 'over tol'})`);
      result.steps.push(step);
      console.error(`${name}: ${step.last && step.last.kind} err ${cmp.err} mean ${cmp.meanErr} (${step.hintsThisStep} hints)`);
    }
    // order + timing: every received line for this hwnd in seq order; each page send before its 2nd frame
    const msgs = mantle.lines.filter((l) => l.msg);
    const byHwnd = {};
    for (const l of msgs) (byHwnd[l.msg.hwnd] = byHwnd[l.msg.hwnd] || []).push(l.msg.seq);
    result.order = Object.fromEntries(Object.entries(byHwnd).map(([h, s]) => [h, { count: s.length, increasing: s.every((v, i) => i === 0 || v > s[i - 1]) }]));
    for (const [h, o] of Object.entries(result.order)) if (!o.increasing) result.problems.push(`hwnd ${h}: seq not increasing`);
    const ring = await ev(`window.__helmTopRow.ring.slice()`);
    const timing = [];
    let j = 0;
    for (const r of ring) {
      const want = JSON.stringify(r.top);
      while (j < msgs.length && JSON.stringify(msgs[j].msg.top) !== want) j++;
      if (j >= msgs.length) break;
      timing.push({ why: r.why, kind: r.kind, sendToRecv: msgs[j].at - r.t, sendToFrame1: r.f1 != null ? r.f1 - r.t : null, sendToFrame2: r.f2 != null ? r.f2 - r.t : null, beforeFrame2: r.f2 == null ? null : msgs[j].at <= r.f2 });
      j++;
    }
    const lat = timing.map((t) => t.sendToRecv).sort((a, b) => a - b);
    result.timing = { matched: timing.length, ringSize: ring.length, sendToRecvMedian: lat[Math.floor(lat.length / 2)], sendToRecvMax: lat[lat.length - 1],
      frame1Median: (() => { const f = timing.map((t) => t.sendToFrame1).filter((v) => v != null).sort((a, b) => a - b); return f[Math.floor(f.length / 2)]; })(),
      late: timing.filter((t) => t.beforeFrame2 === false) };
    if (result.timing.late.length) result.problems.push(`${result.timing.late.length} hint(s) arrived after the second frame`);
    result.hintsTotal = msgs.length;
    // the Settings line, connected and then with Mantle gone (no silent failures: the reason shows)
    const statusText = `(async () => { const m = await import('/shell/state.js'); m.go('settings'); await new Promise((r) => setTimeout(r, 400)); const el = document.querySelector('[data-toprow]'); return el ? el.dataset.toprow + ' | ' + el.textContent : null; })()`;
    result.statusConnected = await ev(statusText);
    await mantle.close();
    await sleep(2500);
    result.statusGone = await ev(statusText);
    if (!/Mantle connected/.test(result.statusConnected || '')) result.problems.push('Settings line while connected: ' + result.statusConnected);
    if (!/not running/.test(result.statusGone || '')) result.problems.push('Settings line with Mantle gone: ' + result.statusGone);
    result.maxBytes = Math.max(...msgs.map((l) => l.bytes));
  } catch (e) {
    result.error = String(e && e.stack || e);
    result.problems.push('error: ' + String(e && e.message || e));
  } finally {
    try { c && c.ws.close(); } catch {}
    killTree(child.pid);
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    await mantle.close().catch(() => {});
    if (!KEEP) {
      await sleep(500);
      for (const d of [userData, lookDir, wallDir]) for (let i = 0; i < 10; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    } else result.kept = { userData, lookDir, wallDir };
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ problems: result.problems, steps: result.steps.map((s) => ({ name: s.name, kind: s.last && s.last.kind, alpha: s.last && s.last.alpha, err: s.err, meanErr: s.meanErr, why: s.why })), order: result.order, timing: result.timing && { ...result.timing, late: result.timing.late.length }, lookSync: result.lookSync && result.lookSync.state, statusConnected: result.statusConnected, statusGone: result.statusGone, out: OUT }, null, 1));
  process.exit(result.problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
