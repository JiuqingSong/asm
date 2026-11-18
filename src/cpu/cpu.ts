// 8086/8088 与 80286 CPU 模拟器核心（按指令解释执行）
//
// 设计要点：
// - 内存是 16MB 的 Uint8Array。8088 只用 20 位地址（超过 1MB 回绕）；286 用 24 位地址，
//   第 20 位受 A20 门控制（关闭时和 8086 一样回绕）。
// - 每个段寄存器有一份"描述符缓存"（基址、界限、访问权限）。实模式下基址就是 段值 × 16；
//   保护模式下段寄存器里是选择子，基址、界限、权限从 GDT/LDT 的描述符里取，
//   每次访问内存都检查界限和权限，不合规时产生异常（#GP、#SS、#NP、#TS）。
// - 指令执行到一半出了异常：抛出 CpuFault，IP 和 SP 退回指令开头，再通过 IDT 交给异常处理程序
//   （保护模式）或中断向量表（实模式）。处理异常时又出异常是双重错误（#DF），再出错就"停机"（复位 CPU）。
// - 每次 step() 执行一条完整指令（含前缀）。REP 串指令每次只执行一次迭代，
//   未完成时把 IP 退回指令开头并置 repContinue，与真实 8086 的可中断行为一致。
// - BIOS/DOS 功能用"陷阱"实现：中断向量指向 F000 段里的小桩代码
//   `F1 nn CF`（陷阱 + 中断号 + IRET），CPU 在实模式下执行到陷阱时回调 JS。
// - 端口读写通过 IOBus 分发，硬件中断通过 IrqSource 注入。

export const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3;

export const CF = 0x0001, PF = 0x0004, AF = 0x0010, ZF = 0x0040, SF = 0x0080;
export const TF = 0x0100, IF = 0x0200, DF = 0x0400, OF = 0x0800;
export const IOPL = 0x3000, NT = 0x4000;

export interface IOBus {
  in8(port: number): number;
  out8(port: number, value: number): void;
}

export interface IrqSource {
  /** 是否有待处理的可屏蔽中断 */
  pending(): boolean;
  /** 应答中断，返回中断向量号 */
  ack(): number;
}

/** 陷阱回调：返回 true 表示处理完毕；false 表示需要等待（例如等键盘输入） */
export type TrapHandler = (intNo: number) => boolean;

/** CPU 异常：向量号和错误码（-1 表示这个异常没有错误码） */
export class CpuFault {
  vector: number;
  code: number;
  constructor(vector: number, code = -1) { this.vector = vector; this.code = code; }
}

/** 段描述符（286 格式：界限 16 位、基址 24 位、访问权限字节） */
interface Desc {
  base: number;
  limit: number;
  access: number;
  /** 描述符在内存里的线性地址（设置"已访问"位、忙位时用） */
  addr: number;
  /** 门：目标偏移、选择子、参数个数 */
  gateOff: number;
  gateSel: number;
  gateCount: number;
}

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, p = 0;
  while (b) { p ^= b & 1; b >>= 1; }
  PARITY[i] = p ? 0 : PF;
}

export const TRAP_OPCODE = 0xf1;
export const BIOS_SEG = 0xf000;
/** 内存大小：16MB（286 的 24 位地址空间） */
export const MEM_SIZE = 0x1000000;

const nullBus: IOBus = { in8: () => 0xff, out8: () => {} };

/** 抛出异常的小工具 */
const gp = (code = 0) => new CpuFault(13, code & 0xfffc);
const np = (code: number) => new CpuFault(11, code & 0xfffc);
const ssf = (code = 0) => new CpuFault(12, code & 0xfffc);
const ts = (code: number) => new CpuFault(10, code & 0xfffc);

export class CPU {
  mem: Uint8Array;
  /** 通用寄存器：AX CX DX BX SP BP SI DI（与 ModR/M 编码顺序一致） */
  r = new Uint16Array(8);
  /** 段寄存器：ES CS SS DS（保护模式下是选择子） */
  s = new Uint16Array(4);
  ip = 0;
  flags = 0xf002;

  io: IOBus = nullBus;
  irq: IrqSource | null = null;
  trap: TrapHandler | null = null;
  /** 内存写入钩子（用于反向执行的历史记录）：参数为线性地址和写入前的旧值 */
  onWrite: ((addr: number, old: number) => void) | null = null;
  /** 显卡显存（EGA/VGA 平面模式时 A0000~AFFFF 的读写交给它；参数是段内偏移） */
  mmio: { read(off: number): number; write(off: number, v: number): void } | null = null;

  halted = false;
  /**
   * 选 286/386 时为 true：按 80286 工作（186/286 的新指令、24 位地址、保护模式等）。
   * 为 false 时是 8086/8088（用 SingleStepTests/8088 验证过的行为，不受 286 部分影响）
   */
  private _is286 = false;
  get is286(): boolean { return this._is286; }
  set is286(v: boolean) { this._is286 = v; this.updateAddrMask(); }
  /** 陷阱处理函数要求等待（如等待按键），CPU 停在陷阱处 */
  waiting = false;
  /** 上一步是一个尚未完成的 REP 串操作迭代 */
  repContinue = false;
  /** 上一步是进入硬件中断（没有执行 CS:IP 处的指令） */
  irqTaken = false;
  /** 进入中断的总次数（INT 指令、异常、硬件中断） */
  interrupts = 0;
  /** 已执行的指令步数 */
  steps = 0;

  // ---- 286：机器状态字、描述符表寄存器、段描述符缓存 ----
  /** 机器状态字（MSW）：位 0 PE（保护模式），位 3 TS（任务切换过）；286 上没用的高位读出来是 1 */
  msw = 0xfff0;
  gdtr = { base: 0, limit: 0xffff };
  idtr = { base: 0, limit: 0x3ff };
  ldtr = { sel: 0, base: 0, limit: 0 };
  tr = { sel: 0, base: 0, limit: 0 };
  /** 各段寄存器的描述符缓存 */
  cBase = new Int32Array(4);
  cLimit = new Int32Array(4).fill(0xffff);
  cAccess = new Uint8Array([0x93, 0x9b, 0x93, 0x93]);
  /** 保护模式下装入了空选择子（不能用来访问内存） */
  cNull = new Uint8Array(4);
  /** 实模式下由 LOADALL 设置了基址的段（不再是 段值 × 16），按位表示 */
  private overrideMask = 0;
  /** 当前特权级（保护模式下等于 CS 的 RPL） */
  cpl = 0;
  /** A20 地址线（286）：关闭时地址第 20 位恒为 0 */
  private a20 = false;
  /** 地址掩码：8086 为 FFFFFh；286 为 FFFFFFh（A20 关闭时去掉第 20 位） */
  private addrMask = 0xfffff;
  /** 程序做了模拟器不支持的事：调用者据此停机并说明原因 */
  onUnsupported: ((message: string) => void) | null = null;
  /** 停机（异常处理时连续出错，"三重错误"）：真机上主板会复位 CPU */
  onShutdown: (() => void) | null = null;

  // ---- 译码临时状态 ----
  private segOvr = -1;
  private rep = 0;
  private mod = 0;
  private reg = 0;
  private rm = 0;
  /** 内存操作数所用的段寄存器（下标）和偏移 */
  private eaSi = DS;
  private eaOff = 0;
  private inhibitIrq = false;
  private startIP = 0;
  private startSP = 0;

  constructor(mem?: Uint8Array) {
    this.mem = mem ?? new Uint8Array(MEM_SIZE);
  }

  get protectedMode(): boolean { return (this.msw & 1) !== 0; }

  /** 复位 CPU 的 286 部分（开机、键盘控制器复位）：回到实模式 */
  resetProtected(): void {
    this.msw = 0xfff0;
    this.gdtr = { base: 0, limit: 0xffff };
    this.idtr = { base: 0, limit: 0x3ff };
    this.ldtr = { sel: 0, base: 0, limit: 0 };
    this.tr = { sel: 0, base: 0, limit: 0 };
    this.cLimit.fill(0xffff);
    this.cAccess.set([0x93, 0x9b, 0x93, 0x93]);
    this.cNull.fill(0);
    this.overrideMask = 0;
    this.cpl = 0;
  }

  setA20(on: boolean): void { this.a20 = on; this.updateAddrMask(); }
  get a20Enabled(): boolean { return this.a20; }
  private updateAddrMask(): void {
    this.addrMask = !this._is286 ? 0xfffff : this.a20 ? 0xffffff : 0xefffff;
  }

  // ================= 内存访问 =================

  /** 段寄存器 i 当前的基址 */
  segBase(i: number): number {
    if (!(this.msw & 1) && !(this.overrideMask & (1 << i))) return this.s[i] << 4;
    return this.cBase[i];
  }

  /** CS:IP 对应的线性地址 */
  get linearIP(): number { return (this.segBase(CS) + this.ip) & this.addrMask; }

  /** 按线性地址读写（已经过 A20 处理） */
  readLin(a: number): number {
    if (this.mmio !== null && (a >>> 16) === 0xa) return this.mmio.read(a & 0xffff);
    return this.mem[a];
  }
  writeLin(a: number, v: number): void {
    if (this.mmio !== null && (a >>> 16) === 0xa) { this.mmio.write(a & 0xffff, v & 0xff); return; }
    if (this.onWrite) this.onWrite(a, this.mem[a]);
    this.mem[a] = v & 0xff;
  }

