// 双机串口实验：A 运行 send.asm，B 运行 receive.asm（两个程序都不修改）
// 用法：node tools/serial-demo.ts <send.asm> <receive.asm> [CPU 速度 id] [buffered]
import { readFileSync } from 'node:fs';
import { assemble } from '../src/asm/assembler.ts';
import { DualMachine } from '../src/machine/dual.ts';
import { CPU_SPEEDS } from '../src/machine/machine.ts';

const [sendPath, recvPath, speedId = '8088', mode = ''] = process.argv.slice(2);
const speed = CPU_SPEEDS.find(s => s.id === speedId)!;
const data = new Uint8Array(10000);
let x = 12345;
for (let i = 0; i < data.length; i++) { x = (x * 1103515245 + 12345) >>> 0; data[i] = i < 256 ? i : (x >>> 16) & 0xff; }

const d = new DualMachine('loopback-rts');
const [A, B] = d.m;
for (const m of d.m) { m.setCpu(speed.id); m.com1.bufferedTx = mode === 'buffered'; m.history.enabled = false; }
A.files.set('TEST.BIN', data);
A.load(assemble(readFileSync(sendPath, 'latin1')), ' c:' + String.fromCharCode(92) + 'test.bin');
B.load(assemble(readFileSync(recvPath, 'latin1')));
d.syncClocks();
const t0 = performance.now();
let r;
for (let i = 0; i < 300; i++) { r = d.run(1_000_000); if (r.reason !== 'budget') break; }
const got = B.files.get('TEST.BIN');
let same = 0;
if (got) for (let i = 0; i < Math.min(got.length, data.length); i++) if (got[i] === data[i]) same++;
const firstBad = got ? [...data].findIndex((b, i) => got[i] !== b) : -1;
console.log(`CPU ${speed.name}${mode ? '，发送带缓冲' : ''}：停止原因 ${r!.reason}，虚拟时间 ${(A.clock / 1193182).toFixed(2)} 秒，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
console.log(`  A 屏幕输出：${JSON.stringify(A.console.slice(-60))}  状态 ${A.status} ${A.message}`);
console.log(`  B 状态 ${B.status} ${B.message}`);
console.log(`  A 串口：发送 ${A.com1.stats.txBytes}，THR 被覆盖 ${A.com1.stats.thrOverwrites}；B 串口：接收 ${B.com1.stats.rxBytes}，溢出 ${B.com1.stats.overruns}，帧错误 ${B.com1.stats.framingErrors}`);
console.log(`  收到文件：${got ? got.length + ' 字节' : '没有'}，与原文件一致 ${same}/${data.length} 字节${firstBad >= 0 ? '，第一个不同在偏移 ' + firstBad : ''}`);
