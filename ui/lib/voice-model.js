// Voice input for the composer: the pure half (state machine, tap-vs-hold, error reasons, 16 kHz
// resampling, PCM encoding, level / silence rules, status text). No DOM and no imports, so node tests
// load it directly (test/host/voice-model.test.js). ui/composer/voice.js is the thin WebAudio/DOM shell
// around it. The engine is local Whisper on the laptop (main/voice/), reached through the same rpc on the
// desktop and the phone: voice.status, voice.warm, voice.transcribe { pcm: base64 Int16 LE mono 16 kHz }.
// Audio only ever lives in memory: nothing here stores anything.
//
// States: idle -> starting (mic opening, model warming in parallel) -> listening -> transcribing -> idle,
// with error (dismissable, Retry) and unavailable (the engine said why) as the failure ends.

export const RATE = 16000;            // what voice.transcribe takes
export const MAX_MS = 120_000;        // a take stops itself here (the engine refuses more)
export const MAX_SAMPLES = (RATE * MAX_MS) / 1000;
export const HOLD_MS = 350;           // Ctrl+M / mic held this long, then released = push-to-talk
export const MIN_MS = 300;            // shorter takes are a mis-tap: back to idle quietly
export const SILENCE_PEAK = 0.015;    // peak (0..1) the take must cross at least once (~ -36 dBFS)
export const STATES = Object.freeze(['idle', 'starting', 'listening', 'transcribing', 'error', 'unavailable']);

export const NOT_HEARD = "Didn't hear anything - check the microphone";
export const NO_SPEECH = 'No speech recognised';
export const LIMIT_NOTE = 'Stopped at the 2 min limit';

export const isRecording = (state) => state === 'starting' || state === 'listening';
export const isBusy = (state) => isRecording(state) || state === 'transcribing';
export const isFailure = (state) => state === 'error' || state === 'unavailable';

export const initial = () => ({ state: 'idle', reason: '', retry: false, loading: false, startedAt: 0, audioMs: 0, limit: false, seq: 0 });

// ---- the state machine ----
// reduce(st, ev) -> the next state, or `st` itself (same object) when the event does not apply here, so
// the shell can tell a no-op. Events from async work carry the `seq` of the take they belong to; a stale
// one (an older take, or one cancelled since) is dropped.
//   press      { at }                 idle | error | unavailable -> starting (a new take, seq + 1)
//   mic-ready  { at }                 starting -> listening (the clock starts here)
//   loading    {}                     starting | listening | transcribing: the model is still loading
//   warm-ok    {}                     ditto: the model is ready
//   warm-fail  { reason }             starting | listening | transcribing -> unavailable (stop the mic)
//   mic-fail   { reason }             starting -> error (Retry)
//   stop       { at, peak, audioMs?, limit? }
//                                     starting -> idle (nothing captured yet)
//                                     listening -> idle (< MIN_MS: a mis-tap) | error (never heard
//                                     anything) | transcribing
//   result     { text }               transcribing -> idle (text goes in) | error (no speech)
//   fail       { code, reason }       transcribing -> error | unavailable (voice_unavailable, unknown_method)
//   cancel     {}                     starting | listening | transcribing -> idle, the audio dropped
//   dismiss    {}                     error | unavailable -> idle
export function reduce(st, ev) {
  if (!st || !ev || typeof ev.type !== 'string') return st;
  if (ev.seq != null && ev.seq !== st.seq) return st;
  const s = st.state;
  switch (ev.type) {
    case 'press':
      if (s !== 'idle' && !isFailure(s)) return st;
      return { ...initial(), state: 'starting', seq: st.seq + 1 };
    case 'mic-ready':
      if (s !== 'starting') return st;
      return { ...st, state: 'listening', startedAt: num(ev.at) };
    case 'loading':
      if (!isBusy(s) || st.loading) return st;
      return { ...st, loading: true };
    case 'warm-ok':
      if (!isBusy(s) || !st.loading) return st;
      return { ...st, loading: false };
    case 'warm-fail':
      if (!isBusy(s)) return st;
      return { ...st, state: 'unavailable', reason: text(ev.reason, 'Voice input is not available'), retry: true, loading: false };
    case 'mic-fail':
      if (s !== 'starting') return st;
      return { ...st, state: 'error', reason: text(ev.reason, 'Could not start the microphone'), retry: true, loading: false };
    case 'stop': {
      if (s === 'starting') return { ...st, state: 'idle', loading: false };
      if (s !== 'listening') return st;
      const ms = Math.min(MAX_MS, Math.max(0, ev.audioMs != null ? num(ev.audioMs) : num(ev.at) - st.startedAt));
      if (ms < MIN_MS) return { ...st, state: 'idle', loading: false, audioMs: ms };
      if (!heard(ev.peak)) return { ...st, state: 'error', reason: NOT_HEARD, retry: true, loading: false, audioMs: ms };
      return { ...st, state: 'transcribing', audioMs: ms, limit: !!ev.limit };
    }
    case 'result':
      if (s !== 'transcribing') return st;
      if (String(ev.text ?? '').trim()) return { ...st, state: 'idle', loading: false };
      return { ...st, state: 'error', reason: NO_SPEECH, retry: true, loading: false };
    case 'fail':
      if (s !== 'transcribing') return st;
      return { ...st, state: failState(ev), reason: text(ev.reason, 'Transcription failed'), retry: true, loading: false };
    case 'cancel':
      if (!isBusy(s)) return st;
      return { ...st, state: 'idle', loading: false, seq: st.seq + 1 };
    case 'dismiss':
      if (!isFailure(s)) return st;
      return { ...st, state: 'idle', reason: '', retry: false };
    default:
      return st;
  }
}

