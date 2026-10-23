// Screenshot attach (desktop only): list screens/windows with small thumbnails, capture one at full
// resolution, crop it, encode it inside the attachment limits. Uses desktopCapturer.getSources
// thumbnails, so there is no getDisplayMedia call and no permission prompt.
// IPC: helm:capture-sources | helm:capture | helm:capture-crop (main window only).
// Owner: lane review-tools.

const crypto = require('crypto');

const MAX_SIDE = 2000;                 // longest side of any attachment, px
const MAX_BYTES = 1.5 * 1024 * 1024;   // encoded size limit
const THUMB_BOX = 320;                 // picker thumbnails fit a 320 px box
const CACHE_MS = 2 * 60 * 1000;        // a capture's full-res image is kept this long for cropping
const HIDE_WAIT_MS = 300;              // let the compositor repaint after hiding Helm
const JPEG_QUALITIES = [88, 80, 70, 60];
const SHRINK = 0.8;                    // per step once JPEG quality alone cannot fit
const MIN_SIDE = 64;

function captureError(message, code = 'capture_failed') { return Object.assign(new Error(message), { code }); }

/** Fit (w, h) inside a max-side box, never upscaling. */
function fitWithin(width, height, maxSide = MAX_SIDE) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return { width: w, height: h, scale: 1 };
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/**
 * Encode a nativeImage-like object ({ getSize, resize, toPNG, toJPEG }) inside the limits:
 * longest side <= maxSide (never upscaled), PNG when it fits, else JPEG at falling quality,
 * else smaller dimensions until it fits. Returns { mime, ext, buffer, width, height }.
 */
function encodeWithin(img, { maxSide = MAX_SIDE, maxBytes = MAX_BYTES } = {}) {
  const src = img.getSize();
  if (!src || !(src.width > 0) || !(src.height > 0)) throw captureError('The captured image is empty');
  let fit = fitWithin(src.width, src.height, maxSide);
  let cur = fit.scale < 1 ? img.resize({ width: fit.width, height: fit.height, quality: 'best' }) : img;
  const png = cur.toPNG();
  if (png.length <= maxBytes) return { mime: 'image/png', ext: 'png', buffer: png, width: fit.width, height: fit.height };
  for (const q of JPEG_QUALITIES) {
    const jpg = cur.toJPEG(q);
    if (jpg.length <= maxBytes) return { mime: 'image/jpeg', ext: 'jpg', buffer: jpg, width: fit.width, height: fit.height };
  }
  let side = Math.max(fit.width, fit.height);
  for (let i = 0; i < 20; i++) {
    side = Math.round(side * SHRINK);
    if (side < MIN_SIDE) break;
    fit = fitWithin(src.width, src.height, side);
    cur = img.resize({ width: fit.width, height: fit.height, quality: 'good' });
    const jpg = cur.toJPEG(JPEG_QUALITIES[JPEG_QUALITIES.length - 1]);
    if (jpg.length <= maxBytes) return { mime: 'image/jpeg', ext: 'jpg', buffer: jpg, width: fit.width, height: fit.height };
  }
  throw captureError('The screenshot could not be made small enough to attach');
}

