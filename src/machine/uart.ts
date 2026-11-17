// 8250 串口芯片（UART）与虚拟串口线
//
// 时间用"PIT 时钟"计（1.193182 MHz），与定时器共用同一个虚拟时钟。
// 发送一个字符需要的时间由波特率和帧格式决定：起始位 + 数据位 + 校验位 + 停止位。

export const PIT_HZ = 1_193_182;

// LSR 位
export const LSR_DR = 0x01, LSR_OE = 0x02, LSR_PE = 0x04, LSR_FE = 0x08, LSR_BI = 0x10, LSR_THRE = 0x20, LSR_TEMT = 0x40;
// MCR 位
export const MCR_DTR = 0x01, MCR_RTS = 0x02, MCR_OUT1 = 0x04, MCR_OUT2 = 0x08, MCR_LOOP = 0x10;
// MSR 输入位
export const MSR_CTS = 0x10, MSR_DSR = 0x20, MSR_RI = 0x40, MSR_DCD = 0x80;

export interface SerialStats {
  txBytes: number;
  rxBytes: number;
  /** 接收端：上一个字节还没读走，新字节又到了（LSR 的 OE 位） */
  overruns: number;
  /** 发送端：THR 里的字节还没送进移位寄存器，又被写入了新字节（数据丢失） */
  thrOverwrites: number;
  /** 两端帧格式或波特率不一致导致的帧错误 */
  framingErrors: number;
}

export interface SerialEvent {
  /** 事件发生时的虚拟时间（PIT 时钟） */
  time: number;
  kind: 'tx' | 'rx' | 'modem' | 'irq' | 'overrun' | 'overwrite';
  value: number;
  text?: string;
}

/** 串口另一端：由串口线实现 */
export interface SerialPeer {
  /** 本端发出的一个字符（在 time 时刻发送完毕） */
  transmit(from: UART, byte: number, time: number): void;
  /** 本端 MCR 改变（DTR/RTS 输出） */
  modemOutputsChanged(from: UART): void;
  /** 计算本端看到的 MSR 输入（CTS/DSR/RI/DCD） */
  modemInputs(of: UART): number;
  /** 把已到达本端的字节交给本端 */
  deliver(to: UART, now: number): void;
}

export class UART {
  readonly name: string;
  readonly base: number;
  readonly irq: number;
  // 寄存器
  dll = 0x0c; dlm = 0;
  ier = 0; lcr = 0x03; mcr = 0; scr = 0;
  rbr = 0;
  lsr = LSR_THRE | LSR_TEMT;
  private msrInputs = 0;
  private msrDelta = 0;
  private thr: number | null = null;
  private tsr: number | null = null;
  private tsrDoneAt = 0;
  private thriPending = false;
  private irqLine = false;
  /**
   * 虚拟串口模式：写 THR 不会覆盖未发出的字节（进入发送缓冲），
   * 缓冲区中的字节只在 CTS 和 DSR 都有效时才发出（硬件流控），类似操作系统虚拟化的串口
   */
  bufferedTx = false;
  private txQueue: number[] = [];

