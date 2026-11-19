import { describe, it, expect } from 'vitest';
import { Machine } from '../src/machine/machine.ts';
import { Disk, blankHardDisk } from '../src/machine/disk.ts';

// 像 Windows 95 的 ESDI_506.PDR 那样经端口操作 IDE 第一通道上的硬盘

function machine(): Machine {
  const m = new Machine();
  m.setCpu('386');
  const data = blankHardDisk(8); // 8MB：16 磁头、63 扇区
  for (let lba = 0; lba < data.length / 512; lba++) { data[lba * 512] = lba & 0xff; data[lba * 512 + 1] = (lba >> 8) & 0xff; }
  m.drives[2] = new Disk('C.IMG', data, false);
  m.ide.reset();
  return m;
}

function irq(m: Machine): boolean {
  const had = (m.pic2.irr & 0x40) !== 0;
  m.pic2.irr &= ~0x40;
  return had;
}

function readWords(m: Machine, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(m.cpu.io.in16!(0x1f0));
  return out;
}

/** 设置 LBA 地址和扇区数 */
function lba(m: Machine, unit: number, a: number, count: number): void {
  const io = m.cpu.io;
  io.out8(0x1f6, 0xe0 | (unit << 4) | ((a >> 24) & 15));
  io.out8(0x1f2, count); io.out8(0x1f3, a & 0xff); io.out8(0x1f4, (a >> 8) & 0xff); io.out8(0x1f5, (a >> 16) & 0xff);
}

describe('IDE 硬盘（第一通道）', () => {
  it('复位后是 ATA 硬盘的签名；IDENTIFY DEVICE 给出几何参数和扇区总数；从盘不存在时读出 0', () => {
    const m = machine(), io = m.cpu.io;
    io.out8(0x3f6, 0x04); io.out8(0x3f6, 0x00); // 软件复位
    expect([io.in8(0x1f2), io.in8(0x1f3), io.in8(0x1f4), io.in8(0x1f5), io.in8(0x1f1)]).toEqual([1, 1, 0, 0, 1]);
    expect(io.in8(0x1f7) & 0xc0).toBe(0x40);
    io.out8(0x1f6, 0xa0);
    io.out8(0x1f7, 0xec);
    expect(irq(m)).toBe(true);
    expect(io.in8(0x1f7) & 0x08).toBe(0x08);
    const w = readWords(m, 256);
    const d = m.drives[2]!;
    expect([w[0], w[1], w[3], w[6]]).toEqual([0x0040, d.geo.cylinders, 16, 63]);
    expect(w[60] | (w[61] << 16)).toBe(d.sectorCount);
    expect(w[49] & 0x0200).toBe(0x0200);
    expect(io.in8(0x1f7) & 0x08).toBe(0);
    io.out8(0x1f6, 0xb0);
    expect(io.in8(0x1f7)).toBe(0);
    io.out8(0x1f7, 0xec);                      // 没有从盘：不理会
    expect(irq(m)).toBe(false);
  });

  it('READ SECTORS：LBA 和 CHS 方式，每个扇区一次中断；结束时寄存器指向最后一个扇区', () => {
    const m = machine(), io = m.cpu.io;
    lba(m, 0, 1000, 2);
    io.out8(0x1f7, 0x20);
    expect(irq(m)).toBe(true);
    let w = readWords(m, 256);
    expect(w[0]).toBe(1000);
    expect(irq(m)).toBe(true);                 // 第二个扇区
    w = readWords(m, 256);
    expect(w[0]).toBe(1001);
    expect(io.in8(0x1f7)).toBe(0x50);
    expect(io.in8(0x1f3) | (io.in8(0x1f4) << 8)).toBe(1001);
    // CHS：柱面 2、磁头 3、扇区 4 → (2 × 16 + 3) × 63 + 3
    io.out8(0x1f6, 0xa3); io.out8(0x1f2, 1); io.out8(0x1f3, 4); io.out8(0x1f4, 2); io.out8(0x1f5, 0);
    io.out8(0x1f7, 0x20);
    w = readWords(m, 256);
    expect(w[0]).toBe(((2 * 16 + 3) * 63 + 3) & 0xffff);
    // 超出范围
    lba(m, 0, 0x0fffffff, 1);
    io.out8(0x1f7, 0x20);
    expect(io.in8(0x1f7) & 1).toBe(1);
    expect(io.in8(0x1f1)).toBe(0x10);
  });

  it('SET MULTIPLE + READ MULTIPLE 一次中断传多个扇区；INITIALIZE DEVICE PARAMETERS 改变 CHS 换算', () => {
    const m = machine(), io = m.cpu.io;
    io.out8(0x1f7, 0xc4);                      // 没设置过：中止
    expect(io.in8(0x1f1)).toBe(0x04);
    io.out8(0x1f2, 8); io.out8(0x1f7, 0xc6);
    expect(io.in8(0x1f7) & 1).toBe(0);
    lba(m, 0, 50, 10);
    io.out8(0x1f7, 0xc4);
    expect(irq(m)).toBe(true);
    const a = readWords(m, 8 * 256);
    expect([a[0], a[7 * 256]]).toEqual([50, 57]);
    expect(irq(m)).toBe(true);
    const b = readWords(m, 2 * 256);
    expect([b[0], b[256]]).toEqual([58, 59]);
    // 逻辑几何：8 磁头、32 扇区
    io.out8(0x1f6, 0xa7); io.out8(0x1f2, 32); io.out8(0x1f7, 0x91);
    io.out8(0x1f6, 0xa1); io.out8(0x1f2, 1); io.out8(0x1f3, 1); io.out8(0x1f4, 1); io.out8(0x1f5, 0);
    io.out8(0x1f7, 0x20);
    expect(readWords(m, 256)[0]).toBe((1 * 8 + 1) * 32);
  });

  it('WRITE SECTORS：第一块不发中断，写完每块发中断；映像被改写', () => {
    const m = machine(), io = m.cpu.io;
    lba(m, 0, 77, 2);
    io.out8(0x1f7, 0x30);
    expect(irq(m)).toBe(false);
    expect(io.in8(0x1f7) & 0x08).toBe(0x08);
    for (let k = 0; k < 256; k++) io.out16!(0x1f0, 0x1234);
    expect(irq(m)).toBe(true);
    for (let k = 0; k < 256; k++) io.out16!(0x1f0, 0x5678);
    expect(irq(m)).toBe(true);
    expect(io.in8(0x1f7)).toBe(0x50);
    const d = m.drives[2]!;
    expect([d.data[77 * 512], d.data[77 * 512 + 1], d.data[78 * 512 + 511]]).toEqual([0x34, 0x12, 0x56]);
    expect(d.dirty).toBe(true);
  });

  it('CMOS 里 C: 是类型 47，参数是映像的几何', () => {
    const m = machine();
    (m as unknown as { initCmos(): void }).initCmos();
    const c = m.cmos;
    expect([c[0x12], c[0x19], c[0x1b] | (c[0x1c] << 8), c[0x1d], c[0x22]]).toEqual([0xf0, 47, m.drives[2]!.geo.cylinders, 16, 63]);
  });
});
