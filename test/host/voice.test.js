// main/voice.js: the voice-input engine bridge (lane voice). A fake Python worker stands in for
// whisper_worker.py (JSON lines over stdio), so these run anywhere in milliseconds.
// HELM_LIVE=1 adds one real run: Windows TTS speaks a sentence into memory, the real worker transcribes it.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createVoice, validateAudio, b64Bytes, defaultCandidates, RATE } = require('../../main/voice');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcmB64 = (ms, amp = 0) => { const n = Math.round((RATE * ms) / 1000); const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 5)), i * 2); return b.toString('base64'); };

// behaviour(cmd, args) -> null (ENOENT) | { exitBeforeHello?, stderr?, handle(req, reply, child) }
function fakeSpawn(behaviour) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 1000 + calls.length; child.exitCode = null;
    const call = { cmd, args, opts, child, requests: [] };
    calls.push(call);
    const b = behaviour(cmd, args, calls.length);
    const exit = (code) => { if (child.exitCode != null) return; child.exitCode = code; setImmediate(() => child.emit('exit', code)); };
    child.kill = () => exit(1);
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        let n;
        while ((n = buf.indexOf('\n')) >= 0) {
          const req = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
          call.requests.push(req);
          const reply = (obj) => setImmediate(() => child.stdout.write(JSON.stringify({ id: req.id, ...obj }) + '\n'));
          b && b.handle && b.handle(req, reply, child);
        }
        cb();
      },
      final(cb) { exit(0); cb(); },
    });
    setImmediate(() => {
      if (!b) { const e = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); child.emit('error', e); return; }
      if (b.stderr) child.stderr.write(b.stderr);
      if (b.exitBeforeHello) { exit(b.exitBeforeHello); return; }
      child.stdout.write(JSON.stringify({ hello: true, pid: child.pid, exe: b.exe || null }) + '\n');
    });
    return child;
  };
  return { spawn, calls };
}

const goodWorker = (over = {}) => ({
  exe: 'C:\\Python313\\python.exe',
  handle(req, reply, child) {
    if (req.op === 'probe') reply({ ok: true, python: '3.13.12', fw: '1.2.1', model: req.model, cached: over.cached !== false });
    else if (req.op === 'load') over.load ? over.load(req, reply, child) : reply({ ok: true, loadMs: 42, model: req.model });
    else if (req.op === 'transcribe') over.transcribe ? over.transcribe(req, reply, child) : reply({ ok: true, text: '  hello from the mic  ', audioMs: 1000, ms: 120 });
  },
});
const quiet = { log: () => {} };
const W = [{ cmd: 'py', args: ['-3.13'] }];

test('validateAudio: rate, base64, empty, odd length, 120 s limit', () => {
  assert.throws(() => validateAudio(null), { code: 'bad_params' });
  assert.throws(() => validateAudio({ pcm: pcmB64(100), rate: 44100 }), { code: 'bad_params', message: /16000 Hz/ });
  assert.throws(() => validateAudio({ pcm: 'not base64!', rate: RATE }), { code: 'bad_params', message: /intact/ });
  assert.throws(() => validateAudio({ pcm: '', rate: RATE }), { code: 'bad_params', message: /empty/ });
  assert.throws(() => validateAudio({ pcm: Buffer.from([1, 2, 3]).toString('base64'), rate: RATE }), { code: 'bad_params', message: /empty/ });
  assert.throws(() => validateAudio({ pcm: pcmB64(121_000), rate: RATE }), { code: 'bad_params', message: /longer than 120 s/ });
  assert.deepStrictEqual(validateAudio({ pcm: pcmB64(2500), rate: RATE }), { audioMs: 2500 });
  assert.strictEqual(b64Bytes(Buffer.alloc(5).toString('base64')), 5);
  assert.strictEqual(b64Bytes('abc'), null);
});

test('defaultCandidates: override first, then py -3.13 / py -3 / python on Windows', () => {
  const c = defaultCandidates({ HELM_VOICE_PYTHON: 'D:\\py\\python.exe' }, 'win32');
  assert.deepStrictEqual(c.map((x) => [x.cmd, ...x.args].join(' ')), ['D:\\py\\python.exe', 'py -3.13', 'py -3', 'python']);
  assert.deepStrictEqual(defaultCandidates({}, 'linux').map((x) => x.cmd), ['python3', 'python']);
});

