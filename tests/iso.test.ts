import { describe, it, expect } from 'vitest';
import { buildIso } from '../tools/mkiso.ts';
import { IsoDisk, BytesSource, BlobSource, isIsoFile } from '../src/machine/iso.ts';
import { FatVolume } from '../src/machine/fat.ts';
import { Disk } from '../src/machine/disk.ts';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';

const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
const big = new Uint8Array(300_000).map((_, i) => (i * 7 + (i >> 9)) & 0xff);

function sampleIso(): Uint8Array {
  return buildIso([
    { path: 'AAA.BIN', data: new Uint8Array(200_000) }, // 让 README.TXT 落在 64KB 之后（测试按需读）
    { path: 'README.TXT', data: bytes('hello from the CD\r\n') },
    { path: 'LongFileName.txt', data: bytes('long') },
    { path: 'DOCS/A.TXT', data: bytes('aaa') },
    { path: 'DOCS/SUB/DEEP.DAT', data: big },
    { path: 'EMPTY.TXT', data: new Uint8Array(0) },
  ], 'MYCD');
}

/** 把虚拟磁盘的全部扇区排成一个普通的硬盘映像 */
function flatten(d: IsoDisk): Uint8Array {
  const out = new Uint8Array(d.sectorCount * 512);
  for (let s = 0; s < d.sectorCount; s++) out.set(d.readSector(s)!, s * 512);
  return out;
}

describe('光盘映像变成只读的 FAT16 硬盘', () => {
  it('目录、文件、卷标都能按 FAT16 读出来', async () => {
    const iso = await IsoDisk.open(new BytesSource(sampleIso()), 'T.ISO');
    const v = FatVolume.open(flatten(iso), false);
    if (typeof v === 'string') throw new Error(v);
    expect(v.fat16).toBe(true);
    expect(v.label).toBe('MYCD');
    const root = v.list('').map(e => e.name).sort();
    expect(root).toContain('README.TXT');
    expect(root).toContain('DOCS');
    expect(root).toContain('EMPTY.TXT');
    expect(root.some(n => /^LONGFI~1\.TXT$/.test(n))).toBe(true);
    expect(new TextDecoder().decode(v.readFile('', 'README.TXT'))).toBe('hello from the CD\r\n');
    expect(v.readFile('', 'EMPTY.TXT').length).toBe(0);
    expect(new TextDecoder().decode(v.readFile('\\DOCS', 'A.TXT'))).toBe('aaa');
    expect(v.readFile('\\DOCS\\SUB', 'DEEP.DAT')).toEqual(big);
    expect(v.list('\\DOCS').map(e => e.name).sort()).toEqual(['A.TXT', 'SUB']);
  });

  it('不是 ISO 时出错；按文件头识别 ISO', async () => {
    await expect(IsoDisk.open(new BytesSource(new Uint8Array(40000)), 'X')).rejects.toThrow(/ISO9660/);
    expect(await isIsoFile(new Blob([sampleIso().slice()]))).toBe(true);
    expect(await isIsoFile(new Blob([new Uint8Array(40000)]))).toBe(false);
  });

  it('INT 13h：从 D:（81h）按需读文件内容，写入返回写保护', async () => {
    const img = sampleIso();
    const iso = await IsoDisk.open(new BlobSource(new Blob([img.slice()])), 'T.ISO');
    // 找到 README.TXT 内容所在的扇区（用内存里的同一份映像算出来）
    const ref = await IsoDisk.open(new BytesSource(img), 'T.ISO');
    let lba = -1;
    for (let s = 64; s < ref.sectorCount && lba < 0; s++) if (ref.readSector(s)![0] === 0x68 && ref.readSector(s)![1] === 0x65) lba = s;
    expect(lba).toBeGreaterThan(0);
    expect(iso.readSector(lba)).toBeNull(); // 还没从文件里读出来
    const { heads, sectors } = iso.geo;
    const c = Math.floor(lba / (heads * sectors)), h = Math.floor(lba / sectors) % heads, s = (lba % sectors) + 1;
    const cx = ((c & 0xff) << 8) | ((c >> 2) & 0xc0) | s;
    const p = assemble(`
.model small
.stack 100h
.data
buf     db 512 dup(0)
.code
start:  mov ax, @data
        mov ds, ax
        mov es, ax
        mov ax, 0201h               ; 分区表
        mov cx, 0001h
        mov dx, 0081h
        mov bx, offset buf
        int 13h
        jc bad
        cmp word ptr buf+510, 0AA55h
        jne bad
        mov ax, 0201h               ; README.TXT 的内容
        mov cx, ${cx}
        mov dx, ${(h << 8) | 0x81}
        mov bx, offset buf
        int 13h
        jc bad
        cmp word ptr buf, 6568h     ; "he"
        jne bad
        mov ax, 0301h               ; 写：写保护
        mov cx, 0001h
        mov dx, 0081h
        int 13h
        jnc bad
        cmp ah, 3
        jne bad
        mov ax, 4c00h
        int 21h
bad:    mov ax, 4c01h
        int 21h
end start`);
    const m = new Machine();
    m.load(p);
    m.drives[3] = new Disk('T.ISO', new Uint8Array(0), false, iso);
    let r = '';
    for (let k = 0; k < 200 && r !== 'exit'; k++) {
      r = m.run(20_000);
      await new Promise(res => setTimeout(res, 1));
    }
    expect(r).toBe('exit');
    expect(m.exitCode).toBe(0);
  });
});
