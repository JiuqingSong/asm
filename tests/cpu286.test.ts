import { describe, it, expect } from 'vitest';
import { disassemble } from '../src/cpu/disasm.ts';
import { CPU, AX, BX, CX, DX, SP, BP, SI, DI, CS, SS, DS, ES, CF, OF } from '../src/cpu/cpu.ts';

/** 在 1000:0100 放一段机器码，执行 n 条指令 */
function run(code: number[], is286: boolean, n: number, setup?: (c: CPU) => void): CPU {
  const c = new CPU();
  c.is286 = is286;
  c.mem.set(code, 0x10100);
  c.s[CS] = 0x1000; c.ip = 0x100;
  c.s[SS] = 0x2000; c.r[SP] = 0x1000;
  c.s[DS] = c.s[ES] = 0x3000;
  c.setFlags(0);
  setup?.(c);
  for (let k = 0; k < n; k++) c.step();
  return c;
}

describe('286 指令（CPU 选 286/386 时）', () => {
  it('PUSHA / POPA', () => {
    const c = run([0x60, 0x31, 0xc0, 0x31, 0xdb, 0x61], true, 4, c => { c.r[AX] = 1; c.r[CX] = 2; c.r[DX] = 3; c.r[BX] = 4; c.r[BP] = 5; c.r[SI] = 6; c.r[DI] = 7; });
    expect([c.r[AX], c.r[CX], c.r[DX], c.r[BX], c.r[SP], c.r[BP], c.r[SI], c.r[DI]]).toEqual([1, 2, 3, 4, 0x1000, 5, 6, 7]);
    expect(c.mem[0x20000 + 0x1000 - 10] | (c.mem[0x20000 + 0x1000 - 9] << 8)).toBe(0x1000); // 压入的是原来的 SP
  });

  it('PUSH 立即数、IMUL 三操作数、移位立即数次数', () => {
    // push 1234h / push -2 / pop ax / pop bx / imul cx,bx,-3 / imul dx,bx,7FFFh / shl bx,4
    const c = run([0x68, 0x34, 0x12, 0x6a, 0xfe, 0x58, 0x5b, 0x6b, 0xcb, 0xfd, 0x69, 0xd3, 0xff, 0x7f, 0xc1, 0xe3, 0x04], true, 7);
    expect(c.r[AX]).toBe(0xfffe);
    expect(c.r[CX]).toBe((0x1234 * -3) & 0xffff);
    expect(c.r[DX]).toBe((0x1234 * 0x7fff) & 0xffff);
    expect(c.flags & (CF | OF)).toBe(CF | OF);        // 结果超出 16 位
    expect(c.r[BX]).toBe(0x2340);
  });

  it('ENTER / LEAVE', () => {
    // enter 8,0 / leave
    const c = run([0xc8, 0x08, 0x00, 0x00, 0xc9], true, 2, c => { c.r[BP] = 0xbeef; });
    expect(c.r[BP]).toBe(0xbeef);
    expect(c.r[SP]).toBe(0x1000);
    const c2 = run([0xc8, 0x08, 0x00, 0x00], true, 1, c => { c.r[BP] = 0xbeef; });
    expect(c2.r[BP]).toBe(0x0ffe);
    expect(c2.r[SP]).toBe(0x0ffe - 8);
  });

  it('SMSW 读出 FFF0h；标志寄存器位 12~15 为 0', () => {
    // smsw ax / pushf / pop bx
    const c = run([0x0f, 0x01, 0xe0, 0x9c, 0x5b], true, 3);
    expect(c.r[AX]).toBe(0xfff0);
    expect(c.r[BX] & 0xf000).toBe(0);
  });

  it('LMSW 进入保护模式时报告"不支持"', () => {
    let msg = '';
    run([0xb8, 0x01, 0x00, 0x0f, 0x01, 0xf0], true, 2, c => { c.onUnsupported = m => { msg = m; }; });
    expect(msg).toMatch(/保护模式/);
  });

  it('无效操作码产生 6 号中断，返回地址指向这条指令', () => {
    const c = run([0x0f, 0xff], true, 1, c => { c.mem[6 * 4] = 0x00; c.mem[6 * 4 + 1] = 0x05; c.mem[6 * 4 + 2] = 0x00; c.mem[6 * 4 + 3] = 0x40; });
    expect([c.s[CS], c.ip]).toEqual([0x4000, 0x0500]);
    expect(c.mem[0x20000 + 0x1000 - 6] | (c.mem[0x20000 + 0x1000 - 5] << 8)).toBe(0x100);
  });

  it('INS / OUTS 带 REP', () => {
    const out: number[] = [];
    const c = run([0xf3, 0x6e], true, 3, c => {
      c.r[CX] = 3; c.r[SI] = 0; c.r[DX] = 0x80;
      c.mem.set([7, 8, 9], 0x30000);
      c.io = { in8: () => 0, out8: (_p, v) => { out.push(v); } };
    });
    expect(out).toEqual([7, 8, 9]);
    expect(c.r[CX]).toBe(0);
  });

  it('8088 上这些操作码仍然是 8086 的含义', () => {
    // 8088：0F = POP CS，60h = JO 的别名，PUSHF 的位 12~15 为 1
    const c = run([0x9c, 0x5b], false, 2);
    expect(c.r[BX] & 0xf000).toBe(0xf000);
    const d = run([0x0f], false, 1, c => { c.mem[0x20000 + 0x1000] = 0x34; c.mem[0x20000 + 0x1001] = 0x12; });
    expect(d.s[CS]).toBe(0x1234);
  });

  it('反汇编：选 286 时按 286 的含义显示', () => {
    const show = (bytes: number[], is286: boolean) => disassemble(o => bytes[o] ?? 0, 0, is286).text;
    expect(show([0x0f, 0x01, 0xe0], true)).toBe('SMSW AX');
    expect(show([0x0f, 0x01, 0xe0], false)).toBe('POP CS');
    expect(show([0x60], true)).toBe('PUSHA');
    expect(show([0x6b, 0xcb, 0xfd], true)).toBe('IMUL CX,BX,-03h');
    expect(show([0xc1, 0xe3, 0x04], true)).toBe('SHL BX,04h');
    expect(show([0xc8, 0x08, 0x00, 0x00], true)).toBe('ENTER 0008h,00h');
    expect(show([0x68, 0x34, 0x12], true)).toBe('PUSH 1234h');
  });
});
