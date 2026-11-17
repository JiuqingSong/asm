// 用 MASM 6.11 (ML.EXE) 作为参照，逐字节比较本汇编器的输出。
// 用法：node tools/ml-compare.ts file1.asm [file2.asm ...]
// ML 生成 OBJ（OMF 格式），解析 LEDATA/LIDATA 得到每个段的内容；
// FIXUPP 标记的位置（需要链接时才能确定的地址）不参与比较。
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/asm/assembler.ts';

const here = dirname(fileURLToPath(import.meta.url));
// ML.EXE（MASM 6.11）不随仓库提供：用环境变量 ML_EXE 指定，默认找仓库上一级的 bin/ML.EXE
const ML = process.env.ML_EXE ?? resolve(here, '..', '..', 'bin', 'ML.EXE');
if (!existsSync(ML)) {
  console.error(`找不到 ML.EXE：${ML}
请用环境变量 ML_EXE 指定 MASM 6.x 的 ML.EXE 路径。`);
  process.exit(2);
}

interface OmfSeg { name: string; data: Map<number, number>; fixups: Set<number> }

function parseOmf(buf: Uint8Array): Map<string, OmfSeg> {
  const lnames: string[] = [''];
  const segs: OmfSeg[] = [{ name: '', data: new Map(), fixups: new Set() }];
  let last: { seg: OmfSeg; offset: number } | null = null;
  let p = 0;
  while (p < buf.length) {
    const type = buf[p];
    const len = buf[p + 1] | (buf[p + 2] << 8);
    const body = buf.subarray(p + 3, p + 3 + len - 1);
    p += 3 + len;
    let q = 0;
    const u8 = () => body[q++];
    const u16 = () => { const v = body[q] | (body[q + 1] << 8); q += 2; return v; };
    const idx = () => { const b = u8(); return b & 0x80 ? ((b & 0x7f) << 8) | u8() : b; };
    switch (type) {
      case 0x96: // LNAMES
        while (q < body.length) { const n = u8(); lnames.push(String.fromCharCode(...body.subarray(q, q + n))); q += n; }
        break;
      case 0x98: { // SEGDEF
        const attr = u8();
        if ((attr >> 5) === 0) { q += 3; }
        u16();
        const nameIdx = idx();
        segs.push({ name: lnames[nameIdx], data: new Map(), fixups: new Set() });
        break;
      }
      case 0xa0: { // LEDATA
        const seg = segs[idx()];
        const off = u16();
        for (let k = 0; q < body.length; k++) seg.data.set(off + k, u8());
        last = { seg, offset: off };
        break;
      }
      case 0xa2: { // LIDATA
        const seg = segs[idx()];
        const off = u16();
        const block = (): number[] => {
          const rep = u16(), cnt = u16();
          let content: number[] = [];
          if (cnt === 0) { const n = u8(); content = Array.from(body.subarray(q, q + n)); q += n; }
          else for (let k = 0; k < cnt; k++) content.push(...block());
          const out: number[] = [];
          for (let k = 0; k < rep; k++) out.push(...content);
          return out;
        };
        const bytes: number[] = [];
        while (q < body.length) bytes.push(...block());
        bytes.forEach((b, k) => seg.data.set(off + k, b));
        last = { seg, offset: off };
        break;
      }
      case 0x9c: { // FIXUPP
        while (q < body.length) {
          const b = u8();
          if (b & 0x80) {
            const locat = (b << 8) | u8();
            const loc = (locat >> 10) & 0xf, dataOff = locat & 0x3ff;
            const fixdat = u8();
            const F = fixdat & 0x80, frame = (fixdat >> 4) & 7, T = fixdat & 8, P = fixdat & 4;
            if (!F && frame < 3) idx();
            else if (!F && frame === 3) u16();
            if (!T) idx();
            if (!P) u16();
            const size = [1, 2, 2, 4, 1, 2, 0, 0, 0, 4, 0, 6, 0, 4][loc] ?? 2;
            if (last) for (let k = 0; k < size; k++) last.seg.fixups.add(last.offset + dataOff + k);
          } else {
            const D = b & 0x40, method = (b >> 2) & 7;
            if ((D && method < 3) || (!D && method < 4)) idx();
          }
        }
        break;
      }
    }
  }
  const m = new Map<string, OmfSeg>();
  for (const s of segs.slice(1)) m.set(s.name.toUpperCase(), s);
  return m;
}

