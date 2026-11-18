// FAT12 / FAT16 文件系统：直接读写磁盘映像里的文件（DOS 用的文件系统）
//
// 磁盘上的布局（以分区的第一个扇区为 0）：
//   [引导扇区（含 BPB 参数）][保留扇区][FAT 表 × 2][根目录（固定大小）][数据区：按"簇"分配]
// FAT 表的每一项对应一个簇，记录文件的下一个簇；目录是 32 字节的目录项数组。
// 硬盘映像的第 0 扇区是分区表（MBR），文件系统在第一个 DOS 分区里；软盘映像整张就是一个文件系统。

export interface FatEntry {
  name: string;      // NAME.EXT
  isDir: boolean;
  size: number;
  date: Date | null;
  attr: number;
}

const SECTOR = 512;

export class FatVolume {
  private data: Uint8Array;
  private base: number;            // 分区起点（字节）
  readonly fat16: boolean;
  private bps = SECTOR;
  private spc: number;             // 每簇扇区数
  private fatStart: number;        // 扇区号（相对分区）
  private fatSectors: number;
  private fats: number;
  private rootStart: number;
  private rootEntries: number;
  private dataStart: number;
  readonly clusters: number;       // 数据区的簇数
  readonly label: string;

  private constructor(data: Uint8Array, baseSector: number) {
    this.data = data;
    this.base = baseSector * SECTOR;
    const b = this.base;
    const w = (o: number) => data[b + o] | (data[b + o + 1] << 8);
    const d = (o: number) => (w(o) | (w(o + 2) << 16)) >>> 0;
    this.bps = w(0x0b);
    this.spc = data[b + 0x0d];
    const reserved = w(0x0e);
    this.fats = data[b + 0x10];
    this.rootEntries = w(0x11);
    const total = w(0x13) || d(0x20);
    this.fatSectors = w(0x16);
    this.fatStart = reserved;
    this.rootStart = reserved + this.fats * this.fatSectors;
    this.dataStart = this.rootStart + Math.ceil((this.rootEntries * 32) / this.bps);
    this.clusters = Math.floor((total - this.dataStart) / this.spc);
    this.fat16 = this.clusters >= 4085;
    this.label = data[b + 0x26] === 0x29 ? String.fromCharCode(...data.subarray(b + 0x2b, b + 0x36)).trim() : '';
  }

  /** 打开映像里的文件系统；不是 FAT12/FAT16（或者还没格式化）时返回说明文字 */
  static open(data: Uint8Array, floppy: boolean): FatVolume | string {
    let base = 0;
    if (!floppy) {
      if (data[510] !== 0x55 || data[511] !== 0xaa) return '这个硬盘还没有分区（第一个扇区没有 55AAh 标记）。先用 DOS 的 FDISK 分区、FORMAT 格式化，或者运行 DOS 安装程序';
      let found = -1;
      for (let p = 0; p < 4; p++) {
        const e = 0x1be + p * 16, type = data[e + 4];
        if ([0x01, 0x04, 0x06, 0x0e].includes(type)) { found = (data[e + 8] | (data[e + 9] << 8) | (data[e + 10] << 16) | (data[e + 11] << 24)) >>> 0; break; }
      }
      if (found < 0) {
        // 没有分区表、直接格式化的硬盘（"超级软盘"）
        if (looksLikeBpb(data, 0)) found = 0;
        else return '硬盘上没有 DOS 分区（FAT12/FAT16）。先用 FDISK 建立分区';
      }
      base = found;
    }
    if (!looksLikeBpb(data, base * SECTOR)) return floppy ? '这张软盘还没有格式化（或者不是 DOS 格式）' : 'DOS 分区还没有格式化。用 FORMAT C: 格式化';
    const v = new FatVolume(data, base);
    if (v.bps !== SECTOR) return `不支持每扇区 ${v.bps} 字节的磁盘`;
    return v;
  }