/** Clamp a crop rect (full-res px) to the image bounds; at least 1x1. */
function clampRect(rect, width, height) {
  const n = (v) => Number(v);
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every((v) => Number.isFinite(n(v)))) throw captureError('Crop needs numeric x, y, width and height', 'bad_request');
  const x = Math.min(Math.max(0, Math.round(n(rect.x))), width - 1);
  const y = Math.min(Math.max(0, Math.round(n(rect.y))), height - 1);
  const w = Math.min(Math.max(1, Math.round(n(rect.width))), width - x);
  const h = Math.min(Math.max(1, Math.round(n(rect.height))), height - y);
  return { x, y, width: w, height: h };
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`; }
function cleanName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s.length > 40 ? s.slice(0, 40).trim() : s) || 'Screen';
}
function attachmentName(sourceName, ext, now) { return `Screenshot ${cleanName(sourceName)} ${stamp(now)}.${ext}`; }

function toAttachment(enc, sourceName, now) {
  return {
    kind: 'image', name: attachmentName(sourceName, enc.ext, now), mime: enc.mime,
    dataUrl: `data:${enc.mime};base64,${enc.buffer.toString('base64')}`, size: enc.buffer.length,
    width: enc.width, height: enc.height,
  };
}

/**
 * createCapture({ desktopCapturer, screen, getWindow, sleep, now })
 *   -> { captureSources(), capture(id, opts), captureCrop(token, rect), _cache() }
 */
function createCapture({ desktopCapturer, screen, getWindow, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), log = () => {} }) {
  let cached = null;   // { token, img, name, width, height, timer }

  const liveWin = () => { const w = getWindow && getWindow(); return w && !(w.isDestroyed && w.isDestroyed()) ? w : null; };
  const selfId = () => { const w = liveWin(); try { return w ? w.getMediaSourceId() : null; } catch { return null; } };
  const kindOf = (id) => (String(id).startsWith('screen:') ? 'screen' : 'window');

  function drop() { if (cached) { clearTimeout(cached.timer); cached = null; } }
  function keep(img, name) {
    drop();
    const size = img.getSize();
    const token = crypto.randomBytes(12).toString('hex');
    const timer = setTimeout(() => { if (cached && cached.token === token) cached = null; }, CACHE_MS);
    if (timer.unref) timer.unref();
    cached = { token, img, name, width: size.width, height: size.height, timer };
    return cached;
  }

  async function captureSources() {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: THUMB_BOX, height: THUMB_BOX }, fetchWindowIcons: true });
    const me = selfId();
    const out = [];
    for (const s of sources || []) {
      const kind = kindOf(s.id);
      if (kind === 'window' && !String(s.name || '').trim()) continue;
      const t = s.thumbnail;
      const thumb = t && !t.isEmpty() ? `data:image/jpeg;base64,${t.toJPEG(72).toString('base64')}` : null;
      let icon = null;
      try { if (s.appIcon && !s.appIcon.isEmpty()) icon = s.appIcon.resize({ width: 32, height: 32, quality: 'best' }).toDataURL(); } catch {}
      out.push({ id: s.id, name: String(s.name || (kind === 'screen' ? 'Screen' : 'Window')), kind, displayId: s.display_id ? String(s.display_id) : null, thumb, icon, self: !!me && s.id === me });
    }
    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1));
  }

  function nativeBox(kind, displayId) {
    const displays = (screen && screen.getAllDisplays ? screen.getAllDisplays() : []) || [];
    const px = (d) => ({ width: Math.round(d.size.width * (d.scaleFactor || 1)), height: Math.round(d.size.height * (d.scaleFactor || 1)) });
    if (kind === 'screen') {
      const d = displays.find((x) => String(x.id) === String(displayId)) || (screen && screen.getPrimaryDisplay && screen.getPrimaryDisplay());
      if (d) return px(d);
    }
    let best = null;
    for (const d of displays) { const p = px(d); if (!best || p.width * p.height > best.width * best.height) best = p; }
    return best || { width: 3840, height: 2160 };
  }

  async function capture(id, { hideSelf = true } = {}) {
    id = String(id || '');
    if (!id) throw captureError('No screen or window was chosen', 'bad_request');
    const kind = kindOf(id);
    const w = liveWin();
    const isSelf = !!w && id === selfId();
    const hide = !!hideSelf && !!w && !isSelf && w.isVisible() && !w.isMinimized();
    // which display a screen source is on: read it from the cheap list first (thumbnailSize 0 = no pixels)
    let displayId = null;
    if (kind === 'screen') {
      const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const hit = (list || []).find((s) => s.id === id);
      displayId = hit ? hit.display_id : null;
    }
    let src;
    if (hide) { w.hide(); await sleep(HIDE_WAIT_MS); }
    try {
      const box = nativeBox(kind, displayId);
      const list = await desktopCapturer.getSources({ types: [kind], thumbnailSize: box, fetchWindowIcons: false });
      src = (list || []).find((s) => s.id === id);
    } finally {
      if (hide) { try { if (!w.isDestroyed()) { w.show(); w.focus(); } } catch (e) { log('capture: restore window failed', e.message); } }
    }
    if (!src) throw captureError(`That ${kind} is no longer available. Pick it again.`, 'not_found');
    const img = src.thumbnail;
    if (!img || img.isEmpty()) throw captureError(`Windows returned an empty image for "${src.name}". Minimised windows cannot be captured.`, 'empty');
    const c = keep(img, src.name);
    const enc = encodeWithin(img);
    return { token: c.token, name: src.name, width: c.width, height: c.height, attachment: toAttachment(enc, src.name, now()) };
  }

  async function captureCrop(token, rect) {
    if (!cached || cached.token !== String(token || '')) throw captureError('That screenshot has expired (kept for 2 minutes). Capture it again.', 'expired');
    const r = clampRect(rect, cached.width, cached.height);
    const img = cached.img.crop(r);
    const enc = encodeWithin(img);
    return { width: r.width, height: r.height, rect: r, attachment: toAttachment(enc, cached.name, now()) };
  }

  return { captureSources, capture, captureCrop, _cache: () => cached, _drop: drop };
}

/** Register the IPC handlers; only the main window's webContents may call them. */
function registerCapture({ ipcMain, desktopCapturer, screen, getWindow, log = () => {} }) {
  const cap = createCapture({ desktopCapturer, screen, getWindow, log });
  const guard = (fn) => async (event, ...args) => {
    const w = getWindow && getWindow();
    if (!w || w.isDestroyed() || event.sender !== w.webContents) throw captureError('Screenshots are only available in the main Helm window', 'forbidden');
    try { return await fn(...args); } catch (e) { log('capture:', e.message); throw e; }
  };
  ipcMain.handle('helm:capture-sources', guard(() => cap.captureSources()));
  ipcMain.handle('helm:capture', guard((id, opts) => cap.capture(id, opts || {})));
  ipcMain.handle('helm:capture-crop', guard((token, rect) => cap.captureCrop(token, rect)));
  return cap;
}

module.exports = { fitWithin, encodeWithin, clampRect, attachmentName, createCapture, registerCapture, MAX_SIDE, MAX_BYTES };
