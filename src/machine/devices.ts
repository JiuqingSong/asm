// 外围芯片：8259 中断控制器、8253 定时器、键盘控制器
import type { IrqSource } from '../cpu/cpu.ts';

/** 8259A 可编程中断控制器（单片，主片） */
export class PIC implements IrqSource {
  irr = 0;      // 中断请求寄存器
  isr = 0;      // 在服务寄存器
  imr = 0xb8;   // 中断屏蔽寄存器（BIOS 默认开放 IRQ0/1/2/6）
  vectorBase = 8;
  /** 接在 IRQ2 上的从片（AT 机的第二个 8259，IRQ8~15）；只有主片有 */
  slave: PIC | null = null;
  private initStep = 0;
  private needIcw4 = false;
  private readIsr = false;
  /** 状态（请求、在服务、屏蔽）可能变了：Machine 用它通知 CPU 重新检查中断（见 CPU.irqCheck） */
  onChange: (() => void) | null = null;
  private changed(): void { if (this.onChange !== null) this.onChange(); }

  /** 复位到 BIOS 开机后的状态 */
  reset(vectorBase: number, imr: number): void {
    this.irr = 0; this.isr = 0; this.imr = imr; this.vectorBase = vectorBase;
    this.initStep = 0; this.readIsr = false;
    this.changed();
  }

  /** 请求：从片有待处理的中断时，主片的 IRQ2 就有请求 */
  private requests(): number { return this.irr | (this.slave !== null && this.slave.pending() ? 4 : 0); }

  raise(irq: number): void { this.irr |= 1 << irq; this.changed(); }
  lower(irq: number): void { this.irr &= ~(1 << irq); this.changed(); }

  /** 优先级最高（编号最小）的位；没有则 -1 */
  private highest(mask: number): number {
    mask &= 0xff;
    return mask === 0 ? -1 : 31 - Math.clz32(mask & -mask);
  }

  // CPU 每条指令都问一次：只用位运算（x & -x 是最低的那个 1）
  pending(): boolean {
    const req = this.requests() & ~this.imr & 0xff;
    if (req === 0) return false;
    const svc = this.isr & 0xff;
    return svc === 0 || (req & -req) < (svc & -svc);
  }

  ack(): number {
    this.changed();
    const req = this.highest(this.requests() & ~this.imr);
    if (req === 2 && this.slave !== null && this.slave.pending()) { this.isr |= 4; return this.slave.ack(); } // 级联：向量由从片给出
    this.irr &= ~(1 << req);
    this.isr |= 1 << req;
    return this.vectorBase + req;
  }

  in8(port: number): number {
    if (port === 0x21) return this.imr;
    return this.readIsr ? this.isr : this.requests();
  }

  out8(port: number, v: number): void {
    this.changed();
    if (port === 0x20) {
      if (v & 0x10) { // ICW1
        this.initStep = 2;
        this.needIcw4 = (v & 1) !== 0;
        this.imr = 0;
        this.isr = 0;
        return;
      }
      if ((v & 0x18) === 0x08) { // OCW3
        if (v & 2) this.readIsr = (v & 1) !== 0;
        return;
      }
      // OCW2
      if ((v & 0xe0) === 0x20) { // 非特定 EOI
        const h = this.highest(this.isr);
        if (h >= 0) this.isr &= ~(1 << h);
      } else if ((v & 0xe0) === 0x60) { // 特定 EOI
        this.isr &= ~(1 << (v & 7));
      }
      return;
    }
    // 端口 21h
    if (this.initStep === 2) { this.vectorBase = v & 0xf8; this.initStep = 3; return; }
    if (this.initStep === 3) { this.initStep = this.needIcw4 ? 4 : 0; return; }
    if (this.initStep === 4) { this.initStep = 0; return; }
    this.imr = v;
  }
}

/**
 * DMA 控制器：AT 机的两片 8237（0~3 号通道 8 位，端口 00h~0Fh；4~7 号通道 16 位，端口 C0h~DEh）和页寄存器（80h~8Fh）。
 * 软驱控制器经 2 号通道传送数据（见 fdc.ts 和 transfer）；其他通道只保存寄存器，让探测、编程 DMA 的程序读回合理的值
 */
export class DMA {
  /** 各通道的当前地址、当前计数（传送时变化；读端口得到的是它们） */
  addr = new Uint16Array(8);
  count = new Uint16Array(8);
  /** 基准地址、基准计数（写端口时和当前值一起设置；自动初始化时恢复成它们） */
  baseAddr = new Uint16Array(8);
  baseCount = new Uint16Array(8);
  mode = new Uint8Array(8);
  /** 屏蔽位：位 n = 通道 n */
  mask = 0xff;
  command = [0, 0];
  /** 状态寄存器的"到达终点"位（读状态寄存器后清掉）：位 n = 通道 n */
  private tcBits = 0;
  private flip = [false, false];
  /** 页寄存器 80h~8Fh（80h 也是开机自检的诊断端口） */
  page = new Uint8Array(16);