  // ----- 扇区和 FAT -----
  private sectorAt(s: number): number { return this.base + s * SECTOR; }
  private clusterSector(c: number): number { return this.dataStart + (c - 2) * this.spc; }
  private get clusterBytes(): number { return this.spc * SECTOR; }

  private fatGet(n: number): number {
    const f = this.sectorAt(this.fatStart);
    if (this.fat16) return this.data[f + n * 2] | (this.data[f + n * 2 + 1] << 8);
    const o = f + Math.floor((n * 3) / 2);
    const v = this.data[o] | (this.data[o + 1] << 8);
    return n & 1 ? v >> 4 : v & 0xfff;
  }

  private fatSet(n: number, v: number): void {
    for (let k = 0; k < this.fats; k++) {
      const f = this.sectorAt(this.fatStart + k * this.fatSectors);
      if (this.fat16) { this.data[f + n * 2] = v & 0xff; this.data[f + n * 2 + 1] = (v >> 8) & 0xff; continue; }
      const o = f + Math.floor((n * 3) / 2);
      if (n & 1) { this.data[o] = (this.data[o] & 0x0f) | ((v << 4) & 0xf0); this.data[o + 1] = (v >> 4) & 0xff; }
      else { this.data[o] = v & 0xff; this.data[o + 1] = (this.data[o + 1] & 0xf0) | ((v >> 8) & 0x0f); }
    }
  }

  private isEnd(v: number): boolean { return this.fat16 ? v >= 0xfff8 : v >= 0xff8; }
  private get endMark(): number { return this.fat16 ? 0xffff : 0xfff; }

  private chain(start: number): number[] {
    const out: number[] = [];
    let c = start;
    while (c >= 2 && c < this.clusters + 2 && !this.isEnd(c) && out.length <= this.clusters) {
      out.push(c);
      c = this.fatGet(c);
    }
    return out;
  }

  private freeChain(start: number): void {
    for (const c of this.chain(start)) this.fatSet(c, 0);
  }

  /** 分配 n 个簇并连成一串，返回第一个簇（n = 0 时返回 0）；空间不够时抛出错误 */
  private allocate(n: number): number[] {
    const got: number[] = [];
    for (let c = 2; c < this.clusters + 2 && got.length < n; c++) if (this.fatGet(c) === 0) got.push(c);
    if (got.length < n) throw new Error('磁盘空间不够');
    got.forEach((c, k) => this.fatSet(c, k + 1 < got.length ? got[k + 1] : this.endMark));
    return got;
  }

  freeBytes(): number {
    let n = 0;
    for (let c = 2; c < this.clusters + 2; c++) if (this.fatGet(c) === 0) n++;
    return n * this.clusterBytes;
  }

  // ----- 目录 -----

  /** 目录占用的全部目录项的字节位置；cluster = 0 表示根目录 */
  private dirSlots(cluster: number): number[] {
    const out: number[] = [];
    if (cluster === 0) {
      const at = this.sectorAt(this.rootStart);
      for (let k = 0; k < this.rootEntries; k++) out.push(at + k * 32);
    } else {
      for (const c of this.chain(cluster)) {
        const at = this.sectorAt(this.clusterSector(c));
        for (let k = 0; k < this.clusterBytes / 32; k++) out.push(at + k * 32);
      }
    }
    return out;
  }

  private entryName(o: number): string {
    const raw = String.fromCharCode(...this.data.subarray(o, o + 11));
    const base = raw.slice(0, 8).trimEnd(), ext = raw.slice(8).trimEnd();
    return (base.charCodeAt(0) === 0x05 ? '\xe5' + base.slice(1) : base) + (ext ? '.' + ext : '');
  }

  /** 列出目录里的有效目录项（不含卷标、长文件名项、已删除项） */
  private entries(cluster: number): { o: number; name: string }[] {
    const out: { o: number; name: string }[] = [];
    for (const o of this.dirSlots(cluster)) {
      const first = this.data[o];
      if (first === 0) break;
      if (first === 0xe5) continue;
      const attr = this.data[o + 11];
      if (attr === 0x0f || attr & 0x08) continue;
      out.push({ o, name: this.entryName(o) });
    }
    return out;
  }

