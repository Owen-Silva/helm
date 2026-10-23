// Top-row hints to Mantle (lane helm-toprow-hints): the TOP maths (ui/lib/toprow.js) and the pipe client
// (main/toprow.js) against a fake Mantle pipe server. Never touches the real \\.\pipe\look-sync-toprow.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const T = require('../../ui/lib/toprow.js');
const { createTopRow, cleanTop, MAX_LINE } = require('../../main/toprow');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 0.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---------- maths ----------
test('fold: one layer is itself; two layers multiply their see-through', () => {
  const one = T.fold([{ rgb: [9, 10, 11], a: 0.5 }]);
  assert.ok(near(one.rgb, [9, 10, 11], 1e-9)); assert.equal(one.alpha, 0.5);
  const two = T.fold([{ rgb: [9, 10, 11], a: 0.5 }, { rgb: [6, 7, 8], a: 0.48 }]);
  assert.ok(Math.abs(two.alpha - (1 - 0.5 * 0.52)) < 1e-12);
  // painting the folded layer equals painting the two in order, over any colour
  for (const under of [[0, 0, 0], [255, 255, 255], [120, 40, 200]]) {
    const step = T.over([6, 7, 8], 0.48, T.over([9, 10, 11], 0.5, under));
    assert.ok(near(T.over(two.rgb, two.alpha, under), step, 1e-9));
  }
  assert.deepEqual(T.fold([]), { rgb: [0, 0, 0], alpha: 0 });
});

test('session view, lined-up shared still: a wash at the painted dim', () => {
  const top = T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 0, washOk: true, scrims: [] });
  assert.deepEqual(top, { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 });
  // Mantle's shared darkening (guard) is just another dim value
  assert.equal(T.topFor({ theme: 'dark', photo: true, dim: 0.62, home: 0, washOk: true }).alpha, 0.62);
  // the palette / a modal on top: still a wash, with the scrim folded in
  const m = T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 0, washOk: true, scrims: [T.SCRIM.dark] });
  assert.equal(m.kind, 'wash'); assert.equal(m.alpha, 0.74);
  assert.deepEqual(m.rgb, [7, 8, 9]);
});

test('"None" background: one flat colour (--bg under the wash), both themes', () => {
  // dark: #141516 under rgb(9,10,11) at .5 -> 14.5, 15.5, 16.5 -> 15, 16, 17 (round half up)
  assert.deepEqual(T.topFor({ theme: 'dark', photo: false, dim: 0.5 }), { kind: 'flat', rgb: [15, 16, 17] });
  assert.deepEqual(T.topFor({ theme: 'light', photo: false, dim: 0.5 }), { kind: 'flat', rgb: [250, 251, 253] });
  assert.deepEqual(T.topFor({ theme: 'dark', photo: false, dim: 0 }), { kind: 'flat', rgb: [20, 21, 22] });
});

test('Home: the unblurred row under its .5 scrim and the wash -> cols', () => {
  const clear = [[200, 100, 50], [0, 0, 0]];
  const top = T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 1, washOk: true, clear, blurred: null });
  assert.equal(top.kind, 'cols');
  // effective alpha at row 0 = 1 - (1 - .5)(1 - .5) = .75 of rgb(9,10,11)
  assert.deepEqual(top.cols[0], [Math.round(200 * 0.25 + 9 * 0.75), Math.round(100 * 0.25 + 10 * 0.75), Math.round(50 * 0.25 + 11 * 0.75)]);
  assert.deepEqual(top.cols[1], [7, 8, 8]);
});

test('Home fading: a per-column mix of the clear and blurred rows by the copy\'s opacity', () => {
  const clear = [[200, 200, 200]], blurred = [[100, 100, 100]];
  const half = T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 0.5, washOk: true, clear, blurred });
  const c = T.over([9, 10, 11], 0.5, [200, 200, 200]);
  const under = T.over(c, 0.5, [100, 100, 100]);
  assert.deepEqual(half.cols[0], T.over([9, 10, 11], 0.5, under).map(Math.round));
  // rows of different lengths are resampled to the clear row's count
  const mixed = T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 0.3, clear: [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]], blurred: [[0, 0, 0], [255, 255, 255]] });
  assert.equal(mixed.cols.length, 4);
});

