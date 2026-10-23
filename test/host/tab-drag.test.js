// Unit tests for the tab strip's drag-to-reorder geometry in ui/lib/tab-state.js (lane tabsmooth, 2026-10-08).
// The user reported: "i have to pull it like all the way over for it to swicth". The swap rule: the dragged tab goes to the
// slot nearest its current left edge, i.e. a neighbour moves aside once the dragged tab covers half of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { slotLefts, dragSlots, dragBounds, dragTarget, dragOffsets, placeTab } = require('../../ui/lib/tab-state.js');

const st = (ids, active = null) => ({ ids, active });

test('slotLefts / dragSlots: packed lefts with a gap, the dragged tab placed at every index', () => {
  assert.deepEqual(slotLefts([100, 300, 100], 2), [0, 102, 404]);
  assert.deepEqual(slotLefts([], 2), []);
  // narrow A (100) dragged: at index 0 / 1 / 2 its left edge would be
  assert.deepEqual(dragSlots([100, 300, 100], 0, 2), [0, 302, 404]);
  // wide B (300) dragged
  assert.deepEqual(dragSlots([100, 300, 100], 1, 2), [0, 102, 204]);
  assert.deepEqual(dragSlots([100, 300, 100], 2, 2), [0, 102, 404]);
});

test('dragTarget, equal tabs: swaps after HALF a tab of travel, not a whole one (the old rule)', () => {
  const w = [196, 196, 196, 196], gap = 2;   // Helm's default tab width
  // dragging the first tab right: its slot is 0, the next one 198; the boundary is 99 px of travel
  assert.equal(dragTarget(w, 0, 0, gap), 0);
  assert.equal(dragTarget(w, 0, 98, gap), 0);
  assert.equal(dragTarget(w, 0, 100, gap), 1);    // the old rule needed ~198 px here
  assert.equal(dragTarget(w, 0, 198, gap), 1);
  // dragging the last tab left (its slot is 594)
  assert.equal(dragTarget(w, 3, 594, gap), 3);
  assert.equal(dragTarget(w, 3, 496, gap), 3);
  assert.equal(dragTarget(w, 3, 494, gap), 2);
  // a middle tab both ways
  assert.equal(dragTarget(w, 1, 198 - 98, gap), 1);
  assert.equal(dragTarget(w, 1, 198 - 100, gap), 0);
  assert.equal(dragTarget(w, 1, 198 + 100, gap), 2);
});

test('dragTarget, mixed widths: the leading edge crossing the neighbour\'s midpoint, both directions', () => {
  const w = [100, 300, 100];   // A narrow, B wide, C narrow; gap 0 keeps the numbers plain
  // narrow A dragged right past wide B: swaps once A's RIGHT edge passes B's midpoint (250)
  assert.equal(dragTarget(w, 0, 149, 0), 0);    // right edge 249
  assert.equal(dragTarget(w, 0, 151, 0), 1);    // right edge 251
  // wide B dragged left past narrow A: swaps once B's LEFT edge passes A's midpoint (50)
  assert.equal(dragTarget(w, 1, 51, 0), 1);
  assert.equal(dragTarget(w, 1, 49, 0), 0);
  // wide B dragged right past narrow C (C's midpoint 450): B's right edge = left + 300
  assert.equal(dragTarget(w, 1, 149, 0), 1);
  assert.equal(dragTarget(w, 1, 151, 0), 2);
  // narrow C dragged left past wide B: C's left edge vs B's midpoint (250)
  assert.equal(dragTarget(w, 2, 251, 0), 2);
  assert.equal(dragTarget(w, 2, 249, 0), 1);
  // exact tie stays put
  assert.equal(dragTarget(w, 0, 150, 0), 0);
});

test('dragTarget: one fast move can cross several tabs; bounds and degenerate input', () => {
  const w = [100, 100, 100, 100, 100];
  assert.equal(dragTarget(w, 0, 260, 0), 3);     // one jump past b, c and d (nearest slot: 300)
  assert.equal(dragTarget(w, 0, 400, 0), 4);
  assert.equal(dragTarget(w, 4, 40, 0), 0);
  assert.equal(dragTarget(w, 4, 140, 0), 1);
  assert.equal(dragTarget(w, 0, -500, 0), 0);    // past the start
  assert.equal(dragTarget(w, 2, 99999, 0), 4);   // past the end
  assert.equal(dragTarget([196], 0, 80, 2), 0);  // a lone tab never moves
  assert.equal(dragTarget([], 0, 10, 2), 0);
  assert.equal(dragTarget(w, 9, 10, 0), 9);      // unknown index: unchanged
  assert.equal(dragTarget(w, 0, NaN, 0), 0);
});

