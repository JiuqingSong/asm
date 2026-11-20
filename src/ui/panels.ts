// 寄存器、标志位、栈、变量、内存面板
import { AX, BX, CX, DX, SP, BP, SI, DI, ES, CS, SS, DS, FS, GS, type CPU } from '../cpu/cpu.ts';
import type { Machine } from '../machine/machine.ts';
import type { Program, ProgramSymbol } from '../asm/types.ts';
import type { FpuSnapshot } from '../cpu/x87.ts';

/** 某一时刻的 CPU 状态快照（用于高亮"刚刚改变"的值） */
export interface Snapshot {
  r: Uint16Array;
  /** 386 寄存器的高 16 位 */
  rh: Uint16Array;
  s: Uint16Array;
  ip: number;
  flags: number;
  mem: Uint8Array;
  fpu: FpuSnapshot | null;
}

export function takeSnapshot(m: Machine): Snapshot {
  return { r: m.cpu.r.slice(), rh: m.cpu.rh.slice(), s: m.cpu.s.slice(), ip: m.cpu.ip, flags: m.cpu.flags, mem: m.mem.slice(), fpu: m.cpu.fpuEnabled ? m.cpu.fpu!.snapshot() : null };
}

export const h2 = (v: number) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const h4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function el(tag: string, cls = '', html = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

// ======================= 寄存器 =======================

const GP: [string, number, string][] = [
  ['AX', AX, '累加器：乘除法、I/O、DOS 功能号（AH）'],
  ['BX', BX, '基址寄存器：可用于 [BX] 间接寻址'],
  ['CX', CX, '计数器：LOOP、REP、移位次数（CL）'],
  ['DX', DX, '数据寄存器：I/O 端口号、乘除法的高 16 位'],
];
const IDX: [string, number, string][] = [
  ['SI', SI, '源变址：串操作的源 DS:SI'], ['DI', DI, '目的变址：串操作的目的 ES:DI'],
  ['BP', BP, '基址指针：默认用 SS 段，常用来访问栈中的参数'], ['SP', SP, '栈指针：栈顶位置 SS:SP'],
];
const SEGS: [string, number, string][] = [
  ['CS', CS, '代码段'], ['DS', DS, '数据段'], ['ES', ES, '附加段'], ['SS', SS, '堆栈段'],
];
const SEGS386: [string, number, string][] = [['FS', FS, '附加段（386）'], ['GS', GS, '附加段（386）']];
const E32: [string, number][] = [['EAX', AX], ['EBX', BX], ['ECX', CX], ['EDX', DX], ['ESI', SI], ['EDI', DI], ['EBP', BP], ['ESP', SP]];
const h8 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const FLAGS: [string, number, string][] = [
  ['OF', 0x800, '溢出标志：有符号运算结果超出范围'], ['DF', 0x400, '方向标志：串操作地址递减（1）或递增（0）'],
  ['IF', 0x200, '中断允许标志：1 时响应硬件中断'], ['TF', 0x100, '陷阱标志：单步中断'],
  ['SF', 0x80, '符号标志：结果最高位为 1（负数）'], ['ZF', 0x40, '零标志：结果为 0'],
  ['AF', 0x10, '辅助进位标志：低 4 位向高 4 位进位/借位'], ['PF', 0x4, '奇偶标志：结果低 8 位中 1 的个数为偶数'],
  ['CF', 0x1, '进位标志：无符号运算的进位/借位'],
];

export class RegisterPanel {
  private regsEl: HTMLElement;
  private flagsEl: HTMLElement;
  private csipEl: HTMLElement;

  constructor(regsEl: HTMLElement, flagsEl: HTMLElement, csipEl: HTMLElement) {
    this.regsEl = regsEl; this.flagsEl = flagsEl; this.csipEl = csipEl;
  }

  render(cpu: CPU, prev: Snapshot | null, lineInfo: string): void {
    const r = cpu.r;
    const cells = el('div', 'cells');
    for (const [name, i, tip] of GP) {
      const v = r[i], pv = prev ? prev.r[i] : v;
      const hiCh = (v >> 8) !== (pv >> 8), loCh = (v & 0xff) !== (pv & 0xff);
      const c = el('div', 'cell' + (hiCh || loCh ? ' changed' : ''));
      c.dataset.reg = 'r' + i;
      c.title = `${tip}\n${v}（有符号 ${(v << 16) >> 16}）\n二进制 ${v.toString(2).padStart(16, '0').replace(/(.{4})/g, '$1 ').trim()}`;
      c.innerHTML = `<div class="name"><span>${name[0]}H</span><span>${name}</span><span>${name[0]}L</span></div>` +
        `<div class="halves"><span class="${hiCh ? 'changed' : ''}">${h2(v >> 8)}</span><span class="${loCh ? 'changed' : ''}">${h2(v)}</span></div>` +
        `<div class="dec">${v}</div>`;
      cells.appendChild(c);
    }
    const line = (list: [string, number, string][], arr: Uint16Array, parr: Uint16Array | null, kind = 'r') => {
      const d = el('div', 'regline');
      for (const [name, i, tip] of list) {
        const ch = parr && parr[i] !== arr[i];
        const e = el('div', 'reg' + (ch ? ' changed' : ''), `<b>${name}</b><span>${h4(arr[i])}</span>`);
        e.title = `${tip}\n${arr[i]}`;
        e.dataset.reg = kind + i;
        d.appendChild(e);
      }
      return d;
    };
    const ipCh = prev && prev.ip !== cpu.ip;
    const flCh = prev && prev.flags !== cpu.flags;
    const misc = el('div', 'regline');
    const wideIp = cpu.ip > 0xffff, wideFl = cpu.flags > 0xffff;
    const ipEl = Object.assign(el('div', 'reg wide' + (ipCh ? ' changed' : ''), `<b>${wideIp ? 'EIP' : 'IP'}</b><span>${wideIp ? h8(cpu.ip) : h4(cpu.ip)}</span>`), { title: '指令指针：下一条要执行的指令 CS:IP' });
    const flEl = Object.assign(el('div', 'reg wide' + (flCh ? ' changed' : ''), `<b>${wideFl ? 'EFLAGS' : 'FLAGS'}</b><span>${wideFl ? h8(cpu.flags) : h4(cpu.flags)}</span>`), { title: '标志寄存器' + (cpu.flags & 0x20000 ? '（VM = 1：虚拟 8086 模式）' : '') });
    ipEl.dataset.reg = 'ip';
    flEl.dataset.reg = 'flags';
    misc.append(ipEl, flEl);
    const rows: HTMLElement[] = [cells, line(IDX, r, prev?.r ?? null), line(cpu.is386 ? [...SEGS, ...SEGS386] : SEGS, cpu.s, prev?.s ?? null, 's'), misc];
    if (cpu.is386) {
      // 386：32 位寄存器（低 16 位就是上面的 AX 等）
      const d = el('div', 'regline e32');
      for (const [name, i] of E32) {
        const ch = prev && (prev.rh[i] !== cpu.rh[i] || prev.r[i] !== cpu.r[i]);
        const e = el('div', 'reg' + (ch ? ' changed' : ''), `<b>${name}</b><span>${h8(cpu.r32(i))}</span>`);
        e.title = `${name}：32 位寄存器，低 16 位是 ${name.slice(1)}
${cpu.r32(i)}`;
        d.appendChild(e);
      }
      rows.splice(3, 0, d);
    }
    if (cpu.fpuEnabled) {
      const fpu = cpu.fpu!;
      const details = document.createElement('details');
      details.className = 'x87';
      details.open = this.regsEl.querySelector<HTMLDetailsElement>('details.x87')?.open ?? false;
      details.append(el('summary', '', `x87 · TOP=${fpu.top} · CW=${h4(fpu.control)} SW=${h4(fpu.statusWord)} TW=${h4(fpu.tagWord)}`));
      const registers = el('div', 'regline x87-registers');
      for (let k = 0; k < 8; k++) {
        const value = fpu.st(k), physical = (fpu.top + k) & 7;
        const changed = prev?.fpu && (prev.fpu.registers[physical] !== value || prev.fpu.tags[physical] !== fpu.tag(k));
        const text = fpu.tag(k) === 3 ? '空' : value.toString(16).toUpperCase().padStart(20, '0');
        const cell = el('div', 'reg' + (changed ? ' changed' : ''), `<b>ST(${k})</b><span>${text}</span>`);
        cell.title = '80 位原始值：符号/指数 16 位 + 尾数 64 位';
        registers.append(cell);
      }
      details.append(registers); rows.push(details);
    }
    this.regsEl.replaceChildren(...rows);

    this.flagsEl.replaceChildren();
    for (const [name, mask, tip] of FLAGS) {
      const on = (cpu.flags & mask) !== 0;
      const ch = prev && ((prev.flags ^ cpu.flags) & mask);
      const f = el('div', 'flag' + (on ? ' on' : '') + (ch ? ' changed' : ''), `<b>${name}</b>${on ? 1 : 0}`);
      f.dataset.flag = String(mask);
      f.title = tip;
      this.flagsEl.appendChild(f);
    }
    this.csipEl.textContent = `${h4(cpu.s[CS])}:${h4(cpu.ip)}${lineInfo ? '  ' + lineInfo : ''}`;
  }
}

// ======================= 栈 =======================

export class StackPanel {
  private elm: HTMLElement;
  private noteEl: HTMLElement;
  /** 返回地址（CALL/INT 之后那条指令的线性地址）-> 所在的源码行和指令类型 */
  private retAddrs = new Map<number, { line: number; int: boolean }>();
  onLineClick: ((line: number) => void) | null = null;

  constructor(elm: HTMLElement, noteEl: HTMLElement) {
    this.elm = elm; this.noteEl = noteEl;
    elm.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('a[data-line]') as HTMLElement | null;
      if (a && this.onLineClick) this.onLineClick(+a.dataset.line!);
    });
  }

  setProgram(p: Program | null): void {
    this.retAddrs.clear();
    if (!p) return;
    for (const e of p.listing) {
      if (!e.isCode || !e.bytes.length) continue;
      let k = 0;
      while ([0x26, 0x2e, 0x36, 0x3e].includes(e.bytes[k])) k++;
      const op = e.bytes[k], op2 = e.bytes[k + 1];
      const isCall = op === 0xe8 || op === 0x9a || (op === 0xff && ((op2 >> 3) & 7) >= 2 && ((op2 >> 3) & 7) <= 3) || (op === 0x0e && op2 === 0xe8);
      const isInt = op === 0xcd || op === 0xcc;
      if (isCall || isInt) this.retAddrs.set(e.segment * 16 + e.offset + e.bytes.length, { line: e.line, int: isInt });
    }
  }

  render(m: Machine, prev: Snapshot | null): void {
    const cpu = m.cpu, p = m.program;
    const ss = cpu.s[SS], sp = cpu.r[SP], bp = cpu.r[BP];
    const top = p && ss === p.stack.ss ? p.stack.sp || 0x10000 : Math.min(0x10000, sp + 32);
    const used = top - sp;
    this.noteEl.textContent = p ? `SS:SP = ${h4(ss)}:${h4(sp)}  已用 ${Math.max(0, used)} 字节` : '';
    if (!p) { this.elm.replaceChildren(el('div', 'stack-empty', '尚未装载程序')); return; }
    const rows: HTMLElement[] = [];
    const maxRows = 14;
    const start = Math.max(0, sp - 4);
    const word = (o: number) => cpu.rw(ss, o);
    const items: number[] = [];
    for (let o = start; o < top && items.length < maxRows + 2; o += 2) items.push(o);
    if (used <= 0) rows.push(el('div', 'stack-empty', '栈是空的（SP 指向栈底）'));
    for (const o of items) {
      const v = word(o);
      const lin = ss * 16 + o;
      const changed = prev && (prev.mem[lin] !== m.mem[lin] || prev.mem[lin + 1] !== m.mem[lin + 1]) && o >= sp;
      const cls = 'srow' + (o < sp ? ' below' : '') + (o === sp ? ' top' : '') + (changed ? ' changed' : '');
      const ptr = [o === sp ? 'SP' : '', o === bp && bp >= sp && bp < top ? 'BP' : ''].filter(Boolean).join(' ');
      let ann = '';
      if (o >= sp) {
        const link = (l: number) => `第 <a data-line="${l}">${l}</a> 行`;
        const far = o + 2 < top ? this.retAddrs.get(word(o + 2) * 16 + v) : undefined;
        const near = this.retAddrs.get(cpu.s[CS] * 16 + v);
        const prevFar = o - 2 >= sp ? this.retAddrs.get(v * 16 + word(o - 2)) : undefined;
        const prev2 = o - 4 >= sp ? this.retAddrs.get(word(o - 2) * 16 + word(o - 4)) : undefined;
        if (far && (far.int || word(o + 2) !== cpu.s[CS])) ann = far.int ? `INT 返回地址 IP（${link(far.line)}）` : `远返回地址 IP（${link(far.line)}调用）`;
        else if (near && !near.int) ann = `返回地址 → ${link(near.line)}之后`;
        else if (prevFar && (prevFar.int || v !== cpu.s[CS])) ann = prevFar.int ? 'INT 返回地址 CS' : '远返回地址 CS';
        else if (prev2 && prev2.int) ann = 'INT 保存的 FLAGS';
        if (o === bp && bp >= sp) ann = ann || '保存的 BP / 参数区';
      } else ann = '（已弹出）';
      rows.push(el('div', cls, `<span class="ptr">${ptr}</span><span class="addr">${h4(ss)}:${h4(o)}</span><span class="val">${h4(v)}</span><span class="ann">${ann}</span>`));
    }
    if (top - sp > maxRows * 2) rows.push(el('div', 'stack-empty', `… 下面还有 ${(top - sp) / 2 - maxRows} 项`));
    this.elm.replaceChildren(...rows);
  }
}

