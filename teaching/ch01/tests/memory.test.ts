import { describe, expect, it } from 'vitest';
import { Memory } from '../src/core.ts';
import { EXPERIMENTS } from '../src/experiments.ts';
import { applyMemoryStep } from '../../shared/memory-experiments.ts';

describe('第 1 章：只有状态，没有 CPU', () => {
  for (const experiment of EXPERIMENTS) {
    it(experiment.title, () => {
      const memory = new Memory();
      for (const step of experiment.steps) applyMemoryStep(memory, step);
    });
  }

  it('只写目标字节；观察副本不改变内存；重置包括末尾', () => {
    const memory = new Memory();
    memory.write8(10, 0xb8);
    memory.write8(65535, 0x5a);
    expect(memory.peek(9, 3)).toEqual(new Uint8Array([0, 0xb8, 0]));
    memory.peek(10, 1).fill(0);
    expect(memory.read8(10)).toBe(0xb8);
    memory.reset();
    expect(memory.read8(10)).toBe(0);
    expect(memory.read8(65535)).toBe(0);
  });

  it('负数、小数、越界输入被拒绝，不借助定宽数组静默截断', () => {
    const memory = new Memory();
    memory.write8(0, 65);
    for (const value of [-1, 1.5, 256, NaN]) expect(() => memory.write8(0, value)).toThrow('字节必须');
    for (const address of [-1, 0.5, 65536]) expect(() => memory.read8(address)).toThrow('地址必须');
    expect(memory.read8(0)).toBe(65);
  });
});
