// 用 SingleStepTests/80386 的实模式测试集验证 386 CPU（真机 386EX 录下的结果）。
// 用法：node tools/run-386-tests.ts [操作码过滤...] [--limit=N] [--verbose]
//   例：node tools/run-386-tests.ts 66 0FBA.4 --limit=200
// 测试数据放在 test-data/80386/（*.MOO.gz，见 https://github.com/SingleStepTests/80386 的 v1_ex_real_mode 目录）。
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CPU, AX, BX, CX, DX, SP, BP, SI, DI, ES, CS, SS, DS, FS, GS } from '../src/cpu/cpu.ts';
import { readMoo, type MooTest } from './moo.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'test-data', '80386');
if (!existsSync(dataDir)) { console.error('找不到测试数据：' + dataDir); process.exit(2); }

const args = process.argv.slice(2);
const filters = args.filter(a => !a.startsWith('--')).map(a => a.toUpperCase());
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.slice(8), 10) : Infinity;
const verbose = args.includes('--verbose');
const revoked = new Set(existsSync(join(dataDir, 'revocation_list.txt'))
  ? readFileSync(join(dataDir, 'revocation_list.txt'), 'utf8').split(/\s+/).filter(Boolean).map(s => s.toLowerCase()) : []);

const GPR: [string, number][] = [['eax', AX], ['ebx', BX], ['ecx', CX], ['edx', DX], ['esi', SI], ['edi', DI], ['ebp', BP], ['esp', SP]];
const SEG: [string, number][] = [['cs', CS], ['ds', DS], ['es', ES], ['fs', FS], ['gs', GS], ['ss', SS]];
/** EFLAGS 只比较低 18 位（测试里高位总是 1，是 386EX 存状态的方式造成的） */
const FLAG_BITS = 0x3ffff;
const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;
/** C0/C1 移位指令的立即数（跳过 ModR/M 和位移） */
function imm8(b: number[], i: number): number {
  const a32 = b.slice(0, i).includes(0x67);
  const m = b[i + 1], mod = m >> 6, rm = m & 7;
  let n = i + 2;
  if (a32) {
    if (mod !== 3 && rm === 4) { const base = b[n] & 7; n++; if (mod === 0 && base === 5) n += 4; }
    if (mod === 0 && rm === 5) n += 4;
  } else if (mod === 0 && rm === 6) n += 2;
  if (mod === 1) n += 1; else if (mod === 2) n += a32 ? 4 : 2;
  return b[n];
}
/** Intel 手册里说"未定义"的标志（真机上取决于内部电路，没有软件依赖它们），按操作码 */
function undefinedFlags(t: MooTest): number {
  const b = t.bytes;
  let i = 0;
  while ([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3].includes(b[i])) i++;
  const op = b[i], m = b[i + 1] ?? 0, reg = (m >> 3) & 7;
  if (op === 0x0f) {
    const op2 = b[i + 1], m2 = b[i + 2] ?? 0;
    if ([0xa3, 0xab, 0xb3, 0xbb, 0xba].includes(op2)) return OF | SF | ZF | AF | PF;     // BT 系列
    if (op2 === 0xbc || op2 === 0xbd) return CF | OF | SF | AF | PF;                      // BSF / BSR
    if (op2 === 0xaf) return SF | ZF | AF | PF;                                            // IMUL
    if ([0xa4, 0xa5, 0xac, 0xad].includes(op2)) return AF | OF | (CF | SF | ZF | PF);      // SHLD / SHRD（次数大于操作数位数时都未定义）
    void m2;
    return 0;
  }
  if (op === 0x37 || op === 0x3f) return OF | SF | ZF | PF;                               // AAA / AAS
  if (op === 0x27 || op === 0x2f) return OF;                                              // DAA / DAS
  if (op === 0xd4 || op === 0xd5) return OF | AF | CF;                                    // AAM / AAD
  if (op === 0x69 || op === 0x6b) return SF | ZF | AF | PF;                               // IMUL
  if ((op === 0xf6 || op === 0xf7) && reg >= 4) return SF | ZF | AF | PF | (reg >= 6 ? CF | OF : 0); // MUL IMUL DIV IDIV
  if ([0xc0, 0xc1, 0xd0, 0xd1, 0xd2, 0xd3].includes(op)) {                                // 移位：OF 只有移 1 位时有定义，AF 未定义
    // 字节、字的 SHL/SHR 移位次数不小于操作数位数时 CF 也未定义
    const opsize = op & 1 ? (b.slice(0, i).includes(0x66) ? 32 : 16) : 8;
    const count = (op >= 0xd2 ? t.init.regs.ecx & 0xff : op >= 0xd0 ? 1 : imm8(b, i)) & 31;
    return OF | AF | (reg >= 4 && reg <= 6 && count >= opsize ? CF : 0);
  }
  return 0;
}

const cpu = new CPU();
cpu.is386 = true;
cpu.setA20(true);

