import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { AX, BX, CX, SP } from '../src/cpu/cpu.ts';

function load(src: string): Machine {
  const p = assemble(src);
  const errs = p.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => `第${e.line}行 ${e.message}`).join('\n'));
  const m = new Machine();
  m.load(p);
  return m;
}

function runToEnd(m: Machine, input = '', maxRounds = 200, typeFirst = false): Machine {
  let typed = false;
  if (typeFirst) { m.run(50_000); m.typeText(input, scanForChar); typed = true; }
  for (let i = 0; i < maxRounds; i++) {
    const r = m.run(1_000_000);
    if (r === 'exit') return m;
    if (r === 'wait') {
      if (typed) throw new Error('程序在等待更多输入：' + m.console);
      m.typeText(input, scanForChar);
      typed = true;
      continue;
    }
    if (r !== 'budget') throw new Error(`意外停止：${r} ${m.message}`);
  }
  throw new Error('程序没有结束');
}

const HELLO = `
.model small
.stack 100h
.data
msg db 'Hello, 8086!', 0dh, 0ah, '$'
.code
start:  mov ax, @data
        mov ds, ax
        mov dx, offset msg
        mov ah, 9
        int 21h
        mov ax, 4c00h
        int 21h
end start
`;

describe('运行程序', () => {
  it('Hello World', () => {
    const m = runToEnd(load(HELLO));
    expect(m.console).toBe('Hello, 8086!\n');
    expect(m.exitCode).toBe(0);
    // 屏幕第一行
    let line = '';
    for (let c = 0; c < 12; c++) line += String.fromCharCode(m.mem[0xb8000 + c * 2]);
    expect(line).toBe('Hello, 8086!');
  });

  it('循环求和并以十进制输出', () => {
    const m = runToEnd(load(`
.model small
.stack 100h
.code
start:  mov cx, 100
        xor ax, ax
again:  add ax, cx
        loop again          ; ax = 5050
        call printnum
        mov ah, 4ch
        int 21h
printnum proc
        mov bx, 10
        xor cx, cx
p1:     xor dx, dx
        div bx
        push dx
        inc cx
        test ax, ax
        jnz p1
p2:     pop dx
        add dl, '0'
        mov ah, 2
        int 21h
        loop p2
        ret
printnum endp
end start`));
    expect(m.console).toBe('5050');
  });

  it('键盘行输入 INT 21h 0Ah 与字符输入 01h', () => {
    const m = runToEnd(load(`
.model small
.stack 100h
.data
buf db 20, ?, 20 dup(?)
.code
start:  mov ax, @data
        mov ds, ax
        mov dx, offset buf
        mov ah, 0ah
        int 21h
        mov dl, 10
        mov ah, 2
        int 21h
        mov bl, buf+1         ; 实际长度
        xor bh, bh
        mov buf[bx+2], '$'
        mov dx, offset buf+2
        mov ah, 9
        int 21h
        mov ah, 1
        int 21h
        mov ah, 4ch
        int 21h
end start`), 'abc\rX');
    expect(m.console).toBe('abc\nabcX');
  });

  it('COM 程序', () => {
    const m = runToEnd(load(`
code segment
        assume cs:code, ds:code
        org 100h
start:  mov dx, offset msg
        mov ah, 9
        int 21h
        ret
msg     db 'COM!$'
code ends
        end start`));
    expect(m.console).toBe('COM!');
  });

  it('除以零触发 0 号中断', () => {
    const m = runToEnd(load(`
.model small
.stack 100h
.code
start:  mov ax, 10
        mov bl, 0
        div bl
        mov ah, 4ch
        int 21h
end start`));
    expect(m.console).toContain('Divide overflow');
    expect(m.message).toContain('除法溢出');
  });

  it('用户挂接 INT 1Ch 定时器中断', () => {
    const m = runToEnd(load(`
.model small
.stack 100h
.data
ticks dw 0
.code
start:  mov ax, @data
        mov ds, ax
        mov ax, 251ch
        push ds
        push cs
        pop ds
        mov dx, offset tick
        int 21h
        pop ds
wait1:  cmp ticks, 3
        jb wait1
        mov dl, 'T'
        mov ah, 2
        int 21h
        mov ah, 4ch
        int 21h
tick    proc far
        push ds
        push ax
        mov ax, @data
        mov ds, ax
        inc ticks
        pop ax
        pop ds
        iret
tick    endp
end start`));
    expect(m.console).toBe('T');
  });

  it('用户挂接 INT 9，直接读端口 60h 的扫描码', () => {
    const m = load(`
.model small
.stack 100h
.data
got db 0
.code
start:  mov ax, @data
        mov ds, ax
        xor ax, ax
        mov es, ax
        cli
        mov word ptr es:[9*4], offset kbd
        mov es:[9*4+2], cs
        sti
w:      cmp got, 0
        je w
        mov ah, 4ch
        mov al, got
        int 21h
kbd:    push ax
        push ds
        mov ax, @data
        mov ds, ax
        in al, 60h
        test al, 80h
        jnz kdone
        mov got, al
kdone:  mov al, 20h
        out 20h, al
        pop ds
        pop ax
        iret
end start`);
    m.run(100_000);
    m.typeText('a', scanForChar);
    runToEnd(m);
    expect(m.exitCode).toBe(0x1e); // A 键的扫描码
  });
});

