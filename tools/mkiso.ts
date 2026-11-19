// 生成一个简单的 ISO9660 光盘映像（测试用）：node tools/mkiso.ts <目录> <输出.iso> [卷标]
// 只写主卷描述符和目录（没有路径表、Joliet），够本模拟器和大多数读 ISO 的程序用。
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IsoFile { path: string; data: Uint8Array }

interface Node { name: string; dir: boolean; data?: Uint8Array; children: Node[]; lba: number; size: number }

const B = 2048;

function both16(b: Uint8Array, o: number, v: number) { b[o] = v & 0xff; b[o + 1] = v >> 8; b[o + 2] = v >> 8; b[o + 3] = v & 0xff; }
function both32(b: Uint8Array, o: number, v: number) {
  for (let k = 0; k < 4; k++) { b[o + k] = (v >>> (8 * k)) & 0xff; b[o + 7 - k] = (v >>> (8 * k)) & 0xff; }
}
function text(b: Uint8Array, o: number, s: string, n: number) { for (let k = 0; k < n; k++) b[o + k] = k < s.length ? s.charCodeAt(k) : 0x20; }

/** 用文件列表（路径用 / 分隔）生成 ISO；bootFloppy 是启动软盘映像（1.2MB、1.44MB 或 2.88MB）时生成可启动光盘（El Torito 软盘模拟） */
export function buildIso(files: IsoFile[], label = 'TESTCD', bootFloppy?: Uint8Array): Uint8Array {
  const root: Node = { name: '', dir: true, children: [], lba: 0, size: 0 };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let c = d.children.find(x => x.dir && x.name === p.toUpperCase());
      if (!c) { c = { name: p.toUpperCase(), dir: true, children: [], lba: 0, size: 0 }; d.children.push(c); }
      d = c;
    }
    d.children.push({ name: parts[parts.length - 1].toUpperCase(), dir: false, data: f.data, children: [], lba: 0, size: f.data.length });
  }
  const recLen = (name: string) => { const n = 33 + name.length; return n + (n & 1); };
  const fileId = (n: Node) => n.dir ? n.name : n.name + ';1';
  // 目录的大小
  const dirs: Node[] = [];
  const collect = (d: Node) => {
    d.children.sort((x, y) => x.name < y.name ? -1 : 1);
    dirs.push(d);
    for (const c of d.children) if (c.dir) collect(c);
  };
  collect(root);
  for (const d of dirs) {
    let size = 34 * 2, used = 68;
    for (const c of d.children) {
      const l = recLen(fileId(c));
      if (used % B + l > B) { used = Math.ceil(used / B) * B; }
      used += l;
    }
    size = Math.ceil(used / B) * B;
    d.size = size;
  }
  // 分配块：16 卷描述符、17 结束符，然后目录、文件；可启动时 17 是启动记录、18 结束符、19 启动目录，软盘映像放在最后
  let next = bootFloppy ? 20 : 18;
  // 路径表（MSCDEX 用它找目录）：L 型（小端）和 M 型（大端）各一块；目录按层次、父目录编号排序
  const levels: Node[] = [root];
  const parentOf = new Map<Node, Node>();
  for (let k = 0; k < levels.length; k++) for (const c of levels[k].children) if (c.dir) { levels.push(c); parentOf.set(c, levels[k]); }
  const pathL = next, pathM = next + 1;
  next += 2;
  for (const d of dirs) { d.lba = next; next += d.size / B; }
  const allFiles: Node[] = [];
  for (const d of dirs) for (const c of d.children) if (!c.dir) { c.lba = next; next += Math.max(1, Math.ceil(c.size / B)); allFiles.push(c); }
  const bootLba = next;
  if (bootFloppy) next += Math.ceil(bootFloppy.length / B);
  const img = new Uint8Array(next * B);
  const record = (o: number, n: Node, id: Uint8Array) => {
    const l = 33 + id.length + ((33 + id.length) & 1);
    img[o] = l;
    both32(img, o + 2, n.lba); both32(img, o + 10, n.size);
    img.set([97, 5, 4, 12, 30, 0, 0], o + 18); // 1997-05-04 12:30:00
    img[o + 25] = n.dir ? 2 : 0;
    both16(img, o + 28, 1);
    img[o + 32] = id.length;
    img.set(id, o + 33);
    return l;
  };
  const parent = new Map<Node, Node>();
  for (const d of dirs) for (const c of d.children) if (c.dir) parent.set(c, d);
  for (const d of dirs) {
    let o = d.lba * B;
    o += record(o, d, Uint8Array.of(0));
    o += record(o, parent.get(d) ?? root, Uint8Array.of(1));
    for (const c of d.children) {
      const id = Uint8Array.from(fileId(c), ch => ch.charCodeAt(0));
      const l = 33 + id.length + ((33 + id.length) & 1);
      if ((o % B) + l > B) o = Math.ceil(o / B) * B;
      o += record(o, c, id);
    }
  }
  for (const f of allFiles) img.set(f.data!, f.lba * B);
  let ptSize = 0;
  for (const [k, d] of levels.entries()) {
    const id = k === 0 ? [0] : Array.from(d.name, ch => ch.charCodeAt(0));
    const par = k === 0 ? 1 : levels.indexOf(parentOf.get(d)!) + 1;
    for (const [base, big] of [[pathL * B, false], [pathM * B, true]] as const) {
      const o = base + ptSize;
      img[o] = id.length;
      if (big) { img[o + 2] = d.lba >>> 24; img[o + 3] = d.lba >>> 16; img[o + 4] = d.lba >>> 8; img[o + 5] = d.lba; img[o + 6] = par >> 8; img[o + 7] = par & 0xff; }
      else { img[o + 2] = d.lba; img[o + 3] = d.lba >>> 8; img[o + 4] = d.lba >>> 16; img[o + 5] = d.lba >>> 24; img[o + 6] = par & 0xff; img[o + 7] = par >> 8; }
      img.set(id, o + 8);
    }
    ptSize += 8 + id.length + (id.length & 1);
  }
  // 主卷描述符
  const p = 16 * B;
  img[p] = 1; text(img, p + 1, 'CD001', 5); img[p + 6] = 1;
  text(img, p + 8, '', 32); text(img, p + 40, label, 32);
  both32(img, p + 80, next); both16(img, p + 120, 1); both16(img, p + 124, 1); both16(img, p + 128, B);
  both32(img, p + 132, ptSize);
  img[p + 140] = pathL; img[p + 141] = pathL >> 8;           // L 型路径表的位置（小端）
  img[p + 151] = pathM; img[p + 150] = pathM >> 8;           // M 型路径表的位置（大端）
  record(p + 156, root, Uint8Array.of(0));
  const t = (bootFloppy ? 18 : 17) * B;
  img[t] = 255; text(img, t + 1, 'CD001', 5); img[t + 6] = 1;
  if (bootFloppy) {
    const media = { [1200 * 1024]: 1, [1440 * 1024]: 2, [2880 * 1024]: 3 }[bootFloppy.length];
    if (!media) throw new Error('启动软盘映像要是 1.2MB、1.44MB 或 2.88MB');
    const r = 17 * B;                                       // 启动记录卷描述符
    img[r] = 0; text(img, r + 1, 'CD001', 5); img[r + 6] = 1;
    img.set(Array.from('EL TORITO SPECIFICATION', c => c.charCodeAt(0)), r + 7);
    img[r + 0x47] = 19;                                     // 启动目录在第 19 块
    const c = 19 * B;                                       // 验证项：校验和让 16 个字之和为 0
    img[c] = 1; img[c + 30] = 0x55; img[c + 31] = 0xaa;
    let sum = 0;
    for (let k = 0; k < 32; k += 2) sum += img[c + k] | (img[c + k + 1] << 8);
    const ck = (0x10000 - (sum & 0xffff)) & 0xffff;
    img[c + 28] = ck & 0xff; img[c + 29] = ck >> 8;
    img[c + 32] = 0x88; img[c + 33] = media;                // 默认启动项：可启动、软盘模拟
    img[c + 38] = 1;                                        // 装入 1 个虚拟扇区
    img[c + 40] = bootLba & 0xff; img[c + 41] = (bootLba >> 8) & 0xff; img[c + 42] = bootLba >> 16;
    img.set(bootFloppy, bootLba * B);
  }
  return img;
}

function readDir(dir: string, prefix = ''): IsoFile[] {
  const out: IsoFile[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...readDir(p, prefix + n + '/'));
    else out.push({ path: prefix + n, data: new Uint8Array(readFileSync(p)) });
  }
  return out;
}

if (process.argv[1]?.endsWith('mkiso.ts')) {
  const [dir, out, label, boot] = process.argv.slice(2);
  if (!dir || !out) { console.log('用法：node tools/mkiso.ts <目录> <输出.iso> [卷标] [启动软盘映像]'); process.exit(1); }
  const img = buildIso(readDir(dir), label ?? 'TESTCD', boot ? new Uint8Array(readFileSync(boot)) : undefined);
  writeFileSync(out, img);
  console.log(`${out}：${img.length} 字节`);
}
