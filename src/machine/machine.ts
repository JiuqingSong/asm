// 虚拟 PC：CPU + 内存 + 中断控制器 + 定时器 + 键盘 + BIOS/DOS，以及调试功能
import { CPU, CS, DS, ES, SS, SP, IF, BIOS_SEG, TRAP_OPCODE, type IOBus } from '../cpu/cpu.ts';
import type { Program } from '../asm/types.ts';
import { PIC, PIT, Keyboard, type KeyEvent } from './devices.ts';
import { Hle } from './bios.ts';
import { UART, type NullModem } from './uart.ts';
import { DosMemory, MEM_TOP } from './dosmem.ts';
import { Video } from './video.ts';
import { Mouse, MOUSE_STUB, MOUSE_PTR, MOUSE_VECTOR } from './mouse.ts';
import { FONT_LO, FONT_HI } from './bios.ts';
import { builtinFont } from './font8x8.ts';

/** CPU 速度选项：每条指令平均消耗的 PIT 时钟数（PIT 为 1.193182 MHz） */
export const CPU_SPEEDS = [
  { id: '8088', name: '8088 4.77MHz', clocks: 3.6, is286: false },
  { id: '286', name: '286 12MHz', clocks: 1.0, is286: true },
  { id: '386', name: '386 33MHz', clocks: 0.25, is286: true },
] as const;
export type CpuSpeedId = (typeof CPU_SPEEDS)[number]['id'];

/** 环境变量块：若干个"名=值\0"，以空字符串结束；之后是字数 1 和程序的完整路径 */
const ENV_TEMPLATE = 'PATH=C:\\\0COMSPEC=C:\\COMMAND.COM\0\0\x01\0C:\\%NAME%\0';

export type MachineStatus = 'empty' | 'ready' | 'paused' | 'running' | 'waiting' | 'exited' | 'error';
export type StopReason = 'step' | 'breakpoint' | 'exit' | 'wait' | 'budget' | 'error' | 'paused';

const STUB_SIZE = 8;
const STUB_INT8 = 0x0800;
const STUB_INT9 = 0x0810;

/** 反向执行用的历史记录：每条指令执行前的寄存器 + 该指令覆盖掉的内存旧值 */
class History {
  readonly cap = 200_000;
  private regs = new Uint16Array(this.cap * 16);
  private wstart = new Float64Array(this.cap);
  private readonly wcap = 1 << 22;
  private waddr = new Int32Array(this.wcap);
  private wold = new Uint8Array(this.wcap);
  private head = 0;   // 已记录的总条数
  count = 0;          // 有效条数
  private wpos = 0;   // 已记录的内存写入总数
  enabled = true;

  clear(): void { this.head = 0; this.count = 0; this.wpos = 0; }

  begin(cpu: CPU, flags: number): void {
    const i = this.head % this.cap;
    const o = i * 16;
    const r = this.regs;
    for (let k = 0; k < 8; k++) r[o + k] = cpu.r[k];
    for (let k = 0; k < 4; k++) r[o + 8 + k] = cpu.s[k];
    r[o + 12] = cpu.ip;
    r[o + 13] = cpu.flags;
    r[o + 14] = (cpu.halted ? 1 : 0) | (cpu.waiting ? 2 : 0);
    r[o + 15] = flags;
    this.wstart[i] = this.wpos;
    this.head++;
    if (this.count < this.cap) this.count++;
    // 写入日志被覆盖的旧记录失效
    while (this.count > 0) {
      const oldest = (this.head - this.count) % this.cap;
      if (this.wpos - this.wstart[oldest] <= this.wcap) break;
      this.count--;
    }
  }

  write(addr: number, old: number): void {
    const j = this.wpos % this.wcap;
    this.waddr[j] = addr;
    this.wold[j] = old;
    this.wpos++;
  }

  /** 撤销最近一条记录；返回该记录的标志（-1 表示没有记录） */
  undo(cpu: CPU, restore: (addr: number, old: number) => void): number {
    if (this.count === 0) return -1;
    this.head--;
    this.count--;
    const i = this.head % this.cap;
    const start = this.wstart[i];
    for (let w = this.wpos - 1; w >= start; w--) {
      const j = w % this.wcap;
      const a = this.waddr[j];
      if (a >= 0x100000) restore(a - 0x100000, this.wold[j]); // 显卡平面里的字节
      else cpu.mem[a] = this.wold[j];
    }
    this.wpos = start;
    const o = i * 16, r = this.regs;
    for (let k = 0; k < 8; k++) cpu.r[k] = r[o + k];
    for (let k = 0; k < 4; k++) cpu.s[k] = r[o + 8 + k];
    cpu.ip = r[o + 12];
    cpu.flags = r[o + 13];
    cpu.halted = (r[o + 14] & 1) !== 0;
    cpu.waiting = (r[o + 14] & 2) !== 0;
    return r[o + 15];
  }
}

