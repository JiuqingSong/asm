// IDE 第二通道上的 ATAPI 光驱（端口 170h~177h、376h，IRQ15）
//
// 和真的光驱一样：主机先写 ATA 命令（A0h = 发送命令包），再从数据端口写 12 字节的 SCSI/MMC 命令包，
// 光驱准备好数据后置 DRQ、发中断，主机从数据端口按 16 位读走。DOS 下用 OAKCDROM.SYS 这样的通用 ATAPI 驱动
// 加 MSCDEX，Windows 95 用自带的 IDE/光驱驱动，都不需要知道这是模拟出来的。
//
// 光盘就是 ISO 文件：第 n 个 2048 字节的扇区在文件的 n × 2048 处，按需从文件里读（见 iso.ts 的 IsoSource）。
// 数据还没读出来时光驱报告"忙"（BSY），读到以后再置 DRQ、发中断。
import type { IsoSource } from './iso.ts';

/** 状态寄存器的位 */
const BSY = 0x80, DRDY = 0x40, DSC = 0x10, DRQ = 0x08, ERR = 0x01;

/** SCSI 感知码：没有错误 / 没有光盘 / 换过光盘 / 无效命令 / 无效参数 / 地址超出范围 */
const SENSE = {
  none: [0, 0, 0],
  noMedium: [2, 0x3a, 0],
  changed: [6, 0x28, 0],
  badCommand: [5, 0x20, 0],
  badField: [5, 0x24, 0],
  outOfRange: [5, 0x21, 0],
};

type Phase = 'idle' | 'packet' | 'dataIn' | 'busy';

export class AtapiCdrom {
  /** 光盘：ISO 文件和名字（没有光盘时为 null） */
  private disc: { src: IsoSource; name: string; sectors: number } | null = null;
  /** 换过光盘：下一次 TEST UNIT READY 等命令报告"换过盘" */
  private mediaChanged = false;
  // ---- 寄存器 ----
  private features = 0;
  private sectorCount = 0;   // ATAPI 里是"中断原因"：位 0 C/D，位 1 I/O
  private lbaLow = 0;
  private lbaMid = 0;        // ATAPI 里是一次传送的字节数（低字节）
  private lbaHigh = 0;       // 字节数（高字节）
  private device = 0xa0;     // 位 4 = 选从盘
  private status = 0;
  private error = 0;
  private control = 0;       // 设备控制：位 1 nIEN（不发中断），位 2 SRST（软件复位）
  // ---- 命令执行 ----
  private phase: Phase = 'idle';
  private packet = new Uint8Array(12);
  private packetPos = 0;
  /** 要读给主机的数据（当前这一块）、读到哪里 */
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  /** READ 命令还没送出的部分：下一个扇区、剩下的扇区数 */
  private readLba = 0;
  private readLeft = 0;
  /** 主机允许的每块最大字节数（发命令时 LBA mid/high 给出） */
  private byteLimit = 0;
  private sense = SENSE.none;
  /** 当前的数据传送属于命令包（传完要发"完成"中断）；IDENTIFY 这样的 ATA 命令传完就结束 */
  private packetCmd = false;
  /** 等着从文件里读数据：读到以后调用 */
  private waiting = false;
  private loading = false;

  /** 发中断（IRQ15）；构造时由机器给出 */
  private raiseIrq: () => void;
  /** 光驱的状态变化（放入、取出光盘），界面据此刷新 */
  onChange: (() => void) | null = null;

  /** 撤销中断请求（读状态寄存器、写命令时） */
  private lowerIrq: () => void;

  constructor(raiseIrq: () => void, lowerIrq: () => void = () => {}) {
    this.raiseIrq = raiseIrq;
    this.lowerIrq = lowerIrq;
    this.reset();
  }

  /** 放入光盘 */
  insert(src: IsoSource, name: string): void {
    this.disc = { src, name, sectors: Math.floor(src.size / 2048) };
    this.mediaChanged = true;
    this.onChange?.();
  }

  /** 取出光盘 */
  eject(): void {
    this.disc = null;
    this.mediaChanged = true;
    this.onChange?.();
  }

