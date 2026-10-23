// capture.js with a fake desktopCapturer / screen / window and fake nativeImage objects:
// encoding limits, crop clamping, token expiry, hide-and-restore of Helm's window, source ordering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fitWithin, encodeWithin, clampRect, createCapture, MAX_BYTES } = require('../../main/capture');

// A fake nativeImage whose encoded size is bytesPerPx * pixels (PNG) or scaled by quality (JPEG).
function fakeImage(width, height, { pngBpp = 0.5, jpegBpp = (q) => q / 100 } = {}) {
  const img = {
    w: width, h: height, resized: [], crops: [],
    getSize: () => ({ width, height }),
    isEmpty: () => width === 0 || height === 0,
    resize({ width: w, height: h }) { img.resized.push({ w, h }); return fakeImage(w, h, { pngBpp, jpegBpp }); },
    crop(r) { img.crops.push(r); return fakeImage(r.width, r.height, { pngBpp, jpegBpp }); },
    toPNG: () => Buffer.alloc(Math.ceil(width * height * pngBpp)),
    toJPEG: (q) => Buffer.alloc(Math.ceil(width * height * jpegBpp(q))),
    toDataURL: () => 'data:image/png;base64,AAAA',
  };
  return img;
}

function fakeWindow({ visible = true, minimized = false, mediaId = 'window:42:0' } = {}) {
  const w = {
    calls: [], visible, minimized,
    isDestroyed: () => false,
    isVisible: () => w.visible,
    isMinimized: () => w.minimized,
    getMediaSourceId: () => mediaId,
    hide() { w.calls.push('hide'); w.visible = false; },
    show() { w.calls.push('show'); w.visible = true; },
    focus() { w.calls.push('focus'); },
  };
  return w;
}

function fakeCapturer(win, { full = { width: 3000, height: 2000 } } = {}) {
  const calls = [];
  const sources = [
    { id: 'window:7:0', name: 'Editor', display_id: '' },
    { id: 'screen:1:0', name: 'Screen 1', display_id: '101' },
    { id: 'window:42:0', name: 'Helm', display_id: '' },
    { id: 'window:9:0', name: '   ', display_id: '' },
    { id: 'screen:2:0', name: 'Screen 2', display_id: '102' },
  ];
  return {
    calls,
    getSources: async (opts) => {
      calls.push({ ...opts, winVisible: win ? win.visible : null });
      const { width, height } = opts.thumbnailSize;
      return sources.filter((s) => opts.types.includes(s.id.split(':')[0])).map((s) => ({
        ...s,
        thumbnail: width ? fakeImage(Math.min(width, full.width), Math.min(height, full.height)) : fakeImage(0, 0),
        appIcon: s.id.startsWith('window') ? fakeImage(64, 64) : null,
      }));
    },
  };
}

const screen = {
  getAllDisplays: () => [
    { id: 101, size: { width: 1920, height: 1080 }, scaleFactor: 1.5 },
    { id: 102, size: { width: 2560, height: 1440 }, scaleFactor: 1 },
  ],
  getPrimaryDisplay: () => ({ id: 101, size: { width: 1920, height: 1080 }, scaleFactor: 1.5 }),
};

const make = (win, opts) => {
  const dc = fakeCapturer(win, opts);
  const sleeps = [];
  const cap = createCapture({ desktopCapturer: dc, screen, getWindow: () => win, sleep: async (ms) => { sleeps.push(ms); }, now: () => new Date(2026, 9, 8, 21, 5) });
  return { cap, dc, sleeps };
};

test('fitWithin: longest side <= 2000, never upscales', () => {
  assert.deepEqual(fitWithin(4000, 1000, 2000), { width: 2000, height: 500, scale: 0.5 });
  assert.deepEqual(fitWithin(1000, 3000, 2000), { width: 667, height: 2000, scale: 2000 / 3000 });
  assert.deepEqual(fitWithin(800, 600, 2000), { width: 800, height: 600, scale: 1 });
});

test('encodeWithin: small PNG stays PNG at its own size (no upscale)', () => {
  const img = fakeImage(800, 600);
  const enc = encodeWithin(img);
  assert.equal(enc.mime, 'image/png');
  assert.equal(enc.ext, 'png');
  assert.equal(enc.width, 800);
  assert.equal(enc.height, 600);
  assert.equal(img.resized.length, 0);
});

test('encodeWithin: big image is downscaled to 2000 on the long side, PNG if it fits', () => {
  const img = fakeImage(3840, 2160, { pngBpp: 0.3 });
  const enc = encodeWithin(img);
  assert.equal(enc.mime, 'image/png');
  assert.equal(Math.max(enc.width, enc.height), 2000);
  assert.ok(enc.buffer.length <= MAX_BYTES);
});

test('encodeWithin: oversize PNG falls back to JPEG', () => {
  const enc = encodeWithin(fakeImage(2000, 1000, { pngBpp: 3, jpegBpp: (q) => q / 200 }));
  assert.equal(enc.mime, 'image/jpeg');
  assert.equal(enc.ext, 'jpg');
  assert.equal(enc.width, 2000);
  assert.ok(enc.buffer.length <= MAX_BYTES);
});

test('encodeWithin: JPEG still too big shrinks the dimensions until it fits', () => {
  const enc = encodeWithin(fakeImage(4000, 3000, { pngBpp: 4, jpegBpp: () => 2 }));
  assert.equal(enc.mime, 'image/jpeg');
  assert.ok(Math.max(enc.width, enc.height) < 2000);
  assert.ok(enc.buffer.length <= MAX_BYTES, `size ${enc.buffer.length}`);
});

