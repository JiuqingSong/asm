import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { generateExecutable } from '../src/asm/executable.ts';
import { loadExecutable } from '../src/machine/exe.ts';
import { Machine } from '../src/machine/machine.ts';
import { EXAMPLES } from '../src/ui/examples.ts';

function run(bytes: Uint8Array, name: string, loadSeg: number): Machine {
  const { program } = loadExecutable(bytes, name, loadSeg);
  const m = new Machine();
  m.load(program);
  expect(m.run(10000)).toBe('exit');
  return m;
}

describe('生成 DOS 可执行文件', () => {
  it.each([0x800, 0x2345])('EXE 在不同装载地址 %i 运行，段地址由 DOS 重定位', loadSeg => {
    const source = EXAMPLES.find(e => e.id === 'hello')!.source;
    const p = assemble(source);
    const bytes = generateExecutable(p);
    const { program, info } = loadExecutable(bytes, 'HELLO.EXE', loadSeg);
    expect(info.format).toBe('exe');
    expect(info.relocations).toBeGreaterThan(0);
    expect(program.entry.cs).toBe(loadSeg + p.entry.cs - p.loadSeg);
    expect(run(bytes, 'HELLO.EXE', loadSeg).console).toBe('Hello, 8086!\n');
  });

  it('远调用、DD 远指针、DUP 段地址都产生正确的重定位', () => {
    const source = `
DATA SEGMENT
pointer dd target
copies dw 2 dup(seg target)
msg db 'FAR!$'
DATA ENDS
STACK1 SEGMENT STACK
dw 64 dup(?)
STACK1 ENDS
CODE SEGMENT
assume cs:CODE, ds:DATA, ss:STACK1
start: mov ax, DATA
mov ds, ax
call far ptr target
mov ax, 4c00h
int 21h
CODE ENDS
OTHER SEGMENT
assume cs:OTHER, ds:DATA
target proc far
mov dx, offset msg
mov ah, 9
int 21h
retf
target endp
OTHER ENDS
end start`;
    const p = assemble(source);
    expect(p.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const bytes = generateExecutable(p);
    const loadSeg = 0x2345;
    const { info } = loadExecutable(bytes, 'FAR.EXE', loadSeg);
    expect(info.relocations).toBe(5);
    const m = run(bytes, 'FAR.EXE', loadSeg);
    expect(m.console).toBe('FAR!');
    const target = p.symbols.find(s => s.name.toLowerCase() === 'target')!;
    const expected = target.segment - p.loadSeg + loadSeg;
    for (const [name, offsets] of [['pointer', [2]], ['copies', [0, 2]]] as const) {
      const sym = p.symbols.find(s => s.name.toLowerCase() === name)!;
      const at = (sym.segment - p.loadSeg + loadSeg) * 16 + sym.offset;
      for (const off of offsets) expect(m.mem[at + off] | (m.mem[at + off + 1] << 8)).toBe(expected);
    }
  });

  it('COM 去掉 ORG 100h 的前缀空洞，在另一个 PSP 地址运行', () => {
    const p = assemble(`.model tiny
.code
org 100h
start: push cs
pop ds
mov dx, offset msg
mov ah, 9
int 21h
mov ax, 4c00h
int 21h
msg db 'COM!$'
end start`);
    const bytes = generateExecutable(p);
    expect(bytes[0]).toBe(0x0e);
    expect(bytes.length).toBe(p.chunks[0].bytes.length);
    expect(run(bytes, 'TEST.COM', 0x2345).console).toBe('COM!');
  });

  it('EXE 文件头为未显式定义的堆栈保留足够内存', () => {
    const p = assemble('.model small\n.code\nstart: mov ax, 4c00h\nint 21h\nend start');
    const bytes = generateExecutable(p);
    const { program, info } = loadExecutable(bytes, 'STACK.EXE', 0x2345);
    expect(info.minAlloc).toBe(0x40);
    expect(Math.ceil(info.imageSize / 16) + info.minAlloc).toBe((program.stack.ss - program.loadSeg) + program.stack.sp / 16);
    run(bytes, 'STACK.EXE', 0x2345);
  });

  it('ORG 覆盖段地址后，不对新的常量执行重定位', () => {
    const p = assemble('.model small\n.code\nstart: dw seg start\norg 0\ndw 1234h\nend start');
    const bytes = generateExecutable(p);
    const { program, info } = loadExecutable(bytes, 'ORG.EXE', 0x2345);
    expect(info.relocations).toBe(0);
    expect([...program.chunks[0].bytes]).toEqual([0x34, 0x12]);
  });

  it.each([
    ['.model tiny\n.code\nstart: nop\nend start', /100h/],
    ['.model tiny\n.code\norg 100h\nstart: mov ax, @data\nend start', /COM 不支持段地址重定位/],
    ['.model small\n.code\nend', /没有可导出/],
    ['not_a_valid_instruction', /汇编失败/],
  ])('不能生成有效文件时明确报错，不下载错误的映像：%s', (source, error) => {
    expect(() => generateExecutable(assemble(source))).toThrow(error);
  });
});
