import './style.css';
import { setupLayout } from './layout.ts';
import { DrivesPanel } from './drives.ts';
import { bootProgram, driveName } from '../machine/boot.ts';
import { assemble } from '../asm/assembler.ts';
import { generateExecutable } from '../asm/executable.ts';
import type { Diag, Program } from '../asm/types.ts';
import { Machine, CPU_SPEEDS, CD_BOOT, type StopReason, type CpuSpeedId } from '../machine/machine.ts';
import { readElTorito } from '../machine/iso.ts';
import { Disk } from '../machine/disk.ts';
import { DualMachine } from '../machine/dual.ts';
import { loadExecutable } from '../machine/exe.ts';
import { scanForChar, type KeyEvent } from '../machine/devices.ts';
import { WIRING_DESC, MCR_DTR, MCR_RTS, MCR_OUT2, MSR_CTS, MSR_DSR, MSR_DCD, LSR_DR, LSR_THRE, type UART, type Wiring } from '../machine/uart.ts';
import { AX } from '../cpu/cpu.ts';
import { EditorView, monaco } from './editor.ts';
import { Screen } from './screen.ts';
import { Speaker } from './speaker.ts';
import { generateFont } from './font.ts';

// 8×8 字库：图形模式下显示文字用（写进虚拟 BIOS 的 ROM）
Machine.font = generateFont();
import { DisasmPanel, currentInstruction } from './disasm-panel.ts';
import { RegisterPanel, StackPanel, VarsPanel, MemoryPanel, takeSnapshot, h2, h4, type Snapshot } from './panels.ts';
import { EXAMPLES } from './examples.ts';
import { INSTR_HELP, DIRECTIVE_HELP, DOS_FUNCS, BIOS_FUNCS } from './help.ts';
import { DEFAULT_CONFIG, configWarnings, type MachineConfig, type StartupMode } from '../machine/config.ts';
import { StartupPanel } from './startup.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const store = {
  get(k: string): string | null { try { return localStorage.getItem('asm86.' + k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem('asm86.' + k, v); } catch { /* 无痕模式等情况下忽略 */ } },
};

type Level = 'error' | 'warning' | 'info' | 'ok';
interface Message { level: Level; text: string; line?: number; who?: number }

/** 一台机器 + 它的源程序 + 它的屏幕 */
interface Session {
  i: number;
  tag: string;
  m: Machine;
  model: monaco.editor.ITextModel;
  program: Program | null;
  dirty: boolean;
  /** 上次载入、保存或新建时的文档版本，独立于是否需要重新汇编。 */
  sourceVersion: number;
  fileName: string;
  screen: Screen;
  box: HTMLElement;
  cmdline: HTMLInputElement;
  snap: Snapshot | null;
  speaker: Speaker;
  /** 正在运行的可执行文件名（直接运行 EXE/COM 时；运行源程序时为 null） */
  binary: string | null;
  /** 可执行文件的说明页（只读） */
  binModel: monaco.editor.ITextModel | null;
  /** 在反汇编面板上按地址设的断点（线性地址） */
  addrBps: Set<number>;
  /** 记录历史（可以后退）：从磁盘启动时默认关闭（为了速度），运行源程序、EXE 时默认打开；双机模式下总是不记录 */
  record: boolean;
}

class App {
  dual!: DualMachine;
  startupMode: StartupMode | null = null;
  private startup: StartupPanel;
  private choosingBoot = false;
  private loading = false;
  private resetLayout: () => void = () => {};
  editor: EditorView;
  sessions: Session[] = [];
  active = 0;
  mode: 'single' | 'dual' = 'single';
  regs = new RegisterPanel($('regs'), $('flags'), $('cs-ip'));
  stack = new StackPanel($('stack'), $('stack-note'));
  vars = new VarsPanel($('tab-vars'));
  memory = new MemoryPanel($('memory'), $<HTMLInputElement>('mem-addr'));
  disasm = new DisasmPanel($('tab-disasm'), (m, t) => this.memory.parse(m, t));
  drives: DrivesPanel | null = null;
  /** "运行到这里"的临时断点 */
  private tempBp: { i: number; lin: number } | null = null;
  messages: Message[] = [];
  tab = 'vars';
  run: 'idle' | 'run' | 'animate' = 'idle';
  private animTimer = 0;
  private raf = 0;
  private lastRender = 0;
  private saveTimer = 0;

  constructor() {
    this.editor = new EditorView($('editor'), {
      onChange: model => this.markDirty(this.byModel(model)),
      onBreakpointsChanged: model => this.syncBreakpoints(this.byModel(model)),
      hover: (model, w, line, text) => this.hover(this.byModel(model), w, line, text),
    });
    this.startup = new StartupPanel(
      (mode, config, cpu, showDiskImages) => this.launch(mode, config, cpu, showDiskImages),
      () => CPU_SPEEDS.find(c => c.id === store.get('cpu'))?.id ?? '8088',
      message => { $('startup-error').textContent = message; this.addMessage('error', message); },
    );
    this.bindUi();
  }

  private createSessions(): void {
    const boxes = document.querySelectorAll<HTMLElement>('.screen-box');
    for (let i = 0; i < 2; i++) {
      const box = boxes[i];
      const model = this.editor.createModel('');
      const s: Session = {
        i, tag: i === 0 ? 'A' : 'B', m: this.dual.m[i], model, program: null, dirty: true, sourceVersion: model.getAlternativeVersionId(),
        fileName: '未命名.asm', screen: new Screen(box.querySelector('.screen') as HTMLElement), box,
        cmdline: box.querySelector('.cmdline') as HTMLInputElement, snap: null, speaker: new Speaker(), binary: null, binModel: null, addrBps: new Set(), record: true,
      };
      s.screen.onKey = e => this.key(s, e);
      s.screen.onMouseRel = (dx, dy, buttons) => {
        if (!s.program || (s.dirty && !s.binary)) return;
        if (!s.m.mouseDriverEnabled && s.m.com2.peer !== s.m.serialMouse) return;
        s.m.mouse.moveRel(dx, dy);
        s.m.mouse.queueButtons(buttons, s.m.clock);
        this.afterKey(s);
      };
      s.screen.onCapture = captured => {
        if (captured) this.setStatus(s.screen.fullscreenCapture
          ? '鼠标已全屏捕获，Esc 交给虚拟机。按右 Ctrl 释放并退出捕获全屏'
          : '鼠标已捕获。按右 Ctrl 释放；普通捕获中 Esc 仍由浏览器保留', 'running');
        else if (this.run === 'run') this.setStatus(this.runText(), 'running');
        else this.setStatus('鼠标已释放', '');
      };
      s.screen.onCaptureError = message => { this.addMessage('error', message, s.i); this.setStatus(message, 'error'); this.setTab('messages'); };
      s.screen.onMouse = (fx, fy, buttons) => {
        if (!s.program || (s.dirty && !s.binary)) return;
        if (!s.m.mouseDriverEnabled && s.m.com2.peer !== s.m.serialMouse) return;
        s.m.mouse.moveTo(fx * 640, fy * s.m.mouse.screenH);
        s.m.mouse.queueButtons(buttons, s.m.clock);
        if (this.run === 'idle' && s.m.config.vga) {
          const mem = s.m.mem, bda = 0x400;
          s.screen.render(mem, mem[bda + 0x51], mem[bda + 0x50], mem[bda + 0x60] | (mem[bda + 0x61] << 8), s.m.video, s.m.mouseDriverEnabled ? s.m.mouse : undefined);
        }
        this.afterKey(s); // 等键盘的程序可能要处理鼠标回调
      };
      s.m.events = {
        log: msg => this.addMessage('warning', msg, s.i),
        bell: () => this.beep(),
        speaker: f => {
          s.speaker.set(f);
          if (f > 0 && this.run === 'run' && this.speed() === 0 && !this.fastSpeakerHint) {
            this.fastSpeakerHint = true;
            this.addMessage('info', '程序打开了 PC 喇叭。全速运行时虚拟时间比真实时间快得多，声音会一闪而过；把速度选成"原机速度"才能听到正常的节奏。', s.i);
          }
        },
        filesChanged: () => { if (this.tab === 'files') this.renderFiles(); },
        disksChanged: () => this.drives?.changed(s.i),
      };
      box.addEventListener('mousedown', () => { s.screen.focus(); if (this.mode === 'dual' && this.active !== i) this.setActive(i); });
      box.querySelector('.screen')!.addEventListener('paste', e => {
        const text = (e as ClipboardEvent).clipboardData?.getData('text') ?? '';
        if (text) { e.preventDefault(); s.m.typeText(text.replace(/\r?\n/g, '\r'), scanForChar); this.afterKey(s); }
      });
      this.sessions.push(s);
      s.cmdline.onchange = () => store.set('cmdline' + (s.i ? '.b' : ''), s.cmdline.value);
      s.screen.setChinese(store.get('chinese') === '1');
    }
    this.stack.onLineClick = l => this.editor.revealLine(this.cur.model, l);
    this.vars.onLineClick = l => this.editor.revealLine(this.cur.model, l);
    this.vars.onAddrClick = (seg, off) => { this.memory.go(seg, off); this.setTab('memory'); };
    this.disasm.onToggleBp = lin => {
      const s = this.cur;
      if (s.addrBps.has(lin)) s.addrBps.delete(lin); else s.addrBps.add(lin);
      this.syncBreakpoints(s);
      this.renderTab();
    };
    this.disasm.onRunTo = lin => this.runTo(this.cur, lin);
    this.disasm.onLine = l => this.editor.revealLine(this.cur.model, l);

  }

