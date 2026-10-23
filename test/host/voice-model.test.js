// Unit tests for ui/lib/voice-model.js: the pure half of composer voice input. Covers the reduce() state
// machine (every transition, no-ops returning the same object, stale seq, garbage), tap-vs-hold, the mic
// and rpc error reasons, the streaming 16 kHz resampler (length, frequency, level, anti-alias, chunking),
// Int16 / base64 encoding, level and silence rules, time formatting, and the status / button words.
// The module is ESM with no imports, so require(esm) loads it directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const V = require('../../ui/lib/voice-model.js');

// a state in `state` with seq 3 and any overrides
const mk = (state, extra = {}) => ({ ...V.initial(), state, seq: 3, ...extra });
const listening = (extra = {}) => mk('listening', { startedAt: 1000, ...extra });
const sine = (freq, rate, seconds = 1, amp = 0.5) => {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};
const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const zeroCrossFreq = (a, rate, from, to) => {
  let c = 0;
  for (let i = from + 1; i < to; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) c++;
  return c / 2 / ((to - from) / rate);
};

test('constants and initial(): the numbers the shell and the engine rely on', () => {
  assert.equal(V.RATE, 16000);
  assert.equal(V.MAX_MS, 120000);
  assert.equal(V.MAX_SAMPLES, 1920000);
  assert.deepEqual([...V.STATES], ['idle', 'starting', 'listening', 'transcribing', 'error', 'unavailable']);
  assert.ok(Object.isFrozen(V.STATES));
  assert.deepEqual(V.initial(), { state: 'idle', reason: '', retry: false, loading: false, startedAt: 0, audioMs: 0, limit: false, seq: 0 });
  assert.notEqual(V.initial(), V.initial());
});

test('reduce press: idle / error / unavailable start a fresh take (seq + 1); busy states ignore it (same object)', () => {
  for (const s of ['idle', 'error', 'unavailable']) {
    const st = mk(s, { reason: 'old', retry: true, loading: true, startedAt: 55, audioMs: 900, limit: true });
    const next = V.reduce(st, { type: 'press', at: 10 });
    assert.deepEqual(next, { ...V.initial(), state: 'starting', seq: 4 }, `press from ${s}`);
  }
  for (const s of ['starting', 'listening', 'transcribing']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'press', at: 10 }), st, `press ignored while ${s}`);
  }
});

test('reduce mic-ready: starting -> listening with startedAt; elsewhere a no-op', () => {
  const next = V.reduce(mk('starting', { loading: true }), { type: 'mic-ready', at: 5000 });
  assert.equal(next.state, 'listening');
  assert.equal(next.startedAt, 5000);
  assert.equal(next.loading, true);
  assert.equal(next.seq, 3);
  assert.equal(V.reduce(mk('starting'), { type: 'mic-ready', at: 'junk' }).startedAt, 0);
  for (const s of ['idle', 'listening', 'transcribing', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'mic-ready', at: 1 }), st, `mic-ready while ${s}`);
  }
});

test('reduce loading / warm-ok: toggle `loading` only in busy states, and only when it changes', () => {
  for (const s of ['starting', 'listening', 'transcribing']) {
    const st = mk(s);
    const on = V.reduce(st, { type: 'loading' });
    assert.deepEqual(on, { ...st, loading: true }, `loading while ${s}`);
    assert.equal(V.reduce(on, { type: 'loading' }), on, 'already loading: same object');
    const off = V.reduce(on, { type: 'warm-ok' });
    assert.deepEqual(off, st, `warm-ok while ${s}`);
    assert.equal(V.reduce(off, { type: 'warm-ok' }), off, 'not loading: same object');
  }
  for (const s of ['idle', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'loading' }), st, `loading while ${s}`);
    const st2 = mk(s, { loading: true });
    assert.equal(V.reduce(st2, { type: 'warm-ok' }), st2, `warm-ok while ${s}`);
  }
});

test('reduce warm-fail: any busy state -> unavailable with the reason (default when blank); elsewhere a no-op', () => {
  for (const s of ['starting', 'listening', 'transcribing']) {
    const next = V.reduce(mk(s, { loading: true }), { type: 'warm-fail', reason: '  Whisper is missing ' });
    assert.equal(next.state, 'unavailable', s);
    assert.equal(next.reason, 'Whisper is missing');
    assert.equal(next.retry, true);
    assert.equal(next.loading, false);
    for (const reason of ['', '   ', undefined, null]) {
      assert.equal(V.reduce(mk(s), { type: 'warm-fail', reason }).reason, 'Voice input is not available');
    }
  }
  for (const s of ['idle', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'warm-fail', reason: 'x' }), st, `warm-fail while ${s}`);
  }
});