const H_VISIBLE = 1;

export interface MachineEvents {
  log?(msg: string): void;
  bell?(): void;
  filesChanged?(): void;
  /** PC 喇叭：频率（Hz），0 表示不响 */
  speaker?(freq: number): void;
}

export class Machine {
  cpu = new CPU();
  mem = this.cpu.mem;
  pic = new PIC();
  kbd = new Keyboard(this.pic);
  pit = new PIT(() => this.pic.raise(0));
  /** 虚拟时间（PIT 时钟数） */
  clock = 0;
  /** 每条指令消耗的 PIT 时钟数（决定虚拟 CPU 的速度） */
  clocksPerInstr = 3.6;
  cpuModel: CpuSpeedId = '8088';
  /** DOS 文件操作是否消耗虚拟时间（模拟磁盘访问，几毫秒） */
  diskLatency = true;
  /** DOS 正在"等磁盘"（陷阱处忙等，不是在等键盘） */
  busy = false;

  /** 选择 CPU 型号：决定速度，以及 PUSH SP 等少数指令按 8086 还是 286 的方式执行 */
  setCpu(id: CpuSpeedId): void {
    const s = CPU_SPEEDS.find(x => x.id === id)!;
    this.cpuModel = id;
    this.clocksPerInstr = s.clocks;
    this.cpu.is286 = s.is286;
  }
  com1 = new UART('COM1', 0x3f8, 4, () => this.clock, on => (on ? this.pic.raise(4) : this.pic.lower(4)));
  com2 = new UART('COM2', 0x2f8, 3, () => this.clock, on => (on ? this.pic.raise(3) : this.pic.lower(3)));
  /** 连接到另一台机器的串口线 */
  link: NullModem | null = null;
  hle = new Hle(this);
  dosmem = new DosMemory(this.cpu);
  video = new Video();
  mouse = new Mouse();
  /** 8×8 字库（256 个字符 × 8 字节），装载程序时写进 BIOS ROM；默认是内置点阵，界面会用浏览器字体补全其余字符 */
  static font: Uint8Array | null = builtinFont();
  history = new History();
  /** 虚拟磁盘：文件名（大写）-> 内容 */
  files = new Map<string, Uint8Array>();
  /** 虚拟磁盘上文件的修改时间（毫秒）；没有记录的在第一次被查询时取当前时间 */
  fileTimes = new Map<string, number>();

  program: Program | null = null;
  status: MachineStatus = 'empty';
  message = '';
  exitCode = 0;
  lastExitCode = 0;
  /** 控制台输出的文本副本（便于复制和测试） */
  console = '';
  breakpoints = new Set<number>();
  events: MachineEvents = {};
  /** 程序执行的指令总数 */
  instructions = 0;

  private codeRanges: [number, number][] = [];
  private instrLen = new Map<number, number>();
  private breakRequest = '';
  private wildWarned = false;
  private pending: { kind: 'step' } | { kind: 'over'; cs: number; ip: number; sp: number } | { kind: 'out'; depth: number } | { kind: 'run' } | null = null;
  private port61 = 0;
  /** PC 喇叭当前的频率（Hz），0 表示不响 */
  speakerFreq = 0;
  private crtcIndex = 0;
  private crtc = new Uint8Array(32);
  private cmosIndex = 0;
  private retrace = 0;
  private unknownPorts = new Set<number>();