// ---- tap vs hold (Ctrl+M and the mic button) ----
// What a press does from this state: start a take, stop the one running, or nothing (transcribing).
export function pressAction(state) {
  if (state === 'idle' || isFailure(state)) return 'start';
  if (isRecording(state)) return 'stop';
  return 'none';
}
// A release only matters after the press that STARTED the take: held >= HOLD_MS = push-to-talk, so stop;
// shorter = a tap, keep listening until the next press.
export const isHold = (heldMs) => num(heldMs) >= HOLD_MS;
export function releaseAction(heldMs, startedByThisPress) {
  return startedByThisPress && isHold(heldMs) ? 'stop' : 'keep';
}

// ---- reasons, in plain words ----
// getUserMedia (and the audio graph after it) failed. `desktop` = Helm's own window (Electron): the fix is
// in Windows Settings; in a browser (the phone) it is the site's permission.
export function micErrorReason(err, { desktop = false } = {}) {
  const name = String(err?.name || '');
  if (name === 'NoMediaDevices') return 'The microphone needs a secure page: open Helm on the phone from its https:// link (Settings > Phone)';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return desktop ? 'Microphone blocked: allow it in Windows Settings > Privacy & security > Microphone' : 'Microphone blocked: allow the microphone for this site';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'No microphone found';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'The microphone is in use by another app';
  const msg = String(err?.message || '').trim();
  return msg ? `Could not start the microphone: ${msg}` : 'Could not start the microphone';
}
// An rpc rejection from voice.warm / voice.transcribe -> the reason to show.
export function rpcErrorReason(err) {
  const code = String(err?.code || '');
  if (code === 'unknown_method') return 'Helm on the laptop has no voice input yet: restart Helm there to update it';
  if (code === 'disconnected') return 'Lost the connection to Helm on the laptop';
  const msg = String(err?.message || '').trim();
  if (code === 'voice_unavailable') return msg || 'Voice input is not available on the laptop';
  if (code === 'voice_failed') return msg ? `Transcription failed: ${msg}` : 'Transcription failed';
  return msg || 'Voice input failed';
}
// error (try again) vs unavailable (the engine itself is missing or broken).
export function failState(err) {
  const code = String(err?.code || '');
  return code === 'voice_unavailable' || code === 'unknown_method' ? 'unavailable' : 'error';
}

// ---- resampling to 16 kHz ----
// Streaming: low-pass (Blackman-windowed sinc, cutoff 0.45 x the target rate) then linear interpolation at
// the output positions, so the mic's 44.1 / 48 kHz frames are converted as they arrive and stopping costs
// nothing. Samples before the first one count as 0. push(chunk) -> the 16 kHz samples it completes;
// flush() -> the rest (the take is n input samples -> ceil(n x to / from) output samples).
export function makeResampler(fromRate, toRate = RATE) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
  const step = fromRate / toRate;
  const taps = step > 1 ? lowpass(0.45 * toRate / fromRate, 32 * Math.ceil(step) + 1) : null;
  const half = taps ? (taps.length - 1) / 2 : 0;
  let buf = new Float32Array(0);   // input from absolute index `base` on
  let base = 0;
  let total = 0;                   // input samples pushed so far
  let k = 0;                       // next output sample; it sits at input position k * step

  const at = (i) => { const j = i - base; return j >= 0 && j < buf.length ? buf[j] : 0; };
  const n = taps ? taps.length : 0;
  const filtered = (i) => {
    if (!taps) return at(i);
    const j0 = i - half - base;
    let acc = 0;
    if (j0 >= 0 && j0 + n <= buf.length) { for (let t = 0; t < n; t++) acc += taps[t] * buf[j0 + t]; return acc; }   // the usual case
    for (let t = 0; t < n; t++) acc += taps[t] * at(i - half + t);   // the edges: 0 outside the take
    return acc;
  };
  const emit = (limit, end) => {
    const out = [];
    for (;;) {
      const p = k * step;
      if (p >= end) break;
      const i = Math.floor(p);
      if (i + 1 + half >= limit) break;   // needs input not here yet
      const f = p - i;
      const a = filtered(i);
      out.push(f ? a + (filtered(i + 1) - a) * f : a);
      k++;
    }
    // keep only what later outputs can still reach
    const keep = Math.floor(k * step) - half;
    if (keep > base) { const drop = Math.min(buf.length, keep - base); buf = buf.subarray(drop); base += drop; }
    return Float32Array.from(out);
  };
  return {
    push(chunk) {
      const c = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk || []);
      if (!c.length) return new Float32Array(0);
      const next = new Float32Array(buf.length + c.length);
      next.set(buf); next.set(c, buf.length);
      buf = next;
      total += c.length;
      return emit(total, Infinity);
    },
    flush() { return emit(Infinity, total); },
  };
}
// One shot: the whole take at once.
export function downsample(input, fromRate, toRate = RATE) {
  const r = makeResampler(fromRate, toRate);
  const a = r.push(input);
  const b = r.flush();
  return concat([a, b]);
}
function lowpass(fc, n) {   // fc = cutoff / sample rate, n odd; unity gain at DC
  const h = new Float64Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- encoding: Float32 -1..1 -> Int16 little-endian -> base64 (what voice.transcribe takes) ----
export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, Number.isFinite(f32[i]) ? f32[i] : 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}
export function int16ToBase64(i16) {
  const bytes = new Uint8Array(i16.length * 2);
  for (let i = 0; i < i16.length; i++) { const v = i16[i]; bytes[2 * i] = v & 0xff; bytes[2 * i + 1] = (v >> 8) & 0xff; }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToInt16(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); out[i] = v >= 0x8000 ? v - 0x10000 : v; }
  return out;
}
export const encodePcm = (f32) => int16ToBase64(floatToInt16(f32));