test('reduce mic-fail: only from starting -> error with Retry', () => {
  const next = V.reduce(mk('starting', { loading: true }), { type: 'mic-fail', reason: 'No microphone found' });
  assert.equal(next.state, 'error');
  assert.equal(next.reason, 'No microphone found');
  assert.equal(next.retry, true);
  assert.equal(next.loading, false);
  assert.equal(V.reduce(mk('starting'), { type: 'mic-fail' }).reason, 'Could not start the microphone');
  for (const s of ['idle', 'listening', 'transcribing', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'mic-fail', reason: 'x' }), st, `mic-fail while ${s}`);
  }
});

test('reduce stop from starting -> idle; from listening: mis-tap / not heard / transcribing', () => {
  const fromStart = V.reduce(mk('starting', { loading: true }), { type: 'stop', at: 2000, peak: 1 });
  assert.equal(fromStart.state, 'idle');
  assert.equal(fromStart.loading, false);

  // < MIN_MS: a mis-tap, back to idle quietly
  const tap = V.reduce(listening({ loading: true }), { type: 'stop', at: 1000 + V.MIN_MS - 1, peak: 0.9 });
  assert.equal(tap.state, 'idle');
  assert.equal(tap.reason, '');
  assert.equal(tap.loading, false);
  assert.equal(tap.audioMs, V.MIN_MS - 1);
  // negative elapsed counts as 0 -> mis-tap
  assert.equal(V.reduce(listening(), { type: 'stop', at: 0, peak: 1 }).state, 'idle');

  // >= MIN_MS but never crossed SILENCE_PEAK
  const quiet = V.reduce(listening(), { type: 'stop', at: 1000 + V.MIN_MS, peak: V.SILENCE_PEAK - 0.001 });
  assert.equal(quiet.state, 'error');
  assert.equal(quiet.reason, V.NOT_HEARD);
  assert.equal(quiet.retry, true);
  assert.equal(quiet.audioMs, V.MIN_MS);
  assert.equal(V.reduce(listening(), { type: 'stop', at: 5000 }).state, 'error', 'missing peak = not heard');

  // heard: transcribing, audioMs from ev.at - startedAt
  const ok = V.reduce(listening(), { type: 'stop', at: 1000 + V.MIN_MS, peak: V.SILENCE_PEAK });
  assert.equal(ok.state, 'transcribing');
  assert.equal(ok.audioMs, V.MIN_MS);
  assert.equal(ok.limit, false);

  // ev.audioMs wins over the clock
  const byAudio = V.reduce(listening(), { type: 'stop', at: 999999, audioMs: 4321, peak: 0.5 });
  assert.equal(byAudio.state, 'transcribing');
  assert.equal(byAudio.audioMs, 4321);
  assert.equal(V.reduce(listening(), { type: 'stop', at: 999999, audioMs: 100, peak: 0.5 }).state, 'idle', 'short audioMs = mis-tap even if the clock says long');

  // clamped to MAX_MS, limit carried
  const long = V.reduce(listening(), { type: 'stop', at: 1000 + 500000, peak: 0.5, limit: true });
  assert.equal(long.audioMs, V.MAX_MS);
  assert.equal(long.limit, true);
  assert.equal(V.reduce(listening(), { type: 'stop', audioMs: 150000, peak: 0.5 }).audioMs, V.MAX_MS);

  for (const s of ['idle', 'transcribing', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'stop', at: 5000, peak: 1 }), st, `stop while ${s}`);
  }
});

test('reduce result: text -> idle; empty / whitespace / missing -> error NO_SPEECH; only while transcribing', () => {
  const tr = mk('transcribing', { audioMs: 3000, loading: true });
  const ok = V.reduce(tr, { type: 'result', text: 'hello world' });
  assert.equal(ok.state, 'idle');
  assert.equal(ok.loading, false);
  for (const text of ['', '   \n\t', undefined, null]) {
    const bad = V.reduce(tr, { type: 'result', text });
    assert.equal(bad.state, 'error', JSON.stringify(text));
    assert.equal(bad.reason, V.NO_SPEECH);
    assert.equal(bad.retry, true);
  }
  for (const s of ['idle', 'starting', 'listening', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'result', text: 'hi' }), st, `result while ${s}`);
  }
});