  constructor() {
    const cpu = this.cpu;
    cpu.io = this.makeBus();
    const pic = this.pic, kbd = this.kbd;
    const mouse = this.mouse;
    cpu.irq = {
      pending: () => pic.pending() || mouse.wantsCallback(),
      ack: () => {
        if (!pic.pending()) {
          // 鼠标事件：桩代码会远调用登记的处理程序
          this.mem[BIOS_SEG * 16 + MOUSE_PTR] = mouse.handlerOff & 0xff;
          this.mem[BIOS_SEG * 16 + MOUSE_PTR + 1] = mouse.handlerOff >> 8;
          this.mem[BIOS_SEG * 16 + MOUSE_PTR + 2] = mouse.handlerSeg & 0xff;
          this.mem[BIOS_SEG * 16 + MOUSE_PTR + 3] = mouse.handlerSeg >> 8;
          mouse.inHandler = true;
          return MOUSE_VECTOR;
        }
        const v = pic.ack();
        if (v === pic.vectorBase + 1) kbd.delivered();
        return v;
      },
    };
    cpu.trap = (n) => this.hle.handle(n);
    this.pit.onReload = ch => { if (ch === 2) this.updateSpeaker(); };
    cpu.onWrite = (a, old) => { if (this.history.enabled) this.history.write(a, old); };
    this.video.planar.onWrite = (a, old) => { if (this.history.enabled) this.history.write(0x100000 + a, old); };
    this.com1.onWarn = this.com2.onWarn = msg => this.log(msg);
  }

  // ======================= 端口 =======================

  private makeBus(): IOBus {
    return {
      in8: (port) => {
        if (port >= 0x3f8 && port <= 0x3ff) return this.com1.in8(port - 0x3f8);
        if (port >= 0x2f8 && port <= 0x2ff) return this.com2.in8(port - 0x2f8);
        switch (port) {
          case 0x20: case 0x21: return this.pic.in8(port);
          case 0x40: case 0x41: case 0x42: case 0x43: return this.pit.in8(port);
          case 0x60: return this.kbd.in60();
          case 0x61: return this.port61;
          case 0x64: return this.kbd.queue.length ? 0x15 : 0x14;
          case 0x71: return this.cmosRead();
          case 0x3d4: return this.crtcIndex;
          case 0x3d5: return this.crtc[this.crtcIndex & 31];
          case 0x3da: this.retrace ^= 0x09; this.video.resetAttrFlip(); return this.retrace;
          case 0xf0: case 0xf1: return 0xff; // 数学协处理器（没有）
          case 0x3c6: case 0x3c7: case 0x3c8: case 0x3c9: case 0x3d9: return this.video.in8(port);
        }
        this.unknownPort(port, '读');
        return 0xff;
      },
      out8: (port, v) => {
        if (port >= 0x3f8 && port <= 0x3ff) { this.com1.out8(port - 0x3f8, v); return; }
        if (port >= 0x2f8 && port <= 0x2ff) { this.com2.out8(port - 0x2f8, v); return; }
        switch (port) {
          case 0x20: case 0x21: {
            const had = this.pic.isr & 2;
            this.pic.out8(port, v);
            if (had && !(this.pic.isr & 2)) this.kbd.eoi();
            return;
          }
          case 0x40: case 0x41: case 0x42: case 0x43: this.pit.out8(port, v); return;
          case 0x61: this.port61 = v; this.updateSpeaker(); return;
          case 0x70: this.cmosIndex = v & 0x7f; return;
          case 0xf0: case 0xf1: return; // 数学协处理器的复位端口：Turbo Pascal 等检测协处理器时会写
          case 0x3d4: this.crtcIndex = v; return;
          case 0x3d5: {
            this.crtc[this.crtcIndex & 31] = v;
            if ((this.crtcIndex === 0x0e || this.crtcIndex === 0x0f) && !this.cpu.mmio && this.mem[0x449] <= 3) {
              const pos = (this.crtc[0x0e] << 8) | this.crtc[0x0f];
              this.hle.setCursor(Math.floor(pos / 80) % 25, pos % 80);
            }
            return;
          }
          default: if (this.video.out8(port, v)) return;
        }
        this.unknownPort(port, '写');
      },
    };
  }

  private unknownPort(port: number, what: string): void {
    if (this.unknownPorts.has(port)) return;
    this.unknownPorts.add(port);
    this.log(`程序${what}了端口 ${port.toString(16).toUpperCase()}h，该端口没有模拟的设备${what === '读' ? '（读到 FFh）' : '（写入被忽略）'}`);
  }

  private cmosRead(): number {
    const d = new Date();
    const bcd = (v: number) => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
    switch (this.cmosIndex) {
      case 0x00: return bcd(d.getSeconds());
      case 0x02: return bcd(d.getMinutes());
      case 0x04: return bcd(d.getHours());
      case 0x06: return d.getDay() + 1;
      case 0x07: return bcd(d.getDate());
      case 0x08: return bcd(d.getMonth() + 1);
      case 0x09: return bcd(d.getFullYear() % 100);
      case 0x0a: return 0x26;
      case 0x0b: return 0x02;
      case 0x0d: return 0x80;
      case 0x32: return bcd(Math.floor(d.getFullYear() / 100));
    }
    return 0;
  }

