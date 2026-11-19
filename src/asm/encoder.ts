// 8086 指令编码：操作数（表达式求值结果）-> 机器码字节。写了 .186 / .286 / .286P 时还可以用 80186、80286 的指令
// （编码和 MASM 6.11 逐字节一致：tests/ml/i286.asm）
import { AsmError } from './lexer.ts';
import { T_FAR, T_NEAR, type Frame, type Segment, type Sym } from './types.ts';

export const R_BX = 3, R_BP = 5, R_SI = 6, R_DI = 7;
export const S_ES = 0, S_CS = 1, S_SS = 2, S_DS = 3;
const SEG_PREFIX = [0x26, 0x2e, 0x36, 0x3e];
const SREG_NAMES = ['ES', 'CS', 'SS', 'DS'];

/** 表达式求值结果 */
export interface Val {
  n: number;
  /** 可重定位：n 是相对于该帧的偏移 */
  frame: Frame | null;
  seg: Segment | null;
  sym: Sym | null;
  isMem: boolean;
  base: number;      // -1 / BX / BP
  index: number;     // -1 / SI / DI
  /** 寄存器操作数：8 / 16 / 1(段寄存器)，0 表示不是寄存器 */
  regType: number;
  reg: number;
  segOvr: number;    // 段超越 -1 / ES CS SS DS
  type: number;      // 大小或 NEAR/FAR，0 未知
  /** 值是某个帧的段地址（SEG x / @data / 段名） */
  frameImm: Frame | null;
  unknown: boolean;
  dist: '' | 'short' | 'near' | 'far';
  isTypeKw: boolean;
  /** 显式写了 PTR */
  ptr: boolean;
}

export function newVal(n = 0): Val {
  return {
    n, frame: null, seg: null, sym: null, isMem: false, base: -1, index: -1,
    regType: 0, reg: 0, segOvr: -1, type: 0, frameImm: null, unknown: false, dist: '', isTypeKw: false, ptr: false,
  };
}

export interface EncCtx {
  /** 当前指令在帧内的起始偏移 */
  pc: number;
  curFrame: Frame;
  loadSeg: number;
  /** ASSUME 表：段寄存器 -> 帧 */
  assume: (Frame | null)[];
  procType: number;
  /** 本条语句的跳转是否已被放大（跨遍保持） */
  isLong: boolean;
  setLong(): void;
  warn(msg: string): void;
  /** .186 / .286 / .286P 打开的指令集：0 = 8086，1 = 80186，2 = 80286，3 = 80286 特权指令 */
  cpu: number;
  /** 记下用到了哪一级的指令 */
  useCpu(level: number): void;
}

/** 80186 新增的指令（PUSH 立即数、三操作数 IMUL、立即数次数的移位在各自的指令里处理） */
const I186 = new Set(['pusha', 'popa', 'enter', 'leave', 'bound', 'ins', 'insb', 'insw', 'outs', 'outsb', 'outsw']);
/** 80286 新增的指令：.286 可用的，和只有 .286P 才能用的特权指令（与 MASM 6.11 的划分相同） */
const I286 = new Set(['arpl', 'lar', 'lsl', 'verr', 'verw', 'smsw', 'str', 'sldt', 'sgdt', 'sidt']);
const I286P = new Set(['clts', 'lmsw', 'lgdt', 'lidt', 'lldt', 'ltr']);
/** 0F 00 /n 和 0F 01 /n 两组 */
const GRP0F00: Record<string, number> = { sldt: 0, str: 1, lldt: 2, ltr: 3, verr: 4, verw: 5 };
const GRP0F01: Record<string, number> = { sgdt: 0, sidt: 1, lgdt: 2, lidt: 3, smsw: 4, lmsw: 6 };
/** 80186/80286 指令要哪一级（0 = 不是这些指令）：写了对应的 CPU 伪指令后它们是指令，否则还可以当符号名 */
export function cpuLevelOf(m: string): number { return I186.has(m) ? 1 : I286.has(m) ? 2 : I286P.has(m) ? 3 : 0; }
const CPU_NAME = ['8086', '80186', '80286', '80286 的特权指令'];
const CPU_DIR = ['', '.186（或 .286）', '.286', '.286P'];

type Op =
  | { k: 'reg'; w: boolean; reg: number }
  | { k: 'sreg'; reg: number }
  | { k: 'imm'; v: number; reloc: boolean; unknown: boolean; frameImm: boolean }
  | { k: 'mem'; base: number; index: number; disp: number; reloc: boolean; unknown: boolean; size: number; segOvr: number; frame: Frame | null; seg: Segment | null; sym: Sym | null; ptr: boolean }
  | { k: 'target'; v: Val };