test('dragTarget is a pure function of position: monotonic, and the same on the way back (no flip-flop)', () => {
  const w = [120, 260, 96, 196, 140], gap = 2;
  for (let from = 0; from < w.length; from++) {
    const { max } = dragBounds(w, from, gap);
    const fwd = [], back = [];
    for (let x = 0; x <= max; x += 3) fwd.push(dragTarget(w, from, x, gap));
    for (let x = Math.floor(max / 3) * 3; x >= 0; x -= 3) back.unshift(dragTarget(w, from, x, gap));
    assert.deepEqual(back, fwd);
    for (let i = 1; i < fwd.length; i++) assert.ok(fwd[i] >= fwd[i - 1], `monotonic from ${from}`);
    assert.equal(fwd[0], 0);
    assert.equal(fwd[fwd.length - 1], w.length - 1);
  }
});

test('dragBounds: the dragged tab stays between the first and last slot', () => {
  assert.deepEqual(dragBounds([100, 300, 100], 0, 2), { min: 0, max: 404 });
  assert.deepEqual(dragBounds([100, 300, 100], 1, 2), { min: 0, max: 204 });
  assert.deepEqual(dragBounds([196], 0, 2), { min: 0, max: 0 });
  assert.deepEqual(dragBounds([], 0, 2), { min: 0, max: 0 });
});

test('dragOffsets: passed neighbours shift by the dragged width + gap; the dragged entry is its new slot', () => {
  const w = [100, 300, 100], gap = 2;
  assert.deepEqual(dragOffsets(w, 0, 0, gap), [0, 0, 0]);
  assert.deepEqual(dragOffsets(w, 0, 1, gap), [302, -102, 0]);
  assert.deepEqual(dragOffsets(w, 0, 2, gap), [404, -102, -102]);
  assert.deepEqual(dragOffsets(w, 2, 0, gap), [102, 102, -404]);
  assert.deepEqual(dragOffsets(w, 1, 0, gap), [302, -102, 0]);
  assert.deepEqual(dragOffsets(w, 1, 2, gap), [0, 102, -302]);
  // the dragged tab's settle offset always lands on dragSlots
  const m = [120, 260, 96, 196, 140];
  for (let from = 0; from < m.length; from++) {
    const slots = dragSlots(m, from, 2), lefts = slotLefts(m, 2);
    for (let to = 0; to < m.length; to++) {
      const dx = dragOffsets(m, from, to, 2);
      assert.equal(dx[from], slots[to] - lefts[from]);
      // the result is a valid packing: sorted new lefts with no overlap
      const placed = m.map((wi, i) => [lefts[i] + dx[i], wi]).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < placed.length; i++) assert.equal(placed[i][0], placed[i - 1][0] + placed[i - 1][1] + 2);
    }
  }
  assert.deepEqual(dragOffsets(w, 5, 0, gap), [0, 0, 0]);   // unknown index: nothing moves
});

test('placeTab: commits the drawn order, keeps undrawn tabs in place, no-op returns the same state', () => {
  const s = st(['a', 'b', 'c', 'd'], 'b');
  assert.deepEqual(placeTab(s, 'a', ['b', 'c', 'a', 'd']).ids, ['b', 'c', 'a', 'd']);
  assert.deepEqual(placeTab(s, 'd', ['d', 'a', 'b', 'c']).ids, ['d', 'a', 'b', 'c']);
  assert.deepEqual(placeTab(s, 'b', ['a', 'c', 'd', 'b']).ids, ['a', 'c', 'd', 'b']);
  assert.equal(placeTab(s, 'b', ['a', 'b', 'c', 'd']).active, 'b');
  assert.deepEqual(placeTab(s, 'b', ['a', 'b', 'c', 'd']), s);   // dropped where it started: no change
  // x is a tab whose session hasn't loaded, so the strip doesn't draw it
  const h = st(['a', 'x', 'b', 'c']);
  assert.deepEqual(placeTab(h, 'c', ['c', 'a', 'b']).ids, ['c', 'a', 'x', 'b']);
  assert.deepEqual(placeTab(h, 'a', ['b', 'c', 'a']).ids, ['x', 'b', 'c', 'a']);
  assert.deepEqual(placeTab(h, 'a', ['b', 'a', 'c']).ids, ['x', 'b', 'a', 'c']);
  // unknown ids / bad order: unchanged
  assert.deepEqual(placeTab(s, 'zzz', ['zzz', 'a']).ids, s.ids);
  assert.deepEqual(placeTab(s, 'a', null).ids, s.ids);
  assert.deepEqual(placeTab(s, 'a', ['b', 'c']).ids, s.ids);
});
