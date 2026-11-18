// 8086/8088、80286 与 80386 CPU 模拟器核心（按指令解释执行）
//
// 设计要点：
// - 三种型号共用一份代码（model：0 = 8088，1 = 286，2 = 386）。8088 的行为用 SingleStepTests/8088 验证，
//   386 的实模式指令用 SingleStepTests/80386 验证；286 只在需要的地方和 386 分开。
// - 通用寄存器：r 是低 16 位（AX CX DX BX SP BP SI DI），rh 是 386 的高 16 位。
//   16 位的运算只碰 r，所以 BIOS 等高层代码照旧用 cpu.r[AX]，不会弄乱 EAX 的高半部分。
// - 内存是 16MB 的 Uint8Array。8088 只用 20 位地址（超过 1MB 回绕）；286 用 24 位地址；386 用 32 位地址
//   （16MB 以上没有内存，读出 FFh）。第 20 位受 A20 门控制（关闭时和 8086 一样回绕）。
// - 每个段寄存器（ES CS SS DS FS GS）有一份"描述符缓存"（基址、界限、访问权限、32 位标志）。实模式下基址就是 段值 × 16；
//   保护模式下段寄存器里是选择子，基址、界限、权限从 GDT/LDT 的描述符里取，每次访问内存都检查界限和权限，
//   不合规时产生异常（#GP、#SS、#NP、#TS）。386 在实模式下也检查界限（超过 FFFFh 是 #GP），并且保留保护模式里装入的
//   界限（"unreal 模式"）。
// - 386 的分页：CR0 的 PG 位打开后，线性地址经两级页表换成物理地址（带一个简单的 TLB），不合规时产生 #PF。
// - 指令执行到一半出了异常：抛出 CpuFault，IP 和 SP 退回指令开头，再通过 IDT 交给异常处理程序
//   （保护模式）或中断向量表（实模式）。处理异常时又出异常是双重错误（#DF），再出错就"停机"（复位 CPU）。
// - 每次 step() 执行一条完整指令（含前缀）。REP 串指令每次只执行一次迭代，
//   未完成时把 IP 退回指令开头并置 repContinue，与真实 CPU 的可中断行为一致。
// - BIOS/DOS 功能用"陷阱"实现：中断向量指向 F000 段里的小桩代码
//   `F1 nn CF`（陷阱 + 中断号 + IRET），CPU 在实模式下执行到陷阱时回调 JS。
// - 端口读写通过 IOBus 分发，硬件中断通过 IrqSource 注入。

export const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, GS = 5;

export const CF = 0x0001, PF = 0x0004, AF = 0x0010, ZF = 0x0040, SF = 0x0080;
export const TF = 0x0100, IF = 0x0200, DF = 0x0400, OF = 0x0800;
export const IOPL = 0x3000, NT = 0x4000;
/** 386：恢复标志（调试）、虚拟 8086 模式 */
export const RF = 0x10000, VM = 0x20000;

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

/** 段描述符（286 格式：界限 16 位、基址 24 位；386 格式：界限 20 位（可按 4KB 计）、基址 32 位、32 位标志） */
interface Desc {
  base: number;
  /** 界限（已按粒度换算成字节） */
  limit: number;
  access: number;
  /** D/B 位：32 位代码段、32 位堆栈段 */
  big: number;
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
/** 按操作数大小（1、2、4 字节）取掩码和符号位 */
const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];

export const TRAP_OPCODE = 0xf1;
export const BIOS_SEG = 0xf000;
/** 内存大小：16MB */
export const MEM_SIZE = 0x1000000;

const nullBus: IOBus = { in8: () => 0xff, out8: () => {} };

/** 抛出异常的小工具 */
const gp = (code = 0) => new CpuFault(13, code & 0xfffc);
const np = (code: number) => new CpuFault(11, code & 0xfffc);
const ssf = (code = 0) => new CpuFault(12, code & 0xfffc);
const ts = (code: number) => new CpuFault(10, code & 0xfffc);
const ud = () => new CpuFault(6);

export class CPU {
  mem: Uint8Array;
  /** 通用寄存器的低 16 位：AX CX DX BX SP BP SI DI（与 ModR/M 编码顺序一致） */
  r = new Uint16Array(8);
  /** 386：通用寄存器的高 16 位（EAX = rh[AX] << 16 | r[AX]） */
  rh = new Uint16Array(8);
  /** 段寄存器：ES CS SS DS FS GS（保护模式下是选择子） */
  s = new Uint16Array(6);
  /** 指令指针（386 的 32 位代码段里是 EIP） */
  ip = 0;
  /** 标志寄存器（386 是 32 位的 EFLAGS） */
  flags = 0xf002;

  io: IOBus = nullBus;
  irq: IrqSource | null = null;
  trap: TrapHandler | null = null;
  /** 内存写入钩子（用于反向执行的历史记录）：参数为物理地址和写入前的旧值 */
  onWrite: ((addr: number, old: number) => void) | null = null;
  /** 显卡显存（A0000~BFFFF 的读写交给它；参数是相对 A0000 的偏移） */
  mmio: { read(off: number): number; write(off: number, v: number): void } | null = null;

  halted = false;
  /** 型号：0 = 8086/8088，1 = 80286，2 = 80386 */
  private model = 0;
  /** 选 286/386 时为 true（186/286 的新指令、24 位以上地址、保护模式等） */
  get is286(): boolean { return this.model >= 1; }
  set is286(v: boolean) { this.model = v ? Math.max(this.model, 1) : 0; this.modelChanged(); }
  /** 选 386 时为 true（32 位寄存器和指令、分页等） */
  get is386(): boolean { return this.model === 2; }
  set is386(v: boolean) { this.model = v ? 2 : Math.min(this.model, 1); this.modelChanged(); }
  /** 正在执行陷阱处理函数（BIOS 的高层模拟） */
  private inTrap = false;
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

  // ---- 286/386：控制寄存器、描述符表寄存器、段描述符缓存 ----
  /**
   * 机器状态字（286 的 MSW；386 是整个 CR0）：位 0 PE（保护模式），位 1 MP，位 2 EM，位 3 TS（任务切换过），
   * 386 的位 31 PG（分页）。286 上没用的高位读出来是 1
   */
  msw = 0xfff0;
  /** 386：缺页时的线性地址、页目录的物理地址 */
  cr2 = 0;
  cr3 = 0;
  /** 386 的调试寄存器 DR0~DR7（只保存，不产生调试异常）、测试寄存器 TR6/TR7 */
  dr = new Uint32Array(8);
  trr = new Uint32Array(8);
  gdtr = { base: 0, limit: 0xffff };
  idtr = { base: 0, limit: 0x3ff };
  ldtr = { sel: 0, base: 0, limit: 0 };
  /** 任务寄存器；is32 表示当前是 386 的 32 位 TSS */
  tr = { sel: 0, base: 0, limit: 0, is32: false };
  /** 各段寄存器的描述符缓存 */
  cBase = new Float64Array(6);
  cLimit = new Float64Array(6).fill(0xffff);
  cAccess = new Uint8Array([0x93, 0x9b, 0x93, 0x93, 0x93, 0x93]);
  /** 386：段描述符的 D/B 位（32 位代码段、32 位堆栈） */
  cBig = new Uint8Array(6);
  /** 保护模式下装入了空选择子（不能用来访问内存） */
  cNull = new Uint8Array(6);
  /** 实模式下基址不是 段值 × 16 的段（LOADALL 设置的，或者 386 从保护模式回来后还没重新装入的），按位表示 */
  private overrideMask = 0;
  /** 当前特权级（保护模式下等于 CS 的 RPL；虚拟 8086 模式下是 3） */
  cpl = 0;
  /** A20 地址线（286/386）：关闭时地址第 20 位恒为 0 */
  private a20 = false;
  /** 地址掩码：8086 为 FFFFFh；286 为 FFFFFFh；386 为 FFFFFFFFh（A20 关闭时去掉第 20 位） */
  private addrMask = 0xfffff;
  /** 分页的 TLB：页号 → 页框地址 | 有效的 U/S、R/W 位 | 已写过（40h） */
  private tlb = new Int32Array(1 << 20);
  /** TLB 里填过的页号（清空时只清这些） */
  private tlbUsed = new Int32Array(8192);
  private tlbCount = 0;
  /** 取指令用的页缓存：线性页号 × 4 + CPL → 物理页的起始地址（-1 表示没有） */
  private fetchKey = -1;
  private fetchBase = 0;
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
  /** 本条指令的操作数大小（2 或 4 字节）和地址大小（是否 32 位） */
  private osz = 2;
  private asz32 = false;
  /** 内存操作数所用的段寄存器（下标）和偏移 */
  private eaSi = DS;
  private eaOff = 0;
  /** 内存操作数的地址用到了 ESP（POP [ESP+n] 要按弹出后的 ESP 算） */
  private eaSP = false;
  private inhibitIrq = false;
  private startIP = 0;
  private startSP = 0;

  constructor(mem?: Uint8Array) {
    this.mem = mem ?? new Uint8Array(MEM_SIZE);
  }

  get protectedMode(): boolean { return (this.msw & 1) !== 0; }
  /** 虚拟 8086 模式 */
  get v86(): boolean { return (this.flags & VM) !== 0; }

  private modelChanged(): void {
    this.updateAddrMask();
    if (!(this.msw & 1)) this.msw = this.model === 2 ? 0 : 0xfff0;
  }

  /** 复位 CPU 的 286/386 部分（开机、键盘控制器复位）：回到实模式 */
  resetProtected(): void {
    this.msw = this.model === 2 ? 0 : 0xfff0;
    this.cr2 = 0; this.cr3 = 0;
    this.dr.fill(0);
    this.gdtr = { base: 0, limit: 0xffff };
    this.idtr = { base: 0, limit: 0x3ff };
    this.ldtr = { sel: 0, base: 0, limit: 0 };
    this.tr = { sel: 0, base: 0, limit: 0, is32: false };
    this.cLimit.fill(0xffff);
    this.cAccess.set([0x93, 0x9b, 0x93, 0x93, 0x93, 0x93]);
    this.cBig.fill(0);
    this.cNull.fill(0);
    this.overrideMask = 0;
    this.cpl = 0;
    this.flags &= 0xffff;
    this.flushTlb();
  }

  setA20(on: boolean): void { this.a20 = on; this.updateAddrMask(); this.fetchKey = -1; }
  get a20Enabled(): boolean { return this.a20; }
  private updateAddrMask(): void {
    this.addrMask = this.model === 0 ? 0xfffff : this.model === 1 ? (this.a20 ? 0xffffff : 0xefffff) : (this.a20 ? 0xffffffff : 0xffefffff);
  }

  // ================= 寄存器 =================

  /** 32 位寄存器 */
  r32(i: number): number { return ((this.rh[i] << 16) | this.r[i]) >>> 0; }
  setR32(i: number, v: number): void { this.r[i] = v; this.rh[i] = v >>> 16; }

