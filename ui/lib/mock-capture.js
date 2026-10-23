// ?mock=1 stand-in for the desktop screenshot bridge (preload.js helmNative.captureSources / capture /
// captureCrop), so the composer's camera flow runs in a plain browser. Screens and windows are drawn on
// a canvas. platform is 'mock' (never 'electron': the Preview pane keys off that).
// transport.js imports this in mock mode when window.helmNative is absent. Owner: lane review-tools.

const MAX_SIDE = 2000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const THUMB = 320;

// Fake desktop content: each source paints itself into (ctx, w, h).
function wallpaper(ctx, w, h, hue) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 18% 34%)`);
  g.addColorStop(1, `hsl(${hue + 30} 14% 18%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
function taskbar(ctx, w, h) {
  const tb = Math.round(h * 0.045);
  ctx.fillStyle = 'rgba(32,32,36,0.92)';
  ctx.fillRect(0, h - tb, w, tb);
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = i === 2 ? '#c9ccd3' : '#7d828c';
    const s = tb * 0.5;
    ctx.fillRect(w / 2 - 3.5 * tb + i * tb + (tb - s) / 2, h - tb + (tb - s) / 2, s, s);
  }
}
function lines(ctx, x, y, w, h, color, rows, seed = 1) {
  const lh = h / rows;
  for (let i = 0; i < rows; i++) {
    const len = 0.35 + (((i * 37 + seed * 13) % 23) / 23) * 0.6;
    ctx.fillStyle = color(i);
    ctx.fillRect(x, y + i * lh + lh * 0.3, w * len, Math.max(1, lh * 0.38));
  }
}
function appWindow(ctx, x, y, w, h, { title, bar = '#2b2d31', body = '#1e1f22', paint }) {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x + 4, y + 6, w, h);
  ctx.fillStyle = body;
  ctx.fillRect(x, y, w, h);
  const th = Math.max(14, Math.round(h * 0.05));
  ctx.fillStyle = bar;
  ctx.fillRect(x, y, w, th);
  ctx.fillStyle = '#c8cad0';
  ctx.font = `${Math.round(th * 0.5)}px Segoe UI, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title, x + th * 0.6, y + th / 2);
  paint && paint(ctx, x, y + th, w, h - th);
}
const code = (ctx, x, y, w, h) => {
  ctx.fillStyle = '#252629'; ctx.fillRect(x, y, w * 0.18, h);
  lines(ctx, x + w * 0.02, y + h * 0.03, w * 0.14, h * 0.6, () => '#5d6068', 14, 3);
  const pal = ['#8fa3c4', '#b7a07e', '#9db59a', '#aeb1b8', '#c49a9a'];
  lines(ctx, x + w * 0.22, y + h * 0.03, w * 0.7, h * 0.92, (i) => pal[(i * 7) % pal.length], 34, 5);
};
const browser = (ctx, x, y, w, h) => {
  ctx.fillStyle = '#f4f4f2'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e3e3e0'; ctx.fillRect(x, y, w, h * 0.07);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x + w * 0.15, y + h * 0.015, w * 0.6, h * 0.04);
  ctx.fillStyle = '#2f3134'; ctx.font = `bold ${Math.round(h * 0.05)}px Georgia, serif`; ctx.textBaseline = 'top';
  ctx.fillText('Electron desktopCapturer', x + w * 0.1, y + h * 0.13);
  lines(ctx, x + w * 0.1, y + h * 0.24, w * 0.75, h * 0.68, (i) => (i % 6 === 5 ? '#f4f4f2' : '#8b8d91'), 22, 2);
};
const term = (ctx, x, y, w, h) => {
  ctx.fillStyle = '#0f1012'; ctx.fillRect(x, y, w, h);
  lines(ctx, x + w * 0.03, y + h * 0.04, w * 0.9, h * 0.9, (i) => (i % 4 === 0 ? '#9db59a' : '#a7a9ae'), 26, 7);
};
const helmUi = (ctx, x, y, w, h) => {
  ctx.fillStyle = '#18191b'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#202124'; ctx.fillRect(x, y, w * 0.2, h);
  lines(ctx, x + w * 0.02, y + h * 0.05, w * 0.15, h * 0.5, () => '#55585f', 10, 4);
  lines(ctx, x + w * 0.26, y + h * 0.06, w * 0.6, h * 0.7, (i) => (i % 5 === 0 ? '#b9bcc4' : '#6c7079'), 20, 9);
  ctx.fillStyle = '#26272a'; ctx.fillRect(x + w * 0.26, y + h * 0.84, w * 0.62, h * 0.11);
};

function desktop(hue, wins) {
  return (ctx, w, h) => {
    wallpaper(ctx, w, h, hue);
    for (const [fx, fy, fw, fh, o] of wins) appWindow(ctx, fx * w, fy * h, fw * w, fh * h, o);
    taskbar(ctx, w, h);
  };
}
const solo = (o) => (ctx, w, h) => appWindow(ctx, 0, 0, w, h, o);

const SOURCES = [
  { id: 'screen:0:0', name: 'Screen 1', kind: 'screen', displayId: '1', w: 2560, h: 1440,
    paint: desktop(220, [[0.05, 0.08, 0.55, 0.7, { title: 'helm — Visual Studio Code', paint: code }], [0.48, 0.2, 0.46, 0.62, { title: 'Docs — Microsoft Edge', bar: '#dedede', paint: browser }]]) },
  { id: 'screen:1:0', name: 'Screen 2', kind: 'screen', displayId: '2', w: 1920, h: 1080,
    paint: desktop(150, [[0.12, 0.12, 0.7, 0.66, { title: 'Windows Terminal', bar: '#1b1c1f', paint: term }]]) },
  { id: 'window:101:0', name: 'helm — Visual Studio Code', kind: 'window', w: 1600, h: 1000, icon: '#5b7fb8', paint: solo({ title: 'helm — Visual Studio Code', paint: code }) },
  { id: 'window:102:0', name: 'Electron desktopCapturer — Microsoft Edge', kind: 'window', w: 1500, h: 1000, icon: '#4f8f8a', paint: solo({ title: 'Docs — Microsoft Edge', bar: '#dedede', paint: browser }) },
  { id: 'window:103:0', name: 'Windows Terminal', kind: 'window', w: 1200, h: 760, icon: '#6f7177', paint: solo({ title: 'Windows Terminal', bar: '#1b1c1f', paint: term }) },
  { id: 'window:104:0', name: 'Helm', kind: 'window', w: 1600, h: 1000, icon: '#8a8d94', self: true, paint: solo({ title: 'Helm', bar: '#1e1f22', paint: helmUi }) },
];

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function render(src, w, h) { const c = canvas(w, h); src.paint(c.getContext('2d'), w, h); return c; }
function fit(w, h, max) { const s = Math.min(1, max / Math.max(w, h)); return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }; }
function scaled(c, w, h) { if (c.width === w && c.height === h) return c; const o = canvas(w, h); const x = o.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, w, h); return o; }
const bytes = (dataUrl) => Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

function icon(color) {
  const c = canvas(32, 32); const x = c.getContext('2d');
  x.fillStyle = color; x.beginPath(); x.roundRect(3, 3, 26, 26, 6); x.fill();
  x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(9, 11, 14, 2.5); x.fillRect(9, 16, 10, 2.5); x.fillRect(9, 21, 12, 2.5);
  return c.toDataURL('image/png');
}

// Same limits as main/capture.js encodeWithin: <= 2000 px long side, PNG, else JPEG, else smaller.
function encode(c) {
  let { width, height } = fit(c.width, c.height, MAX_SIDE);
  let cur = scaled(c, width, height);
  let url = cur.toDataURL('image/png');
  if (bytes(url) <= MAX_BYTES) return { mime: 'image/png', ext: 'png', url, width, height };
  for (const q of [0.88, 0.8, 0.7, 0.6]) { url = cur.toDataURL('image/jpeg', q); if (bytes(url) <= MAX_BYTES) return { mime: 'image/jpeg', ext: 'jpg', url, width, height }; }
  for (let i = 0; i < 20; i++) {
    ({ width, height } = fit(c.width, c.height, Math.round(Math.max(width, height) * 0.8)));
    cur = scaled(c, width, height); url = cur.toDataURL('image/jpeg', 0.6);
    if (bytes(url) <= MAX_BYTES) return { mime: 'image/jpeg', ext: 'jpg', url, width, height };
  }
  throw new Error('The screenshot could not be made small enough to attach');
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
const clean = (s) => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
function attachment(c, name) {
  const e = encode(c);
  return { kind: 'image', name: `Screenshot ${clean(name)} ${stamp()}.${e.ext}`, mime: e.mime, dataUrl: e.url, size: bytes(e.url), width: e.width, height: e.height };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cached = null;   // { token, canvas, name }
const thumbs = new Map();
const icons = new Map();

async function captureSources() {
  await wait(120);
  return SOURCES.map((s) => {
    if (!thumbs.has(s.id)) { const f = fit(s.w, s.h, THUMB); thumbs.set(s.id, render(s, f.width, f.height).toDataURL('image/jpeg', 0.72)); }
    if (s.icon && !icons.has(s.id)) icons.set(s.id, icon(s.icon));
    return { id: s.id, name: s.name, kind: s.kind, displayId: s.displayId || null, thumb: thumbs.get(s.id), icon: icons.get(s.id) || null, self: !!s.self };
  });
}

async function capture(id) {
  await wait(350);
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`That ${String(id).startsWith('screen') ? 'screen' : 'window'} is no longer available. Pick it again.`);
  const c = render(s, s.w, s.h);
  const token = Math.random().toString(16).slice(2);
  cached = { token, canvas: c, name: s.name };
  return { token, name: s.name, width: c.width, height: c.height, attachment: attachment(c, s.name) };
}

async function captureCrop(token, rect) {
  await wait(80);
  if (!cached || cached.token !== token) throw new Error('That screenshot has expired (kept for 2 minutes). Capture it again.');
  const W = cached.canvas.width, H = cached.canvas.height;
  const x = Math.min(Math.max(0, Math.round(rect.x)), W - 1), y = Math.min(Math.max(0, Math.round(rect.y)), H - 1);
  const w = Math.min(Math.max(1, Math.round(rect.width)), W - x), h = Math.min(Math.max(1, Math.round(rect.height)), H - y);
  const c = canvas(w, h);
  c.getContext('2d').drawImage(cached.canvas, x, y, w, h, 0, 0, w, h);
  return { width: w, height: h, rect: { x, y, width: w, height: h }, attachment: attachment(c, cached.name) };
}

export function install() {
  if (window.helmNative) return;
  window.helmNative = { platform: 'mock', captureSources, capture, captureCrop };
  window.dispatchEvent(new Event('helm:native-ready'));
}
