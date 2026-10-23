// Owner: lane shell-qr. Dependency-free QR code encoder (ISO/IEC 18004), byte mode, versions 1-15.
// Exports: encodeQR(text, { ecc }) -> { size, modules }, qrPath(modules) -> SVG path d, QrCode (Preact component).
import { h } from 'preact';

// ---- Tables (index = version; index 0 unused) -------------------------------------------------
const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_ECL_BITS = [1, 0, 3, 2]; // L=01, M=00, Q=11, H=10
const EC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24], // H
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18], // H
];
const MAX_VERSION = 15;

// Total codewords (data + EC) a version holds.
function rawCodewords(ver) {
  let bits = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    bits -= (25 * na - 10) * na - 55;
    if (ver >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}
function dataCodewords(ver, ecl) {
  return rawCodewords(ver) - EC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---- GF(256) Reed-Solomon, primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D) ---------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}
// Generator polynomial prod (x - a^i), i = 0..degree-1; coefficients highest-first, leading 1 omitted.
function rsGenerator(degree) {
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMul(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return g;
}
// Remainder of data(x) * x^degree divided by the generator: the EC codewords.
export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return Array.from(rem);
}

// ---- Data encoding ----------------------------------------------------------------------------
function utf8(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}
function buildCodewords(bytes, ver, ecl) {
  const capacityBits = dataCodewords(ver, ecl) * 8;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}
// Split into blocks, append RS codewords, interleave.
function addEcAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_BLOCKS[ecl][ver];
  const ecLen = EC_PER_BLOCK[ecl][ver];
  const raw = rawCodewords(ver);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks); // data + ec of a short block
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - ecLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    blocks.push({ dat, ec: rsRemainder(dat, ecLen) });
  }
  const out = [];
  const maxData = shortLen - ecLen + 1;
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---- Matrix construction ----------------------------------------------------------------------
function makeGrid(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}
function drawFunctionPatterns(ver, size, mod, fn) {
  const set = (x, y, dark) => {
    mod[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0); // timing
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const al = alignmentPositions(ver);
  const n = al.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(0, 0, size, mod, fn); // reserve the area; real bits written after masking
  drawVersion(ver, size, mod, fn);
}
export function formatBits(ecl, mask) {
  const data = (FORMAT_ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function drawFormatBits(ecl, mask, size, mod, fn) {
  const bits = formatBits(ecl, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, dark) => {
    mod[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // dark module
}
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}
function drawVersion(ver, size, mod, fn) {
  if (ver < 7) return;
  const bits = versionBits(ver);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    mod[b][a] = dark;
    fn[b][a] = true;
    mod[a][b] = dark;
    fn[a][b] = true;
  }
}
function placeCodewords(codewords, size, mod, fn) {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        if (i < total) mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++; // remainder bits stay light
      }
    }
  }
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function applyMask(mask, size, mod, fn) {
  const f = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && f(x, y)) mod[y][x] = !mod[y][x];
}

// Standard penalty rules N1..N4.
export function penalty(mod) {
  const size = mod.length;
  let score = 0;
  const get = (x, y, vertical) => (vertical ? mod[x][y] : mod[y][x]);
  for (let vertical = 0; vertical < 2; vertical++) {
    for (let y = 0; y < size; y++) {
      // N1: runs of 5+ same colour
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && get(x, y, vertical) === get(x - 1, y, vertical)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 finder-like pattern with 4 light modules on either side
      let bits = 0;
      for (let x = 0; x < size; x++) {
        bits = ((bits << 1) & 0x7ff) | (get(x, y, vertical) ? 1 : 0);
        if (x >= 10 && (bits === 0x5d0 || bits === 0x05d)) score += 40;
      }
    }
  }
  // N2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
    }
  }
  // N4: dark proportion
  let dark = 0;
  for (const row of mod) for (const v of row) if (v) dark++;
  const total = size * size;
  score += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * 10;
  return score;
}

/**
 * Encode text as a QR code (byte mode, UTF-8).
 * @param {string} text
 * @param {{ ecc?: 'L'|'M'|'Q'|'H', mask?: number }} [opts] mask forces a mask 0-7 (testing); default picks lowest penalty.
 * @returns {{ size: number, modules: boolean[][], version: number, mask: number }}
 */
export function encodeQR(text, { ecc = 'M', mask: forcedMask } = {}) {
  const ecl = ECL[String(ecc).toUpperCase()];
  if (ecl === undefined) throw new Error(`QR: unknown error-correction level "${ecc}" (use L, M, Q or H)`);
  const bytes = utf8(text);
  let ver = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (needBits <= dataCodewords(v, ecl) * 8) {
      ver = v;
      break;
    }
  }
  if (!ver) {
    const max = dataCodewords(MAX_VERSION, ecl) - 3;
    throw new Error(`QR: text is ${bytes.length} bytes; the limit at ECC ${ecc} is ${max} bytes (version ${MAX_VERSION})`);
  }
  const size = ver * 4 + 17;
  const mod = makeGrid(size);
  const fn = makeGrid(size);
  drawFunctionPatterns(ver, size, mod, fn);
  placeCodewords(addEcAndInterleave(buildCodewords(bytes, ver, ecl), ver, ecl), size, mod, fn);

  let best = forcedMask;
  if (best === undefined) {
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m, size, mod, fn);
      drawFormatBits(ecl, m, size, mod, fn);
      const s = penalty(mod);
      if (s < bestScore) {
        bestScore = s;
        best = m;
      }
      applyMask(m, size, mod, fn); // XOR undo
    }
  }
  applyMask(best, size, mod, fn);
  drawFormatBits(ecl, best, size, mod, fn);
  return { size, modules: mod, version: ver, mask: best };
}

/** SVG path data in module units: one rect per horizontal run of dark modules. */
export function qrPath(modules) {
  let d = '';
  for (let y = 0; y < modules.length; y++) {
    const row = modules[y];
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      const len = end - x;
      d += `M${x} ${y}h${len}v1h-${len}z`;
      x = end;
    }
  }
  return d;
}

let lastKey = '';
let lastQr = null;
/** Preact component: always black on white (scannable in any theme), 4-module quiet zone. */
export function QrCode({ text, size = 168, ecc = 'M', class: cls }) {
  const key = `${ecc}\u0000${text}`;
  let qr = key === lastKey ? lastQr : null;
  if (!qr) {
    try {
      qr = encodeQR(text ?? '', { ecc });
      lastKey = key;
      lastQr = qr;
    } catch (err) {
      return h('span', { class: ['qr-error', cls].filter(Boolean).join(' '), role: 'alert' }, `QR code unavailable: ${err.message}`);
    }
  }
  const n = qr.size + 8;
  return h(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      class: cls,
      width: size,
      height: size,
      viewBox: `-4 -4 ${n} ${n}`,
      'shape-rendering': 'crispEdges',
      role: 'img',
      'aria-label': 'QR code',
    },
    h('rect', { x: -4, y: -4, width: n, height: n, fill: '#ffffff' }),
    h('path', { d: qrPath(qr.modules), fill: '#000000' }),
  );
}