// ======================= 变量 =======================

export class VarsPanel {
  private elm: HTMLElement;
  decimal = false;
  onAddrClick: ((seg: number, off: number) => void) | null = null;
  onLineClick: ((line: number) => void) | null = null;

  constructor(elm: HTMLElement) {
    this.elm = elm;
    elm.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const a = t.closest('a[data-seg]') as HTMLElement | null;
      if (a && this.onAddrClick) this.onAddrClick(+a.dataset.seg!, +a.dataset.off!);
      const l = t.closest('a[data-line]') as HTMLElement | null;
      if (l && this.onLineClick) this.onLineClick(+l.dataset.line!);
      if (t.closest('[data-toggle-dec]')) { this.decimal = !this.decimal; this.rerender?.(); }
    });
  }
  private rerender: (() => void) | null = null;

  render(m: Machine, prev: Snapshot | null): void {
    this.rerender = () => this.render(m, prev);
    const p = m.program;
    if (!p) { this.elm.innerHTML = '<div class="empty">尚未装载程序</div>'; return; }
    const vars = p.symbols.filter(s => s.kind === 'var').sort((a, b) => a.segment * 16 + a.offset - (b.segment * 16 + b.offset));
    const consts = p.symbols.filter(s => s.kind === 'const');
    if (!vars.length && !consts.length) { this.elm.innerHTML = '<div class="empty">程序中没有定义变量</div>'; return; }
    let html = `<table class="vars"><thead><tr><th>变量</th><th>地址</th><th>类型</th><th>当前值 <a data-toggle-dec title="切换十六进制 / 十进制">[${this.decimal ? '十进制' : '十六进制'}]</a></th></tr></thead><tbody>`;
    for (const s of vars) {
      const lin = s.segment * 16 + s.offset;
      const bytes = Math.max(s.size, s.type <= 10 ? s.type : 0);
      let changed = false;
      if (prev) for (let k = 0; k < Math.min(bytes, 4096); k++) if (prev.mem[lin + k] !== m.mem[lin + k]) { changed = true; break; }
      html += `<tr class="${changed ? 'changed' : ''}"><td><a data-line="${s.line}" title="跳到定义处（第 ${s.line} 行）">${esc(s.name)}</a></td>` +
        `<td class="mono"><a data-seg="${s.segment}" data-off="${s.offset}" title="在内存窗口中查看">${h4(s.segment)}:${h4(s.offset)}</a></td>` +
        `<td>${typeLabel(s)}</td><td class="v">${esc(this.format(m, s))}</td></tr>`;
    }
    for (const c of consts) {
      html += `<tr><td><a data-line="${c.line}">${esc(c.name)}</a></td><td></td><td>常量</td><td class="v">${this.num(c.value ?? 0, 2)}</td></tr>`;
    }
    this.elm.innerHTML = html + '</tbody></table>';
  }

  private num(v: number, size: number): string {
    if (this.decimal) return String(v);
    return (size === 1 ? h2(v) : size === 2 ? h4(v) : (v >>> 0).toString(16).toUpperCase().padStart(8, '0')) + 'h';
  }

  private format(m: Machine, s: ProgramSymbol): string {
    const lin = s.segment * 16 + s.offset;
    const mem = m.mem;
    const t = s.type <= 10 ? s.type : 1;
    const count = Math.max(1, s.length);
    const maxItems = t === 1 ? 24 : 12;
    const out: string[] = [];
    for (let k = 0; k < Math.min(count, maxItems); k++) {
      const a = lin + k * t;
      if (t === 1) out.push(this.decimal ? String(mem[a]) : h2(mem[a]));
      else if (t === 2) out.push(this.num(mem[a] | (mem[a + 1] << 8), 2));
      else if (t === 4) {
        const lo = mem[a] | (mem[a + 1] << 8), hi = mem[a + 2] | (mem[a + 3] << 8);
        out.push(this.decimal ? String(hi * 65536 + lo) : `${h4(hi)}:${h4(lo)}`);
      } else out.push(Array.from(mem.subarray(a, a + t)).reverse().map(h2).join('') + 'h');
    }
    let txt = out.join(' ') + (count > maxItems ? ' …' : '');
    if (t === 1 && count === 1) {
      const v = mem[lin];
      txt = this.decimal ? `${v}` : `${h2(v)}h (${v})`;
      if (v >= 32 && v < 127) txt += ` '${String.fromCharCode(v)}'`;
    } else if (t === 1) {
      let str = '';
      let printable = 0;
      for (let k = 0; k < Math.min(count, 40); k++) {
        const c = mem[lin + k];
        if (c >= 32 && c < 127) { str += String.fromCharCode(c); printable++; } else str += '·';
      }
      if (printable >= Math.min(count, 40) / 2) txt += `   "${str}${count > 40 ? '…' : ''}"`;
    } else if (t === 2 && count === 1 && !this.decimal) {
      const v = mem[lin] | (mem[lin + 1] << 8);
      txt += ` (${v})`;
    }
    return txt;
  }
}