const ALU: Record<string, number> = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 };
const SHIFT: Record<string, number> = { rol: 0, ror: 1, rcl: 2, rcr: 3, shl: 4, sal: 4, shr: 5, sar: 7 };
const UNARY: Record<string, number> = { not: 2, neg: 3, mul: 4, imul: 5, div: 6, idiv: 7 };
const JCC: Record<string, number> = {
  jo: 0x70, jno: 0x71, jb: 0x72, jc: 0x72, jnae: 0x72, jnb: 0x73, jae: 0x73, jnc: 0x73,
  je: 0x74, jz: 0x74, jne: 0x75, jnz: 0x75, jbe: 0x76, jna: 0x76, ja: 0x77, jnbe: 0x77,
  js: 0x78, jns: 0x79, jp: 0x7a, jpe: 0x7a, jnp: 0x7b, jpo: 0x7b, jl: 0x7c, jnge: 0x7c,
  jge: 0x7d, jnl: 0x7d, jle: 0x7e, jng: 0x7e, jg: 0x7f, jnle: 0x7f,
};
const LOOPS: Record<string, number> = { loopne: 0xe0, loopnz: 0xe0, loope: 0xe1, loopz: 0xe1, loop: 0xe2, jcxz: 0xe3 };
const SIMPLE: Record<string, number[]> = {
  aaa: [0x37], aas: [0x3f], daa: [0x27], das: [0x2f], cbw: [0x98], cwd: [0x99],
  clc: [0xf8], cld: [0xfc], cli: [0xfa], cmc: [0xf5], stc: [0xf9], std: [0xfd], sti: [0xfb],
  hlt: [0xf4], lahf: [0x9f], sahf: [0x9e], nop: [0x90], pushf: [0x9c], popf: [0x9d],
  wait: [0x9b], fwait: [0x9b], into: [0xce], iret: [0xcf], xlatb: [0xd7],
  movsb: [0xa4], movsw: [0xa5], cmpsb: [0xa6], cmpsw: [0xa7], stosb: [0xaa], stosw: [0xab],
  lodsb: [0xac], lodsw: [0xad], scasb: [0xae], scasw: [0xaf],
};
const STRING_OPS: Record<string, number> = { movs: 0xa4, cmps: 0xa6, stos: 0xaa, lods: 0xac, scas: 0xae };
const NOT_8086 = new Set([
  'pusha', 'popa', 'enter', 'leave', 'bound', 'ins', 'insb', 'insw', 'outs', 'outsb', 'outsw',
  'pushad', 'popad', 'movsx', 'movzx', 'bsf', 'bsr', 'bt', 'btc', 'btr', 'bts', 'cdq', 'cwde',
  'jecxz', 'lfs', 'lgs', 'lss', 'shld', 'shrd', 'setz', 'sete', 'setnz', 'setne', 'bswap',
  'cmpxchg', 'xadd', 'invd', 'wbinvd', 'arpl', 'clts', 'lar', 'lsl', 'lgdt', 'lidt', 'lldt',
  'lmsw', 'ltr', 'sgdt', 'sidt', 'sldt', 'smsw', 'str', 'verr', 'verw', 'iretd', 'pushfd', 'popfd',
  'insd', 'outsd', 'movsd', 'cmpsd', 'stosd', 'lodsd', 'scasd',
]);

export const PREFIXES: Record<string, number> = { rep: 0xf3, repe: 0xf3, repz: 0xf3, repne: 0xf2, repnz: 0xf2, lock: 0xf0 };

/** 8086 指令助记符（保留字，不能作为符号名） */
export function isCoreMnemonic(m: string): boolean {
  return m in ALU || m in SHIFT || m in UNARY || m in JCC || m in LOOPS || m in SIMPLE || m in STRING_OPS || INSTR.has(m);
}
/** 包括非 8086 指令（用于给出"不是 8086 指令"的提示；这些名字仍可作为变量名） */
export function isMnemonic(m: string): boolean {
  return isCoreMnemonic(m) || NOT_8086.has(m);
}
const INSTR = new Set(['mov', 'xchg', 'test', 'inc', 'dec', 'push', 'pop', 'lea', 'lds', 'les', 'jmp', 'call', 'ret',
  'int', 'in', 'out', 'aam', 'aad', 'xlat', 'esc', 'retn', 'retf']);

function err(msg: string): never { throw new AsmError(msg); }

function fitsS8(v: number): boolean { return v >= -128 && v <= 127; }
/** 16 位立即数能否用符号扩展的 8 位表示 */
function fitsS8w(v: number): boolean {
  const x = v & 0xffff;
  return x <= 0x7f || x >= 0xff80;
}

function typeName(size: number): string {
  return size === 1 ? 'BYTE' : size === 2 ? 'WORD' : size === 4 ? 'DWORD' : size === 6 ? 'FWORD' : size === 8 ? 'QWORD' : size === 10 ? 'TBYTE' : size === T_NEAR ? 'NEAR' : size === T_FAR ? 'FAR' : String(size);
}

export class Encoder {
  ctx!: EncCtx;

  encode(ctx: EncCtx, mn: string, vals: Val[], prefixes: number[]): number[] {
    this.ctx = ctx;
    const out = this.encodeInner(mn, vals);
    return [...prefixes, ...out];
  }

  private classify(v: Val, jumpCtx = false): Op {
    if (v.isTypeKw) err('这里需要操作数，不能只写类型名');
    if (v.regType === 8 || v.regType === 16) {
      if (v.segOvr >= 0) err('寄存器前面不能加段超越');
      return { k: 'reg', w: v.regType === 16, reg: v.reg };
    }
    if (v.regType === 1) return { k: 'sreg', reg: v.reg };
    if (v.isMem || v.base >= 0 || v.index >= 0) {
      return {
        k: 'mem', base: v.base, index: v.index, disp: v.n, reloc: v.frame !== null, unknown: v.unknown,
        size: v.type, segOvr: v.segOvr, frame: v.frame, seg: v.seg, sym: v.sym, ptr: v.ptr,
      };
    }
    if (jumpCtx) return { k: 'target', v };
    // 代码标号作为数据操作数时，与 MASM 一致：取它的偏移地址（等同于 OFFSET 标号）
    if (v.segOvr >= 0 && !v.frame) {
      // es:1234h —— 直接地址
      return { k: 'mem', base: -1, index: -1, disp: v.n, reloc: false, unknown: v.unknown, size: v.type, segOvr: v.segOvr, frame: null, seg: null, sym: null, ptr: v.ptr };
    }
    let n = v.n;
    if (v.frameImm) n = this.ctx.loadSeg + v.frameImm.para;
    return { k: 'imm', v: n, reloc: v.frame !== null || v.frameImm !== null, unknown: v.unknown, frameImm: v.frameImm !== null };
  }

