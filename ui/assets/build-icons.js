require('../../tools/lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// Helm brand + app icon builder.
//
// Usage:  node ui/assets/build-icons.js               rebuild everything next to this file
//         node ui/assets/build-icons.js --out <dir>   write into <dir> instead (for review)
//         node ui/assets/build-icons.js --renders <dir>  also dump every size as icon-<n>.png
//
// The mark: a "split round H". A solid disc with two notches cut from top and bottom reads as a
// bold H; around it runs a rim cut by the same two notches. Disc + rim = a helm seen face-on
// (hub and spokes inside a wheel rim), and the whole thing is the monogram. At 16 and 24 px the rim
// and its hairline gap would smear, so the small masters drop the rim and keep the solid round H,
// pixel-hinted so every notch and crossbar edge lands on a whole pixel.
// Rationale + the rejected directions: docs/brand/logo-options.html.
//
// Writes (atomically: temp file then rename, since a running Helm serves these live):
//   icon.svg        app icon master: graphite Windows 11 tile + the full mark. Used for >= 48 px.
//   icon-small.svg  16 px master: full-bleed tile + hinted solid round H (viewBox 0 0 16 16).
//   icon.png        256x256 render of icon.svg, transparent corners.
//   icon.ico        PNG-in-ICO, 16/24/32/48/64/128/256. 16 from icon-small.svg; 24 and 32 from the
//                   same small design hinted to their own pixel grids (SMALL below; generated here,
//                   not written as files); 48+ from icon.svg.
//   mark.svg        bare mark, currentColor, 24-unit viewBox (rail, welcome screen, docs).
//   wordmark.svg    mark + "Helm" in Manrope SemiBold (SIL OFL 1.1), outlined to paths, currentColor.
//
// Geometry lives in the D object below (a 256 grid, centre 128). Rendering uses the Chromium that
// playwright-core already has; the ICO is assembled with plain Buffers.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const argVal = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const OUT = path.resolve(argVal('--out') || __dirname);
const RENDERS = argVal('--renders');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const INK = '#ecebe8'; // warm off-white, same family as the UI's --text
const TILE = { inset: 8, radius: 54, top: '#2c2d30', bottom: '#1b1c1e', hairline: 'rgba(255,255,255,0.10)' };

// 256 design grid. H = round H (disc radius, notch half-width, crossbar half-height).
// RIM = rim outer/inner radius; the rim is cut at x = 128 +- H.hw so its ends line up with the notch walls.
const D = { c: 128, H: { R: 52, hw: 17, ht: 13 }, RIM: { ro: 76, ri: 62 } };

// "Helm" in Manrope SemiBold at font-size 100, baseline y = 0, x from 0 (advance 245.25, cap height 72).
// Produced by docs/brand/tools/outline-wordmark.js (opentype.js, kerning applied).
const HELM_TEXT = { d: 'M17.45 0L7 0L7-72L17.45-72L17.45-40.95L53.45-40.95L53.45-72L63.95-72L63.95 0L53.45 0L53.45-31.10L17.45-31.10L17.45 0ZM101.90 1.50L101.90 1.50Q93.85 1.50 87.78-2.02Q81.70-5.55 78.33-11.88Q74.95-18.20 74.95-26.55L74.95-26.55Q74.95-35.40 78.28-41.90Q81.60-48.40 87.55-51.95Q93.50-55.50 101.40-55.50L101.40-55.50Q109.65-55.50 115.45-51.68Q121.25-47.85 124.13-40.80Q127-33.75 126.40-24.05L126.40-24.05L115.95-24.05L115.95-27.85Q115.85-37.25 112.38-41.75Q108.90-46.25 101.80-46.25L101.80-46.25Q93.95-46.25 90-41.30Q86.05-36.35 86.05-27L86.05-27Q86.05-18.10 90-13.23Q93.95-8.35 101.40-8.35L101.40-8.35Q106.30-8.35 109.88-10.58Q113.45-12.80 115.45-16.95L115.45-16.95L125.70-13.70Q122.55-6.45 116.15-2.48Q109.75 1.50 101.90 1.50ZM121.20-24.05L82.65-24.05L82.65-32.20L121.20-32.20L121.20-24.05ZM149.05 0L138.60 0L138.60-73.50L149.05-73.50L149.05 0ZM239.20 0L228.75 0L228.80-33.65Q228.80-39.50 225.80-42.78Q222.80-46.05 217.90-46.05L217.90-46.05Q214.90-46.05 212.43-44.68Q209.95-43.30 208.43-40.58Q206.90-37.85 206.90-33.75L206.90-33.75L201.85-36.30Q201.75-42 204.28-46.30Q206.80-50.60 211.15-52.98Q215.50-55.35 220.90-55.35L220.90-55.35Q229.65-55.35 234.45-50.10Q239.25-44.85 239.25-36.15L239.25-36.15L239.20 0ZM174.50 0L164 0L164-54L173.30-54L173.30-38.40L174.50-38.40L174.50 0ZM206.85 0L196.40 0L196.45-33.45Q196.45-39.35 193.48-42.70Q190.50-46.05 185.50-46.05L185.50-46.05Q180.55-46.05 177.53-42.65Q174.50-39.25 174.50-33.75L174.50-33.75L169.50-36.95Q169.50-42.25 172.05-46.40Q174.60-50.55 178.95-52.95Q183.30-55.35 188.80-55.35L188.80-55.35Q194.55-55.35 198.60-52.93Q202.65-50.50 204.78-46.15Q206.90-41.80 206.90-36.05L206.90-36.05L206.85 0Z', advance: 245.25, capH: 72, x1: 7, x2: 239.25 };

const n = (v) => +(+v).toFixed(3);

// Round H as a closed path. cx, cy centre; R disc radius; hw notch half-width; ht crossbar half-height.
function roundH(cx, cy, R, hw, ht) {
  const y = Math.sqrt(R * R - hw * hw);
  return `M${n(cx + hw)} ${n(cy - y)}A${n(R)} ${n(R)} 0 0 1 ${n(cx + hw)} ${n(cy + y)}V${n(cy + ht)}H${n(cx - hw)}V${n(cy + y)}`
    + `A${n(R)} ${n(R)} 0 0 1 ${n(cx - hw)} ${n(cy - y)}V${n(cy - ht)}H${n(cx + hw)}Z`;
}

// The two rim halves (ring between ri and ro, cut by the vertical lines x = cx +- hw).
function rim(cx, cy, ro, ri, hw) {
  const yo = Math.sqrt(ro * ro - hw * hw), yi = Math.sqrt(ri * ri - hw * hw);
  return `M${n(cx + hw)} ${n(cy - yo)}A${n(ro)} ${n(ro)} 0 0 1 ${n(cx + hw)} ${n(cy + yo)}V${n(cy + yi)}A${n(ri)} ${n(ri)} 0 0 0 ${n(cx + hw)} ${n(cy - yi)}Z`
    + `M${n(cx - hw)} ${n(cy + yo)}A${n(ro)} ${n(ro)} 0 0 1 ${n(cx - hw)} ${n(cy - yo)}V${n(cy - yi)}A${n(ri)} ${n(ri)} 0 0 0 ${n(cx - hw)} ${n(cy + yi)}Z`;
}

// Full mark at scale k around (cx, cy). k = 1 is the 256 design.
function fullMark(cx, cy, k = 1) {
  const { H, RIM } = D;
  return roundH(cx, cy, H.R * k, H.hw * k, H.ht * k) + rim(cx, cy, RIM.ro * k, RIM.ri * k, H.hw * k);
}

// Pixel-hinted small masters, designed per size (integers = whole pixels from the tile's top-left).
// 16 and 24 drop the rim (solid round H); 32 keeps the rim with a whole 2 px gap and 2 px rim.
// cy is nudged half a pixel where an odd crossbar height needs it to land on whole pixels.
const SMALL = {
  16: { inset: 0, radius: 3.5, c: 8, cy: 8, R: 6.5, hw: 1, ht: 1 },
  24: { inset: 0, radius: 5, c: 12, cy: 12.5, R: 9.5, hw: 2, ht: 1.5 },
  32: { inset: 1, radius: 6.5, c: 16, cy: 16.5, R: 6.5, hw: 2, ht: 1.5, ro: 10.5, ri: 8.5 },
};

function iconSvg() {
  const t = TILE, s = 256 - 2 * t.inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.top}"/>
      <stop offset="1" stop-color="${t.bottom}"/>
    </linearGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="${t.inset}" y="${t.inset}" width="${s}" height="${s}" rx="${t.radius}" fill="url(#tile)"/>
  <rect x="${t.inset + 0.5}" y="${t.inset + 0.5}" width="${s - 1}" height="${s - 1}" rx="${t.radius - 0.5}" fill="none" stroke="${t.hairline}" stroke-width="1"/>
  <path fill="${INK}" filter="url(#lift)" d="${fullMark(D.c, D.c)}"/>
</svg>
`;
}

function smallSvg(size) {
  const g = SMALL[size];
  const cy = g.cy, s = size - 2 * g.inset;
  const d = roundH(g.c, cy, g.R, g.hw, g.ht) + (g.ro ? rim(g.c, cy, g.ro, g.ri, g.hw) : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TILE.top}"/>
      <stop offset="1" stop-color="${TILE.bottom}"/>
    </linearGradient>
  </defs>
  <rect x="${g.inset}" y="${g.inset}" width="${s}" height="${s}" rx="${g.radius}" fill="url(#tile)"/>
  <path fill="${INK}" d="${d}"/>
</svg>
`;
}