  get discName(): string | null { return this.disc?.name ?? null; }
  /** 光盘映像（从光盘启动时读启动目录用） */
  get source(): IsoSource | null { return this.disc?.src ?? null; }
  get discSize(): number { return this.disc?.src.size ?? 0; }

  /** 开机、软件复位：寄存器里放 ATAPI 的签名（主机据此认出这是光驱而不是硬盘） */
  reset(): void {
    this.phase = 'idle';
    this.error = 1;
    this.sectorCount = 1; this.lbaLow = 1; this.lbaMid = 0x14; this.lbaHigh = 0xeb;
    this.device &= 0x10;
    this.status = 0;
    this.waiting = false;
    this.loading = false;
  }

  /** 选中的是从盘（这个通道上只有主盘） */
  private get slave(): boolean { return (this.device & 0x10) !== 0; }

  private irq(): void {
    if (!(this.control & 2)) this.raiseIrq();
  }

  // ======================= 端口 =======================

  /** 端口是不是这个通道的（170h~177h、376h） */
  static owns(port: number): boolean { return (port >= 0x170 && port <= 0x177) || port === 0x376; }

  in8(port: number): number {
    if (port === 0x170) return this.in16() & 0xff;
    if (this.slave && port !== 0x176) return 0; // 这个通道上没有从盘
    switch (port) {
      case 0x171: return this.error;
      case 0x172: return this.sectorCount;
      case 0x173: return this.lbaLow;
      case 0x174: return this.lbaMid;
      case 0x175: return this.lbaHigh;
      case 0x176: return this.device;
      case 0x177: this.lowerIrq(); return this.status; // 读状态寄存器：撤销中断请求（还没被响应的请求随之消失）
      case 0x376: return this.status;   // 备用状态：不影响中断
    }
    return 0xff;
  }

  out8(port: number, v: number): void {
    switch (port) {
      case 0x170: this.out16(v); return;
      case 0x171: this.features = v; return;
      case 0x172: this.sectorCount = v; return;
      case 0x173: this.lbaLow = v; return;
      case 0x174: this.lbaMid = v; return;
      case 0x175: this.lbaHigh = v; return;
      case 0x176: this.device = v | 0xa0; return;
      case 0x177: if (!this.slave) this.command(v); return;
      case 0x376:
        if (v & 4 && !(this.control & 4)) this.reset(); // SRST 从 0 变 1
        this.control = v;
        return;
    }
  }

  /** 数据端口读一个字 */
  in16(): number {
    if (this.slave || this.phase !== 'dataIn') return 0xffff;
    const b = this.buf, p = this.pos;
    const v = b[p] | (b[p + 1] << 8);
    this.pos = p + 2;
    if (this.pos >= b.length) this.blockDone();
    return v;
  }

  /** 数据端口写一个字（命令包） */
  out16(v: number): void {
    if (this.slave || this.phase !== 'packet') return;
    this.packet[this.packetPos++] = v & 0xff;
    this.packet[this.packetPos++] = (v >> 8) & 0xff;
    if (this.packetPos >= 12) this.runPacket();
  }

  // ======================= ATA 命令 =======================

  private command(cmd: number): void {
    this.lowerIrq();
    this.error = 0;
    switch (cmd) {
      case 0xa0: // PACKET：等 12 字节的命令包
        this.byteLimit = (this.lbaMid | (this.lbaHigh << 8)) || 0xfffe;
        this.phase = 'packet'; this.packetPos = 0;
        this.sectorCount = 1;               // C/D = 1：要的是命令
        this.status = DRDY | DRQ;
        return;
      case 0xa1: { // IDENTIFY PACKET DEVICE
        this.packetCmd = false;
        this.readLeft = 0;
        this.sendData(this.identify());
        this.sectorCount = 2;
        return;
      }
      case 0x08: // DEVICE RESET
        this.reset();
        return;
      case 0xec: // IDENTIFY DEVICE：光驱不支持，中止并在寄存器里给出 ATAPI 签名
        this.reset();
        this.abort();
        return;
      case 0xef: case 0xe0: case 0xe1: case 0xe5: case 0xe7: case 0x91: // 设置特性、电源管理、刷新缓存、设置参数：直接完成
        this.status = DRDY | DSC;
        this.irq();
        return;
      default:
        this.abort();
    }
  }

