// PC 喇叭：用 Web Audio 的方波振荡器发声
// 浏览器要求声音在用户操作（点击）之后才能开始，所以在点"运行"时调用 enable()。

export class Speaker {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private freq = 0;
  private live = false;

  /** 在用户点击时调用：创建或恢复声音输出，并按当前频率发声 */
  enable(): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.osc = this.ctx.createOscillator();
        this.osc.type = 'square';
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;
        this.osc.connect(this.gain).connect(this.ctx.destination);
        this.osc.start();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null; // 没有声音设备
    }
    this.live = true;
    this.apply();
  }

  /** 暂停时静音（频率保留，继续运行时恢复） */
  mute(): void {
    this.live = false;
    this.apply();
  }

  /** 程序设置的频率（Hz），0 表示不响 */
  set(freq: number): void {
    this.freq = freq;
    this.apply();
  }

  private apply(): void {
    if (!this.ctx || !this.osc || !this.gain) return;
    const t = this.ctx.currentTime;
    const on = this.live && this.freq >= 20 && this.freq <= 20000;
    if (on) this.osc.frequency.setValueAtTime(this.freq, t);
    // 很短的渐变，避免开关时的咔哒声
    this.gain.gain.setTargetAtTime(on ? 0.05 : 0, t, 0.004);
  }
}
