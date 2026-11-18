// 用 SingleStepTests/80386 核对 386 反汇编器的指令长度：每个用例的 bytes 是一条指令（含前缀）加一个 HLT
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { disassemble } from '../src/cpu/disasm.ts';
import { readMoo } from './moo.ts';
const dir = join(import.meta.dirname, '..', 'test-data', '80386');
let n = 0, bad = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.MOO.gz'))) {
  for (const t of readMoo(join(dir, f)).tests.slice(0, 50)) {
    n++;
    const d = disassemble(o => t.bytes[o] ?? 0, 0, { is386: true });
    if (d.length !== t.bytes.length - 1 && !t.exception) {
      if (bad++ < 15) console.log(f, t.name, t.bytes.map(b => b.toString(16)).join(' '), '→', d.length, d.text);
    }
  }
}
console.log(`${n} 个用例，长度不符 ${bad} 个`);
