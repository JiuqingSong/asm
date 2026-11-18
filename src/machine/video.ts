// 显卡状态：VGA 的 256 色调色板（DAC）、CGA 的调色板寄存器、EGA/VGA 的 4 位平面显存
//
// 显示模式本身记在 BIOS 数据区（0040:0049）里。CGA 模式和 13h 模式的像素数据就在内存里
// （B800 或 A000），平面模式（0Dh、0Eh、10h、12h）的像素数据在显卡自己的 4 个平面里，
// CPU 读写 A000 段时经过这里的图形控制器。

/** 显示模式的基本参数 */
export interface ModeInfo {
  graphics: boolean;
  width: number;   // 像素（图形）或字符列数（文本）
  height: number;
  cols: number;    // BIOS 文字列数
  bpp: number;     // 每个像素的位数（图形）
  seg: number;     // 显存段地址
  rows: number;    // BIOS 文字行数
  charH: number;   // 字符高度（像素）
  planar: boolean; // EGA/VGA 的 4 位平面模式
}

/**
 * 不是 BIOS 模式号：256 色、但不用链式寻址（像素分散在 4 个平面里，"Mode X"）。Windows 95 的启动画面
 * （320×400）就是先设模式 13h 再改寄存器得到的
 */
export const MODE_UNCHAINED = 0x7f;

export function modeInfo(mode: number): ModeInfo {
  const g = (width: number, height: number, bpp: number, seg: number, charH = 8, planar = false): ModeInfo =>
    ({ graphics: true, width, height, cols: width >> 3, bpp, seg, rows: Math.floor(height / charH), charH, planar });
  const t = (cols: number, seg: number): ModeInfo =>
    ({ graphics: false, width: cols, height: 25, cols, bpp: 0, seg, rows: 25, charH: 8, planar: false });
  switch (mode) {
    case 0x04: case 0x05: return g(320, 200, 2, 0xb800);
    case 0x06: return g(640, 200, 1, 0xb800);
    case 0x0d: return g(320, 200, 4, 0xa000, 8, true);
    case 0x0e: return g(640, 200, 4, 0xa000, 8, true);
    case 0x10: return g(640, 350, 4, 0xa000, 14, true);
    case 0x12: return g(640, 480, 4, 0xa000, 16, true);
    case 0x13: return g(320, 200, 8, 0xa000);
    case MODE_UNCHAINED: return g(320, 400, 8, 0xa000); // 实际的宽高由 CRTC 决定（unchainedSize）
    case 0x00: case 0x01: return t(40, 0xb800);
    case 0x07: return t(80, 0xb000);
    default: return t(80, 0xb800);
  }
}

/** 支持的显示模式（其余的给出提示） */
export const SUPPORTED_MODES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0d, 0x0e, 0x10, 0x12, 0x13]);