  private abort(): void {
    this.phase = 'idle';
    this.error = 0x04; // ABRT
    this.status = DRDY | ERR;
    this.irq();
  }

  /** IDENTIFY PACKET DEVICE 的 512 字节 */
  private identify(): Uint8Array {
    const w = new Uint16Array(256);
    const str = (from: number, words: number, s: string) => {
      const t = s.padEnd(words * 2, ' ');
      for (let k = 0; k < words; k++) w[from + k] = (t.charCodeAt(k * 2) << 8) | t.charCodeAt(k * 2 + 1);
    };
    w[0] = 0x85c0;                // ATAPI、光驱（类型 5）、可移动、12 字节命令包
    str(10, 10, 'ASM86CD0001');   // 序列号
    str(23, 4, '1.0');            // 固件版本
    str(27, 20, 'ASMPERFECT VIRTUAL CD-ROM');
    w[49] = 0x0200;               // 支持 LBA
    w[53] = 0x0002;               // 字 64~70 有效
    w[63] = 0x0000;
    w[64] = 0x0003;               // PIO 模式 3、4
    w[65] = 120; w[66] = 120; w[67] = 120; w[68] = 120;
    w[80] = 0x001e;               // ATA/ATAPI-1~4
    w[82] = 0x4010;               // 支持 PACKET 命令集、设备复位
    w[85] = 0x4010;
    const out = new Uint8Array(512);
    for (let k = 0; k < 256; k++) { out[k * 2] = w[k] & 0xff; out[k * 2 + 1] = w[k] >> 8; }
    return out;
  }

  // ======================= 命令包（SCSI/MMC） =======================