  reset(): void {
    this.addr.fill(0); this.count.fill(0); this.baseAddr.fill(0); this.baseCount.fill(0); this.mode.fill(0);
    this.mask = 0xff; this.command = [0, 0]; this.flip = [false, false]; this.page.fill(0); this.tcBits = 0;
  }

  /** 端口是不是 DMA 控制器或页寄存器的 */
  static owns(port: number): boolean {
    return port <= 0x0f || (port >= 0x80 && port <= 0x8f) || (port >= 0xc0 && port <= 0xdf);
  }

  /** 端口 → (控制器号, 寄存器号 0~15) */
  private decode(port: number): [number, number] {
    return port <= 0x0f ? [0, port] : [1, (port - 0xc0) >> 1];
  }

  in8(port: number): number {
    if (port >= 0x80 && port <= 0x8f) return this.page[port - 0x80];
    if (port >= 0xc0 && port & 1) return 0xff;
    const [c, r] = this.decode(port);
    if (r < 8) {
      const ch = c * 4 + (r >> 1), v = r & 1 ? this.count[ch] : this.addr[ch];
      const hi = this.flip[c];
      this.flip[c] = !hi;
      return hi ? v >> 8 : v & 0xff;
    }
    if (r === 8) { const v = (this.tcBits >> (c * 4)) & 0x0f; this.tcBits &= ~(0x0f << (c * 4)); return v; } // 状态：到达终点的通道
    if (r === 0x0f) return ((this.mask >> (c * 4)) & 0x0f) | 0xf0; // 屏蔽寄存器（有些芯片组可以读）
    return 0xff;
  }

  out8(port: number, v: number): void {
    if (port >= 0x80 && port <= 0x8f) { this.page[port - 0x80] = v; return; }
    if (port >= 0xc0 && port & 1) return;
    const [c, r] = this.decode(port);
    if (r < 8) {
      const ch = c * 4 + (r >> 1), arr = r & 1 ? this.count : this.addr, base = r & 1 ? this.baseCount : this.baseAddr;
      arr[ch] = this.flip[c] ? (arr[ch] & 0x00ff) | (v << 8) : (arr[ch] & 0xff00) | v;
      base[ch] = arr[ch];
      this.flip[c] = !this.flip[c];
      return;
    }
    const base = c * 4;
    switch (r) {
      case 0x08: this.command[c] = v; return;
      case 0x0a: if (v & 4) this.mask |= 1 << (base + (v & 3)); else this.mask &= ~(1 << (base + (v & 3))); return; // 单个屏蔽位
      case 0x0b: this.mode[base + (v & 3)] = v; return;
      case 0x0c: this.flip[c] = false; return;                                         // 清先后触发器
      case 0x0d: this.flip[c] = false; this.mask |= 0x0f << base; this.command[c] = 0; this.tcBits &= ~(0x0f << base); return; // 主清除
      case 0x0e: this.mask &= ~(0x0f << base); return;                                // 清除全部屏蔽
      case 0x0f: this.mask = (this.mask & ~(0x0f << base)) | ((v & 0x0f) << base); return;
    }
  }

  /** 通道没被屏蔽，可以传送 */
  ready(ch: number): boolean { return !(this.mask & (1 << ch)); }

  /**
   * 外设经 0~3 号通道（8 位）传送 data.length 个字节，按通道编程的模式：写内存（外设 → 内存）、读内存
   * （内存 → 外设，结果放进 data）或校验（不碰内存）。计数到达终点（计数从 0 再减一）时停止，返回传送的字节数和
   * 是否到达终点；到达终点时自动初始化的通道恢复基准值。地址只在 64KB 内变化，不进位到页寄存器（和真的一样）
   */
  transfer(ch: number, data: Uint8Array, mem: { readLin(a: number): number; writeLin(a: number, v: number): void }): { n: number; tc: boolean } {
    const mode = this.mode[ch], type = (mode >> 2) & 3, down = (mode & 0x20) !== 0;
    const page = this.page[PAGE_PORT[ch]] << 16;
    let n = 0, tc = false;
    while (n < data.length) {
      const a = page | this.addr[ch];
      if (type === 1) mem.writeLin(a, data[n]);
      else if (type === 2) data[n] = mem.readLin(a);
      n++;
      this.addr[ch] = this.addr[ch] + (down ? -1 : 1);
      this.count[ch] = this.count[ch] - 1;
      if (this.count[ch] === 0xffff) { tc = true; break; }
    }
    if (tc) {
      this.tcBits |= 1 << ch;
      if (mode & 0x10) { this.addr[ch] = this.baseAddr[ch]; this.count[ch] = this.baseCount[ch]; } // 自动初始化
      else this.mask |= 1 << ch; // 到达终点后通道被屏蔽（单次传送）
    }
    return { n, tc };
  }
}

