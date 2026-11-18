// 打印 MOO 用例的初始内存里某个地址附近的字节：node tools/peek-ram.ts <文件> <序号> <十六进制地址> [字节数]
import { readMoo } from './moo.ts';
const f = readMoo(process.argv[2]);
const t = f.tests[+process.argv[3]];
const a = parseInt(process.argv[4], 16), n = +(process.argv[5] ?? 4);
const m = new Map(t.init.ram);
console.log(Array.from({ length: n }, (_, k) => (m.get(a + k) ?? -1).toString(16)).join(' '));