  /** 路径（"\\DOS\\SUB" 或空串表示根目录）对应的目录簇号 */
  private dirCluster(path: string): number {
    let c = 0;
    for (const part of splitPath(path)) {
      const e = this.entries(c).find(x => x.name === part && this.data[x.o + 11] & 0x10);
      if (!e) throw new Error(`找不到目录 ${part}`);
      c = this.word(e.o + 26);
    }
    return c;
  }

  private word(o: number): number { return this.data[o] | (this.data[o + 1] << 8); }
  private setWord(o: number, v: number): void { this.data[o] = v & 0xff; this.data[o + 1] = (v >> 8) & 0xff; }

  list(path: string): FatEntry[] {
    const c = this.dirCluster(path);
    return this.entries(c)
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => {
        const attr = this.data[e.o + 11];
        return {
          name: e.name, attr, isDir: (attr & 0x10) !== 0,
          size: (this.word(e.o + 28) | (this.word(e.o + 30) << 16)) >>> 0,
          date: fromDosTime(this.word(e.o + 24), this.word(e.o + 22)),
        };
      })
      .sort((a, b) => (a.isDir === b.isDir ? (a.name < b.name ? -1 : 1) : a.isDir ? -1 : 1));
  }

  readFile(path: string, name: string): Uint8Array {
    const e = this.entries(this.dirCluster(path)).find(x => x.name === name);
    if (!e) throw new Error(`找不到文件 ${name}`);
    const size = (this.word(e.o + 28) | (this.word(e.o + 30) << 16)) >>> 0;
    const out = new Uint8Array(size);
    let p = 0;
    for (const c of this.chain(this.word(e.o + 26))) {
      const at = this.sectorAt(this.clusterSector(c));
      const n = Math.min(this.clusterBytes, size - p);
      out.set(this.data.subarray(at, at + n), p);
      p += n;
      if (p >= size) break;
    }
    return out;
  }

  /** 在目录里找一个空的目录项；子目录满了就再分配一个簇 */
  private freeSlot(cluster: number): number {
    for (const o of this.dirSlots(cluster)) if (this.data[o] === 0 || this.data[o] === 0xe5) return o;
    if (cluster === 0) throw new Error('根目录已满（根目录的目录项个数是固定的），请放进子目录里');
    const [c] = this.allocate(1);
    const chain = this.chain(cluster);
    this.fatSet(chain[chain.length - 1], c);
    const at = this.sectorAt(this.clusterSector(c));
    this.data.fill(0, at, at + this.clusterBytes);
    return at;
  }

  private writeEntry(o: number, name83: string, attr: number, cluster: number, size: number, date: Date): void {
    this.data.fill(0, o, o + 32);
    for (let k = 0; k < 11; k++) this.data[o + k] = name83.charCodeAt(k);
    this.data[o + 11] = attr;
    const t = toDosTime(date);
    this.setWord(o + 22, t.time);
    this.setWord(o + 24, t.date);
    this.setWord(o + 26, cluster);
    this.setWord(o + 28, size & 0xffff);
    this.setWord(o + 30, (size >>> 16) & 0xffff);
  }

  /** 写入一个文件（已有同名文件时覆盖）；返回实际使用的 8.3 文件名 */
  writeFile(path: string, longName: string, bytes: Uint8Array, date = new Date()): string {
    const dir = this.dirCluster(path);
    const existing = this.entries(dir);
    const name = shortName(longName, existing.map(e => e.name));
    const old = existing.find(e => e.name === name);
    if (old && this.data[old.o + 11] & 0x10) throw new Error(`${name} 是一个目录`);
    let slot: number;
    if (old) { this.freeChain(this.word(old.o + 26)); slot = old.o; } else slot = -1;
    const need = Math.ceil(bytes.length / this.clusterBytes);
    if (need * this.clusterBytes > this.freeBytes()) throw new Error(`磁盘空间不够：${name} 需要 ${bytes.length} 字节，剩余 ${this.freeBytes()} 字节`);
    const clusters = this.allocate(need);
    clusters.forEach((c, k) => {
      const at = this.sectorAt(this.clusterSector(c));
      const part = bytes.subarray(k * this.clusterBytes, (k + 1) * this.clusterBytes);
      this.data.fill(0, at, at + this.clusterBytes);
      this.data.set(part, at);
    });
    if (slot < 0) slot = this.freeSlot(dir);
    this.writeEntry(slot, to83Raw(name), 0x20, clusters[0] ?? 0, bytes.length, date);
    return name;
  }

  mkdir(path: string, longName: string): string {
    const dir = this.dirCluster(path);
    const existing = this.entries(dir);
    const name = shortName(longName, existing.map(e => e.name));
    if (existing.some(e => e.name === name)) throw new Error(`已经有 ${name} 了`);
    const [c] = this.allocate(1);
    const at = this.sectorAt(this.clusterSector(c));
    this.data.fill(0, at, at + this.clusterBytes);
    const now = new Date();
    this.writeEntry(at, '.          ', 0x10, c, 0, now);
    this.writeEntry(at + 32, '..         ', 0x10, dir, 0, now);
    const slot = this.freeSlot(dir);
    this.writeEntry(slot, to83Raw(name), 0x10, c, 0, now);
    return name;
  }

  /** 删除文件或空目录 */
  remove(path: string, name: string): void {
    const e = this.entries(this.dirCluster(path)).find(x => x.name === name);
    if (!e) throw new Error(`找不到 ${name}`);
    const attr = this.data[e.o + 11];
    if (attr & 0x10) {
      const sub = this.word(e.o + 26);
      if (this.entries(sub).some(x => x.name !== '.' && x.name !== '..')) throw new Error(`目录 ${name} 不是空的，请先删除里面的文件`);
    }
    this.freeChain(this.word(e.o + 26));
    this.data[e.o] = 0xe5;
  }
}

