import { startChapter } from '../../shared/host.ts';
import { CPU } from './core.ts';
import { EXPERIMENTS } from './experiments.ts';

startChapter({
  number: 4, title: 'ALU 与标志位',
  capabilities: '继承 MOV/HLT；增加 ADD、SUB、CMP、AND、OR、XOR 的 AX/16 位立即数编码及 CF/PF/AF/ZF/SF/OF。没有 ADC、字节运算、ModR/M、分段、栈、分支、中断和设备。',
  experiments: EXPERIMENTS, create: () => new CPU(),
});