function typeLabel(s: ProgramSymbol): string {
  const n = s.type === 1 ? 'DB' : s.type === 2 ? 'DW' : s.type === 4 ? 'DD' : s.type === 8 ? 'DQ' : s.type === 10 ? 'DT' : '?';
  return s.length > 1 ? `${n} ×${s.length}` : n;
}

// ======================= 内存 =======================

export class MemoryPanel {
  private elm: HTMLElement;
  private input: HTMLInputElement;
  expr = 'DS:0000';

  constructor(elm: HTMLElement, input: HTMLInputElement) {
    this.elm = elm; this.input = input;
  }

  /** 解析地址表达式：段:偏移，段/偏移可以是十六进制数、寄存器或变量名 */
  parse(m: Machine, text: string): { seg: number; off: number } | null {
    const cpu = m.cpu;
    const regs: Record<string, number> = {
      ax: cpu.r[AX], bx: cpu.r[BX], cx: cpu.r[CX], dx: cpu.r[DX], si: cpu.r[SI], di: cpu.r[DI], bp: cpu.r[BP], sp: cpu.r[SP],
      cs: cpu.s[CS], ds: cpu.s[DS], es: cpu.s[ES], ss: cpu.s[SS], ip: cpu.ip,
    };
    const val = (t: string): number | null => {
      t = t.trim().toLowerCase();
      if (!t) return null;
      if (t in regs) return regs[t];
      const sym = m.program?.symbols.find(s => s.name.toLowerCase() === t && s.kind !== 'const');
      if (sym) return sym.offset;
      const plus = t.split('+');
      if (plus.length > 1) {
        let sum = 0;
        for (const p of plus) { const v = val(p); if (v === null) return null; sum += v; }
        return sum & 0xffff;
      }
      const n = t.replace(/h$/, '');
      if (/^[0-9a-f]+$/.test(n)) return parseInt(n, 16);
      return null;
    };
    const parts = text.split(':');
    if (parts.length === 2) {
      const seg = val(parts[0]), off = val(parts[1]);
      if (seg === null || off === null) return null;
      return { seg: seg & 0xffff, off: off & 0xffff };
    }
    if (parts.length === 1) {
      const t = parts[0].trim().toLowerCase();
      const sym = m.program?.symbols.find(s => s.name.toLowerCase() === t && s.kind !== 'const');
      if (sym) return { seg: sym.segment, off: sym.offset };
      const off = val(t);
      if (off === null) return null;
      return { seg: cpu.s[DS], off };
    }
    return null;
  }

