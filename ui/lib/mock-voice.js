// Mock voice.* for the ?mock=1 UI (screenshots, click-throughs): no Whisper, made-up text. The real
// engine is main/voice/ (local faster-whisper on the laptop). Pick a scenario with &voice=:
//   ready (default; the first warm "loads" for 1.2 s) | unavailable | empty (no speech) | failed | slow
// voice.transcribe checks its params like the host (rate 16000, non-empty base64, <= 120 s) and answers
// after ~0.4x the audio length (capped). Owner: lane voice.
const scenario = new URLSearchParams(location.search).get('voice') || 'ready';
const REASON = 'faster-whisper is not installed: run pip install faster-whisper on the laptop';
let loaded = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message, code) => Object.assign(new Error(message), { code });

export async function mockVoice(method, p = {}) {
  if (method === 'voice.status') {
    if (scenario === 'unavailable') return { state: 'unavailable', reason: REASON, engine: 'faster-whisper', model: 'base.en' };
    return { state: loaded ? 'ready' : 'off', engine: 'faster-whisper', model: 'base.en' };
  }
  if (method === 'voice.warm') {
    if (scenario === 'unavailable') { await wait(150); throw fail(REASON, 'voice_unavailable'); }
    const t = loaded ? 0 : scenario === 'slow' ? 4000 : 1200;
    await wait(t);
    loaded = true;
    return { state: 'ready', loadMs: t };
  }
  if (method === 'voice.transcribe') {
    if (p.rate !== 16000) throw fail('rate must be 16000', 'bad_params');
    const b64 = typeof p.pcm === 'string' ? p.pcm : '';
    const bytes = Math.floor((b64.length * 3) / 4);
    if (!bytes) throw fail('no audio', 'bad_params');
    const audioMs = Math.round((bytes / 2 / 16000) * 1000);
    if (audioMs > 120_500) throw fail('audio is longer than 120 s', 'bad_params');
    const ms = Math.min(4000, Math.round(audioMs * 0.4));
    await wait(ms);
    if (scenario === 'failed') throw fail('the Whisper worker exited (mock)', 'voice_failed');
    if (scenario === 'empty') return { text: '', audioMs, ms };
    return { text: '(mock) This is what you said, transcribed on the laptop.', audioMs, ms };
  }
  throw new Error(`mock: no handler for ${method}`);
}