describe('调试', () => {
  const SRC = `
.model small
.stack 100h
.data
v dw 1
.code
start:  mov ax, @data
        mov ds, ax
        mov v, 5
        call sub1
        mov bx, 7
        mov ah, 2
        mov dl, 'x'
        int 21h
        mov ah, 4ch
        int 21h
sub1    proc
        mov cx, 9
        ret
sub1    endp
end start`;

  it('单步进入、跳过、反向执行', () => {
    const m = load(SRC);
    const p = m.program!;
    const line = () => p.addrToLine.get(m.linearIP);
    const vAddr = () => { const s = p.symbols.find(s => s.name === 'v')!; return s.segment * 16 + s.offset; };
    expect(line()).toBe(7);
    m.stepInto(); expect(line()).toBe(8);
    m.stepInto(); expect(line()).toBe(9);
    m.stepInto(); expect(line()).toBe(10);
    expect(m.mem[vAddr()]).toBe(5);
    const sp = m.cpu.r[SP];
    m.stepInto(); expect(line()).toBe(18);      // 进入子程序
    expect(m.cpu.r[SP]).toBe(sp - 2);
    m.stepBack(); expect(line()).toBe(10);       // 退回 CALL 之前
    expect(m.cpu.r[SP]).toBe(sp);
    m.stepOver(); expect(line()).toBe(11);       // 跳过整个子程序
    expect(m.cpu.r[CX]).toBe(9);
    m.stepInto(); m.stepInto(); m.stepInto();    // mov bx / mov ah / mov dl
    expect(m.cpu.r[BX]).toBe(7);
    m.stepInto();                                 // int 21h 整体执行
    expect(line()).toBe(15);
    expect(m.console).toBe('x');
    // 一路退回开头，内存也恢复
    while (m.stepBack()) { /* */ }
    expect(line()).toBe(7);
    expect(m.mem[vAddr()]).toBe(1);
    expect(m.cpu.r[AX]).toBe(0);
  });

  it('断点', () => {
    const m = load(SRC);
    const p = m.program!;
    m.breakpoints.add(p.lineToAddrs.get(11)![0]);
    expect(m.run(1_000_000)).toBe('breakpoint');
    expect(p.addrToLine.get(m.linearIP)).toBe(11);
    expect(m.run(1_000_000)).toBe('exit');
  });

  it('REP 串操作单步时整体执行', () => {
    const m = load(`
.model small
.stack 100h
.data
a db 10 dup(1)
b db 10 dup(0)
.code
start:  mov ax, @data
        mov ds, ax
        mov es, ax
        lea si, a
        lea di, b
        mov cx, 10
        cld
        rep movsb
        mov ah, 4ch
        int 21h
end start`);
    for (let i = 0; i < 7; i++) m.stepInto();
    const p = m.program!;
    expect(p.addrToLine.get(m.linearIP)).toBe(15);
    m.stepInto();
    expect(p.addrToLine.get(m.linearIP)).toBe(16);
    expect(m.cpu.r[CX]).toBe(0);
    m.stepBack();
    expect(m.cpu.r[CX]).toBe(10);
  });
});