function looksLikeBpb(data: Uint8Array, o: number): boolean {
  const bps = data[o + 0x0b] | (data[o + 0x0c] << 8);
  const spc = data[o + 0x0d], fats = data[o + 0x10];
  return (data[o] === 0xeb || data[o] === 0xe9) && [512, 1024, 2048, 4096].includes(bps) && spc > 0 && (spc & (spc - 1)) === 0 && fats >= 1 && fats <= 2;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map(s => s.toUpperCase());
}

const VALID = /^[A-Z0-9!#$%&'()\-@^_`{}~\x80-\xff]+$/;

/** 把文件名换成合法的 DOS 8.3 名字（太长或有非法字符时生成 NAME~1.EXT 这样的短名字） */
export function shortName(name: string, existing: string[]): string {
  const up = name.toUpperCase().replace(/\s+/g, '');
  const dot = up.lastIndexOf('.');
  let base = dot > 0 ? up.slice(0, dot) : up, ext = dot > 0 ? up.slice(dot + 1) : '';
  const clean = (s: string) => s.replace(/[^A-Z0-9!#$%&'()\-@^_`{}~]/g, '_').replace(/\./g, '');
  if (base.length <= 8 && ext.length <= 3 && VALID.test(base) && (!ext || VALID.test(ext))) return ext ? `${base}.${ext}` : base;
  base = clean(base) || 'FILE'; ext = clean(ext).slice(0, 3);
  for (let n = 1; n < 1000; n++) {
    const tail = '~' + n;
    const cand = base.slice(0, 8 - tail.length) + tail + (ext ? '.' + ext : '');
    if (!existing.includes(cand)) return cand;
  }
  throw new Error('起不出不重复的短文件名');
}

function to83Raw(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot + 1) : '';
  return base.padEnd(8, ' ') + ext.padEnd(3, ' ');
}

function toDosTime(d: Date): { time: number; date: number } {
  const y = Math.max(0, Math.min(127, d.getFullYear() - 1980));
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: (y << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function fromDosTime(date: number, time: number): Date | null {
  if (!date) return null;
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}