  /** 实模式风格的访问：段值 × 16 + 偏移（给 BIOS/DOS 的高层模拟和测试用） */
  rb(seg: number, off: number): number {
    return this.readLin(((seg << 4) + (off & 0xffff)) & this.addrMask);
  }
  rw(seg: number, off: number): number {
    return this.rb(seg, off) | (this.rb(seg, off + 1) << 8);
  }
  wb(seg: number, off: number, v: number): void {
    this.writeLin(((seg << 4) + (off & 0xffff)) & this.addrMask, v);
  }
  ww(seg: number, off: number, v: number): void {
    this.wb(seg, off, v);
    this.wb(seg, off + 1, v >> 8);
  }

  /** 保护模式下检查对段 i 的访问：空选择子、读写权限、界限 */
  private check(i: number, off: number, size: number, write: boolean): void {
    if (this.cNull[i]) throw i === SS ? ssf(0) : gp(0);
    const acc = this.cAccess[i];
    if (write) {
      if (acc & 8 || !(acc & 2)) throw i === SS ? ssf(0) : gp(0); // 代码段、只读数据段不能写
    } else if ((acc & 0x0a) === 0x08) throw gp(0);                // 只能执行的代码段不能读
    const lim = this.cLimit[i];
    if (!(acc & 8) && acc & 4) { // 向下扩展的数据段：有效偏移是 界限+1 ~ FFFFh
      if (off <= lim || off + size - 1 > 0xffff) throw i === SS ? ssf(0) : gp(0);
    } else if (off + size - 1 > lim) throw i === SS ? ssf(0) : gp(0);
  }

