import type { Experiment } from '../../shared/contracts.ts';

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: 'ch03-mov', title: '第一条指令：MOV 与 HLT',
    question: 'B8 后面的 34 12 为什么变成 AX=1234h？HLT 后 IP 停在哪里？',
    assembly: 'mov ax, 1234h\nmov bx, 0ABCDh\nhlt',
    bytes: [0xb8, 0x34, 0x12, 0xbb, 0xcd, 0xab, 0xf4],
    checkpoints: [
      { step: 1, ip: 3, registers: { AX: 0x1234, BX: 0 }, flags: { mask: 0xffff, value: 2 } },
      { step: 2, ip: 6, registers: { AX: 0x1234, BX: 0xabcd }, flags: { mask: 0xffff, value: 2 } },
      { step: 3, ip: 7, status: 'halted' },
    ],
  },
  {
    id: 'ch03-endian', title: '改一改：交换立即数的两个字节',
    question: '交换的是程序中的两个字节，不是修改 CPU 的字节序规则。',
    assembly: 'mov ax, 3412h\nhlt',
    bytes: [0xb8, 0x12, 0x34, 0xf4],
    checkpoints: [{ step: 1, ip: 3, registers: { AX: 0x3412 } }, { step: 2, ip: 4, status: 'halted' }],
  },
  {
    id: 'ch03-truncated', title: '失败实验：立即数少一个字节',
    question: '教学装载器是否报告错误，而不是悄悄用后面的零补齐？',
    assembly: '; 不完整的 MOV，由 DB 原样提供\nDB 0B8h, 34h',
    bytes: [0xb8, 0x34],
    checkpoints: [],
    fault: { step: 1, ip: 0, contains: '指令字节不足' },
  },
  {
    id: 'ch03-no-dos', title: '失败实验：CPU 不自带 DOS',
    question: 'CD 21 是 INT 21h 的编码，但本章既未实现 INT，也未安装 DOS。',
    assembly: 'int 21h',
    bytes: [0xcd, 0x21],
    checkpoints: [],
    fault: { step: 1, ip: 0, contains: '本章未实现操作码 cd' },
  },
];
