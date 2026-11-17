// 虚拟 PC：CPU + 内存 + 中断控制器 + 定时器 + 键盘 + BIOS/DOS，以及调试功能
import { CPU, CS, DS, ES, SS, SP, IF, BIOS_SEG, TRAP_OPCODE, type IOBus } from '../cpu/cpu.ts';
import type { Program } from '../asm/types.ts';
import { PIC, PIT, Keyboard, type KeyEvent } from './devices.ts';
import { Hle } from './bios.ts';

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
  undo(cpu: CPU): number {
    if (this.count === 0) return -1;
    this.head--;
    this.count--;
    const i = this.head % this.cap;
    const start = this.wstart[i];
    for (let w = this.wpos - 1; w >= start; w--) {
      const j = w % this.wcap;
      cpu.mem[this.waddr[j]] = this.wold[j];
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
}

export class Machine {
  cpu = new CPU();
  mem = this.cpu.mem;
  pic = new PIC();
  kbd = new Keyboard(this.pic);
  pit = new PIT(() => this.pic.raise(0));
  hle = new Hle(this);
  history = new History();
  /** 虚拟磁盘：文件名（大写）-> 内容 */
  files = new Map<string, Uint8Array>();

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
  private pending: { kind: 'step' } | { kind: 'over'; cs: number; ip: number; sp: number } | { kind: 'run' } | null = null;
  private port61 = 0;
  private crtcIndex = 0;
  private crtc = new Uint8Array(32);
  private cmosIndex = 0;
  private retrace = 0;
  private unknownPorts = new Set<number>();

  constructor() {
    const cpu = this.cpu;
    cpu.io = this.makeBus();
    const pic = this.pic, kbd = this.kbd;
    cpu.irq = {
      pending: () => pic.pending(),
      ack: () => {
        const v = pic.ack();
        if (v === pic.vectorBase + 1) kbd.delivered();
        return v;
      },
    };
    cpu.trap = (n) => this.hle.handle(n);
    cpu.onWrite = (a, old) => { if (this.history.enabled) this.history.write(a, old); };
  }

  // ======================= 端口 =======================

  private makeBus(): IOBus {
    return {
      in8: (port) => {
        switch (port) {
          case 0x20: case 0x21: return this.pic.in8(port);
          case 0x40: case 0x41: case 0x42: case 0x43: return this.pit.in8(port);
          case 0x60: return this.kbd.in60();
          case 0x61: return this.port61;
          case 0x64: return this.kbd.queue.length ? 0x15 : 0x14;
          case 0x71: return this.cmosRead();
          case 0x3d4: return this.crtcIndex;
          case 0x3d5: return this.crtc[this.crtcIndex & 31];
          case 0x3da: this.retrace ^= 0x09; return this.retrace;
        }
        this.unknownPort(port, '读');
        return 0xff;
      },
      out8: (port, v) => {
        switch (port) {
          case 0x20: case 0x21: {
            const had = this.pic.isr & 2;
            this.pic.out8(port, v);
            if (had && !(this.pic.isr & 2)) this.kbd.eoi();
            return;
          }
          case 0x40: case 0x41: case 0x42: case 0x43: this.pit.out8(port, v); return;
          case 0x61: this.port61 = v; return;
          case 0x70: this.cmosIndex = v & 0x7f; return;
          case 0x3d4: this.crtcIndex = v; return;
          case 0x3d5: {
            this.crtc[this.crtcIndex & 31] = v;
            if (this.crtcIndex === 0x0e || this.crtcIndex === 0x0f) {
              const pos = (this.crtc[0x0e] << 8) | this.crtc[0x0f];
              this.hle.setCursor(Math.floor(pos / 80) % 25, pos % 80);
            }
            return;
          }
          case 0x3d8: case 0x3d9: return;
        }
        this.unknownPort(port, '写');
      },
    };
  }

  private unknownPort(port: number, what: string): void {
    if (this.unknownPorts.has(port)) return;
    this.unknownPorts.add(port);
    const hint = port >= 0x3f8 && port <= 0x3ff ? '（COM1 串口，暂未模拟）' : port >= 0x2f8 && port <= 0x2ff ? '（COM2 串口，暂未模拟）' : '';
    this.log(`程序${what}了端口 ${port.toString(16).toUpperCase()}h${hint}，该端口没有模拟的设备${what === '读' ? '（读到 FFh）' : '（写入被忽略）'}`);
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

  load(program: Program, cmdline = ''): void {
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
    // INT 9：读键盘 -> 放入缓冲区 -> EOI
    mem.set([TRAP_OPCODE, 0x09, 0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf], bios + STUB_INT9);
    mem.set([0xea, 0x00, 0x00, 0x00, 0xf0], 0xffff0); // 复位向量（不会用到）
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
    w16(psp + 2, 0xa000);
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
    this.kbd.clear();
    this.hle.reset(Math.ceil(program.imageEnd / 16) + 0x10);
    this.hle.clearWarnings();
    this.unknownPorts.clear();
    this.history.clear();
    this.console = '';
    this.instructions = 0;
    this.status = 'ready';
    this.message = '';
    this.exitCode = 0;
    this.breakRequest = '';
    this.wildWarned = false;
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
      // HLT：快进到下一次定时器中断
      const n = this.pit.instrsToNextTick();
      this.pit.advance(n * PIT.CLOCKS_PER_INSTR);
      this.kbd.tick(n);
      cpu.step();
      return;
    }
    cpu.step();
    this.instructions++;
    this.pit.advance(PIT.CLOCKS_PER_INSTR);
    this.kbd.tick(1);
  }

  /** 检查执行一条指令之后是否需要停下 */
  private checkStop(): StopReason | null {
    const cpu = this.cpu;
    if (this.status === 'exited') return 'exit';
    if (cpu.waiting && !this.kbd.queue.length && !(this.pic.pending() && cpu.flags & IF)) {
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
  run(budget: number): StopReason {
    if (!this.canRun()) return this.status === 'exited' ? 'exit' : 'error';
    if (!this.pending || this.pending.kind !== 'run') { this.pending = { kind: 'run' }; this.message = ''; }
    this.status = 'running';
    return this.continuePending(budget);
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
  continuePending(budget: number): StopReason {
    const p = this.pending;
    if (!p) return 'paused';
    const cpu = this.cpu;
    if (this.status !== 'running') this.status = p.kind === 'run' ? 'running' : 'paused';
    for (let n = 0; n < budget; n++) {
      if (n > 0 || p.kind === 'run') {
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
      const f = this.history.undo(this.cpu);
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
