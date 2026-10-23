// Voice input (lane voice): local speech-to-text for the composer, desktop and phone.
// Engine: faster-whisper (base.en, int8, CPU) in a Python worker (main/voice/whisper_worker.py), JSON lines
// over stdin/stdout. The renderer records the mic, downsamples to 16 kHz Int16 and sends it here as base64
// (voice.transcribe); the phone's audio arrives the same way over the tailnet. Private by construction:
// audio lives only in memory (this process, then the worker), is never written to disk or logged, and the
// worker runs with HF_HUB_OFFLINE=1 + local_files_only, so nothing leaves the PC. Dictated text is not
// logged either (only lengths and timings).
//
// RPC (docs: ui/composer/voice.js is the client):
//   voice.status {}                       -> { state: 'off'|'loading'|'ready'|'unavailable', reason?, engine, model }
//   voice.warm {}                         -> { state: 'ready', loadMs }        rejects code 'voice_unavailable'
//   voice.transcribe { pcm, rate: 16000 } -> { text, audioMs, ms }            rejects 'bad_params' | 'voice_unavailable' | 'voice_failed'
// The worker starts on first use, loads the model on voice.warm (the mic button calls it as recording
// starts, so the load overlaps the speech) and closes after idleMs without use (frees ~300 MB).
// Owner: lane voice.

const path = require('path');
const { spawn: nodeSpawn, execFile } = require('child_process');

const RATE = 16000;
const MAX_AUDIO_MS = 120_000;
const MAX_PCM_BYTES = (RATE * 2 * MAX_AUDIO_MS) / 1000;
const MAX_B64 = Math.ceil(MAX_PCM_BYTES / 3) * 4 + 8;
const WORKER = path.join(__dirname, 'voice', 'whisper_worker.py');
const DEFAULT_MODEL = 'base.en';
const UNAVAILABLE_RETRY_MS = 15_000;   // a failed probe is remembered this long, then retried (install, come back)

function voiceError(message, code) { return Object.assign(new Error(message), { code }); }

// Python launch candidates, most specific first. HELM_VOICE_PYTHON = a python.exe path (override).
function defaultCandidates(env = process.env, platform = process.platform) {
  const list = [];
  if (env.HELM_VOICE_PYTHON) list.push({ cmd: env.HELM_VOICE_PYTHON, args: [] });
  if (platform === 'win32') list.push({ cmd: 'py', args: ['-3.13'] }, { cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] });
  else list.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  return list;
}