  peer: SerialPeer | null = null;
  stats: SerialStats = { txBytes: 0, rxBytes: 0, overruns: 0, thrOverwrites: 0, framingErrors: 0 };
  /** 最近的事件（供界面显示） */
  events: SerialEvent[] = [];
  /** 当前虚拟时间 */
  now: () => number;
  setIrq: (raise: boolean) => void;
  /** 产生了可能影响执行的事件（例如收到字节），用于唤醒等待中的机器 */
  onActivity: (() => void) | null = null;
  /** 第一次出现数据丢失时的提示（每次复位后各提示一次） */
  onWarn: ((msg: string) => void) | null = null;
  private warned = new Set<string>();
  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onWarn?.(msg);
  }

  constructor(name: string, base: number, irq: number, now: () => number, setIrq: (raise: boolean) => void) {
    this.name = name; this.base = base; this.irq = irq; this.now = now; this.setIrq = setIrq;
  }

  reset(): void {
    this.dll = 0x0c; this.dlm = 0; this.ier = 0; this.lcr = 0x03; this.mcr = 0; this.scr = 0;
    this.rbr = 0; this.lsr = LSR_THRE | LSR_TEMT; this.msrDelta = 0;
    this.thr = null; this.tsr = null; this.thriPending = false; this.txQueue = [];
    this.stats = { txBytes: 0, rxBytes: 0, overruns: 0, thrOverwrites: 0, framingErrors: 0 };
    this.events = [];
    this.warned.clear();
    if (this.irqLine) { this.irqLine = false; this.setIrq(false); }
    if (this.peer) this.peer.modemOutputsChanged(this);
    this.refreshModem();
  }

  // ---------- 帧格式 ----------
  get divisor(): number { return ((this.dlm << 8) | this.dll) || 0x10000; }
  get baud(): number { return 115200 / this.divisor; }
  /** 帧格式标识：数据位、停止位、校验方式（不同则对方收到帧错误） */
  get format(): number { return this.lcr & 0x3f; }
  get frameBits(): number {
    const data = 5 + (this.lcr & 3);
    const stop = this.lcr & 4 ? (data === 5 ? 1.5 : 2) : 1;
    const parity = this.lcr & 8 ? 1 : 0;
    return 1 + data + parity + stop;
  }
  /** 发送一个字符需要的 PIT 时钟数 */
  get charClocks(): number { return (this.frameBits / this.baud) * PIT_HZ; }
  describeFormat(): string {
    const data = 5 + (this.lcr & 3);
    const par = this.lcr & 8 ? ['奇', '偶', '1', '0'][(this.lcr >> 4) & 3] + '校验' : '无校验';
    const stop = this.lcr & 4 ? (data === 5 ? 1.5 : 2) : 1;
    return `${Math.round(this.baud)} bps，${data} 位数据，${par}，${stop} 位停止`;
  }

  private log(kind: SerialEvent['kind'], value: number, text?: string): void {
    this.events.push({ time: this.now(), kind, value, text });
    if (this.events.length > 2000) this.events.splice(0, 1000);
  }

  // ---------- 端口 ----------
  in8(off: number): number {
    const dlab = (this.lcr & 0x80) !== 0;
    let v = 0;
    switch (off) {
      case 0:
        if (dlab) return this.dll;
        v = this.rbr;
        this.lsr &= ~LSR_DR;
        break;
      case 1: return dlab ? this.dlm : this.ier;
      case 2:
        v = this.iir();
        if (v === 0x02) this.thriPending = false; // 读 IIR 清除"发送保持寄存器空"中断
        break;
      case 3: return this.lcr;
      case 4: return this.mcr;
      case 5:
        v = this.lsr;
        this.lsr &= ~(LSR_OE | LSR_PE | LSR_FE | LSR_BI);
        break;
      case 6:
        v = this.msr();
        this.msrDelta = 0;
        break;
      case 7: return this.scr;
    }
    this.updateIrq();
    return v;
  }

  out8(off: number, v: number): void {
    const dlab = (this.lcr & 0x80) !== 0;
    switch (off) {
      case 0:
        if (dlab) { this.dll = v; return; }
        this.writeThr(v);
        break;
      case 1:
        if (dlab) { this.dlm = v; return; }
        if (!(this.ier & 2) && v & 2 && this.lsr & LSR_THRE) this.thriPending = true;
        this.ier = v & 0x0f;
        break;
      case 2: break; // 8250 没有 FIFO 控制寄存器
      case 3: this.lcr = v; return;
      case 4: {
        const old = this.mcr;
        this.mcr = v & 0x1f;
        if ((old ^ this.mcr) & 0x0f) {
          const names = [[MCR_DTR, 'DTR'], [MCR_RTS, 'RTS'], [MCR_OUT2, 'OUT2']] as const;
          for (const [bit, name] of names) if ((old ^ this.mcr) & bit) this.log('modem', this.mcr, `${name}=${this.mcr & bit ? 1 : 0}`);
        }
        if (this.peer) this.peer.modemOutputsChanged(this);
        this.refreshModem();
        break;
      }
      case 7: this.scr = v; return;
    }
    this.updateIrq();
  }

  private iir(): number {
    if (this.ier & 4 && this.lsr & (LSR_OE | LSR_PE | LSR_FE | LSR_BI)) return 0x06;
    if (this.ier & 1 && this.lsr & LSR_DR) return 0x04;
    if (this.ier & 2 && this.thriPending) return 0x02;
    if (this.ier & 8 && this.msrDelta) return 0x00;
    return 0x01;
  }

  msr(): number { return this.msrInputs | this.msrDelta; }

  /** 中断输出：PC 上 OUT2 为 1 时才接到 8259 */
  private updateIrq(): void {
    const line = (this.mcr & MCR_OUT2) !== 0 && this.iir() !== 0x01;
    if (line && !this.irqLine) this.log('irq', this.iir());
    if (line !== this.irqLine) { this.irqLine = line; this.setIrq(line); }
  }

  /** 重新计算 MSR 输入（对方或本端 MCR 改变后调用） */
  refreshModem(): void {
    let inputs: number;
    if (this.mcr & MCR_LOOP) {
      inputs = (this.mcr & MCR_RTS ? MSR_CTS : 0) | (this.mcr & MCR_DTR ? MSR_DSR : 0) |
        (this.mcr & MCR_OUT1 ? MSR_RI : 0) | (this.mcr & MCR_OUT2 ? MSR_DCD : 0);
    } else inputs = this.peer ? this.peer.modemInputs(this) : 0;
    const changed = inputs ^ this.msrInputs;
    if (changed) {
      if (changed & MSR_CTS) this.msrDelta |= 0x01;
      if (changed & MSR_DSR) this.msrDelta |= 0x02;
      if (changed & MSR_RI && !(inputs & MSR_RI)) this.msrDelta |= 0x04;
      if (changed & MSR_DCD) this.msrDelta |= 0x08;
      this.msrInputs = inputs;
      this.onActivity?.();
      if (this.bufferedTx) this.pump(this.now());
    }
    this.updateIrq();
  }

  // ---------- 发送 ----------
  private writeThr(v: number): void {
    if (this.bufferedTx) {
      this.txQueue.push(v);
    } else {
      if (this.thr !== null) {
        this.stats.thrOverwrites++;
        this.warnOnce('thr', `${this.name}：上一个字节还在发送保持寄存器（THR）里没有发出，程序又写入了新字节，数据丢失。发送前应先检查 LSR（${(this.base + 5).toString(16).toUpperCase()}h）的 THRE 位（20h）；或者在"串口"页选择"虚拟串口"`);
        this.log('overwrite', this.thr, `THR 中的 ${hex(this.thr)} 还没发出就被 ${hex(v)} 覆盖`);
      }
      this.thr = v;
      this.lsr &= ~(LSR_THRE | LSR_TEMT);
      this.thriPending = false;
    }
    this.pump(this.now());
  }

  /** 把 THR（或发送缓冲）中的字节送进移位寄存器 */
  private pump(now: number): void {
    if (this.tsr !== null) return;
    let b: number | null = null;
    if (this.bufferedTx) {
      const ready = (this.mcr & MCR_LOOP) !== 0 || (this.msrInputs & (MSR_CTS | MSR_DSR)) === (MSR_CTS | MSR_DSR);
      b = this.txQueue.length && ready ? this.txQueue.shift()! : null;
    }
    else if (this.thr !== null) { b = this.thr; this.thr = null; this.lsr |= LSR_THRE; this.thriPending = true; }
    if (b === null) return;
    this.tsr = b;
    this.tsrDoneAt = now + this.charClocks;
    this.lsr &= ~LSR_TEMT;
  }

  /** 推进到 now：接收已到达的字节，完成发送中的字符 */
  tick(now: number): void {
    if (this.peer) this.peer.deliver(this, now);
    while (this.tsr !== null && now >= this.tsrDoneAt) {
      const b = this.tsr, t = this.tsrDoneAt;
      this.tsr = null;
      this.stats.txBytes++;
      this.log('tx', b);
      if (this.mcr & MCR_LOOP) this.receive(b, true);
      else if (this.peer) this.peer.transmit(this, b, t);
      this.pump(t);
      if (this.tsr === null && (this.bufferedTx ? true : this.thr === null)) this.lsr |= LSR_TEMT;
      this.updateIrq();
    }
  }

  /** 下一次发送完成的时间（没有则为 Infinity） */
  nextEvent(): number { return this.tsr === null ? Infinity : this.tsrDoneAt; }

  // ---------- 接收 ----------
  receive(b: number, frameOk: boolean): void {
    if (this.lsr & LSR_DR) {
      this.lsr |= LSR_OE;
      this.stats.overruns++;
      this.warnOnce('oe', `${this.name}：接收缓冲里的字节还没被读走，下一个字节就到了（接收溢出），数据丢失。可能是中断没有及时处理，或者 CPU 太慢`);
      this.log('overrun', this.rbr, `接收的 ${hex(this.rbr)} 还没被读走，被 ${hex(b)} 覆盖`);
    }
    this.rbr = b;
    this.lsr |= LSR_DR;
    if (!frameOk) { this.lsr |= LSR_FE; this.stats.framingErrors++; }
    this.stats.rxBytes++;
    this.log('rx', b, frameOk ? undefined : '帧错误');
    this.updateIrq();
    this.onActivity?.();
  }

  /** 发送是否还在进行（THR 或移位寄存器里有数据） */
  get busy(): boolean { return this.tsr !== null || this.thr !== null || this.txQueue.length > 0; }
}

