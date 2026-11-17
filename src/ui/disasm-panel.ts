// 反汇编面板：显示 CS:IP 前后的指令；点左侧设断点，双击一行运行到那里
import { CS } from '../cpu/cpu.ts';
import { disassembleAround, disassemble, type Instruction } from '../cpu/disasm.ts';
import type { Machine } from '../machine/machine.ts';
import { h2, h4 } from './panels.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class DisasmPanel {
  private el: HTMLElement;
  onToggleBp: ((lin: number) => void) | null = null;
  onRunTo: ((lin: number) => void) | null = null;
  onLine: ((line: number) => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const row = t.closest('.drow') as HTMLElement | null;
      if (!row) return;
      if (t.closest('.dg')) this.onToggleBp?.(+row.dataset.lin!);
      const a = t.closest('a[data-line]') as HTMLElement | null;
      if (a) this.onLine?.(+a.dataset.line!);
    });
    el.addEventListener('dblclick', e => {
      const row = (e.target as HTMLElement).closest('.drow') as HTMLElement | null;
      if (row && !(e.target as HTMLElement).closest('.dg')) this.onRunTo?.(+row.dataset.lin!);
    });
  }

  render(m: Machine, breakpoints: Set<number>): void {
    const p = m.program;
    if (!p) { this.el.innerHTML = '<div class="empty">尚未装载程序</div>'; return; }
    const cs = m.cpu.s[CS], ip = m.cpu.ip;
    const read = (o: number) => m.mem[((cs << 4) + (o & 0xffff)) & 0xfffff];
    const list = disassembleAround(read, ip, 8, 30);
    // 标号和变量名：线性地址 -> 名字
    const names = new Map<number, string>();
    for (const s of p.symbols) if (s.kind !== 'const') names.set(s.segment * 16 + s.offset, s.name);
    const where = cs === 0xf000 ? '（BIOS/DOS 内部的桩代码）' : p.addrToLine.size === 0 ? '（没有源码）' : '';
    let html = `<div class="dhead mono">CS = ${h4(cs)}${where}　双击一行：运行到那里；点左侧：设断点</div>`;
    for (const ins of list) {
      const lin = ((cs << 4) + ins.offset) & 0xfffff;
      const cur = ins.offset === ip;
      const bp = breakpoints.has(lin);
      const label = names.get(lin);
      const line = p.addrToLine.get(lin);
      let note = '';
      if (ins.target !== undefined) {
        const tlin = ((ins.targetSeg ?? cs) << 4) + ins.target;
        const tn = names.get(tlin & 0xfffff);
        if (tn) note = tn;
      }
      const cls = 'drow' + (cur ? ' cur' : '') + (bp ? ' bp' : '') + (ins.undocumented ? ' odd' : '');
      html += `<div class="${cls}" data-lin="${lin}">` +
        `<span class="dg" title="${bp ? '取消断点' : '设断点'}">${bp ? '●' : cur ? '➤' : ''}</span>` +
        `<span class="da">${label ? `<b>${esc(label)}</b>` : ''}${h4(cs)}:${h4(ins.offset)}</span>` +
        `<span class="db">${ins.bytes.slice(0, 6).map(h2).join(' ')}${ins.bytes.length > 6 ? '…' : ''}</span>` +
        `<span class="dt">${esc(ins.text)}${note ? `<span class="dn"> ; ${esc(note)}</span>` : ''}</span>` +
        `<span class="dl">${line ? `<a data-line="${line}">第 ${line} 行</a>` : ''}</span></div>`;
    }
    this.el.innerHTML = html;
    this.el.querySelector('.drow.cur')?.scrollIntoView({ block: 'nearest' });
  }
}

/** 当前指令的文字（没有源码时显示在寄存器面板上方） */
export function currentInstruction(m: Machine): Instruction {
  const cs = m.cpu.s[CS];
  return disassemble(o => m.mem[((cs << 4) + (o & 0xffff)) & 0xfffff], m.cpu.ip);
}
