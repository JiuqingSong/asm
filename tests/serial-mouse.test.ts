import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';

const PROG = `
.model small
.stack 100h
.data
buf     db 7 dup(0)
.code
start:  mov ax, @data
        mov ds, ax
        mov es, ax
        mov dx, 2FBh            ; LCR：DLAB=1，设除数 96 -> 1200 bps
        mov al, 80h
        out dx, al
        mov dx, 2F8h
        mov al, 96
        out dx, al
        inc dx
        xor al, al
        out dx, al
        mov dx, 2FBh            ; 7 位数据，无校验，1 位停止
        mov al, 02h
        out dx, al
        mov dx, 2FCh            ; DTR、RTS 置 1：给鼠标上电
        mov al, 03h
        out dx, al
        mov cx, 7
        mov di, offset buf
next:   mov dx, 2FDh
poll:   in al, dx
        test al, 1
        jz poll
        mov dx, 2F8h
        in al, dx
        stosb
        loop next
        mov ax, 4c00h
        int 21h
end start`;

describe('COM2 上的串口鼠标', () => {
  it('上电后发出 M，移动和按键时发出 3 字节的数据包', () => {
    const p = assemble(PROG);
    const m = new Machine();
    m.load(p);
    m.run(3000);                          // 程序已经给鼠标上电
    expect(m.serialMouse.active).toBe(true);
    m.mouse.moveRel(5, -3);               // 向右 5、向上 3
    for (let k = 0; k < 40 && m.status !== 'exited'; k++) {
      m.run(20000);
      if (k === 10) m.mouse.setButtons(1); // 按下左键
    }
    expect(m.status).toBe('exited');
    const lin = p.segments.find(s => s.name.toUpperCase().includes('DATA'))!.addr;
    const buf = Array.from(m.mem.subarray(lin, lin + 7));
    expect(buf[0]).toBe(0x4d);            // 'M'
    expect(buf.slice(1, 4)).toEqual([0x4c, 0x05, 0x3d]); // dx=5，dy=-3（FDh）
    expect(buf.slice(4, 7)).toEqual([0x60, 0x00, 0x00]); // 左键按下，没有移动
  });
});
