// 虚拟 PC：CPU + 内存 + 中断控制器 + 定时器 + 键盘 + BIOS/DOS，以及调试功能
import { CPU, CS, DS, ES, SS, SP, DX, AX, BX, CX, BP, SI, DI, IF, BIOS_SEG, TRAP_OPCODE, type IOBus } from '../cpu/cpu.ts';
import { Disk } from './disk.ts';
import { FloppyController } from './fdc.ts';
import { IdeChannel } from './ide.ts';
import { SerialMouse } from './serial-mouse.ts';
import type { Program } from '../asm/types.ts';
import { PIC, PIT, DMA, Keyboard, type KeyEvent } from './devices.ts';
import { AtapiCdrom } from './atapi.ts';
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
/**
 * 其他硬件中断（IRQ2~7、IRQ8~15，除了鼠标的 IRQ12）的默认处理程序：每个 16 字节，需要的话先进陷阱，再用真的
 * OUT 指令给中断控制器发 EOI。不能在 JavaScript 里直接改中断控制器：Windows 增强模式把中断送进虚拟 8086 模式的
 * BIOS 处理时，要截获到 EOI 才会重新打开这个中断（否则它一直屏蔽着，例如硬盘的 IRQ14，32 位磁盘驱动就等不到中断）
 */
const IRQ_STUBS = 0x1600;
const IRQ_VECTORS = [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x70, 0x71, 0x72, 0x73, 0x76, 0x77]; // 74h 是鼠标（IRQ12），75h 是鼠标桩代码用的陷阱号
import { STUB_INT10, int10Stub } from './vgarom.ts';
import { DISK_ROM, diskRom } from './diskrom.ts';
/** 软盘参数表、硬盘参数表在 F000 段里的位置（与 IBM AT BIOS 相同） */
const DPT_OFF = 0xefc7;
const FDPT_OFF = 0xe401;

/** "从光驱启动"用的驱动器号（启动后光盘里的软盘映像当作 A:） */
export const CD_BOOT = 0xe0;

export function driveName(drive: number): string {
  if (drive === CD_BOOT) return '光驱';
  return drive >= 0x80 ? String.fromCharCode(67 + drive - 0x80) + ':' : String.fromCharCode(65 + drive) + ':';
}

/** 反向执行用的历史记录：每条指令执行前的寄存器 + 该指令覆盖掉的内存旧值 */
class History {
  readonly cap = 200_000;
  /** 每条记录 18 项：8 个 32 位通用寄存器、6 个段寄存器、IP、FLAGS、停机/等待、标志 */
  private regs = new Uint32Array(this.cap * 18);
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
    const o = i * 18;
    const r = this.regs;
    for (let k = 0; k < 8; k++) r[o + k] = cpu.r32(k);
    for (let k = 0; k < 6; k++) r[o + 8 + k] = cpu.s[k];
    r[o + 14] = cpu.ip;
    r[o + 15] = cpu.flags;
    r[o + 16] = (cpu.halted ? 1 : 0) | (cpu.waiting ? 2 : 0);
    r[o + 17] = flags;
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

  /** 最近 n 条记录里 CS = seg 的指令的偏移（反汇编往回找指令起点时用） */
  recentOffsets(seg: number, n = 4096): Set<number> {
    const out = new Set<number>();
    for (let k = 1; k <= Math.min(n, this.count); k++) {
      const o = ((this.head - k) % this.cap) * 18;
      if (this.regs[o + 9] === seg) out.add(this.regs[o + 14]);
    }
    return out;
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
      if (a >= PLANAR_HISTORY) restore(a - PLANAR_HISTORY, this.wold[j]); // 显卡平面里的字节
      else cpu.mem[a] = this.wold[j];
    }
    this.wpos = start;
    const o = i * 18, r = this.regs;
    for (let k = 0; k < 8; k++) cpu.setR32(k, r[o + k]);
    for (let k = 0; k < 6; k++) cpu.s[k] = r[o + 8 + k];
    cpu.ip = r[o + 14];
    cpu.flags = r[o + 15];
    cpu.halted = (r[o + 16] & 1) !== 0;
    cpu.waiting = (r[o + 16] & 2) !== 0;
    return r[o + 17];
  }
}

const H_VISIBLE = 1;
/** 历史记录里显卡平面字节的地址从这里开始（内存是 16MB，不会和它重叠） */
const PLANAR_HISTORY = 0x1000000;

export interface MachineEvents {
  log?(msg: string): void;
  bell?(): void;
  filesChanged?(): void;
  /** 磁盘映像被写过 */
  disksChanged?(): void;
  /** PC 喇叭：频率（Hz），0 表示不响 */
  speaker?(freq: number): void;
}