function setup(t: MooTest): void {
  const g = t.init.regs;
  cpu.resetProtected();
  cpu.msw = g.cr0 >>> 0;
  cpu.cr3 = g.cr3 ?? 0;
  for (const [n, i] of GPR) cpu.setR32(i, g[n] >>> 0);
  for (const [n, i] of SEG) { cpu.s[i] = g[n] & 0xffff; cpu.cBase[i] = (g[n] & 0xffff) << 4; }
  cpu.ip = g.eip >>> 0;
  cpu.flags = (g.eflags & FLAG_BITS) >>> 0;
  cpu.dr[6] = g.dr6 >>> 0; cpu.dr[7] = g.dr7 >>> 0;
  cpu.halted = false;
  for (const [a, v] of t.init.ram) cpu.mem[a] = v;
}

function run(): void {
  // 被测指令 + HLT（出异常时 HLT 在处理程序的入口）
  for (let k = 0; k < 200000 && !cpu.halted; k++) cpu.step();
}

function compare(t: MooTest, fileMasks: Record<string, number>): string[] {
  const errs: string[] = [];
  const f = t.final.regs, init = t.init.regs;
  const mask = (n: string) => (t.final.masks[n] ?? fileMasks[n] ?? 0xffffffff) >>> 0;
  const want = (n: string) => (f[n] ?? init[n]) >>> 0;
  const hex = (v: number) => (v >>> 0).toString(16);
  for (const [n, i] of GPR) {
    const m = mask(n);
    if (((cpu.r32(i) & m) >>> 0) !== ((want(n) & m) >>> 0)) errs.push(`${n}=${hex(cpu.r32(i))} 应为 ${hex(want(n))}`);
  }
  for (const [n, i] of SEG) if (cpu.s[i] !== (want(n) & 0xffff)) errs.push(`${n}=${hex(cpu.s[i])} 应为 ${hex(want(n))}`);
  // 执行到 HLT 之后 EIP 指向 HLT 的下一个字节
  const eip = cpu.ip;
  if (((eip & mask('eip')) >>> 0) !== ((want('eip') & mask('eip')) >>> 0)) errs.push(`eip=${hex(eip)} 应为 ${hex(want('eip'))}`);
  const fm = mask('eflags') & FLAG_BITS & ~undefinedFlags(t);
  if (((cpu.flags & fm) >>> 0) !== ((want('eflags') & fm) >>> 0)) errs.push(`eflags=${hex(cpu.flags & FLAG_BITS)} 应为 ${hex(want('eflags') & FLAG_BITS)}（比较的位 ${hex(fm)}）`);
  // 内存：异常时压在栈上的 FLAGS 里未定义的位不比较
  const exc = t.exception;
  for (const [a, v] of t.final.ram) {
    let got = cpu.mem[a], exp = v;
    if (exc && (a === exc.flagAddr || a === exc.flagAddr + 1)) {
      const m = (mask('eflags') >> (a === exc.flagAddr ? 0 : 8)) & 0xff;
      got &= m; exp &= m;
    }
    if (got !== exp) errs.push(`[${hex(a)}]=${hex(cpu.mem[a])} 应为 ${hex(v)}`);
  }
  return errs;
}

const files = readdirSync(dataDir).filter(f => f.endsWith('.MOO.gz')).sort();
let pass = 0, fail = 0, skip = 0;
const failed: string[] = [];
const t0 = Date.now();
for (const file of files) {
  const base = file.replace('.MOO.gz', '');
  if (filters.length && !filters.some(f => base === f || base.startsWith(f))) continue;
  const moo = readMoo(join(dataDir, file));
  let fp = 0, ff = 0;
  let shown = 0;
  for (const t of moo.tests.slice(0, limit)) {
    if (revoked.has(t.hash)) { skip++; continue; }
    // 清掉上一个测试写过的内存
    for (const [a] of t.final.ram) cpu.mem[a] = 0;
    setup(t);
    let errs: string[];
    try { run(); errs = compare(t, moo.masks); } catch (e) { errs = ['异常：' + (e as Error).message]; }
    for (const [a] of t.init.ram) cpu.mem[a] = 0;
    for (const [a] of t.final.ram) cpu.mem[a] = 0;
    if (errs.length === 0) { fp++; continue; }
    ff++;
    if (shown < (verbose ? 5 : 1)) {
      shown++;
      console.log(`  ✗ ${base} #${t.index} ${t.name} [${t.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}]${t.exception ? ' 异常 ' + t.exception.number : ''}`);
      console.log('    ' + errs.slice(0, 6).join('；'));
    }
  }
  pass += fp; fail += ff;
  if (ff) { failed.push(`${base}(${ff})`); console.log(`${base}: ${fp} 通过，${ff} 失败`); }
}
console.log(`\n共 ${pass + fail} 个用例：${pass} 通过，${fail} 失败，跳过 ${skip}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
if (failed.length) console.log('失败的文件：' + failed.join(' '));
process.exit(fail ? 1 : 0);
