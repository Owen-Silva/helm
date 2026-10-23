// VENDORED from the look-sync project (accent.js at commit 4f82c4b). Do not edit here:
// change it in look-sync, run its tests, and re-copy. Spec: ~/look-sync/CONTRACT.md.
'use strict';
/*
 * accent.js - the shared hue -> accent token mapping (Look Sync contract, section 3).
 * Zero dependencies, CommonJS. Vendored by Helm, Quartz and Mantle.
 *
 * The formula is Quartz's (settings.js:315-324): a custom hue keeps the
 * saturation and lightness of Helm's steel blue. The S/L used here are the
 * EXACT values of the authored hexes (tokens.css: dark #9fb4cc, light
 * #4d6784), not Quartz's rounded 31%/71% and 26%/41%: rounded values give
 * #9eb4cc at hue 212, one step off the steel blue all three apps ship.
 *
 *   tokens(hue, theme) -> { acc, strong, on, soft, line, select, glow, rgb }
 *   tokens(null, theme) -> null   (hue null = keep the app's own tokens)
 */

// Exact HSL of each authored hex, H dropped (the hue is the user's).
// acc    dark #9fb4cc  light #4d6784   (--accent)
// strong dark #b7c8db  light #3c536d   (--accent-strong)
// on     dark #11161c  light #ffffff   (--accent-text, text on an accent fill)
function slOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [s, l];
}
const SL = {
  dark: { acc: slOf('#9fb4cc'), strong: slOf('#b7c8db'), on: slOf('#11161c') },
  light: { acc: slOf('#4d6784'), strong: slOf('#3c536d'), on: null } // on = white
};
// Alphas of the derived tokens, per theme (Helm tokens.css + Quartz ION_TOKENS).
const ALPHA = {
  dark: { soft: 0.14, line: 0.42, select: 0.32, glow: 0.22 },
  light: { soft: 0.11, line: 0.40, select: 0.20, glow: 0.22 }
};
const DEFAULT_HUE = 212; // the steel blue

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
const rgba = (rgb, a) => 'rgba(' + rgb.join(', ') + ', ' + a + ')';

function validHue(hue) {
  return Number.isInteger(hue) && hue >= 0 && hue <= 360;
}

function tokens(hue, theme) {
  if (hue === null || hue === undefined) return null;
  if (!validHue(hue)) throw new RangeError('accent hue must be an integer 0..360, got ' + hue);
  const t = theme === 'light' ? 'light' : 'dark';
  const sl = SL[t], al = ALPHA[t];
  const acc = hslToRgb(hue, sl.acc[0], sl.acc[1]);
  const strong = hslToRgb(hue, sl.strong[0], sl.strong[1]);
  const on = sl.on ? hslToRgb(hue, sl.on[0], sl.on[1]) : [255, 255, 255];
  return {
    acc: hex(acc),
    strong: hex(strong),
    on: hex(on),
    soft: rgba(acc, al.soft),
    line: rgba(acc, al.line),
    select: rgba(acc, al.select),
    glow: rgba(acc, al.glow),
    rgb: acc
  };
}

module.exports = { tokens, validHue, hslToRgb, DEFAULT_HUE, ALPHA };
