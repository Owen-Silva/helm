// Unit tests for ui/lib/bg-placement.js: the lined-up wallpaper's pure math (lane looksync). The module is ESM
// with no imports, so require(esm) loads it directly (like pane-layout.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { coverRect, lineUp, blurKey, blurPlan } = require('../../ui/lib/bg-placement.js');

const mon = (x, y, width, height, scaleFactor = 1) => ({ x, y, width, height, scaleFactor });
const at = (x, y, width, height, display) => ({ content: { x, y, width, height }, display });
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('coverRect: a wide image fills the height and overflows left/right evenly (CSS cover + center)', () => {
  // 3000x1000 into 1920x1080: scale = max(0.64, 1.08) = 1.08 -> 3240x1080, x = (1920-3240)/2
  const r = coverRect(3000, 1000, 1920, 1080);
  close(r.width, 3240, 'width'); close(r.height, 1080, 'height');
  close(r.x, -660, 'x'); assert.equal(r.y, 0);
});

test('coverRect: a tall image fills the width and overflows top/bottom evenly', () => {
  // 1000x2000 into 1920x1080: scale = max(1.92, 0.54) = 1.92 -> 1920x3840, y = (1080-3840)/2
  const r = coverRect(1000, 2000, 1920, 1080);
  close(r.width, 1920, 'width'); close(r.height, 3840, 'height');
  assert.equal(r.x, 0); close(r.y, -1380, 'y');
});

