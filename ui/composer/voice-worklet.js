// AudioWorkletProcessor for voice input (ui/composer/voice.js): copies the mic's first channel to the main
// thread in batches of 1024 samples (~21 ms at 48 kHz) as transferred Float32Arrays. It outputs silence.
// Loaded by audioWorklet.addModule from the same origin (the page CSP is script-src 'self').
// The main thread posts 'stop' when the take ends; process() then returns false and the node is freed.
const BATCH = 1024;

class HelmVoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH);
    this.n = 0;
    this.live = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.live = false; };
  }

  process(inputs) {
    if (!this.live) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;   // no input connected yet
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, BATCH - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === BATCH) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(BATCH);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('helm-voice-tap', HelmVoiceTap);
