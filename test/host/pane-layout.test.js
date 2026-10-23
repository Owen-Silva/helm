// Unit tests for ui/lib/pane-layout.js: the 1 / 2 / 4-corner pane layout's pure rules (lane quad), plus how
// the panes feed tab release (ui/lib/tab-state.js onScreen / releaseOnClose -> sessions.viewing).
// Both UI modules are ESM with no imports, so require(esm) loads them directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const PL = require('../../ui/lib/pane-layout.js');
const { onScreen, releaseOnClose } = require('../../ui/lib/tab-state.js');

const quad = (ids, focus = 0) => ({ n: 4, ids, focus });
const all = new Set(['a', 'b', 'c', 'd', 'e', 'f']);

test('normalize: garbage -> 1 pane; sizes other than 1/2/4 are refused; duplicates and non-ids drop to empty corners', () => {
  for (const x of [null, undefined, 3, 'x', [], {}, { n: 3, ids: ['a', 'b', 'c'] }]) assert.deepEqual(PL.normalize(x), PL.single());
  assert.deepEqual(PL.normalize({ n: 4, ids: ['a', 'a', 7, 'd', 'extra'], focus: 9 }), quad(['a', null, null, 'd'], 0));
  assert.deepEqual(PL.normalize({ n: 4, ids: ['a'] }), quad(['a', null, null, null], 0));
  // 2 panes are two sessions or nothing
  assert.deepEqual(PL.normalize({ n: 2, ids: ['a', null], focus: 1 }), PL.single());
  assert.deepEqual(PL.normalize({ n: 2, ids: ['a', 'b'], focus: 1 }), { n: 2, ids: ['a', 'b'], focus: 1 });
});

test('persistence: serialize -> parse round-trips; the old helm.split shape migrates to 2 panes; bad text -> 1 pane', () => {
  const s = quad(['a', null, 'c', 'd'], 2);
  assert.deepEqual(PL.parse(PL.serialize(s)), s);
  assert.equal(JSON.parse(PL.serialize(s)).v, 1);
  assert.deepEqual(PL.parse(JSON.stringify({ ids: ['a', 'b'], focus: 0 })), { n: 2, ids: ['a', 'b'], focus: 0 });
  assert.deepEqual(PL.parse('null'), PL.single());
  assert.deepEqual(PL.parse('{oops'), PL.single());
  assert.deepEqual(PL.parse(''), PL.single());
  assert.deepEqual(PL.parse(null), PL.single());
  assert.equal(PL.LAYOUT_KEY, 'helm.layout');
});

test('toQuad from 1 pane: the active session top-left (focused), then the tabs in strip order', () => {
  const r = PL.toQuad(PL.single(), { active: 'c', tabs: ['a', 'b', 'c', 'd', 'e'], exists: all });
  assert.deepEqual(r, quad(['c', 'a', 'b', 'd'], 0));
  // nothing active (Home): the first 4 tabs
  assert.deepEqual(PL.toQuad(PL.single(), { active: null, tabs: ['a', 'b', 'c', 'd', 'e'], exists: all }), quad(['a', 'b', 'c', 'd'], 0));
});

test('toQuad: fewer than 4 sessions leaves empty corners; deleted tabs are skipped', () => {
  assert.deepEqual(PL.toQuad(PL.single(), { active: 'a', tabs: ['a', 'b'], exists: all }), quad(['a', 'b', null, null], 0));
  assert.deepEqual(PL.toQuad(PL.single(), { active: 'gone', tabs: ['gone', 'b', 'x'], exists: all }), quad(['b', null, null, null], 0));
  assert.deepEqual(PL.toQuad(PL.single(), { tabs: [] }), quad([null, null, null, null], 0));
});

test('toQuad from 2 panes: left/right stay the top row and the focus stays on the same session', () => {
  const r = PL.toQuad({ n: 2, ids: ['b', 'd'], focus: 1 }, { active: 'd', tabs: ['a', 'b', 'c', 'd'], exists: all });
  assert.deepEqual(r, quad(['b', 'd', 'a', 'c'], 1));
});

