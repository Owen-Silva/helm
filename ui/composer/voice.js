// Voice input for the composer: the WebAudio / DOM shell around ui/lib/voice-model.js (state machine,
// resampling, encoding and every rule live there, tested in node). Owner: lane voice.
//   useVoice({ id, idRef, enabled, onText }) -> { st, ctl }   one per Composer (split view: one per pane)
//   MicButton { voice, disabled }   button.cmp-mic[data-voice-state] in the tool row (bar.js)
//   VoiceStatus { voice }           .cmp-voice[data-voice-state] status line, shown whenever state != idle
// Keys: Ctrl+M tap = start / stop, hold >= 350 ms then release = push-to-talk; Esc while starting, listening
// or transcribing discards the take (and nothing else). Only the focused pane's composer answers Ctrl+M.
// The mic button: click toggles, press-and-hold = push-to-talk (phone too).
// Audio stays in memory: the buffers are dropped as soon as voice.transcribe returns or the take is
// cancelled, and the mic (tracks + AudioContext) closes the moment recording stops, so the OS mic light
// goes off. Engine: local Whisper on the laptop through rpc voice.status / voice.warm / voice.transcribe.
import { html } from '../lib/html.js';
import { useState, useRef, useEffect } from 'preact/hooks';
import { rpc, activeId, appInfo, toast, noteInput } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import * as VM from '../lib/voice-model.js';
import { isPhone } from './util.js';

const WORKLET_URL = new URL('./voice-worklet.js', import.meta.url).href;
const AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const METER_MS = 100;        // the level meter repaints at most 10 times a second (each frame costs CPU)
const DEAD_MIC_MS = 3000;    // listening this long with no audio frame at all = the mic sends nothing
const now = () => performance.now();

let busyCtl = null;          // the one controller with a take in flight (across panes)

// Wire mic -> (AudioWorklet | ScriptProcessor) -> silent sink; onData gets Float32 frames at ctx.sampleRate.
async function wire(ctx, stream, onData) {
  const src = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  let node = null;
  if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      node = new AudioWorkletNode(ctx, 'helm-voice-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      node.port.onmessage = (e) => { if (e.data instanceof Float32Array) onData(e.data); };
    } catch (e) {
      if (ctx.state === 'closed') throw e;   // the take was cancelled while the module loaded: nothing to fall back to
      console.warn('[voice] AudioWorklet unavailable, using ScriptProcessor', e);
      node = null;
    }
  }
  if (!node) {
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => onData(e.inputBuffer.getChannelData(0).slice());
  }
  src.connect(node);
  node.connect(sink);
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return () => {
    try { node.port?.postMessage('stop'); } catch {}
    try { if (node.port) node.port.onmessage = null; node.onaudioprocess = null; } catch {}
    try { src.disconnect(); node.disconnect(); sink.disconnect(); } catch {}
  };
}