  // ======================= 事件 =======================

  log(msg: string): void { this.events.log?.(msg); }

  /** 端口 61h 的位 0（定时器 2 号通道门控）和位 1（喇叭数据）都为 1 时，喇叭按 2 号通道的频率发声 */
  private updateSpeaker(): void {
    const on = (this.port61 & 3) === 3;
    const freq = on ? Math.round(1193182 / this.pit.reload[2]) : 0;
    if (freq !== this.speakerFreq) {
      this.speakerFreq = freq;
      this.events.speaker?.(freq);
    }
  }
  bell(): void { this.events.bell?.(); }
  filesChanged(): void { this.events.filesChanged?.(); }
  consoleOut(ch: number): void {
    if (ch === 0x0a) this.console += '\n';
    else if (ch === 0x0d || ch === 0x07) { /* 忽略 */ }
    else if (ch === 0x08) this.console = this.console.slice(0, -1);
    else this.console += String.fromCharCode(ch);
    if (this.console.length > 200_000) this.console = this.console.slice(-100_000);
  }

  exit(code: number, message = ''): void {
    this.exitCode = code;
    this.lastExitCode = code;
    this.status = 'exited';
    this.message = message || `程序已结束，返回码 ${code}`;
    this.cpu.halted = true;
  }

  requestBreak(msg: string): void { this.breakRequest = msg; }

  // ======================= 装载 =======================

  /** 卸载程序（汇编失败时）：寄存器清零 */
  unload(): void {
    this.program = null;
    this.status = 'empty';
    this.pending = null;
    this.message = '';
    this.cpu.r.fill(0);
    this.cpu.s.fill(0);
    this.cpu.ip = 0;
    this.cpu.flags = 0xf002;
    this.history.clear();
    this.breakpoints.clear();
  }

