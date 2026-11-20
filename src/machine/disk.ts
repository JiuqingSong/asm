// 磁盘映像：软盘（A:、B:）和硬盘（C:、D:），按扇区读写，供 BIOS 的 INT 13h 使用
//
// 映像就是磁盘上全部扇区按顺序排起来的字节（.img / .ima 文件），每个扇区 512 字节。
// 扇区的位置用"柱面、磁头、扇区"（CHS）表示：
//   线性扇区号 = (柱面 × 磁头数 + 磁头) × 每道扇区数 + (扇区 − 1)

import type { IsoDisk } from './iso.ts';

export interface Geometry {
  cylinders: number;
  heads: number;
  sectors: number; // 每道扇区数
}

/** 常见软盘的大小和几何参数；type 是 INT 13h AH=08h 返回的驱动器类型 */
const FLOPPIES: { size: number; geo: Geometry; type: number; name: string }[] = [
  { size: 160 * 1024, geo: { cylinders: 40, heads: 1, sectors: 8 }, type: 1, name: '160KB' },
  { size: 180 * 1024, geo: { cylinders: 40, heads: 1, sectors: 9 }, type: 1, name: '180KB' },
  { size: 320 * 1024, geo: { cylinders: 40, heads: 2, sectors: 8 }, type: 1, name: '320KB' },
  { size: 360 * 1024, geo: { cylinders: 40, heads: 2, sectors: 9 }, type: 1, name: '360KB' },
  { size: 720 * 1024, geo: { cylinders: 80, heads: 2, sectors: 9 }, type: 3, name: '720KB' },
  { size: 1200 * 1024, geo: { cylinders: 80, heads: 2, sectors: 15 }, type: 2, name: '1.2MB' },
  { size: 1440 * 1024, geo: { cylinders: 80, heads: 2, sectors: 18 }, type: 4, name: '1.44MB' },
  { size: 2880 * 1024, geo: { cylinders: 80, heads: 2, sectors: 36 }, type: 6, name: '2.88MB' },
];

function floppyFormat(data: Uint8Array) {
  const raw = FLOPPIES.find(f => f.size === data.length);
  if (raw) return raw;
  const f = FLOPPIES.find(f => f.size + 1024 === data.length);
  if (!f) return undefined;
  const footer = new TextDecoder().decode(data.subarray(f.size));
  return footer.startsWith('[FileVersion 003] ') &&
    footer.includes(`[SectorsPerTrack ${f.geo.sectors}]`) &&
    footer.includes(`[Tracks ${f.geo.cylinders}]`) ? f : undefined;
}

export class Disk {
  readonly data: Uint8Array;
  readonly geo: Geometry;
  readonly floppy: boolean;
  /** 软驱类型（INT 13h AH=08h 的 BL） */
  readonly floppyType: number;
  name: string;
  /** 被写过（界面据此提示下载） */
  dirty = false;
  /** 软盘刚插入、还没被 INT 13h AH=16h 查询过（换盘信号） */
  changed = true;
  /** 光盘映像合成的只读硬盘（这时 data 是 ISO 文件本身，扇区由它生成） */
  readonly iso: IsoDisk | null = null;
  /** 光盘映像的文件（浏览器里保存它，而不是 data） */
  isoFile: Blob | null = null;

  /** iso 不为空时是光盘映像，data 不用（传空数组） */
  constructor(name: string, data: Uint8Array, floppy: boolean, iso: IsoDisk | null = null) {
    this.name = name;
    this.floppy = floppy;
    if (iso) {
      this.iso = iso;
      this.data = data;
      this.geo = iso.geo;
      this.floppyType = 0;
    } else if (floppy) {
      const f = floppyFormat(data);
      if (!f) throw new Error(`${name} 的大小是 ${data.length} 字节，不是标准的软盘映像（160KB、360KB、720KB、1.2MB、1.44MB、2.88MB）`);
      this.data = data.length === f.size ? data : data.slice(0, f.size);
      this.geo = f.geo;
      this.floppyType = f.type;
    } else {
      if (data.length < 512 * 1024 || data.length % 512) throw new Error(`${name} 的大小是 ${data.length} 字节，不像硬盘映像`);
      this.geo = guessHardDiskGeometry(data);
      const size = this.geo.cylinders * this.geo.heads * this.geo.sectors * 512;
      if (size > data.length) { this.data = new Uint8Array(size); this.data.set(data); } else this.data = data;
      this.floppyType = 0;
    }
  }

  get sectorCount(): number { return this.geo.cylinders * this.geo.heads * this.geo.sectors; }

  /** 只读（光盘映像） */
  get readOnly(): boolean { return this.iso !== null; }

  /** 读一个扇区（512 字节；返回的数组不要修改）。光盘映像的内容还没读出来时返回 null */
  readSector(lba: number): Uint8Array | null {
    if (this.iso) return this.iso.readSector(lba);
    return this.data.subarray(lba * 512, lba * 512 + 512);
  }

  /** 写一个扇区；只读时返回 false */
  writeSector(lba: number, buf: Uint8Array): boolean {
    if (this.iso) return false;
    this.data.set(buf.subarray(0, 512), lba * 512);
    this.dirty = true;
    return true;
  }

  /** CHS 换成线性扇区号；超出范围时返回 -1 */
  lba(c: number, h: number, s: number): number {
    const g = this.geo;
    if (c >= g.cylinders || h >= g.heads || s < 1 || s > g.sectors) return -1;
    return (c * g.heads + h) * g.sectors + (s - 1);
  }

  /** 软盘的规格名，例如 1.44MB；硬盘返回容量 */
  get description(): string {
    if (this.iso) return this.iso.description;
    if (this.floppy) return FLOPPIES.find(x => x.size === this.data.length)?.name ?? '';
    return `${Math.round(this.data.length / 1024 / 1024)}MB 硬盘`;
  }

  /** 几何参数的说明 */
  get geometryText(): string {
    return `${this.geo.cylinders} 柱面 × ${this.geo.heads} 磁头 × 每道 ${this.geo.sectors} 扇区`;
  }
}

/** 标准原始软盘映像，或附有可识别的 1024 字节尾部说明的映像 */
export function isFloppyImage(data: Uint8Array): boolean {
  return floppyFormat(data) !== undefined;
}

/** 新建一个空白硬盘映像（16 磁头、每道 63 扇区，和当年 BIOS 的"LBA 转换"参数相同） */
export function blankHardDisk(megabytes: number): Uint8Array {
  const cyl = Math.max(1, Math.min(1024, Math.floor((megabytes * 1024 * 1024) / (16 * 63 * 512))));
  return new Uint8Array(cyl * 16 * 63 * 512);
}

/** 新建一张空白（未格式化）软盘 */
export function blankFloppy(): Uint8Array {
  return new Uint8Array(1440 * 1024);
}

/**
 * 推测硬盘映像的几何参数：如果有分区表，按分区的结束位置推出磁头数和每道扇区数；
 * 否则用 16 磁头、63 扇区
 */
function guessHardDiskGeometry(data: Uint8Array): Geometry {
  let heads = 16, sectors = 63;
  if (data[510] === 0x55 && data[511] === 0xaa) {
    for (let p = 0; p < 4; p++) {
      const e = 0x1be + p * 16;
      if (!data[e + 4]) continue; // 分区类型为 0：空
      const endHead = data[e + 5], endSec = data[e + 6] & 0x3f;
      if (endSec > 0) { heads = endHead + 1; sectors = endSec; break; }
    }
  }
  const cylinders = Math.max(1, Math.min(1024, Math.ceil(data.length / (heads * sectors * 512))));
  return { cylinders, heads, sectors };
}
