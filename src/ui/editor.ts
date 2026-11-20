// Monaco 编辑器：8086 汇编语法高亮、断点、当前行、错误标记、机器码显示、悬停提示
// 只引入编辑器核心与内置功能（查找、悬停等），不引入其他语言
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { Diag, Program } from '../asm/types.ts';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const REGISTERS = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'sp', 'bp', 'al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh', 'cs', 'ds', 'es', 'ss'];
const INSTRUCTIONS = `aaa aad aam aas adc add and call cbw clc cld cli cmc cmp cmpsb cmpsw cmps cwd daa das dec div hlt idiv imul in inc int into iret
ja jae jb jbe jc jcxz je jg jge jl jle jmp jna jnae jnb jnbe jnc jne jng jnge jnl jnle jno jnp jns jnz jo jp jpe jpo js jz
lahf lds lea les lock lodsb lodsw lods loop loope loopne loopnz loopz mov movsb movsw movs mul neg nop not or out pop popf push pushf
rcl rcr rep repe repne repnz repz ret retf retn rol ror sahf sal sar sbb scasb scasw scas shl shr stc std sti stosb stosw stos sub test
wait xchg xlat xlatb xor`.split(/\s+/);
const DIRECTIVES = `.model .code .data .data? .const .stack .startup .exit .8086 .186 .286 .386 segment ends assume proc endp db dw dd dq dt
byte word dword qword tbyte sbyte sword equ textequ label org even align end macro endm local exitm rept irp irpc for forc
if ife ifdef ifndef ifb ifnb else elseif endif group public extrn include title page name comment`.split(/\s+/);
const OPERATORS = ['offset', 'seg', 'ptr', 'near', 'far', 'short', 'dup', 'type', 'length', 'size', 'lengthof', 'sizeof', 'high', 'low',
  'mod', 'shl', 'shr', 'not', 'and', 'or', 'xor', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'this', '@data', '@code', 'small', 'tiny', 'stack', 'public', 'para', 'nothing'];

monaco.languages.register({ id: 'asm86', extensions: ['.asm'] });
monaco.languages.setLanguageConfiguration('asm86', {
  comments: { lineComment: ';' },
  brackets: [['[', ']'], ['(', ')']],
  autoClosingPairs: [{ open: '[', close: ']' }, { open: '(', close: ')' }, { open: "'", close: "'", notIn: ['string', 'comment'] }, { open: '"', close: '"', notIn: ['string', 'comment'] }],
  wordPattern: /(\.[a-zA-Z]+\??)|([a-zA-Z_@$?][\w@$?]*)|(\d[\da-fA-F]*[hHbBoOqQdDtT]?)/,
});
monaco.languages.setMonarchTokensProvider('asm86', {
  ignoreCase: true,
  registers: REGISTERS,
  instructions: INSTRUCTIONS,
  directives: DIRECTIVES,
  operators: OPERATORS,
  tokenizer: {
    root: [
      [/;.*$/, 'comment'],
      [/'([^']|'')*'/, 'string'],
      [/"([^"]|"")*"/, 'string'],
      [/\b[0-9][0-9a-fA-F]*[hH]\b/, 'number.hex'],
      [/\b[01]+[bByY]\b/, 'number'],
      [/\b[0-7]+[oOqQ]\b/, 'number'],
      [/\b[0-9]+[dDtT]?\b/, 'number'],
      [/^\s*[a-zA-Z_@$?][\w@$?]*(?=\s*:(?!\s*\[))/, 'type.identifier'],
      [/\.[a-zA-Z]+\??/, { cases: { '@directives': 'keyword.directive', '@default': 'identifier' } }],
      [/[a-zA-Z_@$?][\w@$?]*/, {
        cases: { '@registers': 'variable.predefined', '@instructions': 'keyword', '@directives': 'keyword.directive', '@operators': 'operator.word', '@default': 'identifier' },
      }],
      [/[[\]()]/, '@brackets'],
      [/[,:+\-*/]/, 'delimiter'],
    ],
  },
} as monaco.languages.IMonarchLanguage);

