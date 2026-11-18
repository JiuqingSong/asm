// DOS 文本屏幕（80×25，B800:0000）的渲染与键盘输入
import { SCAN, type KeyEvent } from '../machine/devices.ts';
import { modeInfo, type Video } from '../machine/video.ts';
import type { Mouse } from '../machine/mouse.ts';

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

// ---------- 中文显示（模拟 UCDOS 等中文 DOS）----------
// 制表符（CP437 B3h~DAh）与 GBK 的编码范围重叠，例如 C9 CD 既是"╔═"又是"赏"。
// 中文系统靠上下文识别制表符。这里的规则：只承认"强"连接——上下连接时至少一方是竖线（│║），
// 左右连接时至少一方是横线（─═）；由强连接连成的一组制表符，既有上下连接又有左右连接，才当作表格线。
// 这样上下对齐的汉字（例如两行都有"文件"，文 = CE C4 = ╬─）不会被误认成表格。
const UP = new Set([0xb3, 0xb4, 0xb5, 0xb6, 0xb9, 0xba, 0xbc, 0xbd, 0xbe, 0xc0, 0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xca, 0xcc, 0xce, 0xcf, 0xd0, 0xd3, 0xd4, 0xd7, 0xd8, 0xd9]);
const DOWN = new Set([0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbf, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xcb, 0xcc, 0xce, 0xd1, 0xd2, 0xd5, 0xd6, 0xd7, 0xd8, 0xda]);
const LEFT = new Set([0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc1, 0xc2, 0xc4, 0xc5, 0xca, 0xcb, 0xcd, 0xce, 0xcf, 0xd0, 0xd1, 0xd2, 0xd7, 0xd8, 0xd9]);
const RIGHT = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xda]);

/** 每个字符格的显示方式：0 西文字符，1 汉字的前半（占两格），2 汉字的后半（不显示），3 制表符 */
const VLINE = new Set([0xb3, 0xba]);
const HLINE = new Set([0xc4, 0xcd]);

export function layoutGbk(ch: Uint8Array): Int8Array {
  const n = COLS * ROWS;
  const kind = new Int8Array(n);
  // 1. 找出相互连接的制表符，按连通块判断有没有上下方向的连接
  const comp = new Int32Array(n).fill(-1);
  const vertical: boolean[] = [];
  const horizontal: boolean[] = [];
  const isBox = (i: number) => ch[i] >= 0xb3 && ch[i] <= 0xda;
  for (let i = 0; i < n; i++) {
    if (!isBox(i) || comp[i] >= 0) continue;
    const id = vertical.length;
    vertical.push(false);
    horizontal.push(false);
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const k = stack.pop()!, r = Math.floor(k / COLS), c = k % COLS, b = ch[k];
      const links: [number, boolean, boolean][] = [
        [k - COLS, r > 0 && UP.has(b), true], [k + COLS, r < ROWS - 1 && DOWN.has(b), true],
        [k - 1, c > 0 && LEFT.has(b), false], [k + 1, c < COLS - 1 && RIGHT.has(b), false],
      ];
      for (const [j, ok, vert] of links) {
        if (!ok || !isBox(j)) continue;
        const nb = ch[j];
        const back = j === k - COLS ? DOWN.has(nb) : j === k + COLS ? UP.has(nb) : j === k - 1 ? RIGHT.has(nb) : LEFT.has(nb);
        if (!back) continue;
        const strong = vert ? VLINE.has(b) || VLINE.has(nb) : HLINE.has(b) || HLINE.has(nb);
        if (!strong) continue;
        if (vert) vertical[id] = true; else horizontal[id] = true;
        if (comp[j] < 0) { comp[j] = id; stack.push(j); }
      }
    }
  }
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && vertical[comp[i]] && horizontal[comp[i]]) kind[i] = 3;
  // 2. 其余的高位字节两两组成汉字（每行从左到右配对）
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (kind[i] === 3) continue;
      const hi = ch[i], lo = ch[i + 1];
      if (hi >= 0x81 && hi <= 0xfe && c < COLS - 1 && kind[i + 1] !== 3 && lo >= 0x40 && lo <= 0xfe && lo !== 0x7f) {
        kind[i] = 1; kind[i + 1] = 2; c++;
      }
    }
  }
  return kind;
}