test('not the shared still (sync off / own picture / preview): cols from the painted row; unknown -> none', () => {
  const blurred = [[50, 60, 70], [80, 90, 100]];
  const top = T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 0, washOk: false, blurred });
  assert.equal(top.kind, 'cols');
  assert.deepEqual(top.cols, [[30, 35, 41], [45, 50, 56]]);
  assert.deepEqual(T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 0, washOk: false, blurred: null }), { kind: 'none' });
  assert.deepEqual(T.topFor({ theme: 'dark', photo: true, dim: 0.5, home: 1, clear: null }), { kind: 'none' });
});

test('light theme is sent too, with the light wash (island white)', () => {
  assert.deepEqual(T.topFor({ theme: 'light', photo: true, dim: 0.3, home: 0, washOk: true }), { kind: 'wash', rgb: [255, 255, 255], alpha: 0.3 });
});

test('spans: equal spans of one device row, left to right; colCount caps at MAX_COLS', () => {
  const W = 10, row = new Uint8ClampedArray(W * 4);
  for (let x = 0; x < W; x++) row.set([x < 5 ? 0 : 200, 10, 20, 255], x * 4);
  assert.deepEqual(T.spans(row, W, 2), [[0, 10, 20], [200, 10, 20]]);
  assert.equal(T.spans(row, W, 50).length, 10);
  assert.equal(T.colCount(1440), 180);
  assert.equal(T.colCount(3840), T.MAX_COLS);
  assert.equal(T.colCount(0), 1);
  // the biggest cols hint fits the protocol's 8 KB line
  const big = { v: 1, app: 'helm', hwnd: '18446744073709551615', seq: 1e9, t: Date.now(), top: { kind: 'cols', cols: Array.from({ length: T.MAX_COLS }, () => [255, 255, 255]) } };
  assert.ok(JSON.stringify(big).length + 1 <= MAX_LINE);
});

test('cleanTop: only protocol TOPs pass', () => {
  assert.deepEqual(cleanTop({ kind: 'wash', rgb: [9, 10, 11], alpha: 0.5, extra: 1 }), { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 });
  assert.equal(cleanTop({ kind: 'wash', rgb: [9, 10, 11], alpha: 1.5 }), null);
  assert.equal(cleanTop({ kind: 'flat', rgb: [9, 10, 256] }), null);
  assert.equal(cleanTop({ kind: 'flat', rgb: [9.5, 10, 11] }), null);
  assert.equal(cleanTop({ kind: 'cols', cols: [] }), null);
  assert.deepEqual(cleanTop({ kind: 'none' }), { kind: 'none' });
  assert.equal(cleanTop({ kind: 'photo' }), null);
  assert.equal(cleanTop(null), null);
});

// ---------- the pipe client against a fake Mantle ----------
let pipeN = 0;
const pipeName = () => `\\\\.\\pipe\\helm-toprow-test-${process.pid}-${Date.now().toString(36)}-${pipeN++}`;
function fakeMantle(name) {
  const lines = [];
  const socks = new Set();
  const server = net.createServer((s) => {
    socks.add(s);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push({ at: Date.now(), raw: buf.slice(0, i), msg: JSON.parse(buf.slice(0, i)) }); buf = buf.slice(i + 1); }
    });
    s.on('close', () => socks.delete(s));
    s.on('error', () => {});
  });
  return new Promise((res) => server.listen(name, () => res({
    lines,
    close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  })));
}
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

test('no Mantle: no throw, status says not running, retries no faster than every 2 s', async () => {
  const name = pipeName();
  let opens = 0;
  const logs = [];
  const tr = createTopRow({ pipe: name, connect: (p) => { opens++; return net.connect(p); }, log: (m) => logs.push(m), retryMs: 500 });
  tr.start();
  assert.equal(tr.set('123', { kind: 'flat', rgb: [1, 2, 3] }), false);   // kept, not sent
  await until(() => tr.state().state === 'not-running');
  assert.equal(tr.state().state, 'not-running');
  assert.match(tr.state().reason, /nothing is listening/);
  await sleep(2300);
  tr.stop();
  assert.ok(opens >= 1 && opens <= 2, `attempts in 2.3 s: ${opens}`);
  assert.equal(logs.length, 1, 'logs only on a state change: ' + JSON.stringify(logs));
});

