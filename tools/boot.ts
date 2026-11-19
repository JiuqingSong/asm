// 从磁盘映像启动虚拟 PC，运行一段时间后显示屏幕内容和用到的 BIOS 功能
// 用法：node tools/boot.ts <A: 映像> [C: 映像 或 -] [百万条指令数] [按键...]
//   按键：普通文字直接写；{F3} {ENTER} {ESC} {Y} 之类表示特殊键；每段按键之间运行一段时间
//   C: 写 new:64 表示新建一个 64MB 的空白硬盘；写 - 表示没有硬盘
//   {PNG} 把图形画面存成 PNG（文件名前缀用环境变量 PNG 指定）；CPU=8088/286/386 选 CPU
//   调试：WATCH=1 跑飞（执行 00 00 或跑到 A000 段以上）时打印之前的指令和最近的换段；WATCHAT=段:偏移 第一次执行到这里时打印；
//         DUMPAT=段:偏移 同时反汇编那里的代码；VIDEO=1 打印显卡状态；STATE=1 打印 CPU 状态；VEC=33 打印中断向量；DIS=段:偏移 反汇编
//   环境变量 ISO=光盘映像 放进 D:；CD=光盘映像 放进光驱；BOOT=C 表示从硬盘启动，BOOT=CD 从光驱启动；DISKS="映像2;映像3" 是依次换进 A: 的软盘，按键里写 {SWAP} 换下一张，{EJECT} 取出 A:
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Machine } from '../src/machine/machine.ts';
import { Disk, blankHardDisk } from '../src/machine/disk.ts';
import { scanForChar } from '../src/machine/devices.ts';
import { CP437 } from '../src/ui/screen.ts';
import { bootProgram } from '../src/machine/boot.ts';
import { saveScreenPng } from './png.ts';
import { IsoDisk, BytesSource, readElTorito } from '../src/machine/iso.ts';
import { CD_BOOT } from '../src/machine/machine.ts';

