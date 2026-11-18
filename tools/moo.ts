// 读 SingleStepTests 的 MOO 测试文件（格式见 https://github.com/dbalsom/moo 的 doc/moo_format_v1.md）
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/** RG32 的寄存器顺序 */
export const RG32_NAMES = ['cr0', 'cr3', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'eip', 'eflags', 'dr6', 'dr7'] as const;
/** REGS 的寄存器顺序 */
export const REGS_NAMES = ['ax', 'bx', 'cx', 'dx', 'cs', 'ss', 'ds', 'es', 'sp', 'bp', 'si', 'di', 'ip', 'flags'] as const;

export interface MooState {
  regs: Record<string, number>;
  /** 未定义的位（1 表示不用比较） */
  masks: Record<string, number>;
  ram: [number, number][];
}

export interface MooTest {
  index: number;
  name: string;
  bytes: number[];
  init: MooState;
  final: MooState;
  exception: { number: number; flagAddr: number } | null;
  hash: string;
}

export interface MooFile {
  cpu: string;
  /** 整个文件通用的未定义位 */
  masks: Record<string, number>;
  tests: MooTest[];
}

export function readMoo(path: string): MooFile {
  const raw = readFileSync(path);
  const buf = path.endsWith('.gz') ? gunzipSync(raw) : raw;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u16 = (o: number) => dv.getUint16(o, true);

  const regs = (o: number, end: number, kind: string): Record<string, number> => {
    const out: Record<string, number> = {};
    if (kind === 'RG32' || kind === 'RM32') {
      const mask = u32(o); let p = o + 4;
      for (let b = 0; b < 32; b++) if (mask & (1 << b)) { out[RG32_NAMES[b]] = u32(p); p += 4; }
    } else {
      const mask = u16(o); let p = o + 2;
      for (let b = 0; b < 16; b++) if (mask & (1 << b)) { out[REGS_NAMES[b]] = u16(p); p += 2; }
    }
    void end;
    return out;
  };

  const state = (o: number, end: number): MooState => {
    const st: MooState = { regs: {}, masks: {}, ram: [] };
    while (o < end) {
      const t = id(o), len = u32(o + 4), d = o + 8;
      if (t === 'REGS' || t === 'RG32') st.regs = regs(d, d + len, t);
      else if (t === 'RMSK' || t === 'RM32') st.masks = regs(d, d + len, t);
      else if (t === 'RAM ') {
        const n = u32(d);
        for (let k = 0; k < n; k++) st.ram.push([u32(d + 4 + k * 5), buf[d + 8 + k * 5]]);
      }
      o = d + len;
    }
    return st;
  };

  let o = 0;
  const file: MooFile = { cpu: '', masks: {}, tests: [] };
  while (o < buf.length) {
    const t = id(o), len = u32(o + 4), d = o + 8;
    if (t === 'MOO ') { file.cpu = id(d + 8); o = d + len; continue; }
    if (t === 'RMSK' || t === 'RM32') { file.masks = regs(d, d + len, t); o = d + len; continue; }
    if (t !== 'TEST') { o = d + len; continue; }
    const test: MooTest = { index: u32(d), name: '', bytes: [], init: { regs: {}, masks: {}, ram: [] }, final: { regs: {}, masks: {}, ram: [] }, exception: null, hash: '' };
    let p = d + 4;
    const end = d + len;
    while (p < end) {
      const st = id(p), sl = u32(p + 4), sd = p + 8;
      switch (st) {
        case 'NAME': test.name = buf.subarray(sd + 4, sd + 4 + u32(sd)).toString('latin1'); break;
        case 'BYTS': test.bytes = Array.from(buf.subarray(sd + 4, sd + 4 + u32(sd))); break;
        case 'INIT': test.init = state(sd, sd + sl); break;
        case 'FINA': test.final = state(sd, sd + sl); break;
        case 'EXCP': test.exception = { number: buf[sd], flagAddr: u32(sd + 1) }; break;
        case 'HASH': test.hash = buf.subarray(sd, sd + 20).toString('hex'); break;
      }
      p = sd + sl;
    }
    file.tests.push(test);
    o = end;
  }
  return file;
}
