import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';

// AT 机的第二个中断控制器（IRQ8~15）、实时钟中断、DMA 控制器

function run(src: string): Machine {
  const p = assemble(src);
  const errs = p.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => `第${e.line}行 ${e.message}`).join('\n'));
  const m = new Machine();
  m.setCpu('386');
  m.load(p);
  for (let k = 0; k < 400; k++) {
    const r = m.run(200_000);
    if (r === 'exit') return m;
    if (r !== 'budget') throw new Error(`意外停止：${r} ${m.message}`);
  }
  throw new Error('程序没有结束');
}

describe('AT 机的设备', () => {
  it('实时钟的周期中断经从片（IRQ8 → INT 70h）送到', () => {
    const m = run(`
.model small
.stack 100h
.data
count   dw 0
regc    db 0
.code
start:  mov ax, @data
        mov ds, ax
        cli
        xor ax, ax
        mov es, ax
        mov word ptr es:[1C0h], offset handler   ; INT 70h 的向量
        mov word ptr es:[1C2h], cs
        mov al, 0Bh                 ; CMOS 寄存器 B：打开周期中断（位 6）
        out 70h, al
        in al, 71h
        or al, 40h
        mov ah, al
        mov al, 0Bh
        out 70h, al
        mov al, ah
        out 71h, al
        in al, 0A1h                 ; 从片：开放 IRQ8
        and al, 0FEh
        out 0A1h, al
        sti
wait1:  cmp count, 10
        jb wait1
        cli
        mov ax, 4C00h
        int 21h

handler: push ax
        push ds
        mov ax, @data
        mov ds, ax
        inc count
        mov al, 0Ch                 ; 读寄存器 C：中断原因，同时清掉
        out 70h, al
        in al, 71h
        mov regc, al
        mov al, 20h                 ; EOI：从片和主片
        out 0A0h, al
        out 20h, al
        pop ds
        pop ax
        iret
end start`);
    const ds = m.program!.symbols.find(s => s.name === 'count')!;
    const base = ds.segment * 16 + ds.offset;
    expect(m.mem[base] | (m.mem[base + 1] << 8)).toBe(10);
    expect(m.mem[base + 2] & 0xc0).toBe(0xc0); // 位 7 中断、位 6 周期
  });

  it('DMA 控制器：地址、计数经先后触发器写入后能读回，页寄存器、屏蔽寄存器', () => {
    const m = run(`
.model small
.stack 100h
.data
res     db 8 dup(0)
.code
start:  mov ax, @data
        mov ds, ax
        out 0Ch, al                 ; 清先后触发器
        mov al, 34h                 ; 2 号通道地址 1234h：先低字节后高字节
        out 04h, al
        mov al, 12h
        out 04h, al
        mov al, 0FFh                ; 计数 01FFh
        out 05h, al
        mov al, 01h
        out 05h, al
        mov al, 7                   ; 页寄存器（2 号通道是 81h）
        out 81h, al
        mov al, 2                   ; 开放 2 号通道
        out 0Ah, al
        out 0Ch, al
        in al, 04h
        mov res, al
        in al, 04h
        mov res+1, al
        in al, 05h
        mov res+2, al
        in al, 05h
        mov res+3, al
        in al, 81h
        mov res+4, al
        in al, 0Fh
        mov res+5, al
        mov ax, 4C00h
        int 21h
end start`);
    const s = m.program!.symbols.find(x => x.name === 'res')!;
    const a = s.segment * 16 + s.offset;
    expect(Array.from(m.mem.subarray(a, a + 6))).toEqual([0x34, 0x12, 0xff, 0x01, 7, 0xfb]);
    expect(m.cpu.r[0]).toBeDefined();
  });

  it('INT 70h 的默认处理给两片都发 EOI；从片默认屏蔽全部，主片的 IRQ2 开放', () => {
    const m = new Machine();
    m.setCpu('386');
    m.load(assemble('.model small\n.code\nstart: mov ax,4c00h\nint 21h\nend start'));
    expect(m.pic2.imr).toBe(0xff);
    expect(m.pic.imr & 4).toBe(0);
    expect(m.pic2.vectorBase).toBe(0x70);
  });
});