test('reduce fail: voice_unavailable (and unknown_method) -> unavailable, other codes -> error', () => {
  const tr = mk('transcribing', { loading: true });
  const un = V.reduce(tr, { type: 'fail', code: 'voice_unavailable', reason: 'no model' });
  assert.equal(un.state, 'unavailable');
  assert.equal(un.reason, 'no model');
  assert.equal(un.retry, true);
  assert.equal(un.loading, false);
  // failState() also maps unknown_method (an old laptop Helm) to unavailable
  assert.equal(V.reduce(tr, { type: 'fail', code: 'unknown_method', reason: 'x' }).state, 'unavailable');
  for (const code of ['voice_failed', 'disconnected', 'bad_params', undefined]) {
    const e = V.reduce(tr, { type: 'fail', code, reason: 'r' });
    assert.equal(e.state, 'error', String(code));
    assert.equal(e.reason, 'r');
  }
  assert.equal(V.reduce(tr, { type: 'fail', code: 'voice_failed' }).reason, 'Transcription failed');
  for (const s of ['idle', 'starting', 'listening', 'error', 'unavailable']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'fail', code: 'voice_failed' }), st, `fail while ${s}`);
  }
});

test('reduce cancel / dismiss: cancel ends any busy take (seq + 1); dismiss clears a failure; no-ops elsewhere', () => {
  for (const s of ['starting', 'listening', 'transcribing']) {
    const next = V.reduce(mk(s, { loading: true }), { type: 'cancel' });
    assert.equal(next.state, 'idle', s);
    assert.equal(next.seq, 4);
    assert.equal(next.loading, false);
  }
  for (const s of ['idle', 'error', 'unavailable']) {
    const st = mk(s, { reason: 'r' });
    assert.equal(V.reduce(st, { type: 'cancel' }), st, `cancel while ${s}`);
  }
  for (const s of ['error', 'unavailable']) {
    const next = V.reduce(mk(s, { reason: 'boom', retry: true }), { type: 'dismiss' });
    assert.equal(next.state, 'idle', s);
    assert.equal(next.reason, '');
    assert.equal(next.retry, false);
    assert.equal(next.seq, 3, 'dismiss keeps seq');
  }
  for (const s of ['idle', 'starting', 'listening', 'transcribing']) {
    const st = mk(s);
    assert.equal(V.reduce(st, { type: 'dismiss' }), st, `dismiss while ${s}`);
  }
});

test('reduce: stale seq is dropped, matching seq applies; garbage input returns st', () => {
  const tr = mk('transcribing');
  assert.equal(V.reduce(tr, { type: 'result', text: 'hi', seq: 2 }), tr);
  assert.equal(V.reduce(tr, { type: 'result', text: 'hi', seq: 4 }), tr);
  assert.equal(V.reduce(tr, { type: 'result', text: 'hi', seq: 3 }).state, 'idle');
  const st = mk('starting');
  assert.equal(V.reduce(st, { type: 'mic-ready', at: 1, seq: 0 }), st);
  for (const ev of [null, undefined, {}, { type: 5 }, { type: 'bogus' }, { type: '' }, 'press']) {
    assert.equal(V.reduce(st, ev), st, JSON.stringify(ev));
  }
  assert.equal(V.reduce(null, { type: 'press' }), null);
  assert.equal(V.reduce(undefined, { type: 'press' }), undefined);
});