  get cur(): Session { return this.sessions[this.active]; }
  private byModel(model: monaco.editor.ITextModel): Session { return this.sessions.find(s => s.model === model || s.binModel === model) ?? this.cur; }
  /** 编辑器里显示的文档：源程序，或可执行文件的说明页 */
  private shown(s: Session): monaco.editor.ITextModel { return s.binary && s.binModel ? s.binModel : s.model; }
  private showDoc(s: Session): void {
    this.editor.setModel(this.shown(s));
    this.editor.editor.updateOptions({ readOnly: !!s.binary });
  }
  /** 当前模式下参与运行的会话 */
  private get live(): Session[] { return this.mode === 'dual' ? this.sessions : [this.sessions[0]]; }

  // ======================= 初始化 =======================

  private loadWiring(): Wiring {
    const w = store.get('wiring');
    return w && w in WIRING_DESC ? (w as Wiring) : 'loopback-rts';
  }

  private async launch(mode: StartupMode, config: Readonly<MachineConfig>, cpu: CpuSpeedId, showDiskImages = mode !== 'debug'): Promise<void> {
    if (this.startupMode) await this.goHome();
    this.startupMode = mode;
    this.active = 0;
    this.resetLayout();
    this.messages = [];
    this.dual = new DualMachine(this.loadWiring(), [new Machine(config), new Machine(config)]);
    if (!this.sessions.length) this.createSessions();
    else for (const s of this.sessions) {
      const events = s.m.events;
      s.m = this.dual.m[s.i];
      s.m.events = events;
      s.program = null;
      s.binary = null;
      s.snap = null;
      s.addrBps.clear();
      s.dirty = true;
    }
    store.set('cpu', cpu);
    document.body.classList.add('has-session');
    document.body.classList.toggle('full-mode', mode === 'full');
    document.body.classList.toggle('show-disk-images', mode !== 'debug' || showDiskImages);
    $('mode-name').textContent = { debug: '直接调试', dual: '双机对联', full: '完整模拟' }[mode];
    $('startup-error').textContent = '';
    this.restore();
    this.loading = true;
    const workspace = document.querySelector<HTMLElement>('.layout')!;
    const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
    workspace.inert = toolbar.inert = true;
    try { await this.drives!.restore(); }
    finally { this.loading = false; workspace.inert = toolbar.inert = false; }
    for (const warning of configWarnings(config)) this.addMessage('warning', warning);
    if (mode === 'full') {
      this.setTab('files');
      await this.chooseBoot();
    }
    window.dispatchEvent(new Event('resize'));
  }

  private async goHome(): Promise<void> {
    if (!this.startupMode || this.loading) return;
    if (this.live.some(s => s.program?.format === 'boot' && !s.m.poweredOff) &&
      !confirm('返回启动选择将关闭当前虚拟机。客体系统尚未写回的缓存可能丢失；建议先在客体中安全关机。继续吗？')) throw new Error('已取消返回启动选择');
    this.stop();
    document.exitPointerLock();
    this.save();
    this.loading = true;
    const workspace = document.querySelector<HTMLElement>('.layout')!;
    const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
    workspace.inert = toolbar.inert = true;
    try {
      for (const s of this.live) await this.drives!.flushAll(s.i);
      this.dual.link.disconnect();
      for (const s of this.sessions) { s.m.powerOff(); s.m.unload(); }
      this.startupMode = null;
      document.body.classList.remove('has-session', 'full-mode', 'show-disk-images');
      this.setStatus('请选择启动方式', '');
    } finally { this.loading = false; workspace.inert = toolbar.inert = false; }
  }

  private async chooseBoot(): Promise<void> {
    if (this.choosingBoot || this.startupMode !== 'full') return;
    this.choosingBoot = true;
    const running = this.run !== 'idle';
    this.stop();
    this.cur.screen.release();
    this.drives?.render();
    try {
      const started = await this.startup.boot(this.cur.m, async drive =>
        drive === CD_BOOT ? this.runCdBoot(this.cur) : this.runBoot(this.cur, drive));
      if (!started && running) this.start();
      else if (!started) this.setStatus('未选择启动设备。点“重启”或“运行”重新选择', '');
    } finally { this.choosingBoot = false; }
  }

  private restore(): void {
    const cpu = (store.get('cpu') as CpuSpeedId) || '8088';
    $<HTMLSelectElement>('cpu').value = CPU_SPEEDS.some(c => c.id === cpu) ? cpu : '8088';
    this.applyCpu();
    $<HTMLSelectElement>('uart-mode').value = store.get('uartMode') === 'buffered' ? 'buffered' : 'real';
    $<HTMLInputElement>('disk-latency').checked = store.get('diskLatency') !== '0';
    this.applySerialSettings();
    const sp = store.get('speed');
    if (sp) $<HTMLSelectElement>('speed').value = sp;
    $<HTMLInputElement>('show-bytes').checked = store.get('showBytes') === '1';
    $<HTMLInputElement>('fullscreen-capture').checked = store.get('fullscreenCapture') === '1';
    for (const s of this.sessions) s.screen.fullscreenCapture = $<HTMLInputElement>('fullscreen-capture').checked;
    for (const s of this.sessions) {
      const key = s.i === 0 ? '' : '.b';
      const src = store.get('source' + key);
      const ex = EXAMPLES.find(e => e.id === (s.i === 0 ? 'hello' : 'chat'))!;
      const text = src ?? ex.source;
      if (s.model.getValue() !== text) this.editor.setText(s.model, text);
      s.sourceVersion = s.model.getAlternativeVersionId();
      s.fileName = src !== null ? store.get('file' + key) ?? '未命名.asm' : ex.id + '.asm';
      s.cmdline.value = store.get('cmdline' + key) ?? '';
    }
    this.showDoc(this.cur);
    this.setMode(this.startupMode === 'dual' ? 'dual' : 'single', false);
    if (this.startupMode !== 'full') {
      for (const s of this.live) this.assemble(s, false);
      this.loadAll();
    } else {
      this.setTab('files');
      this.render(true);
    }
  }

