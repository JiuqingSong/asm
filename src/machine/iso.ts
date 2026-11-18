// 把光盘映像（ISO9660）变成一块只读的 FAT16 硬盘
//
// DOS 不认识光盘的 ISO9660 文件系统，要读光盘本来得装光驱驱动和 MSCDEX。这里换一种做法：
// 读出 ISO 里的目录和文件，现场"合成"一块硬盘——分区表、FAT16 引导扇区、FAT 表、目录都由这里生成，
// 文件内容不复制，DOS 读到哪个扇区，就从 ISO 里对应的位置取。
// 浏览器里 ISO 是一个 File（不读进内存）：装入时只读卷描述符和目录，文件内容在 DOS 读到时才按块读出来（见 BlobSource）。这块盘装在第二个硬盘位置时，DOS 开机后它就是 D:。
//
// 布局（以 512 字节扇区计）：0 号扇区是分区表，分区从 63 号扇区开始：
//   [引导扇区][FAT 1][FAT 2][根目录][数据区：每个子目录、每个文件各占一段连续的簇]
import { shortName } from './fat.ts';
import type { Geometry } from './disk.ts';

/** ISO 文件的内容：可能还没读出来（浏览器里读文件是异步的） */
export interface IsoSource {
  readonly size: number;
  /** 已经读出来的话返回内容，否则返回 null 并开始读 */
  get(offset: number, length: number): Uint8Array | null;
  /** 等某一段读出来 */
  load(offset: number, length: number): Promise<void>;
}

/** 整个映像已经在内存里（测试、命令行工具） */
export class BytesSource implements IsoSource {
  private bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  get size(): number { return this.bytes.length; }
  get(offset: number, length: number): Uint8Array { return this.bytes.subarray(offset, offset + length); }
  async load(): Promise<void> { /* 已经在内存里 */ }
}

/** 浏览器里的 File/Blob：按 64KB 一块读，最多缓存 32MB（最近用过的留下） */
export class BlobSource implements IsoSource {
  private static readonly CHUNK = 64 * 1024;
  private static readonly KEEP = 512;
  private chunks = new Map<number, Uint8Array>();
  private pending = new Map<number, Promise<void>>();
  readonly blob: Blob;
  constructor(blob: Blob) { this.blob = blob; }
  get size(): number { return this.blob.size; }

  private chunk(i: number): Promise<void> {
    if (this.chunks.has(i)) return Promise.resolve();
    let p = this.pending.get(i);
    if (!p) {
      const C = BlobSource.CHUNK;
      p = this.blob.slice(i * C, (i + 1) * C).arrayBuffer().then(b => {
        this.chunks.set(i, new Uint8Array(b));
        this.pending.delete(i);
        while (this.chunks.size > BlobSource.KEEP) this.chunks.delete(this.chunks.keys().next().value!);
      }, () => { this.pending.delete(i); });
      this.pending.set(i, p);
    }
    return p;
  }

  get(offset: number, length: number): Uint8Array | null {
    const C = BlobSource.CHUNK, first = Math.floor(offset / C), last = Math.floor((offset + length - 1) / C);
    let missing = false;
    for (let i = first; i <= last; i++) if (!this.chunks.has(i)) { missing = true; this.chunk(i); }
    if (missing) {
      for (let i = last + 1; i <= last + 4 && i * C < this.size; i++) this.chunk(i); // 顺序读文件时预先读后面几块
      return null;
    }
    // 最近用过：挪到 Map 的末尾
    for (let i = first; i <= last; i++) { const c = this.chunks.get(i)!; this.chunks.delete(i); this.chunks.set(i, c); }
    if (first === last) return this.chunks.get(first)!.subarray(offset - first * C, offset - first * C + length);
    const out = new Uint8Array(length);
    for (let i = first; i <= last; i++) {
      const c = this.chunks.get(i)!, base = i * C;
      const a = Math.max(offset, base), b = Math.min(offset + length, base + c.length);
      if (b > a) out.set(c.subarray(a - base, b - base), a - offset);
    }
    return out;
  }

