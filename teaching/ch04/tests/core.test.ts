import { describe, expect, it } from 'vitest';
import { CPU } from '../src/core.ts';
import { EXPERIMENTS } from '../src/experiments.ts';
import { checkExperiment } from '../../shared/experiment-test.ts';

describe('第 4 章的状态契约', () => {
  for (const experiment of EXPERIMENTS) {
    it(experiment.title, () => checkExperiment(new CPU(), experiment));
  }

  it('保留上一章全部 MOV 编码和 HLT，非目标寄存器不变', () => {
    const cpu = new CPU();
    cpu.load([...Array.from({ length: 8 }, (_, i) => [0xb8 + i, i + 1, 0x12]).flat(), 0xf4]);
    for (let i = 0; i < 8; i++) {
      const before = cpu.state();
      cpu.step();
      for (let r = 0; r < 8; r++) expect(cpu.state().registers[r]).toBe(r === i ? 0x1200 + i + 1 : before.registers[r]);
      expect(cpu.state().flags).toBe(2);
    }
    cpu.step();
    expect(cpu.state().status).toBe('halted');
  });

  it('SUB 的有符号溢出和 PF 只依据结果低字节', () => {
    const cpu = new CPU();
    cpu.load([0xb8, 0, 0x80, 0x2d, 1, 0, 0xf4]);
    cpu.step(); cpu.step();
    expect(cpu.state().registers[0]).toBe(0x7fff);
    expect(cpu.state().flags & 0x08d5).toBe(0x0814);
  });

  it('逻辑操作清 CF/OF，但未定义 AF 不作为真机契约', () => {
    const cpu = new CPU();
    cpu.load([0xb8, 0xff, 0xff, 0x05, 1, 0, 0x0d, 0, 0x80, 0xf4]);
    cpu.step(); cpu.step(); cpu.step();
    expect(cpu.state().registers[0]).toBe(0x8000);
    expect(cpu.state().flags & 0x08c5).toBe(0x84);
  });

  it('截断算术立即数不改变寄存器或标志；查看不会执行程序', () => {
    const cpu = new CPU();
    cpu.load([0xb8, 7, 0, 0x05, 1]);
    cpu.step();
    const before = cpu.state();
    cpu.peek(0, 5).fill(0);
    expect(cpu.state()).toEqual(before);
    expect(() => cpu.step()).toThrow('指令字节不足');
    expect(cpu.state().ip).toBe(3);
    expect(cpu.state().registers).toEqual(before.registers);
    expect(cpu.state().flags).toBe(before.flags);
  });
});
