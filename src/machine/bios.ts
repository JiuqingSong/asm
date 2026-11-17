// BIOS 与 DOS 功能的高层模拟（HLE）
//
// 每个中断向量默认指向 F000 段里的一小段桩代码，桩代码里的"陷阱"指令会调用这里的处理函数。
// 处理函数通过修改寄存器返回结果；需要通过标志位返回的（CF、ZF）修改栈上保存的 FLAGS。
// 返回 false 表示需要等待（例如键盘缓冲区为空），CPU 会停在陷阱处，等有按键后重试。
import { AX, BX, CX, DX, SI, DI, BP, DS, ES, CF, ZF, type CPU } from '../cpu/cpu.ts';
import type { Machine } from './machine.ts';
import { MOUSE_STUB } from './mouse.ts';
import { PIT_HZ } from './uart.ts';
import { modeInfo, SUPPORTED_MODES, type ModeInfo } from './video.ts';

/** ROM 里 8×8 字库的位置：前 128 个字符在 F000:FA6E（与 IBM PC 相同），后 128 个在 F000:0A00 */
export const FONT_LO = 0xfa6e, FONT_HI = 0x0a00;

const BDA = 0x40;


interface OpenFile { name: string; pos: number; data: number[]; write: boolean; dirty: boolean }

/** 文件名换成 DOS 目录项里的 11 个字符（8 + 3，不足补空格）；* 展开成若干个 ?。不是合法的 8.3 名字时返回 null */
export function to83(name: string): string | null {
  if (name === '.' || name === '..') return name.padEnd(11, ' ');
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot), ext = dot < 0 ? '' : name.slice(dot + 1);
  const part = (s: string, n: number) => {
    const star = s.indexOf('*');
    if (star >= 0) s = s.slice(0, star).padEnd(n, '?');
    return s.length > n || /[\s.\\/:]/.test(s) ? null : s.padEnd(n, ' ');
  };
  const b = part(base, 8), e = part(ext, 3);
  return b === null || e === null || !base ? null : b + e;
}

/** 按 DOS 的规则比较：模板里的 ? 匹配任何字符（包括补的空格） */
export function match83(template: string, name: string): boolean {
  for (let i = 0; i < 11; i++) if (template[i] !== '?' && template[i] !== name[i]) return false;
  return true;
}

/** 11 个字符的目录项名字换回 NAME.EXT */
function from83(n: string): string {
  const b = n.slice(0, 8).trimEnd(), e = n.slice(8).trimEnd();
  return e ? b + '.' + e : b;
}

export class Hle {
  private m: Machine;
  private cpu: CPU;
  /** 正在进行的行输入（INT 21h 0Ah / 3Fh） */
  private line: number[] | null = null;
  private handles = new Map<number, OpenFile>();
  private warned = new Set<string>();
  /** 正在进行的磁盘操作结束的虚拟时间（-1 表示没有） */
  private busyUntil = -1;
  /** 磁盘传输区（DTA）：查找文件的结果写在这里；程序开始时在 PSP:0080 */
  private dta = { seg: 0, off: 0x80 };
  /** 模拟 DOS 的磁盘缓冲区：最近读写过的扇区（文件名:扇区号），命中时几乎不花时间 */
  private sectorCache = new Map<string, true>();

  constructor(m: Machine) {
    this.m = m;
    this.cpu = m.cpu;
  }

  reset(): void {
    this.line = null;
    this.busyUntil = -1;
    this.sectorCache.clear();
    this.m.busy = false;
    this.handles.clear();
    this.dta = { seg: this.m.program?.pspSeg ?? 0, off: 0x80 };
  }

  /**
   * 模拟磁盘操作的耗时：在 ms 毫秒（虚拟时间）内反复返回 false，CPU 停在陷阱处"忙等"，
   * 期间中断保持开放（桩代码先执行了 STI），和真实的 DOS 等待磁盘时一样。
   */
  private spin(ms: number): boolean {
    if (!this.m.diskLatency) return true;
    if (this.busyUntil < 0) {
      if (ms <= 0) return true;
      this.busyUntil = this.m.clock + (ms * PIT_HZ) / 1000; // 截止时间只在第一次进入时确定
    }
    if (this.m.clock < this.busyUntil) { this.m.busy = true; return false; }
    this.busyUntil = -1;
    this.m.busy = false;
    return true;
  }
  /** 读写文件 n 字节要花的时间（毫秒）：不在缓冲区里的扇区按每个约 1 毫秒计，命中缓冲区只算 DOS 调用本身 */
  private diskCost(f: OpenFile | undefined, n: number): number {
    if (!f) return 0;
    const first = Math.floor(f.pos / 512), last = Math.floor((f.pos + Math.max(n, 1) - 1) / 512);
    let misses = 0;
    for (let s = first; s <= last; s++) {
      const key = f.name + ':' + s;
      if (this.sectorCache.has(key)) this.sectorCache.delete(key);
      else misses++;
      this.sectorCache.set(key, true);
    }
    while (this.sectorCache.size > 40) this.sectorCache.delete(this.sectorCache.keys().next().value!); // DOS 的 BUFFERS=40
    return misses ? 0.5 + misses * 0.5 : 0.01;
  }

