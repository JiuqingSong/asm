// 反汇编面板：默认显示 CS:IP 前后的指令；也可以输入地址查看任意位置，用按钮或鼠标滚轮翻页。
// 点左侧设断点，双击一行运行到那里
import { CS, BIOS_SEG, TRAP_OPCODE } from '../cpu/cpu.ts';
import { disassembleAround, disassemble, type Instruction } from '../cpu/disasm.ts';
import type { Machine } from '../machine/machine.ts';
import { h2, h4 } from './panels.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

type Parse = (m: Machine, text: string) => { seg: number; off: number } | null;

export class DisasmPanel {
  private list: HTMLElement;
  private input: HTMLInputElement;
  private note: HTMLElement;
  /** 用户指定的查看位置；null 表示跟随 CS:IP */
  private view: { seg: number; off: number } | null = null;
  /** 上次显示的指令（翻页用） */
  private shown: Instruction[] = [];
  private shownSeg = 0;
  private m: Machine | null = null;
  private bps: Set<number> = new Set();
  onToggleBp: ((lin: number) => void) | null = null;
  onRunTo: ((lin: number) => void) | null = null;
  onLine: ((line: number) => void) | null = null;

  private parse: Parse;

  constructor(el: HTMLElement, parse: Parse) {
    this.parse = parse;
    el.innerHTML = `
      <div class="mem-bar">
        <button data-act="prev" title="上一页（也可以在列表上滚动鼠标滚轮）">◀</button>
        <input class="mono dis-addr" title="地址：段:偏移，例如 335D:32AD、CS:0100，或者标号名；只写偏移时用 CS 段。按回车跳转" />
        <button data-act="next" title="下一页">▶</button>
        <button data-act="follow" title="回到当前要执行的指令（CS:IP）">➤ CS:IP</button>
        <span class="note dis-note"></span>
      </div>
      <div class="dis-list"></div>`;
    this.list = el.querySelector('.dis-list') as HTMLElement;
    this.input = el.querySelector('.dis-addr') as HTMLInputElement;
    this.note = el.querySelector('.dis-note') as HTMLElement;

    el.querySelector('.mem-bar')!.addEventListener('click', e => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'prev') this.page(-1);
      else if (act === 'next') this.page(1);
      else if (act === 'follow') { this.follow(); this.refresh(); }
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.goto(this.input.value);
      else if (e.key === 'Escape') { this.follow(); this.refresh(); }
    });
    this.list.addEventListener('wheel', e => {
      if (!this.m || !this.shown.length) return;
      e.preventDefault();
      this.scroll(e.deltaY > 0 ? 3 : -3);
    }, { passive: false });
    this.list.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const row = t.closest('.drow') as HTMLElement | null;
      if (!row) return;
      if (t.closest('.dg')) this.onToggleBp?.(+row.dataset.lin!);
      const a = t.closest('a[data-line]') as HTMLElement | null;
      if (a) this.onLine?.(+a.dataset.line!);
    });
    this.list.addEventListener('dblclick', e => {
      const row = (e.target as HTMLElement).closest('.drow') as HTMLElement | null;
      if (row && !(e.target as HTMLElement).closest('.dg')) this.onRunTo?.(+row.dataset.lin!);
    });
  }

  /** 回到跟随 CS:IP（单步、到达断点、后退之后调用） */
  follow(): void { this.view = null; }

  private refresh(): void { if (this.m) this.render(this.m, this.bps); }

  private goto(text: string): void {
    if (!this.m) return;
    const t = text.trim();
    if (!t) { this.follow(); this.refresh(); return; }
    const a = this.parse(this.m, t.includes(':') ? t : 'CS:' + t) ?? this.parse(this.m, t);
    if (!a) { this.note.textContent = '地址格式：段:偏移，例如 335D:32AD'; return; }
    this.view = a;
    this.refresh();
  }

  private rowsFit(): number {
    const h = this.list.clientHeight || 600;
    return Math.max(10, Math.ceil(h / 18) + 1);
  }

  /** 翻一页：向后从最后一条之后开始，向前回溯一屏 */
  private page(dir: 1 | -1): void {
    if (!this.m || !this.shown.length) return;
    const n = Math.max(5, this.rowsFit() - 3);
    this.scroll(dir * n);
  }

  /** 滚动 n 条指令（负数向前） */
  private scroll(n: number): void {
    const m = this.m!, seg = this.shownSeg;
    const read = this.reader(m, seg);
    const first = this.shown[0].offset;
    let off: number;
    if (n > 0) {
      const target = this.shown[Math.min(n, this.shown.length - 1)];
      off = n < this.shown.length ? target.offset : (target.offset + target.length) & this.offMask(m, seg);
    } else {
      off = disassembleAround(read, first, -n, 1, this.mode(m, seg), m.knownInstructionStarts(seg))[0].offset;
      if (off === first) off = (first - 1) & this.offMask(m, seg); // 回溯不到对齐的起点时至少退一个字节
    }
    this.view = { seg, off };
    this.refresh();
  }

  /** 段的基址：当前的 CS 用 CPU 里的描述符缓存（保护模式下不是 段值 × 16），其他段按实模式算 */
  private base(m: Machine, seg: number): number {
    return seg === m.cpu.s[CS] ? m.cpu.segBase(CS) : seg << 4;
  }
  private is32(m: Machine, seg: number): boolean { return seg === m.cpu.s[CS] && m.cpu.code32; }
  private offMask(m: Machine, seg: number): number { return this.is32(m, seg) ? 0xffffffff : 0xffff; }
  private mode(m: Machine, seg: number) { return { is286: m.cpu.is286, is386: m.cpu.is386, code32: this.is32(m, seg) }; }
  private reader(m: Machine, seg: number) {
    const base = this.base(m, seg), mask = this.offMask(m, seg);
    return (o: number) => m.cpu.peekLin(base + ((o & mask) >>> 0));
  }

  render(m: Machine, breakpoints: Set<number>): void {
    this.m = m; this.bps = breakpoints;
    const p = m.program;
    if (!p) { this.list.innerHTML = '<div class="empty">尚未装载程序</div>'; this.shown = []; return; }
    const cpu = m.cpu;
    const following = this.view === null;
    const seg = following ? cpu.s[CS] : this.view!.seg;
    const read = this.reader(m, seg);
    const rows = this.rowsFit();
    const mode = this.mode(m, seg), base = this.base(m, seg);
    const hx = (v: number) => (v > 0xffff ? (v >>> 0).toString(16).toUpperCase().padStart(8, '0') : h4(v));
    const list = (following ? disassembleAround(read, cpu.ip, 8, rows, mode, m.knownInstructionStarts(seg)) : disassembleAround(read, this.view!.off, 0, rows, mode))
      .map(i => trapAware(read, seg, i));
    this.shown = list; this.shownSeg = seg;
    if (document.activeElement !== this.input) this.input.value = following ? `${h4(cpu.s[CS])}:${hx(cpu.ip)}` : `${h4(seg)}:${hx(list[0].offset)}`;
    this.note.textContent = following ? '' : `当前指令在 ${h4(cpu.s[CS])}:${hx(cpu.ip)}`;
    // 标号和变量名：线性地址 -> 名字
    const names = new Map<number, string>();
    for (const s of p.symbols) if (s.kind !== 'const') names.set(s.segment * 16 + s.offset, s.name);
    const where = seg === 0xf000 ? '（BIOS/DOS 内部的桩代码）' : p.addrToLine.size === 0 ? '（没有源码）' : '';
    const pm = cpu.protectedMode ? (cpu.v86 ? '，虚拟 8086 模式' : `，保护模式，基址 ${(base >>> 0).toString(16).toUpperCase()}h${mode.code32 ? '，32 位代码' : ''}`) : '';
    let html = `<div class="dhead mono">CS = ${h4(seg)}${where}${pm}　双击一行：运行到那里；点左侧：设断点；滚轮翻动</div>`;
    const curLin = cpu.linearIP;
    for (const ins of list) {
      const lin = (base + ins.offset) >>> 0;
      const cur = lin === curLin;
      const bp = breakpoints.has(lin);
      const label = names.get(lin);
      const line = p.addrToLine.get(lin);
      let note = '';
      if (ins.target !== undefined) {
        const tlin = ((ins.targetSeg ?? seg) << 4) + ins.target;
        const tn = names.get(tlin & 0xfffff);
        if (tn) note = tn;
      }
      const cls = 'drow' + (cur ? ' cur' : '') + (bp ? ' bp' : '') + (ins.undocumented ? ' odd' : '');
      html += `<div class="${cls}" data-lin="${lin}">` +
        `<span class="dg" title="${bp ? '取消断点' : '设断点'}">${bp ? '●' : cur ? '➤' : ''}</span>` +
        `<span class="da">${label ? `<b>${esc(label)}</b>` : ''}${h4(seg)}:${hx(ins.offset)}</span>` +
        `<span class="db">${ins.bytes.slice(0, 6).map(h2).join(' ')}${ins.bytes.length > 6 ? '…' : ''}</span>` +
        `<span class="dt">${esc(ins.text)}${note ? `<span class="dn"> ; ${esc(note)}</span>` : ''}</span>` +
        `<span class="dl">${line ? `<a data-line="${line}">第 ${line} 行</a>` : ''}</span></div>`;
    }
    this.list.innerHTML = html;
  }
}

/** BIOS 桩代码里的陷阱指令（F1 nn）：显示成"INT nn 的模拟实现" */
function trapAware(read: (o: number) => number, cs: number, ins: Instruction): Instruction {
  if (cs !== BIOS_SEG || read(ins.offset) !== TRAP_OPCODE) return ins;
  const n = read(ins.offset + 1);
  const text = `[INT ${h2(n)}h 的功能由模拟器实现]`;
  return { ...ins, length: 2, bytes: [TRAP_OPCODE, n], text, mnemonic: 'TRAP' };
}

/** 当前指令的文字（没有源码时显示在寄存器面板上方） */
export function currentInstruction(m: Machine): Instruction {
  const cpu = m.cpu, cs = cpu.s[CS], base = cpu.segBase(CS), mask = cpu.code32 ? 0xffffffff : 0xffff;
  const read = (o: number) => cpu.peekLin(base + ((o & mask) >>> 0));
  return trapAware(read, cs, disassemble(read, cpu.ip, { is286: cpu.is286, is386: cpu.is386, code32: cpu.code32 }));
}
