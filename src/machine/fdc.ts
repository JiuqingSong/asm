// 软驱控制器：NEC µPD765 / Intel 82077AA（端口 3F0h~3F5h、3F7h，IRQ6，DMA 2 号通道）
//
// DOS 下软盘由 BIOS 的 INT 13h 读写（bios.ts 里高层模拟，不经过这里）；Windows 95、Linux 这些系统用自己的
// 驱动直接操作控制器：往数据端口（3F5h）写命令和参数，控制器寻道、读写扇区（数据经 DMA 2 号通道和内存交换），
// 完成后发 IRQ6，驱动再从数据端口读回结果字节（ST0、ST1、ST2、柱面、磁头、扇区、扇区大小）。
//
// 软盘就是 A:、B: 的磁盘映像（disk.ts），按柱面、磁头、扇区找到映像里的 512 字节。没有模拟的：
// 数据传输率（任何传输率都能读）、磁头加载和寻道的真实时间、删除标记的扇区、扫描命令。
import type { Disk } from './disk.ts';

/** 主状态寄存器（3F4h）的位 */
const RQM = 0x80, DIO = 0x40, NDMA = 0x20, CB = 0x10;
/** ST0 的位：异常结束、无效命令、寻道结束、设备检查 */
const ST0_ABNORMAL = 0x40, ST0_INVALID = 0x80, ST0_SEEK_END = 0x20, ST0_EQUIP = 0x10;
/** ST1 的位：到了磁道末尾、找不到扇区、找不到地址标记；ST2：柱面不对 */
const ST1_EN = 0x80, ST1_ND = 0x04, ST1_MA = 0x01, ST1_NW = 0x02, ST2_WC = 0x10, ST2_CM = 0x40;
/** 命令执行要花的时间（PIT 时钟，约 0.5 毫秒）：结果总是在发命令之后的一小会儿才出来，像真的控制器 */
const DELAY = 600;

/** 各命令（低 5 位）在命令字节之后的参数个数；没有的是无效命令 */
const PARAMS: Record<number, number> = {
  0x02: 8, 0x03: 2, 0x04: 1, 0x05: 8, 0x06: 8, 0x07: 1, 0x08: 0, 0x09: 8, 0x0a: 1, 0x0c: 8, 0x0d: 5,
  0x0e: 0, 0x0f: 2, 0x10: 0, 0x12: 1, 0x13: 3, 0x14: 0, 0x16: 8,
};

type Phase = 'command' | 'exec' | 'pioIn' | 'pioOut' | 'result';
type Transfer = {
  c: number[]; disk: Disk; cyl: number;
  sectors: { lba: number; h: number; r: number }[];
  usable: number; k: number;
};
type Action =
  | { kind: 'irq' }
  | { kind: 'seek'; d: number; head: number; target: number }
  | { kind: 'id'; d: number; head: number; disk: Disk }
  | { kind: 'transfer' | 'format'; c: number[]; disk: Disk; cyl: number }
  | { kind: 'dma' | 'pio'; transfer: Transfer }
  | { kind: 'formatIds'; disk: Disk; d: number; head: number; n: number; fill: number };

export interface FdcHost {
  /** 0、1 号驱动器里的软盘（没有盘时为 null） */
  disk(drive: number): Disk | null;
  /** 驱动器存在（A:、B: 固定安装，与是否插盘无关） */
  driveExists(drive: number): boolean;
  /** 现在的虚拟时间（PIT 时钟） */
  now(): number;
  /** 发 IRQ6 */
  irq(): void;
  /** 经 DMA 2 号通道传送（按通道的模式把 data 写进内存，或从内存读进 data）；返回传送的字节数和是否到达终点。通道被屏蔽时返回 null */
  dma(data: Uint8Array): { n: number; tc: boolean } | null;
  /** 软盘被写过（界面据此提示下载） */
  written(drive: number): void;
}

