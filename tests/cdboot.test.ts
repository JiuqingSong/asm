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
    if (typeof r === 'string') throw new Error(r);
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

  it('不能启动的光盘、"不模拟"方式给出说明', async () => {
    const plain = buildIso([{ path: 'A.TXT', data: new Uint8Array(1) }]);
    expect(await readElTorito(new BytesSource(plain))).toMatch(/不能启动/);
    const iso = buildIso([], 'X', floppy(1));
    iso[19 * 2048 + 33] = 0;                    // 改成"不模拟"
    expect(await readElTorito(new BytesSource(iso))).toMatch(/不模拟/);
  });
});
