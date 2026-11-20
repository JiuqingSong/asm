import workletUrl from './pcm-worklet.js?url';

export class PcmOutput {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private live = false;
  private failed = false;
  private overflowReported = false;
  private pending: Float32Array<ArrayBuffer>[] = [];
  private pendingFrames = 0;
  readonly stats = { submitted: 0, processed: 0, nonzero: 0, queued: 0 };

  constructor(onError: (message: string) => void) { this.error = onError; }
  private error: (message: string) => void;

  enable(): void {
    if (this.failed) {
      this.error('声卡音频不可用，请刷新页面后重试');
      return;
    }
    this.live = true;
    this.overflowReported = false;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;
        this.gain.connect(this.ctx.destination);
        const ctx = this.ctx;
        void ctx.audioWorklet.addModule(workletUrl).then(() => {
          this.node = new AudioWorkletNode(ctx, 'asm86-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          this.node.connect(this.gain!);
          this.node.onprocessorerror = () => this.fail('声卡音频处理器发生错误');
          this.node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (!data || typeof data !== 'object' || !('type' in data)) return;
            if (data.type === 'overflow') this.overflow();
            else if (data.type === 'error') this.fail('声卡音频数据无效');
            else if (data.type === 'stats' && 'processed' in data && 'nonzero' in data && 'queued' in data &&
              typeof data.processed === 'number' && typeof data.nonzero === 'number' && typeof data.queued === 'number') {
              this.stats.processed = data.processed;
              this.stats.nonzero = data.nonzero;
              this.stats.queued = data.queued;
            }
          };
          if (this.live) {
            this.gain!.gain.value = 1;
            for (const samples of this.pending) this.send(samples);
          }
          this.pending = [];
          this.pendingFrames = 0;
        }).catch((error: unknown) => this.fail('无法初始化声卡音频：' + this.message(error)));
      }
      if (this.ctx.state === 'suspended')
        void this.ctx.resume().catch((error: unknown) => this.fail('无法开启声卡音频：' + this.message(error)));
      if (this.gain && this.node) this.gain.gain.value = 1;
    } catch (error) { this.fail('无法开启声卡音频：' + this.message(error)); }
  }

  mute(): void {
    this.live = false;
    if (this.gain) this.gain.gain.value = 0;
    this.node?.port.postMessage({ type: 'clear' });
    this.pending = [];
    this.pendingFrames = 0;
  }

  write(samples: Float32Array, rate: number): void {
    if (!this.live || this.failed) return;
    if (rate !== 48000 || samples.length % 2 || samples.some(n => !Number.isFinite(n))) {
      this.fail('声卡输出的 PCM 格式无效（需要 48000 Hz 双声道）');
      return;
    }
    const copy = samples.slice(Math.max(0, samples.length - 16384 * 2));
    if (copy.length < samples.length) this.overflow();
    this.stats.submitted += copy.length / 2;
    if (this.node) this.send(copy);
    else {
      if (this.pendingFrames + copy.length / 2 > 16384) {
        this.pending = [];
        this.pendingFrames = 0;
        this.overflow();
      }
      this.pending.push(copy);
      this.pendingFrames += copy.length / 2;
    }
  }

  private send(samples: Float32Array<ArrayBuffer>): void {
    this.node!.port.postMessage({ type: 'samples', buffer: samples.buffer }, [samples.buffer]);
  }

  private overflow(): void {
    if (this.overflowReported) return;
    this.overflowReported = true;
    this.error('声卡音频缓存溢出，已丢弃过期采样；请使用“原机速度”，并避免长时间切到后台');
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private fail(message: string): void {
    this.mute();
    if (!this.failed) this.error(message);
    this.failed = true;
  }
}
