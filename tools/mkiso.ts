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

/** 用文件列表（路径用 / 分隔）生成 ISO */
export function buildIso(files: IsoFile[], label = 'TESTCD'): Uint8Array {
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
  // 分配块：16 卷描述符、17 结束符，然后目录、文件
  let next = 18;
  for (const d of dirs) { d.lba = next; next += d.size / B; }
  const allFiles: Node[] = [];
  for (const d of dirs) for (const c of d.children) if (!c.dir) { c.lba = next; next += Math.max(1, Math.ceil(c.size / B)); allFiles.push(c); }
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
  // 主卷描述符
  const p = 16 * B;
  img[p] = 1; text(img, p + 1, 'CD001', 5); img[p + 6] = 1;
  text(img, p + 8, '', 32); text(img, p + 40, label, 32);
  both32(img, p + 80, next); both16(img, p + 120, 1); both16(img, p + 124, 1); both16(img, p + 128, B);
  record(p + 156, root, Uint8Array.of(0));
  const t = 17 * B;
  img[t] = 255; text(img, t + 1, 'CD001', 5); img[t + 6] = 1;
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
  const [dir, out, label] = process.argv.slice(2);
  if (!dir || !out) { console.log('用法：node tools/mkiso.ts <目录> <输出.iso> [卷标]'); process.exit(1); }
  const img = buildIso(readDir(dir), label ?? 'TESTCD');
  writeFileSync(out, img);
  console.log(`${out}：${img.length} 字节`);
}
