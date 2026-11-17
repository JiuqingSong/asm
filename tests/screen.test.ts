import { describe, it, expect } from 'vitest';
import { layoutGbk } from '../src/ui/screen.ts';

/** 用 GBK 字节和 CP437 制表符拼出一屏（80×25） */
function screen(rows: (number[] | string)[]): Uint8Array {
  const out = new Uint8Array(80 * 25).fill(0x20);
  const gbk = (s: string): number[] => {
    // 测试只用到下面几个字的 GBK 编码
    const table: Record<string, number[]> = { 文: [0xce, 0xc4], 件: [0xbc, 0xfe], 新: [0xd0, 0xc2], 建: [0xbd, 0xa8], 打: [0xb4, 0xf2], 开: [0xbf, 0xaa] };
    return [...s].flatMap(ch => table[ch] ?? [ch.charCodeAt(0)]);
  };
  rows.forEach((r, i) => { const bytes = typeof r === 'string' ? gbk(r) : r; out.set(bytes, i * 80); });
  return out;
}

describe('中文显示：GBK 与制表符', () => {
  it('菜单框是表格线，框里和框外的汉字都是汉字', () => {
    const ch = screen([
      '    文件',                                                   // 第 0 行：文=CE C4，两个字节都在制表符范围内
      [0xc9, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xbb], // ╔════════╗（C9 CD 也是汉字"赏"）
      [0xba, 0x20, ...[0xd0, 0xc2, 0xbd, 0xa8], 0x20, 0x20, 0x20, 0xba], // ║ 新建   ║
      [0xba, 0x20, ...[0xb4, 0xf2, 0xbf, 0xaa], 0x20, 0x20, 0x20, 0xba], // ║ 打开   ║
      [0xc8, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xbc], // ╚════════╝
    ]);
    const k = layoutGbk(ch);
    const row = (r: number, n: number) => Array.from(k.subarray(r * 80, r * 80 + n));
    expect(row(0, 8)).toEqual([0, 0, 0, 0, 1, 2, 1, 2]);           // 文件：汉字
    expect(row(1, 10)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);    // 上边框
    expect(row(2, 10)).toEqual([3, 0, 1, 2, 1, 2, 0, 0, 0, 3]);    // ║ 新建   ║
    expect(row(3, 10)).toEqual([3, 0, 1, 2, 1, 2, 0, 0, 0, 3]);    // ║ 打开   ║（打=B4 ┤ 在 新=D0 ╨ 下面，不能连成线）
    expect(row(4, 10)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);    // 下边框
  });

  it('上下对齐的相同汉字不会连成表格线', () => {
    const ch = screen([
      [0xc9, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xbb],
      [0xba, 0x20, ...[0xd0, 0xc2, 0xbd, 0xa8, 0xce, 0xc4, 0xbc, 0xfe], 0xba], // ║ 新建文件║
      [0xba, 0x20, ...[0xb4, 0xf2, 0xbf, 0xaa, 0xce, 0xc4, 0xbc, 0xfe], 0xba], // ║ 打开文件║（两个"文"上下对齐）
      [0xc8, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xbc],
    ]);
    const k = layoutGbk(ch);
    const row = (r: number) => Array.from(k.subarray(r * 80, r * 80 + 11));
    expect(row(1)).toEqual([3, 0, 1, 2, 1, 2, 1, 2, 1, 2, 3]);
    expect(row(2)).toEqual([3, 0, 1, 2, 1, 2, 1, 2, 1, 2, 3]);
  });
});