// Bare mark on the UI's 24-unit icon grid (mark diameter 22, 1 unit margin).
function markSvg() {
  const k = 22 / (2 * D.RIM.ro);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" role="img" aria-label="Helm">
  <path d="${fullMark(12, 12, k)}"/>
</svg>
`;
}

// Mark + "Helm". Mark diameter = 1.25 x cap height, caps centred on the mark, gap = 0.42 x mark.
function wordmarkSvg() {
  const T = HELM_TEXT, md = T.capH * 1.25, k = md / (2 * D.RIM.ro), gap = md * 0.42;
  const pad = 2, w = pad + md + gap + (T.x2) + pad, h = pad + md + pad;
  const cx = pad + md / 2, cy = pad + md / 2, base = cy + T.capH / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w * 2)}" height="${n(h * 2)}" fill="currentColor" role="img" aria-label="Helm">
  <path d="${fullMark(cx, cy, k)}"/>
  <path transform="translate(${n(pad + md + gap)} ${n(base)})" d="${T.d}"/>
</svg>
`;
}

function buildIco(entries) {
  // entries: [{ size, png: Buffer }]. PNG-in-ICO (Vista+): ICONDIR + ICONDIRENTRY[] + raw PNG bytes.
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type 1 = icon
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o); // width (0 = 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette colours
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.png)]);
}

