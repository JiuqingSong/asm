// 汇编器共享的数据结构

export interface Diag {
  line: number;      // 源文件行号（从 1 开始）
  col: number;       // 列（从 0 开始，-1 表示整行）
  message: string;
  severity: 'error' | 'warning';
}

/** 段或组都可以作为"帧"（段寄存器指向的位置） */
export interface Frame {
  kind: 'segment' | 'group';
  name: string;
  /** 布局后：相对于映像起点的段落号 */
  para: number;
}

export interface Segment extends Frame {
  kind: 'segment';
  align: number;          // 字节对齐：1 2 16 256
  combine: string;        // public stack common private ...
  cls: string;            // 类名，如 CODE DATA STACK
  group: Group | null;
  bytes: number[];        // 内容（-1 表示未初始化）
  pc: number;             // 当前位置
  size: number;           // 最大位置
  loadStart: number;      // 映像从这个偏移开始（ORG 100h 时为 100h）
  orgSeen: boolean;
  emitted: boolean;
  /** 布局后：在帧（所属组或自身）中的偏移 */
  offsetInFrame: number;
  /** 布局后：线性起始地址（相对映像起点） */
  start: number;
  order: number;
}

export interface Group extends Frame {
  kind: 'group';
  segments: Segment[];
}

export type SymKind = 'label' | 'var' | 'const' | 'text' | 'segment' | 'group' | 'macro';

/** 类型值：1/2/4/8/10 为数据大小；NEAR/FAR 为代码标号 */
export const T_NEAR = 0xff02;
export const T_FAR = 0xff05;

export interface Sym {
  name: string;          // 原始大小写
  kind: SymKind;
  seg: Segment | null;
  offset: number;        // 段内偏移（label/var）或常数值（const）
  type: number;          // 0 / 1 2 4 8 10 / T_NEAR / T_FAR
  length: number;        // LENGTH：第一项为 DUP 时是重复次数，否则为 1
  size: number;          // SIZE = LENGTH * TYPE
  lengthof: number;      // LENGTHOF：数据项总个数
  sizeof: number;        // SIZEOF：总字节数
  text?: string;         // 文本宏内容
  redefinable?: boolean; // 用 = 定义的常量
  line: number;
  pass: number;          // 最后一次定义它的遍数
  frame?: Frame;         // segment/group 符号
}

export interface ListingEntry {
  line: number;
  seg: Segment;
  offset: number;
  bytes: number[];       // -1 表示未初始化
  isCode: boolean;
}

export interface ProgramSymbol {
  name: string;
  kind: 'label' | 'var' | 'const' | 'proc';
  segName: string;
  /** 运行时的段值和偏移（已加上装载段） */
  segment: number;
  offset: number;
  type: number;
  /** 数据项总个数 */
  length: number;
  /** 总字节数 */
  size: number;
  line: number;
  value?: number;        // 常量的值
}

export interface Program {
  ok: boolean;
  /** 程序用到的最高指令集：0 = 8086，1 = 80186，2 = 80286，3 = 80286 特权指令（汇编器生成的程序才有） */
  cpu?: number;
  diagnostics: Diag[];
  format: 'exe' | 'com' | 'boot';
  /** format 为 boot 时：从哪个 BIOS 驱动器启动（0 = A:，80h = C:） */
  bootDrive?: number;
  /** 程序映像装载的段（PSP 在它前面 0x10 个段落） */
  loadSeg: number;
  pspSeg: number;
  /** 需要拷入内存的块：线性地址 + 字节 */
  chunks: { addr: number; bytes: Uint8Array }[];
  /** 需要 DOS 装载器重定位的段地址字（线性地址；汇编器输出时提供） */
  relocations?: number[];
  entry: { cs: number; ip: number };
  stack: { ss: number; sp: number };
  /** 源码行 -> 该行生成的指令起始线性地址 */
  lineToAddrs: Map<number, number[]>;
  /** 指令起始线性地址 -> 源码行 */
  addrToLine: Map<number, number>;
  symbols: ProgramSymbol[];
  listing: { line: number; segment: number; offset: number; bytes: number[]; isCode: boolean; segName: string; segOffset: number }[];
  /** 各段内容（bytes 中 -1 表示未初始化），addr 为段内偏移 0 的线性地址 */
  segments: { name: string; addr: number; size: number; loadStart: number; bytes: number[] }[];
  /** 映像范围（线性地址） */
  imageStart: number;
  imageEnd: number;
  /** 默认数据段（用于内存窗口初始显示） */
  dataSeg: number;
}
