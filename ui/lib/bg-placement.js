// Pure math for the LINED-UP wallpaper (lane looksync, 2026-10-10). No DOM, no imports.
// In "Same as desktop" mode the desktop window draws Mantle's wallpaper still behind its glass exactly where the
// desktop draws it: cover-fit to the monitor the window is mostly on, shifted by the window content area's screen
// position (DIPs). chrome.js Background renders it; test/host/bg-placement.test.js pins the numbers.

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isRect = (r) => !!r && typeof r === 'object' && num(r.x) && num(r.y) && num(r.width) && num(r.height) && r.width > 0 && r.height > 0;
const z = (v) => v + 0;   // -0 -> 0

// Exactly CSS `background-size: cover; background-position: center` for an imgW x imgH image in a boxW x boxH box:
// the smallest uniform scale that covers both dimensions, centred (overflow split evenly). Unrounded.
export function coverRect(imgW, imgH, boxW, boxH) {
  if (!(imgW > 0 && imgH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, width: Math.max(0, +boxW || 0), height: Math.max(0, +boxH || 0) };
  const s = Math.max(boxW / imgW, boxH / imgH);
  const width = imgW * s, height = imgH * s;
  return { x: z((boxW - width) / 2), y: z((boxH - height) / 2), width, height };
}

// Where the monitor-sized wallpaper layer sits inside a winW x winH window (CSS px == DIPs; Helm never zooms).
// placement = { content: {x, y, width, height}, display: {x, y, width, height, scaleFactor} } in screen DIPs.
// tx / ty: integer offset of the layer's top-left from the window's top-left (display origin - content origin),
// clamped into [winW - monW, 0] x [winH - monH, 0] so a window partly (or wholly, like the --test window at
// -20000,-20000) off its monitor still has picture under every pixel. Not ok -> the caller keeps the plain
// cover-to-window layer: no placement (phone, mock), a malformed one, or a window bigger than its monitor.
export function lineUp(placement, winW, winH) {
  const no = (reason) => ({ ok: false, reason, monW: 0, monH: 0, scale: 1, tx: 0, ty: 0, clamped: false });
  if (!placement || typeof placement !== 'object') return no('no-placement');
  const c = placement.content, d = placement.display;
  if (!isRect(c) || !isRect(d)) return no('bad-placement');
  const w = winW > 0 ? winW : c.width, h = winH > 0 ? winH : c.height;
  const monW = d.width, monH = d.height;
  if (w > monW || h > monH) return no('bigger-than-monitor');
  const rawX = Math.round(d.x - c.x), rawY = Math.round(d.y - c.y);
  const tx = z(Math.min(0, Math.max(Math.ceil(w - monW), rawX)));
  const ty = z(Math.min(0, Math.max(Math.ceil(h - monH), rawY)));
  const scale = num(d.scaleFactor) && d.scaleFactor > 0 ? d.scaleFactor : 1;
  return { ok: true, reason: null, monW, monH, scale, tx, ty, clamped: tx !== rawX || ty !== rawY };
}

// The once-per-key cache key for the blurred still: same picture, blur, monitor size, pixel ratio and saturation
// (light ground: saturate 150%, CONTRACT "Light look"; 100 = none, the key as before) -> same render.
export function blurKey(url, blurPx, monW, monH, dpr, sat = 100) {
  const r = (v, p = 100) => Math.round((+v || 0) * p) / p;
  const s = Math.round(+sat) === 100 || !Number.isFinite(+sat) ? '' : `|s${Math.round(+sat)}`;
  return `${url || ''}|b${r(blurPx)}|${r(monW)}x${r(monH)}@${r(dpr, 1000)}${s}`;
}

// The canvas plan for one blur render: backing size (monitor DIPs x dpr), the Gaussian sigma in backing px
// (CSS blur(N) == sigma N CSS px == N*dpr device px), the duplicated-edge margin (~3 sigma, so the monitor edges
// do not fade to transparent) and where the cover-fit image lands inside the backing (unrounded).
export function blurPlan(imgW, imgH, monW, monH, dpr, blurPx) {
  const ratio = dpr > 0 ? dpr : 1;
  const cw = Math.max(1, Math.round(monW * ratio)), ch = Math.max(1, Math.round(monH * ratio));
  const sigma = Math.max(0, +blurPx || 0) * ratio;
  const margin = sigma > 0 ? Math.ceil(sigma * 3) : 0;
  return { cw, ch, sigma, margin, draw: coverRect(imgW, imgH, cw, ch) };
}
