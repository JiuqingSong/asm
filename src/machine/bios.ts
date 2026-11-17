// BIOS 与 DOS 功能的高层模拟（HLE）
//
// 每个中断向量默认指向 F000 段里的一小段桩代码，桩代码里的"陷阱"指令会调用这里的处理函数。
// 处理函数通过修改寄存器返回结果；需要通过标志位返回的（CF、ZF）修改栈上保存的 FLAGS。
// 返回 false 表示需要等待（例如键盘缓冲区为空），CPU 会停在陷阱处，等有按键后重试。
import { AX, BX, CX, DX, SI, BP, DS, ES, CF, ZF, type CPU } from '../cpu/cpu.ts';
import type { Machine } from './machine.ts';
import { PIT_HZ } from './uart.ts';

const BDA = 0x40;
const VIDEO_SEG = 0xb800;
const COLS = 80, ROWS = 25;

interface OpenFile { name: string; pos: number; data: number[]; write: boolean; dirty: boolean }

export class Hle {
  private m: Machine;
  private cpu: CPU;
  /** 正在进行的行输入（INT 21h 0Ah / 3Fh） */
  private line: number[] | null = null;
  private handles = new Map<number, OpenFile>();
  private warned = new Set<string>();
  private nextFreeSeg = 0;
  /** 正在进行的磁盘操作结束的虚拟时间（-1 表示没有） */
  private busyUntil = -1;

  constructor(m: Machine) {
    this.m = m;
    this.cpu = m.cpu;
  }

  reset(memStartSeg: number): void {
    this.line = null;
    this.busyUntil = -1;
    this.m.busy = false;
    this.handles.clear();
    this.nextFreeSeg = memStartSeg;
  }