test('walks: a full happy path, and a cancel whose late result (old seq) is dropped', () => {
  let st = V.initial();
  st = V.reduce(st, { type: 'press', at: 100 });
  assert.equal(st.state, 'starting');
  const seq = st.seq;
  assert.equal(seq, 1);
  st = V.reduce(st, { type: 'loading', seq });
  assert.equal(st.loading, true);
  st = V.reduce(st, { type: 'mic-ready', at: 200, seq });
  assert.equal(st.state, 'listening');
  st = V.reduce(st, { type: 'warm-ok', seq });
  assert.equal(st.loading, false);
  st = V.reduce(st, { type: 'stop', at: 3200, peak: 0.4, seq });
  assert.deepEqual(st, { state: 'transcribing', reason: '', retry: false, loading: false, startedAt: 200, audioMs: 3000, limit: false, seq: 1 });
  st = V.reduce(st, { type: 'result', text: 'hello', seq });
  assert.equal(st.state, 'idle');

  // cancel while transcribing, then the old take's result arrives
  let c = V.reduce(V.initial(), { type: 'press', at: 0 });
  const old = c.seq;
  c = V.reduce(c, { type: 'mic-ready', at: 0, seq: old });
  c = V.reduce(c, { type: 'stop', at: 2000, peak: 0.5, seq: old });
  assert.equal(c.state, 'transcribing');
  c = V.reduce(c, { type: 'cancel' });
  assert.equal(c.state, 'idle');
  assert.equal(V.reduce(c, { type: 'result', text: 'late', seq: old }), c, 'late result dropped while idle');
  // and still dropped once a new take is transcribing
  c = V.reduce(c, { type: 'press', at: 5000 });
  c = V.reduce(c, { type: 'mic-ready', at: 5000, seq: c.seq });
  c = V.reduce(c, { type: 'stop', at: 7000, peak: 0.5, seq: c.seq });
  assert.equal(c.state, 'transcribing');
  assert.notEqual(c.seq, old);
  assert.equal(V.reduce(c, { type: 'result', text: 'late', seq: old }), c, 'late result dropped during the next take');
  assert.equal(V.reduce(c, { type: 'fail', code: 'voice_failed', seq: old }), c, 'late fail dropped too');
});

test('pressAction / isHold / releaseAction: tap vs push-to-talk', () => {
  assert.equal(V.pressAction('idle'), 'start');
  assert.equal(V.pressAction('error'), 'start');
  assert.equal(V.pressAction('unavailable'), 'start');
  assert.equal(V.pressAction('starting'), 'stop');
  assert.equal(V.pressAction('listening'), 'stop');
  assert.equal(V.pressAction('transcribing'), 'none');
  assert.equal(V.HOLD_MS, 350);
  assert.equal(V.isHold(349), false);
  assert.equal(V.isHold(350), true);
  assert.equal(V.isHold(V.HOLD_MS), true);
  assert.equal(V.isHold('junk'), false);
  assert.equal(V.releaseAction(500, true), 'stop');
  assert.equal(V.releaseAction(V.HOLD_MS, true), 'stop');
  assert.equal(V.releaseAction(349, true), 'keep');
  assert.equal(V.releaseAction(5000, false), 'keep');
});

test('micErrorReason: each getUserMedia failure in plain words, desktop vs phone', () => {
  for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) {
    const d = V.micErrorReason({ name }, { desktop: true });
    assert.ok(d.includes('Windows Settings > Privacy & security > Microphone'), d);
    const p = V.micErrorReason({ name });
    assert.ok(p.includes('allow the microphone for this site'), p);
    assert.ok(!p.includes('Windows'), p);
  }
  for (const name of ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError']) {
    assert.equal(V.micErrorReason({ name }), 'No microphone found');
  }
  for (const name of ['NotReadableError', 'TrackStartError', 'AbortError']) {
    assert.ok(V.micErrorReason({ name }, { desktop: true }).includes('in use by another app'), name);
  }
  const nm = V.micErrorReason({ name: 'NoMediaDevices' });
  assert.ok(nm.includes('secure page') && nm.includes('https') && nm.includes('Settings > Phone'), nm);
  assert.equal(V.micErrorReason({ name: 'WeirdError', message: ' device exploded ' }), 'Could not start the microphone: device exploded');
  assert.equal(V.micErrorReason({ name: 'WeirdError' }), 'Could not start the microphone');
  assert.equal(V.micErrorReason(null), 'Could not start the microphone');
  assert.equal(V.micErrorReason(undefined, { desktop: true }), 'Could not start the microphone');
});

test('rpcErrorReason + failState: every code', () => {
  const cases = [
    [{ code: 'unknown_method' }, /restart Helm there/, 'unavailable'],
    [{ code: 'disconnected', message: 'socket closed' }, /^Lost the connection to Helm on the laptop$/, 'error'],
    [{ code: 'voice_unavailable', message: 'whisper.exe missing' }, /^whisper\.exe missing$/, 'unavailable'],
    [{ code: 'voice_unavailable' }, /^Voice input is not available on the laptop$/, 'unavailable'],
    [{ code: 'voice_failed', message: 'decoder crashed' }, /^Transcription failed: decoder crashed$/, 'error'],
    [{ code: 'voice_failed' }, /^Transcription failed$/, 'error'],
    [{ code: 'bad_params', message: 'pcm too long' }, /^pcm too long$/, 'error'],
    [{ code: 'bad_params' }, /^Voice input failed$/, 'error'],
    [{ message: 'boom' }, /^boom$/, 'error'],
    [null, /^Voice input failed$/, 'error'],
    [undefined, /^Voice input failed$/, 'error'],
  ];
  for (const [err, re, state] of cases) {
    assert.match(V.rpcErrorReason(err), re, JSON.stringify(err));
    assert.equal(V.failState(err), state, JSON.stringify(err));
  }
});

