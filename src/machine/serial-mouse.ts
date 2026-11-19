// 串口鼠标：接在 COM2 上的"硬件"，给直接操作串口的鼠标驱动（Windows 的鼠标驱动、DOS 的 MOUSE.COM、
// CTMOUSE 等）使用。按驱动设置的数据位数自动选择两种最常见的协议：
//
// Microsoft 鼠标（1200 bps，7 位数据，1 位停止）：
//   - 鼠标由串口的 DTR、RTS 线供电。上电后鼠标发出一个字节 'M' 表示自己是 Microsoft 鼠标；
//   - 之后每次移动或按键变化发一个 3 字节的数据包：
//       第 1 字节：0 1 L R Y7 Y6 X7 X6    （位 6 恒为 1，用来找包的开头）
//       第 2 字节：0 0 X5 X4 X3 X2 X1 X0
//       第 3 字节：0 0 Y5 Y4 Y3 Y2 Y1 Y0
//     X、Y 是有符号的移动量（-128~127），Y 向下为正。
//
// Mouse Systems 鼠标（1200 bps，8 位数据，1 位停止）：
//   - 每次移动或按键变化发一个 5 字节的数据包：
//       第 1 字节：1 0 0 0 0 L M R（按下为 0）
//       第 2、3 字节：X、Y 移动量（Y 向上为正）
//       第 4、5 字节：发前两个字节期间的移动量（这里总是 0）
import type { SerialPeer, UART } from './uart.ts';
import { PIT_HZ, MCR_DTR, MCR_RTS, MSR_CTS, MSR_DSR } from './uart.ts';
import type { Mouse } from './mouse.ts';

const BYTE_CLOCKS_7 = (9 / 1200) * PIT_HZ;  // 起始位 + 7 位数据 + 停止位
const BYTE_CLOCKS_8 = (10 / 1200) * PIT_HZ; // 起始位 + 8 位数据 + 停止位

export class SerialMouse implements SerialPeer {
  private mouse: Mouse;
  private queue: { byte: number; time: number }[] = [];
  private powered = false;
  /** Microsoft 协议：上电后发过 'M' 才开始发数据包 */
  private identified = false;
  private lastButtons = 0;
  private busyUntil = 0;
  private uart: UART | null = null;

  constructor(mouse: Mouse) { this.mouse = mouse; }

  /** 主机按 8 位数据接收：按 Mouse Systems 协议发送 */
  private get mouseSystems(): boolean { return !!this.uart && (this.uart.lcr & 3) === 3; }

  /** 有驱动正在使用串口鼠标（串口设成了 1200 bps 并且给鼠标上了电） */
  get active(): boolean {
    const u = this.uart;
    if (!u || !this.powered || Math.abs(u.baud - 1200) / 1200 > 0.03) return false;
    return this.mouseSystems || this.identified;
  }

  transmit(): void { /* 主机发给鼠标的数据：鼠标不理会 */ }

  modemOutputsChanged(from: UART): void {
    this.uart = from;
    const on = (from.mcr & (MCR_DTR | MCR_RTS)) !== 0;
    const msOn = (from.mcr & (MCR_DTR | MCR_RTS)) === (MCR_DTR | MCR_RTS);
    if (msOn && !this.identified) {
      // Microsoft 鼠标上电：清掉之前的移动量，过两个字符的时间后发出 'M'
      const now = from.now();
      this.queue = [{ byte: 0x4d, time: now + BYTE_CLOCKS_7 * 2 }];
      this.busyUntil = now + BYTE_CLOCKS_7 * 2;
      this.identified = true;
      this.mouse.rawDx = this.mouse.rawDy = 0;
      this.lastButtons = this.mouse.buttons & 3;
    }
    if (!msOn) this.identified = false;
    if (!on) this.queue = [];
    this.powered = on;
  }

  modemInputs(): number { return MSR_CTS | MSR_DSR; }

  deliver(to: UART, now: number): void {
    this.uart = to;
    if (this.queue.length === 0) {
      // 每条指令都会走到这里：没有移动、按键也没变就不必去算波特率（makePacket 也会什么都不做）
      const m = this.mouse;
      if (Math.trunc(m.rawDx) === 0 && Math.trunc(m.rawDy) === 0 && (m.buttons & 7) === this.lastButtons) return;
      if (this.active) this.makePacket(now);
    }
    while (this.queue.length && this.queue[0].time <= now) {
      const { byte } = this.queue.shift()!;
      // 主机按 1200 bps 接收才收得对；Microsoft 协议按 8 位数据接收时，第 8 位读到的是停止位（1）
      const sameBaud = Math.abs(to.baud - 1200) / 1200 < 0.03;
      const extra = !this.mouseSystems && (to.lcr & 3) === 3 ? 0x80 : 0;
      to.receive(sameBaud ? byte | extra : (byte * 37 + 11) & 0xff, sameBaud);
    }
  }

  nextArrival(): number { return this.queue.length ? this.queue[0].time : Infinity; }

  /** 有移动或按键变化时生成一个数据包（一个包发完才发下一个，和真鼠标一样） */
  private makePacket(now: number): void {
    const m = this.mouse;
    const buttons = m.buttons & 7;
    const dx = Math.max(-127, Math.min(127, Math.trunc(m.rawDx)));
    const dy = Math.max(-127, Math.min(127, Math.trunc(m.rawDy)));
    if (!dx && !dy && buttons === this.lastButtons) return;
    m.rawDx -= dx; m.rawDy -= dy;
    this.lastButtons = buttons;
    let bytes: number[], clocks: number;
    if (this.mouseSystems) {
      const b = 0x80 | (buttons & 1 ? 0 : 4) | (buttons & 4 ? 0 : 2) | (buttons & 2 ? 0 : 1);
      bytes = [b, dx & 0xff, -dy & 0xff, 0, 0];
      clocks = BYTE_CLOCKS_8;
    } else {
      const x = dx & 0xff, y = dy & 0xff;
      bytes = [0x40 | ((buttons & 1) << 5) | ((buttons & 2) << 3) | ((y >> 6) << 2) | (x >> 6), x & 0x3f, y & 0x3f];
      clocks = BYTE_CLOCKS_7;
    }
    const start = Math.max(now, this.busyUntil);
    bytes.forEach((byte, k) => this.queue.push({ byte, time: start + clocks * (k + 1) }));
    this.busyUntil = start + clocks * bytes.length;
  }
}
