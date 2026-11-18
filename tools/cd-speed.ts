// 测光驱（ATAPI + DOS 光驱驱动 + MSCDEX）的读取速度：从启动盘启动，在 DOS 提示符下把光盘上的一个文件复制到 NUL，
// 报告这次复制用了多少条指令、多少虚拟时间，以及光驱的端口访问次数
// 用法：node tools/cd-speed.ts <启动软盘> <光盘映像> <光盘上的文件> [菜单按键]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Machine } from '../src/machine/machine.ts';
import { Disk } from '../src/machine/disk.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { CP437 } from '../src/ui/screen.ts';
import { BytesSource } from '../src/machine/iso.ts';

const [floppy, iso, file, menu = '1'] = process.argv.slice(2);
const m = new Machine();
m.setCpu('386');
m.drives[0] = new Disk(basename(floppy), new Uint8Array(readFileSync(floppy)), true);
m.cdrom.insert(new BytesSource(new Uint8Array(readFileSync(iso))), basename(iso));
const { bootProgram } = await import('../src/machine/boot.ts');
m.load(bootProgram(0));
const ports = new Map<number, number>();
const io = m.cpu.io, in8 = io.in8, out8 = io.out8, in16 = io.in16!;
io.in8 = p => { ports.set(p, (ports.get(p) ?? 0) + 1); return in8(p); };
io.out8 = (p, v) => { ports.set(p, (ports.get(p) ?? 0) + 1); out8(p, v); };
io.in16 = p => { ports.set(p | 0x10000, (ports.get(p | 0x10000) ?? 0) + 1); return in16(p); };
const screen = () => { let s = ''; for (let k = 0; k < 2000; k++) s += CP437[m.video.textCell(k)[0]]; return s; };
const run = (n: number) => { const end = m.instructions + n; while (m.instructions < end) m.run(100_000); };
run(30e6);
m.typeText(menu + '\r', scanForChar);
run(30e6);
ports.clear();
m.typeText(`copy ${file} nul\r`, scanForChar);
const i0 = m.instructions, c0 = m.clock, t0 = Date.now();
while (!screen().includes('copied')) { run(200_000); if (m.instructions - i0 > 3e9) break; }
const di = m.instructions - i0, dt = (m.clock - c0) / 1193182;
console.log(`复制 ${file}：${(di / 1e6).toFixed(1)} 百万条指令，虚拟时间 ${dt.toFixed(2)} 秒，实际 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
console.log('端口：', [...ports].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `${p > 0xffff ? 'IN16 ' : ''}${(p & 0xffff).toString(16)}h×${n}`).join('，'));
