import { describe, it, expect } from 'vitest';
import { Machine } from '../src/machine/machine.ts';
import { BytesSource, BlobSource, type IsoSource } from '../src/machine/iso.ts';
import { buildIso } from '../tools/mkiso.ts';

// 像驱动程序（OAKCDROM.SYS、Windows 95 的 ESDI_506）那样经端口操作 IDE 第二通道上的 ATAPI 光驱

const iso = buildIso([{ path: 'README.TXT', data: Uint8Array.from('hello from the CD', c => c.charCodeAt(0)) }], 'TESTCD');

function machine(src: IsoSource = new BytesSource(iso)): Machine {
  const m = new Machine();
  m.setCpu('386');
  m.cdrom.insert(src, 'TEST.ISO');
  return m;
}

/** 发一个命令包，返回读到的数据和最后的状态、错误寄存器 */
function packet(m: Machine, cmd: number[], limit = 0xfffe): { data: number[]; status: number; error: number } {
  const io = m.cpu.io;
  io.out8(0x176, 0xa0);                       // 选主盘
  io.out8(0x174, limit & 0xff); io.out8(0x175, limit >> 8);
  io.out8(0x177, 0xa0);                       // PACKET
  expect(io.in8(0x376) & 0x08).toBe(0x08);    // DRQ：等命令包
  expect(io.in8(0x172) & 3).toBe(1);          // C/D = 1
  const p = [...cmd, ...new Array(12).fill(0)].slice(0, 12);
  for (let k = 0; k < 12; k += 2) io.out16!(0x170, p[k] | (p[k + 1] << 8));
  const data: number[] = [];
  for (let guard = 0; guard < 1000; guard++) {
    const st = io.in8(0x376);
    if (st & 0x80) return { data, status: st, error: io.in8(0x171) }; // 忙：调用者自己处理
    if (!(st & 0x08)) return { data, status: st, error: io.in8(0x171) };
    const n = io.in8(0x174) | (io.in8(0x175) << 8);
    expect(io.in8(0x172) & 3).toBe(2);        // I/O = 1：数据
    for (let k = 0; k < n; k += 2) { const w = io.in16!(0x170); data.push(w & 0xff, w >> 8); }
  }
  throw new Error('数据阶段没有结束');
}

describe('ATAPI 光驱（IDE 第二通道）', () => {
  it('复位后寄存器里是 ATAPI 签名；IDENTIFY DEVICE 被中止，IDENTIFY PACKET DEVICE 返回光驱的信息', () => {
    const m = machine(), io = m.cpu.io;
    io.out8(0x176, 0xa0);
    expect([io.in8(0x172), io.in8(0x173), io.in8(0x174), io.in8(0x175)]).toEqual([1, 1, 0x14, 0xeb]);
    io.out8(0x177, 0xec);
    expect(io.in8(0x177) & 1).toBe(1);        // ERR
    expect([io.in8(0x174), io.in8(0x175)]).toEqual([0x14, 0xeb]);
    io.out8(0x177, 0xa1);
    expect(io.in8(0x177) & 0x08).toBe(0x08);
    const w: number[] = [];
    for (let k = 0; k < 256; k++) w.push(io.in16!(0x170));
    expect(w[0]).toBe(0x85c0);
    const model = w.slice(27, 47).map(x => String.fromCharCode(x >> 8, x & 0xff)).join('').trim();
    expect(model).toBe('ASMPERFECT VIRTUAL CD-ROM');
    expect(io.in8(0x177) & 0x08).toBe(0);     // 传完了
    // 从盘不存在
    io.out8(0x176, 0xb0);
    expect(io.in8(0x177)).toBe(0);
  });

  it('INQUIRY、换盘后的 TEST UNIT READY / REQUEST SENSE、READ CAPACITY、READ(10)，并发出 IRQ15', () => {
    const m = machine();
    const inq = packet(m, [0x12, 0, 0, 0, 36]);
    expect(inq.data[0]).toBe(0x05);           // 光驱
    expect(String.fromCharCode(...inq.data.slice(16, 30)).trim()).toBe('VIRTUAL CD-ROM');
    expect(m.pic2.irr & 0x80).toBe(0x80);     // IRQ15
    const tur = packet(m, [0x00]);
    expect(tur.status & 1).toBe(1);           // 刚放入光盘：检查条件
    const sense = packet(m, [0x03, 0, 0, 0, 18]);
    expect([sense.data[2] & 0x0f, sense.data[12]]).toEqual([6, 0x28]); // 换过盘
    expect(packet(m, [0x00]).status & 1).toBe(0);
    const cap = packet(m, [0x25]);
    const last = (cap.data[0] << 24) | (cap.data[1] << 16) | (cap.data[2] << 8) | cap.data[3];
    expect(last).toBe(iso.length / 2048 - 1);
    expect((cap.data[6] << 8) | cap.data[7]).toBe(2048);
    const rd = packet(m, [0x28, 0, 0, 0, 0, 16, 0, 0, 1]);
    expect(rd.data.length).toBe(2048);
    expect(String.fromCharCode(...rd.data.slice(1, 6))).toBe('CD001');
    expect(rd.status & 0x41).toBe(0x40);      // 完成、没有错误
    const toc = packet(m, [0x43, 0, 0, 0, 0, 0, 0, 0, 20]);
    expect([toc.data[2], toc.data[3], toc.data[14]]).toEqual([1, 1, 0xaa]);
  });

  it('没有光盘时报告"没有介质"；读超出光盘的扇区报错', () => {
    const m = machine();
    m.cdrom.eject();
    expect(packet(m, [0x00]).status & 1).toBe(1);
    expect(packet(m, [0x03, 0, 0, 0, 18]).data[12]).toBe(0x3a);
    m.cdrom.insert(new BytesSource(iso), 'TEST.ISO');
    packet(m, [0x00]);                        // 消掉"换过盘"
    expect(packet(m, [0x28, 0, 0, 0x10, 0, 0, 0, 0, 1]).status & 1).toBe(1);
  });

  it('光盘映像在浏览器的文件里（按需读）：数据没读出来时报告忙，读到后继续', async () => {
    const m = machine(new BlobSource(new Blob([iso.slice()])));
    packet(m, [0x00]);                        // 消掉"换过盘"
    const first = packet(m, [0x28, 0, 0, 0, 0, 16, 0, 0, 1]);
    expect(first.status & 0x80).toBe(0x80);   // 忙
    for (let k = 0; k < 20 && m.cdrom.pending === false; k++) await new Promise(r => setTimeout(r, 1));
    m.cdrom.poll();
    const io = m.cpu.io;
    expect(io.in8(0x177) & 0x08).toBe(0x08);
    const bytes: number[] = [];
    for (let k = 0; k < 1024; k++) { const w = io.in16!(0x170); bytes.push(w & 0xff, w >> 8); }
    expect(String.fromCharCode(...bytes.slice(1, 6))).toBe('CD001');
    expect(io.in8(0x177) & 0x41).toBe(0x40);
  });
});
