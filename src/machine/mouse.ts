import { modeInfo } from './video.ts';
// 鼠标驱动（INT 33h），按微软鼠标驱动的接口
//
// 坐标是驱动的"虚拟屏幕"坐标：水平 0~639，垂直 0~199（文本模式下每个字符 8×8；
// 320 像素宽的图形模式下 x 是像素的 2 倍）。
// 光标不写进显存，由界面在显示时叠加上去（按屏幕掩码和光标掩码），程序读显存时不会读到光标。
//
// 事件回调（功能 0Ch/14h）：鼠标事件发生时，Machine 在指令边界进入 BIOS 里的桩代码，
// 桩代码保存寄存器、远调用程序登记的处理程序，再恢复寄存器返回（像硬件中断一样）。
import { AX, BX, CX, DX, SI, DI, ES, type CPU } from '../cpu/cpu.ts';

/** 鼠标回调的桩代码在 F000:0E00，它要调用的处理程序地址放在 F000:0E20；中断向量用 74h（PS/2 鼠标的 IRQ12） */
export const MOUSE_STUB = 0x0e00, MOUSE_PTR = 0x0e20, MOUSE_VECTOR = 0x74;

/** 默认的图形光标：左上角的箭头（屏幕掩码 16 个字 + 光标掩码 16 个字） */
const ARROW_SCREEN = [0x3fff, 0x1fff, 0x0fff, 0x07ff, 0x03ff, 0x01ff, 0x00ff, 0x007f, 0x003f, 0x001f, 0x01ff, 0x10ff, 0x30ff, 0xf87f, 0xf87f, 0xfc3f];
const ARROW_CURSOR = [0x0000, 0x4000, 0x6000, 0x7000, 0x7800, 0x7c00, 0x7e00, 0x7f00, 0x7f80, 0x7c00, 0x6c00, 0x4600, 0x0600, 0x0300, 0x0300, 0x0000];

/** 事件掩码位 */
export const EV_MOVE = 1, EV_LDOWN = 2, EV_LUP = 4, EV_RDOWN = 8, EV_RUP = 16, EV_MDOWN = 32, EV_MUP = 64;

export class Mouse {
  x = 320; y = 100;
  buttons = 0;
  /** 光标显示计数：0 显示，负数隐藏（复位后为 -1） */
  visible = -1;
  minX = 0; maxX = 639; minY = 0; maxY = 199;
  /** 每个按键的按下/松开次数和最后一次的位置 */
  presses = [0, 0, 0]; releases = [0, 0, 0];
  pressPos: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  releasePos: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  /** 累计移动量（mickey） */
  mickeyX = 0; mickeyY = 0;
  /** 每 8 像素对应的 mickey 数 */
  ratioX = 8; ratioY = 16;
  // 文本光标：软件光标的两个掩码（作用于 属性<<8 | 字符）
  textHardware = false;
  textScreenMask = 0x77ff;
  textCursorMask = 0x7700;
  // 图形光标
  gfxScreen = ARROW_SCREEN.slice();
  gfxCursor = ARROW_CURSOR.slice();
  hotX = 0; hotY = 0;
  // 事件回调
  handlerMask = 0; handlerSeg = 0; handlerOff = 0;
  /** 尚未交给回调的事件（按位或在一起） */
  pending = 0;
  /** 回调正在执行（不重入） */
  inHandler = false;
  enabled = true;
  /** 程序调用过复位（INT 33h AX=0），界面据此决定是否隐藏系统光标 */
  used = false;
  /** 状态被修改的次数（界面据此重画） */
  version = 0;
  /**
   * 来自界面的按键变化排队：每个状态至少保持 BUTTON_HOLD 个 PIT 时钟（约 30 毫秒虚拟时间），
   * 这样很快的一次点击（按下和松开在同一帧里到达）也能被轮询的程序看到
   */
  private queue: number[] = [];
  private lastChange = -Infinity;
  static readonly BUTTON_HOLD = 36_000;

  reset(): void {
    this.x = (this.minX + this.maxX + 1) >> 1;
    this.y = (this.minY + this.maxY + 1) >> 1;
    this.visible = -1;
    this.presses = [0, 0, 0]; this.releases = [0, 0, 0];
    this.mickeyX = this.mickeyY = 0;
    this.textHardware = false; this.textScreenMask = 0x77ff; this.textCursorMask = 0x7700;
    this.gfxScreen = ARROW_SCREEN.slice(); this.gfxCursor = ARROW_CURSOR.slice();
    this.hotX = this.hotY = 0;
    this.handlerMask = 0;
    this.pending = 0;
    this.inHandler = false;
    this.version++;
  }

