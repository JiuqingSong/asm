// Native x87 differential check. Compile tools/softfloat/reference.c with an x86 GCC/Clang first.
// node tools/check-x87.ts <reference.exe>
import { spawnSync } from 'node:child_process';
import { X87, type FpuContext } from '../src/cpu/x87.ts';
import { F80_MASK } from '../src/cpu/softfloat.ts';

const reference = process.argv[2];
if (!reference) throw new Error('Usage: node tools/check-x87.ts <native reference executable>');
let seed = 0x387486;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const normal = (small = false) => (BigInt(16383 + (small ? -1 : (random() % 101) - 50) | (random() & 1 ? 0x8000 : 0)) << 64n) |
  0x8000000000000000n | (BigInt(random()) << 32n) | BigInt(random());
const context: FpuContext = {
  read: () => { throw new Error('Unexpected memory access'); },
  write: () => { throw new Error('Unexpected memory access'); },
  ax: () => {}, ip: 0, cs: 0, dp: 0, ds: 0, operand32: true, protectedMode: true,
};
const instructions = [
  [0xd8, 0xc1], [0xd8, 0xe1], [0xd8, 0xc9], [0xd8, 0xf1], [0xd9, 0xfa], [0xd9, 0xfc],
  [0xd9, 0xfe], [0xd9, 0xff], [0xd9, 0xf0], [0xd9, 0xf1], [0xd9, 0xf9], [0xd9, 0xf3],
  [0xd9, 0xf8], [0xd9, 0xf5], [0xd9, 0xfd],
];
const cases: { op: number; cw: number; a: bigint; b: bigint }[] = [];
for (let op = 0; op < instructions.length; op++) {
  for (const pc of [0, 0x200, 0x300]) for (let rc = 0; rc < 4; rc++) {
    for (let k = 0; k < 40; k++) {
      let a = normal(op >= 6 && op <= 11), b = normal();
      if (op === 4 || op === 9) a &= ~(1n << 79n);
      cases.push({ op, cw: 0x7f | pc | (rc << 10), a, b });
    }
  }
}
const input = cases.map(c => [c.op, c.cw, c.a >> 64n, c.a & F80_MASK, c.b >> 64n, c.b & F80_MASK].map(x => x.toString(16)).join(' ')).join('\n') + '\n';
const result = spawnSync(reference, [], { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Native oracle failed (${result.status}): ${result.stderr}`);
const lines = result.stdout.trim().split(/\r?\n/);
if (lines.length !== cases.length) throw new Error(`Expected ${cases.length} oracle results, received ${lines.length}`);
const failures = new Map<number, { count: number; first: string }>();
for (let k = 0; k < cases.length; k++) {
  const c = cases[k], fpu = new X87();
  fpu.control = c.cw; fpu.registers[0] = c.a; fpu.registers[1] = c.b; fpu.tags[0] = fpu.tags[1] = 0;
  fpu.execute(instructions[c.op][0], instructions[c.op][1], context);
  const [hex, sw] = lines[k].split(' '), expected = BigInt('0x' + hex);
  const difference = fpu.st() > expected ? fpu.st() - expected : expected - fpu.st();
  const tolerance = c.op >= 6 && c.op <= 11 ? 2n : 0n;
  const mask = c.op === 12 || c.op === 13 ? 0x473f : c.op >= 6 && c.op <= 11 ? 0x3f : 0x23f;
  if (difference > tolerance || ((fpu.status ^ parseInt(sw, 16)) & mask)) {
    const failure = failures.get(c.op) ?? { count: 0, first: JSON.stringify({
      cw: c.cw.toString(16), a: c.a.toString(16), b: c.b.toString(16),
      expected: hex, actual: fpu.st().toString(16), sw, actualSw: fpu.statusWord.toString(16),
    }) };
    failure.count++; failures.set(c.op, failure);
  }
}
for (const [op, f] of failures) console.error(`op ${op}: ${f.count} failures; ${f.first}`);
console.log(`${cases.length} native x87 cases; ${[...failures.values()].reduce((n, f) => n + f.count, 0)} failures`);
if (failures.size) process.exitCode = 1;
