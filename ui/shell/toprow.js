// Top-row hints for Mantle, renderer side (lane helm-toprow-hints). Mantle's top bar takes the colour of the window
// under it; this tells it what Helm's TOP PIXEL ROW is about to be, in the same JS task that changes it (Preact's
// layout effects, the lined-up layer's per-frame move, a modal opening), so the bar can paint on the same frame
// instead of waiting for its screen capture. The maths is ui/lib/toprow.js; this file reads the live inputs:
//   - Background (chrome.js) registers a snapshot of its layers (topRowSource) and calls topRowUpdate on every
//     render and every move of the lined-up layer
//   - modals / the palette / the lightbox render <TopScrim> (ui/lib/top-scrim.js) while they are open
//   - Home's fade (.bg-clear opacity) is followed frame by frame from requestAnimationFrame
// The hint goes to the main process (preload helmNative.topRow -> main/toprow.js -> the pipe). Desktop window only.
import { signal } from '@preact/signals';
import { topFor, spans, colCount, sameTop, SCRIM, BG_RGB } from '../lib/toprow.js';
import { coverRect } from '../lib/bg-placement.js';
import { openScrims, onScrimChange } from '../lib/top-scrim.js';
import { background, resolvedTheme } from './state.js';
import { look, settings } from '../lib/store.js';

const native = () => (typeof window !== 'undefined' ? window.helmNative : null);
let source = null;          // () => Background's layers (chrome.js)
let last = null;            // the last TOP sent
let fadeRaf = 0;
// what was sent last, for Settings > Appearance: { kind, alpha?, why } (changes rarely; never per frame)
export const topRowLast = signal(null);
// a small ring for the checks (tools/toprow-check.js): what was sent, when, and why
const ring = [];
if (typeof window !== 'undefined') window.__helmTopRow = { ring, computeMs: 0 };

export function topRowSource(fn) { source = fn; }
onScrimChange((why) => topRowUpdate(why));   // <TopScrim> in modals / the palette / the lightbox


// ---------- reading rows ----------
// one scratch canvas per use (the 1-row read and the blurred band): sharing one resized it twice a frame mid-fade
const scratch = {};
function ctx2d(w, h, slot) {
  let c = scratch[slot];
  if (!c) c = scratch[slot] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c.getContext('2d', { willReadFrequently: true });
}

// the lined-up blurred canvas: its backing row under the window's row 0, cut to the window (cached per offset)
let blurRowCache = { key: null, cols: null };
function blurredFromCanvas(c, tx, ty, W) {
  const dpr = c.canvas.width / c.monW;
  const key = [c.key, tx, ty, W].join('|');
  if (blurRowCache.key === key) return blurRowCache.cols;
  const y = Math.min(c.canvas.height - 1, Math.max(0, Math.floor((-ty + 0.5 / dpr) * dpr)));
  const x0 = Math.max(0, Math.round(-tx * dpr)), w = Math.max(1, Math.min(c.canvas.width - x0, Math.round(W * dpr)));
  const row = c.canvas.getContext('2d').getImageData(x0, y, w, 1).data;
  const cols = spans(row, w, colCount(W));
  blurRowCache = { key, cols };
  return cols;
}

// decoded pictures by URL (the lined-up path hands its own in; own mode / the CSS fallback decode here)
const imgs = new Map();   // url -> HTMLImageElement | 'loading' | 'failed'
function decoded(url, given) {
  if (given && given.naturalWidth) return given;
  const v = imgs.get(url);
  if (v && v !== 'loading' && v !== 'failed') return v;
  if (!v) {
    imgs.set(url, 'loading');
    if (imgs.size > 4) imgs.delete(imgs.keys().next().value);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode().then(() => { imgs.set(url, img); topRowUpdate('decoded'); }, () => imgs.set(url, 'failed'));
  }
  return null;
}

// one picture row drawn like CSS `background-size: cover; background-position: center` in `box` (window CSS px),
// optionally blurred like the CSS filter (own mode / fallback), cut to the window's W CSS px
// one cache slot per kind: while Home's copy fades, compute() asks for BOTH the clear row and the blurred row every
// frame; with one shared slot each evicted the other, so every frame redrew the blurred band on the CPU (helm-motion2)
const rowCache = { clear: { key: null, cols: null }, blur: { key: null, cols: null } };
function pictureRow(img, box, W, blurPx) {
  const key = [img.src, box.x, box.y, box.width, box.height, W, blurPx, resolvedTheme.peek()].join('|');
  const slot = blurPx > 0 ? 'blur' : 'clear';
  if (rowCache[slot].key === key) return rowCache[slot].cols;
  const r = coverRect(img.naturalWidth, img.naturalHeight, box.width, box.height);
  const left = box.x + r.x, top = box.y + r.y, sx = img.naturalWidth / r.width, sy = img.naturalHeight / r.height;
  let row;
  if (!(blurPx > 0)) {
    const dpr = devicePixelRatio || 1;
    const y = Math.min(img.naturalHeight - 1, Math.max(0, Math.floor((0.5 / dpr - top) * sy)));
    const c = ctx2d(W, 1, 'row');
    c.clearRect(0, 0, W, 1);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'medium';
    c.drawImage(img, (0 - left) * sx, y, W * sx, 1, 0, 0, W, 1);
    row = c.getImageData(0, 0, W, 1).data;
  } else {
    // a band of rows around row 0, blurred like the CSS filter on the element (which starts 2.5 x blur above row 0)
    const m = Math.ceil(blurPx * 3), H = 2 * m + 1;
    const c = ctx2d(W + 2 * m, H, 'band');
    c.clearRect(0, 0, W + 2 * m, H);
    c.save();
    c.fillStyle = `rgb(${BG_RGB[resolvedTheme.peek() === 'light' ? 'light' : 'dark'].join(',')})`;
    c.fillRect(0, 0, W + 2 * m, H);
    c.filter = `blur(${blurPx}px)${resolvedTheme.peek() === 'light' ? ' saturate(150%)' : ''}`;   // light ground: + saturate, as painted
    // canvas y = window y + m (row 0 at the band's centre); x = window x + m
    c.beginPath(); c.rect(box.x + m, box.y + m, box.width, box.height); c.clip();
    c.drawImage(img, left + m, top + m, r.width, r.height);
    c.restore();
    row = c.getImageData(m, m, W, 1).data;
  }
  const cols = spans(row, W, colCount(W));
  rowCache[slot] = { key, cols };
  return cols;
}

