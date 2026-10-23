// Unit tests for ui/lib/tab-state.js: the session tab strip's pure rules (lane tabs).
// The UI module is ESM with no imports, so require(esm) loads it directly (same as session-activity.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STORAGE_KEY, MAX_TABS, normalize, parse, serialize, openTab, neighborOf, closeTab, moveTab, dropIndex, prune,
  cycle, tabForDigit, helloChoice, startChoice,
} = require('../../ui/lib/tab-state.js');

const st = (ids, active = null) => ({ ids, active });

test('storage key', () => { assert.equal(STORAGE_KEY, 'helm.tabs'); });

test('normalize: garbage in, valid state out; drops duplicates and non-strings; active must be a tab', () => {
  assert.deepEqual(normalize(null), st([]));
  assert.deepEqual(normalize('x'), st([]));
  assert.deepEqual(normalize({ ids: 'a' }), st([]));
  assert.deepEqual(normalize({ ids: ['a', 'a', 3, '', null, 'b'], active: 'b' }), st(['a', 'b'], 'b'));
  assert.deepEqual(normalize({ ids: ['a'], active: 'zzz' }), st(['a'], null));
  const many = Array.from({ length: MAX_TABS + 20 }, (_, i) => `s${i}`);
  assert.equal(normalize({ ids: many }).ids.length, MAX_TABS);
});

test('parse / serialize round trip; unreadable or missing storage = null (tabs never used)', () => {
  const s = st(['a', 'b', 'c'], 'b');
  assert.deepEqual(parse(serialize(s)), s);
  assert.equal(parse(null), null);
  assert.equal(parse(''), null);
  assert.equal(parse('{not json'), null);
  assert.equal(parse('[1,2]'), null);
  assert.equal(parse('{"foo":1}'), null);
  assert.deepEqual(parse('{"ids":[],"active":null}'), st([]));   // every tab closed: still "used"
});

test('openTab: new tabs go at the end and become active; an open tab keeps its place', () => {
  let s = st([]);
  s = openTab(s, 'a'); s = openTab(s, 'b'); s = openTab(s, 'c');
  assert.deepEqual(s, st(['a', 'b', 'c'], 'c'));
  s = openTab(s, 'a');
  assert.deepEqual(s, st(['a', 'b', 'c'], 'a'));   // no re-sort on re-open
  s = openTab(s, 'd');
  assert.deepEqual(s, st(['a', 'b', 'c', 'd'], 'd'));   // end, not next to the active tab
  assert.deepEqual(openTab(s, ''), s);
  assert.deepEqual(openTab(s, null), s);
});

test('closeTab: closing the active tab activates the right neighbour, else the left, else none', () => {
  assert.deepEqual(closeTab(st(['a', 'b', 'c'], 'b'), 'b'), st(['a', 'c'], 'c'));
  assert.deepEqual(closeTab(st(['a', 'b', 'c'], 'c'), 'c'), st(['a', 'b'], 'b'));
  assert.deepEqual(closeTab(st(['a'], 'a'), 'a'), st([], null));
  // closing an inactive tab leaves the active one alone
  assert.deepEqual(closeTab(st(['a', 'b', 'c'], 'a'), 'c'), st(['a', 'b'], 'a'));
  // unknown id: unchanged
  assert.deepEqual(closeTab(st(['a', 'b'], 'a'), 'zzz'), st(['a', 'b'], 'a'));
});