  go(seg: number, off: number): void {
    this.expr = `${h4(seg)}:${h4(off)}`;
    this.input.value = this.expr;
  }

  page(m: Machine, delta: number): void {
    const a = this.parse(m, this.expr);
    if (!a) return;
    this.go(a.seg, (a.off + delta) & 0xffff);
  }

  render(m: Machine, prev: Snapshot | null): void {
    const a = this.parse(m, this.expr);
    if (!a) { this.elm.innerHTML = '<div class="empty">地址格式：段:偏移，例如 DS:0000、B800:0000、ES:DI，或者变量名</div>'; return; }
    const varAt = new Map<number, string>();
    for (const s of m.program?.symbols ?? []) {
      if (s.kind !== 'var') continue;
      const lin = s.segment * 16 + s.offset;
      for (let k = 0; k < Math.min(s.size || s.type, 4096); k++) if (!varAt.has(lin + k)) varAt.set(lin + k, s.name);
    }
    let html = '';
    const rowStart = a.off & 0xfff0;
    for (let row = 0; row < 16; row++) {
      const off = (rowStart + row * 16) & 0xffff;
      let bytes = '', chars = '';
      for (let k = 0; k < 16; k++) {
        const o = (off + k) & 0xffff;
        const lin = ((a.seg << 4) + o) & 0xfffff;
        const b = m.mem[lin];
        const ch = prev && prev.mem[lin] !== b;
        const v = varAt.get(lin);
        const cls = [ch ? 'changed' : '', v ? 'var' : ''].filter(Boolean).join(' ');
        bytes += `<span class="${cls}"${v ? ` title="${esc(v)}"` : ''}>${h2(b)}</span>`;
        if (k === 7) bytes += ' ';
        chars += b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '·';
      }
      html += `<div class="mrow"><span class="ma">${h4(a.seg)}:${h4(off)}</span><span class="mb">${bytes}</span><span class="mc">${chars}</span></div>`;
    }
    this.elm.innerHTML = html;
  }
}