// ---------- the TOP ----------
function compute() {
  const b = background.peek();
  const theme = resolvedTheme.peek() === 'light' ? 'light' : 'dark';
  const W = Math.max(1, Math.round(innerWidth));
  const s = source ? source() : null;
  const st = {
    theme, photo: !!b.url, dim: Math.min(0.95, Math.max(0, +b.dim || 0)),
    scrims: openScrims().map((x) => x || SCRIM[theme]),
    home: 0, washOk: false, blurred: null, clear: null,
  };
  if (!st.photo) return { top: topFor(st), why: 'no picture: --bg under the wash' };
  // Home's unblurred copy: its opacity right now (mid-fade too: read once per frame while it animates)
  const clearEl = s && s.clearEl;
  if (clearEl && clearEl.isConnected) {
    const o = parseFloat(getComputedStyle(clearEl).opacity);
    st.home = Number.isFinite(o) ? o : 1;
    if (clearEl.getAnimations().some((a) => a.playState === 'running')) followFade();
  }
  const lined = s && s.lined;   // { canvas, monW, monH, key, url, blurPx } on screen, or null (CSS cover + filter)
  const d = b.desktop || null, sync = look.peek()?.sync || null;
  const sharedBlur = sync && sync.enabled && sync.state === 'ok' ? settings.peek()?.glass?.[theme]?.blurPx : null;   // the glass of the theme showing (light look un-held)
  st.washOk = !!(lined && b.mode === 'desktop' && d && d.source === 'mantle' && lined.url === b.url
    && sharedBlur != null && Math.abs(lined.blurPx - sharedBlur) < 0.01);
  let why = null;
  if (st.home < 1 && !(st.home === 0 && st.washOk)) {
    if (lined) st.blurred = blurredFromCanvas(lined, s.tx, s.ty, W);
    else {
      const img = decoded(b.url, null);
      if (img) st.blurred = pictureRow(img, { x: -2.5 * b.blur, y: -2.5 * b.blur, width: innerWidth + 5 * b.blur, height: innerHeight + 5 * b.blur }, W, Math.max(0, +b.blur || 0));
      else why = 'the picture is still decoding';
    }
  }
  if (st.home > 0) {
    const img = decoded(b.url, lined ? s.img : null);
    if (img) {
      const box = lined ? { x: s.tx, y: s.ty, width: lined.monW, height: lined.monH } : { x: 0, y: 0, width: innerWidth, height: innerHeight };
      st.clear = pictureRow(img, box, W, 0);
    } else why = 'the picture is still decoding';
  }
  const top = topFor(st);
  if (top.kind === 'wash') why = 'the shared desktop still, lined up and blurred like the shared glass';
  else if (top.kind === 'cols') why = st.home > 0 ? (st.home < 1 ? 'Home fading' : 'Home: the unblurred picture') : !lined ? 'own picture / not lined up yet' : 'lined up, but not the shared glass (sync off, a preview, or a different still)';
  return { top, why: why || 'unknown' };
}

// while Home's copy fades, one update per frame: requestAnimationFrame runs before the frame it describes
function followFade() {
  if (fadeRaf) return;
  fadeRaf = requestAnimationFrame(() => { fadeRaf = 0; topRowUpdate('fade'); });
}

/** work out the TOP now and send it when it changed. Cheap when nothing changed (rows are cached). */
export function topRowUpdate(why) {
  const nat = native();
  if (!nat || typeof nat.topRow !== 'function' || !source) return;
  let r;
  const t0 = performance.now();
  try { r = compute(); } catch (e) { r = { top: { kind: 'none' }, why: 'could not work it out: ' + (e && e.message) }; }
  window.__helmTopRow.computeMs = +(performance.now() - t0).toFixed(2);
  if (sameTop(r.top, last)) return;
  last = r.top;
  nat.topRow(r.top);
  const entry = { t: Date.now(), p: performance.now(), why, kind: r.top.kind, top: r.top };
  ring.push(entry);
  if (ring.length > 120) ring.splice(0, ring.length - 120);
  // the check (tools/toprow-check.js) sets trace: note when the next two frames begin, to prove the hint went out first
  if (window.__helmTopRow.trace) requestAnimationFrame(() => { entry.f1 = Date.now(); requestAnimationFrame(() => { entry.f2 = Date.now(); }); });
  const lastKind = topRowLast.peek();
  const alpha = r.top.kind === 'wash' ? r.top.alpha : undefined;
  if (!lastKind || lastKind.kind !== r.top.kind || lastKind.alpha !== alpha || lastKind.why !== r.why) topRowLast.value = { kind: r.top.kind, alpha, why: r.why };
}