  /** 装载程序；name 是程序文件名（写进环境变量块，程序可以由此知道自己的路径） */
  load(program: Program, cmdline = '', name = 'PROGRAM.EXE'): void {
    const cpu = this.cpu, mem = this.mem;
    this.program = program;
    mem.fill(0);
    // 中断向量表与 BIOS 桩代码
    const bios = BIOS_SEG * 16;
    for (let n = 0; n < 256; n++) {
      let off = n * STUB_SIZE;
      if (n === 8) off = STUB_INT8;
      else if (n === 9) off = STUB_INT9;
      mem[n * 4] = off & 0xff; mem[n * 4 + 1] = off >> 8;
      mem[n * 4 + 2] = BIOS_SEG & 0xff; mem[n * 4 + 3] = BIOS_SEG >> 8;
      const a = bios + n * STUB_SIZE;
      if (n === 0x16 || n === 0x21) mem.set([0xfb, TRAP_OPCODE, n, 0xcf], a); // STI 后再进入陷阱，等待键盘时可响应 IRQ1
      else mem.set([TRAP_OPCODE, n, 0xcf], a);
    }
    // INT 8：时钟滴答 -> 调用 INT 1Ch -> EOI
    mem.set([TRAP_OPCODE, 0x08, 0xcd, 0x1c, 0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf], bios + STUB_INT8);
    // 鼠标回调：保存寄存器 -> 陷阱（装入 AX~DI）-> CALL FAR CS:[0E20] -> 恢复寄存器 -> 陷阱（回调结束）-> IRET
    mem.set([0x50, 0x53, 0x51, 0x52, 0x56, 0x57, 0x55, 0x1e, 0x06, TRAP_OPCODE, MOUSE_VECTOR, 0x2e, 0xff, 0x1e, MOUSE_PTR & 0xff, MOUSE_PTR >> 8,
      0x07, 0x1f, 0x5d, 0x5f, 0x5e, 0x5a, 0x59, 0x5b, 0x58, TRAP_OPCODE, MOUSE_VECTOR + 1, 0xcf], bios + MOUSE_STUB);
    mem[MOUSE_VECTOR * 4] = MOUSE_STUB & 0xff; mem[MOUSE_VECTOR * 4 + 1] = MOUSE_STUB >> 8;
    mem[MOUSE_VECTOR * 4 + 2] = BIOS_SEG & 0xff; mem[MOUSE_VECTOR * 4 + 3] = BIOS_SEG >> 8;
    // INT 9：读键盘 -> 放入缓冲区 -> EOI
    mem.set([TRAP_OPCODE, 0x09, 0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf], bios + STUB_INT9);
    mem.set([0xea, 0x00, 0x00, 0x00, 0xf0], 0xffff0); // 复位向量（不会用到）
    // 8×8 字库：INT 43h 指向前 128 个字符，INT 1Fh 指向后 128 个
    if (Machine.font) {
      mem.set(Machine.font.subarray(0, 1024), bios + FONT_LO);
      mem.set(Machine.font.subarray(1024, 2048), bios + FONT_HI);
    }
    for (const [vec, off] of [[0x43, FONT_LO], [0x1f, FONT_HI]] as const) {
      mem[vec * 4] = off & 0xff; mem[vec * 4 + 1] = off >> 8; mem[vec * 4 + 2] = BIOS_SEG & 0xff; mem[vec * 4 + 3] = BIOS_SEG >> 8;
    }
    // BIOS 数据区
    const bda = 0x400;
    const w16 = (a: number, v: number) => { mem[a] = v & 0xff; mem[a + 1] = (v >> 8) & 0xff; };
    w16(bda + 0x10, 0x0021);
    w16(bda + 0x13, 640);
    w16(bda + 0x1a, 0x1e); w16(bda + 0x1c, 0x1e);
    mem[bda + 0x49] = 3;
    w16(bda + 0x4a, 80);
    w16(bda + 0x4c, 4000);
    w16(bda + 0x60, 0x0607);
    w16(bda + 0x63, 0x3d4);
    w16(bda + 0x80, 0x1e); w16(bda + 0x82, 0x3e);
    mem[bda + 0x84] = 24;
    for (let o = 0; o < 4000; o += 2) { mem[0xb8000 + o] = 0x20; mem[0xb8000 + o + 1] = 0x07; }
    // PSP
    const psp = program.pspSeg * 16;
    mem.set([0xcd, 0x20], psp);
    w16(psp + 2, MEM_TOP);
    // 环境变量块和内存控制块链：[环境 MCB][环境 256 字节][程序 MCB][PSP + 程序 … 到 640KB]
    const pspSeg = program.pspSeg, envSeg = pspSeg - 0x11;
    const env = ENV_TEMPLATE.replace('%NAME%', name.toUpperCase().slice(0, 64));
    for (let k = 0; k < env.length; k++) mem[envSeg * 16 + k] = env.charCodeAt(k) & 0xff;
    w16(psp + 0x2c, envSeg);
    w16(psp + 0x16, pspSeg); // 父进程（就是自己，表示由"命令行"启动）
    this.dosmem.first = envSeg - 1;
    const base = name.replace(/.[^.]*$/, '').toUpperCase().slice(0, 8);
    this.dosmem.write(envSeg - 1, false, pspSeg, 0x10, base);
    this.dosmem.write(pspSeg - 1, true, pspSeg, MEM_TOP - pspSeg, base);
    w16(0x500 + 0x100, envSeg - 1); // INT 21h 52h：0050:0100 处是第一个 MCB 的段地址
    const cmd = cmdline.slice(0, 126);
    mem[psp + 0x80] = cmd.length;
    for (let k = 0; k < cmd.length; k++) mem[psp + 0x81 + k] = cmd.charCodeAt(k) & 0xff;
    mem[psp + 0x81 + cmd.length] = 0x0d;
    // 程序映像
    for (const c of program.chunks) mem.set(c.bytes, c.addr);
    // 寄存器
    cpu.r.fill(0);
    cpu.s.fill(0);
    cpu.s[CS] = program.entry.cs;
    cpu.ip = program.entry.ip;
    cpu.s[SS] = program.stack.ss;
    cpu.r[SP] = program.stack.sp;
    cpu.s[DS] = program.pspSeg;
    cpu.s[ES] = program.pspSeg;
    cpu.flags = 0xf202;
    cpu.halted = false;
    cpu.waiting = false;
    if (program.format === 'com') {
      cpu.s[DS] = cpu.s[ES] = cpu.s[SS] = cpu.s[CS] = program.pspSeg;
      w16(program.pspSeg * 16 + 0xfffe, 0);
    }
    // 设备
    this.pic.irr = 0; this.pic.isr = 0; this.pic.imr = 0xb8; this.pic.vectorBase = 8;
    this.pit.reload = [0x10000, 0x10000, 0x10000];
    this.pit.out8(0x43, 0x36); this.pit.out8(0x40, 0); this.pit.out8(0x40, 0);
    this.port61 = 0;
    this.updateSpeaker();
    this.kbd.clear();
    this.clock = 0;
    this.video.reset();
    cpu.mmio = null;
    this.mouse.powerOn();
    this.com1.reset();
    this.com2.reset();
    this.hle.reset();
    this.hle.clearWarnings();
    this.unknownPorts.clear();
    this.history.clear();
    this.console = '';
    this.instructions = 0;
    this.status = 'ready';
    this.message = '';
    this.exitCode = 0;
    this.breakRequest = '';
    // 没有源码的程序（直接装载的 EXE/COM）无法判断哪里是代码，不做"跑飞"检查
    this.wildWarned = program.addrToLine.size === 0;
    this.pending = null;
    // 代码范围（用于发现"程序跑飞"）
    this.instrLen.clear();
    this.codeRanges = [];
    for (const e of program.listing) {
      if (!e.isCode || !e.bytes.length) continue;
      const lin = e.segment * 16 + e.offset;
      this.instrLen.set(lin, e.bytes.length);
    }
    const sorted = [...this.instrLen.entries()].sort((a, b) => a[0] - b[0]);
    for (const [a, len] of sorted) {
      const last = this.codeRanges[this.codeRanges.length - 1];
      if (last && a <= last[1] + 16) last[1] = Math.max(last[1], a + len);
      else this.codeRanges.push([a, a + len]);
    }
  }