export class FloppyController {
  /** 数字输出寄存器（3F2h）：位 0~1 选驱动器，位 2 为 0 时复位，位 3 允许中断和 DMA，位 4~7 马达 */
  dor = 0x0c;
  /** 传输率（3F4h 写、3F7h 写），只保存 */
  rate = 0;
  private phase: Phase = 'command';
  private cmd: number[] = [];
  private result: number[] = [];
  /** 非 DMA（SPECIFY 的 ND 位）时经数据端口逐字节传送的数据 */
  private pio = new Uint8Array(0);
  private pioPos = 0;
  private pioDone: Action | null = null;
  /** 各驱动器磁头所在的柱面 */
  private pcn = [0, 0, 0, 0];
  /** 正在寻道的驱动器（主状态寄存器的位 0~3） */
  private seeking = 0;
  /** 等着 SENSE INTERRUPT STATUS 读走的中断：ST0 和柱面 */
  private pending: [number, number][] = [];
  /** SPECIFY 的两个字节、CONFIGURE 的设置、LOCK */
  private specify = [0, 0];
  private config = [0x20, 0]; // EIS/EFIFO/POLL/FIFOTHR、PRETRK
  private locked = false;
  private perpendicular = 0;
  /** 换盘信号（3F7h 的位 7）：放入、取出软盘后为 1，寻道后清掉 */
  private changeLine = [true, true, true, true];
  private seen: (Disk | null)[] = [null, null, null, null];
  /** 读 ID 时转到的下一个扇区（模拟软盘在转） */
  private rotation = 0;
  /** 下一个事件（命令执行完）的时间和要做的事 */
  next = Infinity;
  private action: Action | null = null;

  private host: FdcHost;
  constructor(host: FdcHost) { this.host = host; }

  /** 机器复位：控制器回到开机时的状态（BIOS 开机后 DOR 是 0Ch） */
  reset(): void {
    this.dor = 0x0c; this.rate = 0;
    this.pcn = [0, 0, 0, 0];
    this.specify = [0, 0]; this.config = [0x20, 0]; this.locked = false; this.perpendicular = 0;
    this.changeLine = [true, true, true, true];
    this.softReset();
    this.pending = [];
  }

  /** 控制器复位（DOR 位 2、DSR 位 7）：中止命令；复位结束时发中断，驱动用 4 次 SENSE INTERRUPT STATUS 读走 */
  private softReset(): void {
    this.phase = 'command'; this.cmd = []; this.result = []; this.pioDone = null;
    this.seeking = 0; this.next = Infinity; this.action = null;
    if (!this.locked) this.config = [0x20, 0];
    this.pending = [[0xc0, 0], [0xc1, 0], [0xc2, 0], [0xc3, 0]];
  }

  static owns(port: number): boolean { return port >= 0x3f0 && port <= 0x3f7 && port !== 0x3f6; }

  /** 机器推进时间时调用：到时间的命令执行完 */
  tick(): void {
    if (this.host.now() < this.next) return;
    const f = this.action;
    this.next = Infinity; this.action = null;
    if (f) this.continueAction(f);
  }

  private later(f: Action): void {
    this.action = f;
    this.next = this.host.now() + DELAY;
  }

  private interrupt(): void { if (this.dor & 0x08) this.host.irq(); }

  private continueAction(a: Action): void {
    switch (a.kind) {
      case 'irq': this.interrupt(); return;
      case 'seek': {
        const { d, head, target } = a;
        this.seeking &= ~(1 << d);
        if (!this.host.driveExists(d)) { this.pending.push([ST0_SEEK_END | ST0_ABNORMAL | ST0_EQUIP | (head << 2) | d, this.pcn[d]]); this.interrupt(); return; }
        this.pcn[d] = target;
        this.checkChange(d);
        if (d < 2 && this.host.disk(d)) this.changeLine[d] = false;
        this.pending.push([ST0_SEEK_END | (head << 2) | d, target]);
        this.interrupt(); return;
      }
      case 'id': {
        const { d, head, disk } = a, g = disk.geo, cyl = this.pcn[d];
        if (cyl >= g.cylinders || head >= g.heads) { this.finish(this.status(ST0_ABNORMAL | (head << 2) | d, ST1_MA, 0, cyl, head, 1, 2), true); return; }
        this.rotation = this.rotation % g.sectors + 1;
        this.finish(this.status((head << 2) | d, 0, 0, cyl, head, this.rotation, 2), true); return;
      }
      case 'transfer': this.transferReady(a.c, a.disk, a.cyl); return;
      case 'format': this.formatReady(a.c, a.disk); return;
      case 'dma': this.transferDma(a.transfer); return;
      case 'pio': {
        const t = a.transfer;
        if ([0x05, 0x09].includes(t.c[0] & 0x1f)) {
          for (let i = 0; i < t.usable; i++) t.disk.writeSector(t.sectors[i].lba, this.pio.subarray(i * 512, i * 512 + 512));
          this.host.written(t.c[1] & 3);
        }
        this.transferEnd(t, t.usable, false, t.usable < t.sectors.length); return;
      }
      case 'formatIds': this.formatIds(a.disk, a.d, a.head, a.n, a.fill, this.pio); return;
    }
  }

  private get selected(): number { return this.dor & 3; }

