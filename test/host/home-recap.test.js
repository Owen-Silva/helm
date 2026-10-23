// Unit tests for the "Since you left" rules in ui/lib/home-model.js (lane recap): recapRow / recapView / fmtCost.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { recapRow, recapView, fmtCost, RECAP_MAX } = require('../../ui/lib/home-model.js');

const MIN = 60_000;
const row = (id, extra = {}) => ({ id, title: `T ${id}`, project: 'p', outcome: 'done', commits: 0, fileCount: 0, files: [], costUsd: 0, from: 10 * MIN, to: 10 * MIN, ...extra });
const clockOf = (ms) => `c${ms / MIN}`;

test('fmtCost: blank for none, <$0.01 for crumbs, cents always (lane accuracy: $12.60 is not "$13")', () => {
  assert.equal(fmtCost(0), '');
  assert.equal(fmtCost(null), '');
  assert.equal(fmtCost(0.004), '<$0.01');
  assert.equal(fmtCost(1.234), '$1.23');
  assert.equal(fmtCost(12.6), '$12.60');
});

test('recapRow: pieces for commits (first subject), files (3 names + rest), cost and span', () => {
  const r = recapRow(row('a', { commits: 2, commitSubject: 'Add recap', fileCount: 5, files: ['a.js', 'b.js', 'c.css'], costUsd: 0.35, from: 10 * MIN, to: 61 * MIN }), null, clockOf);
  assert.deepEqual(r.pieces, [
    { k: 'commits', text: '2 commits', detail: 'Add recap' },
    { k: 'files', text: '5 files', detail: 'a.js, b.js, c.css +2' },
    { k: 'cost', text: '$0.35' },
    { k: 'span', text: 'c10–c61', detail: '51m' },
  ]);
  assert.equal(r.lead, 'Finished');
  assert.equal(r.state, 'ok');
  const one = recapRow(row('b', { commits: 1, fileCount: 1, files: ['x'] }), null, clockOf);
  assert.equal(one.pieces[0].text, '1 commit');
  assert.equal(one.pieces[1].text, '1 file');
  assert.deepEqual(one.pieces[2], { k: 'span', text: 'c10', detail: '' });   // under a minute: one time
});

test('recapRow: live status wins (waiting / working / error), and a finished session drops a stale "working"', () => {
  assert.equal(recapRow(row('a'), { id: 'a', status: 'waiting' }).outcome, 'waiting');
  assert.equal(recapRow(row('a'), { id: 'a', status: 'working' }).lead, 'Still working');
  const f = recapRow(row('a', { outcome: 'failed', error: 'API Error: 529' }), { id: 'a', status: 'idle' });
  assert.equal(f.outcome, 'failed');
  assert.equal(f.error, 'API Error: 529');
  assert.equal(recapRow(row('a'), { id: 'a', status: 'error', activity: 'CLI exited' }).error, 'CLI exited');
  assert.equal(recapRow(row('a', { outcome: 'working' }), { id: 'a', status: 'idle' }).outcome, 'done');
  assert.equal(recapRow(row('a', { outcome: 'working' }), null).outcome, 'working');   // no live data: trust the engine
});

test('recapView: waiting and failed lead, archived / unknown drop out, capped with "+N more"', () => {
  const rows = [row('d1'), row('f', { outcome: 'failed', error: 'x' }), row('w', { outcome: 'waiting' }), row('arch'), row('ghost')];
  const live = [{ id: 'd1', status: 'idle' }, { id: 'f', status: 'idle' }, { id: 'w', status: 'waiting' }, { id: 'arch', status: 'idle', archived: true }];
  const v = recapView(rows, live);
  assert.deepEqual(v.rows.map((r) => r.id), ['w', 'f', 'd1']);
  assert.equal(v.more, 0);
  const many = Array.from({ length: 9 }, (_, i) => row(`s${i}`));
  const m = recapView(many, many.map((r) => ({ id: r.id, status: 'idle' })));
  assert.equal(m.rows.length, RECAP_MAX);
  assert.equal(m.more, 3);
  assert.equal(recapView(many, [], { showAll: true }).rows.length, 9);
  assert.deepEqual(recapView([], []), { rows: [], more: 0, total: 0 });
  assert.deepEqual(recapView(null, null).total, 0);
});