export class Machine {
  cpu = new CPU();
  mem = this.cpu.mem;
  pic = new PIC();
  /** AT 机的第二个中断控制器（IRQ8~15，接在主片的 IRQ2 上） */
  pic2 = new PIC();
  dma = new DMA();
  /** IDE 第二通道上的 ATAPI 光驱（IRQ15） */
  cdrom = new AtapiCdrom(() => this.pic2.raise(7), () => this.pic2.lower(7));
  /** IDE 第一通道上的 ATA 硬盘（IRQ14）：C: 主盘、D: 从盘，给 Windows 95 的 32 位磁盘驱动用；DOS 经 INT 13h 读写 */
  ide = new IdeChannel({
    disk: u => this.drives[2 + u],
    irq: () => this.pic2.raise(6),
    irqOff: () => this.pic2.lower(6),
    now: () => this.clock,
    written: () => this.disksChanged(),
  });
  /** 软驱控制器（端口 3F0h~3F7h，IRQ6，DMA 2 号通道）：给 Windows 95 这样自己操作软驱的系统用；DOS 经 INT 13h 读写 */
  fdc = new FloppyController({
    disk: d => this.driveFor(d),
    driveExists: d => d === 0 || (d === 1 && (this.mem[0x410] & 0xc1) === 0x41),
    now: () => this.clock,
    irq: () => this.pic.raise(6),
    dma: data => (this.dma.ready(2) ? this.dma.transfer(2, data, this.cpu) : null), // 方向由通道的模式决定（和真机一样）
    written: d => { const x = this.drives[d]; if (x) x.dirty = true; this.disksChanged(); },
  });
  // ---- 实时钟的中断（IRQ8）：CMOS 寄存器 A 的周期中断、每秒一次的更新结束中断；寄存器 C 是中断标志 ----
  private rtcFlags = 0;
  private rtcNextPeriodic = Infinity;
  private rtcNextSecond = 0;
  /** 下一个实时钟事件的时间（PIT 时钟） */
  private rtcNext = 0;
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

  /** 选择 CPU 型号：决定速度和指令集（8088、80286、80386） */
  setCpu(id: CpuSpeedId): void {
    const s = CPU_SPEEDS.find(x => x.id === id)!;
    this.cpuModel = id;
    this.clocksPerInstr = s.clocks;
    this.cpu.is286 = s.is286;
    this.cpu.is386 = id === '386';
    this.cpu.setFlags(this.cpu.flags); // 位 12-15：8086 为 1，286 为 0
  }
  com1 = new UART('COM1', 0x3f8, 4, () => this.clock, on => (on ? this.pic.raise(4) : this.pic.lower(4)));
  com2 = new UART('COM2', 0x2f8, 3, () => this.clock, on => (on ? this.pic.raise(3) : this.pic.lower(3)));
  /** 连接到另一台机器的串口线 */
  link: NullModem | null = null;
  hle = new Hle(this);
  dosmem = new DosMemory(this.cpu);
  video = new Video();
  mouse = new Mouse();
  /** COM2 上的 Microsoft 串口鼠标（给 Windows 等直接操作串口的鼠标驱动用） */
  serialMouse = new SerialMouse(this.mouse);
  /** 8×8 字库（256 个字符 × 8 字节），装载程序时写进 BIOS ROM；默认是内置点阵，界面会用浏览器字体补全其余字符 */
  static font: Uint8Array | null = builtinFont();
  history = new History();
  /** 虚拟磁盘：文件名（大写）-> 内容 */
  files = new Map<string, Uint8Array>();
  /** 磁盘映像：0 = A:，1 = B:（软驱），2 = C:，3 = D:（硬盘）；换程序、重启时保留 */
  drives: (Disk | null)[] = [null, null, null, null];
  /** 从光驱启动用的软盘映像（光盘里 El Torito 的启动软盘，由界面事先读出来） */
  cdBoot: Disk | null = null;
  /** 这次是从光驱启动的：光盘里的软盘映像当作 A:，原来的 A: 变成 B:（和真的 BIOS 一样，到下次启动为止） */
  private cdEmu: Disk | null = null;
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
  private cmosIndex = 0;
  /** CMOS 的 128 字节（时间以外的部分）：关机原因（0Fh）、软驱和硬盘类型、内存大小等 */
  cmos = new Uint8Array(128);
  private kbcOutputPending = false;
  private kbcWriteOutput = false;
  private port92 = 0;
  private retrace = 0;
  private unknownPorts = new Set<number>();

