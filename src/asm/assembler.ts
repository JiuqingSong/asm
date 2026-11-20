// MASM 子集汇编器：源代码 -> 内存映像 + 源码映射
//
// 采用多遍扫描：每一遍完整处理一次源代码，向前引用使用上一遍得到的符号值，
// 直到所有符号的地址都不再变化。跳转指令先按短跳转生成，放不下时改为长跳转（跨遍保持）。
import { AsmError, stripComment, tokenize, type Token } from './lexer.ts';
import { Encoder, newVal, isMnemonic, isCoreMnemonic, cpuLevelOf, PREFIXES, R_BX, R_BP, R_SI, R_DI, type Val } from './encoder.ts';
import {
  T_FAR, T_NEAR, type Diag, type Frame, type Group, type Program, type ProgramSymbol, type Segment, type Sym,
} from './types.ts';

interface SrcLine { text: string; line: number }
interface MacroDef { name: string; params: { name: string; req: boolean; def: string }[]; body: string[] }
interface CondState { active: boolean; taken: boolean; parentActive: boolean }

class ExitMacro { }

const REG16: Record<string, number> = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
const REG8: Record<string, number> = { al: 0, cl: 1, dl: 2, bl: 3, ah: 4, ch: 5, dh: 6, bh: 7 };
const SREG: Record<string, number> = { es: 0, cs: 1, ss: 2, ds: 3 };
const TYPES: Record<string, number> = {
  byte: 1, sbyte: 1, word: 2, sword: 2, dword: 4, sdword: 4, fword: 6, qword: 8, tbyte: 10, near: T_NEAR, far: T_FAR,
};
const DATA_DIRS: Record<string, number> = {
  db: 1, dw: 2, dd: 4, dq: 8, dt: 10, byte: 1, sbyte: 1, word: 2, sword: 2, dword: 4, sdword: 4, qword: 8, tbyte: 10,
};
const IGNORED = new Set([
  'title', 'subttl', 'page', 'name', '.list', '.nolist', '.xlist', '.lall', '.sall', '.xall', '.cref', '.xcref',
  '.lfcond', '.sfcond', '.tfcond', 'public', 'option', '.listall', '.listmacro', '.nolistmacro', '.listmacroall',
  '.listif', '.nolistif', '%out', 'echo', 'dosseg', '.dosseg', '.seq', '.alpha',
]);
const CPU_DIRS = new Set(['.8086', '.8087', '.186', '.286', '.286c', '.286p', '.287', '.386', '.386p', '.387',
  '.486', '.486p', '.586', '.586p', '.no87']);
const REPEAT_DIRS = new Set(['rept', 'repeat', 'irp', 'for', 'irpc', 'forc', 'while']);
const COND_DIRS = new Set(['if', 'ife', 'ifdef', 'ifndef', 'ifb', 'ifnb', 'ifidn', 'ifidni', 'ifdif', 'ifdifi',
  'else', 'elseif', 'elseife', 'elseifdef', 'elseifndef', 'endif', 'if1', 'if2']);

export interface AssembleOptions {
  /** 程序映像装载的段地址（默认 0x1000） */
  loadSeg?: number;
}

export function assemble(source: string, opts: AssembleOptions = {}): Program {
  return new Assembler(source, opts.loadSeg ?? 0x1000).run();
}

class Assembler {
  private lines: SrcLine[];
  private loadSeg: number;
  private diags: Diag[] = [];
  private pass = 0;
  private syms = new Map<string, Sym>();
  private segMap = new Map<string, Segment>();
  private groupMap = new Map<string, Group>();
  private segList: Segment[] = [];
  private cur: Segment | null = null;
  private segStack: Segment[] = [];
  private assume: (Frame | null)[] = [null, null, null, null];
  private procStack: Sym[] = [];
  private model = '';
  /** .186 / .286 / .286P 打开的指令集（0 = 8086），以及实际用到的最高一级 */
  private cpu = 0;
  private cpuUsed = 0;
  private macros = new Map<string, MacroDef>();
  private localCounter = 0;
  private macroDepth = 0;
  private cond: CondState[] = [];
  private ended = false;
  private endSeen = false;
  private entry: Val | null = null;
  private startupEntry: Val | null = null;
  private listing: { line: number; seg: Segment; offset: number; bytes: number[]; isCode: boolean }[] = [];
  private stmtIndex = 0;
  private longJumps = new Set<number>();
  private undefRefs = new Map<string, { line: number; col: number; name: string }>();
  private curLine = 0;
  private encoder = new Encoder();
  private relocations = new Map<Segment, Set<number>>();
  private segOrderCounter = 0;
  private isCom = false;

  constructor(source: string, loadSeg: number) {
    this.lines = source.split(/\r?\n/).map((text, i) => ({ text, line: i + 1 }));
    this.loadSeg = loadSeg;
  }

  run(): Program {
    let prevSig = '';
    const MAX_PASSES = 25;
    for (this.pass = 1; this.pass <= MAX_PASSES; this.pass++) {
      this.runPass();
      const sig = this.signature();
      if (this.pass >= 2 && sig === prevSig) break;
      prevSig = sig;
      if (this.pass === MAX_PASSES) this.error(0, '汇编遍数过多，符号地址无法稳定（可能存在相互依赖的跳转或 EQU）');
    }
    return this.output();
  }

  // ======================= 诊断 =======================

  private error(line: number, message: string, col = -1): void {
    this.diags.push({ line, col, message, severity: 'error' });
  }
  private warn(message: string, line = this.curLine): void {
    if (this.diags.some(d => d.line === line && d.message === message)) return;
    this.diags.push({ line, col: -1, message, severity: 'warning' });
  }

  // ======================= 每一遍 =======================

  private runPass(): void {
    this.diags = [];
    for (const s of this.segMap.values()) {
      s.bytes = []; s.pc = 0; s.size = 0; s.loadStart = 0; s.orgSeen = false; s.emitted = false;
    }
    this.segList = [];
    this.cur = null;
    this.segStack = [];
    this.assume = [null, null, null, null];
    this.procStack = [];
    this.model = '';
    this.cpu = 0;
    this.cpuUsed = 0;
    this.macros.clear();
    this.localCounter = 0;
    this.cond = [];
    this.ended = false;
    this.endSeen = false;
    this.entry = null;
    this.startupEntry = null;
    this.listing = [];
    this.relocations.clear();
    this.stmtIndex = 0;
    this.undefRefs.clear();
    for (const g of this.groupMap.values()) g.segments = [];

    this.processLines(this.lines);

    const last = this.lines.length;
    if (this.cond.length) this.error(last, 'IF 缺少对应的 ENDIF');
    for (const p of this.procStack) this.error(p.line, `过程 ${p.name} 缺少 ENDP`);
    const openSeg = this.cur as Segment | null;
    if (openSeg && !this.isSimplified(openSeg)) this.error(last, `段 ${openSeg.name} 缺少 ENDS`);
    if (!this.endSeen) this.warn('源程序缺少 END 伪指令', last);
    for (const [name, ref] of this.undefRefs) {
      const s = this.syms.get(name);
      if (!s || s.pass !== this.pass) this.error(ref.line, `未定义的符号：${ref.name}`, ref.col);
    }
    this.layout();
  }

  private signature(): string {
    const parts: string[] = [];
    for (const [k, s] of this.syms) parts.push(`${k}:${s.kind}:${s.seg?.name ?? ''}:${s.offset}:${s.type}:${s.size}`);
    for (const s of this.segList) parts.push(`#${s.name}:${s.start}:${s.para}:${s.offsetInFrame}:${s.size}`);
    parts.push(`L${[...this.longJumps].join(',')}`);
    return parts.join('|');
  }

  private skipping(): boolean {
    return this.cond.length > 0 && !this.cond[this.cond.length - 1].active;
  }

  private processLines(lines: SrcLine[]): void {
    for (let i = 0; i < lines.length && !this.ended; i++) {
      const L = lines[i];
      this.curLine = L.line;
      try {
        i = this.processLine(lines, i);
      } catch (e) {
        if (e instanceof ExitMacro) throw e;
        if (e instanceof AsmError) this.error(L.line, e.message, e.col);
        else throw e;
      }
    }
  }