export type Wiring = 'loopback-rts' | 'full' | 'three-wire';

export const WIRING_DESC: Record<Wiring, string> = {
  'loopback-rts': '部分握手：TXD↔RXD 交叉，DTR→对方 DSR/DCD，RTS→本端 CTS',
  full: '全握手：TXD↔RXD、DTR↔DSR/DCD、RTS↔CTS 全部交叉',
  'three-wire': '三线制：只交叉 TXD↔RXD，握手信号在本端回环',
};

/** 虚拟交叉串口线（Null Modem） */
export class NullModem implements SerialPeer {
  a: UART;
  b: UART;
  wiring: Wiring;
  /** 正在线路上传输、尚未到达对方的字节 */
  private inflight: { to: UART; byte: number; time: number; frameOk: boolean }[] = [];

  constructor(a: UART, b: UART, wiring: Wiring = 'loopback-rts') {
    this.a = a; this.b = b; this.wiring = wiring;
    a.peer = this; b.peer = this;
    a.refreshModem(); b.refreshModem();
  }

  other(u: UART): UART { return u === this.a ? this.b : this.a; }

  transmit(from: UART, byte: number, time: number): void {
    const to = this.other(from);
    // 两端波特率和帧格式必须一致，否则对方收到的是乱码并报告帧错误
    const sameBaud = Math.abs(from.baud - to.baud) / to.baud < 0.03;
    const frameOk = sameBaud && from.format === to.format;
    this.inflight.push({ to, byte: frameOk ? byte : (byte * 37 + 11) & 0xff, time, frameOk });
  }

