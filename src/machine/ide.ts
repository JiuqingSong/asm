// IDE 第一通道上的 ATA 硬盘（端口 1F0h~1F7h、3F6h，IRQ14）：C: 是主盘，D: 是从盘
//
// DOS 用 BIOS 的 INT 13h 读写硬盘（bios.ts 里高层模拟，不经过这里）；Windows 95 的 32 位磁盘驱动（ESDI_506.PDR）、
// Linux 这些系统直接操作控制器：往任务文件寄存器写扇区地址（CHS 或 LBA）和扇区数，再写命令；读扇区时控制器
// 把数据准备好、置 DRQ、发中断，主机从数据端口按 16 位读走 256 个字；写扇区时主机先把数据写进数据端口。
//
// 只有 PIO 方式（IDENTIFY 里不报告 DMA）。D: 是光盘映像合成的只读盘时，扇区内容还没从文件里读出来就报告"忙"，
// 读到以后再继续（见 iso.ts）；写它会被中止。
import type { Disk } from './disk.ts';

/** 状态寄存器的位 */
const BSY = 0x80, DRDY = 0x40, DSC = 0x10, DRQ = 0x08, ERR = 0x01;
/** 错误寄存器的位：中止命令、找不到扇区（ID 不存在） */
const ABRT = 0x04, IDNF = 0x10;
/** READ/WRITE MULTIPLE 一块最多的扇区数 */
const MAX_MULTIPLE = 16;

type Phase = 'idle' | 'dataIn' | 'dataOut';

export interface IdeHost {
  /** 0 = 主盘（C:），1 = 从盘（D:）；没有时为 null */
  disk(unit: number): Disk | null;
  /** 发 IRQ14 */
  irq(): void;
  /** 硬盘被写过 */
  written(unit: number): void;
}

export class IdeChannel {
  // ---- 任务文件寄存器（两个设备共用） ----
  private features = 0;
  private sectorCount = 0;
  private sector = 0;        // 扇区号 / LBA 位 0~7
  private cylLow = 0;        // 柱面低字节 / LBA 位 8~15
  private cylHigh = 0;       // 柱面高字节 / LBA 位 16~23
  private device = 0xa0;     // 位 4 选从盘，位 6 LBA 方式，位 0~3 磁头号 / LBA 位 24~27
  private control = 0;       // 设备控制：位 1 nIEN，位 2 SRST
  // ---- 每个设备自己的 ----
  private status = [DRDY | DSC, DRDY | DSC];
  private error = [1, 1];
  /** INITIALIZE DEVICE PARAMETERS 设置的逻辑几何（CHS 方式换算用）：磁头数、每道扇区数；null = 默认（映像的几何） */
  private logical: ([number, number] | null)[] = [null, null];
  /** SET MULTIPLE MODE 设置的每块扇区数（0 = 没有设置） */
  private multiple = [0, 0];
  // ---- 命令执行 ----
  private phase: Phase = 'idle';
  private unit = 0;
  private buf = new Uint8Array(512);
  private pos = 0;
  /** 读写命令：下一个扇区（LBA）、还剩的扇区数、每块的扇区数、本块的扇区数 */
  private lba = 0;
  private left = 0;
  private block = 1;
  private blockLen = 0;
  private writing = false;
  /** 光盘映像的扇区还没读出来：读到以后再做 */
  private waiting: (() => void) | null = null;

  private host: IdeHost;
  constructor(host: IdeHost) {
    this.host = host;
    this.reset();
  }

  /** 开机、软件复位：寄存器里放 ATA 硬盘的签名，诊断通过 */
  reset(): void {
    this.phase = 'idle';
    this.waiting = null;
    this.sectorCount = 1; this.sector = 1; this.cylLow = 0; this.cylHigh = 0;
    this.device = 0xa0;
    for (const u of [0, 1]) {
      this.status[u] = DRDY | DSC;
      this.error[u] = 1;
      this.multiple[u] = 0;
      this.logical[u] = null;
    }
  }

  static owns(port: number): boolean { return (port >= 0x1f0 && port <= 0x1f7) || port === 0x3f6; }

  /** 当前选中的设备 */
  private get sel(): number { return (this.device >> 4) & 1; }

  private irq(): void { if (!(this.control & 2)) this.host.irq(); }