  busyRemaining(): number { return this.busyUntil < 0 ? 0 : Math.max(0, this.busyUntil - this.m.clock); }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.m.log(msg);
  }
  clearWarnings(): void { this.warned.clear(); }

  // ---------- 寄存器便捷访问 ----------
  private get ah() { return this.cpu.r[AX] >> 8; }
  private get al() { return this.cpu.r[AX] & 0xff; }
  private set al(v: number) { this.cpu.setR8(0, v); }
  private set ah(v: number) { this.cpu.setR8(4, v); }
  private retFlag(mask: number, on: boolean) { this.cpu.setStackedFlag(mask, on); }
  private ok() { this.retFlag(CF, false); }
  private fail(code: number) { this.cpu.r[AX] = code; this.retFlag(CF, true); }

  // ---------- 入口 ----------
  handle(n: number): boolean {
    switch (n) {
      case 0x00: return this.divideError();
      case 0x01: case 0x04: return true;
      case 0x03: this.m.requestBreak('遇到 INT 3 断点'); return true;
      case 0x05: return true;
      case 0x2a: case 0x28: return true; // 网络、DOS 空闲：忽略
      case 0x08: return this.timerTick();
      case 0x09: return this.keyboardIrq();
      case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e: case 0x0f:
        this.m.pic.out8(0x20, 0x20); // 默认的硬件中断处理：只发 EOI
        return true;
      case 0x10: return this.video();
      case 0x11: this.cpu.r[AX] = 0x0021; return true;
      case 0x12: this.cpu.r[AX] = 640; return true;
      case 0x16: return this.keyboard();
      case 0x1a: return this.clock();
      case 0x1c: return true;
      case 0x20: this.m.exit(0); return true;
      case 0x21: return this.dos();
      case 0x33:
        if (!this.m.mouse.int33(this.cpu, this.mode)) this.warnOnce(`INT 33h（鼠标）功能 ${hex(this.cpu.r[AX] & 0xff)}h 暂未实现`);
        return true;
      case 0x74: case 0x75:
        // 鼠标回调桩代码里的两个陷阱（只认桩代码里的位置，程序自己执行 INT 74h 时不做任何事）
        if (this.cpu.ip === MOUSE_STUB + 11) this.m.mouse.enterCallback(this.cpu);
        else if (this.cpu.ip === MOUSE_STUB + 27) this.m.mouse.inHandler = false;
        return true;
    }
    this.warnOnce(`程序调用了 INT ${hex(n)}h，本模拟器暂未实现该中断（已忽略）`);
    return true;
  }

  private divideError(): boolean {
    this.writeString('Divide overflow\r\n');
    this.m.exit(0, '除法溢出：除数为 0，或者商超出了结果寄存器的范围（DIV/IDIV 触发了 0 号中断）');
    return true;
  }

  // ---------- 定时器与时钟 ----------
  private timerTick(): boolean {
    let t = this.cpu.rw(BDA, 0x6c) + this.cpu.rw(BDA, 0x6e) * 0x10000 + 1;
    if (t >= 0x1800b0) { t = 0; this.cpu.wb(BDA, 0x70, 1); }
    this.cpu.ww(BDA, 0x6c, t & 0xffff);
    this.cpu.ww(BDA, 0x6e, Math.floor(t / 0x10000));
    return true;
  }

  private clock(): boolean {
    const d = new Date();
    const bcd = (v: number) => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
    switch (this.ah) {
      case 0x00:
        this.cpu.r[CX] = this.cpu.rw(BDA, 0x6e);
        this.cpu.r[DX] = this.cpu.rw(BDA, 0x6c);
        this.al = this.cpu.rb(BDA, 0x70);
        this.cpu.wb(BDA, 0x70, 0);
        return true;
      case 0x02:
        this.cpu.setR8(5, bcd(d.getHours())); this.cpu.setR8(1, bcd(d.getMinutes()));
        this.cpu.setR8(6, bcd(d.getSeconds())); this.cpu.setR8(2, 0);
        this.ok(); return true;
      case 0x04:
        this.cpu.setR8(5, bcd(Math.floor(d.getFullYear() / 100))); this.cpu.setR8(1, bcd(d.getFullYear() % 100));
        this.cpu.setR8(6, bcd(d.getMonth() + 1)); this.cpu.setR8(2, bcd(d.getDate()));
        this.ok(); return true;
    }
    this.warnOnce(`INT 1Ah 功能 ${hex(this.ah)}h 暂未实现`);
    return true;
  }

  // ---------- 键盘 ----------
  private keyboardIrq(): boolean {
    const k = this.m.kbd.current;
    if (!k) return true;
    const cpu = this.cpu;
    let shift = cpu.rb(BDA, 0x17);
    const sc = k.scan & 0x7f;
    const bit = sc === 0x2a ? 2 : sc === 0x36 ? 1 : sc === 0x1d ? 4 : sc === 0x38 ? 8 : 0;
    if (bit) {
      shift = k.release ? shift & ~bit : shift | bit;
      cpu.wb(BDA, 0x17, shift);
      return true;
    }
    if (k.release) return true;
    const head = cpu.rw(BDA, 0x1a), tail = cpu.rw(BDA, 0x1c);
    let next = tail + 2;
    if (next >= 0x3e) next = 0x1e;
    if (next === head) return true; // 缓冲区满
    cpu.ww(BDA, tail, (sc << 8) | k.ascii);
    cpu.ww(BDA, 0x1c, next);
    return true;
  }

  /** 读 BIOS 键盘缓冲区：返回 (扫描码<<8)|ASCII，空时返回 -1 */
  kbdRead(remove: boolean): number {
    const cpu = this.cpu;
    const head = cpu.rw(BDA, 0x1a), tail = cpu.rw(BDA, 0x1c);
    if (head === tail) return -1;
    const k = cpu.rw(BDA, head);
    if (remove) {
      let h = head + 2;
      if (h >= 0x3e) h = 0x1e;
      cpu.ww(BDA, 0x1a, h);
    }
    return k;
  }

  private kbdFlush(): void {
    this.cpu.ww(BDA, 0x1a, this.cpu.rw(BDA, 0x1c));
  }

  private keyboard(): boolean {
    switch (this.ah) {
      case 0x00: case 0x10: {
        const k = this.kbdRead(true);
        if (k < 0) return false;
        this.cpu.r[AX] = k;
        return true;
      }
      case 0x01: case 0x11: {
        const k = this.kbdRead(false);
        if (k < 0) {
          // 与 IBM PC BIOS 一致：缓冲区为空时 AX 也会被设成缓冲区头部那个旧的键值
          this.cpu.r[AX] = this.cpu.rw(BDA, this.cpu.rw(BDA, 0x1a));
          this.retFlag(ZF, true);
          return true;
        }
        this.cpu.r[AX] = k;
        this.retFlag(ZF, false);
        return true;
      }
      case 0x02: case 0x12: this.al = this.cpu.rb(BDA, 0x17); return true;
    }
    this.warnOnce(`INT 16h 功能 ${hex(this.ah)}h 暂未实现`);
    return true;
  }

  // ---------- 显示 ----------
  private get mode(): number { return this.cpu.rb(BDA, 0x49); }
  private get vinfo(): ModeInfo { return modeInfo(this.mode); }
  private get cols(): number { return this.vinfo.cols; }
  private get rows(): number { return this.vinfo.rows; }

  getCursor(): { row: number; col: number } {
    return { col: this.cpu.rb(BDA, 0x50), row: this.cpu.rb(BDA, 0x51) };
  }
  setCursor(row: number, col: number): void {
    this.cpu.wb(BDA, 0x50, col);
    this.cpu.wb(BDA, 0x51, row);
  }

  private cellOff(row: number, col: number): number { return (row * this.cols + col) * 2; }
  private get textSeg(): number { return this.vinfo.seg; }

  // ----- 图形模式的像素 -----

  /** 像素所在的字节偏移和位移（CGA 模式偶数行在 B800:0000，奇数行在 B800:2000） */
  private pixelAt(x: number, y: number): { off: number; shift: number; mask: number } {
    const m = this.mode;
    if (m === 0x13) return { off: y * 320 + x, shift: 0, mask: 0xff };
    const bank = (y & 1) * 0x2000 + (y >> 1) * 80;
    if (m === 0x06) return { off: bank + (x >> 3), shift: 7 - (x & 7), mask: 1 };
    return { off: bank + (x >> 2), shift: (3 - (x & 3)) * 2, mask: 3 };
  }

  putPixel(x: number, y: number, color: number, xor = false): void {
    const vi = this.vinfo;
    if (!vi.graphics || x < 0 || y < 0 || x >= vi.width || y >= vi.height) return;
    if (vi.planar) { this.m.video.planar.setPixel(y * (vi.width >> 3) + (x >> 3), x & 7, color & 15, xor); return; }
    const { off, shift, mask } = this.pixelAt(x, y);
    const old = this.cpu.rb(vi.seg, off);
    const c = (color & mask) << shift;
    const v = xor ? old ^ c : (old & ~(mask << shift)) | c;
    this.cpu.wb(vi.seg, off, v);
  }

  getPixel(x: number, y: number): number {
    const vi = this.vinfo;
    if (!vi.graphics || x < 0 || y < 0 || x >= vi.width || y >= vi.height) return 0;
    if (vi.planar) return this.m.video.planar.pixel(y * (vi.width >> 3) + (x >> 3), x & 7);
    const { off, shift, mask } = this.pixelAt(x, y);
    return (this.cpu.rb(vi.seg, off) >> shift) & mask;
  }

  /** 在图形模式下画一个 8×8 字符（字形取自 ROM 字库：INT 43h、INT 1Fh 指向的表） */
  private drawGlyph(row: number, col: number, ch: number, color: number): void {
    const xor = this.mode !== 0x13 && (color & 0x80) !== 0;
    const vecNo = ch < 128 ? 0x43 : 0x1f;
    const tOff = this.cpu.rw(0, vecNo * 4), tSeg = this.cpu.rw(0, vecNo * 4 + 2);
    const base = (ch & 0x7f) * 8, h = this.vinfo.charH;
    for (let gy = 0; gy < h; gy++) {
      const bits = this.cpu.rb(tSeg, tOff + base + Math.floor((gy * 8) / h));
      for (let gx = 0; gx < 8; gx++) {
        const on = (bits >> (7 - gx)) & 1;
        if (xor) { if (on) this.putPixel(col * 8 + gx, row * h + gy, color & 0x7f, true); }
        else this.putPixel(col * 8 + gx, row * h + gy, on ? color : 0);
      }
    }
  }

  /** 卷动一个窗口（文字坐标）；图形模式下按 8 像素一行卷动像素 */
  scroll(up: boolean, n: number, attr: number, r1: number, c1: number, r2: number, c2: number): void {
    const cpu = this.cpu, vi = this.vinfo, cols = this.cols;
    r2 = Math.min(r2, this.rows - 1); c2 = Math.min(c2, cols - 1);
    if (r1 > r2 || c1 > c2) return;
    const h = r2 - r1 + 1;
    if (n === 0 || n > h) n = h;
    if (vi.graphics) {
      const ch = vi.charH;
      const y1 = r1 * ch, y2 = r2 * ch + ch - 1, x1 = c1 * 8, x2 = c2 * 8 + 7, dy = n * ch;
      const fill = vi.bpp === 8 ? attr : vi.planar ? attr & 15 : 0;
      if (vi.planar) {
        // 平面模式：每个字符正好占每行的一个字节，按平面整字节搬移
        const pl = this.m.video.planar, bpl = vi.width >> 3;
        const rows = up ? range(y1, y2) : range(y1, y2).reverse();
        for (const y of rows) {
          const src = up ? y + dy : y - dy;
          for (let k = 0; k < 4; k++) {
            const p = pl.planes[k];
            for (let c = c1; c <= Math.min(c2, bpl - 1); c++) pl.setByte(y * bpl + c, k, src >= y1 && src <= y2 ? p[src * bpl + c] : (fill >> k) & 1 ? 0xff : 0);
          }
        }
        return;
      }
      if (this.mode === 0x13 && x1 === 0 && x2 >= 319) {
        // 整行卷动：按字节整块搬移，快得多
        const rows = up ? range(y1, y2) : range(y1, y2).reverse();
        for (const y of rows) {
          const src = up ? y + dy : y - dy;
          for (let x = 0; x < 320; x++) cpu.wb(0xa000, y * 320 + x, src >= y1 && src <= y2 ? cpu.rb(0xa000, src * 320 + x) : fill);
        }
        return;
      }
      const rows = up ? range(y1, y2) : range(y1, y2).reverse();
      for (const y of rows) {
        const src = up ? y + dy : y - dy;
        for (let x = x1; x <= Math.min(x2, vi.width - 1); x++) this.putPixel(x, y, src >= y1 && src <= y2 ? this.getPixel(x, src) : fill);
      }
      return;
    }
    const seg = this.textSeg;
    const rows = up ? range(r1, r2) : range(r1, r2).reverse();
    for (const r of rows) {
      const src = up ? r + n : r - n;
      for (let c = c1; c <= c2; c++) {
        const o = this.cellOff(r, c);
        if (src >= r1 && src <= r2) {
          const so = this.cellOff(src, c);
          cpu.wb(seg, o, cpu.rb(seg, so));
          cpu.wb(seg, o + 1, cpu.rb(seg, so + 1));
        } else {
          cpu.wb(seg, o, 0x20);
          cpu.wb(seg, o + 1, attr);
        }
      }
    }
  }

  /** 电传方式输出一个字符（处理回车、换行、退格、响铃，到底部自动滚屏）；图形模式下 attr 是颜色 */
  teletype(ch: number, attr = -1): void {
    let { row, col } = this.getCursor();
    const cols = this.cols, graphics = this.vinfo.graphics;
    switch (ch) {
      case 0x07: this.m.bell(); break;
      case 0x08: if (col > 0) col--; break;
      case 0x0a: row++; break;
      case 0x0d: col = 0; break;
      default: {
        if (graphics) this.drawGlyph(row, col, ch, attr >= 0 ? attr : this.mode === 0x13 ? 15 : 3);
        else {
          const o = this.cellOff(row, col);
          this.cpu.wb(this.textSeg, o, ch);
          if (attr >= 0) this.cpu.wb(this.textSeg, o + 1, attr);
        }
        col++;
        if (col >= cols) { col = 0; row++; }
      }
    }
    if (row >= this.rows) { this.scroll(true, 1, graphics ? 0 : 0x07, 0, 0, this.rows - 1, cols - 1); row = this.rows - 1; }
    this.setCursor(row, col);
    this.m.consoleOut(ch);
  }

  writeString(s: string): void {
    for (const c of s) this.teletype(c.charCodeAt(0) & 0xff);
  }

  clearScreen(): void {
    const vi = this.vinfo;
    if (vi.planar) {
      const pl = this.m.video.planar;
      for (let k = 0; k < 4; k++) pl.planes[k].fill(0);
      pl.writes++;
    } else if (vi.graphics) {
      const size = this.mode === 0x13 ? 64000 : 0x4000;
      for (let o = 0; o < size; o++) this.cpu.wb(vi.seg, o, 0);
    } else {
      for (let o = 0; o < vi.cols * this.rows * 2; o += 2) {
        this.cpu.wb(vi.seg, o, 0x20);
        this.cpu.wb(vi.seg, o + 1, 0x07);
      }
    }
    this.setCursor(0, 0);
  }

  private setMode(al: number): void {
    const cpu = this.cpu;
    const mode = al & 0x7f;
    if (!SUPPORTED_MODES.has(mode)) {
      this.warnOnce(`程序要切换到显示模式 ${hex(mode)}h，本模拟器暂不支持（支持文本模式和图形模式 04h、05h、06h、0Dh、0Eh、10h、12h、13h），仍保持原来的模式`);
      return;
    }
    const vi = modeInfo(mode);
    cpu.wb(BDA, 0x49, mode);
    cpu.ww(BDA, 0x4a, vi.cols);
    cpu.ww(BDA, 0x4c, vi.graphics ? (mode === 0x13 ? 0xfa00 : vi.planar ? (vi.width >> 3) * vi.height : 0x4000) : vi.cols * vi.rows * 2);
    cpu.wb(BDA, 0x84, vi.rows - 1);
    cpu.ww(BDA, 0x85, vi.charH);
    const video = this.m.video;
    cpu.mmio = vi.planar ? video.planar : null;
    if (vi.planar) video.enterPlanar(mode);
    else if (mode === 0x13) video.reset();
    else if (mode === 0x04 || mode === 0x05) video.cgaColor = 0x30;
    else if (mode === 0x06) video.cgaColor = 0x3f;
    video.version++;
    this.m.mouse.modeChanged(mode);
    if (!(al & 0x80)) this.clearScreen(); else this.setCursor(0, 0);
  }

  private video(): boolean {
    const cpu = this.cpu, r = cpu.r;
    const bl = r[BX] & 0xff;
    const graphics = this.vinfo.graphics;
    switch (this.ah) {
      case 0x00: this.setMode(this.al); return true;
      case 0x01: cpu.ww(BDA, 0x60, r[CX]); return true;
      case 0x02: this.setCursor(r[DX] >> 8, r[DX] & 0xff); return true;
      case 0x03: { const c = this.getCursor(); r[DX] = (c.row << 8) | c.col; r[CX] = cpu.rw(BDA, 0x60); return true; }
      case 0x05: return true;
      case 0x06: case 0x07:
        this.scroll(this.ah === 0x06, this.al, r[BX] >> 8, r[CX] >> 8, r[CX] & 0xff, r[DX] >> 8, r[DX] & 0xff);
        return true;
      case 0x08: {
        if (graphics) { r[AX] = 0; return true; }
        const c = this.getCursor(), o = this.cellOff(c.row, c.col);
        r[AX] = (cpu.rb(this.textSeg, o + 1) << 8) | cpu.rb(this.textSeg, o);
        return true;
      }
      case 0x09: case 0x0a: {
        const c = this.getCursor();
        if (graphics) {
          for (let k = 0; k < r[CX] && c.col + k < this.cols; k++) this.drawGlyph(c.row, c.col + k, this.al, bl);
          return true;
        }
        let o = this.cellOff(c.row, c.col);
        for (let k = 0; k < r[CX] && o < this.cols * this.rows * 2; k++, o += 2) {
          cpu.wb(this.textSeg, o, this.al);
          if (this.ah === 0x09) cpu.wb(this.textSeg, o + 1, bl);
        }
        return true;
      }
      case 0x0b: { // CGA 调色板：BH=0 设背景色，BH=1 选调色板
        const v = this.m.video;
        if (r[BX] >> 8 === 0) v.cgaColor = (v.cgaColor & 0x20) | (bl & 0x1f);
        else v.cgaColor = (v.cgaColor & 0x1f) | ((bl & 1) << 5);
        v.version++;
        return true;
      }
      case 0x0c: this.putPixel(r[CX], r[DX], this.al, this.mode !== 0x13 && (this.al & 0x80) !== 0); return true;
      case 0x0d: this.al = this.getPixel(r[CX], r[DX]); return true;
      case 0x0e: this.teletype(this.al, graphics ? (bl || (this.mode === 0x13 ? 15 : 3)) : -1); return true;
      case 0x0f: r[AX] = (this.cols << 8) | this.mode; cpu.setR8(7, 0); return true;
      case 0x10: return this.palette();
      case 0x11:
        if (this.al === 0x30) { // 取字库信息：ES:BP 指向 8×8 字库
          const upper = r[BX] >> 8 === 4;
          cpu.s[ES] = 0xf000; r[BP] = upper ? FONT_HI : FONT_LO;
          r[CX] = this.vinfo.charH; cpu.setR8(2, this.rows - 1);
        }
        return true;
      case 0x12:
        if (bl === 0x10) { r[BX] = 0x0003; r[CX] = 0x0009; } // EGA/VGA 信息：彩色，256KB
        return true;
      case 0x13: {
        const mode = this.al;
        let row = r[DX] >> 8, col = r[DX] & 0xff;
        const save = this.getCursor();
        this.setCursor(row, col);
        let p = r[BP];
        for (let k = 0; k < r[CX]; k++) {
          const ch = cpu.rb(cpu.s[ES], p++);
          let attr = bl;
          if (mode & 2) attr = cpu.rb(cpu.s[ES], p++);
          this.teletype(ch, ch >= 0x20 ? attr : -1);
        }
        if (!(mode & 1)) { row = save.row; col = save.col; this.setCursor(row, col); }
        return true;
      }
      case 0x1a:
        if (this.al === 0) { this.al = 0x1a; r[BX] = 0x0008; } // 显示组合：VGA 彩色
        return true;
      case 0x1b: case 0xef: case 0xfe: return true; // 功能信息等：按"不支持"处理
    }
    this.warnOnce(`INT 10h 功能 ${hex(this.ah)}h 暂未实现`);
    return true;
  }

  /** INT 10h AH=10h：调色板 */
  private palette(): boolean {
    const cpu = this.cpu, r = cpu.r, v = this.m.video, bl = r[BX] & 0xff;
    switch (this.al) {
      case 0x10: v.setColor(r[BX] & 0xff, r[DX] >> 8, r[CX] >> 8, r[CX] & 0xff); return true;
      case 0x12: {
        let p = r[DX];
        for (let k = 0; k < r[CX]; k++, p += 3) {
          v.setColor((r[BX] + k) & 0xff, cpu.rb(cpu.s[ES], p), cpu.rb(cpu.s[ES], p + 1), cpu.rb(cpu.s[ES], p + 2));
        }
        return true;
      }
      case 0x15: {
        const i = (r[BX] & 0xff) * 3;
        cpu.setR8(6, v.dac[i]); cpu.setR8(5, v.dac[i + 1]); cpu.setR8(1, v.dac[i + 2]);
        return true;
      }
      case 0x17: {
        let p = r[DX];
        for (let k = 0; k < r[CX] * 3; k++) cpu.wb(cpu.s[ES], p++, v.dac[(((r[BX] + Math.floor(k / 3)) & 0xff) * 3) + (k % 3)]);
        return true;
      }
      case 0x00: v.setAttr(bl, r[BX] >> 8); return true;               // 设一个调色板寄存器
      case 0x01: v.setAttr(0x11, r[BX] >> 8); return true;             // 边框色
      case 0x02: {                                                      // 16 个调色板寄存器 + 边框色
        for (let k = 0; k < 17; k++) v.setAttr(k, cpu.rb(cpu.s[ES], r[DX] + k));
        return true;
      }
      case 0x07: cpu.setR8(7, v.attr[bl & 0x1f] ?? 0); return true;    // 读一个调色板寄存器
      case 0x08: cpu.setR8(7, v.attr[0x11]); return true;
      case 0x09: {
        for (let k = 0; k < 17; k++) cpu.wb(cpu.s[ES], r[DX] + k, v.attr[k]);
        return true;
      }
      case 0x03: case 0x13: case 0x1a: return true;
    }
    this.warnOnce(`INT 10h AX=10${hex(this.al)}h 暂未实现`);
    return true;
  }

  // ---------- DOS ----------
  private readAsciiz(seg: number, off: number): string {
    let s = '';
    for (let k = 0; k < 128; k++) {
      const c = this.cpu.rb(seg, off + k);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  private normName(s: string): string {
    let n = s.trim().toUpperCase().replace(/\//g, '\\');
    n = n.replace(/^[A-Z]:/, '').replace(/^\\+/, '').replace(/^\.\\/, '');
    return n;
  }

  /**
   * 行输入（带回显、退格），回车结束。返回 null 表示还在等待。
   * 返回的数组不含回车。
   */
  private readLine(max: number): number[] | null {
    if (!this.line) this.line = [];
    for (;;) {
      const k = this.kbdRead(true);
      if (k < 0) return null;
      const ch = k & 0xff;
      if (ch === 0x0d) { const res = this.line; this.line = null; return res; }
      if (ch === 0x08) {
        if (this.line.length) { this.line.pop(); this.teletype(8); this.teletype(0x20); this.teletype(8); }
        continue;
      }
      if (ch === 0 || ch === 0x1b) continue;
      if (this.line.length >= max) { this.m.bell(); continue; }
      this.line.push(ch);
      this.teletype(ch);
    }
  }

  private dos(): boolean {
    const cpu = this.cpu, r = cpu.r;
    const ah = this.ah;
    switch (ah) {
      case 0x00: this.m.exit(0); return true;
      case 0x01: {
        const k = this.kbdRead(true);
        if (k < 0) return false;
        this.al = k & 0xff;
        if (k & 0xff) this.teletype(k & 0xff);
        return true;
      }
      case 0x02: this.teletype(r[DX] & 0xff); this.al = r[DX] & 0xff; return true;
      case 0x05: return true;
      case 0x06: {
        const dl = r[DX] & 0xff;
        if (dl !== 0xff) { this.teletype(dl); this.al = dl; return true; }
        const k = this.kbdRead(true);
        if (k < 0) { this.al = 0; this.retFlag(ZF, true); return true; }
        this.al = k & 0xff; this.retFlag(ZF, false);
        return true;
      }
      case 0x07: case 0x08: {
        const k = this.kbdRead(true);
        if (k < 0) return false;
        this.al = k & 0xff;
        return true;
      }
      case 0x09: {
        let off = r[DX];
        for (let k = 0; k < 0x10000; k++) {
          const c = cpu.rb(cpu.s[DS], off++);
          if (c === 0x24) return true;
          this.teletype(c);
        }
        this.warnOnce('INT 21h 09h 功能输出的字符串没有找到结束符 $');
        return true;
      }
      case 0x0a: {
        const seg = cpu.s[DS], off = r[DX];
        const max = cpu.rb(seg, off);
        if (max === 0) return true;
        const line = this.readLine(max - 1);
        if (!line) return false;
        line.forEach((c, k) => cpu.wb(seg, off + 2 + k, c));
        cpu.wb(seg, off + 2 + line.length, 0x0d);
        cpu.wb(seg, off + 1, line.length);
        this.teletype(0x0d);
        return true;
      }
      case 0x0b: this.al = this.kbdRead(false) >= 0 ? 0xff : 0; return true;
      case 0x0c: {
        if (!this.line) this.kbdFlush();
        const f = this.al;
        if ([0x01, 0x06, 0x07, 0x08, 0x0a].includes(f)) { this.ah = f; const res = this.dos(); if (res) this.ah = 0x0c; return res; }
        return true;
      }
      case 0x0d: return true;
      case 0x0e: this.al = 3; return true;
      case 0x19: this.al = 2; return true;
      case 0x36: // 磁盘剩余空间：AX 每簇扇区数，BX 空闲簇，CX 每扇区字节，DX 总簇数（约 16MB 的盘，剩一半）
        r[AX] = 8; r[BX] = 2000; r[CX] = 512; r[DX] = 4000;
        return true;
      case 0x1a: this.dta = { seg: cpu.s[DS], off: r[DX] }; return true;
      case 0x2f: cpu.s[ES] = this.dta.seg; r[BX] = this.dta.off; return true;
      case 0x4e: case 0x4f: if (!this.spin(ah === 0x4e ? 3 : 1)) return false; return this.findFile(ah === 0x4e);
      case 0x11: case 0x12: if (!this.spin(ah === 0x11 ? 3 : 1)) return false; return this.fcbFind(ah === 0x11);
      case 0x29: return this.parseFcbName();
      case 0x56: { // 改名：DS:DX 旧名，ES:DI 新名
        if (!this.spin(3)) return false;
        const from = this.normName(this.readAsciiz(cpu.s[DS], r[DX]));
        const to = this.normName(this.readAsciiz(cpu.s[ES], r[DI]));
        const fs = this.m.files;
        if (!fs.has(from)) { this.fail(2); return true; }
        if (!to || /[*?]/.test(to)) { this.fail(3); return true; }
        if (fs.has(to)) { this.fail(5); return true; }
        fs.set(to, fs.get(from)!); fs.delete(from);
        const t = this.m.fileTimes.get(from);
        this.m.fileTimes.delete(from);
        if (t !== undefined) this.m.fileTimes.set(to, t);
        this.m.filesChanged();
        this.ok();
        return true;
      }
      case 0x57: { // 文件的日期和时间：AL=0 读，AL=1 设置
        const f = this.handles.get(r[BX]);
        if (!f) { this.fail(6); return true; }
        if (this.al === 0) {
          const { time, date } = this.dosTime(f.name);
          r[CX] = time; r[DX] = date;
        } else if (this.al === 1) {
          const d = r[DX], t = r[CX];
          this.m.fileTimes.set(f.name, new Date(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2).getTime());
        }
        this.ok();
        return true;
      }
      case 0x3b: { // 改变当前目录：虚拟磁盘只有根目录
        const p = this.normName(this.readAsciiz(cpu.s[DS], r[DX]));
        if (p === '' || p === '.' || p === '\\') { this.ok(); return true; }
        this.fail(3);
        return true;
      }
      case 0x39: case 0x3a:
        this.warnOnce('虚拟磁盘只有一个根目录，不能建立或删除子目录');
        this.fail(ah === 0x39 ? 5 : 3);
        return true;
      case 0x25: cpu.ww(0, this.al * 4, r[DX]); cpu.ww(0, this.al * 4 + 2, cpu.s[DS]); return true;
      case 0x2a: {
        const d = new Date();
        r[CX] = d.getFullYear(); cpu.setR8(6, d.getMonth() + 1); cpu.setR8(2, d.getDate()); this.al = d.getDay();
        return true;
      }
      case 0x2c: {
        const d = new Date();
        cpu.setR8(5, d.getHours()); cpu.setR8(1, d.getMinutes()); cpu.setR8(6, d.getSeconds()); cpu.setR8(2, Math.floor(d.getMilliseconds() / 10));
        return true;
      }
      case 0x2b: case 0x2d: this.al = 0; return true;
      case 0x30: r[AX] = 0x0005; r[BX] = 0; r[CX] = 0; return true;
      case 0x35: r[BX] = cpu.rw(0, this.al * 4); cpu.s[ES] = cpu.rw(0, this.al * 4 + 2); return true;
      case 0x31: this.m.exit(this.al, '程序以驻留方式（TSR）结束；本模拟器把它当作普通退出处理'); return true;
      case 0x4c: this.m.exit(this.al); return true;
      case 0x4d: r[AX] = this.m.lastExitCode; return true;
      case 0x48: { // 分配内存：BX=段落数
        const res = this.m.dosmem.alloc(r[BX], this.m.program?.pspSeg ?? 8);
        if (typeof res === 'number') { r[AX] = res; this.ok(); }
        else { r[BX] = res.largest; this.fail(res.corrupt ? 7 : 8); }
        return true;
      }
      case 0x49: // 释放内存：ES=块的段地址
        if (this.m.dosmem.free(cpu.s[ES])) this.ok(); else this.fail(9);
        return true;
      case 0x4a: { // 调整内存块：ES=块，BX=新的段落数
        const res = this.m.dosmem.resize(cpu.s[ES], r[BX]);
        if (res === true) this.ok();
        else { r[BX] = res.largest; this.fail(res.bad ? 9 : 8); }
        return true;
      }
      case 0x52: // 取 DOS 内部的"表的表"：ES:BX-2 处是第一个 MCB 的段地址
        cpu.s[ES] = 0x0050; r[BX] = 0x0102;
        return true;
      case 0x33: // Ctrl-Break 检查开关等
        if (this.al === 0 || this.al === 2) cpu.setR8(2, 0);
        else if (this.al === 5) cpu.setR8(2, 3); // 从 C: 启动
        return true;
      case 0x44:
        if (this.al === 0) {
          r[DX] = r[BX] <= 2 ? 0x80d3 : 0x0002;
          if (r[BX] > 4 && !this.handles.has(r[BX])) { this.fail(6); return true; }
          this.ok(); return true;
        }
        break;
      case 0x47: cpu.wb(cpu.s[DS], r[SI], 0); this.ok(); return true;
      case 0x3c: case 0x3d: case 0x5b: {
        if (!this.spin(3)) return false;
        const name = this.normName(this.readAsciiz(cpu.s[DS], r[DX]));
        if (!name || /[*?<>|"]/.test(name)) { this.fail(3); return true; }
        const fs = this.m.files;
        if (ah === 0x3d && !fs.has(name)) { this.fail(2); return true; }
        if (ah === 0x5b && fs.has(name)) { this.fail(0x50); return true; }
        if (ah !== 0x3d) fs.set(name, new Uint8Array(0));
        let h = 5;
        while (this.handles.has(h)) h++;
        if (h > 20) { this.fail(4); return true; }
        const mode = ah === 0x3d ? this.al & 3 : 2;
        this.handles.set(h, { name, pos: 0, data: Array.from(fs.get(name)!), write: mode !== 0, dirty: ah !== 0x3d });
        r[AX] = h; this.ok();
        if (ah !== 0x3d) this.m.filesChanged();
        return true;
      }
      case 0x3e: {
        if (r[BX] > 4 && !this.spin(2)) return false;
        const f = this.handles.get(r[BX]);
        if (r[BX] <= 4) { this.ok(); return true; }
        if (!f) { this.fail(6); return true; }
        this.flushFile(f);
        this.handles.delete(r[BX]);
        this.ok();
        return true;
      }
      case 0x3f: {
        const h = r[BX], seg = cpu.s[DS], off = r[DX], n = r[CX];
        if (h === 0) {
          const line = this.readLine(Math.max(0, n - 2));
          if (!line) return false;
          const bytes = [...line, 0x0d, 0x0a].slice(0, n);
          bytes.forEach((c, k) => cpu.wb(seg, off + k, c));
          this.teletype(0x0d); this.teletype(0x0a);
          r[AX] = bytes.length; this.ok();
          return true;
        }
        const f = this.handles.get(h);
        if (!this.spin(this.busyUntil < 0 ? this.diskCost(f, n) : 0)) return false;
        if (!f) { this.fail(6); return true; }
        const cnt = Math.max(0, Math.min(n, f.data.length - f.pos));
        for (let k = 0; k < cnt; k++) cpu.wb(seg, off + k, f.data[f.pos + k]);
        f.pos += cnt;
        r[AX] = cnt; this.ok();
        return true;
      }
      case 0x40: {
        const h = r[BX], seg = cpu.s[DS], off = r[DX], n = r[CX];
        if (h === 1 || h === 2) {
          for (let k = 0; k < n; k++) this.teletype(cpu.rb(seg, off + k));
          r[AX] = n; this.ok();
          return true;
        }
        if (h === 3 || h === 4) { r[AX] = n; this.ok(); return true; }
        const f = this.handles.get(h);
        if (!this.spin(this.busyUntil < 0 ? this.diskCost(f, n) : 0)) return false;
        if (!f) { this.fail(6); return true; }
        if (!f.write) { this.fail(5); return true; }
        if (n === 0) { f.data.length = f.pos; f.dirty = true; r[AX] = 0; this.ok(); this.flushFile(f); return true; }
        while (f.data.length < f.pos) f.data.push(0);
        for (let k = 0; k < n; k++) f.data[f.pos + k] = cpu.rb(seg, off + k);
        f.pos += n;
        f.dirty = true;
        r[AX] = n; this.ok();
        this.flushFile(f);
        return true;
      }
      case 0x41: {
        if (!this.spin(3)) return false;
        const name = this.normName(this.readAsciiz(cpu.s[DS], r[DX]));
        if (!this.m.files.delete(name)) { this.fail(2); return true; }
        this.m.fileTimes.delete(name);
        this.m.filesChanged();
        this.ok();
        return true;
      }
      case 0x42: {
        const f = this.handles.get(r[BX]);
        if (!f) { this.fail(6); return true; }
        const off = ((r[CX] << 16) | r[DX]) | 0;
        const base = this.al === 0 ? 0 : this.al === 1 ? f.pos : f.data.length;
        const np = base + off;
        if (np < 0) { this.fail(0x19); return true; }
        f.pos = np;
        r[AX] = np & 0xffff; r[DX] = (np >>> 16) & 0xffff; this.ok();
        return true;
      }
      case 0x43: {
        const name = this.normName(this.readAsciiz(cpu.s[DS], r[DX]));
        if (!this.m.files.has(name)) { this.fail(2); return true; }
        r[CX] = 0x20; this.ok();
        return true;
      }
    }
    this.warnOnce(`程序调用了 INT 21h 的 ${hex(ah)}h 号功能，本模拟器暂未实现（返回 CF=1）`);
    this.fail(1);
    return true;
  }

  // ---------- 查找文件 ----------

  /** 文件的修改时间，换成 DOS 的格式 */
  private dosTime(name: string): { time: number; date: number } {
    let t = this.m.fileTimes.get(name);
    if (t === undefined) { t = Date.now(); this.m.fileTimes.set(name, t); }
    const d = new Date(t);
    const y = Math.max(0, Math.min(127, d.getFullYear() - 1980));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (y << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /** 虚拟磁盘上某个目录里的文件（目录名是空串表示根目录），按 8.3 名字列出 */
  private dirEntries(dir: string): { key: string; n83: string }[] {
    const out: { key: string; n83: string }[] = [];
    for (const key of this.m.files.keys()) {
      const k = key.lastIndexOf('\\');
      if ((k < 0 ? '' : key.slice(0, k)) !== dir) continue;
      const n83 = to83(k < 0 ? key : key.slice(k + 1));
      if (n83 && !n83.includes('?')) out.push({ key, n83 });
    }
    return out;
  }

  /** INT 21h 4Eh/4Fh：查找第一个/下一个文件。查找的状态保存在 DTA 的保留区里，和真的 DOS 一样 */
  private findFile(first: boolean): boolean {
    const cpu = this.cpu, r = cpu.r, { seg, off } = this.dta;
    let template: string, attr: number, index: number, dir: string;
    if (first) {
      const p = this.normName(this.readAsciiz(cpu.s[DS], r[DX]));
      const k = p.lastIndexOf('\\');
      dir = k < 0 ? '' : p.slice(0, k);
      const t = to83(k < 0 ? p || '*.*' : p.slice(k + 1) || '*.*');
      attr = r[CX] & 0xff;
      if (!t) { this.fail(2); return true; }
      if (dir && dir !== '.' && !this.dirEntries(dir).length) { this.fail(3); return true; }
      if (dir === '.') dir = '';
      template = t; index = 0;
      // 保留区：0 驱动器号，1~11 模板，12 属性，13~14 下一个目录项的序号，15~20 目录名的长度和散列（这里只放长度）
      cpu.wb(seg, off, 3);
      for (let i = 0; i < 11; i++) cpu.wb(seg, off + 1 + i, template.charCodeAt(i));
      cpu.wb(seg, off + 12, attr);
      this.findDirs.set(seg * 16 + off, dir);
      if (attr === 0x08) { // 只找卷标
        this.writeFound(seg, off, 'ASM86', 0x08, 0, this.dosTime('').time, this.dosTime('').date);
        cpu.ww(seg, off + 13, 0xffff);
        this.ok();
        return true;
      }
    } else {
      template = '';
      for (let i = 0; i < 11; i++) template += String.fromCharCode(cpu.rb(seg, off + 1 + i));
      attr = cpu.rb(seg, off + 12);
      index = cpu.rw(seg, off + 13);
      dir = this.findDirs.get(seg * 16 + off) ?? '';
      if (index === 0xffff) { this.fail(0x12); return true; }
    }
    const list = this.dirEntries(dir);
    for (let i = index; i < list.length; i++) {
      if (!match83(template, list[i].n83)) continue;
      const { time, date } = this.dosTime(list[i].key);
      this.writeFound(seg, off, from83(list[i].n83), 0x20, this.m.files.get(list[i].key)!.length, time, date);
      cpu.ww(seg, off + 13, i + 1);
      this.ok();
      return true;
    }
    cpu.ww(seg, off + 13, 0xffff);
    this.fail(0x12); // 没有更多文件
    return true;
  }
  /** 4Eh 开始查找时的目录（按 DTA 的地址记录；虚拟磁盘一般只有根目录） */
  private findDirs = new Map<number, string>();

  /** 把找到的文件写进 DTA：15h 属性，16h 时间，18h 日期，1Ah 大小，1Eh 文件名（以 0 结尾） */
  private writeFound(seg: number, off: number, name: string, attr: number, size: number, time: number, date: number): void {
    const cpu = this.cpu;
    cpu.wb(seg, off + 0x15, attr);
    cpu.ww(seg, off + 0x16, time);
    cpu.ww(seg, off + 0x18, date);
    cpu.ww(seg, off + 0x1a, size & 0xffff);
    cpu.ww(seg, off + 0x1c, (size >>> 16) & 0xffff);
    for (let i = 0; i < 13; i++) cpu.wb(seg, off + 0x1e + i, i < name.length ? name.charCodeAt(i) : 0);
  }

  /**
   * INT 21h 11h/12h：用 FCB 查找文件（DOS 1.0 的老方法）。DS:DX 是 FCB（可以是以 FFh 开头的扩展 FCB），
   * 结果按"驱动器号 + 32 字节目录项"写进 DTA；查找的位置记在 FCB 的保留区（偏移 0Ch）里
   */
  private fcbFind(first: boolean): boolean {
    const cpu = this.cpu, r = cpu.r, ds = cpu.s[DS];
    let fcb = r[DX], attr = 0;
    const ext = cpu.rb(ds, fcb) === 0xff;
    if (ext) { attr = cpu.rb(ds, fcb + 6); fcb += 7; }
    let template = '';
    for (let i = 0; i < 11; i++) template += String.fromCharCode(cpu.rb(ds, fcb + 1 + i)).toUpperCase();
    const index = first ? 0 : cpu.rw(ds, fcb + 0x0c);
    const list = this.dirEntries('');
    const { seg, off } = this.dta;
    for (let i = index; i < list.length; i++) {
      if (!match83(template, list[i].n83)) continue;
      cpu.ww(ds, fcb + 0x0c, i + 1);
      let o = off;
      if (ext) { cpu.wb(seg, o, 0xff); for (let k = 1; k < 6; k++) cpu.wb(seg, o + k, 0); cpu.wb(seg, o + 6, attr); o += 7; }
      cpu.wb(seg, o, cpu.rb(ds, fcb) || 3);
      for (let k = 0; k < 11; k++) cpu.wb(seg, o + 1 + k, list[i].n83.charCodeAt(k));
      cpu.wb(seg, o + 12, 0x20);
      for (let k = 13; k < 23; k++) cpu.wb(seg, o + k, 0);
      const { time, date } = this.dosTime(list[i].key), size = this.m.files.get(list[i].key)!.length;
      cpu.ww(seg, o + 23, time); cpu.ww(seg, o + 25, date); cpu.ww(seg, o + 27, 0);
      cpu.ww(seg, o + 29, size & 0xffff); cpu.ww(seg, o + 31, (size >>> 16) & 0xffff);
      this.al = 0;
      return true;
    }
    this.al = 0xff;
    return true;
  }

  /** INT 21h 29h：把 DS:SI 处的文件名分析成 FCB（ES:DI）。AL 的位 0 跳过前导分隔符，位 1~3 没写驱动器/名字/扩展名时保留 FCB 原值 */
  private parseFcbName(): boolean {
    const cpu = this.cpu, r = cpu.r, ds = cpu.s[DS], es = cpu.s[ES], fcb = r[DI], flags = this.al;
    let si = r[SI];
    const ch = () => String.fromCharCode(cpu.rb(ds, si));
    const SEP = ':.;,=+ \t';
    if (flags & 1) while (SEP.includes(ch()) && ch() !== '.') si++;
    else while (ch() === ' ' || ch() === '\t') si++;
    let wild = false;
    // 驱动器
    const c0 = ch().toUpperCase();
    if (/[A-Z]/.test(c0) && String.fromCharCode(cpu.rb(ds, si + 1)) === ':') {
      cpu.wb(es, fcb, c0.charCodeAt(0) - 64); si += 2;
    } else if (!(flags & 2)) cpu.wb(es, fcb, 0);
    const field = (start: number, len: number, keep: boolean) => {
      let s = '';
      while (s.length < 32) {
        const c = ch();
        if (c === '\0' || c === '.' || c <= ' ' || '/\\"[]<>|:;,=+'.includes(c)) break;
        s += c.toUpperCase(); si++;
      }
      if (!s) { if (!keep) for (let k = 0; k < len; k++) cpu.wb(es, fcb + start + k, 0x20); return; }
      const star = s.indexOf('*');
      if (star >= 0) s = s.slice(0, star).padEnd(len, '?');
      if (s.includes('?')) wild = true;
      s = s.slice(0, len).padEnd(len, ' ');
      for (let k = 0; k < len; k++) cpu.wb(es, fcb + start + k, s.charCodeAt(k));
    };
    field(1, 8, (flags & 4) !== 0);
    if (ch() === '.') { si++; field(9, 3, false); } else if (!(flags & 8)) for (let k = 0; k < 3; k++) cpu.wb(es, fcb + 9 + k, 0x20);
    r[SI] = si;
    this.al = wild ? 1 : 0;
    return true;
  }

  private flushFile(f: OpenFile): void {
    if (!f.dirty) return;
    this.m.fileTimes.set(f.name, Date.now());
    this.m.files.set(f.name, Uint8Array.from(f.data));
    f.dirty = false;
    this.m.filesChanged();
  }
}

function hex(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function range(a: number, b: number): number[] { const out: number[] = []; for (let i = a; i <= b; i++) out.push(i); return out; }
