// DOS 的内存管理：内存控制块（MCB）链
//
// 每个内存块前面有一个段落的 MCB：
//   +0  'M'（后面还有块）或 'Z'（最后一块）
//   +1  属主（PSP 段地址；0 表示空闲）
//   +3  块的大小（段落数，不含 MCB 本身）
//   +8  属主程序名（8 字节，DOS 4 以后）
// INT 21h 48h/49h/4Ah 在这条链上分配、释放、调整；程序（例如 C、BASIC 的运行库）
// 启动时会检查这条链是否完整。
import type { CPU } from '../cpu/cpu.ts';

/** 常规内存的上限（640KB） */
export const MEM_TOP = 0xa000;

interface Block { mcb: number; last: boolean; owner: number; size: number }

export class DosMemory {
  private cpu: CPU;
  /** 第一个 MCB 的段地址 */
  first = 0;

  constructor(cpu: CPU) { this.cpu = cpu; }

  write(mcb: number, last: boolean, owner: number, size: number, name = ''): void {
    const c = this.cpu;
    c.wb(mcb, 0, last ? 0x5a : 0x4d);
    c.ww(mcb, 1, owner);
    c.ww(mcb, 3, size);
    for (let k = 0; k < 8; k++) c.wb(mcb, 8 + k, k < name.length ? name.charCodeAt(k) : 0);
  }

  /** 遍历整条链；链损坏时返回 null */
  blocks(): Block[] | null {
    const out: Block[] = [];
    let seg = this.first;
    for (let guard = 0; guard < 4096; guard++) {
      const t = this.cpu.rb(seg, 0);
      if (t !== 0x4d && t !== 0x5a) return null;
      const b = { mcb: seg, last: t === 0x5a, owner: this.cpu.rw(seg, 1), size: this.cpu.rw(seg, 3) };
      out.push(b);
      if (b.last) return out;
      seg = seg + 1 + b.size;
      if (seg >= MEM_TOP) return null;
    }
    return null;
  }

  /** 合并相邻的空闲块 */
  private merge(): void {
    const bs = this.blocks();
    if (!bs) return;
    for (let k = 0; k < bs.length - 1; k++) {
      const a = bs[k], b = bs[k + 1];
      if (a.owner === 0 && b.owner === 0) {
        this.write(a.mcb, b.last, 0, a.size + 1 + b.size);
        this.merge();
        return;
      }
    }
  }

  private largestFree(bs: Block[]): number {
    return bs.filter(b => b.owner === 0).reduce((m, b) => Math.max(m, b.size), 0);
  }

  /** 分配 paras 个段落：成功返回块的段地址，失败返回 { largest } */
  alloc(paras: number, owner: number): number | { largest: number; corrupt?: boolean } {
    this.merge();
    const bs = this.blocks();
    if (!bs) return { largest: 0, corrupt: true };
    const b = bs.find(x => x.owner === 0 && x.size >= paras);
    if (!b) return { largest: this.largestFree(bs) };
    if (b.size > paras) {
      // 拆成两块：前面分配出去，后面仍然空闲
      this.write(b.mcb + 1 + paras, b.last, 0, b.size - paras - 1);
      this.write(b.mcb, false, owner, paras);
    } else {
      this.write(b.mcb, b.last, owner, b.size);
    }
    return b.mcb + 1;
  }

  /** 释放 seg 开始的块 */
  free(seg: number): boolean {
    const bs = this.blocks();
    const b = bs?.find(x => x.mcb === seg - 1);
    if (!b) return false;
    this.write(b.mcb, b.last, 0, b.size);
    this.merge();
    return true;
  }

  /** 把 seg 开始的块调整为 paras 个段落：成功返回 true，失败返回 { largest }（这个块最多能有多大） */
  resize(seg: number, paras: number): true | { largest: number; bad?: boolean } {
    this.merge();
    const bs = this.blocks();
    const i = bs ? bs.findIndex(x => x.mcb === seg - 1) : -1;
    if (!bs || i < 0) return { largest: 0, bad: true };
    const b = bs[i];
    const next = bs[i + 1];
    const room = b.size + (next && next.owner === 0 ? 1 + next.size : 0);
    if (paras > room) return { largest: room };
    const last = next && next.owner === 0 ? next.last : b.last;
    if (paras === room) {
      this.write(b.mcb, last, b.owner, paras);
    } else if (paras + 1 <= room) {
      // 剩下的部分成为空闲块
      this.write(b.mcb + 1 + paras, last, 0, room - paras - 1);
      this.write(b.mcb, false, b.owner, paras);
    } else {
      this.write(b.mcb, last, b.owner, room);
    }
    this.merge();
    return true;
  }
}