  // ======================= 执行 =======================

  get linearIP(): number { return ((this.cpu.s[CS] << 4) + this.cpu.ip) & 0xfffff; }
  inBios(): boolean { return this.cpu.s[CS] === BIOS_SEG; }

  private inCode(lin: number): boolean {
    for (const [a, b] of this.codeRanges) if (lin >= a && lin < b) return true;
    // PSP 开头的 INT 20h（COM 程序用 RET 返回时会执行到这里）
    const psp = (this.program?.pspSeg ?? 0) * 16;
    if (lin >= psp && lin < psp + 2) return true;
    return false;
  }

  /** 执行一条 CPU 指令（含历史记录与设备时钟） */
  private exec1(): void {
    const cpu = this.cpu;
    if (this.history.enabled) {
      const visible = !this.inBios() && !cpu.repContinue && !cpu.waiting;
      this.history.begin(cpu, visible ? H_VISIBLE : 0);
    }
    if (cpu.halted) {
      // HLT：快进到下一次定时器中断；连着串口线时每次只前进一小段，以便及时收到数据
      const dt = Math.max(1, Math.min(this.pit.clocksToNextTick(), this.link ? 64 : Infinity));
      this.advanceTime(dt);
      this.kbd.tick(Math.ceil(dt / this.clocksPerInstr));
      cpu.step();
      return;
    }
    cpu.step();
    this.instructions++;
    // 等磁盘时一次多走一点时间（仍然足够细，能及时响应中断）
    this.advanceTime(this.busy ? Math.max(this.clocksPerInstr, Math.min(this.hle.busyRemaining(), 32)) : this.clocksPerInstr);
    this.kbd.tick(1);
  }

  /** 推进虚拟时间：定时器、串口 */
  private advanceTime(dt: number): void {
    this.clock += dt;
    this.pit.advance(dt);
    this.com1.tick(this.clock);
    this.com2.tick(this.clock);
    this.mouse.tick(this.clock);
  }

  /** 机器空闲（等待键盘、已停止）时，让时间流逝到 t（双机运行时保持两台机器的时间同步） */
  idleTo(t: number): void {
    if (t <= this.clock) return;
    if (this.status === 'exited' || this.status === 'empty') { this.clock = t; this.com1.tick(t); this.com2.tick(t); return; }
    this.advanceTime(t - this.clock);
  }

  /** 下一个串口事件（字节到达或发送完成）的时间，没有则为 Infinity */
  nextSerialEvent(): number {
    let t = Infinity;
    for (const u of [this.com1, this.com2]) {
      t = Math.min(t, u.nextEvent());
      if (this.link && (u === this.link.a || u === this.link.b)) t = Math.min(t, this.link.nextArrival(u));
    }
    return t;
  }

