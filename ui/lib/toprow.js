// Top-row hints for Mantle (look-sync CONTRACT "Top-row hints", protocol v1): what Helm's window shows in its TOP
// PIXEL ROW, so Mantle's top bar can take that colour on the same frame instead of waiting for its screen capture.
// Pure maths, no DOM and no imports (test/host/toprow.test.js loads it with require(esm)); ui/shell/toprow.js feeds
// it from the live page and sends the result. Owner: lane helm-toprow-hints.
//
// What row 0 is made of (bottom to top; the strip, rail and tabs never reach row 0, the window controls are
// transparent at rest):
//   .bg            --bg (BG_RGB), only seen when there is no picture
//   .bg-photo      the picture: blurred (lined-up canvas, or CSS cover + filter in own mode / before the canvas lands)
//   .bg-clear      Home only: the UNBLURRED picture with a top scrim (home.css ::after, HOME_SCRIM at row 0),
//                  faded in / out by its opacity (0..1 = `home` below)
//   .bg-wash       WASH_RGB at the painted dim (--bg-dim: Mantle's shared darkening when it is used)
//   modal scrims   --scrim over the whole window while a modal / the palette / the lightbox is open
//
// TOP (protocol): { kind: 'wash', rgb, alpha } | { kind: 'flat', rgb } | { kind: 'cols', cols } | { kind: 'none' }

export const WASH_RGB = { dark: [9, 10, 11], light: [255, 255, 255] };     // shell.css --wash-rgb (light: island white)
export const BG_RGB = { dark: [20, 21, 22], light: [244, 246, 250] };      // tokens.css --bg (light: island ground #f4f6fa)
export const HOME_SCRIM = 0.5;                                             // home.css ::after top stop (--home-scrim = wash rgb)
export const SCRIM = { dark: { rgb: [6, 7, 8], a: 0.48 }, light: { rgb: [30, 31, 32], a: 0.22 } };   // tokens.css --scrim
export const MAX_COLS = 240;   // ~3.4 KB of JSON: well under the protocol's 8 KB line

const clamp01 = (v) => Math.min(1, Math.max(0, +v || 0));
const r255 = (v) => Math.min(255, Math.max(0, Math.round(v)));
const rgbOf = (c) => [r255(c[0]), r255(c[1]), r255(c[2])];

/** source-over: `top` at alpha a over an opaque `under` -> unrounded rgb */
export function over(top, a, under) {
  return [0, 1, 2].map((k) => top[k] * a + under[k] * (1 - a));
}

/**
 * fold(layers) -> { rgb, alpha }: one layer equal to `layers` (bottom -> top, each { rgb, a }) painted in order
 * over any opaque colour. alpha = 1 - prod(1 - a); rgb = each layer's surviving share / alpha.
 */
export function fold(layers) {
  let keep = 1;
  const acc = [0, 0, 0];
  for (let i = layers.length - 1; i >= 0; i--) {
    const { rgb, a } = layers[i];
    const al = clamp01(a);
    for (let k = 0; k < 3; k++) acc[k] += rgb[k] * al * keep;
    keep *= 1 - al;
  }
  const alpha = 1 - keep;
  return { rgb: alpha > 0 ? acc.map((v) => v / alpha) : [0, 0, 0], alpha };
}

/** paint `layers` (bottom -> top) over an opaque colour -> unrounded rgb */
export function paint(layers, under) {
  const f = fold(layers);
  return over(f.rgb, f.alpha, under);
}

/**
 * spans(row, width, n) -> n mean colours: row = RGBA bytes of one device-pixel row `width` px wide, split into n
 * equal spans left to right (the protocol's cols span the window's full width).
 */
export function spans(row, width, n) {
  const out = [];
  const cnt = Math.max(1, Math.min(n, width));
  for (let i = 0; i < cnt; i++) {
    const x0 = Math.floor((i * width) / cnt), x1 = Math.max(x0 + 1, Math.floor(((i + 1) * width) / cnt));
    const s = [0, 0, 0];
    for (let x = x0; x < x1; x++) { const d = x * 4; s[0] += row[d]; s[1] += row[d + 1]; s[2] += row[d + 2]; }
    const m = x1 - x0;
    out.push([s[0] / m, s[1] / m, s[2] / m]);
  }
  return out;
}

/** how many cols for a window `cssW` CSS px wide: one per 8 px, at most MAX_COLS */
export const colCount = (cssW) => Math.max(1, Math.min(MAX_COLS, Math.ceil((+cssW || 0) / 8)));

/** resample n colours to m (nearest span centre), used when the blurred and clear rows differ in count */
function resample(cols, m) {
  if (cols.length === m) return cols;
  return Array.from({ length: m }, (_, i) => cols[Math.min(cols.length - 1, Math.floor(((i + 0.5) * cols.length) / m))]);
}

/**
 * topFor(s) -> TOP
 *   s.theme      'dark' | 'light'
 *   s.photo      a picture is painted (false: the "None" background -> --bg)
 *   s.dim        the wash alpha actually painted (--bg-dim)
 *   s.home       0..1: opacity of Home's unblurred copy (.bg-clear); 0 away from Home
 *   s.scrims     [{ rgb, a }] full-window scrims open above the wash (modals, palette, lightbox)
 *   s.washOk     the blurred layer at row 0 IS the look-sync desktop still, lined up with the screen and blurred
 *                with the shared glass blur (so Mantle can draw it itself)
 *   s.blurred    cols (unrounded rgb) of the blurred picture at row 0, or null when unknown
 *   s.clear      cols of Home's unblurred picture at row 0, or null when unknown
 * Anything that cannot be said exactly -> { kind: 'none' } (Mantle keeps using its capture).
 */
export function topFor(s) {
  const theme = s.theme === 'light' ? 'light' : 'dark';
  const wash = WASH_RGB[theme];
  const above = [{ rgb: wash, a: clamp01(s.dim) }, ...(s.scrims || []).map((x) => ({ rgb: x.rgb, a: clamp01(x.a) }))];
  if (!s.photo) return { kind: 'flat', rgb: rgbOf(paint(above, BG_RGB[theme])) };
  const home = clamp01(s.home);
  if (home === 0 && s.washOk) {
    const f = fold(above);
    return { kind: 'wash', rgb: rgbOf(f.rgb), alpha: Math.round(f.alpha * 1000) / 1000 };
  }
  // per column: Home's copy (with its scrim) over the blurred layer at `home`, then the wash and scrims
  const needBlur = home < 1, needClear = home > 0;
  if ((needBlur && !(s.blurred && s.blurred.length)) || (needClear && !(s.clear && s.clear.length))) return { kind: 'none' };
  const n = needClear ? s.clear.length : s.blurred.length;
  const B = needBlur ? resample(s.blurred, n) : null, C = needClear ? resample(s.clear, n) : null;
  const cols = [];
  for (let i = 0; i < n; i++) {
    const clearCol = C ? over(wash, HOME_SCRIM, C[i]) : null;
    const under = !C ? B[i] : !B ? clearCol : over(clearCol, home, B[i]);
    cols.push(rgbOf(paint(above, under)));
  }
  return { kind: 'cols', cols };
}

/** the same TOP twice? (sends are skipped when nothing changed) */
export const sameTop = (a, b) => JSON.stringify(a) === JSON.stringify(b);
