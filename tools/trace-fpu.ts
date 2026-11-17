// 借用一个 Turbo Pascal 程序里的 8087 仿真器，逐条跟踪一条浮点指令是怎么用整数指令算出来的
//
// 用法：node tools/trace-fpu.ts <TP 程序.EXE> [参数] [要跟踪的指令]
//   要跟踪的指令：8087 指令 D9 xx 的第 2 个字节（默认 F2 = FPTAN，FA = FSQRT），
//   或者 3E:xx 表示 Turbo Pascal 7 的 INT 3Eh 功能 xx（EC = Sin，EE = Cos 等，System 单元里的标准函数就是这样调用的）
//
// 做法：先让程序运行一段时间（仿真器装好 INT 34h~3Dh），然后在 PSP 的 90h 处放一小段代码：
//   FLD dword ptr [C0h]   （写成仿真形式 INT 35h 06 C0 00）
//   D9 xx                 （写成 INT 35h xx，例如 FPTAN）
//   FSTP dword ptr [C4h]
//   FSTP dword ptr [C8h]
//   INT 3
// 把 CS:IP 指过去，逐条执行并记录，最后统计用到的指令和最常执行的循环。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Machine } from '../src/machine/machine.ts';
import { loadExecutable } from '../src/machine/exe.ts';
import { disassemble } from '../src/cpu/disasm.ts';
import { CS, DS, ES } from '../src/cpu/cpu.ts';

const [file, angleArg = '0.5', opArg = 'F2'] = process.argv.slice(2);
const int3e = opArg.toUpperCase().startsWith('3E:');
const op = parseInt(int3e ? opArg.slice(3) : opArg, 16);
const opBytes = int3e ? [0xcd, 0x3e, op, 0x90] : [0xcd, 0x35, op];
const { program } = loadExecutable(new Uint8Array(readFileSync(file)), basename(file));
const m = new Machine();
m.setCpu('386');
m.load(program, '', basename(file));
const dir = dirname(file);
for (const n of readdirSync(dir)) {
  const p = join(dir, n);
  if (statSync(p).isFile()) m.files.set(n.toUpperCase(), new Uint8Array(readFileSync(p)));
}

// 1. 运行到仿真器装好
const vec = (n: number) => m.mem[n * 4 + 2] | (m.mem[n * 4 + 3] << 8);
while (m.instructions < 30_000_000 && vec(0x35) === 0xf000) if (m.run(100_000) !== 'budget') break;
m.run(3_000_000);
if (vec(0x35) === 0xf000) { console.log('这个程序没有装 8087 仿真器（不是用 {$N+} 编译的？）'); process.exit(1); }
const emuSeg = vec(0x35);
console.log(`仿真器入口：INT 35h -> ${emuSeg.toString(16).toUpperCase()}:${(m.mem[0xd4] | (m.mem[0xd5] << 8)).toString(16).toUpperCase()}`);

// 2. 放进测试代码
const psp = program.pspSeg, base = psp * 16;
const code = [0xcd, 0x35, 0x06, 0xc0, 0x00, ...opBytes, 0xcd, 0x35, 0x1e, 0xc4, 0x00, 0xcd, 0x35, 0x1e, 0xc8, 0x00, 0xcc];
const opEnd = 0x90 + 5 + opBytes.length;
m.mem.set(code, base + 0x90);
const f32 = new DataView(new ArrayBuffer(4));
f32.setFloat32(0, +angleArg, true);
for (let i = 0; i < 4; i++) m.mem[base + 0xc0 + i] = f32.getUint8(i);
const cpu = m.cpu;
cpu.s[CS] = psp; cpu.ip = 0x90; cpu.s[DS] = psp; cpu.s[ES] = psp;
m.history.enabled = false;

// 3. 逐条执行，记录
const read = (seg: number) => (off: number) => m.mem[((seg << 4) + (off & 0xffff)) & 0xfffff];
const hits = new Map<string, number>();
const mnem = new Map<string, number>();
const text = new Map<string, string>();
let n = 0;
let inOp = false, opCount = 0;
while (n < 2_000_000) {
  const cs = cpu.s[CS], ip = cpu.ip;
  if (cs === psp && ip === 0x90 + 5) inOp = true;       // 开始执行第 2 条（被跟踪的那条）
  if (cs === psp && ip === opEnd) inOp = false;
  if (cs === psp && m.mem[base + ip] === 0xcc) break;
  const ins = disassemble(read(cs), ip);
  if (inOp) {
    opCount++;
    const key = `${cs.toString(16).toUpperCase()}:${ip.toString(16).toUpperCase().padStart(4, '0')}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    text.set(key, ins.text);
    mnem.set(ins.mnemonic, (mnem.get(ins.mnemonic) ?? 0) + 1);
  }
  cpu.step();
  n++;
}
const rd = (o: number) => { for (let i = 0; i < 4; i++) f32.setUint8(i, m.mem[base + o + i]); return f32.getFloat32(0, true); };
const st0 = rd(0xc4), st1 = rd(0xc8);
console.log(`被跟踪的指令（${int3e ? 'INT 3Eh 功能 ' : 'D9 '}${op.toString(16).toUpperCase()}）执行了 ${opCount} 条 8086 指令`);
console.log(`结果：ST(0) = ${st0}，ST(1) = ${st1}${!int3e && op === 0xf2 ? `，ST(1)/ST(0) = ${st1 / st0}（Math.tan = ${Math.tan(+angleArg)}）` : ''}`);
console.log('用得最多的指令：', [...mnem].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `${k}×${v}`).join('，'));
console.log('执行次数最多的地址（循环体）：');
const hot = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 40).sort((a, b) => a[0] < b[0] ? -1 : 1);
for (const [k, v] of hot) console.log(`  ${k}  ×${String(v).padStart(4)}  ${text.get(k)}`);