function hex(v: number, w = 2) { return v.toString(16).toUpperCase().padStart(w, '0'); }

let failures = 0;
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'latin1');
  const dir = mkdtempSync(join(tmpdir(), 'mlcmp-'));
  const asmPath = join(dir, 'T.ASM');
  writeFileSync(asmPath, src, 'latin1');
  let mlOut = '';
  try {
    mlOut = execFileSync(ML, ['/c', '/nologo', '/FoT.OBJ', 'T.ASM'], { cwd: dir, encoding: 'latin1' });
  } catch (e) {
    mlOut = (e as { stdout?: string }).stdout ?? String(e);
  }
  const objPath = join(dir, 'T.OBJ');
  const prog = assemble(src);
  const ours = prog.diagnostics.filter(d => d.severity === 'error');
  console.log(`== ${basename(file)}`);
  if (!existsSync(objPath)) {
    console.log('  ML 汇编失败：\n' + mlOut.split('\n').filter(l => l.trim()).map(l => '    ' + l.trim()).join('\n'));
    console.log(`  本汇编器：${ours.length ? ours.map(d => `第${d.line}行 ${d.message}`).join('；') : '没有报错'}`);
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  if (ours.length) {
    failures++;
    console.log('  ML 成功，但本汇编器报错：');
    for (const d of ours) console.log(`    第 ${d.line} 行：${d.message}`);
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  const omf = parseOmf(readFileSync(objPath));
  const lines = src.split(/\r?\n/);
  let bad = 0, compared = 0;
  const badLines = new Map<number, string>();
  for (const seg of prog.segments) {
    const o = omf.get(seg.name.toUpperCase());
    if (!o) { console.log(`  ML 没有段 ${seg.name}`); continue; }
    for (const [off, b] of o.data) {
      if (o.fixups.has(off)) continue;
      compared++;
      const mine = seg.bytes[off] ?? -1;
      if (mine !== b && !(mine === -1 && b === 0)) {
        bad++;
        const le = prog.listing.find(l => l.segName === seg.name && off >= l.segOffset && off < l.segOffset + Math.max(1, l.bytes.length));
        const ln = le?.line ?? 0;
        if (!badLines.has(ln)) {
          const mlBytes = le ? le.bytes.map((_, k) => o.data.has(le.segOffset + k) ? (o.fixups.has(le.segOffset + k) ? '??' : hex(o.data.get(le.segOffset + k)!)) : '--').join(' ') : '';
          badLines.set(ln, `    第 ${ln} 行 ${(lines[ln - 1] ?? '').trim()}\n      本汇编器 ${le?.bytes.map(x => x < 0 ? '--' : hex(x)).join(' ')}\n      ML       ${mlBytes}   (偏移 ${seg.name}:${hex(off, 4)})`);
        }
      }
    }
    if (o.data.size && Math.max(...o.data.keys()) + 1 > seg.size) {
      bad++;
      console.log(`  段 ${seg.name} 大小不同：本汇编器 ${hex(seg.size, 4)}，ML 至少 ${hex(Math.max(...o.data.keys()) + 1, 4)}`);
    }
  }
  if (bad) {
    failures++;
    console.log(`  ✗ ${bad} 个字节不同（共比较 ${compared} 字节）`);
    for (const s of badLines.values()) console.log(s);
  } else console.log(`  ✓ 一致（比较了 ${compared} 字节）`);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
