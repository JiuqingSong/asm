import './style.css';
import { assemble } from '../asm/assembler.ts';
import type { Diag, Program } from '../asm/types.ts';
import { Machine, type StopReason } from '../machine/machine.ts';
import { scanForChar } from '../machine/devices.ts';
import { AX } from '../cpu/cpu.ts';
import { EditorView } from './editor.ts';
import { Screen } from './screen.ts';
import { RegisterPanel, StackPanel, VarsPanel, MemoryPanel, takeSnapshot, h2, h4, type Snapshot } from './panels.ts';
import { EXAMPLES } from './examples.ts';
import { INSTR_HELP, DIRECTIVE_HELP, DOS_FUNCS, BIOS_FUNCS } from './help.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get(k: string): string | null { try { return localStorage.getItem('asm86.' + k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem('asm86.' + k, v); } catch { /* 无痕模式等情况下忽略 */ } },
};

type Level = 'error' | 'warning' | 'info' | 'ok';
interface Message { level: Level; text: string; line?: number }

class App {
  m = new Machine();
  editor: EditorView;
  screen: Screen;
  regs = new RegisterPanel($('regs'), $('flags'), $('cs-ip'));
  stack = new StackPanel($('stack'), $('stack-note'));
  vars = new VarsPanel($('tab-vars'));
  memory = new MemoryPanel($('memory'), $<HTMLInputElement>('mem-addr'));

  program: Program | null = null;
  dirty = true;
  fileName = '未命名.asm';
  messages: Message[] = [];
  tab = 'vars';
  /** 上一次停下时的状态（用于高亮变化） */
  snap: Snapshot | null = null;
  mode: 'idle' | 'run' | 'animate' = 'idle';
  private animTimer = 0;
  private raf = 0;
  private lastRender = 0;

  constructor() {
    this.editor = new EditorView($('editor'), {
      onChange: () => this.markDirty(),
      onBreakpointsChanged: () => this.syncBreakpoints(),
      hover: (w, line, text) => this.hover(w, line, text),
    });
    this.screen = new Screen($('screen'));
    this.screen.onKey = e => this.key(e);
    this.m.events = {
      log: msg => this.addMessage('warning', msg),
      bell: () => this.beep(),
      filesChanged: () => { if (this.tab === 'files') this.renderFiles(); },
    };
    this.stack.onLineClick = l => this.editor.revealLine(l);
    this.vars.onLineClick = l => this.editor.revealLine(l);
    this.vars.onAddrClick = (seg, off) => { this.memory.go(seg, off); this.setTab('memory'); };

    this.bindUi();
    const saved = store.get('source');
    const savedName = store.get('file');
    if (saved) { this.editor.value = saved; this.fileName = savedName || this.fileName; }
    else this.loadExample(EXAMPLES[0].id, false);
    const sp = store.get('speed');
    if (sp) $<HTMLSelectElement>('speed').value = sp;
    $<HTMLInputElement>('show-bytes').checked = store.get('showBytes') === '1';
    $('file-name').textContent = this.fileName;
    this.assemble(false);
    this.render(true);
  }

  // ======================= 界面绑定 =======================

