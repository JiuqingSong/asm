// 用 SingleStepTests/8088 核对反汇编器：每个用例的 bytes 就是一条完整指令（含前缀），
// 反汇编得到的长度必须相同。用法：node tools/disasm-check.ts [每个文件的用例数，默认 500]
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disassemble } from '../src/cpu/disasm.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-data', '8088');
const limit = +(process.argv[2] ?? 500);
let total = 0, bad = 0;
const samples: string[] = [];
const names = new Map<string, string>();
for (const f of readdirSync(dir).filter(x => x.endsWith('.json.gz')).sort()) {
  const tests: { name: string; bytes: number[] }[] = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8'));
  for (const t of tests.slice(0, limit)) {
    total++;
    const d = disassemble(o => t.bytes[o] ?? 0, 0);
    if (!names.has(f)) names.set(f, `${t.name}  →  ${d.text}`);
    if (d.length !== t.bytes.length) {
      bad++;
      if (samples.length < 15) samples.push(`${f}: ${t.name} [${t.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}] 反汇编为 ${d.text}（${d.length} 字节）`);
    }
  }
}
console.log(`${total} 个用例，长度不符 ${bad} 个`);
if (samples.length) console.log(samples.join('\n'));
if (process.argv.includes('--show')) for (const [f, s] of names) console.log(f.padEnd(14), s);
process.exit(bad ? 1 : 0);