  private processLine(lines: SrcLine[], i: number): number {
    const L = lines[i];
    const raw = L.text;
    // COMMENT 定界符 ... 定界符
    const cm = raw.match(/^\s*comment\s+(\S)/i);
    if (cm && !this.skipping()) {
      const delim = cm[1];
      const restIdx = raw.toLowerCase().indexOf('comment') + 7;
      const after = raw.slice(raw.indexOf(delim, restIdx) + 1);
      if (after.includes(delim)) return i;
      for (let j = i + 1; j < lines.length; j++) if (lines[j].text.includes(delim)) return j;
      this.error(L.line, 'COMMENT 缺少结束定界符');
      return lines.length - 1;
    }

    let toks = tokenize(raw);
    if (!toks.length) return i;

    // 条件汇编
    const c0 = toks[0].lower;
    if (COND_DIRS.has(c0)) { this.conditional(c0, toks.slice(1), raw, toks[0]); return i; }
    if (this.skipping()) return i;

    const defining = toks.length > 1 && ['equ', 'textequ', 'macro', '='].includes(toks[1].lower);
    toks = this.expandText(toks, defining ? 1 : 0);
    if (!toks.length) return i;

    // 标号
    if (toks.length >= 2 && toks[0].kind === 'id' && toks[1].text === ':' && !(toks[0].lower in SREG)) {
      if (toks[2]?.text === ':') toks.splice(2, 1); // name::
      this.defineLabel(toks[0], T_NEAR);
      toks = toks.slice(2);
      if (!toks.length) return i;
    }

    const t0 = toks[0], t1 = toks[1];
    const w0 = t0.lower, w1 = t1?.lower ?? '';

    if (w1 === 'macro' && t0.kind === 'id') return this.collectMacro(lines, i, toks);
    if (REPEAT_DIRS.has(w0)) return this.collectRepeat(lines, i, toks);
    if (w0 === 'endm') { throw new AsmError('ENDM 没有对应的 MACRO 或 REPT'); }
    if (w0 === 'exitm') { if (this.macroDepth) throw new ExitMacro(); throw new AsmError('EXITM 只能用在宏里'); }
    if (w0 === 'local') { throw new AsmError('LOCAL 只能写在宏定义的开头'); }

    // .186 / .286 之后，PUSHA、INS、STR 这些就是指令（8086 方式下它们还可以当符号名）
    const newInstr = this.cpu > 0 && cpuLevelOf(w0) > 0;
    if (t1 && t0.kind === 'id' && !isCoreMnemonic(w0) && !newInstr && !(w0 in PREFIXES)) {
      if (w1 in DATA_DIRS && !(w0 in DATA_DIRS)) { this.defineData(t0, w1, toks.slice(2)); return i; }
      switch (w1) {
        case 'equ': this.equ(t0, toks.slice(2), raw, t1); return i;
        case '=': this.assign(t0, toks.slice(2)); return i;
        case 'textequ': this.textequ(t0, raw, t1); return i;
        case 'segment': this.segmentDir(t0, toks.slice(2)); return i;
        case 'ends': this.endsDir(t0); return i;
        case 'proc': this.procDir(t0, toks.slice(2)); return i;
        case 'endp': this.endpDir(t0); return i;
        case 'label': this.labelDir(t0, toks.slice(2)); return i;
        case 'group': this.groupDir(t0, toks.slice(2)); return i;
        case 'struc': case 'struct': case 'record': case 'union': case 'typedef':
          throw new AsmError(`暂不支持 ${t1.text.toUpperCase()}`);
      }
    }

    const mac = this.macros.get(w0);
    if (mac) { this.expandMacro(mac, L, raw, t0); return i; }

    if (this.directive(w0, toks)) return i;

    if (w0 in DATA_DIRS) { this.defineData(null, w0, toks.slice(1)); return i; }

    if (w0 in PREFIXES || isMnemonic(w0)) { this.instruction(toks); return i; }

    if (t1 && (isMnemonic(w1) || w1 in PREFIXES)) {
      throw new AsmError(`无法识别 "${t0.text}"。如果它是标号，后面要加冒号：${t0.text}:`, t0.col);
    }
    if (t0.kind === 'id' && this.syms.get(w0)?.kind === 'macro') {
      throw new AsmError(`宏 ${t0.text} 需要先定义后使用`, t0.col);
    }
    throw new AsmError(`无法识别的指令或伪指令：${t0.text}`, t0.col);
  }