  /** 装载新程序时：完全恢复初始状态 */
  powerOn(): void {
    this.minX = 0; this.maxX = 639; this.minY = 0; this.maxY = 199; this.screenH = 200;
    this.buttons = 0;
    this.queue = [];
    this.lastChange = -Infinity;
    this.enabled = true;
    this.used = false;
    this.reset();
  }

  private clamp(): void {
    this.x = Math.max(this.minX, Math.min(this.maxX, this.x));
    this.y = Math.max(this.minY, Math.min(this.maxY, this.y));
  }

  // ======================= 来自界面的输入 =======================

  /** 鼠标移动到虚拟坐标 (x, y) */
  moveTo(x: number, y: number): void {
    if (!this.enabled) return;
    const nx = Math.round(x), ny = Math.round(y);
    if (nx === this.x && ny === this.y) return;
    this.mickeyX += ((nx - this.x) * this.ratioX) / 8;
    this.mickeyY += ((ny - this.y) * this.ratioY) / 8;
    this.x = nx; this.y = ny;
    this.clamp();
    this.pending |= EV_MOVE;
    this.version++;
  }

  /** 界面上的按键变化：排队，按虚拟时间逐个生效 */
  queueButtons(buttons: number, now: number): void {
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.buttons;
    if ((buttons & 7) === last) return;
    this.queue.push(buttons & 7);
    this.tick(now);
  }

  /** 推进虚拟时间：让排队的按键变化生效 */
  tick(now: number): void {
    while (this.queue.length && now - this.lastChange >= Mouse.BUTTON_HOLD) {
      this.setButtons(this.queue.shift()!);
      this.lastChange = now;
    }
  }

  /** 按键状态改变：buttons 是新的按键位（位 0 左键，位 1 右键，位 2 中键） */
  setButtons(buttons: number): void {
    if (!this.enabled) return;
    const changed = buttons ^ this.buttons;
    for (let b = 0; b < 3; b++) {
      if (!(changed & (1 << b))) continue;
      const down = (buttons & (1 << b)) !== 0;
      if (down) { this.presses[b]++; this.pressPos[b] = [this.x, this.y]; }
      else { this.releases[b]++; this.releasePos[b] = [this.x, this.y]; }
      this.pending |= [down ? EV_LDOWN : EV_LUP, down ? EV_RDOWN : EV_RUP, down ? EV_MDOWN : EV_MUP][b];
    }
    this.buttons = buttons & 7;
    this.version++;
  }

  /** 有需要交给回调的事件吗 */
  wantsCallback(): boolean {
    return this.enabled && !this.inHandler && (this.pending & this.handlerMask) !== 0 && (this.handlerSeg | this.handlerOff) !== 0;
  }

  /** 进入回调：设置好寄存器（由 BIOS 桩代码里的陷阱调用） */
  enterCallback(cpu: CPU): void {
    const r = cpu.r;
    r[AX] = this.pending & this.handlerMask;
    r[BX] = this.buttons;
    r[CX] = this.x;
    r[DX] = this.y;
    r[SI] = Math.trunc(this.mickeyX) & 0xffff;
    r[DI] = Math.trunc(this.mickeyY) & 0xffff;
    this.pending = 0;
    this.inHandler = true;
  }

  // ======================= INT 33h =======================

