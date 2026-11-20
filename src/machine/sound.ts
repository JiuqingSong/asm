/** Non-PnP SB16 DSP 4.05 / CT1745 mixer. Only PCM output is implemented. */
export interface SoundHost {
  now(): number;
  dma(channel: number, data: Uint8Array): { n: number; tc: boolean } | null;
  irq(irq: number, active: boolean): void;
  pcm(samples: Float32Array, sampleRate: number): void;
  unsupported(message: string): void;
}

const CLOCK = 1193182;
export const SOUND_RATE = 48000;
const CHUNK = 256;
// DSP 8051 identity bytes read by the native Windows98 driver, also observed on DSP 4.4 hardware.
const FIRMWARE_PROBE = new Map<number, number>([
  [0x0e, 0xff], [0x0f, 7], [0x0b, 0], [0x23, 0], [0x24, 0],
  [0x2b, 0], [0x2c, 0], [0x2d, 0], [0x37, 0x38],
]);
type Playback = { bits: number; signed: boolean; stereo: boolean; auto: boolean; count: number; rate: number };

export class SoundBlaster {
  private host: SoundHost;
  mixer = new Uint8Array(256);
  private mixerIndex = 0;
  private fifo: number[] = [];
  private resetHigh = false;
  private resetNext = Infinity;
  private busyUntil = 0;
  private command = -1;
  private params: number[] = [];
  private testRegister = 0;
  private rate = 22050;
  private inputRate = 22050;
  private legacyBlock = 1;
  private speaker = false;
  private irqStatus = 0;
  private playback: Playback | null = null;
  private queuedPlayback: Playback | null = null;
  private blockLeft = 0;
  private paused = false;
  private pauseRemaining = 0;
  private sourceNext = Infinity;
  private renderNext = Infinity;
  private left = 0;
  private right = 0;
  private pcmBuffer = new Float32Array(CHUNK * 2);
  private pcmPos = 0;
  private sample = new Uint8Array(2);

  constructor(host: SoundHost) { this.host = host; this.reset(); }

  static owns(port: number): boolean {
    return (port >= 0x220 && port <= 0x22f) || (port >= 0x388 && port <= 0x38b);
  }

  get next(): number { return Math.min(this.resetNext, this.sourceNext, this.renderNext); }

  reset(): void {
    this.host.irq(this.irqNumber(), false);
    this.mixer.fill(0);
    this.mixer[0x80] = 2; // IRQ5
    this.mixer[0x81] = 0x22; // DMA1 / DMA5
    this.resetMixer();
    this.mixerIndex = 0;
    this.resetDsp();
  }

  private resetMixer(): void {
    this.mixer[0x30] = this.mixer[0x31] = 0xc0;
    this.mixer[0x32] = this.mixer[0x33] = 0xc0;
    this.mixer[0x22] = this.mixer[0x04] = 0xcc;
    this.mixer[0x3c] = 0x1f;
    this.mixer[0x0e] = 0;
  }

  private resetDsp(): void {
    this.host.irq(this.irqNumber(), false);
    this.fifo = []; this.command = -1; this.params = [];
    this.testRegister = 0; this.rate = this.inputRate = 22050; this.legacyBlock = 1;
    this.speaker = false; this.irqStatus = 0; this.playback = this.queuedPlayback = null;
    this.paused = false; this.pauseRemaining = 0;
    this.sourceNext = this.renderNext = this.resetNext = Infinity;
    this.busyUntil = 0; this.left = this.right = 0; this.pcmPos = 0;
    this.blockLeft = 0; this.resetHigh = false;
    this.pcmBuffer.fill(0);
  }

  private irqNumber(): number {
    const v = this.mixer[0x80];
    return v & 1 ? 9 : v & 2 ? 5 : v & 4 ? 7 : 10; // ISA IRQ2 is routed to IRQ9 on an AT.
  }

  private interrupt(bit: number): void {
    const before = this.irqStatus;
    this.irqStatus |= bit;
    if (!before) this.host.irq(this.irqNumber(), true);
  }

