// Before / after contact sheets for tools/overlap-audit.js runs (lane helm-overlap, 2026-10-15).
// Usage: node tools/overlap-sheet.js --before=<dir> --after=<dir> --out=<dir> [--beforeJson=f] [--afterJson=f] [--rows=8]
//   <dir>/<width>/<screen>.png come from `overlap-audit.js --shots --out=<dir>`. One sheet per width (split every
//   --rows rows): screens with findings in either run, before on the left, after on the right, finding counts in
//   the label. Red boxes = the control, orange dashed = what it hit. Also <dir>/zoom/*.png when both have them.
try { require('./lowcpu-optional'); } catch { /* cloud runner */ }
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const BEFORE = path.resolve(arg('before')), AFTER = path.resolve(arg('after')), OUT = path.resolve(arg('out'));
const ROWS = Number(arg('rows', 8));
const counts = (f) => {
  const m = {};
  if (f && fs.existsSync(f)) for (const x of JSON.parse(fs.readFileSync(f, 'utf8')).findings || []) { const k = `${x.width}/${x.scenario}`; m[k] = (m[k] || 0) + 1; }
  return m;
};
const cb = counts(arg('beforeJson')), ca = counts(arg('afterJson'));
const uri = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function page(title, rows, colW) {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 24px; background: #1b1c1e; color: #e6e7e9; font: 13px/1.4 "Segoe UI", system-ui, sans-serif; width: max-content; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; } .sub { color: #9a9ca1; margin-bottom: 18px; }
    .row { margin: 0 0 22px; } .lab { margin: 0 0 6px; font-weight: 600; } .lab span { color: #9a9ca1; font-weight: 400; }
    .pair { display: flex; gap: 16px; } .cell { width: ${colW}px; } .cell img { width: 100%; display: block; border: 1px solid #3a3c40; border-radius: 6px; }
    .tag { font-size: 11px; color: #9a9ca1; margin: 0 0 3px; text-transform: uppercase; letter-spacing: .06em; }
  </style><h1>${esc(title)}</h1><div class="sub">Left: master (8a8bfeb). Right: wk/overlap. Red = the control in its hover + focus state, orange dashed = what it hits.</div>${rows}`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.HELM_SHOT_CHANNEL ? { channel: process.env.HELM_SHOT_CHANNEL } : {});
  const made = [];
  try {
    for (const w of fs.readdirSync(AFTER).filter((d) => /^\d+$/.test(d))) {
      const names = fs.readdirSync(path.join(AFTER, w)).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(BEFORE, w, f)));
      const shown = names.filter((f) => { const k = `${w}/${f.slice(0, -4)}`; return (cb[k] || 0) + (ca[k] || 0) > 0; })
        .sort((a, b) => (cb[`${w}/${b.slice(0, -4)}`] || 0) - (cb[`${w}/${a.slice(0, -4)}`] || 0));
      const colW = +w >= 821 ? 760 : 360;
      for (let i = 0; i < shown.length; i += ROWS) {
        const rows = shown.slice(i, i + ROWS).map((f) => {
          const k = `${w}/${f.slice(0, -4)}`;
          return `<div class="row"><div class="lab">${esc(f.slice(0, -4))} <span>${cb[k] || 0} findings before, ${ca[k] || 0} after</span></div><div class="pair">
            <div class="cell"><div class="tag">before</div><img src="${uri(path.join(BEFORE, w, f))}"></div>
            <div class="cell"><div class="tag">after</div><img src="${uri(path.join(AFTER, w, f))}"></div></div></div>`;
        }).join('');
        const p = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
        await p.setContent(page(`Helm overlap audit, ${w} px (${i / ROWS + 1} of ${Math.ceil(shown.length / ROWS)})`, rows, colW), { waitUntil: 'load' });
        const file = path.join(OUT, `sheet-${w}-${i / ROWS + 1}.png`);
        await p.screenshot({ path: file, fullPage: true });
        await p.close();
        made.push(file);
      }
    }
    // the action-row zoom crops, one row per state
    const zb = path.join(BEFORE, 'zoom'), za = path.join(AFTER, 'zoom');
    if (fs.existsSync(zb) && fs.existsSync(za)) {
      const rows = fs.readdirSync(za).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(zb, f))).sort().map((f) => `<div class="row"><div class="lab">${esc(f.slice(0, -4).replace(/^\d-/, ''))} <span>${f.startsWith('0') ? 'nothing hovered' : 'hovered + keyboard focus'}</span></div><div class="pair">
        <div class="cell"><div class="tag">before</div><img src="${uri(path.join(zb, f))}"></div><div class="cell"><div class="tag">after</div><img src="${uri(path.join(za, f))}"></div></div></div>`).join('');
      const p = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
      await p.setContent(page('Message action row, 3x (time, Copy, Edit & resend, Fork, Rewind)', rows, 560), { waitUntil: 'load' });
      const file = path.join(OUT, 'sheet-action-row.png');
      await p.screenshot({ path: file, fullPage: true });
      await p.close();
      made.push(file);
    }
  } finally { await browser.close(); }
  for (const f of made) console.log('sheet', f);
  console.log(`overlap-sheet: ${made.length} sheets`);
})().catch((e) => { console.error(e); process.exit(1); });
