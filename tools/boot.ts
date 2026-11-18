// 从磁盘映像启动虚拟 PC，运行一段时间后显示屏幕内容和用到的 BIOS 功能
// 用法：node tools/boot.ts <A: 映像> [C: 映像 或 -] [百万条指令数] [按键...]
//   按键：普通文字直接写；{F3} {ENTER} {ESC} {Y} 之类表示特殊键；每段按键之间运行一段时间
//   C: 写 new:64 表示新建一个 64MB 的空白硬盘；写 - 表示没有硬盘
//   {PNG} 把图形画面存成 PNG（文件名前缀用环境变量 PNG 指定）；CPU=8088/286/386 选 CPU
//   调试：WATCH=1 跑飞（执行 00 00 或跑到 A000 段以上）时打印之前的指令和最近的换段；WATCHAT=段:偏移 第一次执行到这里时打印；
//         DUMPAT=段:偏移 同时反汇编那里的代码；VIDEO=1 打印显卡状态；STATE=1 打印 CPU 状态；VEC=33 打印中断向量；DIS=段:偏移 反汇编
//   环境变量 ISO=光盘映像 放进 D:；BOOT=C 表示从硬盘启动；DISKS="映像2;映像3" 是依次换进 A: 的软盘，按键里写 {SWAP} 换下一张，{EJECT} 取出 A:
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Machine } from '../src/machine/machine.ts';
import { Disk, blankHardDisk } from '../src/machine/disk.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { CP437 } from '../src/ui/screen.ts';
import { bootProgram } from '../src/machine/boot.ts';
import { saveScreenPng } from './png.ts';
import { IsoDisk, BytesSource } from '../src/machine/iso.ts';

