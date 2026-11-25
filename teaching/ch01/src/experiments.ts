import type { MemoryExperiment } from '../../shared/memory-experiments.ts';

export const EXPERIMENTS: readonly MemoryExperiment[] = [
  {
    id: 'ch01-state', title: '状态有了，CPU 还没有',
    question: '操作来自宿主函数，不是客体指令。没有 CPU 时，B8 也只是一个内存字节。',
    steps: [
      { kind: 'read8', address: 0, expected: 0 },
      { kind: 'write8', address: 0, value: 0xb8 },
      { kind: 'write8', address: 1, value: 0x34 },
      { kind: 'write8', address: 2, value: 0x12 },
      { kind: 'bytes', address: 0, expected: [0xb8, 0x34, 0x12, 0] },
    ],
  },
  {
    id: 'ch01-address', title: '地址与内容是不同的数',
    question: '地址 16 里放 65，不意味着地址 65 也放 16。',
    steps: [
      { kind: 'write8', address: 16, value: 65 },
      { kind: 'read8', address: 16, expected: 65 },
      { kind: 'read8', address: 65, expected: 0 },
      { kind: 'copy', address: 16, length: 1 },
    ],
  },
  {
    id: 'ch01-bounds', title: '失败实验：不悄悄截断错误输入',
    question: '数组本身可能转换超范围数值，但接口应明确拒绝，并保持原内存。',
    steps: [
      { kind: 'write8', address: 0, value: 0x41 },
      { kind: 'reject8', address: 0, value: 256, contains: '字节必须' },
      { kind: 'reject8', address: 65536, value: 1, contains: '地址必须' },
      { kind: 'read8', address: 0, expected: 0x41 },
    ],
  },
];
