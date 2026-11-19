import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';
import { Disk, blankHardDisk } from '../src/machine/disk.ts';

// 汇编器的 .186 / .286 / .286P：编码本身和 MASM 6.11 逐字节对照见 tests/ml/i286.asm（tools/ml-compare.ts）

const errors = (src: string) => assemble(src).diagnostics.filter(d => d.severity === 'error').map(d => d.message);

describe('80186/80286 指令（.186 / .286 / .286P）', () => {
  it('没写 CPU 伪指令时 186 的指令报错并说明怎么做', () => {
    const e = errors('.model small\n.code\nstart:\n pusha\n push 5\n shl ax, 4\n mov ax, 4c00h\n int 21h\nend start');
    expect(e).toHaveLength(3);
    expect(e[0]).toMatch(/80186.*\.186/);
    expect(e[1]).toMatch(/PUSH 立即数/);
    expect(e[2]).toMatch(/移位次数只能是 1 或 CL/);
  });

  it('.186 能用 186 的指令，不能用 286 的', () => {
    const e = errors('.186\n.model small\n.code\nstart:\n pusha\n imul ax, 5\n smsw ax\n mov ax, 4c00h\n int 21h\nend start');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/SMSW.*80286.*\.286/);
  });

  it('.286 不能用特权指令，.286P 可以', () => {
    const src = (dir: string) => `${dir}\n.model small\n.code\nstart:\n smsw ax\n lmsw ax\n clts\n mov ax, 4c00h\n int 21h\nend start`;
    expect(errors(src('.286'))).toHaveLength(2);
    expect(errors(src('.286P'))).toHaveLength(0);
  });

  it('8086 方式下 INS、STR 这些名字还可以当变量名', () => {
    const p = assemble('.model small\n.data\nins db 1\nstr dw 2\n.code\nstart:\n mov al, ins\n mov ax, 4c00h\n int 21h\nend start');
    expect(p.ok).toBe(true);
    expect(p.cpu).toBe(0);
  });

  it('程序记下用到的最高一级指令', () => {
    expect(assemble('.286\n.model small\n.code\nstart:\n insw\n mov ax, 4c00h\n int 21h\nend start').cpu).toBe(1);
    expect(assemble('.286P\n.model small\n.code\nstart:\n str ax\n mov ax, 4c00h\n int 21h\nend start').cpu).toBe(2);
  });

  it('用 IDENTIFY 读硬盘的信息（REP INSW、SHR AL, 4）', () => {
    const p = assemble(`.286
.model small
.data
id db 512 dup (0)
hex db '0123456789ABCDEF'
res db 8 dup ('$')
.code
start:
 mov ax, @data
 mov ds, ax
 mov es, ax
 mov dx, 1f6h
 mov al, 0a0h
 out dx, al
 mov dx, 1f7h
 mov al, 0ech
 out dx, al
wait1: in al, dx
 test al, 80h
 jnz wait1
 test al, 8
 jz wait1
 mov dx, 1f0h
 mov di, offset id
 mov cx, 256
 cld
 rep insw
 mov al, id[0]          ; 字 0 的低字节 40h：固定硬盘
 mov bx, offset hex
 mov ah, al
 shr al, 4
 xlat
 mov res[0], al
 mov al, ah
 and al, 0fh
 xlat
 mov res[1], al
 mov dx, offset res
 mov ah, 9
 int 21h
 mov ax, 4c00h
 int 21h
end start`);
    expect(p.ok).toBe(true);
    const m = new Machine();
    m.setCpu('286');
    m.drives[2] = new Disk('C.IMG', blankHardDisk(8), false);
    m.load(p);
    for (let k = 0; k < 50 && m.run(200_000) === 'budget'; k++);
    expect(m.console).toContain('40');
  });
});