  /** 展开文本宏（EQU 定义的文本） */
  private expandText(toks: Token[], skip: number): Token[] {
    let changed = true, depth = 0;
    while (changed && depth++ < 10) {
      changed = false;
      const out: Token[] = [];
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        const s = k >= skip && t.kind === 'id' ? this.syms.get(t.lower) : undefined;
        if (s && s.kind === 'text' && s.text !== undefined) {
          for (const nt of tokenize(s.text)) out.push({ ...nt, col: t.col });
          changed = true;
        } else out.push(t);
      }
      toks = out;
    }
    return toks;
  }

  // ======================= 条件汇编 =======================

  private conditional(d: string, args: Token[], raw: string, dt: Token): void {
    const top = this.cond[this.cond.length - 1];
    const parentActive = top ? top.active : true;
    const evalCond = (): boolean => {
      const base = d.replace(/^else/, '') || 'if';
      switch (base) {
        case 'if': return this.constExpr(args) !== 0;
        case 'ife': return this.constExpr(args) === 0;
        case 'ifdef': return args.length > 0 && this.isDefined(args[0].lower);
        case 'ifndef': return !(args.length > 0 && this.isDefined(args[0].lower));
        case 'if1': return true;
        case 'if2': return false;
        case 'ifb': case 'ifnb': {
          const rest = stripComment(raw).slice(dt.col + dt.text.length).trim().replace(/^<(.*)>$/, '$1').trim();
          return (rest === '') === (base === 'ifb');
        }
        case 'ifidn': case 'ifidni': case 'ifdif': case 'ifdifi': {
          const rest = stripComment(raw).slice(dt.col + dt.text.length);
          const parts = splitArgs(rest);
          let a = parts[0] ?? '', b = parts[1] ?? '';
          if (base.endsWith('i')) { a = a.toLowerCase(); b = b.toLowerCase(); }
          return (a === b) === base.startsWith('ifidn');
        }
      }
      throw new AsmError(`不支持的条件伪指令 ${d.toUpperCase()}`);
    };
    if (d === 'endif') {
      if (!top) throw new AsmError('ENDIF 没有对应的 IF');
      this.cond.pop();
      return;
    }
    if (d === 'else') {
      if (!top) throw new AsmError('ELSE 没有对应的 IF');
      top.active = top.parentActive && !top.taken;
      top.taken = true;
      return;
    }
    if (d.startsWith('else')) {
      if (!top) throw new AsmError(`${d.toUpperCase()} 没有对应的 IF`);
      const v = top.parentActive && !top.taken && evalCond();
      top.active = v;
      if (v) top.taken = true;
      return;
    }
    const v = parentActive && evalCond();
    this.cond.push({ active: v, taken: v, parentActive });
  }

  private isDefined(name: string): boolean {
    const s = this.syms.get(name);
    return !!s && s.pass === this.pass;
  }

  // ======================= 宏 =======================

  private blockEnd(lines: SrcLine[], i: number): number {
    let depth = 1;
    for (let j = i + 1; j < lines.length; j++) {
      const w = stripComment(lines[j].text).trim().split(/[\s,]+/);
      const a = (w[0] ?? '').toLowerCase().replace(/:$/, ''), b = (w[1] ?? '').toLowerCase();
      if (b === 'macro' || REPEAT_DIRS.has(a)) depth++;
      else if (a === 'endm') { if (--depth === 0) return j; }
    }
    return -1;
  }

  private collectMacro(lines: SrcLine[], i: number, toks: Token[]): number {
    const end = this.blockEnd(lines, i);
    if (end < 0) { this.error(lines[i].line, `宏 ${toks[0].text} 缺少 ENDM`); return lines.length - 1; }
    const params: MacroDef['params'] = [];
    const ptoks = toks.slice(2);
    let k = 0;
    while (k < ptoks.length) {
      const t = ptoks[k];
      if (t.text === ',') { k++; continue; }
      if (t.kind !== 'id') throw new AsmError(`宏参数名无效：${t.text}`, t.col);
      const p = { name: t.lower, req: false, def: '' };
      k++;
      if (ptoks[k]?.text === ':') {
        const q = ptoks[k + 1];
        if (q?.lower === 'req') { p.req = true; k += 2; }
        else if (q?.text === '=') { k += 2; const parts: string[] = []; while (k < ptoks.length && ptoks[k].text !== ',') parts.push(ptoks[k++].text); p.def = parts.join(' ').replace(/^<(.*)>$/, '$1'); }
      }
      params.push(p);
    }
    const name = toks[0].lower;
    if (name in REG16 || name in REG8 || isMnemonic(name)) this.warn(`宏名 ${toks[0].text} 与指令或寄存器同名`);
    this.macros.set(name, { name: toks[0].text, params, body: lines.slice(i + 1, end).map(l => l.text) });
    const s = this.syms.get(name);
    if (!s || s.kind === 'macro') this.syms.set(name, { ...this.newSym(toks[0].text, 'macro'), line: lines[i].line });
    return end;
  }

  private expandBody(body: string[], map: Map<string, string>, line: number): SrcLine[] {
    // LOCAL 伪指令：为每个局部标号生成唯一名字
    const out: SrcLine[] = [];
    const m = new Map(map);
    let k = 0;
    while (k < body.length) {
      const t = stripComment(body[k]).trim();
      const mm = t.match(/^local\s+(.*)$/i);
      if (!mm) break;
      for (const nm of mm[1].split(',').map(x => x.trim()).filter(Boolean)) {
        m.set(nm.toLowerCase(), '??' + (this.localCounter++).toString(16).toUpperCase().padStart(4, '0'));
      }
      k++;
    }
    for (; k < body.length; k++) out.push({ text: substitute(body[k], m), line });
    return out;
  }

  private runExpansion(lines: SrcLine[]): void {
    if (++this.macroDepth > 40) { this.macroDepth--; throw new AsmError('宏嵌套层数过多（可能是递归调用）'); }
    try {
      this.processLines(lines);
    } catch (e) {
      if (!(e instanceof ExitMacro)) throw e;
    } finally {
      this.macroDepth--;
    }
  }

  private expandMacro(mac: MacroDef, L: SrcLine, raw: string, nameTok: Token): void {
    const argText = stripComment(raw).slice(nameTok.col + nameTok.text.length);
    const args = splitArgs(argText);
    const map = new Map<string, string>();
    mac.params.forEach((p, idx) => {
      let v = args[idx] ?? '';
      if (v === '') {
        if (p.req) throw new AsmError(`调用宏 ${mac.name} 时缺少必需的参数 ${p.name}`);
        v = p.def;
      }
      map.set(p.name, v);
    });
    if (args.length > mac.params.length && args.slice(mac.params.length).some(a => a !== '')) {
      this.warn(`宏 ${mac.name} 的参数多于定义（多余的参数被忽略）`, L.line);
    }
    this.runExpansion(this.expandBody(mac.body, map, L.line));
  }

  private collectRepeat(lines: SrcLine[], i: number, toks: Token[]): number {
    const end = this.blockEnd(lines, i);
    const L = lines[i];
    if (end < 0) { this.error(L.line, `${toks[0].text.toUpperCase()} 缺少 ENDM`); return lines.length - 1; }
    const body = lines.slice(i + 1, end).map(l => l.text);
    const d = toks[0].lower;
    const expanded: SrcLine[] = [];
    if (d === 'rept' || d === 'repeat') {
      const n = this.constExpr(toks.slice(1));
      if (n < 0 || n > 65536) throw new AsmError('REPT 次数无效');
      for (let k = 0; k < n; k++) expanded.push(...this.expandBody(body, new Map(), L.line));
    } else if (d === 'while') {
      throw new AsmError('暂不支持 WHILE 宏循环');
    } else {
      // IRP/FOR 参数, <a,b,c>      IRPC/FORC 参数, 字符串
      const p = toks[1];
      if (!p || p.kind !== 'id') throw new AsmError(`${d.toUpperCase()} 缺少参数名`);
      const text = stripComment(L.text);
      const commaIdx = text.indexOf(',', p.col + p.text.length);
      if (commaIdx < 0) throw new AsmError(`${d.toUpperCase()} 的语法是：${d.toUpperCase()} 参数, <值1, 值2, ...>`);
      const rest = text.slice(commaIdx + 1).trim();
      let values: string[];
      if (d === 'irpc' || d === 'forc') values = [...rest.replace(/^<(.*)>$/, '$1')];
      else values = splitArgs(rest.replace(/^<(.*)>$/, '$1'));
      for (const v of values) expanded.push(...this.expandBody(body, new Map([[p.lower, v]]), L.line));
    }
    this.runExpansion(expanded);
    return end;
  }

  // ======================= 符号 =======================

  private newSym(name: string, kind: Sym['kind']): Sym {
    return { name, kind, seg: null, offset: 0, type: 0, length: 0, size: 0, lengthof: 0, sizeof: 0, line: this.curLine, pass: this.pass };
  }

  private defineSym(tok: Token, kind: Sym['kind']): Sym {
    const key = tok.lower;
    if (key in REG16 || key in REG8 || key in SREG) throw new AsmError(`不能用寄存器名 ${tok.text} 作为符号名`, tok.col);
    if (isCoreMnemonic(key) && kind !== 'segment') throw new AsmError(`不能用指令名 ${tok.text} 作为符号名`, tok.col);
    let s = this.syms.get(key);
    if (s && s.pass === this.pass && !(s.redefinable && kind === 'const')) {
      throw new AsmError(`符号 ${tok.text} 重复定义（第一次定义在第 ${s.line} 行）`, tok.col);
    }
    if (!s) { s = this.newSym(tok.text, kind); this.syms.set(key, s); }
    s.kind = kind;
    s.pass = this.pass;
    s.line = this.curLine;
    s.name = tok.text;
    s.redefinable = false;
    s.text = undefined;
    return s;
  }

  private requireSeg(): Segment {
    if (!this.cur) throw new AsmError('代码和数据必须写在段里（先写 .CODE / .DATA 或 xxx SEGMENT）');
    return this.cur;
  }

  private defineLabel(tok: Token, type: number): Sym {
    const seg = this.requireSeg();
    const s = this.defineSym(tok, 'label');
    s.seg = seg; s.offset = seg.pc; s.type = type; s.length = 1; s.size = 0; s.lengthof = 1; s.sizeof = 0;
    return s;
  }

  // ======================= 表达式 =======================

  private frameOf(seg: Segment): Frame { return seg.group ?? seg; }

  evalExpr(toks: Token[]): Val {
    if (!toks.length) throw new AsmError('缺少操作数');
    const p = new ExprParser(this, toks);
    return p.parseAll();
  }

  private constExpr(toks: Token[]): number {
    const v = this.evalExpr(toks);
    if (v.regType || v.isMem || v.base >= 0 || v.index >= 0 || v.frame || v.frameImm) throw new AsmError('这里需要一个常数表达式');
    return v.n;
  }

  /** 供表达式求值调用：解析一个标识符 */
  lookup(t: Token, inBracket: boolean): Val {
    const k = t.lower;
    if (k in REG16) {
      const r = REG16[k];
      if (inBracket) {
        const v = newVal();
        if (r === R_BX || r === R_BP) v.base = r;
        else if (r === R_SI || r === R_DI) v.index = r;
        else throw new AsmError(`${t.text.toUpperCase()} 不能用来间接寻址：8086 只能用 BX、BP、SI、DI`, t.col);
        v.isMem = true;
        return v;
      }
      const v = newVal(); v.regType = 16; v.reg = r; v.type = 2; return v;
    }
    if (k in REG8) {
      if (inBracket) throw new AsmError(`${t.text.toUpperCase()} 不能用来间接寻址：8086 只能用 BX、BP、SI、DI`, t.col);
      const v = newVal(); v.regType = 8; v.reg = REG8[k]; v.type = 1; return v;
    }
    if (k in SREG) {
      if (inBracket) throw new AsmError(`段寄存器 ${t.text.toUpperCase()} 不能写在方括号里`, t.col);
      const v = newVal(); v.regType = 1; v.reg = SREG[k]; v.type = 2; return v;
    }
    if (k in TYPES) { const v = newVal(TYPES[k]); v.isTypeKw = true; v.type = TYPES[k]; return v; }
    if (k === '$') {
      const seg = this.requireSeg();
      const v = newVal(seg.offsetInFrame + seg.pc);
      v.frame = this.frameOf(seg); v.seg = seg; v.type = T_NEAR;
      return v;
    }
    if (k === '@data') {
      const g = this.groupMap.get('dgroup');
      if (!g || !this.model) throw new AsmError('使用 @DATA 前需要先写 .MODEL', t.col);
      const v = newVal(); v.frameImm = g; return v;
    }
    if (k === '@code') {
      const s = this.segMap.get('_text');
      if (!s) throw new AsmError('@CODE 需要先定义 .CODE', t.col);
      const v = newVal(); v.frameImm = this.model === 'tiny' ? this.frameOf(s) : s; return v;
    }
    const s = this.syms.get(k);
    if (!s || (s.pass !== this.pass && s.pass < this.pass - 1) || (s.pass !== this.pass && s.kind === 'text')) {
      if (!this.undefRefs.has(k)) this.undefRefs.set(k, { line: this.curLine, col: t.col, name: t.text });
      const v = newVal(); v.unknown = true; return v;
    }
    if (s.pass !== this.pass && !this.undefRefs.has(k)) {
      // 向前引用：使用上一遍的值，并在本遍结束时确认已定义
      this.undefRefs.set(k, { line: this.curLine, col: t.col, name: t.text });
    }
    switch (s.kind) {
      case 'const': return newVal(s.offset);
      case 'text': return this.evalExpr(tokenize(s.text ?? ''));
      case 'var': case 'label': {
        const seg = s.seg!;
        const v = newVal(seg.offsetInFrame + s.offset);
        v.frame = this.frameOf(seg); v.seg = seg; v.sym = s; v.type = s.type;
        v.isMem = s.kind === 'var';
        return v;
      }
      case 'segment': case 'group': { const v = newVal(); v.frameImm = s.frame!; return v; }
      case 'macro': throw new AsmError(`${t.text} 是宏，不能用在表达式里`, t.col);
    }
  }

  symSize(v: Val, what: 'size' | 'length' | 'sizeof' | 'lengthof'): number {
    if (v.sym) return v.sym[what];
    if (what === 'size' || what === 'sizeof') return v.type;
    return 1;
  }

  // ======================= 数据定义 =======================

  private emit(bytes: number[], fixups: number[] = []): void {
    const seg = this.requireSeg();
    const start = seg.pc;
    let relocations = this.relocations.get(seg);
    for (const b of bytes) {
      relocations?.delete(seg.pc);
      relocations?.delete(seg.pc - 1);
      seg.bytes[seg.pc] = b;
      seg.pc++;
      if (seg.pc > 0x10000) throw new AsmError(`段 ${seg.name} 超过 64KB`);
    }
    if (bytes.length) seg.emitted = true;
    if (seg.pc > seg.size) seg.size = seg.pc;
    if (fixups.length) {
      if (!relocations) this.relocations.set(seg, relocations = new Set());
      for (const offset of fixups) relocations.add(start + offset);
    }
  }

  private defineData(nameTok: Token | null, dir: string, toks: Token[]): void {
    const size = DATA_DIRS[dir];
    const seg = this.requireSeg();
    let sym: Sym | null = null;
    if (nameTok) {
      sym = this.defineSym(nameTok, 'var');
      sym.seg = seg; sym.offset = seg.pc; sym.type = size;
    }
    const start = seg.pc;
    if (!toks.length) throw new AsmError(`${dir.toUpperCase()} 后面缺少初始值（不需要初值时写 ?）`);
    const items = splitComma(toks);
    const first = items[0] ?? [];
    const dupIdx = first.findIndex((t, k) => t.lower === 'dup' && k > 0);
    const count = this.dataItems(toks, size);
    if (sym) {
      sym.length = dupIdx > 0 ? this.constExpr(first.slice(0, dupIdx)) : 1;
      sym.size = sym.length * size;
      sym.lengthof = count;
      sym.sizeof = seg.pc - start;
    }
    this.listing.push({ line: this.curLine, seg, offset: start, bytes: seg.bytes.slice(start, seg.pc), isCode: false });
  }

  /** 生成逗号分隔的数据项，返回数据元素个数 */
  private dataItems(toks: Token[], size: number): number {
    let count = 0;
    for (const item of splitComma(toks)) {
      if (!item.length) throw new AsmError('数据项为空（多了一个逗号？）');
      const dupIdx = item.findIndex((t, k) => t.lower === 'dup' && k > 0);
      if (dupIdx > 0) {
        const n = this.constExpr(item.slice(0, dupIdx));
        if (n < 0 || n > 0x10000) throw new AsmError(`DUP 次数无效：${n}`);
        const inner = item.slice(dupIdx + 1);
        if (inner[0]?.text !== '(' || inner[inner.length - 1]?.text !== ')') throw new AsmError('DUP 后面要用括号括起初始值，例如 10 DUP(0)');
        const body = inner.slice(1, -1);
        if (body.length === 1 && body[0].text === '?') {
          this.emit(new Array(n * size).fill(-1));
          count += n;
        } else {
          const seg = this.requireSeg();
          const s0 = seg.pc;
          const c = this.dataItems(body, size);
          const chunk = seg.bytes.slice(s0, seg.pc);
          const fixups = [...(this.relocations.get(seg) ?? [])].filter(at => at >= s0 && at + 1 < seg.pc).map(at => at - s0);
          for (let k = 1; k < n; k++) this.emit(chunk, fixups);
          if (n === 0) { seg.pc = s0; }
          count += c * n;
        }
        continue;
      }
      if (item.length === 1 && item[0].text === '?') { this.emit(new Array(size).fill(-1)); count++; continue; }
      if (item.length === 1 && item[0].kind === 'str') {
        const str = item[0].text;
        if (size === 1) {
          if ([...str].some(ch => ch.codePointAt(0)! > 255)) this.warn('字符串里的中文等非西文字符在 DOS 屏幕（代码页 437）上无法显示，已替换为 ?');
          this.emit([...encodeStr(str)]);
          count += encodeStr(str).length;
          continue;
        }
        if (str.length > size) throw new AsmError(`字符串 '${str}' 太长，${size === 2 ? 'DW' : 'DD'} 最多放 ${size} 个字符；字符串请用 DB 定义`);
      }
      const v = this.evalExpr(item);
      if (v.regType) throw new AsmError('数据定义中不能使用寄存器');
      if (v.isMem && v.base < 0 && v.index < 0 && v.frame && size === 1) throw new AsmError('DB 不能存放地址（地址是 16 位的，请用 DW）');
      if (v.base >= 0 || v.index >= 0) throw new AsmError('数据定义中不能使用寄存器寻址');
      let n = v.n;
      if (v.frameImm) n = this.loadSeg + v.frameImm.para;
      if (size === 1) {
        if (!v.unknown && (n < -128 || n > 255)) throw new AsmError(`数值 ${n} 超出字节范围（-128~255）`);
        this.emit([n & 0xff]);
      } else if (size === 2) {
        if (!v.unknown && (n < -32768 || n > 65535)) throw new AsmError(`数值 ${n} 超出字范围（-32768~65535）`);
        this.emit([n & 0xff, (n >> 8) & 0xff], v.frameImm ? [0] : []);
      } else if (size === 4 && v.frame) {
        const segv = this.loadSeg + v.frame.para;
        this.emit([n & 0xff, (n >> 8) & 0xff, segv & 0xff, (segv >> 8) & 0xff], [2]);
      } else {
        const bytes: number[] = [];
        let x = BigInt.asUintN(size * 8, BigInt(Math.trunc(n)));
        for (let k = 0; k < size; k++) { bytes.push(Number(x & 0xffn)); x >>= 8n; }
        this.emit(bytes, v.frameImm && size >= 2 ? [0] : []);
      }
      count++;
    }
    return count;
  }

  // ======================= 伪指令 =======================

  private equ(name: Token, rest: Token[], raw: string, equTok: Token): void {
    const text = stripComment(raw).slice(equTok.col + equTok.text.length).trim();
    if (text.startsWith('<') && text.endsWith('>')) {
      const s = this.defineSym(name, 'text'); s.text = text.slice(1, -1); return;
    }
    if (!rest.length) throw new AsmError('EQU 后面缺少内容');
    const hasReg = rest.some(t => t.kind === 'id' && (t.lower in REG16 || t.lower in REG8 || t.lower in SREG || t.lower === 'ptr'));
    const longStr = rest.some(t => t.kind === 'str' && t.text.length > 2);
    let v: Val | null = null;
    if (!hasReg && !longStr) {
      try { v = this.evalExpr(rest); } catch { v = null; }
    }
    if (v) {
      const absolute = !v.isMem && !v.frame && !v.frameImm && !v.regType && v.base < 0 && v.index < 0 && !v.isTypeKw;
      if (absolute) {
        // 数值常量（向前引用时本遍暂为 0，后续遍会修正）
        const s = this.defineSym(name, 'const'); s.offset = v.n; return;
      }
      if (v.frame && !v.isMem && v.base < 0 && v.index < 0 && rest.length === 1 && rest[0].lower === '$') {
        // name EQU $ —— 当前位置的标号
        const s = this.defineSym(name, 'label');
        s.seg = v.seg; s.offset = v.n - (v.seg?.offsetInFrame ?? 0); s.type = T_NEAR;
        return;
      }
    }
    const s = this.defineSym(name, 'text');
    s.text = text;
  }

  private assign(name: Token, rest: Token[]): void {
    const v = this.constExpr(rest);
    const ex = this.syms.get(name.lower);
    if (ex && ex.pass === this.pass && !ex.redefinable) throw new AsmError(`符号 ${name.text} 已用 EQU 定义，不能再用 = 修改`);
    const s = this.defineSym(name, 'const');
    s.offset = v;
    s.redefinable = true;
  }

  private textequ(name: Token, raw: string, tt: Token): void {
    const text = stripComment(raw).slice(tt.col + tt.text.length).trim().replace(/^<(.*)>$/, '$1');
    const s = this.defineSym(name, 'text');
    s.text = text;
  }

  private getSegment(name: string, display: string): Segment {
    let s = this.segMap.get(name);
    if (!s) {
      s = {
        kind: 'segment', name: display, para: 0, align: 16, combine: 'private', cls: '', group: null, bytes: [], pc: 0,
        size: 0, loadStart: 0, orgSeen: false, emitted: false, offsetInFrame: 0, start: 0, order: this.segOrderCounter++,
      };
      this.segMap.set(name, s);
    }
    if (!this.segList.includes(s)) {
      this.segList.push(s);
      s.group = null;
    }
    return s;
  }

  private segmentDir(name: Token, attrs: Token[]): void {
    if (this.cur && this.isSimplified(this.cur)) this.cur = null;
    const fresh = !this.segList.includes(this.segMap.get(name.lower) as Segment);
    const seg = this.getSegment(name.lower, name.text);
    if (this.segStack.includes(seg) || this.cur === seg) throw new AsmError(`段 ${name.text} 已经打开`);
    if (fresh) {
      seg.align = 16; seg.combine = 'private'; seg.cls = '';
    }
    for (const a of attrs) {
      switch (a.lower) {
        case 'byte': seg.align = 1; break;
        case 'word': seg.align = 2; break;
        case 'dword': seg.align = 4; break;
        case 'para': seg.align = 16; break;
        case 'page': seg.align = 256; break;
        case 'public': case 'stack': case 'common': case 'memory': case 'private': seg.combine = a.lower === 'memory' ? 'public' : a.lower; break;
        case 'at': throw new AsmError('暂不支持 SEGMENT AT');
        case 'use16': case 'use32': case 'readonly': case 'flat': break;
        default:
          if (a.kind === 'str') seg.cls = a.text.toUpperCase();
          else if (a.text === "'" || a.text === '"') break;
          else if (a.kind !== 'op') throw new AsmError(`无法识别的段属性：${a.text}`, a.col);
      }
    }
    this.defineSegSym(name, seg);
    if (this.cur) this.segStack.push(this.cur);
    this.cur = seg;
  }

  private defineSegSym(name: Token, frame: Frame): Sym {
    const key = name.lower;
    let s = this.syms.get(key);
    if (s && s.pass === this.pass && s.kind !== 'segment' && s.kind !== 'group') {
      throw new AsmError(`符号 ${name.text} 重复定义`);
    }
    if (!s) { s = this.newSym(name.text, frame.kind); this.syms.set(key, s); }
    s.kind = frame.kind; s.frame = frame; s.pass = this.pass; s.line = this.curLine;
    return s;
  }

  private endsDir(name: Token): void {
    if (!this.cur || this.cur.name.toLowerCase() !== name.lower) {
      throw new AsmError(this.cur ? `ENDS 的段名 ${name.text} 与当前段 ${this.cur.name} 不一致` : `ENDS ${name.text} 没有对应的 SEGMENT`);
    }
    if (this.procStack.length && this.procStack[this.procStack.length - 1].seg === this.cur) {
      throw new AsmError(`过程 ${this.procStack[this.procStack.length - 1].name} 还没有 ENDP 就结束了段`);
    }
    this.cur = this.segStack.pop() ?? null;
  }

  private isSimplified(seg: Segment): boolean {
    return ['_text', '_data', 'const', '_bss', 'stack'].includes(seg.name.toLowerCase()) && this.model !== '';
  }

  private simplifiedSeg(kind: 'code' | 'data' | 'data?' | 'const' | 'stack'): Segment {
    if (!this.model) throw new AsmError(`使用 .${kind.toUpperCase()} 前需要先写 .MODEL（例如 .MODEL SMALL）`);
    const def = {
      code: ['_text', '_TEXT', 2, 'public', 'CODE'],
      data: ['_data', '_DATA', 2, 'public', 'DATA'],
      'data?': ['_bss', '_BSS', 2, 'public', 'BSS'],
      const: ['const', 'CONST', 2, 'public', 'CONST'],
      stack: ['stack', 'STACK', 16, 'stack', 'STACK'],
    }[kind] as [string, string, number, string, string];
    const seg = this.getSegment(def[0], def[1]);
    seg.align = def[2]; seg.combine = def[3]; seg.cls = def[4];
    const g = this.groupMap.get('dgroup')!;
    if (kind !== 'code' || this.model === 'tiny') {
      if (!g.segments.includes(seg)) g.segments.push(seg);
      seg.group = g;
    }
    this.defineSegSym({ kind: 'id', text: def[1], lower: def[0], value: 0, col: 0 }, seg);
    return seg;
  }

  private openSimplified(seg: Segment): void {
    if (this.cur && !this.isSimplified(this.cur)) throw new AsmError(`段 ${this.cur.name} 还没有用 ENDS 结束`);
    if (this.procStack.length) throw new AsmError(`过程 ${this.procStack[this.procStack.length - 1].name} 还没有 ENDP`);
    this.cur = seg;
  }

  private procDir(name: Token, attrs: Token[]): void {
    let type = T_NEAR;
    for (const a of attrs) {
      if (a.lower === 'far') type = T_FAR;
      else if (a.lower === 'near') type = T_NEAR;
      else if (a.lower === 'public' || a.lower === 'private' || a.lower === 'c' || a.lower === 'pascal' || a.lower === 'stdcall') { /* 忽略 */ }
      else if (a.lower === 'uses') throw new AsmError('暂不支持 PROC ... USES，请手动 PUSH/POP');
      else throw new AsmError(`无法识别的过程属性：${a.text}`, a.col);
    }
    const s = this.defineLabel(name, type);
    this.procStack.push(s);
  }

  private endpDir(name: Token): void {
    const top = this.procStack[this.procStack.length - 1];
    if (!top) throw new AsmError(`ENDP ${name.text} 没有对应的 PROC`);
    if (top.name.toLowerCase() !== name.lower) throw new AsmError(`ENDP 的名字 ${name.text} 与过程 ${top.name} 不一致`);
    this.procStack.pop();
  }

  private labelDir(name: Token, rest: Token[]): void {
    const t = rest[0]?.lower;
    if (!t || !(t in TYPES)) throw new AsmError('LABEL 后面需要类型：BYTE、WORD、DWORD、NEAR 或 FAR');
    if (TYPES[t] === T_NEAR || TYPES[t] === T_FAR) { this.defineLabel(name, TYPES[t]); return; }
    const seg = this.requireSeg();
    const s = this.defineSym(name, 'var');
    s.seg = seg; s.offset = seg.pc; s.type = TYPES[t]; s.length = 1; s.size = TYPES[t]; s.lengthof = 1; s.sizeof = TYPES[t];
  }

  private groupDir(name: Token, rest: Token[]): void {
    let g = this.groupMap.get(name.lower);
    if (!g) { g = { kind: 'group', name: name.text, para: 0, segments: [] }; this.groupMap.set(name.lower, g); }
    for (const t of rest) {
      if (t.text === ',') continue;
      const seg = this.segMap.get(t.lower);
      if (!seg || !this.segList.includes(seg)) throw new AsmError(`GROUP 中的段 ${t.text} 尚未定义`, t.col);
      if (!g.segments.includes(seg)) g.segments.push(seg);
      seg.group = g;
    }
    this.defineSegSym(name, g);
  }

  /** .8086 / .186 / .286 / .286P …：选择允许的指令集（.8087 等协处理器伪指令不影响） */
  private cpuDirective(w: string): void {
    if (/^.(8087|287|387|no87)$/.test(w)) return;
    if (w === '.8086') this.cpu = 0;
    else if (w === '.186') this.cpu = 1;
    else if (w === '.286' || w === '.286c') this.cpu = 2;
    else if (w === '.286p') this.cpu = 3;
    else {
      this.cpu = 3;
      this.warn(`${w.toUpperCase()}：32 位指令暂不支持，按 .286P 处理（可以用 80186/80286 的指令）`);
    }
  }

  private directive(w: string, toks: Token[]): boolean {
    const args = toks.slice(1);
    if (IGNORED.has(w)) return true;
    if (CPU_DIRS.has(w)) { this.cpuDirective(w); return true; }
    switch (w) {
      case '.model': {
        const m = args[0]?.lower;
        if (!m) throw new AsmError('.MODEL 后面需要内存模型，例如 .MODEL SMALL');
        if (!['tiny', 'small', 'medium', 'compact', 'large', 'huge', 'flat'].includes(m)) throw new AsmError(`未知的内存模型：${args[0].text}`);
        if (m === 'flat') throw new AsmError('FLAT 模型是 32 位的，8086 请用 .MODEL SMALL');
        if (m !== 'tiny' && m !== 'small') this.warn(`${args[0].text.toUpperCase()} 模型按 SMALL 处理`);
        this.model = m === 'tiny' ? 'tiny' : 'small';
        let g = this.groupMap.get('dgroup');
        if (!g) { g = { kind: 'group', name: 'DGROUP', para: 0, segments: [] }; this.groupMap.set('dgroup', g); }
        this.defineSegSym({ kind: 'id', text: 'DGROUP', lower: 'dgroup', value: 0, col: 0 }, g);
        this.assume = [null, null, g, g];
        return true;
      }
      case '.code': {
        const seg = this.simplifiedSeg('code');
        this.openSimplified(seg);
        this.assume[1] = this.model === 'tiny' ? this.groupMap.get('dgroup')! : seg;
        return true;
      }
      case '.data': this.openSimplified(this.simplifiedSeg('data')); return true;
      case '.const': this.openSimplified(this.simplifiedSeg('const')); return true;
      case '.data?': this.openSimplified(this.simplifiedSeg('data?')); return true;
      case '.fardata': case '.fardata?': throw new AsmError(`暂不支持 ${w.toUpperCase()}`);
      case '.stack': {
        const size = args.length ? this.constExpr(args) : 1024;
        const prev = this.cur;
        const seg = this.simplifiedSeg('stack');
        this.cur = seg;
        this.emit(new Array(size).fill(-1));
        this.listing.push({ line: this.curLine, seg, offset: seg.pc - size, bytes: [], isCode: false });
        this.cur = prev && prev !== seg ? prev : null;
        return true;
      }
      case '.startup': {
        if (this.model === 'tiny') {
          this.processLines([{ text: 'org 100h', line: this.curLine }]);
          this.startupEntry = this.evalExpr(tokenize('$'));
          return true;
        }
        this.startupEntry = this.evalExpr(tokenize('$'));
        this.processLines([
          { text: 'mov dx, @data', line: this.curLine },
          { text: 'mov ds, dx', line: this.curLine },
        ]);
        return true;
      }
      case '.exit': {
        const lines = args.length
          ? [`mov ax, 4C00h + ((${args.map(a => a.kind === 'str' ? `'${a.text}'` : a.text).join(' ')}) and 0FFh)`, 'int 21h']
          : ['mov ah, 4Ch', 'int 21h'];
        this.processLines(lines.map(text => ({ text, line: this.curLine })));
        return true;
      }
      case 'assume': {
        for (const part of splitComma(args)) {
          if (part.length === 1 && part[0].lower === 'nothing') { this.assume = [null, null, null, null]; continue; }
          if (part.length < 3 || part[1].text !== ':' || !(part[0].lower in SREG)) {
            throw new AsmError('ASSUME 的写法是：ASSUME CS:代码段名, DS:数据段名');
          }
          const sr = SREG[part[0].lower];
          if (part.length === 3 && part[2].lower === 'nothing') { this.assume[sr] = null; continue; }
          const v = this.evalExpr(part.slice(2));
          if (v.frameImm) this.assume[sr] = v.frameImm;
          else if (!v.unknown) throw new AsmError(`ASSUME 后面应该是段名或组名`);
        }
        return true;
      }
      case 'org': {
        const seg = this.requireSeg();
        const v = this.evalExpr(args);
        let n = v.n;
        if (v.frame) n -= seg.offsetInFrame;
        if (n < 0 || n > 0xffff) throw new AsmError('ORG 的值无效');
        if (!seg.emitted) { seg.loadStart = n; seg.orgSeen = true; }
        seg.pc = n;
        if (seg.pc > seg.size) seg.size = seg.pc;
        return true;
      }
      case 'even': case 'align': {
        const seg = this.requireSeg();
        const n = w === 'even' ? 2 : args.length ? this.constExpr(args) : 2;
        if (n <= 0 || (n & (n - 1))) throw new AsmError('ALIGN 的值必须是 2 的幂');
        const fill = seg.cls === 'CODE' ? 0x90 : 0;
        const pad = (n - (seg.pc % n)) % n;
        this.emit(new Array(pad).fill(fill));
        return true;
      }
      case 'end': {
        this.endSeen = true;
        this.ended = true;
        if (this.procStack.length) throw new AsmError(`过程 ${this.procStack[this.procStack.length - 1].name} 缺少 ENDP`);
        if (args.length) {
          const v = this.evalExpr(args);
          if (!v.frame && !v.unknown) throw new AsmError('END 后面应该是程序入口的标号');
          this.entry = v;
        }
        return true;
      }
      case 'include': case 'includelib': throw new AsmError('不支持 INCLUDE（浏览器里没有文件系统，请把内容直接粘贴进来）');
      case 'extrn': case 'extern': case 'externdef': throw new AsmError('不支持多模块程序（EXTRN）');
      case '.radix': throw new AsmError('暂不支持 .RADIX');
      case 'purge': return true;
      case 'ends': {
        if (this.cur && this.isSimplified(this.cur)) { this.cur = null; return true; }
        throw new AsmError('ENDS 前面需要段名');
      }
      case 'endp': throw new AsmError('ENDP 前面需要过程名');
    }
    return false;
  }

  // ======================= 指令 =======================

  private instruction(toks: Token[]): void {
    const seg = this.requireSeg();
    const prefixes: number[] = [];
    let k = 0;
    while (k < toks.length && toks[k].lower in PREFIXES) prefixes.push(PREFIXES[toks[k++].lower]);
    const stmt = this.stmtIndex++;
    const start = seg.pc;
    let bytes: number[];
    let fixups: number[] = [];
    if (k >= toks.length) {
      bytes = prefixes;
    } else {
      const mt = toks[k];
      const mn = mt.lower;
      if (!isMnemonic(mn)) throw new AsmError(`前缀后面应该是指令：${mt.text}`, mt.col);
      if (prefixes.some(p => p !== 0xf0) && !/^(movs|cmps|stos|lods|scas|ins|outs)[bw]?$/.test(mn)) {
        this.warn(`REP 前缀只对串操作指令有意义（${mt.text.toUpperCase()} 不是串操作）`);
      }
      const vals = splitComma(toks.slice(k + 1)).map(part => {
        if (!part.length) throw new AsmError('操作数为空（多了一个逗号？）', mt.col);
        return this.evalExpr(part);
      });
      const frame = this.frameOf(seg);
      const asm = this;
      bytes = this.encoder.encode({
        pc: seg.offsetInFrame + seg.pc,
        curFrame: frame,
        loadSeg: this.loadSeg,
        assume: this.assume,
        procType: this.procStack.length ? this.procStack[this.procStack.length - 1].type : T_NEAR,
        isLong: this.longJumps.has(stmt),
        setLong() { asm.longJumps.add(stmt); },
        warn: (m: string) => this.warn(m),
        cpu: this.cpu,
        useCpu: (level: number) => { if (level > this.cpuUsed) this.cpuUsed = level; },
      }, mn, vals, prefixes);
      if (this.encoder.relocationOffset !== null) fixups = [this.encoder.relocationOffset];
    }
    this.emit(bytes, fixups);
    this.listing.push({ line: this.curLine, seg, offset: start, bytes, isCode: true });
  }

  // ======================= 布局与输出 =======================

  private layout(): void {
    const segs = this.segList;
    const stackSeg = segs.find(s => s.combine === 'stack');
    this.isCom = this.model === 'tiny' ||
      (!stackSeg && segs.length === 1 && segs[0].orgSeen && segs[0].loadStart === 0x100);
    const rank = (s: Segment): number => {
      if (this.model) {
        const n = s.name.toLowerCase();
        const order = ['_text', '_data', 'const', '_bss', 'stack'];
        const idx = order.indexOf(n);
        if (idx === 0) return 0;
        if (idx > 0) return 100 + idx;
        return 50 + s.order / 1000;
      }
      return 0;
    };
    const classOrder: string[] = [];
    for (const s of segs) if (!classOrder.includes(s.cls)) classOrder.push(s.cls);
    const ordered = [...segs].sort((a, b) => rank(a) - rank(b) || classOrder.indexOf(a.cls) - classOrder.indexOf(b.cls) || segs.indexOf(a) - segs.indexOf(b));

    const placedGroups = new Set<Group>();
    if (this.isCom) {
      let off = 0;
      for (const s of ordered) {
        off = alignUp(off, s.align);
        s.offsetInFrame = off;
        s.start = -0x100 + off;
        s.para = -0x10;
        off += s.size;
        if (s.group) s.group.para = -0x10;
      }
      if (off > 0x10000) this.error(0, 'COM 程序的总大小超过 64KB');
    } else {
      let addr = 0;
      for (const s of ordered) {
        const g = s.group;
        if (g && !placedGroups.has(g)) {
          addr = alignUp(addr, 16);
          g.para = addr >> 4;
          placedGroups.add(g);
          addr = alignUp(addr, s.align);
        } else if (g) {
          addr = alignUp(addr, s.align);
        } else {
          addr = alignUp(addr, s.align);
        }
        s.start = addr;
        s.para = Math.floor(addr / 16);
        s.offsetInFrame = g ? addr - g.para * 16 : addr - s.para * 16;
        addr += s.size;
        if (g && s.offsetInFrame + s.size > 0x10000) this.error(0, `组 ${g.name} 超过 64KB`);
      }
    }
  }

  private output(): Program {
    const loadSeg = this.loadSeg;
    const pspSeg = loadSeg - 0x10;
    const diags = this.diags.slice();
    const base = loadSeg * 16;
    const chunks: Program['chunks'] = [];
    let imageEnd = base;
    for (const s of this.segList) {
      const from = s.loadStart, to = s.size;
      if (to > from) {
        const arr = new Uint8Array(to - from);
        for (let k = from; k < to; k++) { const b = s.bytes[k]; arr[k - from] = b === undefined || b < 0 ? 0 : b; }
        chunks.push({ addr: base + s.start + from, bytes: arr });
      }
      imageEnd = Math.max(imageEnd, base + s.start + s.size);
    }

    const addrToLine = new Map<number, number>();
    const lineToAddrs = new Map<number, number[]>();
    const listing: Program['listing'] = [];
    for (const e of this.listing) {
      const frame = this.frameOf(e.seg);
      const segment = loadSeg + frame.para;
      const offset = e.seg.offsetInFrame + e.offset;
      listing.push({ line: e.line, segment, offset, bytes: e.bytes, isCode: e.isCode, segName: e.seg.name, segOffset: e.offset });
      if (e.isCode && e.bytes.length) {
        const lin = base + e.seg.start + e.offset;
        if (!addrToLine.has(lin)) addrToLine.set(lin, e.line);
        const arr = lineToAddrs.get(e.line) ?? [];
        arr.push(lin);
        lineToAddrs.set(e.line, arr);
      }
    }

    // 入口
    let entry = { cs: 0, ip: 0 };
    const ev = this.entry ?? this.startupEntry;
    if (ev && ev.frame) {
      entry = { cs: loadSeg + ev.frame.para, ip: ev.n & 0xffff };
    } else {
      const code = this.segList.find(s => s.cls === 'CODE') ?? this.segList[0];
      if (code) {
        const f = this.frameOf(code);
        entry = { cs: loadSeg + f.para, ip: code.offsetInFrame + code.loadStart };
        if (this.endSeen && this.segList.length) diags.push({ line: this.lines.length, col: -1, severity: 'warning', message: 'END 后面没有指定程序入口标号，将从代码段开头执行' });
      }
    }
    if (!this.segList.length) diags.push({ line: 1, col: -1, severity: 'error', message: '程序里没有任何段（需要 .CODE 或 SEGMENT）' });

    // 堆栈
    let stack: Program['stack'];
    const stackSeg = this.segList.find(s => s.combine === 'stack');
    if (this.isCom) {
      stack = { ss: pspSeg, sp: 0xfffe };
      if (this.entry && entry.ip !== 0x100) diags.push({ line: this.lines.length, col: -1, severity: 'warning', message: 'COM 程序的入口通常应在偏移 100h' });
    } else if (stackSeg) {
      const f = this.frameOf(stackSeg);
      stack = { ss: loadSeg + f.para, sp: (stackSeg.offsetInFrame + stackSeg.size) & 0xffff };
      if (stackSeg.size === 0) diags.push({ line: 1, col: -1, severity: 'warning', message: '堆栈段大小为 0' });
    } else {
      const ssPara = Math.ceil((imageEnd - base) / 16);
      stack = { ss: loadSeg + ssPara, sp: 0x400 };
      imageEnd = (loadSeg + ssPara) * 16 + 0x400;
      if (this.segList.length) diags.push({ line: 1, col: -1, severity: 'warning', message: '程序没有定义堆栈段，已自动分配 1KB 堆栈（建议加上 .STACK）' });
    }

    // 符号表
    const symbols: ProgramSymbol[] = [];
    for (const s of this.syms.values()) {
      if (s.pass !== this.pass) continue;
      if (s.kind === 'var' || s.kind === 'label') {
        const seg = s.seg!;
        const f = this.frameOf(seg);
        symbols.push({
          name: s.name, kind: s.kind === 'label' ? 'label' : 'var',
          segName: seg.name, segment: loadSeg + f.para, offset: (seg.offsetInFrame + s.offset) & 0xffff,
          type: s.type, length: s.lengthof, size: s.sizeof, line: s.line,
        });
      } else if (s.kind === 'const') {
        symbols.push({ name: s.name, kind: 'const', segName: '', segment: 0, offset: 0, type: 0, length: 0, size: 0, line: s.line, value: s.offset });
      }
    }

    // 默认数据段
    const dg = this.groupMap.get('dgroup');
    let dataSeg = this.isCom ? pspSeg : entry.cs;
    if (!this.isCom) {
      if (dg && this.model && dg.segments.length) dataSeg = loadSeg + dg.para;
      else {
        const d = this.segList.find(s => s.cls === 'DATA' || /data|dseg/i.test(s.name));
        if (d) dataSeg = loadSeg + this.frameOf(d).para;
      }
    }

    diags.sort((a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    return {
      ok: !diags.some(d => d.severity === 'error'),
      diagnostics: diags,
      cpu: this.cpuUsed,
      format: this.isCom ? 'com' : 'exe',
      loadSeg, pspSeg, chunks, entry, stack, lineToAddrs, addrToLine, symbols, listing,
      relocations: [...this.relocations].flatMap(([seg, offsets]) => [...offsets].map(offset => base + seg.start + offset)).sort((a, b) => a - b),
      segments: this.segList.map(s => ({ name: s.name, addr: base + s.start, size: s.size, loadStart: s.loadStart, bytes: Array.from({ length: s.size }, (_, k) => s.bytes[k] ?? -1) })),
      imageStart: this.isCom ? pspSeg * 16 + 0x100 : base,
      imageEnd,
      dataSeg,
    };
  }
}

// ======================= 表达式解析器 =======================

class ExprParser {
  private pos = 0;
  private bracket = 0;
  private a: Assembler;
  private toks: Token[];

  constructor(a: Assembler, toks: Token[]) {
    this.a = a;
    this.toks = toks;
  }

  private peek(): Token | undefined { return this.toks[this.pos]; }
  private next(): Token | undefined { return this.toks[this.pos++]; }
  private is(text: string): boolean { const t = this.peek(); return !!t && t.lower === text && (t.kind === 'op' || t.kind === 'id'); }
  private expect(text: string): void {
    const t = this.next();
    if (!t || t.lower !== text) throw new AsmError(`缺少 ${text}`, t?.col ?? -1);
  }

  parseAll(): Val {
    const v = this.parseOr();
    const t = this.peek();
    if (t) throw new AsmError(`表达式中有多余的内容：${t.text}`, t.col);
    return v;
  }

  private parseOr(): Val {
    let v = this.parseAnd();
    while (this.is('or') || this.is('xor')) {
      const op = this.next()!.lower;
      const b = this.parseAnd();
      v = absOp(v, b, op, (x, y) => (op === 'or' ? x | y : x ^ y));
    }
    return v;
  }
  private parseAnd(): Val {
    let v = this.parseNot();
    while (this.is('and')) {
      this.next();
      const b = this.parseNot();
      v = absOp(v, b, 'and', (x, y) => x & y);
    }
    return v;
  }
  private parseNot(): Val {
    if (this.is('not')) { this.next(); const v = this.parseNot(); return absOp(v, newVal(0), 'not', x => ~x & 0xffff); }
    return this.parseRel();
  }
  private parseRel(): Val {
    let v = this.parseAdd();
    const rels = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
    while (this.peek() && rels.includes(this.peek()!.lower)) {
      const op = this.next()!.lower;
      const b = this.parseAdd();
      v = absOp(v, b, op, (x, y) => {
        const r = op === 'eq' ? x === y : op === 'ne' ? x !== y : op === 'lt' ? x < y : op === 'le' ? x <= y : op === 'gt' ? x > y : x >= y;
        return r ? 0xffff : 0;
      });
    }
    return v;
  }
  private parseAdd(): Val {
    let v = this.parseMul();
    while (this.is('+') || this.is('-')) {
      const op = this.next()!.text;
      const b = this.parseMul();
      v = op === '+' ? addVal(v, b) : subVal(v, b);
    }
    return v;
  }
  private parseMul(): Val {
    let v = this.parseUnary();
    while (this.is('*') || this.is('/') || this.is('mod') || this.is('shl') || this.is('shr')) {
      const op = this.next()!.lower;
      const b = this.parseUnary();
      v = absOp(v, b, op, (x, y) => {
        switch (op) {
          case '*': return x * y;
          case '/': if (y === 0) throw new AsmError('除数为 0'); return Math.trunc(x / y);
          case 'mod': if (y === 0) throw new AsmError('除数为 0'); return x % y;
          case 'shl': return x << y;
          default: return x >>> y;
        }
      });
    }
    return v;
  }
  private parseUnary(): Val {
    if (this.is('-')) { this.next(); const v = this.parseUnary(); return absOp(newVal(0), v, '-', (_x, y) => -y); }
    if (this.is('+')) { this.next(); return this.parseUnary(); }
    return this.parseHighLow();
  }
  private parseHighLow(): Val {
    if (this.is('high') || this.is('low')) {
      const op = this.next()!.lower;
      const v = this.parseHighLow();
      return absOp(v, newVal(0), op, x => (op === 'high' ? (x >> 8) & 0xff : x & 0xff));
    }
    return this.parsePtr();
  }
  private parsePtr(): Val {
    const t = this.peek();
    if (t && t.kind === 'id') {
      switch (t.lower) {
        case 'offset': {
          this.next();
          const v = this.parsePtr();
          if (v.regType) throw new AsmError('OFFSET 不能用于寄存器');
          if (v.base >= 0 || v.index >= 0) throw new AsmError('OFFSET 不能用于寄存器间接寻址，请用 LEA');
          const r = { ...v, isMem: false, type: 0, ptr: false, sym: null };
          return r;
        }
        case 'seg': {
          this.next();
          const v = this.parsePtr();
          if (!v.frame && !v.frameImm && !v.unknown) throw new AsmError('SEG 后面应该是变量、标号或段名');
          const r = newVal();
          r.frameImm = v.frame ?? v.frameImm;
          r.unknown = v.unknown;
          return r;
        }
        case 'type': { this.next(); const v = this.parsePtr(); return newVal(v.isTypeKw ? v.n : v.type); }
        case 'size': case 'sizeof': case 'length': case 'lengthof': {
          this.next();
          const v = this.parsePtr();
          return newVal(this.a.symSize(v, t.lower as 'size' | 'sizeof' | 'length' | 'lengthof'));
        }
        case 'short': { this.next(); const v = this.parsePtr(); return { ...v, dist: 'short' }; }
        case 'this': {
          this.next();
          const ty = this.parsePtr();
          if (!ty.isTypeKw) throw new AsmError('THIS 后面需要类型');
          const v = this.a.lookup({ kind: 'id', text: '$', lower: '$', value: 0, col: t.col }, false);
          return { ...v, type: ty.n, isMem: ty.n !== T_NEAR && ty.n !== T_FAR };
        }
      }
    }
    const x = this.parseSegOvr();
    if (this.is('ptr')) {
      this.next();
      if (!x.isTypeKw) throw new AsmError('PTR 前面应该是类型（BYTE / WORD / DWORD / NEAR / FAR）');
      const y = this.parsePtr();
      if (y.regType) throw new AsmError('寄存器不需要 PTR');
      const r = { ...y, type: x.n, ptr: true };
      if (x.n === T_NEAR) r.dist = 'near';
      else if (x.n === T_FAR) r.dist = 'far';
      else r.isMem = r.isMem || r.base >= 0 || r.index >= 0 || r.segOvr >= 0 || !!r.frame;
      return r;
    }
    return x;
  }
  private parseSegOvr(): Val {
    const x = this.parsePostfix();
    if (this.is(':')) {
      this.next();
      const y = this.parsePtr();
      if (x.regType === 1) {
        if (y.regType) throw new AsmError('段超越后面不能是寄存器');
        return { ...y, segOvr: x.reg };
      }
      if (x.frameImm) throw new AsmError('暂不支持用段名或组名做段超越，请用段寄存器（如 ES:）');
      throw new AsmError('冒号前面应该是段寄存器（ES/CS/SS/DS）');
    }
    return x;
  }
  private parsePostfix(): Val {
    let v = this.parsePrimary();
    while (this.is('[')) {
      const b = this.parseBracket();
      v = addVal(v, b);
    }
    return v;
  }
  private parseBracket(): Val {
    this.expect('[');
    this.bracket++;
    const v = this.parseOr();
    this.expect(']');
    this.bracket--;
    return { ...v, isMem: true };
  }
  private parsePrimary(): Val {
    const t = this.peek();
    if (!t) throw new AsmError('表达式不完整');
    if (t.kind === 'num') { this.next(); return newVal(t.value); }
    if (t.kind === 'str') {
      this.next();
      const b = encodeStr(t.text);
      if (b.length === 0) throw new AsmError('空字符串');
      if (b.length > 2) throw new AsmError(`字符串 '${t.text}' 不能用在表达式中（太长）`, t.col);
      return newVal(b.length === 2 ? (b[0] << 8) | b[1] : b[0]);
    }
    if (t.text === '(') {
      this.next();
      const v = this.parseOr();
      this.expect(')');
      return v;
    }
    if (t.text === '[') return this.parseBracket();
    if (t.kind === 'id') {
      this.next();
      if (t.lower === '?') throw new AsmError('? 只能用在数据定义中');
      return this.a.lookup(t, this.bracket > 0);
    }
    throw new AsmError(`表达式中不应出现 ${t.text}`, t.col);
  }
}

function addVal(a: Val, b: Val): Val {
  if (a.regType || b.regType) throw new AsmError('寄存器不能参与加减运算（间接寻址请写在方括号里，例如 [BX+2]）');
  if (a.isTypeKw || b.isTypeKw) throw new AsmError('类型名不能参与运算');
  if (a.frame && b.frame) throw new AsmError('两个地址不能相加');
  if (a.frameImm || b.frameImm) throw new AsmError('段地址不能参与加减运算');
  const r: Val = { ...a };
  r.n = a.n + b.n;
  r.frame = a.frame ?? b.frame;
  r.seg = a.seg ?? b.seg;
  r.sym = a.sym ?? b.sym;
  r.isMem = a.isMem || b.isMem;
  r.type = a.type || b.type;
  if (a.base >= 0 && b.base >= 0) throw new AsmError('不能同时使用两个基址寄存器（BX 和 BP）');
  if (a.index >= 0 && b.index >= 0) throw new AsmError('不能同时使用两个变址寄存器（SI 和 DI）');
  r.base = a.base >= 0 ? a.base : b.base;
  r.index = a.index >= 0 ? a.index : b.index;
  r.segOvr = a.segOvr >= 0 ? a.segOvr : b.segOvr;
  r.unknown = a.unknown || b.unknown;
  r.ptr = a.ptr || b.ptr;
  r.dist = a.dist || b.dist;
  return r;
}

function subVal(a: Val, b: Val): Val {
  if (a.regType || b.regType) throw new AsmError('寄存器不能参与加减运算');
  if (b.base >= 0 || b.index >= 0) throw new AsmError('不能减去寄存器');
  if (a.frameImm || b.frameImm) throw new AsmError('段地址不能参与加减运算');
  const r: Val = { ...a };
  r.n = a.n - b.n;
  r.unknown = a.unknown || b.unknown;
  if (a.frame && b.frame) {
    if (a.frame !== b.frame && !r.unknown) throw new AsmError('不同段中的地址不能相减');
    r.frame = null; r.seg = null; r.sym = null;
    r.isMem = a.base >= 0 || a.index >= 0;
    r.type = 0;
  } else if (b.frame && !b.unknown) {
    throw new AsmError('不能用常数减去地址');
  }
  return r;
}

function absOp(a: Val, b: Val, op: string, f: (x: number, y: number) => number): Val {
  const bad = (v: Val) => v.regType || v.isMem || v.base >= 0 || v.index >= 0 || v.frame || v.frameImm || v.isTypeKw;
  if ((bad(a) && !a.unknown) || (bad(b) && !b.unknown)) throw new AsmError(`运算符 ${op.toUpperCase()} 只能用于常数`);
  const r = newVal(f(a.n, b.n));
  r.unknown = a.unknown || b.unknown;
  return r;
}

// ======================= 工具函数 =======================

function alignUp(v: number, a: number): number {
  return Math.ceil(v / a) * a;
}

/** 字符串转字节：ASCII 原样，其他字符按 GBK 无法处理时用 '?' */
function encodeStr(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out.push(c < 256 ? c : 0x3f);
  }
  return out;
}

/** 按顶层逗号分割记号 */
function splitComma(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.text === '(' || t.text === '[' || t.text === '<') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '>') depth--;
    if (t.text === ',' && depth === 0 && t.kind === 'op') { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length || out.length) out.push(cur);
  return out;
}

/** 宏实参分割：逗号分隔，<...> 内的逗号不分割 */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, q = '';
  for (const c of text) {
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '<') { if (depth++ === 0) continue; }
    else if (c === '>') { if (--depth === 0) continue; }
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

/** 宏参数替换：标识符整体替换，& 用于拼接 */
function substitute(line: string, map: Map<string, string>): string {
  if (!map.size) return line;
  const s = stripComment(line);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j++;
      const inner = s.slice(i + 1, j).replace(/&([A-Za-z_@$?][\w@$?]*)&?/g, (m, n: string) => map.get(n.toLowerCase()) ?? m);
      out += c + inner + (j < s.length ? c : '');
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_@$?.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[\w@$?]/.test(s[j])) j++;
      const id = s.slice(i, j);
      const rep = map.get(id.toLowerCase());
      if (rep !== undefined) {
        if (out.endsWith('&')) out = out.slice(0, -1);
        out += rep;
        if (s[j] === '&') j++;
      } else out += id;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
