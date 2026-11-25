import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const data = join(root, 'test-data', '8088');
const meta = JSON.parse(readFileSync(join(data, 'metadata.json'), 'utf8')).opcodes;
const args = process.argv.slice(2);
const limit = Number(args.find(a => a.startsWith('--limit='))?.slice(8) ?? Infinity);
if (!(limit > 0)) throw new Error('Expected positive --limit');
const filters = args.filter(a => !a.startsWith('--')).map(a => a.toUpperCase());
const names = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di', 'es', 'cs', 'ss', 'ds', 'ip', 'flags'];
const temp = mkdtempSync(join(tmpdir(), 'asm86-native-cpu-'));
let total = 0, failures = 0;
try {
  for (const file of readdirSync(data).filter(f => f.endsWith('.json.gz'))) {
    const base = file.slice(0, -8);
    if (filters.length && !filters.some(f => f === base.toUpperCase() || base.toUpperCase().startsWith(f + '.'))) continue;
    const [op, reg] = base.split('.');
    const info = reg === undefined ? meta[op] : meta[op]?.reg?.[reg];
    if (info?.status === 'undefined' || info?.status === 'prefix') continue;
    const tests = JSON.parse(gunzipSync(readFileSync(join(data, file)))).slice(0, limit);
    const words = [tests.length];
    for (const t of tests) {
      words.push(info?.['flags-mask'] ?? 0xffff, /^(div|idiv|aam)/.test(t.name.replace(/^(rep\w* |lock )/, '')) ? 1 : 0);
      for (const state of [t.initial, t.final]) for (const name of names) words.push(state.regs[name] ?? t.initial.regs[name]);
      for (const state of [t.initial, t.final]) {
        words.push(state.ram.length);
        for (const [a, v] of state.ram) words.push(a, v);
      }
    }
    const buffer = Buffer.alloc(words.length * 4);
    words.forEach((value, i) => buffer.writeUInt32LE(value, i * 4));
    const corpus = join(temp, 'cases.bin'); writeFileSync(corpus, buffer);
    const result = spawnSync(join(import.meta.dirname, 'build', 'native-tests.exe'), [corpus], { encoding: 'utf8' });
    if (result.error) throw result.error;
    total += tests.length;
    if (result.status !== 0) { ++failures; console.error(base, result.stdout, result.stderr); }
    else if (filters.length) console.log(base, result.stdout.trim());
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (!total) throw new Error('No matching CPU tests');
console.log(`${total} CPU cases; ${failures} failing opcode files`);
process.exitCode = failures ? 1 : 0;