  /** 机器定期调用：光盘映像的数据读到了就继续 */
  poll(): void { if (this.waiting) { const f = this.waiting; this.waiting = null; f(); } }
  get pending(): boolean { return this.waiting !== null; }

  // ======================= 端口 =======================

  in8(port: number): number {
    if (port === 0x1f0) return this.in16() & 0xff;
    const u = this.sel;
    if (!this.host.disk(u)) return port === 0x1f6 ? this.device : 0; // 没有这个设备：读出 0
    switch (port) {
      case 0x1f1: return this.error[u];
      case 0x1f2: return this.sectorCount;
      case 0x1f3: return this.sector;
      case 0x1f4: return this.cylLow;
      case 0x1f5: return this.cylHigh;
      case 0x1f6: return this.device;
      case 0x1f7: return this.status[u]; // 读状态寄存器就算应答了中断（中断控制器是边沿触发）
      case 0x3f6: return this.status[u]; // 备用状态
    }
    return 0xff;
  }

  out8(port: number, v: number): void {
    switch (port) {
      case 0x1f0: this.out16(v); return;
      case 0x1f1: this.features = v; return;
      case 0x1f2: this.sectorCount = v; return;
      case 0x1f3: this.sector = v; return;
      case 0x1f4: this.cylLow = v; return;
      case 0x1f5: this.cylHigh = v; return;
      case 0x1f6: this.device = v | 0xa0; return;
      case 0x1f7: this.command(v); return;
      case 0x3f6:
        if (v & 4 && !(this.control & 4)) this.reset(); // SRST 从 0 变 1
        this.control = v;
        return;
    }
  }

  /** 数据端口读一个字 */
  in16(): number {
    if (this.phase !== 'dataIn') return 0xffff;
    const b = this.buf, p = this.pos;
    const v = b[p] | (b[p + 1] << 8);
    this.pos = p + 2;
    if (this.pos >= b.length) this.readBlockDone();
    return v;
  }

