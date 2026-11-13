// Runs on the audio thread. Input channel 0 = your mic, channel 1 = the other person.
// Collects half-second blocks of both and hands them to the page, sample-aligned.
class TwoStemRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 2);
    this.me = new Float32Array(this.size);
    this.them = new Float32Array(this.size);
    this.n = 0;
    this.done = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop' && !this.done) {
        this.flush(true);
        this.done = true;
      }
    };
  }

  flush(final) {
    const me = this.me.slice(0, this.n);
    const them = this.them.slice(0, this.n);
    this.port.postMessage({ me, them, final }, [me.buffer, them.buffer]);
    this.n = 0;
  }

  process(inputs) {
    if (this.done) return false;
    const input = inputs[0] || [];
    const a = input[0];
    const b = input[1];
    const frames = (a && a.length) || (b && b.length) || 128;
    for (let i = 0; i < frames; i++) {
      this.me[this.n] = a ? a[i] : 0;
      this.them[this.n] = b ? b[i] : 0;
      if (++this.n === this.size) this.flush(false);
    }
    return true;
  }
}

registerProcessor('two-stem-recorder', TwoStemRecorder);
