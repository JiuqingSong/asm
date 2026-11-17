// 8086/8088 反汇编器：机器码 -> MASM 风格的文本
//
// 输出的文字尽量能被本项目的汇编器（以及 MASM）重新汇编成同样的机器码，
// 跳转目标是同一段内的偏移地址（target 字段），界面上可以换成源码中的标号。

const R16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const R8 = ['AL', 'CL', 'DL', 'BL', 'AH', 'CH', 'DH', 'BH'];
const SREG = ['ES', 'CS', 'SS', 'DS'];
const EA = ['BX+SI', 'BX+DI', 'BP+SI', 'BP+DI', 'SI', 'DI', 'BP', 'BX'];
const ALU = ['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'CMP'];
const SHIFT = ['ROL', 'ROR', 'RCL', 'RCR', 'SHL', 'SHR', 'SETMO', 'SAR'];
const GRP3 = ['TEST', 'TEST', 'NOT', 'NEG', 'MUL', 'IMUL', 'DIV', 'IDIV'];
const JCC = ['JO', 'JNO', 'JB', 'JAE', 'JE', 'JNE', 'JBE', 'JA', 'JS', 'JNS', 'JP', 'JNP', 'JL', 'JGE', 'JLE', 'JG'];

/** 十六进制数，MASM 写法：以字母开头时前面补 0，后面加 h */
export function hexNum(v: number, digits = 0): string {
  let s = v.toString(16).toUpperCase();
  if (digits) s = s.padStart(digits, '0');
  if (/^[A-F]/.test(s)) s = '0' + s;
  return s + 'h';
}

export interface Instruction {
  /** 指令起始的段内偏移 */
  offset: number;
  /** 指令长度（含前缀） */
  length: number;
  bytes: number[];
  /** 完整文本，例如 "MOV AX,[BX+SI+04h]" */
  text: string;
  mnemonic: string;
  /** 段内跳转/调用的目标偏移 */
  target?: number;
  /** 跳转形式：短跳转、近跳转、远跳转（远跳转的段在 targetSeg） */
  form?: 'short' | 'near' | 'far';
  targetSeg?: number;
  isCall?: boolean;
  isRet?: boolean;
  isJump?: boolean;
  /** 条件跳转、LOOP 等（可能不跳） */
  conditional?: boolean;
  /** 未公开或无效的指令 */
  undocumented?: boolean;
}

export type ReadByte = (offset: number) => number;

export function disassemble(read: ReadByte, start: number): Instruction {
  let p = start & 0xffff;
  const bytes: number[] = [];
  const next = () => { const b = read(p) & 0xff; bytes.push(b); p = (p + 1) & 0xffff; return b; };
  const next16 = () => { const lo = next(); return lo | (next() << 8); };
  const sx8 = (v: number) => (v & 0x80 ? v - 0x100 : v);

  let segOvr = -1;
  let rep = '';
  let lock = false;
  let op: number;
  for (;;) {
    op = next();
    if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { segOvr = (op >> 3) & 3; continue; }
    if (op === 0xf2 || op === 0xf3) { rep = op === 0xf3 ? 'REP' : 'REPNE'; continue; }
    if (op === 0xf0 || op === 0xf1) { lock = true; continue; }
    break;
  }
  if (bytes.length > 8) {
    // 一长串前缀：只把第一个当作一条指令
    p = (start + 1) & 0xffff;
    bytes.length = 1;
    return finish('DB', [hexNum(bytes[0], 2)], { undocumented: true });
  }

  let mod = 0, reg = 0, rm = 0, memText = '';
  let segUsed = false;
  const modrm = () => {
    const b = next();
    mod = b >> 6; reg = (b >> 3) & 7; rm = b & 7;
    if (mod === 3) return;
    let base = EA[rm];
    let disp = 0;
    if (mod === 0 && rm === 6) {
      const d = next16();
      memText = `[${hexNum(d, 4)}]`;
      const s = segOvr >= 0 ? segOvr : 3;
      memText = `${SREG[s]}:${memText}`;
      segUsed = true;
      return;
    }
    if (mod === 1) disp = sx8(next());
    else if (mod === 2) disp = next16();
    let t = base;
    if (mod === 1 && disp !== 0) t += disp < 0 ? `-${hexNum(-disp, 2)}` : `+${hexNum(disp, 2)}`;
    else if (mod === 1 && rm !== 6) t += `+${hexNum(0, 2)}`; // [BP] 本身就要带 8 位位移 0
    else if (mod === 2) t += `+${hexNum(disp, 4)}`;
    base = `[${t}]`;
    if (segOvr >= 0) { base = `${SREG[segOvr]}:${base}`; segUsed = true; }
    memText = base;
  };
  /** r/m 操作数；size 为 1/2 时在内存操作数前加 BYTE/WORD PTR（needPtr 为真时） */
  const rmOp = (w: boolean, needPtr: boolean, ptr = w ? 'WORD' : 'BYTE') => {
    if (mod === 3) return (w ? R16 : R8)[rm];
    return needPtr ? `${ptr} PTR ${memText}` : memText;
  };
  const regOp = (w: boolean) => (w ? R16 : R8)[reg];
  const imm = (w: boolean) => (w ? hexNum(next16(), 4) : hexNum(next(), 2));

  function finish(mnemonic: string, ops: string[], extra: Partial<Instruction> = {}): Instruction {
    const pre: string[] = [];
    if (lock) pre.push('LOCK');
    if (rep) pre.push(rep);
    const text = [...pre, mnemonic].join(' ') + (ops.length ? ' ' + ops.join(',') : '');
    return { offset: start & 0xffff, length: bytes.length, bytes: bytes.slice(), text, mnemonic, ...extra };
  }
  const rel8 = () => { const d = sx8(next()); return (p + d) & 0xffff; };
  const rel16 = () => { const d = next16(); return (p + d) & 0xffff; };

  // ---- 00-3F：算术逻辑运算 ----
  if (op < 0x40 && (op & 7) < 6) {
    const alu = ALU[op >> 3], w = (op & 1) === 1;
    switch (op & 7) {
      case 0: case 1: modrm(); return finish(alu, [rmOp(w, false), regOp(w)]);
      case 2: case 3: modrm(); return finish(alu, [regOp(w), rmOp(w, false)]);
      case 4: return finish(alu, ['AL', imm(false)]);
      case 5: return finish(alu, ['AX', imm(true)]);
    }
  }
  switch (op) {
    case 0x06: case 0x0e: case 0x16: case 0x1e: return finish('PUSH', [SREG[op >> 3]]);
    case 0x07: case 0x17: case 0x1f: return finish('POP', [SREG[op >> 3]]);
    case 0x0f: return finish('POP', ['CS'], { undocumented: true });
    case 0x27: return finish('DAA', []);
    case 0x2f: return finish('DAS', []);
    case 0x37: return finish('AAA', []);
    case 0x3f: return finish('AAS', []);
  }
  if (op >= 0x40 && op < 0x60) return finish(['INC', 'DEC', 'PUSH', 'POP'][(op - 0x40) >> 3], [R16[op & 7]]);
  if (op >= 0x60 && op < 0x80) {
    const t = rel8();
    return finish(JCC[op & 0xf], [hexNum(t, 4)], { target: t, form: 'short', isJump: true, conditional: true, undocumented: op < 0x70 });
  }
  switch (op) {
    case 0x80: case 0x81: case 0x82: case 0x83: {
      const w = (op & 1) === 1;
      modrm();
      const v = op === 0x81 ? hexNum(next16(), 4) : op === 0x83 ? signedImm(sx8(next())) : hexNum(next(), 2);
      return finish(ALU[reg], [rmOp(w, true), v], { undocumented: op === 0x82 });
    }
    case 0x84: case 0x85: { const w = op === 0x85; modrm(); return finish('TEST', mod === 3 ? [regOp(w), rmOp(w, false)] : [rmOp(w, false), regOp(w)]); }
    case 0x86: case 0x87: { const w = op === 0x87; modrm(); return finish('XCHG', mod === 3 ? [regOp(w), rmOp(w, false)] : [rmOp(w, false), regOp(w)]); }
    case 0x88: case 0x89: { const w = op === 0x89; modrm(); return finish('MOV', [rmOp(w, false), regOp(w)]); }
    case 0x8a: case 0x8b: { const w = op === 0x8b; modrm(); return finish('MOV', [regOp(w), rmOp(w, false)]); }
    case 0x8c: modrm(); return finish('MOV', [rmOp(true, false), SREG[reg & 3]], { undocumented: reg > 3 });
    case 0x8d: modrm(); return finish('LEA', [R16[reg], mod === 3 ? R16[rm] : memText], { undocumented: mod === 3 });
    case 0x8e: modrm(); return finish('MOV', [SREG[reg & 3], rmOp(true, false)], { undocumented: reg > 3 });
    case 0x8f: modrm(); return finish('POP', [rmOp(true, true)], { undocumented: reg !== 0 });
    case 0x90: return finish('NOP', []);
    case 0x98: return finish('CBW', []);
    case 0x99: return finish('CWD', []);
    case 0x9a: {
      const o = next16(), s = next16();
      return finish('CALL', [`${hexNum(s, 4)}:${hexNum(o, 4)}`], { target: o, targetSeg: s, form: 'far', isCall: true });
    }
    case 0x9b: return finish('WAIT', []);
    case 0x9c: return finish('PUSHF', []);
    case 0x9d: return finish('POPF', []);
    case 0x9e: return finish('SAHF', []);
    case 0x9f: return finish('LAHF', []);
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
      const addr = next16();
      const m = `${SREG[segOvr >= 0 ? segOvr : 3]}:[${hexNum(addr, 4)}]`;
      segUsed = true;
      const acc = op & 1 ? 'AX' : 'AL';
      return finish('MOV', op < 0xa2 ? [acc, m] : [m, acc]);
    }
    case 0xa8: return finish('TEST', ['AL', imm(false)]);
    case 0xa9: return finish('TEST', ['AX', imm(true)]);
  }
  if (op >= 0x91 && op <= 0x97) return finish('XCHG', ['AX', R16[op & 7]]);
  if (op >= 0xa4 && op <= 0xaf && op !== 0xa8 && op !== 0xa9) {
    const names: Record<number, string> = { 0xa4: 'MOVS', 0xa6: 'CMPS', 0xaa: 'STOS', 0xac: 'LODS', 0xae: 'SCAS' };
    const base = names[op & 0xfe];
    const w = (op & 1) === 1;
    if ((op & 0xfe) === 0xa6 || (op & 0xfe) === 0xae) rep = rep === 'REP' ? 'REPE' : rep;
    if (segOvr >= 0 && (base === 'MOVS' || base === 'CMPS' || base === 'LODS')) {
      // 有段超越时只能写成带操作数的形式
      segUsed = true;
      const sz = w ? 'WORD' : 'BYTE';
      const src = `${sz} PTR ${SREG[segOvr]}:[SI]`;
      if (base === 'LODS') return finish('LODS', [src]);
      return finish(base, [`${sz} PTR ES:[DI]`, src]);
    }
    return finish(base + (w ? 'W' : 'B'), []);
  }
  if (op >= 0xb0 && op <= 0xb7) return finish('MOV', [R8[op & 7], imm(false)]);
  if (op >= 0xb8 && op <= 0xbf) return finish('MOV', [R16[op & 7], imm(true)]);
  switch (op) {
    case 0xc0: case 0xc2: { const n = next16(); return finish('RET', [hexNum(n, 4)], { isRet: true, undocumented: op === 0xc0 }); }
    case 0xc1: case 0xc3: return finish('RET', [], { isRet: true, undocumented: op === 0xc1 });
    case 0xc4: modrm(); return finish('LES', [R16[reg], mod === 3 ? R16[rm] : memText], { undocumented: mod === 3 });
    case 0xc5: modrm(); return finish('LDS', [R16[reg], mod === 3 ? R16[rm] : memText], { undocumented: mod === 3 });
    case 0xc6: modrm(); return finish('MOV', [rmOp(false, true), imm(false)], { undocumented: reg !== 0 });
    case 0xc7: modrm(); return finish('MOV', [rmOp(true, true), imm(true)], { undocumented: reg !== 0 });
    case 0xc8: case 0xca: { const n = next16(); return finish('RETF', [hexNum(n, 4)], { isRet: true, undocumented: op === 0xc8 }); }
    case 0xc9: case 0xcb: return finish('RETF', [], { isRet: true, undocumented: op === 0xc9 });
    case 0xcc: return finish('INT', ['3'], { isCall: true });
    case 0xcd: return finish('INT', [hexNum(next(), 2)], { isCall: true });
    case 0xce: return finish('INTO', [], { isCall: true });
    case 0xcf: return finish('IRET', [], { isRet: true });
    case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const w = (op & 1) === 1;
      modrm();
      return finish(SHIFT[reg], [rmOp(w, true), op & 2 ? 'CL' : '1'], { undocumented: reg === 6 });
    }
    case 0xd4: { const b = next(); return finish('AAM', b === 10 ? [] : [hexNum(b, 2)]); }
    case 0xd5: { const b = next(); return finish('AAD', b === 10 ? [] : [hexNum(b, 2)]); }
    case 0xd6: return finish('SALC', [], { undocumented: true });
    case 0xd7:
      if (segOvr >= 0) { segUsed = true; return finish('XLAT', [`BYTE PTR ${SREG[segOvr]}:[BX]`]); }
      return finish('XLATB', []);
  }
  if (op >= 0xd8 && op <= 0xdf) {
    modrm();
    return finish('ESC', [hexNum(((op & 7) << 3) | reg, 2), mod === 3 ? R16[rm] : memText], { undocumented: true });
  }
  switch (op) {
    case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
      const t = rel8();
      return finish(['LOOPNE', 'LOOPE', 'LOOP', 'JCXZ'][op - 0xe0], [hexNum(t, 4)], { target: t, form: 'short', isJump: true, conditional: true });
    }
    case 0xe4: return finish('IN', ['AL', hexNum(next(), 2)]);
    case 0xe5: return finish('IN', ['AX', hexNum(next(), 2)]);
    case 0xe6: return finish('OUT', [hexNum(next(), 2), 'AL']);
    case 0xe7: return finish('OUT', [hexNum(next(), 2), 'AX']);
    case 0xe8: { const t = rel16(); return finish('CALL', [hexNum(t, 4)], { target: t, form: 'near', isCall: true }); }
    case 0xe9: { const t = rel16(); return finish('JMP', [hexNum(t, 4)], { target: t, form: 'near', isJump: true }); }
    case 0xea: {
      const o = next16(), s = next16();
      return finish('JMP', [`${hexNum(s, 4)}:${hexNum(o, 4)}`], { target: o, targetSeg: s, form: 'far', isJump: true });
    }
    case 0xeb: { const t = rel8(); return finish('JMP', [`SHORT ${hexNum(t, 4)}`], { target: t, form: 'short', isJump: true }); }
    case 0xec: return finish('IN', ['AL', 'DX']);
    case 0xed: return finish('IN', ['AX', 'DX']);
    case 0xee: return finish('OUT', ['DX', 'AL']);
    case 0xef: return finish('OUT', ['DX', 'AX']);
    case 0xf4: return finish('HLT', []);
    case 0xf5: return finish('CMC', []);
    case 0xf6: case 0xf7: {
      const w = op === 0xf7;
      modrm();
      const ops = [rmOp(w, true)];
      if (reg < 2) ops.push(imm(w));
      return finish(GRP3[reg], ops, { undocumented: reg === 1 });
    }
    case 0xf8: return finish('CLC', []);
    case 0xf9: return finish('STC', []);
    case 0xfa: return finish('CLI', []);
    case 0xfb: return finish('STI', []);
    case 0xfc: return finish('CLD', []);
    case 0xfd: return finish('STD', []);
    case 0xfe: {
      modrm();
      if (reg < 2) return finish(reg ? 'DEC' : 'INC', [rmOp(false, true)]);
      return finish('???', [rmOp(false, true)], { undocumented: true });
    }
    case 0xff: {
      modrm();
      switch (reg) {
        case 0: return finish('INC', [rmOp(true, true)]);
        case 1: return finish('DEC', [rmOp(true, true)]);
        case 2: return finish('CALL', [rmOp(true, true)], { isCall: true });
        case 3: return finish('CALL', [mod === 3 ? R16[rm] : `DWORD PTR ${memText}`], { isCall: true, form: 'far', undocumented: mod === 3 });
        case 4: return finish('JMP', [rmOp(true, true)], { isJump: true });
        case 5: return finish('JMP', [mod === 3 ? R16[rm] : `DWORD PTR ${memText}`], { isJump: true, form: 'far', undocumented: mod === 3 });
        default: return finish('PUSH', [rmOp(true, true)], { undocumented: reg === 7 });
      }
    }
  }
  void segUsed;
  return finish('DB', [hexNum(op, 2)], { undocumented: true });
}

function signedImm(v: number): string {
  return v < 0 ? `-${hexNum(-v, 2)}` : hexNum(v, 2);
}

/**
 * 反汇编一段代码，使 at 处的指令包含在里面：向前回溯若干字节找一个能"对齐"到 at 的起点，
 * 再向后连续反汇编 count 条。
 */
export function disassembleAround(read: ReadByte, at: number, before: number, count: number): Instruction[] {
  at &= 0xffff;
  let bestStart = at, bestN = 0;
  for (let back = Math.min(before * 6, at); back > 0; back--) {
    const s = (at - back) & 0xffff;
    let p = s, n = 0;
    while (((at - p) & 0xffff) > 0 && ((at - p) & 0xffff) <= back && n < 64) {
      const ins = disassemble(read, p);
      p = (p + ins.length) & 0xffff;
      n++;
    }
    if (p === at && n > bestN && n <= before + 2) { bestStart = s; bestN = n; }
    if (bestN >= before) break;
  }
  const out: Instruction[] = [];
  let p = bestStart;
  while (out.length < count) {
    const ins = disassemble(read, p);
    out.push(ins);
    p = (p + ins.length) & 0xffff;
  }
  return out;
}