/** CGA/EGA 的 16 种颜色（6 位分量，0~63） */
const EGA16: [number, number, number][] = [
  [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42], [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
  [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63], [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
];

/** EGA 的 64 种颜色：颜色号的 6 位是 rgbRGB（小写的每位 1/3 亮度，大写的每位 2/3 亮度） */
function ega64(i: number): [number, number, number] {
  const c = (hi: number, lo: number) => ((i >> hi) & 1) * 42 + ((i >> lo) & 1) * 21;
  return [c(2, 5), c(1, 4), c(0, 3)];
}

/** 属性控制器的 16 个调色板寄存器：VGA BIOS 在 16 色模式下的默认值 */
const ATTR_DEFAULT = [0, 1, 2, 3, 4, 5, 0x14, 7, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f];

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

/**
 * EGA/VGA 的 4 位平面显存（模式 0Dh、0Eh、10h、12h）
 *
 * A000 段的每个字节地址对应 4 个平面里各一个字节，一个像素的颜色号由 4 个平面里的同一位拼成。
 * CPU 读写这段地址要经过图形控制器：读的时候把 4 个平面装进锁存器，
 * 写的时候按写模式、逻辑运算、位屏蔽和平面屏蔽把数据和锁存器合成后写进各个平面。
 */
export class Planar {
  planes = [new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(65536)];
  latch = [0, 0, 0, 0];
  /** 定序器寄存器（3C4h/3C5h），2 = 平面屏蔽 */
  seq = new Uint8Array(8);
  /** 图形控制器寄存器（3CEh/3CFh）：0 置位/复位，1 允许置位/复位，2 颜色比较，3 循环移位和逻辑运算，
   *  4 读平面选择，5 读写模式，7 颜色无关，8 位屏蔽 */
  gc = new Uint8Array(16);
  seqIndex = 0;
  gcIndex = 0;
  /** 写入时记录旧值（用于反向执行），地址 = 平面号 × 65536 + 偏移 */
  onWrite: ((addr: number, old: number) => void) | null = null;
  /** 显存被写过的次数（界面据此判断是否需要重画） */
  writes = 0;

  reset(): void {
    for (const p of this.planes) p.fill(0);
    this.latch = [0, 0, 0, 0];
    this.seq.fill(0); this.gc.fill(0);
    this.seq[2] = 0x0f; this.seq[4] = 0x06;
    this.gc[6] = 0x05; this.gc[7] = 0x0f; this.gc[8] = 0xff;
    this.seqIndex = this.gcIndex = 0;
    this.writes++;
  }

  read(off: number): number {
    const p = this.planes, l = this.latch, gc = this.gc;
    l[0] = p[0][off]; l[1] = p[1][off]; l[2] = p[2][off]; l[3] = p[3][off];
    if (gc[5] & 0x08) { // 读模式 1：和颜色比较寄存器比较，相同的像素位为 1
      const cc = gc[2], dc = gc[7];
      let res = 0xff;
      for (let k = 0; k < 4; k++) if ((dc >> k) & 1) res &= (cc >> k) & 1 ? l[k] : ~l[k];
      return res & 0xff;
    }
    return l[gc[4] & 3];
  }

  write(off: number, v: number): void {
    const gc = this.gc, l = this.latch;
    const wm = gc[5] & 3, rot = gc[3] & 7, fn = (gc[3] >> 3) & 3;
    const mapMask = this.seq[2] & 0x0f;
    let bm = gc[8];
    if (rot && (wm === 0 || wm === 3)) v = ((v >> rot) | (v << (8 - rot))) & 0xff;
    if (wm === 3) bm &= v;
    for (let k = 0; k < 4; k++) {
      if (!((mapMask >> k) & 1)) continue;
      let d: number;
      if (wm === 1) d = l[k]; // 写模式 1：直接写回锁存器（显存到显存的复制）
      else {
        if (wm === 0) d = (gc[1] >> k) & 1 ? ((gc[0] >> k) & 1 ? 0xff : 0) : v;
        else if (wm === 2) d = (v >> k) & 1 ? 0xff : 0;
        else d = (gc[0] >> k) & 1 ? 0xff : 0;
        if (fn === 1) d &= l[k]; else if (fn === 2) d |= l[k]; else if (fn === 3) d ^= l[k];
        d = (d & bm) | (l[k] & ~bm & 0xff);
      }
      const plane = this.planes[k];
      if (this.onWrite) this.onWrite(k * 65536 + off, plane[off]);
      plane[off] = d;
    }
    this.writes++;
  }

  /** 一个像素的颜色号（bit 0 是字节里最左边的像素） */
  pixel(off: number, bit: number): number {
    const p = this.planes, s = 7 - bit;
    return ((p[0][off] >> s) & 1) | (((p[1][off] >> s) & 1) << 1) | (((p[2][off] >> s) & 1) << 2) | (((p[3][off] >> s) & 1) << 3);
  }

  /** BIOS 用：直接写一个像素（不经过图形控制器） */
  setPixel(off: number, bit: number, color: number, xor: boolean): void {
    const m = 0x80 >> bit;
    for (let k = 0; k < 4; k++) {
      const plane = this.planes[k], old = plane[off];
      const on = (color >> k) & 1;
      const v = xor ? (on ? old ^ m : old) : on ? old | m : old & ~m;
      if (v !== old) { if (this.onWrite) this.onWrite(k * 65536 + off, old); plane[off] = v; }
    }
    this.writes++;
  }

  /** BIOS 用：直接写一个字节的 4 个平面 */
  setByte(off: number, k: number, v: number): void {
    const plane = this.planes[k];
    if (plane[off] === v) return;
    if (this.onWrite) this.onWrite(k * 65536 + off, plane[off]);
    plane[off] = v;
    this.writes++;
  }

  /** 清空 4 个平面 */
  clear(): void {
    for (const p of this.planes) p.fill(0);
    this.writes++;
  }

  /** 恢复反向执行记录的旧值 */
  restore(addr: number, old: number): void {
    this.planes[(addr >> 16) & 3][addr & 0xffff] = old;
    this.writes++;
  }
}

/**
 * 标准 VGA BIOS 在各显示模式下装入的寄存器值（杂项输出、定序器 0~4、CRTC 0~18h、图形控制器 0~8、
 * 属性控制器 10h~14h）。程序（例如 Windows 386 增强模式的显卡驱动）会把这些寄存器读出来保存、判断当前模式
 */
interface ModeRegs { misc: number; seq: number[]; crtc: number[]; gc: number[]; attr: number[] }
const TEXT_GC = [0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x0e, 0x00, 0xff];
const PLANAR_GC = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x0f, 0xff];
const T40: ModeRegs = {
  misc: 0x67, seq: [0x03, 0x08, 0x03, 0x00, 0x02],
  crtc: [0x2d, 0x27, 0x28, 0x90, 0x2b, 0xa0, 0xbf, 0x1f, 0x00, 0x4f, 0x0d, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x14, 0x1f, 0x96, 0xb9, 0xa3, 0xff],
  gc: TEXT_GC, attr: [0x0c, 0x00, 0x0f, 0x08, 0x00],
};
const T80: ModeRegs = {
  misc: 0x67, seq: [0x03, 0x00, 0x03, 0x00, 0x02],
  crtc: [0x5f, 0x4f, 0x50, 0x82, 0x55, 0x81, 0xbf, 0x1f, 0x00, 0x4f, 0x0d, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x1f, 0x96, 0xb9, 0xa3, 0xff],
  gc: TEXT_GC, attr: [0x0c, 0x00, 0x0f, 0x08, 0x00],
};
const CGA4: ModeRegs = {
  misc: 0x63, seq: [0x03, 0x09, 0x03, 0x00, 0x02],
  crtc: [0x2d, 0x27, 0x28, 0x90, 0x2b, 0x80, 0xbf, 0x1f, 0x00, 0xc1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x14, 0x00, 0x96, 0xb9, 0xa2, 0xff],
  gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x0f, 0x00, 0xff], attr: [0x01, 0x00, 0x03, 0x00, 0x00],
};
const VGA_MODE_REGS: Record<number, ModeRegs> = {
  0x00: T40, 0x01: T40, 0x02: T80, 0x03: T80, 0x04: CGA4, 0x05: CGA4,
  0x06: {
    misc: 0x63, seq: [0x03, 0x01, 0x01, 0x00, 0x06],
    crtc: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0xc1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x00, 0x96, 0xb9, 0xc2, 0xff],
    gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0d, 0x00, 0xff], attr: [0x01, 0x00, 0x01, 0x00, 0x00],
  },
  0x0d: {
    misc: 0x63, seq: [0x03, 0x09, 0x0f, 0x00, 0x06],
    crtc: [0x2d, 0x27, 0x28, 0x90, 0x2b, 0x80, 0xbf, 0x1f, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x14, 0x00, 0x96, 0xb9, 0xe3, 0xff],
    gc: PLANAR_GC, attr: [0x01, 0x00, 0x0f, 0x00, 0x00],
  },
  0x0e: {
    misc: 0x63, seq: [0x03, 0x01, 0x0f, 0x00, 0x06],
    crtc: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x00, 0x96, 0xb9, 0xe3, 0xff],
    gc: PLANAR_GC, attr: [0x01, 0x00, 0x0f, 0x00, 0x00],
  },
  0x10: {
    misc: 0xa3, seq: [0x03, 0x01, 0x0f, 0x00, 0x06],
    crtc: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x83, 0x85, 0x5d, 0x28, 0x0f, 0x63, 0xba, 0xe3, 0xff],
    gc: PLANAR_GC, attr: [0x01, 0x00, 0x0f, 0x00, 0x00],
  },
  0x12: {
    misc: 0xe3, seq: [0x03, 0x01, 0x0f, 0x00, 0x06],
    crtc: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0x0b, 0x3e, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xea, 0x8c, 0xdf, 0x28, 0x00, 0xe7, 0x04, 0xe3, 0xff],
    gc: PLANAR_GC, attr: [0x01, 0x00, 0x0f, 0x00, 0x00],
  },
  0x13: {
    misc: 0x63, seq: [0x03, 0x01, 0x0f, 0x00, 0x0e],
    crtc: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x40, 0x96, 0xb9, 0xa3, 0xff],
    gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x05, 0x0f, 0xff], attr: [0x41, 0x00, 0x0f, 0x00, 0x00],
  },
};