  async load(offset: number, length: number): Promise<void> {
    const C = BlobSource.CHUNK;
    const jobs: Promise<void>[] = [];
    for (let i = Math.floor(offset / C); i <= Math.floor((offset + length - 1) / C); i++) jobs.push(this.chunk(i));
    await Promise.all(jobs);
  }
}

interface IsoEntry {
  name: string;
  isDir: boolean;
  lba: number;      // ISO 的逻辑块号（2048 字节）
  size: number;
  date: Date;
  children: IsoEntry[];
}

/** 判断 16 号块（32768 字节处）是不是 ISO9660 的卷描述符（标志 "CD001"） */
export function isIsoHeader(pvd: Uint8Array): boolean {
  return pvd.length >= 6 && pvd[0] === 1 && String.fromCharCode(...pvd.subarray(1, 6)) === 'CD001';
}

/** 浏览器里的文件是不是 ISO 光盘映像 */
export async function isIsoFile(f: Blob): Promise<boolean> {
  if (f.size < 17 * 2048) return false;
  return isIsoHeader(new Uint8Array(await f.slice(16 * 2048, 16 * 2048 + 6).arrayBuffer()));
}

function isoDate(b: Uint8Array, o: number): Date {
  return new Date(1900 + b[o], Math.max(0, b[o + 1] - 1), b[o + 2] || 1, b[o + 3], b[o + 4], b[o + 5]);
}

/** 读 ISO 的目录树（只读卷描述符和目录，不读文件内容） */
async function readTree(src: IsoSource): Promise<{ root: IsoEntry; label: string }> {
  const read = async (o: number, n: number) => { await src.load(o, n); return src.get(o, n)!; };
  const pvdBytes = await read(16 * 2048, 2048);
  if (!isIsoHeader(pvdBytes)) throw new Error('不是 ISO9660 光盘映像（32768 字节处没有 CD001 标志）');
  const block = pvdBytes[128] | (pvdBytes[129] << 8) || 2048;
  const label = String.fromCharCode(...pvdBytes.subarray(40, 72)).trim();
  let iso = pvdBytes;
  const rec = (o: number): IsoEntry => {
    const lba = iso[o + 2] | (iso[o + 3] << 8) | (iso[o + 4] << 16) | (iso[o + 5] << 24);
    const size = (iso[o + 10] | (iso[o + 11] << 8) | (iso[o + 12] << 16) | (iso[o + 13] << 24)) >>> 0;
    const isDir = (iso[o + 25] & 2) !== 0;
    const nlen = iso[o + 32];
    let name = String.fromCharCode(...iso.subarray(o + 33, o + 33 + nlen));
    name = name.replace(/;\d+$/, '').replace(/\.$/, '');
    return { name, isDir, lba: lba >>> 0, size, date: isoDate(iso, o + 18), children: [] };
  };
  const root = rec(156);
  root.name = '';
  const seen = new Set<number>();
  const walk = async (dir: IsoEntry, depth: number) => {
    if (depth > 32 || seen.has(dir.lba)) return;
    seen.add(dir.lba);
    if (dir.lba * block + dir.size > src.size) return;
    iso = await read(dir.lba * block, dir.size); // 这个目录的全部记录
    const start = 0, end = dir.size;
    let o = start;
    while (o < end && o + 33 <= iso.length) {
      const len = iso[o];
      if (len === 0) { o = (Math.floor((o - start) / block) + 1) * block + start; continue; } // 记录不跨块：跳到下一块
      const nlen = iso[o + 32];
      const special = nlen === 1 && (iso[o + 33] === 0 || iso[o + 33] === 1); // "." 和 ".."
      if (!special) {
        const e = rec(o);
        if (block !== 2048) e.lba = (e.lba * block) / 2048;
        dir.children.push(e);
      }
      o += len;
    }
    for (const c of dir.children) if (c.isDir) await walk(c, depth + 1);
  };
  await walk(root, 0);
  return { root, label };
}