/** 0~3 号通道的页寄存器（80h 开始的序号）：0 号是 87h、1 号 83h、2 号 81h、3 号 82h */
const PAGE_PORT = [7, 3, 1, 2];

/** 8254 可编程定时器：0 号通道产生 IRQ0，2 号通道用于喇叭和计时 */
export class PIT {
  reload = [0x10000, 0x10000, 0x10000];
  private counter = 0x10000;
  private latch = [-1, -1, -1];
  private access = [3, 3, 3];
  private writeLow = [true, true, true];
  private readLow = [true, true, true];
  private pendingLow = [0, 0, 0];
  private mode = [3, 2, 3];
  private statusLatch = [-1, -1, -1];
  private nullCount = [false, false, false];
  private counter2 = 0x10000;
  private gate2 = false;
  private onTick: () => void;
  /** 某个通道的计数值被重新设定（喇叭用 2 号通道） */
  onReload: ((ch: number) => void) | null = null;

  constructor(onTick: () => void) {
    this.onTick = onTick;
  }

  advance(clocks: number): void {
    if (this.gate2) {
      this.counter2 -= clocks;
      if (this.mode[2] === 2 || this.mode[2] === 3) {
        if (this.counter2 <= 0) this.counter2 += (Math.floor(-this.counter2 / this.reload[2]) + 1) * this.reload[2];
      } else this.counter2 = Math.max(0, this.counter2);
    }
    this.counter -= clocks;
    while (this.counter <= 0) {
      this.counter += this.reload[0];
      this.onTick();
    }
  }

  /** 距离下一次 IRQ0 还有多少个时钟 */
  clocksToNextTick(): number {
    return Math.max(0, this.counter);
  }

  setGate2(high: boolean): void {
    if (high && !this.gate2 && [1, 2, 3, 5].includes(this.mode[2])) this.counter2 = this.reload[2];
    this.gate2 = high;
  }

  get output2(): boolean {
    if (this.mode[2] === 0 || this.mode[2] === 1) return this.counter2 === 0;
    if (!this.gate2) return true;
    if (this.mode[2] === 2) return this.counter2 > 1;
    if (this.mode[2] === 3) return this.counter2 > Math.floor(this.reload[2] / 2);
    return this.counter2 !== 0;
  }

  private count(ch: number): number {
    return (ch === 0 ? Math.max(0, this.counter) : ch === 2 ? Math.ceil(this.counter2) : 0) & 0xffff;
  }

  in8(port: number): number {
    const ch = port & 3;
    if (ch === 3) return 0xff;
    if (this.statusLatch[ch] >= 0) {
      const status = this.statusLatch[ch];
      this.statusLatch[ch] = -1;
      return status;
    }
    let v = this.latch[ch] >= 0 ? this.latch[ch] : this.count(ch);
    let res: number;
    if (this.access[ch] === 1) res = v & 0xff;
    else if (this.access[ch] === 2) res = (v >> 8) & 0xff;
    else {
      res = this.readLow[ch] ? v & 0xff : (v >> 8) & 0xff;
      this.readLow[ch] = !this.readLow[ch];
      if (this.readLow[ch]) this.latch[ch] = -1;
      v = 0;
    }
    if (this.access[ch] !== 3) this.latch[ch] = -1;
    return res;
  }

  out8(port: number, v: number): void {
    const ch = port & 3;
    if (ch === 3) {
      const sel = v >> 6;
      if (sel === 3) {
        for (let k = 0; k < 3; k++) if (v & (2 << k)) {
          if (!(v & 0x20) && this.latch[k] < 0) this.latch[k] = this.count(k);
          if (!(v & 0x10) && this.statusLatch[k] < 0) {
            this.statusLatch[k] = (k === 2 && this.output2 ? 0x80 : 0)
              | (this.nullCount[k] ? 0x40 : 0) | (this.access[k] << 4) | (this.mode[k] << 1);
          }
        }
        return;
      }
      const acc = (v >> 4) & 3;
      if (acc === 0) { if (this.latch[sel] < 0) this.latch[sel] = this.count(sel); return; }
      this.access[sel] = acc;
      const mode = (v >> 1) & 7;
      this.mode[sel] = mode >= 6 ? mode - 4 : mode;
      this.nullCount[sel] = true;
      this.latch[sel] = this.statusLatch[sel] = -1;
      this.writeLow[sel] = true;
      this.readLow[sel] = true;
      return;
    }
    const set = (val: number) => {
      this.reload[ch] = val === 0 ? 0x10000 : val;
      if (ch === 0) this.counter = this.reload[0];
      if (ch === 2) this.counter2 = this.reload[2];
      this.nullCount[ch] = false;
      this.onReload?.(ch);
    };
    if (this.access[ch] === 1) set(v);
    else if (this.access[ch] === 2) set(v << 8);
    else if (this.writeLow[ch]) { this.pendingLow[ch] = v; this.writeLow[ch] = false; }
    else { set(this.pendingLow[ch] | (v << 8)); this.writeLow[ch] = true; }
  }
}

