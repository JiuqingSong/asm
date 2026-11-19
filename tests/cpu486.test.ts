import { describe, it, expect } from 'vitest';
import { CPU, AX, BX, CX, DX, CS, ZF } from '../src/cpu/cpu.ts';

// 486 的新指令和标志位（实模式下用 66h 前缀执行 32 位操作）

function run(code: number[], is486 = true): CPU {
  const c = new CPU();
  c.is386 = true;
  c.is486 = is486;
  c.mem.set(code, 0x2000);
  c.mem.set([0x00, 0x30, 0x00, 0x00], 6 * 4);  // INT 6（无效操作码）→ 0000:3000
  c.mem[0x3000] = 0xf4;                         // hlt
  c.s[CS] = 0; c.ip = 0x2000;
  c.setFlags(0x0002);
  for (let k = 0; k < 1000 && !c.halted; k++) c.step();
  return c;
}

describe('486', () => {
  it('BSWAP、XADD', () => {
    const c = run([
      0x66, 0xb8, 0x78, 0x56, 0x34, 0x12,       // mov eax, 12345678h
      0x0f, 0xc8,                               // bswap eax
      0x66, 0xbb, 0x07, 0x00, 0x00, 0x00,       // mov ebx, 7
      0x66, 0xb9, 0x05, 0x00, 0x00, 0x00,       // mov ecx, 5
      0x66, 0x0f, 0xc1, 0xcb,                   // xadd ebx, ecx：ebx = 12，ecx = 7
      0xf4,
    ]);
    expect(c.r32(AX)).toBe(0x78563412);
    expect([c.r32(BX), c.r32(CX)]).toEqual([12, 7]);
    expect(c.ip).toBe(0x2019);
  });

  it('CMPXCHG：相等时写目标（ZF=1），不相等时装入累加器（ZF=0）', () => {
    const c = run([
      0x66, 0xb8, 0x01, 0x00, 0x00, 0x00,       // mov eax, 1
      0x66, 0xb9, 0x01, 0x00, 0x00, 0x00,       // mov ecx, 1
      0x66, 0xba, 0x09, 0x00, 0x00, 0x00,       // mov edx, 9
      0x66, 0x0f, 0xb1, 0xd1,                   // cmpxchg ecx, edx：eax = ecx → ecx = 9
      0x9c, 0x5b,                               // pushf / pop bx
      0x66, 0x0f, 0xb1, 0xd1,                   // 再来一次：eax(1) ≠ ecx(9) → eax = 9
      0x9c, 0x5e,                               // pushf / pop si
      0xf4,
    ]);
    expect(c.r32(CX)).toBe(9);
    expect(c.r32(AX)).toBe(9);
    expect(c.r[BX] & ZF).toBe(ZF);
    expect(c.r[6] & ZF).toBe(0);
  });

  it('CPUID 报告 GenuineIntel、家族 4；EFLAGS 的 AC 位、ID 位能改（386 不能）', () => {
    const code = [
      0x66, 0x9c, 0x66, 0x58,                   // pushfd / pop eax
      0x66, 0x0d, 0x00, 0x00, 0x24, 0x00,       // or eax, 240000h（AC + ID）
      0x66, 0x50, 0x66, 0x9d,                   // push eax / popfd
      0x66, 0x9c, 0x66, 0x5a,                   // pushfd / pop edx
      0xf4,
    ];
    const c4 = run(code);
    expect(c4.r32(DX) & 0x240000).toBe(0x240000);
    const c3 = run(code, false);
    expect(c3.r32(DX) & 0x240000).toBe(0);
    const id = run([0x66, 0x31, 0xc0, 0x0f, 0xa2, 0xf4]);                          // xor eax,eax / cpuid
    const s = (v: number) => String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
    expect(s(id.r32(BX)) + s(id.r32(DX)) + s(id.r32(CX))).toBe('GenuineIntel');
    const f = run([0x66, 0xb8, 0x01, 0x00, 0x00, 0x00, 0x0f, 0xa2, 0xf4]);           // mov eax,1 / cpuid
    expect((f.r32(AX) >> 8) & 0xf).toBe(4);
  });

  it('386 上这些指令是无效操作码（INT 6）', () => {
    for (const code of [[0x0f, 0xc8], [0x0f, 0xa2], [0x0f, 0xc1, 0xcb], [0x0f, 0xb1, 0xd1], [0x0f, 0x09]]) {
      const c = run([...code, 0xf4], false);
      expect(c.ip).toBe(0x3001);
    }
  });
});