  /** 生成 ModR/M（以及段超越前缀和位移） */
  private modrm(regField: number, op: Op): { prefix: number[]; bytes: number[] } {
    if (op.k === 'reg') return { prefix: [], bytes: [0xc0 | (regField << 3) | op.reg] };
    if (op.k !== 'mem') err('内部错误：需要内存操作数');
    const { base, index } = op;
    let rm: number;
    if (base === R_BX && index === R_SI) rm = 0;
    else if (base === R_BX && index === R_DI) rm = 1;
    else if (base === R_BP && index === R_SI) rm = 2;
    else if (base === R_BP && index === R_DI) rm = 3;
    else if (base < 0 && index === R_SI) rm = 4;
    else if (base < 0 && index === R_DI) rm = 5;
    else if (base === R_BP && index < 0) rm = 6;
    else if (base === R_BX && index < 0) rm = 7;
    else rm = -1;
    const disp = op.disp & 0xffff;
    const bytes: number[] = [];
    if (rm < 0) {
      bytes.push((regField << 3) | 6, disp & 0xff, disp >> 8);
    } else {
      const sd = disp >= 0x8000 ? disp - 0x10000 : disp;
      if (disp === 0 && rm !== 6 && !op.reloc && !op.unknown) bytes.push((regField << 3) | rm);
      else if (fitsS8(sd) && !op.reloc && !op.unknown) bytes.push(0x40 | (regField << 3) | rm, sd & 0xff);
      else bytes.push(0x80 | (regField << 3) | rm, disp & 0xff, disp >> 8);
    }
    return { prefix: this.segPrefix(op), bytes };
  }

  private segPrefix(op: Op & { k: 'mem' }): number[] {
    const def = op.base === R_BP ? S_SS : S_DS;
    if (op.segOvr >= 0) return op.segOvr === def && !op.frame ? [] : [SEG_PREFIX[op.segOvr]];
    if (op.frame) {
      const a = this.ctx.assume;
      const match = (f: Frame | null) => f !== null && (f === op.frame || f === op.seg);
      if (match(a[def])) return [];
      for (const sr of [S_DS, S_SS, S_ES, S_CS]) if (match(a[sr])) return [SEG_PREFIX[sr]];
      if (!op.unknown) {
        err(`无法通过段寄存器访问 ${op.sym?.name ?? op.frame.name}：没有用 ASSUME 把任何段寄存器关联到 ${op.frame.name}`);
      }
    }
    return [];
  }

  private memSize(op: Op, other?: Op): number {
    if (op.k !== 'mem') return 0;
    if (op.size === 1 || op.size === 2) return op.size;
    if (op.size !== 0 && op.size !== T_NEAR && op.size !== T_FAR) {
      if (other?.k === 'reg') err(`操作数大小不匹配：内存操作数是 ${typeName(op.size)}，寄存器是 ${other.w ? 'WORD' : 'BYTE'}`);
      err(`这条指令不支持 ${typeName(op.size)} 类型的内存操作数`);
    }
    return 0;
  }

  /** 决定操作宽度：w=true 为 16 位 */
  private width(a: Op, b?: Op): boolean {
    const sa = a.k === 'reg' ? (a.w ? 2 : 1) : a.k === 'sreg' ? 2 : this.memSize(a, b);
    const sb = b ? (b.k === 'reg' ? (b.w ? 2 : 1) : b.k === 'sreg' ? 2 : this.memSize(b, a)) : 0;
    if (sa && sb && sa !== sb) {
      if (a.k === 'mem' && !(a as { ptr: boolean }).ptr && b?.k === 'reg') {
        err(`操作数大小不匹配：${this.descr(a)} 是 ${typeName(sa)}，${this.descr(b)} 是 ${typeName(sb)}（如确需按其他大小访问，请用 ${typeName(sb)} PTR）`);
      }
      if (b?.k === 'mem' && !(b as { ptr: boolean }).ptr && a.k === 'reg') {
        err(`操作数大小不匹配：${this.descr(a)} 是 ${typeName(sa)}，${this.descr(b)} 是 ${typeName(sb)}（如确需按其他大小访问，请用 ${typeName(sa)} PTR）`);
      }
      err(`两个操作数大小不一致（${typeName(sa)} 和 ${typeName(sb)}）`);
    }
    const s = sa || sb;
    if (!s) err('无法确定操作数大小，请用 BYTE PTR 或 WORD PTR 指明，例如 mov byte ptr [bx], 1');
    return s === 2;
  }

