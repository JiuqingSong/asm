import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/asm/assembler.ts';
import { Machine, type CpuSpeedId } from '../src/machine/machine.ts';
import { DualMachine } from '../src/machine/dual.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { EXAMPLES } from '../src/ui/examples.ts';

function asm(src: string) {
  const p = assemble(src);
  const errs = p.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => `第${e.line}行 ${e.message}`).join('\n'));
  return p;
}

describe('8250 串口', () => {
  it('回环模式：自己发自己收', () => {
    const m = new Machine();
    m.load(asm(`
.model small
.stack 100h
.code
start:  mov dx, 3fbh
        mov al, 80h
        out dx, al
        mov dx, 3f8h
        mov al, 12            ; 9600 bps
        out dx, al
        inc dx
        mov al, 0
        out dx, al
        mov dx, 3fbh
        mov al, 3
        out dx, al
        mov dx, 3fch
        mov al, 10h           ; LOOP
        out dx, al
        mov dx, 3f8h
        mov al, 'Q'
        out dx, al
        mov dx, 3fdh
w:      in al, dx
        test al, 1
        jz w
        mov dx, 3f8h
        in al, dx
        mov dl, al
        mov ah, 2
        int 21h
        mov ah, 4ch
        int 21h
end start`));
    while (m.run(100_000) === 'budget');
    expect(m.console).toBe('Q');
    expect(m.com1.stats.txBytes).toBe(1);
  });

  it('串口聊天示例：在 A 机打字，B 机收到', () => {
    const d = new DualMachine();
    const src = EXAMPLES.find(e => e.id === 'chat')!.source;
    for (const m of d.m) m.load(asm(src));
    d.syncClocks();
    d.run(200_000);
    d.m[0].typeText('hi\r', scanForChar);
    for (let i = 0; i < 50; i++) d.run(200_000);
    expect(d.m[1].console).toContain('hi\n');
    d.m[1].typeText('\x1b', scanForChar);
    d.m[0].typeText('\x1b', scanForChar);
    for (let i = 0; i < 50 && d.m.some(m => m.status !== 'exited'); i++) d.run(200_000);
    expect(d.m.map(m => m.status)).toEqual(['exited', 'exited']);
  });

  it('波特率不一致时接收方报告帧错误', () => {
    const d = new DualMachine();
    const src = EXAMPLES.find(e => e.id === 'chat')!.source;
    d.m[0].load(asm(src));
    d.m[1].load(asm(src.replace('mov al, 12              ; 115200 / 9600 = 12', 'mov al, 6')));
    d.syncClocks();
    d.run(200_000);
    d.m[0].typeText('x', scanForChar);
    for (let i = 0; i < 30; i++) d.run(200_000);
    expect(d.m[1].com1.stats.framingErrors).toBe(1);
  });
});

// 2003 年的串口文件传输作业（不在仓库里，位于上一级目录）
const here = (f: string) => fileURLToPath(new URL('../../' + f, import.meta.url));
const haveOriginals = existsSync(here('send.asm')) && existsSync(here('receive.asm'));

describe.skipIf(!haveOriginals)('send.asm + receive.asm 原样运行', () => {
  const data = new Uint8Array(5000).map((_, i) => (i * 7 + (i >> 3)) & 0xff);
  function transfer(cpu: CpuSpeedId, buffered: boolean) {
    const d = new DualMachine('loopback-rts');
    const [A, B] = d.m;
    for (const m of d.m) { m.setCpu(cpu); m.com1.bufferedTx = buffered; m.history.enabled = false; }
    A.files.set('DATA.BIN', data);
    A.load(asm(readFileSync(here('send.asm'), 'latin1')), ' c:\\data.bin');
    B.load(asm(readFileSync(here('receive.asm'), 'latin1')));
    d.syncClocks();
    let r, after = 0;
    for (let i = 0; i < 100; i++) {
      r = d.run(1_000_000);
      if (r.reason !== 'budget') break;
      if (A.status === 'exited' && ++after > 5) break; // 发送方结束后再给接收方一点时间
    }
    return { A, B, r: r!, got: B.files.get('DATA.BIN') };
  }

  it('286 + 虚拟串口：传输成功，文件完全一致', { timeout: 60_000 }, () => {
    const { A, B, got } = transfer('286', true);
    expect(A.console).toContain('TRANSFER OVER!');
    expect(B.status).toBe('exited');
    expect(got && Array.from(got)).toEqual(Array.from(data));
  });

  it('8088：接收方中断程序里的 PUSH SP / POP SP 在 8086 上会让栈错位', () => {
    const { B, r } = transfer('8088', true);
    expect(r.reason).toBe('error');
    expect(B.message).toContain('代码之外');
  });

  it('真实 8250：发送方不检查 THRE，THR 被覆盖，数据丢失', { timeout: 60_000 }, () => {
    const { A, got } = transfer('386', false);
    expect(A.com1.stats.thrOverwrites).toBeGreaterThan(100);
    expect(got && Array.from(got)).not.toEqual(Array.from(data));
  });
});