const gbk = (() => { try { return new TextDecoder('gbk'); } catch { return null; } })();

export class Screen {
  private el: HTMLElement;
  private cells: HTMLSpanElement[] = [];
  private prev = new Int16Array(COLS * ROWS * 2).fill(-1);
  private cursor: HTMLDivElement;
  private cellW = 8;
  private cellH = 16;
  onKey: ((e: KeyEvent) => void) | null = null;
  /** 鼠标：显示区域内的相对位置（0~1）和按键（位 0 左、位 1 右、位 2 中） */
  onMouse: ((fx: number, fy: number, buttons: number) => void) | null = null;
  /** 相对移动（鼠标被捕获时）：dx、dy 是虚拟屏幕上的像素（水平按 640 宽计） */
  onMouseRel: ((dx: number, dy: number, buttons: number) => void) | null = null;
  /** 程序在用串口鼠标（它自己画光标、只要相对移动量）：单击屏幕时捕获鼠标 */
  relative = false;
  /** 捕获状态变化（界面据此提示"按 Esc 释放鼠标"） */
  onCapture: ((captured: boolean) => void) | null = null;
  private get captured(): boolean { return document.pointerLockElement === this.el; }
  private rows: HTMLElement[] = [];
  private vramView = new Uint8Array(COLS * ROWS * 2);
  /** 中文显示：像 UCDOS 那样把 GBK 编码显示成汉字 */
  chinese = false;
  private snapshot = new Uint8Array(COLS * ROWS * 2);
  private dirtyAll = true;
  // 图形模式：用 canvas 画像素
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private image: ImageData | null = null;
  private graphicsMode = -1;
  private paletteVersion = -1;
  private rgba = new Uint32Array(256);