  constructor() {
    const cpu = this.cpu;
    cpu.io = this.makeBus();
    const pic = this.pic, kbd = this.kbd;
    pic.slave = this.pic2;
    this.pic2.reset(0x70, 0xff);
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
    // A0000~BFFFF 的显存都在显卡的 4 个平面里
    cpu.mmio = this.video;
    cpu.onUnsupported = msg => { this.fatal = msg; };
    cpu.onShutdown = () => this.cpuReset(); // 三重错误：主板复位 CPU
    this.pit.onReload = ch => { if (ch === 2) this.updateSpeaker(); };
    cpu.onWrite = (a, old) => { if (this.history.enabled) this.history.write(a, old); };
    this.video.planar.onWrite = (a, old) => { if (this.history.enabled) this.history.write(PLANAR_HISTORY + a, old); };
    this.com1.onWarn = this.com2.onWarn = msg => this.log(msg);
    this.com2.peer = this.serialMouse;
  }

  // ======================= 端口 =======================

  private makeBus(): IOBus {
    return {
      in8: (port) => {
        if (port >= 0x3f8 && port <= 0x3ff) return this.com1.in8(port - 0x3f8);
        if (port >= 0x2f8 && port <= 0x2ff) return this.com2.in8(port - 0x2f8);
        if (FloppyController.owns(port)) return this.fdc.in8(port);
        switch (port) {
          case 0x20: case 0x21: return this.pic.in8(port);
          case 0xa0: case 0xa1: return this.pic2.in8(port & 0x21);
          case 0x40: case 0x41: case 0x42: case 0x43: return this.pit.in8(port);
          case 0x60:
            if (this.kbcOutputPending) { this.kbcOutputPending = false; return this.kbcOutputPort(); } // 命令 D0h 的回答
            return this.kbd.in60();
          case 0x61: return (this.port61 & 0xcf) | ((Math.floor(this.clock / 18) & 1) << 4); // 位 4：内存刷新，约每 15 微秒翻转一次（AT 机上程序用它计时）
          case 0x64: return this.kbd.outputFull || this.kbd.queue.length || this.kbcOutputPending ? 0x15 : 0x14;
          case 0x92: return this.cpu.a20Enabled ? 0x02 : 0x00;
          case 0x71: return this.cmosRead();
          case 0x3da: this.retrace ^= 0x09; this.video.resetAttrFlip(); return this.retrace;
          case 0xf0: case 0xf1: return 0xff; // 数学协处理器（没有）
          case 0x3c0: case 0x3c1: case 0x3c4: case 0x3c5: case 0x3c6: case 0x3c7: case 0x3c8: case 0x3c9:
          case 0x3cc: case 0x3ce: case 0x3cf: case 0x3d9: case 0x3ca: case 0x3c3: case 0x3d4: case 0x3d5: return this.video.in8(port);
        }
        if (DMA.owns(port)) return this.dma.in8(port);
        if (AtapiCdrom.owns(port)) return this.cdrom.in8(port);
        if (IdeChannel.owns(port)) return this.ide.in8(port);
        this.unknownPort(port, '读');
        return 0xff;
      },
      wide: (port) => port === 0x170 || port === 0x1f0,
      in16: port => (port === 0x1f0 ? this.ide.in16() : this.cdrom.in16()),
      out16: (port, v) => { if (port === 0x1f0) this.ide.out16(v); else this.cdrom.out16(v); },
      out8: (port, v) => {
        if (port >= 0x3f8 && port <= 0x3ff) { this.com1.out8(port - 0x3f8, v); return; }
        if (port >= 0x2f8 && port <= 0x2ff) { this.com2.out8(port - 0x2f8, v); return; }
        if (FloppyController.owns(port)) { this.fdc.out8(port, v); return; }
        switch (port) {
          case 0x20: case 0x21: {
            const had = this.pic.isr & 2;
            this.pic.out8(port, v);
            if (had && !(this.pic.isr & 2)) this.kbd.eoi();
            return;
          }
          case 0x40: case 0x41: case 0x42: case 0x43: this.pit.out8(port, v); return;
          case 0x61: this.port61 = v; this.updateSpeaker(); return;
          case 0x64: // 键盘控制器（8042）的命令
            switch (v) {
              case 0xd0: this.kbcOutputPending = true; return;  // 读输出端口：下一次读 60h 得到
              case 0xd1: this.kbcWriteOutput = true; return;    // 写输出端口：下一次写 60h 的字节
              case 0xdd: this.cpu.setA20(false); return;
              case 0xdf: this.cpu.setA20(true); return;
              case 0xfe: this.cpuReset(); return;               // 复位 CPU
            }
            if (v >= 0xf0 && !(v & 1)) this.cpuReset();         // F0h~FEh：脉冲输出端口，位 0 为 0 时复位 CPU
            return;
          case 0x60:
            if (this.kbcWriteOutput) {
              // 输出端口：位 1 是 A20 门，位 0 为 0 时复位 CPU
              this.kbcWriteOutput = false;
              this.cpu.setA20((v & 2) !== 0);
              if (!(v & 1)) this.cpuReset();
              return;
            }
            return; // 发给键盘的命令（设置指示灯等）：接受但不模拟
          case 0x92: { // "快速 A20"端口：位 1 是 A20，位 0 从 0 变 1 时复位 CPU
            this.cpu.setA20((v & 2) !== 0);
            const reset = v & 1 && !(this.port92 & 1);
            this.port92 = v;
            if (reset) this.cpuReset();
            return;
          }
          case 0x71: this.cmosWrite(v); return;
          case 0xa0: case 0xa1: this.pic2.out8(port & 0x21, v); return;
          case 0x70: this.cmosIndex = v & 0x7f; return;
          case 0xf0: case 0xf1: return; // 数学协处理器的复位端口：Turbo Pascal 等检测协处理器时会写
          case 0x3d4: this.video.crtcIndex = v; return;
          case 0x3d5: {
            const vc = this.video, ci = vc.crtcIndex & 31;
            vc.crtc[ci] = v;
            if ((ci === 0x0e || ci === 0x0f) && !(vc.planar.gc[6] & 1) && this.mem[0x449] <= 3) {
              const pos = (vc.crtc[0x0e] << 8) | vc.crtc[0x0f];
              this.hle.setCursor(Math.floor(pos / 80) % 25, pos % 80);
            }
            return;
          }
          default: if (this.video.out8(port, v)) return;
        }
        if (DMA.owns(port)) { this.dma.out8(port, v); return; }
        if (AtapiCdrom.owns(port)) { this.cdrom.out8(port, v); return; }
        if (IdeChannel.owns(port)) { this.ide.out8(port, v); return; }
        this.unknownPort(port, '写');
      },
    };
  }