test('status probes once, warm loads, transcribe returns trimmed text; later spawns use the real exe', async () => {
  const f = fakeSpawn(() => goodWorker());
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W });
  assert.deepStrictEqual(await v.status(), { state: 'off', engine: 'faster-whisper', model: 'base.en' });
  assert.strictEqual(f.calls.length, 1);
  assert.deepStrictEqual(f.calls[0].args.slice(0, 2), ['-3.13', '-u']);
  assert.match(f.calls[0].args[2], /whisper_worker\.py$/);
  assert.strictEqual(f.calls[0].opts.env.HF_HUB_OFFLINE, '1', 'the worker never goes online');
  assert.strictEqual(f.calls[0].opts.windowsHide, true);
  const w = await v.warm();
  assert.deepStrictEqual(w, { state: 'ready', loadMs: 42 });
  assert.strictEqual((await v.status()).state, 'ready');
  const r = await v.transcribe({ pcm: pcmB64(1000, 3000), rate: RATE });
  assert.deepStrictEqual(r, { text: 'hello from the mic', audioMs: 1000, ms: 120 });
  assert.deepStrictEqual(f.calls[0].requests.map((q) => q.op), ['probe', 'load', 'transcribe']);
  assert.strictEqual(f.calls.length, 1, 'one worker for the whole run');
  v.dispose();
  await sleep(5);
  assert.strictEqual(f.calls[0].child.exitCode, 0, 'dispose closes stdin; the worker exits on EOF');
});

test('concurrent warms share one load; transcribe without warm warms first', async () => {
  let loads = 0;
  const f = fakeSpawn(() => goodWorker({ load: (req, reply) => { loads++; setTimeout(() => reply({ ok: true, loadMs: 5 }), 20); } }));
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W });
  const [a, b, t] = await Promise.all([v.warm(), v.warm(), v.transcribe({ pcm: pcmB64(500), rate: RATE })]);
  assert.strictEqual(loads, 1);
  assert.strictEqual(a.state, 'ready'); assert.strictEqual(b.state, 'ready'); assert.strictEqual(t.text, 'hello from the mic');
  v.dispose();
});

test('no Python at all -> unavailable with a plain reason; remembered briefly, not re-spawned on every press', async () => {
  const f = fakeSpawn(() => null);
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: [{ cmd: 'py', args: ['-3.13'] }, { cmd: 'python', args: [] }] });
  await assert.rejects(v.warm(), { code: 'voice_unavailable', message: /Python 3 was not found/ });
  const s = await v.status();
  assert.strictEqual(s.state, 'unavailable');
  assert.match(s.reason, /Python 3 was not found/);
  const spawned = f.calls.length;
  await assert.rejects(v.warm(), { code: 'voice_unavailable' });
  await assert.rejects(v.transcribe({ pcm: pcmB64(500), rate: RATE }), { code: 'voice_unavailable' });
  assert.strictEqual(f.calls.length, spawned, 'no new spawn inside the retry window');
  v.dispose();
});

test('Windows "python" store stub (exits 9009 before hello) is skipped for the next candidate', async () => {
  const f = fakeSpawn((cmd) => (cmd === 'python' ? { exitBeforeHello: 9009, stderr: 'Python was not found; run without arguments to install from the Microsoft Store' } : goodWorker()));
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: [{ cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }] });
  assert.strictEqual((await v.warm()).state, 'ready');
  assert.deepStrictEqual(f.calls.map((c) => c.cmd), ['python', 'py']);
  v.dispose();
});

test('faster-whisper missing in every Python -> the pip command is the reason', async () => {
  const f = fakeSpawn(() => ({ handle: (req, reply) => reply({ ok: false, code: 'no_module', error: 'faster-whisper is not installed for this Python (ModuleNotFoundError): pip install faster-whisper' }) }));
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: [{ cmd: 'py', args: ['-3.13'] }, { cmd: 'py', args: ['-3'] }] });
  await assert.rejects(v.warm(), { code: 'voice_unavailable', message: /pip install faster-whisper/ });
  assert.strictEqual(f.calls.length, 2, 'both Pythons were tried');
  v.dispose();
});

test('model not downloaded -> unavailable, says how to get it, never downloads by itself', async () => {
  const f = fakeSpawn(() => goodWorker({ cached: false }));
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W });
  await assert.rejects(v.warm(), { code: 'voice_unavailable', message: /base\.en is not on this PC yet/ });
  assert.ok(!f.calls[0].requests.some((q) => q.op === 'load'), 'no load (which could download) was sent');
  v.dispose();
});

test('worker errors map to RPC codes; a crash mid-transcribe rejects and the next call respawns', async () => {
  let n = 0;
  const f = fakeSpawn(() => goodWorker({
    transcribe: (req, reply, child) => {
      n++;
      if (n === 1) reply({ ok: false, code: 'bad_audio', error: 'The recording is empty' });
      else if (n === 2) reply({ ok: false, code: 'failed', error: 'Whisper failed on this recording: boom' });
      else if (n === 3) { child.stderr.write('Traceback: MemoryError\n'); child.kill(); }
      else reply({ ok: true, text: 'back again', audioMs: 500, ms: 9 });
    },
  }));
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W });
  const audio = { pcm: pcmB64(500), rate: RATE };
  await assert.rejects(v.transcribe(audio), { code: 'bad_params' });
  await assert.rejects(v.transcribe(audio), { code: 'voice_failed', message: /boom/ });
  await assert.rejects(v.transcribe(audio), { code: 'voice_failed', message: /stopped \(exit 1\).*MemoryError/ });
  assert.strictEqual((await v.status()).state, 'off', 'a dead worker reads as off, not ready');
  const r = await v.transcribe(audio);
  assert.strictEqual(r.text, 'back again');
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(f.calls[1].cmd, 'C:\\Python313\\python.exe', 'respawn uses the python.exe the first worker reported');
  v.dispose();
});

