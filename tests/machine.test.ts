import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { AX, BX, CX, DX, SP, SI, DI, BP } from '../src/cpu/cpu.ts';

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
      if (ex.id.startsWith('blank') || ex.pair || ex.id === 'mouse') return; // 双机示例在 serial.test.ts 中测试，鼠标示例有专门的测试
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

describe('鼠标（INT 33h）', () => {
  it('检测驱动、读位置和按键、按下次数', () => {
    const m = load(`
.model small
.stack 100h
.code
start:  mov ax, 0
        int 33h             ; AX=FFFFh 表示有驱动
        mov si, ax
        mov ax, 3
        int 33h             ; 复位后在屏幕中央
        mov di, cx
        mov bp, dx
w:      mov ax, 5
        mov bx, 0
        int 33h             ; 左键按下了几次
        or bx, bx
        jz w
        mov ah, 4ch
        int 21h
end start`);
    m.run(10_000);
    expect(m.cpu.r[SI]).toBe(0xffff);
    expect([m.cpu.r[DI], m.cpu.r[BP]]).toEqual([320, 100]);
    m.mouse.moveTo(100, 50);
    m.mouse.setButtons(1);
    m.mouse.setButtons(0);
    runToEnd(m);
    expect(m.cpu.r[CX]).toBe(100);              // 按下时的位置
    expect(m.cpu.r[DX]).toBe(50);
  });

  it('事件回调：鼠标移动和按键时调用程序登记的处理程序', () => {
    const m = load(`
.model small
.stack 100h
.data
clicks  dw 0
lastx   dw 0
.code
start:  mov ax, @data
        mov ds, ax
        mov ax, 0
        int 33h
        mov ax, 0Ch             ; 登记处理程序：左键按下时调用
        mov cx, 2
        push cs
        pop es
        mov dx, offset handler
        int 33h
        mov ah, 0               ; 等键盘（等待期间鼠标事件照样会调用处理程序）
        int 16h
        mov ah, 4ch
        mov al, byte ptr clicks
        int 21h
handler proc far
        push ds
        push ax
        mov ax, @data
        mov ds, ax
        inc clicks
        mov lastx, cx
        pop ax
        pop ds
        retf
handler endp
end start`);
    m.run(10_000);
    expect(m.status).toBe('waiting');
    for (const x of [10, 20, 30]) {
      m.mouse.moveTo(x, 5);
      m.mouse.setButtons(1);
      m.run(10_000);
      m.mouse.setButtons(0);
      m.run(10_000);
    }
    m.typeText('q', scanForChar);
    runToEnd(m);
    expect(m.exitCode).toBe(3);
    const lastx = m.program!.symbols.find(s => s.name === 'lastx')!;
    expect(m.cpu.rw(lastx.segment, lastx.offset)).toBe(30);
  });
});

describe('鼠标画图示例', () => {
  it('按住左键拖动会画出点，右键换颜色', () => {
    const m = new Machine();
    m.load(assemble(EXAMPLES.find(e => e.id === 'mouse')!.source));
    m.run(200_000);
    expect(m.mouse.visible).toBe(0);
    const at = (x: number, y: number) => m.mem[0xa0000 + y * 320 + x];
    m.mouse.moveTo(100, 50); m.mouse.setButtons(1); m.run(50_000);
    m.mouse.moveTo(120, 50); m.run(50_000);
    m.mouse.setButtons(0); m.run(50_000);
    expect(at(50, 50)).toBe(40);
    expect(at(60, 50)).toBe(40);
    m.mouse.setButtons(2); m.run(50_000); m.mouse.setButtons(0); m.run(50_000);
    m.mouse.moveTo(200, 80); m.mouse.setButtons(1); m.run(50_000); m.mouse.setButtons(0);
    expect(at(100, 80)).toBe(49);
    m.typeText('x', scanForChar);
    runToEnd(m);
    expect(m.mem[0x449]).toBe(3);
  });
});