  private unknownPort(port: number, what: string): void {
    if (this.unknownPorts.has(port)) return;
    this.unknownPorts.add(port);
    this.log(`程序${what}了端口 ${port.toString(16).toUpperCase()}h，该端口没有模拟的设备${what === '读' ? '（读到 FFh）' : '（写入被忽略）'}`);
  }

  private kbcOutputPort(): number {
    return 0xdd | (this.cpu.a20Enabled ? 0x02 : 0);
  }

  private cmosWrite(v: number): void {
    const i = this.cmosIndex;
    if ([0x00, 0x02, 0x04, 0x06, 0x07, 0x08, 0x09, 0x32, 0x0c, 0x0d].includes(i)) return; // 时间、日期跟着电脑的时钟走；C、D 只读
    this.cmos[i] = v;
    if (i === 0x0a || i === 0x0b) this.rtcSchedule();
  }

  /** BIOS 的 IRQ8 处理：读一次寄存器 C */
  rtcAck(): void { this.rtcFlags = 0; }

  /** 实时钟的周期：寄存器 A 的低 4 位是速率（3~15：8192Hz~2Hz；1、2 按 256Hz、128Hz），0 表示关闭 */
  private rtcSchedule(): void {
    const rate = this.cmos[0x0a] & 0x0f;
    if (!rate || !(this.cmos[0x0b] & 0x40)) this.rtcNextPeriodic = Infinity;
    else {
      const hz = 32768 >> ((rate < 3 ? rate + 7 : rate) - 1);
      const period = 1193182 / hz;
      this.rtcNextPeriodic = this.clock + period;
    }
    if (this.rtcNextSecond <= this.clock) this.rtcNextSecond = this.clock + 1193182;
    this.rtcNext = Math.min(this.rtcNextPeriodic, this.rtcNextSecond);
  }

  /** 到了实时钟事件的时间：设置寄存器 C 的标志，允许的话在 IRQ8 上发中断（读寄存器 C 之前不会再发） */
  private rtcEvent(): void {
    const b = this.cmos[0x0b];
    let fire = 0;
    if (this.clock >= this.rtcNextPeriodic) {
      fire |= 0x40;
      const rate = this.cmos[0x0a] & 0x0f;
      const period = 1193182 / (32768 >> ((rate < 3 ? rate + 7 : rate) - 1));
      while (this.rtcNextPeriodic <= this.clock) this.rtcNextPeriodic += period;
    }
    if (this.clock >= this.rtcNextSecond) {
      fire |= 0x10;
      while (this.rtcNextSecond <= this.clock) this.rtcNextSecond += 1193182;
    }
    this.rtcNext = Math.min(this.rtcNextPeriodic, this.rtcNextSecond);
    this.rtcFlags |= fire;
    if (fire & b & 0x70 && !(this.rtcFlags & 0x80)) {
      this.rtcFlags |= 0x80;
      this.pic2.raise(0);
    }
  }