test('fake Mantle: every window on connect, then each change at once, seq increasing per hwnd', async () => {
  const name = pipeName();
  const m = await fakeMantle(name);
  const tr = createTopRow({ pipe: name });
  tr.set('100', { kind: 'flat', rgb: [29, 31, 34] });      // window create, before the connection
  tr.set('100', { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 });
  tr.set('200', { kind: 'none' });
  tr.start();
  assert.ok(await until(() => m.lines.length >= 2), 'both windows on connect');
  assert.equal(tr.state().state, 'connected');
  const first = m.lines.map((l) => l.msg);
  assert.deepEqual(first.map((x) => x.hwnd).sort(), ['100', '200']);
  for (const x of first) { assert.equal(x.v, 1); assert.equal(x.app, 'helm'); assert.equal(typeof x.t, 'number'); }
  assert.deepEqual(first.find((x) => x.hwnd === '100').top, { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 });
  // a scripted run of changes: each goes out at once, in order
  const script = [
    { kind: 'cols', cols: [[10, 20, 30], [40, 50, 60]] },
    { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 },
    { kind: 'wash', rgb: [8, 9, 10], alpha: 0.74 },
    { kind: 'flat', rgb: [15, 16, 17] },
  ];
  const sentAt = [];
  for (const top of script) { sentAt.push(Date.now()); assert.equal(tr.set('100', top), true); }
  assert.ok(await until(() => m.lines.length >= 2 + script.length));
  const got = m.lines.slice(2).map((l) => l.msg);
  assert.deepEqual(got.map((x) => x.top), script);
  const seqs = m.lines.map((l) => l.msg).filter((x) => x.hwnd === '100').map((x) => x.seq);
  assert.ok(seqs.every((v, i) => i === 0 || v > seqs[i - 1]), 'seq increases: ' + seqs);
  // latency: written in the same tick, received within a few ms on a local pipe
  const lat = m.lines.slice(2).map((l, i) => l.at - sentAt[i]);
  assert.ok(Math.max(...lat) < 100, 'pipe latency ms: ' + lat);
  // close: none, then forgotten
  tr.forget('100');
  assert.ok(await until(() => m.lines.length >= 3 + script.length));
  assert.deepEqual(m.lines[m.lines.length - 1].msg.top, { kind: 'none' });
  assert.equal(tr.last('100'), null);
  // a bad TOP is refused, nothing sent
  assert.equal(tr.set('200', { kind: 'flat', rgb: [300, 0, 0] }), false);
  tr.stop();
  await m.close();
});

test('Mantle restarts: reconnects (2 s backoff) and re-sends every window with a newer seq', async () => {
  const name = pipeName();
  let m = await fakeMantle(name);
  const tr = createTopRow({ pipe: name });
  tr.start();
  tr.set('7', { kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 });
  assert.ok(await until(() => m.lines.length >= 1));
  const seqBefore = m.lines[m.lines.length - 1].msg.seq;
  await m.close();
  assert.ok(await until(() => tr.state().state === 'not-running'));
  tr.set('7', { kind: 'flat', rgb: [1, 1, 1] });   // changed while Mantle was away: kept
  m = await fakeMantle(name);
  const t0 = Date.now();
  assert.ok(await until(() => m.lines.length >= 1, 5000), 'reconnected');
  assert.ok(Date.now() - t0 <= 4500);
  const again = m.lines[0].msg;
  assert.deepEqual(again.top, { kind: 'flat', rgb: [1, 1, 1] });
  assert.ok(again.seq > seqBefore);
  assert.equal(tr.state().state, 'connected');
  tr.stop();
  await m.close();
});

test('off (a --test run without HELM_TOPROW_PIPE): never connects, says why', () => {
  const tr = createTopRow({ pipe: null, offReason: 'Off in test runs', connect: () => { throw new Error('must not connect'); } });
  tr.start();
  assert.equal(tr.set('1', { kind: 'none' }), false);
  assert.deepEqual([tr.state().state, tr.state().reason], ['off', 'Off in test runs']);
  tr.stop();
});

test('parseScrim: the painted scrim colour of a modal / the palette', async () => {
  const { parseScrim } = await import('../../ui/lib/top-scrim.js');
  assert.deepEqual(parseScrim('rgba(0, 0, 0, 0.26)'), { rgb: [0, 0, 0], a: 0.26 });
  assert.deepEqual(parseScrim('rgb(6, 7, 8)'), { rgb: [6, 7, 8], a: 1 });
  assert.equal(parseScrim('transparent'), null);
});