describe('VGA 平面模式（12h）', () => {
  const PROG = `
.model small
.stack 100h
.code
start:  mov ax, 12h
        int 10h
        mov ax, 0A000h
        mov es, ax
        ; 写模式 2，位屏蔽只留最左边的像素：(0,0) 写成颜色 12
        mov dx, 3CEh
        mov ax, 0205h
        out dx, ax
        mov ax, 8008h
        out dx, ax
        mov al, es:[0]          ; 先读一下，装入锁存器
        mov byte ptr es:[0], 0Ch
        ; 写模式 0 + 置位/复位：第 1 行最左边 8 个像素都写成颜色 9
        mov ax, 0005h
        out dx, ax
        mov ax, 0FF08h
        out dx, ax
        mov ax, 0F01h
        out dx, ax
        mov ax, 0900h
        out dx, ax
        mov byte ptr es:[80], 0
        mov ax, 0001h
        out dx, ax
        ; 读模式 1：和颜色 9 比较，8 个像素都相同
        mov ax, 0805h
        out dx, ax
        mov ax, 0902h
        out dx, ax
        mov bl, es:[80]
        mov ax, 0005h
        out dx, ax
        ; BIOS 写点、读点
        mov ah, 0Ch
        mov al, 14
        mov cx, 639
        mov dx, 479
        int 10h
        mov ah, 0Dh
        mov cx, 0
        mov dx, 0
        int 10h
        cmp bl, 0FFh
        je ok
        mov al, 0EEh
ok:     mov ah, 4ch
        int 21h
end start`;

  it('写模式 0/2、置位/复位、位屏蔽、读模式 1 和 BIOS 写点读点', () => {
    const m = load(PROG);
    runToEnd(m);
    const pl = m.video.planar;
    expect(m.exitCode).toBe(12);                       // BIOS 读回 (0,0) 的颜色
    expect(pl.pixel(0, 0)).toBe(12);
    expect(pl.pixel(0, 1)).toBe(0);                    // 位屏蔽之外的像素没变
    for (let b = 0; b < 8; b++) expect(pl.pixel(80, b)).toBe(9);
    expect(pl.pixel(479 * 80 + 79, 7)).toBe(14);       // (639,479)
    expect(m.mem[0xa0000]).toBe(0);                    // 平面里的数据不在普通内存里
    expect(m.mem[0x484]).toBe(29);                     // 30 行文字
  });

  it('反向执行能撤销对平面的写入', () => {
    const m = load(PROG);
    runToEnd(m);
    for (let k = 0; k < 200 && m.video.planar.pixel(0, 0) !== 0; k++) m.stepBack();
    expect(m.video.planar.pixel(0, 0)).toBe(0);
  });

  it('切换到 12h 后鼠标的移动范围是 640×480', () => {
    const m = load(`
.model small
.stack 100h
.code
start:  mov ax, 0
        int 33h
        mov ax, 12h
        int 10h
        mov ax, 4c00h
        int 21h
end start`);
    runToEnd(m);
    expect(m.mouse.maxY).toBe(479);
    m.mouse.moveTo(600, 470);
    expect([m.mouse.x, m.mouse.y]).toEqual([600, 470]);
  });
});