test('downsample: 1 s of 440 Hz at 48 k and 44.1 k -> 16000 samples, same pitch, same level', () => {
  for (const from of [48000, 44100]) {
    const out = V.downsample(sine(440, from), from);
    assert.ok(out instanceof Float32Array);
    assert.equal(out.length, 16000, `${from}`);
    const f = zeroCrossFreq(out, 16000, 200, 15800);
    assert.ok(Math.abs(f - 440) <= 3, `${from}: ${f} Hz`);
    const r = rms(out, 200, 15800);
    assert.ok(Math.abs(r - 0.5 / Math.SQRT2) / (0.5 / Math.SQRT2) <= 0.02, `${from}: rms ${r}`);
  }
});

test('downsample: identity at 16 k, doubling at 8 k, anti-alias filter at 48 k', () => {
  const x = sine(440, 16000, 0.5);
  const same = V.downsample(x, 16000);
  assert.equal(same.length, x.length);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(same[i] - x[i]) <= 1e-6, `i=${i}`);

  const up = V.downsample(sine(440, 8000, 0.25), 8000);
  assert.equal(up.length, 4000);

  // 12 kHz is above the 8 kHz Nyquist of the output: it must not fold back in
  const alias = V.downsample(sine(12000, 48000), 48000);
  const ra = rms(alias, 200, alias.length - 200);
  assert.ok(ra < 1e-3, `12 kHz leaked: rms ${ra}`);
  // 6 kHz is below the 7.2 kHz cutoff: it passes
  const pass = V.downsample(sine(6000, 48000), 48000);
  const rp = rms(pass, 200, pass.length - 200);
  assert.ok(Math.abs(rp - 0.5 / Math.SQRT2) / (0.5 / Math.SQRT2) <= 0.05, `6 kHz rms ${rp}`);
});

test('makeResampler: odd-sized streaming chunks + flush == one shot; length = ceil(n x 16000 / from); bad rates throw', () => {
  for (const from of [48000, 44100]) {
    const x = sine(440, from, 0.7);
    const once = V.downsample(x, from);
    const r = V.makeResampler(from);
    const parts = [];
    const sizes = [1000, 1, 37, 4096];
    for (let i = 0, j = 0; i < x.length; j++) {
      const n = sizes[j % sizes.length];
      parts.push(r.push(x.subarray(i, i + n)));
      i += n;
    }
    parts.push(r.flush());
    const streamed = V.concat(parts);
    assert.equal(streamed.length, once.length, `${from}`);
    for (let i = 0; i < once.length; i++) {
      if (streamed[i] !== once[i]) assert.fail(`${from}: sample ${i}: ${streamed[i]} !== ${once[i]}`);
    }
  }
  const r = V.makeResampler(48000);
  const empty = r.push(new Float32Array(0));
  assert.ok(empty instanceof Float32Array);
  assert.equal(empty.length, 0);
  assert.equal(r.push([]).length, 0);
  assert.equal(r.push(null).length, 0);

  assert.throws(() => V.makeResampler(0), RangeError);
  assert.throws(() => V.makeResampler(-1), RangeError);
  assert.throws(() => V.makeResampler(48000, 0), RangeError);
  assert.throws(() => V.makeResampler(NaN), RangeError);

  for (const from of [48000, 44100]) {
    for (const n of [1, 2, 3, 4801, 44101]) {
      const x = new Float32Array(n).fill(0.25);
      assert.equal(V.downsample(x, from).length, Math.ceil((n * 16000) / from), `from ${from}, n ${n}`);
    }
  }
});

