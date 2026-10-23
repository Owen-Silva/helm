// The overlap detector's rules (tools/overlap-core.js) on hand-built geometry, no browser. The full browser
// run is `npm run test:overlap` (tools/overlap-audit.js), which uses these same rules on every Helm screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../tools/overlap-core.js');

const RING = 'rgba(20, 21, 22, 0.9) 0px 0px 0px 1px, rgba(159, 180, 204, 0.55) 0px 0px 0px 3px';
const r = (x, y, w, h) => ({ x, y, w, h });
const VIEW = r(0, 0, 1280, 860);
const ctl = (id, rect, o = {}) => ({ id, kind: 'ctl', sel: 'button#' + id, rect, clip: VIEW, layer: 'page', anc: [], ctl: null, ...o });
const kinds = (fs) => fs.map((f) => f.kind).sort();
const withRing = (c, reach) => ({ ...c, ink: core.grow(c.rect, reach), ring: true });

test('parses focus rings and modern colour syntax', () => {
  const s = core.parseShadows(RING);
  assert.equal(s.length, 2);
  assert.deepEqual([s[1].spread, s[1].alpha], [3, 0.55]);
  const m = core.parseShadows('color(srgb 0.1 0.2 0.3 / 0.4) 0px 8px 24px 0px, inset 0px 0px 0px 1px oklab(0.5 0 0 / 50%)');
  assert.deepEqual([m[0].alpha, m[0].blur, m[1].inset, m[1].alpha], [0.4, 24, true, 0.5]);
  assert.deepEqual(core.ringReach({ boxShadow: RING, outlineStyle: 'none', outlineWidth: '0px' }), { l: 3, t: 3, r: 3, b: 3 });
  // soft elevation shadows are meant to spill; inset rings never leave the box
  assert.deepEqual(core.ringReach({ boxShadow: 'rgba(0, 0, 0, 0.3) 0px 8px 24px 0px, rgba(1, 2, 3, 0.9) 0px 0px 0px 2px inset' }), { l: 0, t: 0, r: 0, b: 0 });
  assert.deepEqual(core.ringReach({ boxShadow: 'none', outlineStyle: 'solid', outlineWidth: '2px', outlineOffset: '-2px' }), { l: 0, t: 0, r: 0, b: 0 });
});

// The 2026-10-15 report: the user-message action row (time, Copy, Edit, Fork, Rewind) hung in the 20 px gap
// between two messages; 25x20 buttons, 6 px apart, with a 3 px focus ring.
function actionRow({ h = 20, w = 25, gap = 6, reach = 3, rowTop = 100 }) {
  const bubbleAbove = { id: 200000, kind: 'box', sel: 'div.bubble', rect: r(700, rowTop - 60, 400, 60), clip: VIEW, layer: 'page', anc: [], ctl: null };
  const nextBubble = { id: 200001, kind: 'box', sel: 'div.bubble(next)', rect: r(700, rowTop + 20, 400, 40), clip: VIEW, layer: 'page', anc: [], ctl: null };
  const time = { id: 100000, kind: 'glyph', sel: 'span.msg-time "10:25 PM"', rect: r(960, rowTop + 4, 44, 12), clip: VIEW, layer: 'page', anc: [], ctl: null };
  const els = [bubbleAbove, nextBubble, time];
  for (let i = 0; i < 4; i++) {
    const c = ctl(i, r(1004 + gap + i * (w + gap), rowTop + (20 - h) / 2, w, h));
    els.push(reach ? withRing(c, { l: reach, t: reach, r: reach, b: reach }) : { ...c, ink: c.rect, ring: false });
  }
  return { viewport: VIEW, scrollWidth: 1280, els };
}

test('the old action row: rings bleed into the bubbles above and below', () => {
  const f = core.analyze(actionRow({}), { scenario: 'chat', width: 1280 });
  const rings = f.filter((x) => x.kind === 'ring');
  assert.ok(rings.length >= 4, `expected the ring to reach the bubbles, got ${JSON.stringify(kinds(f))}`);
  assert.ok(rings.some((x) => x.b.includes('bubble(next)')));
});

test('tight gap: one button\'s ring reaches its neighbour', () => {
  const f = core.analyze(actionRow({ gap: 2, h: 14 }), { scenario: 'chat', width: 1280 });
  assert.ok(f.some((x) => x.kind === 'ring' && x.b.startsWith('button#')), JSON.stringify(f.map((x) => x.kind + ' ' + x.a + ' x ' + x.b)));
});

test('the new action row: inset rings, 24 px squares, a gap between them, nothing reported', () => {
  const f = core.analyze(actionRow({ h: 20, w: 24, gap: 4, reach: 0 }), { scenario: 'chat', width: 1280 });
  assert.deepEqual(kinds(f), []);
});

test('overlapping control boxes and hit areas', () => {
  const a = ctl(1, r(10, 10, 30, 30)), b = ctl(2, r(35, 10, 30, 30));
  assert.deepEqual(kinds(core.analyze({ els: [a, b] })), ['overlap']);
  const c = ctl(3, r(10, 10, 32, 32), { hit: r(4, 4, 44, 44) }), d = ctl(4, r(46, 10, 32, 32), { hit: r(40, 4, 44, 44) });
  assert.deepEqual(kinds(core.analyze({ els: [c, d] })), ['hit-overlap']);
  // a button inside a row is not "overlapping" the row
  const row = ctl(5, r(0, 0, 200, 40)), inner = ctl(6, r(160, 8, 24, 24), { anc: [5] });
  assert.deepEqual(kinds(core.analyze({ els: [row, inner] })), []);
  // different layers (a toast over the chat) are never compared
  assert.deepEqual(kinds(core.analyze({ els: [a, { ...b, layer: 'L1' }] })), []);
});

