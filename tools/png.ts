// 把虚拟 PC 的图形画面存成 PNG（命令行工具用）
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { Machine } from '../src/machine/machine.ts';
import { modeInfo, MODE_UNCHAINED } from '../src/machine/video.ts';

/** 当前是图形模式时保存截图，返回 true；文本模式返回 false */
export function saveScreenPng(m: Machine, file: string): boolean {
  const mode = m.video.hardwareMode(); // 和界面一样按显卡寄存器判断
  const vi = { ...modeInfo(mode) };
  if (!vi.graphics) return false;
  const ux = mode === MODE_UNCHAINED ? m.video.unchainedSize() : null;
  if (ux) { vi.width = ux.width; vi.height = ux.height; }
  const { width: w, height: h } = vi, v = m.video;
  const rgb = (i: number) => { const k = (i & v.pelMask) * 3; return [v.dac[k], v.dac[k + 1], v.dac[k + 2]].map(c => (c << 2) | (c >> 4)); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c: number[];
      if (ux) c = rgb(v.planar.planes[x & 3][(ux.start + y * ux.stride + (x >> 2)) & 0xffff]);
      else if (vi.planar) c = rgb(v.dacIndex(v.planar.pixel(y * (w >> 3) + (x >> 3), x & 7)));
      else if (vi.bpp === 8) c = rgb(v.peek(0xa0000 + y * 320 + x));
      else {
        const ppb = 8 / vi.bpp, b = v.peek(0xb8000 + (y & 1) * 0x2000 + (y >> 1) * 80 + Math.floor(x / ppb));
        const idx = (b >> ((ppb - 1 - (x % ppb)) * vi.bpp)) & ((1 << vi.bpp) - 1);
        c = [idx * 85, idx * 85, idx * 85];
      }
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return true;
}