test('toPair: from 4 keeps the focused corner + the next filled one in corner order; from 1 = the Ctrl+Shift+\\ split', () => {
  assert.deepEqual(PL.toPair(quad(['a', 'b', 'c', 'd'], 2), { exists: all }), { n: 2, ids: ['c', 'd'], focus: 0 });
  assert.deepEqual(PL.toPair(quad(['a', 'b', 'c', null], 2), { exists: all }), { n: 2, ids: ['a', 'c'], focus: 1 });
  assert.deepEqual(PL.toPair(quad([null, 'b', null, null], 1), { partner: 'e', exists: all }), { n: 2, ids: ['b', 'e'], focus: 0 });
  assert.deepEqual(PL.toPair(quad([null, 'b', null, null], 1), { partner: null, exists: all }), PL.single());
  assert.deepEqual(PL.toPair(PL.single(), { active: 'a', partner: 'b', exists: all }), { n: 2, ids: ['a', 'b'], focus: 1 });
  assert.deepEqual(PL.toPair(PL.single(), { active: 'a', partner: 'a', exists: all }), PL.single());
});

test('assign: into a corner focuses it; already in another corner -> the two swap (an empty one too)', () => {
  const s = quad(['a', 'b', 'c', null], 0);
  assert.deepEqual(PL.assign(s, 3, 'e'), quad(['a', 'b', 'c', 'e'], 3));
  assert.deepEqual(PL.assign(s, 0, 'c'), quad(['c', 'b', 'a', null], 0));           // swap
  assert.deepEqual(PL.assign(s, 3, 'a'), quad([null, 'b', 'c', 'a'], 3));           // swap with an empty corner = move
  assert.deepEqual(PL.assign(s, 1, 'b'), quad(['a', 'b', 'c', null], 1));           // same corner: focus only
  assert.deepEqual(PL.assign(s, 0, 'a'), s);                                         // nothing to do
  assert.deepEqual(PL.assign(s, 7, 'e'), s);
  assert.deepEqual(PL.assign({ n: 2, ids: ['a', 'b'], focus: 0 }, 0, 'b'), { n: 2, ids: ['b', 'a'], focus: 0 });
  assert.deepEqual(PL.assign(PL.single(), 0, 'a'), PL.single());
});

test('closePane / removeId: a corner empties and the layout stays; 2 panes go back to one', () => {
  const s = quad(['a', 'b', 'c', 'd'], 1);
  assert.deepEqual(PL.closePane(s, 1), quad(['a', null, 'c', 'd'], 1));             // focus stays on the empty corner
  assert.deepEqual(PL.removeId(s, 'd'), quad(['a', 'b', 'c', null], 1));
  assert.deepEqual(PL.removeId(s, 'zz'), s);
  assert.deepEqual(PL.closePane({ n: 2, ids: ['a', 'b'], focus: 0 }, 0), PL.single());
  let q = s;
  for (const id of ['a', 'b', 'c', 'd']) q = PL.removeId(q, id);
  assert.deepEqual(q, quad([null, null, null, null], 1));                            // all closed: still 4 corners
});

test('prune: deleted sessions drop out cleanly (same object when nothing changed)', () => {
  const s = quad(['a', 'b', 'gone', 'd'], 2);
  assert.deepEqual(PL.prune(s, all), quad(['a', 'b', null, 'd'], 2));
  const ok = quad(['a', null, 'c', 'd'], 0);
  assert.equal(PL.prune(ok, all), ok);
  assert.deepEqual(PL.prune({ n: 2, ids: ['a', 'gone'], focus: 0 }, all), PL.single());
  const one = PL.single();
  assert.equal(PL.prune(one, all), one);
  assert.deepEqual(PL.prune(s, (id) => id !== 'a' && id !== 'gone'), quad([null, 'b', null, 'd'], 2));
});

test('follow: the pane showing it takes the focus; else an empty corner (the focused one first); full -> replace focused', () => {
  const s = quad(['a', 'b', null, 'd'], 0);
  assert.deepEqual(PL.follow(s, 'd'), quad(['a', 'b', null, 'd'], 3));
  assert.deepEqual(PL.follow(s, 'e'), quad(['a', 'b', 'e', 'd'], 2));               // first empty corner
  assert.deepEqual(PL.follow(quad(['a', null, null, 'd'], 1), 'e'), quad(['a', 'e', null, 'd'], 1));   // focused empty corner
  assert.deepEqual(PL.follow(quad(['a', 'b', 'c', 'd'], 2), 'e'), quad(['a', 'b', 'e', 'd'], 2));      // full: replace focused
  assert.equal(PL.follow(s, 'a'), s);
  assert.equal(PL.follow(s, null), s);
  assert.deepEqual(PL.follow({ n: 2, ids: ['a', 'b'], focus: 0 }, 'e'), { n: 2, ids: ['e', 'b'], focus: 0 });   // the split rule
  const one = PL.single();
  assert.equal(PL.follow(one, 'e'), one);
});