// Atomic write: temp name in the same folder, then rename over the target (retry briefly if a
// reader has the file open on Windows).
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const until = Date.now() + 100; while (Date.now() < until) { /* brief spin; no timers in a sync path */ }
    }
  }
}

async function render(page, svg, size) {
  const src = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${src}</body></html>`);
  return page.locator('svg').screenshot({ omitBackground: true });
}

async function main() {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const files = {
    'icon.svg': iconSvg(),
    'icon-small.svg': smallSvg(16),
    'mark.svg': markSvg(),
    'wordmark.svg': wordmarkSvg(),
  };
  // Render from the SVG text that is written to disk (one source of truth per size).
  const sourceFor = (size) => (size === 16 ? files['icon-small.svg'] : SMALL[size] ? smallSvg(size) : files['icon.svg']);
  const browser = await chromium.launch();
  const pngs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 });
    for (const size of SIZES) pngs.push({ size, png: await render(page, sourceFor(size), size) });
  } finally {
    await browser.close();
  }
  for (const [name, text] of Object.entries(files)) writeAtomic(path.join(OUT, name), text);
  writeAtomic(path.join(OUT, 'icon.png'), pngs.find((p) => p.size === 256).png);
  const ico = buildIco(pngs);
  writeAtomic(path.join(OUT, 'icon.ico'), ico);
  if (RENDERS) {
    fs.mkdirSync(RENDERS, { recursive: true });
    for (const p of pngs) fs.writeFileSync(path.join(RENDERS, `icon-${p.size}.png`), p.png);
  }
  console.log(`${Object.keys(files).join(', ')}, icon.png (256), icon.ico (${pngs.length} entries, ${ico.length} bytes) -> ${OUT}`);
}

module.exports = { D, SMALL, INK, TILE, roundH, rim, fullMark, iconSvg, smallSvg, markSvg, wordmarkSvg, buildIco };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
