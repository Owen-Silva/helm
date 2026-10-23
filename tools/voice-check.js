// FIRST: caps CPU + one browser (Electron counts) machine-wide when lowcpu.js is present. A cloud runner
// (cloudtest, CI=true) has none; elsewhere a missing cap is reported on stderr, never a quiet skip.
require('./lowcpu-optional'); // FIRST: optional CPU cap (see tools/lowcpu-optional.js)
// Voice input, end to end, in an isolated `electron . --test --fallback-engine` window (lane voice, 2026-10-14).
// The microphone is Chromium's fake capture device playing a sentence Windows TTS spoke into a temp WAV, so the
// whole path is real: getUserMedia -> AudioWorklet -> 16 kHz Int16 -> voice.transcribe -> Python faster-whisper
// -> text at the caret. Checks every UI state (listening / transcribing / error / unavailable), Ctrl+M tap and
// hold, Esc cancel, the mic being released, phone widths (393, 320), no audio or dictated text left on disk or
// in the log, and records what Chromium's own Web Speech API does inside Electron (the engine decision).
// Off-screen, never focused; stopped BY PID; profile + WAV deleted. Needs Python + faster-whisper + base.en.
// Usage: node tools/voice-check.js [--shots=<dir>] [--wav=<file>] [--ram-wait=<s>]
//   --shots default %TEMP%\helm-voice-shots; --wav = a 48 kHz mono 16-bit WAV of SENTENCE to use instead of TTS.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const profile = 'voice' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-voice-check-'));
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8) || path.join(os.tmpdir(), 'helm-voice-shots');
const electronExe = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENTENCE = 'Please run the tests in the helm folder, then commit the branch.';

let failures = 0, passes = 0;
const notes = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

// Windows TTS -> 48 kHz mono Int16 in memory -> WAV with 0.8 s of silence before and 1.5 s after.
function makeWav(file) {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$m = New-Object System.IO.MemoryStream',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToAudioStream($m, $f)',
    `$s.Speak('${SENTENCE}')`,
    '[Convert]::ToBase64String($m.ToArray())',
  ].join('; ');
  const speech = Buffer.from(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim(), 'base64');
  const rate = 48000;
  const data = Buffer.concat([Buffer.alloc(rate * 2 * 0.8), speech, Buffer.alloc(rate * 2 * 1.5)]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return Math.round((data.length / 2 / rate) * 1000);
}

function client(ws) {
  let id = 1; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); p && p(m); } });
  return (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    const i = id++;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(method + ' timed out')); }, ms);
    pending.set(i, (m) => { clearTimeout(t); if (m.error) reject(Object.assign(new Error(method + ': ' + (m.error.message || JSON.stringify(m.error))), { code: m.error.code })); else resolve(m.result); });
    ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
  });
}

// ---- page probes (the focused pane's composer) ----
const VS = `(() => {
  const root = document.querySelector('.sess-composer') || document;
  const b = root.querySelector('button.cmp-mic');
  const st = root.querySelector('.cmp-voice');
  const ta = root.querySelector('textarea');
  const r = b ? b.getBoundingClientRect() : null;
  return { mic: !!b, state: b ? b.dataset.voiceState : null, disabled: b ? b.disabled : null, title: b ? b.title : null, label: b ? b.getAttribute('aria-label') : null,
    line: st ? st.textContent.replace(/\\s+/g, ' ').trim() : null, lineState: st ? st.dataset.voiceState : null, text: ta ? ta.value : null,
    visible: !!(r && r.width > 0 && r.height > 0), focusInBox: document.activeElement === ta,
    tracks: (window.__vstreams || []).flatMap((s) => s.getTracks()).map((t) => t.readyState) };
})()`;
// Helm starts on Home: open the session view on a mock session (fallback engine) so its composer renders.
const OPEN_SESSION = `import('/shell/state.js').then((sh) => { sh.openSession('s_helm'); return true; })`;
const COMPOSER_RECT =`(() => { const el = document.querySelector('.sess-composer'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 6), y: Math.max(0, Math.floor(r.top) - 6), width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12 }; })()`;
const WRAP_GUM = `(() => {
  if (window.__vwrapped) return true; window.__vwrapped = true; window.__vstreams = [];
  const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md); window.__vorigGum = orig;
  md.getUserMedia = async (c) => { if (window.__vfail) { const e = new DOMException('denied by test', window.__vfail); throw e; } const s = await orig(c); window.__vstreams.push(s); return s; };
  return true; })()`;
