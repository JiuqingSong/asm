import { describe, it, expect } from 'vitest';
import { CPU, AX, BX, CX, DX, SP, SI, DI, CS, DS } from '../src/cpu/cpu.ts';

// 386 的保护模式和分页：真机测试集（SingleStepTests/80386）只有实模式，这里用手写的机器码检查
// 32 位代码段、平坦内存、回到实模式、分页和缺页异常。

/** 平坦模型的 GDT：08 32 位代码、10 32 位数据（4GB），18 16 位代码、20 16 位数据（64KB） */
const GDT = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0xff, 0xff, 0, 0, 0, 0x9a, 0xcf, 0,
  0xff, 0xff, 0, 0, 0, 0x92, 0xcf, 0,
  0xff, 0xff, 0, 0, 0, 0x9a, 0x00, 0,
  0xff, 0xff, 0, 0, 0, 0x92, 0x00, 0,
];

/** 实模式开头（2000h）：LIDT、LGDT，打开 PE，远跳转到 08:201C 的 32 位代码 */
const REAL = [
  0x0f, 0x01, 0x1e, 0x08, 0x11,             // 2000 lidt [1108h]
  0x0f, 0x01, 0x16, 0x00, 0x11,             // 2005 lgdt [1100h]
  0x0f, 0x20, 0xc0,                         // 200A mov eax, cr0
  0x66, 0x83, 0xc8, 0x01,                   // 200D or eax, 1
  0x0f, 0x22, 0xc0,                         // 2011 mov cr0, eax
  0x66, 0xea, 0x1c, 0x20, 0x00, 0x00, 0x08, 0x00, // 2014 jmp 08:0000201C
];

/** 32 位代码的开头（201Ch 起，15 字节）：装入数据段，设置 ESP */
const PM32_SETUP = [
  0x66, 0xb8, 0x10, 0x00,                   // mov ax, 10h
  0x8e, 0xd8, 0x8e, 0xc0, 0x8e, 0xd0,       // mov ds/es/ss, ax
  0xbc, 0x00, 0x00, 0x20, 0x00,             // mov esp, 200000h
];

function machine(code32: number[], idt?: (cpu: CPU) => void): CPU {
  const c = new CPU();
  c.is386 = true;
  c.setA20(true);
  c.mem.set(GDT, 0x1000);
  c.mem.set([0x27, 0x00, 0x00, 0x10, 0x00, 0x00], 0x1100); // GDTR：界限 27h，基址 1000h
  c.mem.set([0x7f, 0x00, 0x00, 0x30, 0x00, 0x00], 0x1108); // IDTR：界限 7Fh，基址 3000h
  c.mem.set(REAL, 0x2000);
  c.mem.set([...PM32_SETUP, ...code32], 0x201c);
  idt?.(c);
  c.s[CS] = 0; c.ip = 0x2000;
  c.setFlags(0x0002);
  for (let k = 0; k < 10000 && !c.halted; k++) c.step();
  return c;
}

