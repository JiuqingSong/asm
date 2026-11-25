import { describe, expect, it } from 'vitest';
import { Memory } from '../src/core.ts';
import { EXPERIMENTS } from '../src/experiments.ts';
import { applyMemoryStep, describeValue, parseInteger } from '../../shared/memory-experiments.ts';

describe('第 2 章：字节与数值解释', () => {
  for (const experiment of EXPERIMENTS) {
    it(experiment.title, () => {
      const memory = new Memory();
      for (const step of experiment.steps) applyMemoryStep(memory, step);
    });
  }

  it('16 位读写只访问相邻两字节，允许非对齐位置', () => {
    const memory = new Memory();
    memory.write8(0, 0x5a);
    memory.write8(3, 0xa5);
    memory.write16LE(1, 0xabcd);
    expect(memory.peek(0, 4)).toEqual(new Uint8Array([0x5a, 0xcd, 0xab, 0xa5]));
    expect(memory.read16LE(1)).toBe(0xabcd);
    memory.write16LE(65534, 0x1234);
    expect(memory.read16LE(65534)).toBe(0x1234);
    expect(() => memory.read16LE(65535)).toThrow('地址必须');
  });

  it('失败的两字节写入不会提交低字节，也不会回绕写地址 0', () => {
    const memory = new Memory();
    memory.write8(0, 0xaa);
    memory.write8(65535, 0x5a);
    expect(() => memory.write16LE(65535, 0x1234)).toThrow('地址必须');
    expect(memory.read8(0)).toBe(0xaa);
    expect(memory.read8(65535)).toBe(0x5a);
    for (const value of [-1, 1.5, 65536]) expect(() => memory.write16LE(0, value)).toThrow('16 位值必须');
    expect(memory.read8(0)).toBe(0xaa);
  });

  it('完整解析三种数值写法，拒绝不完整或不精确的输入', () => {
    expect([parseInteger('65'), parseInteger('0x41'), parseInteger('0b01000001')]).toEqual([65, 65, 65]);
    for (const text of ['0x', '0b102', '65abc', '1.5', '9007199254740993']) expect(() => parseInteger(text)).toThrow();
    expect(() => describeValue(256, 8)).toThrow('位模式必须');
  });
});
