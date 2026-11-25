import { startChapter } from '../../shared/host.ts';
import { CPU } from './core.ts';
import { EXPERIMENTS } from './experiments.ts';

startChapter({
  number: 3, title: '第一条指令',
  capabilities: '本章实现：64KB 平坦内存、8 个 16 位通用寄存器、MOV r16/立即数、HLT。没有 ALU、分段、栈、中断、时间模型和操作系统。',
  experiments: EXPERIMENTS, create: () => new CPU(),
});
