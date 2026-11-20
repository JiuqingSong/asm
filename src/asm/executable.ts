import type { Program } from './types.ts';

/** 把汇编结果写成 DOS COM 或带重定位表的 MZ EXE，不依赖模拟器的固定装载地址。 */
export function generateExecutable(program: Program): Uint8Array {
  if (!program.ok) throw new Error('汇编失败，请先修正源码中的错误');
  if (program.format === 'boot') throw new Error('磁盘引导程序不能导出为 EXE/COM');
  if (!program.relocations) throw new Error('缺少汇编重定位信息，请从汇编源码生成可执行文件');
  const com = program.format === 'com';
  const start = com ? program.pspSeg * 16 + 0x100 : program.loadSeg * 16;
  const end = program.chunks.reduce((end, chunk) => Math.max(end, chunk.addr + chunk.bytes.length), start);
  const size = end - start;
  if (com) {
    if (program.entry.cs !== program.pspSeg || program.entry.ip !== 0x100)
      throw new Error('COM 必须从偏移 100h 开始执行，请使用 ORG 100h 或 .STARTUP，并把入口标号放在起始位置');
    if (program.relocations.length)
      throw new Error('COM 不支持段地址重定位；请用 PUSH CS / POP DS 设置数据段，或改用 .MODEL SMALL 生成 EXE');
    if (size > 0xff00) throw new Error('COM 文件超过 65280 字节');
  } else if (program.imageEnd - start > 0xa0000 - 0x100) {
    throw new Error('EXE 所需内存超过 DOS 常规内存范围');
  }
  if (!size) throw new Error('程序没有可导出的机器码');
  const image = new Uint8Array(size);
  for (const chunk of program.chunks) {
    if (chunk.addr < start) throw new Error('程序内容位于可执行文件装载范围之前，请检查 ORG 和段布局');
    image.set(chunk.bytes, chunk.addr - start);
  }
  if (com) return image;

  const relocations = program.relocations;
  if (relocations.length > 0xffff) throw new Error('EXE 重定位项超过 65535 项');
  const headerSize = Math.ceil((0x1c + relocations.length * 4) / 16) * 16;
  const bytes = new Uint8Array(headerSize + size);
  const view = new DataView(bytes.buffer);
  const w = (at: number, value: number) => view.setUint16(at, value, true);
  w(0, 0x5a4d);
  w(2, bytes.length % 512);
  w(4, Math.ceil(bytes.length / 512));
  w(6, relocations.length);
  w(8, headerSize / 16);
  w(0x0a, Math.max(0, Math.ceil((program.imageEnd - start) / 16) - Math.ceil(size / 16)));
  w(0x0c, 0xffff);
  w(0x0e, program.stack.ss - program.loadSeg);
  w(0x10, program.stack.sp);
  w(0x14, program.entry.ip);
  w(0x16, program.entry.cs - program.loadSeg);
  w(0x18, 0x1c);
  for (const [i, address] of relocations.entries()) {
    const at = address - start;
    if (at < 0 || at + 1 >= size) throw new Error('EXE 重定位地址超出程序映像');
    const segment = ((image[at] | (image[at + 1] << 8)) - program.loadSeg) & 0xffff;
    image[at] = segment & 0xff;
    image[at + 1] = segment >> 8;
    w(0x1c + i * 4, at & 15);
    w(0x1e + i * 4, at >> 4);
  }
  bytes.set(image, headerSize);
  return bytes;
}
