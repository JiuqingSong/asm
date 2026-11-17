// 8086/8088 CPU 模拟器核心（实模式，按指令解释执行）
//
// 设计要点：
// - 内存是 1MB 的 Uint8Array，地址 = (段 << 4) + 偏移，超过 1MB 回绕。
// - 每次 step() 执行一条完整指令（含前缀）。REP 串指令每次只执行一次迭代，
//   未完成时把 IP 退回指令开头并置 repContinue，与真实 8086 的可中断行为一致。
// - BIOS/DOS 功能用"陷阱"实现：中断向量指向 F000 段里的小桩代码
//   `F1 nn CF`（陷阱 + 中断号 + IRET），CPU 执行到陷阱时回调 JS。
//   这样用户程序可以像真机一样读取、替换、串接中断向量。
// - 端口读写通过 IOBus 分发，硬件中断通过 IrqSource 注入。

export const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3;

export const CF = 0x0001, PF = 0x0004, AF = 0x0010, ZF = 0x0040, SF = 0x0080;
export const TF = 0x0100, IF = 0x0200, DF = 0x0400, OF = 0x0800;

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

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, p = 0;
  while (b) { p ^= b & 1; b >>= 1; }
  PARITY[i] = p ? 0 : PF;
}

export const TRAP_OPCODE = 0xf1;
export const BIOS_SEG = 0xf000;

const nullBus: IOBus = { in8: () => 0xff, out8: () => {} };

export class CPU {
  mem: Uint8Array;
  /** 通用寄存器：AX CX DX BX SP BP SI DI（与 ModR/M 编码顺序一致） */
  r = new Uint16Array(8);
  /** 段寄存器：ES CS SS DS */
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
   * 在 80286 及以后的 CPU 上有区别的几处行为（只影响实模式下这几条指令，不增加新指令）：
   * PUSH SP 压入减 2 之前的值；移位次数只取低 5 位。
   */
  is286 = false;
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

  // ---- 译码临时状态 ----
  private segOvr = -1;
  private rep = 0;
  private mod = 0;
  private reg = 0;
  private rm = 0;
  private eaSeg = 0;
  private eaOff = 0;
  private inhibitIrq = false;
  private startIP = 0;

  constructor(mem?: Uint8Array) {
    this.mem = mem ?? new Uint8Array(0x100000);
  }

  // ================= 内存访问 =================

  rb(seg: number, off: number): number {
    const a = ((seg << 4) + (off & 0xffff)) & 0xfffff;
    if (this.mmio !== null && (a & 0xf0000) === 0xa0000) return this.mmio.read(a & 0xffff);
    return this.mem[a];
  }
  rw(seg: number, off: number): number {
    return this.rb(seg, off) | (this.rb(seg, off + 1) << 8);
  }
  wb(seg: number, off: number, v: number): void {
    const a = ((seg << 4) + (off & 0xffff)) & 0xfffff;
    if (this.mmio !== null && (a & 0xf0000) === 0xa0000) { this.mmio.write(a & 0xffff, v & 0xff); return; }
    if (this.onWrite) this.onWrite(a, this.mem[a]);
    this.mem[a] = v & 0xff;
  }
  ww(seg: number, off: number, v: number): void {
    this.wb(seg, off, v);
    this.wb(seg, off + 1, v >> 8);
  }