test('a focus ring cut by an overflow ancestor', () => {
  const clip = r(0, 0, 200, 100);
  const a = withRing(ctl(1, r(0, 20, 200, 32), { clip }), { l: 3, t: 3, r: 3, b: 3 });
  const f = core.analyze({ els: [a] });
  assert.deepEqual(kinds(f), ['clipped-ring']);
  assert.match(f[0].detail, /cut by 3 px \(lr\)/);
});

// 2026-10-16 merge audit: the phone session header's status button and a message's copy buttons scrolled up out
// of the chat, under the header; and a pressed segment's lift landing 0.3 px inside a paged scroller's edge.
test('hit areas and neighbours only count where they are on screen', () => {
  const chat = r(0, 60, 320, 500);
  const info = ctl(1, r(10, 30, 300, 20), { hit: r(6, 30, 308, 23) });
  const copy = ctl(2, r(200, 30, 36, 22), { hit: r(196, 28, 44, 26), clip: chat });   // scrolled out of the chat
  assert.deepEqual(kinds(core.analyze({ els: [info, copy] })), []);
  const copyOn = ctl(3, r(200, 52, 36, 22), { hit: r(196, 50, 44, 26), clip: r(0, 0, 320, 560) });   // on screen: still caught
  assert.deepEqual(kinds(core.analyze({ els: [info, copyOn] })), ['hit-overlap']);
  const small = ctl(4, r(10, 30, 300, 20));
  const opt = ctl(5, r(10, 40, 300, 30), { clip: chat });                            // under the header, out of the chat
  assert.deepEqual(kinds(core.analyze({ els: [small, opt] })), []);
});

test('a ring cut by a scroller that can still scroll that way is not reported', () => {
  const clip = r(0, 0, 200, 100);
  const a = withRing(ctl(1, r(20, 60, 60, 39.7), { clip }), { l: 2, t: 1, r: 2, b: 3 });
  assert.deepEqual(kinds(core.analyze({ els: [a] })), ['clipped-ring']);             // at the scroller's end: a real cut
  assert.deepEqual(kinds(core.analyze({ els: [{ ...a, clipSoft: { l: false, t: false, r: false, b: true } }] })), []);
  assert.deepEqual(kinds(core.analyze({ els: [{ ...a, clipSoft: { l: false, t: true, r: false, b: false } }] })), ['clipped-ring']);
});

test('text cut, text spilling, text colliding', () => {
  const g = (id, rect, o = {}) => ({ id, kind: 'glyph', sel: 'span#' + id, rect, clip: VIEW, layer: 'page', anc: [], ctl: null, ...o });
  assert.deepEqual(kinds(core.analyze({ els: [g(1, r(0, 0, 240, 16), { hardClip: r(0, 0, 200, 40) })] })), ['text-clip']);
  assert.deepEqual(kinds(core.analyze({ els: [g(1, r(0, 0, 240, 16), { hardClip: r(0, 0, 200, 40), cutX: true })] })), []);
  assert.deepEqual(kinds(core.analyze({ els: [g(1, r(0, 0, 240, 16), { container: { rect: r(0, 0, 200, 30), sel: 'div.card' } })] })), ['text-spill']);
  assert.deepEqual(kinds(core.analyze({ els: [g(1, r(0, 0, 100, 16)), g(2, r(90, 4, 100, 16))] })), ['text-collide']);
});

test('small targets follow WCAG 2.5.8 (spacing exception, inline links exempt)', () => {
  const lone = ctl(1, r(100, 100, 16, 16));
  assert.deepEqual(kinds(core.analyze({ els: [lone] })), []);                         // nothing within 12 px of its centre
  const near = ctl(2, r(118, 100, 16, 16));
  assert.ok(kinds(core.analyze({ els: [lone, near] })).includes('small-target'));
  assert.deepEqual(kinds(core.analyze({ els: [{ ...lone, inline: true }, { ...near, inline: true }] })), []);
  const ok = ctl(3, r(100, 100, 24, 24)), ok2 = ctl(4, r(124, 100, 24, 24));
  assert.deepEqual(kinds(core.analyze({ els: [ok, ok2] })), []);
});

test('page wider than the window', () => {
  assert.deepEqual(kinds(core.analyze({ viewport: r(0, 0, 320, 640), scrollWidth: 344, els: [] })), ['page-overflow']);
});

test('allow entries need a reason and match on kind + selector', () => {
  const f = { kind: 'ring', scenario: 'settings@2', width: 393, a: '.seg button.seg-btn[Dark]', b: 'button.seg-btn[Light]' };
  assert.equal(core.allowed(f, [{ kind: 'ring', sel: 'seg-btn' }]), null);
  assert.ok(core.allowed(f, [{ kind: 'ring', sel: 'seg-btn', reason: 'segmented control: one shared pill' }]));
  assert.equal(core.allowed(f, [{ kind: 'ring', sel: 'seg-btn', width: 1280, reason: 'x' }]), null);
  const d = core.dedupe([f, { ...f }, { ...f, width: 320 }]);
  assert.deepEqual(d.map((x) => x.count), [2, 1]);
});