  private acknowledge(bit: number): void {
    this.irqStatus &= ~bit;
    if (!this.irqStatus) this.host.irq(this.irqNumber(), false);
  }

  private reply(...bytes: number[]): void {
    if (this.fifo.length + bytes.length > 256) { this.unsupported('DSP 响应 FIFO 已满'); return; }
    this.fifo.push(...bytes);
  }

  in8(port: number): number {
    this.tick();
    switch (port) {
      case 0x224: return this.mixerIndex;
      case 0x225: return this.mixerIndex === 0x82 ? this.irqStatus : this.mixer[this.mixerIndex];
      case 0x226: return 0xff;
      case 0x22a: return this.fifo.length ? this.fifo.shift()! : 0xff;
      case 0x22c: return this.resetHigh || this.host.now() < this.busyUntil ? 0x80 : 0;
      case 0x22e: this.acknowledge(1); return this.fifo.length ? 0x80 : 0;
      case 0x22f: this.acknowledge(2); return 0xff;
      default: this.unsupported(`端口 ${port.toString(16)}h（OPL/FM 不支持）`); return 0xff;
    }
  }

  out8(port: number, value: number): void {
    this.tick();
    const v = value & 0xff;
    if (port === 0x224) { this.mixerIndex = v; return; }
    if (port === 0x225) { this.writeMixer(v); return; }
    if (port === 0x226) {
      if (v & 1) { this.resetDsp(); this.resetHigh = true; }
      else if (this.resetHigh) {
        this.resetHigh = false;
        this.resetNext = this.host.now() + CLOCK * 3 / 1e6;
      }
      return;
    }
    if (port !== 0x22c) { this.unsupported(`端口 ${port.toString(16)}h（OPL/FM、MPU/MIDI 不支持）`); return; }
    if (this.resetHigh || this.resetNext !== Infinity) return;
    // Writes are accepted at instruction granularity; readiness still exposes the DSP processing delay.
    this.busyUntil = this.host.now() + CLOCK / 1e6;
    if (this.command < 0) { this.command = v; this.params = []; }
    else this.params.push(v);
    if (this.params.length >= this.parameterCount(this.command)) {
      const command = this.command, p = this.params;
      this.command = -1; this.params = [];
      this.execute(command, p);
    }
  }

  private parameterCount(c: number): number {
    if ((c & 0xe0) === 0xa0 || (c & 0xf0) === 0xb0 || (c & 0xf0) === 0xc0) return 3;
    if ([0x05, 0x0e, 0x14, 0x24, 0x41, 0x42, 0x48, 0x80].includes(c)) return 2;
    if ([0x04, 0x08, 0x0f, 0x10, 0x38, 0x40, 0xe0, 0xe2, 0xe4, 0xf9].includes(c)) return 1;
    return 0;
  }

