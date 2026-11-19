// 8086/8088、80286、80386 反汇编器：机器码 -> MASM 风格的文本
//
// 输出的文字尽量能被本项目的汇编器（以及 MASM）重新汇编成同样的机器码，
// 跳转目标是同一段内的偏移地址（target 字段），界面上可以换成源码中的标号。
// 386 的指令（66h/67h 前缀、32 位寄存器、SIB 寻址、0F 开头的新指令）只在 is386 时识别；
// code32 表示当前是 32 位代码段（操作数和地址默认 32 位）。

const R16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const R32 = ['EAX', 'ECX', 'EDX', 'EBX', 'ESP', 'EBP', 'ESI', 'EDI'];
const R8 = ['AL', 'CL', 'DL', 'BL', 'AH', 'CH', 'DH', 'BH'];
const SREG = ['ES', 'CS', 'SS', 'DS', 'FS', 'GS', '?', '?'];
const EA = ['BX+SI', 'BX+DI', 'BP+SI', 'BP+DI', 'SI', 'DI', 'BP', 'BX'];
const ALU = ['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'CMP'];
const SHIFT = ['ROL', 'ROR', 'RCL', 'RCR', 'SHL', 'SHR', 'SETMO', 'SAR'];
const GRP3 = ['TEST', 'TEST', 'NOT', 'NEG', 'MUL', 'IMUL', 'DIV', 'IDIV'];
const JCC = ['JO', 'JNO', 'JB', 'JAE', 'JE', 'JNE', 'JBE', 'JA', 'JS', 'JNS', 'JP', 'JNP', 'JL', 'JGE', 'JLE', 'JG'];
const SETCC = JCC.map(j => 'SET' + j.slice(1));

/** 十六进制数，MASM 写法：以字母开头时前面补 0，后面加 h */
export function hexNum(v: number, digits = 0): string {
  let s = (v >>> 0).toString(16).toUpperCase();
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

/** 反汇编的 CPU 型号：is286 时按 186/286 解释 0Fh、60h~6Fh、C0h/C1h、C8h/C9h 等；is386 时再加上 386 的指令 */
export interface DisasmMode { is286?: boolean; is386?: boolean; code32?: boolean }

function modeOf(m: boolean | DisasmMode | undefined): DisasmMode {
  if (typeof m === 'object') return { ...m, is286: m.is286 || m.is386 };
  return { is286: !!m };
}

export function disassemble(read: ReadByte, start: number, cpu: boolean | DisasmMode = false): Instruction {
  const mode = modeOf(cpu);
  const is386 = !!mode.is386, cpu286 = !!mode.is286;
  const ipMask = mode.code32 ? 0xffffffff : 0xffff;
  let p = (start & ipMask) >>> 0;
  const bytes: number[] = [];
  const next = () => { const b = read(p) & 0xff; bytes.push(b); p = ((p + 1) & ipMask) >>> 0; return b; };
  const next16 = () => { const lo = next(); return lo | (next() << 8); };
  const next32 = () => { const lo = next16(); return (lo | (next16() << 16)) >>> 0; };
  const sx8 = (v: number) => (v & 0x80 ? v - 0x100 : v);

  let segOvr = -1;
  let rep = '';
  let lock = false;
  let o32 = !!mode.code32, a32 = !!mode.code32;
  let op: number;
  for (;;) {
    op = next();
    if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { segOvr = (op >> 3) & 3; continue; }
    if (op === 0xf2 || op === 0xf3) { rep = op === 0xf3 ? 'REP' : 'REPNE'; continue; }
    if (op === 0xf0 || (op === 0xf1 && !is386)) { lock = true; continue; }
    if (is386 && (op === 0x64 || op === 0x65)) { segOvr = op - 0x60; continue; }
    if (is386 && op === 0x66) { o32 = !mode.code32; continue; }
    if (is386 && op === 0x67) { a32 = !mode.code32; continue; }
    break;
  }
  if (bytes.length > (is386 ? 14 : 8)) {
    // 一长串前缀：只把第一个当作一条指令
    p = ((start + 1) & ipMask) >>> 0;
    bytes.length = 1;
    return finish('DB', [hexNum(bytes[0], 2)], { undocumented: true });
  }
  const RW = o32 ? R32 : R16;
  const wsz = o32 ? 'DWORD' : 'WORD';
  const nextW = () => (o32 ? next32() : next16());
  const sfx = o32 ? 'D' : 'W';

  let mod = 0, reg = 0, rm = 0, memText = '';
  let segUsed = false;
  const dispText = (d: number, digits: number) => d < 0 ? `-${hexNum(-d, digits)}` : `+${hexNum(d, digits)}`;
  const modrm = () => {
    const b = next();
    mod = b >> 6; reg = (b >> 3) & 7; rm = b & 7;
    if (mod === 3) return;
    if (a32) { modrm32(); return; }
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
    if (mod === 1 && disp !== 0) t += dispText(disp, 2);
    else if (mod === 1 && rm !== 6) t += `+${hexNum(0, 2)}`; // [BP] 本身就要带 8 位位移 0
    else if (mod === 2) t += `+${hexNum(disp, 4)}`;
    base = `[${t}]`;
    if (segOvr >= 0) { base = `${SREG[segOvr]}:${base}`; segUsed = true; }
    memText = base;
  };
  const modrm32 = () => {
    let t = '';
    if (rm === 4) {
      const sib = next();
      const sc = sib >> 6, idx = (sib >> 3) & 7, base = sib & 7;
      const parts: string[] = [];
      if (!(base === 5 && mod === 0)) parts.push(R32[base]);
      if (idx !== 4) parts.push(R32[idx] + (sc ? '*' + (1 << sc) : ''));
      t = parts.join('+');
      if (base === 5 && mod === 0) { const d = next32(); t += (t ? '+' : '') + hexNum(d, 8); }
    } else if (rm === 5 && mod === 0) t = hexNum(next32(), 8);
    else t = R32[rm];
    if (mod === 1) t += dispText(sx8(next()), 2);
    else if (mod === 2) t += dispText(next32() | 0, 8);
    memText = `[${t}]`;
    if (segOvr >= 0) { memText = `${SREG[segOvr]}:${memText}`; segUsed = true; }
  };
  /** r/m 操作数；needPtr 为真时在内存操作数前加 BYTE/WORD/DWORD PTR */
  const rmOp = (w: boolean, needPtr: boolean, ptr = w ? wsz : 'BYTE') => {
    if (mod === 3) return (w ? RW : R8)[rm];
    return needPtr ? `${ptr} PTR ${memText}` : memText;
  };
  const rm16 = (needPtr: boolean) => (mod === 3 ? R16[rm] : needPtr ? `WORD PTR ${memText}` : memText);
  const regOp = (w: boolean) => (w ? RW : R8)[reg];
  const imm = (w: boolean) => (w ? (o32 ? hexNum(next32(), 8) : hexNum(next16(), 4)) : hexNum(next(), 2));
  const acc = (w: boolean) => (w ? RW[0] : 'AL');

  function finish(mnemonic: string, ops: string[], extra: Partial<Instruction> = {}): Instruction {
    const pre: string[] = [];
    if (lock) pre.push('LOCK');
    if (rep) pre.push(rep);
    const text = [...pre, mnemonic].join(' ') + (ops.length ? ' ' + ops.join(',') : '');
    return { offset: (start & ipMask) >>> 0, length: bytes.length, bytes: bytes.slice(), text, mnemonic, ...extra };
  }
  const tmask = (v: number) => (o32 ? v >>> 0 : v & 0xffff);
  const rel8 = () => { const d = sx8(next()); return tmask(p + d); };
  const relW = () => { const d = o32 ? next32() | 0 : (next16() << 16) >> 16; return tmask(p + d); };
  const tHex = (t: number) => hexNum(t, o32 || t > 0xffff ? 8 : 4);

  if (cpu286) {
    switch (op) {
      case 0x0f: {
        const op2 = next();
        if (op2 === 0x01) {
          modrm();
          const names = ['SGDT', 'SIDT', 'LGDT', 'LIDT', 'SMSW', '', 'LMSW', ''];
          if (!names[reg] || (reg < 4 && mod === 3)) break;
          return finish(names[reg], [reg >= 4 ? rm16(false) : memText]);
        }
        if (op2 === 0x00) {
          modrm();
          const names = ['SLDT', 'STR', 'LLDT', 'LTR', 'VERR', 'VERW', '', ''];
          if (!names[reg]) break;
          return finish(names[reg], [rm16(false)]);
        }
        if (op2 === 0x02 || op2 === 0x03) { modrm(); return finish(op2 === 2 ? 'LAR' : 'LSL', [RW[reg], rm16(false)]); }
        if (op2 === 0x06) return finish('CLTS', []);
        if (op2 === 0x05 && !is386) return finish('LOADALL', [], { undocumented: true });
        if (is386) { const r = op0F386(op2); if (r) return r; }
        break;
      }
      case 0x60: return finish('PUSHA' + (o32 ? 'D' : ''), []);
      case 0x61: return finish('POPA' + (o32 ? 'D' : ''), []);
      case 0x62: modrm(); return finish('BOUND', [RW[reg], memText]);
      case 0x63: modrm(); return finish('ARPL', [rm16(false), R16[reg]]);
      case 0x68: return finish('PUSH', [imm(true)]);
      case 0x6a: return finish('PUSH', [signedImm(sx8(next()))]);
      case 0x69: case 0x6b: {
        modrm();
        const a = rmOp(true, false);
        return finish('IMUL', [RW[reg], a, op === 0x69 ? imm(true) : signedImm(sx8(next()))]);
      }
      case 0x6c: case 0x6d: return finish(op & 1 ? 'INS' + sfx : 'INSB', []);
      case 0x6e: case 0x6f: return finish(op & 1 ? 'OUTS' + sfx : 'OUTSB', []);
      case 0xc0: case 0xc1: {
        const w = op === 0xc1;
        modrm();
        const target = rmOp(w, true);
        return finish(SHIFT[reg === 6 ? 4 : reg], [target, hexNum(next(), 2)]);
      }
      case 0xc8: { const size = next16(); const level = next(); return finish('ENTER', [hexNum(size, 4), hexNum(level, 2)]); }
      case 0xc9: return finish('LEAVE', []);
    }
    if (op === 0x0f || (op >= 0x60 && op <= 0x6f)) return finish('DB', bytes.map(b => hexNum(b, 2)), { undocumented: true }); // 无效操作码
  }

  /** 386 的 0F 开头的指令 */
  function op0F386(op2: number): Instruction | null {
    if (op2 >= 0x80 && op2 <= 0x8f) { const t = relW(); return finish(JCC[op2 & 0xf], [tHex(t)], { target: t, form: 'near', isJump: true, conditional: true }); }
    if (op2 >= 0x90 && op2 <= 0x9f) { modrm(); return finish(SETCC[op2 & 0xf], [rmOp(false, true)]); }
    if (op2 >= 0x20 && op2 <= 0x26 && op2 !== 0x25) {
      const b = next(), n = (b >> 3) & 7, g = R32[b & 7];
      const special = (op2 & 1 ? 'DR' : op2 >= 0x24 ? 'TR' : 'CR') + n;
      return finish('MOV', op2 & 2 ? [special, g] : [g, special]);
    }
    switch (op2) {
      case 0xa0: return finish('PUSH', ['FS']);
      case 0xa1: return finish('POP', ['FS']);
      case 0xa8: return finish('PUSH', ['GS']);
      case 0xa9: return finish('POP', ['GS']);
      case 0xa3: case 0xab: case 0xb3: case 0xbb:
        modrm(); return finish(['BT', 'BTS', 'BTR', 'BTC'][(op2 >> 3) & 3], [rmOp(true, false), regOp(true)]);
      case 0xba: modrm(); if (reg < 4) return null; return finish(['BT', 'BTS', 'BTR', 'BTC'][reg & 3], [rmOp(true, true), hexNum(next(), 2)]);
      case 0xa4: case 0xac: modrm(); { const d = rmOp(true, false), s = regOp(true); return finish(op2 === 0xa4 ? 'SHLD' : 'SHRD', [d, s, hexNum(next(), 2)]); }
      case 0xa5: case 0xad: modrm(); return finish(op2 === 0xa5 ? 'SHLD' : 'SHRD', [rmOp(true, false), regOp(true), 'CL']);
      case 0xaf: modrm(); return finish('IMUL', [regOp(true), rmOp(true, false)]);
      case 0xb2: case 0xb4: case 0xb5: modrm(); return finish(op2 === 0xb2 ? 'LSS' : op2 === 0xb4 ? 'LFS' : 'LGS', [RW[reg], memText]);
      case 0xb6: case 0xbe: modrm(); return finish(op2 === 0xb6 ? 'MOVZX' : 'MOVSX', [RW[reg], rmOp(false, true)]);
      case 0xb7: case 0xbf: modrm(); return finish(op2 === 0xb7 ? 'MOVZX' : 'MOVSX', [RW[reg], rm16(true)]);
      case 0xbc: case 0xbd: modrm(); return finish(op2 === 0xbc ? 'BSF' : 'BSR', [RW[reg], rmOp(true, false)]);
    }
    return null;
  }

  // ---- 00-3F：算术逻辑运算 ----
  if (op < 0x40 && (op & 7) < 6) {
    const alu = ALU[op >> 3], w = (op & 1) === 1;
    switch (op & 7) {
      case 0: case 1: modrm(); return finish(alu, [rmOp(w, false), regOp(w)]);
      case 2: case 3: modrm(); return finish(alu, [regOp(w), rmOp(w, false)]);
      case 4: return finish(alu, ['AL', imm(false)]);
      case 5: return finish(alu, [acc(true), imm(true)]);
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
  if (op >= 0x40 && op < 0x60) return finish(['INC', 'DEC', 'PUSH', 'POP'][(op - 0x40) >> 3], [RW[op & 7]]);
  if (op >= 0x60 && op < 0x80) {
    const t = rel8();
    return finish(JCC[op & 0xf], [tHex(t)], { target: t, form: 'short', isJump: true, conditional: true, undocumented: op < 0x70 });
  }
  switch (op) {
    case 0x80: case 0x81: case 0x82: case 0x83: {
      const w = (op & 1) === 1;
      modrm();
      const v = op === 0x81 ? imm(true) : op === 0x83 ? signedImm(sx8(next())) : hexNum(next(), 2);
      return finish(ALU[reg], [rmOp(w, true), v], { undocumented: op === 0x82 });
    }
    case 0x84: case 0x85: { const w = op === 0x85; modrm(); return finish('TEST', mod === 3 ? [regOp(w), rmOp(w, false)] : [rmOp(w, false), regOp(w)]); }
    case 0x86: case 0x87: { const w = op === 0x87; modrm(); return finish('XCHG', mod === 3 ? [regOp(w), rmOp(w, false)] : [rmOp(w, false), regOp(w)]); }
    case 0x88: case 0x89: { const w = op === 0x89; modrm(); return finish('MOV', [rmOp(w, false), regOp(w)]); }
    case 0x8a: case 0x8b: { const w = op === 0x8b; modrm(); return finish('MOV', [regOp(w), rmOp(w, false)]); }
    case 0x8c: modrm(); return finish('MOV', [mod === 3 ? RW[rm] : memText, SREG[is386 ? reg : reg & 3]], { undocumented: reg > (is386 ? 5 : 3) });
    case 0x8d: modrm(); return finish('LEA', [RW[reg], mod === 3 ? RW[rm] : memText], { undocumented: mod === 3 });
    case 0x8e: modrm(); return finish('MOV', [SREG[is386 ? reg : reg & 3], rm16(false)], { undocumented: reg > (is386 ? 5 : 3) });
    case 0x8f: modrm(); return finish('POP', [rmOp(true, true)], { undocumented: reg !== 0 });
    case 0x90: return finish('NOP', []);
    case 0x98: return finish(o32 ? 'CWDE' : 'CBW', []);
    case 0x99: return finish(o32 ? 'CDQ' : 'CWD', []);
    case 0x9a: {
      const o = nextW(), s = next16();
      return finish('CALL', [`${hexNum(s, 4)}:${tHex(o)}`], { target: o, targetSeg: s, form: 'far', isCall: true });
    }
    case 0x9b: return finish('WAIT', []);
    case 0x9c: return finish(o32 ? 'PUSHFD' : 'PUSHF', []);
    case 0x9d: return finish(o32 ? 'POPFD' : 'POPF', []);
    case 0x9e: return finish('SAHF', []);
    case 0x9f: return finish('LAHF', []);
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
      const addr = a32 ? next32() : next16();
      const m = `${SREG[segOvr >= 0 ? segOvr : 3]}:[${hexNum(addr, a32 ? 8 : 4)}]`;
      segUsed = true;
      const a = acc((op & 1) === 1);
      return finish('MOV', op < 0xa2 ? [a, m] : [m, a]);
    }
    case 0xa8: return finish('TEST', ['AL', imm(false)]);
    case 0xa9: return finish('TEST', [acc(true), imm(true)]);
  }
  if (op >= 0x91 && op <= 0x97) return finish('XCHG', [RW[0], RW[op & 7]]);
  if (op >= 0xa4 && op <= 0xaf && op !== 0xa8 && op !== 0xa9) {
    const names: Record<number, string> = { 0xa4: 'MOVS', 0xa6: 'CMPS', 0xaa: 'STOS', 0xac: 'LODS', 0xae: 'SCAS' };
    const base = names[op & 0xfe];
    const w = (op & 1) === 1;
    if ((op & 0xfe) === 0xa6 || (op & 0xfe) === 0xae) rep = rep === 'REP' ? 'REPE' : rep;
    const si = a32 ? 'ESI' : 'SI', di = a32 ? 'EDI' : 'DI';
    if ((segOvr >= 0 && (base === 'MOVS' || base === 'CMPS' || base === 'LODS')) || a32) {
      // 有段超越（或 32 位地址）时只能写成带操作数的形式
      segUsed = true;
      const sz = w ? wsz : 'BYTE';
      const src = `${sz} PTR ${SREG[segOvr >= 0 ? segOvr : 3]}:[${si}]`, dst = `${sz} PTR ES:[${di}]`;
      if (base === 'LODS') return finish('LODS', [src]);
      if (base === 'STOS' || base === 'SCAS') return finish(base, [dst]);
      return finish(base, [dst, src]);
    }
    return finish(base + (w ? sfx : 'B'), []);
  }
  if (op >= 0xb0 && op <= 0xb7) return finish('MOV', [R8[op & 7], imm(false)]);
  if (op >= 0xb8 && op <= 0xbf) return finish('MOV', [RW[op & 7], imm(true)]);
  switch (op) {
    case 0xc0: case 0xc2: { const n = next16(); return finish('RET', [hexNum(n, 4)], { isRet: true, undocumented: op === 0xc0 }); }
    case 0xc1: case 0xc3: return finish('RET', [], { isRet: true, undocumented: op === 0xc1 });
    case 0xc4: modrm(); return finish('LES', [RW[reg], mod === 3 ? RW[rm] : memText], { undocumented: mod === 3 });
    case 0xc5: modrm(); return finish('LDS', [RW[reg], mod === 3 ? RW[rm] : memText], { undocumented: mod === 3 });
    case 0xc6: modrm(); return finish('MOV', [rmOp(false, true), imm(false)], { undocumented: reg !== 0 });
    case 0xc7: modrm(); return finish('MOV', [rmOp(true, true), imm(true)], { undocumented: reg !== 0 });
    case 0xc8: case 0xca: { const n = next16(); return finish('RETF', [hexNum(n, 4)], { isRet: true, undocumented: op === 0xc8 }); }
    case 0xc9: case 0xcb: return finish('RETF', [], { isRet: true, undocumented: op === 0xc9 });
    case 0xcc: return finish('INT', ['3'], { isCall: true });
    case 0xcd: return finish('INT', [hexNum(next(), 2)], { isCall: true });
    case 0xce: return finish('INTO', [], { isCall: true });
    case 0xcf: return finish(o32 ? 'IRETD' : 'IRET', [], { isRet: true });
    case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const w = (op & 1) === 1;
      modrm();
      return finish(SHIFT[reg], [rmOp(w, true), op & 2 ? 'CL' : '1'], { undocumented: reg === 6 });
    }
    case 0xd4: { const b = next(); return finish('AAM', b === 10 ? [] : [hexNum(b, 2)]); }
    case 0xd5: { const b = next(); return finish('AAD', b === 10 ? [] : [hexNum(b, 2)]); }
    case 0xd6: return finish('SALC', [], { undocumented: true });
    case 0xd7:
      if (segOvr >= 0 || a32) { segUsed = true; return finish('XLAT', [`BYTE PTR ${SREG[segOvr >= 0 ? segOvr : 3]}:[${a32 ? 'EBX' : 'BX'}]`]); }
      return finish('XLATB', []);
  }
  if (op >= 0xd8 && op <= 0xdf) {
    modrm();
    return finish('ESC', [hexNum(((op & 7) << 3) | reg, 2), mod === 3 ? R16[rm] : memText], { undocumented: true });
  }
  switch (op) {
    case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
      const t = rel8();
      return finish(['LOOPNE', 'LOOPE', 'LOOP', a32 ? 'JECXZ' : 'JCXZ'][op - 0xe0], [tHex(t)], { target: t, form: 'short', isJump: true, conditional: true });
    }
    case 0xe4: return finish('IN', ['AL', hexNum(next(), 2)]);
    case 0xe5: return finish('IN', [acc(true), hexNum(next(), 2)]);
    case 0xe6: return finish('OUT', [hexNum(next(), 2), 'AL']);
    case 0xe7: return finish('OUT', [hexNum(next(), 2), acc(true)]);
    case 0xe8: { const t = relW(); return finish('CALL', [tHex(t)], { target: t, form: 'near', isCall: true }); }
    case 0xe9: { const t = relW(); return finish('JMP', [tHex(t)], { target: t, form: 'near', isJump: true }); }
    case 0xea: {
      const o = nextW(), s = next16();
      return finish('JMP', [`${hexNum(s, 4)}:${tHex(o)}`], { target: o, targetSeg: s, form: 'far', isJump: true });
    }
    case 0xeb: { const t = rel8(); return finish('JMP', [`SHORT ${tHex(t)}`], { target: t, form: 'short', isJump: true }); }
    case 0xec: return finish('IN', ['AL', 'DX']);
    case 0xed: return finish('IN', [acc(true), 'DX']);
    case 0xee: return finish('OUT', ['DX', 'AL']);
    case 0xef: return finish('OUT', ['DX', acc(true)]);
    case 0xf1: return finish('ICEBP', [], { undocumented: true });
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
      const far = o32 ? 'FWORD' : 'DWORD';
      switch (reg) {
        case 0: return finish('INC', [rmOp(true, true)]);
        case 1: return finish('DEC', [rmOp(true, true)]);
        case 2: return finish('CALL', [rmOp(true, true)], { isCall: true });
        case 3: return finish('CALL', [mod === 3 ? RW[rm] : `${far} PTR ${memText}`], { isCall: true, form: 'far', undocumented: mod === 3 });
        case 4: return finish('JMP', [rmOp(true, true)], { isJump: true });
        case 5: return finish('JMP', [mod === 3 ? RW[rm] : `${far} PTR ${memText}`], { isJump: true, form: 'far', undocumented: mod === 3 });
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
 * 反汇编一段代码，使 at 处的指令包含在里面，前面大约有 before 条指令，一共 count 条。
 *
 * x86 的指令长短不一，往回找"前面的指令从哪里开始"没有唯一答案：从不同的字节开始解码，可能都能对齐到 at。
 * 做法是试遍前面几十个字节里的每个起点，挑最可信的一个：
 * - anchors 是已知的指令起点（执行过的指令、程序入口、引导扇区的 7C00）：路过的越多越可信；
 * - 解码出来的怪指令（没有文档的操作码、只能写成 DB 的字节）越少越可信；
 * - 再看回溯得多远：错位的解码通常几条以后就会"归位"，从更远处开始，靠近 at 的部分更可能是对的。
 * 选好以后只保留 at 前面的 before 条（所以从 7C00 到 at 有十几条指令时也不会把 7C00 那条挤掉）。
 */
export function disassembleAround(read: ReadByte, at: number, before: number, count: number, cpu: boolean | DisasmMode = false,
  anchors?: ReadonlySet<number>): Instruction[] {
  const mask = typeof cpu === 'object' && cpu.code32 ? 0xffffffff : 0xffff;
  const m = (v: number) => (v & mask) >>> 0;
  at = m(at);
  let bestPath: number[] = [], bestScore = -Infinity;
  if (before > 0) {
    for (let back = Math.min(before * 6 + 16, at); back > 0; back--) {
      const path: number[] = [];
      let p = m(at - back), weird = 0, hits = 0;
      while (m(at - p) > 0 && m(at - p) <= back && path.length < 128) {
        const ins = disassemble(read, p, cpu);
        path.push(p);
        if (anchors?.has(p)) hits++;
        p = m(p + ins.length);
        if (ins.undocumented || ins.mnemonic === 'DB') weird++;
      }
      if (p !== at) continue;
      // 只看最后 before 条里的怪指令（更前面的会被裁掉，不显示）
      let shownWeird = 0;
      for (const q of path.slice(-before)) { const ins = disassemble(read, q, cpu); if (ins.undocumented || ins.mnemonic === 'DB') shownWeird++; }
      const score = Math.min(hits, 64) * 1000 - shownWeird * 50 - weird + back * 0.01;
      if (score > bestScore) { bestScore = score; bestPath = path; }
    }
  }
  const out: Instruction[] = [];
  let p = bestPath.length ? bestPath[Math.max(0, bestPath.length - before)] : at;
  while (out.length < count) {
    const ins = disassemble(read, p, cpu);
    out.push(ins);
    p = m(p + ins.length);
  }
  return out;
}