function createController(setSt) {
  let st = VM.initial();
  let take = null;           // { seq, ctx, stream, unwire, rs, chunks, samples, peak, level, painted, paintAt, warm, warmDone, closed }
  let pressAt = 0;
  let pressStarted = false;  // the press now held started the take (its release may be push-to-talk)
  let keyHeld = false;       // M is still physically down after our Ctrl+M
  const c = { props: {}, meterEl: null };

  const desktop = () => appInfo.value.platform === 'electron';
  const set = (next) => {
    if (next === st) return st;
    const prev = st;
    st = next;
    if (VM.isRecording(prev.state) && !VM.isRecording(next.state)) closeMic(take);
    if (VM.isBusy(next.state)) busyCtl = c;
    else { if (busyCtl === c) busyCtl = null; if (next.state !== 'transcribing') take = null; }
    setSt(next);
    return next;
  };
  const dispatch = (ev) => set(VM.reduce(st, ev));
  const current = (T) => T && take === T && st.seq === T.seq;

  // Stop the tracks and close the context: the OS mic indicator goes off here.
  function closeMic(T) {
    if (!T || T.closed) return;
    T.closed = true;
    try { T.unwire?.(); } catch {}
    for (const t of T.stream?.getTracks?.() || []) { try { t.stop(); } catch {} }
    try { T.ctx?.close().catch(() => {}); } catch {}
    T.stream = null; T.ctx = null; T.unwire = null;
  }

  function onFrames(T, raw) {
    if (!current(T) || T.closed || !VM.isRecording(st.state)) return;
    const p = VM.peakOf(raw);
    if (p > T.peak) T.peak = p;
    const t = now();
    T.level = VM.smoothLevel(T.level, VM.meterLevel(p), t - (T.levelAt || t));
    T.levelAt = t;
    if (t - T.paintAt >= METER_MS) {
      const lvl = Math.round(T.level * 5);
      if (lvl !== T.painted && c.meterEl) { c.meterEl.dataset.lvl = String(lvl); T.painted = lvl; }
      T.paintAt = t;
    }
    const out = T.rs.push(raw);
    if (out.length) { T.chunks.push(out); T.samples += out.length; }
    if (T.samples >= VM.MAX_SAMPLES) stop({ limit: true });
  }

  async function start() {
    if (busyCtl && busyCtl !== c) busyCtl.cancel('You started dictating in another pane');
    const next = dispatch({ type: 'press', at: now() });
    if (next.state !== 'starting') return;
    const seq = next.seq;
    const T = { seq, ctx: null, stream: null, unwire: null, rs: null, chunks: [], samples: 0, peak: 0, level: 0, levelAt: 0, painted: -1, paintAt: 0, warm: null, warmDone: false, closed: false };
    take = T;
    // The model loads in parallel with the mic (first use ~3-5 s).
    T.warm = rpc('voice.warm', {});
    T.warm.then(() => { T.warmDone = true; if (current(T)) dispatch({ type: 'warm-ok', seq }); },
      (e) => { T.warmDone = true; if (current(T)) dispatch({ type: 'warm-fail', seq, reason: VM.rpcErrorReason(e) }); });
    rpc('voice.status', {}).then((r) => { if (!T.warmDone && current(T) && (r?.state === 'off' || r?.state === 'loading')) dispatch({ type: 'loading', seq }); }, () => {});
    try {
      // Made inside the key / click so the autoplay policy lets it run; default rate (resampled to 16 kHz here).
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw Object.assign(new Error('this browser has no Web Audio'), { name: 'NoWebAudio' });
      T.ctx = new AC();
      T.rs = VM.makeResampler(T.ctx.sampleRate);
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mediaDevices'), { name: 'NoMediaDevices' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      if (T.closed || !current(T)) { for (const t of stream.getTracks()) t.stop(); return; }   // cancelled while it opened
      T.stream = stream;
      const unwire = await wire(T.ctx, stream, (f) => onFrames(T, f));
      if (T.closed || !current(T)) { unwire(); return; }
      T.unwire = unwire;
      dispatch({ type: 'mic-ready', seq, at: now() });
    } catch (e) {
      if (!current(T) || T.closed) return;
      console.warn('[voice] microphone failed', e);
      dispatch({ type: 'mic-fail', seq, reason: VM.micErrorReason(e, { desktop: desktop() }) });
    }
  }

  function stop({ limit = false } = {}) {
    const T = take;
    if (st.state === 'starting') { dispatch({ type: 'stop', at: now(), peak: 0 }); return; }   // nothing captured yet
    if (st.state !== 'listening' || !T) return;
    const tail = T.closed ? new Float32Array(0) : T.rs.flush();
    if (tail.length) { T.chunks.push(tail); T.samples += tail.length; }
    closeMic(T);
    let pcm = VM.concat(T.chunks);
    T.chunks = [];
    if (pcm.length > VM.MAX_SAMPLES) pcm = pcm.subarray(0, VM.MAX_SAMPLES);
    const next = dispatch({ type: 'stop', at: now(), peak: T.peak, audioMs: VM.samplesToMs(pcm.length), limit });
    if (next.state === 'transcribing') transcribe(T, pcm);
  }

  async function transcribe(T, pcm) {
    let b64 = VM.encodePcm(pcm);
    pcm = null;
    try { await T.warm; } catch { return; }   // warm-fail already showed the reason (state unavailable)
    if (!current(T) || st.state !== 'transcribing') return;
    let r;
    try {
      r = await rpc('voice.transcribe', { pcm: b64, rate: VM.RATE });
    } catch (e) {
      b64 = null;
      if (current(T) && st.state === 'transcribing') dispatch({ type: 'fail', seq: T.seq, code: e?.code, reason: VM.rpcErrorReason(e) });
      return;
    }
    b64 = null;   // the audio is gone from here on
    if (!current(T) || st.state !== 'transcribing') return;   // cancelled meanwhile: the text is dropped too
    const text = String(r?.text ?? '').trim();
    take = null;
    dispatch({ type: 'result', seq: T.seq, text });
    if (text) c.props.onText?.(text);
  }

  // Discard the take (Esc, the x, leaving the session). why = shown when audio was actually lost.
  c.cancel = (why) => {
    if (!VM.isBusy(st.state)) return false;
    const T = take;
    const lost = !!why && (st.state === 'transcribing' || (T && T.samples > 0));
    closeMic(T);
    take = null;
    dispatch({ type: 'cancel' });
    if (lost) toast({ title: 'Dictation discarded', body: why, kind: 'warn', ms: 4500 });
    return true;
  };
  c.dismiss = () => { dispatch({ type: 'dismiss' }); c.props.refocus?.(); };
  c.retry = () => { if (VM.isFailure(st.state)) start(); };
  c.state = () => st;
  c.elapsedMs = () => (take && st.state === 'listening' ? VM.samplesToMs(take.samples) : 0);
  // A dead mic (context never ran, device sends nothing) must not sit at 0:00 forever.
  c.watchdog = () => {
    if (st.state !== 'listening' || !take || take.samples > 0) return;
    if (now() - st.startedAt < DEAD_MIC_MS) return;
    closeMic(take);
    dispatch({ type: 'stop', at: now(), peak: 0, audioMs: now() - st.startedAt });
  };

  // ---- press / release (keys and the mic button share the tap-vs-hold rule) ----
  c.down = () => {
    if (!c.props.enabled) return;
    const a = VM.pressAction(st.state);
    pressAt = now();
    pressStarted = a === 'start';
    if (a === 'start') start();
    else if (a === 'stop') stop();
  };
  c.up = () => {
    if (!pressStarted) return;
    pressStarted = false;
    if (VM.releaseAction(now() - pressAt, true) === 'stop') stop();
  };
  c.tap = () => { c.down(); pressStarted = false; };   // keyboard / programmatic click: a plain toggle

  c.mount = (idRef) => {
    const mine = () => !idRef.current || idRef.current === activeId.value;
    const isM = (e) => e.code === 'KeyM' || e.key === 'm' || e.key === 'M';
    const onKey = (e) => {
      if (e.isComposing) return;
      if (e.type === 'keydown') {
        if (keyHeld && isM(e) && !e.ctrlKey) { e.preventDefault(); return; }   // M still down after Ctrl went up: no stray m's
        if (isM(e) && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
          if (!c.props.enabled || !mine()) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat || keyHeld) return;
          if (VM.pressAction(st.state) === 'start' && document.querySelector('.modal-scrim:not(.m-leave)')) return;   // a dialog has the keyboard
          keyHeld = true;
          c.down();
          return;
        }
        if (e.key === 'Escape' && VM.isBusy(st.state)) { e.preventDefault(); e.stopPropagation(); c.cancel(); c.props.refocus?.(); }
        return;
      }
      if (!keyHeld) return;
      if (isM(e)) { keyHeld = false; c.up(); } else if (e.key === 'Control') c.up();
    };
    const onBlur = () => { if (keyHeld) { keyHeld = false; c.up(); } };
    // The phone suspends the mic in the background: keep what was said and transcribe it.
    const onVis = () => { if (document.visibilityState === 'hidden' && st.state === 'listening') stop(); };
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', onKey, true);
    addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('keyup', onKey, true);
      removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  };
  return c;
}