describe('汇编器', () => {
  // 这两个程序不在仓库里（位于仓库的上一级目录），找不到时跳过
  const serialFiles = ['send.asm', 'receive.asm'].map(f => fileURLToPath(new URL('../../' + f, import.meta.url)));
  it.skipIf(!serialFiles.every(f => existsSync(f)))('能汇编 2003 年的串口传输程序', () => {
    for (const f of serialFiles) {
      const src = readFileSync(f, 'latin1');
      const p = assemble(src);
      expect(p.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    }
  });

  it('常见错误给出中文提示', () => {
    const cases: [string, RegExp][] = [
      ['mov ds, 1234h', /不能把立即数直接送入段寄存器/],
      ['mov [bx], 1', /BYTE PTR 或 WORD PTR/],
      ['mov al, v', /大小不匹配/],
      ['mov v, w', /两个内存单元/],
      ['shl ax, 4', /移位次数只能是 1 或 CL/],
      ['push 5', /80186/],
      ['mov ax, [cx]', /BX、BP、SI、DI/],
      ['jmp nowhere', /未定义的符号：nowhere/],
      ['pusha', /不是 8086 指令/],
      ['start mov ax, 1', /后面要加冒号/],
    ];
    for (const [line, re] of cases) {
      const p = assemble(`.model small\n.data\nv dw 0\nw dw 0\n.code\nx:\n ${line}\nend x`);
      const msgs = p.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join(' | ');
      expect(msgs, line).toMatch(re);
    }
  });
});

import { EXAMPLES } from '../src/ui/examples.ts';

describe('示例程序', () => {
  for (const ex of EXAMPLES) {
    it(ex.title, () => {
      const p = assemble(ex.source);
      expect(p.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
      if (ex.id.startsWith('blank') || ex.pair) return; // 双机示例在 serial.test.ts 中测试
      const m = new Machine();
      m.load(p);
      const input = ex.input ?? (ex.id === 'keyboard' ? 'ab\x1b' : '');
      runToEnd(m, input, 200, ex.id === 'keyboard');
      expect(m.status).toBe('exited');
    });
  }
  it('示例的运行结果', () => {
    const out = (id: string, input = '') => {
      const m = new Machine();
      m.load(assemble(EXAMPLES.find(e => e.id === id)!.source));
      return runToEnd(m, input, 200, id === 'keyboard');
    };
    expect(out('sum').console).toBe('5050');
    expect(out('reverse').console).toBe('GFEDCBA');
    expect(out('input', 'Hello asm\r').console).toBe('Please type a line: Hello asm\nHELLO ASM');
    expect(out('stack').cpu.r[AX] & 0xff).toBe(6);
    expect(out('timer').console).toBe('.....');
    expect(out('keyboard', 'ab\x1b').console).toBe('1E 9E 30 B0 ');
    const sorted = out('sort');
    const s = sorted.program!.symbols.find(x => x.name === 'arr')!;
    const base = s.segment * 16 + s.offset;
    const vals = Array.from({ length: 8 }, (_, i) => sorted.mem[base + i * 2] | (sorted.mem[base + i * 2 + 1] << 8));
    expect(vals).toEqual([3, 5, 12, 28, 37, 50, 64, 91]);
  });
});

describe('PC 喇叭', () => {
  it('两只老虎：频率序列与时长', () => {
    const m = new Machine();
    m.load(assemble(EXAMPLES.find(e => e.id === 'music')!.source));
    const notes: { f: number; t: number }[] = [];
    m.events.speaker = f => notes.push({ f, t: m.clock });
    runToEnd(m);
    const on = notes.filter(n => n.f > 0);
    expect(on.slice(0, 4).map(n => n.f)).toEqual([262, 294, 330, 262]);
    expect(on.length).toBe(32);
    // 第一个音持续约 3 个时钟滴答（4 个减去 1 个停顿），每个滴答 65536 个 PIT 时钟
    const dur = (notes[1].t - notes[0].t) / 65536;
    expect(dur).toBeGreaterThan(2.5);
    expect(dur).toBeLessThan(3.5);
    expect(notes[notes.length - 1].f).toBe(0);
  });
});

describe('跳出子程序', () => {
  const SRC = `
.model small
.stack 100h
.code
start:  mov ax, 1
        call outer
        mov bx, 2           ; 第 7 行：从 outer 跳出后应停在这里
        mov ah, 4ch
        int 21h
outer   proc
        push bx
        pop bx
        call inner          ; 第 13 行
        push cx
        call inner
        pop cx              ; 第 16 行
        ret
outer   endp
inner   proc
        nop                 ; 第 20 行
        ret
inner   endp
end start`;

  it('从子程序中间跳出，嵌套调用和 PUSH/POP 不影响判断', () => {
    const m = load(SRC);
    const p = m.program!;
    const line = () => p.addrToLine.get(m.linearIP);
    m.stepInto(); m.stepInto();             // mov ax / call outer
    expect(line()).toBe(11);
    m.stepInto(); m.stepInto();             // push bx / pop bx
    expect(line()).toBe(13);
    m.stepOut();
    expect(line()).toBe(7);
    expect(m.cpu.r[AX]).toBe(1);
  });

  it('从内层子程序跳出到外层', () => {
    const m = load(SRC);
    const p = m.program!;
    const line = () => p.addrToLine.get(m.linearIP);
    m.breakpoints.add(p.lineToAddrs.get(20)![0]);
    m.run(100000);                          // 停在 inner 的 nop
    expect(line()).toBe(20);
    m.stepOut();
    expect(line()).toBe(14);                // 第一次调用 inner 之后
  });

  it('后退可以撤销修改寄存器', () => {
    const m = load(SRC);
    m.stepInto();
    m.poke(() => { m.cpu.r[AX] = 0x1234; });
    expect(m.cpu.r[AX]).toBe(0x1234);
    m.stepBack();
    expect(m.cpu.r[AX]).toBe(1);
  });
});

describe('图形模式', () => {
  const run = (id: string, keys: string) => {
    const m = new Machine();
    m.load(assemble(EXAMPLES.find(e => e.id === id)!.source));
    const snaps: Uint8Array[] = [];
    for (const [n, k] of [...keys].entries()) {
      // 第一个键：运行到程序等待按键；之后（程序在循环里查询键盘）只运行一小段
      for (let i = 0; i < (n === 0 ? 400 : 20) && m.run(100_000) === 'budget'; i++) { /* */ }
      snaps.push(m.mem.slice(0xa0000, 0xa0000 + 64000));
      m.typeText(k, scanForChar);
    }
    runToEnd(m);
    return { m, snaps };
  };

  it('VGA 256 色：色块位置正确，调色板轮转，最后回到文本模式', () => {
    const { m, snaps } = run('vga', 'xx');
    const px = (x: number, y: number) => snaps[0][y * 320 + x];
    expect(px(5, 20)).toBe(0);                  // 第 0 号色块
    expect(px(25, 20)).toBe(1);                 // 第 1 号
    expect(px(5 + 20 * 15, 16 + 11 * 15 + 3)).toBe(255);
    expect(m.mem[0x449]).toBe(3);               // 退出前回到了文本模式
    // 轮转后 32 号颜色不再是默认的纯蓝 (0,0,63)
    const d = m.video.dac;
    expect([d[96], d[97], d[98]]).not.toEqual([0, 0, 63]);
  });

  it('Bresenham 画线：线从中心画到四条边', () => {
    const { snaps } = run('lines', 'x');
    const s = snaps[0];
    const lit = s.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(lit).toBeGreaterThan(15000);
    expect(s[0]).not.toBe(0);                   // 左上角 (0,0)
    expect(s[199 * 320 + 312]).not.toBe(0);     // 下边最后一条线的终点 (312,199)
    expect(s[100 * 320 + 160]).not.toBe(0);     // 中心
  });

  it('CGA 模式和 BIOS 写点、读点', () => {
    const m = load(`
.model small
.stack 100h
.code
start:  mov ax, 0004h
        int 10h
        mov ah, 0Ch
        mov al, 3
        mov cx, 10
        mov dx, 1           ; 奇数行在 B800:2000
        int 10h
        mov ah, 0Dh
        int 10h
        mov ah, 4ch
        int 21h
end start`);
    runToEnd(m);
    expect(m.exitCode).toBe(3);                 // 读回的颜色
    expect(m.mem[0xb8000 + 0x2000 + (10 >> 2)]).toBe(0b00001100); // x=10 是这个字节的第 3 个像素（位 3、2）
  });
});

describe('图形模式下的文字', () => {
  it('BIOS 用 8×8 字库把字画进显存', () => {
    const m = load(`
.model small
.stack 100h
.data
msg db 'A$'
.code
start:  mov ax, @data
        mov ds, ax
        mov ax, 13h
        int 10h
        mov dx, offset msg
        mov ah, 9
        int 21h
        mov ah, 4ch
        int 21h
end start`);
    runToEnd(m);
    // "A" 的点阵第 0 行是 01110（放在第 1~5 列），颜色 15
    const row0 = Array.from(m.mem.subarray(0xa0000, 0xa0000 + 8));
    expect(row0).toEqual([0, 0, 15, 15, 15, 0, 0, 0]);
    const row4 = Array.from(m.mem.subarray(0xa0000 + 4 * 320, 0xa0000 + 4 * 320 + 8));
    expect(row4).toEqual([0, 15, 15, 15, 15, 15, 0, 0]); // 横杠 11111
  });
});
