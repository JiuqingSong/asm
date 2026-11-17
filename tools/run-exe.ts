// 在虚拟 PC 上运行一个 DOS 可执行文件，报告它用到的中断、端口和屏幕输出
// 用法：node tools/run-exe.ts <文件> [命令行] [指令数上限] [截图.png]
// 和程序在同一个目录里的其他文件（字库、BGI 驱动等）都放进虚拟磁盘
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { modeInfo } from '../src/machine/video.ts';
import { Machine } from '../src/machine/machine.ts';
import { loadExecutable } from '../src/machine/exe.ts';
import { AX } from '../src/cpu/cpu.ts';
import { CP437 } from '../src/ui/screen.ts';

const [file, cmd = '', limitArg = '50000000', png = ''] = process.argv.slice(2);
const { program, info } = loadExecutable(new Uint8Array(readFileSync(file)), basename(file));
console.log('文件信息：', info);
const m = new Machine();
m.setCpu('386');
const ints = new Map<string, number>();
const logs: string[] = [];
m.events.log = s => logs.push(s);
const hle = m.hle.handle.bind(m.hle);
m.hle.handle = (n: number) => {
  const ah = m.cpu.r[AX] >> 8;
  const key = [0x10, 0x16, 0x21, 0x1a, 0x33].includes(n) ? `INT ${n.toString(16)}h AH=${ah.toString(16)}h` : `INT ${n.toString(16)}h`;
  ints.set(key, (ints.get(key) ?? 0) + 1);
  return hle(n);
};
const ports = new Map<string, number>();
const io = m.cpu.io;
m.cpu.io = {
  in8: p => { const k = `IN ${p.toString(16)}h`; ports.set(k, (ports.get(k) ?? 0) + 1); return io.in8(p); },
  out8: (p, v) => { const k = `OUT ${p.toString(16)}h`; ports.set(k, (ports.get(k) ?? 0) + 1); io.out8(p, v); },
};
m.load(program, cmd, basename(file));
const dir = dirname(file);
for (const n of readdirSync(dir)) {
  const p = join(dir, n);
  if (statSync(p).isFile() && n.toUpperCase() !== basename(file).toUpperCase()) m.files.set(n.toUpperCase(), new Uint8Array(readFileSync(p)));
}
const limit = +limitArg;
let r = '';
while (m.instructions < limit) {
  r = m.run(1_000_000);
  if (r !== 'budget') break;
}
console.log(`停止：${r} ${m.status} ${m.message}；执行了 ${m.instructions.toLocaleString()} 条指令；CS:IP=${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}；显示模式 ${m.mem[0x449].toString(16)}h`);
console.log('中断：', [...ints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}×${v}`).join('，'));
console.log('端口：', [...ports.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}×${v}`).join('，'));
console.log('提示：', logs.join(' | ') || '无');
const rows: string[] = [];
for (let r = 0; r < 25; r++) {
  let line = '';
  for (let c = 0; c < 80; c++) line += CP437[m.mem[0xb8000 + (r * 80 + c) * 2]];
  rows.push(line.trimEnd());
}
console.log('屏幕：\n' + rows.join('\n').replace(/\n+$/, ''));

// 图形模式：把画面存成 PNG
const vi = modeInfo(m.mem[0x449]);
if (png && vi.graphics) {
  const { width: w, height: h } = vi, v = m.video;
  const rgb = (i: number) => { const k = (i & v.pelMask) * 3; return [v.dac[k], v.dac[k + 1], v.dac[k + 2]].map(c => (c << 2) | (c >> 4)); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c: number[];
      if (vi.planar) c = rgb(v.dacIndex(v.planar.pixel(y * (w >> 3) + (x >> 3), x & 7)));
      else if (vi.bpp === 8) c = rgb(m.mem[0xa0000 + y * 320 + x]);
      else { const ppb = 8 / vi.bpp, b = m.mem[0xb8000 + (y & 1) * 0x2000 + (y >> 1) * 80 + Math.floor(x / ppb)]; const idx = (b >> ((ppb - 1 - (x % ppb)) * vi.bpp)) & ((1 << vi.bpp) - 1); c = [idx * 85, idx * 85, idx * 85]; }
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log('截图：', png);
}
