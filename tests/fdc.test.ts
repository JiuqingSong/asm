import { describe, it, expect } from 'vitest';
import { Machine } from '../src/machine/machine.ts';
import { Disk } from '../src/machine/disk.ts';

// 像 Windows 95 的 HSFLOP、Linux 的 floppy 驱动那样经端口操作软驱控制器，数据经 DMA 2 号通道

function floppy(): Uint8Array {
  const d = new Uint8Array(1440 * 1024);
  for (let lba = 0; lba < 2880; lba++) { d[lba * 512] = lba & 0xff; d[lba * 512 + 1] = lba >> 8; d[lba * 512 + 511] = 0xa5; }
  return d;
}

function machine(): Machine {
  const m = new Machine();
  m.setCpu('386');
  m.drives[0] = new Disk('A.IMG', floppy(), true);
  m.mem[0x410] = 0x01; // 一个软驱
  return m;
}

/** 让虚拟时间走一段（控制器执行命令要一点时间） */
function wait(m: Machine, clocks = 2000): void {
  (m as unknown as { advanceTime(dt: number): void }).advanceTime(clocks);
}

function cmd(m: Machine, bytes: number[]): void {
  const io = m.cpu.io;
  for (const b of bytes) {
    expect(io.in8(0x3f4) & 0xc0).toBe(0x80); // RQM，主机 → 控制器
    io.out8(0x3f5, b);
  }
}

function results(m: Machine): number[] {
  const io = m.cpu.io, out: number[] = [];
  while ((io.in8(0x3f4) & 0xd0) === 0xd0) out.push(io.in8(0x3f5));
  return out;
}

/** 设置 DMA 2 号通道：mode 46h = 写内存（读软盘），4Ah = 读内存（写软盘） */
function dma(m: Machine, mode: number, addr: number, len: number): void {
  const io = m.cpu.io;
  io.out8(0x0a, 0x06);                   // 屏蔽 2 号通道
  io.out8(0x0c, 0);
  io.out8(0x0b, mode);
  io.out8(0x04, addr & 0xff); io.out8(0x04, (addr >> 8) & 0xff);
  io.out8(0x81, addr >> 16);
  io.out8(0x05, (len - 1) & 0xff); io.out8(0x05, (len - 1) >> 8);
  io.out8(0x0a, 0x02);                   // 打开
}

function irqCount(m: Machine): boolean {
  const had = (m.pic.irr & 0x40) !== 0;
  m.pic.irr &= ~0x40;
  return had;
}

function resetFdc(m: Machine): void {
  const io = m.cpu.io;
  io.out8(0x3f2, 0x00);
  io.out8(0x3f2, 0x1c);                  // 马达 A 开、允许中断和 DMA、退出复位
  wait(m);
  expect(irqCount(m)).toBe(true);
  for (let k = 0; k < 4; k++) { cmd(m, [0x08]); expect(results(m)).toEqual([0xc0 + k, 0]); }
  cmd(m, [0x03, 0xdf, 0x02]);            // SPECIFY：DMA 方式
}

function seek(m: Machine, cyl: number, head = 0): void {
  cmd(m, [0x0f, head << 2, cyl]);
  expect(m.cpu.io.in8(0x3f4) & 1).toBe(1); // 驱动器 0 在寻道
  wait(m);
  expect(irqCount(m)).toBe(true);
  cmd(m, [0x08]);
  expect(results(m)).toEqual([0x20 | (head << 2), cyl]);
}