  private runPacket(): void {
    const p = this.packet, op = p[0];
    this.packetCmd = true;
    this.status = BSY;
    const be16 = (o: number) => (p[o] << 8) | p[o + 1];
    const be32 = (o: number) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
    // 换过光盘、没有光盘：多数命令报告"检查条件"（INQUIRY、REQUEST SENSE 除外）
    if (op !== 0x12 && op !== 0x03 && op !== 0x46 && op !== 0x4a) {
      if (this.mediaChanged && this.disc) { this.mediaChanged = false; return this.fail(SENSE.changed); }
      if (!this.disc && ![0x1b, 0x1e, 0xbd, 0xbb].includes(op)) return this.fail(SENSE.noMedium);
    }
    switch (op) {
      case 0x00: return this.ok();                                        // TEST UNIT READY
      case 0x03: {                                                        // REQUEST SENSE
        const d = new Uint8Array(18);
        d[0] = 0x70; d[2] = this.sense[0]; d[7] = 10; d[12] = this.sense[1]; d[13] = this.sense[2];
        this.sense = SENSE.none;
        return this.reply(d, p[4]);
      }
      case 0x12: {                                                        // INQUIRY
        const d = new Uint8Array(36);
        d[0] = 0x05; d[1] = 0x80; d[2] = 0x00; d[3] = 0x21; d[4] = 31;   // 光驱、可移动、ATAPI
        const put = (o: number, s: string, n: number) => { for (let k = 0; k < n; k++) d[o + k] = (s.padEnd(n, ' ')).charCodeAt(k); };
        put(8, 'ASM86', 8); put(16, 'VIRTUAL CD-ROM', 16); put(32, '1.0', 4);
        return this.reply(d, p[4]);
      }
      case 0x1b: {                                                        // START STOP UNIT：LoEj + !Start = 弹出
        if ((p[4] & 3) === 2 && this.disc) this.eject();
        return this.ok();
      }
      case 0x1e: return this.ok();                                        // PREVENT/ALLOW MEDIUM REMOVAL
      case 0x25: {                                                        // READ CAPACITY
        const last = this.disc!.sectors - 1, d = new Uint8Array(8);
        d[0] = last >>> 24; d[1] = last >>> 16; d[2] = last >>> 8; d[3] = last; d[6] = 0x08; // 2048 字节一块
        return this.reply(d, 8);
      }
      case 0x28: case 0xa8: {                                             // READ(10) / READ(12)
        const lba = be32(2), n = op === 0x28 ? be16(7) : be32(6);
        if (n === 0) return this.ok();
        if (lba + n > this.disc!.sectors) return this.fail(SENSE.outOfRange);
        this.readLba = lba; this.readLeft = n;
        return this.nextReadBlock();
      }
      case 0x2b: return this.ok();                                        // SEEK
      case 0x43: return this.readToc(p);                                  // READ TOC
      case 0x42: {                                                        // READ SUB-CHANNEL：没有在放音乐
        const d = new Uint8Array(p[2] & 0x40 ? 16 : 4);
        d[1] = 0x15; d[3] = d.length - 4;
        if (d.length > 4) { d[4] = 1; d[5] = 0x14; d[6] = 1; d[7] = 1; }
        return this.reply(d, be16(7));
      }
      case 0x1a: case 0x5a: return this.modeSense(op === 0x5a, p[2] & 0x3f, op === 0x5a ? be16(7) : p[4]); // MODE SENSE
      case 0x15: case 0x55: return this.fail(SENSE.badCommand);           // MODE SELECT：不支持改设置
      case 0xbb: return this.ok();                                        // SET CD SPEED
      case 0xbd: {                                                        // MECHANISM STATUS
        const d = new Uint8Array(8);
        return this.reply(d, be16(8));
      }
      case 0x4a: {                                                        // GET EVENT STATUS NOTIFICATION
        const d = new Uint8Array(4);
        d[1] = 2; d[2] = 0x80; d[3] = 0x10;                               // 没有事件；支持媒体事件
        return this.reply(d, be16(7));
      }
      case 0x46: {                                                        // GET CONFIGURATION：当前配置是光驱
        const d = new Uint8Array(8);
        d[3] = 4; d[6] = 0x00; d[7] = this.disc ? 0x08 : 0;               // 当前配置文件：CD-ROM
        return this.reply(d, be16(7));
      }
    }
    return this.fail(SENSE.badCommand);
  }

  /** READ TOC：一条数据轨（轨道 1）加导出区 */
  private readToc(p: Uint8Array): void {
    const msf = (p[1] & 2) !== 0, format = p[2] & 0x0f || (p[9] >> 6), alloc = (p[7] << 8) | p[8];
    const addr = (lba: number, d: Uint8Array, o: number) => {
      if (msf) { const f = lba + 150; d[o + 1] = Math.floor(f / 4500); d[o + 2] = Math.floor(f / 75) % 60; d[o + 3] = f % 75; }
      else { d[o] = lba >>> 24; d[o + 1] = lba >>> 16; d[o + 2] = lba >>> 8; d[o + 3] = lba; }
    };
    if (format === 1) { // 会话信息：第一个会话从轨道 1 开始
      const d = new Uint8Array(12);
      d[1] = 10; d[2] = 1; d[3] = 1; d[5] = 0x14; d[6] = 1; addr(0, d, 8);
      return this.reply(d, alloc);
    }
    const d = new Uint8Array(20);
    d[1] = 18; d[2] = 1; d[3] = 1;                          // 长度、第一轨、最后一轨
    d[5] = 0x14; d[6] = 1; addr(0, d, 8);                   // 轨道 1：数据轨，从 0 开始
    d[13] = 0x14; d[14] = 0xaa; addr(this.disc!.sectors, d, 16); // 导出区
    return this.reply(d, alloc);
  }

