// 查看 MOO 测试文件里的用例：node tools/peek-moo.ts <文件> [起始序号] [个数]
import { readMoo } from './moo.ts';
const f = readMoo(process.argv[2]);
const from = +(process.argv[3] ?? 0), n = +(process.argv[4] ?? 2);
console.log(f.cpu, f.tests.length, 'filemasks', JSON.stringify(f.masks));
const h = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${(v >>> 0).toString(16)}`).join(' ');
for (const t of f.tests.slice(from, from + n)) {
  console.log(`#${t.index} ${t.name} [${t.bytes.map(b => b.toString(16)).join(' ')}] exc=${JSON.stringify(t.exception)}`);
  console.log('  init', h(t.init.regs));
  console.log('  fina', h(t.final.regs), t.final.masks && Object.keys(t.final.masks).length ? 'masks ' + h(t.final.masks) : '', 'ram', t.final.ram.map(([a, v]) => a.toString(16) + '=' + v.toString(16)).join(' '));
}