describe('软驱控制器（82077）', () => {
  it('复位后有 4 个"就绪变化"中断；VERSION 返回 90h；没有中断时 SENSE INTERRUPT 返回无效', () => {
    const m = machine();
    resetFdc(m);
    cmd(m, [0x10]);
    expect(results(m)).toEqual([0x90]);
    cmd(m, [0x08]);
    expect(results(m)).toEqual([0x80]);
    cmd(m, [0x1f]);                      // 不存在的命令
    expect(results(m)).toEqual([0x80]);
  });

  it('寻道后经 DMA 读扇区（多磁道），结果里是下一个扇区的地址', () => {
    const m = machine();
    resetFdc(m);
    cmd(m, [0x07, 0x00]); wait(m); irqCount(m); cmd(m, [0x08]); expect(results(m)).toEqual([0x20, 0]); // RECALIBRATE
    seek(m, 5);
    // 读柱面 5、磁头 0、扇区 17 起的 4 个扇区：17、18，然后（MT）磁头 1 的 1、2
    dma(m, 0x46, 0x12000, 4 * 512);
    cmd(m, [0xe6, 0x00, 5, 0, 17, 2, 18, 0x1b, 0xff]);
    expect(m.cpu.io.in8(0x3f4) & 0x80).toBe(0);   // 执行中
    wait(m);
    expect(irqCount(m)).toBe(true);
    const lbaOf = (c: number, h: number, s: number) => (c * 2 + h) * 18 + s - 1;
    const at = (k: number) => m.mem[0x12000 + k * 512] | (m.mem[0x12000 + k * 512 + 1] << 8);
    expect([at(0), at(1), at(2), at(3)]).toEqual([lbaOf(5, 0, 17), lbaOf(5, 0, 18), lbaOf(5, 1, 1), lbaOf(5, 1, 2)]);
    expect(m.mem[0x12000 + 4 * 512]).toBe(0);     // DMA 到达终点就停
    expect(results(m)).toEqual([0x04, 0, 0, 5, 1, 3, 2]); // 正常结束（磁头 1）；下一个是 5/1/3
    expect(m.cpu.io.in8(0x08) & 0x04).toBe(0x04); // DMA 状态：2 号通道到达终点
  });

  it('经 DMA 写扇区，映像被改写；读到磁道末尾时报告 EN', () => {
    const m = machine();
    resetFdc(m);
    seek(m, 1);
    for (let k = 0; k < 512; k++) m.mem[0x3000 + k] = 0x5a;
    dma(m, 0x4a, 0x3000, 512);
    cmd(m, [0xc5, 0x00, 1, 0, 3, 2, 18, 0x1b, 0xff]);
    wait(m);
    expect(results(m)).toEqual([0, 0, 0, 1, 0, 4, 2]);
    const d = m.drives[0]!;
    expect(d.data[d.lba(1, 0, 3) * 512 + 100]).toBe(0x5a);
    expect(d.dirty).toBe(true);
    // DMA 给了 2 个扇区的计数，但 EOT = 18 只剩 1 个扇区（不是多磁道）：到了磁道末尾
    dma(m, 0x46, 0x4000, 1024);
    cmd(m, [0x46, 0x00, 1, 0, 18, 2, 18, 0x1b, 0xff]);
    wait(m);
    expect(results(m)).toEqual([0x40, 0x80, 0, 2, 0, 1, 2]);
  });

  it('柱面不对、扇区不存在时报错；READ ID 返回磁头所在的柱面', () => {
    const m = machine();
    resetFdc(m);
    seek(m, 2);
    dma(m, 0x46, 0x4000, 512);
    cmd(m, [0xe6, 0x00, 3, 0, 1, 2, 18, 0x1b, 0xff]); // 磁头在柱面 2，要读柱面 3
    wait(m);
    expect(results(m).slice(0, 3)).toEqual([0x40, 0x04, 0x10]);
    cmd(m, [0xe6, 0x00, 2, 0, 19, 2, 19, 0x1b, 0xff]); // 没有第 19 扇区
    wait(m);
    expect(results(m).slice(0, 2)).toEqual([0x40, 0x04]);
    cmd(m, [0x4a, 0x00]);
    wait(m);
    const id = results(m);
    expect([id[0], id[3], id[4], id[6]]).toEqual([0, 2, 0, 2]);
  });

  it('非 DMA 方式：数据经数据端口逐字节读', () => {
    const m = machine(), io = m.cpu.io;
    resetFdc(m);
    cmd(m, [0x03, 0xdf, 0x03]);          // ND = 1
    cmd(m, [0x46, 0x00, 0, 0, 1, 2, 1, 0x1b, 0xff]);
    wait(m);
    expect(io.in8(0x3f4)).toBe(0xf0);    // RQM | DIO | NDMA | CB
    const got: number[] = [];
    for (let k = 0; k < 512; k++) got.push(io.in8(0x3f5));
    expect([got[0], got[1], got[511]]).toEqual([0, 0, 0xa5]);
    expect(results(m)).toEqual([0x40, 0x80, 0, 1, 0, 1, 2]); // 非 DMA 没有终点信号：到了 EOT
  });

  it('换盘信号：放入软盘后为 1，寻道后清掉，换盘后又为 1；FORMAT TRACK 填充扇区', () => {
    const m = machine(), io = m.cpu.io;
    resetFdc(m);
    expect(io.in8(0x3f7) & 0x80).toBe(0x80);
    seek(m, 0);
    expect(io.in8(0x3f7) & 0x80).toBe(0);
    m.drives[0] = new Disk('B.IMG', floppy(), true);
    expect(io.in8(0x3f7) & 0x80).toBe(0x80);
    seek(m, 4);
    expect(io.in8(0x3f7) & 0x80).toBe(0);
    // 格式化柱面 4 磁头 1：18 个扇区的 ID
    const ids: number[] = [];
    for (let s = 1; s <= 18; s++) ids.push(4, 1, s, 2);
    m.mem.set(ids, 0x5000);
    dma(m, 0x4a, 0x5000, ids.length);
    cmd(m, [0x4d, 0x04, 2, 18, 0x54, 0xf6]);
    wait(m);
    expect(results(m)[0]).toBe(0x04);
    const d = m.drives[0]!;
    expect(d.data[d.lba(4, 1, 7) * 512]).toBe(0xf6);
    expect(d.data[d.lba(4, 0, 7) * 512]).not.toBe(0xf6);
  });

  it('BIOS 的 IRQ6 处理程序在 40:3E 的位 7 记下中断', () => {
    const m = machine();
    m.mem[0x43e] = 0;
    m.hle.handle(0x0e);
    expect(m.mem[0x43e] & 0x80).toBe(0x80);
  });
});
