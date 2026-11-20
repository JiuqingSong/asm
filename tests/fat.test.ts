import { describe, it, expect } from 'vitest';
import { FatVolume, shortName } from '../src/machine/fat.ts';
import { Disk, isFloppyImage } from '../src/machine/disk.ts';

/** 一张格式化好的空白 1.44MB 软盘（FAT12）：和 DOS 的 FORMAT A: 得到的参数相同 */
function blank144(): Uint8Array {
  const d = new Uint8Array(1440 * 1024);
  const w = (o: number, v: number) => { d[o] = v & 0xff; d[o + 1] = v >> 8; };
  d.set([0xeb, 0x3c, 0x90], 0);
  w(0x0b, 512); d[0x0d] = 1; w(0x0e, 1); d[0x10] = 2; w(0x11, 224); w(0x13, 2880); d[0x15] = 0xf0; w(0x16, 9); w(0x18, 18); w(0x1a, 2);
  d[510] = 0x55; d[511] = 0xaa;
  for (const fat of [512, 512 + 9 * 512]) d.set([0xf0, 0xff, 0xff], fat);
  return d;
}

describe('FAT 文件系统', () => {
  it('loads a floppy with a recognized metadata footer without exposing it as sectors', () => {
    const raw = blank144();
    const volume = FatVolume.open(raw, true);
    if (typeof volume === 'string') throw new Error(volume);
    volume.writeFile('', 'TEST.TXT', new TextEncoder().encode('floppy contents'));
    const image = new Uint8Array(raw.length + 1024);
    image.set(raw);
    image.set(new TextEncoder().encode('[FileVersion 003] [Description Setup-Boot Disk\u0001] [SectorsPerTrack 18] [Tracks 80]'), raw.length);
    const footer = image.slice(raw.length);
    expect(isFloppyImage(raw)).toBe(true);
    expect(isFloppyImage(image)).toBe(true);
    const disk = new Disk('BOOT.IMG', image, true);
    expect(disk.data.length).toBe(raw.length);
    expect(disk.data.every((value, i) => value === raw[i])).toBe(true);
    expect(disk.geo).toEqual({ cylinders: 80, heads: 2, sectors: 18 });
    expect(disk.description).toBe('1.44MB');
    expect(disk.readSector(2880)).toHaveLength(0);
    const loaded = FatVolume.open(disk.data, true);
    if (typeof loaded === 'string') throw new Error(loaded);
    expect(new TextDecoder().decode(loaded.readFile('', 'TEST.TXT'))).toBe('floppy contents');
    disk.writeSector(2879, new Uint8Array(512).fill(0x5a));
    expect(disk.data.slice(-512)).toEqual(new Uint8Array(512).fill(0x5a));
    expect(image.slice(raw.length)).toEqual(footer);
  });

  it('rejects arbitrary extra data, truncated footers and mismatched footer geometry', () => {
    for (const [extra, text] of [
      [1024, ''], [512, '[FileVersion 003] [SectorsPerTrack 18] [Tracks 80]'],
      [1024, '[FileVersion 003] [SectorsPerTrack 9] [Tracks 80]'],
      [1024, '[FileVersion 003] [SectorsPerTrack 18] [Tracks 40]'],
    ] as const) {
      const image = new Uint8Array(1440 * 1024 + extra);
      image.set(new TextEncoder().encode(text), 1440 * 1024);
      expect(isFloppyImage(image)).toBe(false);
      expect(() => new Disk('INVALID.IMG', image, true)).toThrow(/不是标准/);
    }
  });

  it('在 FAT12 软盘上写入、读回、建目录、删除', () => {
    const img = blank144();
    const v = FatVolume.open(img, true);
    if (typeof v === 'string') throw new Error(v);
    expect(v.fat16).toBe(false);
    const free0 = v.freeBytes();
    expect(free0).toBe(1457664);                       // 和 DOS 的 CHKDSK 报告的一样
    // 几个跨多个簇的文件：FAT12 的奇数、偶数簇号都要写对
    const big = Uint8Array.from({ length: 5000 }, (_, k) => k * 7);
    expect(v.writeFile('', 'big.bin', big)).toBe('BIG.BIN');
    expect(v.writeFile('', 'second.dat', Uint8Array.from({ length: 1500 }, (_, k) => 255 - (k & 255)))).toBe('SECOND.DAT');
    expect(Array.from(v.readFile('', 'BIG.BIN'))).toEqual(Array.from(big));
    expect(v.readFile('', 'SECOND.DAT')[1499]).toBe(255 - (1499 & 255));
    expect(v.freeBytes()).toBe(free0 - 10 * 512 - 3 * 512);
    // 子目录
    expect(v.mkdir('', 'games')).toBe('GAMES');
    v.writeFile('\GAMES', 'A Long File Name.txt', new TextEncoder().encode('hi'));
    expect(v.list('\GAMES').map(e => e.name)).toEqual(['ALONGF~1.TXT']);
    expect(v.list('').map(e => e.name)).toEqual(['GAMES', 'BIG.BIN', 'SECOND.DAT']);
    expect(() => v.remove('', 'GAMES')).toThrow(/不是空的/);
    v.remove('\GAMES', 'ALONGF~1.TXT');
    v.remove('', 'GAMES');
    // 覆盖已有的文件：原来的簇要释放
    v.writeFile('', 'BIG.BIN', new Uint8Array(10));
    expect(v.readFile('', 'BIG.BIN').length).toBe(10);
    expect(v.freeBytes()).toBe(free0 - 512 - 3 * 512);
  });

  it('没有格式化的磁盘给出说明', () => {
    expect(FatVolume.open(new Uint8Array(1440 * 1024), true)).toMatch(/没有格式化/);
    expect(FatVolume.open(new Uint8Array(1024 * 1024), false)).toMatch(/没有分区/);
  });

  it('长文件名换成 8.3 短名字', () => {
    expect(shortName('readme.txt', [])).toBe('README.TXT');
    expect(shortName('Disk 1 - Setup.img', [])).toBe('DISK1-~1.IMG');
    expect(shortName('verylongname.html', ['VERYLO~1.HTM'])).toBe('VERYLO~2.HTM');
    expect(shortName('turbohz2', [])).toBe('TURBOHZ2');
  });
});