  /**
   * 模拟磁盘操作的耗时：在 ms 毫秒（虚拟时间）内反复返回 false，CPU 停在陷阱处"忙等"，
   * 期间中断保持开放（桩代码先执行了 STI），和真实的 DOS 等待磁盘时一样。
   */
  private spin(ms: number): boolean {
    if (!this.m.diskLatency || ms <= 0) return true;
    if (this.busyUntil < 0) this.busyUntil = this.m.clock + (ms * PIT_HZ) / 1000;
    if (this.m.clock < this.busyUntil) { this.m.busy = true; return false; }
    this.busyUntil = -1;
    this.m.busy = false;
    return true;
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
      case 0x33: this.cpu.r[AX] = 0; return true; // 没有鼠标
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
  getCursor(): { row: number; col: number } {
    return { col: this.cpu.rb(BDA, 0x50), row: this.cpu.rb(BDA, 0x51) };
  }
  setCursor(row: number, col: number): void {
    this.cpu.wb(BDA, 0x50, col);
    this.cpu.wb(BDA, 0x51, row);
  }

  private cellOff(row: number, col: number): number { return (row * COLS + col) * 2; }

  scroll(up: boolean, n: number, attr: number, r1: number, c1: number, r2: number, c2: number): void {
    const cpu = this.cpu;
    r2 = Math.min(r2, ROWS - 1); c2 = Math.min(c2, COLS - 1);
    if (r1 > r2 || c1 > c2) return;
    const h = r2 - r1 + 1;
    if (n === 0 || n > h) n = h;
    const rows = up ? range(r1, r2) : range(r1, r2).reverse();
    for (const r of rows) {
      const src = up ? r + n : r - n;
      for (let c = c1; c <= c2; c++) {
        const o = this.cellOff(r, c);
        if (src >= r1 && src <= r2) {
          const so = this.cellOff(src, c);
          cpu.wb(VIDEO_SEG, o, cpu.rb(VIDEO_SEG, so));
          cpu.wb(VIDEO_SEG, o + 1, cpu.rb(VIDEO_SEG, so + 1));
        } else {
          cpu.wb(VIDEO_SEG, o, 0x20);
          cpu.wb(VIDEO_SEG, o + 1, attr);
        }
      }
    }
  }

  /** 电传方式输出一个字符（处理回车、换行、退格、响铃，到底部自动滚屏） */
  teletype(ch: number, attr = -1): void {
    let { row, col } = this.getCursor();
    switch (ch) {
      case 0x07: this.m.bell(); break;
      case 0x08: if (col > 0) col--; break;
      case 0x0a: row++; break;
      case 0x0d: col = 0; break;
      default: {
        const o = this.cellOff(row, col);
        this.cpu.wb(VIDEO_SEG, o, ch);
        if (attr >= 0) this.cpu.wb(VIDEO_SEG, o + 1, attr);
        col++;
        if (col >= COLS) { col = 0; row++; }
      }
    }
    if (row >= ROWS) { this.scroll(true, 1, 0x07, 0, 0, ROWS - 1, COLS - 1); row = ROWS - 1; }
    this.setCursor(row, col);
    this.m.consoleOut(ch);
  }

  writeString(s: string): void {
    for (const c of s) this.teletype(c.charCodeAt(0) & 0xff);
  }

  clearScreen(): void {
    for (let o = 0; o < COLS * ROWS * 2; o += 2) {
      this.cpu.wb(VIDEO_SEG, o, 0x20);
      this.cpu.wb(VIDEO_SEG, o + 1, 0x07);
    }
    this.setCursor(0, 0);
  }

  private video(): boolean {
    const cpu = this.cpu, r = cpu.r;
    const bl = r[BX] & 0xff;
    switch (this.ah) {
      case 0x00: {
        const mode = this.al & 0x7f;
        if (mode > 3 && mode !== 7) this.warnOnce(`程序切换到了显示模式 ${hex(mode)}h，本模拟器目前只支持文本模式`);
        cpu.wb(BDA, 0x49, mode);
        if (!(this.al & 0x80)) this.clearScreen(); else this.setCursor(0, 0);
        return true;
      }
      case 0x01: cpu.ww(BDA, 0x60, r[CX]); return true;
      case 0x02: this.setCursor(r[DX] >> 8, r[DX] & 0xff); return true;
      case 0x03: { const c = this.getCursor(); r[DX] = (c.row << 8) | c.col; r[CX] = cpu.rw(BDA, 0x60); return true; }
      case 0x05: return true;
      case 0x06: case 0x07:
        this.scroll(this.ah === 0x06, this.al, r[BX] >> 8, r[CX] >> 8, r[CX] & 0xff, r[DX] >> 8, r[DX] & 0xff);
        return true;
      case 0x08: {
        const c = this.getCursor(), o = this.cellOff(c.row, c.col);
        r[AX] = (cpu.rb(VIDEO_SEG, o + 1) << 8) | cpu.rb(VIDEO_SEG, o);
        return true;
      }
      case 0x09: case 0x0a: {
        const c = this.getCursor();
        let o = this.cellOff(c.row, c.col);
        for (let k = 0; k < r[CX] && o < COLS * ROWS * 2; k++, o += 2) {
          cpu.wb(VIDEO_SEG, o, this.al);
          if (this.ah === 0x09) cpu.wb(VIDEO_SEG, o + 1, bl);
        }
        return true;
      }
      case 0x0e: this.teletype(this.al); return true;
      case 0x0f: r[AX] = (COLS << 8) | cpu.rb(BDA, 0x49); cpu.setR8(7, 0); return true;
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
      case 0x10: case 0x11: case 0x12: case 0x1a: return true;
    }
    this.warnOnce(`INT 10h 功能 ${hex(this.ah)}h 暂未实现`);
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
      case 0x1a: return true;
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
      case 0x48: {
        const need = r[BX];
        if (this.nextFreeSeg + need > 0xa000) { r[BX] = Math.max(0, 0xa000 - this.nextFreeSeg); this.fail(8); return true; }
        r[AX] = this.nextFreeSeg; this.nextFreeSeg += need; this.ok();
        return true;
      }
      case 0x49: case 0x4a: this.ok(); return true;
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
        if (!this.spin(1 + n / 1000)) return false;
        const f = this.handles.get(h);
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
        if (!this.spin(1 + n / 1000)) return false;
        const f = this.handles.get(h);
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

  private flushFile(f: OpenFile): void {
    if (!f.dirty) return;
    this.m.files.set(f.name, Uint8Array.from(f.data));
    f.dirty = false;
    this.m.filesChanged();
  }
}

function hex(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function range(a: number, b: number): number[] { const out: number[] = []; for (let i = a; i <= b; i++) out.push(i); return out; }