test('clampRect clamps to the image bounds', () => {
  assert.deepEqual(clampRect({ x: -50, y: -10, width: 300, height: 200 }, 1000, 800), { x: 0, y: 0, width: 300, height: 200 });
  assert.deepEqual(clampRect({ x: 900, y: 700, width: 500, height: 500 }, 1000, 800), { x: 900, y: 700, width: 100, height: 100 });
  assert.deepEqual(clampRect({ x: 5000, y: 5000, width: 10, height: 10 }, 1000, 800), { x: 999, y: 799, width: 1, height: 1 });
  assert.throws(() => clampRect({ x: 'a', y: 0, width: 1, height: 1 }, 10, 10), /numeric/);
});

test('captureSources: screens first, self flag, empty-name windows dropped, JPEG thumbs', async () => {
  const win = fakeWindow();
  const { cap, dc } = make(win);
  const list = await cap.captureSources();
  assert.deepEqual(list.map((s) => s.id), ['screen:1:0', 'screen:2:0', 'window:7:0', 'window:42:0']);
  assert.deepEqual(list.map((s) => s.kind), ['screen', 'screen', 'window', 'window']);
  assert.deepEqual(list.filter((s) => s.self).map((s) => s.id), ['window:42:0']);
  assert.ok(list[0].thumb.startsWith('data:image/jpeg;base64,'));
  assert.equal(list[0].displayId, '101');
  assert.equal(list[0].icon, null);
  assert.ok(list[2].icon.startsWith('data:image/png'));
  assert.deepEqual(dc.calls[0].thumbnailSize, { width: 320, height: 320 });
});

test('capture(screen): hides a visible Helm, captures at native size, restores', async () => {
  const win = fakeWindow();
  const { cap, dc, sleeps } = make(win, { full: { width: 4000, height: 4000 } });
  const r = await cap.capture('screen:1:0', { hideSelf: true });
  assert.deepEqual(win.calls, ['hide', 'show', 'focus']);
  assert.deepEqual(sleeps, [300]);
  const full = dc.calls.find((c) => c.thumbnailSize.width > 0);
  assert.deepEqual(full.types, ['screen']);
  assert.deepEqual(full.thumbnailSize, { width: 2880, height: 1620 });   // 1920x1080 @1.5
  assert.equal(full.winVisible, false, 'Helm hidden while the full image is grabbed');
  assert.equal(r.width, 2880);
  assert.ok(r.token && typeof r.token === 'string');
  assert.equal(r.attachment.kind, 'image');
  assert.ok(Math.max(r.attachment.width, r.attachment.height) <= 2000);
  assert.ok(r.attachment.size <= MAX_BYTES);
  assert.match(r.attachment.dataUrl, /^data:image\/(png|jpeg);base64,/);
  assert.equal(r.attachment.name, 'Screenshot Screen 1 2026-10-08 21.05.png');
});

test('capture(window): only window sources fetched, box = largest display', async () => {
  const win = fakeWindow();
  const { cap, dc } = make(win);
  await cap.capture('window:7:0', { hideSelf: false });
  assert.deepEqual(win.calls, []);
  assert.deepEqual(dc.calls.map((c) => c.types), [['window']]);
  assert.deepEqual(dc.calls[0].thumbnailSize, { width: 2880, height: 1620 });   // 4.67M px beats 2560x1440
});

test('capture never hides for the self source, a hidden window or a minimised one', async () => {
  const w1 = fakeWindow();
  await make(w1).cap.capture('window:42:0', { hideSelf: true });
  assert.deepEqual(w1.calls, []);
  const w2 = fakeWindow({ visible: false });
  await make(w2).cap.capture('screen:1:0', { hideSelf: true });
  assert.deepEqual(w2.calls, [], 'a hidden window is never shown');
  const w3 = fakeWindow({ minimized: true });
  await make(w3).cap.capture('screen:1:0', { hideSelf: true });
  assert.deepEqual(w3.calls, []);
});

test('capture restores the window even when the capture throws', async () => {
  const win = fakeWindow();
  let n = 0;
  const dc = { getSources: async (o) => { if (++n === 2) throw new Error('boom'); return [{ id: 'screen:1:0', display_id: '101', name: 'S', thumbnail: fakeImage(0, 0) }]; } };
  const cap = createCapture({ desktopCapturer: dc, screen, getWindow: () => win, sleep: async () => {} });
  await assert.rejects(cap.capture('screen:1:0'), /boom/);
  assert.deepEqual(win.calls, ['hide', 'show', 'focus']);
});

test('capture of a vanished source errors clearly', async () => {
  const { cap } = make(fakeWindow({ visible: false }));
  await assert.rejects(cap.capture('window:999:0'), /no longer available/);
});

test('captureCrop: clamps, crops the cached full-res image, unknown token errors', async () => {
  const { cap } = make(fakeWindow({ visible: false }));
  const r = await cap.capture('screen:2:0');
  assert.equal(r.width, 2560);
  const c = await cap.captureCrop(r.token, { x: 2400, y: 1300, width: 900, height: 900 });
  assert.deepEqual(c.rect, { x: 2400, y: 1300, width: 160, height: 140 });
  assert.equal(c.attachment.width, 160);
  assert.equal(c.attachment.mime, 'image/png');
  await assert.rejects(cap.captureCrop('nope', { x: 0, y: 0, width: 1, height: 1 }), /expired/);
  const r2 = await cap.capture('screen:1:0');
  await assert.rejects(cap.captureCrop(r.token, { x: 0, y: 0, width: 1, height: 1 }), /expired/, 'only the latest capture is kept');
  await cap.captureCrop(r2.token, { x: 0, y: 0, width: 10, height: 10 });
  cap._drop();
});
