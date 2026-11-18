import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';
import { MODE_UNCHAINED } from '../src/machine/video.ts';

function run(src: string): Machine {
  const p = assemble(src);
  const errs = p.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => `第${e.line}行 ${e.message}`).join('\n'));
  const m = new Machine();
  m.setCpu('386');
  m.load(p);
  for (let k = 0; k < 100; k++) {
    const r = m.run(200_000);
    if (r === 'exit') return m;
    if (r !== 'budget') throw new Error(`意外停止：${r} ${m.message}`);
  }
  throw new Error('程序没有结束');
}

describe('VGA 显存和寄存器', () => {
  it('非链式 256 色（"Mode X"，Windows 95 启动画面的 320×400）：显示模式按寄存器判断，像素按平面存放', () => {
    const m = run(`
.model small
.stack 100h
.code
start:  mov ax, 0013h               ; 先设 256 色模式
        int 10h
        mov dx, 3C4h                ; 定序器 4：关掉链式寻址（位 3），打开奇偶禁止（位 2）
        mov ax, 0604h
        out dx, ax
        mov dx, 3D4h                ; CRTC 9：每行不重复（400 行）
        mov ax, 4009h
        out dx, ax
        mov ax, 0A000h
        mov es, ax
        mov dx, 3C4h                ; 平面屏蔽：只写平面 2
        mov ax, 0402h
        out dx, ax
        mov byte ptr es:[0], 33h    ; x = 2, y = 0
        mov byte ptr es:[80], 44h   ; x = 2, y = 1（每行每个平面 80 字节）
        mov ax, 0F02h               ; 4 个平面都写
        out dx, ax
        mov byte ptr es:[1], 55h    ; x = 4~7, y = 0
        mov ax, 4C00h               ; 结束（不切回文本模式）
        int 21h
end start`);
    const v = m.video;
    expect(v.hardwareMode()).toBe(MODE_UNCHAINED);
    expect(v.unchainedSize()).toMatchObject({ width: 320, height: 400, stride: 80, start: 0 });
    const p = v.planar.planes;
    expect(p[2][0]).toBe(0x33);
    expect(p[0][0]).toBe(0);
    expect(p[2][80]).toBe(0x44);
    expect([p[0][1], p[1][1], p[2][1], p[3][1]]).toEqual([0x55, 0x55, 0x55, 0x55]);
  });

  it('INT 10h 设置模式时和真的 VGA BIOS 一样用 OUT 装入调色板和 DAC（Windows 的 DOS 窗口靠它换算颜色）', () => {
    const m = run(`
.model small
.stack 100h
.code
start:  mov ax, 0003h
        int 10h
        mov ax, 4C00h
        int 21h
end start`);
    const v = m.video;
    expect(Array.from(v.attr.subarray(0, 16))).toEqual([0, 1, 2, 3, 4, 5, 0x14, 7, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);
    expect(Array.from(v.dac.subarray(0, 9))).toEqual([0, 0, 0, 0, 0, 42, 0, 42, 0]); // 黑、蓝、绿
    expect(Array.from(v.dac.subarray(7 * 3, 8 * 3))).toEqual([42, 42, 42]);          // 7：浅灰
    expect(Array.from(v.dac.subarray(63 * 3, 64 * 3))).toEqual([63, 63, 63]);        // 3Fh：白
  });

  it('模式 13h（链式）：第 i 个像素在平面 i & 3', () => {
    const m = run(`
.model small
.stack 100h
.code
start:  mov ax, 0013h
        int 10h
        mov ax, 0A000h
        mov es, ax
        mov byte ptr es:[321], 7    ; x = 1, y = 1
        mov ax, 4C00h
        int 21h
end start`);
    expect(m.video.hardwareMode()).toBe(0x13);
    expect(m.video.planar.planes[321 & 3][321 >> 2]).toBe(7);
    expect(m.video.peek(0xa0000 + 321)).toBe(7);
  });
});