test('floatToInt16 / int16ToBase64 / base64ToInt16 / encodePcm: clamping, little-endian, round trip', () => {
  assert.deepEqual([...V.floatToInt16([2, -2, NaN, Infinity, -Infinity, 0.5, -0.5, 1, -1, 0])],
    [32767, -32768, 0, 0, 0, 16384, -16384, 32767, -32768, 0]);
  assert.deepEqual([...Buffer.from(V.int16ToBase64(Int16Array.from([1, -2])), 'base64')], [0x01, 0x00, 0xfe, 0xff]);
  assert.equal(V.int16ToBase64(new Int16Array(0)), '');
  assert.equal(V.base64ToInt16('').length, 0);
  assert.equal(V.base64ToInt16(null).length, 0);

  // odd length, more than two 0x8000-byte chunks of bytes, extremes included
  const n = 0x8000 * 2 + 4321;
  const x = new Int16Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; x[i] = (seed >>> 8) & 0xffff; }
  x[0] = -32768; x[1] = 32767; x[n - 1] = -32768; x[0x4000] = 32767; x[0x4001] = -1;
  const back = V.base64ToInt16(V.int16ToBase64(x));
  assert.equal(back.length, n);
  assert.deepEqual(back, x);
  // node's own decoder agrees on the bytes
  const viaBuffer = Buffer.from(V.int16ToBase64(x), 'base64');
  assert.equal(viaBuffer.readInt16LE(2), 32767);
  assert.equal(viaBuffer.readInt16LE(0), -32768);

  const f = Float32Array.from([0, 0.1, -0.7, 1.5, -3, 0.999]);
  assert.equal(V.encodePcm(f), V.int16ToBase64(V.floatToInt16(f)));
});

test('peakOf / heard / meterLevel / smoothLevel', () => {
  assert.equal(V.peakOf(Float32Array.from([0.1, -0.8, 0.5])), Math.fround(0.8));
  assert.equal(V.peakOf(new Float32Array(0)), 0);
  assert.equal(V.heard(V.SILENCE_PEAK), true);
  assert.equal(V.heard(V.SILENCE_PEAK - 1e-6), false);
  assert.equal(V.heard(undefined), false);

  assert.equal(V.meterLevel(0), 0);
  assert.equal(V.meterLevel(-1), 0);
  assert.equal(V.meterLevel(1), 1);
  assert.equal(V.meterLevel(2), 1);
  assert.equal(V.meterLevel(1e-6), 0, 'below -54 dB = empty');
  let prev = -1;
  for (let p = 0.001; p <= 1; p *= 1.3) {
    const m = V.meterLevel(p);
    assert.ok(m >= prev && m >= 0 && m <= 1, `p=${p} m=${m}`);
    prev = m;
  }

  assert.equal(V.smoothLevel(0.2, 0.8, 16), 0.8, 'rises at once');
  assert.ok(Math.abs(V.smoothLevel(1, 0, 100) - 0.84) < 1e-12, 'falls by 1.6/s');
  assert.ok(Math.abs(V.smoothLevel(1, 0, 100, 2) - 0.8) < 1e-12, 'custom perSecond');
  assert.equal(V.smoothLevel(0.5, 0.45, 100), 0.45, 'never below the new value');
  assert.equal(V.smoothLevel(0.1, 0, 1000), 0, 'never negative');
  assert.equal(V.smoothLevel(0.5, 0, -100), 0.5, 'negative dt = no fall');
});

test('samplesToMs / limitReached / fmtElapsed / fmtSeconds', () => {
  assert.equal(V.samplesToMs(16000), 1000);
  assert.equal(V.samplesToMs(V.MAX_SAMPLES), V.MAX_MS);
  assert.equal(V.samplesToMs(48000, 48000), 1000);
  assert.equal(V.limitReached(119999), false);
  assert.equal(V.limitReached(120000), true);
  assert.equal(V.limitReached(undefined), false);
  assert.equal(V.fmtElapsed(0), '0:00');
  assert.equal(V.fmtElapsed(999), '0:00');
  assert.equal(V.fmtElapsed(61000), '1:01');
  assert.equal(V.fmtElapsed(120000), '2:00');
  assert.equal(V.fmtElapsed(-5000), '0:00');
  assert.equal(V.fmtSeconds(0), '1 s');
  assert.equal(V.fmtSeconds(5800), '6 s');
  assert.equal(V.fmtSeconds(120000), '120 s');
});

