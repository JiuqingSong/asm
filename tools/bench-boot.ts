// 速度基准 + 行为校验：从硬盘映像启动，跑固定条数的指令，打印速度和机器状态的校验和
// 用法：node tools/bench-boot.ts <C: 映像> [百万条指令=300] [CPU=386]
//   HIST=1    打开历史记录（默认关闭，和界面里从磁盘启动时一样）
//   MOUSE=1   3 亿条之后每 2000 万条移动一次鼠标、交替按下/松开左键（检查串口鼠标、鼠标回调的路径）
//   SRC=目录  用另一份 src 目录（例如改动前复制出来的）运行，对比速度和校验和
//
// 校验和覆盖内存、寄存器、显存平面、虚拟时间。CMOS 时钟这里固定成 2000-01-01 12:00（平时读电脑的时间，
// 每次运行都不同），所以同一份代码每次运行的校验和都一样。优化前后校验和相同 = 行为完全相同。
// 速度看"CPU 时间"那一项（按本进程用掉的 CPU 时间算，比墙钟稳定）；电脑忙或降频时数字会变，前后对比要交替多跑几次。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length) super(...(a as [number]));
    else super(2000, 0, 1, 12, 0, 0);
  }
  static now(): number { return new RealDate(2000, 0, 1, 12, 0, 0).getTime(); }
}
globalThis.Date = FixedDate as DateConstructor;

const src = process.env.SRC ? pathToFileURL(resolve(process.env.SRC)).href + '/' : new URL('../src/', import.meta.url).href;
const { Machine } = await import(src + 'machine/machine.ts') as typeof import('../src/machine/machine.ts');
const { Disk } = await import(src + 'machine/disk.ts') as typeof import('../src/machine/disk.ts');
const { bootProgram } = await import(src + 'machine/boot.ts') as typeof import('../src/machine/boot.ts');

const [img, millions = '300', cpuName = '386'] = process.argv.slice(2);
if (!img) { console.log('用法：node tools/bench-boot.ts <C: 映像> [百万条指令] [CPU]'); process.exit(1); }
const m = new Machine();
m.setCpu(cpuName as '8088' | '286' | '386');
m.drives[2] = new Disk('C.IMG', new Uint8Array(readFileSync(img)), false);
m.load(bootProgram(0x80));
m.history.enabled = process.env.HIST === '1';

const end = +millions * 1e6, t0 = performance.now(), c0 = process.cpuUsage();
let tLast = t0, iLast = 0;
while (m.instructions < end) {
  if (process.env.MOUSE && m.instructions > 300e6 && m.instructions % 20e6 < 500_000) {
    const k = Math.floor(m.instructions / 20e6);
    m.mouse.moveRel(k % 2 ? 7 : -5, k % 3 ? 4 : -6);
    if (k % 4 === 0) m.mouse.queueButtons(1, m.clock);
    if (k % 4 === 1) m.mouse.queueButtons(0, m.clock);
  }
  const r = m.run(500_000);
  if (r === 'exit' || r === 'error') { console.log('停止：', r, m.message); break; }
  if (m.instructions - iLast >= 100e6) {
    const t = performance.now();
    console.log(`${(m.instructions / 1e6).toFixed(0)}M  ${((m.instructions - iLast) / (t - tLast) / 1e3).toFixed(2)} M 条/秒`);
    tLast = t; iLast = m.instructions;
  }
}
const wall = (performance.now() - t0) / 1000, cu = process.cpuUsage(c0), cpuSec = (cu.user + cu.system) / 1e6;
const h = createHash('sha1');
h.update(m.cpu.mem);
h.update(new Uint8Array(m.cpu.r.buffer));
h.update(new Uint8Array(m.cpu.rh.buffer));
h.update(String([m.cpu.ip, m.cpu.flags, m.clock, m.instructions, ...m.cpu.s]));
for (const p of m.video.planar.planes) h.update(p);
console.log(`共 ${(m.instructions / 1e6).toFixed(1)}M 条，墙钟 ${wall.toFixed(1)} 秒（${(m.instructions / wall / 1e6).toFixed(2)} M 条/秒），` +
  `CPU 时间 ${cpuSec.toFixed(1)} 秒（${(m.instructions / cpuSec / 1e6).toFixed(2)} M 条/秒），虚拟 ${(m.clock / 1193182).toFixed(1)} 秒，校验 ${h.digest('hex').slice(0, 16)}`);
if (process.env.MOUSE) console.log(`COM2（串口鼠标）收到 ${m.com2.stats.rxBytes} 字节，鼠标位置 ${m.mouse.x},${m.mouse.y}`);
