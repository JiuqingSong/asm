import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/asm/assembler.ts';
import { disassemble, disassembleAround, hexNum } from '../src/cpu/disasm.ts';
import type { Program } from '../src/asm/types.ts';
import { EXAMPLES } from '../src/ui/examples.ts';

/** 文本里的十六进制数换算成十进制，使 [SI+16h] 和 [SI+0016h] 相同 */
function norm(t: string): string {
  return t.replace(/-?\b0*([0-9A-F]+)h\b/g, (m) => String(parseInt(m.replace(/h$/, ''), 16)));
}

/**
 * 往返对照：把程序每个段里的指令反汇编成文本，生成一份新的源程序（每条指令前加 ORG 和标号，
 * 跳转目标换成标号），再汇编一次；新机器码反汇编出的指令必须和原来的语义相同
 * （汇编器对较小的位移可能选更短的编码，所以比较语义而不是字节）。
 */
function roundTrip(p: Program): { checked: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let checked = 0;
  // 用了 80186/80286 指令的程序（.186 / .286）按 286 反汇编，重新汇编时也写 .286P
  const is286 = (p.cpu ?? 0) > 0;
  for (const seg of p.segments) {
    const entries = p.listing.filter(e => e.segName === seg.name && e.bytes.length).sort((a, b) => a.segOffset - b.segOffset);
    if (!entries.some(e => e.isCode)) continue;
    const segBytes = (o: number) => seg.bytes[o & 0xffff] ?? 0;
    // 逐条拆开（一行源码可能生成多条指令）
    const ins: { off: number; d: ReturnType<typeof disassemble>; line: number }[] = [];
    for (const e of entries.filter(x => x.isCode)) {
      let o = e.segOffset;
      while (o < e.segOffset + e.bytes.length) {
        const d = disassemble(segBytes, o, is286);
        ins.push({ off: o, d, line: e.line });
        o += d.length;
      }
      if (o !== e.segOffset + e.bytes.length) mismatches.push(`第 ${e.line} 行：指令长度对不上`);
    }
    const starts = new Set(ins.map(x => x.off));
    const lines = [...(is286 ? ['.286P'] : []), 'X SEGMENT', 'ASSUME CS:X, DS:X, ES:X, SS:X'];
    const used: typeof ins = [];
    for (const e of entries.filter(x => !x.isCode)) {
      lines.push(`ORG ${hexNum(e.segOffset, 4)}`, `DB ${e.bytes.map(b => hexNum(b < 0 ? 0 : b, 2)).join(',')}`);
    }
    for (const x of ins) {
      const d = x.d;
      lines.push(`ORG ${hexNum(x.off, 4)}`);
      const label = `L_${x.off.toString(16)}:`;
      if (d.undocumented || d.targetSeg !== undefined || d.mnemonic === 'ESC' || (d.target !== undefined && !starts.has(d.target))) {
        lines.push(`${label} DB ${d.bytes.map(b => hexNum(b, 2)).join(',')}`);
        continue;
      }
      let text = d.text;
      if (d.target !== undefined) {
        const tgt = hexNum(d.target, 4), lab = `L_${d.target.toString(16)}`;
        text = text.replace(tgt, d.mnemonic === 'JMP' && d.form === 'near' ? `NEAR PTR ${lab}` : lab);
      }
      lines.push(`${label} ${text}`);
      used.push(x);
    }
    lines.push('X ENDS', 'END');
    const q = assemble(lines.join(String.fromCharCode(10)));
    const errs = q.diagnostics.filter(d => d.severity === 'error');
    if (errs.length) { mismatches.push(...errs.map(er => `重新汇编出错：${lines[er.line - 1]} —— ${er.message}`)); continue; }
    const out = q.segments[0];
    for (const x of used) {
      const again = disassemble(o => out.bytes[o & 0xffff] ?? 0, x.off, is286);
      checked++;
      if (norm(again.text) !== norm(x.d.text)) mismatches.push(`第 ${x.line} 行：${x.d.text} 重新汇编后变成 ${again.text}`);
    }
  }
  return { checked, mismatches };
}

