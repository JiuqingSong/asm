// 把汇编好的 COM 程序变成 .COM 文件的字节
import type { Program } from '../asm/types.ts';

/** 汇编出来的 COM 程序在内存里的映像（从 PSP:0100 开始） */
export function comFile(p: Program): Uint8Array {
  if (!p.ok || p.format !== 'com') throw new Error('不是 COM 格式的程序');
  const start = p.pspSeg * 16 + 0x100;
  let end = start;
  for (const c of p.chunks) end = Math.max(end, c.addr + c.bytes.length);
  const out = new Uint8Array(end - start);
  for (const c of p.chunks) out.set(c.bytes, c.addr - start);
  return out;
}
