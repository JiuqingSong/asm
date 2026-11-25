import type { Experiment } from '../../shared/contracts.ts';

const arithmeticMask = 0x08d5;
const logicalMask = 0x08c5;

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: 'ch04-carry', title: '无符号进位：FFFFh + 1',
    question: '结果为零；为什么 CF=1 而 OF=0？',
    assembly: 'mov ax, 0FFFFh\nadd ax, 1\nhlt',
    bytes: [0xb8, 0xff, 0xff, 0x05, 1, 0, 0xf4],
    checkpoints: [
      { step: 1, ip: 3, registers: { AX: 0xffff }, flags: { mask: arithmeticMask, value: 0 } },
      { step: 2, ip: 6, registers: { AX: 0 }, flags: { mask: arithmeticMask, value: 0x55 } },
      { step: 3, ip: 7, status: 'halted' },
    ],
  },
  {
    id: 'ch04-overflow', title: '有符号溢出：7FFFh + 1',
    question: '同样加一，为什么 CF=0 而 OF=1？把期望 OF 改成 0 会使哪个断言失败？',
    assembly: 'mov ax, 7FFFh\nadd ax, 1\nhlt',
    bytes: [0xb8, 0xff, 0x7f, 0x05, 1, 0, 0xf4],
    checkpoints: [
      { step: 1, ip: 3, registers: { AX: 0x7fff } },
      { step: 2, ip: 6, registers: { AX: 0x8000 }, flags: { mask: arithmeticMask, value: 0x894 } },
      { step: 3, ip: 7, status: 'halted' },
    ],
  },
  {
    id: 'ch04-borrow', title: '借位：0 - 1',
    question: 'FFFFh 同时可以解释为无符号 65535 和有符号 -1；位模式本身没有类型。',
    assembly: 'mov ax, 0\nsub ax, 1\nhlt',
    bytes: [0xb8, 0, 0, 0x2d, 1, 0, 0xf4],
    checkpoints: [
      { step: 1, ip: 3, registers: { AX: 0 } },
      { step: 2, ip: 6, registers: { AX: 0xffff }, flags: { mask: arithmeticMask, value: 0x95 } },
      { step: 3, ip: 7, status: 'halted' },
    ],
  },
  {
    id: 'ch04-cmp', title: 'CMP：只改标志，不写回结果',
    question: '3 - 3 等于零，为什么 AX 仍然是 3？',
    assembly: 'mov ax, 3\ncmp ax, 3\nhlt',
    bytes: [0xb8, 3, 0, 0x3d, 3, 0, 0xf4],
    checkpoints: [
      { step: 1, ip: 3, registers: { AX: 3 } },
      { step: 2, ip: 6, registers: { AX: 3 }, flags: { mask: arithmeticMask, value: 0x44 } },
      { step: 3, ip: 7, status: 'halted' },
    ],
  },
  {
    id: 'ch04-logic', title: '位操作：AND、OR、XOR',
    question: '逻辑运算如何设置 ZF、SF、PF，并清除 CF、OF？AF 为什么不参加比较？',
    assembly: 'mov ax, 0F0h\nand ax, 0Fh\nor ax, 80h\nxor ax, 80h\nhlt',
    bytes: [0xb8, 0xf0, 0, 0x25, 0x0f, 0, 0x0d, 0x80, 0, 0x35, 0x80, 0, 0xf4],
    checkpoints: [
      { step: 1, ip: 3, registers: { AX: 0xf0 } },
      { step: 2, ip: 6, registers: { AX: 0 }, flags: { mask: logicalMask, value: 0x44 } },
      { step: 3, ip: 9, registers: { AX: 0x80 }, flags: { mask: logicalMask, value: 0 } },
      { step: 4, ip: 12, registers: { AX: 0 }, flags: { mask: logicalMask, value: 0x44 } },
      { step: 5, ip: 13, status: 'halted' },
    ],
  },
  {
    id: 'ch04-unsupported', title: '失败实验：本章还不会跳转',
    question: 'ALU 已能比较，但分支要到下一章；不能偷偷借用完整 CPU。',
    assembly: 'jmp $',
    bytes: [0xeb, 0xfe],
    checkpoints: [],
    fault: { step: 1, ip: 0, contains: '本章未实现操作码 eb' },
  },
];