monaco.editor.defineTheme('asm-light', {
  base: 'vs', inherit: true,
  rules: [
    { token: 'comment', foreground: '6a8759', fontStyle: 'italic' },
    { token: 'keyword', foreground: '1f4fbf', fontStyle: 'bold' },
    { token: 'keyword.directive', foreground: '8a3ab9' },
    { token: 'variable.predefined', foreground: 'b5470b' },
    { token: 'number', foreground: '0b7a75' },
    { token: 'number.hex', foreground: '0b7a75' },
    { token: 'string', foreground: 'a31515' },
    { token: 'type.identifier', foreground: '7a5c00', fontStyle: 'bold' },
    { token: 'operator.word', foreground: '8a3ab9' },
  ],
  colors: { 'editor.background': '#ffffff' },
});
monaco.editor.defineTheme('asm-dark', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: '7f9f7f', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7cb2ff', fontStyle: 'bold' },
    { token: 'keyword.directive', foreground: 'c792ea' },
    { token: 'variable.predefined', foreground: 'ffab70' },
    { token: 'number', foreground: '7fd6c2' },
    { token: 'number.hex', foreground: '7fd6c2' },
    { token: 'string', foreground: 'e6a26b' },
    { token: 'type.identifier', foreground: 'e8c66a', fontStyle: 'bold' },
    { token: 'operator.word', foreground: 'c792ea' },
  ],
  colors: { 'editor.background': '#1c2027' },
});

export interface EditorHooks {
  onChange(model: monaco.editor.ITextModel): void;
  onBreakpointsChanged(model: monaco.editor.ITextModel): void;
  hover(model: monaco.editor.ITextModel, word: string, line: number, lineText: string): string[] | null;
}

/** 每个文档各自的断点、当前行、机器码（切换标签页时保留） */
interface DocState {
  bp: string[];
  cur: string[];
  codeLines: Set<number>;
  bytesByLine: Map<number, string>;
}

export class EditorView {
  editor: monaco.editor.IStandaloneCodeEditor;
  private docs = new Map<monaco.editor.ITextModel, DocState>();
  private bytesChanged = new monaco.Emitter<void>();
  private hooks: EditorHooks;
  private suppressChange = false;