const [a, c = '-', millionsArg = '200', ...keys] = process.argv.slice(2);
const m = new Machine();
m.setCpu((process.env.CPU as '8088' | '286' | '386') || '386');
if (a && a !== '-') m.drives[0] = new Disk(basename(a), new Uint8Array(readFileSync(a)), true);
if (c.startsWith('new:')) m.drives[2] = new Disk('C.IMG', blankHardDisk(+c.slice(4)), false);
else if (c !== '-') m.drives[2] = new Disk(basename(c), new Uint8Array(readFileSync(c)), false);
// ISO=光盘映像：放进 D:（变成只读的 FAT16 硬盘）
if (process.env.ISO) m.drives[3] = new Disk(basename(process.env.ISO), new Uint8Array(0), false, await IsoDisk.open(new BytesSource(new Uint8Array(readFileSync(process.env.ISO))), basename(process.env.ISO)));
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
if (process.env.PORTS) {
  const io = m.cpu.io;
  const log: string[] = [];
  (globalThis as { __ports?: string[] }).__ports = log;
  m.cpu.io = {
    in8: p => { const v = io.in8(p); if ((p & 0xfff8) === 0x2f8 || (p & 0xfff8) === 0x3f8) log.push(`IN ${p.toString(16)}=${v.toString(16)}`); return v; },
    out8: (p, v) => { if ((p & 0xfff8) === 0x2f8 || (p & 0xfff8) === 0x3f8) log.push(`OUT ${p.toString(16)},${v.toString(16)}`); io.out8(p, v); },
  };
}
if (process.env.INT6) {
  const hle = m.hle.handle.bind(m.hle);
  let shown = 0;
  const { disassemble: dis6 } = await import('../src/cpu/disasm.ts');
  m.hle.handle = (n: number) => {
    if (n === 6 && shown++ < 3) {
      const ss = m.cpu.s[2], sp = m.cpu.r[4];
      const ip = m.mem[ss * 16 + sp] | (m.mem[ss * 16 + sp + 1] << 8), cs = m.mem[ss * 16 + sp + 2] | (m.mem[ss * 16 + sp + 3] << 8);
      const read = (o: number) => m.mem[((cs << 4) + (o & 0xffff)) & 0xfffff];
      console.log(`INT 6 在 ${cs.toString(16)}:${ip.toString(16)}：${dis6(read, ip, true).text}，字节 ${[...m.mem.subarray(cs * 16 + ip, cs * 16 + ip + 10)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      console.log('之前的字节：' + [...m.mem.subarray(cs * 16 + ip - 16, cs * 16 + ip)].map(b => b.toString(16).padStart(2, '0')).join(' ')); let o = Math.max(0, ip - 24); const lines: string[] = [];
      for (let k = 0; k < 14; k++) { const ins = dis6(read, o, true); lines.push(`  ${cs.toString(16)}:${o.toString(16).padStart(4, '0')} ${ins.text}`); o += ins.length; }
      console.log(lines.join('\n'));
    }
    return hle(n);
  };
}
m.load(bootProgram(process.env.BOOT === 'C' ? 0x80 : 0));
// WATCH=1：CPU 第一次跑到 A000 段以上（又不是 BIOS 的 F000 段）时，打印最近执行过的 40 条指令的位置
if (process.env.WATCH) {
  const cpu = m.cpu as unknown as { step(): void; s: Uint16Array; ip: number };
  const orig = cpu.step.bind(cpu);
  const recent: string[] = [];
  let reported = false, zeros = 0;
  const watchInt = process.env.WATCHINT ? process.env.WATCHINT.split(':').map(x => parseInt(x, 16)) : null;
  const watchAt = process.env.WATCHAT ? process.env.WATCHAT.split(':').map(x => parseInt(x, 16)) : null;
  const { disassemble } = await import('../src/cpu/disasm.ts');
  cpu.step = () => {
    const cs = cpu.s[1], ip = cpu.ip;
    const cbase = m.cpu.segBase(1), lin = (cbase + ip) & 0xffffff;
    zeros = m.mem[lin] === 0 && m.mem[lin + 1] === 0 ? zeros + 1 : 0;
    if (!reported && ((cs >= 0xa000 && cs !== 0xf000) || zeros >= 4 || (watchAt && cs === watchAt[0] && ip === watchAt[1]) || (watchInt && m.mem[lin] === 0xcd && m.mem[lin + 1] === watchInt[0] && (m.cpu.r[0] >> 8) === watchInt[1]))) {
      reported = true;
      console.log(`跑到了 ${cs.toString(16)}:${ip.toString(16)}，之前执行的指令：\n` + recent.slice(0, recent.length - 3).join('\n'));
      if (process.env.DUMPAT) { const [ds, dofs] = process.env.DUMPAT.split(':').map(x => parseInt(x, 16)); const rd = (o: number) => m.mem[((ds << 4) + (o & 0xffff)) & 0xfffff]; let o = dofs; const out: string[] = []; for (let k = 0; k < 16; k++) { const ins = disassemble(rd, o); out.push(`  ${ds.toString(16)}:${o.toString(16)}  ${ins.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(18)} ${ins.text}`); o += ins.length; } console.log('触发时的代码：\n' + out.join('\n')); }
      const r = m.cpu.r, s = m.cpu.s;
      console.log(`寄存器：AX=${r[0].toString(16)} BX=${r[3].toString(16)} CX=${r[1].toString(16)} DX=${r[2].toString(16)} SP=${r[4].toString(16)} BP=${r[5].toString(16)} SI=${r[6].toString(16)} DI=${r[7].toString(16)} ES=${s[0].toString(16)} CS=${s[1].toString(16)} SS=${s[2].toString(16)} DS=${s[3].toString(16)}`);
    }
    const read = (o: number) => m.mem[(cbase + (o & 0xffff)) & 0xffffff];
    const text = disassemble(read, ip).text;
    recent.push(`${cs.toString(16).padStart(4, '0')}:${ip.toString(16).padStart(4, '0')}  ${text}`);
    if (recent.length > 60) recent.shift();
    tailLog.length = 0; tailLog.push(...recent);
    orig();
    if (cpu.s[1] !== cs && !reported) {
      jumps.push(`${cs.toString(16)}:${ip.toString(16)} ${text} -> ${cpu.s[1].toString(16)}:${cpu.ip.toString(16)}`);
      if (jumps.length > 30) jumps.shift();
    }
    if (reported && !shownJumps) { shownJumps = true; console.log('最近 30 次换代码段：\n' + jumps.join('\n')); }
  };
}
let shownJumps = false;
const tailLog: string[] = [];
(globalThis as { __tail?: string[] }).__tail = tailLog;
const jumps: string[] = [];

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
let pngNo = 0;
const swaps = (process.env.DISKS ?? '').split(';').filter(Boolean);
const t0 = Date.now();
run(+millionsArg);
for (const k of keys) {
  for (const part of k.split(/(\{[A-Z0-9:,-]+\})/).filter(Boolean)) {
    const sp = /^\{([A-Z0-9]+)\}$/.exec(part);
    if (part === '{SWAP}') { const p = swaps.shift()!; m.drives[0] = new Disk(basename(p), new Uint8Array(readFileSync(p)), true); console.log('换盘：', basename(p)); continue; }
    if (part === '{EJECT}') { m.drives[0] = null; console.log('取出 A: 的软盘'); continue; }
    if (part === '{PNG}') { const f = `${process.env.PNG ?? 'screen'}-${++pngNo}.png`; console.log(saveScreenPng(m, f) ? '截图：' + f : '（文本模式，没有截图）'); continue; }
    const mv = /^\{MOVE:(-?\d+),(-?\d+)\}$/.exec(part);
    if (mv) { for (let k = 0; k < 10; k++) { m.mouse.moveRel(+mv[1] / 10, +mv[2] / 10); run(1); } continue; }
    if (part === '{CLICK}') { m.mouse.queueButtons(1, m.clock); run(2); m.mouse.queueButtons(0, m.clock); run(2); continue; }
    if (part === '{SHOT}') { console.log('屏幕：\n' + screen()); continue; }
    const alt = /^\{ALT:([A-Z])\}$/.exec(part);
    if (alt) { // Alt + 字母
      const sc = scanForChar(alt[1].toLowerCase());
      m.pressKey({ scan: 0x38, ascii: 0, release: false });
      m.pressKey({ scan: sc, ascii: 0, release: false });
      m.pressKey({ scan: sc | 0x80, ascii: 0, release: true });
      m.pressKey({ scan: 0xb8, ascii: 0, release: true });
      continue;
    }
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
if (process.env.VIDEO) {
  const v = m.video, pl = v.planar;
  const nz = pl.planes.map(p => p.reduce((n, b) => n + (b ? 1 : 0), 0));
  console.log('平面里非零字节：', nz.join(' / '), '；属性寄存器：', [...v.attr].map(x => x.toString(16)).join(' '));
  console.log('DAC 前 16 色：', Array.from({ length: 16 }, (_, i) => [...v.dac.subarray(i * 3, i * 3 + 3)].join(',')).join(' | '));
  console.log('图形控制器：', [...pl.gc.subarray(0, 9)].map(x => x.toString(16)).join(' '), '；定序器：', [...pl.seq.subarray(0, 5)].map(x => x.toString(16)).join(' '), '；PEL 屏蔽', v.pelMask.toString(16));
}
if (process.env.STATE) {
  const c = m.cpu;
  console.log(`CPU：halted=${c.halted} waiting=${c.waiting} IF=${(c.flags >> 9) & 1} FLAGS=${c.flags.toString(16)} 保护模式=${c.protectedMode} CPL=${c.cpl} 中断次数=${c.interrupts} A20=${c.a20Enabled}；状态 ${m.status} ${m.message}`);
  const lin = (c.s[1] << 4) + c.ip;
  console.log('CS:IP 处的字节：', [...m.mem.subarray(lin, lin + 16)].map(b => b.toString(16).padStart(2, '0')).join(' '));
}

if (process.env.WATCH) console.log('最后执行的指令：\n' + ((globalThis as { __tail?: string[] }).__tail ?? []).slice(-40).join('\n'));

if (process.env.PORTS) { const l = (globalThis as { __ports?: string[] }).__ports ?? []; console.log('串口访问（共 ' + l.length + ' 次）：' + l.slice(0, 200).join(' ')); }
if (process.env.CONSOLE) console.log('输出的文字：' + JSON.stringify(m.console.slice(-600)));
