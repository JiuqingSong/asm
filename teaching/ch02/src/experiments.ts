import type { MemoryExperiment } from '../../shared/memory-experiments.ts';

export const EXPERIMENTS: readonly MemoryExperiment[] = [
  {
    id: 'ch02-bases', title: '同一个字节，三种写法',
    question: '十进制 65、十六进制 41、二进制 01000001 是同一位模式。',
    steps: [
      { kind: 'write8', address: 0, value: 65 },
      { kind: 'bytes', address: 0, expected: [0x41] },
      { kind: 'interpret', width: 8, value: 0x41, expectedSigned: 65 },
    ],
  },
  {
    id: 'ch02-endian', title: '低字节在低地址',
    question: '内存只存字节；LE 读写函数定义了如何组成 16 位数。',
    steps: [
      { kind: 'write16', address: 0x10, value: 0x1234 },
      { kind: 'bytes', address: 0x10, expected: [0x34, 0x12] },
      { kind: 'read16', address: 0x10, expected: 0x1234 },
      { kind: 'write8', address: 0x10, value: 0x12 },
      { kind: 'write8', address: 0x11, value: 0x34 },
      { kind: 'read16', address: 0x10, expected: 0x3412 },
    ],
  },
  {
    id: 'ch02-signed', title: '补码：位模式不自带类型',
    question: 'FF 的 8 位解释和 00FF 的 16 位解释为什么不同？',
    steps: [
      { kind: 'interpret', width: 8, value: 0xff, expectedSigned: -1 },
      { kind: 'interpret', width: 16, value: 0xff, expectedSigned: 255 },
      { kind: 'interpret', width: 16, value: 0xffff, expectedSigned: -1 },
      { kind: 'interpret', width: 16, value: 0x8000, expectedSigned: -32768 },
      { kind: 'interpret', width: 16, value: 0x7fff, expectedSigned: 32767 },
    ],
  },
  {
    id: 'ch02-width', title: '位宽与截断：先用宿主数学理解',
    question: '这里展示结果，不执行 ADD，也不产生 FLAGS。CPU 运算在第 4 章实现。',
    steps: [
      { kind: 'sum', width: 8, left: 255, right: 1, expectedLow: 0, expectedOutside: true },
      { kind: 'sum', width: 16, left: 255, right: 1, expectedLow: 256, expectedOutside: false },
      { kind: 'sum', width: 16, left: 65535, right: 1, expectedLow: 0, expectedOutside: true },
    ],
  },
  {
    id: 'ch02-boundary', title: '失败实验：两个字节必须都在范围内',
    question: '在最后一个地址写 16 位值时，不能先写低字节再发现高字节越界。',
    steps: [
      { kind: 'write8', address: 65535, value: 0x5a },
      { kind: 'reject16', address: 65535, value: 0x1234, contains: '地址必须' },
      { kind: 'read8', address: 65535, expected: 0x5a },
      { kind: 'reject16', address: 0, value: 65536, contains: '16 位值必须' },
    ],
  },
];