  /** 处理 INT 33h；返回 false 表示功能号未实现 */
  int33(cpu: CPU, mode: number): boolean {
    const r = cpu.r, ax = r[AX];
    switch (ax) {
      case 0x00: case 0x21: // 复位 / 软件复位
        this.used = true;
        this.setDefaultRange(mode);
        this.reset();
        r[AX] = 0xffff; r[BX] = 2;
        return true;
      case 0x01: if (this.visible < 0) this.visible++; this.version++; return true;
      case 0x02: this.visible--; this.version++; return true;
      case 0x03: r[BX] = this.buttons; r[CX] = this.x; r[DX] = this.y; return true;
      case 0x04: this.x = r[CX]; this.y = r[DX]; this.clamp(); this.version++; return true;
      case 0x05: case 0x06: {
        const b = Math.min(2, r[BX]);
        const press = ax === 0x05;
        r[AX] = this.buttons;
        r[BX] = press ? this.presses[b] : this.releases[b];
        [r[CX], r[DX]] = press ? this.pressPos[b] : this.releasePos[b];
        if (press) this.presses[b] = 0; else this.releases[b] = 0;
        return true;
      }
      case 0x07: this.minX = Math.min(r[CX], r[DX]); this.maxX = Math.max(r[CX], r[DX]); this.clamp(); return true;
      case 0x08: this.minY = Math.min(r[CX], r[DX]); this.maxY = Math.max(r[CX], r[DX]); this.clamp(); return true;
      case 0x09: { // 图形光标：BX、CX 热点，ES:DX 屏幕掩码 16 字 + 光标掩码 16 字
        this.hotX = (r[BX] << 16) >> 16; this.hotY = (r[CX] << 16) >> 16;
        for (let k = 0; k < 16; k++) {
          this.gfxScreen[k] = cpu.rw(cpu.s[ES], r[DX] + k * 2);
          this.gfxCursor[k] = cpu.rw(cpu.s[ES], r[DX] + 32 + k * 2);
        }
        this.version++;
        return true;
      }
      case 0x0a: // 文本光标：BX=0 软件光标（CX 屏幕掩码，DX 光标掩码），BX=1 硬件光标
        this.textHardware = r[BX] === 1;
        if (!this.textHardware) { this.textScreenMask = r[CX]; this.textCursorMask = r[DX]; }
        this.version++;
        return true;
      case 0x0b:
        r[CX] = Math.trunc(this.mickeyX) & 0xffff; r[DX] = Math.trunc(this.mickeyY) & 0xffff;
        this.mickeyX -= Math.trunc(this.mickeyX); this.mickeyY -= Math.trunc(this.mickeyY);
        return true;
      case 0x0c: this.handlerMask = r[CX]; this.handlerSeg = cpu.s[ES]; this.handlerOff = r[DX]; return true;
      case 0x0f: this.ratioX = r[CX] || 8; this.ratioY = r[DX] || 16; return true;
      case 0x14: { // 交换回调：返回原来的
        const [m, s, o] = [this.handlerMask, this.handlerSeg, this.handlerOff];
        this.handlerMask = r[CX]; this.handlerSeg = cpu.s[ES]; this.handlerOff = r[DX];
        r[CX] = m; cpu.s[ES] = s; r[DX] = o;
        return true;
      }
      case 0x15: r[BX] = 64; return true; // 保存状态所需的字节数
      case 0x16: case 0x17: return true;  // 保存/恢复状态：不需要
      case 0x1a: this.ratioX = r[BX] || 8; this.ratioY = r[CX] || 16; return true;
      case 0x1b: r[BX] = this.ratioX; r[CX] = this.ratioY; r[DX] = 64; return true;
      case 0x1d: case 0x10: case 0x13: case 0x1c: return true; // 显示页、禁区、加速阈值、中断频率：忽略
      case 0x1e: r[BX] = 0; return true;
      case 0x1f: this.enabled = false; cpu.s[ES] = 0; r[BX] = 0; return true;
      case 0x20: this.enabled = true; r[AX] = 0xffff; return true;
      case 0x24: r[BX] = 0x0626; r[CX] = 0x0400; return true; // 驱动版本 6.26，PS/2 鼠标
      case 0x26: r[BX] = 0; r[CX] = this.maxX; r[DX] = this.maxY; return true;
    }
    return false;
  }

  /** 按显示模式设置默认的活动范围 */
  /** 驱动的虚拟屏幕高度：200 行的模式（包括文本模式）是 200，10h 是 350，12h 是 480 */
  screenH = 200;

  private setDefaultRange(mode: number): void {
    const vi = modeInfo(mode);
    this.screenH = vi.graphics && vi.height > 200 ? vi.height : 200;
    this.minX = 0; this.minY = 0;
    this.maxX = 639;
    this.maxY = this.screenH - 1;
  }

  /** 程序用 INT 10h 切换了显示模式：和真的鼠标驱动一样，按新模式重设移动范围 */
  modeChanged(mode: number): void {
    this.setDefaultRange(mode);
    this.clamp();
    this.version++;
  }
}
