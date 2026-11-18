// 随 AsmPerfect 86 提供的 DOS 小工具：源程序在本目录里，用我们自己的汇编器汇编成 .COM 文件，
// 可以放进磁盘映像，在真 DOS 里运行
import { assemble } from '../asm/assembler.ts';
import { comFile } from './com.ts';
import mouseAsm from './mouse.asm?raw';

export { comFile };

export interface DosUtility {
  name: string;
  description: string;
  source: string;
}

export const UTILITIES: DosUtility[] = [
  { name: 'MOUSE.COM', description: '鼠标驱动：让 INT 33h 重新指向虚拟 PC 内置的鼠标驱动（DOS 启动后需要运行一次）', source: mouseAsm },
];

export function buildUtility(u: DosUtility): Uint8Array {
  const p = assemble(u.source);
  const errs = p.diagnostics.filter(d => d.severity === 'error');
  if (errs.length) throw new Error(`${u.name} 汇编出错：` + errs.map(e => `第 ${e.line} 行 ${e.message}`).join('；'));
  return comFile(p);
}