describe('查找文件（INT 21h 4Eh/4Fh、FCB 11h/12h）', () => {
  const files = (m: Machine) => {
    m.files.set('HELLO.ASM', new Uint8Array(100));
    m.files.set('SUM.ASM', new Uint8Array(2000));
    m.files.set('DATA.TXT', new Uint8Array(70000));
    m.fileTimes.set('HELLO.ASM', new Date(1998, 9, 26, 13, 45, 30).getTime());
  };

  it('用 DTA 列出匹配的文件名、大小和日期', () => {
    const m = load(`
.model small
.stack 100h
.data
pat     db '*.ASM', 0
dta     db 43 dup(0)
crlf    db 13, 10, '$'
.code
start:  mov ax, @data
        mov ds, ax
        mov dx, offset dta
        mov ah, 1Ah
        int 21h
        mov dx, offset pat
        mov cx, 0
        mov ah, 4Eh
        int 21h
next:   jc done
        mov si, offset dta + 1Eh
print:  lodsb
        or al, al
        jz endname
        mov dl, al
        mov ah, 2
        int 21h
        jmp print
endname: mov dx, offset crlf
        mov ah, 9
        int 21h
        mov ah, 4Fh
        int 21h
        jmp next
done:   mov ah, 2Fh             ; 取 DTA，确认就是设置的那个
        int 21h
        cmp bx, offset dta
        jne bad
        mov ax, 4c00h
        int 21h
bad:    mov ax, 4c01h
        int 21h
end start`);
    files(m);
    runToEnd(m);
    expect(m.exitCode).toBe(0);
    expect(m.console.replace(/\r/g, '')).toBe('HELLO.ASM\nSUM.ASM\n');
  });

  it('DTA 里的属性、大小、日期和时间', () => {
    const m = load(`
.model small
.stack 100h
.data
pat     db '\DATA.*', 0
.code
start:  mov ax, @data
        mov ds, ax
        mov dx, offset pat
        mov cx, 0
        mov ah, 4Eh
        int 21h
        mov ax, 4c00h
        adc al, 0
        int 21h
end start`);
    files(m);
    runToEnd(m);
    expect(m.exitCode).toBe(0);
    const dta = m.program!.pspSeg * 16 + 0x80;   // 默认 DTA 在 PSP:0080
    expect(m.mem[dta + 0x15]).toBe(0x20);
    expect(m.mem[dta + 0x1a] | (m.mem[dta + 0x1b] << 8) | (m.mem[dta + 0x1c] << 16)).toBe(70000);
    expect(String.fromCharCode(...m.mem.subarray(dta + 0x1e, dta + 0x1e + 9))).toBe('DATA.TXT\0');
  });

  it('找不到时 CF=1、AX=12h；日期时间按 DOS 格式', () => {
    const m = load(`
.model small
.stack 100h
.data
pat     db 'HELLO.ASM', 0
none    db '*.EXE', 0
.code
start:  mov ax, @data
        mov ds, ax
        mov dx, offset pat
        mov cx, 0
        mov ah, 4Eh
        int 21h
        mov dx, offset none
        mov ah, 4Eh
        int 21h
        mov ah, 4ch
        int 21h
end start`);
    files(m);
    runToEnd(m);
    expect(m.exitCode).toBe(0x12);
  });

  it('FCB：29h 分析文件名，11h/12h 查找', () => {
    const m = load(`
.model small
.stack 100h
.data
spec    db '*.ASM', 0
fcb     db 37 dup(0)
dta     db 128 dup(0)
.code
start:  mov ax, @data
        mov ds, ax
        mov es, ax
        mov dx, offset dta
        mov ah, 1Ah
        int 21h
        mov si, offset spec
        mov di, offset fcb
        mov ax, 2901h
        int 21h
        mov bl, al              ; 1 = 有通配符
        mov dx, offset fcb
        mov ah, 11h
        int 21h
        mov cx, 0
again:  or al, al
        jnz done
        inc cx
        mov ah, 12h
        int 21h
        jmp again
done:   mov al, cl
        add al, bl              ; 2 个文件 + 通配符标志 1
        mov ah, 4ch
        int 21h
end start`);
    files(m);
    runToEnd(m);
    expect(m.exitCode).toBe(3);
  });

  it('文件时间：57h 读出上传时记录的日期', () => {
    const m = load(`
.model small
.stack 100h
.data
nm      db 'HELLO.ASM', 0
.code
start:  mov ax, @data
        mov ds, ax
        mov dx, offset nm
        mov ax, 3D00h
        int 21h
        mov bx, ax
        mov ax, 5700h
        int 21h
        mov ax, dx
        mov ah, 4ch             ; 退出码 = 日期的低字节
        int 21h
end start`);
    files(m);
    runToEnd(m);
    const date = ((1998 - 1980) << 9) | (10 << 5) | 26;
    expect(m.exitCode).toBe(date & 0xff);
  });
});