/** 一段连续的簇：一个子目录（内容已经生成）或者一个文件（内容在 ISO 里） */
interface Extent { start: number; count: number; dir: Uint8Array | null; isoOffset: number; size: number }

export class IsoDisk {
  readonly sectorCount: number;
  readonly geo: Geometry;
  readonly description: string;
  private iso: IsoSource;
  private spc: number;            // 每簇扇区数
  private fatSectors: number;
  private rootEntries: number;
  private clusters: number;
  private usedEnd = 2;            // 用到的最后一个簇 + 1；后面凑数的簇标成坏簇（光盘没有剩余空间）
  private extents: Extent[] = [];
  private rootDir: Uint8Array;
  private bootSector = new Uint8Array(512);
  private mbr = new Uint8Array(512);
  private readonly PART = 63;     // 分区的起始扇区
  private fatStart: number;
  private rootStart: number;
  private dataStart: number;
  private partSectors: number;

  /** 打开光盘映像（读出目录树）；超过 FAT16 能放下的大小时出错 */
  static async open(src: IsoSource, name: string): Promise<IsoDisk> {
    return new IsoDisk(src, name, await readTree(src));
  }

  private constructor(iso: IsoSource, name: string, { root, label }: { root: IsoEntry; label: string }) {
    this.iso = iso;
    // 簇的大小：数据要能放进 FAT16 最多 65524 个簇
    const files: IsoEntry[] = [], dirs: IsoEntry[] = [];
    const collect = (d: IsoEntry) => { for (const c of d.children) { if (c.isDir) { dirs.push(c); collect(c); } else files.push(c); } };
    collect(root);
    let spc = 4;
    for (;;) {
      const cb = spc * 512;
      let n = 0;
      for (const f of files) n += Math.ceil(f.size / cb);
      for (const d of dirs) n += Math.max(1, Math.ceil(((d.children.length + 2) * 32) / cb));
      if (n <= 65000) { this.clusters = Math.max(n, 4100); break; } // 少于 4085 个簇会被当成 FAT12
      if (spc >= 64) throw new Error(`${name} 太大了：FAT16 最大 2GB，这张光盘的内容放不下`);
      spc *= 2;
    }
    this.spc = spc;
    const cb = spc * 512;
    // 分配簇：按目录树的顺序，每个子目录、每个文件一段连续的簇
    let next = 2;
    const clusterOf = new Map<IsoEntry, number>();
    const assign = (d: IsoEntry) => {
      for (const c of d.children) {
        const count = c.isDir ? Math.max(1, Math.ceil(((c.children.length + 2) * 32) / cb)) : Math.ceil(c.size / cb);
        if (count === 0) { clusterOf.set(c, 0); continue; }
        clusterOf.set(c, next);
        this.extents.push({ start: next, count, dir: null, isoOffset: c.lba * 2048, size: c.size });
        next += count;
      }
      for (const c of d.children) if (c.isDir) assign(c);
    };
    assign(root);
    this.usedEnd = next;
    // 目录项
    const dosDate = (t: Date) => {
      const y = Math.max(0, Math.min(127, t.getFullYear() - 1980));
      return { time: (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1), date: (y << 9) | ((t.getMonth() + 1) << 5) | t.getDate() };
    };
    const entry = (buf: Uint8Array, o: number, raw11: string, attr: number, cluster: number, size: number, t: Date) => {
      for (let k = 0; k < 11; k++) buf[o + k] = raw11.charCodeAt(k) & 0xff;
      buf[o + 11] = attr;
      const { time, date } = dosDate(t);
      buf[o + 22] = time & 0xff; buf[o + 23] = time >> 8; buf[o + 24] = date & 0xff; buf[o + 25] = date >> 8;
      buf[o + 26] = cluster & 0xff; buf[o + 27] = cluster >> 8;
      buf[o + 28] = size & 0xff; buf[o + 29] = (size >> 8) & 0xff; buf[o + 30] = (size >> 16) & 0xff; buf[o + 31] = (size >>> 24) & 0xff;
    };
    const raw = (n: string) => {
      const dot = n.lastIndexOf('.');
      const b = dot > 0 ? n.slice(0, dot) : n, e = dot > 0 ? n.slice(dot + 1) : '';
      return b.padEnd(8, ' ') + e.padEnd(3, ' ');
    };
    const fill = (d: IsoEntry, buf: Uint8Array, self: number, parent: number, isRoot: boolean) => {
      let o = 0;
      if (isRoot) { entry(buf, 0, (label || 'CDROM').toUpperCase().replace(/[^A-Z0-9 _-]/g, '_').padEnd(11, ' ').slice(0, 11), 0x08, 0, 0, d.date); o = 32; }
      else {
        entry(buf, 0, '.          ', 0x10, self, 0, d.date);
        entry(buf, 32, '..         ', 0x10, parent, 0, d.date);
        o = 64;
      }
      const used: string[] = [];
      for (const c of d.children) {
        if (o + 32 > buf.length) break;
        const n = shortName(c.name || 'NONAME', used);
        used.push(n);
        entry(buf, o, raw(n), c.isDir ? 0x11 : 0x21, clusterOf.get(c) ?? 0, c.isDir ? 0 : c.size, c.date);
        o += 32;
      }
    };
    this.rootEntries = Math.max(512, Math.ceil((root.children.length + 1) / 16) * 16);
    this.rootDir = new Uint8Array(this.rootEntries * 32);
    fill(root, this.rootDir, 0, 0, true);
    const fillDirs = (d: IsoEntry, self: number) => {
      for (const c of d.children) {
        if (!c.isDir) continue;
        const cl = clusterOf.get(c)!;
        const ext = this.extents.find(x => x.start === cl)!;
        ext.dir = new Uint8Array(ext.count * cb);
        fill(c, ext.dir, cl, self, false);
        fillDirs(c, cl);
      }
    };
    fillDirs(root, 0);
    // 分区内的布局
    this.fatSectors = Math.ceil(((this.clusters + 2) * 2) / 512);
    this.fatStart = 1;
    this.rootStart = this.fatStart + this.fatSectors * 2;
    this.dataStart = this.rootStart + (this.rootEntries * 32) / 512;
    this.partSectors = this.dataStart + this.clusters * spc;
    // 几何参数：255 个磁头、每道 63 扇区（避开 504MB 的限制，最大约 8GB）
    const heads = 255, sectors = 63;
    const cylinders = Math.min(1024, Math.ceil((this.PART + this.partSectors) / (heads * sectors)));
    this.geo = { cylinders, heads, sectors };
    this.sectorCount = cylinders * heads * sectors;
    this.makeMbr();
    this.makeBootSector(label);
    const mb = Math.round(iso.size / 1024 / 1024);
    this.description = `光盘映像 ${mb}MB，卷标 ${label || '（无）'}，只读`;
  }