  private bindUi(): void {
    const sel = $<HTMLSelectElement>('examples');
    for (const ex of EXAMPLES) sel.add(new Option(ex.title, ex.id));
    sel.onchange = () => { if (sel.value) this.loadExample(sel.value); sel.value = ''; };
    const cpuSel = $<HTMLSelectElement>('cpu');
    for (const c of CPU_SPEEDS) cpuSel.add(new Option(c.name, c.id));
    cpuSel.onchange = () => { this.applyCpu(); store.set('cpu', cpuSel.value); };
    $('btn-home').onclick = () => { void this.goHome().catch(e => this.addMessage('error', (e as Error).message)); };
    const wiring = $<HTMLSelectElement>('wiring');
    for (const [k, v] of Object.entries(WIRING_DESC)) wiring.add(new Option(v, k));
    wiring.value = this.loadWiring();
    wiring.onchange = () => { this.dual.link.setWiring(wiring.value as Wiring); store.set('wiring', wiring.value); this.renderTab(); };
    $<HTMLSelectElement>('uart-mode').onchange = () => { this.applySerialSettings(); store.set('uartMode', $<HTMLSelectElement>('uart-mode').value); };
    $<HTMLInputElement>('disk-latency').onchange = () => { this.applySerialSettings(); store.set('diskLatency', $<HTMLInputElement>('disk-latency').checked ? '1' : '0'); };

    $('btn-new').onclick = () => this.newFile();
    $('btn-open').onclick = () => $<HTMLInputElement>('file-input').click();
    $<HTMLInputElement>('file-input').onchange = e => this.openFile(e.target as HTMLInputElement);
    $('btn-save').onclick = () => this.saveFile();
    $('btn-export').onclick = () => this.exportExecutable();
    $('btn-assemble').onclick = () => { this.stop(); this.assembleAll(true); };
    $('btn-run').onclick = () => this.start();
    $('btn-pause').onclick = () => this.pause();
    $('btn-step').onclick = () => this.step(false);
    $('btn-over').onclick = () => this.step(true);
    $('btn-out').onclick = () => this.step('out');
    $('btn-back').onclick = () => this.back();
    $<HTMLInputElement>('record-history').onchange = e => {
      const s = this.cur;
      s.record = (e.target as HTMLInputElement).checked;
      this.applyHistory(s);
      this.setStatus(s.record ? '开始记录历史：从现在起可以后退' : '不再记录历史（运行更快），不能后退', '');
      this.updateButtons();
    };
    $('btn-reset').onclick = () => this.restart();
    $('btn-power').onclick = () => this.powerOff();
    $('btn-cad').onclick = () => {
      const s = this.cur;
      if (!s.program || s.m.status === 'empty') { this.setStatus('虚拟机没有在运行', ''); return; }
      s.m.sendCtrlAltDel();
      this.afterKey(s);
      s.screen.focus();
    };
    $<HTMLSelectElement>('speed').onchange = e => {
      store.set('speed', (e.target as HTMLSelectElement).value);
      if (this.run !== 'idle') { this.stop(); this.start(); }
    };
    $<HTMLInputElement>('show-bytes').onchange = e => {
      const on = (e.target as HTMLInputElement).checked;
      store.set('showBytes', on ? '1' : '0');
      for (const s of this.sessions) this.editor.showBytes(s.model, s.dirty ? null : s.program, on);
    };
    $<HTMLInputElement>('fullscreen-capture').onchange = e => {
      const on = (e.target as HTMLInputElement).checked;
      store.set('fullscreenCapture', on ? '1' : '0');
      for (const s of this.sessions) s.screen.fullscreenCapture = on;
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.onclick = () => this.setTab(b.dataset.tab!);
    const memAddr = $<HTMLInputElement>('mem-addr');
    memAddr.onchange = () => { this.memory.expr = memAddr.value; this.renderTab(); };
    memAddr.onkeydown = e => { if (e.key === 'Enter') { this.memory.expr = memAddr.value; this.renderTab(); } };
    $('mem-prev').onclick = () => { this.memory.page(this.cur.m, -0x100); this.renderTab(); };
    $('mem-next').onclick = () => { this.memory.page(this.cur.m, 0x100); this.renderTab(); };
    $('file-upload').onclick = () => $<HTMLInputElement>('disk-input').click();
    $<HTMLInputElement>('disk-input').onchange = e => this.uploadToDisk(e.target as HTMLInputElement);
    $('files').onclick = e => this.fileAction(e);
    $('tab-messages').onclick = e => {
      const a = (e.target as HTMLElement).closest('a[data-line]') as HTMLElement | null;
      if (a) {
        const s = this.sessions[+(a.dataset.who ?? this.active)];
        if (s.i !== this.active) this.setActive(s.i);
        this.editor.revealLine(s.model, +a.dataset.line!);
      }
    };
    $('regs').addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest('[data-reg]') as HTMLElement | null;
      if (el) this.editRegister(el);
    });
    $('flags').addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest('[data-flag]') as HTMLElement | null;
      if (el) this.toggleFlag(+el.dataset.flag!);
    });
    const cn = document.querySelectorAll<HTMLInputElement>('.cn-toggle');
    const setChinese = (on: boolean) => {
      for (const c of cn) c.checked = on;
      for (const s of this.sessions) s.screen.setChinese(on);
      store.set('chinese', on ? '1' : '0');
      this.render(false);
    };
    for (const c of cn) c.onchange = () => setChinese(c.checked);
    if (store.get('chinese') === '1') setChinese(true);

    window.addEventListener('keydown', e => {
      if (!this.startupMode || this.loading || document.querySelector('dialog[open]')) return;
      const k = e.key;
      // 从磁盘启动、DOS 屏幕有焦点时，功能键交给虚拟机（调试请用工具栏按钮）
      if (/^F\d+$/.test(k) && (e.target as HTMLElement).closest?.('.screen') && this.cur.program?.format === 'boot') return;
      let handled = true;
      if (k === 'F5' && e.ctrlKey) this.restart();
      else if (k === 'F5') this.start();
      else if (k === 'F6') this.pause();
      else if (k === 'F7' && this.startupMode !== 'full') { this.stop(); this.assembleAll(true); }
      else if (k === 'F10' && e.ctrlKey) this.runToCursor();
      else if (k === 'F10') this.step(true);
      else if (k === 'F11' && e.shiftKey && e.ctrlKey) this.back();
      else if (k === 'F11' && e.shiftKey) this.step('out');
      else if (k === 'F11') this.step(false);
      else if (k === 's' && e.ctrlKey && this.startupMode !== 'full') this.saveFile();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    this.resetLayout = setupLayout(() => window.dispatchEvent(new Event('resize')));
    this.drives = new DrivesPanel($('drives'), {
      machines: () => this.live.map(x => ({ m: x.m, tag: x.tag, i: x.i })),
      dual: () => this.mode === 'dual',
      message: (kind, text, i) => {
        this.addMessage(kind, text, i);
        if (kind === 'error') { this.setTab('messages'); $('boot-error').textContent = text; }
      },
    });
    const screenPane = document.querySelector('.screen-pane') as HTMLElement;
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--screen-h', screenPane.offsetHeight + 'px');
    }).observe(screenPane);
    window.addEventListener('beforeunload', () => this.save());
  }

  private applyCpu(): void {
    const id = $<HTMLSelectElement>('cpu').value as CpuSpeedId;
    for (const s of this.sessions) s.m.setCpu(id);
  }

  private applySerialSettings(): void {
    const buffered = $<HTMLSelectElement>('uart-mode').value === 'buffered';
    const disk = $<HTMLInputElement>('disk-latency').checked;
    for (const s of this.sessions) { s.m.com1.bufferedTx = buffered; s.m.diskLatency = disk; }
    this.renderTab();
  }

  // ======================= 模式与标签页 =======================

  private setMode(mode: 'single' | 'dual', userAction: boolean): void {
    this.stop();
    this.mode = mode;
    const dual = mode === 'dual';
    if (dual) this.dual.link.connect(); else this.dual.link.disconnect();
    this.sessions[1].box.classList.toggle('hidden', !dual);
    for (const s of this.sessions) {
      s.box.querySelector('.screen-title')!.textContent = dual ? `${s.tag} 机屏幕` : 'DOS 屏幕';
      s.box.querySelector('.screen-hint')?.classList.toggle('hidden', dual);
      this.applyHistory(s);
    }
    if (!dual && this.active !== 0) this.setActive(0);
    else for (const s of this.sessions) s.box.classList.toggle('active', dual && s.i === this.active);
    this.renderTabs();
    if (userAction) {
      if (dual) this.addMessage('info', '双机模式：A 机和 B 机的 COM1 用串口线连接。在"串口"页可以设置接线方式并查看线路上的每个字节。双机模式下不能后退。');
      for (const s of this.live) if (s.dirty || !s.program) this.assemble(s, false);
      this.loadAll();
      if (dual) this.setTab('serial');
    }
  }

  private setActive(i: number): void {
    this.active = i;
    this.showDoc(this.cur);
    for (const s of this.sessions) s.box.classList.toggle('active', this.mode === 'dual' && s.i === i);
    this.renderTabs();
    const p = this.cur.program;
    if (p) this.memory.go(p.dataSeg, 0);
    this.render(true);
  }

  private renderTabs(): void {
    const el = $('ed-tabs');
    el.innerHTML = '';
    for (const s of this.live) {
      const b = document.createElement('button');
      b.className = s.i === this.active ? 'active' : '';
      b.innerHTML = (this.mode === 'dual' ? `<span class="tag">${s.tag} 机</span>` : '') + (s.binary ? esc(s.binary) + ' <span class="note">可执行文件</span>' : esc(s.fileName || '未命名')) + (!s.binary && s.dirty && s.program ? ' <span class="mod">●</span>' : '');
      b.title = s.dirty ? '已修改，运行时会自动重新汇编' : s.fileName;
      b.onclick = () => this.setActive(s.i);
      el.appendChild(b);
    }
    $('dirty-note').textContent = this.cur.dirty && this.cur.program ? '已修改，运行时会自动重新汇编' : '';
  }

  private setTab(t: string): void {
    this.tab = t;
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.classList.toggle('active', b.dataset.tab === t);
    for (const id of ['vars', 'memory', 'disasm', 'serial', 'messages', 'files']) $('tab-' + id).classList.toggle('hidden', id !== t);
    this.renderTab();
  }

  // ======================= 文件 =======================

  private save(): void {
    for (const s of this.sessions) {
      const key = s.i === 0 ? '' : '.b';
      store.set('source' + key, s.model.getValue());
      store.set('file' + key, s.fileName);
    }
  }

  private sourceModified(s: Session): boolean {
    return s.model.getAlternativeVersionId() !== s.sourceVersion;
  }

  private newFile(): void {
    const s = this.cur;
    if (this.sourceModified(s) && !confirm('当前代码已修改，确定放弃修改并新建空白源文件吗？')) return;
    this.stop();
    s.binary = null;
    this.editor.setText(s.model, '');
    s.sourceVersion = s.model.getAlternativeVersionId();
    s.fileName = '';
    s.program = null;
    s.dirty = true;
    s.snap = null;
    s.addrBps.clear();
    s.m.unload();
    s.screen.allKeys = false;
    this.editor.setProgram(s.model, null, [], false);
    this.showDoc(s);
    this.messages = this.messages.filter(m => m.who !== s.i);
    this.renderMessageCount();
    this.renderTabs();
    this.setStatus('已新建空白源文件', '');
    this.render(true);
    this.save();
  }

  private loadExample(id: string, confirmed = false): void {
    const ex = EXAMPLES.find(e => e.id === id);
    if (!ex) return;
    const targets = ex.pair ? this.sessions : [this.cur];
    const where = ex.pair ? 'A 机和 B 机' : this.mode === 'dual' ? `${this.cur.tag} 机` : '当前编辑器';
    const needsConfirm = targets.some(s => this.startupMode === 'debug' ? this.sourceModified(s) : s.model.getValue().trim());
    if (!confirmed && needsConfirm && !confirm(`用示例"${ex.title}"替换${where}中的代码？`)) return;
    if (ex.pair && this.startupMode !== 'dual') {
      void this.launch('dual', DEFAULT_CONFIG, this.cur.m.cpuModel).then(() => this.loadExample(id, true)).catch(e => this.addMessage('error', (e as Error).message));
      return;
    }
    this.stop();
    for (const s of targets) {
      s.binary = null;
      this.editor.setText(s.model, ex.source);
      s.sourceVersion = s.model.getAlternativeVersionId();
      s.fileName = ex.id + '.asm';
      s.dirty = true;
    }
    if (ex.pair && this.mode !== 'dual') this.setMode('dual', false);
    for (const s of this.live) if (s.dirty || !s.program) this.assemble(s, false);
    this.loadAll();
    this.renderTabs();
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
    const s = this.cur;
    if (this.startupMode === 'debug' && this.sourceModified(s) && !confirm(`当前代码已修改，确定用 "${f.name}" 替换吗？`)) return;
    s.binary = null;
    this.showDoc(s);
    this.editor.setText(s.model, text.replace(/\x1a+$/, ''));
    s.sourceVersion = s.model.getAlternativeVersionId();
    s.fileName = f.name;
    s.dirty = true;
    this.assemble(s, false);
    this.loadAll();
    this.renderTabs();
    this.save();
  }

  private saveFile(): void {
    const s = this.cur;
    const blob = new Blob([s.model.getValue().replace(/\r?\n/g, '\r\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const name = s.fileName || '未命名.asm';
    a.download = name.endsWith('.asm') ? name : name + '.asm';
    a.click();
    s.sourceVersion = s.model.getAlternativeVersionId();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private exportExecutable(): void {
    const s = this.cur;
    const fail = (text: string) => {
      this.addMessage('error', text, s.i);
      this.setStatus(text, 'error');
      this.setTab('messages');
    };
    if (s.binary) { fail('当前窗口是可执行文件说明，请先切回汇编源码再生成 EXE/COM'); return; }
    let program: Program;
    try { program = assemble(s.model.getValue()); }
    catch (e) {
      console.error(e);
      fail('汇编器内部错误：' + (e as Error).message);
      return;
    }
    this.messages = this.messages.filter(m => m.who !== s.i);
    for (const d of program.diagnostics) this.addDiag(d, s.i);
    this.renderMessageCount();
    if (this.tab === 'messages') this.renderMessages();
    this.editor.setDiagnostics(s.model, program.diagnostics);
    if (!program.ok) {
      const n = program.diagnostics.filter(d => d.severity === 'error').length;
      this.setStatus(`生成失败：源码有 ${n} 个汇编错误`, 'error');
      this.setTab('messages');
      return;
    }
    let bytes: Uint8Array;
    try { bytes = generateExecutable(program); }
    catch (e) { fail('生成失败：' + (e as Error).message); return; }
    const extension = program.format === 'com' ? 'com' : 'exe';
    const input = prompt(`已生成 ${extension.toUpperCase()}，请输入下载文件名：`, (s.fileName || '未命名.asm').replace(/\.asm$/i, '') + '.' + extension);
    if (input === null) { this.setStatus('已取消下载可执行文件', ''); return; }
    let name = input.trim();
    if (!name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.endsWith('.')) {
      fail('文件名不能为空，也不能包含路径、末尾句点或 \\ / : * ? " < > | 等字符');
      return;
    }
    if (/\.(exe|com)$/i.test(name) && !name.toLowerCase().endsWith('.' + extension)) {
      fail(`当前程序生成的是 ${extension.toUpperCase()}，请使用 .${extension} 扩展名`);
      return;
    }
    if (!name.toLowerCase().endsWith('.' + extension)) name += '.' + extension;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/octet-stream' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.addMessage('ok', `已生成并下载 ${name}（${bytes.length} 字节）`, s.i);
    this.setStatus(`已下载 ${name}`, '');
  }

  private async uploadToDisk(input: HTMLInputElement): Promise<void> {
    for (const f of Array.from(input.files ?? [])) {
      this.cur.m.files.set(f.name.toUpperCase(), new Uint8Array(await f.arrayBuffer()));
      this.cur.m.fileTimes.set(f.name.toUpperCase(), f.lastModified);
    }
    input.value = '';
    this.renderFiles();
  }

  /**
   * 从光驱启动：读出光盘的 El Torito 启动信息。软盘模拟时光盘里的启动软盘这次就是 A:，原来的 A: 变成 B:；
   * 不模拟时把引导程序装入内存，光驱是 E0h 号盘（引导程序用 INT 13h 扩展功能读光盘）
   */
  private async runCdBoot(s: Session): Promise<boolean> {
    const src = s.m.cdrom.source;
    const fail = (msg: string) => { this.addMessage('error', msg, s.i); $('boot-error').textContent = msg; };
    if (!src) { fail('光驱里没有光盘'); return false; }
    let r;
    try { r = await readElTorito(src); } catch (e) { fail('读光盘出错：' + (e as Error).message); return false; }
    if (typeof r === 'string') { fail(r); return false; }
    if (r.kind === 'floppy') { s.m.cdBoot = new Disk(`${s.m.cdrom.discName} 的启动软盘`, r.image, true); s.m.cdBootNoEmu = null; }
    else { s.m.cdBoot = null; s.m.cdBootNoEmu = { image: r.image, loadSeg: r.loadSeg, rba: r.rba, count: r.count }; }
    return this.runBoot(s, CD_BOOT);
  }

  /** 从磁盘映像启动（像开机一样：读引导扇区，运行真的 DOS 等系统） */
  private runBoot(s: Session, drive: number): boolean {
    const noemu = drive === CD_BOOT ? s.m.cdBootNoEmu : null;
    const d = noemu ? null : drive === CD_BOOT ? s.m.cdBoot : s.m.driveFor(drive, null);
    const name = d?.name ?? s.m.cdrom.discName ?? '光盘';
    this.stop();
    const program = bootProgram(drive);
    try { s.m.load(program); }
    catch (e) {
      const message = (e as Error).message;
      this.addMessage('error', message, s.i);
      $('boot-error').textContent = message;
      return false;
    }
    s.binary = `[${driveName(drive)} 启动]`;
    s.program = program;
    s.record = false;
    this.applyHistory(s);
    s.dirty = false;
    s.snap = null;
    s.screen.allKeys = true;
    this.syncBreakpoints(s);
    this.memory.go(program.dataSeg, 0);
    this.renderTabs();
    this.addMessage('ok', noemu ? `从光驱启动（${name}，不模拟方式：引导程序 ${noemu.count * 512} 字节装在 ${(noemu.loadSeg || 0x7c0).toString(16).toUpperCase()}0h，光驱是 E0h 号盘）`
      : drive === CD_BOOT ? `从光驱启动（${name}，当作 A:${s.m.drives[0] ? '；原来的 A: 这次是 B:' : ''}）` : `从 ${driveName(drive)} 启动（${name}）`, s.i);
    this.render(true);
    this.start();
    s.screen.focus();
    requestAnimationFrame(() => s.screen.focus()); // 点按钮之后焦点可能又回到按钮上，再设一次
    return true;
  }

  /** 直接装载并运行虚拟磁盘上的 EXE/COM 文件（没有源码） */
  private runBinary(s: Session, name: string): void {
    const data = s.m.files.get(name);
    if (!data) return;
    let loaded;
    try {
      loaded = loadExecutable(data, name);
    } catch (e) {
      this.addMessage('error', (e as Error).message, s.i);
      this.setTab('messages');
      return;
    }
    const { program, info } = loaded;
    this.stop();
    const h4x = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
    const text = [
      `; ${name}：直接运行的 DOS 可执行文件（没有源码）`,
      ';',
      `; 格式：${info.format.toUpperCase()}，程序映像 ${info.imageSize} 字节` +
        (info.format === 'exe' ? `，重定位 ${info.relocations} 项，另需内存 ${info.minAlloc * 16} 字节` : ''),
      info.packer ? `; 用 ${info.packer} 压缩过：运行时先由开头的解压代码在内存里展开，再跳到真正的程序` : ';',
      `; 入口 CS:IP = ${h4x(program.entry.cs)}:${h4x(program.entry.ip)}，堆栈 SS:SP = ${h4x(program.stack.ss)}:${h4x(program.stack.sp)}`,
      ';',
      '; 可以运行、暂停、单步，在右边查看寄存器、栈和内存。',
      '; 没有源码，所以编辑器里不显示当前行（反汇编视图在开发计划里）。',
      '; 显示中文的程序（为 UCDOS 等中文 DOS 编写）：勾选屏幕右上角的"中文"。',
      ';',
      '; 回到源程序：点"汇编"，或者从"示例程序"、"打开"载入源程序。',
    ].join('\n');
    if (!s.binModel) s.binModel = this.editor.createModel('');
    this.editor.setText(s.binModel, text);
    s.binary = name;
    s.program = program;
    s.record = true;
    this.applyHistory(s);
    s.dirty = false;
    if (this.active !== s.i) this.setActive(s.i); else this.showDoc(s);
    this.renderTabs();
    this.addMessage('ok', `装载 ${name}：${info.format.toUpperCase()}，${info.imageSize} 字节${info.packer ? `，${info.packer} 压缩` : ''}`, s.i);
    this.loadAll();
    this.setTab('disasm');
    this.start();
    s.screen.focus();
  }

  /** 运行到某个地址（临时断点） */
  private runTo(s: Session, lin: number): void {
    if (this.run !== 'idle') this.pause();
    if (!this.ensureReady()) return;
    if (s.m.status === 'exited') { this.setStatus('程序已结束。点"重启"可以重新开始', 'error'); return; }
    if (s.m.linearIP === lin) { this.setStatus('已经在这个位置了', ''); return; }
    this.tempBp = { i: s.i, lin };
    this.start();
  }

  /** 运行到编辑器光标所在的行（这一行没有代码时，用后面最近的有代码的行） */
  private runToCursor(): void {
    const s = this.cur;
    if (s.binary) { this.setStatus('可执行文件没有源码：请在"反汇编"页里双击要运行到的那一行', ''); this.setTab('disasm'); return; }
    if (!this.ensureReady() || !s.program) return;
    const pos = this.editor.editor.getPosition();
    if (!pos) return;
    for (let l = pos.lineNumber; l < pos.lineNumber + 30; l++) {
      const addrs = s.program.lineToAddrs.get(l);
      if (addrs) { this.runTo(s, addrs[0]); return; }
    }
    this.setStatus('光标所在的行（以及后面几行）没有生成代码', '');
  }

  /** 在寄存器面板上直接修改寄存器 */
  private editRegister(el: HTMLElement): void {
    const s = this.cur, m = s.m, cpu = m.cpu;
    if (this.run !== 'idle' || !s.program || m.status === 'empty') return;
    const key = el.dataset.reg ?? "";
    const get = () => key === 'ip' ? cpu.ip : key === 'flags' ? cpu.flags : key[0] === 'r' ? cpu.r[+key.slice(1)] : cpu.s[+key.slice(1)];
    const set = (v: number) => {
      if (key === 'ip') cpu.ip = v;
      else if (key === 'flags') cpu.setFlags(v);
      else if (key[0] === 'r') cpu.r[+key.slice(1)] = v;
      else cpu.s[+key.slice(1)] = v;
    };
    if (el.querySelector('.reg-edit')) return;
    const input = document.createElement('input');
    input.className = 'reg-edit';
    input.value = h4(get());
    input.title = '十六进制；以 d 结尾表示十进制，例如 100d';
    el.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      const raw = input.value.trim();
      const t = raw.toLowerCase();
      input.remove();
      if (!apply) return;
      const v = /^\d+d$/.test(t) ? parseInt(t, 10) : /^[0-9a-f]{1,4}h?$/.test(t) ? parseInt(t.replace(/h$/, ''), 16) : NaN;
      if (Number.isNaN(v) || v > 0xffff) { this.setStatus(`"${raw}" 不是有效的 16 位数值`, 'error'); return; }
      if (v === get()) return;
      s.snap = takeSnapshot(m);
      m.poke(() => set(v));
      this.setStatus(`已修改 ${regName(key)}，"后退"可以撤销`, '');
      this.render(true);
    };
    input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
    input.onclick = e => e.stopPropagation();
  }

  /** 点标志位：切换它的值 */
  private toggleFlag(mask: number): void {
    const s = this.cur, m = s.m;
    if (this.run !== 'idle' || !s.program || m.status === 'empty') return;
    s.snap = takeSnapshot(m);
    m.poke(() => m.cpu.setFlags(m.cpu.flags ^ mask));
    this.render(true);
  }

  private fileAction(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b) return;
    const m = this.sessions[+b.dataset.who!].m;
    const name = b.dataset.name!;
    if (b.dataset.act === 'run') { this.runBinary(this.sessions[+b.dataset.who!], name); return; }
    if (b.dataset.act === 'del') m.files.delete(name);
    else {
      const data = m.files.get(name);
      if (!data) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data.slice()]));
      a.download = name;
      a.click();
    }
    this.renderFiles();
  }

  private renderFiles(): void {
    $('file-target').textContent = this.mode === 'dual' ? `（上传到 ${this.cur.tag} 机）` : '';
    const parts: string[] = [];
    for (const s of this.live) {
      if (this.mode === 'dual') parts.push(`<div class="pane-head sub">${s.tag} 机的磁盘</div>`);
      if (!s.m.files.size) {
        parts.push('<div class="empty">磁盘是空的。程序用 INT 21h 创建的文件会出现在这里，也可以上传文件给程序读取。</div>');
        continue;
      }
      for (const [n, d] of [...s.m.files.entries()].sort()) {
        parts.push(`<div class="file-row"><span class="fn">C:\\${esc(n)}</span><span class="note">${d.length} 字节</span>` +
          (/.(exe|com)$/i.test(n) ? `<button data-act="run" data-who="${s.i}" data-name="${esc(n)}" title="装载并运行这个可执行文件">运行</button>` : '') +
          `<button data-act="get" data-who="${s.i}" data-name="${esc(n)}">下载</button><button data-act="del" data-who="${s.i}" data-name="${esc(n)}">删除</button></div>`);
      }
    }
    $('files').innerHTML = parts.join('');
  }

  // ======================= 汇编与装载 =======================

  private markDirty(s: Session): void {
    if (!s.dirty) {
      s.dirty = true;
      this.editor.showBytes(s.model, null, false);
      this.renderTabs();
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 500);
  }

  /** 汇编一个会话的源程序（不装载） */
  private assemble(s: Session, showMessages: boolean): boolean {
    if (s.binary) { s.binary = null; if (s === this.cur) this.showDoc(s); }
    let p: Program;
    try {
      p = assemble(s.model.getValue());
    } catch (e) {
      this.addMessage('error', '汇编器内部错误：' + (e as Error).message, s.i);
      console.error(e);
      return false;
    }
    this.messages = this.messages.filter(m => m.who !== s.i);
    for (const d of p.diagnostics) this.addDiag(d, s.i);
    this.editor.setProgram(s.model, p.ok ? p : null, p.diagnostics, $<HTMLInputElement>('show-bytes').checked);
    s.dirty = false;
    this.renderTabs();
    const who = this.mode === 'dual' ? `${s.tag} 机：` : '';
    if (!p.ok) {
      s.program = null;
      s.m.unload();
      s.snap = null;
      const n = p.diagnostics.filter(d => d.severity === 'error').length;
      this.setStatus(`${who}汇编失败，${n} 个错误`, 'error');
      if (this.active !== s.i) this.setActive(s.i);
      this.setTab('messages');
      return false;
    }
    s.program = p;
    s.record = true;
    this.applyHistory(s);
    const warns = p.diagnostics.filter(d => d.severity === 'warning').length;
    const size = p.chunks.reduce((n, c) => n + c.bytes.length, 0);
    this.addMessage('ok', `${who}汇编成功：${p.format.toUpperCase()} 程序，${size} 字节${warns ? `，${warns} 个警告` : ''}`, s.i);
    // 用了 80186/80286 的指令（.186 / .286）：8088 上这些操作码是别的指令，程序会跑飞
    if (p.cpu && s.m.cpuModel === '8088') {
      this.addMessage('warning', `${who}程序用了 ${p.cpu === 1 ? '80186' : '80286'} 的指令（例如 PUSHA、INSW、SHR AL, 4），8088 上没有这些指令。请把工具栏的 CPU 选成 286 或更高再运行。`, s.i);
      if (showMessages) this.setTab('messages');
    }
    if (showMessages && warns) this.setTab('messages');
    return true;
  }

  private assembleAll(showMessages: boolean): boolean {
    if (this.startupMode === 'full') return false;
    let ok = true;
    for (const s of this.live) ok = this.assemble(s, showMessages) && ok;
    if (ok) this.loadAll();
    else this.render(true);
    return ok;
  }

  /** 装载所有会话的程序（双机时两台机器一起从头开始） */
  private loadAll(): void {
    for (const s of this.live) {
      s.screen.allKeys = s.program?.format === 'boot';
      if (!s.program) continue;
      s.m.load(s.program, s.cmdline.value, s.binary ?? 'PROGRAM.EXE');
      s.snap = null;
      this.syncBreakpoints(s);
    }
    if (this.mode === 'dual') this.dual.syncClocks();
    const p = this.cur.program;
    if (p) this.memory.go(p.dataSeg, 0);
    if (this.live.every(s => s.program)) {
      this.setStatus(this.mode === 'dual' ? '两台机器都已装载，可以运行或单步执行' : '已装载，可以运行或单步执行', '');
    }
    this.render(true);
  }

  private ensureReady(): boolean {
    if (this.startupMode === 'full') return !!this.cur.program;
    if (this.live.some(s => !s.binary && (s.dirty || !s.program))) return this.assembleAll(true);
    return true;
  }

  private syncBreakpoints(s: Session): void {
    s.m.breakpoints.clear();
    for (const a of s.addrBps) s.m.breakpoints.add(a);
    if (this.tempBp && this.tempBp.i === s.i) s.m.breakpoints.add(this.tempBp.lin);
    if (!s.program || s.dirty) return;
    for (const l of this.editor.breakpointLines(s.model)) {
      const addrs = s.program.lineToAddrs.get(l);
      if (addrs) s.m.breakpoints.add(addrs[0]);
    }
  }

  // ======================= 执行控制 =======================

  /** 0 全速，-1 原机速度，其他为每秒步数 */
  private speed(): number { return +$<HTMLSelectElement>('speed').value; }
  /** 按原机速度运行时：开始时的真实时间和虚拟时间 */
  private rtWall = 0;
  /** 本次全速运行中程序用到了喇叭（结束时提示改用原机速度） */
  private fastSpeakerHint = false;
  private rtClock = 0;
  private get liveClock(): number { return Math.max(...this.live.map(s => s.m.clock)); }
  private get finished(): boolean { return this.live.every(s => s.m.status === 'exited' || s.m.status === 'error' || s.m.status === 'empty'); }

  start(): void {
    if (!this.startupMode || this.loading) return;
    if (this.startupMode === 'full' && !this.cur.program) { void this.chooseBoot(); return; }
    if (this.run !== 'idle') return;
    if (!this.ensureReady()) return;
    const done = this.mode === 'single' ? this.cur.m.status === 'exited' || this.cur.m.status === 'error' : this.finished;
    if (done) this.loadAll();
    for (const s of this.live) { this.syncBreakpoints(s); s.snap = takeSnapshot(s.m); }
    const sp = this.speed();
    for (const s of this.live) s.speaker.enable();
    this.fastSpeakerHint = false;
    if (sp <= 0) {
      this.run = 'run';
      for (const x of this.live) this.editor.setCurrentLine(x.model, null, false); // 全速运行时不显示当前行
      this.rtWall = performance.now();
      this.rtClock = this.liveClock;
      this.setStatus(this.runText(), 'running');
      this.tick();
    } else {
      this.run = 'animate';
      this.setStatus(`运行中（每秒 ${sp} 步）…`, 'running');
      this.animTimer = window.setInterval(() => this.animStep(), 1000 / sp);
    }
    this.updateButtons();
  }

  private runText(): string {
    if (this.speed() !== -1) return '运行中…';
    const cpu = CPU_SPEEDS.find(c => c.id === this.cur.m.cpuModel)!;
    return `运行中（原机速度：${cpu.name}）…`;
  }

  private tick = (): void => {
    if (this.run !== 'run') return;
    const t0 = performance.now();
    let r: StopReason, who = this.active;
    // 按原机速度运行：让虚拟时间跟上真实时间（PIT 时钟 1.193182 MHz）；落后太多（主机太慢、页面在后台）就不再追赶
    const realtime = this.speed() === -1;
    let until = Infinity;
    if (realtime) {
      until = this.rtClock + (t0 - this.rtWall) * 1193.182;
      if (until - this.liveClock > 1193.182 * 250) { this.rtClock = this.liveClock; this.rtWall = t0; until = this.rtClock; }
    }
    if (this.mode === 'dual') {
      let d;
      do { d = this.dual.run(20_000, until); } while (d.reason === 'budget' && performance.now() - t0 < 14 && this.liveClock < until);
      r = d.reason;
      if (d.who >= 0) who = d.who;
    } else {
      const m = this.cur.m;
      do {
        r = m.run(20_000, until);
        if (r === 'wait' && realtime) { m.idleTo(until); r = 'budget'; break; } // 等键盘时时间照常流逝
      } while (r === 'budget' && performance.now() - t0 < 14 && m.clock < until);
    }
    if (realtime && r === 'budget') {
      const waiting = this.live.find(s => s.m.status === 'waiting');
      if (waiting) this.setStatus(this.waitText(waiting), 'waiting');
      else if ($('status').classList.contains('waiting')) this.setStatus(this.runText(), 'running');
    }
    if (r === 'budget') {
      if (performance.now() - this.lastRender > 60) { this.render(false); this.lastRender = performance.now(); }
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    if (r === 'wait') {
      this.render(false);
      const s = this.sessions[who];
      this.setStatus(this.waitText(s), 'waiting');
      s.screen.focus();
      return; // 保持运行模式，按键后继续
    }
    this.run = 'idle';
    this.stopped(r, who);
  };

  private waitText(s: Session): string {
    return this.mode === 'dual'
      ? `${s.tag} 机正在等待键盘输入：点击它的屏幕后打字`
      : '程序正在等待键盘输入：点击下面的 DOS 屏幕后打字';
  }

  private animStep(): void {
    const s = this.cur;
    if (s.m.status === 'waiting') return;
    for (const x of this.live) x.snap = takeSnapshot(x.m);
    const r = this.mode === 'dual' ? this.dual.step(this.active, 'into').reason : s.m.stepInto();
    if (r === 'step' && s.m.breakpoints.has(s.m.linearIP)) {
      this.stop();
      s.m.message = '到达断点';
      this.stopped('breakpoint', s.i);
      return;
    }
    if (r === 'wait') {
      this.render(true);
      this.setStatus(this.waitText(s), 'waiting');
      s.screen.focus();
      return;
    }
    if (r !== 'step') {
      if (this.mode === 'dual' && r === 'exit') {
        // 当前机器结束了，另一台还在运行：切换过去继续单步
        const other = this.sessions[1 - this.active];
        if (other.m.status !== 'exited' && other.m.status !== 'error') {
          this.addMessage('info', `${s.tag} 机：${s.m.message}`, s.i);
          this.setActive(other.i);
          return;
        }
      }
      this.stop();
      this.stopped(r, s.i);
      return;
    }
    this.render(true);
  }

  step(over: boolean | 'out'): void {
    if (this.run !== 'idle') this.pause();
    if (!this.ensureReady()) return;
    const s = this.cur;
    const tag = this.mode === 'dual' ? `${s.tag} 机的` : '';
    if (s.m.status === 'exited') { this.setStatus(`${tag}程序已结束。点"重启"可以重新开始`, 'error'); return; }
    if (s.m.status === 'waiting') { this.setStatus(this.waitText(s), 'waiting'); s.screen.focus(); return; }
    for (const x of this.live) { this.syncBreakpoints(x); x.snap = takeSnapshot(x.m); }
    if (this.mode === 'dual') {
      const d = this.dual.step(this.active, over === 'out' ? 'out' : over ? 'over' : 'into');
      this.stopped(d.reason, d.who);
    } else {
      this.stopped(over === 'out' ? s.m.stepOut() : over ? s.m.stepOver() : s.m.stepInto(), s.i);
    }
  }

  back(): void {
    this.disasm.follow();
    if (this.mode === 'dual') { this.setStatus('双机模式下不能后退（已经从串口线上发出去的数据无法撤回）', ''); return; }
    if (this.run !== 'idle') this.pause();
    const s = this.cur;
    if (!s.program || s.dirty) return;
    s.snap = takeSnapshot(s.m);
    if (!s.m.stepBack()) { this.setStatus('已经在程序开头了', ''); return; }
    this.setStatus(s.m.message || '已后退一步', '');
    this.render(true);
  }

  pause(): void {
    if (this.run === 'idle' && !this.live.some(s => s.m.status === 'waiting')) return;
    this.stop();
    for (const s of this.live) s.m.pause();
    this.setStatus('已暂停', '');
    this.render(true);
  }

  private stop(): void {
    this.run = 'idle';
    if (this.tempBp) { const i = this.tempBp.i; this.tempBp = null; this.syncBreakpoints(this.sessions[i]); }
    for (const s of this.sessions) s.speaker.mute();
    clearInterval(this.animTimer);
    cancelAnimationFrame(this.raf);
    this.updateButtons();
  }

  /** 关机：停止运行，屏幕变黑，磁盘映像马上存进浏览器 */
  private powerOff(): void {
    const on = this.live.filter(s => s.program && !s.m.poweredOff && s.m.status !== 'empty');
    if (!on.length) { this.setStatus('虚拟机没有在运行', ''); return; }
    if (on.some(s => s.program!.format === 'boot' && s.m.status !== 'exited') &&
        !confirm('DOS 可能还有没写进磁盘的数据（DOS 的缓冲区、SMARTDRV 的写缓存），直接关机可能丢失或损坏文件，和真机拔电源一样。\n\n更安全的做法：在 DOS 里运行 SHUTDOWN（磁盘映像的"文件"浏览器里可以放入 SHUTDOWN.COM），它会先写回缓冲区再关机。\n\n仍然直接关机吗？')) return;
    this.stop();
    for (const s of on) s.m.powerOff();
    for (const s of on) void this.drives?.flushAll(s.i).catch(e => this.addMessage('error', `保存映像失败：${(e as Error).message}`, s.i));
    this.setStatus('已关机。点“重启”可以重新开机', '');
    this.addMessage('info', '已关机', this.active);
    this.render(true);
  }

  restart(): void {
    if (!this.startupMode || this.loading) return;
    if (this.startupMode === 'full') { void this.chooseBoot(); return; }
    this.stop();
    if (this.live.some(s => !s.binary && (s.dirty || !s.program))) { this.assembleAll(true); return; }
    this.loadAll();
    // 从磁盘启动的系统：重启就是重新开机，直接运行起来
    if (this.live.every(s => s.program?.format === 'boot')) { this.start(); this.cur.screen.focus(); }
  }

  private stopped(r: StopReason, who: number): void {
    this.disasm.follow();
    if (this.tempBp) {
      const t = this.tempBp;
      this.tempBp = null;
      this.syncBreakpoints(this.sessions[t.i]);
      if (r === 'breakpoint' && this.sessions[t.i].m.linearIP === t.lin) this.sessions[t.i].m.message = '已运行到指定位置';
    }
    for (const x of this.sessions) x.speaker.mute();
    this.updateButtons();
    const s = this.sessions[who >= 0 ? who : this.active];
    const tag = this.mode === 'dual' ? `${s.tag} 机：` : '';
    if (this.mode === 'dual' && s.i !== this.active && (r === 'breakpoint' || r === 'error')) this.setActive(s.i);
    const m = s.m;
    switch (r) {
      case 'exit': {
        if (m.poweredOff) {
          void this.drives?.flushAll(s.i).catch(e => this.addMessage('error', `保存映像失败：${(e as Error).message}`, s.i));
          this.setStatus(tag + m.message + '。点“重启”可以重新开机', '');
          this.addMessage('info', m.message, s.i);
          break;
        }
        if (this.mode === 'dual') {
          this.setStatus(this.sessions.map(x => `${x.tag} 机：${x.m.status === 'exited' ? x.m.message : statusName(x.m.status)}`).join('；'), '');
          for (const x of this.sessions) if (x.m.status === 'exited') this.addMessage('info', `${x.m.message}（共执行 ${x.m.instructions.toLocaleString()} 条指令）`, x.i);
        } else {
          const bad = m.message.includes('溢出');
          this.setStatus(m.message, bad ? 'error' : '');
          this.addMessage(bad ? 'error' : 'info', `${m.message}（共执行 ${m.instructions.toLocaleString()} 条指令）`, s.i);
        }
        break;
      }
      case 'breakpoint': this.setStatus(tag + (m.message || '到达断点'), ''); break;
      case 'wait': this.setStatus(this.waitText(s), 'waiting'); s.screen.focus(); break;
      case 'error': this.setStatus(tag + m.message, 'error'); this.addMessage('error', m.message, s.i); break;
      default: this.setStatus(tag + (m.message || '已暂停'), '');
    }
    if (this.fastSpeakerHint && r === 'exit') {
      $('status').textContent += '。程序用到了 PC 喇叭，请把速度选成"原机速度"再运行';
      $('status').title = $('status').textContent ?? '';
    }
    this.render(true);
  }

  private key(s: Session, e: KeyEvent): void {
    if (!s.program || s.dirty) return;
    s.m.pressKey(e);
    this.afterKey(s);
  }

  private afterKey(s: Session): void {
    if (s.m.status !== 'waiting') return;
    if (this.run === 'run') {
      this.setStatus(this.runText(), 'running');
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const r = s.m.continuePending(this.run === 'animate' ? 2_000_000 : 50_000_000);
    if (r === 'wait') { this.render(true); return; }
    if (this.mode === 'dual') this.dual.catchUp(this.sessions[1 - s.i].m, s.m.clock);
    if (this.run === 'animate') {
      this.setStatus(`运行中（每秒 ${this.speed()} 步）…`, 'running');
      if (r !== 'step') { this.stop(); this.stopped(r, s.i); return; }
      this.render(true);
    } else this.stopped(r, s.i);
  }

  // ======================= 渲染 =======================

  private setStatus(text: string, cls: string): void {
    const s = $('status');
    s.textContent = text;
    s.title = text;
    s.className = 'status ' + cls;
  }

  /** 按会话的设置和单机/双机模式打开或关闭历史记录 */
  private applyHistory(s: Session): void { s.m.setHistory(s.record && this.mode !== 'dual'); }

  private updateButtons(): void {
    if (!this.startupMode || !this.sessions.length) return;
    const running = this.run !== 'idle';
    const rec = $<HTMLInputElement>('record-history');
    rec.checked = this.cur.record && this.mode !== 'dual';
    rec.disabled = this.mode === 'dual';
    $<HTMLButtonElement>('btn-run').disabled = running;
    $<HTMLButtonElement>('btn-pause').disabled = !running && !this.live.some(s => s.m.status === 'waiting');
    $<HTMLButtonElement>('btn-back').disabled = running || this.mode === 'dual' || !this.cur.m.canStepBack;
  }

  render(full: boolean): void {
    if (!this.startupMode || !this.sessions.length) return;
    const s = this.cur, m = s.m;
    const line = s.program && !s.dirty ? s.program.addrToLine.get(m.linearIP) ?? null : null;
    const info = line ? `第 ${line} 行` : s.program && m.status !== 'empty' ? `${m.inBios() ? 'BIOS/DOS：' : ''}${currentInstruction(m).text}` : '';
    $('cpu-title').textContent = this.mode === 'dual' ? `${s.tag} 机寄存器` : '寄存器';
    this.regs.render(m.cpu, s.snap, info);
    this.stack.setProgram(s.program);
    this.stack.render(m, s.snap);
    for (const x of this.live) {
      x.box.classList.toggle('no-video', !x.m.config.vga);
      const mem = x.m.mem, bda = 0x400;
      x.screen.relative = x.m.serialMouse.active;
      if (x.m.config.vga) x.screen.render(mem, mem[bda + 0x51], mem[bda + 0x50], mem[bda + 0x60] | (mem[bda + 0x61] << 8), x.m.video, x.m.mouseDriverEnabled ? x.m.mouse : undefined);
    }
    if (full || this.run === 'animate') {
      for (const x of this.live) {
        const l = x.program && !x.dirty ? x.program.addrToLine.get(x.m.linearIP) ?? null : null;
        this.editor.setCurrentLine(x.model, this.run === 'run' ? null : l, x === s);
      }
      this.renderTab();
    } else if (this.tab === 'serial') this.renderTab();
    this.updateButtons();
  }

  private renderTab(): void {
    if (!this.startupMode || !this.sessions.length) return;
    const s = this.cur;
    switch (this.tab) {
      case 'vars': this.vars.render(s.m, s.snap); break;
      case 'memory': this.memory.render(s.m, s.snap); break;
      case 'disasm': this.disasm.render(s.m, s.m.breakpoints); break;
      case 'serial': this.renderSerial(); break;
      case 'messages': this.renderMessages(); break;
      case 'files': this.renderFiles(); this.drives?.render(); break;
    }
  }

  // ======================= 串口面板 =======================

  private renderSerial(): void {
    const el = $('serial');
    if (this.mode !== 'dual') {
      el.innerHTML = '<div class="serial-hint">串口线只在"双机"模式下连接（工具栏里切换）。单机模式下，程序仍然可以操作 COM1（3F8h）和 COM2（2F8h），8250 的回环模式（MCR 的 LOOP 位）也可以用。</div>';
      return;
    }
    const uarts = this.sessions.map(x => x.m.com1);
    const ms = (t: number) => (t / 1193.182).toFixed(3);
    const led = (on: boolean, name: string, tip: string) => `<span class="led ${on ? 'on' : ''}" title="${tip}">${name}</span>`;
    const card = (u: UART, tag: string) => {
      const mcr = u.mcr, msr = u.msr(), lsr = u.lsr, st = u.stats;
      const ier = ['收到数据', '发送空', '线路状态', 'MODEM 状态'].filter((_, k) => u.ier & (1 << k));
      return `<div class="uart"><h4>${tag} 机 COM1</h4>` +
        `<div class="fmt">${u.describeFormat()}</div>` +
        `<div class="leds">输出 ${led(!!(mcr & MCR_DTR), 'DTR', '数据终端就绪')}${led(!!(mcr & MCR_RTS), 'RTS', '请求发送')}${led(!!(mcr & MCR_OUT2), 'OUT2', 'PC 上接通 8250 到 8259 的中断线')}</div>` +
        `<div class="leds">输入 ${led(!!(msr & MSR_CTS), 'CTS', '清除发送')}${led(!!(msr & MSR_DSR), 'DSR', '数据设备就绪')}${led(!!(msr & MSR_DCD), 'DCD', '载波检测')}</div>` +
        `<div class="leds">状态 ${led(!!(lsr & LSR_DR), 'DR', '接收缓冲有数据')}${led(!!(lsr & LSR_THRE), 'THRE', '发送保持寄存器空')}${led(u.busy, '发送中', '正在通过线路发送')}</div>` +
        `<div class="stats">中断：${ier.length ? ier.join('、') : '关闭'}${u.ier && !(mcr & MCR_OUT2) ? '（OUT2=0，接不到 8259）' : ''}</div>` +
        `<div class="stats">已发送 <b>${st.txBytes}</b> 字节，已接收 <b>${st.rxBytes}</b> 字节` +
        (st.overruns ? `，<span class="bad">接收溢出 ${st.overruns} 次</span>` : '') +
        (st.thrOverwrites ? `，<span class="bad">THR 被覆盖 ${st.thrOverwrites} 次</span>` : '') +
        (st.framingErrors ? `，<span class="bad">帧错误 ${st.framingErrors} 次</span>` : '') + '</div></div>';
    };
    const events = uarts.flatMap((u, i) => u.events.filter(e => e.kind !== 'rx' && e.kind !== 'irq').slice(-150).map(e => ({ ...e, who: i })));
    events.sort((a, b) => a.time - b.time);
    const rows = events.slice(-150).reverse().map(e => {
      const from = this.sessions[e.who].tag, to = this.sessions[1 - e.who].tag;
      if (e.kind === 'tx') {
        const v = e.value;
        const c = v >= 32 && v < 127 ? ` '${String.fromCharCode(v)}'` : v === 13 ? ' 回车' : v === 10 ? ' 换行' : '';
        return `<div class="ev"><span class="t">${ms(e.time)} ms</span><span>${from} → ${to}</span><span>${esc(h2(v) + 'h' + c)}</span></div>`;
      }
      const cls = e.kind === 'modem' ? 'modem' : 'bad';
      return `<div class="ev ${cls}"><span class="t">${ms(e.time)} ms</span><span>${from} 机</span><span>${esc(e.text ?? e.kind)}</span></div>`;
    });
    el.innerHTML = `<div class="uarts">${card(uarts[0], 'A')}${card(uarts[1], 'B')}</div>` +
      `<div class="serial-hint">线路上的事件（最新的在上面；时间是虚拟时间）</div>` +
      `<div class="serial-log">${rows.join('') || '<div class="t">还没有数据</div>'}</div>`;
  }

  // ======================= 消息 =======================

  private addDiag(d: Diag, who: number): void {
    this.messages.push({ level: d.severity, text: d.message, line: d.line > 0 ? d.line : undefined, who });
    this.renderMessageCount();
    if (this.tab === 'messages') this.renderMessages();
  }

  addMessage(level: Level, text: string, who?: number): void {
    this.messages.push({ level, text, who });
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
    el.innerHTML = this.messages.map(m => {
      const tag = this.mode === 'dual' && m.who !== undefined ? `${this.sessions[m.who].tag} 机 ` : '';
      const link = m.line ? `<a data-line="${m.line}" data-who="${m.who ?? this.active}">${tag}第 ${m.line} 行</a>` : (tag ? `<span>${tag}</span>` : '');
      return `<div class="msg ${m.level}"><span class="lvl">${label[m.level]}</span>${link}<span>${esc(m.text)}</span></div>`;
    }).join('');
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

  hover(s: Session, word: string, _line: number, lineText: string): string[] | null {
    const w = word.toLowerCase();
    const m = s.m, cpu = m.cpu;
    const loaded = !!s.program && !s.dirty && m.status !== 'empty';
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
    const sym = s.program?.symbols.find(x => x.name.toLowerCase() === w);
    if (sym && !s.dirty) {
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
      const mm = lineText.match(/\bint\s+([0-9][0-9a-f]*)(h?)\b/i);
      const n = mm ? parseInt(mm[1], mm[2] || /[a-f]/i.test(mm[1]) ? 16 : 10) : -1;
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

/** data-reg 标识 -> 寄存器名 */
function regName(key: string): string {
  if (key === 'ip') return 'IP';
  if (key === 'flags') return 'FLAGS';
  return (key[0] === 'r' ? ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'] : ['ES', 'CS', 'SS', 'DS'])[+key.slice(1)] ?? key;
}

function statusName(st: string): string {
  return ({ empty: '未装载', ready: '就绪', paused: '已暂停', running: '运行中', waiting: '等待键盘', exited: '已结束', error: '出错' } as Record<string, string>)[st] ?? st;
}

const app = new App();
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;

const brand = document.querySelector('.brand') as HTMLElement;
brand.title = `AsmPerfect 86 版本 ${import.meta.env.VITE_APP_VERSION ?? '开发版'}`;
$('version').textContent = import.meta.env.VITE_APP_VERSION ? 'v' + import.meta.env.VITE_APP_VERSION : '开发版';