export class Video {
  /** CRTC 寄存器（3D4h/3D5h）和杂项输出寄存器（3C2h 写、3CCh 读） */
  crtc = new Uint8Array(32);
  crtcIndex = 0;
  misc = 0x67;

  /** 256 色调色板，每种颜色 3 个 6 位分量 */
  dac = defaultDac();
  pelMask = 0xff;
  private writeIndex = 0;
  private writeSub = 0;
  private readIndex = 0;
  private readSub = 0;
  /** CGA 颜色选择寄存器（端口 3D9h）：位 0~3 背景/边框色，位 4 高亮，位 5 调色板 1 */
  cgaColor = 0x20;
  /** 4 位平面显存和图形控制器、定序器 */
  planar = new Planar();
  /** 属性控制器：16 个调色板寄存器 + 模式控制（10h）、颜色平面允许（12h）、颜色选择（14h） */
  attr = new Uint8Array(0x15);
  private attrIndex = 0;
  private attrFlip = false;
  /** 调色板被修改的次数（界面据此判断是否需要重画） */
  version = 0;

  constructor() { this.reset(); }

  reset(): void {
    this.dac = defaultDac();
    this.pelMask = 0xff;
    this.writeIndex = this.writeSub = this.readIndex = this.readSub = 0;
    this.cgaColor = 0x20;
    this.attr.fill(0);
    this.attr.set(ATTR_DEFAULT);
    this.attr[0x10] = 0x01; this.attr[0x12] = 0x0f;
    this.attrIndex = 0; this.attrFlip = false;
    this.planar.reset();
    this.version++;
  }