  private chs(lba: number): [number, number, number] {
    const { heads, sectors } = this.geo;
    const c = Math.min(1023, Math.floor(lba / (heads * sectors)));
    const h = Math.floor(lba / sectors) % heads, s = (lba % sectors) + 1;
    return [h, s | ((c >> 2) & 0xc0), c & 0xff];
  }

  private makeMbr(): void {
    const m = this.mbr, e = 0x1be;
    m.set([0xcd, 0x18], 0); // 不能从这块盘启动：INT 18h
    m[e] = 0x00;
    m.set(this.chs(this.PART), e + 1);
    m[e + 4] = this.partSectors < 65536 ? 0x04 : 0x06; // FAT16 小于 32MB / 大于 32MB
    m.set(this.chs(this.PART + this.partSectors - 1), e + 5);
    const w32 = (o: number, v: number) => { m[o] = v & 0xff; m[o + 1] = (v >> 8) & 0xff; m[o + 2] = (v >> 16) & 0xff; m[o + 3] = (v >>> 24) & 0xff; };
    w32(e + 8, this.PART);
    w32(e + 12, this.partSectors);
    m[510] = 0x55; m[511] = 0xaa;
  }

  private makeBootSector(label: string): void {
    const b = this.bootSector;
    const w = (o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
    const w32 = (o: number, v: number) => { w(o, v & 0xffff); w(o + 2, v >>> 16); };
    b.set([0xeb, 0x3c, 0x90], 0);
    b.set(Array.from('ASM86ISO', c => c.charCodeAt(0)), 3);
    w(0x0b, 512); b[0x0d] = this.spc; w(0x0e, 1); b[0x10] = 2; w(0x11, this.rootEntries);
    w(0x13, this.partSectors < 65536 ? this.partSectors : 0);
    b[0x15] = 0xf8; w(0x16, this.fatSectors); w(0x18, this.geo.sectors); w(0x1a, this.geo.heads);
    w32(0x1c, this.PART); w32(0x20, this.partSectors < 65536 ? 0 : this.partSectors);
    b[0x24] = 0x81; b[0x26] = 0x29; w32(0x27, 0x1509_1997);
    b.set(Array.from((label || 'CDROM').toUpperCase().padEnd(11, ' ').slice(0, 11), c => c.charCodeAt(0) & 0xff), 0x2b);
    b.set(Array.from('FAT16   ', c => c.charCodeAt(0)), 0x36);
    b.set([0xcd, 0x18], 0x3e);
    b[510] = 0x55; b[511] = 0xaa;
  }

  /** 簇号 c 在 FAT 里的值 */
  private fatEntry(c: number): number {
    if (c === 0) return 0xfff8;
    if (c === 1) return 0xffff;
    const x = this.findExtent(c);
    if (!x) return c >= this.usedEnd && c < this.clusters + 2 ? 0xfff7 : 0;
    return c < x.start + x.count - 1 ? c + 1 : 0xffff;
  }

  private findExtent(c: number): Extent | null {
    const xs = this.extents;
    let lo = 0, hi = xs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, x = xs[mid];
      if (c < x.start) hi = mid - 1;
      else if (c >= x.start + x.count) lo = mid + 1;
      else return x;
    }
    return null;
  }