test('neighborOf', () => {
  assert.equal(neighborOf(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(neighborOf(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(neighborOf(['a'], 'a'), null);
  assert.equal(neighborOf(['a'], 'x'), null);
});

test('moveTab: index into the list without the moved tab, clamped; active unchanged', () => {
  const s = st(['a', 'b', 'c', 'd'], 'b');
  assert.deepEqual(moveTab(s, 'a', 3).ids, ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveTab(s, 'd', 0).ids, ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveTab(s, 'b', 2).ids, ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveTab(s, 'b', 99).ids, ['a', 'c', 'd', 'b']);
  assert.deepEqual(moveTab(s, 'b', -5).ids, ['b', 'a', 'c', 'd']);
  assert.equal(moveTab(s, 'b', 2).active, 'b');
  assert.deepEqual(moveTab(s, 'zzz', 0), s);
  assert.deepEqual(moveTab(s, 'b', 1), s);   // same place
});

test('dropIndex: counts the other tabs whose centre is left of the pointer', () => {
  const mids = [50, 150, 250, 350];   // four 100 px tabs
  assert.equal(dropIndex(mids, 40, 0), 0);
  assert.equal(dropIndex(mids, 160, 0), 1);    // dragged right past b's centre
  assert.equal(dropIndex(mids, 340, 0), 2);
  assert.equal(dropIndex(mids, 360, 0), 3);
  assert.equal(dropIndex(mids, 240, 3), 2);    // dragged left past c's centre
  assert.equal(dropIndex(mids, 10, 3), 0);
  assert.equal(dropIndex(mids, 150, 1), 1);    // its own centre: stays
  // drag + move together: a then lands after c
  const s = st(['a', 'b', 'c', 'd'], 'a');
  assert.deepEqual(moveTab(s, 'a', dropIndex(mids, 260, 0)).ids, ['b', 'c', 'a', 'd']);
});

test('prune: drops tabs whose session is gone; a gone active tab hands over to its neighbour', () => {
  const s = st(['a', 'b', 'c', 'd'], 'b');
  assert.deepEqual(prune(s, new Set(['a', 'b', 'c', 'd'])), s);
  assert.deepEqual(prune(s, new Set(['a', 'b', 'd'])), st(['a', 'b', 'd'], 'b'));
  assert.deepEqual(prune(s, new Set(['a', 'c', 'd'])), st(['a', 'c', 'd'], 'c'));   // right neighbour
  assert.deepEqual(prune(s, new Set(['a', 'd'])), st(['a', 'd'], 'd'));             // next surviving on the right
  assert.deepEqual(prune(st(['a', 'b', 'c'], 'c'), new Set(['a'])), st(['a'], 'a')); // left when none on the right
  assert.deepEqual(prune(s, new Set()), st([], null));
  assert.deepEqual(prune(s, (id) => id !== 'a'), st(['b', 'c', 'd'], 'b'));          // predicate form
});

test('cycle: Ctrl+Tab wraps both ways; from no tab goes to first / last', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(cycle(ids, 'a', 1), 'b');
  assert.equal(cycle(ids, 'c', 1), 'a');
  assert.equal(cycle(ids, 'a', -1), 'c');
  assert.equal(cycle(ids, 'b', -1), 'a');
  assert.equal(cycle(ids, null, 1), 'a');
  assert.equal(cycle(ids, 'zzz', -1), 'c');
  assert.equal(cycle([], 'a', 1), null);
  assert.equal(cycle(['a'], 'a', 1), 'a');
});

test('tabForDigit: 1..8 pick that tab, 9 is the last tab', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
  assert.equal(tabForDigit(ids, 1), 't1');
  assert.equal(tabForDigit(ids, 8), 't8');
  assert.equal(tabForDigit(ids, 9), 't12');
  assert.equal(tabForDigit(['a', 'b'], 9), 'b');
  assert.equal(tabForDigit(['a', 'b'], 3), null);
  assert.equal(tabForDigit([], 1), null);
  assert.equal(tabForDigit(ids, 0), null);
  assert.equal(tabForDigit(ids, 10), null);
});

test('helloChoice: startup shows the saved active tab; nothing when every tab was closed; no opinion before tabs were used', () => {
  const all = new Set(['a', 'b', 'c']);
  assert.equal(helloChoice(null, null, all), undefined);                  // never used: default pick
  assert.equal(helloChoice(st(['a', 'b'], 'b'), null, all), 'b');
  assert.equal(helloChoice(st([], null), null, all), null);               // every tab closed: home view
  assert.equal(helloChoice(st(['a', 'b'], 'b'), 'a', all), 'a');          // reconnect keeps what is on screen
  assert.equal(helloChoice(st(['a', 'b'], 'b'), 'c', all), 'b');          // ...only if it is a tab
  assert.equal(helloChoice(st(['a', 'x', 'b'], 'x'), null, all), 'b');    // saved active is gone: its neighbour
  assert.equal(helloChoice(st(['x'], 'x'), null, all), null);             // every saved tab is gone
  assert.equal(helloChoice(st(['a', 'b'], null), null, all), 'a');
});

test('startChoice (lane home): a launch on Home selects nothing and keeps every tab; off Home it is helloChoice', () => {
  const all = new Set(['a', 'b', 'c']);
  // what tabs.js persisted before the restart
  const text = serialize(st(['c', 'a', 'b'], 'a'));
  const saved = parse(text);
  assert.equal(startChoice({ onHome: true, saved, current: null, exists: all }), null);   // lands on Home, no tab active
  assert.deepEqual(parse(text).ids, ['c', 'a', 'b']);                                      // the tab list is untouched
  assert.deepEqual(prune(saved, all), st(['c', 'a', 'b'], 'a'));                           // and survives the startup prune
  assert.equal(startChoice({ onHome: true, saved: null, current: null, exists: all }), null);   // tabs never used: still Home
  assert.equal(startChoice({ onHome: true, saved, current: 'b', exists: all }), null);     // a reconnect while on Home stays there
  assert.equal(startChoice({ onHome: false, saved, current: null, exists: all }), 'a');    // elsewhere: unchanged rules
  assert.equal(startChoice({ onHome: false, saved, current: 'b', exists: all }), 'b');
  assert.equal(startChoice({ onHome: false, saved: null, current: null, exists: all }), undefined);
  assert.equal(startChoice(), undefined);
});