// Decoded byte length of a base64 string (no decode); null when it is not base64.
function b64Bytes(s) {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

function validateAudio(p) {
  if (!p || typeof p !== 'object') throw voiceError('voice.transcribe needs { pcm, rate }', 'bad_params');
  if (p.rate !== RATE) throw voiceError(`Audio must be ${RATE} Hz mono (got ${p.rate})`, 'bad_params');
  if (typeof p.pcm !== 'string' || p.pcm.length > MAX_B64) {
    throw voiceError(typeof p.pcm === 'string' ? `The recording is longer than ${MAX_AUDIO_MS / 1000} s` : 'No audio arrived', 'bad_params');
  }
  const bytes = b64Bytes(p.pcm);
  if (bytes == null) throw voiceError('The recording did not arrive intact (not base64)', 'bad_params');
  if (bytes < 2 || bytes % 2) throw voiceError('The recording is empty', 'bad_params');
  if (bytes > MAX_PCM_BYTES) throw voiceError(`The recording is longer than ${MAX_AUDIO_MS / 1000} s`, 'bad_params');
  return { audioMs: Math.round(bytes / 2 / (RATE / 1000)) };
}

/**
 * createVoice({ log, spawn, candidates, workerPath, model, idleMs, env, platform })
 *   spawn / candidates / workerPath / env: injectable for tests (test/host/voice.test.js uses a fake worker).
 * -> { methods: { 'voice.status', 'voice.warm', 'voice.transcribe' }, status, warm, transcribe, dispose, state }
 */
function createVoice({
  log = () => {}, spawn = nodeSpawn, candidates = null, workerPath = WORKER, model = process.env.HELM_VOICE_MODEL || DEFAULT_MODEL,
  idleMs = 10 * 60_000, env = process.env, platform = process.platform, killTree = null,
  timeouts = {},
} = {}) {
  const T = { hello: 20_000, probe: 60_000, load: 120_000, minTranscribe: 30_000, ...timeouts };
  let state = 'off';            // off | loading | ready | unavailable
  let reason = null;            // why unavailable (shown in the UI)
  let unavailableAt = 0;
  let worker = null;            // { child, pending: Map, buf, stderr, exe, ready: Promise }
  let chosen = null;            // the candidate that worked ({ cmd, args }); later spawns use the real exe
  let probing = null, warming = null;
  let idleTimer = null;
  let nextId = 1;
  let disposed = false;
  let forced = null;            // test-only (main.js test.voice): pretend the engine is unavailable for this reason

  const snapshot = () => (forced ? { state: 'unavailable', reason: forced, engine: 'faster-whisper', model }
    : { state, ...(reason && state === 'unavailable' ? { reason } : {}), engine: 'faster-whisper', model });

  function setUnavailable(why) {
    state = 'unavailable'; reason = why; unavailableAt = Date.now();
    log(`[voice] unavailable: ${why}`);
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (worker && worker.pending.size === 0) { log(`[voice] idle ${Math.round(idleMs / 60000)} min: closing the Whisper worker`); stopWorker(); }
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function defaultKillTree(pid) {
    if (!pid) return;
    if (platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }

  // Close stdin (the worker exits on EOF); kill the tree if it is still there 2 s later.
  function stopWorker() {
    const w = worker;
    if (!w) return;
    worker = null;
    if (state === 'ready' || state === 'loading') state = 'off';
    try { w.child.stdin.end(); } catch {}
    const t = setTimeout(() => { if (w.child.exitCode == null && !w.exited) (killTree || defaultKillTree)(w.child.pid); }, 2000);
    if (t.unref) t.unref();
  }

  function failAll(w, err) {
    for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    w.pending.clear();
  }

  // Spawn one candidate; resolves the worker once it says hello, rejects with a reason otherwise.
  function startWorker(cand) {
    return new Promise((resolve, reject) => {
      let child;
      const wenv = { ...env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
      try {
        child = spawn(cand.cmd, [...cand.args, '-u', workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: wenv });
      } catch (e) { reject(new Error(`${cand.cmd} could not start: ${e.message}`)); return; }
      const w = { child, pending: new Map(), buf: '', stderr: '', exe: null, exited: false };
      let hello = false;
      const helloTimer = setTimeout(() => { if (!hello) { try { child.kill(); } catch {} reject(new Error(`${cand.cmd} did not start the voice worker within ${T.hello / 1000} s`)); } }, T.hello);
      child.on('error', (e) => {
        clearTimeout(helloTimer);
        w.exited = true;
        if (!hello) reject(new Error(e.code === 'ENOENT' ? `${cand.cmd} was not found` : `${cand.cmd}: ${e.message}`));
        else failAll(w, voiceError(`The voice worker failed: ${e.message}`, 'voice_failed'));
      });
      child.on('exit', (code) => {
        clearTimeout(helloTimer);
        w.exited = true;
        const tail = w.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300);
        if (!hello) { reject(new Error(`${cand.cmd} ${cand.args.join(' ')} exited (${code})${tail ? ': ' + tail : ''}`.replace(/\s+/g, ' '))); return; }
        if (worker === w) { worker = null; if (state === 'ready' || state === 'loading') state = 'off'; }
        if (w.pending.size) failAll(w, voiceError(`The voice worker stopped (exit ${code})${tail ? ': ' + tail : ''}`, 'voice_failed'));
        log(`[voice] worker exited (${code})`);
      });
      child.stderr.on('data', (d) => { w.stderr = (w.stderr + d).slice(-4000); });
      child.stdout.on('data', (d) => {
        w.buf += d;
        let n;
        while ((n = w.buf.indexOf('\n')) >= 0) {
          const line = w.buf.slice(0, n).trim();
          w.buf = w.buf.slice(n + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.hello) { hello = true; clearTimeout(helloTimer); w.exe = msg.exe || null; resolve(w); continue; }
          const p = w.pending.get(msg.id);
          if (!p) continue;
          w.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      });
    });
  }

  function request(w, op, fields, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        w.pending.delete(id);
        reject(voiceError(`Whisper took longer than ${Math.round(timeoutMs / 1000)} s (${op}); the worker was restarted`, 'voice_failed'));
        if (worker === w) stopWorker();
      }, timeoutMs);
      w.pending.set(id, { resolve, reject, timer });
      try { w.child.stdin.write(JSON.stringify({ id, op, model, ...fields }) + '\n'); }
      catch (e) { w.pending.delete(id); clearTimeout(timer); reject(voiceError(`The voice worker is not running: ${e.message}`, 'voice_failed')); }
    });
  }

  // Find a Python with faster-whisper and the model; leaves that worker running as `worker`.
  async function probe() {
    if (worker) return worker;
    if (probing) return probing;
    probing = (async () => {
      const list = chosen ? [chosen] : (candidates || defaultCandidates(env, platform));
      const reasons = [];
      let sawPython = false;
      for (const cand of list) {
        let w;
        try { w = await startWorker(cand); } catch (e) { reasons.push(e.message); continue; }
        sawPython = true;
        let res;
        try { res = await request(w, 'probe', {}, T.probe); } catch (e) { reasons.push(e.message); try { w.child.stdin.end(); } catch {} continue; }
        if (!res.ok) { reasons.push(res.error || res.code); try { w.child.stdin.end(); } catch {} if (res.code === 'no_module') continue; break; }
        if (!res.cached) {
          try { w.child.stdin.end(); } catch {}
          throw voiceError(`The Whisper model ${model} is not on this PC yet. Download it once (about 140 MB): py -c "from faster_whisper import WhisperModel; WhisperModel('${model}')"`, 'voice_unavailable');
        }
        chosen = w.exe ? { cmd: w.exe, args: [] } : cand;
        log(`[voice] engine: faster-whisper ${res.fw} on Python ${res.python} (${w.exe || cand.cmd}), model ${model}`);
        worker = w;
        return w;
      }
      const noModule = reasons.find((r) => /faster-whisper is not installed/.test(r));
      throw voiceError(noModule ? 'faster-whisper is not installed. Install it once: py -m pip install faster-whisper'
        : sawPython ? `The voice worker could not start: ${reasons[reasons.length - 1] || 'unknown error'}`
          : 'Python 3 was not found on this PC (voice input runs Whisper locally in Python). Install Python 3, then: py -m pip install faster-whisper', 'voice_unavailable');
    })();
    try { return await probing; } catch (e) { setUnavailable(e.message); throw e; } finally { probing = null; }
  }

  function checkUnavailable() {
    if (forced) throw voiceError(forced, 'voice_unavailable');
    if (state === 'unavailable' && Date.now() - unavailableAt < UNAVAILABLE_RETRY_MS) throw voiceError(reason, 'voice_unavailable');
  }

  async function warm() {
    if (disposed) throw voiceError('Helm is shutting down', 'voice_unavailable');
    checkUnavailable();
    if (state === 'ready' && worker) { armIdle(); return { state: 'ready', loadMs: 0 }; }
    if (warming) return warming;
    warming = (async () => {
      state = 'loading'; reason = null;
      const w = await probe();
      const res = await request(w, 'load', {}, T.load);
      if (!res.ok) {
        if (res.code === 'no_model' || res.code === 'no_module') { setUnavailable(res.error); throw voiceError(res.error, 'voice_unavailable'); }
        state = 'off';
        throw voiceError(res.error || 'Whisper could not load', 'voice_failed');
      }
      state = 'ready';
      log(`[voice] model ${model} loaded in ${res.loadMs} ms`);
      armIdle();
      return { state: 'ready', loadMs: res.loadMs };
    })();
    try { return await warming; } catch (e) { if (state === 'loading') state = 'off'; throw e; } finally { warming = null; }
  }

  async function transcribe(p) {
    const { audioMs } = validateAudio(p);
    await warm();
    const w = worker;
    if (!w) throw voiceError('The voice worker stopped before the recording arrived', 'voice_failed');
    const res = await request(w, 'transcribe', { pcm: p.pcm }, Math.max(T.minTranscribe, audioMs * 3));
    armIdle();
    if (!res.ok) {
      const code = res.code === 'bad_audio' ? 'bad_params' : res.code === 'no_model' || res.code === 'no_module' ? 'voice_unavailable' : 'voice_failed';
      throw voiceError(res.error || 'Whisper failed on this recording', code);
    }
    const text = typeof res.text === 'string' ? res.text.trim() : '';
    log(`[voice] transcribed ${(audioMs / 1000).toFixed(1)} s of audio in ${res.ms} ms -> ${text.length} chars`);
    return { text, audioMs: res.audioMs ?? audioMs, ms: res.ms ?? null };
  }

  async function status() {
    if (forced) return snapshot();
    if (state === 'unavailable' && Date.now() - unavailableAt >= UNAVAILABLE_RETRY_MS) { state = 'off'; reason = null; }
    if (state === 'off' && !worker && !chosen) {
      try { await probe(); } catch { /* setUnavailable already ran */ }
    }
    return snapshot();
  }

  function dispose() {
    disposed = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const w = worker;
    stopWorker();
    if (w) failAll(w, voiceError('Helm is shutting down', 'voice_failed'));
  }

  return {
    status, warm, transcribe, dispose,
    testSet: ({ unavailable = null } = {}) => { forced = unavailable ? String(unavailable) : null; return snapshot(); },
    state: snapshot,
    methods: {
      'voice.status': () => status(),
      'voice.warm': () => warm(),
      'voice.transcribe': (p) => transcribe(p),
    },
  };
}

module.exports = { createVoice, validateAudio, b64Bytes, defaultCandidates, RATE, MAX_AUDIO_MS };