describe('磁盘映像与 INT 13h', () => {
  it('读写扇区、读驱动器参数', async () => {
    const { Disk, blankFloppy } = await import('../src/machine/disk.ts');
    const m = load(`
.model small
.stack 100h
.data
buf     db 512 dup(0)
.code
start:  mov ax, @data
        mov ds, ax
        mov es, ax
        mov di, offset buf          ; 填一个扇区：0,1,2,...
        mov cx, 512
        xor al, al
fill:   stosb
        inc al
        loop fill
        mov ax, 0301h               ; 写 1 个扇区：柱面 1，磁头 1，扇区 5
        mov cx, 0105h
        mov dx, 0100h
        mov bx, offset buf
        int 13h
        jc bad
        mov di, offset buf          ; 清掉缓冲区再读回来
        mov cx, 256
        xor ax, ax
        rep stosw
        mov ax, 0201h
        mov cx, 0105h
        mov dx, 0100h
        mov bx, offset buf
        int 13h
        jc bad
        cmp byte ptr buf+200, 200
        jne bad
        mov ah, 08h                 ; 读参数：1.44MB 软驱，79 柱面，18 扇区，2 个磁头
        mov dl, 0
        int 13h
        jc bad
        cmp bl, 4
        jne bad
        cmp cx, 4F12h
        jne bad
        cmp dh, 1
        jne bad
        mov ax, 0201h               ; 扇区号超出范围：错误 04h
        mov cx, 0013h
        mov dx, 0
        int 13h
        jnc bad
        cmp ah, 4
        jne bad
        mov ax, 4c00h
        int 21h
bad:    mov ax, 4c01h
        int 21h
end start`);
    m.drives[0] = new Disk('T.IMG', blankFloppy(), true);
    runToEnd(m);
    expect(m.exitCode).toBe(0);
    const lba = (1 * 2 + 1) * 18 + 4;
    expect(m.drives[0]!.data[lba * 512 + 200]).toBe(200);
    expect(m.drives[0]!.dirty).toBe(true);
  });

  it('从软盘启动：引导扇区装到 0000:7C00，DL = 驱动器号', async () => {
    const { Disk, blankFloppy } = await import('../src/machine/disk.ts');
    const { bootProgram } = await import('../src/machine/boot.ts');
    const img = blankFloppy();
    // 引导扇区：用 INT 10h 显示 DL+'A'，再读第 2 个扇区到 0000:8000 并跳过去
    const code = [
      0x88, 0xd0, 0x04, 0x41, 0xb4, 0x0e, 0xcd, 0x10,       // mov al,dl / add al,'A' / mov ah,0Eh / int 10h
      0xbb, 0x00, 0x80, 0xb8, 0x01, 0x02, 0xb9, 0x02, 0x00, // mov bx,8000h / mov ax,0201h / mov cx,0002h
      0xb6, 0x00, 0xcd, 0x13,                               // mov dh,0 / int 13h
      0xea, 0x00, 0x80, 0x00, 0x00,                         // jmp 0000:8000
    ];
    img.set(code, 0);
    img[510] = 0x55; img[511] = 0xaa;
    img.set([0xb0, 0x4b, 0xb4, 0x0e, 0xcd, 0x10, 0xf4], 512); // mov al,'K' / mov ah,0Eh / int 10h / hlt
    const m = new Machine();
    m.drives[0] = new Disk('BOOT.IMG', img, true);
    m.load(bootProgram(0));
    m.run(10_000);
    expect(String.fromCharCode(m.mem[0xb8000], m.mem[0xb8002])).toBe('AK');
  });

  it('空白硬盘不能启动，给出说明', async () => {
    const { Disk, blankHardDisk } = await import('../src/machine/disk.ts');
    const { bootProgram } = await import('../src/machine/boot.ts');
    const m = new Machine();
    m.drives[2] = new Disk('C.IMG', blankHardDisk(32), false);
    expect(() => m.load(bootProgram(0x80))).toThrow(/55AAh/);
    expect(m.drives[2]!.geo).toEqual({ cylinders: 65, heads: 16, sectors: 63 });
  });

  it('Ctrl+Alt+Del：从磁盘启动时热启动', async () => {
    const { Disk, blankFloppy } = await import('../src/machine/disk.ts');
    const { bootProgram } = await import('../src/machine/boot.ts');
    const img = blankFloppy();
    // 引导扇区：把 0000:0500 处的计数加 1 显示出来（热启动时内存会被清掉，所以每次都是 '1'），然后等按键
    img.set([0xfe, 0x06, 0x00, 0x05, 0xa0, 0x00, 0x05, 0x04, 0x30, 0xb4, 0x0e, 0xcd, 0x10, 0xb4, 0x00, 0xcd, 0x16, 0xeb, 0xfa], 0);
    img[510] = 0x55; img[511] = 0xaa;
    const m = new Machine();
    const logs: string[] = [];
    m.events.log = t => logs.push(t);
    m.drives[0] = new Disk('BOOT.IMG', img, true);
    m.load(bootProgram(0));
    m.run(20_000);
    m.mem[0xb8002] = 0x58;                  // 在屏幕上做个记号：重新开机会清屏
    m.sendCtrlAltDel();
    for (let k = 0; k < 20; k++) m.run(20_000);
    expect(logs.join()).toContain('Ctrl+Alt+Del');
    expect(m.mem[0xb8000]).toBe(0x31);       // 重新开机后又显示了 '1'
    expect(m.mem[0xb8002]).toBe(0x20);       // 记号没了
  });
});