test('visibleSlots / shownIds: all 4 corners; a narrow window draws only the focused corner\'s row', () => {
  const s = quad(['a', null, 'c', 'd'], 3);
  assert.deepEqual(PL.visibleSlots(s), [0, 1, 2, 3]);
  assert.deepEqual(PL.shownIds(s), ['a', 'c', 'd']);
  assert.deepEqual(PL.visibleSlots(s, true), [2, 3]);
  assert.deepEqual(PL.shownIds(s, true), ['c', 'd']);
  assert.deepEqual(PL.shownIds({ ...s, focus: 1 }, true), ['a']);
  assert.deepEqual(PL.shownIds({ n: 2, ids: ['a', 'b'], focus: 0 }, true), ['a', 'b']);   // 2 panes are never cut
  assert.deepEqual(PL.visibleSlots(PL.single()), []);
  assert.equal(PL.focusedId(s), 'd');
  assert.equal(PL.focusedId({ ...s, focus: 1 }), null);
  assert.equal(PL.focusedId(PL.single()), undefined);
});

test('cornerChoices: tabs not on screen first, then recent sessions, no repeats, capped', () => {
  assert.deepEqual(PL.cornerChoices({ shown: ['a', null, 'c', null], tabs: ['a', 'b', 'c', 'e'], recent: ['f', 'b', 'a', 'g', 'h', 'i'], limit: 5 }), ['b', 'e', 'f', 'g', 'h']);
  assert.deepEqual(PL.cornerChoices({}), []);
  assert.equal(PL.besideSlot(quad(['a', 'b', null, 'd'], 0)), 2);
  assert.equal(PL.besideSlot(quad(['a', 'b', 'c', 'd'], 3)), 0);
  assert.equal(PL.besideSlot(PL.single()), -1);
});

test('viewing set: every corner on screen is reported; closing a corner\'s tab releases only that one', () => {
  const s = quad(['a', 'b', 'c', 'd'], 0);
  const screen = (st, narrow = false) => onScreen({ view: 'session', active: PL.focusedId(st), splitIds: PL.shownIds(st, narrow) });
  assert.deepEqual(screen(s), ['a', 'b', 'c', 'd']);
  // the tab of corner 1 closes: its corner empties, the other 3 stay on screen and are never released
  const after = PL.removeId(s, 'b');
  assert.deepEqual(screen(after), ['a', 'c', 'd']);
  assert.equal(releaseOnClose(screen(after), 'b'), true);
  for (const id of ['a', 'c', 'd']) assert.equal(releaseOnClose(screen(after), id), false, `${id} is still in a corner`);
  // a tab that is not in a corner (a 5th one) closing changes nothing on screen
  assert.equal(releaseOnClose(screen(s), 'e'), true);
  assert.deepEqual(screen(s), ['a', 'b', 'c', 'd']);
  // the focused corner emptied (nothing active): the others still count
  const f0 = PL.removeId(s, 'a');
  assert.deepEqual(onScreen({ view: 'session', active: null, splitIds: PL.shownIds(f0) }), ['b', 'c', 'd']);
  // every corner empty: nothing on screen
  assert.deepEqual(onScreen({ view: 'session', active: null, splitIds: PL.shownIds(quad([null, null, null, null])) }), []);
  // Home / another view / the phone: the corners are not on screen
  assert.deepEqual(onScreen({ view: 'home', active: null, splitIds: PL.shownIds(s) }), []);
  assert.deepEqual(onScreen({ view: 'session', active: 'a', splitIds: PL.shownIds(s), phone: true }), ['a']);
  // narrow window: only the drawn row counts
  assert.deepEqual(screen({ ...s, focus: 3 }, true), ['c', 'd']);
});