  /** 读一个扇区；文件内容还没从 ISO 读出来时返回 null（已经开始读，稍后再试） */
  readSector(lba: number): Uint8Array | null {
    if (lba === 0) return this.mbr;
    const out = new Uint8Array(512);
    const s = lba - this.PART;
    if (s < 0 || s >= this.partSectors) return out;
    if (s === 0) return this.bootSector;
    if (s < this.rootStart) {
      const fs = (s - this.fatStart) % this.fatSectors; // 两份 FAT 内容一样
      for (let k = 0; k < 256; k++) {
        const v = this.fatEntry(fs * 256 + k);
        out[k * 2] = v & 0xff; out[k * 2 + 1] = v >> 8;
      }
      return out;
    }
    if (s < this.dataStart) return this.rootDir.subarray((s - this.rootStart) * 512, (s - this.rootStart + 1) * 512);
    const d = s - this.dataStart;
    const c = 2 + Math.floor(d / this.spc);
    const x = this.findExtent(c);
    if (!x) return out;
    const off = ((c - x.start) * this.spc + (d % this.spc)) * 512;
    if (x.dir) return x.dir.subarray(off, off + 512);
    if (off < x.size) {
      const a = x.isoOffset + off;
      const n = Math.min(512, x.size - off, this.iso.size - a);
      if (n <= 0) return out;
      const bytes = this.iso.get(a, n);
      if (!bytes) return null;
      out.set(bytes);
    }
    return out;
  }
}