  /** 把到达时间已过的字节交给接收方（接收方的虚拟时间已到 time） */
  deliver(to: UART, now: number): void {
    for (let k = 0; k < this.inflight.length;) {
      const f = this.inflight[k];
      if (f.to === to && f.time <= now) { this.inflight.splice(k, 1); to.receive(f.byte, f.frameOk); }
      else k++;
    }
  }

  nextArrival(to: UART): number {
    let t = Infinity;
    for (const f of this.inflight) if (f.to === to && f.time < t) t = f.time;
    return t;
  }

  modemOutputsChanged(from: UART): void { this.other(from).refreshModem(); }

  modemInputs(of: UART): number {
    const peer = this.other(of);
    const dtr = (u: UART) => (u.mcr & MCR_DTR) !== 0 && !(u.mcr & MCR_LOOP);
    const rts = (u: UART) => (u.mcr & MCR_RTS) !== 0 && !(u.mcr & MCR_LOOP);
    let cts: boolean, dsr: boolean;
    switch (this.wiring) {
      case 'full': cts = rts(peer); dsr = dtr(peer); break;
      case 'loopback-rts': cts = rts(of); dsr = dtr(peer); break;
      default: cts = rts(of); dsr = dtr(of); break;
    }
    return (cts ? MSR_CTS : 0) | (dsr ? MSR_DSR | MSR_DCD : 0);
  }

  setWiring(w: Wiring): void {
    this.wiring = w;
    this.a.refreshModem(); this.b.refreshModem();
  }

  get connected(): boolean { return this.a.peer === this; }

  connect(): void {
    this.a.peer = this; this.b.peer = this;
    this.a.refreshModem(); this.b.refreshModem();
  }

  disconnect(): void {
    this.a.peer = null; this.b.peer = null;
    this.a.refreshModem(); this.b.refreshModem();
    this.inflight = [];
  }
}

function hex(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0') + 'h'; }