  /** BIOS 切换到 16 色平面模式：清显存，恢复寄存器，DAC 装入 EGA 的 64 种颜色 */
  enterPlanar(mode: number): void {
    this.reset();
    if (mode === 0x0d || mode === 0x0e) {
      // 200 行模式和 CGA 兼容：调色板寄存器直接指向前 16 种 DAC 颜色
      for (let i = 0; i < 16; i++) this.attr[i] = i;
    } else {
      for (let i = 0; i < 64; i++) {
        const [r, g, b] = ega64(i);
        this.dac[i * 3] = r; this.dac[i * 3 + 1] = g; this.dac[i * 3 + 2] = b;
      }
    }
    this.version++;
  }

  /**
   * 装入标准 VGA BIOS 在这个模式下设置的寄存器值（定序器、CRTC、图形控制器、属性控制器的模式寄存器、杂项输出）。
   * 调色板寄存器（属性 0~0Fh）不动，由各模式自己的代码设置
   */
  /** BIOS 设置这个模式时装入的属性调色板（16 个）和 DAC（256 色模式 256 种颜色，其余 64 种 EGA 颜色） */
  static modePalette(mode: number): { attr: number[]; dac: Uint8Array } {
    if (mode === 0x13) return { attr: Array.from({ length: 16 }, (_, i) => i), dac: defaultDac() };
    const dac = new Uint8Array(64 * 3);
    for (let i = 0; i < 64; i++) dac.set(ega64(i), i * 3);
    let attr = ATTR_DEFAULT;
    if (mode === 0x0d || mode === 0x0e) attr = [0, 1, 2, 3, 4, 5, 6, 7, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17];
    else if (mode === 0x04 || mode === 0x05) attr = [0, 0x13, 0x15, 0x17, 2, 4, 6, 7, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17];
    else if (mode === 0x06) attr = [0, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17];
    return { attr, dac };
  }

  /** 这个模式的寄存器表（杂项输出、定序器 0~4、CRTC 0~18h、图形控制器 0~8、属性 10h~14h），不改寄存器 */
  static modeTable(mode: number): number[] {
    const t = VGA_MODE_REGS[mode] ?? T80;
    return [t.misc, ...t.seq, ...t.crtc, ...t.gc, ...t.attr];
  }