// id: the composer's session (a change or unmount discards the take, with a toast if audio was lost).
export function useVoice({ id, idRef, enabled, onText, refocus }) {
  const [st, setSt] = useState(VM.initial);
  const ref = useRef(null);
  if (!ref.current) ref.current = createController(setSt);
  const ctl = ref.current;
  ctl.props = { enabled, onText, refocus };
  useEffect(() => ctl.mount(idRef), []);
  useEffect(() => () => { ctl.cancel('You left the session before it finished'); }, [id]);
  useEffect(() => { if (!enabled) ctl.cancel('The session closed'); }, [enabled]);
  return { st, ctl };
}

export function MicButton({ voice, disabled = false }) {
  const { st, ctl } = voice;
  const s = st.state;
  const phone = isPhone.value;
  const label = VM.buttonLabel(st, { phone });
  const ptr = useRef({ down: false, click: false });
  const onPointerDown = (e) => {
    if (disabled || !e.isPrimary || e.button !== 0) return;
    ptr.current = { down: true, click: true };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    ctl.down();
  };
  const release = () => { if (!ptr.current.down) return; ptr.current.down = false; ctl.up(); };
  const onClick = (e) => {
    if (ptr.current.click) { ptr.current.click = false; return; }   // the pointer already handled it
    e.preventDefault();
    ctl.tap();
  };
  return html`<button type="button" class=${'icon-btn cmp-icon cmp-mic' + (VM.isRecording(s) ? ' on' : '')} data-voice-state=${s}
    title=${label} aria-label=${label} aria-pressed=${VM.isRecording(s) ? 'true' : 'false'} disabled=${disabled || s === 'transcribing'}
    onPointerDown=${onPointerDown} onPointerUp=${release} onPointerCancel=${() => { release(); ptr.current.click = false; }}
    onMouseDown=${(e) => e.preventDefault()} onContextMenu=${(e) => e.preventDefault()} onClick=${onClick}>
    <${Icon} name=${VM.isFailure(s) ? 'mic-off' : 'mic'} size=${16} />
  </button>`;
}

