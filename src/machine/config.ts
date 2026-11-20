export interface MachineConfig {
  bios: boolean;
  dos: boolean;
  mouseDriver: boolean;
  pic: boolean;
  slavePic: boolean;
  pit: boolean;
  keyboard: boolean;
  dma: boolean;
  rtc: boolean;
  vga: boolean;
  speaker: boolean;
  com1: boolean;
  com2: boolean;
  fdc: boolean;
  floppyA: boolean;
  floppyB: boolean;
  ide: boolean;
  cdrom: boolean;
  serialMouse: boolean;
}

export type StartupMode = 'debug' | 'dual' | 'full';

export const DEFAULT_CONFIG: Readonly<MachineConfig> = Object.freeze({
  bios: true, dos: true, mouseDriver: true,
  pic: true, slavePic: true, pit: true, keyboard: true, dma: true, rtc: true,
  vga: true, speaker: true, com1: true, com2: true, fdc: true,
  floppyA: true, floppyB: true, ide: true, cdrom: true, serialMouse: true,
});

export const CONFIG_OPTIONS: { key: keyof MachineConfig; label: string; software?: boolean }[] = [
  { key: 'bios', label: 'BIOS 服务（中断、数据区、ROM 参数表）', software: true },
  { key: 'dos', label: '浅层 DOS（INT 20h/21h、PSP、环境变量、MCB）', software: true },
  { key: 'mouseDriver', label: '内置鼠标驱动（INT 33h）', software: true },
  { key: 'pic', label: '主 8259 中断控制器' },
  { key: 'slavePic', label: '从 8259 中断控制器' },
  { key: 'pit', label: '8253 定时器' },
  { key: 'keyboard', label: '键盘 / 8042 控制器' },
  { key: 'dma', label: '8237 DMA 控制器' },
  { key: 'rtc', label: 'CMOS / RTC 实时钟' },
  { key: 'vga', label: 'VGA 显卡' },
  { key: 'speaker', label: 'PC 喇叭' },
  { key: 'com1', label: 'COM1 串口' },
  { key: 'com2', label: 'COM2 串口' },
  { key: 'fdc', label: '82077 软驱控制器' },
  { key: 'floppyA', label: 'A: 软驱（安装状态，与是否插盘无关）' },
  { key: 'floppyB', label: 'B: 软驱（安装状态，与是否插盘无关）' },
  { key: 'ide', label: 'IDE 第一通道（C: / D: 硬盘）' },
  { key: 'cdrom', label: 'IDE 第二通道 / ATAPI 光驱' },
  { key: 'serialMouse', label: 'Microsoft 串口鼠标（COM2，需要客体驱动）' },
];

export function configWarnings(c: Readonly<MachineConfig>): string[] {
  const out: string[] = [];
  if (c.serialMouse && !c.com2) out.push('串口鼠标需要 COM2；当前不会连接鼠标。');
  if (c.slavePic && !c.pic) out.push('没有主 PIC，从 PIC 的中断无法传给 CPU。');
  if (c.fdc && !c.dma) out.push('没有 DMA，软驱控制器的 DMA 传输不可用。');
  if (!c.fdc && (c.floppyA || c.floppyB)) out.push('没有软驱控制器，A:/B: 软驱不可用。');
  if (!c.floppyA && c.floppyB && c.fdc) out.push('只安装 B:：部分 DOS 只按软驱数量枚举，可能不能正确识别这种配置。');
  if (!c.pic || !c.pit || !c.keyboard || !c.vga || !c.bios) out.push('关闭基础设备或 BIOS 后，依赖它们的示例和操作系统可能无法运行；不会自动补装。');
  if (!c.dos) out.push('不预设 DOS 环境；直接调试中依赖 INT 21h 或 COM 的 RET 退出方式将不可用。');
  return out;
}