  // ---------- 显存（A0000~BFFFF，CPU 的 mmio） ----------
  /**
   * CPU 看到的显存窗口：图形控制器 6 的位 2~3 选择 A0000~BFFFF（128KB）、A0000~AFFFF、B0000~B7FFF 或 B8000~BFFFF。
   * 返回窗口里的偏移，不在窗口里返回 -1
   */
  private window(off: number): number {
    switch ((this.planar.gc[6] >> 2) & 3) {
      case 0: return off;
      case 1: return off < 0x10000 ? off : -1;
      case 2: return off >= 0x10000 && off < 0x18000 ? off - 0x10000 : -1;
      default: return off >= 0x18000 ? off - 0x18000 : -1;
    }
  }
  /**
   * CPU 读显存（off 是相对 A0000 的偏移）。地址怎么落到平面上由定序器 4 决定：
   * 链式（256 色模式 13h）：平面 = 地址的低 2 位；奇偶（文本、CGA 模式）：偶地址在平面 0、奇地址在平面 1；
   * 其余是 4 个平面并行（16 色模式，经过图形控制器的读写模式和锁存器）
   */
  read(off: number): number {
    const o = this.window(off);
    if (o < 0) return 0xff;
    const pl = this.planar, s4 = pl.seq[4];
    if (s4 & 8) return pl.planes[o & 3][(o >> 2) & 0xffff];
    if (!(s4 & 4)) return pl.planes[o & 1][o & 0xfffe];
    return pl.read(o & 0xffff);
  }
  write(off: number, v: number): void {
    const o = this.window(off);
    if (o < 0) return;
    const pl = this.planar, s4 = pl.seq[4], mask = pl.seq[2];
    if (s4 & 8) { const p = o & 3; if (mask & (1 << p)) pl.setByte((o >> 2) & 0xffff, p, v & 0xff); return; }
    if (!(s4 & 4)) { const p = o & 1; if (mask & (1 << p)) pl.setByte(o & 0xfffe, p, v & 0xff); return; }
    pl.write(o & 0xffff, v & 0xff);
  }
  /** 按物理地址（A0000~BFFFF）看显存里的一个字节，和 CPU 读到的一样但不改变锁存器（界面、截图用） */
  peek(addr: number): number {
    const o = this.window(addr - 0xa0000);
    if (o < 0) return 0xff;
    const pl = this.planar, s4 = pl.seq[4];
    if (s4 & 8) return pl.planes[o & 3][(o >> 2) & 0xffff];
    if (!(s4 & 4)) return pl.planes[o & 1][o & 0xfffe];
    return pl.planes[pl.gc[4] & 3][o & 0xffff];
  }
  /**
   * 256 色非链式模式的画面：宽度 = (CRTC 1 + 1) × 4，高度 = 显示的扫描线数 ÷ 每行重复的次数；
   * 每行在每个平面里占 CRTC 13h × 2 字节，从 CRTC 0Ch/0Dh 的起始地址开始
   */
  unchainedSize(): { width: number; height: number; stride: number; start: number } {
    const c = this.crtc;
    const vde = (c[0x12] | ((c[7] & 2) << 7) | ((c[7] & 0x40) << 3)) + 1;
    const rep = ((c[9] & 0x1f) + 1) * (c[9] & 0x80 ? 2 : 1);
    return { width: (c[1] + 1) * 4, height: Math.max(1, Math.floor(vde / rep)), stride: c[0x13] * 2, start: (c[0x0c] << 8) | c[0x0d] };
  }

  /** 文本模式的字符和属性（第 i 个字符格，从 CRTC 的起始地址算起） */
  textCell(i: number): [number, number] {
    const start = ((this.crtc[0x0c] << 8) | this.crtc[0x0d]) * 2;
    const o = (start + i * 2) & 0xfffe;
    return [this.planar.planes[0][o], this.planar.planes[1][o]];
  }
  /** 开机时的空白文本屏幕（空格、灰字黑底） */
  clearText(): void {
    const p0 = this.planar.planes[0], p1 = this.planar.planes[1];
    for (let i = 0; i < 4000; i += 2) { p0[i] = 0x20; p1[i] = 0x07; }
    this.planar.writes++;
  }

  /** 显存映射可能变了（A0000 段是否按 4 个平面访问）：机器据此设置 CPU 的 mmio */
  onMapChange: (() => void) | null = null;
  /** A0000~AFFFF 按 4 个平面访问：图形模式、不是 256 色的链式模式、不是 CGA 兼容模式、映射在 A0000 */
  get planarMapped(): boolean {
    const gc = this.planar.gc;
    return (gc[6] & 1) !== 0 && !(this.planar.seq[4] & 8) && !(gc[5] & 0x20) && ((gc[6] >> 2) & 3) <= 1;
  }