export function VoiceStatus({ voice }) {
  const { st, ctl } = voice;
  const s = st.state;
  const [, tick] = useState(0);
  const meterRef = useRef(null);
  const listening = s === 'listening';
  useEffect(() => {
    ctl.meterEl = meterRef.current;
    return () => { if (ctl.meterEl === meterRef.current) ctl.meterEl = null; };
  });
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => { tick((n) => n + 1); ctl.watchdog(); noteInput(); }, 500);   // noteInput: a take is the user at work (restart gate)
    return () => clearInterval(t);
  }, [listening]);
  if (s === 'idle') return null;
  const phone = isPhone.value;
  const { text, hint } = VM.statusText(st, { elapsedMs: ctl.elapsedMs(), phone });
  const failed = VM.isFailure(s);
  const lead = failed
    ? html`<${Icon} name="alert" size=${14} class="cmp-voice-ico" />`
    : listening ? html`<span class="cmp-voice-dot" aria-hidden="true" />` : html`<span class="spinner sm" aria-hidden="true" />`;
  return html`<div class="cmp-voice" data-voice-state=${s} role="status" aria-live="polite">
    ${lead}
    ${listening
      ? html`<span class="sr-only">Listening</span>
          <span class="cmp-voice-time" aria-hidden="true">${text}</span>
          <span class="cmp-voice-meter" ref=${meterRef} data-lvl="0" aria-hidden="true"><i /><i /><i /><i /><i /></span>`
      : html`<span class="cmp-voice-text">${text}</span>`}
    ${hint && html`<span class="cmp-voice-hint">${hint}</span>`}
    <span class="cmp-voice-acts">
      ${failed && st.retry && html`<button type="button" class="btn btn-ghost sm cmp-voice-retry" onClick=${() => ctl.retry()}>Try again</button>`}
      <button type="button" class="cmp-voice-x" title=${failed ? 'Dismiss' : phone ? 'Discard' : 'Discard (Esc)'} aria-label=${failed ? 'Dismiss' : 'Discard the recording'}
        onClick=${() => { if (failed) ctl.dismiss(); else { ctl.cancel(); ctl.props.refocus?.(); } }}><${Icon} name="x" size=${12} /></button>
    </span>
  </div>`;
}