  /** 软盘换过了：记下换盘信号 */
  private checkChange(d: number): void {
    const disk = d < 2 ? this.host.disk(d) : null;
    if (disk !== this.seen[d]) { this.seen[d] = disk; this.changeLine[d] = true; }
  }

  in8(port: number): number {
    switch (port) {
      case 0x3f2: return this.dor;
      case 0x3f4: return this.msr();
      case 0x3f5: return this.readData();
      case 0x3f7: { // 数字输入寄存器：位 7 是选中的驱动器的换盘信号
        const d = this.selected;
        this.checkChange(d);
        return this.changeLine[d] ? 0x80 : 0;
      }
    }
    return 0xff; // 3F0h、3F1h：AT 机上没有（PS/2 的状态寄存器）
  }

  out8(port: number, v: number): void {
    switch (port) {
      case 0x3f2: {
        const was = this.dor;
        this.dor = v;
        if (!(v & 4)) { this.phase = 'command'; this.next = Infinity; this.action = null; return; } // 保持在复位状态
        if (!(was & 4)) { this.softReset(); this.later({ kind: 'irq' }); } // 复位结束
        return;
      }
      case 0x3f4: // 传输率选择：位 7 软件复位
        this.rate = v & 3;
        if (v & 0x80) { this.softReset(); this.later({ kind: 'irq' }); }
        return;
      case 0x3f5: this.writeData(v); return;
      case 0x3f7: this.rate = v & 3; return;
    }
  }

  private msr(): number {
    if (!(this.dor & 4)) return 0;
    switch (this.phase) {
      case 'command': return RQM | (this.cmd.length ? CB : 0) | this.seeking;
      case 'exec': return CB | this.seeking;
      case 'pioIn': return RQM | DIO | NDMA | CB;
      case 'pioOut': return RQM | NDMA | CB;
      case 'result': return RQM | DIO | CB;
    }
  }

  private readData(): number {
    if (this.phase === 'pioIn') {
      const v = this.pio[this.pioPos++];
      if (this.pioPos >= this.pio.length) { const f = this.pioDone!; this.pioDone = null; this.continueAction(f); }
      return v;
    }
    if (this.phase !== 'result') return 0xff;
    const v = this.result.shift()!;
    if (!this.result.length) this.phase = 'command';
    return v;
  }

  private writeData(v: number): void {
    if (!(this.dor & 4)) return;
    if (this.phase === 'pioOut') {
      this.pio[this.pioPos++] = v;
      if (this.pioPos >= this.pio.length) { const f = this.pioDone!; this.pioDone = null; this.continueAction(f); }
      return;
    }
    if (this.phase !== 'command') return;
    this.cmd.push(v);
    const op = this.cmd[0];
    const need = PARAMS[op & 0x1f] ?? PARAMS[op];
    if (need === undefined || (op & 0x1f) === 0x0e && op !== 0x0e || (op & 0x1f) === 0x10 && op !== 0x10) {
      this.cmd = [];
      this.finish([ST0_INVALID], false);
      return;
    }
    if (this.cmd.length < need + 1) return;
    const c = this.cmd;
    this.cmd = [];
    this.execute(c);
  }

  /** 进入结果阶段；irq 时同时发中断 */
  private finish(result: number[], irq: boolean): void {
    this.result = result;
    this.phase = result.length ? 'result' : 'command';
    if (irq) this.interrupt();
  }

  private execute(c: number[]): void {
    const op = c[0] & 0x1f;
    switch (op) {
      case 0x03: this.specify = [c[1], c[2]]; this.phase = 'command'; return; // SPECIFY
      case 0x04: this.finish([this.st3(c[1])], false); return;              // SENSE DRIVE STATUS
      case 0x08: {                                                          // SENSE INTERRUPT STATUS
        const p = this.pending.shift();
        this.finish(p ? [p[0], p[1]] : [ST0_INVALID], false);
        return;
      }
      case 0x07: case 0x0f: {                                               // RECALIBRATE、SEEK（含相对寻道）
        const d = c[1] & 3, head = (c[1] >> 2) & 1;
        let target = op === 0x07 ? 0 : c[2];
        if (op === 0x0f && c[0] & 0x80) target = c[0] & 0x40 ? this.pcn[d] + c[2] : this.pcn[d] - c[2];
        target = Math.max(0, Math.min(255, target));
        this.seeking |= 1 << d;
        this.phase = 'command';
        this.later({ kind: 'seek', d, head, target });
        return;
      }
      case 0x0a: {                                                          // READ ID
        const d = c[1] & 3, head = (c[1] >> 2) & 1;
        this.phase = 'exec';
        const disk = this.mediaFor(d);
        if (!disk) return; // 没有盘：软盘不转，命令一直不结束（驱动超时后复位控制器）
        this.later({ kind: 'id', d, head, disk });
        return;
      }
      case 0x02: case 0x05: case 0x06: case 0x09: case 0x0c: case 0x16: this.transferCommand(c); return;
      case 0x0d: this.format(c); return;
      case 0x0e:                                                             // DUMPREG
        this.finish([...this.pcn, this.specify[0], this.specify[1], 0, (this.locked ? 0x80 : 0) | this.perpendicular, this.config[0], this.config[1]], false);
        return;
      case 0x10: this.finish([0x90], false); return;                         // VERSION：82077（增强型）
      case 0x12: this.perpendicular = c[1] & 0x3f; this.phase = 'command'; return; // PERPENDICULAR MODE
      case 0x13: this.config = [c[2], c[3]]; this.phase = 'command'; return; // CONFIGURE
      case 0x14: this.locked = (c[0] & 0x80) !== 0; this.finish([this.locked ? 0x10 : 0], false); return; // LOCK / UNLOCK
    }
    this.finish([ST0_INVALID], false);
  }