const [a, c = '-', millionsArg = '200', ...keys] = process.argv.slice(2);
const m = new Machine();
m.setCpu((process.env.CPU as '8088' | '286' | '386') || '386');
if (a && a !== '-') m.drives[0] = new Disk(basename(a), new Uint8Array(readFileSync(a)), true);
if (c.startsWith('new:')) m.drives[2] = new Disk('C.IMG', blankHardDisk(+c.slice(4)), false);
else if (c !== '-') m.drives[2] = new Disk(basename(c), new Uint8Array(readFileSync(c)), false);
// ISO=光盘映像：放进 D:（变成只读的 FAT16 硬盘）
if (process.env.ISO) m.drives[3] = new Disk(basename(process.env.ISO), new Uint8Array(0), false, await IsoDisk.open(new BytesSource(new Uint8Array(readFileSync(process.env.ISO))), basename(process.env.ISO)));
if (process.env.CD) m.cdrom.insert(new BytesSource(new Uint8Array(readFileSync(process.env.CD))), basename(process.env.CD)); // CD=光盘映像：放进光驱（IDE 第二通道的 ATAPI 光驱）
const logs: string[] = [];
// PROF=1：统计异常（按向量和发生的位置）、端口访问次数，并抽样 CPU 在哪里（V86 / 保护模式环 0~3）；每次按键之间打印一次后清零
const prof = process.env.PROF ? { faults: new Map<string, number>(), where: new Map<string, number>(), ports: new Map<number, number>(), hot: new Map<number, number>() } : null;
if (prof) {
  const cpu = m.cpu as unknown as { deliverFault(f: { vector: number; code: number }): void };
  const orig = cpu.deliverFault.bind(cpu);
  cpu.deliverFault = f => {
    const lin = m.cpu.linearIP, op = [0, 1, 2].map(k => m.cpu.peekLin(lin + k).toString(16).padStart(2, '0')).join(' ');
    const key = `#${f.vector} ${m.cpu.v86 ? 'V86' : 'PM'} ${lin.toString(16)} [${op}]`;
    prof.faults.set(key, (prof.faults.get(key) ?? 0) + 1);
    orig(f);
  };
  const io = m.cpu.io, in8 = io.in8, out8 = io.out8, in16 = io.in16!, out16 = io.out16!;
  const cnt = (p: number) => prof.ports.set(p, (prof.ports.get(p) ?? 0) + 1);
  io.in8 = p => { cnt(p); return in8(p); };
  io.out8 = (p, v) => { cnt(p); out8(p, v); };
  io.in16 = p => { cnt(p | 0x10000); return in16(p); };
  io.out16 = (p, v) => { cnt(p | 0x10000); out16(p, v); };
}
const hotBase = new Map<number, [number, boolean]>();
const profReport = async (title: string) => {
  if (!prof) return;
  const top = (mp: Map<string, number>, n: number) => [...mp].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${k} ×${v}`).join('\n');
  console.log(`== 统计（${title}）==
异常：
${top(prof.faults, 15)}
位置（抽样）：
${top(prof.where, 15)}`);
  console.log('端口：', [...prof.ports].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, n]) => `${p > 0xffff ? 'W' : ''}${(p & 0xffff).toString(16)}h×${n}`).join('，'));
  const { disassemble } = await import('../src/cpu/disasm.ts');
  for (const [ip, n] of [...prof.hot].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`热点 ${ip.toString(16)} ×${n}：`);
    const [base, code32] = hotBase.get(ip)!;
    let a = ip - base - 20;
    for (let k = 0; k < 14; k++) {
      const d = disassemble(x => m.cpu.peekLin(base + x), a, { is286: true, is386: true, code32 });
      console.log(`  ${a === ip - base ? '>' : ' '}${a.toString(16)}  ${d.text}`);
      a += d.length;
    }
  }
  prof.faults.clear(); prof.where.clear(); prof.ports.clear(); prof.hot.clear();
};
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
// WATCHPHYS=起点-终点（物理地址，十六进制）：记录读写这段内存的代码位置（每个位置只记第一次，最多 200 条）
if (process.env.WATCHPHYS) {
  const [w0, w1] = process.env.WATCHPHYS.split('-').map(x => parseInt(x, 16));
  const cpu = m.cpu, seen = new Set<string>(), log: string[] = [];
  (globalThis as { __physlog?: string[] }).__physlog = log;
  const note = (what: string, a: number) => {
    if (a < w0 || a >= w1 || log.length >= 200) return;
    const key = `${cpu.s[1].toString(16)}:${cpu.instructionStart.toString(16)} ${what}`;
    if (seen.has(key)) return;
    seen.add(key);
    log.push(`${key} ${a.toString(16)}${cpu.v86 ? '（V86）' : ''} 第 ${m.instructions} 条`);
  };
  const rl = cpu.readLin.bind(cpu), wl = cpu.writeLin.bind(cpu);
  cpu.readLin = (a: number) => { note('读', a); return rl(a); };
  cpu.writeLin = (a: number, v: number) => { note('写', a); wl(a, v); };
}
// PORTLOG=3c0-3df,a0-a1：记录这些端口的读写（只记保护模式下的；PORTLOGALL=1 时都记，PORTLOGPM=1 时不记虚拟 8086 模式的），最后打印最近的 PORTLOGN 条
if (process.env.PORTLOG) {
  const ranges = process.env.PORTLOG.split(',').map(r => r.split('-').map(x => parseInt(x, 16))).map(([a, b]) => [a, b ?? a]);
  const io = m.cpu.io;
  const log: string[] = [];
  (globalThis as { __portlog?: string[] }).__portlog = log;
  const want = (p: number) => (process.env.PORTLOGALL || (m.cpu.protectedMode && !(process.env.PORTLOGPM && m.cpu.v86))) && ranges.some(([a, b]) => p >= a && p <= b);
  const at = () => `${process.env.PORTLOGTIME ? (m.clock / 1193.182).toFixed(2) + 'ms ' : ''}${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}${m.cpu.v86 ? 'v' : ''}`;
  // PORTLOGIRQ=14：同时记下这个中断的请求和响应（看中断有没有送到）
  if (process.env.PORTLOGIRQ) {
    const irq = +process.env.PORTLOGIRQ, pic = irq >= 8 ? m.pic2 : m.pic, bit = irq & 7;
    const raise = pic.raise.bind(pic);
    pic.raise = (n: number) => { if (n === bit) log.push(`${at()} IRQ${irq} 请求（主片屏蔽 ${m.pic.imr.toString(16)}，从片屏蔽 ${m.pic2.imr.toString(16)}，IF=${(m.cpu.flags >> 9) & 1}）`); raise(n); };
    const ack = m.pic.ack.bind(m.pic);
    m.pic.ack = () => { const v = ack(); if (v === (irq >= 8 ? m.pic2.vectorBase : m.pic.vectorBase) + bit) log.push(`${at()} IRQ${irq} 响应（向量 ${v.toString(16)}）`); return v; };
  }
  let words = 0; // 数据端口的字：只计数，连续的合成一行
  const flush = () => { if (words) { log.push(`  （数据端口 ${words} 个字）`); words = 0; } };
  m.cpu.io = {
    ...io,
    in8: p => { const v = io.in8(p); if (want(p)) { flush(); log.push(`${at()} IN ${p.toString(16)}=${v.toString(16)}`); } return v; },
    out8: (p, v) => { if (want(p)) { flush(); log.push(`${at()} OUT ${p.toString(16)},${v.toString(16)}`); } io.out8(p, v); },
    in16: p => { if (want(p)) words++; return io.in16!(p); },
    out16: (p, v) => { if (want(p)) words++; io.out16!(p, v); },
  };
}
if (process.env.ATTRWATCH) { // 谁写了属性控制器的 10h（模式控制）寄存器
  const v = m.video, orig = v.setAttr.bind(v), origLoad = v.loadModeRegs.bind(v);
  v.setAttr = (i: number, x: number) => { if (i === 0x10) console.log(`attr[10h] = ${x.toString(16)} 于 ${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}`); orig(i, x); };
  v.loadModeRegs = (mode: number) => { console.log(`loadModeRegs(${mode.toString(16)}) 于 ${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}`); origLoad(mode); };
  const origReset = v.reset.bind(v);
  v.reset = () => { console.log(`video.reset 于 ${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}`); origReset(); };
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
if (process.env.BOOT === 'CD') { // 从光驱启动（CD= 指定的光盘，El Torito 软盘模拟）
  const r = await readElTorito(m.cdrom.source!);
  if (typeof r === 'string') throw new Error(r);
  if (r.kind === 'floppy') m.cdBoot = new Disk('光盘的启动软盘', r.image, true);
  else { m.cdBootNoEmu = { image: r.image, loadSeg: r.loadSeg, rba: r.rba, count: r.count }; console.log(`不模拟方式：引导程序 ${r.count} 个扇区，从第 ${r.rba} 块装到 ${(r.loadSeg || 0x7c0).toString(16)}0h`); }
}
m.load(bootProgram(process.env.BOOT === 'C' ? 0x80 : process.env.BOOT === 'CD' ? CD_BOOT : 0));
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
// TRACEFROM=段:偏移（十六进制，偏移可以是 32 位）：执行到这里以后记录接下来的 TRACEN 条指令（含 32 位寄存器），最后打印
const traceLog: string[] = [];
if (process.env.TRACEFROM) {
  const [tcs, tip] = process.env.TRACEFROM.split(':').map(x => parseInt(x, 16));
  const n = +(process.env.TRACEN ?? 2000);
  const cpu = m.cpu;
  const orig = cpu.step.bind(cpu);
  const { disassemble } = await import('../src/cpu/disasm.ts');
  let on = false;
  const h = (v: number) => (v >>> 0).toString(16);
  cpu.step = () => {
    if (!on && cpu.s[1] === tcs && cpu.ip === tip) {
      on = true;
      // TRACEDIS=起点-终点（当前代码段里的偏移）：开始跟踪时反汇编这一段
      if (process.env.TRACEDIS) {
        const [d0, d1] = process.env.TRACEDIS.split('-').map(x => parseInt(x, 16));
        const base = cpu.segBase(1);
        let o = d0;
        while (o < d1) {
          const ins = disassemble(q => cpu.peekLin(base + (q >>> 0)), o, { is386: true, code32: cpu.code32 });
          traceLog.push(`  ${h(o)}  ${ins.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(24)} ${ins.text}`);
          o += ins.length;
        }
      }
    }
    if (on && traceLog.length < n) {
      const base = cpu.segBase(1), mask = cpu.code32 ? 0xffffffff : 0xffff;
      const ins = disassemble(o => cpu.peekLin(base + ((o & mask) >>> 0)), cpu.ip, { is386: cpu.is386, code32: cpu.code32 });
      traceLog.push(`${h(cpu.s[1])}:${h(cpu.ip).padStart(8, '0')} ${ins.text.padEnd(36)} eax=${h(cpu.r32(0))} ebx=${h(cpu.r32(3))} ecx=${h(cpu.r32(1))} edx=${h(cpu.r32(2))} esi=${h(cpu.r32(6))} edi=${h(cpu.r32(7))} f=${h(cpu.flags)}`);
    }
    orig();
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
    const r = m.run(prof ? 50_000 : 500_000);
    if (prof) { const k = `${m.cpu.v86 ? 'V86' : 'PM' + m.cpu.cpl} ${m.cpu.linearIP.toString(16).padStart(8, '0').slice(0, 5)}xxx`; prof.where.set(k, (prof.where.get(k) ?? 0) + 1); const ip = m.cpu.linearIP; prof.hot.set(ip, (prof.hot.get(ip) ?? 0) + 1); hotBase.set(ip, [ip - m.cpu.ip, m.cpu.code32]); }
    if (r === 'exit' || r === 'error') { console.log('停止：', r, m.message); return false; }
  }
  return true;
};
const screen = () => {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = '';
    for (let col = 0; col < 80; col++) line += CP437[m.video.textCell(r * 80 + col)[0]];
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
    const alt = /^\{ALT:([A-Z]|ENTER|TAB)\}$/.exec(part);
    if (alt) { // Alt + 字母（或回车、Tab）
      const sc = alt[1] === 'ENTER' ? 0x1c : alt[1] === 'TAB' ? 0x0f : scanForChar(alt[1].toLowerCase());
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
  await profReport(k);
}
console.log(`执行了 ${(m.instructions / 1e6).toFixed(1)} 百万条指令（${((Date.now() - t0) / 1000).toFixed(1)} 秒），虚拟时间 ${(m.clock / 1193182).toFixed(1)} 秒，CS:IP=${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)}，模式 ${m.video.hardwareMode().toString(16)}h（BIOS 数据区 ${m.mem[0x449].toString(16)}h）`);
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

if (process.env.TRACEFROM) console.log('跟踪：\n' + traceLog.join('\n'));
if (process.env.WATCHPHYS) console.log('访问记录：\n' + ((globalThis as { __physlog?: string[] }).__physlog ?? []).join('\n'));
// PLANEDUMP=偏移,偏移,...（十六进制）：结束时打印 4 个平面在这些偏移处的 16 个字节
if (process.env.PLANEDUMP) for (const o of process.env.PLANEDUMP.split(",").map(x => parseInt(x, 16))) m.video.planar.planes.forEach((p, k) => console.log(`平面 ${k} @${o.toString(16)}：`, Array.from(p.subarray(o, o + 16), b => b.toString(16).padStart(2, "0")).join(" ")));
// FINDTEXT=文字：结束时在整个物理内存和显卡的 4 个平面里找这段文字（连续存放，或者"字符、属性"交替存放）
if (process.env.FINDTEXT) {
  const t = Array.from(process.env.FINDTEXT, c => c.charCodeAt(0));
  const find = (buf: Uint8Array, step: number) => {
    const hits: number[] = [];
    for (let a = 0; a + t.length * step <= buf.length && hits.length < 12; a++) {
      let ok = true;
      for (let k = 0; k < t.length && ok; k++) ok = buf[a + k * step] === t[k];
      if (ok) hits.push(a);
    }
    return hits.map(h => h.toString(16));
  };
  console.log('内存里（连续）：', find(m.mem, 1).join(' '));
  console.log('内存里（字符、属性交替）：', find(m.mem, 2).join(' '));
for (const h of find(m.mem, 2)) { const a = parseInt(h, 16); console.log(`  ${h} 处的属性字节：`, Array.from({ length: 6 }, (_, k) => m.mem[a + 1 + k * 2].toString(16)).join(' ')); }
  m.video.planar.planes.forEach((p, k) => console.log(`平面 ${k}（连续 / 隔一个字节）：`, find(p, 1).join(' '), '/', find(p, 2).join(' ')));
}
if (process.env.WATCH) console.log('最后执行的指令：\n' + ((globalThis as { __tail?: string[] }).__tail ?? []).slice(-40).join('\n'));

if (process.env.DISLIN) {
  const { disassemble } = await import('../src/cpu/disasm.ts');
  for (const spec of process.env.DISLIN.split(';')) {
    const [a0, n] = spec.split(',');
    let a = parseInt(a0, 16);
    console.log(`反汇编 ${a.toString(16)}：`);
    for (let k = 0; k < +(n ?? 30); k++) {
      const d = disassemble(x => m.cpu.peekLin(x >>> 0), a, { is286: true, is386: true, code32: true });
      console.log(`  ${(a >>> 0).toString(16)}  ${d.text}`);
      a += d.length;
    }
  }
}
if (process.env.PORTLOG) { const l = (globalThis as { __portlog?: string[] }).__portlog ?? []; const n = +(process.env.PORTLOGN ?? 300); console.log(`端口访问（共 ${l.length} 次，最后 ${n} 次）：\n` + l.slice(-n).join('\n')); }
if (process.env.PORTS) { const l = (globalThis as { __ports?: string[] }).__ports ?? []; console.log('串口访问（共 ' + l.length + ' 次）：' + l.slice(0, 200).join(' ')); }
if (process.env.CONSOLE) console.log('输出的文字：' + JSON.stringify(m.console.slice(-600)));