  /** 检查执行一条指令之后是否需要停下 */
  private checkStop(): StopReason | null {
    const cpu = this.cpu;
    if (this.status === 'exited') return 'exit';
    if (cpu.waiting && !this.busy && !this.kbd.queue.length && !(cpu.irq!.pending() && cpu.flags & IF)) {
      this.status = 'waiting';
      this.message = '程序正在等待键盘输入（点击屏幕后直接打字）';
      return 'wait';
    }
    if (cpu.halted && !(cpu.flags & IF)) {
      this.status = 'error';
      this.message = 'CPU 执行了 HLT 且中断已关闭（IF=0），不会再被唤醒';
      return 'error';
    }
    if (!this.inBios()) {
      if (this.breakRequest) {
        this.message = this.breakRequest;
        this.breakRequest = '';
        this.status = 'paused';
        return 'breakpoint';
      }
      const lin = this.linearIP;
      if (!this.wildWarned && !this.inCode(lin)) {
        this.wildWarned = true;
        this.status = 'paused';
        this.message = 'CPU 跑到了程序代码之外：可能是程序末尾忘了用 MOV AH,4CH / INT 21H 结束，或者跳转/返回地址错误。可以继续执行，但结果难以预料。';
        return 'error';
      }
    }
    return null;
  }

  /** 单步（进入）：执行一条用户指令；穿过 BIOS 代码和 REP 的剩余迭代 */
  stepInto(): StopReason {
    if (!this.canRun()) return this.status === 'exited' ? 'exit' : 'error';
    this.pending = { kind: 'step' };
    this.message = '';
    this.exec1();
    return this.continuePending(2_000_000);
  }

  /** CS:IP 处的指令是调用还是返回（跳过前缀） */
  private callKind(): 'call' | 'ret' | '' {
    const cs = this.cpu.s[CS];
    let ip = this.cpu.ip, op = 0;
    for (let k = 0; k < 8; k++) {
      op = this.cpu.rb(cs, ip);
      if (![0x26, 0x2e, 0x36, 0x3e, 0xf0, 0xf1, 0xf2, 0xf3].includes(op)) break;
      ip = (ip + 1) & 0xffff;
    }
    if (op === 0xe8 || op === 0x9a) return 'call';
    if (op === 0xff) { const reg = (this.cpu.rb(cs, ip + 1) >> 3) & 7; return reg === 2 || reg === 3 ? 'call' : ''; }
    if ((op >= 0xc0 && op <= 0xc3) || (op >= 0xc8 && op <= 0xcb) || op === 0xcf) return 'ret';
    return '';
  }

  /**
   * 跳出：一直运行到当前子程序（或中断处理程序）返回为止。
   * 用"调用深度"判断：CALL 和进入中断加 1，RET/IRET 减 1，变成负数就是从当前子程序返回了。
   */
  stepOut(): StopReason {
    if (!this.canRun()) return this.status === 'exited' ? 'exit' : 'error';
    this.pending = { kind: 'out', depth: 0 };
    this.message = '';
    return this.continuePending(50_000_000);
  }

  /** 修改寄存器、标志位或内存：记入历史，"后退"可以撤销 */
  poke(fn: () => void): void {
    if (this.history.enabled) this.history.begin(this.cpu, H_VISIBLE);
    fn();
  }

  /** 单步（跳过）：CALL、INT、REP 串操作和 LOOP 整体执行 */
  stepOver(): StopReason {
    if (!this.canRun()) return this.status === 'exited' ? 'exit' : 'error';
    const cpu = this.cpu;
    const lin = this.linearIP;
    const len = this.instrLen.get(lin);
    let k = 0;
    let op = this.mem[lin];
    while (len && k < len - 1 && [0x26, 0x2e, 0x36, 0x3e, 0xf0, 0xf2, 0xf3].includes(op)) op = this.mem[(lin + ++k) & 0xfffff];
    const modrmReg = (this.mem[(lin + k + 1) & 0xfffff] >> 3) & 7;
    const isCall = op === 0xe8 || op === 0x9a || (op === 0xff && (modrmReg === 2 || modrmReg === 3));
    const isInt = op === 0xcd || op === 0xcc || op === 0xce;
    const isLoop = op >= 0xe0 && op <= 0xe2;
    if (len && (isCall || isInt || isLoop)) {
      this.pending = { kind: 'over', cs: cpu.s[CS], ip: (cpu.ip + len) & 0xffff, sp: cpu.r[SP] };
      this.message = '';
      this.exec1();
      return this.continuePending(50_000_000);
    }
    return this.stepInto();
  }

