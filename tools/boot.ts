// 从磁盘映像启动虚拟 PC，运行一段时间后显示屏幕内容和用到的 BIOS 功能
// 用法：node tools/boot.ts <A: 映像> [C: 映像 或 -] [百万条指令数] [按键...]
//   按键：普通文字直接写；{F3} {ENTER} {ESC} {Y} 之类表示特殊键；每段按键之间运行一段时间
//   C: 写 new:64 表示新建一个 64MB 的空白硬盘；写 - 表示没有硬盘
//   环境变量 BOOT=C 表示从硬盘启动；DISKS="映像2;映像3" 是依次换进 A: 的软盘，按键里写 {SWAP} 换下一张，{EJECT} 取出 A:
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Machine } from '../src/machine/machine.ts';
import { Disk, blankHardDisk } from '../src/machine/disk.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { CP437 } from '../src/ui/screen.ts';
import { bootProgram } from '../src/machine/boot.ts';

const [a, c = '-', millionsArg = '200', ...keys] = process.argv.slice(2);
const m = new Machine();
m.setCpu('386');
if (a && a !== '-') m.drives[0] = new Disk(basename(a), new Uint8Array(readFileSync(a)), true);
if (c.startsWith('new:')) m.drives[2] = new Disk('C.IMG', blankHardDisk(+c.slice(4)), false);
else if (c !== '-') m.drives[2] = new Disk(basename(c), new Uint8Array(readFileSync(c)), false);
const logs: string[] = [];
m.events.log = s => logs.push(s);
const ints = new Map<string, number>();
const hle = m.hle.handle.bind(m.hle);
m.hle.handle = (n: number) => {
  const ah = m.cpu.r[0] >> 8;
  const key = `INT ${n.toString(16)}h AH=${ah.toString(16)}h`;
  ints.set(key, (ints.get(key) ?? 0) + 1);
  return hle(n);
};
m.load(bootProgram(process.env.BOOT === 'C' ? 0x80 : 0));

const SPECIAL: Record<string, [number, number]> = {
  ENTER: [0x1c, 13], ESC: [0x01, 27], TAB: [0x0f, 9], BS: [0x0e, 8], SPACE: [0x39, 32],
  F1: [0x3b, 0], F2: [0x3c, 0], F3: [0x3d, 0], F4: [0x3e, 0], F5: [0x3f, 0], F6: [0x40, 0], F7: [0x41, 0], F8: [0x42, 0],
  UP: [0x48, 0], DOWN: [0x50, 0], LEFT: [0x4b, 0], RIGHT: [0x4d, 0],
};
const run = (millions: number) => {
  const end = m.instructions + millions * 1e6;
  while (m.instructions < end) {
    const r = m.run(500_000);
    if (r === 'exit' || r === 'error') { console.log('停止：', r, m.message); return false; }
  }
  return true;
};
const screen = () => {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = '';
    for (let col = 0; col < 80; col++) line += CP437[m.mem[0xb8000 + (r * 80 + col) * 2]];
    rows.push(line.trimEnd());
  }
  return rows.join('\n').replace(/\n+$/, '');
};
const swaps = (process.env.DISKS ?? '').split(';').filter(Boolean);
const t0 = Date.now();
run(+millionsArg);
for (const k of keys) {
  for (const part of k.split(/(\{[A-Z0-9]+\})/).filter(Boolean)) {
    const sp = /^\{([A-Z0-9]+)\}$/.exec(part);
    if (part === '{SWAP}') { const p = swaps.shift()!; m.drives[0] = new Disk(basename(p), new Uint8Array(readFileSync(p)), true); console.log('换盘：', basename(p)); continue; }
    if (part === '{EJECT}') { m.drives[0] = null; console.log('取出 A: 的软盘'); continue; }
    if (part === '{SHOT}') { console.log('屏幕：\n' + screen()); continue; }
    if (sp && SPECIAL[sp[1]]) { m.pressKey({ scan: SPECIAL[sp[1]][0], ascii: SPECIAL[sp[1]][1], release: false }); m.pressKey({ scan: SPECIAL[sp[1]][0] | 0x80, ascii: 0, release: true }); }
    else m.typeText(part, scanForChar);
  }
  run(+millionsArg);
}
console.log(`执行了 ${(m.instructions / 1e6).toFixed(1)} 百万条指令（${((Date.now() - t0) / 1000).toFixed(1)} 秒），虚拟时间 ${(m.clock / 1193182).toFixed(1)} 秒，CS:IP=${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}，模式 ${m.mem[0x449].toString(16)}h`);
console.log('BIOS/DOS 调用：', [...ints].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, v]) => `${k}×${v}`).join('，'));
console.log('提示：', logs.join(' | ') || '无');
console.log('屏幕：\n' + screen());
if (process.env.SAVE_C && m.drives[2]) { writeFileSync(process.env.SAVE_C, m.drives[2].data); console.log('硬盘映像已保存到', process.env.SAVE_C); }
if (process.env.DIS) {
  const { disassemble } = await import('../src/cpu/disasm.ts');
  const [segs, offs] = process.env.DIS.split(':');
  const seg = parseInt(segs, 16); let off = parseInt(offs, 16);
  const read = (o: number) => m.mem[((seg << 4) + (o & 0xffff)) & 0xfffff];
  for (let i = 0; i < 40; i++) { const ins = disassemble(read, off); console.log(`${seg.toString(16)}:${off.toString(16).padStart(4, '0')}  ${ins.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(20)} ${ins.text}`); off += ins.length; }
}
if (process.env.VEC) {
  const n = parseInt(process.env.VEC, 16), off = m.mem[n * 4] | (m.mem[n * 4 + 1] << 8), seg = m.mem[n * 4 + 2] | (m.mem[n * 4 + 3] << 8);
  console.log(`INT ${n.toString(16)}h -> ${seg.toString(16)}:${off.toString(16)}，开头的字节：${[...m.mem.subarray(seg * 16 + off, seg * 16 + off + 8)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}
