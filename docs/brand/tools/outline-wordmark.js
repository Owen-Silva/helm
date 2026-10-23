// Outline "Helm" to SVG path data for the wordmark (pasted into HELM_TEXT in ui/assets/build-icons.js).
//
// Font: Manrope SemiBold (600), SIL Open Font License 1.1, https://fonts.google.com/specimen/Manrope
// (static TTF from the Google Fonts CSS API). Outlining an OFL font into a logo is allowed.
//
// opentype.js is NOT a Helm dependency; run this from a scratch folder:
//   mkdir %TEMP%\outline && cd %TEMP%\outline && npm i opentype.js@1.3.4
//   copy <this file> . && node outline-wordmark.js <path-to>\Manrope-SemiBold.ttf
// Prints the metrics (cap height, advance, bbox) and writes helm-text.d next to the script.
const opentype = require('opentype.js');
const font = opentype.loadSync(process.argv[2]);
const size = 100, text = 'Helm';
const glyphs = font.stringToGlyphs(text);
let x = 0; const parts = [];
const s = size / font.unitsPerEm;
glyphs.forEach((g, i) => {
  parts.push(g.getPath(x, 0, size).toPathData(2));
  x += g.advanceWidth * s;
  if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * s;
});
const bb = font.getPath(text, 0, 0, size).getBoundingBox();
console.log(JSON.stringify({
  capH: font.tables.os2.sCapHeight * s, xH: font.tables.os2.sxHeight * s, advance: +x.toFixed(2),
  bb: { x1: +bb.x1.toFixed(2), y1: +bb.y1.toFixed(2), x2: +bb.x2.toFixed(2), y2: +bb.y2.toFixed(2) },
}));
require('fs').writeFileSync(require('path').join(__dirname, 'helm-text.d'), parts.join(''));