  setChinese(on: boolean): void {
    this.chinese = on;
    this.dirtyAll = true;
    this.prev.fill(-1);
    for (const s of this.cells) { s.className = ''; s.style.display = ''; }
  }

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
      this.rows.push(row);
    }
    this.cursor = document.createElement('div');
    this.cursor.className = 'cursor';
    el.appendChild(this.cursor);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gfx';
    this.canvas.style.display = 'none';
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    const mouse = (e: MouseEvent) => {
      if (!this.onMouse) return;
      if (this.captured) {
        // 被捕获时只有相对移动量；屏幕显示得比 640 像素窄时按比例放大
        const r = this.displayRect();
        const kx = 640 / Math.max(1, r.width), ky = this.virtualHeight / Math.max(1, r.height);
        this.onMouseRel?.(e.movementX * kx, e.movementY * ky, e.buttons & 7);
        return;
      }
      const r = this.displayRect();
      const fx = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
      const fy = Math.max(0, Math.min(0.9999, (e.clientY - r.top) / r.height));
      this.onMouse(fx, fy, e.buttons & 7);
    };
    el.addEventListener('mousemove', mouse);
    el.addEventListener('mousedown', e => {
      if (this.relative && !this.captured && e.button === 0) {
        // 程序用的是串口鼠标：捕获鼠标（浏览器的光标消失，移动量全部交给程序），按 Esc 释放
        try { void (this.el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => { /* 不允许捕获 */ }); } catch { /* 不支持 */ }
        return;
      }
      mouse(e);
      if (e.button !== 0) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => this.onCapture?.(this.captured));
    el.addEventListener('mouseup', mouse);
    el.addEventListener('contextmenu', e => { if (this.onMouse) e.preventDefault(); });
    el.addEventListener('keydown', e => this.key(e, false));
    el.addEventListener('keyup', e => this.key(e, true));
    // 切到别的窗口（例如 Alt+Tab）时，松开键的事件发生在别处，虚拟机收不到：
    // 当作这些键都已松开，否则 BIOS 会一直以为 Alt、Ctrl、Shift 还按着
    el.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('blur', () => this.releaseAll());
    const wrap = el.parentElement!;
    new ResizeObserver(() => this.fit(wrap)).observe(wrap);
    window.addEventListener('resize', () => this.fit(wrap));
  }

  private fit(wrap: HTMLElement): void {
    if (!wrap.clientWidth) return; // 窗口被隐藏（别的窗口最大化）时不调整
    const w = wrap.clientWidth - 16;
    // 等宽字体中一个字符约 0.6em 宽，行高 1.18em。
    // 窗口被拖动调整过大小或最大化时，按窗口的高度放大；否则屏幕高度不超过浏览器窗口的 40%
    const pane = wrap.closest('.screen-pane');
    const sized = !!pane && (pane.classList.contains('sized') || pane.classList.contains('maxed'));
    const byWidth = w / COLS / 0.6;
    const byHeight = sized ? (wrap.clientHeight - 16) / ROWS / 1.18 : (window.innerHeight * 0.4) / ROWS / 1.18;
    const size = Math.max(6, Math.min(sized ? 48 : 15, Math.floor(Math.min(byWidth, byHeight) * 10) / 10));
    this.el.style.fontSize = size + 'px';
    requestAnimationFrame(() => this.measure());
  }

  private measure(): void {
    const s = this.cells[0];
    const r = s.getBoundingClientRect();
    if (r.width) { this.cellW = r.width; this.cellH = (s.parentElement as HTMLElement).getBoundingClientRect().height; }
    this.prev.fill(-1);
  }

  /** 虚拟屏幕高度（串口鼠标的纵向比例用） */
  private get virtualHeight(): number { return this.graphicsMode >= 0 ? modeInfo(this.graphicsMode).height : 200; }

  /** 释放鼠标捕获 */
  release(): void { if (this.captured) document.exitPointerLock(); }

  /** 从显存渲染 */
  render(mem: Uint8Array, cursorRow: number, cursorCol: number, cursorShape: number, video?: Video, mouse?: Mouse): void {
    // 显示什么由显卡寄存器决定（和真的显示器一样），不看 BIOS 数据区的模式号；CGA 4 色模式 4、5 的区别只在 BIOS 数据区里
    let mode = video ? video.hardwareMode() : mem[0x449];
    if (mode === 0x04 && mem[0x449] === 0x05) mode = 0x05;
    const info = modeInfo(mode);
    const showMouse = !!mouse && mouse.used && mouse.visible >= 0;
    this.el.style.cursor = showMouse ? 'none' : '';
    this.el.style.userSelect = showMouse ? 'none' : '';
    if (info.graphics && video) { this.renderGraphics(mem, mode, video, showMouse ? mouse : undefined); return; }
    if (this.graphicsMode >= 0) this.leaveGraphics();
    // 文本模式的鼠标光标：把光标所在格子的 (属性<<8 | 字符) 先和屏幕掩码"与"、再和光标掩码"异或"（只改显示，不改显存）
    const vram = this.vramView;
    vram.set(mem.subarray(0xb8000, 0xb8000 + COLS * ROWS * 2));
    if (showMouse) {
      const col = Math.min(COLS - 1, mouse!.x >> 3), row = Math.min(ROWS - 1, mouse!.y >> 3);
      const i = (row * COLS + col) * 2;
      const v = (((vram[i + 1] << 8) | vram[i]) & mouse!.textScreenMask) ^ mouse!.textCursorMask;
      vram[i] = v & 0xff; vram[i + 1] = v >> 8;
    }
    const base = 0;
    mem = vram;
    if (this.chinese && gbk) this.renderChinese(vram);
    else for (let i = 0; i < COLS * ROWS; i++) {
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
      let cell = this.cells[cursorRow * COLS + cursorCol];
      let dx = 0;
      if (cell.style.display === 'none' && cursorCol > 0) { cell = this.cells[cursorRow * COLS + cursorCol - 1]; dx = this.cellW; }
      this.cursor.style.left = cell.offsetLeft + dx + 'px';
      this.cursor.style.top = (cell.offsetTop + this.cellH * 0.82) + 'px';
      this.cursor.style.width = (this.cellW || cell.offsetWidth) + 'px';
    }
  }

  private renderChinese(vram: Uint8Array): void {
    let changed = this.dirtyAll;
    for (let k = 0; k < vram.length && !changed; k++) if (vram[k] !== this.snapshot[k]) changed = true;
    if (!changed) return;
    this.snapshot.set(vram);
    this.dirtyAll = false;
    const chars = new Uint8Array(COLS * ROWS);
    for (let i = 0; i < chars.length; i++) chars[i] = vram[i * 2];
    const kind = layoutGbk(chars);
    for (let i = 0; i < chars.length; i++) {
      const s = this.cells[i], at = vram[i * 2 + 1];
      const k = kind[i];
      s.style.display = k === 2 ? 'none' : '';
      s.className = k === 1 ? 'wide' : '';
      if (k === 1) s.textContent = gbk!.decode(chars.subarray(i, i + 2));
      else if (k !== 2) s.textContent = CP437[chars[i]];
      const fg = at & 15, bg = (at >> 4) & 7;
      s.style.color = fg === 7 ? '' : PALETTE[fg];
      s.style.background = bg === 0 ? '' : PALETTE[bg];
    }
  }

  private leaveGraphics(): void {
    this.graphicsMode = -1;
    this.canvas.style.display = 'none';
    this.el.classList.remove('graphics');
    this.prev.fill(-1);
    this.dirtyAll = true;
  }

  /** 图形模式：按显示模式把显存换算成像素 */
  private renderGraphics(mem: Uint8Array, mode: number, video: Video, mouse?: Mouse): void {
    const info = modeInfo(mode);
    if (mode !== this.graphicsMode) {
      this.graphicsMode = mode;
      this.canvas.width = info.width;
      this.canvas.height = info.height;
      this.image = this.ctx?.createImageData(info.width, info.height) ?? null;
      this.canvas.style.display = '';
      this.el.classList.add('graphics');
      this.cursor.style.display = 'none';
      this.paletteVersion = -1;
    }
    if (!this.ctx || !this.image) return;
    // 调色板：6 位分量换算成 8 位，按小端写成 RGBA
    if (video.version !== this.paletteVersion) {
      this.paletteVersion = video.version;
      const c8 = (v: number) => ((v & 63) << 2) | ((v & 63) >> 4);
      const pack = (r: number, g: number, b: number) => (255 << 24) | (c8(b) << 16) | (c8(g) << 8) | c8(r);
      if (mode === 0x13) {
        for (let i = 0; i < 256; i++) {
          const k = (i & video.pelMask) * 3;
          this.rgba[i] = pack(video.dac[k], video.dac[k + 1], video.dac[k + 2]);
        }
      } else if (info.planar) {
        for (let i = 0; i < 16; i++) {
          const k = (video.dacIndex(i) & video.pelMask) * 3;
          this.rgba[i] = pack(video.dac[k], video.dac[k + 1], video.dac[k + 2]);
        }
      } else if (mode === 0x06) {
        this.rgba[0] = pack(0, 0, 0); this.rgba[1] = pack(63, 63, 63);
      } else {
        video.cgaColors(mode).forEach(([r, g, b], i) => { this.rgba[i] = pack(r, g, b); });
      }
    }
    const px = new Uint32Array(this.image.data.buffer);
    const { width, height } = info;
    if (mode === 0x13) {
      const base = 0xa0000;
      for (let i = 0; i < 64000; i++) px[i] = this.rgba[mem[base + i]];
    } else if (info.planar) {
      // 4 个平面的同一位拼成颜色号；每个字节 8 个像素，最高位在左边
      const [p0, p1, p2, p3] = video.planar.planes, rgba = this.rgba;
      const bytes = (width >> 3) * height;
      for (let o = 0, i = 0; o < bytes; o++) {
        const b0 = p0[o], b1 = p1[o], b2 = p2[o], b3 = p3[o];
        for (let s = 7; s >= 0; s--) px[i++] = rgba[((b0 >> s) & 1) | (((b1 >> s) & 1) << 1) | (((b2 >> s) & 1) << 2) | (((b3 >> s) & 1) << 3)];
      }
    } else {
      const base = 0xb8000;
      const ppb = mode === 0x06 ? 8 : 4, bits = mode === 0x06 ? 1 : 2, mask = (1 << bits) - 1;
      for (let y = 0; y < height; y++) {
        const row = base + (y & 1) * 0x2000 + (y >> 1) * 80;
        for (let x = 0; x < width; x++) {
          const b = mem[row + Math.floor(x / ppb)];
          px[y * width + x] = this.rgba[(b >> ((ppb - 1 - (x % ppb)) * bits)) & mask];
        }
      }
    }
    if (mouse) this.drawGfxCursor(px, mem, mode, mouse, video);
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** 显示区域（文本的 80×25 格子，或者图形模式的画布）在页面上的位置 */
  private displayRect(): { left: number; top: number; width: number; height: number } {
    if (this.graphicsMode >= 0) return this.canvas.getBoundingClientRect();
    const a = this.rows[0].getBoundingClientRect(), b = this.rows[ROWS - 1].getBoundingClientRect();
    const first = this.cells[0].getBoundingClientRect();
    return { left: first.left, top: a.top, width: this.cellW * COLS, height: b.bottom - a.top };
  }

  /** 在图形画面上叠加鼠标光标（16×16 的屏幕掩码和光标掩码） */
  private drawGfxCursor(px: Uint32Array, mem: Uint8Array, mode: number, mouse: Mouse, video: Video): void {
    const { width, height, planar } = modeInfo(mode);
    const half = width === 320; // 320 像素宽的模式里，驱动的 x 坐标是像素的 2 倍
    const cx = (half ? mouse.x >> 1 : mouse.x) - mouse.hotX, cy = mouse.y - mouse.hotY;
    const white = mode === 0x13 || planar ? 15 : mode === 0x06 ? 1 : 3;
    for (let r = 0; r < 16; r++) {
      const y = cy + r;
      if (y < 0 || y >= height) continue;
      for (let c = 0; c < 16; c++) {
        const x = cx + c;
        if (x < 0 || x >= width) continue;
        const s = (mouse.gfxScreen[r] >> (15 - c)) & 1, k = (mouse.gfxCursor[r] >> (15 - c)) & 1;
        if (s && !k) continue;
        let idx: number;
        if (mode === 0x13) idx = mem[0xa0000 + y * 320 + x];
        else if (planar) idx = video.planar.pixel(y * (width >> 3) + (x >> 3), x & 7);
        else {
          const ppb = mode === 0x06 ? 8 : 4, bits = mode === 0x06 ? 1 : 2;
          const b = mem[0xb8000 + (y & 1) * 0x2000 + (y >> 1) * 80 + Math.floor(x / ppb)];
          idx = (b >> ((ppb - 1 - (x % ppb)) * bits)) & ((1 << bits) - 1);
        }
        idx = (s ? idx : 0) ^ (k ? white : 0);
        px[y * width + x] = this.rgba[idx];
      }
    }
  }

  focus(): void { this.el.focus(); }

  /** 从磁盘启动时为 true：功能键全部交给虚拟机里的程序（DOS 安装程序要用 F3、F5、F8 等） */
  allKeys = false;

  /** 当前按着的键（扫描码） */
  private down = new Set<number>();

  private releaseAll(): void {
    if (!this.onKey) { this.down.clear(); return; }
    for (const scan of this.down) this.onKey({ scan: scan | 0x80, ascii: 0, release: true });
    this.down.clear();
  }

  private key(e: KeyboardEvent, release: boolean): void {
    if (!this.onKey) return;
    if (e.ctrlKey && (e.key === 'v' || e.key === 'c')) return; // 允许复制粘贴
    if (!this.allKeys && /^F(5|6|7|10|11)$/.test(e.key)) return; // 调试快捷键（从磁盘启动时全部交给程序）
    const scan = SCAN[e.code];
    if (scan === undefined) return;
    e.preventDefault();
    if (release) { this.down.delete(scan); this.onKey({ scan: scan | 0x80, ascii: 0, release: true }); return; }
    this.down.add(scan);
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
