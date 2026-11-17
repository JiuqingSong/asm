// 装载 DOS 可执行文件（MZ 格式的 EXE，以及 COM），生成可以交给 Machine.load 的 Program
import type { Program } from '../asm/types.ts';

export interface ExeInfo {
  format: 'exe' | 'com';
  /** 映像大小（字节，不含文件头） */
  imageSize: number;
  relocations: number;
  /** 映像之后至少/最多还需要的内存（段落） */
  minAlloc: number;
  maxAlloc: number;
  /** 文件头里注明的压缩/打包工具（PKLITE、LZEXE 等），没有则为空 */
  packer: string;
  /** 文件尾部附加的数据（覆盖段、资源等）字节数 */
  extraBytes: number;
}

/** 识别常见的 EXE 压缩工具 */
function detectPacker(b: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 0x200)));
  if (head.includes('PKLITE')) return 'PKLITE';
  if (head.slice(0x1c, 0x20) === 'LZ09' || head.slice(0x1c, 0x20) === 'LZ91') return 'LZEXE';
  if (head.includes('UPX')) return 'UPX';
  return '';
}

/**
 * 把 EXE/COM 文件装载到 loadSeg 段（PSP 在它前面 0x10 个段落）。
 * 返回的 Program 没有源码映射，只能按机器码调试。
 */
export function loadExecutable(bytes: Uint8Array, name: string, loadSeg = 0x1000): { program: Program; info: ExeInfo } {
  const w = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const pspSeg = loadSeg - 0x10;
  const isMZ = bytes.length >= 0x1c && ((bytes[0] === 0x4d && bytes[1] === 0x5a) || (bytes[0] === 0x5a && bytes[1] === 0x4d));
  const base: Omit<Program, 'format' | 'chunks' | 'entry' | 'stack' | 'imageStart' | 'imageEnd' | 'dataSeg'> = {
    ok: true, diagnostics: [], loadSeg, pspSeg, lineToAddrs: new Map(), addrToLine: new Map(), symbols: [], listing: [], segments: [],
  };

  if (!isMZ) {
    // COM：原样放在 PSP:0100，所有段寄存器都指向 PSP
    if (bytes.length > 0xff00) throw new Error(`${name} 不是 EXE 文件，作为 COM 文件又太大（COM 最大约 64KB）`);
    const start = pspSeg * 16 + 0x100;
    return {
      program: {
        ...base, format: 'com', chunks: [{ addr: start, bytes: bytes.slice() }],
        entry: { cs: pspSeg, ip: 0x100 }, stack: { ss: pspSeg, sp: 0xfffe },
        imageStart: start, imageEnd: pspSeg * 16 + 0x10000, dataSeg: pspSeg,
      },
      info: { format: 'com', imageSize: bytes.length, relocations: 0, minAlloc: 0, maxAlloc: 0, packer: '', extraBytes: 0 },
    };
  }

  const lastPage = w(2), pages = w(4), nReloc = w(6), hdrPara = w(8);
  const minAlloc = w(0x0a), maxAlloc = w(0x0c);
  const ss = w(0x0e), sp = w(0x10), ip = w(0x14), cs = w(0x16), relocOff = w(0x18);
  const fileSize = pages === 0 ? 0 : (pages - 1) * 512 + (lastPage || 512);
  const hdrSize = hdrPara * 16;
  const imageSize = Math.max(0, Math.min(bytes.length, fileSize) - hdrSize);
  if (hdrSize > bytes.length) throw new Error(`${name} 的 EXE 文件头已损坏`);
  if (loadSeg * 16 + imageSize + minAlloc * 16 > 0xa0000) {
    throw new Error(`${name} 需要 ${Math.ceil((imageSize + minAlloc * 16) / 1024)}KB 内存，超过了常规内存 640KB`);
  }

  const image = bytes.slice(hdrSize, hdrSize + imageSize);
  // 重定位：表中每一项（偏移, 段）指向映像里的一个字，加上装载段
  for (let k = 0; k < nReloc; k++) {
    const e = relocOff + k * 4;
    const off = w(e), seg = w(e + 2);
    const at = seg * 16 + off;
    if (at + 1 >= image.length) continue;
    const v = (image[at] | (image[at + 1] << 8)) + loadSeg;
    image[at] = v & 0xff;
    image[at + 1] = (v >> 8) & 0xff;
  }

  const start = loadSeg * 16;
  return {
    program: {
      ...base, format: 'exe', chunks: [{ addr: start, bytes: image }],
      entry: { cs: (cs + loadSeg) & 0xffff, ip },
      stack: { ss: (ss + loadSeg) & 0xffff, sp },
      imageStart: start, imageEnd: start + imageSize + minAlloc * 16, dataSeg: loadSeg,
    },
    info: {
      format: 'exe', imageSize, relocations: nReloc, minAlloc, maxAlloc, packer: detectPacker(bytes),
      extraBytes: Math.max(0, bytes.length - fileSize),
    },
  };
}
