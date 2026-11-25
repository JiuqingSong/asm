import { EXPERIMENTS as CH03 } from '../../teaching/ch03/src/experiments.ts';
import { EXPERIMENTS as CH04 } from '../../teaching/ch04/src/experiments.ts';
import type { Experiment } from '../../teaching/shared/contracts.ts';
import type { MachineConfig } from '../machine/config.ts';

export const TEACHING_EXPERIMENTS: readonly Experiment[] = [...CH03, ...CH04];

export const TEACHING_CONFIG: Readonly<MachineConfig> = Object.freeze(
  {
    fpu: false, bios: false, dos: false, mouseDriver: false,
    pic: false, slavePic: false, pit: false, keyboard: false, dma: false, rtc: false,
    vga: false, speaker: false, sound: false, com1: false, com2: false,
    fdc: false, floppyA: false, floppyB: false, ide: false, cdrom: false, serialMouse: false,
  },
);

export function teachingSource(experiment: Experiment): string {
  const checkpoints = experiment.checkpoints.map(c =>
    `; 步 ${c.step}：相对 IP=${c.ip}，寄存器 ${JSON.stringify(c.registers ?? {})}`
    + (c.flags ? `，FLAGS & ${c.flags.mask.toString(16)}h = ${c.flags.value.toString(16)}h` : '')
    + (c.status ? `，状态 ${c.status}` : ''),
  ).join('\n');
  const ends = experiment.checkpoints.length ? experiment.checkpoints.map(c => c.ip) : [experiment.bytes.length];
  let start = 0;
  const instructions = experiment.assembly.split('\n').filter(line => line.trim() && !line.trim().startsWith(';'));
  const encoded = ends.map((end, index) => {
    const bytes = experiment.bytes.slice(start, end);
    start = end;
    return `DB ${bytes.map(byte => '0' + byte.toString(16).toUpperCase() + 'h').join(', ')} ; ${instructions[index] ?? '原始字节'}`;
  }).join('\n');
  return `; 教学对照：${experiment.title}
; 完整 CPU，关闭全部可选硬件、BIOS、DOS、鼠标驱动。
; 宿主汇编和装载提供入口；相对 IP = 当前 IP - 100h。
; 本例无系统输出。HLT 不等于 DOS 退出；到 HLT 后停止单步即可。
; 独立教学错误不等于真 CPU 异常；失败变体请优先在章节页面运行。
; 相同助记符可有多种编码；用 DB 保留书中的 AX 专用操作码，
; 避免汇编器自动选择本章尚未实现的 83h/ModR/M 短立即数形式。
${checkpoints}
code segment
assume cs:code
org 100h
start:
${encoded}
code ends
end start
`;
}