  private fetch8(): number {
    const v = this.rb(this.s[CS], this.ip);
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
    // 8086：位 12-15 恒为 1，位 1 恒为 1，位 3、5 恒为 0
    this.flags = (v & 0x0fd5) | 0xf002;
  }
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
    this.r[SP] -= 2;
    this.ww(this.s[SS], this.r[SP], v);
  }
  pop(): number {
    const v = this.rw(this.s[SS], this.r[SP]);
    this.r[SP] += 2;
    return v;
  }

  // ================= 中断 =================

  /** 进入中断：压入 FLAGS、CS、IP，清 IF/TF，从中断向量表取新的 CS:IP */
  interrupt(n: number): void {
    this.interrupts++;
    this.push(this.flags);
    this.flags &= ~(IF | TF);
    this.push(this.s[CS]);
    this.push(this.ip);
    this.ip = this.rw(0, n * 4);
    this.s[CS] = this.rw(0, n * 4 + 2);
    this.halted = false;
  }

  /** 修改中断栈帧中保存的 FLAGS（陷阱处理函数通过它返回 CF/ZF 等状态） */
  setStackedFlag(mask: number, on: boolean): void {
    const off = (this.r[SP] + 4) & 0xffff;
    let f = this.rw(this.s[SS], off);
    f = on ? f | mask : f & ~mask;
    this.ww(this.s[SS], off, f);
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
    this.eaSeg = this.s[this.segOvr >= 0 ? this.segOvr : seg];
  }

  private getRM8(): number {
    return this.mod === 3 ? this.getR8(this.rm) : this.rb(this.eaSeg, this.eaOff);
  }
  private setRM8(v: number): void {
    if (this.mod === 3) this.setR8(this.rm, v); else this.wb(this.eaSeg, this.eaOff, v);
  }
  private getRM16(): number {
    return this.mod === 3 ? this.r[this.rm] : this.rw(this.eaSeg, this.eaOff);
  }
  private setRM16(v: number): void {
    if (this.mod === 3) this.r[this.rm] = v; else this.ww(this.eaSeg, this.eaOff, v);
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

  // ================= 串操作 =================

  private stringOp(op: number): void {
    // op: A4 MOVSB A5 MOVSW A6 CMPSB A7 CMPSW AA STOSB AB STOSW AC LODSB AD LODSW AE SCASB AF SCASW
    const r = this.r;
    if (this.rep && r[CX] === 0) return;
    const w = (op & 1) === 1;
    const d = this.flags & DF ? (w ? -2 : -1) : (w ? 2 : 1);
    const srcSeg = this.s[this.segOvr >= 0 ? this.segOvr : DS];
    const es = this.s[ES];
    let compare = false;
    switch (op & 0xfe) {
      case 0xa4:
        if (w) this.ww(es, r[DI], this.rw(srcSeg, r[SI])); else this.wb(es, r[DI], this.rb(srcSeg, r[SI]));
        r[SI] += d; r[DI] += d;
        break;
      case 0xa6:
        if (w) this.alu(7, this.rw(srcSeg, r[SI]), this.rw(es, r[DI]), true);
        else this.alu(7, this.rb(srcSeg, r[SI]), this.rb(es, r[DI]), false);
        r[SI] += d; r[DI] += d;
        compare = true;
        break;
      case 0xaa:
        if (w) this.ww(es, r[DI], r[AX]); else this.wb(es, r[DI], r[AX]);
        r[DI] += d;
        break;
      case 0xac:
        if (w) r[AX] = this.rw(srcSeg, r[SI]); else this.setR8(0, this.rb(srcSeg, r[SI]));
        r[SI] += d;
        break;
      case 0xae:
        if (w) this.alu(7, r[AX], this.rw(es, r[DI]), true);
        else this.alu(7, r[AX] & 0xff, this.rb(es, r[DI]), false);
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
      this.interrupt(this.irq.ack());
      this.steps++;
      return;
    }
    this.inhibitIrq = false;
    if (this.halted) return;
    const tf = this.flags & TF;
    this.startIP = this.ip;
    this.segOvr = -1;
    this.rep = 0;
    let op: number;
    for (;;) {
      op = this.fetch8();
      if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { this.segOvr = (op >> 3) & 3; continue; }
      if (op === 0xf2 || op === 0xf3) { this.rep = op; continue; }
      if (op === 0xf0) continue;
      if (op === TRAP_OPCODE) {
        if (this.trap && this.s[CS] === BIOS_SEG) {
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
  }

  private exec(op: number): void {
    const r = this.r, s = this.s;
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
      case 0x07: case 0x0f: case 0x17: case 0x1f:
        s[(op >> 3) & 3] = this.pop();
        if (op === 0x17) this.inhibitIrq = true;
        return;
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
        if (this.is286) { this.push(r[SP]); return; }
        r[SP] -= 2; this.ww(s[SS], r[SP], r[SP]); return;
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
        s[this.reg & 3] = this.getRM16();
        if ((this.reg & 3) === SS) this.inhibitIrq = true;
        return;
      }
      case 0x8f: { this.modrm(); const v = this.pop(); this.setRM16(v); return; }

      // ---- 90-9F ----
      case 0x90: return;
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
        const t = r[AX]; r[AX] = r[op & 7]; r[op & 7] = t; return;
      }
      case 0x98: r[AX] = (((r[AX] & 0xff) << 24) >> 24) & 0xffff; return;
      case 0x99: r[DX] = r[AX] & 0x8000 ? 0xffff : 0; return;
      case 0x9a: {
        const nip = this.fetch16(), ncs = this.fetch16();
        this.push(s[CS]); this.push(this.ip);
        s[CS] = ncs; this.ip = nip;
        return;
      }
      case 0x9b: return; // WAIT
      case 0x9c: this.push(this.flags); return;
      case 0x9d: this.setFlags(this.pop()); return;
      case 0x9e: this.flags = (this.flags & 0xff00) | (((r[AX] >> 8) & 0xd5) | 2); return;
      case 0x9f: this.setR8(4, this.flags & 0xff); return;

      // ---- A0-AF ----
      case 0xa0: { const o = this.fetch16(); this.setR8(0, this.rb(this.s[this.segOvr >= 0 ? this.segOvr : DS], o)); return; }
      case 0xa1: { const o = this.fetch16(); r[AX] = this.rw(this.s[this.segOvr >= 0 ? this.segOvr : DS], o); return; }
      case 0xa2: { const o = this.fetch16(); this.wb(this.s[this.segOvr >= 0 ? this.segOvr : DS], o, r[AX]); return; }
      case 0xa3: { const o = this.fetch16(); this.ww(this.s[this.segOvr >= 0 ? this.segOvr : DS], o, r[AX]); return; }
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
        r[this.reg] = this.rw(this.eaSeg, this.eaOff);
        s[op === 0xc4 ? ES : DS] = this.rw(this.eaSeg, this.eaOff + 2);
        return;
      }
      case 0xc6: this.modrm(); this.setRM8(this.fetch8()); return;
      case 0xc7: this.modrm(); this.setRM16(this.fetch16()); return;
      case 0xc8: case 0xca: {
        const n = this.fetch16();
        this.ip = this.pop(); s[CS] = this.pop(); r[SP] += n;
        return;
      }
      case 0xc9: case 0xcb: this.ip = this.pop(); s[CS] = this.pop(); return;
      case 0xcc: this.interrupt(3); return;
      case 0xcd: this.interrupt(this.fetch8()); return;
      case 0xce: if (this.flags & OF) this.interrupt(4); return;
      case 0xcf:
        this.ip = this.pop(); s[CS] = this.pop(); this.setFlags(this.pop());
        return;

      // ---- D0-DF ----
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const w = (op & 1) === 1;
        this.modrm();
        const count = op & 2 ? r[CX] & (this.is286 ? 0x1f : 0xff) : 1;
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
      case 0xd7: this.setR8(0, this.rb(s[this.segOvr >= 0 ? this.segOvr : DS], r[BX] + (r[AX] & 0xff))); return;
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
      case 0xe4: this.setR8(0, this.io.in8(this.fetch8())); return;
      case 0xe5: { const p = this.fetch8(); r[AX] = this.io.in8(p) | (this.io.in8((p + 1) & 0xffff) << 8); return; }
      case 0xe6: this.io.out8(this.fetch8(), r[AX] & 0xff); return;
      case 0xe7: { const p = this.fetch8(); this.io.out8(p, r[AX] & 0xff); this.io.out8((p + 1) & 0xffff, r[AX] >> 8); return; }
      case 0xe8: { const d = this.fetch16(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fetch16(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const nip = this.fetch16(); s[CS] = this.fetch16(); this.ip = nip; return; }
      case 0xeb: { const d = this.fetchS8(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xec: this.setR8(0, this.io.in8(r[DX])); return;
      case 0xed: r[AX] = this.io.in8(r[DX]) | (this.io.in8((r[DX] + 1) & 0xffff) << 8); return;
      case 0xee: this.io.out8(r[DX], r[AX] & 0xff); return;
      case 0xef: this.io.out8(r[DX], r[AX] & 0xff); this.io.out8((r[DX] + 1) & 0xffff, r[AX] >> 8); return;

      // ---- F0-FF ----
      case 0xf4: this.halted = true; return;
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
      case 0xfa: this.flags &= ~IF; return;
      case 0xfb: this.flags |= IF; this.inhibitIrq = true; return;
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
            const nip = this.rw(this.eaSeg, this.eaOff), ncs = this.rw(this.eaSeg, this.eaOff + 2);
            this.push(s[CS]); this.push(this.ip);
            s[CS] = ncs; this.ip = nip;
            return;
          }
          case 4: this.ip = this.getRM16(); return;
          case 5: {
            const nip = this.rw(this.eaSeg, this.eaOff);
            s[CS] = this.rw(this.eaSeg, this.eaOff + 2);
            this.ip = nip;
            return;
          }
          default: { // PUSH r/m16（/7 是别名）
            if (this.mod === 3 && this.rm === SP && !this.is286) { r[SP] -= 2; this.ww(s[SS], r[SP], r[SP]); return; }
            this.push(this.getRM16());
            return;
          }
        }
      }
    }
  }
}
