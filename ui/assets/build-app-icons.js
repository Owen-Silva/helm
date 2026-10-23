require('../../tools/lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// Install icons for the phone (ui/manifest.webmanifest + apple-touch-icon), rendered from the
// brand master icon.svg so they never drift from it. Same pattern as build-icons.js (Chromium from
// playwright-core, atomic writes since a running Helm serves these live); it only ADDS files and
// never touches the brand's own outputs.
//
// Usage:  node ui/assets/build-app-icons.js              write next to this file
//         node ui/assets/build-app-icons.js --out <dir>  write into <dir> instead (for review)
//
// Writes:
//   app-icon-192.png, app-icon-512.png  purpose "any": icon.svg as is (rounded tile, clear corners)
//   app-icon-maskable-512.png           purpose "maskable": the tile runs full bleed (the launcher
//                                       crops it to its own shape); the mark's disc is 30% of the
//                                       width from the centre, inside the 40% maskable safe zone
//   apple-touch-icon.png                180x180, full bleed and opaque (iOS rounds the corners and
//                                       would paint transparent ones black)
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : __dirname);
const MASTER = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');

// icon.svg draws the tile as `<rect x="8" ... rx="54" fill="url(#tile)"/>` plus a hairline rect.
// Full bleed: the tile covers the whole 256 grid with square corners and the hairline goes.
function fullBleed(svg) {
  const out = svg
    .replace(/<rect x="8" y="8" width="240" height="240" rx="54" fill="url\(#tile\)"\/>/, '<rect x="0" y="0" width="256" height="256" fill="url(#tile)"/>')
    .replace(/<rect x="8\.5"[\s\S]*?\/>\s*/, '');
  if (out === svg || !out.includes('width="256" height="256" fill="url(#tile)"')) throw new Error('icon.svg changed shape: update fullBleed() in build-app-icons.js');
  return out;
}

const TARGETS = [
  { file: 'app-icon-192.png', size: 192, svg: MASTER, clear: true },
  { file: 'app-icon-512.png', size: 512, svg: MASTER, clear: true },
  { file: 'app-icon-maskable-512.png', size: 512, svg: fullBleed(MASTER), clear: false },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed(MASTER), clear: false },
];

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function render(page, svg, size, clear) {
  const src = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${clear ? 'transparent' : '#1b1c1e'}">${src}</body></html>`);
  return page.locator('svg').screenshot({ omitBackground: clear });
}

async function main() {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const t of TARGETS) {
      const png = await render(page, t.svg, t.size, t.clear);
      writeAtomic(path.join(OUT, t.file), png);
    }
  } finally {
    await browser.close();
  }
  console.log(`${TARGETS.map((t) => `${t.file} (${t.size})`).join(', ')} -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