  /** 驱动器里的软盘（不存在的驱动器、没有盘时为 null） */
  private mediaFor(d: number): Disk | null {
    if (d >= 2 || !this.host.driveExists(d)) return null;
    this.checkChange(d);
    return this.host.disk(d);
  }

  private st3(b: number): number {
    const d = b & 3, head = (b >> 2) & 1;
    const disk = this.mediaFor(d);
    return 0x20 | (this.pcn[d] === 0 ? 0x10 : 0) | (!disk || disk.geo.heads > 1 ? 0x08 : 0) | (disk?.readOnly ? 0x40 : 0) | (head << 2) | d;
  }

  private status(st0: number, st1: number, st2: number, c: number, h: number, r: number, n: number): number[] {
    return [st0, st1, st2, c & 0xff, h & 0xff, r & 0xff, n & 0xff];
  }

  /** 读、写、校验扇区（READ DATA、READ DELETED、READ TRACK、WRITE DATA、WRITE DELETED、VERIFY） */
  private transferCommand(c: number[]): void {
    const d = c[1] & 3;
    this.phase = 'exec';
    const disk = this.mediaFor(d);
    if (!disk) return;
    if (this.config[0] & 0x40) this.pcn[d] = c[2];
    this.later({ kind: 'transfer', c, disk, cyl: this.pcn[d] });
  }

  private transferReady(c: number[], disk: Disk, cyl: number): void {
    const op = c[0] & 0x1f, mt = (c[0] & 0x80) !== 0, mfm = (c[0] & 0x40) !== 0;
    const write = op === 0x05 || op === 0x09, verify = op === 0x16;
    const d = c[1] & 3;
    const head = (c[1] >> 2) & 1;
    const C = c[2], H = c[3], N = c[5], EOT = c[6];
    const R = op === 0x02 ? 1 : c[4];
    const pioMode = (this.specify[1] & 1) !== 0 && !verify;
    const g = disk.geo;
    const fail = (st1: number, st2 = 0) => this.finish(this.status(ST0_ABNORMAL | (head << 2) | d, st1, st2, C, head, R, N), true);

      if (!mfm) { fail(ST1_MA); return; }                       // FM（单密度）：PC 的软盘都是 MFM
      if (cyl >= g.cylinders || head >= g.heads) { fail(ST1_MA); return; }
      if (C !== cyl) { fail(ST1_ND, ST2_WC); return; }          // 磁头所在的磁道上找不到这个柱面号
      if (write && disk.readOnly) { this.finish(this.status(ST0_ABNORMAL | (head << 2) | d, ST1_NW, 0, C, head, R, N), true); return; }
      const size = N === 0 ? (c[8] || 128) : 128 << Math.min(N, 7);
      if (size !== 512) { fail(ST1_ND); return; }               // 只有 512 字节的扇区
      if (H !== head) { fail(ST1_ND); return; }                 // 扇区 ID 里的磁头号和磁头对不上
      // 要传送的扇区：从 R 到 EOT（多磁道时接着读另一面）；lba < 0 是这个磁道上没有的扇区
      const sectors: { lba: number; h: number; r: number }[] = [];
      for (let r = R, h = head; ;) {
        sectors.push({ lba: disk.lba(cyl, h, r), h, r });
        if (op === 0x0c) break;                                 // READ DELETED：读到正常扇区后停下
        if (r >= EOT) { if (mt && h === 0 && g.heads > 1) { h = 1; r = 1; continue; } break; }
        r++;
      }
      const firstBad = sectors.findIndex(x => x.lba < 0);
      const usable = firstBad < 0 ? sectors.length : firstBad;
      const transfer: Transfer = { c, disk, cyl, sectors, usable, k: 0 };
      if (usable === 0) { this.transferEnd(transfer, 0, false, true); return; }

      if (pioMode) {
        // 非 DMA：全部数据经数据端口逐字节读写（主机读完、写完后进入结果阶段）
        this.pio = new Uint8Array(usable * 512);
        this.pioPos = 0;
        if (!write) for (let i = 0; i < usable; i++) this.pio.set(disk.readSector(sectors[i].lba) ?? new Uint8Array(512), i * 512);
        this.phase = write ? 'pioOut' : 'pioIn';
        this.pioDone = { kind: 'pio', transfer };
        this.interrupt();
        return;
      }

      this.transferDma(transfer);
  }