// What Chromium's built-in Web Speech API does inside Electron (no Google key): the evidence behind the engine choice.
const WEB_SPEECH = `new Promise((resolve) => {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return resolve({ exists: false });
  const r = new R(); r.lang = 'en-US'; r.interimResults = false;
  const t = setTimeout(() => { try { r.abort(); } catch {} resolve({ exists: true, outcome: 'no result or error in 12 s' }); }, 12000);
  r.onerror = (e) => { clearTimeout(t); resolve({ exists: true, outcome: 'error: ' + e.error + (e.message ? ' (' + e.message + ')' : '') }); };
  r.onresult = (e) => { clearTimeout(t); resolve({ exists: true, outcome: 'result: ' + e.results[0][0].transcript }); };
  try { r.start(); } catch (e) { clearTimeout(t); resolve({ exists: true, outcome: 'start threw: ' + e.message }); }
})`;

// The user's laptop has 11.7 GB: an Electron test instance (+ the ~300 MB Whisper worker) only starts with
// >= 1.5 GB free (2026-10-14 RAM rule). Waits up to --ram-wait=<s> (default 600) and says so, never quietly.
async function waitForRam(minGb = 1.5) {
  const waitS = Number((process.argv.find((a) => a.startsWith('--ram-wait=')) || '').slice(11)) || 600;
  const t0 = Date.now();
  for (;;) {
    const free = os.freemem() / 1024 ** 3;
    if (free >= minGb) { console.log(`free RAM ${free.toFixed(2)} GB (>= ${minGb})`); return true; }
    if (Date.now() - t0 > waitS * 1000) { console.log(`NOT RUN: free RAM ${free.toFixed(2)} GB stayed under ${minGb} GB for ${waitS} s`); return false; }
    if ((Date.now() - t0) % 60000 < 5000) console.log(`waiting for RAM: ${free.toFixed(2)} GB free, need ${minGb}`);
    await sleep(5000);
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!(await waitForRam())) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} process.exit(2); }
  const given = (process.argv.find((a) => a.startsWith('--wav=')) || '').slice(6);
  const wav = given ? path.resolve(given) : path.join(work, 'say.wav');
  const clipMs = given ? Math.round(((fs.statSync(wav).size - 44) / 2 / 48000) * 1000) : makeWav(wav);
  console.log(`fake mic: ${wav} (${clipMs} ms: "${SENTENCE}")`);
  const child = spawn(electronExe, ['.', '--test', '--profile=' + profile, '--fallback-engine',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  console.log(`started electron pid ${child.pid} (throwaway profile, off-screen, unfocusable)`);
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    let ready = null;
    for (let i = 0; i < 90 && !ready; i++) { await sleep(500); const m = /HELM_READY (\{.*\})/.exec(out); if (m) ready = JSON.parse(m[1]); }
    if (!ready) throw new Error('no HELM_READY within 45 s');
    const { port, token } = ready;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const rpc = client(ws);
    const evalJs = (js) => rpc('test.eval', { js });
    const vs = () => evalJs(VS);
    const key = (type, keyCode, modifiers = []) => ({ type, keyCode, modifiers });
    const shot = async (name) => {
      const rect = await evalJs(COMPOSER_RECT);
      const f = path.join(SHOTS, name + '.png');
      await rpc('test.capture', { file: f, waitMs: 0, ...(rect ? { rect } : {}) });
      return f;
    };
    const waitState = async (want, ms = 10000) => {
      const t0 = Date.now(); let s = null;
      while (Date.now() - t0 < ms) { s = await vs().catch(() => null); if (s && (Array.isArray(want) ? want.includes(s.state) : s.state === want)) return { s, ms: Date.now() - t0 }; await sleep(60); }
      return { s, ms: null };
    };
    const consoleFrom = (await rpc('test.console', { since: 0 })).next;

    for (let i = 0; i < 60; i++) { if (await evalJs(`!!document.querySelector('.strip')`).catch(() => false)) break; await sleep(500); }
    await evalJs(OPEN_SESSION);
    for (let i = 0; i < 40; i++) { if ((await vs()).mic) break; await sleep(250); }

    // ---- 0: the evidence for the engine choice ----
    const ws0 = await evalJs(WEB_SPEECH).catch((e) => ({ exists: '?', outcome: 'eval failed: ' + e.message }));
    notes.push(`Chromium Web Speech API inside Electron 44: exists=${ws0.exists}, ${ws0.outcome || ''}`);
    console.log('  note ' + notes[notes.length - 1]);

    // ---- A: engine + idle button ----
    const st = await rpc('voice.status');
    check('A voice.status: the local engine is available (faster-whisper, base.en)', st.state !== 'unavailable' && st.engine === 'faster-whisper', JSON.stringify(st));
    let s = await vs();
    check('A mic button in the composer, idle, says its shortcut', s.mic && s.visible && s.state === 'idle' && /Ctrl\+M/i.test(`${s.title} ${s.label}`), JSON.stringify({ state: s.state, title: s.title }));
    check('A no status line while idle', s.line == null || s.line === '', s.line);
    await shot('desk-idle');

    // ---- B: click -> listening (real fake-mic audio) -> click -> transcribing -> text at the caret ----
    await evalJs(WRAP_GUM);
    const before = s.text || '';
    await evalJs(`document.querySelector('.sess-composer button.cmp-mic').click(), true`);
    let w = await waitState('listening', 15000);
    check('B click: listening', w.ms != null, w.ms != null ? `${w.ms} ms` : JSON.stringify(w.s));
    await sleep(1200);
    s = await vs();
    check('B listening line shows the elapsed time and how to stop', /\d:\d\d/.test(s.line || '') && /stop/i.test(s.line || '') && s.lineState === 'listening', s.line);
    check('B the mic is live while listening', s.tracks.includes('live'), s.tracks.join());
    await shot('desk-listening');
    await sleep(Math.max(500, clipMs - 1200 - 800));
    const tStop = Date.now();
    await evalJs(`document.querySelector('.sess-composer button.cmp-mic').click(), true`);
    w = await waitState('transcribing', 4000);
    check('B click again: transcribing', w.ms != null, JSON.stringify(w.s && { state: w.s.state, line: w.s.line }));
    if (w.ms != null) { s = w.s; check('B transcribing line says so', /transcrib/i.test(s.line || ''), s.line); await shot('desk-transcribing'); }
    check('B the mic is released as soon as recording stops', (await vs()).tracks.every((t) => t === 'ended'), (await vs()).tracks.join());
    w = await waitState('idle', 60000);
    const waitMs = Date.now() - tStop;
    s = await vs();
    const got = (s.text || '').slice(before.length).trim();
    check('B back to idle with the text in the box', w.ms != null && /run the tests/i.test(got) && /commit the branch/i.test(got), `${waitMs} ms after stop: "${got}"`);
    check('B not sent: the text waits in the box', (s.text || '').includes(got) && got.length > 0);
    notes.push(`stop -> text: ${waitMs} ms for ~${Math.round(clipMs / 1000)} s of audio (cold model load overlapped the recording)`);
    await shot('desk-after-text');
    // clear the box for the next steps
    await evalJs(`(() => { const ta = document.querySelector('.sess-composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

    // ---- C: Ctrl+M tap starts, Esc cancels (nothing inserted, mic released) ----
    const n0 = (await evalJs('(window.__vstreams || []).length'));
    await rpc('test.input', { events: [key('keyDown', 'M', ['control']), { ...key('keyUp', 'M', ['control']), waitMs: 0 }] });
    w = await waitState('listening', 10000);
    check('C Ctrl+M (tap) starts listening', w.ms != null, JSON.stringify(w.s && w.s.state));
    await sleep(900);
    await rpc('test.input', { events: [key('keyDown', 'Escape'), key('keyUp', 'Escape')] });
    w = await waitState('idle', 3000);
    s = await vs();
    check('C Esc cancels: idle, nothing inserted', w.ms != null && (s.text || '') === '', JSON.stringify({ state: s.state, text: s.text }));
    check('C Esc released the mic', s.tracks.slice(n0).every((t) => t === 'ended') && s.tracks.length > n0, s.tracks.join());

    // ---- D: Ctrl+M tap to start, tap to stop; then hold = push-to-talk ----
    await rpc('test.input', { events: [key('keyDown', 'M', ['control']), key('keyUp', 'M', ['control'])] });
    w = await waitState('listening', 10000);
    await sleep(800);
    await rpc('test.input', { events: [key('keyDown', 'M', ['control']), key('keyUp', 'M', ['control'])] });
    w = await waitState(['transcribing', 'idle', 'error'], 3000);
    check('D a second Ctrl+M tap stops listening', w.ms != null, JSON.stringify(w.s && { state: w.s.state, line: w.s.line }));
    await waitState(['idle', 'error'], 30000);
    s = await vs();
    if (s.state === 'error') { check('D a near-silent take explains itself (not silent)', !!s.line && s.line.length > 8, s.line); await evalJs(`(() => { const x = document.querySelector('.sess-composer .cmp-voice button[aria-label*="ismiss" i], .sess-composer .cmp-voice .cmp-x, .sess-composer .cmp-voice button:last-of-type'); x && x.click(); return !!x; })()`); }
    await waitState('idle', 3000);
    const n1 = (await evalJs('(window.__vstreams || []).length'));
    await rpc('test.input', { events: [key('keyDown', 'M', ['control'])] });
    w = await waitState('listening', 10000);
    await sleep(1300);
    s = await vs();
    check('D hold Ctrl+M: still listening while held', s.state === 'listening', s.state);
    await rpc('test.input', { events: [key('keyUp', 'M', ['control'])] });
    w = await waitState(['transcribing', 'idle', 'error'], 3000);
    check('D release after a hold stops (push-to-talk)', w.ms != null && w.s.state !== 'listening', JSON.stringify(w.s && w.s.state));
    await waitState(['idle', 'error'], 30000);
    s = await vs();
    check('D hold released the mic', s.tracks.slice(n1).every((t) => t === 'ended'), s.tracks.join());
    if (s.state === 'error') await evalJs(`(() => { const b = [...document.querySelectorAll('.sess-composer .cmp-voice button')].pop(); b && b.click(); return true; })()`);
    await waitState('idle', 3000);

    // ---- E: microphone blocked -> error with the reason ----
    await evalJs(`window.__vfail = 'NotAllowedError', true`);
    await evalJs(`document.querySelector('.sess-composer button.cmp-mic').click(), true`);
    w = await waitState('error', 5000);
    s = await vs();
    check('E blocked mic -> error state', w.ms != null, s.state);
    check('E the reason names the fix (Windows microphone privacy)', /blocked/i.test(s.line || '') && /privacy|settings/i.test(s.line || ''), s.line);
    check('E the button title carries the reason too', /blocked/i.test(`${s.title} ${s.label}`), s.title);
    await shot('desk-error-blocked');
    await evalJs(`window.__vfail = null, true`);
    const dismissed = await evalJs(`(() => { const b = [...document.querySelectorAll('.sess-composer .cmp-voice button')].find((x) => /dismiss|close/i.test(x.getAttribute('aria-label') || x.title || '')); if (b) b.click(); return !!b; })()`);
    w = await waitState('idle', 2000);
    check('E dismiss returns to idle', dismissed && w.ms != null, JSON.stringify({ dismissed, state: w.s && w.s.state }));

    // ---- F: engine unavailable -> unavailable with the reason; mic never opened ----
    const reason = 'Python 3 was not found on this PC (voice input runs Whisper locally in Python)';
    await rpc('test.voice', { unavailable: reason });
    const n2 = (await evalJs('(window.__vstreams || []).length'));
    await evalJs(`document.querySelector('.sess-composer button.cmp-mic').click(), true`);
    w = await waitState('unavailable', 8000);
    s = await vs();
    check('F engine unavailable -> unavailable state with the engine\'s reason', w.ms != null && (s.line || '').includes('Python 3 was not found'), s.line);
    await sleep(300);
    s = await vs();
    check('F the mic is not left open', s.tracks.slice(n2).every((t) => t === 'ended'), s.tracks.join());
    await shot('desk-unavailable');
    await rpc('test.voice', {});
    await evalJs(`(() => { const b = [...document.querySelectorAll('.sess-composer .cmp-voice button')].find((x) => /dismiss|close/i.test(x.getAttribute('aria-label') || x.title || '')); if (b) b.click(); return !!b; })()`);
    await waitState('idle', 2000);

    // ---- G: widths. Overflow is measured with the mic and with it hidden (the same bar without voice = baseline) ----
    const FIT = `(() => { const b = document.querySelector('.sess-composer button.cmp-mic'); const bar = document.querySelector('.sess-composer .cmp-bar'); if (!b || !bar) return null;
      const m = () => { const r = b.getBoundingClientRect(), br = bar.getBoundingClientRect(); return { inBar: r.left >= br.left - 1 && r.right <= br.right + 1 && r.top >= br.top - 1 && r.bottom <= br.bottom + 1, overflow: bar.scrollWidth > bar.clientWidth + 1, barH: Math.round(br.height), w: Math.round(r.width), h: Math.round(r.height) }; };
      const withMic = m(); b.style.display = 'none'; const bh = Math.round(bar.getBoundingClientRect().height); const without = bar.scrollWidth > bar.clientWidth + 1; b.style.display = '';
      return { ...withMic, overflowWithoutMic: without, barHWithoutMic: bh, phone: document.documentElement.clientWidth <= 820 }; })()`;
    for (const width of [1280, 393, 320]) {
      const rs = await rpc('test.resize', { width, height: 820 });
      await sleep(500);
      await evalJs(OPEN_SESSION);
      await sleep(400);
      s = await vs();
      const fit = await evalJs(FIT);
      check(`G ${width}px: window really ${width} wide (${width < 821 ? 'phone' : 'desktop'} layout)`, rs.inner === width && fit && fit.phone === (width < 821), JSON.stringify({ inner: rs.inner, phone: fit && fit.phone }));
      check(`G ${width}px: mic shown inside the bar; the mic adds no overflow`, s.mic && s.visible && fit && fit.inBar && (!fit.overflow || fit.overflowWithoutMic), JSON.stringify(fit));
      if (fit && fit.barH !== fit.barHWithoutMic) notes.push(`${width}px: the bar is ${fit.barH}px tall with the mic, ${fit.barHWithoutMic}px without (a wrap)`);
      await rpc('test.capture', { file: path.join(SHOTS, `win${width}-idle.png`), waitMs: 0 });
      if (width === 1280) continue;
      await evalJs(`document.querySelector('.sess-composer button.cmp-mic').click(), true`);
      w = await waitState('listening', 10000);
      await sleep(700);
      const lineFit = await evalJs(`(() => { const el = document.querySelector('.sess-composer .cmp-voice'); if (!el) return null; return { overflow: el.scrollWidth > el.clientWidth + 1, h: Math.round(el.getBoundingClientRect().height) }; })()`);
      check(`G ${width}px: listening line fits`, w.ms != null && lineFit && !lineFit.overflow, JSON.stringify(lineFit));
      await shot(`phone${width}-listening`);
      await rpc('test.capture', { file: path.join(SHOTS, `win${width}-listening.png`), waitMs: 0 });
      await rpc('test.input', { events: [key('keyDown', 'Escape'), key('keyUp', 'Escape')] });
      await waitState('idle', 3000);
    }
    await rpc('test.resize', { width: 1280, height: 820 });

    // ---- H: privacy ----
    const audioFiles = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(wav|webm|ogg|pcm|mp3|m4a|opus|flac)$/i.test(e.name)) audioFiles.push(p); } };
    try { walk(userData); } catch {}
    check('H no audio file anywhere in the profile', audioFiles.length === 0, audioFiles.join(', '));
    const logs = [];
    try { const ld = path.join(userData, 'logs'); for (const f of fs.readdirSync(ld)) logs.push(fs.readFileSync(path.join(ld, f), 'utf8')); } catch {}
    const logText = logs.join('\n') + out;
    check('H the dictated text is not in the log', !/run the tests/i.test(logText), logs.length ? '' : 'stdout only');
    check('H the log says what the engine did (timings only)', /\[voice\] transcribed \d/.test(logText));

    const con = await rpc('test.console', { since: consoleFrom });
    const errs = con.entries.filter((e) => e.level === 'error' || e.level === 'crash');
    check('no renderer errors during the run', errs.length === 0, errs.slice(0, 3).map((e) => e.message.slice(0, 160)).join(' | '));
    ws.close();
  } catch (e) {
    failures++;
    console.log('  FAIL run: ' + e.message);
    console.log('  --- electron output (tail) ---\n' + out.replace(/token=[^&\s"]+/g, 'token=…').slice(-1500));
  } finally {
    killTree(child.pid);
    await sleep(600);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
  for (const n of notes) console.log('note: ' + n);
  console.log(`shots: ${SHOTS}`);
  console.log(`\nvoice-check: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main();