  constructor(el: HTMLElement, hooks: EditorHooks) {
    this.hooks = hooks;
    const dark = matchMedia('(prefers-color-scheme: dark)');
    this.editor = monaco.editor.create(el, {
      model: null,
      theme: dark.matches ? 'asm-dark' : 'asm-light',
      fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 14,
      lineHeight: 20,
      glyphMargin: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      tabSize: 8,
      insertSpaces: false,
      renderWhitespace: 'none',
      fixedOverflowWidgets: true,
      hover: { delay: 350 },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    });
    dark.addEventListener('change', e => monaco.editor.setTheme(e.matches ? 'asm-dark' : 'asm-light'));
    monaco.languages.registerInlayHintsProvider('asm86', {
      onDidChangeInlayHints: this.bytesChanged.event,
      provideInlayHints: (model, range) => {
        const hints: monaco.languages.InlayHint[] = [];
        const bytes = this.docs.get(model)?.bytesByLine;
        if (bytes) {
          for (let l = range.startLineNumber; l <= range.endLineNumber; l++) {
            const t = bytes.get(l);
            if (t) hints.push({ label: t, position: { lineNumber: l, column: model.getLineMaxColumn(l) }, paddingLeft: true });
          }
        }
        return { hints, dispose() {} };
      },
    });
    this.editor.onMouseDown(e => {
      const t = e.target.type;
      if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
        const line = e.target.position?.lineNumber;
        const model = this.editor.getModel();
        if (line && model) this.toggleBreakpoint(model, line);
      }
    });
    monaco.languages.registerHoverProvider('asm86', {
      provideHover: (model, pos) => {
        const w = model.getWordAtPosition(pos);
        if (!w) return null;
        const res = this.hooks.hover(model, w.word, pos.lineNumber, model.getLineContent(pos.lineNumber));
        if (!res || !res.length) return null;
        return {
          range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn),
          contents: res.map(value => ({ value, supportHtml: false })),
        };
      },
    });
  }

  createModel(text: string): monaco.editor.ITextModel {
    const model = monaco.editor.createModel(text, 'asm86');
    this.docs.set(model, { bp: [], cur: [], codeLines: new Set(), bytesByLine: new Map() });
    model.onDidChangeContent(() => { if (!this.suppressChange) this.hooks.onChange(model); });
    return model;
  }

  private doc(model: monaco.editor.ITextModel): DocState { return this.docs.get(model)!; }

  get model(): monaco.editor.ITextModel | null { return this.editor.getModel(); }

  setModel(model: monaco.editor.ITextModel): void {
    if (this.editor.getModel() !== model) this.editor.setModel(model);
  }

  /** 替换文档内容（清除断点和当前行） */
  setText(model: monaco.editor.ITextModel, text: string): void {
    this.suppressChange = true;
    model.setValue(text);
    this.suppressChange = false;
    const d = this.doc(model);
    d.bp = model.deltaDecorations(d.bp, []);
    d.cur = model.deltaDecorations(d.cur, []);
    d.codeLines.clear();
    d.bytesByLine.clear();
    this.bytesChanged.fire();
  }

  // ---------- 断点 ----------
  breakpointLines(model: monaco.editor.ITextModel): number[] {
    const d = this.doc(model);
    const lines = d.bp.map(id => model.getDecorationRange(id)?.startLineNumber ?? 0).filter(l => l > 0);
    return [...new Set(lines)];
  }

  toggleBreakpoint(model: monaco.editor.ITextModel, line: number): void {
    const lines = new Set(this.breakpointLines(model));
    if (lines.has(line)) lines.delete(line); else lines.add(line);
    this.setBreakpoints(model, [...lines]);
    this.hooks.onBreakpointsChanged(model);
  }

  setBreakpoints(model: monaco.editor.ITextModel, lines: number[]): void {
    const d = this.doc(model);
    const ok = (l: number) => d.codeLines.size === 0 || d.codeLines.has(l);
    d.bp = model.deltaDecorations(d.bp, lines.map(l => ({
      range: new monaco.Range(l, 1, l, 1),
      options: {
        isWholeLine: true,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        glyphMarginClassName: ok(l) ? 'bp-glyph' : 'bp-glyph-off',
        glyphMarginHoverMessage: { value: ok(l) ? '断点（点击取消）' : '这一行没有生成代码，断点不起作用' },
        overviewRuler: { color: '#d33a3a', position: monaco.editor.OverviewRulerLane.Left },
      },
    })));
  }

  // ---------- 当前执行行 ----------
  setCurrentLine(model: monaco.editor.ITextModel, line: number | null, reveal: boolean): void {
    const d = this.doc(model);
    d.cur = model.deltaDecorations(d.cur, line ? [{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'cur-line', glyphMarginClassName: 'cur-glyph', zIndex: 10 },
    }] : []);
    if (line && reveal && this.editor.getModel() === model) {
      this.editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
    }
  }

  // ---------- 汇编结果 ----------
  setDiagnostics(model: monaco.editor.ITextModel, diags: Diag[]): void {
    monaco.editor.setModelMarkers(model, 'asm', diags.map(d => {
      const lineLen = d.line >= 1 && d.line <= model.getLineCount() ? model.getLineMaxColumn(d.line) : 1;
      return {
        severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: d.message,
        startLineNumber: Math.max(1, d.line), endLineNumber: Math.max(1, d.line),
        startColumn: d.col >= 0 ? d.col + 1 : 1, endColumn: lineLen,
      };
    }));
  }

  setProgram(model: monaco.editor.ITextModel, p: Program | null, diags: Diag[], showBytes: boolean): void {
    this.setDiagnostics(model, diags);
    this.doc(model).codeLines = new Set(p ? [...p.lineToAddrs.keys()] : []);
    this.setBreakpoints(model, this.breakpointLines(model));
    this.showBytes(model, p, showBytes);
  }

  showBytes(model: monaco.editor.ITextModel, p: Program | null, on: boolean): void {
    const bytesByLine = this.doc(model).bytesByLine;
    bytesByLine.clear();
    if (p && on) {
      const h = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');
      const byLine = new Map<number, { seg: number; off: number; bytes: number[] }>();
      for (const e of p.listing) {
        const cur = byLine.get(e.line);
        if (!cur) byLine.set(e.line, { seg: e.segment, off: e.offset, bytes: [...e.bytes] });
        else if (cur.bytes.length < 16) cur.bytes.push(...e.bytes);
      }
      for (const [line, e] of byLine) {
        const shown = e.bytes.slice(0, 8).map(b => (b < 0 ? '??' : h(b, 2))).join(' ') + (e.bytes.length > 8 ? ' …' : '');
        bytesByLine.set(line, `${h(e.seg, 4)}:${h(e.off, 4)}  ${shown}`);
      }
    }
    this.bytesChanged.fire();
  }

  revealLine(model: monaco.editor.ITextModel, line: number): void {
    this.setModel(model);
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column: 1 });
    this.editor.focus();
  }
}

export { monaco };
