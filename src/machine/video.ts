// 显卡状态：VGA 的 256 色调色板（DAC）和 CGA 的调色板寄存器
//
// 显示模式本身记在 BIOS 数据区（0040:0049）里，像素数据在内存里（A000 或 B800），
// 这里只保存不在内存中的那部分：调色板和端口的读写位置。

/** 显示模式的基本参数 */
export interface ModeInfo {
  graphics: boolean;
  width: number;   // 像素（图形）或字符列数（文本）
  height: number;
  cols: number;    // BIOS 文字列数
  bpp: number;     // 每个像素的位数（图形）
  seg: number;     // 显存段地址
}

export function modeInfo(mode: number): ModeInfo {
  switch (mode) {
    case 0x04: case 0x05: return { graphics: true, width: 320, height: 200, cols: 40, bpp: 2, seg: 0xb800 };
    case 0x06: return { graphics: true, width: 640, height: 200, cols: 80, bpp: 1, seg: 0xb800 };
    case 0x13: return { graphics: true, width: 320, height: 200, cols: 40, bpp: 8, seg: 0xa000 };
    case 0x00: case 0x01: return { graphics: false, width: 40, height: 25, cols: 40, bpp: 0, seg: 0xb800 };
    case 0x07: return { graphics: false, width: 80, height: 25, cols: 80, bpp: 0, seg: 0xb000 };
    default: return { graphics: false, width: 80, height: 25, cols: 80, bpp: 0, seg: 0xb800 };
  }
}

/** 支持的显示模式（其余的给出提示） */
export const SUPPORTED_MODES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x13]);

/** CGA/EGA 的 16 种颜色（6 位分量，0~63） */
const EGA16: [number, number, number][] = [
  [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42], [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
  [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63], [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
];

/** VGA 开机时 256 色模式的默认调色板（6 位分量） */
export function defaultDac(): Uint8Array {
  const dac = new Uint8Array(768);
  const set = (i: number, r: number, g: number, b: number) => { dac[i * 3] = r; dac[i * 3 + 1] = g; dac[i * 3 + 2] = b; };
  EGA16.forEach(([r, g, b], i) => set(i, r, g, b));
  // 16~31：16 级灰度
  const grays = [0, 5, 8, 11, 14, 17, 20, 24, 28, 32, 36, 40, 45, 50, 56, 63];
  grays.forEach((v, i) => set(16 + i, v, v, v));
  // 32~247：9 组色环，每组 24 种色相（亮/中/暗 × 饱和度高/中/低）
  const groups: [number, number][] = [[63, 0], [63, 31], [63, 45], [28, 0], [28, 14], [28, 20], [16, 0], [16, 8], [16, 11]];
  let i = 32;
  for (const [hi, lo] of groups) {
    const steps = [0, 1, 2, 3, 4].map(k => Math.round(lo + ((hi - lo) * k) / 4));
    const up = steps, down = [...steps].reverse();
    // 色环：蓝 -> 品红 -> 红 -> 黄 -> 绿 -> 青 -> 蓝
    for (let k = 0; k < 4; k++) set(i++, up[k], lo, hi);       // 蓝 -> 品红：红色分量上升
    for (let k = 0; k < 4; k++) set(i++, hi, lo, down[k]);     // 品红 -> 红：蓝色分量下降
    for (let k = 0; k < 4; k++) set(i++, hi, up[k], lo);       // 红 -> 黄：绿色分量上升
    for (let k = 0; k < 4; k++) set(i++, down[k], hi, lo);     // 黄 -> 绿：红色分量下降
    for (let k = 0; k < 4; k++) set(i++, lo, hi, up[k]);       // 绿 -> 青：蓝色分量上升
    for (let k = 0; k < 4; k++) set(i++, lo, down[k], hi);     // 青 -> 蓝：绿色分量下降
  }
  // 248~255：黑色
  return dac;
}

export class Video {
  /** 256 色调色板，每种颜色 3 个 6 位分量 */
  dac = defaultDac();
  pelMask = 0xff;
  private writeIndex = 0;
  private writeSub = 0;
  private readIndex = 0;
  private readSub = 0;
  /** CGA 颜色选择寄存器（端口 3D9h）：位 0~3 背景/边框色，位 4 高亮，位 5 调色板 1 */
  cgaColor = 0x20;
  /** 调色板被修改的次数（界面据此判断是否需要重画） */
  version = 0;

  reset(): void {
    this.dac = defaultDac();
    this.pelMask = 0xff;
    this.writeIndex = this.writeSub = this.readIndex = this.readSub = 0;
    this.cgaColor = 0x20;
    this.version++;
  }

  setColor(i: number, r: number, g: number, b: number): void {
    this.dac[i * 3] = r & 63; this.dac[i * 3 + 1] = g & 63; this.dac[i * 3 + 2] = b & 63;
    this.version++;
  }

  in8(port: number): number {
    switch (port) {
      case 0x3c6: return this.pelMask;
      case 0x3c7: return 0x03; // DAC 状态：读模式
      case 0x3c8: return this.writeIndex;
      case 0x3c9: {
        const v = this.dac[this.readIndex * 3 + this.readSub];
        if (++this.readSub === 3) { this.readSub = 0; this.readIndex = (this.readIndex + 1) & 0xff; }
        return v;
      }
      case 0x3d9: return this.cgaColor;
    }
    return 0xff;
  }

  out8(port: number, v: number): boolean {
    switch (port) {
      case 0x3c6: this.pelMask = v; this.version++; return true;
      case 0x3c7: this.readIndex = v; this.readSub = 0; return true;
      case 0x3c8: this.writeIndex = v; this.writeSub = 0; return true;
      case 0x3c9:
        this.dac[this.writeIndex * 3 + this.writeSub] = v & 63;
        this.version++;
        if (++this.writeSub === 3) { this.writeSub = 0; this.writeIndex = (this.writeIndex + 1) & 0xff; }
        return true;
      case 0x3d9: this.cgaColor = v; this.version++; return true;
      case 0x3c0: case 0x3c4: case 0x3c5: case 0x3ce: case 0x3cf: case 0x3c2: case 0x3d8: return true; // EGA/VGA 其他寄存器：接受但不模拟
    }
    return false;
  }

  /** CGA 四色模式的 4 种颜色（RGB 6 位分量） */
  cgaColors(mode: number): [number, number, number][] {
    const bg = EGA16[this.cgaColor & 15];
    const bright = (this.cgaColor & 0x10) !== 0;
    const pal1 = mode === 0x05 ? false : (this.cgaColor & 0x20) !== 0;
    // 调色板 0：绿、红、棕；调色板 1：青、品红、白（高亮时用亮色）；模式 5（单色复合）用青、红、白
    const idx = mode === 0x05 ? [3, 4, 7] : pal1 ? [3, 5, 7] : [2, 4, 6];
    return [bg, ...idx.map(k => EGA16[k + (bright ? 8 : 0)])];
  }
}