test('statusText: every state, desktop vs phone', () => {
  // starting
  const sd = V.statusText(mk('starting'));
  assert.equal(sd.text, 'Starting the microphone…');
  assert.equal(sd.hint, 'Esc cancels');
  const sdl = V.statusText(mk('starting', { loading: true }));
  assert.ok(sdl.text.includes('speech model is loading'), sdl.text);
  assert.deepEqual(V.statusText(mk('starting'), { phone: true }), { text: 'Starting the mic…', hint: '' });
  assert.ok(V.statusText(mk('starting', { loading: true }), { phone: true }).text.includes('loading the speech model'));

  // listening
  assert.deepEqual(V.statusText(mk('listening'), { elapsedMs: 61000 }), { text: '1:01', hint: 'Ctrl+M or click to stop · Esc cancels' });
  assert.deepEqual(V.statusText(mk('listening'), { elapsedMs: 61000, phone: true }), { text: '1:01', hint: 'Tap the mic to stop' });
  assert.equal(V.statusText(mk('listening'), { elapsedMs: 109999 }).text, '1:49', 'more than 10 s left: no note');
  assert.equal(V.statusText(mk('listening'), { elapsedMs: 110000 }).text, '1:50 · stops in 10 s');
  assert.equal(V.statusText(mk('listening'), { elapsedMs: 115500 }).text, '1:55 · stops in 5 s');
  assert.equal(V.statusText(mk('listening'), { elapsedMs: 130000 }).text, '2:10 · stops in 0 s');

  // transcribing
  assert.deepEqual(V.statusText(mk('transcribing', { audioMs: 5800 })), { text: 'Transcribing 6 s…', hint: 'Esc cancels' });
  assert.deepEqual(V.statusText(mk('transcribing', { audioMs: 5800 }), { phone: true }), { text: 'Transcribing 6 s…', hint: '' });
  assert.equal(V.statusText(mk('transcribing', { audioMs: 120000, limit: true })).text, `${V.LIMIT_NOTE} · Transcribing 120 s…`);
  assert.equal(V.statusText(mk('transcribing', { audioMs: 2000, loading: true })).text, 'Transcribing 2 s… (loading the speech model first)');
  assert.equal(V.statusText(mk('transcribing', { audioMs: 2000, loading: true }), { phone: true }).text, 'Transcribing 2 s… (loading the model)');

  // failures show the reason (with a fallback), no hint
  for (const phone of [false, true]) {
    assert.deepEqual(V.statusText(mk('error', { reason: 'No microphone found' }), { phone }), { text: 'No microphone found', hint: '' });
    assert.deepEqual(V.statusText(mk('unavailable', { reason: 'no model' }), { phone }), { text: 'no model', hint: '' });
  }
  assert.equal(V.statusText(mk('error')).text, 'Voice input failed');
  assert.equal(V.statusText(mk('unavailable')).text, 'Voice input is not available');

  // idle / garbage
  assert.deepEqual(V.statusText(mk('idle')), { text: '', hint: '' });
  assert.deepEqual(V.statusText(null), { text: '', hint: '' });
});

test('buttonLabel: the shortcut on the desktop only; failures carry the reason', () => {
  const idleD = V.buttonLabel(mk('idle'));
  assert.ok(idleD.includes('Ctrl+M'), idleD);
  const idleP = V.buttonLabel(mk('idle'), { phone: true });
  assert.ok(!idleP.includes('Ctrl'), idleP);
  assert.ok(idleP.startsWith('Dictate'), idleP);

  const err = V.buttonLabel(mk('error', { reason: 'No microphone found' }));
  assert.ok(err.includes('No microphone found') && err.includes('Ctrl+M'), err);
  const errP = V.buttonLabel(mk('error', { reason: 'No microphone found' }), { phone: true });
  assert.ok(errP.includes('No microphone found') && !errP.includes('Ctrl'), errP);
  const un = V.buttonLabel(mk('unavailable', { reason: 'no model' }));
  assert.ok(un.includes('no model') && un.includes('Ctrl+M') && un.includes('unavailable'), un);
  assert.ok(V.buttonLabel(mk('unavailable')).includes('no reason given'));
  assert.ok(V.buttonLabel(mk('error')).includes('failed'));

  assert.equal(V.buttonLabel(mk('starting')), 'Cancel the microphone (Ctrl+M)');
  assert.equal(V.buttonLabel(mk('listening'), { phone: true }), 'Stop and transcribe');
  assert.equal(V.buttonLabel(mk('transcribing')), 'Transcribing…');
  assert.equal(V.buttonLabel(null), 'Dictate (Ctrl+M: tap to start and stop, hold to talk)');
});