  private transferEnd(t: Transfer, done: number, tc: boolean, bad: boolean): void {
    const c = t.c, C = c[2], N = c[5], EOT = c[6], d = c[1] & 3;
    const op = c[0] & 0x1f, mt = (c[0] & 0x80) !== 0;
    if (bad) { const x = t.sectors[done]; this.finish(this.status(ST0_ABNORMAL | (x.h << 2) | d, ST1_ND, 0, C, x.h, x.r, N), true); return; }
    const last = t.sectors[done - 1];
    let rc = C, rh = last.h, rr = last.r + 1;
    if (last.r >= EOT) { rr = 1; if (mt && last.h === 0) rh = 1; else { rc = C + 1; if (mt) rh = 0; } }
    const ranOff = !tc && op !== 0x0c;
    this.finish(this.status((ranOff ? ST0_ABNORMAL : 0) | (last.h << 2) | d, ranOff ? ST1_EN : 0, op === 0x0c ? ST2_CM : 0, rc, rh, rr, N), true);
  }

  private transferDma(t: Transfer): void {
    const op = t.c[0] & 0x1f, write = op === 0x05 || op === 0x09, verify = op === 0x16;
    while (t.k < t.usable) {
      const lba = t.sectors[t.k].lba;
      if (verify) { t.k++; continue; }
      const buf = write ? new Uint8Array(512) : Uint8Array.from(t.disk.readSector(lba) ?? new Uint8Array(512));
      const res = this.host.dma(buf);
      if (!res) { this.later({ kind: 'dma', transfer: t }); return; }
      if (write && res.n) { t.disk.writeSector(lba, buf); this.host.written(t.c[1] & 3); }
      t.k++;
      if (res.tc) { this.transferEnd(t, t.k, true, false); return; }
    }
    this.transferEnd(t, t.k, false, t.usable < t.sectors.length);
  }

  /** FORMAT TRACK：DMA 送来每个扇区的 C、H、R、N（各 4 字节），扇区内容填成 D */
  private format(c: number[]): void {
    const d = c[1] & 3;
    this.phase = 'exec';
    const disk = this.mediaFor(d);
    if (!disk) return;
    this.later({ kind: 'format', c, disk, cyl: this.pcn[d] });
  }

  private formatReady(c: number[], disk: Disk): void {
    const d = c[1] & 3, head = (c[1] >> 2) & 1, N = c[2], SC = c[3], D = c[5];
      const cyl = this.pcn[d];
      if (disk.readOnly) { this.finish(this.status(ST0_ABNORMAL | (head << 2) | d, ST1_NW, 0, cyl, head, 1, N), true); return; }
      const ids = new Uint8Array(SC * 4);
      if ((this.specify[1] & 1) === 0) {
        const res = this.host.dma(ids);
        if (!res) { this.format(c); return; }
      } else {
        // 非 DMA：主机经数据端口写 ID
        this.pio = ids; this.pioPos = 0; this.phase = 'pioOut';
        this.pioDone = { kind: 'formatIds', disk, d, head, n: N, fill: D };
        this.interrupt();
        return;
      }
      this.formatIds(disk, d, head, N, D, ids);
  }

  private formatIds(disk: Disk, d: number, head: number, N: number, D: number, ids: Uint8Array): void {
    const cyl = this.pcn[d], fill = new Uint8Array(512).fill(D);
    let last = 1;
    for (let i = 0; i + 3 < ids.length; i += 4) {
      last = ids[i + 2];
      if (ids[i + 3] !== 2) continue;
      const lba = disk.lba(cyl, head, ids[i + 2]);
      if (lba >= 0) disk.writeSector(lba, fill);
    }
    if (ids.length) this.host.written(d);
    this.finish(this.status((head << 2) | d, 0, 0, cyl, head, last, N), true);
  }
}