  getR8(i: number): number {
    return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8;
  }
  setR8(i: number, v: number): void {
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0x00ff) | ((v & 0xff) << 8);
  }
  /** 按大小（1、2、4 字节）读写通用寄存器 */
  private getRegN(size: number, i: number): number {
    return size === 2 ? this.r[i] : size === 1 ? this.getR8(i) : this.r32(i);
  }
  private setRegN(size: number, i: number, v: number): void {
    if (size === 2) this.r[i] = v; else if (size === 1) this.setR8(i, v); else this.setR32(i, v);
  }

  /** 写 FLAGS 的低 16 位（POPF、IRET、SAHF 之外的地方也用） */
  setFlags(v: number): void {
    // 8086：位 12-15 恒为 1；286 实模式：位 12-15 恒为 0（程序用这一点区分 8086 和 286）；
    // 286 保护模式、386：位 12-13 是 IOPL，位 14 是 NT。位 1 恒为 1，位 3、5、15 恒为 0
    if (this.model === 0) this.flags = (v & 0x0fd5) | 0xf002;
    else if (this.model === 1) this.flags = (v & (this.msw & 1 ? 0x7fd5 : 0x0fd5)) | 0x0002;
    else this.flags = (this.flags & 0xffff0000) | (v & 0x7fd5) | 0x0002;
  }
  /** 386：写整个 EFLAGS（keep 里的位保持原样）；没有 AC 位（这是 386 和 486 的区别） */
  private setEflags(v: number, keep = 0): void {
    const mask = 0x37fd5 & ~keep;
    this.flags = ((this.flags & ~mask) | (v & mask) | 0x0002) >>> 0;
  }
  private get iopl(): number { return (this.flags >> 12) & 3; }

  private setF(mask: number, on: boolean | number): void {
    if (on) this.flags |= mask; else this.flags &= ~mask;
  }
  private szp8(v: number): void {
    this.flags = (this.flags & ~(SF | ZF | PF)) | (v & 0x80 ? SF : 0) | (v === 0 ? ZF : 0) | PARITY[v & 0xff];
  }
  private szp16(v: number): void {
    this.flags = (this.flags & ~(SF | ZF | PF)) | (v & 0x8000 ? SF : 0) | (v === 0 ? ZF : 0) | PARITY[v & 0xff];
  }
  private szp(v: number, size: number): void {
    this.flags = (this.flags & ~(SF | ZF | PF)) | (v & SIGN[size] ? SF : 0) | (v === 0 ? ZF : 0) | PARITY[v & 0xff];
  }

  // ================= 内存访问 =================

  /** 段寄存器 i 当前的基址 */
  segBase(i: number): number {
    if (!(this.msw & 1)) return this.overrideMask & (1 << i) ? this.cBase[i] : this.s[i] << 4;
    return this.flags & VM ? this.s[i] << 4 : this.cBase[i];
  }

  /** CS:IP 对应的线性地址 */
  get linearIP(): number { return ((this.segBase(CS) + this.ip) & this.addrMask) >>> 0; }

  /** 按物理地址读写（已经过 A20 处理；地址必须小于 16MB） */
  readLin(a: number): number {
    if (this.mmio !== null && (a >>> 17) === 5) return this.mmio.read(a - 0xa0000);
    return this.mem[a];
  }
  writeLin(a: number, v: number): void {
    if (this.mmio !== null && (a >>> 17) === 5) { this.mmio.write(a - 0xa0000, v & 0xff); return; }
    if (this.onWrite) this.onWrite(a, this.mem[a]);
    this.mem[a] = v & 0xff;
  }

  /** 线性地址 → 物理地址（分页、A20） */
  private phys(lin: number, write: boolean): number {
    if (this.msw & 0x80000000) lin = this.translate(lin >>> 0, write);
    return (lin & this.addrMask) >>> 0;
  }
  /** 按线性地址读写一个字节（386 经过分页；16MB 以上没有内存，读出 FFh、写入忽略） */
  private rl(lin: number): number { const a = this.phys(lin, false); return a < MEM_SIZE ? this.readLin(a) : 0xff; }
  private wl(lin: number, v: number): void { const a = this.phys(lin, true); if (a < MEM_SIZE) this.writeLin(a, v); }

  /** 分页：查页表把线性地址换成物理地址；不合规时 #PF（CR2 = 线性地址） */
  private translate(lin: number, write: boolean): number {
    const page = lin >>> 12;
    const user = this.cpl === 3;
    let e = this.tlb[page];
    if (e === 0 || (write && !(e & 0x40))) e = this.walk(lin, write, user);
    else if (user && (!(e & 4) || (write && !(e & 2)))) this.pageFault(lin, write, user, true);
    return ((e & 0xfffff000) | (lin & 0xfff)) >>> 0;
  }
  private walk(lin: number, write: boolean, user: boolean): number {
    const rd = (a: number) => (this.mem[a] | (this.mem[a + 1] << 8) | (this.mem[a + 2] << 16) | (this.mem[a + 3] << 24)) >>> 0;
    const wr = (a: number, v: number) => { for (let k = 0; k < 4; k++) this.writeLin(a + k, v >>> (8 * k)); };
    const pdeA = (((this.cr3 & 0xfffff000) >>> 0) + (lin >>> 22) * 4) & (MEM_SIZE - 1);
    const pde = rd(pdeA);
    if (!(pde & 1)) this.pageFault(lin, write, user, false);
    const pteA = (((pde & 0xfffff000) >>> 0) + ((lin >>> 12) & 0x3ff) * 4) & (MEM_SIZE - 1);
    const pte = rd(pteA);
    if (!(pte & 1)) this.pageFault(lin, write, user, false);
    const u = pde & pte & 4, w = pde & pte & 2;
    if (user && (!u || (write && !w))) this.pageFault(lin, write, user, true);
    if (!(pde & 0x20)) wr(pdeA, pde | 0x20);
    const npte = pte | 0x20 | (write ? 0x40 : 0);
    if (npte !== pte) wr(pteA, npte);
    const e = ((pte & 0xfffff000) | u | w | (npte & 0x40)) >>> 0;
    const page = lin >>> 12;
    if (this.tlb[page] === 0) {
      if (this.tlbCount === this.tlbUsed.length) this.flushTlb();
      this.tlbUsed[this.tlbCount++] = page;
    }
    this.tlb[page] = e | 1; // 位 0：有效
    return e;
  }
  private pageFault(lin: number, write: boolean, user: boolean, present: boolean): never {
    this.cr2 = lin >>> 0;
    throw new CpuFault(14, (present ? 1 : 0) | (write ? 2 : 0) | (user ? 4 : 0));
  }
  /** 按线性地址读一个字节，不改变任何状态（调试器用）：分页时查页表，没有映射的页读出 FFh */
  peekLin(lin: number): number {
    lin >>>= 0;
    if (this.msw & 0x80000000) {
      const rd = (a: number) => (this.mem[a] | (this.mem[a + 1] << 8) | (this.mem[a + 2] << 16) | (this.mem[a + 3] << 24)) >>> 0;
      const pde = rd((((this.cr3 & 0xfffff000) >>> 0) + (lin >>> 22) * 4) & (MEM_SIZE - 4));
      if (!(pde & 1)) return 0xff;
      const pte = rd((((pde & 0xfffff000) >>> 0) + ((lin >>> 12) & 0x3ff) * 4) & (MEM_SIZE - 4));
      if (!(pte & 1)) return 0xff;
      lin = ((pte & 0xfffff000) | (lin & 0xfff)) >>> 0;
    }
    const a = (lin & this.addrMask) >>> 0;
    return a < MEM_SIZE ? this.mem[a] : 0xff;
  }
  /** 当前代码段是 32 位的 */
  get code32(): boolean { return this.cBig[CS] !== 0 && (this.msw & 1) !== 0 && !(this.flags & VM); }

  /** 清空 TLB（写 CR3、开关分页、任务切换时） */
  flushTlb(): void {
    this.fetchKey = -1;
    const t = this.tlb, u = this.tlbUsed;
    for (let k = 0; k < this.tlbCount; k++) t[u[k]] = 0;
    this.tlbCount = 0;
  }

  /**
   * 实模式风格的访问：段值 × 16 + 偏移（给 BIOS/DOS 的高层模拟和测试用）。分页打开时（例如 Windows 386 增强模式下
   * 在虚拟 8086 模式里调用 BIOS）这是线性地址，要经过页表；没有映射的页读出 FFh、写入忽略，不产生缺页异常
   */
  rb(seg: number, off: number): number {
    const lin = (seg << 4) + (off & 0xffff);
    if (this.msw & 0x80000000) { const a = this.physQuiet(lin, false); return a < 0 ? 0xff : this.readLin(a); }
    return this.readLin(lin & this.addrMask);
  }
  rw(seg: number, off: number): number {
    return this.rb(seg, off) | (this.rb(seg, off + 1) << 8);
  }
  wb(seg: number, off: number, v: number): void {
    const lin = (seg << 4) + (off & 0xffff);
    if (this.msw & 0x80000000) { const a = this.physQuiet(lin, true); if (a >= 0) this.writeLin(a, v); return; }
    this.writeLin(lin & this.addrMask, v);
  }
  /** 分页时把线性地址换成物理地址，不产生异常（不存在的页返回 -1）；按系统级访问，设置已访问位和脏位 */
  private physQuiet(lin: number, write: boolean): number {
    // 在虚拟 8086 模式下进入的 BIOS 陷阱里：和真的 CPU 一样产生缺页异常（监控程序装入这一页后重新执行陷阱指令）。
    // Windows 增强模式靠它知道 DOS 窗口的显存被写过、需要重画
    if (this.inTrap && this.flags & VM) { const a = this.phys(lin, write); return a < MEM_SIZE ? a : -1; }
    const cr2 = this.cr2;
    try {
      const saved = this.cpl;
      this.cpl = 0;
      try { const a = this.phys(lin, write); return a < MEM_SIZE ? a : -1; } finally { this.cpl = saved; }
    } catch (e) {
      if (!(e instanceof CpuFault)) throw e;
      this.cr2 = cr2;
      return -1;
    }
  }
  ww(seg: number, off: number, v: number): void {
    this.wb(seg, off, v);
    this.wb(seg, off + 1, v >> 8);
  }

  /** 检查对段 i 的访问：保护模式下查空选择子、读写权限；286 保护模式和 386 查界限 */
  private check(i: number, off: number, size: number, write: boolean): void {
    const fault = i === SS ? ssf : gp;
    if (this.msw & 1 && !(this.flags & VM)) {
      if (this.cNull[i]) throw fault(0);
      const acc = this.cAccess[i];
      if (write) {
        if (acc & 8 || !(acc & 2)) throw fault(0);   // 代码段、只读数据段不能写
      } else if ((acc & 0x0a) === 0x08) throw gp(0);  // 只能执行的代码段不能读
    }
    const lim = this.cLimit[i], acc = this.cAccess[i];
    if ((acc & 0x0c) === 0x04) { // 向下扩展的数据段：有效偏移是 界限+1 ~ FFFFh（32 位段是 FFFFFFFFh）
      if (off <= lim || off + size - 1 > (this.cBig[i] ? 0xffffffff : 0xffff)) throw fault(0);
    } else if (off + size - 1 > lim) throw fault(0);
  }

  /** 通过段寄存器 i 访问内存。8088/286 的偏移在 64KB 里回绕；386 查界限 */
  private rbS(i: number, off: number): number {
    if (this.model === 2) { this.check(i, off, 1, false); return this.rl(this.segBase(i) + off); }
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 1, false);
    return this.readLin((this.segBase(i) + off) & this.addrMask);
  }
  private rwS(i: number, off: number): number {
    if (this.model === 2) {
      this.check(i, off, 2, false);
      const a = this.segBase(i) + off;
      return this.rl(a) | (this.rl(a + 1) << 8);
    }
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 2, false);
    const b = this.segBase(i);
    return this.readLin((b + off) & this.addrMask) | (this.readLin((b + ((off + 1) & 0xffff)) & this.addrMask) << 8);
  }
  private rdS(i: number, off: number): number {
    this.check(i, off, 4, false);
    const a = this.segBase(i) + off;
    return (this.rl(a) | (this.rl(a + 1) << 8) | (this.rl(a + 2) << 16) | (this.rl(a + 3) << 24)) >>> 0;
  }
  private wbS(i: number, off: number, v: number): void {
    if (this.model === 2) { this.check(i, off, 1, true); this.wl(this.segBase(i) + off, v); return; }
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 1, true);
    this.writeLin((this.segBase(i) + off) & this.addrMask, v);
  }
  private wwS(i: number, off: number, v: number): void {
    if (this.model === 2) {
      this.check(i, off, 2, true);
      const a = this.segBase(i) + off;
      this.wl(a, v); this.wl(a + 1, v >> 8);
      return;
    }
    off &= 0xffff;
    if (this.msw & 1) this.check(i, off, 2, true);
    const b = this.segBase(i);
    this.writeLin((b + off) & this.addrMask, v);
    this.writeLin((b + ((off + 1) & 0xffff)) & this.addrMask, v >> 8);
  }
  private wdS(i: number, off: number, v: number): void {
    this.check(i, off, 4, true);
    const a = this.segBase(i) + off;
    this.wl(a, v); this.wl(a + 1, v >>> 8); this.wl(a + 2, v >>> 16); this.wl(a + 3, v >>> 24);
  }
  /** 按大小读写 */
  private rd(i: number, off: number, size: number): number {
    return size === 2 ? this.rwS(i, off) : size === 1 ? this.rbS(i, off) : this.rdS(i, off);
  }
  private wr(i: number, off: number, size: number, v: number): void {
    if (size === 2) this.wwS(i, off, v); else if (size === 1) this.wbS(i, off, v); else this.wdS(i, off, v);
  }
  /** 系统表（GDT、IDT、TSS）的读写：线性地址 */
  private rbL(a: number): number { return this.model === 2 ? this.rl(a) : this.readLin(a & this.addrMask); }
  private wbL(a: number, v: number): void { if (this.model === 2) this.wl(a, v); else this.writeLin(a & this.addrMask, v); }
  private rwL(a: number): number { return this.rbL(a) | (this.rbL(a + 1) << 8); }
  private wwL(a: number, v: number): void { this.wbL(a, v); this.wbL(a + 1, v >> 8); }
  private rdL(a: number): number { return (this.rwL(a) | (this.rwL(a + 2) << 16)) >>> 0; }
  private wdL(a: number, v: number): void { this.wwL(a, v); this.wwL(a + 2, v >>> 16); }

  private fetch8(): number {
    const ip = this.ip;
    if (this.model === 2) {
      if (ip > this.cLimit[CS]) throw gp(0);
      const lin = (this.segBase(CS) + ip) >>> 0;
      const key = (lin >>> 12) * 4 + this.cpl;
      let v: number;
      if (key === this.fetchKey) v = this.mem[this.fetchBase + (lin & 0xfff)];
      else {
        const a = this.phys(lin, false);
        if (a < MEM_SIZE && (a >>> 17) !== 5) { this.fetchKey = key; this.fetchBase = a - (a & 0xfff); }
        v = a < MEM_SIZE ? this.readLin(a) : 0xff;
      }
      this.ip = ip + 1;
      return v;
    }
    if (this.msw & 1 && ip > this.cLimit[CS]) throw gp(0);
    const v = this.readLin((this.segBase(CS) + ip) & this.addrMask);
    this.ip = (ip + 1) & 0xffff;
    return v;
  }
  private fetch16(): number {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }
  private fetch32(): number {
    const lo = this.fetch16();
    return (lo | (this.fetch16() << 16)) >>> 0;
  }
  private fetchS8(): number {
    const v = this.fetch8();
    return v & 0x80 ? v - 0x100 : v;
  }
  /** 按大小取立即数 */
  private fetchN(size: number): number {
    return size === 2 ? this.fetch16() : size === 1 ? this.fetch8() : this.fetch32();
  }
  /** 带符号的相对位移（2 或 4 字节） */
  private fetchRel(size: number): number {
    return size === 2 ? (this.fetch16() << 16) >> 16 : this.fetch32() | 0;
  }

  /** 近转移：IP 按操作数大小截断；386 检查是否超出 CS 的界限 */
  private jumpNear(nip: number): void {
    if (this.model === 2) {
      nip = this.osz === 4 ? nip >>> 0 : nip & 0xffff;
      if (nip > this.cLimit[CS]) throw gp(0);
      this.ip = nip;
    } else this.ip = nip & 0xffff;
  }

  // ================= 栈 =================

  /** 堆栈是 32 位的（保护模式下 SS 的 B 位） */
  private get stack32(): boolean { return this.cBig[SS] !== 0 && (this.msw & 1) !== 0 && !(this.flags & VM); }
  private getSP(): number { return this.stack32 ? this.r32(SP) : this.r[SP]; }
  private setSP(v: number): void { if (this.stack32) this.setR32(SP, v); else this.r[SP] = v; }
  /** 堆栈上 SP + k 的偏移（16 位堆栈回绕） */
  private spAdd(sp: number, k: number): number { return this.stack32 ? (sp + k) >>> 0 : (sp + k) & 0xffff; }

  /** 压入一个字（BIOS 等高层代码用） */
  push(v: number): void { this.pushN(v, 2); }
  pop(): number { return this.popN(2); }
  private pushN(v: number, size: number): void {
    if (this.model < 2) { const sp = (this.r[SP] - 2) & 0xffff; this.wwS(SS, sp, v); this.r[SP] = sp; return; }
    const sp = this.spAdd(this.getSP(), -size);
    if (size === 2) this.wwS(SS, sp, v); else this.wdS(SS, sp, v);
    this.setSP(sp);
  }
  private popN(size: number): number {
    if (this.model < 2) { const v = this.rwS(SS, this.r[SP]); this.r[SP] += 2; return v; }
    const sp = this.getSP();
    const v = size === 2 ? this.rwS(SS, sp) : this.rdS(SS, sp);
    this.setSP(this.spAdd(sp, size));
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
    const m = (k: number) => this.rbL(a + k);
    const access = m(5);
    let lim = m(0) | (m(1) << 8), dbase = m(2) | (m(3) << 8) | (m(4) << 16), big = 0, gateOff = lim;
    if (this.model === 2) {
      const b6 = m(6), b7 = m(7);
      lim |= (b6 & 0x0f) << 16;
      if (b6 & 0x80) lim = lim * 4096 + 0xfff; // 粒度 4KB
      dbase = (dbase | (b7 << 24)) >>> 0;
      big = (b6 & 0x40) ? 1 : 0;
      if (!(access & 0x10) && access & 0x08) gateOff = (gateOff | (b6 << 16) | (b7 << 24)) >>> 0; // 386 的门：32 位偏移
    }
    return { limit: lim, base: dbase, access, big, addr: a, gateOff, gateSel: m(2) | (m(3) << 8), gateCount: m(4) & 0x1f };
  }

  /** 设置描述符的"已访问"位 */
  private touch(d: Desc): void {
    if (!(d.access & 1)) { d.access |= 1; this.wbL(d.addr + 5, d.access); }
  }

  private setCache(i: number, sel: number, d: Desc): void {
    this.s[i] = sel;
    this.cBase[i] = d.base;
    this.cLimit[i] = d.limit;
    this.cAccess[i] = d.access;
    this.cBig[i] = d.big;
    this.cNull[i] = 0;
  }

  /** 装入数据段寄存器和 SS（MOV、POP、LES/LDS 等） */
  private loadSeg(i: number, sel: number): void {
    if (!(this.msw & 1) || this.flags & VM) {
      // 实模式、虚拟 8086 模式：基址 = 段值 × 16；386 实模式下界限和权限保持不变
      this.s[i] = sel;
      this.cBase[i] = sel << 4;
      this.overrideMask &= ~(1 << i);
      if (this.flags & VM) { this.cLimit[i] = 0xffff; this.cAccess[i] = 0xf3; this.cBig[i] = 0; this.cNull[i] = 0; }
      return;
    }
    if (i === CS) throw ud(); // 不能用 MOV/POP 装入 CS
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

  /** 实模式、虚拟 8086 模式下装入 CS（远转移、中断） */
  private loadCSReal(sel: number): void {
    this.s[CS] = sel; this.cBase[CS] = sel << 4; this.overrideMask &= ~2;
    if (this.flags & VM) { this.cLimit[CS] = 0xffff; this.cBig[CS] = 0; }
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
    for (const i of [ES, DS, FS, GS]) {
      if (this.cNull[i]) continue;
      const acc = this.cAccess[i], dpl = (acc >> 5) & 3;
      const conformingCode = (acc & 0x0c) === 0x0c && acc & 0x08;
      if (!conformingCode && dpl < this.cpl) { this.s[i] = 0; this.cNull[i] = 1; }
    }
  }

  /** 门的类型：286 的门是 4~7，386 的是 C~F（第 3 位为 1 表示 32 位） */
  private validGate(type: number, base: number): boolean {
    return type === base || (this.model === 2 && type === base + 8);
  }

  // ================= 远转移 =================

  private farJump(sel: number, off: number): void {
    if (!(this.msw & 1) || this.flags & VM) {
      if (this.model === 2 && off > this.cLimit[CS] && !(this.flags & VM)) throw gp(0);
      this.loadCSReal(sel); this.ip = off;
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
      this.loadCS(sel, d, this.cpl);
      this.ip = off;
      return;
    }
    const type = d.access & 0x1f;
    if (this.validGate(type, 4)) { // 调用门：JMP 不能改变特权级
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      const t = this.codeDesc(d.gateSel);
      const tdpl = (t.access >> 5) & 3;
      if (t.access & 0x04 ? tdpl > this.cpl : tdpl !== this.cpl) throw gp(d.gateSel);
      if (!(t.access & 0x80)) throw np(d.gateSel);
      const goff = type === 4 ? d.gateOff & 0xffff : d.gateOff;
      if (goff > t.limit) throw gp(0);
      this.loadCS(d.gateSel, t, this.cpl);
      this.ip = goff;
      return;
    }
    if (type === 1 || type === 5 || (this.model === 2 && type === 9)) { // 任务状态段或任务门
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      this.taskSwitch(type === 5 ? d.gateSel : sel, 'jmp');
      return;
    }
    throw gp(sel);
  }

  /** 远调用：size 是压栈的大小（操作数大小） */
  private farCall(sel: number, off: number, size: number): void {
    if (!(this.msw & 1) || this.flags & VM) {
      if (this.model === 2 && off > this.cLimit[CS] && !(this.flags & VM)) throw gp(0);
      this.pushN(this.s[CS], size); this.pushN(this.ip, size);
      this.loadCSReal(sel); this.ip = off;
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
      this.pushN(this.s[CS], size); this.pushN(this.ip, size);
      this.loadCS(sel, d, this.cpl);
      this.ip = off;
      return;
    }
    const type = d.access & 0x1f;
    if (this.validGate(type, 4)) { // 调用门
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      const t = this.codeDesc(d.gateSel);
      const tdpl = (t.access >> 5) & 3;
      if (tdpl > this.cpl) throw gp(d.gateSel);
      if (!(t.access & 0x80)) throw np(d.gateSel);
      const gsz = type === 4 ? 2 : 4;
      const goff = gsz === 2 ? d.gateOff & 0xffff : d.gateOff;
      if (goff > t.limit) throw gp(0);
      if (!(t.access & 0x04) && tdpl < this.cpl) {
        // 调用更高特权级的过程：换到 TSS 里为那一级准备的堆栈，复制参数
        const oldSS = this.s[SS], oldSP = this.getSP(), oldCS = this.s[CS], oldIP = this.ip;
        const params: number[] = [];
        for (let k = d.gateCount - 1; k >= 0; k--) params.push(this.rd(SS, this.spAdd(oldSP, k * gsz), gsz));
        this.switchStack(tdpl);
        this.pushN(oldSS, gsz); this.pushN(oldSP, gsz);
        for (const p of params) this.pushN(p, gsz);
        this.pushN(oldCS, gsz); this.pushN(oldIP, gsz);
        this.loadCS(d.gateSel, t, tdpl);
      } else {
        this.pushN(this.s[CS], gsz); this.pushN(this.ip, gsz);
        this.loadCS(d.gateSel, t, this.cpl);
      }
      this.ip = goff;
      return;
    }
    if (type === 1 || type === 5 || (this.model === 2 && type === 9)) {
      if (dpl < this.cpl || dpl < rpl) throw gp(sel);
      if (!(d.access & 0x80)) throw np(sel);
      this.taskSwitch(type === 5 ? d.gateSel : sel, 'call');
      return;
    }
    throw gp(sel);
  }

  /** 换到特权级 level 的堆栈（从当前 TSS 里取 SS:SP） */
  private switchStack(level: number): void {
    let nsp: number, nss: number;
    if (this.tr.is32) {
      const off = 4 + level * 8;
      if (off + 5 > this.tr.limit) throw ts(this.tr.sel);
      nsp = this.rdL(this.tr.base + off); nss = this.rwL(this.tr.base + off + 4);
    } else {
      const off = 2 + level * 4;
      if (off + 3 > this.tr.limit) throw ts(this.tr.sel);
      nsp = this.rwL(this.tr.base + off); nss = this.rwL(this.tr.base + off + 2);
    }
    if ((nss & 0xfffc) === 0) throw ts(nss);
    const d = this.desc(nss, ts);
    if ((nss & 3) !== level || ((d.access >> 5) & 3) !== level || (d.access & 0x1a) !== 0x12) throw ts(nss);
    if (!(d.access & 0x80)) throw ssf(nss);
    this.touch(d);
    this.setCache(SS, nss, d);
    if (d.big) this.setR32(SP, nsp); else this.r[SP] = nsp;
  }

  /** RETF n */
  private farReturn(n: number, size: number): void {
    if (!(this.msw & 1) || this.flags & VM) {
      const sp = this.getSP();
      const nip = this.rd(SS, sp, size), cs = this.rd(SS, this.spAdd(sp, size), size) & 0xffff;
      if (this.model === 2 && nip > this.cLimit[CS] && !(this.flags & VM)) throw gp(0);
      this.ip = size === 2 && this.model < 2 ? nip & 0xffff : nip;
      this.loadCSReal(cs);
      this.setSP(this.spAdd(sp, size * 2 + n));
      return;
    }
    const sp = this.getSP();
    const nip = this.rd(SS, sp, size), ncs = this.rd(SS, this.spAdd(sp, size), size) & 0xffff;
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
      this.setSP(this.spAdd(sp, size * 2 + n));
      return;
    }
    // 返回到特权级更低的调用者：还要弹出它的 SS:SP
    const nsp = this.rd(SS, this.spAdd(sp, size * 2 + n), size), nss = this.rd(SS, this.spAdd(sp, size * 3 + n), size) & 0xffff;
    this.loadCS(ncs, d, rpl);
    this.loadSeg(SS, nss);
    this.ip = nip;
    this.setSP(this.stack32 ? (nsp + n) >>> 0 : (nsp + n) & 0xffff);
    this.nullifyDataSegs();
  }

  private iret(size: number): void {
    if (!(this.msw & 1)) {
      const nip = this.popN(size), cs = this.popN(size) & 0xffff, f = this.popN(size);
      if (this.model === 2 && nip > this.cLimit[CS]) throw gp(0);
      this.ip = nip;
      this.loadCSReal(cs);
      if (size === 4) this.setEflags(f, VM); else this.setFlags(f);
      return;
    }
    if (this.flags & VM) { // 虚拟 8086 模式：IOPL 为 3 时直接返回，否则 #GP（交给监控程序）
      if (this.iopl < 3) throw gp(0);
      const nip = this.popN(size), cs = this.popN(size) & 0xffff, f = this.popN(size);
      this.ip = nip; this.loadCSReal(cs);
      if (size === 4) this.setEflags(f, VM | IOPL | RF); else this.setFlags((f & ~IOPL) | (this.flags & IOPL));
      return;
    }
    if (this.flags & NT) { // 嵌套任务：返回到前一个任务
      const back = this.rwL(this.tr.base);
      this.taskSwitch(back, 'iret');
      return;
    }
    const sp = this.getSP();
    const nip = this.rd(SS, sp, size), ncs = this.rd(SS, this.spAdd(sp, size), size) & 0xffff, nflags = this.rd(SS, this.spAdd(sp, size * 2), size);
    if (size === 4 && nflags & VM && this.cpl === 0) { this.iretToV86(sp, nip, ncs, nflags); return; }
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
      this.setSP(this.spAdd(sp, size * 3));
    } else {
      const nsp = this.rd(SS, this.spAdd(sp, size * 3), size), nss = this.rd(SS, this.spAdd(sp, size * 4), size) & 0xffff;
      this.loadCS(ncs, d, rpl);
      this.loadSeg(SS, nss);
      this.setSP(nsp);
      this.nullifyDataSegs();
    }
    this.ip = nip;
    this.popFlagsProtected(nflags, oldCpl, size);
  }

  /** IRETD 回到虚拟 8086 模式：栈上依次是 EIP、CS、EFLAGS、ESP、SS、ES、DS、FS、GS */
  private iretToV86(sp: number, nip: number, ncs: number, nflags: number): void {
    const at = (k: number) => this.rd(SS, this.spAdd(sp, k * 4), 4);
    const nesp = at(3), nss = at(4) & 0xffff, nes = at(5) & 0xffff, nds = at(6) & 0xffff, nfs = at(7) & 0xffff, ngs = at(8) & 0xffff;
    this.setEflags(nflags);
    this.flags |= VM;
    this.cpl = 3;
    this.loadCSReal(ncs);
    this.ip = nip & 0xffff;
    this.loadSeg(SS, nss); this.loadSeg(ES, nes); this.loadSeg(DS, nds); this.loadSeg(FS, nfs); this.loadSeg(GS, ngs);
    this.setR32(SP, nesp);
  }

  /** 保护模式下的 POPF/IRET：IOPL 只有 CPL 0 能改，IF 只有 CPL <= IOPL 时能改 */
  private popFlagsProtected(v: number, cpl: number, size = 2): void {
    let keep = 0;
    if (cpl > 0) keep |= IOPL;
    if (cpl > this.iopl) keep |= IF;
    if (size === 4) { this.setEflags(v, keep | VM); return; }
    this.setFlags((v & ~keep) | (this.flags & keep));
  }

  // ================= 任务切换（286 的 44 字节 TSS，386 的 104 字节 TSS） =================

  private taskSwitch(sel: number, kind: 'jmp' | 'call' | 'iret' | 'int'): void {
    if ((sel & 0xfffc) === 0 || sel & 4) throw (kind === 'iret' ? ts : gp)(sel);
    const d = this.desc(sel, kind === 'iret' ? ts : gp);
    const type = d.access & 0x1f;
    const busy = kind === 'iret'; // 返回时目标是"忙"的 TSS，其他情况是"可用"的
    const is32 = this.model === 2 && (type & 8) !== 0;
    if ((type & 0x17) !== (busy ? 0x03 : 0x01) || (type & 8 && this.model < 2)) throw (kind === 'iret' ? ts : gp)(sel);
    if (!(d.access & 0x80)) throw np(sel);
    if (d.limit < (is32 ? 0x67 : 43)) throw ts(sel);
    const r = this.r, s = this.s;
    // 保存当前任务的状态
    const old = this.tr.base;
    let flags = this.flags;
    if (kind === 'iret') flags &= ~NT;
    if (this.tr.is32) {
      this.wdL(old + 0x20, this.ip);
      this.wdL(old + 0x24, flags);
      for (let k = 0; k < 8; k++) this.wdL(old + 0x28 + k * 4, this.r32(k));
      for (let k = 0; k < 6; k++) this.wwL(old + 0x48 + k * 4, s[k]);
    } else {
      this.wwL(old + 0x0e, this.ip);
      this.wwL(old + 0x10, flags);
      for (let k = 0; k < 8; k++) this.wwL(old + 0x12 + k * 2, r[k]);
      for (let k = 0; k < 4; k++) this.wwL(old + 0x22 + k * 2, s[k]);
    }
    // 旧任务：JMP、IRET 清掉"忙"位
    if (kind === 'jmp' || kind === 'iret') {
      const od = this.desc(this.tr.sel);
      this.wbL(od.addr + 5, od.access & ~0x02);
    }
    // 新任务："忙"位；CALL、INT 嵌套时记下前一个任务
    if (kind !== 'iret') this.wbL(d.addr + 5, d.access | 0x02);
    const nb = d.base;
    if (kind === 'call' || kind === 'int') this.wwL(nb, this.tr.sel);
    this.tr = { sel, base: nb, limit: d.limit, is32 };
    this.msw |= 8; // TS
    // 装入新任务的状态
    let nflags: number, sels: number[], nldt: number;
    if (is32) {
      const cr3 = this.rdL(nb + 0x1c);
      if (this.msw & 0x80000000 && cr3 !== this.cr3) { this.cr3 = cr3; this.flushTlb(); }
      this.ip = this.rdL(nb + 0x20);
      nflags = this.rdL(nb + 0x24);
      for (let k = 0; k < 8; k++) this.setR32(k, this.rdL(nb + 0x28 + k * 4));
      sels = [0, 1, 2, 3, 4, 5].map(k => this.rwL(nb + 0x48 + k * 4));
      nldt = this.rwL(nb + 0x60);
    } else {
      this.ip = this.rwL(nb + 0x0e);
      nflags = this.rwL(nb + 0x10);
      for (let k = 0; k < 8; k++) r[k] = this.rwL(nb + 0x12 + k * 2);
      sels = [0, 1, 2, 3].map(k => this.rwL(nb + 0x22 + k * 2)).concat([0, 0]);
      nldt = this.rwL(nb + 0x2a);
    }
    if (kind === 'call' || kind === 'int') nflags |= NT;
    if (is32) this.setEflags(nflags); else this.setFlags(nflags);
    this.loadLdt(nldt, ts);
    if (this.flags & VM) { // 新任务是虚拟 8086 模式
      this.cpl = 3;
      this.loadCSReal(sels[CS]);
      for (const i of [ES, SS, DS, FS, GS]) this.loadSeg(i, sels[i]);
      return;
    }
    // 先按新任务的 CPL 装入各个段（出错是 #TS）
    s[CS] = sels[CS]; this.cpl = sels[CS] & 3;
    try {
      const cd = this.codeDesc(sels[CS]);
      this.loadCS(sels[CS], cd, sels[CS] & 3);
      this.loadSeg(SS, sels[SS]);
      for (const i of [ES, DS, FS, GS]) this.loadSeg(i, sels[i]);
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
    if (this.model === 2 && n * 4 + 3 > this.idtr.limit) throw gp(n * 8 + 2);
    this.push(this.flags & 0xffff);
    this.flags &= ~(IF | TF);
    if (this.model === 2) this.flags &= ~RF;
    this.push(this.s[CS]);
    this.push(this.ip);
    const a = this.idtr.base + n * 4;
    this.ip = this.rwL(a);
    this.loadCSReal(this.rwL(a + 2));
    this.halted = false;
  }

  private protectedInterrupt(n: number, code: number, soft: boolean): void {
    const ext = soft ? 0 : 1;
    // 虚拟 8086 模式下 IOPL < 3 时 INT n 交给监控程序（#GP）
    if (soft && this.flags & VM && this.iopl < 3) throw gp(0);
    if (n * 8 + 7 > this.idtr.limit) throw gp(n * 8 + 2 + ext);
    const a = this.idtr.base + n * 8;
    const m = (k: number) => this.rbL(a + k);
    const acc = m(5);
    const type = acc & 0x1f, gdpl = (acc >> 5) & 3;
    const gate32 = this.model === 2 && (type & 8) !== 0;
    const goff = gate32 ? (m(0) | (m(1) << 8) | (m(6) << 16) | (m(7) << 24)) >>> 0 : m(0) | (m(1) << 8);
    const gsel = m(2) | (m(3) << 8);
    if (type !== 5 && !this.validGate(type, 6) && !this.validGate(type, 7)) throw gp(n * 8 + 2 + ext);
    if (soft && gdpl < this.cpl) throw gp(n * 8 + 2);
    if (!(acc & 0x80)) throw np(n * 8 + 2 + ext);
    if (type === 5) { // 任务门
      this.taskSwitch(gsel, 'int');
      if (code >= 0) this.pushN(code, this.tr.is32 ? 4 : 2);
      return;
    }
    const size = gate32 ? 4 : 2;
    const t = this.codeDesc(gsel);
    const tdpl = (t.access >> 5) & 3;
    if (tdpl > this.cpl) throw gp(gsel);
    if (!(t.access & 0x80)) throw np(gsel);
    if (goff > t.limit) throw gp(0);
    const flags = this.flags;
    if (flags & VM) {
      // 从虚拟 8086 模式进入：只能到 0 级，换到 0 级堆栈，压入 GS FS DS ES SS ESP EFLAGS CS EIP
      if (tdpl !== 0 || t.access & 0x04) throw gp(gsel);
      const oldSS = this.s[SS], oldSP = this.r32(SP), segs = [this.s[GS], this.s[FS], this.s[DS], this.s[ES]];
      this.flags &= ~VM;
      this.cpl = 0;
      this.switchStack(0);
      for (const v of segs) this.pushN(v, size);
      this.pushN(oldSS, size); this.pushN(oldSP, size);
      this.pushN(flags, size); this.pushN(this.s[CS], size); this.pushN(this.ip, size);
      if (code >= 0) this.pushN(code, size);
      for (const i of [GS, FS, DS, ES]) { this.s[i] = 0; this.cNull[i] = 1; }
      this.loadCS(gsel, t, 0);
    } else if (!(t.access & 0x04) && tdpl < this.cpl) {
      const oldSS = this.s[SS], oldSP = this.getSP();
      this.switchStack(tdpl);
      this.pushN(oldSS, size); this.pushN(oldSP, size);
      this.pushN(flags, size); this.pushN(this.s[CS], size); this.pushN(this.ip, size);
      if (code >= 0) this.pushN(code, size);
      this.loadCS(gsel, t, tdpl);
    } else {
      this.pushN(flags, size); this.pushN(this.s[CS], size); this.pushN(this.ip, size);
      if (code >= 0) this.pushN(code, size);
      this.loadCS(gsel, t, this.cpl);
    }
    this.ip = goff;
    this.flags &= ~(TF | NT | RF | VM);
    if ((type & 7) === 6) this.flags &= ~IF; // 中断门关中断，陷阱门不关
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
    if (this.asz32) { this.modrm32(); return; }
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
    this.eaSP = false;
  }

  /** 32 位寻址：[基址 + 变址 × 比例 + 位移]，rm = 4 时后面跟 SIB 字节 */
  private modrm32(): void {
    let off = 0, seg = DS;
    this.eaSP = false;
    if (this.rm === 4) {
      const sib = this.fetch8();
      const base = sib & 7, index = (sib >> 3) & 7, scale = sib >> 6;
      if (base === 5 && this.mod === 0) off = this.fetch32();
      else {
        off = this.r32(base);
        if (base === SP || base === BP) seg = SS;
        if (base === SP) this.eaSP = true;
      }
      if (index !== 4) off += this.r32(index) * (1 << scale);
      else if (scale && !(base === 5 && this.mod === 0)) off = this.r32(base) * (1 << scale); // 386 的怪癖：没有变址但比例不为 0 时，基址乘以比例
    } else if (this.rm === 5 && this.mod === 0) off = this.fetch32();
    else {
      off = this.r32(this.rm);
      if (this.rm === BP) seg = SS;
    }
    if (this.mod === 1) off += this.fetchS8();
    else if (this.mod === 2) off += this.fetch32() | 0;
    this.eaOff = off >>> 0;
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
  private getRM(size: number): number {
    return this.mod === 3 ? this.getRegN(size, this.rm) : this.rd(this.eaSi, this.eaOff, size);
  }
  private setRM(size: number, v: number): void {
    if (this.mod === 3) this.setRegN(size, this.rm, v); else this.wr(this.eaSi, this.eaOff, size, v);
  }
  private getReg(size: number): number { return this.getRegN(size, this.reg); }
  private setReg(size: number, v: number): void { this.setRegN(size, this.reg, v); }
  /** 内存操作数的偏移 + k（按地址大小回绕） */
  private eaPlus(k: number): number { return this.asz32 ? (this.eaOff + k) >>> 0 : this.model === 2 ? this.eaOff + k : (this.eaOff + k) & 0xffff; }

  // ================= 运算 =================

  /** 0 ADD, 1 OR, 2 ADC, 3 SBB, 4 AND, 5 SUB, 6 XOR, 7 CMP */
  private alu(op: number, a: number, b: number, size: number): number {
    const mask = MASK[size];
    const sign = SIGN[size];
    let res: number;
    switch (op) {
      case 0: case 2: {
        const c = op === 2 && this.flags & CF ? 1 : 0;
        res = a + b + c;
        this.setF(CF, res > mask);
        this.setF(AF, (a ^ b ^ res) & 0x10);
        this.setF(OF, (res ^ a) & (res ^ b) & sign);
        break;
      }
      case 3: case 5: case 7: {
        const c = op === 3 && this.flags & CF ? 1 : 0;
        res = a - b - c;
        this.setF(CF, res < 0);
        this.setF(AF, (a ^ b ^ res) & 0x10);
        this.setF(OF, (a ^ b) & (a ^ res) & sign);
        break;
      }
      case 1: res = a | b; this.flags &= ~(CF | OF | AF); break;
      case 4: res = a & b; this.flags &= ~(CF | OF | AF); break;
      default: res = a ^ b; this.flags &= ~(CF | OF | AF); break;
    }
    res = size === 4 ? res >>> 0 : res & mask;
    this.szp(res, size);
    return res;
  }

  private inc(v: number, size: number): number {
    const sign = SIGN[size];
    const res = size === 4 ? (v + 1) >>> 0 : (v + 1) & MASK[size];
    this.setF(OF, res === sign);
    this.setF(AF, (v & 0xf) === 0xf);
    this.szp(res, size);
    return res;
  }
  private dec(v: number, size: number): number {
    const sign = SIGN[size];
    const res = size === 4 ? (v - 1) >>> 0 : (v - 1) & MASK[size];
    this.setF(OF, v === sign);
    this.setF(AF, (v & 0xf) === 0);
    this.szp(res, size);
    return res;
  }

  /** 移位/循环移位：0 ROL 1 ROR 2 RCL 3 RCR 4 SHL 5 SHR 6 SETMO 7 SAR */
  private shift(op: number, v: number, count: number, size: number): number {
    if (count === 0) return v;
    if (op === 6 && this.model >= 1) op = 4; // 186 以后：/6 是 SHL 的别名（8086 上是未公开的 SETMO）
    const mask = MASK[size], sign = SIGN[size];
    const t = size === 4 ? (x: number) => x >>> 0 : (x: number) => x & mask;
    let cf = this.flags & CF ? 1 : 0;
    for (let i = 0; i < count; i++) {
      switch (op) {
        case 0: cf = v & sign ? 1 : 0; v = t(v * 2 + cf); break;
        case 1: cf = v & 1; v = t((v >>> 1) + (cf ? sign : 0)); break;
        case 2: { const n = v & sign ? 1 : 0; v = t(v * 2 + cf); cf = n; break; }
        case 3: { const n = v & 1; v = t((v >>> 1) + (cf ? sign : 0)); cf = n; break; }
        case 4: cf = v & sign ? 1 : 0; v = t(v * 2); break;
        case 5: cf = v & 1; v = v >>> 1; break;
        case 6: cf = 0; v = mask; break;
        case 7: cf = v & 1; v = t((v >>> 1) + (v & sign ? sign : 0)); break;
      }
    }
    this.setF(CF, cf);
    const msb = v & sign ? 1 : 0;
    if (op === 0 || op === 2 || op === 4 || op === 6) this.setF(OF, msb ^ cf);
    else this.setF(OF, msb ^ (v & (sign >>> 1) ? 1 : 0));
    if (op >= 4) {
      this.szp(v, size);
      this.setF(AF, op === 4 && v & 0x10);
    }
    return v;
  }

  /** SHLD / SHRD（386） */
  private shiftDouble(left: boolean, dst: number, src: number, count: number, size: number): number {
    count &= 31;
    if (count === 0) return dst;
    const bits = size * 8;
    const B = BigInt(bits), mask = (1n << B) - 1n;
    let res: number, cf: number;
    if (left) {
      // 16 位时次数可以超过 16：386 按 目标:源:源 的 48 位来移
      const wide = size === 2 ? (BigInt(dst) << 32n) | (BigInt(src) << 16n) | BigInt(src) : (BigInt(dst) << B) | BigInt(src);
      const total = size === 2 ? 48n : 2n * B;
      const sh = wide << BigInt(count);
      res = Number((sh >> (total - B)) & mask);
      cf = Number((sh >> total) & 1n);
    } else {
      // 右移：目标在低位，源在高位（16 位时 386 按 源:源:目标 的 48 位来移）
      const wide = size === 2 ? BigInt(dst) | (BigInt(src) << 16n) | (BigInt(src) << 32n) : (BigInt(src) << B) | BigInt(dst);
      res = Number((wide >> BigInt(count)) & mask);
      cf = Number((wide >> BigInt(count - 1)) & 1n);
    }
    this.setF(CF, cf);
    const sign = SIGN[size];
    this.setF(OF, (res ^ dst) & sign);
    this.szp(res, size);
    return res;
  }

  /** 386 的 DAA / DAS：第一步的进位/借位也算进 CF */
  private daa386(sub: boolean): void {
    const oldAL = this.r[AX] & 0xff, oldCF = this.flags & CF;
    let al = oldAL, cf = 0;
    if ((al & 0xf) > 9 || this.flags & AF) {
      cf = oldCF || (sub ? al < 6 : al > 0xf9) ? 1 : 0;
      al = (sub ? al - 6 : al + 6) & 0xff;
      this.flags |= AF;
    } else this.flags &= ~AF;
    if (oldAL > 0x99 || oldCF) { al = (sub ? al - 0x60 : al + 0x60) & 0xff; cf = 1; }
    this.setF(CF, cf);
    this.setF(OF, sub ? oldAL & ~al & 0x80 : ~oldAL & al & 0x80);
    this.setR8(0, al); this.szp8(al);
  }

  private divideError(): void {
    if (this.model >= 1) throw new CpuFault(0); // 286 以后：返回地址指向出错的那条指令
    this.interrupt(0);
  }

  private mulDiv(op: number, size: number): void {
    const src = this.getRM(size);
    const r = this.r;
    if (size === 4) { this.mulDiv32(op, src); return; }
    const w = size === 2;
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
        const minQ = this.model >= 1 ? 1 : 0; // 286 以后：商可以是 -8000h / -80h
        if (w) {
          const num = (r[DX] << 16) | r[AX];
          const d = (src << 16) >> 16;
          if (d === 0) return this.divideError();
          const q = Math.trunc(num / d);
          if (q > 0x7fff || q < -0x7fff - minQ) return this.divideError();
          const qq = this.rep && this.model === 0 ? -q : q; // 8088 未公开行为：REP 前缀使商变号
          r[AX] = qq & 0xffff; r[DX] = (num - q * d) & 0xffff;
        } else {
          const num = (r[AX] << 16) >> 16;
          const d = (src << 24) >> 24;
          if (d === 0) return this.divideError();
          const q = Math.trunc(num / d);
          if (q > 0x7f || q < -0x7f - minQ) return this.divideError();
          const qq = this.rep && this.model === 0 ? -q : q;
          r[AX] = (((num - q * d) & 0xff) << 8) | (qq & 0xff);
        }
        break;
      }
    }
  }

  /** 32 位的乘除（EDX:EAX） */
  private mulDiv32(op: number, src: number): void {
    const eax = this.r32(AX);
    switch (op) {
      case 4: { // MUL
        const p = BigInt(eax) * BigInt(src);
        const lo = Number(p & 0xffffffffn), hi = Number(p >> 32n);
        this.setR32(AX, lo); this.setR32(DX, hi);
        this.setF(CF | OF, hi !== 0);
        this.szp(lo, 4);
        this.flags &= ~AF;
        return;
      }
      case 5: { // IMUL
        const p = BigInt(eax | 0) * BigInt(src | 0);
        const lo = Number(BigInt.asUintN(32, p)), hi = Number(BigInt.asUintN(32, p >> 32n));
        this.setR32(AX, lo); this.setR32(DX, hi);
        this.setF(CF | OF, p !== BigInt(lo | 0));
        this.szp(lo, 4);
        this.flags &= ~AF;
        return;
      }
      case 6: { // DIV
        if (src === 0) return this.divideError();
        const num = (BigInt(this.r32(DX)) << 32n) | BigInt(eax);
        const q = num / BigInt(src);
        if (q > 0xffffffffn) return this.divideError();
        this.setR32(AX, Number(q)); this.setR32(DX, Number(num % BigInt(src)));
        return;
      }
      case 7: { // IDIV
        const d = BigInt(src | 0);
        if (d === 0n) return this.divideError();
        const num = BigInt.asIntN(64, (BigInt(this.r32(DX)) << 32n) | BigInt(eax));
        const q = num / d;
        if (q > 0x7fffffffn || q < -0x80000000n) return this.divideError();
        this.setR32(AX, Number(BigInt.asUintN(32, q))); this.setR32(DX, Number(BigInt.asUintN(32, num % d)));
        return;
      }
    }
  }

  /** 两操作数 / 三操作数的 IMUL（结果截断到操作数大小） */
  private imulN(a: number, b: number, size: number): number {
    let res: number, fits: boolean;
    if (size === 4) {
      const p = BigInt(a | 0) * BigInt(b | 0);
      res = Number(BigInt.asUintN(32, p));
      fits = p === BigInt(res | 0);
    } else {
      const sa = (a << 16) >> 16, sb = (b << 16) >> 16;
      const p = sa * sb;
      res = p & 0xffff;
      fits = ((res << 16) >> 16) === p;
    }
    this.setF(CF, !fits); this.setF(OF, !fits);
    this.szp(res, size);
    return res;
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

  // ================= 特权检查 =================

  /** 保护模式下的特权检查：CPL 必须是 0（虚拟 8086 模式下一律 #GP） */
  private requireCpl0(): void { if (this.msw & 1 && (this.cpl !== 0 || this.flags & VM)) throw gp(0); }
  /** 开关中断等：保护模式下要求 CPL <= IOPL */
  private requireIopl(): void { if (this.msw & 1 && this.cpl > this.iopl) throw gp(0); }
  /** I/O 指令：CPL > IOPL（或虚拟 8086 模式）时查 386 TSS 里的 I/O 许可位图 */
  private ioCheck(port: number, size: number): void {
    if (!(this.msw & 1)) return;
    if (!(this.flags & VM) && this.cpl <= this.iopl) return;
    if (this.model < 2 || !this.tr.is32 || this.tr.limit < 0x67) throw gp(0);
    const mapBase = this.rwL(this.tr.base + 0x66);
    for (let p = port; p < port + size; p++) {
      const off = mapBase + (p >> 3);
      if (off > this.tr.limit || this.rbL(this.tr.base + off) & (1 << (p & 7))) throw gp(0);
    }
  }
  private inN(port: number, size: number): number {
    this.ioCheck(port, size);
    let v = 0;
    for (let k = 0; k < size; k++) v |= this.io.in8((port + k) & 0xffff) << (8 * k);
    return v >>> 0;
  }
  private outN(port: number, size: number, v: number): void {
    this.ioCheck(port, size);
    for (let k = 0; k < size; k++) this.io.out8((port + k) & 0xffff, (v >>> (8 * k)) & 0xff);
  }

  // ================= 186/286 的新指令 =================

  private exec186(op: number): void {
    const r = this.r, os = this.osz;
    switch (op) {
      case 0x60: { // PUSHA / PUSHAD
        const sp = this.getRegN(os, SP);
        for (let k = 0; k < 8; k++) this.pushN(k === SP ? sp : this.getRegN(os, k), os);
        return;
      }
      case 0x61: // POPA / POPAD（跳过 SP；386 在 16 位堆栈上 POPAD 时 ESP 的高 16 位取弹出的值）
        for (let k = 7; k >= 0; k--) {
          const v = this.popN(os);
          if (k !== SP) this.setRegN(os, k, v); else if (os === 4 && !this.stack32) this.rh[SP] = v >>> 16;
        }
        return;
      case 0x62: { // BOUND：超出范围时产生 5 号中断
        this.modrm();
        if (this.mod === 3) throw ud();
        let v: number, lo: number, hi: number;
        if (os === 4) { v = this.r32(this.reg) | 0; lo = this.rdS(this.eaSi, this.eaOff) | 0; hi = this.rdS(this.eaSi, this.eaPlus(4)) | 0; }
        else { v = (r[this.reg] << 16) >> 16; lo = (this.rwS(this.eaSi, this.eaOff) << 16) >> 16; hi = (this.rwS(this.eaSi, this.eaPlus(2)) << 16) >> 16; }
        if (v < lo || v > hi) throw new CpuFault(5);
        return;
      }
      case 0x63: { // ARPL r/m16, r16（只在保护模式下有效）
        if (!(this.msw & 1) || this.flags & VM) throw ud();
        this.modrm();
        const dst = this.getRM16(), src = r[this.reg];
        if ((dst & 3) < (src & 3)) { this.setRM16((dst & ~3) | (src & 3)); this.flags |= ZF; }
        else this.flags &= ~ZF;
        return;
      }
      case 0x68: this.pushN(this.fetchN(os), os); return;                    // PUSH 立即数
      case 0x6a: this.pushN(os === 4 ? this.fetchS8() >>> 0 : this.fetchS8() & 0xffff, os); return; // PUSH imm8（符号扩展）
      case 0x69: case 0x6b: { // IMUL r, r/m, 立即数
        this.modrm();
        const a = this.getRM(os);
        const b = op === 0x69 ? this.fetchN(os) : this.fetchS8();
        this.setReg(os, this.imulN(a, b, os));
        return;
      }
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: this.stringOp(op); return; // INS / OUTS
      default: throw ud(); // 64h~67h：286 上没有（386 是前缀）
    }
  }

  /** 0F 开头的两字节指令（286、386） */
  private exec0F(): void {
    const op2 = this.fetch8();
    const pm = (this.msw & 1) !== 0 && !(this.flags & VM);
    const is386 = this.model === 2, os = this.osz;
    switch (op2) {
      case 0x00: { // SLDT STR LLDT LTR VERR VERW：只在保护模式下有效
        if (!pm) throw ud();
        this.modrm();
        switch (this.reg) {
          case 0: if (this.mod === 3) this.setRegN(os, this.rm, this.ldtr.sel); else this.setRM16(this.ldtr.sel); return;
          case 1: if (this.mod === 3) this.setRegN(os, this.rm, this.tr.sel); else this.setRM16(this.tr.sel); return;
          case 2: this.requireCpl0(); this.loadLdt(this.getRM16()); return;
          case 3: { // LTR：GDT 里"可用"的 TSS，装入后标成"忙"
            this.requireCpl0();
            const sel = this.getRM16();
            if ((sel & 0xfffc) === 0 || sel & 4) throw gp(sel);
            const d = this.desc(sel);
            const type = d.access & 0x1f;
            if (type !== 0x01 && !(is386 && type === 0x09)) throw gp(sel);
            if (!(d.access & 0x80)) throw np(sel);
            this.wbL(d.addr + 5, d.access | 0x02);
            this.tr = { sel, base: d.base, limit: d.limit, is32: type === 0x09 };
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
          default: throw ud();
        }
      }
      case 0x01: {
        this.modrm();
        const reg = this.reg;
        if (reg === 4) { // SMSW
          if (this.mod === 3 && os === 4) this.setR32(this.rm, this.msw); else this.setRM16(this.msw & 0xffff);
          return;
        }
        if (reg === 6) { // LMSW：只改低 4 位；PE 位置 1 就进入保护模式（不能用 LMSW 退出）
          this.requireCpl0();
          const v = this.getRM16();
          const wasPm = this.msw & 1;
          this.msw = ((this.msw & ~0x0f) | (v & 0x0f) | (this.msw & 1)) >>> 0;
          if (this.msw & 1 && !wasPm) this.enterProtected();
          return;
        }
        if (this.mod === 3 || reg === 5 || reg === 7) throw ud();
        const t = reg === 0 || reg === 2 ? this.gdtr : this.idtr;
        const si = this.eaSi;
        if (reg < 2) { // SGDT / SIDT：界限 2 字节 + 基址（286：3 字节 + 一个 FFh）
          this.wwS(si, this.eaOff, t.limit);
          if (is386) this.wdS(si, this.eaPlus(2), os === 4 ? t.base : t.base & 0xffffff);
          else { this.wwS(si, this.eaPlus(2), t.base & 0xffff); this.wbS(si, this.eaPlus(4), t.base >> 16); this.wbS(si, this.eaPlus(5), 0xff); }
        } else { // LGDT / LIDT
          this.requireCpl0();
          const limit = this.rwS(si, this.eaOff);
          const base = is386 && os === 4 ? this.rdS(si, this.eaPlus(2)) : (this.rwS(si, this.eaPlus(2)) | (this.rbS(si, this.eaPlus(4)) << 16));
          t.limit = limit; t.base = base;
        }
        return;
      }
      case 0x02: case 0x03: { // LAR / LSL
        if (!pm) throw ud();
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
          const okTypes = op2 === 0x02 ? [1, 2, 3, 4, 5, 9, 11, 12] : [1, 2, 3, 9, 11];
          if (!okTypes.includes(type) || (!is386 && type > 7)) return;
        }
        if (!conforming && Math.max(this.cpl, sel & 3) > dpl) return;
        if (op2 === 0x02) {
          const b6 = is386 ? this.rbL(d.addr + 6) & 0xf0 : 0;
          this.setReg(os, os === 4 ? ((b6 << 16) | (d.access << 8)) >>> 0 : (d.access << 8) & 0xff00);
        } else this.setReg(os, d.limit);
        this.flags |= ZF;
        return;
      }
      case 0x05: if (this.model !== 1) throw ud(); this.loadAll(); return;
      case 0x06: this.requireCpl0(); this.msw &= ~8; return; // CLTS
    }
    if (!is386) throw ud(); // 其余是 386 以后的指令
    switch (op2) {
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x26: { // MOV 控制寄存器 / 调试寄存器 / 测试寄存器
        const b = this.fetch8();
        const n = (b >> 3) & 7, g = b & 7;
        this.requireCpl0();
        if (op2 === 0x20) {
          if (n === 0) this.setR32(g, this.msw); else if (n === 2) this.setR32(g, this.cr2); else if (n === 3) this.setR32(g, this.cr3); else throw ud();
        } else if (op2 === 0x22) {
          const v = this.r32(g);
          if (n === 0) this.setCr0(v); else if (n === 2) this.cr2 = v; else if (n === 3) { this.cr3 = v; this.flushTlb(); } else throw ud();
        } else if (op2 === 0x21) this.setR32(g, this.dr[n]);
        else if (op2 === 0x23) this.dr[n] = this.r32(g);
        else if (op2 === 0x24) this.setR32(g, this.trr[n]);
        else this.trr[n] = this.r32(g);
        return;
      }
      case 0x80: case 0x81: case 0x82: case 0x83: case 0x84: case 0x85: case 0x86: case 0x87:
      case 0x88: case 0x89: case 0x8a: case 0x8b: case 0x8c: case 0x8d: case 0x8e: case 0x8f: { // Jcc rel16/32
        const d = this.fetchRel(os);
        if (this.cond(op2 & 0xf)) this.jumpNear(this.ip + d);
        return;
      }
      case 0x90: case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
      case 0x98: case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: case 0x9f: // SETcc
        this.modrm(); this.setRM8(this.cond(op2 & 0xf) ? 1 : 0); return;
      case 0xa0: case 0xa8: this.pushSeg(op2 === 0xa0 ? FS : GS); return;
      case 0xa1: case 0xa9: this.popSeg(op2 === 0xa1 ? FS : GS); return;
      case 0xa3: case 0xab: case 0xb3: case 0xbb: { // BT BTS BTR BTC r/m, r
        this.modrm();
        this.bitOp((op2 >> 3) & 3, this.getReg(os), true);
        return;
      }
      case 0xba: { // BT BTS BTR BTC r/m, imm8
        this.modrm();
        if (this.reg < 4) throw ud();
        this.bitOp(this.reg & 3, this.fetch8(), false);
        return;
      }
      case 0xa4: case 0xa5: case 0xac: case 0xad: { // SHLD / SHRD
        this.modrm();
        const count = op2 & 1 ? this.r[CX] & 0xff : this.fetch8();
        const dst = this.getRM(os), src = this.getReg(os);
        const c = count & 31;
        if (c === 0) return;
        this.setRM(os, this.shiftDouble(op2 < 0xa8, dst, src, c, os));
        return;
      }
      case 0xaf: this.modrm(); this.setReg(os, this.imulN(this.getReg(os), this.getRM(os), os)); return; // IMUL r, r/m
      case 0xb2: case 0xb4: case 0xb5: { // LSS / LFS / LGS
        this.modrm();
        if (this.mod === 3) throw ud();
        const off = this.rd(this.eaSi, this.eaOff, os), sel = this.rwS(this.eaSi, this.eaPlus(os));
        const seg = op2 === 0xb2 ? SS : op2 === 0xb4 ? FS : GS;
        this.loadSeg(seg, sel);
        this.setReg(os, off);
        if (seg === SS) this.inhibitIrq = true;
        return;
      }
      case 0xb6: this.modrm(); this.setReg(os, this.getRM8()); return;                       // MOVZX r, r/m8
      case 0xb7: this.modrm(); this.setReg(os, this.getRM16()); return;                      // MOVZX r, r/m16
      case 0xbe: this.modrm(); this.setReg(os, ((this.getRM8() << 24) >> 24) >>> 0); return;  // MOVSX r, r/m8
      case 0xbf: this.modrm(); this.setReg(os, ((this.getRM16() << 16) >> 16) >>> 0); return; // MOVSX r, r/m16
      case 0xbc: case 0xbd: { // BSF / BSR
        this.modrm();
        const v = this.getRM(os);
        if (v === 0) { this.flags |= ZF; return; }
        this.flags &= ~ZF;
        let k: number;
        if (op2 === 0xbc) { k = 0; while (!((v >>> k) & 1)) k++; }
        else k = 31 - Math.clz32(v);
        this.setReg(os, k);
        return;
      }
    }
    throw ud();
  }

  /** BT/BTS/BTR/BTC：kind 0 BT 1 BTS 2 BTR 3 BTC；寄存器给出的位号可以超出操作数（内存时按位号找到对应的字） */
  private bitOp(kind: number, bit: number, fromReg: boolean): void {
    const os = this.osz, bits = os * 8;
    if (this.mod !== 3 && fromReg) {
      const signed = os === 4 ? bit | 0 : (bit << 16) >> 16;
      const delta = Math.floor(signed / bits) * os;
      this.eaOff = this.asz32 ? (this.eaOff + delta) >>> 0 : (this.eaOff + delta) & 0xffff;
    }
    const n = bit & (bits - 1);
    const v = this.getRM(os);
    const set = (v >>> n) & 1;
    this.setF(CF, set);
    if (kind === 0) return;
    const m = os === 4 ? (1 << n) >>> 0 : 1 << n;
    const nv = kind === 1 ? v | m : kind === 2 ? v & ~m : v ^ m;
    this.setRM(os, os === 4 ? nv >>> 0 : nv & 0xffff);
  }

  private pushSeg(i: number): void {
    if (this.osz === 4) { // 32 位：ESP 减 4，只写低 16 位
      const sp = this.spAdd(this.getSP(), -4);
      this.wwS(SS, sp, this.s[i]);
      this.setSP(sp);
    } else this.pushN(this.s[i], 2);
  }
  private popSeg(i: number): void {
    const sp = this.getSP();
    const v = this.rwS(SS, sp);
    this.loadSeg(i, v);
    this.setSP(this.spAdd(sp, this.osz));
    if (i === SS) this.inhibitIrq = true;
  }

  /** 写 CR0：PE 位从 0 变 1 进入保护模式，从 1 变 0 回到实模式；PG 位开关分页 */
  private setCr0(v: number): void {
    v >>>= 0;
    if (v & 0x80000000 && !(v & 1)) throw gp(0);
    const old = this.msw;
    this.msw = v;
    if (v & 1 && !(old & 1)) this.enterProtected();
    else if (!(v & 1) && old & 1) this.exitProtected();
    if ((v ^ old) & 0x80000000) this.flushTlb();
  }

  /** PE 位刚置 1：段描述符缓存保留实模式下的基址 */
  private enterProtected(): void {
    for (let i = 0; i < 6; i++) if (!(this.overrideMask & (1 << i))) this.cBase[i] = this.s[i] << 4;
    this.overrideMask = 0;
    this.cpl = 0;
  }
  /** 386 清掉 PE 回到实模式：段描述符缓存（基址、界限）保持不变，直到重新装入段寄存器 */
  private exitProtected(): void {
    this.overrideMask = 0;
    for (let i = 0; i < 6; i++) if (this.cBase[i] !== this.s[i] << 4) this.overrideMask |= 1 << i;
    this.cNull.fill(0);
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
    // op: A4 MOVS A6 CMPS AA STOS AC LODS AE SCAS 6C INS 6E OUTS（奇数是字/双字）
    const a32 = this.asz32;
    const idx = a32 ? (i: number) => this.r32(i) : (i: number) => this.r[i];
    const setIdx = a32 ? (i: number, v: number) => this.setR32(i, v) : (i: number, v: number) => { this.r[i] = v; };
    if (this.rep && idx(CX) === 0) return;
    const size = op & 1 ? this.osz : 1;
    const d = this.flags & DF ? -size : size;
    const src = this.segOvr >= 0 ? this.segOvr : DS;
    let compare = false;
    switch (op & 0xfe) {
      case 0xa4:
        this.wr(ES, idx(DI), size, this.rd(src, idx(SI), size));
        setIdx(SI, idx(SI) + d); setIdx(DI, idx(DI) + d);
        break;
      case 0xa6:
        this.alu(7, this.rd(src, idx(SI), size), this.rd(ES, idx(DI), size), size);
        setIdx(SI, idx(SI) + d); setIdx(DI, idx(DI) + d);
        compare = true;
        break;
      case 0xaa:
        this.wr(ES, idx(DI), size, this.getRegN(size, AX));
        setIdx(DI, idx(DI) + d);
        break;
      case 0xac:
        this.setRegN(size, AX, this.rd(src, idx(SI), size));
        setIdx(SI, idx(SI) + d);
        break;
      case 0x6c: // INS（186 以后）
        this.wr(ES, idx(DI), size, this.inN(this.r[DX], size));
        setIdx(DI, idx(DI) + d);
        break;
      case 0x6e: // OUTS
        this.outN(this.r[DX], size, this.rd(src, idx(SI), size));
        setIdx(SI, idx(SI) + d);
        break;
      case 0xae:
        this.alu(7, this.getRegN(size, AX), this.rd(ES, idx(DI), size), size);
        setIdx(DI, idx(DI) + d);
        compare = true;
        break;
    }
    if (this.rep) {
      const cx = a32 ? (this.r32(CX) - 1) >>> 0 : (this.r[CX] - 1) & 0xffff;
      setIdx(CX, cx);
      let more = cx !== 0;
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
      this.startIP = this.ip; this.startSP = this.r32(SP);
      const n = this.irq.ack();
      try { this.interrupt(n); } catch (e) { this.faultHandler(e); }
      this.steps++;
      return;
    }
    this.inhibitIrq = false;
    if (this.halted) return;
    const tf = this.flags & TF;
    this.startIP = this.ip;
    this.startSP = this.model === 2 ? this.r32(SP) : this.r[SP];
    this.segOvr = -1;
    this.rep = 0;
    const big = this.model === 2 && this.cBig[CS] !== 0 && (this.msw & 1) !== 0 && !(this.flags & VM);
    this.osz = big ? 4 : 2;
    this.asz32 = big;
    let lock = false;
    try {
      let op: number;
      for (;;) {
        op = this.fetch8();
        if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { this.segOvr = (op >> 3) & 3; continue; }
        if (op === 0xf2 || op === 0xf3) { this.rep = op; continue; }
        if (op === 0xf0) { if (this.model === 2) lock = true; continue; }
        if (this.model === 2 && op >= 0x64 && op <= 0x67) {
          if (op <= 0x65) this.segOvr = op - 0x60;
          else if (op === 0x66) this.osz = big ? 2 : 4;
          else this.asz32 = !big;
          continue;
        }
        if (op === TRAP_OPCODE) {
          if (this.trap && this.s[CS] === BIOS_SEG && (!(this.msw & 1) || this.flags & VM)) {
            const n = this.fetch8();
            const before = this.s.slice();
            this.inTrap = true;
            let done: boolean;
            try { done = this.trap(n); } finally { this.inTrap = false; }
            if (!done) {
              this.ip = this.startIP;
              this.waiting = true;
            } else {
              this.waiting = false;
            }
            // 陷阱处理函数直接改了段寄存器：重新算基址
            for (let i = 0; i < 6; i++) if (this.s[i] !== before[i]) { this.cBase[i] = this.s[i] << 4; this.overrideMask &= ~(1 << i); }
            this.steps++;
            return;
          }
          if (this.model === 2) { this.steps++; this.interrupt(1); return; } // 386：ICEBP（INT 1）
          continue; // 8088/286 上 F1 是 LOCK 的别名
        }
        break;
      }
      if (lock && !this.lockable(op)) throw ud();
      this.exec(op);
      this.steps++;
      if (tf && !this.repContinue) this.interrupt(1);
    } catch (e) {
      this.faultHandler(e);
      this.steps++;
    }
  }

  /**
   * 386：LOCK 前缀只能用在"读-改-写"内存的指令上（ADD、ADC、AND、BTx、DEC、INC、NEG、NOT、OR、SBB、SUB、XOR、XCHG，
   * 目标是内存），否则 #UD
   */
  private lockable(op: number): boolean {
    const peek = (k: number) => this.rl(this.segBase(CS) + this.ip + k);
    if (op === 0x0f) {
      const op2 = peek(0), m = peek(1);
      if (m >> 6 === 3) return false;
      return op2 === 0xab || op2 === 0xb3 || op2 === 0xbb || (op2 === 0xba && ((m >> 3) & 7) >= 5);
    }
    const m = peek(0), mem = m >> 6 !== 3, reg = (m >> 3) & 7;
    if (op < 0x40) return mem && (op & 7) < 2 && (op >> 3) !== 7;
    if (op >= 0x80 && op <= 0x83) return mem && reg !== 7;
    if (op === 0x86 || op === 0x87) return mem;
    if (op === 0xf6 || op === 0xf7) return mem && (reg === 2 || reg === 3);
    if (op === 0xfe || op === 0xff) return mem && reg < 2;
    return false;
  }

  /** 指令执行中出了异常：退回指令开头，交给异常处理程序 */
  private faultHandler(e: unknown): void {
    if (!(e instanceof CpuFault)) throw e;
    this.ip = this.startIP;
    if (this.model === 2) this.setR32(SP, this.startSP); else this.r[SP] = this.startSP;
    this.repContinue = false;
    this.deliverFault(e);
  }

  private exec(op: number): void {
    const r = this.r, s = this.s, os = this.osz;
    if (this.model >= 1) {
      // 286：这些操作码在 8086 上是别的指令（POP CS、条件跳转和 RET 的别名），在 186/286 上是新指令
      if (op === 0x0f) { this.exec0F(); return; }
      if (op >= 0x60 && op <= 0x6f) { this.exec186(op); return; }
      if (op === 0xc0 || op === 0xc1) { // 移位，次数是立即数
        const size = op === 0xc1 ? os : 1;
        this.modrm();
        const v = this.getRM(size);
        this.setRM(size, this.shift(this.reg, v, this.fetch8() & 0x1f, size));
        return;
      }
      if (op === 0xc8) { // ENTER 栈帧大小, 嵌套层数
        const size = this.fetch16(), level = this.fetch8() & 0x1f;
        const s32 = this.stack32;
        this.pushN(this.getRegN(os, BP), os);
        const frame = this.getSP();
        if (level > 0) {
          let bp = s32 ? this.r32(BP) : r[BP];
          for (let k = 1; k < level; k++) {
            bp = s32 ? (bp - os) >>> 0 : (bp - os) & 0xffff;
            this.pushN(this.rd(SS, bp, os), os);
          }
          this.pushN(frame, os);
        }
        this.setRegN(os, BP, frame);
        this.setSP(this.spAdd(this.getSP(), -size));
        return;
      }
      if (op === 0xc9) { // LEAVE
        const s32 = this.stack32;
        const bp = s32 ? this.r32(BP) : r[BP];
        const v = this.rd(SS, bp, os);
        this.setSP(this.spAdd(bp, os));
        this.setRegN(os, BP, v);
        return;
      }
    }
    switch (op) {
      // ---- 00-3F：算术逻辑运算 ----
      case 0x00: case 0x01: case 0x02: case 0x03: case 0x08: case 0x09: case 0x0a: case 0x0b:
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x18: case 0x19: case 0x1a: case 0x1b:
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x28: case 0x29: case 0x2a: case 0x2b:
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x38: case 0x39: case 0x3a: case 0x3b: {
        const alu = (op >> 3) & 7, size = op & 1 ? os : 1;
        this.modrm();
        if (op & 2) {
          const res = this.alu(alu, this.getReg(size), this.getRM(size), size);
          if (alu !== 7) this.setReg(size, res);
        } else {
          const res = this.alu(alu, this.getRM(size), this.getReg(size), size);
          if (alu !== 7) this.setRM(size, res);
        }
        return;
      }
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const res = this.alu((op >> 3) & 7, r[AX] & 0xff, this.fetch8(), 1);
        if (op !== 0x3c) this.setR8(0, res);
        return;
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const res = this.alu((op >> 3) & 7, this.getRegN(os, AX), this.fetchN(os), os);
        if (op !== 0x3d) this.setRegN(os, AX, res);
        return;
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: this.pushSeg((op >> 3) & 3); return;
      case 0x07: case 0x0f: case 0x17: case 0x1f: {
        if (op === 0x0f) { const v = this.rwS(SS, r[SP]); s[CS] = v; this.cBase[CS] = v << 4; r[SP] += 2; return; } // 8086 的 POP CS
        this.popSeg((op >> 3) & 3);
        return;
      }
      case 0x27: { // DAA
        if (this.model === 2) { this.daa386(false); return; }
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
        if (this.model === 2) { this.daa386(true); return; }
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
        if (this.model === 2) { // 386：加减 6 作用在整个 AX 上（AL 的进位/借位进到 AH）
          if ((r[AX] & 0xf) > 9 || this.flags & AF) {
            r[AX] = op === 0x37 ? r[AX] + 0x106 : r[AX] - 0x106;
            this.flags |= AF | CF;
          } else this.flags &= ~(AF | CF);
          r[AX] &= 0xff0f;
          this.szp8(r[AX] & 0xff);
          return;
        }
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
        this.setRegN(os, op & 7, this.inc(this.getRegN(os, op & 7), os)); return;
      case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f:
        this.setRegN(os, op & 7, this.dec(this.getRegN(os, op & 7), os)); return;
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x55: case 0x56: case 0x57:
        this.pushN(this.getRegN(os, op & 7), os); return;
      case 0x54: // 8086 的 PUSH SP 压入的是减 2 之后的值；286 起压入原来的值
        if (this.model >= 1) { this.pushN(this.getRegN(os, SP), os); return; }
        r[SP] -= 2; this.wwS(SS, r[SP], r[SP]); return;
      case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        this.setRegN(os, op & 7, this.popN(os)); return;

      // ---- 60-7F：条件跳转（60-6F 是 8086 上的别名） ----
      case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67:
      case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f:
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
        const d = this.fetchS8();
        if (this.cond(op & 0xf)) this.jumpNear(this.ip + d);
        return;
      }

      // ---- 80-83：立即数运算 ----
      case 0x80: case 0x81: case 0x82: case 0x83: {
        const size = op & 1 ? os : 1;
        this.modrm();
        const a = this.getRM(size);
        const b = op === 0x81 ? this.fetchN(os) : op === 0x83 ? (os === 4 ? this.fetchS8() >>> 0 : this.fetchS8() & 0xffff) : this.fetch8();
        const res = this.alu(this.reg, a, b, size);
        if (this.reg !== 7) this.setRM(size, res);
        return;
      }
      case 0x84: case 0x85: {
        const size = op & 1 ? os : 1;
        this.modrm();
        this.alu(4, this.getRM(size), this.getReg(size), size);
        return;
      }
      case 0x86: case 0x87: {
        const size = op & 1 ? os : 1;
        this.modrm();
        const a = this.getRM(size), b = this.getReg(size);
        this.setRM(size, b); this.setReg(size, a);
        return;
      }
      case 0x88: case 0x89: { const size = op & 1 ? os : 1; this.modrm(); this.setRM(size, this.getReg(size)); return; }
      case 0x8a: case 0x8b: { const size = op & 1 ? os : 1; this.modrm(); this.setReg(size, this.getRM(size)); return; }
      case 0x8c: { // MOV r/m, 段寄存器
        this.modrm();
        const i = this.model === 2 ? this.reg : this.reg & 3;
        if (i > 5) throw ud();
        if (this.mod === 3) this.setRegN(os, this.rm, s[i]); else this.setRM16(s[i]);
        return;
      }
      case 0x8d: { // LEA
        this.modrm();
        if (this.mod === 3 && this.model >= 1) throw ud();
        this.setReg(os, this.eaOff);
        return;
      }
      case 0x8e: {
        this.modrm();
        const i = this.model === 2 ? this.reg : this.reg & 3;
        if (i > 5 || (i === CS && this.model >= 1)) throw ud();
        const v = this.getRM16();
        if (i === CS) {
          if (this.model >= 1) throw ud();
          s[CS] = v; this.cBase[CS] = v << 4; // 8086 允许 MOV CS
        } else this.loadSeg(i, v);
        if (i === SS) this.inhibitIrq = true;
        return;
      }
      case 0x8f: { // POP r/m
        this.modrm();
        if (this.reg !== 0 && this.model === 2) throw ud();
        const sp = this.getSP();
        const v = this.rd(SS, sp, os);
        this.setSP(this.spAdd(sp, os));
        if (this.eaSP && this.mod !== 3) this.eaOff = (this.eaOff + os) >>> 0; // [ESP+n] 按弹出后的 ESP 算
        this.setRM(os, v);
        return;
      }

      // ---- 90-9F ----
      case 0x90: return;
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
        const t = this.getRegN(os, AX); this.setRegN(os, AX, this.getRegN(os, op & 7)); this.setRegN(os, op & 7, t); return;
      }
      case 0x98: // CBW / CWDE
        if (os === 4) this.setR32(AX, ((r[AX] << 16) >> 16) >>> 0); else r[AX] = (((r[AX] & 0xff) << 24) >> 24) & 0xffff;
        return;
      case 0x99: // CWD / CDQ
        if (os === 4) this.setR32(DX, this.rh[AX] & 0x8000 ? 0xffffffff : 0); else r[DX] = r[AX] & 0x8000 ? 0xffff : 0;
        return;
      case 0x9a: {
        const nip = this.fetchN(os), ncs = this.fetch16();
        this.farCall(ncs, nip, os);
        return;
      }
      case 0x9b: // WAIT：TS 和 MP 都置 1 时 #NM
        if (this.model >= 1 && (this.msw & 0x0a) === 0x0a) throw new CpuFault(7);
        return;
      case 0x9c: // PUSHF / PUSHFD
        if (this.flags & VM && this.iopl < 3) throw gp(0);
        if (os === 4) this.pushN(this.flags & ~(VM | RF), 4); else this.pushN(this.flags & 0xffff, 2);
        return;
      case 0x9d: { // POPF / POPFD
        if (this.flags & VM && this.iopl < 3) throw gp(0);
        const v = this.popN(os);
        if (this.msw & 1 && !(this.flags & VM)) this.popFlagsProtected(v, this.cpl, os);
        else if (this.flags & VM) { if (os === 4) this.setEflags(v, VM | RF | IOPL); else this.setFlags((v & ~IOPL) | (this.flags & IOPL)); }
        else if (os === 4) this.setEflags(v, VM);
        else this.setFlags(v);
        return;
      }
      case 0x9e: this.flags = (this.flags & ~0xff) | ((r[AX] >> 8) & 0xd5) | 2; return;
      case 0x9f: this.setR8(4, this.flags & 0xff); return;

      // ---- A0-AF ----
      case 0xa0: case 0xa1: case 0xa2: case 0xa3: { // MOV AL/AX, [偏移] 等
        const o = this.asz32 ? this.fetch32() : this.fetch16();
        const seg = this.segOvr >= 0 ? this.segOvr : DS, size = op & 1 ? os : 1;
        if (op < 0xa2) this.setRegN(size, AX, this.rd(seg, o, size)); else this.wr(seg, o, size, this.getRegN(size, AX));
        return;
      }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        this.stringOp(op); return;
      case 0xa8: this.alu(4, r[AX] & 0xff, this.fetch8(), 1); return;
      case 0xa9: this.alu(4, this.getRegN(os, AX), this.fetchN(os), os); return;

      // ---- B0-BF：MOV 寄存器, 立即数 ----
      case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        this.setR8(op & 7, this.fetch8()); return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        this.setRegN(os, op & 7, this.fetchN(os)); return;

      // ---- C0-CF ----
      case 0xc0: case 0xc2: { // RET n（C0 是 8086 上的别名）
        const n = this.fetch16();
        const sp = this.getSP();
        const nip = this.rd(SS, sp, os);
        this.jumpNear(nip);
        this.setSP(this.spAdd(sp, os + n));
        return;
      }
      case 0xc1: case 0xc3: {
        const sp = this.getSP();
        const nip = this.rd(SS, sp, os);
        this.jumpNear(nip);
        this.setSP(this.spAdd(sp, os));
        return;
      }
      case 0xc4: case 0xc5: {
        this.modrm();
        if (this.mod === 3 && this.model >= 1) throw ud();
        const off = this.rd(this.eaSi, this.eaOff, os), sel = this.rwS(this.eaSi, this.eaPlus(os));
        this.loadSeg(op === 0xc4 ? ES : DS, sel);
        this.setReg(os, off);
        return;
      }
      case 0xc6: this.modrm(); if (this.reg && this.model === 2) throw ud(); this.setRM8(this.fetch8()); return;
      case 0xc7: this.modrm(); if (this.reg && this.model === 2) throw ud(); this.setRM(os, this.fetchN(os)); return;
      case 0xc8: case 0xca: { const n = this.fetch16(); this.farReturn(n, os); return; }
      case 0xc9: case 0xcb: this.farReturn(0, os); return;
      case 0xcc: this.interrupt(3, -1, true); return;
      case 0xcd: { const n = this.fetch8(); this.interrupt(n, -1, true); return; }
      case 0xce: if (this.flags & OF) this.interrupt(4, -1, true); return;
      case 0xcf: this.iret(os); return;

      // ---- D0-DF ----
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const size = op & 1 ? os : 1;
        this.modrm();
        const count = op & 2 ? r[CX] & (this.model >= 1 ? 0x1f : 0xff) : 1;
        this.setRM(size, this.shift(this.reg, this.getRM(size), count, size));
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
        const res = this.alu(0, al, (ah * base) & 0xff, 1);
        r[AX] = res;
        return;
      }
      case 0xd6: this.setR8(0, this.flags & CF ? 0xff : 0); return; // SALC（未公开）
      case 0xd7: { // XLAT
        const seg = this.segOvr >= 0 ? this.segOvr : DS;
        const off = this.asz32 ? (this.r32(BX) + (r[AX] & 0xff)) >>> 0 : (r[BX] + (r[AX] & 0xff)) & 0xffff;
        this.setR8(0, this.rbS(seg, off));
        return;
      }
      case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
        // ESC（协处理器指令）：没有协处理器。EM 或 TS 置 1 时 #NM（让操作系统去模拟），否则忽略
        if (this.model >= 1 && this.msw & 0x0c) throw new CpuFault(7);
        this.modrm(); return;

      // ---- E0-EF ----
      case 0xe0: case 0xe1: case 0xe2: { // LOOPNZ / LOOPZ / LOOP（计数器按地址大小是 CX 或 ECX）
        const d = this.fetchS8();
        let cx: number;
        if (this.asz32) { cx = (this.r32(CX) - 1) >>> 0; this.setR32(CX, cx); } else { cx = (r[CX] - 1) & 0xffff; r[CX] = cx; }
        const zf = (this.flags & ZF) !== 0;
        if (cx !== 0 && (op === 0xe2 || (op === 0xe1 ? zf : !zf))) this.jumpNear(this.ip + d);
        return;
      }
      case 0xe3: { const d = this.fetchS8(); if ((this.asz32 ? this.r32(CX) : r[CX]) === 0) this.jumpNear(this.ip + d); return; }
      case 0xe4: { const p = this.fetch8(); this.setR8(0, this.inN(p, 1)); return; }
      case 0xe5: { const p = this.fetch8(); this.setRegN(os, AX, this.inN(p, os)); return; }
      case 0xe6: { const p = this.fetch8(); this.outN(p, 1, r[AX] & 0xff); return; }
      case 0xe7: { const p = this.fetch8(); this.outN(p, os, this.getRegN(os, AX)); return; }
      case 0xe8: { // CALL 近
        const d = this.fetchRel(os);
        const ret = this.ip;
        const nip = this.model === 2 ? (os === 4 ? (ret + d) >>> 0 : (ret + d) & 0xffff) : (ret + d) & 0xffff;
        if (this.model === 2 && nip > this.cLimit[CS]) throw gp(0);
        this.pushN(ret, os);
        this.ip = nip;
        return;
      }
      case 0xe9: { const d = this.fetchRel(os); this.jumpNear(this.ip + d); return; }
      case 0xea: { const nip = this.fetchN(os); const ncs = this.fetch16(); this.farJump(ncs, nip); return; }
      case 0xeb: { const d = this.fetchS8(); this.jumpNear(this.ip + d); return; }
      case 0xec: this.setR8(0, this.inN(r[DX], 1)); return;
      case 0xed: this.setRegN(os, AX, this.inN(r[DX], os)); return;
      case 0xee: this.outN(r[DX], 1, r[AX] & 0xff); return;
      case 0xef: this.outN(r[DX], os, this.getRegN(os, AX)); return;

      // ---- F0-FF ----
      case 0xf4: this.requireCpl0(); this.halted = true; return;
      case 0xf5: this.flags ^= CF; return;
      case 0xf6: case 0xf7: {
        const size = op & 1 ? os : 1;
        this.modrm();
        switch (this.reg) {
          case 0: case 1: {
            const v = this.getRM(size);
            this.alu(4, v, this.fetchN(size), size);
            return;
          }
          case 2: { const v = ~this.getRM(size); this.setRM(size, size === 4 ? v >>> 0 : v & MASK[size]); return; }
          case 3: this.setRM(size, this.alu(5, 0, this.getRM(size), size)); return;
          default: this.mulDiv(this.reg, size); return;
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
        if (this.reg === 0) this.setRM8(this.inc(this.getRM8(), 1));
        else if (this.reg === 1) this.setRM8(this.dec(this.getRM8(), 1));
        else if (this.model >= 1) throw ud();
        return;
      }
      case 0xff: {
        this.modrm();
        switch (this.reg) {
          case 0: this.setRM(os, this.inc(this.getRM(os), os)); return;
          case 1: this.setRM(os, this.dec(this.getRM(os), os)); return;
          case 2: { // CALL 近（间接）
            const t = this.getRM(os);
            const nip = this.model === 2 ? (os === 4 ? t >>> 0 : t & 0xffff) : t;
            if (this.model === 2 && nip > this.cLimit[CS]) throw gp(0);
            this.pushN(this.ip, os);
            this.ip = nip;
            return;
          }
          case 3: {
            if (this.mod === 3 && this.model >= 1) throw ud();
            const nip = this.rd(this.eaSi, this.eaOff, os), ncs = this.rwS(this.eaSi, this.eaPlus(os));
            this.farCall(ncs, nip, os);
            return;
          }
          case 4: this.jumpNear(this.getRM(os)); return;
          case 5: {
            if (this.mod === 3 && this.model >= 1) throw ud();
            const nip = this.rd(this.eaSi, this.eaOff, os), ncs = this.rwS(this.eaSi, this.eaPlus(os));
            this.farJump(ncs, nip);
            return;
          }
          case 6: // PUSH r/m（8086 的 PUSH SP 压入减 2 之后的值）
            if (this.model === 0 && this.mod === 3 && this.rm === SP) { r[SP] -= 2; this.wwS(SS, r[SP], r[SP]); return; }
            this.pushN(this.getRM(os), os);
            return;
          default: { // /7：8086 上是 PUSH 的别名
            if (this.model >= 1) throw ud();
            if (this.mod === 3 && this.rm === SP) { r[SP] -= 2; this.wwS(SS, r[SP], r[SP]); return; }
            this.push(this.getRM16());
            return;
          }
        }
      }
    }
  }
}
