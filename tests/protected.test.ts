import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';

// 一个完整走一遍 286 保护模式的 COM 程序（286 的指令写成 db）：
// 进入保护模式 → 访问 1MB 以上 → 越界触发 #GP → 降到 3 环 → 经调用门回 0 环再返回 →
// 用中断门从 3 环进 0 环 → 写 CMOS 关机原因 0Ah，通过键盘控制器复位回到实模式 → 在实模式下经 A20 读 1MB 处
const PROG = `
.model tiny
.code
org 100h
start:  jmp main

gdt     dw 0, 0, 0, 0
g_code  dw 0FFFFh, 0
        db 0, 9Ah
        dw 0
g_data  dw 0FFFFh, 0
        db 0, 92h
        dw 0
g_big   dw 0FFFFh, 0
        db 10h, 92h
        dw 0
g_small dw 000Fh, 0
        db 0, 92h
        dw 0
g_c3    dw 0FFFFh, 0
        db 0, 0FAh
        dw 0
g_d3    dw 0FFFFh, 0
        db 0, 0F2h
        dw 0
g_tss   dw 43, 0
        db 0, 81h
        dw 0
g_gate  dw offset gate_target, 08h
        db 0, 0E4h
        dw 0
g_low   dw 0FFFFh, 0
        db 0, 92h
        dw 0
gdt_end:
gdtr    dw gdt_end - gdt - 1
        dw 0, 0
idt     db 33*8 dup(0)
idtr    dw 33*8 - 1
        dw 0, 0
tss     db 44 dup(0)

saved_cs dw 0
saved_ss dw 0
saved_sp dw 0
res_big       dw 0
res_gp        dw 0
res_gp_code   dw 0FFFFh
res_after_gp  dw 0
res_r3        dw 0
res_gate_cpl  dw 0FFFFh
res_gate_ss   dw 0
res_after_gate dw 0
res_int_cpl   dw 0FFFFh
res_real_big  dw 0

stk0    db 256 dup(0)
stk0_top label word
stk3    db 256 dup(0)
stk3_top label word

; 把 CS×16 + BX 写成描述符的 24 位基址（DI 指向描述符）
setbase proc
        mov ax, cs
        mov dx, ax
        mov cl, 4
        shl ax, cl
        mov cl, 12
        shr dx, cl
        add ax, bx
        adc dl, 0
        mov [di+2], ax
        mov [di+4], dl
        ret
setbase endp

main:   mov saved_cs, cs
        mov saved_ss, ss
        mov saved_sp, sp
        xor bx, bx
        mov di, offset g_code
        call setbase
        mov di, offset g_data
        call setbase
        mov di, offset g_small
        call setbase
        mov di, offset g_c3
        call setbase
        mov di, offset g_d3
        call setbase
        mov bx, offset tss
        mov di, offset g_tss
        call setbase
        mov bx, offset gdt          ; GDTR、IDTR 的基址（setbase 写 [di+2] 和 [di+4]：正好是界限后面的 3 字节基址）
        mov di, offset gdtr
        call setbase
        mov bx, offset idt
        mov di, offset idtr
        call setbase
        ; IDT：13 号（#GP）中断门，32 号 DPL=3 的中断门（3 环用 INT 20h 进 0 环）
        mov word ptr idt+13*8, offset gp_handler
        mov word ptr idt+13*8+2, 08h
        mov byte ptr idt+13*8+5, 86h
        mov word ptr idt+32*8, offset back0
        mov word ptr idt+32*8+2, 08h
        mov byte ptr idt+32*8+5, 0E6h
        ; TSS：0 环的堆栈
        mov word ptr tss+2, offset stk0_top
        mov word ptr tss+4, 10h
        mov al, 2                   ; 打开 A20（端口 92h）
        out 92h, al
        cli
        db 0Fh, 01h, 16h            ; lgdt [gdtr]
        dw offset gdtr
        db 0Fh, 01h, 1Eh            ; lidt [idtr]
        dw offset idtr
        mov ax, 1
        db 0Fh, 01h, 0F0h           ; lmsw ax
        db 0EAh                     ; jmp 08h:pm
        dw offset pm, 08h

pm:     mov ax, 10h
        mov ds, ax
        mov ss, ax
        mov sp, offset stk0_top
        mov ax, 18h                 ; 基址 1MB 的数据段
        mov es, ax
        mov word ptr es:[0], 1234h
        mov ax, es:[0]
        mov res_big, ax
        mov ax, 20h                 ; 界限只有 0Fh 的段：读 [10h] 越界
        mov es, ax
        db 26h, 0A1h                ; mov ax, es:[0010h]（4 字节）
        dw 0010h
        mov res_after_gp, 1
        mov ax, 38h
        db 0Fh, 00h, 0D8h           ; ltr ax
        mov ax, 33h                 ; 用 RETF 降到 3 环：SS、SP、CS、IP
        push ax
        mov ax, offset stk3_top
        push ax
        mov ax, 2Bh
        push ax
        mov ax, offset ring3
        push ax
        retf

ring3:  mov ax, 33h
        mov ds, ax
        mov res_r3, 3
        db 9Ah                      ; call far 43h:0（调用门）
        dw 0, 43h
        mov res_after_gate, 1
        int 20h                     ; 中断门：回到 0 环

gate_target:
        mov ax, cs
        and ax, 3
        mov res_gate_cpl, ax
        mov ax, ss
        mov res_gate_ss, ax
        retf

gp_handler:
        pop ax                      ; 错误码
        mov res_gp_code, ax
        mov res_gp, 1
        mov bp, sp
        add word ptr [bp], 4        ; 跳过出错的那条 4 字节指令
        iret

back0:  mov ax, 10h
        mov ds, ax
        mov ax, cs
        and ax, 3
        mov res_int_cpl, ax
        mov al, 0Fh                 ; CMOS 关机原因 = 0Ah：复位后直接跳到 0040:0067
        out 70h, al
        mov al, 0Ah
        out 71h, al
        mov ax, 48h                 ; 基址 0 的段
        mov es, ax
        mov word ptr es:[467h], offset resume
        mov ax, saved_cs
        mov es:[469h], ax
        mov al, 0FEh                ; 键盘控制器：复位 CPU
        out 64h, al
        hlt

resume: mov ax, cs                  ; 回到了实模式
        mov ds, ax
        mov ss, saved_ss
        mov sp, saved_sp
        mov ax, 0FFFFh              ; A20 开着：FFFF:0010 就是 1MB
        mov es, ax
        mov ax, es:[0010h]
        mov res_real_big, ax
        sti
        mov ax, 4C00h
        int 21h
end start
`;

