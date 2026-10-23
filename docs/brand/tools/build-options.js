require('../../../tools/lowcpu-optional'); // FIRST: caps CPU + one headless browser machine-wide
// Builds the logo exploration: docs/brand/options/*.svg, docs/brand/renders/*.png and the
// standalone review page docs/brand/logo-options.html (every image embedded as a data URI).
// Usage: node docs/brand/tools/build-options.js   (run after ui/assets/build-icons.js)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const B = require('../../../ui/assets/build-icons.js');

const ROOT = path.resolve(__dirname, '..');
const OPT = path.join(ROOT, 'options');
const REN = path.join(ROOT, 'renders');
const ASSETS = path.resolve(__dirname, '../../../ui/assets');
const ACC = '#9fb4cc';
const n = (v) => +v.toFixed(2);

// ---- the rejected directions, on the same 256 grid as the pick ----
function kingSpoke() {
  const c = 128, rim = 50, hub = 15; const handles = []; let king = '';
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 4, out = i === 0 ? 90 : 84;
    const d = `M${n(c + 60 * Math.cos(a))} ${n(c + 60 * Math.sin(a))}L${n(c + out * Math.cos(a))} ${n(c + out * Math.sin(a))}`;
    if (i === 0) king = d; else handles.push(d);
  }
  const spokes = [0, 1, 2, 3].map((i) => { const a = (i * Math.PI) / 2; return `M${n(c + hub * Math.cos(a))} ${n(c + hub * Math.sin(a))}L${n(c + rim * Math.cos(a))} ${n(c + rim * Math.sin(a))}`; }).join('');
  return `<g fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="${c}" cy="${c}" r="${rim}" stroke-width="15"/><path d="${spokes}" stroke-width="11"/><path d="${handles.join('')}" stroke-width="15"/><path d="${king}" stroke-width="15" stroke="${ACC}"/></g><circle cx="${c}" cy="${c}" r="${hub}" fill="currentColor"/>`;
}
function hWheel() {
  const c = 128, rim = 66, stem = 30, y = n(Math.sqrt(rim * rim - stem * stem));
  return `<g fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"><circle cx="${c}" cy="${c}" r="${rim}"/><path d="M${c - stem} ${n(c - y)}V${n(c + y)}M${c + stem} ${n(c - y)}V${n(c + y)}M36 ${c}H220"/></g>`;
}
function quadrant() {
  const c = 128, r = 61;
  return `<g fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"><circle cx="${c}" cy="${c}" r="${r}"/><path d="M${c} ${c - r}V${c + r}M${c - r} ${c}H${c + r}"/></g><path fill="currentColor" d="M${c} ${c}V${c - r}A${r} ${r} 0 0 1 ${c + r} ${c}Z"/>`;
}
function tiller() {
  return `<g fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><path d="M128 58V196"/><path d="M128 120H168a10 10 0 0 1 10 10V176a20 20 0 0 1-20 20H128"/><path d="M128 58L80 86"/></g>`;
}
const pickMark = `<path fill="currentColor" d="${B.fullMark(128, 128)}"/>`;

const OPTIONS = [
  { id: 'a-split-round-h', name: 'A. Split round H', pick: true, mark: pickMark,
    idea: 'A solid disc cut by two notches reads as a bold H; a rim cut by the same notches wraps it, so the H is also a helm seen face-on (hub and spokes inside the wheel).',
    verdict: '' },
  { id: 'b-king-spoke', name: 'B. King spoke', mark: kingSpoke(),
    idea: 'A redrawn ship\'s wheel with the king spoke (the marked spoke that tells the helmsman the rudder is centred) in Helm\'s steel accent.',
    verdict: 'Instantly a ship\'s wheel, but that is the problem: it is the old clip-art idea drawn better. Below 48 px the eight handles turn into a sun or a virus, and the accent spoke vanishes at taskbar size.' },
  { id: 'c-h-wheel', name: 'C. H in the wheel', mark: hWheel(),
    idea: 'An H set inside a rim, its crossbar running out through the rim as the two side handles.',
    verdict: 'Reads as a globe (or the astronomical Earth symbol) first and an H second, at every size.' },
  { id: 'd-heading-quadrant', name: 'D. Heading quadrant', mark: quadrant(),
    idea: 'Compass card abstraction: a ring with its cross-hair spokes and one filled quadrant for the heading.',
    verdict: 'The most legible at 16 px, but it reads as a pie chart or a clock at quarter past, and says nothing about Helm.' },
  { id: 'e-tiller', name: 'E. Tiller line', mark: tiller(),
    idea: 'A minimal line mark: rudder stock, blade and tiller arm drawn as one stroke family.',
    verdict: 'Ownable, but at small sizes it reads as a lowercase b or a music flat, and a line mark looks thin and unfinished on the tile.' },
];

