class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.fraction = 0;
    this.processed = 0;
    this.nonzero = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'clear') {
        this.read = this.write = this.fraction = 0;
        return;
      }
      if (data.type !== 'samples' || !(data.buffer instanceof ArrayBuffer)) return;
      const samples = new Float32Array(data.buffer);
      const frames = samples.length / 2;
      if (!Number.isInteger(frames)) {
        this.port.postMessage({ type: 'error', message: 'Invalid stereo PCM buffer' });
        return;
      }
      if (frames > this.capacity || this.write - this.read + frames > this.capacity) {
        this.read = this.write;
        this.fraction = 0;
        this.port.postMessage({ type: 'overflow' });
      }
      const start = Math.max(0, frames - this.capacity);
      for (let i = start; i < frames; i++) {
        const index = this.write++ % this.capacity;
        this.left[index] = samples[i * 2];
        this.right[index] = samples[i * 2 + 1];
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!left || !right) return true;
    const ratio = 48000 / sampleRate;
    for (let i = 0; i < left.length; i++) {
      if (this.read >= this.write) {
        left[i] = right[i] = 0;
        continue;
      }
      const a = this.read % this.capacity;
      const b = (this.read + 1 < this.write ? this.read + 1 : this.read) % this.capacity;
      left[i] = this.left[a] + (this.left[b] - this.left[a]) * this.fraction;
      right[i] = this.right[a] + (this.right[b] - this.right[a]) * this.fraction;
      if (left[i] !== 0 || right[i] !== 0) this.nonzero++;
      this.fraction += ratio;
      const count = Math.floor(this.fraction);
      this.read = Math.min(this.write, this.read + count);
      this.fraction -= count;
    }
    this.processed += left.length;
    if (this.processed % 4096 === 0)
      this.port.postMessage({ type: 'stats', processed: this.processed, nonzero: this.nonzero, queued: this.write - this.read });
    return true;
  }
}

registerProcessor('asm86-pcm', PcmProcessor);