describe('286 保护模式', () => {
  it('进入保护模式、1MB 以上、#GP、特权级、调用门、中断门、复位回实模式', () => {
    const p = assemble(PROG);
    const errs = p.diagnostics.filter(d => d.severity === 'error');
    expect(errs.map(e => `${e.line}: ${e.message}`)).toEqual([]);
    const m = new Machine();
    m.setCpu('286');
    m.load(p);
    for (let k = 0; k < 50 && m.status !== 'exited'; k++) m.run(100_000);
    expect(m.message).toMatch(/返回码 0/);
    const v = (name: string) => {
      const s = p.symbols.find(x => x.name.toLowerCase() === name)!;
      const a = s.segment * 16 + s.offset;
      return m.mem[a] | (m.mem[a + 1] << 8);
    };
    expect(v('res_big')).toBe(0x1234);
    expect(m.mem[0x100000] | (m.mem[0x100001] << 8)).toBe(0x1234);
    expect(v('res_gp')).toBe(1);
    expect(v('res_gp_code')).toBe(0);
    expect(v('res_after_gp')).toBe(1);
    expect(v('res_r3')).toBe(3);
    expect(v('res_gate_cpl')).toBe(0);
    expect(v('res_gate_ss')).toBe(0x10);
    expect(v('res_after_gate')).toBe(1);
    expect(v('res_int_cpl')).toBe(0);
    expect(v('res_real_big')).toBe(0x1234);
    expect(m.cpu.protectedMode).toBe(false);
  });

  it('A20 关闭时 1MB 以上回绕到 0（和 8086 一样）', () => {
    const m = new Machine();
    m.setCpu('286');
    m.cpu.setA20(false);
    m.cpu.wb(0xffff, 0x10, 0x5a);
    expect(m.mem[0]).toBe(0x5a);
    m.cpu.setA20(true);
    m.cpu.wb(0xffff, 0x10, 0xa5);
    expect(m.mem[0x100000]).toBe(0xa5);
  });
});
