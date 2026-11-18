import { describe, it, expect } from 'vitest';
import { FatVolume, shortName } from '../src/machine/fat.ts';

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
