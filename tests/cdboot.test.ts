import { describe, it, expect } from 'vitest';
import { Machine, CD_BOOT } from '../src/machine/machine.ts';
import { Disk } from '../src/machine/disk.ts';
import { BytesSource, readElTorito } from '../src/machine/iso.ts';
import { bootProgram } from '../src/machine/boot.ts';
import { buildIso } from '../tools/mkiso.ts';

// 从光驱启动：El Torito 的软盘模拟（光盘里的启动软盘当作 A:）

function floppy(mark: number): Uint8Array {
  const d = new Uint8Array(1440 * 1024);
  d[0] = 0xeb; d[1] = 0xfe; d[2] = mark;   // JMP $（停在引导扇区里）
  d[510] = 0x55; d[511] = 0xaa;
  return d;
}

describe('从光驱启动（El Torito 软盘模拟）', () => {
  it('读出启动软盘映像，启动后它是 A:，原来的 A: 是 B:', async () => {
    const iso = buildIso([{ path: 'README.TXT', data: new Uint8Array(10) }], 'BOOTCD', floppy(0x42));
    const r = await readElTorito(new BytesSource(iso));
    if (typeof r === 'string' || r.kind !== 'floppy') throw new Error(String(r));
    expect(r.media).toBe(2);
    expect(r.image[2]).toBe(0x42);

    const m = new Machine();
    m.setCpu('386');
    m.drives[0] = new Disk('A.IMG', floppy(0x11), true);
    m.cdBoot = new Disk('CD', r.image, true);
    m.load(bootProgram(CD_BOOT));
    expect(m.mem[0x7c02]).toBe(0x42);          // 引导扇区来自光盘
    expect(m.cpu.r[2] & 0xff).toBe(0);         // DL = 0（A:）
    expect(m.driveFor(0)).toBe(m.cdBoot);
    expect(m.driveFor(1)).toBe(m.drives[0]);
    expect((m.mem[0x410] >> 6) & 3).toBe(1);   // 两个软驱

    // 从 A: 启动时恢复原样
    m.load(bootProgram(0));
    expect(m.mem[0x7c02]).toBe(0x11);
    expect(m.driveFor(1)).toBe(null);
  });

  it('不能启动的光盘、硬盘模拟方式给出说明', async () => {
    const plain = buildIso([{ path: 'A.TXT', data: new Uint8Array(1) }]);
    expect(await readElTorito(new BytesSource(plain))).toMatch(/不能启动/);
    const iso = buildIso([], 'X', floppy(1));
    iso[19 * 2048 + 33] = 4;                    // 改成"硬盘模拟"
    expect(await readElTorito(new BytesSource(iso))).toMatch(/硬盘模拟/);
  });

  it('不模拟方式：引导程序装到 7C00，DL = E0h，用 INT 13h 扩展功能（41h、42h、48h、4Bh）读光盘', async () => {
    const iso = buildIso([{ path: 'README.TXT', data: new Uint8Array(10) }], 'NOEMU', floppy(0));
    const cat = 19 * 2048, bootLba = iso[cat + 40] | (iso[cat + 41] << 8);
    iso[cat + 33] = 0;                          // 不模拟
    iso[cat + 38] = 4;                          // 4 个虚拟扇区（2048 字节，和 isolinux、ETFSBOOT 一样）
    const code = [
      0xb4, 0x41, 0xbb, 0xaa, 0x55, 0xcd, 0x13,  // mov ah,41h / mov bx,55AAh / int 13h
      0x89, 0xdd,                                // mov bp,bx
      0xbe, 0x20, 0x7c, 0xb4, 0x42, 0xcd, 0x13,  // mov si,7C20h / mov ah,42h / int 13h：读第 16 块到 0000:8000
      0xbe, 0x40, 0x7c, 0xb8, 0x01, 0x4b, 0xcd, 0x13, // mov si,7C40h / mov ax,4B01h / int 13h：启动状态
      0xfa, 0xf4,                                // cli / hlt
    ];
    iso.fill(0, bootLba * 2048, bootLba * 2048 + 2048);
    iso.set(code, bootLba * 2048);
    iso.set([0x10, 0, 1, 0, 0x00, 0x80, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0], bootLba * 2048 + 0x20);
    const r = await readElTorito(new BytesSource(iso));
    if (typeof r === 'string' || r.kind !== 'noemu') throw new Error(String(r));
    expect([r.loadSeg, r.count, r.rba, r.image.length]).toEqual([0, 4, bootLba, 2048]);

    const m = new Machine();
    m.setCpu('386');
    m.cdrom.insert(new BytesSource(iso), 'NOEMU.ISO');
    m.cdBootNoEmu = { image: r.image, loadSeg: r.loadSeg, rba: r.rba, count: r.count };
    m.load(bootProgram(CD_BOOT));
    expect([m.cpu.s[1], m.cpu.ip, m.cpu.r[2] & 0xff]).toEqual([0, 0x7c00, 0xe0]);
    for (let k = 0; k < 20 && !m.cpu.halted; k++) m.run(1000);
    expect(m.cpu.r[5]).toBe(0xaa55);           // 41h：有扩展功能
    expect(String.fromCharCode(...m.mem.subarray(0x8001, 0x8006))).toBe('CD001');
    expect([m.mem[0x7c40], m.mem[0x7c41], m.mem[0x7c42]]).toEqual([0x13, 0, 0xe0]); // 4Bh：不模拟、E0h 号盘
  });
});
