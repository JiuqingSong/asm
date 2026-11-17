// 外围芯片：8259 中断控制器、8253 定时器、键盘控制器
import type { IrqSource } from '../cpu/cpu.ts';

/** 8259A 可编程中断控制器（单片，主片） */
export class PIC implements IrqSource {
  irr = 0;      // 中断请求寄存器
  isr = 0;      // 在服务寄存器
  imr = 0xb8;   // 中断屏蔽寄存器（BIOS 默认开放 IRQ0/1/2/6）
  vectorBase = 8;
  private initStep = 0;
  private needIcw4 = false;
  private readIsr = false;

  raise(irq: number): void { this.irr |= 1 << irq; }
  lower(irq: number): void { this.irr &= ~(1 << irq); }

  private highest(mask: number): number {
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) return i;
    return -1;
  }

  pending(): boolean {
    const req = this.highest(this.irr & ~this.imr);
    if (req < 0) return false;
    const svc = this.highest(this.isr);
    return svc < 0 || req < svc;
  }

  ack(): number {
    const req = this.highest(this.irr & ~this.imr);
    this.irr &= ~(1 << req);
    this.isr |= 1 << req;
    return this.vectorBase + req;
  }

  in8(port: number): number {
    if (port === 0x21) return this.imr;
    return this.readIsr ? this.isr : this.irr;
  }

  out8(port: number, v: number): void {
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

/** 8253 可编程定时器（只模拟 0 号通道产生 IRQ0 和 2 号通道的频率设置） */
export class PIT {
  reload = [0x10000, 0x10000, 0x10000];
  private counter = 0x10000;
  private latch = [-1, -1, -1];
  private access = [3, 3, 3];
  private writeLow = [true, true, true];
  private readLow = [true, true, true];
  private pendingLow = [0, 0, 0];
  private onTick: () => void;
  /** 某个通道的计数值被重新设定（喇叭用 2 号通道） */
  onReload: ((ch: number) => void) | null = null;

  constructor(onTick: () => void) {
    this.onTick = onTick;
  }

  advance(clocks: number): void {
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

  in8(port: number): number {
    const ch = port & 3;
    if (ch === 3) return 0xff;
    let v = this.latch[ch] >= 0 ? this.latch[ch] : ch === 0 ? Math.max(0, this.counter) & 0xffff : 0;
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
      if (sel === 3) return;
      const acc = (v >> 4) & 3;
      if (acc === 0) { this.latch[sel] = sel === 0 ? Math.max(0, this.counter) & 0xffff : 0; this.readLow[sel] = true; return; }
      this.access[sel] = acc;
      this.writeLow[sel] = true;
      this.readLow[sel] = true;
      return;
    }
    const set = (val: number) => {
      this.reload[ch] = val === 0 ? 0x10000 : val;
      if (ch === 0) this.counter = this.reload[0];
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
    return this.current ? this.current.scan : 0;
  }

  clear(): void {
    this.queue = [];
    this.current = null;
    this.inService = false;
    this.cooldown = 0;
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