  /** CMOS 的初始内容：1.44MB 软驱、640KB 常规内存、扩展内存（286 时 15MB） */
  private initCmos(): void {
    const c = this.cmos;
    c.fill(0);
    c[0x0a] = 0x26; c[0x0b] = 0x02;        // 实时钟：32768Hz 晶振、1024Hz 周期；24 小时制，周期中断关闭
    c[0x10] = 0x40 | (this.driveFor(1) ? 0x04 : 0); // A:（和有盘时的 B:）是 1.44MB 软驱
    c[0x14] = 0x01 | (this.driveFor(1) ? 0x40 : 0); // 设备字节
    c[0x15] = 0x80; c[0x16] = 0x02;        // 常规内存 640KB
    const ext = this.cpu.is286 ? 15360 : 0;
    c[0x17] = c[0x30] = ext & 0xff; c[0x18] = c[0x31] = ext >> 8;
    // 硬盘类型：12h 的高、低 4 位是 C:、D:，Fh 表示看 19h/1Ah 的扩展类型；47 = 用户自定义，参数在 1Bh~23h、24h~2Ch
    for (const k of [0, 1]) {
      const d = this.drives[2 + k];
      if (!d) continue;
      c[0x12] |= k ? 0x0f : 0xf0;
      c[0x19 + k] = 47;
      const p = k ? 0x24 : 0x1b, cyl = d.geo.cylinders;
      c[p] = cyl & 0xff; c[p + 1] = cyl >> 8; c[p + 2] = d.geo.heads;
      c[p + 3] = 0xff; c[p + 4] = 0xff;                       // 写预补偿：没有
      c[p + 5] = cyl & 0xff; c[p + 6] = cyl >> 8; c[p + 7] = d.geo.sectors; // 着陆区、每道扇区数
    }
    // 10h~2Dh 的校验和（2Eh 高字节、2Fh 低字节）
    let sum = 0;
    for (let k = 0x10; k <= 0x2d; k++) sum += c[k];
    c[0x2e] = (sum >> 8) & 0xff; c[0x2f] = sum & 0xff;
  }