  private descr(op: Op): string {
    if (op.k === 'reg') return (op.w ? ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'] : ['AL', 'CL', 'DL', 'BL', 'AH', 'CH', 'DH', 'BH'])[op.reg];
    if (op.k === 'mem' && op.sym) return op.sym.name;
    return '内存操作数';
  }

  private imm(v: number, w: boolean, op: Op): number[] {
    if (op.k === 'imm' && !op.unknown) {
      if (w ? v < -65536 || v > 65535 : v < -256 || v > 255) {
        err(`立即数 ${v} 超出${w ? '16' : '8'} 位范围`);
      }
    }
    return w ? [v & 0xff, (v >> 8) & 0xff] : [v & 0xff];
  }

  private need(vals: Val[], n: number, mn: string): void {
    if (vals.length !== n) err(n === 0 ? `${mn.toUpperCase()} 不需要操作数` : `${mn.toUpperCase()} 需要 ${n} 个操作数`);
  }

  /** 需要 80186/80286 的指令：没写对应的 CPU 伪指令时报错 */
  private requireCpu(level: number, what: string): void {
    if (this.ctx.cpu < level) {
      err(`${what}是 ${CPU_NAME[level]} 的指令，需要在程序开头写 ${CPU_DIR[level]}；运行时 CPU 要选 286 或更高（8088 上没有这些指令）`);
    }
    this.ctx.useCpu(level);
  }

  private encodeInner(mn: string, vals: Val[]): number[] {
    if (I186.has(mn) || I286.has(mn) || I286P.has(mn)) return this.encode286(mn, vals);
    if (NOT_8086.has(mn)) err(`${mn.toUpperCase()} 不是 8086/80286 指令（本模拟器的汇编器只支持到 80286）`);

    if (mn in SIMPLE) {
      if (mn === 'xlatb' && vals.length) err('XLATB 不需要操作数');
      this.need(vals, 0, mn);
      return SIMPLE[mn];
    }

    if (mn in ALU) {
      this.need(vals, 2, mn);
      const idx = ALU[mn];
      const a = this.classify(vals[0]), b = this.classify(vals[1]);
      if (a.k === 'imm') err('目的操作数不能是立即数');
      if (a.k === 'sreg' || b.k === 'sreg') err('段寄存器不能参与算术或逻辑运算');
      if (a.k === 'mem' && b.k === 'mem') err('两个操作数不能都是内存');
      if (b.k === 'imm') {
        const w = this.width(a);
        if (a.k === 'reg' && a.reg === 0) {
          // 累加器短格式（与 MASM 一致：字操作且能符号扩展时用 83）
          if (!w) return [idx * 8 + 4, ...this.imm(b.v, false, b)];
          if (fitsS8w(b.v) && !b.reloc && !b.unknown) return [0x83, 0xc0 | (idx << 3), b.v & 0xff];
          return [idx * 8 + 5, ...this.imm(b.v, true, b)];
        }
        const m = this.modrm(idx, a);
        if (!w) return [...m.prefix, 0x80, ...m.bytes, ...this.imm(b.v, false, b)];
        if (fitsS8w(b.v) && !b.reloc && !b.unknown) return [...m.prefix, 0x83, ...m.bytes, b.v & 0xff];
        return [...m.prefix, 0x81, ...m.bytes, ...this.imm(b.v, true, b)];
      }
      const w = this.width(a, b);
      if (a.k === 'reg' && b.k !== 'mem') {
        // reg, reg：MASM 使用 "reg, r/m" 方向（操作码 +2）
        const m = this.modrm(a.reg, b);
        return [idx * 8 + 2 + (w ? 1 : 0), ...m.bytes];
      }
      if (a.k === 'reg') {
        const m = this.modrm(a.reg, b);
        return [...m.prefix, idx * 8 + 2 + (w ? 1 : 0), ...m.bytes];
      }
      if (b.k !== 'reg') err('无效的操作数组合');
      const m = this.modrm(b.reg, a);
      return [...m.prefix, idx * 8 + (w ? 1 : 0), ...m.bytes];
    }

    switch (mn) {
      case 'mov': return this.mov(vals);
      case 'xchg': {
        this.need(vals, 2, mn);
        let a = this.classify(vals[0]), b = this.classify(vals[1]);
        if (a.k === 'imm' || b.k === 'imm') err('XCHG 不能用立即数');
        if (a.k === 'sreg' || b.k === 'sreg') err('XCHG 不能用段寄存器');
        if (a.k === 'mem' && b.k === 'mem') err('两个操作数不能都是内存');
        const w = this.width(a, b);
        if (w && a.k === 'reg' && b.k === 'reg' && (a.reg === 0 || b.reg === 0)) {
          return [0x90 + (a.reg === 0 ? b.reg : a.reg)];
        }
        if (a.k === 'reg' && b.k === 'reg') return [0x86 + (w ? 1 : 0), 0xc0 | (a.reg << 3) | b.reg];
        if (a.k === 'reg') [a, b] = [b, a];
        if (b.k !== 'reg') err('无效的操作数组合');
        const m = this.modrm(b.reg, a);
        return [...m.prefix, 0x86 + (w ? 1 : 0), ...m.bytes];
      }
      case 'test': {
        this.need(vals, 2, mn);
        let a = this.classify(vals[0]), b = this.classify(vals[1]);
        if (a.k === 'imm' && b.k !== 'imm') [a, b] = [b, a];
        if (a.k === 'sreg' || b.k === 'sreg') err('TEST 不能用段寄存器');
        if (a.k === 'imm') err('无效的操作数组合');
        if (b.k === 'imm') {
          const w = this.width(a);
          if (a.k === 'reg' && a.reg === 0) return [w ? 0xa9 : 0xa8, ...this.imm(b.v, w, b)];
          const m = this.modrm(0, a);
          return [...m.prefix, w ? 0xf7 : 0xf6, ...m.bytes, ...this.imm(b.v, w, b)];
        }
        if (a.k === 'mem' && b.k === 'mem') err('两个操作数不能都是内存');
        const w = this.width(a, b);
        if (a.k === 'reg' && b.k === 'reg') return [0x84 + (w ? 1 : 0), 0xc0 | (a.reg << 3) | b.reg];
        if (a.k === 'reg') [a, b] = [b, a];
        if (b.k !== 'reg') err('无效的操作数组合');
        const m = this.modrm(b.reg, a);
        return [...m.prefix, 0x84 + (w ? 1 : 0), ...m.bytes];
      }
      case 'inc': case 'dec': {
        this.need(vals, 1, mn);
        const a = this.classify(vals[0]);
        const sub = mn === 'inc' ? 0 : 1;
        if (a.k === 'imm' || a.k === 'sreg') err(`${mn.toUpperCase()} 的操作数必须是寄存器或内存`);
        const w = this.width(a);
        if (a.k === 'reg' && w) return [0x40 + sub * 8 + a.reg];
        const m = this.modrm(sub, a);
        return [...m.prefix, w ? 0xff : 0xfe, ...m.bytes];
      }
      case 'push': case 'pop': {
        this.need(vals, 1, mn);
        const a = this.classify(vals[0]);
        const isPush = mn === 'push';
        if (a.k === 'imm') {
          if (!isPush) err('POP 的操作数不能是立即数');
          if (this.ctx.cpu < 1) err('PUSH 立即数是 80186 才有的指令：8086 需要先把数放进寄存器；或者在程序开头写 .186（或 .286），运行时 CPU 选 286 或更高');
          this.ctx.useCpu(1);
          // 和 MASM 一样：写出来的值在 -128~127 之间才用符号扩展的短格式 6A（0FF80h 这样写的用 68）
          if (a.v >= -128 && a.v <= 127 && !a.reloc && !a.unknown && !a.frameImm) return [0x6a, a.v & 0xff];
          return [0x68, ...this.imm(a.v, true, a)];
        }
        if (a.k === 'sreg') {
          if (!isPush && a.reg === S_CS) err('不能 POP CS');
          return [(a.reg << 3) | (isPush ? 0x06 : 0x07)];
        }
        if (a.k === 'reg') {
          if (!a.w) err(`${mn.toUpperCase()} 只能操作 16 位数据`);
          if (a.reg === 4) {
            this.ctx.warn(isPush
              ? 'PUSH SP 在 8086/8088 上压入的是减 2 之后的 SP，在 80286 以后压入的是原来的值；和 POP SP 配对使用时，在 8086/8088 上会让栈错开 2 个字节'
              : 'POP SP 会直接改变栈指针；如果和 PUSH SP 配对，在 8086/8088 上会让栈错开 2 个字节（PUSH SP 在 8086 和 286 上行为不同）');
          }
          return [(isPush ? 0x50 : 0x58) + a.reg];
        }
        const s = this.memSize(a);
        if (s === 1) err(`${mn.toUpperCase()} 只能操作 16 位数据`);
        const m = this.modrm(isPush ? 6 : 0, a);
        return [...m.prefix, isPush ? 0xff : 0x8f, ...m.bytes];
      }
      case 'lea': case 'lds': case 'les': {
        this.need(vals, 2, mn);
        const a = this.classify(vals[0]), b = this.classify(vals[1]);
        if (a.k !== 'reg' || !a.w) err(`${mn.toUpperCase()} 的第一个操作数必须是 16 位通用寄存器`);
        if (b.k !== 'mem') err(`${mn.toUpperCase()} 的第二个操作数必须是内存操作数`);
        const m = this.modrm(a.reg, b);
        const op = mn === 'lea' ? 0x8d : mn === 'lds' ? 0xc5 : 0xc4;
        return [...m.prefix, op, ...m.bytes];
      }
      case 'jmp': return this.jmpCall(vals, false);
      case 'call': return this.jmpCall(vals, true);
      case 'ret': case 'retn': case 'retf': {
        const far = mn === 'retf' || (mn === 'ret' && this.ctx.procType === T_FAR);
        if (vals.length === 0) return [far ? 0xcb : 0xc3];
        const n = this.classify(vals[0]);
        if (n.k !== 'imm') err('RET 的操作数必须是立即数');
        return [far ? 0xca : 0xc2, n.v & 0xff, (n.v >> 8) & 0xff];
      }
      case 'int': {
        this.need(vals, 1, mn);
        const n = this.classify(vals[0]);
        if (n.k !== 'imm') err('INT 的操作数必须是中断号（立即数）');
        if (!n.unknown && (n.v < 0 || n.v > 255)) err('中断号必须在 0~255 之间');
        return n.v === 3 ? [0xcc] : [0xcd, n.v & 0xff];
      }
      case 'aam': case 'aad': {
        const base = vals.length ? this.classify(vals[0]) : null;
        if (base && base.k !== 'imm') err(`${mn.toUpperCase()} 的操作数必须是立即数`);
        return [mn === 'aam' ? 0xd4 : 0xd5, base ? base.v & 0xff : 10];
      }
      case 'in': {
        this.need(vals, 2, mn);
        const a = this.classify(vals[0]), b = this.classify(vals[1]);
        if (a.k !== 'reg' || a.reg !== 0) err('IN 的目的操作数只能是 AL 或 AX');
        if (b.k === 'reg' && b.w && b.reg === 2) return [a.w ? 0xed : 0xec];
        if (b.k === 'imm') {
          if (!b.unknown && (b.v < 0 || b.v > 255)) err('端口号大于 255 时必须先放进 DX，再用 IN AL, DX');
          return [a.w ? 0xe5 : 0xe4, b.v & 0xff];
        }
        err('IN 的端口只能是 0~255 的立即数或 DX');
      }
      // eslint-disable-next-line no-fallthrough
      case 'out': {
        this.need(vals, 2, mn);
        const a = this.classify(vals[0]), b = this.classify(vals[1]);
        if (b.k !== 'reg' || b.reg !== 0) err('OUT 的源操作数只能是 AL 或 AX');
        if (a.k === 'reg' && a.w && a.reg === 2) return [b.w ? 0xef : 0xee];
        if (a.k === 'imm') {
          if (!a.unknown && (a.v < 0 || a.v > 255)) err('端口号大于 255 时必须先放进 DX，再用 OUT DX, AL');
          return [b.w ? 0xe7 : 0xe6, a.v & 0xff];
        }
        err('OUT 的端口只能是 0~255 的立即数或 DX');
      }
      // eslint-disable-next-line no-fallthrough
      case 'xlat': {
        if (vals.length > 1) err('XLAT 最多一个操作数');
        if (vals.length) {
          const a = this.classify(vals[0]);
          if (a.k === 'mem') { const p = this.segPrefix(a); return [...p, 0xd7]; }
        }
        return [0xd7];
      }
      case 'esc': err('不支持 ESC 指令');
    }

    if (mn in SHIFT) {
      this.need(vals, 2, mn);
      const a = this.classify(vals[0]), b = this.classify(vals[1]);
      if (a.k === 'imm' || a.k === 'sreg') err('移位指令的目的操作数必须是寄存器或内存');
      const w = this.width(a);
      const m = this.modrm(SHIFT[mn], a);
      if (b.k === 'reg' && !b.w && b.reg === 1) return [...m.prefix, w ? 0xd3 : 0xd2, ...m.bytes];
      if (b.k === 'imm') {
        if (b.v === 1 && !b.unknown) return [...m.prefix, w ? 0xd1 : 0xd0, ...m.bytes];
        if (this.ctx.cpu < 1) err(`8086 的移位次数只能是 1 或 CL；要移 ${b.v} 位，请先 MOV CL, ${b.v}，再写 ${mn.toUpperCase()} ${this.descr(a)}, CL（或者在程序开头写 .186 / .286，运行时 CPU 选 286 或更高）`);
        this.ctx.useCpu(1);
        if (!b.unknown && (b.v < 0 || b.v > 255)) err('移位次数必须在 0~255 之间');
        return [...m.prefix, w ? 0xc1 : 0xc0, ...m.bytes, b.v & 0xff];
      }
      err('移位次数只能是 1 或 CL');
    }

    if (mn in UNARY) {
      if (mn === 'imul' && vals.length > 1) return this.imul3(vals);
      this.need(vals, 1, mn);
      const a = this.classify(vals[0]);
      if (a.k === 'imm') err(`${mn.toUpperCase()} 的操作数不能是立即数`);
      if (a.k === 'sreg') err(`${mn.toUpperCase()} 不能用段寄存器`);
      const w = this.width(a);
      const m = this.modrm(UNARY[mn], a);
      return [...m.prefix, w ? 0xf7 : 0xf6, ...m.bytes];
    }

    if (mn in JCC || mn in LOOPS) return this.condJump(mn, vals);

    if (mn in STRING_OPS) {
      const base = STRING_OPS[mn];
      if (vals.length === 0) err(`${mn.toUpperCase()} 需要操作数来确定大小，或改用 ${mn.toUpperCase()}B / ${mn.toUpperCase()}W`);
      const ops = vals.map(v => this.classify(v));
      let size = 0;
      for (const o of ops) { const s = this.memSize(o); if (s) { size = s; break; } }
      if (!size) for (const o of ops) if (o.k === 'reg') size = o.w ? 2 : 1;
      if (!size) err('无法确定串操作的大小');
      // 源操作数（DS:SI）允许段超越
      let prefix: number[] = [];
      const src = mn === 'movs' || mn === 'cmps' ? ops[1] : mn === 'lods' ? ops[0] : null;
      if (src && src.k === 'mem') prefix = this.segPrefix(src);
      return [...prefix, base + (size === 2 ? 1 : 0)];
    }

    err(`未知指令：${mn}`);
  }

  /** IMUL reg, r/m, 立即数 和 IMUL reg, 立即数（= IMUL reg, reg, 立即数）（80186） */
  private imul3(vals: Val[]): number[] {
    this.requireCpu(1, '多操作数的 IMUL ');
    if (vals.length !== 2 && vals.length !== 3) err('IMUL 需要 1 个操作数（8086 的格式），或者 2~3 个操作数：IMUL 寄存器, [寄存器或内存,] 立即数');
    const d = this.classify(vals[0]);
    const s = vals.length === 3 ? this.classify(vals[1]) : d;
    const n = this.classify(vals[vals.length - 1]);
    if (d.k !== 'reg' || !d.w) err('IMUL 的目的操作数必须是 16 位通用寄存器');
    if (n.k !== 'imm') err('IMUL 的最后一个操作数必须是立即数');
    if (s.k === 'reg' && !s.w) err('IMUL 的源操作数必须是 16 位');
    if (s.k === 'mem' && this.memSize(s) === 1) err('IMUL 的源操作数必须是字（WORD）');
    if (s.k !== 'reg' && s.k !== 'mem') err('IMUL 的源操作数必须是寄存器或内存');
    const m = this.modrm(d.reg, s);
    // 和 ADD 等一样：能符号扩展成 16 位的用短格式 6B（0FFFFh 也算），否则 69
    if (fitsS8w(n.v) && !n.reloc && !n.unknown) return [...m.prefix, 0x6b, ...m.bytes, n.v & 0xff];
    return [...m.prefix, 0x69, ...m.bytes, ...this.imm(n.v, true, n)];
  }

  /** 16 位的寄存器或内存操作数 */
  private rm16(op: Op, mn: string): void {
    if (op.k === 'reg' && !op.w) err(`${mn.toUpperCase()} 的操作数必须是 16 位`);
    if (op.k === 'mem' && this.memSize(op) === 1) err(`${mn.toUpperCase()} 的操作数必须是字（WORD）`);
    if (op.k !== 'reg' && op.k !== 'mem') err(`${mn.toUpperCase()} 的操作数必须是寄存器或内存`);
  }

  /** 80186 / 80286 新增的指令 */
  private encode286(mn: string, vals: Val[]): number[] {
    this.requireCpu(I186.has(mn) ? 1 : I286.has(mn) ? 2 : 3, `${mn.toUpperCase()} `);
    const simple: Record<string, number> = { pusha: 0x60, popa: 0x61, leave: 0xc9, insb: 0x6c, insw: 0x6d, outsb: 0x6e, outsw: 0x6f };
    if (mn in simple) { this.need(vals, 0, mn); return [simple[mn]]; }
    if (mn === 'clts') { this.need(vals, 0, mn); return [0x0f, 0x06]; }
    if (mn === 'ins' || mn === 'outs') {
      // INS 目的, DX（目的固定是 ES:DI）；OUTS DX, 源（源是 DS:SI，可以加段超越）
      this.need(vals, 2, mn);
      const isIns = mn === 'ins';
      const mem = this.classify(vals[isIns ? 0 : 1]), port = this.classify(vals[isIns ? 1 : 0]);
      if (port.k !== 'reg' || !port.w || port.reg !== 2) err(`${mn.toUpperCase()} 的端口只能是 DX`);
      const size = this.memSize(mem);
      if (mem.k !== 'mem' || !size) err(`${mn.toUpperCase()} 需要写明大小的内存操作数，例如 BYTE PTR [${isIns ? 'DI' : 'SI'}]，或改用 ${mn.toUpperCase()}B / ${mn.toUpperCase()}W`);
      const prefix = isIns ? [] : this.segPrefix(mem);
      return [...prefix, (isIns ? 0x6c : 0x6e) + (size === 2 ? 1 : 0)];
    }
    if (mn === 'enter') {
      this.need(vals, 2, mn);
      const a = this.classify(vals[0]), b = this.classify(vals[1]);
      if (a.k !== 'imm' || b.k !== 'imm') err('ENTER 的两个操作数都必须是立即数：ENTER 局部变量字节数, 嵌套层数');
      if (!b.unknown && (b.v < 0 || b.v > 255)) err('ENTER 的嵌套层数必须在 0~255 之间');
      return [0xc8, ...this.imm(a.v, true, a), b.v & 0xff];
    }
    this.need(vals, mn in GRP0F00 || mn in GRP0F01 ? 1 : 2, mn);
    const a = this.classify(vals[0]), b = vals.length > 1 ? this.classify(vals[1]) : a;
    if (mn === 'bound') {
      if (a.k !== 'reg' || !a.w) err('BOUND 的第一个操作数必须是 16 位通用寄存器');
      if (b.k !== 'mem') err('BOUND 的第二个操作数必须是内存（两个字：下界、上界）');
      const m = this.modrm(a.reg, b);
      return [...m.prefix, 0x62, ...m.bytes];
    }
    if (mn === 'arpl') {
      this.rm16(a, mn);
      if (b.k !== 'reg' || !b.w) err('ARPL 的第二个操作数必须是 16 位通用寄存器');
      const m = this.modrm(b.reg, a);
      return [...m.prefix, 0x63, ...m.bytes];
    }
    if (mn === 'lar' || mn === 'lsl') {
      if (a.k !== 'reg' || !a.w) err(`${mn.toUpperCase()} 的第一个操作数必须是 16 位通用寄存器`);
      this.rm16(b, mn);
      const m = this.modrm(a.reg, b);
      return [...m.prefix, 0x0f, mn === 'lar' ? 0x02 : 0x03, ...m.bytes];
    }
    if (mn in GRP0F00) {
      this.rm16(a, mn);
      const m = this.modrm(GRP0F00[mn], a);
      return [...m.prefix, 0x0f, 0x00, ...m.bytes];
    }
    // 0F 01 组：SGDT/SIDT/LGDT/LIDT 只能是内存（6 字节：界限 + 基址），SMSW/LMSW 是 16 位
    if (mn === 'smsw' || mn === 'lmsw') this.rm16(a, mn);
    else {
      if (a.k !== 'mem') err(`${mn.toUpperCase()} 的操作数必须是内存（6 个字节：界限、基址）`);
      if ((mn === 'lgdt' || mn === 'lidt') && a.size === 1) err(`${mn.toUpperCase()} 的操作数不能是字节，应该是 6 个字节（界限、基址）`);
    }
    const m = this.modrm(GRP0F01[mn], a);
    return [...m.prefix, 0x0f, 0x01, ...m.bytes];
  }

  private mov(vals: Val[]): number[] {
    this.need(vals, 2, 'mov');
    const a = this.classify(vals[0]), b = this.classify(vals[1]);
    if (a.k === 'imm') err('MOV 的目的操作数不能是立即数');
    if (a.k === 'mem' && b.k === 'mem') err('8086 不能在两个内存单元之间直接 MOV，需要借助寄存器中转');
    if (a.k === 'sreg') {
      if (a.reg === S_CS) err('不能用 MOV 修改 CS（请用 JMP FAR / CALL FAR / RETF）');
      if (b.k === 'imm') err(`不能把立即数直接送入段寄存器 ${SREG_NAMES[a.reg]}，需要先送入通用寄存器，例如 MOV AX, ... 再 MOV ${SREG_NAMES[a.reg]}, AX`);
      if (b.k === 'sreg') err('段寄存器之间不能直接 MOV，需要借助通用寄存器');
      if (b.k === 'reg' && !b.w) err('段寄存器只能和 16 位寄存器交换数据');
      if (b.k === 'mem' && this.memSize(b) === 1) err('段寄存器只能装入字（WORD）');
      const m = this.modrm(a.reg, b);
      return [...m.prefix, 0x8e, ...m.bytes];
    }
    if (b.k === 'sreg') {
      if (a.k === 'reg' && !a.w) err('段寄存器只能送入 16 位寄存器');
      if (a.k === 'mem' && this.memSize(a) === 1) err('段寄存器只能存入字（WORD）');
      const m = this.modrm(b.reg, a);
      return [...m.prefix, 0x8c, ...m.bytes];
    }
    if (b.k === 'imm') {
      const w = this.width(a);
      if (a.k === 'reg') return [(w ? 0xb8 : 0xb0) + a.reg, ...this.imm(b.v, w, b)];
      const m = this.modrm(0, a);
      return [...m.prefix, w ? 0xc7 : 0xc6, ...m.bytes, ...this.imm(b.v, w, b)];
    }
    if (b.k === 'target' || a.k === 'target') err('无效的操作数');
    const w = this.width(a, b);
    // 累加器与直接地址之间的短格式 A0-A3
    if (a.k === 'reg' && a.reg === 0 && b.k === 'mem' && b.base < 0 && b.index < 0) {
      return [...this.segPrefix(b), w ? 0xa1 : 0xa0, b.disp & 0xff, (b.disp >> 8) & 0xff];
    }
    if (b.k === 'reg' && b.reg === 0 && a.k === 'mem' && a.base < 0 && a.index < 0) {
      return [...this.segPrefix(a), w ? 0xa3 : 0xa2, a.disp & 0xff, (a.disp >> 8) & 0xff];
    }
    if (a.k === 'reg') {
      const m = this.modrm(a.reg, b);
      return [...m.prefix, w ? 0x8b : 0x8a, ...m.bytes];
    }
    if (b.k !== 'reg') err('无效的操作数组合');
    const m = this.modrm(b.reg, a);
    return [...m.prefix, w ? 0x89 : 0x88, ...m.bytes];
  }

  private jmpCall(vals: Val[], isCall: boolean): number[] {
    const name = isCall ? 'CALL' : 'JMP';
    this.need(vals, 1, name.toLowerCase());
    const v = vals[0];
    const op = this.classify(v, true);
    if (op.k === 'reg') {
      if (!op.w) err(`${name} 的寄存器操作数必须是 16 位`);
      return [0xff, 0xc0 | ((isCall ? 2 : 4) << 3) | op.reg];
    }
    if (op.k === 'sreg') err(`${name} 不能用段寄存器`);
    if (op.k === 'mem') {
      const far = op.size === 4 || v.dist === 'far' || op.size === T_FAR;
      const m = this.modrm(isCall ? (far ? 3 : 2) : (far ? 5 : 4), op);
      return [...m.prefix, 0xff, ...m.bytes];
    }
    if (op.k !== 'target') err(`无效的 ${name} 目标`);
    const t = op.v;
    if (!t.frame && !t.unknown) err(`${name} 的目标必须是标号`);
    const ctx = this.ctx;
    const sameFrame = t.frame === ctx.curFrame || t.unknown;
    const far = t.dist === 'far' || (t.type === T_FAR && t.dist !== 'near' && t.dist !== 'short');
    if (far) {
      // 与 MASM 一致：CALL 同一段内的 FAR 过程时生成 PUSH CS + 近调用（4 字节）
      if (isCall && t.dist !== 'far' && t.frame === ctx.curFrame) {
        const d = (t.n - (ctx.pc + 4)) & 0xffff;
        return [0x0e, 0xe8, d & 0xff, d >> 8];
      }
      const seg = t.frame ? ctx.loadSeg + t.frame.para : 0;
      return [isCall ? 0x9a : 0xea, t.n & 0xff, (t.n >> 8) & 0xff, seg & 0xff, (seg >> 8) & 0xff];
    }
    if (!sameFrame) err(`${name} 的目标 ${t.sym?.name ?? ''} 在另一个段中，需要写 ${name} FAR PTR ${t.sym?.name ?? '标号'}`);
    if (isCall) {
      const d = (t.n - (ctx.pc + 3)) & 0xffff;
      return [0xe8, d & 0xff, d >> 8];
    }
    const ds = t.n - (ctx.pc + 2);
    if (t.dist === 'short') {
      if (!t.unknown && !fitsS8(ds)) err(`SHORT 跳转超出范围（${ds} 字节，只能在 -128~127 之间）`);
      return [0xeb, ds & 0xff];
    }
    if (t.dist !== 'near' && !ctx.isLong) {
      if (fitsS8(ds) || t.unknown) return [0xeb, ds & 0xff];
      ctx.setLong();
    }
    const d = (t.n - (ctx.pc + 3)) & 0xffff;
    return [0xe9, d & 0xff, d >> 8];
  }

  private condJump(mn: string, vals: Val[]): number[] {
    this.need(vals, 1, mn);
    const op = this.classify(vals[0], true);
    if (op.k !== 'target') err(`${mn.toUpperCase()} 的目标必须是标号（8086 的条件跳转只能是短跳转）`);
    const t = op.v;
    const ctx = this.ctx;
    if (t.frame && t.frame !== ctx.curFrame) err(`${mn.toUpperCase()} 不能跳转到另一个段`);
    const ds = t.n - (ctx.pc + 2);
    const isLoop = mn in LOOPS;
    const opc = isLoop ? LOOPS[mn] : JCC[mn];
    if (!ctx.isLong) {
      if (fitsS8(ds) || t.unknown) return [opc, ds & 0xff];
      if (isLoop || t.dist === 'short') {
        err(`${mn.toUpperCase()} 跳转超出范围（距离 ${ds} 字节，只能在 -128~127 之间）`);
      }
      ctx.setLong();
    }
    if (isLoop) {
      if (!fitsS8(ds)) err(`${mn.toUpperCase()} 跳转超出范围（距离 ${ds} 字节，只能在 -128~127 之间）`);
      return [opc, ds & 0xff];
    }
    // 超出短跳转范围：与 MASM 6 一样自动扩展为 "反条件短跳 + 近跳转"
    const d = (t.n - (ctx.pc + 5)) & 0xffff;
    return [opc ^ 1, 3, 0xe9, d & 0xff, d >> 8];
  }
}