const tile = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" style="color:${B.INK}">
  <defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${B.TILE.top}"/><stop offset="1" stop-color="${B.TILE.bottom}"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="${B.TILE.radius}" fill="url(#tile)"/>
  <rect x="8.5" y="8.5" width="239" height="239" rx="${B.TILE.radius - 0.5}" fill="none" stroke="${B.TILE.hairline}"/>
  ${inner}
</svg>
`;
const bare = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 40 176 176" width="176" height="176" fill="none">\n  ${inner}\n</svg>\n`;

const SIZES = [256, 48, 32, 24, 16];

(async () => {
  for (const d of [OPT, REN]) fs.mkdirSync(d, { recursive: true });
  const browser = await chromium.launch();
  const png = {}; // png[id][size] = Buffer
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 });
    const shot = async (svg, size) => {
      await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body>`);
      return page.locator('svg').screenshot({ omitBackground: true });
    };
    for (const o of OPTIONS) {
      const icon = o.pick ? fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8') : tile(o.mark);
      fs.writeFileSync(path.join(OPT, `${o.id}-mark.svg`), o.pick ? fs.readFileSync(path.join(ASSETS, 'mark.svg'), 'utf8') : bare(o.mark));
      fs.writeFileSync(path.join(OPT, `${o.id}-icon.svg`), icon);
      png[o.id] = {};
      for (const s of SIZES) {
        // The pick is shown exactly as shipped: its hinted small masters at 32 and below.
        const src = o.pick && B.SMALL[s] ? B.smallSvg(s) : icon;
        png[o.id][s] = await shot(src, s);
        fs.writeFileSync(path.join(REN, `${o.id}-${s}.png`), png[o.id][s]);
      }
    }
    // The page itself, then a capture of it for the record.
    fs.writeFileSync(path.join(ROOT, 'logo-options.html'), page_(png));
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await p2.goto('file:///' + path.join(ROOT, 'logo-options.html').replace(/\\/g, '/'));
    await p2.screenshot({ path: path.join(REN, 'logo-options-page.png'), fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(`options: ${OPTIONS.length}, renders: ${OPTIONS.length * SIZES.length} -> ${REN}`);
})().catch((e) => { console.error(e); process.exit(1); });

// ---------------- page ----------------
function page_(png) {
  const uri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  const svgUri = (file) => `data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`;
  const img = (id, s, cls = '') => `<img class="${cls}" src="${uri(png[id][s])}" width="${s}" height="${s}" alt="">`;
  const dummy = (bg) => `<span class="dummy" style="background:${bg}"></span>`;
  const contexts = (id) => `
      <div class="ctx">
        <figure><div class="taskbar dark">${dummy('#5a5f66')}${dummy('#3e6f9e')}<span class="tb-app">${img(id, 24)}<i></i></span>${dummy('#6b5b4e')}${dummy('#4d6b57')}</div><figcaption>Taskbar, dark (24 px)</figcaption></figure>
        <figure><div class="taskbar light">${dummy('#9aa0a8')}${dummy('#5d8fc0')}<span class="tb-app">${img(id, 24)}<i></i></span>${dummy('#a08b78')}${dummy('#7d9b86')}</div><figcaption>Taskbar, light (24 px)</figcaption></figure>
        <figure><div class="alttab"><div class="card"><div class="title">${img(id, 16)}<span>Helm</span></div><div class="thumb"></div></div><div class="card dim"><div class="title"><span class="dot"></span><span>Terminal</span></div><div class="thumb"></div></div></div><figcaption>Alt+Tab title (16 px)</figcaption></figure>
        <figure><div class="tray dark"><span class="g"></span><span class="g"></span>${img(id, 16)}<span class="clock">12:41 AM</span></div><div class="tray light"><span class="g"></span><span class="g"></span>${img(id, 16)}<span class="clock">12:41 AM</span></div><figcaption>Tray, dark and light (16 px)</figcaption></figure>
      </div>`;
  const sizes = (id) => `
      <div class="sizes">
        ${['dark', 'light'].map((m) => `<div class="pane ${m}">${SIZES.map((s) => `<div class="sz">${img(id, s)}<span>${s}</span></div>`).join('')}</div>`).join('')}
      </div>
      <div class="zoom">${[32, 24, 16].map((s) => `<div class="sz">${img(id, s, 'px')}<span>${s} px, 6x</span></div>`).join('')}</div>`;
  const sections = OPTIONS.map((o) => `
    <section class="opt${o.pick ? ' pick' : ''}" id="${o.id}">
      <header><h2>${o.name}</h2>${o.pick ? '<span class="badge">Pick</span>' : ''}</header>
      <p class="idea">${o.idea}</p>
      ${o.pick ? `<p class="why">${RATIONALE}</p>` : `<p class="verdict"><b>Why not:</b> ${o.verdict}</p>`}
      ${sizes(o.id)}
      ${contexts(o.id)}
      <p class="files">Files: <code>options/${o.id}-icon.svg</code>, <code>options/${o.id}-mark.svg</code>, <code>renders/${o.id}-{256,48,32,24,16}.png</code></p>
      ${o.pick ? `
      <div class="lockup">
        <div class="pane dark"><img src="${svgUri(path.join(ASSETS, 'wordmark.svg'))}" class="wm inv" alt="Helm wordmark"><span class="rail"><img src="${svgUri(path.join(ASSETS, 'mark.svg'))}" class="inv" width="20" height="20" alt=""><img src="${svgUri(path.join(ASSETS, 'mark.svg'))}" class="inv" width="28" height="28" alt=""></span></div>
        <div class="pane light"><img src="${svgUri(path.join(ASSETS, 'wordmark.svg'))}" class="wm" alt="Helm wordmark"><span class="rail"><img src="${svgUri(path.join(ASSETS, 'mark.svg'))}" width="20" height="20" alt=""><img src="${svgUri(path.join(ASSETS, 'mark.svg'))}" width="28" height="28" alt=""></span></div>
      </div>
      <p class="files">Wordmark: Manrope SemiBold (SIL OFL 1.1) outlined to paths, mark at 1.25x cap height. Bare mark at 20 and 28 px as the rail and welcome screen would use it. Shipped files: <code>ui/assets/icon.svg</code>, <code>icon-small.svg</code>, <code>icon.png</code>, <code>icon.ico</code>, <code>mark.svg</code>, <code>wordmark.svg</code>.</p>
      <p class="files">Variants of A that lost: the solid round H alone (kept for 16 and 24 px only; without the rim it reads as an emblem, not a helm), rotated 14 to 18 degrees "mid-turn" (dynamic but sporty, and an angled notch cannot be pixel-hinted), four diagonal handles (reads as a bug), an unbroken outer ring (reads as a helipad).</p>` : ''}
    </section>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helm Logo Options</title>
<meta name="description" content="Five directions for Helm's own mark, each at 256/48/32/24/16 px on dark and light, in taskbar, Alt+Tab and tray contexts, with the pick and its rationale.">
<style>
:root { --bg:#ecebe8; --panel:#f6f6f4; --text:#1b1c1e; --muted:#5d5f63; --line:rgba(0,0,0,.10); --accent:#4d6784; --accent-soft:rgba(77,103,132,.10); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#151617; --panel:#1d1e20; --text:#e8e7e4; --muted:#9a9b9e; --line:rgba(255,255,255,.10); --accent:#9fb4cc; --accent-soft:rgba(159,180,204,.12); } }
:root[data-theme="dark"] { --bg:#151617; --panel:#1d1e20; --text:#e8e7e4; --muted:#9a9b9e; --line:rgba(255,255,255,.10); --accent:#9fb4cc; --accent-soft:rgba(159,180,204,.12); }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; }
main { max-width:1120px; margin:0 auto; padding:40px 16px 80px; }
h1 { font:600 28px/1.2 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; margin:0 0 6px; letter-spacing:-.01em; }
.lede { color:var(--muted); margin:0 0 8px; max-width:760px; }
.note { color:var(--muted); font-size:13px; margin:0 0 32px; max-width:760px; }
section.opt { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:24px; margin:0 0 28px; }
section.pick { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent-soft); }
header { display:flex; align-items:center; gap:12px; }
h2 { font:600 19px/1.3 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; margin:0; }
.badge { font-size:12px; font-weight:600; color:var(--accent); border:1px solid var(--accent); border-radius:999px; padding:1px 10px; }
.idea { margin:8px 0 4px; max-width:820px; }
.why, .verdict { margin:6px 0 18px; max-width:820px; color:var(--muted); }
.why { color:var(--text); }
.sizes { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.pane { border-radius:10px; padding:16px; display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; }
.pane.dark { background:#202020; color:#cfcfcf; } .pane.light { background:#f3f3f3; color:#444; border:1px solid rgba(0,0,0,.06); }
.sz { display:flex; flex-direction:column; align-items:center; gap:4px; font-size:11px; }
.sizes .sz img[width="256"] { width:128px; height:128px; } /* 256 render shown at half size; open renders/ for 1:1 */
.zoom { display:flex; gap:20px; align-items:flex-end; margin:12px 0 0; padding:16px; border-radius:10px; background:#2a2a2a; color:#cfcfcf; flex-wrap:wrap; }
.px { image-rendering:pixelated; }
.zoom img[width="32"] { width:192px; height:192px; } .zoom img[width="24"] { width:144px; height:144px; } .zoom img[width="16"] { width:96px; height:96px; }
.ctx { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; margin:12px 0 0; }
figure { margin:0; } figcaption { font-size:12px; color:var(--muted); margin-top:6px; }
.taskbar { height:48px; border-radius:8px; display:flex; align-items:center; justify-content:center; gap:14px; }
.taskbar.dark { background:#1c1c1c; } .taskbar.light { background:#eeeeee; border:1px solid rgba(0,0,0,.06); }
.dummy { width:24px; height:24px; border-radius:6px; display:inline-block; opacity:.85; }
.tb-app { position:relative; width:40px; height:40px; border-radius:6px; display:flex; align-items:center; justify-content:center; }
.taskbar.dark .tb-app { background:rgba(255,255,255,.06); } .taskbar.light .tb-app { background:rgba(0,0,0,.05); }
.tb-app i { position:absolute; bottom:2px; width:16px; height:3px; border-radius:2px; background:#9aa6b4; }
.alttab { background:#2b2b2b; border-radius:10px; padding:10px; display:flex; gap:8px; height:96px; }
.card { flex:1; border-radius:6px; padding:6px; background:#3a3a3a; outline:2px solid #e8e8e8; outline-offset:-2px; display:flex; flex-direction:column; gap:6px; min-width:0; }
.card.dim { outline:none; background:#323232; }
.title { display:flex; align-items:center; gap:6px; color:#eee; font-size:12px; white-space:nowrap; overflow:hidden; }
.thumb { flex:1; border-radius:3px; background:linear-gradient(#4a4b4d,#3d3e40); }
.dot { width:16px; height:16px; border-radius:4px; background:#555; display:inline-block; flex:none; }
.tray { height:40px; border-radius:8px; display:flex; align-items:center; justify-content:flex-end; gap:12px; padding:0 12px; margin-bottom:6px; }
.tray.dark { background:#1c1c1c; color:#e6e6e6; } .tray.light { background:#eeeeee; color:#222; border:1px solid rgba(0,0,0,.06); }
.tray .g { width:14px; height:14px; border-radius:50%; border:1.5px solid currentColor; opacity:.7; }
.clock { font-size:12px; }
.files { font-size:13px; color:var(--muted); margin:14px 0 0; }
code { font:12.5px ui-monospace,"Cascadia Code",Consolas,monospace; }
.lockup { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:16px; }
.lockup .pane { align-items:center; justify-content:space-between; min-height:120px; }
.wm { height:48px; width:auto; } .inv { filter:invert(.93); }
.rail { display:flex; gap:16px; align-items:center; }
@media (max-width:820px) { .sizes, .lockup { grid-template-columns:1fr; } .ctx { grid-template-columns:1fr 1fr; } }
@media (max-width:480px) { .ctx { grid-template-columns:1fr; } section.opt { padding:16px; } }
</style>
</head>
<body>
<main>
  <h1>Helm logo options</h1>
  <p class="lede">Five directions for Helm's own mark, replacing the ship's-wheel glyph. Each is drawn on the same 256 grid and the same graphite Windows 11 tile, then shown at 256, 48, 32, 24 and 16 px on a dark and a light ground and in the places Windows actually shows it.</p>
  <p class="note">Small images are the real 1x PNG renders, so on a high-DPI screen the browser enlarges them; judge pixels from the 6x zoom strip. The pick ships with pixel-hinted 16, 24 and 32 px masters; B to E are shown un-hinted (hinting would sharpen them slightly but not change the verdict).</p>
  ${sections}
</main>
</body>
</html>
`;
}

const RATIONALE = 'Why this one: it is the only direction that is both a monogram and a helm. The solid round H is ownable (nobody else\'s H is a cut disc) and the rim turns it into a wheel seen face-on without drawing a ship\'s wheel, so it reads as Helm\'s, not as nautical clip art. It holds up best at small sizes: at 16 and 24 px the rim would smear into the disc, so those masters drop it and keep the solid round H, hinted so every notch and crossbar edge lands on a whole pixel; the 32 px master keeps the rim with a whole 2 px gap. It is one flat shape in warm off-white on a graphite tile, with no material effects beyond a faint tile falloff and a 2 px lift shadow at 256, so it sits with Helm\'s grey glass and steel accent instead of competing with them, and it feels steady and deliberate, which is the "in control" you wanted the name to carry.';
