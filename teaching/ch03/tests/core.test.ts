import { describe, expect, it } from 'vitest';
import { CPU } from '../src/core.ts';
import { EXPERIMENTS } from '../src/experiments.ts';
import { checkExperiment } from '../../shared/experiment-test.ts';

describe('第 3 章的状态契约', () => {
  for (const experiment of EXPERIMENTS) {
    it(experiment.title, () => checkExperiment(new CPU(), experiment));
  }

  it('全部 MOV r16 编码只修改目标寄存器，FLAGS 不变', () => {
    const cpu = new CPU();
    const code = Array.from({ length: 8 }, (_, i) => [0xb8 + i, i + 1, 0x12]).flat();
    cpu.load([...code, 0xf4]);
    for (let i = 0; i < 8; i++) {
      const before = cpu.state();
      cpu.step();
      const after = cpu.state();
      expect(after.ip).toBe((i + 1) * 3);
      expect(after.flags).toBe(before.flags);
      for (let r = 0; r < 8; r++) expect(after.registers[r]).toBe(r === i ? 0x1200 + i + 1 : before.registers[r]);
    }
  });

  it('查看副本不改变状态；非法装载不覆盖已经运行的机器', () => {
    const cpu = new CPU();
    cpu.load(EXPERIMENTS[0].bytes);
    cpu.step();
    const before = cpu.state();
    cpu.peek(0, 3).fill(0);
    expect(cpu.peek(0, 3)).toEqual(new Uint8Array([0xb8, 0x34, 0x12]));
    expect(cpu.state()).toEqual(before);
    expect(() => cpu.load([256])).toThrow('原状态未修改');
    expect(cpu.state()).toEqual(before);
    cpu.step();
    expect(cpu.state().registers[3]).toBe(0xabcd);
  });

  it('错误不提交半条 MOV；重新装载解除错误', () => {
    const cpu = new CPU();
    cpu.load([0xb8, 0x12]);
    expect(() => cpu.step()).toThrow('指令字节不足');
    expect(cpu.state().registers).toEqual(Array(8).fill(0));
    expect(cpu.state().ip).toBe(0);
    expect(() => cpu.step()).toThrow('指令字节不足');
    cpu.load([0xf4]);
    expect(cpu.state().status).toBe('ready');
    cpu.step();
    expect(cpu.state().status).toBe('halted');
  });
});
