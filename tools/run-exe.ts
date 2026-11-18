// 在虚拟 PC 上运行一个 DOS 可执行文件，报告它用到的中断、端口和屏幕输出
// 用法：node tools/run-exe.ts <文件> [命令行] [指令数上限] [截图.png]
// 和程序在同一个目录里的其他文件（字库、BGI 驱动等）都放进虚拟磁盘
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { saveScreenPng } from './png.ts';
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
  for (let c = 0; c < 80; c++) line += CP437[m.video.textCell(r * 80 + c)[0]];
  rows.push(line.trimEnd());
}
console.log('屏幕：\n' + rows.join('\n').replace(/\n+$/, ''));

// 图形模式：把画面存成 PNG
if (png && saveScreenPng(m, png)) console.log('截图：', png);