  private execute(c: number, p: number[]): void {
    if ((c & 0xf0) === 0xb0 || (c & 0xf0) === 0xc0) {
      if (c & 8) { this.unsupported(`DSP ${c.toString(16)}h：录音（P2）`); return; }
      if (c & 1 || p[0] & ~0x30) { this.unsupported(`DSP ${c.toString(16)}h：无效 PCM 格式`); return; }
      this.start({ bits: c < 0xc0 ? 16 : 8, signed: !!(p[0] & 0x10), stereo: !!(p[0] & 0x20),
        auto: !!(c & 4), count: 1 + p[1] + (p[2] << 8), rate: this.rate });
      return;
    }
    switch (c) {
      case 0x03: this.reply(0); return; // Idle ASP interface status, not an ASP version/presence response.
      case 0x04:
        if ([0, 0x80, 0xc0, 0xf9, 0xfa, 0xfc].includes(p[0])) return;
        this.unsupported(`ASP 模式 ${p[0].toString(16)}h：没有安装 ASP，不能执行微码`);
        return;
      case 0x05: return; // value, parameter: configuring an unpopulated ASP has no PCM effect.
      case 0x08:
        if (p[0] === 3) { this.reply(0xff); return; } // No chip: never return a valid ASP version (10h–1Fh).
        this.unsupported(`ASP 查询 ${p[0].toString(16)}h`);
        return;
      case 0x0e: return; // An unpopulated ASP register bus cannot store writes, regardless of the index.
      // Register 09h retains its fixed status bits even without an external ASP.
      case 0x0f: this.reply(p[0] === 9 ? 0xf8 : 0xff); return;
      case 0xf9: {
        const value = FIRMWARE_PROBE.get(p[0]);
        if (value === undefined) { this.unsupported(`DSP F9h：8051 内存读取 ${p[0].toString(16)}h`); return; }
        this.reply(value);
        return;
      }
      case 0xe1: this.reply(4, 5); return;
      case 0xe0: this.reply(p[0] ^ 0xff); return;
      case 0xe4: this.testRegister = p[0]; return;
      case 0xe8: this.reply(this.testRegister); return;
      case 0xe3:
        this.reply(...Array.from('COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.\0', ch => ch.charCodeAt(0)));
        return;
      case 0xd1: this.speaker = true; return;
      case 0xd3: this.speaker = false; return;
      case 0xd8: this.reply(this.speaker ? 0xff : 0); return;
      case 0x40: {
        const rate = 1000000 / (256 - p[0]);
        if (rate > 48000) { this.unsupported(`DSP 40h：采样率 ${rate}`); return; }
        this.rate = rate; return;
      }
      case 0x41: case 0x42: {
        const rate = (p[0] << 8) | p[1];
        if (rate === 0 || rate > 48000) { this.unsupported(`DSP ${c.toString(16)}h：采样率 ${rate}`); return; }
        if (c === 0x41) this.rate = rate; else this.inputRate = rate;
        return;
      }
      case 0x48: this.legacyBlock = 1 + p[0] + (p[1] << 8); return;
      case 0x14: case 0x1c: case 0x90: case 0x91: {
        const stereo = !!(this.mixer[0x0e] & 2);
        this.start({ bits: 8, signed: false, stereo, auto: c === 0x1c || c === 0x90,
          count: c === 0x14 ? 1 + p[0] + (p[1] << 8) : this.legacyBlock, rate: this.rate / (stereo ? 2 : 1) });
        return;
      }
      case 0xd0: case 0xd5:
        if (this.playback?.bits === (c === 0xd0 ? 8 : 16) && !this.paused) {
          this.paused = true; this.pauseRemaining = Math.max(0, this.sourceNext - this.host.now());
          this.sourceNext = Infinity; this.left = this.right = 0;
          this.flush(); this.renderNext = Infinity;
        }
        return;
      case 0xd4: case 0xd6:
        if (this.playback?.bits === (c === 0xd4 ? 8 : 16) && this.paused) {
          this.paused = false; this.sourceNext = this.host.now() + this.pauseRemaining;
          this.renderNext = this.sourceNext;
        }
        return;
      case 0xda: case 0xd9:
        if (this.playback?.bits === (c === 0xda ? 8 : 16)) {
          this.playback.auto = false; this.queuedPlayback = null;
        }
        return;
      case 0xf2: this.interrupt(1); return;
      case 0xf3: this.interrupt(2); return;
      default: this.unsupported(`DSP 命令 ${c.toString(16)}h（仅支持 PCM 播放；录音、ADPCM、ASP、MIDI 不支持）`);
    }
  }

  private unsupported(detail: string): void { this.host.unsupported(`SB16：${detail}`); }