  /** 连续运行，最多执行 budget 条指令 */
  /** 连续运行：最多执行 budget 条指令，或者虚拟时间到达 untilClock 为止 */
  run(budget: number, untilClock = Infinity): StopReason {
    if (!this.canRun()) return this.status === 'exited' ? 'exit' : 'error';
    if (!this.pending || this.pending.kind !== 'run') { this.pending = { kind: 'run' }; this.message = ''; }
    this.status = 'running';
    return this.continuePending(budget, untilClock);
  }

  /** 暂停连续运行 */
  pause(): void {
    if (this.status === 'running' || this.status === 'waiting') {
      this.pending = null;
      this.status = 'paused';
      this.message = '已暂停';
    }
  }

  private canRun(): boolean {
    if (!this.program || this.status === 'empty') return false;
    if (this.status === 'exited') return false;
    return true;
  }

  /** 继续执行尚未完成的单步/跳过/运行（例如等到按键之后） */
  continuePending(budget: number, untilClock = Infinity): StopReason {
    let p = this.pending;
    if (!p) return 'paused';
    const cpu = this.cpu;
    if (this.status !== 'running') this.status = p.kind === 'run' ? 'running' : 'paused';
    for (let n = 0; n < budget; n++) {
      if (p.kind === 'run' && this.clock >= untilClock) return 'budget';
      if (p.kind === 'out') {
        if (n > 0 && !this.inBios() && !cpu.repContinue && this.breakpoints.has(this.linearIP)) return this.stopAt('breakpoint');
        const kind = this.callKind(), ints = cpu.interrupts;
        this.exec1();
        if (!cpu.irqTaken) p.depth += kind === 'call' ? 1 : kind === 'ret' ? -1 : 0;
        p.depth += cpu.interrupts - ints;
        if (p.depth < 0) p = this.pending = { kind: 'step' }; // 已经返回：再走出 BIOS 代码就停
      } else if (n > 0 || p.kind === 'run') {
        // 是否已到达停止点
        if (p.kind === 'step' && !this.inBios() && !cpu.repContinue && !cpu.waiting) return this.stopAt('step');
        if (p.kind === 'over' && cpu.s[CS] === p.cs && cpu.ip === p.ip && cpu.r[SP] >= p.sp && !cpu.repContinue) return this.stopAt('step');
        if (p.kind === 'over' && !this.inBios() && n > 0 && this.breakpoints.has(this.linearIP) && !cpu.repContinue) return this.stopAt('breakpoint');
        if (p.kind === 'run' && n > 0 && !this.inBios() && !cpu.repContinue && this.breakpoints.has(this.linearIP)) return this.stopAt('breakpoint');
        this.exec1();
      }
      const s = this.checkStop();
      if (s) {
        if (s !== 'wait') this.pending = null;
        if (s === 'breakpoint' || s === 'error') return s;
        return s;
      }
    }
    if (p.kind === 'run') return 'budget';
    this.pending = null;
    this.status = 'paused';
    this.message = '这一步执行的指令太多，已暂停';
    return 'paused';
  }

  private stopAt(reason: StopReason): StopReason {
    this.pending = null;
    this.status = 'paused';
    if (reason === 'breakpoint') this.message = '到达断点';
    return reason;
  }

  /** 反向单步：撤销上一条用户指令 */
  stepBack(): boolean {
    if (!this.program) return false;
    let any = false;
    for (;;) {
      const f = this.history.undo(this.cpu, (a, old) => this.video.planar.restore(a, old));
      if (f < 0) break;
      any = true;
      if (f & H_VISIBLE) break;
    }
    if (any) {
      this.pending = null;
      if (this.status === 'exited' || this.status === 'waiting' || this.status === 'error') this.status = 'paused';
      if (this.status === 'ready' && this.history.count === 0) this.status = 'ready';
      this.message = this.history.count === 0 ? '已回到程序开头' : '';
      if (this.instructions > 0) this.instructions--;
    }
    return any;
  }

  get canStepBack(): boolean { return this.history.count > 0; }

  // ======================= 键盘 =======================

  pressKey(e: KeyEvent): void {
    this.kbd.push(e);
  }

  typeText(text: string, scanFor: (ch: string) => number): void {
    for (const ch of text) {
      const scan = scanFor(ch);
      const ascii = ch === '\n' ? 0x0d : ch.charCodeAt(0) & 0xff;
      this.kbd.push({ scan, ascii, release: false });
      this.kbd.push({ scan: scan | 0x80, ascii: 0, release: true });
    }
  }
}