  private bindUi(): void {
    const sel = $<HTMLSelectElement>('examples');
    for (const ex of EXAMPLES) sel.add(new Option(ex.title, ex.id));
    sel.onchange = () => { if (sel.value) this.loadExample(sel.value, true); sel.value = ''; };
    $('btn-open').onclick = () => $<HTMLInputElement>('file-input').click();
    $<HTMLInputElement>('file-input').onchange = e => this.openFile(e.target as HTMLInputElement);
    $('btn-save').onclick = () => this.saveFile();
    $('btn-assemble').onclick = () => { this.stop(); this.assemble(true); };
    $('btn-run').onclick = () => this.run();
    $('btn-pause').onclick = () => this.pause();
    $('btn-step').onclick = () => this.step(false);
    $('btn-over').onclick = () => this.step(true);
    $('btn-back').onclick = () => this.back();
    $('btn-reset').onclick = () => this.restart();
    $<HTMLSelectElement>('speed').onchange = e => {
      store.set('speed', (e.target as HTMLSelectElement).value);
      if (this.mode !== 'idle') { this.stop(); this.run(); }
    };
    $<HTMLInputElement>('show-bytes').onchange = e => {
      const on = (e.target as HTMLInputElement).checked;
      store.set('showBytes', on ? '1' : '0');
      this.editor.showBytes(this.dirty ? null : this.program, on);
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.onclick = () => this.setTab(b.dataset.tab!);
    const memAddr = $<HTMLInputElement>('mem-addr');
    memAddr.onchange = () => { this.memory.expr = memAddr.value; this.renderTab(); };
    memAddr.onkeydown = e => { if (e.key === 'Enter') { this.memory.expr = memAddr.value; this.renderTab(); } };
    $('mem-prev').onclick = () => { this.memory.page(this.m, -0x100); this.renderTab(); };
    $('mem-next').onclick = () => { this.memory.page(this.m, 0x100); this.renderTab(); };
    $('file-upload').onclick = () => $<HTMLInputElement>('disk-input').click();
    $<HTMLInputElement>('disk-input').onchange = e => this.uploadToDisk(e.target as HTMLInputElement);
    $('files').onclick = e => this.fileAction(e);
    $('tab-messages').onclick = e => {
      const a = (e.target as HTMLElement).closest('a[data-line]') as HTMLElement | null;
      if (a) this.editor.revealLine(+a.dataset.line!);
    };
    $('screen').addEventListener('paste', e => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (text) { e.preventDefault(); this.m.typeText(text.replace(/\r?\n/g, '\r'), scanForChar); this.afterKey(); }
    });
    $('screen').addEventListener('mousedown', () => this.screen.focus());

    window.addEventListener('keydown', e => {
      const k = e.key;
      let handled = true;
      if (k === 'F5' && e.ctrlKey) this.restart();
      else if (k === 'F5') this.run();
      else if (k === 'F6') this.pause();
      else if (k === 'F7') { this.stop(); this.assemble(true); }
      else if (k === 'F10') this.step(true);
      else if (k === 'F11' && e.shiftKey) this.back();
      else if (k === 'F11') this.step(false);
      else if (k === 's' && e.ctrlKey) this.saveFile();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    const screenPane = document.querySelector('.screen-pane') as HTMLElement;
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--screen-h', screenPane.offsetHeight + 'px');
    }).observe(screenPane);
    window.addEventListener('beforeunload', () => this.save());
  }

  private setTab(t: string): void {
    this.tab = t;
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.classList.toggle('active', b.dataset.tab === t);
    for (const id of ['vars', 'memory', 'messages', 'files']) $('tab-' + id).classList.toggle('hidden', id !== t);
    this.renderTab();
  }

  // ======================= 文件 =======================

  private save(): void {
    store.set('source', this.editor.value);
    store.set('file', this.fileName);
  }

  private loadExample(id: string, confirmReplace: boolean): void {
    const ex = EXAMPLES.find(e => e.id === id);
    if (!ex) return;
    if (confirmReplace && this.editor.value.trim() && !confirm(`用示例"${ex.title}"替换当前编辑器中的代码？`)) return;
    this.stop();
    this.editor.value = ex.source;
    this.fileName = ex.id + '.asm';
    $('file-name').textContent = this.fileName;
    this.assemble(false);
    this.save();
  }

