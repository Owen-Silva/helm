// Tiny bitmap painter for the taskbar overlay badge and the placeholder tray icon,
// so neither needs image files. Pixels are BGRA for nativeImage.createFromBitmap.
// Owner: lane host (B).

// 3x5 glyphs, rows top to bottom, 3 bits each (MSB = left column).
const GLYPHS = {
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7], 4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0], H: [5, 5, 7, 5, 5],
};

function canvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  const px = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  return { buf, px };
}

function drawText({ px }, text, size, scale, color) {
  const w = text.length * 3 * scale + (text.length - 1) * scale;
  const h = 5 * scale;
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - h) / 2);
  [...text].forEach((ch, n) => {
    const g = GLYPHS[ch];
    if (!g) return;
    for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
      if (!(g[row] & (4 >> col))) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px(x0 + n * 4 * scale + col * scale + dx, y0 + row * scale + dy, color);
    }
  });
}

// Filled circle with an anti-aliased edge.
function disc({ px }, size, color) {
  const c = (size - 1) / 2, r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c);
    const a = Math.max(0, Math.min(1, r - d + 0.5));
    if (a > 0) px(x, y, [color[0], color[1], color[2], Math.round(255 * a)]);
  }
}

function roundRect({ px }, size, radius, color) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
    const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
    const a = Math.max(0, Math.min(1, radius - Math.hypot(dx, dy) + 0.5));
    if (a > 0) px(x, y, [color[0], color[1], color[2], Math.round(255 * a)]);
  }
}

// 32x32 badge (shown at 16 dip with scaleFactor 2): a muted amber disc with the count.
function badgeBitmap(count) {
  const size = 32;
  const cv = canvas(size);
  disc(cv, size, [214, 160, 72]);
  const text = count > 9 ? '9+' : String(count);
  drawText(cv, text, size, text.length > 1 ? 3 : 4, [24, 24, 26, 255]);
  return { buffer: cv.buf, width: size, height: size };
}

// 32x32 placeholder app icon: neutral graphite rounded square with a light "H".
function appIconBitmap() {
  const size = 32;
  const cv = canvas(size);
  roundRect(cv, size, 7, [46, 48, 52]);
  drawText(cv, 'H', size, 4, [230, 230, 232, 255]);
  return { buffer: cv.buf, width: size, height: size };
}

module.exports = { badgeBitmap, appIconBitmap };