describe('386 保护模式', () => {
  it('32 位代码段：平坦内存、32 位运算、SIB 寻址、MOVZX', () => {
    const c = machine([
      0xb8, 0x78, 0x56, 0x34, 0x12,             // mov eax, 12345678h
      0xa3, 0x00, 0x00, 0x10, 0x00,             // mov [100000h], eax
      0x8b, 0x1d, 0x00, 0x00, 0x10, 0x00,       // mov ebx, [100000h]
      0x50, 0x5a,                               // push eax / pop edx
      0x0f, 0xb6, 0xc8,                         // movzx ecx, al
      0x8d, 0x34, 0x8d, 0x00, 0x10, 0x00, 0x00, // lea esi, [ecx*4+1000h]
      0xf4,                                     // hlt
    ]);
    expect(c.protectedMode).toBe(true);
    expect(c.cBig[CS]).toBe(1);
    expect(c.r32(AX)).toBe(0x12345678);
    expect(c.r32(BX)).toBe(0x12345678);
    expect(c.r32(DX)).toBe(0x12345678);
    expect(c.r32(CX)).toBe(0x78);
    expect(c.r32(SI)).toBe(0x78 * 4 + 0x1000);
    expect(c.r32(SP)).toBe(0x200000);
    expect(Array.from(c.mem.subarray(0x100000, 0x100004))).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(Array.from(c.mem.subarray(0x200000 - 4, 0x200000))).toEqual([0x78, 0x56, 0x34, 0x12]); // PUSH 压了 4 字节
  });

  it('从 32 位保护模式回到实模式（16 位代码段 → 清 PE → 远跳转）', () => {
    const c = machine([
      0xb8, 0x00, 0x00, 0xcd, 0xab,             // mov eax, ABCD0000h
      0xea, 0x37, 0x20, 0x00, 0x00, 0x18, 0x00, // jmp 18:2037（16 位代码段）
      // 2037：16 位保护模式
      0xb8, 0x20, 0x00,                         // mov ax, 20h
      0x8e, 0xd8, 0x8e, 0xc0, 0x8e, 0xd0,       // mov ds/es/ss, ax
      0x0f, 0x20, 0xc0,                         // mov eax, cr0
      0x66, 0x83, 0xe0, 0xfe,                   // and eax, -2
      0x0f, 0x22, 0xc0,                         // mov cr0, eax
      0xea, 0x4f, 0x20, 0x00, 0x00,             // jmp 0000:204F
      // 204F：实模式
      0x31, 0xc0, 0x8e, 0xd8,                   // xor ax, ax / mov ds, ax
      0xf4,
    ]);
    expect(c.protectedMode).toBe(false);
    expect(c.s[CS]).toBe(0);
    expect(c.ip).toBe(0x2054);
    expect(c.r[AX]).toBe(0);
    expect(c.cBig[CS]).toBe(0);
    expect(c.s[DS]).toBe(0);
  });

  it('分页：页目录、页表、写访问位和脏位，缺页异常经 32 位中断门、CR2', () => {
    const c = machine([
      0xb8, 0x00, 0x00, 0x01, 0x00,             // mov eax, 10000h
      0x0f, 0x22, 0xd8,                         // mov cr3, eax
      0x0f, 0x20, 0xc0,                         // mov eax, cr0
      0x0d, 0x00, 0x00, 0x00, 0x80,             // or eax, 80000000h
      0x0f, 0x22, 0xc0,                         // mov cr0, eax
      0xc7, 0x05, 0x04, 0x00, 0x00, 0x80, 0xbe, 0xba, 0xfe, 0xca, // mov dword [80000004h], CAFEBABEh
      0x8b, 0x3d, 0x04, 0x00, 0x10, 0x00,       // mov edi, [100004h]
      0xa1, 0x00, 0x00, 0x00, 0x90,             // mov eax, [90000000h] → 缺页
      0xf4,
    ], c => {
      // 页目录 10000h：0~4MB 恒等映射（页表 11000h）；80000000h 起的 4MB 映射到页表 12000h（第 0 页 → 物理 100000h）
      const w32 = (a: number, v: number) => { for (let k = 0; k < 4; k++) c.mem[a + k] = (v >>> (8 * k)) & 0xff; };
      w32(0x10000, 0x11000 | 3);
      w32(0x10000 + 0x200 * 4, 0x12000 | 3);
      for (let i = 0; i < 1024; i++) w32(0x11000 + i * 4, (i * 0x1000) | 3);
      w32(0x12000, 0x100000 | 3);
      // IDT 3000h：14 号是 32 位中断门，处理程序在 2100h
      c.mem.set([0x00, 0x21, 0x08, 0x00, 0x00, 0x8e, 0x00, 0x00], 0x3000 + 14 * 8);
      c.mem.set([0x5b, 0x0f, 0x20, 0xd1, 0xf4], 0x2100); // pop ebx（错误码）/ mov ecx, cr2 / hlt
    });
    expect(c.r32(DI)).toBe(0xcafebabe);
    expect(Array.from(c.mem.subarray(0x100004, 0x100008))).toEqual([0xbe, 0xba, 0xfe, 0xca]);
    expect(c.r32(BX)).toBe(0);                  // 错误码：页不存在、读、0 级
    expect(c.r32(CX)).toBe(0x90000000);         // CR2
    expect(c.mem[0x10000 + 0x200 * 4] & 0x20).toBe(0x20); // 页目录项：已访问
    expect(c.mem[0x12000] & 0x60).toBe(0x60);   // 页表项：已访问、已写
    expect(c.ip).toBe(0x2105);
  });
});