  private async openFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { text = new TextDecoder('gbk').decode(buf); }
    this.stop();
    this.editor.value = text.replace(/\x1a+$/, '');
    this.fileName = f.name;
    $('file-name').textContent = f.name;
    this.assemble(false);
    this.save();
  }

  private saveFile(): void {
    const blob = new Blob([this.editor.value.replace(/\r?\n/g, '\r\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.fileName.endsWith('.asm') ? this.fileName : this.fileName + '.asm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async uploadToDisk(input: HTMLInputElement): Promise<void> {
    for (const f of Array.from(input.files ?? [])) {
      this.m.files.set(f.name.toUpperCase(), new Uint8Array(await f.arrayBuffer()));
    }
    input.value = '';
    this.renderFiles();
  }

  private fileAction(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b) return;
    const name = b.dataset.name!;
    if (b.dataset.act === 'del') this.m.files.delete(name);
    else {
      const data = this.m.files.get(name);
      if (!data) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data.slice()]));
      a.download = name;
      a.click();
    }
    this.renderFiles();
  }

  private renderFiles(): void {
    const el = $('files');
    if (!this.m.files.size) { el.innerHTML = '<div class="empty">虚拟磁盘是空的。程序用 INT 21h 创建的文件会出现在这里，也可以上传文件给程序读取。</div>'; return; }
    el.innerHTML = [...this.m.files.entries()].sort().map(([n, d]) =>
      `<div class="file-row"><span class="fn">C:\\${n}</span><span class="note">${d.length} 字节</span>` +
      `<button data-act="get" data-name="${n}">下载</button><button data-act="del" data-name="${n}">删除</button></div>`).join('');
  }

  // ======================= 汇编 =======================

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      $('dirty-note').textContent = '已修改，运行时会自动重新汇编';
      this.editor.showBytes(null, false);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 500);
  }
  private saveTimer = 0;

  /** 汇编并装载；返回是否成功 */
  assemble(showMessages: boolean): boolean {
    const src = this.editor.value;
    let p: Program;
    try {
      p = assemble(src);
    } catch (e) {
      this.addMessage('error', '汇编器内部错误：' + (e as Error).message);
      console.error(e);
      return false;
    }
    this.messages = [];
    for (const d of p.diagnostics) this.addDiag(d);
    const showBytes = $<HTMLInputElement>('show-bytes').checked;
    this.editor.setProgram(p.ok ? p : null, p.diagnostics, showBytes);
    this.dirty = false;
    $('dirty-note').textContent = '';
    if (!p.ok) {
      this.program = null;
      this.m.unload();
      this.snap = null;
      const n = p.diagnostics.filter(d => d.severity === 'error').length;
      this.setStatus(`汇编失败：${n} 个错误`, 'error');
      this.setTab('messages');
      this.editor.setCurrentLine(null, false);
      this.render(true);
      return false;
    }
    this.program = p;
    const warns = p.diagnostics.filter(d => d.severity === 'warning').length;
    const size = p.chunks.reduce((s, c) => s + c.bytes.length, 0);
    this.addMessage('ok', `汇编成功：${p.format.toUpperCase()} 程序，${size} 字节${warns ? `，${warns} 个警告` : ''}`);
    this.load();
    if (showMessages && (warns || this.tab === 'messages')) this.setTab('messages');
    return true;
  }

  private load(): void {
    if (!this.program) return;
    this.m.load(this.program, $<HTMLInputElement>('cmdline').value);
    this.stack.setProgram(this.program);
    this.syncBreakpoints();
    this.snap = null;
    const ds = this.program.dataSeg;
    this.memory.go(ds, 0);
    this.setStatus('已装载，可以运行或单步执行', '');
    this.render(true);
  }

  private ensureReady(): boolean {
    if (this.dirty || !this.program) {
      if (!this.assemble(true)) return false;
    }
    return true;
  }

  private syncBreakpoints(): void {
    this.m.breakpoints.clear();
    if (!this.program) return;
    for (const l of this.editor.breakpointLines()) {
      const addrs = this.program.lineToAddrs.get(l);
      if (addrs) this.m.breakpoints.add(addrs[0]);
    }
  }

  // ======================= 执行控制 =======================

  private speed(): number { return +$<HTMLSelectElement>('speed').value; }

  run(): void {
    if (this.mode !== 'idle') return;
    if (!this.ensureReady()) return;
    if (this.m.status === 'exited' || this.m.status === 'error') this.load();
    this.syncBreakpoints();
    this.snap = takeSnapshot(this.m);
    const sp = this.speed();
    if (sp === 0) {
      this.mode = 'run';
      this.setStatus('运行中…', 'running');
      this.tick();
    } else {
      this.mode = 'animate';
      this.setStatus(`运行中（每秒 ${sp} 步）…`, 'running');
      this.animTimer = window.setInterval(() => this.animStep(), 1000 / sp);
    }
    this.updateButtons();
  }

  private tick = (): void => {
    if (this.mode !== 'run') return;
    const t0 = performance.now();
    let r: StopReason;
    do { r = this.m.run(20_000); } while (r === 'budget' && performance.now() - t0 < 14);
    if (r === 'budget') {
      if (performance.now() - this.lastRender > 60) { this.render(false); this.lastRender = performance.now(); }
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    if (r === 'wait') {
      this.render(false);
      this.setStatus('等待键盘输入：点击下面的 DOS 屏幕后打字', 'waiting');
      this.screen.focus();
      return; // 保持 run 模式，按键后继续
    }
    this.mode = 'idle';
    this.stopped(r);
  };

  private animStep(): void {
    if (this.m.status === 'waiting') return;
    const before = takeSnapshot(this.m);
    const r = this.m.stepInto();
    this.snap = before;
    if (r === 'step' && this.m.breakpoints.has(this.m.linearIP)) {
      this.stop();
      this.m.message = '到达断点';
      this.stopped('breakpoint');
      return;
    }
    if (r === 'wait') {
      this.render(true);
      this.setStatus('等待键盘输入：点击下面的 DOS 屏幕后打字', 'waiting');
      this.screen.focus();
      return;
    }
    if (r !== 'step') { this.stop(); this.stopped(r); return; }
    this.render(true);
  }

  step(over: boolean): void {
    if (this.mode !== 'idle') this.pause();
    if (!this.ensureReady()) return;
    if (this.m.status === 'exited') { this.setStatus('程序已结束。点"重启"可以重新开始', 'error'); return; }
    if (this.m.status === 'waiting') { this.setStatus('程序正在等待键盘输入：点击 DOS 屏幕后打字', 'waiting'); this.screen.focus(); return; }
    this.syncBreakpoints();
    this.snap = takeSnapshot(this.m);
    const r = over ? this.m.stepOver() : this.m.stepInto();
    this.stopped(r);
  }

  back(): void {
    if (this.mode !== 'idle') this.pause();
    if (!this.program || this.dirty) return;
    this.snap = takeSnapshot(this.m);
    if (!this.m.stepBack()) { this.setStatus('已经在程序开头了', ''); return; }
    this.setStatus(this.m.message || '已后退一步', '');
    this.render(true);
  }

  pause(): void {
    if (this.mode === 'idle' && this.m.status !== 'waiting') return;
    this.stop();
    this.m.pause();
    this.setStatus('已暂停', '');
    this.render(true);
  }

  private stop(): void {
    this.mode = 'idle';
    clearInterval(this.animTimer);
    cancelAnimationFrame(this.raf);
    this.updateButtons();
  }

  restart(): void {
    this.stop();
    if (this.dirty || !this.program) { this.assemble(true); return; }
    this.load();
  }

  private stopped(r: StopReason): void {
    this.updateButtons();
    const m = this.m;
    switch (r) {
      case 'exit':
        this.setStatus(m.message, m.message.includes('溢出') ? 'error' : '');
        this.addMessage(m.message.includes('溢出') ? 'error' : 'info', `${m.message}（共执行 ${m.instructions.toLocaleString()} 条指令）`);
        break;
      case 'breakpoint': this.setStatus(m.message || '到达断点', ''); break;
      case 'wait':
        this.setStatus('等待键盘输入：点击下面的 DOS 屏幕后打字', 'waiting');
        this.screen.focus();
        break;
      case 'error':
        this.setStatus(m.message, 'error');
        this.addMessage('error', m.message);
        break;
      case 'paused': this.setStatus(m.message || '已暂停', ''); break;
      default: this.setStatus(m.message || '已暂停', '');
    }
    this.render(true);
  }

  private key(e: import('../machine/devices.ts').KeyEvent): void {
    if (!this.program || this.dirty) return;
    this.m.pressKey(e);
    this.afterKey();
  }

  private afterKey(): void {
    const m = this.m;
    if (m.status !== 'waiting') return;
    if (this.mode === 'run') {
      this.setStatus('运行中…', 'running');
      this.raf = requestAnimationFrame(this.tick);
    } else if (this.mode === 'animate') {
      const r = m.continuePending(2_000_000);
      if (r === 'wait') return;
      this.setStatus(`运行中（每秒 ${this.speed()} 步）…`, 'running');
      if (r !== 'step') { this.stop(); this.stopped(r); return; }
      this.render(true);
    } else {
      const r = m.continuePending(50_000_000);
      if (r === 'wait') { this.render(true); return; }
      this.stopped(r);
    }
  }

  // ======================= 渲染 =======================

  private setStatus(text: string, cls: string): void {
    const s = $('status');
    s.textContent = text;
    s.title = text;
    s.className = 'status ' + cls;
  }

  private updateButtons(): void {
    const running = this.mode !== 'idle';
    $<HTMLButtonElement>('btn-run').disabled = running;
    $<HTMLButtonElement>('btn-pause').disabled = !running && this.m.status !== 'waiting';
    $<HTMLButtonElement>('btn-back').disabled = running || !this.m.canStepBack;
  }

  render(full: boolean): void {
    const m = this.m, cpu = m.cpu;
    const p = this.program;
    const lin = m.linearIP;
    const line = p && !this.dirty ? p.addrToLine.get(lin) ?? null : null;
    const inBios = m.inBios();
    const info = line ? `第 ${line} 行` : p ? (inBios ? 'BIOS/DOS 内部' : '') : '';
    this.regs.render(cpu, this.snap, info);
    this.stack.render(m, this.snap);
    const bda = 0x400;
    this.screen.render(m.mem, m.mem[bda + 0x51], m.mem[bda + 0x50], m.mem[bda + 0x60] | (m.mem[bda + 0x61] << 8));
    if (full || this.mode === 'animate') {
      this.editor.setCurrentLine(this.mode === 'run' ? null : line, true);
      this.renderTab();
    }
    this.updateButtons();
  }

  private renderTab(): void {
    switch (this.tab) {
      case 'vars': this.vars.render(this.m, this.snap); break;
      case 'memory': this.memory.render(this.m, this.snap); break;
      case 'messages': this.renderMessages(); break;
      case 'files': this.renderFiles(); break;
    }
  }

  // ======================= 消息 =======================

  private addDiag(d: Diag): void {
    this.messages.push({ level: d.severity, text: d.message, line: d.line > 0 ? d.line : undefined });
    this.renderMessageCount();
  }

  addMessage(level: Level, text: string): void {
    this.messages.push({ level, text });
    if (this.messages.length > 300) this.messages.shift();
    this.renderMessageCount();
    if (this.tab === 'messages') this.renderMessages();
  }

  private renderMessageCount(): void {
    const n = this.messages.filter(m => m.level === 'error').length;
    $('msg-count').textContent = n ? String(n) : '';
  }

  private renderMessages(): void {
    const el = $('tab-messages');
    if (!this.messages.length) { el.innerHTML = '<div class="empty">没有消息</div>'; return; }
    const label: Record<Level, string> = { error: '错误', warning: '警告', info: '信息', ok: '完成' };
    const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    el.innerHTML = this.messages.map(m =>
      `<div class="msg ${m.level}"><span class="lvl">${label[m.level]}</span>${m.line ? `<a data-line="${m.line}">第 ${m.line} 行</a>` : ''}<span>${esc(m.text)}</span></div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  private beep(): void {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.12);
      o.onended = () => ctx.close();
    } catch { /* 没有声音设备 */ }
  }

  // ======================= 悬停提示 =======================

  private hover(word: string, _line: number, lineText: string): string[] | null {
    const w = word.toLowerCase();
    const m = this.m, cpu = m.cpu;
    const loaded = !!this.program && !this.dirty && m.status !== 'empty';
    const r16: Record<string, number> = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
    const r8: Record<string, number> = { al: 0, cl: 1, dl: 2, bl: 3, ah: 4, ch: 5, dh: 6, bh: 7 };
    const sr: Record<string, number> = { es: 0, cs: 1, ss: 2, ds: 3 };
    const fmt16 = (v: number) => `\`${h4(v)}h\` = ${v}（有符号 ${(v << 16) >> 16}）  \n二进制 \`${v.toString(2).padStart(16, '0').replace(/(.{4})(?=.)/g, '$1 ')}\``;
    if (w in r16 || w in sr) {
      if (!loaded) return [`**${w.toUpperCase()}**：16 位寄存器`];
      const v = w in r16 ? cpu.r[r16[w]] : cpu.s[sr[w]];
      return [`**${w.toUpperCase()}** = ${fmt16(v)}`];
    }
    if (w in r8) {
      if (!loaded) return [`**${w.toUpperCase()}**：8 位寄存器`];
      const v = cpu.getR8(r8[w]);
      return [`**${w.toUpperCase()}** = \`${h2(v)}h\` = ${v}（有符号 ${(v << 24) >> 24}）${v >= 32 && v < 127 ? `，字符 '${String.fromCharCode(v)}'` : ''}`];
    }
    const sym = this.program?.symbols.find(s => s.name.toLowerCase() === w);
    if (sym && !this.dirty) {
      if (sym.kind === 'const') return [`**常量 ${sym.name}** = ${sym.value}（\`${h4(sym.value ?? 0)}h\`）`];
      const addr = `\`${h4(sym.segment)}:${h4(sym.offset)}\``;
      if (sym.kind === 'label') return [`**标号 ${sym.name}**：${addr}（第 ${sym.line} 行）`];
      const lin = sym.segment * 16 + sym.offset;
      const t = sym.type <= 10 ? sym.type : 1;
      const n = Math.min(Math.max(1, sym.length), 16);
      const vals: string[] = [];
      for (let k = 0; k < n; k++) {
        const a = lin + k * t;
        vals.push(t === 1 ? h2(m.mem[a]) : t === 2 ? h4(m.mem[a] | (m.mem[a + 1] << 8)) : h4(m.mem[a + 2] | (m.mem[a + 3] << 8)) + ':' + h4(m.mem[a] | (m.mem[a + 1] << 8)));
      }
      const tn = t === 1 ? 'DB' : t === 2 ? 'DW' : t === 4 ? 'DD' : 'D?';
      return [`**变量 ${sym.name}**：${tn}${sym.length > 1 ? ` × ${sym.length}` : ''}，地址 ${addr}`, `当前值：\`${vals.join(' ')}${sym.length > 16 ? ' …' : ''}\``];
    }
    if (w === 'int') {
      const mm = lineText.match(/\bint\s+([0-9][0-9a-f]*)h?\b/i);
      const n = mm ? parseInt(mm[1], /h$/i.test(lineText.match(/\bint\s+(\S+)/i)?.[1] ?? '') || /[a-f]/i.test(mm[1]) ? 16 : 10) : -1;
      const out = [`**INT**：${INSTR_HELP.int[0]}`];
      const ah = loaded ? cpu.r[AX] >> 8 : -1;
      const table = n === 0x21 ? DOS_FUNCS : BIOS_FUNCS[n];
      if (table) {
        const name = n === 0x21 ? 'INT 21h（DOS 功能调用）' : `INT ${h2(n)}h`;
        if (ah >= 0 && table[ah]) out.push(`${name}，当前 AH = ${h2(ah)}h：**${table[ah]}**`);
        else out.push(`${name} 常用功能（AH）：  \n` + Object.entries(table).slice(0, 12).map(([k, v]) => `\`${h2(+k)}h\` ${v}`).join('  \n'));
      }
      return out;
    }
    const ih = INSTR_HELP[w];
    if (ih) return [`**${w.toUpperCase()}**：${ih[0]}`, `影响标志位：${ih[1]}`];
    const dh = DIRECTIVE_HELP[w];
    if (dh) return [`**${word.toUpperCase()}**：${dh}`];
    return null;
  }
}

const app = new App();
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