  /** 通过段寄存器 i 访问内存 */
  private rbS(i: number, off: number): number {
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 1, false);
    return this.readLin((this.segBase(i) + off) & this.addrMask);
  }
  private rwS(i: number, off: number): number {
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 2, false);
    const b = this.segBase(i);
    return this.readLin((b + off) & this.addrMask) | (this.readLin((b + ((off + 1) & 0xffff)) & this.addrMask) << 8);
  }
  private wbS(i: number, off: number, v: number): void {
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 1, true);
    this.writeLin((this.segBase(i) + off) & this.addrMask, v);
  }
  private wwS(i: number, off: number, v: number): void {
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 2, true);
    const b = this.segBase(i);
    this.writeLin((b + off) & this.addrMask, v);
    this.writeLin((b + ((off + 1) & 0xffff)) & this.addrMask, v >> 8);
  }
  /** 系统表（GDT、IDT、TSS）的读写：线性地址 */
  private rwL(a: number): number { return this.readLin(a & this.addrMask) | (this.readLin((a + 1) & this.addrMask) << 8); }
  private wwL(a: number, v: number): void { this.writeLin(a & this.addrMask, v); this.writeLin((a + 1) & this.addrMask, v >> 8); }

  private fetch8(): number {
    if (this.msw & 1 && this.ip > this.cLimit[CS]) throw gp(0);
    const v = this.readLin((this.segBase(CS) + this.ip) & this.addrMask);
    this.ip = (this.ip + 1) & 0xffff;
    return v;
  }
  private fetch16(): number {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }
  private fetchS8(): number {
    const v = this.fetch8();
    return v & 0x80 ? v - 0x100 : v;
  }

  // ================= 寄存器 =================

  getR8(i: number): number {
    return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8;
  }
  setR8(i: number, v: number): void {
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0x00ff) | ((v & 0xff) << 8);
  }

  setFlags(v: number): void {
    // 8086：位 12-15 恒为 1；286 实模式：位 12-15 恒为 0（程序用这一点区分 8086 和 286）；
    // 286 保护模式：位 12-13 是 IOPL，位 14 是 NT。位 1 恒为 1，位 3、5 恒为 0
    if (!this._is286) this.flags = (v & 0x0fd5) | 0xf002;
    else this.flags = (v & (this.msw & 1 ? 0x7fd5 : 0x0fd5)) | 0x0002;
  }
  private get iopl(): number { return (this.flags >> 12) & 3; }

  private setF(mask: number, on: boolean | number): void {
    if (on) this.flags |= mask; else this.flags &= ~mask;
  }
  private szp8(v: number): void {
    this.flags = (this.flags & ~(SF | ZF | PF)) | (v & 0x80 ? SF : 0) | (v === 0 ? ZF : 0) | PARITY[v];
  }
  private szp16(v: number): void {
    this.flags = (this.flags & ~(SF | ZF | PF)) | (v & 0x8000 ? SF : 0) | (v === 0 ? ZF : 0) | PARITY[v & 0xff];
  }
  private szp(v: number, w: boolean): void {
    if (w) this.szp16(v); else this.szp8(v);
  }

  // ================= 栈 =================

  push(v: number): void {
    const sp = (this.r[SP] - 2) & 0xffff;
    this.wwS(SS, sp, v);
    this.r[SP] = sp;
  }
  pop(): number {
    const v = this.rwS(SS, this.r[SP]);
    this.r[SP] += 2;
    return v;
  }

  // ================= 段寄存器的装入 =================

  /** 读描述符表里的一项；选择子超出表的范围时 #GP(选择子) */
  private desc(sel: number, fault: (code: number) => CpuFault = gp): Desc {
    const idx = sel & 0xfff8;
    let base: number, limit: number;
    if (sel & 4) {
      if (!this.ldtr.sel) throw fault(sel);
      base = this.ldtr.base; limit = this.ldtr.limit;
    } else { base = this.gdtr.base; limit = this.gdtr.limit; }
    if (idx + 7 > limit) throw fault(sel);
    const a = base + idx;
    const m = (k: number) => this.readLin((a + k) & this.addrMask);
    return {
      limit: m(0) | (m(1) << 8),
      base: m(2) | (m(3) << 8) | (m(4) << 16),
      access: m(5),
      addr: a,
      gateOff: m(0) | (m(1) << 8),
      gateSel: m(2) | (m(3) << 8),
      gateCount: m(4) & 0x1f,
    };
  }

  /** 设置描述符的"已访问"位 */
  private touch(d: Desc): void {
    if (!(d.access & 1)) { d.access |= 1; this.writeLin((d.addr + 5) & this.addrMask, d.access); }
  }

  private setCache(i: number, sel: number, d: Desc): void {
    this.s[i] = sel;
    this.cBase[i] = d.base;
    this.cLimit[i] = d.limit;
    this.cAccess[i] = d.access;
    this.cNull[i] = 0;
  }

  /** 装入 ES、SS、DS（MOV、POP、LES/LDS 等） */
  private loadSeg(i: number, sel: number): void {
    if (!(this.msw & 1)) {
      this.s[i] = sel;
      this.cBase[i] = sel << 4;
      this.overrideMask &= ~(1 << i);
      return;
    }
    if (i === CS) throw new CpuFault(6); // 不能用 MOV/POP 装入 CS
    const rpl = sel & 3;
    if ((sel & 0xfffc) === 0) {
      if (i === SS) throw gp(0);
      this.s[i] = sel; this.cNull[i] = 1; this.cBase[i] = 0; this.cLimit[i] = 0;
      return;
    }
    const d = this.desc(sel);
    const dpl = (d.access >> 5) & 3;
    if (i === SS) {
      // 堆栈段：必须是可写的数据段，RPL 和 DPL 都等于 CPL
      if (rpl !== this.cpl || dpl !== this.cpl || (d.access & 0x1a) !== 0x12) throw gp(sel);
      if (!(d.access & 0x80)) throw ssf(sel);
    } else {
      // 数据段或可读的代码段；数据段和非一致代码段要求 max(CPL, RPL) <= DPL
      if (!(d.access & 0x10) || (d.access & 0x0a) === 0x08) throw gp(sel);
      const conforming = (d.access & 0x0c) === 0x0c;
      if (!conforming && Math.max(this.cpl, rpl) > dpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
    }
    this.touch(d);
    this.setCache(i, sel, d);
  }

  /** 检查并返回一个可以转移到的代码段描述符（JMP/CALL/RET/IRET 共用的部分） */
  private codeDesc(sel: number): Desc {
    if ((sel & 0xfffc) === 0) throw gp(0);
    const d = this.desc(sel);
    if ((d.access & 0x18) !== 0x18) throw gp(sel);
    return d;
  }

  private loadCS(sel: number, d: Desc, cpl: number): void {
    this.touch(d);
    this.setCache(CS, (sel & 0xfffc) | cpl, d);
    this.cpl = cpl;
  }

  /** 特权级下降后，DPL 比新 CPL 高（数值小）的数据段寄存器要清成空选择子 */
  private nullifyDataSegs(): void {
    for (const i of [ES, DS]) {
      if (this.cNull[i]) continue;
      const acc = this.cAccess[i], dpl = (acc >> 5) & 3;
      const conformingCode = (acc & 0x0c) === 0x0c && acc & 0x08;
      if (!conformingCode && dpl < this.cpl) { this.s[i] = 0; this.cNull[i] = 1; }
    }
  }

  // ================= 远转移 =================

  private farJump(sel: number, off: number): void {
    if (!(this.msw & 1)) { this.s[CS] = sel; this.cBase[CS] = sel << 4; this.overrideMask &= ~2; this.ip = off; return; }
    if ((sel & 0xfffc) === 0) throw gp(0);
    const d = this.desc(sel);
    const dpl = (d.access >> 5) & 3, rpl = sel & 3;
    if (d.access & 0x10) {
      if (!(d.access & 0x08)) throw gp(sel);
      if (d.access & 0x04) { if (dpl > this.cpl) throw gp(sel); }
      else if (rpl > this.cpl || dpl !== this.cpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      if (off > d.limit) throw gp(0);
      this.loadCS(sel, d, this.cpl);
      this.ip = off;
      return;
    }
    const type = d.access & 0x0f;
    if (type === 4) { // 调用门：JMP 不能改变特权级
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      const t = this.codeDesc(d.gateSel);
      const tdpl = (t.access >> 5) & 3;
      if (t.access & 0x04 ? tdpl > this.cpl : tdpl !== this.cpl) throw gp(d.gateSel);
      if (!(t.access & 0x80)) throw np(d.gateSel);
      if (d.gateOff > t.limit) throw gp(0);
      this.loadCS(d.gateSel, t, this.cpl);
      this.ip = d.gateOff;
      return;
    }
    if (type === 1 || type === 5) { // 任务状态段或任务门
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      this.taskSwitch(type === 5 ? d.gateSel : sel, 'jmp');
      return;
    }
    throw gp(sel);
  }

  private farCall(sel: number, off: number): void {
    const r = this.r;
    if (!(this.msw & 1)) {
      this.push(this.s[CS]); this.push(this.ip);
      this.s[CS] = sel; this.cBase[CS] = sel << 4; this.overrideMask &= ~2; this.ip = off;
      return;
    }
    if ((sel & 0xfffc) === 0) throw gp(0);
    const d = this.desc(sel);
    const dpl = (d.access >> 5) & 3, rpl = sel & 3;
    if (d.access & 0x10) {
      if (!(d.access & 0x08)) throw gp(sel);
      if (d.access & 0x04) { if (dpl > this.cpl) throw gp(sel); }
      else if (rpl > this.cpl || dpl !== this.cpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      if (off > d.limit) throw gp(0);
      // 先压栈（可能出 #SS），再换 CS
      const sp = r[SP];
      this.push(this.s[CS]); this.push(this.ip);
      try { this.loadCS(sel, d, this.cpl); } catch (e) { r[SP] = sp; throw e; }
      this.ip = off;
      return;
    }
    const type = d.access & 0x0f;
    if (type === 4) { // 调用门
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      const t = this.codeDesc(d.gateSel);
      const tdpl = (t.access >> 5) & 3;
      if (tdpl > this.cpl) throw gp(d.gateSel);
      if (!(t.access & 0x80)) throw np(d.gateSel);
      if (d.gateOff > t.limit) throw gp(0);
      if (!(t.access & 0x04) && tdpl < this.cpl) {
        // 调用更高特权级的过程：换到 TSS 里为那一级准备的堆栈，复制参数
        const oldSS = this.s[SS], oldSP = r[SP], oldCS = this.s[CS], oldIP = this.ip;
        const params: number[] = [];
        for (let k = d.gateCount - 1; k >= 0; k--) params.push(this.rwS(SS, oldSP + k * 2));
        this.switchStack(tdpl);
        this.push(oldSS); this.push(oldSP);
        for (const p of params) this.push(p);
        this.push(oldCS); this.push(oldIP);
        this.loadCS(d.gateSel, t, tdpl);
      } else {
        this.push(this.s[CS]); this.push(this.ip);
        this.loadCS(d.gateSel, t, this.cpl);
      }
      this.ip = d.gateOff;
      return;
    }
    if (type === 1 || type === 5) {
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      this.taskSwitch(type === 5 ? d.gateSel : sel, 'call');
      return;
    }
    throw gp(sel);
  }

  /** 换到特权级 level 的堆栈（从当前 TSS 里取 SS:SP） */
  private switchStack(level: number): void {
    const off = 2 + level * 4;
    if (off + 3 > this.tr.limit) throw ts(this.tr.sel);
    const nsp = this.rwL(this.tr.base + off), nss = this.rwL(this.tr.base + off + 2);
    if ((nss & 0xfffc) === 0) throw ts(nss);
    const d = this.desc(nss, ts);
    if ((nss & 3) !== level || ((d.access >> 5) & 3) !== level || (d.access & 0x1a) !== 0x12) throw ts(nss);
    if (!(d.access & 0x80)) throw ssf(nss);
    this.touch(d);
    this.setCache(SS, nss, d);
    this.r[SP] = nsp;
  }

  /** RETF n */
  private farReturn(n: number): void {
    const r = this.r;
    if (!(this.msw & 1)) {
      this.ip = this.pop(); const cs = this.pop();
      this.s[CS] = cs; this.cBase[CS] = cs << 4; this.overrideMask &= ~2;
      r[SP] += n;
      return;
    }
    const sp = r[SP];
    const nip = this.rwS(SS, sp), ncs = this.rwS(SS, sp + 2);
    const rpl = ncs & 3;
    if (rpl < this.cpl) throw gp(ncs);
    const d = this.codeDesc(ncs);
    const dpl = (d.access >> 5) & 3;
    if (d.access & 0x04 ? dpl > rpl : dpl !== rpl) throw gp(ncs);
    if (!(d.access & 0x80)) throw np(ncs);
    if (nip > d.limit) throw gp(0);
    if (rpl === this.cpl) {
      this.loadCS(ncs, d, rpl);
      this.ip = nip;
      r[SP] = sp + 4 + n;
      return;
    }
    // 返回到特权级更低的调用者：还要弹出它的 SS:SP
    const nsp = this.rwS(SS, sp + 4 + n), nss = this.rwS(SS, sp + 6 + n);
    this.loadCS(ncs, d, rpl);
    this.loadSegAt(SS, nss);
    this.ip = nip;
    r[SP] = nsp + n;
    this.nullifyDataSegs();
  }

  /** 在新的 CPL 下装入段寄存器（返回到外层时用） */
  private loadSegAt(i: number, sel: number): void { this.loadSeg(i, sel); }

  private iret(): void {
    const r = this.r;
    if (!(this.msw & 1)) {
      this.ip = this.pop(); const cs = this.pop();
      this.s[CS] = cs; this.cBase[CS] = cs << 4; this.overrideMask &= ~2;
      this.setFlags(this.pop());
      return;
    }
    if (this.flags & NT) { // 嵌套任务：返回到前一个任务
      const back = this.rwL(this.tr.base);
      this.taskSwitch(back, 'iret');
      return;
    }
    const sp = r[SP];
    const nip = this.rwS(SS, sp), ncs = this.rwS(SS, sp + 2), nflags = this.rwS(SS, sp + 4);
    const rpl = ncs & 3;
    if (rpl < this.cpl) throw gp(ncs);
    const d = this.codeDesc(ncs);
    const dpl = (d.access >> 5) & 3;
    if (d.access & 0x04 ? dpl > rpl : dpl !== rpl) throw gp(ncs);
    if (!(d.access & 0x80)) throw np(ncs);
    if (nip > d.limit) throw gp(0);
    const oldCpl = this.cpl;
    if (rpl === this.cpl) {
      this.loadCS(ncs, d, rpl);
      r[SP] = sp + 6;
    } else {
      const nsp = this.rwS(SS, sp + 6), nss = this.rwS(SS, sp + 8);
      this.loadCS(ncs, d, rpl);
      this.loadSegAt(SS, nss);
      r[SP] = nsp;
      this.nullifyDataSegs();
    }
    this.ip = nip;
    this.popFlagsProtected(nflags, oldCpl);
  }

  /** 保护模式下的 POPF/IRET：IOPL 只有 CPL 0 能改，IF 只有 CPL <= IOPL 时能改 */
  private popFlagsProtected(v: number, cpl: number): void {
    let keep = 0;
    if (cpl > 0) keep |= IOPL;
    if (cpl > this.iopl) keep |= IF;
    this.setFlags((v & ~keep) | (this.flags & keep));
  }

  // ================= 任务切换（286 的 TSS，44 字节） =================

  private taskSwitch(sel: number, kind: 'jmp' | 'call' | 'iret' | 'int'): void {
    if ((sel & 0xfffc) === 0 || sel & 4) throw (kind === 'iret' ? ts : gp)(sel);
    const d = this.desc(sel, kind === 'iret' ? ts : gp);
    const type = d.access & 0x1f;
    const want = kind === 'iret' ? 0x03 : 0x01; // 返回时目标是"忙"的 TSS，其他情况是"可用"的
    if (type !== want) throw (kind === 'iret' ? ts : gp)(sel);
    if (!(d.access & 0x80)) throw np(sel);
    if (d.limit < 43) throw ts(sel);
    const r = this.r, s = this.s;
    // 保存当前任务的状态
    const old = this.tr.base;
    let flags = this.flags;
    if (kind === 'iret') flags &= ~NT;
    this.wwL(old + 0x0e, this.ip);
    this.wwL(old + 0x10, flags);
    for (let k = 0; k < 8; k++) this.wwL(old + 0x12 + k * 2, r[k]);
    this.wwL(old + 0x22, s[ES]); this.wwL(old + 0x24, s[CS]); this.wwL(old + 0x26, s[SS]); this.wwL(old + 0x28, s[DS]);
    // 旧任务：JMP、IRET 清掉"忙"位
    if (kind === 'jmp' || kind === 'iret') {
      const od = this.desc(this.tr.sel);
      this.writeLin((od.addr + 5) & this.addrMask, od.access & ~0x02);
    }
    // 新任务："忙"位；CALL、INT 嵌套时记下前一个任务
    if (kind !== 'iret') this.writeLin((d.addr + 5) & this.addrMask, d.access | 0x02);
    const nb = d.base;
    if (kind === 'call' || kind === 'int') this.wwL(nb, this.tr.sel);
    this.tr = { sel, base: nb, limit: d.limit };
    this.msw |= 8; // TS
    // 装入新任务的状态
    this.ip = this.rwL(nb + 0x0e);
    let nflags = this.rwL(nb + 0x10);
    if (kind === 'call' || kind === 'int') nflags |= NT;
    this.setFlags(nflags);
    for (let k = 0; k < 8; k++) r[k] = this.rwL(nb + 0x12 + k * 2);
    const nes = this.rwL(nb + 0x22), ncs = this.rwL(nb + 0x24), nss = this.rwL(nb + 0x26), nds = this.rwL(nb + 0x28);
    const nldt = this.rwL(nb + 0x2a);
    this.loadLdt(nldt, ts);
    // 先按新任务的 CPL 装入各个段（出错是 #TS）
    s[CS] = ncs; this.cpl = ncs & 3;
    try {
      const cd = this.codeDesc(ncs);
      this.loadCS(ncs, cd, ncs & 3);
      this.loadSeg(SS, nss);
      this.loadSeg(ES, nes);
      this.loadSeg(DS, nds);
    } catch (e) {
      if (e instanceof CpuFault && e.vector === 13) throw ts(e.code);
      throw e;
    }
  }

  private loadLdt(sel: number, fault: (c: number) => CpuFault = gp): void {
    if ((sel & 0xfffc) === 0) { this.ldtr = { sel: 0, base: 0, limit: 0 }; return; }
    if (sel & 4) throw fault(sel);
    const d = this.desc(sel, fault);
    if ((d.access & 0x1f) !== 0x02) throw fault(sel);
    if (!(d.access & 0x80)) throw np(sel);
    this.ldtr = { sel, base: d.base, limit: d.limit };
  }

  // ================= 中断 =================

  /**
   * 进入中断：实模式下压入 FLAGS、CS、IP，从中断向量表取新的 CS:IP；
   * 保护模式下通过 IDT 里的门（可能换特权级、换堆栈，或者切换任务）。
   * code 是异常的错误码（-1 表示没有）；soft 表示 INT 指令（要检查门的 DPL）
   */
  interrupt(n: number, code = -1, soft = false): void {
    this.interrupts++;
    if (this.msw & 1) { this.protectedInterrupt(n, code, soft); this.halted = false; return; }
    this.push(this.flags);
    this.flags &= ~(IF | TF);
    this.push(this.s[CS]);
    this.push(this.ip);
    const a = this.idtr.base + n * 4;
    this.ip = this.rwL(a);
    const cs = this.rwL(a + 2);
    this.s[CS] = cs; this.cBase[CS] = cs << 4; this.overrideMask &= ~2;
    this.halted = false;
  }

  private protectedInterrupt(n: number, code: number, soft: boolean): void {
    const ext = soft ? 0 : 1;
    if (n * 8 + 7 > this.idtr.limit) throw gp(n * 8 + 2 + ext);
    const a = this.idtr.base + n * 8;
    const m = (k: number) => this.readLin((a + k) & this.addrMask);
    const goff = m(0) | (m(1) << 8), gsel = m(2) | (m(3) << 8), acc = m(5);
    const type = acc & 0x1f, gdpl = (acc >> 5) & 3;
    if (type !== 5 && type !== 6 && type !== 7) throw gp(n * 8 + 2 + ext);
    if (soft && gdpl < this.cpl) throw gp(n * 8 + 2);
    if (!(acc & 0x80)) throw np(n * 8 + 2 + ext);
    if (type === 5) { // 任务门
      this.taskSwitch(gsel, 'int');
      if (code >= 0) this.push(code);
      return;
    }
    const t = this.codeDesc(gsel);
    const tdpl = (t.access >> 5) & 3;
    if (tdpl > this.cpl) throw gp(gsel);
    if (!(t.access & 0x80)) throw np(gsel);
    if (goff > t.limit) throw gp(0);
    const flags = this.flags;
    if (!(t.access & 0x04) && tdpl < this.cpl) {
      const oldSS = this.s[SS], oldSP = this.r[SP];
      this.switchStack(tdpl);
      this.push(oldSS); this.push(oldSP);
      this.push(flags); this.push(this.s[CS]); this.push(this.ip);
      if (code >= 0) this.push(code);
      this.loadCS(gsel, t, tdpl);
    } else {
      this.push(flags); this.push(this.s[CS]); this.push(this.ip);
      if (code >= 0) this.push(code);
      this.loadCS(gsel, t, this.cpl);
    }
    this.ip = goff;
    this.flags &= ~(TF | NT);
    if (type === 6) this.flags &= ~IF; // 中断门关中断，陷阱门不关
  }

  /** 修改中断栈帧中保存的 FLAGS（陷阱处理函数通过它返回 CF/ZF 等状态） */
  setStackedFlag(mask: number, on: boolean): void {
    const off = (this.r[SP] + 4) & 0xffff;
    let f = this.rwS(SS, off);
    f = on ? f | mask : f & ~mask;
    this.wwS(SS, off, f);
  }

  /** 交出一个异常；处理时又出错是双重错误，再出错就停机 */
  private deliverFault(f: CpuFault): void {
    try {
      this.interrupt(f.vector, f.code);
    } catch (e) {
      if (!(e instanceof CpuFault)) throw e;
      try {
        if (f.vector === 8) throw e;
        this.interrupt(8, 0);
      } catch (e2) {
        if (!(e2 instanceof CpuFault)) throw e2;
        this.halted = true;
        if (this.onShutdown) this.onShutdown();
        else this.onUnsupported?.('CPU 处理异常时连续出错（三重错误），停机');
      }
    }
  }

  // ================= ModR/M =================

  private modrm(): void {
    const b = this.fetch8();
    this.mod = b >> 6;
    this.reg = (b >> 3) & 7;
    this.rm = b & 7;
    if (this.mod === 3) return;
    const r = this.r;
    let off = 0, seg = DS;
    switch (this.rm) {
      case 0: off = r[BX] + r[SI]; break;
      case 1: off = r[BX] + r[DI]; break;
      case 2: off = r[BP] + r[SI]; seg = SS; break;
      case 3: off = r[BP] + r[DI]; seg = SS; break;
      case 4: off = r[SI]; break;
      case 5: off = r[DI]; break;
      case 6:
        if (this.mod === 0) off = this.fetch16();
        else { off = r[BP]; seg = SS; }
        break;
      case 7: off = r[BX]; break;
    }
    if (this.mod === 1) off += this.fetchS8();
    else if (this.mod === 2) off += this.fetch16();
    this.eaOff = off & 0xffff;
    this.eaSi = this.segOvr >= 0 ? this.segOvr : seg;
  }

  private getRM8(): number {
    return this.mod === 3 ? this.getR8(this.rm) : this.rbS(this.eaSi, this.eaOff);
  }
  private setRM8(v: number): void {
    if (this.mod === 3) this.setR8(this.rm, v); else this.wbS(this.eaSi, this.eaOff, v);
  }
  private getRM16(): number {
    return this.mod === 3 ? this.r[this.rm] : this.rwS(this.eaSi, this.eaOff);
  }
  private setRM16(v: number): void {
    if (this.mod === 3) this.r[this.rm] = v; else this.wwS(this.eaSi, this.eaOff, v);
  }
  private getRM(w: boolean): number { return w ? this.getRM16() : this.getRM8(); }
  private setRM(w: boolean, v: number): void { if (w) this.setRM16(v); else this.setRM8(v); }
  private getReg(w: boolean): number { return w ? this.r[this.reg] : this.getR8(this.reg); }
  private setReg(w: boolean, v: number): void { if (w) this.r[this.reg] = v; else this.setR8(this.reg, v); }

  // ================= 运算 =================

  /** 0 ADD, 1 OR, 2 ADC, 3 SBB, 4 AND, 5 SUB, 6 XOR, 7 CMP */
  private alu(op: number, a: number, b: number, w: boolean): number {
    const mask = w ? 0xffff : 0xff;
    const sign = w ? 0x8000 : 0x80;
    let res: number;
    switch (op) {
      case 0: case 2: {
        const c = op === 2 && this.flags & CF ? 1 : 0;
        res = a + b + c;
        this.setF(CF, res > mask);
        this.setF(AF, (a ^ b ^ res) & 0x10);
        this.setF(OF, (res ^ a) & (res ^ b) & sign);
        res &= mask;
        break;
      }
      case 3: case 5: case 7: {
        const c = op === 3 && this.flags & CF ? 1 : 0;
        res = a - b - c;
        this.setF(CF, res < 0);
        this.setF(AF, (a ^ b ^ res) & 0x10);
        this.setF(OF, (a ^ b) & (a ^ res) & sign);
        res &= mask;
        break;
      }
      case 1: res = a | b; this.flags &= ~(CF | OF | AF); break;
      case 4: res = a & b; this.flags &= ~(CF | OF | AF); break;
      default: res = a ^ b; this.flags &= ~(CF | OF | AF); break;
    }
    this.szp(res, w);
    return res;
  }

  private inc(v: number, w: boolean): number {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    const res = (v + 1) & mask;
    this.setF(OF, res === sign);
    this.setF(AF, (v & 0xf) === 0xf);
    this.szp(res, w);
    return res;
  }
  private dec(v: number, w: boolean): number {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    const res = (v - 1) & mask;
    this.setF(OF, v === sign);
    this.setF(AF, (v & 0xf) === 0);
    this.szp(res, w);
    return res;
  }

  /** 移位/循环移位：0 ROL 1 ROR 2 RCL 3 RCR 4 SHL 5 SHR 6 SETMO 7 SAR */
  private shift(op: number, v: number, count: number, w: boolean): number {
    if (count === 0) return v;
    if (op === 6 && this._is286) op = 4; // 186 以后：/6 是 SHL 的别名（8086 上是未公开的 SETMO）
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    let cf = this.flags & CF ? 1 : 0;
    for (let i = 0; i < count; i++) {
      switch (op) {
        case 0: cf = v & sign ? 1 : 0; v = ((v << 1) | cf) & mask; break;
        case 1: cf = v & 1; v = (v >> 1) | (cf ? sign : 0); break;
        case 2: { const n = v & sign ? 1 : 0; v = ((v << 1) | cf) & mask; cf = n; break; }
        case 3: { const n = v & 1; v = (v >> 1) | (cf ? sign : 0); cf = n; break; }
        case 4: cf = v & sign ? 1 : 0; v = (v << 1) & mask; break;
        case 5: cf = v & 1; v >>= 1; break;
        case 6: cf = 0; v = mask; break;
        case 7: cf = v & 1; v = (v >> 1) | (v & sign); break;
      }
    }
    this.setF(CF, cf);
    const msb = v & sign ? 1 : 0;
    if (op === 0 || op === 2 || op === 4 || op === 6) this.setF(OF, msb ^ cf);
    else this.setF(OF, msb ^ (v & (sign >> 1) ? 1 : 0));
    if (op >= 4) {
      this.szp(v, w);
      this.setF(AF, op === 4 && v & 0x10);
    }
    return v;
  }

  private divideError(): void {
    if (this._is286) throw new CpuFault(0); // 286 以后：返回地址指向出错的那条指令
    this.interrupt(0);
  }

  private mulDiv(op: number, w: boolean): void {
    const src = this.getRM(w);
    const r = this.r;
    switch (op) {
      case 4: { // MUL
        if (w) {
          const p = r[AX] * src;
          r[AX] = p & 0xffff; r[DX] = Math.floor(p / 0x10000) & 0xffff;
          this.setF(CF | OF, r[DX] !== 0);
          this.szp16(r[AX]);
        } else {
          r[AX] = (r[AX] & 0xff) * src;
          this.setF(CF | OF, (r[AX] & 0xff00) !== 0);
          this.szp8(r[AX] & 0xff);
        }
        this.flags &= ~AF;
        break;
      }
      case 5: { // IMUL
        if (w) {
          const a = (r[AX] << 16) >> 16, b = (src << 16) >> 16;
          const p = a * b;
          r[AX] = p & 0xffff; r[DX] = (p >> 16) & 0xffff;
          this.setF(CF | OF, p !== ((p << 16) >> 16));
          this.szp16(r[AX]);
        } else {
          const a = ((r[AX] & 0xff) << 24) >> 24, b = (src << 24) >> 24;
          const p = a * b;
          r[AX] = p & 0xffff;
          this.setF(CF | OF, p !== ((p << 24) >> 24));
          this.szp8(r[AX] & 0xff);
        }
        this.flags &= ~AF;
        break;
      }
      case 6: { // DIV
        if (w) {
          const num = r[DX] * 0x10000 + r[AX];
          if (src === 0) return this.divideError();
          const q = Math.floor(num / src);
          if (q > 0xffff) return this.divideError();
          r[DX] = num % src; r[AX] = q;
        } else {
          const num = r[AX];
          if (src === 0) return this.divideError();
          const q = Math.floor(num / src);
          if (q > 0xff) return this.divideError();
          r[AX] = ((num % src) << 8) | q;
        }
        break;
      }
      case 7: { // IDIV
        if (w) {
          const num = (r[DX] << 16) | r[AX];
          const d = (src << 16) >> 16;
          if (d === 0) return this.divideError();
          const q = Math.trunc(num / d);
          if (q > 0x7fff || q < -0x7fff) return this.divideError();
          const qq = this.rep ? -q : q; // 8088 未公开行为：REP 前缀使商变号
          r[AX] = qq & 0xffff; r[DX] = (num - q * d) & 0xffff;
        } else {
          const num = (r[AX] << 16) >> 16;
          const d = (src << 24) >> 24;
          if (d === 0) return this.divideError();
          const q = Math.trunc(num / d);
          if (q > 0x7f || q < -0x7f) return this.divideError();
          const qq = this.rep ? -q : q;
          r[AX] = (((num - q * d) & 0xff) << 8) | (qq & 0xff);
        }
        break;
      }
    }
  }

  private cond(cc: number): boolean {
    const f = this.flags;
    let res: boolean;
    switch (cc >> 1) {
      case 0: res = (f & OF) !== 0; break;
      case 1: res = (f & CF) !== 0; break;
      case 2: res = (f & ZF) !== 0; break;
      case 3: res = (f & (CF | ZF)) !== 0; break;
      case 4: res = (f & SF) !== 0; break;
      case 5: res = (f & PF) !== 0; break;
      case 6: res = !(f & SF) !== !(f & OF); break;
      default: res = (f & ZF) !== 0 || !(f & SF) !== !(f & OF); break;
    }
    return cc & 1 ? !res : res;
  }

  // ================= 186/286 的新指令 =================

  /** 保护模式下的特权检查：CPL 必须是 0 */
  private requireCpl0(): void { if (this.msw & 1 && this.cpl !== 0) throw gp(0); }
  /** I/O 和开关中断：保护模式下要求 CPL <= IOPL */
  private requireIopl(): void { if (this.msw & 1 && this.cpl > this.iopl) throw gp(0); }

  private exec186(op: number): void {
    const r = this.r;
    switch (op) {
      case 0x60: { // PUSHA
        const sp = r[SP];
        this.push(r[AX]); this.push(r[CX]); this.push(r[DX]); this.push(r[BX]);
        this.push(sp); this.push(r[BP]); this.push(r[SI]); this.push(r[DI]);
        return;
      }
      case 0x61: // POPA（跳过 SP）
        r[DI] = this.pop(); r[SI] = this.pop(); r[BP] = this.pop(); this.pop();
        r[BX] = this.pop(); r[DX] = this.pop(); r[CX] = this.pop(); r[AX] = this.pop();
        return;
      case 0x62: { // BOUND r16, m16&16：超出范围时产生 5 号中断
        this.modrm();
        if (this.mod === 3) throw new CpuFault(6);
        const v = (r[this.reg] << 16) >> 16;
        const lo = (this.rwS(this.eaSi, this.eaOff) << 16) >> 16, hi = (this.rwS(this.eaSi, this.eaOff + 2) << 16) >> 16;
        if (v < lo || v > hi) throw new CpuFault(5);
        return;
      }
      case 0x63: { // ARPL r/m16, r16（只在保护模式下有效）
        if (!(this.msw & 1)) throw new CpuFault(6);
        this.modrm();
        const dst = this.getRM16(), src = r[this.reg];
        if ((dst & 3) < (src & 3)) { this.setRM16((dst & ~3) | (src & 3)); this.flags |= ZF; }
        else this.flags &= ~ZF;
        return;
      }
      case 0x68: this.push(this.fetch16()); return;            // PUSH imm16
      case 0x6a: this.push(this.fetchS8() & 0xffff); return;   // PUSH imm8（符号扩展）
      case 0x69: case 0x6b: { // IMUL r16, r/m16, 立即数
        this.modrm();
        const a = (this.getRM16() << 16) >> 16;
        const b = op === 0x69 ? (this.fetch16() << 16) >> 16 : this.fetchS8();
        const res = a * b;
        const low = res & 0xffff;
        r[this.reg] = low;
        const fits = ((low << 16) >> 16) === res;
        this.setF(CF, !fits); this.setF(OF, !fits);
        this.szp16(low);
        return;
      }
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: this.requireIopl(); this.stringOp(op); return; // INS / OUTS
      default: throw new CpuFault(6); // 64h~67h 是 386 的前缀
    }
  }

  /** 0F 开头的两字节指令（286） */
  private exec0F(): void {
    const op2 = this.fetch8();
    const pm = (this.msw & 1) !== 0;
    switch (op2) {
      case 0x00: { // SLDT STR LLDT LTR VERR VERW：只在保护模式下有效
        if (!pm) throw new CpuFault(6);
        this.modrm();
        switch (this.reg) {
          case 0: this.setRM16(this.ldtr.sel); return;
          case 1: this.setRM16(this.tr.sel); return;
          case 2: this.requireCpl0(); this.loadLdt(this.getRM16()); return;
          case 3: { // LTR：GDT 里"可用"的 TSS，装入后标成"忙"
            this.requireCpl0();
            const sel = this.getRM16();
            if ((sel & 0xfffc) === 0 || sel & 4) throw gp(sel);
            const d = this.desc(sel);
            if ((d.access & 0x1f) !== 0x01) throw gp(sel);
            if (!(d.access & 0x80)) throw np(sel);
            this.writeLin((d.addr + 5) & this.addrMask, d.access | 0x02);
            this.tr = { sel, base: d.base, limit: d.limit };
            return;
          }
          case 4: case 5: { // VERR / VERW：能读/写就置 ZF
            const sel = this.getRM16();
            this.flags &= ~ZF;
            if ((sel & 0xfffc) === 0) return;
            let d: Desc;
            try { d = this.desc(sel); } catch { return; }
            if (!(d.access & 0x10)) return;
            const dpl = (d.access >> 5) & 3, code = (d.access & 0x08) !== 0, conforming = code && (d.access & 0x04) !== 0;
            if (!conforming && Math.max(this.cpl, sel & 3) > dpl) return;
            const ok = this.reg === 4 ? (!code || (d.access & 0x02) !== 0) : (!code && (d.access & 0x02) !== 0);
            if (ok) this.flags |= ZF;
            return;
          }
          default: throw new CpuFault(6);
        }
      }
      case 0x01: {
        this.modrm();
        const reg = this.reg;
        if (reg === 4) { this.setRM16(this.msw); return; } // SMSW
        if (reg === 6) { // LMSW：PE 位置 1 就进入保护模式（286 上不能用 LMSW 退出）
          this.requireCpl0();
          const v = this.getRM16();
          const wasPm = this.msw & 1;
          this.msw = (this.msw & 0xfff0) | (v & 0x0f) | (this.msw & 1);
          if (this.msw & 1 && !wasPm) this.enterProtected();
          return;
        }
        if (this.mod === 3 || reg === 5 || reg === 7) throw new CpuFault(6);
        const t = reg === 0 || reg === 2 ? this.gdtr : this.idtr;
        const si = this.eaSi, off = this.eaOff;
        if (reg < 2) { // SGDT / SIDT：界限 2 字节 + 基址 3 字节 + 一个 FFh（286）
          this.wwS(si, off, t.limit);
          this.wwS(si, off + 2, t.base & 0xffff);
          this.wbS(si, off + 4, t.base >> 16);
          this.wbS(si, off + 5, 0xff);
        } else { // LGDT / LIDT
          this.requireCpl0();
          t.limit = this.rwS(si, off);
          t.base = this.rwS(si, off + 2) | (this.rbS(si, off + 4) << 16);
        }
        return;
      }
      case 0x02: case 0x03: { // LAR / LSL
        if (!pm) throw new CpuFault(6);
        this.modrm();
        const sel = this.getRM16();
        this.flags &= ~ZF;
        if ((sel & 0xfffc) === 0) return;
        let d: Desc;
        try { d = this.desc(sel); } catch { return; }
        const dpl = (d.access >> 5) & 3, type = d.access & 0x1f;
        const conforming = (d.access & 0x1c) === 0x1c;
        if (!(d.access & 0x10)) {
          // 系统描述符：LAR 认 TSS、LDT、门；LSL 只认 TSS 和 LDT
          const okTypes = op2 === 0x02 ? [1, 2, 3, 4, 5] : [1, 2, 3];
          if (!okTypes.includes(type)) return;
        }
        if (!conforming && Math.max(this.cpl, sel & 3) > dpl) return;
        this.r[this.reg] = op2 === 0x02 ? (d.access << 8) & 0xff00 : d.limit;
        this.flags |= ZF;
        return;
      }
      case 0x05: this.loadAll(); return;
      case 0x06: this.requireCpl0(); this.msw &= ~8; return; // CLTS
    }
    throw new CpuFault(6); // 其余是 386 以后的指令
  }

  /** PE 位刚置 1：段描述符缓存保留实模式下的基址，界限 FFFFh */
  private enterProtected(): void {
    for (let i = 0; i < 4; i++) if (!(this.overrideMask & (1 << i))) this.cBase[i] = this.s[i] << 4;
    this.overrideMask = 0;
    this.cpl = 0;
  }

  /**
   * LOADALL（286 未公开指令，0F 05）：从物理地址 800h 起的 102 字节一次装入全部寄存器，
   * 包括段描述符缓存。HIMEM.SYS 在 286 上用它访问 1MB 以上的内存
   */
  private loadAll(): void {
    this.requireCpl0();
    const w = (a: number) => this.mem[a] | (this.mem[a + 1] << 8);
    const cache = (a: number) => ({ base: this.mem[a] | (this.mem[a + 1] << 8) | (this.mem[a + 2] << 16), access: this.mem[a + 3], limit: w(a + 4) });
    const r = this.r, s = this.s;
    this.msw = (this.msw & 0xfff0) | (w(0x806) & 0x0f) | (this.msw & 1); // PE 只能置 1
    this.tr.sel = w(0x816);
    this.flags = w(0x818); this.setFlags(this.flags);
    this.ip = w(0x81a);
    this.ldtr.sel = w(0x81c);
    s[DS] = w(0x81e); s[SS] = w(0x820); s[CS] = w(0x822); s[ES] = w(0x824);
    r[DI] = w(0x826); r[SI] = w(0x828); r[BP] = w(0x82a); r[SP] = w(0x82c);
    r[BX] = w(0x82e); r[DX] = w(0x830); r[CX] = w(0x832); r[AX] = w(0x834);
    const order = [[ES, 0x836], [CS, 0x83c], [SS, 0x842], [DS, 0x848]];
    for (const [i, a] of order) {
      const c = cache(a);
      this.cBase[i] = c.base; this.cLimit[i] = c.limit; this.cAccess[i] = c.access; this.cNull[i] = 0;
    }
    const g = cache(0x84e); this.gdtr = { base: g.base, limit: g.limit };
    const l = cache(0x854); this.ldtr.base = l.base; this.ldtr.limit = l.limit;
    const it = cache(0x85a); this.idtr = { base: it.base, limit: it.limit };
    const t = cache(0x860); this.tr.base = t.base; this.tr.limit = t.limit;
    this.overrideMask = this.msw & 1 ? 0 : 0x0f;
    this.cpl = this.msw & 1 ? s[CS] & 3 : 0;
  }

  // ================= 串操作 =================

  private stringOp(op: number): void {
    // op: A4 MOVSB A5 MOVSW A6 CMPSB A7 CMPSW AA STOSB AB STOSW AC LODSB AD LODSW AE SCASB AF SCASW
    const r = this.r;
    if (this.rep && r[CX] === 0) return;
    const w = (op & 1) === 1;
    const d = this.flags & DF ? (w ? -2 : -1) : (w ? 2 : 1);
    const src = this.segOvr >= 0 ? this.segOvr : DS;
    let compare = false;
    switch (op & 0xfe) {
      case 0xa4:
        if (w) this.wwS(ES, r[DI], this.rwS(src, r[SI])); else this.wbS(ES, r[DI], this.rbS(src, r[SI]));
        r[SI] += d; r[DI] += d;
        break;
      case 0xa6:
        if (w) this.alu(7, this.rwS(src, r[SI]), this.rwS(ES, r[DI]), true);
        else this.alu(7, this.rbS(src, r[SI]), this.rbS(ES, r[DI]), false);
        r[SI] += d; r[DI] += d;
        compare = true;
        break;
      case 0xaa:
        if (w) this.wwS(ES, r[DI], r[AX]); else this.wbS(ES, r[DI], r[AX]);
        r[DI] += d;
        break;
      case 0xac:
        if (w) r[AX] = this.rwS(src, r[SI]); else this.setR8(0, this.rbS(src, r[SI]));
        r[SI] += d;
        break;
      case 0x6c: // INSB / INSW（186 以后）
        if (w) this.wwS(ES, r[DI], this.io.in8(r[DX]) | (this.io.in8((r[DX] + 1) & 0xffff) << 8));
        else this.wbS(ES, r[DI], this.io.in8(r[DX]));
        r[DI] += d;
        break;
      case 0x6e: { // OUTSB / OUTSW
        const v = w ? this.rwS(src, r[SI]) : this.rbS(src, r[SI]);
        this.io.out8(r[DX], v & 0xff);
        if (w) this.io.out8((r[DX] + 1) & 0xffff, v >> 8);
        r[SI] += d;
        break;
      }
      case 0xae:
        if (w) this.alu(7, r[AX], this.rwS(ES, r[DI]), true);
        else this.alu(7, r[AX] & 0xff, this.rbS(ES, r[DI]), false);
        r[DI] += d;
        compare = true;
        break;
    }
    if (this.rep) {
      r[CX]--;
      let more = r[CX] !== 0;
      if (more && compare) {
        const zf = (this.flags & ZF) !== 0;
        more = this.rep === 0xf3 ? zf : !zf;
      }
      if (more) {
        this.ip = this.startIP;
        this.repContinue = true;
      }
    }
  }

  // ================= 执行 =================

  /** 当前指令起始 IP（含前缀） */
  get instructionStart(): number { return this.startIP; }

  step(): void {
    this.repContinue = false;
    this.irqTaken = false;
    if (!this.inhibitIrq && this.flags & IF && this.irq && this.irq.pending()) {
      this.irqTaken = true;
      this.waiting = false; // 等待中的陷阱被中断打断：返回后会重新执行陷阱
      this.startIP = this.ip; this.startSP = this.r[SP];
      const n = this.irq.ack();
      try { this.interrupt(n); } catch (e) { this.faultHandler(e); }
      this.steps++;
      return;
    }
    this.inhibitIrq = false;
    if (this.halted) return;
    const tf = this.flags & TF;
    this.startIP = this.ip;
    this.startSP = this.r[SP];
    this.segOvr = -1;
    this.rep = 0;
    try {
      let op: number;
      for (;;) {
        op = this.fetch8();
        if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { this.segOvr = (op >> 3) & 3; continue; }
        if (op === 0xf2 || op === 0xf3) { this.rep = op; continue; }
        if (op === 0xf0) continue;
        if (op === TRAP_OPCODE) {
          if (this.trap && this.s[CS] === BIOS_SEG && !(this.msw & 1)) {
            const n = this.fetch8();
            if (!this.trap(n)) {
              this.ip = this.startIP;
              this.waiting = true;
            } else {
              this.waiting = false;
            }
            this.steps++;
            return;
          }
          continue; // 8088 上 F1 是 LOCK 的别名
        }
        break;
      }
      this.exec(op);
      this.steps++;
      if (tf && !this.repContinue) this.interrupt(1);
    } catch (e) {
      this.faultHandler(e);
      this.steps++;
    }
  }

  /** 指令执行中出了异常：退回指令开头，交给异常处理程序 */
  private faultHandler(e: unknown): void {
    if (!(e instanceof CpuFault)) throw e;
    this.ip = this.startIP;
    this.r[SP] = this.startSP;
    this.repContinue = false;
    this.deliverFault(e);
  }

  private exec(op: number): void {
    const r = this.r, s = this.s;
    if (this._is286) {
      // 286：这些操作码在 8086 上是别的指令（POP CS、条件跳转和 RET 的别名），在 186/286 上是新指令
      if (op === 0x0f) { this.exec0F(); return; }
      if (op >= 0x60 && op <= 0x6f) { this.exec186(op); return; }
      if (op === 0xc0 || op === 0xc1) { // 移位，次数是立即数
        const w = op === 0xc1;
        this.modrm();
        const v = this.getRM(w);
        this.setRM(w, this.shift(this.reg, v, this.fetch8() & 0x1f, w));
        return;
      }
      if (op === 0xc8) { // ENTER 栈帧大小, 嵌套层数
        const size = this.fetch16(), level = this.fetch8() & 0x1f;
        this.push(r[BP]);
        const frame = r[SP];
        if (level > 0) {
          let bp = r[BP];
          for (let k = 1; k < level; k++) { bp = (bp - 2) & 0xffff; this.push(this.rwS(SS, bp)); }
          r[BP] = bp;
          this.push(frame);
        }
        r[BP] = frame;
        r[SP] -= size;
        return;
      }
      if (op === 0xc9) { // LEAVE
        const bp = this.rwS(SS, r[BP]);
        r[SP] = r[BP] + 2; r[BP] = bp;
        return;
      }
    }
    switch (op) {
      // ---- 00-3F：算术逻辑运算 ----
      case 0x00: case 0x01: case 0x02: case 0x03: case 0x08: case 0x09: case 0x0a: case 0x0b:
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x18: case 0x19: case 0x1a: case 0x1b:
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x28: case 0x29: case 0x2a: case 0x2b:
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x38: case 0x39: case 0x3a: case 0x3b: {
        const alu = (op >> 3) & 7, w = (op & 1) === 1;
        this.modrm();
        if (op & 2) {
          const res = this.alu(alu, this.getReg(w), this.getRM(w), w);
          if (alu !== 7) this.setReg(w, res);
        } else {
          const res = this.alu(alu, this.getRM(w), this.getReg(w), w);
          if (alu !== 7) this.setRM(w, res);
        }
        return;
      }
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const res = this.alu((op >> 3) & 7, r[AX] & 0xff, this.fetch8(), false);
        if (op !== 0x3c) this.setR8(0, res);
        return;
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const res = this.alu((op >> 3) & 7, r[AX], this.fetch16(), true);
        if (op !== 0x3d) r[AX] = res;
        return;
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: this.push(s[(op >> 3) & 3]); return;
      case 0x07: case 0x0f: case 0x17: case 0x1f: {
        const v = this.rwS(SS, r[SP]);
        if (op === 0x0f) { s[CS] = v; this.cBase[CS] = v << 4; } // 8086 的 POP CS
        else this.loadSeg((op >> 3) & 3, v);
        r[SP] += 2;
        if (op === 0x17) this.inhibitIrq = true;
        return;
      }
      case 0x27: { // DAA
        const al = r[AX] & 0xff, cf = this.flags & CF, af = this.flags & AF;
        let v = al;
        if ((al & 0xf) > 9 || af) { v += 6; this.flags |= AF; } else this.flags &= ~AF;
        if (al > (af ? 0x9f : 0x99) || cf) { v += 0x60; this.flags |= CF; } else this.flags &= ~CF;
        v &= 0xff;
        this.setF(OF, ~al & v & 0x80);
        this.setR8(0, v); this.szp8(v);
        return;
      }
      case 0x2f: { // DAS
        const al = r[AX] & 0xff, cf = this.flags & CF, af = this.flags & AF;
        let v = al;
        if ((al & 0xf) > 9 || af) { v -= 6; this.flags |= AF; } else this.flags &= ~AF;
        if (al > (af ? 0x9f : 0x99) || cf) { v -= 0x60; this.flags |= CF; } else this.flags &= ~CF;
        v &= 0xff;
        this.setF(OF, al & ~v & 0x80);
        this.setR8(0, v); this.szp8(v);
        return;
      }
      case 0x37: case 0x3f: { // AAA / AAS
        const al = r[AX] & 0xff;
        let ah = r[AX] >> 8;
        let v = al;
        if ((al & 0xf) > 9 || this.flags & AF) {
          if (op === 0x37) { v = al + 6; ah = (ah + 1) & 0xff; } else { v = al - 6; ah = (ah - 1) & 0xff; }
          this.flags |= AF | CF;
        } else this.flags &= ~(AF | CF);
        r[AX] = (ah << 8) | (v & 0x0f);
        this.szp8(v & 0xff);
        this.setF(OF, op === 0x37 ? ~al & v & 0x80 : al & ~v & 0x80);
        return;
      }

      // ---- 40-5F：INC/DEC/PUSH/POP 寄存器 ----
      case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
        r[op & 7] = this.inc(r[op & 7], true); return;
      case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f:
        r[op & 7] = this.dec(r[op & 7], true); return;
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x55: case 0x56: case 0x57:
        this.push(r[op & 7]); return;
      case 0x54: // 8086 的 PUSH SP 压入的是减 2 之后的值；286 起压入原来的值
        if (this._is286) { this.push(r[SP]); return; }
        r[SP] -= 2; this.wwS(SS, r[SP], r[SP]); return;
      case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        r[op & 7] = this.pop(); return;

      // ---- 60-7F：条件跳转（60-6F 是 8086 上的别名） ----
      case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67:
      case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f:
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
        const d = this.fetchS8();
        if (this.cond(op & 0xf)) this.ip = (this.ip + d) & 0xffff;
        return;
      }

      // ---- 80-83：立即数运算 ----
      case 0x80: case 0x81: case 0x82: case 0x83: {
        const w = (op & 1) === 1;
        this.modrm();
        const a = this.getRM(w);
        const b = op === 0x81 ? this.fetch16() : op === 0x83 ? this.fetchS8() & 0xffff : this.fetch8();
        const res = this.alu(this.reg, a, b, w);
        if (this.reg !== 7) this.setRM(w, res);
        return;
      }
      case 0x84: case 0x85: {
        const w = op === 0x85;
        this.modrm();
        this.alu(4, this.getRM(w), this.getReg(w), w);
        return;
      }
      case 0x86: case 0x87: {
        const w = op === 0x87;
        this.modrm();
        const a = this.getRM(w), b = this.getReg(w);
        this.setRM(w, b); this.setReg(w, a);
        return;
      }
      case 0x88: case 0x89: { const w = op === 0x89; this.modrm(); this.setRM(w, this.getReg(w)); return; }
      case 0x8a: case 0x8b: { const w = op === 0x8b; this.modrm(); this.setReg(w, this.getRM(w)); return; }
      case 0x8c: this.modrm(); this.setRM16(s[this.reg & 3]); return;
      case 0x8d: this.modrm(); r[this.reg] = this.eaOff; return;
      case 0x8e: {
        this.modrm();
        const v = this.getRM16(), i = this.reg & 3;
        if (i === CS) {
          if (this._is286) throw new CpuFault(6);
          s[CS] = v; this.cBase[CS] = v << 4; // 8086 允许 MOV CS
        } else this.loadSeg(i, v);
        if (i === SS) this.inhibitIrq = true;
        return;
      }
      case 0x8f: { this.modrm(); const v = this.rwS(SS, r[SP]); r[SP] += 2; this.setRM16(v); return; }

      // ---- 90-9F ----
      case 0x90: return;
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
        const t = r[AX]; r[AX] = r[op & 7]; r[op & 7] = t; return;
      }
      case 0x98: r[AX] = (((r[AX] & 0xff) << 24) >> 24) & 0xffff; return;
      case 0x99: r[DX] = r[AX] & 0x8000 ? 0xffff : 0; return;
      case 0x9a: {
        const nip = this.fetch16(), ncs = this.fetch16();
        this.farCall(ncs, nip);
        return;
      }
      case 0x9b: return; // WAIT
      case 0x9c: this.push(this.flags); return;
      case 0x9d: {
        const v = this.rwS(SS, r[SP]);
        r[SP] += 2;
        if (this.msw & 1) this.popFlagsProtected(v, this.cpl); else this.setFlags(v);
        return;
      }
      case 0x9e: this.flags = (this.flags & 0xff00) | (((r[AX] >> 8) & 0xd5) | 2); return;
      case 0x9f: this.setR8(4, this.flags & 0xff); return;

      // ---- A0-AF ----
      case 0xa0: { const o = this.fetch16(); this.setR8(0, this.rbS(this.segOvr >= 0 ? this.segOvr : DS, o)); return; }
      case 0xa1: { const o = this.fetch16(); r[AX] = this.rwS(this.segOvr >= 0 ? this.segOvr : DS, o); return; }
      case 0xa2: { const o = this.fetch16(); this.wbS(this.segOvr >= 0 ? this.segOvr : DS, o, r[AX]); return; }
      case 0xa3: { const o = this.fetch16(); this.wwS(this.segOvr >= 0 ? this.segOvr : DS, o, r[AX]); return; }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        this.stringOp(op); return;
      case 0xa8: this.alu(4, r[AX] & 0xff, this.fetch8(), false); return;
      case 0xa9: this.alu(4, r[AX], this.fetch16(), true); return;

      // ---- B0-BF：MOV 寄存器, 立即数 ----
      case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        this.setR8(op & 7, this.fetch8()); return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        r[op & 7] = this.fetch16(); return;

      // ---- C0-CF ----
      case 0xc0: case 0xc2: { const n = this.fetch16(); this.ip = this.pop(); r[SP] += n; return; }
      case 0xc1: case 0xc3: this.ip = this.pop(); return;
      case 0xc4: case 0xc5: {
        this.modrm();
        if (this.mod === 3 && this._is286) throw new CpuFault(6);
        const off = this.rwS(this.eaSi, this.eaOff), sel = this.rwS(this.eaSi, this.eaOff + 2);
        this.loadSeg(op === 0xc4 ? ES : DS, sel);
        r[this.reg] = off;
        return;
      }
      case 0xc6: this.modrm(); this.setRM8(this.fetch8()); return;
      case 0xc7: this.modrm(); this.setRM16(this.fetch16()); return;
      case 0xc8: case 0xca: { const n = this.fetch16(); this.farReturn(n); return; }
      case 0xc9: case 0xcb: this.farReturn(0); return;
      case 0xcc: this.interrupt(3, -1, true); return;
      case 0xcd: { const n = this.fetch8(); this.interrupt(n, -1, true); return; }
      case 0xce: if (this.flags & OF) this.interrupt(4, -1, true); return;
      case 0xcf: this.iret(); return;

      // ---- D0-DF ----
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const w = (op & 1) === 1;
        this.modrm();
        const count = op & 2 ? r[CX] & (this._is286 ? 0x1f : 0xff) : 1;
        this.setRM(w, this.shift(this.reg, this.getRM(w), count, w));
        return;
      }
      case 0xd4: { // AAM
        const base = this.fetch8();
        if (base === 0) { this.divideError(); return; }
        const al = r[AX] & 0xff;
        r[AX] = (Math.floor(al / base) << 8) | (al % base);
        this.szp8(r[AX] & 0xff);
        this.flags &= ~(CF | OF | AF);
        return;
      }
      case 0xd5: { // AAD
        const base = this.fetch8();
        const al = r[AX] & 0xff, ah = r[AX] >> 8;
        const res = this.alu(0, al, (ah * base) & 0xff, false);
        r[AX] = res;
        return;
      }
      case 0xd6: this.setR8(0, this.flags & CF ? 0xff : 0); return; // SALC（未公开）
      case 0xd7: this.setR8(0, this.rbS(this.segOvr >= 0 ? this.segOvr : DS, r[BX] + (r[AX] & 0xff))); return;
      case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
        this.modrm(); return; // ESC：无协处理器，忽略

      // ---- E0-EF ----
      case 0xe0: case 0xe1: case 0xe2: {
        const d = this.fetchS8();
        r[CX]--;
        const zf = (this.flags & ZF) !== 0;
        const jump = r[CX] !== 0 && (op === 0xe2 || (op === 0xe1 ? zf : !zf));
        if (jump) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe3: { const d = this.fetchS8(); if (r[CX] === 0) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: { this.requireIopl(); this.setR8(0, this.io.in8(this.fetch8())); return; }
      case 0xe5: { this.requireIopl(); const p = this.fetch8(); r[AX] = this.io.in8(p) | (this.io.in8((p + 1) & 0xffff) << 8); return; }
      case 0xe6: { this.requireIopl(); this.io.out8(this.fetch8(), r[AX] & 0xff); return; }
      case 0xe7: { this.requireIopl(); const p = this.fetch8(); this.io.out8(p, r[AX] & 0xff); this.io.out8((p + 1) & 0xffff, r[AX] >> 8); return; }
      case 0xe8: { const d = this.fetch16(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fetch16(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const nip = this.fetch16(); const ncs = this.fetch16(); this.farJump(ncs, nip); return; }
      case 0xeb: { const d = this.fetchS8(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xec: this.requireIopl(); this.setR8(0, this.io.in8(r[DX])); return;
      case 0xed: this.requireIopl(); r[AX] = this.io.in8(r[DX]) | (this.io.in8((r[DX] + 1) & 0xffff) << 8); return;
      case 0xee: this.requireIopl(); this.io.out8(r[DX], r[AX] & 0xff); return;
      case 0xef: this.requireIopl(); this.io.out8(r[DX], r[AX] & 0xff); this.io.out8((r[DX] + 1) & 0xffff, r[AX] >> 8); return;

      // ---- F0-FF ----
      case 0xf4: this.requireCpl0(); this.halted = true; return;
      case 0xf5: this.flags ^= CF; return;
      case 0xf6: case 0xf7: {
        const w = op === 0xf7;
        this.modrm();
        switch (this.reg) {
          case 0: case 1: {
            const v = this.getRM(w);
            this.alu(4, v, w ? this.fetch16() : this.fetch8(), w);
            return;
          }
          case 2: this.setRM(w, ~this.getRM(w)); return;
          case 3: this.setRM(w, this.alu(5, 0, this.getRM(w), w)); return;
          default: this.mulDiv(this.reg, w); return;
        }
      }
      case 0xf8: this.flags &= ~CF; return;
      case 0xf9: this.flags |= CF; return;
      case 0xfa: this.requireIopl(); this.flags &= ~IF; return;
      case 0xfb: this.requireIopl(); this.flags |= IF; this.inhibitIrq = true; return;
      case 0xfc: this.flags &= ~DF; return;
      case 0xfd: this.flags |= DF; return;
      case 0xfe: {
        this.modrm();
        if (this.reg === 0) this.setRM8(this.inc(this.getRM8(), false));
        else if (this.reg === 1) this.setRM8(this.dec(this.getRM8(), false));
        return;
      }
      case 0xff: {
        this.modrm();
        switch (this.reg) {
          case 0: this.setRM16(this.inc(this.getRM16(), true)); return;
          case 1: this.setRM16(this.dec(this.getRM16(), true)); return;
          case 2: { const t = this.getRM16(); this.push(this.ip); this.ip = t; return; }
          case 3: {
            if (this.mod === 3 && this._is286) throw new CpuFault(6);
            const nip = this.rwS(this.eaSi, this.eaOff), ncs = this.rwS(this.eaSi, this.eaOff + 2);
            this.farCall(ncs, nip);
            return;
          }
          case 4: this.ip = this.getRM16(); return;
          case 5: {
            if (this.mod === 3 && this._is286) throw new CpuFault(6);
            const nip = this.rwS(this.eaSi, this.eaOff), ncs = this.rwS(this.eaSi, this.eaOff + 2);
            this.farJump(ncs, nip);
            return;
          }
          default: { // PUSH r/m16（/7 是别名）
            if (this.mod === 3 && this.rm === SP && !this._is286) { r[SP] -= 2; this.wwS(SS, r[SP], r[SP]); return; }
            this.push(this.getRM16());
            return;
          }
        }
      }
    }
  }
}
