// BIOS ROM 里 INT 10h 的桩代码：先进入陷阱（JavaScript 完成功能），切换显示模式后再用真正的 OUT 指令
// 把这个模式的 VGA 寄存器值写到端口上，需要的话再用 REP STOSW 清屏。
//
// 为什么要这样：Windows 386 增强模式的显卡驱动（VDDVGA）在虚拟 8086 模式下调用 INT 10h 切换模式，
// 它靠截获 3C0h~3DFh 端口的读写来记住显卡的状态，DOS 窗口里的显存也是它安排的。如果模式完全在 JavaScript 里切换，
// 驱动看不到寄存器的变化，以为显卡还在原来的模式，或者改动了正在显示的 Windows 画面。
// 清屏也必须在寄存器换好以后做：显存怎么映射（平面、奇偶、链式）由寄存器决定。
//
// 陷阱处理函数切换模式后把寄存器表写到 F000:0900（杂项输出 1 字节、定序器 5、CRTC 25、图形控制器 9、
// 属性控制器 10h~14h 5 个，共 45 字节），清屏参数写在后面（段、字数、填充的字），并把 F000:08FF 置位：
// 位 0 = 写寄存器，位 1 = 清屏。

export const STUB_INT10 = 0x0840;
export const VGA_TABLE = 0x0900;
export const VGA_FLAG = 0x08ff;
/** 清屏参数：段、字数、填充值（各一个字） */
export const VGA_CLEAR = VGA_TABLE + 45;

const lo = (v: number) => v & 0xff, hi = (v: number) => v >> 8;

/** 输出一组带索引的寄存器：DX = 索引端口，CX = 个数，AH = 起始索引，CS:SI 指向数值（12 字节） */
const INDEXED_LOOP = [
  0x88, 0xe0,       // mov al, ah
  0xee,             // out dx, al
  0x42,             // inc dx
  0x2e, 0xac,       // lods byte ptr cs:[si]
  0xee,             // out dx, al
  0x4a,             // dec dx
  0xfe, 0xc4,       // inc ah
  0xe2, 0xf4,       // loop 上面
];

export function int10Stub(trap: number): number[] {
  const clear = [
    0x2e, 0x8e, 0x06, lo(VGA_CLEAR), hi(VGA_CLEAR),         // mov es, cs:[段]
    0x2e, 0x8b, 0x0e, lo(VGA_CLEAR + 2), hi(VGA_CLEAR + 2), // mov cx, cs:[字数]
    0x2e, 0xa1, lo(VGA_CLEAR + 4), hi(VGA_CLEAR + 4),       // mov ax, cs:[填充值]
    0x31, 0xff, 0xfc, 0xf3, 0xab,                           // xor di,di / cld / rep stosw
  ];
  const body = [
    0x50, 0x52, 0x51, 0x56, 0x57, 0x06,                     // push ax dx cx si di es
    0x2e, 0xa0, lo(VGA_FLAG), hi(VGA_FLAG), 0x50,           // mov al, cs:[标志] / push ax
    0x2e, 0xc6, 0x06, lo(VGA_FLAG), hi(VGA_FLAG), 0x00,     // mov byte ptr cs:[标志], 0
    0xbe, lo(VGA_TABLE), hi(VGA_TABLE),                     // mov si, 0900h
    0xba, 0xc2, 0x03, 0x2e, 0xac, 0xee,                     // 杂项输出：mov dx,3C2h / lods cs: / out
    0xba, 0xc4, 0x03, 0xb9, 0x05, 0x00, 0x30, 0xe4,         // 定序器 0~4：mov dx,3C4h / mov cx,5 / xor ah,ah
    ...INDEXED_LOOP,
    0xba, 0xd4, 0x03, 0xb8, 0x11, 0x00, 0xef,               // CRTC：先清 11h 的写保护（out 3D4h, 0011h）
    0xb9, 0x19, 0x00, 0x30, 0xe4,                           // CRTC 0~18h：mov cx,25 / xor ah,ah
    ...INDEXED_LOOP,
    0xba, 0xce, 0x03, 0xb9, 0x09, 0x00, 0x30, 0xe4,         // 图形控制器 0~8
    ...INDEXED_LOOP,
    0xba, 0xda, 0x03, 0xec,                                 // 属性控制器：读 3DAh 回到"写索引"状态
    0xba, 0xc0, 0x03, 0xb9, 0x05, 0x00, 0xb4, 0x10,         // mov dx,3C0h / mov cx,5 / mov ah,10h
    0x88, 0xe0, 0xee, 0x2e, 0xac, 0xee, 0xfe, 0xc4, 0xe2, 0xf6, // 索引、数值交替写到 3C0h
    0xb0, 0x20, 0xee,                                       // 打开显示（索引的位 5）
    0x58, 0xa8, 0x02, 0x74, clear.length,                   // pop ax / test al,2 / jz 不清屏
    ...clear,
    0x07, 0x5f, 0x5e, 0x59, 0x5a, 0x58,                     // pop es di si cx dx ax
  ];
  return [
    0xf1, trap,                                             // 陷阱：JavaScript 处理 INT 10h
    0x2e, 0x80, 0x3e, lo(VGA_FLAG), hi(VGA_FLAG), 0x00,     // cmp byte ptr cs:[标志], 0
    0x75, 0x03,                                             // jne 下面
    0xe9, lo(body.length), hi(body.length),                 // jmp 结束
    ...body,
    0xcf,                                                   // iret
  ];
}