  /** 数据端口写一个字 */
  out16(v: number): void {
    if (this.phase !== 'dataOut') return;
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >> 8) & 0xff;
    if (this.pos >= this.buf.length) this.writeBlockDone();
  }

  // ======================= 命令 =======================

  private command(cmd: number): void {
    const u = this.sel, d = this.host.disk(u);
    if (!d) return; // 没有这个设备：不理会
    this.unit = u;
    this.error[u] = 0;
    this.waiting = null;
    switch (cmd) {
      case 0xec: return this.sendIdentify(d);                                 // IDENTIFY DEVICE
      case 0x20: case 0x21: return this.startRead(d, 1);                      // READ SECTORS
      case 0xc4:                                                              // READ MULTIPLE
        if (!this.multiple[u]) return this.abort();
        return this.startRead(d, this.multiple[u]);
      case 0x30: case 0x31: return this.startWrite(d, 1);                     // WRITE SECTORS
      case 0xc5:                                                              // WRITE MULTIPLE
        if (!this.multiple[u]) return this.abort();
        return this.startWrite(d, this.multiple[u]);
      case 0x40: case 0x41: {                                                 // READ VERIFY SECTORS
        const first = this.address(d);
        const n = this.sectorCount || 256;
        if (first < 0 || first + n > d.sectorCount) return this.notFound();
        this.setAddress(d, first + n - 1);
        return this.done();
      }
      case 0xc6: {                                                            // SET MULTIPLE MODE
        const n = this.sectorCount;
        if (n === 0 || n > MAX_MULTIPLE || (n & (n - 1))) return this.abort();
        this.multiple[u] = n;
        return this.done();
      }
      case 0x91: {                                                            // INITIALIZE DEVICE PARAMETERS
        this.logical[u] = [(this.device & 0x0f) + 1, this.sectorCount];
        return this.done();
      }
      case 0x90: {                                                            // EXECUTE DEVICE DIAGNOSTIC
        this.reset();
        this.irq();
        return;
      }
      case 0xe5: this.sectorCount = 0xff; return this.done();                 // CHECK POWER MODE：在转
      case 0xef: case 0xe0: case 0xe1: case 0xe2: case 0xe3: case 0xe6: case 0xe7: case 0xea: // 设置特性、电源管理、刷新缓存
        return this.done();
    }
    if ((cmd & 0xf0) === 0x10 || (cmd & 0xf0) === 0x70) {                     // RECALIBRATE、SEEK
      if ((cmd & 0xf0) === 0x70 && this.address(d) < 0) return this.notFound();
      return this.done();
    }
    this.abort(); // 包括 IDENTIFY PACKET DEVICE（A1h）、PACKET、DMA 读写：硬盘不支持
  }

  /** CHS 方式换算用的磁头数、每道扇区数 */
  private geom(d: Disk): [number, number] { return this.logical[this.unit] ?? [d.geo.heads, d.geo.sectors]; }

  /** 任务文件寄存器里的扇区地址 → LBA；超出范围时 −1 */
  private address(d: Disk): number {
    if (this.device & 0x40) {
      const lba = ((this.device & 0x0f) << 24) | (this.cylHigh << 16) | (this.cylLow << 8) | this.sector;
      return lba < d.sectorCount ? lba : -1;
    }
    const [heads, spt] = this.geom(d);
    const c = (this.cylHigh << 8) | this.cylLow, h = this.device & 0x0f, s = this.sector;
    if (!heads || !spt || h >= heads || s < 1 || s > spt) return -1;
    const lba = (c * heads + h) * spt + s - 1;
    return lba < d.sectorCount ? lba : -1;
  }

  /** 把 LBA 写回任务文件寄存器（命令结束时寄存器指向最后处理的扇区） */
  private setAddress(d: Disk, lba: number): void {
    if (this.device & 0x40) {
      this.sector = lba & 0xff; this.cylLow = (lba >> 8) & 0xff; this.cylHigh = (lba >> 16) & 0xff;
      this.device = (this.device & 0xf0) | ((lba >> 24) & 0x0f);
      return;
    }
    const [heads, spt] = this.geom(d);
    if (!heads || !spt) return;
    const s = lba % spt + 1, t = Math.floor(lba / spt), h = t % heads, c = Math.floor(t / heads);
    this.sector = s; this.cylLow = c & 0xff; this.cylHigh = (c >> 8) & 0xff;
    this.device = (this.device & 0xf0) | h;
  }

  private done(): void {
    this.phase = 'idle';
    this.status[this.unit] = DRDY | DSC;
    this.irq();
  }

  private abort(): void {
    this.phase = 'idle';
    this.error[this.unit] = ABRT;
    this.status[this.unit] = DRDY | DSC | ERR;
    this.irq();
  }

  private notFound(): void {
    this.phase = 'idle';
    this.error[this.unit] = IDNF;
    this.status[this.unit] = DRDY | DSC | ERR;
    this.irq();
  }

  // ---- IDENTIFY ----

  private sendIdentify(d: Disk): void {
    const w = new Uint16Array(256);
    const str = (from: number, words: number, s: string) => {
      const t = s.padEnd(words * 2, ' ');
      for (let k = 0; k < words; k++) w[from + k] = (t.charCodeAt(k * 2) << 8) | t.charCodeAt(k * 2 + 1);
    };
    const g = d.geo, total = d.sectorCount;
    const [lh, ls] = this.geom(d);
    w[0] = 0x0040;                                  // 固定硬盘
    w[1] = g.cylinders; w[3] = g.heads; w[6] = g.sectors;
    str(10, 10, `ASM86HD000${this.unit}`);          // 序列号
    str(23, 4, '1.0');                              // 固件版本
    str(27, 20, `ASMPERFECT VIRTUAL HARD DISK ${this.unit ? 'D' : 'C'}`);
    w[47] = 0x8000 | MAX_MULTIPLE;                  // READ/WRITE MULTIPLE 每块最多 16 扇区
    w[49] = 0x0200;                                 // 支持 LBA（不支持 DMA）
    w[51] = 0x0200;                                 // PIO 时序方式 2
    w[53] = 0x0003;                                 // 字 54~58、64~70 有效
    if (lh && ls) {
      const cyl = Math.min(65535, Math.floor(total / (lh * ls)));
      w[54] = cyl; w[55] = lh; w[56] = ls;
      const cap = cyl * lh * ls;
      w[57] = cap & 0xffff; w[58] = cap >>> 16;
    }
    w[59] = this.multiple[this.unit] ? 0x100 | this.multiple[this.unit] : 0;
    w[60] = total & 0xffff; w[61] = total >>> 16;   // LBA 方式的扇区总数
    w[64] = 0x0003;                                 // PIO 方式 3、4
    w[65] = 120; w[66] = 120; w[67] = 120; w[68] = 120;
    w[80] = 0x001e;                                 // ATA-1~4
    w[82] = 0x4000; w[83] = 0x4000; w[84] = 0x4000; w[85] = 0x4000; w[86] = 0x4000; w[87] = 0x4000;
    const out = new Uint8Array(512);
    for (let k = 0; k < 256; k++) { out[k * 2] = w[k] & 0xff; out[k * 2 + 1] = w[k] >> 8; }
    this.buf = out; this.pos = 0;
    this.left = 0; this.writing = false;
    this.phase = 'dataIn';
    this.status[this.unit] = DRDY | DSC | DRQ;
    this.irq();
  }

  // ---- 读 ----

  private startRead(d: Disk, block: number): void {
    const first = this.address(d);
    const n = this.sectorCount || 256;
    if (first < 0) return this.notFound();
    this.lba = first; this.left = n; this.block = block; this.writing = false;
    this.nextReadBlock(d);
  }

  /** 准备下一块（最多 block 个扇区）的数据，置 DRQ、发中断 */
  private nextReadBlock(d: Disk): void {
    const count = Math.min(this.block, this.left);
    if (this.lba + count > d.sectorCount) {
      // 读到盘的末尾之外：先把能读的读完，再报错（简化：直接报错）
      this.setAddress(d, Math.min(this.lba, d.sectorCount - 1));
      return this.notFound();
    }
    const buf = new Uint8Array(count * 512);
    for (let k = 0; k < count; k++) {
      const s = d.readSector(this.lba + k);
      if (!s) {
        // 光盘映像的这一段还没从文件里读出来：报告忙，读到后再继续
        this.phase = 'idle';
        this.status[this.unit] = BSY;
        this.waiting = () => this.nextReadBlock(d);
        return;
      }
      buf.set(s, k * 512);
    }
    this.buf = buf; this.pos = 0; this.blockLen = count;
    this.setAddress(d, this.lba + count - 1);
    this.phase = 'dataIn';
    this.status[this.unit] = DRDY | DSC | DRQ;
    this.irq();
  }

  private readBlockDone(): void {
    if (this.writing || this.left === 0) { // IDENTIFY
      this.phase = 'idle';
      this.status[this.unit] = DRDY | DSC;
      return;
    }
    this.lba += this.blockLen; this.left -= this.blockLen;
    const d = this.host.disk(this.unit);
    if (this.left > 0 && d) { this.nextReadBlock(d); return; }
    this.phase = 'idle';
    this.status[this.unit] = DRDY | DSC; // 最后一块读完：不再发中断
  }

  // ---- 写 ----

  private startWrite(d: Disk, block: number): void {
    const first = this.address(d);
    const n = this.sectorCount || 256;
    if (first < 0) return this.notFound();
    if (d.readOnly) return this.abort();
    this.lba = first; this.left = n; this.block = block; this.writing = true;
    this.expectBlock();
    // 第一块数据不发中断：主机看到 DRQ 就写
  }

  private expectBlock(): void {
    const count = Math.min(this.block, this.left);
    this.buf = new Uint8Array(count * 512); this.pos = 0; this.blockLen = count;
    this.phase = 'dataOut';
    this.status[this.unit] = DRDY | DSC | DRQ;
  }

  private writeBlockDone(): void {
    const d = this.host.disk(this.unit);
    if (!d) return;
    if (this.lba + this.blockLen > d.sectorCount) { this.setAddress(d, Math.min(this.lba, d.sectorCount - 1)); return this.notFound(); }
    for (let k = 0; k < this.blockLen; k++) d.writeSector(this.lba + k, this.buf.subarray(k * 512, k * 512 + 512));
    this.host.written(this.unit);
    this.setAddress(d, this.lba + this.blockLen - 1);
    this.lba += this.blockLen; this.left -= this.blockLen;
    if (this.left > 0) { this.expectBlock(); this.irq(); return; }
    this.done();
  }
}
