import { describe, it, expect } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { Machine } from '../src/machine/machine.ts';
import { DEFAULT_CONFIG, CONFIG_OPTIONS } from '../src/machine/config.ts';
import { Disk, blankFloppy } from '../src/machine/disk.ts';
import { bootProgram } from '../src/machine/boot.ts';

const program = () => assemble('.model tiny\n.code\norg 100h\nstart: cli\nhlt\nend start');
function bootDisk(): Disk {
  const data = blankFloppy();
  data.set([0xcd, 0x33, 0xfa, 0xf4]);
  data.set([0x55, 0xaa], 510);
  return new Disk('BOOT.IMG', data, true);
}
const vector = (m: Machine, n: number) => [...m.mem.subarray(n * 4, n * 4 + 4)];

describe('可选的硬件和预设环境', () => {
  it('关闭 DOS 不生成 PSP、环境变量或 DOS 中断；仍能装载和执行自己的代码', () => {
    const m = new Machine({ dos: false });
    const p = program();
    expect(p.ok).toBe(true);
    m.load(p);
    expect(vector(m, 0x21)).toEqual([0, 0, 0, 0]);
    expect(vector(m, 0x20)).toEqual([0, 0, 0, 0]);
    expect([...m.mem.subarray(p.pspSeg * 16, p.pspSeg * 16 + 4)]).toEqual([0, 0, 0, 0]);
    expect(m.mem[(p.pspSeg - 0x11) * 16]).toBe(0);
    m.run(10);
    expect(m.cpu.halted).toBe(true);
  });

  it('关闭 BIOS 不安装 BIOS 向量、ROM 标志或数据区，不影响单独启用的 DOS', () => {
    const m = new Machine({ bios: false });
    m.load(program());
    expect(vector(m, 0x10)).toEqual([0, 0, 0, 0]);
    expect(vector(m, 0x13)).toEqual([0, 0, 0, 0]);
    expect(m.mem[0xc0000]).toBe(0);
    expect(m.mem[0xffff0]).toBe(0);
    expect(m.mem[0x413]).toBe(0);
    expect(vector(m, 0x21)).not.toEqual([0, 0, 0, 0]);
  });

  it.each([
    ['com1', 0x3fb], ['com2', 0x2fb], ['pic', 0x21], ['slavePic', 0xa1],
    ['pit', 0x40], ['keyboard', 0x64], ['dma', 0x0a], ['rtc', 0x71],
    ['vga', 0x3c4], ['fdc', 0x3f4], ['ide', 0x1f7], ['cdrom', 0x177],
  ] as const)('关闭 %s 后端口不再响应，写入不会唤醒设备', (key, port) => {
    const m = new Machine({ [key]: false });
    m.load(program());
    const warnings: string[] = [];
    m.events.log = s => warnings.push(s);
    m.cpu.io.out8(port, 0x55);
    expect(m.cpu.io.in8(port)).toBe(0xff);
    expect(warnings).toHaveLength(1);
    if (key === 'ide' || key === 'cdrom') {
      const data = key === 'ide' ? 0x1f0 : 0x170;
      expect(m.cpu.io.wide!(data)).toBe(false);
      m.cpu.io.out16!(data, 0x1234);
      expect(m.cpu.io.in16!(data)).toBe(0xffff);
    }
  });

  it('关闭设备时 BIOS、CMOS、磁盘入口与端口一致，保留未连接的映像', () => {
    const m = new Machine({ floppyB: false, ide: false });
    const disk = bootDisk();
    m.drives[1] = disk;
    m.drives[2] = new Disk('HD', new Uint8Array(1024 * 1024), false);
    m.load(program());
    expect(m.mem[0x410] & 0xc1).toBe(1);
    expect(m.mem[0x475]).toBe(0);
    expect(m.cmos[0x10]).toBe(0x40);
    expect(m.cmos[0x12]).toBe(0);
    expect(m.driveFor(1)).toBeNull();
    expect(m.driveFor(0x80)).toBeNull();
    expect(m.drives[1]).toBe(disk);
    m.cpu.r[0] = 0x0800;
    m.cpu.r[2] = 1;
    m.hle.handle(0x13);
    expect(m.cpu.r[0] >> 8).not.toBe(0);
  });

  it('关闭内置驱动不影响 Microsoft 串口鼠标；关闭 COM2 后不再连接鼠标', () => {
    const m = new Machine({ mouseDriver: false });
    m.load(program());
    expect(vector(m, 0x33)).toEqual([0, 0, 0, 0]);
    expect(m.mem[0xf0198]).toBe(0);
    expect(m.com2.peer).toBe(m.serialMouse);
    expect(new Machine({ com2: false }).com2.peer).toBeNull();
    const other = new Machine({ serialMouse: false });
    other.load(program());
    expect(other.com2.peer).toBeNull();
    expect(vector(other, 0x33)).not.toEqual([0, 0, 0, 0]);
  });

  it('磁盘引导不残留 DOS 或内置鼠标服务；客体可以自己安装中断处理程序', () => {
    const m = new Machine();
    m.drives[0] = bootDisk();
    m.load(bootProgram(0));
    expect(vector(m, 0x21)).toEqual([0, 0, 0, 0]);
    expect(vector(m, 0x33)).toEqual([0, 0, 0, 0]);
    expect(m.mem[0xf0198]).toBe(0);
    m.mem.set([0xb8, 0x34, 0x12, 0xcf], 0x800);
    m.mem.set([0, 8, 0, 0], 0x33 * 4);
    m.run(30);
    expect(m.cpu.r[0]).toBe(0x1234);
    m.ctrlAltDel();
    expect(m.cpu.ip).toBe(0x7c00);
    expect(vector(m, 0x33)).toEqual([0, 0, 0, 0]);
  });

  it('不把缺少介质的显式 A: 启动偷偷改为硬盘启动', () => {
    const m = new Machine();
    m.drives[2] = bootDisk();
    expect(() => m.load(bootProgram(0))).toThrow(/A:.*没有/);
  });

  it('启动选择失败不破坏原来可继续运行的客体环境', () => {
    const m = new Machine({ cdrom: false });
    m.drives[0] = bootDisk();
    const p = bootProgram(0);
    m.load(p);
    m.mem[0x800] = 0x5a;
    const before = m.mem.slice();
    for (const drive of [0x80, 0xe0]) expect(() => m.load(bootProgram(drive))).toThrow();
    m.drives[0] = new Disk('BLANK.IMG', new Uint8Array(1440 * 1024), true);
    expect(() => m.load(bootProgram(0))).toThrow(/55AA/);
    expect(m.program).toBe(p);
    expect(m.mem.every((v, i) => v === before[i])).toBe(true);
    expect(m.cpu.ip).toBe(0x7c00);
  });

  it('没有定时器或 PIC 时不投递定时中断；没有 VGA 时显存窗口不变成 RAM', () => {
    const config = { ...DEFAULT_CONFIG };
    for (const { key } of CONFIG_OPTIONS) config[key] = false;
    const m = new Machine(config);
    const p = program();
    m.load(p);
    m.cpu.wb(0xb800, 0, 65);
    expect(m.cpu.rb(0xb800, 0)).toBe(0xff);
    m.run(100);
    expect(m.cpu.irq!.pending()).toBe(false);
    expect(Number.isFinite(m.clock)).toBe(true);
    expect(m.cpu.halted).toBe(true);
  });

  it('关闭 VGA 不留下显示 BIOS、字体向量或活动显示模式的数据', () => {
    const m = new Machine({ vga: false });
    m.load(program());
    for (const n of [0x10, 0x1f, 0x43]) expect(vector(m, n)).toEqual([0, 0, 0, 0]);
    for (const a of [0xc0000, 0x449, 0x44a, 0x463, 0x484, 0x487]) expect(m.mem[a]).toBe(0);
  });
});