// ---- level, silence, time ----
export function peakOf(f32) {
  let p = 0;
  for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > p) p = a; }
  return p;
}
export const heard = (peak) => num(peak) >= SILENCE_PEAK;
// Peak -> 0..1 for the meter, on a dB scale (-54 dB = empty, 0 dB = full) so speech moves it visibly.
export function meterLevel(peak) {
  const p = num(peak);
  if (p <= 0) return 0;
  const db = 20 * Math.log10(p);
  return Math.max(0, Math.min(1, (db + 54) / 54));
}
// The meter rises at once and falls back gently (a fall of `perSecond` of full scale per second).
export function smoothLevel(prev, next, dtMs, perSecond = 1.6) {
  const fall = Math.max(0, num(prev) - (perSecond * Math.max(0, num(dtMs))) / 1000);
  return Math.max(num(next), fall);
}
export const samplesToMs = (n, rate = RATE) => (num(n) * 1000) / rate;
export const limitReached = (audioMs) => num(audioMs) >= MAX_MS;
export function fmtElapsed(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
export const fmtSeconds = (ms) => `${Math.max(1, Math.round(num(ms) / 1000))} s`;

// ---- words for the UI ----
// The status line under the box: { text, hint } (hint = the keys, desktop only). phone = short text.
export function statusText(st, { elapsedMs = 0, phone = false } = {}) {
  const s = st?.state;
  if (s === 'starting') {
    if (phone) return { text: st.loading ? 'Starting… loading the speech model' : 'Starting the mic…', hint: '' };
    return { text: st.loading ? 'Starting the microphone… the speech model is loading (first use takes a few seconds)' : 'Starting the microphone…', hint: 'Esc cancels' };
  }
  if (s === 'listening') {
    const left = MAX_MS - num(elapsedMs);
    const near = left <= 10_000 ? ` · stops in ${Math.max(0, Math.ceil(left / 1000))} s` : '';
    return { text: fmtElapsed(elapsedMs) + near, hint: phone ? 'Tap the mic to stop' : 'Ctrl+M or click to stop · Esc cancels' };
  }
  if (s === 'transcribing') {
    const lim = st.limit ? `${LIMIT_NOTE} · ` : '';
    const load = st.loading ? (phone ? ' (loading the model)' : ' (loading the speech model first)') : '';
    return { text: `${lim}Transcribing ${fmtSeconds(st.audioMs)}…${load}`, hint: phone ? '' : 'Esc cancels' };
  }
  if (isFailure(s)) return { text: st.reason || (s === 'unavailable' ? 'Voice input is not available' : 'Voice input failed'), hint: '' };
  return { text: '', hint: '' };
}
// The mic button's aria-label / title. The shortcut is named on the desktop only (the phone has no keys).
export function buttonLabel(st, { phone = false } = {}) {
  const s = st?.state;
  const key = phone ? '' : ' (Ctrl+M)';
  if (s === 'starting') return `Cancel the microphone${key}`;
  if (s === 'listening') return `Stop and transcribe${key}`;
  if (s === 'transcribing') return 'Transcribing…';
  if (s === 'unavailable') return `Voice input unavailable: ${st.reason || 'no reason given'}. Try again${key}`;
  if (s === 'error') return `Voice input: ${st.reason || 'failed'}. Try again${key}`;
  return phone ? 'Dictate: tap to start and stop, or hold to talk' : 'Dictate (Ctrl+M: tap to start and stop, hold to talk)';
}

// ---- helpers ----
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function text(v, fallback) { const s = String(v ?? '').trim(); return s || fallback; }
