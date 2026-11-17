// 用 SingleStepTests/8088 测试集验证 CPU 模拟器。
// 用法：npm run test:cpu [-- 操作码过滤...] [--limit=N] [--verbose]
//   例：npm run test:cpu -- 00 F6.7 --limit=500
// 测试数据放在 test-data/8088/（*.json.gz + metadata.json）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CPU, AX, BX, CX, DX, SP, BP, SI, DI, ES, CS, SS, DS } from '../src/cpu/cpu.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'test-data', '8088');
if (!existsSync(join(dataDir, 'metadata.json'))) {
  console.error('找不到测试数据：' + dataDir);
  process.exit(2);
}

const args = process.argv.slice(2);
const filters = args.filter(a => !a.startsWith('--')).map(a => a.toUpperCase());
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.slice(8), 10) : Infinity;
const verbose = args.includes('--verbose');

const meta = JSON.parse(readFileSync(join(dataDir, 'metadata.json'), 'utf8')).opcodes;

type Regs = Record<string, number>;
interface Test {
  name: string;
  bytes: number[];
  initial: { regs: Regs; ram: [number, number][] };
  final: { regs: Regs; ram: [number, number][] };
}

const REG16: [string, number][] = [['ax', AX], ['bx', BX], ['cx', CX], ['dx', DX], ['sp', SP], ['bp', BP], ['si', SI], ['di', DI]];
const SREG: [string, number][] = [['es', ES], ['cs', CS], ['ss', SS], ['ds', DS]];

function info(file: string): { status: string; mask: number } {
  const base = file.replace('.json.gz', '');
  const [op, reg] = base.split('.');
  let m = meta[op];
  if (reg !== undefined && m?.reg) m = m.reg[reg];
  return { status: m?.status ?? 'normal', mask: m?.['flags-mask'] ?? 0xffff };
}

const cpu = new CPU();
const written = new Set<number>();
cpu.onWrite = (a) => { written.add(a); };

const files = readdirSync(dataDir).filter(f => f.endsWith('.json.gz')).sort();
let totalPass = 0, totalFail = 0, totalSkip = 0;
const failedFiles: string[] = [];
const t0 = Date.now();

for (const file of files) {
  const base = file.replace('.json.gz', '');
  if (filters.length && !filters.some(f => base === f || base.startsWith(f + '.'))) continue;
  const { status, mask } = info(file);
  if (status === 'undefined' || status === 'prefix') { totalSkip++; continue; }

  const tests: Test[] = JSON.parse(gunzipSync(readFileSync(join(dataDir, file))).toString('utf8'));
  let pass = 0, fail = 0;
  let firstFail = '';
  const n = Math.min(tests.length, limit);
  for (let ti = 0; ti < n; ti++) {
    const t = tests[ti];
    const ini = t.initial, fin = t.final;
    // 初始化
    for (const [k, i] of REG16) cpu.r[i] = ini.regs[k];
    for (const [k, i] of SREG) cpu.s[i] = ini.regs[k];
    cpu.ip = ini.regs.ip;
    cpu.flags = ini.regs.flags;
    cpu.halted = false;
    const initRam = new Map<number, number>();
    for (const [a, v] of ini.ram) { cpu.mem[a] = v; initRam.set(a, v); }
    written.clear();

    let guard = 0;
    do { cpu.step(); } while (cpu.repContinue && ++guard < 1_000_000);

    // 比较
    const errs: string[] = [];
    const exp = (k: string) => (fin.regs[k] ?? ini.regs[k]);
    for (const [k, i] of REG16) if (cpu.r[i] !== exp(k)) errs.push(`${k}=${hex(cpu.r[i])} 应为 ${hex(exp(k))}`);
    for (const [k, i] of SREG) if (cpu.s[i] !== exp(k)) errs.push(`${k}=${hex(cpu.s[i])} 应为 ${hex(exp(k))}`);
    if (cpu.ip !== exp('ip')) errs.push(`ip=${hex(cpu.ip)} 应为 ${hex(exp('ip'))}`);
    if ((cpu.flags & mask) !== (exp('flags') & mask)) {
      errs.push(`flags=${flagStr(cpu.flags)} 应为 ${flagStr(exp('flags'))} (差异 ${flagStr((cpu.flags ^ exp('flags')) & mask, true)})`);
    }
    const finRam = new Map<number, number>(fin.ram);
    // 除法异常（DIV/IDIV/AAM 触发 INT 0）时，压栈的 FLAGS 中算术标志位由微码决定，属于未定义，按掩码比较
    const exc = /^(div|idiv|aam)/.test(t.name.replace(/^(rep\w* |lock )/, '')) && cpu.ip === (initRam.get(0) ?? 0) + ((initRam.get(1) ?? 0) << 8);
    const excMask = exc ? 0x0700 : 0xffff; // 只严格比较 DF/IF/TF
    const flagAddr = exc ? ((cpu.s[SS] << 4) + ((cpu.r[SP] + 4) & 0xffff)) & 0xfffff : -1;
    for (const [a, v] of finRam) {
      let actual = cpu.mem[a], want = v;
      if (a === flagAddr) { actual &= excMask & 0xff; want &= excMask & 0xff; }
      else if (a === flagAddr + 1) { actual &= excMask >> 8; want &= excMask >> 8; }
      if (actual !== want) errs.push(`[${hex(a, 5)}]=${hex(cpu.mem[a], 2)} 应为 ${hex(v, 2)}`);
    }
    if (exc) errs.splice(0, errs.length, ...errs.filter(e => !e.startsWith('flags=')));
    for (const a of written) {
      if (finRam.has(a)) continue;
      const v = initRam.get(a) ?? 0;
      if (cpu.mem[a] !== v) errs.push(`意外写入 [${hex(a, 5)}]=${hex(cpu.mem[a], 2)}`);
    }

    if (errs.length) {
      fail++;
      if (!firstFail || verbose) {
        const msg = `  #${ti} ${t.name} [${t.bytes.map(b => hex(b, 2)).join(' ')}]\n    ` + errs.join('\n    ');
        if (verbose) console.log(msg); else firstFail = msg;
      }
    } else pass++;

    // 清理内存
    for (const a of initRam.keys()) cpu.mem[a] = 0;
    for (const a of written) cpu.mem[a] = 0;
  }
  totalPass += pass;
  totalFail += fail;
  const tag = status === 'normal' ? '' : ` (${status})`;
  if (fail) {
    failedFiles.push(base);
    console.log(`✗ ${base}${tag}: ${pass}/${n} 通过`);
    if (firstFail) console.log(firstFail);
  } else if (verbose || filters.length) {
    console.log(`✓ ${base}${tag}: ${n}/${n}`);
  }
}

const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n共 ${totalPass + totalFail} 个用例：通过 ${totalPass}，失败 ${totalFail}，跳过文件 ${totalSkip}，用时 ${sec}s`);
if (failedFiles.length) console.log('失败的操作码：' + failedFiles.join(' '));
process.exit(totalFail ? 1 : 0);

function hex(v: number, w = 4): string { return v.toString(16).toUpperCase().padStart(w, '0'); }
function flagStr(f: number, only = false): string {
  const names: [number, string][] = [[0x800, 'O'], [0x400, 'D'], [0x200, 'I'], [0x100, 'T'], [0x80, 'S'], [0x40, 'Z'], [0x10, 'A'], [0x4, 'P'], [0x1, 'C']];
  if (only) return names.filter(([m]) => f & m).map(([, n]) => n).join('') || '-';
  return names.map(([m, n]) => (f & m ? n : '.')).join('');
}