  private writeMixer(v: number): void {
    const r = this.mixerIndex;
    if (r === 0) { this.resetMixer(); return; }
    if (r === 0x82) return; // read-only interrupt status
    if (r === 0x80) {
      if (![1, 2, 4, 8].includes(v)) { this.unsupported(`无效 IRQ 选择 ${v.toString(16)}h`); return; }
      this.host.irq(this.irqNumber(), false); this.mixer[r] = v;
      if (this.irqStatus) this.host.irq(this.irqNumber(), true);
      return;
    }
    if (r === 0x81) {
      if ((v & ~0xeb) || ![1, 2, 8].includes(v & 0x0f) || ![0x20, 0x40, 0x80].includes(v & 0xf0)) {
        this.unsupported(`无效 DMA 选择 ${v.toString(16)}h`); return;
      }
    }
    this.mixer[r] = v;
    if (r === 0x22 || r === 0x04) {
      const base = r === 0x22 ? 0x30 : 0x32;
      this.mixer[base] = v & 0xf0; this.mixer[base + 1] = (v & 0x0f) << 4;
    } else if (r >= 0x30 && r <= 0x33) {
      const base = r & ~1, alias = r < 0x32 ? 0x22 : 0x04;
      this.mixer[alias] = (this.mixer[base] & 0xf0) | (this.mixer[base + 1] >> 4);
    }
  }

  private start(playback: Playback): void {
    if (this.playback?.auto && !playback.auto && this.playback.bits === playback.bits) {
      this.queuedPlayback = playback;
      return;
    }
    this.playback = playback; this.queuedPlayback = null; this.blockLeft = playback.count;
    this.paused = false; this.speaker = true;
    this.sourceNext = this.host.now() + CLOCK / playback.rate;
    if (this.renderNext === Infinity) this.renderNext = this.sourceNext;
  }

  private readSample(): number | null {
    const p = this.playback!;
    const select = this.mixer[0x81], ch = p.bits === 8 ? (select & 1 ? 0 : select & 2 ? 1 : 3)
      : (select & 0x20 ? 5 : select & 0x40 ? 6 : 7);
    const data = p.bits === 8 ? this.sample.subarray(0, 1) : this.sample;
    const result = this.host.dma(ch, data);
    if (!result || result.n !== data.length) return null;
    let value = data[0] | (p.bits === 16 ? data[1] << 8 : 0);
    const midpoint = p.bits === 16 ? 32768 : 128;
    if (p.signed) { if (value >= midpoint) value -= midpoint * 2; }
    else value -= midpoint;
    this.blockLeft--;
    if (!this.blockLeft) {
      this.interrupt(p.bits === 16 ? 2 : 1);
      if (this.queuedPlayback) {
        this.playback = this.queuedPlayback; this.queuedPlayback = null; this.blockLeft = this.playback.count;
      } else if (p.auto) this.blockLeft = p.count;
      else this.playback = null;
    }
    return value / midpoint;
  }

  /** Both DMA sampling and host PCM are driven exclusively by the machine's PIT-clock timeline. */
  tick(): void {
    const now = this.host.now();
    if (now >= this.resetNext) { this.resetNext = Infinity; this.reply(0xaa); }
    while (now >= Math.min(this.sourceNext, this.renderNext)) {
      if (this.sourceNext <= this.renderNext) {
        const at = this.sourceNext, p = this.playback;
        if (!p) { this.left = this.right = 0; this.sourceNext = Infinity; }
        else {
          const left = this.readSample();
          const right = p.stereo && this.playback ? this.readSample() : left;
          this.left = left ?? 0; this.right = right ?? 0;
          this.sourceNext = at + CLOCK / p.rate;
        }
      } else {
        const enabled = this.speaker && !this.paused;
        this.pcmBuffer[this.pcmPos++] = enabled ? this.left * this.gain(0) : 0;
        this.pcmBuffer[this.pcmPos++] = enabled ? this.right * this.gain(1) : 0;
        this.renderNext += CLOCK / SOUND_RATE;
        if (this.pcmPos === this.pcmBuffer.length) this.flush();
        if (!this.playback && this.sourceNext === Infinity) { this.flush(); this.renderNext = Infinity; }
      }
    }
  }

  private gain(side: number): number {
    // CT1745 master and DAC controls: five significant bits, approximately 2 dB per step.
    const master = this.mixer[0x30 + side] >> 3, pcm = this.mixer[0x32 + side] >> 3;
    if (!master || !pcm) return 0;
    return Math.pow(10, ((master - 31) + (pcm - 31)) / 10);
  }