test('coverRect: same aspect -> exact fit; scaling the box scales the rect (backing px == DIPs x dpr)', () => {
  assert.deepEqual(coverRect(3840, 2160, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
  const a = coverRect(3000, 1000, 1920, 1080), b = coverRect(3000, 1000, 1920 * 1.5, 1080 * 1.5);
  for (const k of ['x', 'y', 'width', 'height']) close(b[k], a[k] * 1.5, k);
  // garbage never throws and never returns NaN
  for (const r of [coverRect(0, 0, 100, 50), coverRect(NaN, 10, 100, 50)]) assert.deepEqual(r, { x: 0, y: 0, width: 100, height: 50 });
});

test('lineUp: window at the monitor origin -> no offset', () => {
  const r = lineUp(at(0, 0, 1200, 800, mon(0, 0, 1920, 1080, 1.5)), 1200, 800);
  assert.deepEqual(r, { ok: true, reason: null, monW: 1920, monH: 1080, scale: 1.5, tx: 0, ty: 0, clamped: false });
});

test('lineUp: window in the middle -> the layer shifts up/left by the window position', () => {
  const r = lineUp(at(300, 140, 1200, 800, mon(0, 0, 1920, 1080)), 1200, 800);
  assert.equal(r.ok, true); assert.equal(r.tx, -300); assert.equal(r.ty, -140); assert.equal(r.clamped, false);
  // fractional DIP positions (scale 1.25) round to whole CSS px
  const f = lineUp(at(300.4, 140.6, 1200, 800, mon(0, 0, 1920, 1080, 1.25)), 1200, 800);
  assert.equal(f.tx, -300); assert.equal(f.ty, -141);
});

test('lineUp: window partly off its monitor -> clamped so the layer still covers the whole window', () => {
  // hanging off the right/bottom edges: raw -1000/-600 would leave a gap; clamp to winW-monW / winH-monH
  const r = lineUp(at(1000, 600, 1200, 800, mon(0, 0, 1920, 1080)), 1200, 800);
  assert.equal(r.tx, 1200 - 1920); assert.equal(r.ty, 800 - 1080); assert.equal(r.clamped, true);
  // hanging off the left/top edges: raw +200/+50 would leave a gap at the window's top-left; clamp to 0
  const l = lineUp(at(-200, -50, 1200, 800, mon(0, 0, 1920, 1080)), 1200, 800);
  assert.equal(l.tx, 0); assert.equal(l.ty, 0); assert.equal(l.clamped, true);
  // the --test window lives at -20000,-20000 (nearest display is the primary): still ok, clamped to 0,0
  const t = lineUp(at(-20000, -20000, 1280, 800, mon(0, 0, 2560, 1440)), 1280, 800);
  assert.equal(t.ok, true); assert.equal(t.tx, 0); assert.equal(t.ty, 0);
  // never -0 (data-tx prints and deepEqual both care)
  assert.ok(Object.is(t.tx, 0) && Object.is(t.ty, 0));
});

test('lineUp: second monitor at negative x -> offset is relative to THAT monitor', () => {
  const left = mon(-2560, 0, 2560, 1440, 1);
  const r = lineUp(at(-2560 + 400, 100, 1600, 900, left), 1600, 900);
  assert.equal(r.ok, true); assert.equal(r.monW, 2560); assert.equal(r.monH, 1440);
  assert.equal(r.tx, -400); assert.equal(r.ty, -100);
  // a monitor above the primary (negative y), scale 2
  const up = lineUp(at(100, -1080 + 30, 1000, 700, mon(0, -1080, 1920, 1080, 2)), 1000, 700);
  assert.equal(up.tx, -100); assert.equal(up.ty, -30); assert.equal(up.scale, 2);
});

test('lineUp: maximised window -> content.y sits below the title bar, so the layer moves up by it', () => {
  // work area 1920x1032 (taskbar 48); content starts 32 px down (title bar); the layer is the FULL monitor
  const r = lineUp(at(0, 32, 1920, 1000, mon(0, 0, 1920, 1080)), 1920, 1000);
  assert.equal(r.ok, true); assert.equal(r.tx, 0); assert.equal(r.ty, -32); assert.equal(r.clamped, false);
  // exactly monitor-sized content (frameless fullscreen) is still ok
  assert.equal(lineUp(at(0, 0, 1920, 1080, mon(0, 0, 1920, 1080)), 1920, 1080).ok, true);
});

test('lineUp: a window bigger than its monitor in either dimension -> not ok (CSS cover fallback)', () => {
  const wide = lineUp(at(-10, 0, 1940, 900, mon(0, 0, 1920, 1080)), 1940, 900);
  assert.equal(wide.ok, false); assert.equal(wide.reason, 'bigger-than-monitor');
  const tall = lineUp(at(0, 0, 1000, 1100, mon(0, 0, 1920, 1080)), 1000, 1100);
  assert.equal(tall.ok, false); assert.equal(tall.reason, 'bigger-than-monitor');
  // the passed window size wins over content (the viewport is what gets painted)
  assert.equal(lineUp(at(0, 0, 1000, 800, mon(0, 0, 1920, 1080)), 2000, 800).ok, false);
  // missing window size falls back to the content size
  assert.equal(lineUp(at(10, 20, 1000, 800, mon(0, 0, 1920, 1080))).tx, -10);
});

test('lineUp: no placement (phone, ?mock=1) or a malformed one -> not ok, zero offsets', () => {
  for (const p of [null, undefined, 0, 'x']) {
    const r = lineUp(p, 400, 800);
    assert.equal(r.ok, false); assert.equal(r.reason, 'no-placement'); assert.equal(r.tx, 0); assert.equal(r.ty, 0);
  }
  for (const p of [{}, { content: { x: 0, y: 0, width: 10, height: 10 } }, at(0, 0, 0, 10, mon(0, 0, 100, 100)),
    at(0, 0, 10, 10, mon(0, 0, NaN, 100)), at(0, 0, 10, 10, { x: 0, y: 0, width: 100 })]) {
    assert.equal(lineUp(p, 10, 10).reason, 'bad-placement');
  }
  // a bad scaleFactor degrades to 1, it does not refuse
  assert.equal(lineUp(at(0, 0, 10, 10, mon(0, 0, 100, 100, 0)), 10, 10).scale, 1);
});

test('blurKey: same inputs -> same key; any of url / blur / monitor size / dpr changes it; window position never', () => {
  const k = blurKey('/bg/desktop?v=3', 5, 1920, 1080, 1.5);
  assert.equal(k, blurKey('/bg/desktop?v=3', 5, 1920, 1080, 1.5));
  assert.equal(k, blurKey('/bg/desktop?v=3', 5.0001, 1920, 1080, 1.5));   // float noise from a slider
  for (const other of [blurKey('/bg/desktop?v=4', 5, 1920, 1080, 1.5), blurKey('/bg/desktop?v=3', 6, 1920, 1080, 1.5),
    blurKey('/bg/desktop?v=3', 5, 2560, 1080, 1.5), blurKey('/bg/desktop?v=3', 5, 1920, 1440, 1.5), blurKey('/bg/desktop?v=3', 5, 1920, 1080, 1)]) {
    assert.notEqual(other, k);
  }
  // light ground: saturate(150%) is baked in, so it is its own render; 100 (dark) keeps the key exactly as before
  assert.equal(blurKey('/bg/desktop?v=3', 5, 1920, 1080, 1.5, 100), k);
  assert.equal(k, '/bg/desktop?v=3|b5|1920x1080@1.5');
  assert.notEqual(blurKey('/bg/desktop?v=3', 5, 1920, 1080, 1.5, 150), k);
});

test('blurPlan: backing = monitor DIPs x dpr, sigma = blur x dpr, margin ~3 sigma, cover in backing px', () => {
  const p = blurPlan(3840, 2160, 1920, 1080, 1.5, 5);
  assert.equal(p.cw, 2880); assert.equal(p.ch, 1620);
  assert.equal(p.sigma, 7.5); assert.equal(p.margin, 23);
  assert.deepEqual(p.draw, { x: 0, y: 0, width: 2880, height: 1620 });
  const none = blurPlan(3000, 1000, 1920, 1080, 1, 0);
  assert.equal(none.sigma, 0); assert.equal(none.margin, 0);
  close(none.draw.x, -660, 'cover x');
  assert.equal(blurPlan(100, 100, 100, 100, 0, 5).cw, 100);   // a bad dpr degrades to 1
});