  /**
   * 按寄存器判断显卡现在实际处在哪个模式（像真的显示器一样只看硬件，不看 BIOS 数据区里的模式号：
   * Windows 增强模式下每个虚拟机有自己的 BIOS 数据区，切换虚拟机时它跟着变）
   */
  hardwareMode(): number {
    const gc = this.planar.gc, seq = this.planar.seq, crtc = this.crtc;
    if (!(gc[6] & 1)) return crtc[1] < 0x40 ? 0x01 : 0x03;
    if (seq[4] & 8) return 0x13;
    if (gc[5] & 0x40) return MODE_UNCHAINED; // 256 色移位方式，但没有链式寻址
    if (gc[5] & 0x20) return 0x04;
    if (((gc[6] >> 2) & 3) === 3) return 0x06;
    const vde = (crtc[0x12] | ((crtc[7] & 2) << 7) | ((crtc[7] & 0x40) << 3)) + 1;
    const h = crtc[9] & 0x80 ? vde >> 1 : vde;
    if (h > 400) return 0x12;
    if (h > 300) return 0x10;
    return seq[1] & 8 ? 0x0d : 0x0e;
  }

  loadModeRegs(mode: number): void {
    const t = VGA_MODE_REGS[mode] ?? T80;
    const pl = this.planar;
    this.misc = t.misc;
    pl.seq.fill(0); pl.seq.set(t.seq);
    pl.gc.fill(0); pl.gc.set(t.gc);
    this.crtc.fill(0); this.crtc.set(t.crtc);
    this.attr.set(t.attr, 0x10);
    this.version++;
    this.onMapChange?.();
  }

  /** 当前模式的寄存器表（杂项输出、定序器 0~4、CRTC 0~18h、图形控制器 0~8、属性 10h~14h），给 BIOS 桩代码用 OUT 写出去 */
  modeRegTable(): number[] {
    const pl = this.planar;
    return [this.misc, ...pl.seq.subarray(0, 5), ...this.crtc.subarray(0, 25), ...pl.gc.subarray(0, 9), ...this.attr.subarray(0x10, 0x15)];
  }

  /** 颜色号（0~15）经过属性控制器后对应的 DAC 颜色号 */
  dacIndex(c: number): number {
    const a = this.attr, cs = a[0x14];
    const p = a[c & a[0x12] & 15];
    return ((cs & 0x0c) << 4) | (a[0x10] & 0x80 ? ((cs & 3) << 4) | (p & 15) : p & 0x3f);
  }

  setColor(i: number, r: number, g: number, b: number): void {
    this.dac[i * 3] = r & 63; this.dac[i * 3 + 1] = g & 63; this.dac[i * 3 + 2] = b & 63;
    this.version++;
  }

  /** INT 10h AX=1000h 等：设置属性控制器的一个寄存器 */
  setAttr(i: number, v: number): void {
    if (i < 0x15) { this.attr[i] = v; this.version++; }
  }

  /** 读状态寄存器 3DAh 时：属性控制器回到"写索引"状态 */
  resetAttrFlip(): void { this.attrFlip = false; }

  in8(port: number): number {
    const pl = this.planar;
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
      case 0x3c0: return this.attrIndex;
      case 0x3c1: return this.attr[this.attrIndex & 0x1f] ?? 0;
      case 0x3c4: return pl.seqIndex;
      case 0x3c5: return pl.seq[pl.seqIndex & 7];
      case 0x3ce: return pl.gcIndex;
      case 0x3cf: return pl.gc[pl.gcIndex & 15];
      case 0x3cc: return this.misc;  // 杂项输出寄存器
      case 0x3ca: return 0x00;       // 特性控制寄存器
      case 0x3c3: return 0x01;       // VGA 允许寄存器
      case 0x3d4: return this.crtcIndex;
      case 0x3d5: return this.crtc[this.crtcIndex & 31];
    }
    return 0xff;
  }

  out8(port: number, v: number): boolean {
    const pl = this.planar;
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
      case 0x3c0:
        // 属性控制器：同一个端口交替写索引和数据（读 3DAh 把它复位到"索引"）
        if (!this.attrFlip) this.attrIndex = v & 0x3f;
        else this.setAttr(this.attrIndex & 0x1f, v);
        this.attrFlip = !this.attrFlip;
        return true;
      case 0x3c4: pl.seqIndex = v; return true;
      case 0x3c5: pl.seq[pl.seqIndex & 7] = v; if ((pl.seqIndex & 7) === 4) this.onMapChange?.(); return true;
      case 0x3ce: pl.gcIndex = v; return true;
      case 0x3cf: pl.gc[pl.gcIndex & 15] = v; if ((pl.gcIndex & 15) === 5 || (pl.gcIndex & 15) === 6) { this.version++; this.onMapChange?.(); } return true;
      case 0x3c2: this.misc = v; return true;
      case 0x3c3: case 0x3ca: case 0x3da: case 0x3d8: return true; // VGA 允许、特性控制、CGA 模式寄存器：接受但不模拟
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