export interface KeyEvent {
  scan: number;    // 扫描码（松开时 | 0x80）
  ascii: number;   // 对应的 ASCII（BIOS 键盘缓冲区用），松开时为 0
  release: boolean;
}

/** 键盘控制器：按键事件排队，通过 IRQ1 逐个送出，端口 60h 读出扫描码 */
export class Keyboard {
  queue: KeyEvent[] = [];
  /** 最近一次通过 IRQ1 送出的按键（端口 60h 读到的就是它） */
  current: KeyEvent | null = null;
  private pic: PIC;
  private inService = false;
  /** 键盘控制器的"输出缓冲区满"：送出一个按键后置位，读端口 60h 后清除（Windows 的键盘驱动先查它再读 60h） */
  outputFull = false;
  /** 两次按键之间至少间隔的指令数（模拟真实键盘的节奏，避免程序来不及读取） */
  static readonly GAP = 3000;
  private cooldown = 0;

  constructor(pic: PIC) {
    this.pic = pic;
  }

  push(e: KeyEvent): void {
    this.queue.push(e);
    this.update();
  }

  /** CPU 应答 IRQ1 之后调用 */
  delivered(): void {
    this.current = this.queue.shift() ?? null;
    this.inService = true;
    this.outputFull = this.current !== null;
  }

  /** 中断结束（EOI）后，送出下一个 */
  eoi(): void {
    this.inService = false;
    this.cooldown = Keyboard.GAP;
    this.update();
  }

  /** 每执行 n 条指令调用一次 */
  tick(n: number): void {
    if (this.cooldown > 0) {
      this.cooldown -= n;
      if (this.cooldown <= 0) this.update();
    }
  }

  update(): void {
    if (!this.inService && this.cooldown <= 0 && this.queue.length) this.pic.raise(1);
  }

  in60(): number {
    this.outputFull = false;
    return this.current ? this.current.scan : 0;
  }

  clear(): void {
    this.queue = [];
    this.current = null;
    this.inService = false;
    this.cooldown = 0;
    this.outputFull = false;
  }
}

/** US 键盘扫描码表：KeyboardEvent.code -> 扫描码 */
export const SCAN: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18,
  KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, NumpadEnter: 0x1c, ControlLeft: 0x1d, ControlRight: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, AltRight: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Home: 0x47, ArrowUp: 0x48, PageUp: 0x49, NumpadSubtract: 0x4a, ArrowLeft: 0x4b,
  Numpad5: 0x4c, ArrowRight: 0x4d, NumpadAdd: 0x4e, End: 0x4f, ArrowDown: 0x50, PageDown: 0x51, Insert: 0x52, Delete: 0x53,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, Numpad4: 0x4b, Numpad6: 0x4d, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, F11: 0x57, F12: 0x58, NumpadDivide: 0x35, IntlBackslash: 0x56,
};

/** 根据字符反查扫描码（用于"粘贴文本"或测试注入） */
export function scanForChar(ch: string): number {
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return SCAN['Key' + c.toUpperCase()];
  if (c >= '0' && c <= '9') return SCAN['Digit' + c];
  const map: Record<string, string> = {
    ' ': 'Space', '\r': 'Enter', '\n': 'Enter', '\b': 'Backspace', '\t': 'Tab', '\x1b': 'Escape',
    '-': 'Minus', '_': 'Minus', '=': 'Equal', '+': 'Equal', '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight',
    '}': 'BracketRight', ';': 'Semicolon', ':': 'Semicolon', "'": 'Quote', '"': 'Quote', '`': 'Backquote', '~': 'Backquote',
    '\\': 'Backslash', '|': 'Backslash', ',': 'Comma', '<': 'Comma', '.': 'Period', '>': 'Period', '/': 'Slash', '?': 'Slash',
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8',
    '(': 'Digit9', ')': 'Digit0',
  };
  return SCAN[map[ch] ?? ''] ?? 0;
}