test('a hung transcription times out with a reason and the worker is replaced', async () => {
  let n = 0;
  const f = fakeSpawn(() => goodWorker({ transcribe: (req, reply) => { if (++n > 1) reply({ ok: true, text: 'ok', audioMs: 500, ms: 1 }); } }));
  const kills = [];
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W, timeouts: { minTranscribe: 40 }, killTree: (pid) => kills.push(pid) });
  await assert.rejects(v.transcribe({ pcm: pcmB64(10), rate: RATE }), { code: 'voice_failed', message: /longer than 0 s|longer than/ });
  assert.strictEqual((await v.transcribe({ pcm: pcmB64(10), rate: RATE })).text, 'ok');
  assert.strictEqual(f.calls.length, 2);
  v.dispose();
});

test('idle close frees the worker; the next press reloads', async () => {
  const f = fakeSpawn(() => goodWorker());
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W, idleMs: 30 });
  await v.warm();
  await sleep(80);
  assert.strictEqual(f.calls[0].child.exitCode, 0, 'idle worker exited');
  assert.strictEqual((await v.status()).state, 'off');
  await v.warm();
  assert.strictEqual(f.calls.length, 2);
  v.dispose();
});

test('the engine never logs dictated text or audio', async () => {
  const lines = [];
  const f = fakeSpawn(() => goodWorker({ transcribe: (req, reply) => reply({ ok: true, text: 'my secret password is swordfish', audioMs: 900, ms: 50 }) }));
  const v = createVoice({ log: (...a) => lines.push(a.join(' ')), spawn: f.spawn, candidates: W });
  const audio = pcmB64(900, 2000);
  await v.transcribe({ pcm: audio, rate: RATE });
  const all = lines.join('\n');
  assert.ok(!/swordfish/.test(all), 'no text in the log');
  assert.ok(!all.includes(audio.slice(0, 40)), 'no audio in the log');
  assert.match(all, /transcribed 0\.9 s of audio in 50 ms -> 31 chars/);
  v.dispose();
});

test('testSet (main.js test.voice only) forces unavailable with a reason, and clears', async () => {
  const f = fakeSpawn(() => goodWorker());
  const v = createVoice({ ...quiet, spawn: f.spawn, candidates: W });
  assert.deepStrictEqual(v.testSet({ unavailable: 'Python 3 was not found' }), { state: 'unavailable', reason: 'Python 3 was not found', engine: 'faster-whisper', model: 'base.en' });
  assert.strictEqual((await v.status()).state, 'unavailable');
  await assert.rejects(v.warm(), { code: 'voice_unavailable', message: 'Python 3 was not found' });
  assert.strictEqual(f.calls.length, 0, 'nothing spawned while forced');
  v.testSet({});
  assert.strictEqual((await v.warm()).state, 'ready');
  v.dispose();
});

test('RPC methods are exposed under voice.*', () => {
  const v = createVoice({ ...quiet, spawn: fakeSpawn(() => goodWorker()).spawn, candidates: W });
  assert.deepStrictEqual(Object.keys(v.methods).sort(), ['voice.status', 'voice.transcribe', 'voice.warm']);
  v.dispose();
});

// ---- live (opt-in): real Python + faster-whisper + the cached base.en model ----
test('LIVE: Windows TTS sentence -> real worker -> text', { skip: process.env.HELM_LIVE !== '1' || process.platform !== 'win32' }, async () => {
  const { execFileSync } = require('node:child_process');
  // System.Speech writes 16 kHz mono PCM into a MemoryStream; base64 of the samples comes back on stdout (no file).
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$m = New-Object System.IO.MemoryStream',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToAudioStream($m, $f)',
    "$s.Speak('Please run the tests in the helm folder, then commit the branch.')",
    '[Convert]::ToBase64String($m.ToArray())',
  ].join('; ');
  const pcm = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
  const v = createVoice({ log: () => {} });
  try {
    const t0 = Date.now();
    const w = await v.warm();
    const r = await v.transcribe({ pcm, rate: RATE });
    console.log(`  live: load ${w.loadMs} ms, ${r.audioMs} ms audio -> ${r.ms} ms, total ${Date.now() - t0} ms: "${r.text}"`);
    assert.match(r.text.toLowerCase(), /run the tests/);
    assert.match(r.text.toLowerCase(), /commit the branch/);
  } finally { v.dispose(); }
});