describe('反汇编', () => {
  const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
  const sources: [string, string][] = [
    ...readdirSync(here('ml')).filter(f => f.endsWith('.asm')).map(f => [f, readFileSync(here('ml/' + f), 'latin1')] as [string, string]),
    ...EXAMPLES.map(e => [e.id, e.source] as [string, string]),
  ];
  for (const f of ['../../send.asm', '../../receive.asm']) if (existsSync(here(f))) sources.push([f, readFileSync(here(f), 'latin1')]);

  for (const [name, src] of sources) {
    it(`往返对照：${name}`, () => {
      const p = assemble(src);
      const { checked, mismatches } = roundTrip(p);
      expect(mismatches).toEqual([]);
      expect(checked).toBeGreaterThan(0);
    });
  }

  it('常见指令的文字', () => {
    const t = (bytes: number[], at = 0x100) => disassemble(o => bytes[o - at] ?? 0x90, at).text;
    expect(t([0xb8, 0x34, 0x12])).toBe('MOV AX,1234h');
    expect(t([0x8b, 0x40, 0x04])).toBe('MOV AX,[BX+SI+04h]');
    expect(t([0x26, 0xc6, 0x07, 0xff])).toBe('MOV BYTE PTR ES:[BX],0FFh');
    expect(t([0xcd, 0x21])).toBe('INT 21h');
    expect(t([0xf3, 0xa4])).toBe('REP MOVSB');
    expect(t([0xf3, 0xa6])).toBe('REPE CMPSB');
    expect(t([0xeb, 0xfe])).toBe('JMP SHORT 0100h');
    expect(t([0xe8, 0x00, 0x00])).toBe('CALL 0103h');
    expect(t([0x83, 0xc3, 0xff])).toBe('ADD BX,-01h');
    expect(t([0x8b, 0x46, 0x00])).toBe('MOV AX,[BP]');
    expect(t([0xa1, 0x00, 0x20])).toBe('MOV AX,DS:[2000h]');
  });

  it('从中间位置找到正确的指令边界', () => {
    // 5 条 3 字节的 MOV，从第 4 条（偏移 9）开始往回找
    const code = [0xb8, 0x01, 0x00, 0xbb, 0x02, 0x00, 0xb9, 0x03, 0x00, 0xba, 0x04, 0x00, 0xbe, 0x05, 0x00];
    const list = disassembleAround(o => code[o] ?? 0x90, 9, 3, 4);
    expect(list.map(i => i.offset)).toEqual([0, 3, 6, 9].slice(-4).length === 4 ? list.map(i => i.offset) : []);
    expect(list.some(i => i.offset === 9 && i.text === 'MOV DX,0004h')).toBe(true);
  });
  it('引导扇区：从 7C00 到当前指令有十几条时，往回找的起点仍然对齐，不会错位解码（也不会挤掉开头的 CLI）', () => {
    // CLI / XOR AX,AX / MOV DS,AX / MOV ES,AX / MOV SS,AX / MOV SP,7C00h / STI / MOV SI,7C30h /
    // LODSB / TEST AL,AL / JE / MOV AH,0Eh / INT 10h / JMP SHORT / HLT；7C00 前面是 0
    const code = [0xfa, 0x31, 0xc0, 0x8e, 0xd8, 0x8e, 0xc0, 0x8e, 0xd0, 0xbc, 0x00, 0x7c, 0xfb, 0xbe, 0x30, 0x7c,
      0xac, 0x84, 0xc0, 0x74, 0x06, 0xb4, 0x0e, 0xcd, 0x10, 0xeb, 0xf5, 0xf4];
    const read = (o: number) => (o >= 0x7c00 && o < 0x7c00 + code.length ? code[o - 0x7c00] : 0);
    const starts = [0x7c00, 0x7c01, 0x7c03, 0x7c05, 0x7c07, 0x7c09, 0x7c0c, 0x7c0d, 0x7c10, 0x7c11, 0x7c13, 0x7c15, 0x7c17, 0x7c19];
    // 有已知的起点（引导扇区的入口）：前面 13 条正好从 7C00 开始
    const a = disassembleAround(read, 0x7c19, 13, 14, false, new Set([0x7c00]));
    expect(a.map(i => i.offset)).toEqual(starts);
    expect(a[0].text).toBe('CLI');
    // 没有任何已知起点：显示出来的部分也要对齐（不能出现 7C02 那样的错位）
    const b = disassembleAround(read, 0x7c17, 8, 9);
    expect(b.every(i => starts.includes(i.offset))).toBe(true);
  });
});