  private flush(): void {
    if (!this.pcmPos) return;
    this.host.pcm(this.pcmBuffer.slice(0, this.pcmPos), SOUND_RATE);
    this.pcmPos = 0;
  }

  /** Called by the snapshot codec before committing a restored machine. */
  validateState(): void {
    const invalid = (field: string): never => { throw new Error(`Invalid SB16 state: ${field}`); };
    const integer = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
    const time = (v: number) => v === Infinity || (Number.isFinite(v) && v >= 0);
    if (!(this.mixer instanceof Uint8Array) || this.mixer.length !== 256) invalid('mixer');
    if (![1, 2, 4, 8].includes(this.mixer[0x80])) invalid('IRQ selection');
    const dma = this.mixer[0x81];
    if ((dma & ~0xeb) || ![1, 2, 8].includes(dma & 15) || ![0x20, 0x40, 0x80].includes(dma & 0xf0)) invalid('DMA selection');
    if (!(this.pcmBuffer instanceof Float32Array) || this.pcmBuffer.length !== CHUNK * 2 ||
      !this.pcmBuffer.every(v => Number.isFinite(v) && Math.abs(v) <= 1)) invalid('PCM buffer');
    if (!(this.sample instanceof Uint8Array) || this.sample.length !== 2) invalid('DMA sample');
    if (!integer(this.pcmPos, 0, CHUNK * 2 - 2) || this.pcmPos & 1) invalid('PCM position');
    if (!Array.isArray(this.fifo) || this.fifo.length > 256 || !this.fifo.every(v => integer(v, 0, 255))) invalid('DSP FIFO');
    if (!Array.isArray(this.params) || this.params.length > 3 || !this.params.every(v => integer(v, 0, 255))) invalid('DSP parameters');
    if (!integer(this.command, -1, 255) || (this.command < 0 && this.params.length) ||
      (this.command >= 0 && this.params.length >= this.parameterCount(this.command))) invalid('DSP command');
    if (!integer(this.testRegister, 0, 255) || !integer(this.mixerIndex, 0, 255)) invalid('DSP/mixer register');
    if (!Number.isFinite(this.rate) || this.rate < 1 || this.rate > 48000 ||
      !integer(this.inputRate, 1, 48000)) invalid('sample rate');
    if (!integer(this.legacyBlock, 1, 65536) || !integer(this.irqStatus, 0, 3)) invalid('block/IRQ');
    for (const name of ['resetNext', 'sourceNext', 'renderNext', 'busyUntil'] as const) {
      if (!time(this[name])) invalid(name);
    }
    for (const name of ['resetHigh', 'speaker', 'paused'] as const) {
      if (typeof this[name] !== 'boolean') invalid(name);
    }
    if (!Number.isFinite(this.pauseRemaining) || this.pauseRemaining < 0) invalid('pause remaining');
    if (![this.left, this.right].every(v => Number.isFinite(v) && Math.abs(v) <= 1)) invalid('sample amplitude');
    for (const p of [this.playback, this.queuedPlayback]) {
      if (p === null) continue;
      if (!p || ![8, 16].includes(p.bits) || typeof p.signed !== 'boolean' || typeof p.stereo !== 'boolean' ||
        typeof p.auto !== 'boolean' || !integer(p.count, 1, 65536) || !Number.isFinite(p.rate) || p.rate < 1 || p.rate > 48000) invalid('playback');
    }
    if (!integer(this.blockLeft, 0, 65536) || (this.playback && (this.blockLeft < 1 || this.blockLeft > this.playback.count))) invalid('block remaining');
    if (this.paused && (!this.playback || this.sourceNext !== Infinity || this.renderNext !== Infinity)) invalid('paused scheduling');
    if (this.playback && !this.paused && this.sourceNext === Infinity) invalid('playback scheduling');
    if (this.queuedPlayback && (!this.playback?.auto || this.playback.bits !== this.queuedPlayback.bits)) invalid('queued playback');
  }
}