  /** MODE SENSE：能力页（2Ah），其余页只给出头部 */
  private modeSense(ten: boolean, page: number, alloc: number): void {
    const header = ten ? 8 : 4;
    const pages: number[] = [];
    if (page === 0x2a || page === 0x3f) {
      pages.push(0x2a, 0x12, 0x01, 0x00, 0x71, 0x00, 0x29, 0x00, 0x05, 0x84, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x05, 0x84, 0x00, 0x00);
    }
    if (page === 0x0d || page === 0x3f) pages.push(0x0d, 0x06, 0, 0, 0, 0x3c, 0, 0x4b);
    const d = new Uint8Array(header + pages.length);
    d.set(pages, header);
    if (ten) { const len = d.length - 2; d[0] = len >> 8; d[1] = len & 0xff; d[2] = 0x01; }
    else { d[0] = d.length - 1; d[1] = 0x01; }
    return this.reply(d, alloc);
  }

  // ======================= 数据传送 =======================

  /** 命令完成，没有数据 */
  private ok(): void {
    this.phase = 'idle';
    this.sense = SENSE.none;
    this.sectorCount = 3;          // I/O = 1、C/D = 1：完成
    this.status = DRDY | DSC;
    this.irq();
  }

  /** 命令出错：检查条件，感知数据留给 REQUEST SENSE */
  private fail(sense: number[]): void {
    this.phase = 'idle';
    this.sense = sense;
    this.sectorCount = 3;
    this.error = (sense[0] << 4) | 0x04;
    this.status = DRDY | ERR;
    this.irq();
  }

  /** 送回一段数据（长度不超过主机给的分配长度） */
  private reply(d: Uint8Array, alloc: number): void {
    const n = Math.min(d.length, alloc || d.length);
    if (n === 0) return this.ok();
    this.readLeft = 0;
    this.sendData(d.subarray(0, n));
  }

  /** 进入数据阶段：字节数写进 LBA mid/high，置 DRQ，发中断 */
  private sendData(d: Uint8Array): void {
    this.buf = d.length & 1 ? Uint8Array.from([...d, 0]) : d;
    this.pos = 0;
    this.phase = 'dataIn';
    this.lbaMid = d.length & 0xff; this.lbaHigh = (d.length >> 8) & 0xff;
    this.sectorCount = 2;          // I/O = 1：数据送给主机
    this.status = DRDY | DSC | DRQ;
    this.irq();
  }

  /** 读走了一块：还有扇区就送下一块，否则完成 */
  private blockDone(): void {
    if (this.readLeft > 0) { this.nextReadBlock(); return; }
    if (this.packetCmd) { this.ok(); return; }
    this.phase = 'idle';
    this.status = DRDY | DSC;
  }

  /** 从光盘读下一块（不超过主机允许的字节数）；数据还没从文件里读出来时先报告忙 */
  private nextReadBlock(): void {
    const per = Math.max(1, Math.min(this.readLeft, Math.floor(this.byteLimit / 2048) || 1, 16));
    const off = this.readLba * 2048, len = per * 2048;
    const src = this.disc!.src;
    const data = src.get(off, len);
    if (!data) {
      this.phase = 'busy';
      this.status = BSY;
      const lba = this.readLba;
      this.loading = true;
      src.load(off, len).then(() => {
        if (this.phase !== 'busy' || this.readLba !== lba) return;
        this.loading = false;
        this.waiting = true;
      }, () => this.fail(SENSE.outOfRange));
      return;
    }
    this.readLba += per; this.readLeft -= per;
    this.sendData(data.length === len ? data : Uint8Array.from(data));
  }

  /** 机器定期调用：文件里的数据读到了就继续 */
  poll(): void {
    if (this.waiting) { this.waiting = false; this.nextReadBlock(); }
  }

  /** 是否在等文件里的数据（机器据此决定要不要调用 poll） */
  get pending(): boolean { return this.waiting; }

  /** Reattach an interrupted host read without delivering data or advancing VM time. */
  restoreMediaRead(): void {
    if (!this.loading || this.phase !== 'busy' || !this.disc) return;
    const per = Math.max(1, Math.min(this.readLeft, Math.floor(this.byteLimit / 2048) || 1, 16));
    const lba = this.readLba;
    this.disc.src.load(lba * 2048, per * 2048).then(() => {
      if (this.phase !== 'busy' || this.readLba !== lba) return;
      this.loading = false;
      this.waiting = true;
    });
  }
}
