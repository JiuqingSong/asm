// DOS 文本屏幕（80×25，B800:0000）的渲染与键盘输入
import { SCAN, type KeyEvent } from '../machine/devices.ts';

const LOW = ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼';
const HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** 代码页 437 -> Unicode */
export const CP437: string[] = (() => {
  const t: string[] = [];
  const low = [...LOW], high = [...HIGH];
  for (let i = 0; i < 256; i++) {
    if (i < 32) t.push(low[i]);
    else if (i < 127) t.push(String.fromCharCode(i));
    else if (i === 127) t.push('⌂');
    else t.push(high[i - 128]);
  }
  return t;
})();

const PALETTE = [
  '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
];

const COLS = 80, ROWS = 25;

export class Screen {
  private el: HTMLElement;
  private cells: HTMLSpanElement[] = [];
  private prev = new Int16Array(COLS * ROWS * 2).fill(-1);
  private cursor: HTMLDivElement;
  private cellW = 8;
  private cellH = 16;
  onKey: ((e: KeyEvent) => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement('div');
      row.className = 'row';
      for (let c = 0; c < COLS; c++) {
        const s = document.createElement('span');
        s.textContent = ' ';
        row.appendChild(s);
        this.cells.push(s);
      }
      el.appendChild(row);
    }
    this.cursor = document.createElement('div');
    this.cursor.className = 'cursor';
    el.appendChild(this.cursor);
    el.addEventListener('keydown', e => this.key(e, false));
    el.addEventListener('keyup', e => this.key(e, true));
    const wrap = el.parentElement!;
    new ResizeObserver(() => this.fit(wrap)).observe(wrap);
    window.addEventListener('resize', () => this.fit(wrap));
  }

  private fit(wrap: HTMLElement): void {
    const w = wrap.clientWidth - 16;
    // 等宽字体中一个字符约 0.6em 宽，行高 1.18em；屏幕高度不超过窗口的 40%
    const byWidth = w / COLS / 0.6;
    const byHeight = (window.innerHeight * 0.4) / ROWS / 1.18;
    const size = Math.max(8, Math.min(15, Math.floor(Math.min(byWidth, byHeight) * 10) / 10));
    this.el.style.fontSize = size + 'px';
    requestAnimationFrame(() => this.measure());
  }

  private measure(): void {
    const s = this.cells[0];
    const r = s.getBoundingClientRect();
    if (r.width) { this.cellW = r.width; this.cellH = (s.parentElement as HTMLElement).getBoundingClientRect().height; }
    this.prev.fill(-1);
  }

  /** 从显存渲染 */
  render(mem: Uint8Array, cursorRow: number, cursorCol: number, cursorShape: number): void {
    const base = 0xb8000;
    for (let i = 0; i < COLS * ROWS; i++) {
      const ch = mem[base + i * 2], at = mem[base + i * 2 + 1];
      if (this.prev[i * 2] === ch && this.prev[i * 2 + 1] === at) continue;
      this.prev[i * 2] = ch; this.prev[i * 2 + 1] = at;
      const s = this.cells[i];
      s.textContent = CP437[ch];
      const fg = at & 15, bg = (at >> 4) & 7;
      s.style.color = fg === 7 ? '' : PALETTE[fg];
      s.style.background = bg === 0 ? '' : PALETTE[bg];
    }
    const hidden = (cursorShape & 0x2000) !== 0 || cursorRow >= ROWS || cursorCol >= COLS;
    this.cursor.style.display = hidden ? 'none' : '';
    if (!hidden) {
      const cell = this.cells[cursorRow * COLS + cursorCol];
      this.cursor.style.left = cell.offsetLeft + 'px';
      this.cursor.style.top = (cell.offsetTop + this.cellH * 0.82) + 'px';
      this.cursor.style.width = (this.cellW || cell.offsetWidth) + 'px';
    }
  }

  focus(): void { this.el.focus(); }

  private key(e: KeyboardEvent, release: boolean): void {
    if (!this.onKey) return;
    if (e.ctrlKey && (e.key === 'v' || e.key === 'c')) return; // 允许复制粘贴
    if (/^F(5|6|7|10|11)$/.test(e.key)) return;              // 调试快捷键
    const scan = SCAN[e.code];
    if (scan === undefined) return;
    e.preventDefault();
    if (release) { this.onKey({ scan: scan | 0x80, ascii: 0, release: true }); return; }
    let ascii = 0;
    if (e.key.length === 1) {
      const c = e.key.charCodeAt(0);
      ascii = c < 128 ? c : 0;
      if (e.ctrlKey && /[a-z]/i.test(e.key)) ascii = e.key.toUpperCase().charCodeAt(0) - 0x40;
      if (e.altKey) ascii = 0;
    } else {
      ascii = ({ Enter: 13, Backspace: 8, Tab: 9, Escape: 27 } as Record<string, number>)[e.key] ?? 0;
    }
    this.onKey({ scan, ascii, release: false });
  }
}