  /**
   * CPU 被复位（键盘控制器命令、端口 92h、三重错误）。AT 机上程序用这个办法从 286 的保护模式回到实模式：
   * 先在 CMOS 的 0Fh 写"关机原因"、在 0040:0067 放好返回地址，再复位 CPU。BIOS 开机时看到原因是
   * 05h 或 0Ah 就不重新开机，而是直接跳到 0040:0067（05h 还要先给中断控制器发 EOI）
   */
  cpuReset(): void {
    const code = this.cmos[0x0f];
    this.cmos[0x0f] = 0;
    const cpu = this.cpu;
    if (code === 0x05 || code === 0x0a || code === 0x09) {
      cpu.resetProtected();
      cpu.setFlags(0x0002);
      cpu.halted = false;
      cpu.waiting = false;
      if (code === 0x05) this.pic.out8(0x20, 0x20);
      const m = this.mem;
      const off = m[0x467] | (m[0x468] << 8), seg = m[0x469] | (m[0x46a] << 8);
      if (code === 0x09) {
        // "从 INT 15h 87h（搬移扩展内存）返回"：0040:0067 存的是 SS:SP。AT 机 BIOS 的做法是
        // 换回这个堆栈，弹出 DS、ES，再 POPA、IRET（Windows 3.0 标准模式的 DOSX 就是按这个顺序准备堆栈的）
        const r = cpu.r;
        cpu.s[SS] = seg; r[SP] = off;
        cpu.s[DS] = cpu.pop();
        cpu.s[ES] = cpu.pop();
        r[DI] = cpu.pop(); r[SI] = cpu.pop(); r[BP] = cpu.pop(); cpu.pop();
        r[BX] = cpu.pop(); r[DX] = cpu.pop(); r[CX] = cpu.pop(); r[AX] = cpu.pop();
        cpu.ip = cpu.pop(); cpu.s[CS] = cpu.pop(); cpu.setFlags(cpu.pop());
        return;
      }
      cpu.ip = off;
      cpu.s[CS] = seg;
      return;
    }
    this.reboot();
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
      case 0x0c: { const f = this.rtcFlags; this.rtcFlags = 0; return f; } // 读出后清零
      case 0x0d: return 0x80;
      case 0x32: return bcd(Math.floor(d.getFullYear() / 100));
    }
    return this.cmos[this.cmosIndex];
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
    this.cpu.setFlags(0x0002);
    this.history.clear();
    this.breakpoints.clear();
  }

  /** 装载程序；name 是程序文件名（写进环境变量块，程序可以由此知道自己的路径） */
  load(program: Program, cmdline = '', name = 'PROGRAM.EXE'): void {
    const cpu = this.cpu, mem = this.mem;
    this.program = program;
    this.cdEmu = program.format === 'boot' && program.bootDrive === CD_BOOT ? this.cdBoot : null;
    mem.fill(0);
    // 中断向量表与 BIOS 桩代码
    const bios = BIOS_SEG * 16;
    for (let n = 0; n < 256; n++) {
      let off = n * STUB_SIZE;
      if (n === 8) off = STUB_INT8;
      else if (n === 9) off = STUB_INT9;
      else if (n === 0x10) off = STUB_INT10;
      else if (n === 0x13) off = DISK_ROM; // 硬盘读写经 IDE 端口，其余进入陷阱（diskrom.ts）
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
    // 先用 IN AL,60h 真的读一次键盘端口（Windows 增强模式的 DOS 窗口里，键盘驱动截获这个读操作送出扫描码），再进陷阱
    mem.set([0x50, 0xe4, 0x60, TRAP_OPCODE, 0x09, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf], bios + STUB_INT9);
    // INT 10h：陷阱，切换显示模式后再用 OUT 指令写 VGA 寄存器（见 vgarom.ts）
    mem.set(int10Stub(0x10), bios + STUB_INT10);
    IRQ_VECTORS.forEach((n, k) => {
      const off = IRQ_STUBS + k * 16;
      const trap = n === 0x0e || n === 0x70 || n === 0x76 ? [TRAP_OPCODE, n] : [];
      const eoi = n >= 0x70 ? [0xb0, 0x20, 0xe6, 0xa0, 0xe6, 0x20] : [0xb0, 0x20, 0xe6, 0x20]; // mov al,20h / (out 0A0h,al) / out 20h,al
      mem.set([...trap, 0x50, ...eoi, 0x58, 0xcf], bios + off);  // （陷阱）push ax / EOI / pop ax / iret
      mem[n * 4] = off & 0xff; mem[n * 4 + 1] = off >> 8;
    });
    mem.set(diskRom(0x13 * STUB_SIZE, FDPT_OFF), bios + DISK_ROM);
    // 复位向量：跳到 F000:E05B（IBM PC 的开机入口），那里的陷阱重新启动机器
    mem.set([0xea, 0x5b, 0xe0, 0x00, 0xf0], 0xffff0);
    mem.set([TRAP_OPCODE, 0x19, 0xcf], bios + 0xe05b);
    // 软盘参数表（INT 1Eh 指向它，DOS 的引导扇区会复制并修改它）
    mem.set([0xdf, 0x02, 0x25, 0x02, 0x12, 0x1b, 0xff, 0x6c, 0xf6, 0x0f, 0x08], bios + DPT_OFF);
    mem[0x1e * 4] = DPT_OFF & 0xff; mem[0x1e * 4 + 1] = DPT_OFF >> 8;
    // 硬盘参数表（INT 41h、46h 指向第一、二个硬盘的）
    for (const [k, vec] of [[2, 0x41], [3, 0x46]] as const) {
      const d = this.drives[k], t = bios + FDPT_OFF + (k - 2) * 16;
      if (d && !d.floppy) {
        mem[t] = d.geo.cylinders & 0xff; mem[t + 1] = d.geo.cylinders >> 8; mem[t + 2] = d.geo.heads;
        mem[t + 12] = d.geo.cylinders & 0xff; mem[t + 13] = d.geo.cylinders >> 8; mem[t + 14] = d.geo.sectors;
      }
      const off = FDPT_OFF + (k - 2) * 16;
      mem[vec * 4] = off & 0xff; mem[vec * 4 + 1] = off >> 8;
    }
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
    // 设备字：位 0 有软驱，位 6~7 软驱数 − 1，位 4~5 = 00 表示 EGA/VGA（显卡有自己的 BIOS）
    const floppies = this.driveFor(1) ? 2 : 1;
    w16(bda + 0x10, 0x0001 | ((floppies - 1) << 6));
    // EGA/VGA 的信息：87h 显存 256KB、显示器是彩色的；88h 开关设置；89h VGA 的模式设置选项
    mem[bda + 0x87] = 0x60; mem[bda + 0x88] = 0x09; mem[bda + 0x89] = 0x11; mem[bda + 0x8a] = 0x0b;
    // 显卡 BIOS 的 ROM：C000:0000 起是 55AAh 标志和长度（32KB），程序据此判断有 EGA/VGA 显卡
    mem.set([0x55, 0xaa, 0x40], 0xc0000);
    mem.set(Array.from('IBM VGA COMPATIBLE BIOS (AsmPerfect 86)', c => c.charCodeAt(0)), 0xc001e);
    mem[bda + 0x75] = (this.drives[2] ? 1 : 0) + (this.drives[3] ? 1 : 0); // 硬盘个数
    w16(bda + 0x13, 640);
    w16(bda + 0x1a, 0x1e); w16(bda + 0x1c, 0x1e);
    mem[bda + 0x49] = 3;
    w16(bda + 0x4a, 80);
    w16(bda + 0x4c, 4000);
    w16(bda + 0x60, 0x0607);
    w16(bda + 0x63, 0x3d4);
    w16(bda + 0x80, 0x1e); w16(bda + 0x82, 0x3e);
    mem[bda + 0x84] = 24;
    if (program.format === 'boot') this.loadBootSector(program.bootDrive ?? 0);
    else this.loadProgram(program, cmdline, name);
    // 设备
    this.pic.reset(8, 0xb8);
    this.pic2.reset(0x70, 0xff);
    this.dma.reset();
    this.cdrom.reset();
    this.ide.reset();
    this.fdc.reset();
    this.rtcFlags = 0;
    this.pit.reload = [0x10000, 0x10000, 0x10000];
    this.pit.out8(0x43, 0x36); this.pit.out8(0x40, 0); this.pit.out8(0x40, 0);
    this.port61 = 0;
    this.updateSpeaker();
    this.kbd.clear();
    this.clock = 0;
    this.video.reset();
    this.video.loadModeRegs(3);
    this.video.clearText();
    cpu.mmio = this.video;
    cpu.resetProtected();
    cpu.setA20(false);
    this.kbcOutputPending = this.kbcWriteOutput = false;
    this.port92 = 0;
    this.initCmos();
    this.rtcNextSecond = 0; this.rtcSchedule();
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
    this.poweredOff = false;
    this.loadTail();
  }

  /** 开机：把启动盘的第一个扇区读到 0000:7C00，从那里开始执行（DL = 驱动器号） */
  private loadBootSector(drive: number): void {
    const cpu = this.cpu, mem = this.mem;
    // 和 BIOS 一样按 A:、C: 的顺序：A: 没有盘时从 C: 启动
    if (drive === CD_BOOT) {
      if (!this.cdEmu) throw new Error('光驱里没有可以启动的光盘');
      drive = 0;
    }
    if (drive === 0 && !this.driveFor(0) && this.drives[2]) drive = 0x80;
    const d = this.driveFor(drive);
    if (!d) throw new Error(`${driveName(drive)} 没有磁盘映像，不能启动`);
    const sec = d.readSector(0)!;
    if (sec[510] !== 0x55 || sec[511] !== 0xaa) throw new Error(`${driveName(drive)} 的磁盘不能启动（第一个扇区末尾没有引导标记 55AAh；空白的硬盘需要先用启动软盘分区、格式化）`);
    mem.set(sec, 0x7c00);
    // 开机自检时 BIOS 按 CMOS 时钟设置"午夜以来的滴答数"，DOS 由此得到当前时间
    const now = new Date();
    const ticks = Math.floor(((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1193182 / 65536);
    mem[0x46c] = ticks & 0xff; mem[0x46d] = (ticks >> 8) & 0xff; mem[0x46e] = (ticks >> 16) & 0xff; mem[0x46f] = 0;
    cpu.r.fill(0);
    cpu.s.fill(0);
    cpu.s[CS] = 0; cpu.ip = 0x7c00;
    cpu.s[SS] = 0; cpu.r[SP] = 0x7c00;
    cpu.r[DX] = drive;
    cpu.setFlags(0x0202);
    cpu.halted = false;
    cpu.waiting = false;
    cpu.resetProtected();
    for (const x of this.drives) if (x) x.changed = true;
    if (this.cdEmu) this.cdEmu.changed = true;
  }

  /** 关机：屏幕变黑，喇叭不响，程序停止（磁盘映像的内容保留） */
  powerOff(message = '已关机'): void {
    const mem = this.mem;
    this.cpu.mmio = this.video;
    this.video.reset();
    this.video.loadModeRegs(3);
    mem[0x449] = 3;
    this.video.clearText();
    mem[0x450] = 0; mem[0x451] = 0;
    mem[0x460] = 0x20; mem[0x461] = 0x20; // 光标形状：位 5 = 不显示光标
    this.mouse.visible = -1;
    this.mouse.used = false;
    this.port61 = 0;
    this.updateSpeaker();
    this.exit(0, message);
    this.poweredOff = true;
  }

  /** CPU 遇到了模拟器不支持的情况（例如进入保护模式），下一次检查时停机 */
  private fatal = '';

  /** 已经关机（关机后要重新启动才能运行） */
  poweredOff = false;

  /** INT 19h 或复位：从原来的启动盘重新启动；普通程序调用时忽略 */
  reboot(): void {
    const p = this.program;
    if (!p || p.format !== 'boot') { this.log('程序调用了 INT 19h（重新启动），只有从磁盘启动时才有效，已忽略'); return; }
    try { this.load(p); } catch (e) { this.exit(0, (e as Error).message); }
  }

  disksChanged(): void { this.events.disksChanged?.(); }

  /** BIOS 收到 Ctrl+Alt+Del：从磁盘启动时热启动；运行普通程序时只提示 */
  ctrlAltDel(): void {
    if (this.program?.format === 'boot') { this.log('Ctrl+Alt+Del：重新启动'); this.reboot(); return; }
    this.log('Ctrl+Alt+Del：只有从磁盘启动时才会重新启动；要重新运行程序请点"重启"');
  }

  /** 依次按下 Ctrl、Alt、Del 再松开（工具栏按钮用：浏览器收不到真的 Ctrl+Alt+Del） */
  sendCtrlAltDel(): void {
    const keys = [0x1d, 0x38, 0x53];
    for (const scan of keys) this.pressKey({ scan, ascii: 0, release: false });
    for (const scan of [...keys].reverse()) this.pressKey({ scan: scan | 0x80, ascii: 0, release: true });
  }

  /** 段 seg 里已知的指令起点（偏移）：最近执行过的指令、程序入口、引导扇区的入口 7C00。反汇编往回找对齐时用 */
  knownInstructionStarts(seg: number): Set<number> {
    const out = this.history.recentOffsets(seg);
    const p = this.program;
    if (p) {
      if (p.entry.cs === seg) out.add(p.entry.ip);
      if (p.format === 'boot' && seg === 0) out.add(0x7c00);
    }
    out.add(this.cpu.s[CS] === seg ? this.cpu.ip : -1);
    return out;
  }

  /** BIOS 驱动器号对应的磁盘映像（0、1 软驱，80h、81h 硬盘；从光驱启动时 0 是光盘里的软盘映像，1 是原来的 A:） */
  driveFor(drive: number): Disk | null {
    if (drive === 0) return this.cdEmu ?? this.drives[0];
    if (drive === 1) return this.cdEmu ? this.drives[0] : this.drives[1];
    if (drive === 0x80 || drive === 0x81) return this.drives[drive - 0x80 + 2];
    return null;
  }

  /** 装载汇编出来的程序或 EXE/COM：PSP、环境变量、内存控制块、程序映像和寄存器 */
  private loadProgram(program: Program, cmdline: string, name: string): void {
    const cpu = this.cpu, mem = this.mem;
    const w16 = (a: number, v: number) => { mem[a] = v & 0xff; mem[a + 1] = (v >> 8) & 0xff; };
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
    cpu.setFlags(0x0202);
    cpu.halted = false;
    cpu.waiting = false;
    if (program.format === 'com') {
      cpu.s[DS] = cpu.s[ES] = cpu.s[SS] = cpu.s[CS] = program.pspSeg;
      w16(program.pspSeg * 16 + 0xfffe, 0);
    }
  }

  /** load() 的最后一部分（原来紧跟在设备复位之后的代码） */
  private loadTail(): void {
    const program = this.program!;
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

  get linearIP(): number { return this.cpu.linearIP; }
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
      const dt = Math.max(1, Math.min(this.pit.clocksToNextTick(), this.link ? 64 : Infinity, Math.ceil(this.rtcNext - this.clock), Math.ceil(this.fdc.next - this.clock), Math.ceil(this.ide.next - this.clock)));
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
    if (this.clock >= this.rtcNext) this.rtcEvent();
    if (this.cdrom.pending) this.cdrom.poll();
    if (this.ide.pending) this.ide.poll();
    if (this.clock >= this.ide.next) this.ide.tick();
    if (this.clock >= this.fdc.next) this.fdc.tick();
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
    t = Math.min(t, this.serialMouse.nextArrival());
    return t;
  }

  /** 检查执行一条指令之后是否需要停下 */
  private checkStop(): StopReason | null {
    const cpu = this.cpu;
    if (this.status === 'exited') return 'exit';
    if (this.fatal) {
      this.status = 'error';
      this.message = this.fatal;
      this.fatal = '';
      return 'error';
    }
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
