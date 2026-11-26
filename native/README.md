# C++ 原生 DOS / Windows 虚拟机（Windows）

独立的 Windows 桌面程序，不使用浏览器、JavaScript、.NET、DOSBox 或硬件虚拟化。
现有 TypeScript 网页版保持不变。

首版提供 8086/8088 指令语义、20 位地址空间、640KB 常规内存、单片 PIC、PIT、
键盘、40/80 列彩色文本显示，以及高层 BIOS 和持久化磁盘映像。
在此基础上已加入可选的 80286 / AT 平台、16 位保护模式、VGA 图形，
以及接在 COM1 的 Microsoft 串口鼠标。
已用本地 MS-DOS 6.22 三张安装盘验证：空白硬盘分区、格式化、完整安装、换盘、
重启、VER、建立目录、文件复制，以及退出程序后从硬盘冷启动并读回文件。
8088 和 286 两种模式均通过上述安装验证。Windows 3.1 英文版六张安装盘已完成
真实安装，并在独立进程中从硬盘冷启动、以标准模式进入 Program Manager；
已验证 COM1 驱动接收鼠标移动，光标位置随之改变，并能双击打开 File Manager。
实时调度已在 286 与实验性 386 的正常档、全速档验证按下/释放各间隔约 100ms 的双击打开 File Manager。
实验性的 80386 / AT 已通过真实 Windows 3.1 增强模式安装与 `WIN /3` 冷启动：
Program Manager、COM1 鼠标双击打开 File Manager、键盘操作均已验证，
系统“关于”对话框明确显示 **386 Enhanced Mode**。这不代表完整的 386 或全部增强模式应用兼容性。
另已验证增强模式正常退出回到 DOS、继续执行命令，以及磁盘写入经刷新后重新启动仍可读回。
中文版 Windows 3.2 已用用户安装好的硬盘副本验证 `WIN` 冷启动、COM1 鼠标双击打开文件管理器及键盘菜单操作，
“关于”窗口确认版本 3.2 和 386 增强方式，仍归于实验性 386 支持。
其启动所需的 `INT 10h / AX=1124h` 会设置图形字体指针和行高、行数；
字体查询返回当前几何信息，不再固定报告 25 行。
Windows 3.1 / 3.2 增强模式的 MS-DOS 会话已验证：执行 `VER`、Alt+Enter 全屏/窗口切换、
窗口内命令输入及文件写入、`EXIT` 返回桌面，并在重启后读回文件。
实验性 486 档位也已通过 Windows 3.1 / 3.2 增强模式冷启动及上述 DOS 会话验证。
IRQ1 固件通过客户机 `IN 60h` 接收虚拟扫描码；文本、属性与字体使用真实 VGA 平面布局，
避免绕过 Windows 的虚拟键盘或让 DOS 窗口抓取到空白文本。
MS-DOS EDIT 已验证在 8088 和 286 上输入文字、通过 Alt+F 菜单保存、退出，
以及独立冷启动后读回保存的文件。
Windows 95 已完成真实安装，验证窗口/全屏 DOS 命令、`EXIT` 返回桌面及 APM 自动关机。
Windows 95 OSR2 完整安装由用户确认。Windows 9x 支持仍属实验性，不代表所有驱动或应用兼容。
Windows 98 的完整安装、重新启动及安装后基本操作也已由用户验证。

## 性能基准

```powershell
.\native\build\native-tests.exe --benchmark
# VGA graphics conversion only (no GDI presentation):
.\native\build\native-tests.exe --benchmark-video
```

使用不访问磁盘、注册表或用户设置的确定性 486 指令循环，分别测量实模式寄存器、
分页 VM86 寄存器、分页 VM86 内存和分页 32 位保护模式内存负载。
每项预热后重复五次，每次执行一百万步，输出吞吐量中位数、最小值、最大值及最终状态校验值。
运行期间尽量关闭其它高负载任务；混合核心 CPU 比较不同构建时，应让测试进程使用同一个核心。
这是解释器微基准，不包含窗口绘制、磁盘访问或完整 Windows 启动，MIPS 不等同于模拟 CPU 的 MHz。

普通 RAM 的物理字／双字读取使用连续读取路径，以减少分页时读取页表项的逐字节开销；
跨页、地址回绕、A20 边界及 MMIO 访问保留逐字节语义。不缓存页表翻译，不改变客体计时、
页保护、访问／脏位或设备读取副作用。

同一 4KiB 页内的字／双字内存操作，在页目录和页表均为普通 RAM、且无写入观察回调时，
仅对本次操作查一次页表；跨页、MMIO 页表及写入观察回调保留逐字节翻译。
段检查、页权限与访问／脏位、对齐异常优先级及跨页存储的预检查不变；
不跨操作缓存翻译，客体直接修改页表后下一次访问立即生效。
386/486 的字／双字取指也在同页、段界限及 15 字节指令长度允许时使用连续 RAM 路径；
代码或页表涉及 MMIO 时仍按原顺序逐字节取指，保留读取副作用和异常位置。

`--benchmark-video` 分别测量五种 VGA 图形模式，每项预热后重复五次，每次转换 30 帧，
输出每帧耗时的中位数、最小值、最大值及像素校验值。GUI 和无界面的 `frame` 命令共用
批量转换路径：每帧计算调色板，再按显存字节展开像素，避免逐像素重复查询显示状态与颜色。
每帧重新读取 VGA 状态，不缓存显存或调色板；CRTC 起始地址／步幅、平面屏蔽、PEL mask、
调色板变更及屏幕消隐仍立即生效。此基准不包括 GDI 缩放和窗口呈现，不能等同于整机提速。

文本显示每帧读取当前活动页和调色板，将每行中属性相同的连续字符合并成一次 GDI 绘制，
减少启动时逐字符调用的开销；仍按 8×16 单元格定位，不缓存文本或改变光标闪烁。
`--ui-test` 会将合并绘制与原逐格绘制逐像素比较，覆盖 CP437 字符、40/80 列、
属性切换、活动页、调色板变更和消隐。

## APM 自动关机

AT（286 / 386 / 486）提供 APM 1.2 实模式 / VM86 BIOS 接口（`INT 15h / AH=53h`），
支持发现、连接、版本协商、启用/接管、电源状态查询及整机断电请求。
Windows 95 正常关机后会自动进入虚拟机关机状态、刷新硬盘并将屏幕变黑；
需从 Machine 菜单重新选择启动盘才能再次启动。8088 / XT 不提供 APM。
当前不提供保护模式 APM 调用入口、ACPI、待机、挂起或休眠；
能力查询不声明这些功能，未支持的请求返回 APM 错误。

## 构建

使用 Zig 0.14.1 的 Clang C++ 编译器，除 Windows 系统库外没有运行时依赖：

```powershell
$env:ZIG = 'C:\tools\zig\zig.exe'
.\native\build.ps1
```

输出为 `native\build\asm86-native.exe`，可独立运行。`native-tests.exe` 是测试程序。
构建使用 C++17，开启 `-Wall -Wextra -Werror`；`-Debug` 可关闭优化。
构建也将仓库现有 Berkeley SoftFloat C 源码及共享数值内核编译成原生静态库，
不需要 WASM 运行时或额外下载。分发程序时请同时附带输出目录中的
`softfloat-license.txt`，保留其第三方许可声明。

## 启动

启动时恢复上次选择的硬盘；首次使用可显式加载 `native\dos622.img`：

```powershell
.\native\run.ps1
# 首次选择 DOS 硬盘（以后无需重复指定）：
.\native\run.ps1 -HardDisk '.\native\dos622.img'
# 不限速启动：
.\native\run.ps1 -FullSpeed
# 运行另行安装了 Windows 3.1 的硬盘：
.\native\run.ps1 -Cpu 286 -HardDisk '.\native\win31.img' -FullSpeed
# 运行包含增强模式组件的独立 Windows 3.1 安装：
.\native\run.ps1 -Cpu 386 -HardDisk '.\native\win31-386.img' -FullSpeed
# 使用实验性 486DX 核心（带 x87）：
.\native\run.ps1 -Cpu 486 -HardDisk '.\native\win31-386.img' -FullSpeed
# Windows 98：避免安装器测速受宿主负载影响：
.\native\run.ps1 -Cpu 486 -StableTiming -FullSpeed
# 挂载 ISO（需在客体中加载 ATAPI 光驱驱动和 MSCDEX）：
.\native\run.ps1 -Cpu 486 -Cdrom 'D:\images\install.iso'
# 或直接指定映像：
.\native\build\asm86-native.exe --hard 'D:\images\dos622.img' --boot c
# 创建后续 Windows 安装用的 504 MiB 硬盘（目标必须不存在）：
.\native\build\asm86-native.exe --create-hard 'D:\images\win95.img' 504 --cpu 486
```

GUI 启动时恢复上次的软盘、CPU 和速度设置，机器保持关机、屏幕全黑；
`run.ps1` 或命令行加载映像也不会自动开机，用菜单选择启动设备。
`--boot a/c` 仅在 `--headless` 脚本模式自动引导，GUI 仍需菜单启动：

- **Disks > Create C: hard disk > 31.5 / 126 / 504 MiB**：按容量新建空白硬盘，绝不覆盖已有文件。
  命令行 `--create-hard <路径> [31.5|126|504]` 也支持容量选择，省略时仍为 31.5 MiB。
- **Disks > Open C: hard disk**：打开已有硬盘；替换硬盘前先用 **Machine > Power off** 关机。
- **Disks > Insert A: floppy**：插入或切换安装盘，可在安装过程中换盘，不会重启机器。
- **Disks > Eject A:**：取出软盘。
- **Disks > Insert ATAPI CD-ROM / Eject ATAPI CD-ROM**：在 AT 平台挂载或取出只读 ISO；
  不重启机器，尊重客体的锁盘状态，正在传输时拒绝换盘。光盘路径暂不保存。
- **Machine > Boot / restart from A: / C:**：从指定设备启动或重启。
- **Machine > Power off**：释放鼠标和按键、停止执行、刷新硬盘，屏幕立即变黑；
  保留已加载映像、CPU 和速度选择，再从 A:/C: 引导即可重新开机。
- **Machine > Ctrl+Alt+Del**：与现有组合键相同，释放输入并重启客体；
  有软盘时从 A: 启动，否则从 C: 启动，保留 CPU 型号和速度设置，不触发宿主安全界面。
  快捷键为 **右 Ctrl+Del**，左 Ctrl+Del 保留给客体；右 Ctrl 单独按下仍释放鼠标。
  持续按住 Del 不重复重启，关机状态禁用此重启功能，需从菜单选择 A:/C: 开机。
- **Machine > Full speed**：勾选时取消执行限速，再次点击恢复正常速度，无需重启客体。
  标题栏显示 **Full speed / Normal speed**；首次运行默认正常速度，以后自动记住选择。
  正常档随 CPU 型号切换：8088 约 0.33 MIPS，286 约 2 MIPS，386 约 4 MIPS，486 约 8 MIPS；标题栏显示当前档位。
  这是指令吞吐量近似值，不代表周期精确的 CPU 主频。
- **Machine > Stable CPU timing (Windows 98)**：仅用于 486，默认关闭，选择会记忆。
  启用后按执行的指令量推进忙碌 CPU 的虚拟时间，安装器测速不再依赖宿主负载；
  宿主较慢时客体时间也会变慢。可配合 Full speed，菜单会标明 stable CPU timers。
  正常档在此模式下使用约 32 MIPS 的虚拟吞吐量。关闭后恢复原有实时计时，无时钟跳变。
  改变计时模式后应重新启动安装程序，避免一次测速跨越两种模式。
- **Machine > CPU: 8088 / CPU: 80286 / AT / CPU: 80386 / AT (experimental) / CPU: 80486DX / AT (experimental)**：
  停机后选择 CPU；首次运行默认 8088，以后自动记住选择；Windows 3.1 标准模式选择 286，
  增强模式可选择实验性 386 或 486。
  切换型号会重置机器，请先在客体中退出程序。
- **View > Maximize** 或标题栏最大化按钮：窗口最大化，DOS 内容随之等比放大，空余区域留黑。
- **View > Original size**：文本模式恢复到 **640×400 客户区**；
  图形模式恢复为当前像素尺寸，例如模式 13h 为 320×200，模式 12h 为 640×480。
  标题栏的普通还原按钮则恢复最大化之前的窗口大小。

窗口可自由调整大小，文字和背景作为整个画面一起缩放，不只是扩大黑色窗口。
文字使用匹配 8×16 单元格的 TrueType 字体；整帧在后台绘制后一次呈现，
重绘时不先清黑显示区域，避免字符被裁切和整屏闪烁（输入光标仍正常闪烁）。
菜单、标题栏和边框不计入 640×400；程序启用系统 DPI 感知。
键盘输入发送给客体；Ctrl+Alt+Del 从当前插入的软盘（若有）或硬盘重启。
宿主文件对话框和菜单保持 Windows 原生行为。因执行错误而停止时保留错误画面供排查，
这与明确选择 **Power off** 的黑屏关机状态不同。

硬盘路径、软盘路径（包括换盘和取出）、CPU 型号、速度和计时模式在选择成功后立即保存到当前 Windows
用户的注册表 `HKEY_CURRENT_USER\Software\Asm86\Native`，不依赖启动目录，也不需要管理员权限。
软盘保存为绝对路径；下次启动自动以只读方式重新插入。若文件已移动或不可读取，会明确提示，
让 A: 保持空盘；可重新插盘或选择 **Eject A:** 清除旧路径。
硬盘同样保存为绝对路径；下次启动自动加载。创建或打开另一硬盘成功后会更新记忆；
文件不可用时明确提示并让 C: 保持空盘，不偷偷改用 DOS 硬盘。启动设备仍不保存，程序仍以关机状态启动。
命令行的 `--hard`、`--create-hard`、`--floppy`、`--cpu`、`--full-speed` / `--normal-speed` 优先于已保存的对应设置，
并成为新的记忆值；`run.ps1` 未指定硬盘、CPU 或速度时也沿用已保存的选择，不再强制加载 `dos622.img`，
可用 `-Cpu 8088` / `-Cpu 286`、`-FullSpeed` / `-NormalSpeed` 显式覆盖。
`--stable-timing` / `--real-time-timing`（脚本对应 `-StableTiming` / `-RealTimeTiming`）
显式覆盖并保存计时模式；未指定时沿用记忆，脚本拒绝同时指定两个相反的开关。
`--headless` 和 `--ui-test` 不读取或修改这些用户设置，保证脚本和测试相互独立。

## VGA 图形与 COM1 鼠标

- VGA 图形模式：0Dh（320×200×16）、0Eh（640×200×16）、10h（640×350×16）、
  12h（640×480×16）、13h（320×200×256）。显示按当前像素宽高比缩放并留黑边。
- A0000h–BFFFFh 显存窗口经 VGA 控制器读写，支持四平面、锁存器、读模式 0/1、
  写模式 0–3、平面/位屏蔽、逻辑操作、chain-4、文本奇偶寻址、字体平面、属性调色板和 6 位 DAC。
  图形/文本状态、图形尺寸及 256 色选择按硬件寄存器决定，不依赖最后一次 BIOS 模式号；
  Windows 从全屏 DOS 直接恢复 VGA 寄存器时也能正确恢复画面。
- 支持 BIOS 切换模式、页 0 像素读写、16 色 XOR 绘图，以及调色板/DAC 读写。
  不提供 VBE/SVGA 扩展和显示器 DDC/EDID；`INT 10h / AH=4Fh` 返回失败状态 `AX=014Fh`，
  不填充虚假的显示器数据，也不会因 Windows 95 OSR2 的可选探测而停机。
  图形页 0 支持字符/字符串绘制、字符识别、光标及双向窗口滚屏，使用客体 INT 43h
  字体指针和 BIOS 字符高度；16 色字符支持 XOR，256 色保留完整颜色索引。
  无法按当前字体识别的像素返回字符 0；非零图形显示页仍会显式报错。
  BIOS 字符、滚屏及显示页服务遵循客体 BDA 中的逻辑模式，宿主显示仍按 VGA 硬件状态渲染；
  Windows 95 启动图隐藏的 DOS 文本输出不会被错误画到启动图上，VM86 文本窗口也不会改写宿主图形画面。
  VM86 模式切换只更新该虚拟机的 BIOS 状态，不直接重置物理 VGA；
  ROM 使用客体端口 I/O、字体复制和显存清屏指令，使 Windows 显示监控器能虚拟化 DOS 窗口或切换全屏。
- 未提供常驻 CAM SCSI 接口，INT 4Fh 向量保持为空，避免 Windows 95 将固件占位入口
  误识别为 SCSI 驱动。Windows 的可选 INT 68h 调试通知使用空 IRET 入口。
- 串口鼠标固定接在 **COM1：3F8h–3FFh，IRQ4**，不放在 COM2。
  实现鼠标驱动所需的 8250 基础功能：除数锁存器、收发状态、接收/发送/线路/调制解调器中断、OUT2 门控、
  回环及溢出状态；Microsoft 鼠标按 1200 baud、7N1 发送上电 `M` 标识和三字节数据包。
  字节按客体时间到达，大幅移动拆成多个数据包，不把整包瞬间塞入接收寄存器。
  默认 BIOS IRQ4 入口屏蔽未被驱动接管的串口中断并应答 PIC，保留寄存器和 UART 状态；
  Windows 95 关机卸载鼠标驱动后，继续移动鼠标不会落入未实现的 BIOS 服务。
- 客体需安装标准 Microsoft 串口鼠标驱动。驱动启用 COM1 后，点击显示区域捕获鼠标；
  按一下 **右 Ctrl** 释放；左 Ctrl 和 Ctrl+Alt 组合保留给客体使用。
  窗口失焦、停机或关闭时也会释放，不会一直锁住宿主鼠标。
  支持相对移动和左右键；暂不提供 INT 33h 驱动、PS/2 鼠标或中键/滚轮。

正常档限制 CPU 指令吞吐量；全速档在处理窗口消息的间隙尽可能多执行指令，
每约 8ms 交还控制权，画面仍约每 16ms 刷新。默认实时计时模式下，两档的 PIT、RTC、串口鼠标和
依赖这些设备的 Windows 计时均按宿主单调时钟推进，不随 CPU 吞吐量加速。
设备推进最多以 0.25ms 为一片，与 CPU 执行交替，避免窗口绘制后的时间追赶
把多字节鼠标包一次性塞入 UART；RTC 周期中断保持原有相位，不累积轮询误差。
正常档的空闲 CPU 预算不攒到唤醒之后；全速仍可能占用一个 CPU 核。
仅依赖忙等循环次数的软件仍可能受全速影响，并非周期精确模拟。
直接运行 EXE 时可加 `--full-speed` 或 `--normal-speed`。
正常/全速模式均在窗口失焦、被遮挡或最小化后继续运行；失焦只释放鼠标和按键，
不会自动停机。全速执行与有上限的消息处理交替进行，不再依赖消息队列完全空闲；
最小化时省略定时重绘，保留执行。切换速度不重置客体时钟；重新启动客体时重新建立计时基准。

## 安装 DOS 6.22

安装盘需要自行提供，本项目不包含或分发 DOS 文件。

1. 新建 C: 硬盘，插入第 1 张软盘，从 A: 启动。
2. 按 Setup 提示配置空闲磁盘空间并重启，确认设置和 `C:\DOS` 安装目录。
3. 提示时依次插入第 2、3 张软盘，再在客体中按 Enter。
4. 按提示取出软盘，完成最后的确认并重启。
5. 以后只打开该硬盘，从 C: 启动即可。

软盘始终以只读方式打开，原始安装盘不会被修改。硬盘直接按扇区写回并在每次
BIOS 写请求结束时刷新；同一映像不允许另一个进程同时写入。
客体的 FDISK/FORMAT 会修改所挂载的硬盘映像，请只使用专门创建的映像或备份。

支持 160/180/320/360/720KB、1.2/1.44MB 原始软盘映像。
软盘也识别附加 1024 字节 `[FileVersion 003]` 元数据的映像：
仅在尾部标识、BPB 容量及磁头/磁道参数一致时使用前面的标准软盘数据，
不把元数据当成额外扇区，也不修改或截断原文件。
硬盘采用
16 磁头、63 扇区/磁道的 CHS 布局，必须包含完整柱面，最大 1024 柱面（504 MiB）。
其他几何布局的已有硬盘映像不在本版支持范围内。
三种创建容量分别为 64/256/1024 柱面；BIOS 与 ATA IDENTIFY 报告一致的实际容量。
504 MiB 新盘已通过真实 DOS 6.22 的自动分区、格式化、完整安装及独立冷启动文件读回验证。

## 独立 IMG 工具

`image-tool.exe` 是独立命令行程序，`image-gui.exe` 是调用它的 Win32 包装界面，
不依赖虚拟机、浏览器或管理员权限；两个 EXE 应放在同一目录。
正常构建会同时生成它们，也可仅构建工具：

```powershell
.\native\build-image-tools.ps1 -Zig 'C:\tools\zig\zig.exe'
.\native\build\image-gui.exe
# 虚拟机 EXE 正在使用时，可构建到独立目录，不关闭当前窗口：
.\native\build.ps1 -OutputDirectory '.\native\build\image-utilities'
```

图形界面提供硬盘 **31.5 / 63 / 126 / 252 / 504 MiB**，软盘
**160 / 180 / 320 / 360 / 720 / 1200 / 1440 KiB**。
默认新建已格式化数据盘：软盘 FAT12，硬盘 MBR 加单一 FAT16 主分区，
沿用 16 磁头、63 扇区布局和 DOS 常用簇大小。勾选 **Raw zeros** 则创建纯零空盘。
硬盘 MBR 使用自编的 8088 兼容引导代码：定位唯一活动分区、由 LBA 计算 CHS，
读取并跳转到该分区引导扇区；支持完整 504 MiB 范围，不依赖分区表中的旧 CHS 值。
两者都不包含 DOS 系统文件；数据盘不能直接启动 DOS，安装系统仍需启动盘和安装程序。
容量上限集中在 `image.h`，未来更大硬盘仍需同步扩展分区、文件系统和虚拟机支持，
首版不会接受超过 504 MiB 的容量。

```powershell
.\native\build\image-tool.exe create-hard 'D:\images\data.img' --size 126
.\native\build\image-tool.exe create-hard 'D:\images\blank.img' --size 504 --raw
.\native\build\image-tool.exe create-floppy 'D:\images\files.img' --size 1440
.\native\build\image-tool.exe put 'D:\images\data.img' 'D:\files\SETUP' 'D:\files\README.TXT' --dest '\INSTALL'
.\native\build\image-tool.exe list 'D:\images\data.img' --dir '\INSTALL'
```

命令行硬盘容量单位为 MiB，接受可精确表示完整柱面的十进制大小，不仅限于界面预设。
格式化 FAT16 最小 10 柱面（4.921875 MiB），纯零盘最小 1 柱面。
图形界面可一次拖入多个文件或文件夹，多层子目录递归导入并保留结构；
也可用 **Add files / Add folder**。目标目录不存在时创建，默认不覆盖已有文件；
`--overwrite` / 界面复选框仅允许替换普通文件，不覆盖目录、只读/隐藏/系统文件或长名别名文件。
列表为待导入队列，点 **Import all** 才写入；**List target** 可查看映像中的目标目录和剩余容量。

首版导入只支持 FAT12/FAT16，以及 **ASCII DOS 8.3 文件名**（转换为大写），
不自动截断长文件名、不生成别名；宿主上层路径和 IMG 路径可包含 Unicode。
源文件夹中不符合 8.3 的名称、符号链接或 junction 会明确报错。
FAT32、NTFS、扩展分区及多 DOS 主分区映像暂不支持。
已有映像的启动代码、分区表和其他未修改数据保持不变。

请先从虚拟机中卸载映像。工具拒绝已挂载/正在写入的映像；
导入在内存中修改副本，按文件簇、目录及 FAT 的实际空间检查。
总容量不足、根目录已满、源文件读取失败、文件名冲突或损坏 FAT 均报错，原 IMG 不变。
全部成功后将临时文件写在原文件旁、刷新，并原子替换原 IMG。
导入需要 **Windows 10+ 和支持 POSIX 原子重命名的文件系统（已验证本机 NTFS）**；
不支持时明确失败，不降级为原地写入。
因此需约一个 IMG 容量的内存，以及原目录中额外一个 IMG 容量的空闲空间。
新建映像永远不覆盖已有目标文件。

### 引导扇区导出／导入

界面下方的 **Boot sector** 使用上方 **Open IMG** 选择的映像。
选择 **Floppy boot sector / Hard disk MBR / Hard disk partition boot sector**，
分区引导扇区另选主分区表槽位 1–4，再选择 BIN 路径并点击 **Export sector / Import sector**。
导出为原始 **512 字节** BIN，不自动覆盖已有输出。

```powershell
.\native\build\image-tool.exe boot-export 'D:\images\floppy.img' 'D:\images\floppy-boot.bin' --sector floppy
.\native\build\image-tool.exe boot-export 'D:\images\data.img' 'D:\images\mbr.bin' --sector mbr
.\native\build\image-tool.exe boot-export 'D:\images\data.img' 'D:\images\vbr.bin' --sector partition --partition 1
.\native\build\image-tool.exe boot-import 'D:\images\data.img' 'D:\images\vbr.bin' --sector partition --partition 1
# 明确替换全部 512 字节（包括 BPB 或分区表），操作前备份：
.\native\build\image-tool.exe boot-import 'D:\images\data.img' 'D:\images\mbr.bin' --sector mbr --full
```

导入文件必须恰好 512 字节，默认 **仅替换引导代码**：

- MBR 替换 0–439 和签名字节 510–511，保留磁盘标识、保留字节及分区表 440–509。
- FAT12/FAT16 卷引导扇区替换开头跳转、BPB 后的代码及 55AA 签名；
  保留 OEM/BPB/扩展 BPB，包括卷标、序列号、容量、FAT 布局和隐藏扇区数。
  来源和目标必须具有有效、兼容的 BPB 头部格式，跳转不能进入保留的头部。
- 分区槽位是 MBR 主分区表中的位置，不是 DOS 盘符；按该槽位的 LBA 定位。
  空分区、越界分区、扩展分区和非 FAT12/FAT16 分区均拒绝。

**Full 512 bytes** / `--full` 则不合并或保留扇区内部字段，可用于完整恢复或未格式化介质。
这可能破坏文件系统或分区表；界面导入时必须再次确认，CLI 的显式 `--full` 即确认。
其他扇区和软盘元数据尾部保持不变，仍遵守挂载互斥、临时副本、刷新与原子替换规则。
导入引导代码不等于安装 DOS，也不会自动放入系统文件；代码必须适合目标系统和布局。

### 修复旧数据盘 MBR

早期 IMG 工具生成的硬盘 MBR 只显示 `Non-system data disk`，不会执行分区引导扇区，
因此即使随后安装了 DOS，也可能被这个占位 MBR 阻挡。新版新建硬盘已改用上述分区引导代码；
已有映像不自动改动，可备份并卸载映像后修复：

```powershell
.\native\build\image-tool.exe boot-install-mbr 'D:\images\installed-dos.img'
```

界面选择 **Hard disk MBR** 后点击 **Install MBR**，无需提供 BIN。
仅更换 MBR 引导代码，保留磁盘标识、分区表、分区引导扇区及全部文件，
不格式化、不设置活动分区。要求已有唯一活动的 FAT12/FAT16 主分区且其范围有效；
无活动分区、多活动分区、错误分区标志或越界分区均拒绝。
软盘和卷引导扇区的“无系统数据盘”提示仍是正常的未安装系统状态。

### 工具验证

```powershell
.\native\build\image-tests.exe
$p = Start-Process .\native\build\image-gui.exe -ArgumentList '--ui-test' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw 'Image GUI check failed' }
```

测试包含全部预设容量、BPB/CHS、递归导入、空文件、目录扩展、显式覆盖、
多个源累计超容量回滚、挂载互斥和 FAT 损坏拒绝；界面测试通过拖放消息调用真实 CLI，
检查嵌套目录读回及超容量错误。生成的 FAT12 软盘和 FAT16 硬盘已由真实 DOS 读回文件。
引导扇区测试覆盖精确导出、MBR/卷 BPB 保留、主分区槽位及边界、
完整覆盖、无效输入回滚和挂载互斥；界面测试通过真实 CLI 完成导出、修改代码和导入，
并验证其余映像字节不变。
另执行真实 8088/286/386/486 指令测试，覆盖 MBR 重定位、第四分区槽位、
高于 255 的柱面、传递启动驱动号及无效引导信息，并验证 MBR 修复不改变系统文件。

## 安装和运行 Windows 3.1 标准模式

安装盘需要自行提供，本项目不包含或分发 Windows 文件。

1. 备份已安装 DOS 的硬盘映像，使用独立副本安装 Windows；不要同时挂载同一个可写映像。
2. 选择 **CPU: 80286 / AT**，挂载该硬盘，从 C: 启动。建议打开 **Full speed**。
3. 插入第 1 张 Windows 3.1 安装盘，在 DOS 输入 `A:\SETUP`。
4. 按提示安装，依次切换第 2 至第 6 张盘。鼠标使用 Microsoft 串口鼠标驱动，
   接口为 **COM1（3F8h，IRQ4）**，不需要改接 COM2。
5. 完成后取出软盘并重启；在 DOS 输入 `WIN /S`，进入 Windows 标准模式。

此处验证的是 **英文 Windows 3.1**。中文版 **Windows 3.2 要求 386 或更高 CPU**，
当前原生版的 286 模式不能运行；安装程序会正常提示处理器不满足要求，而不是因中文系统探测中断而停机。

286 模式提供 16 MiB 物理地址空间、A20 门、主从 8259 PIC、8042 键盘控制器、
CMOS/RTC 周期中断、扩展内存 BIOS 服务和 286 暖复位模式切换。
CPU 支持 186/286 指令、段描述符缓存、特权级、门、中断/异常、任务切换和 LOADALL。
这是经真实系统验证的兼容性实现，不代表完整的 286 硬件认证。

## 验证

```powershell
.\native\build\native-tests.exe
node .\native\test-cpu.mjs                    # 复用 test-data\8088 真机测试数据
node .\native\test-cpu.mjs --limit=100         # 每个操作码文件抽测 100 条

# 实际创建窗口，检查显示、全速/正常切换、键盘、重绘及停止：
$p = Start-Process .\native\build\asm86-native.exe -ArgumentList '--ui-test' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw 'UI check failed' }

# 三张 .img 按文件名排序必须依次为安装盘 1、2、3。
# 目标文件必须不存在；安装失败时保留映像供排查。
.\native\test-dos.ps1 -MediaDirectory 'D:\MS-DOS 6.22' -HardDisk 'D:\images\new-dos622.img'
# 同样验证 286 / AT：
.\native\test-dos.ps1 -Cpu 286 -MediaDirectory 'D:\MS-DOS 6.22' -HardDisk 'D:\images\new-dos286.img'
# 验证最大容量，原有默认仍为 31.5 MiB：
.\native\test-dos.ps1 -Cpu 286 -MediaDirectory 'D:\MS-DOS 6.22' -HardDisk 'D:\images\new-dos504.img' -HardDiskMiB 504
```

DOS 验证在同一个 C++ 执行核心上无窗口运行，向真实 Setup 发送键盘输入，
不预置文件系统或系统文件。安装后退出进程，再启动独立进程检查文件持久化。
临时脚本和输出日志自动清理，安装得到的硬盘保留。

`--headless <UTF-8 脚本>` 可用于复现问题。脚本每行一条指令：
`run <指令预算>`、`wait <屏幕文字>`、`expect <屏幕文字>`、`key ENTER/TAB/F1/...`、
`type <文字>`、`mount <软盘路径>`、`eject`、`mount-cd <ISO 路径>`、`eject-cd`、`boot a/c`。
`key ALT_DOWN` / `key ALT_UP` 可配合 `type f` 等操作测试 DOS 的 Alt 菜单；
按下、字母输入、释放之间用 `run` 留出键盘中断处理时间。
普通 `key` 和 `type` 均发送按下、释放扫描码；只有显式的 `ALT_DOWN` 会保持按下状态。
`type` 也发送字符所需的 Shift/Ctrl/Alt 扫描码，并在字符间留出处理时间，
因此 Windows 的虚拟 DOS 键盘可接收大写字母、冒号及重定向符号，而不是只依赖宿主传入 ASCII。
`wait` 最多执行十亿步，超时返回非零；显示文字出现后可用 `run 100000`
等待客体完成画面绘制及输入缓冲清理，再发送按键。
DOS 的 AUTOEXEC 命令回显也包含提示符；加载 HIMEM/SMARTDRV 后，实际键盘提示符可能
尚未就绪，冷启动验证在首次提示符后额外执行 `run 5000000`，避免过早输入丢键。
`screen <路径>` 保存屏幕文字，`frame <路径>` 保存当前图形画面为 BMP；
`state` 输出寄存器、保护模式/特权级、视频模式和 COM1 鼠标状态，
`dump <路径>` 保存诊断内存。
`mouse <dx> <dy> <buttons>` 经真实串口数据包注入相对移动和按键；
按钮掩码为 0（释放）、1（左键）、2（右键）、3（同时按下），随后用 `run`
推进客体时间，让 UART、IRQ4 和 Windows 鼠标驱动处理输入。
原有 `run` / `wait` 仍使用确定性的指令驱动时间，保持已有快速安装脚本的行为，
不读取 GUI 的已保存速度设置。`realtime <毫秒数> <normal|full>` 则使用与 GUI 相同的
实时调度器，适合验证计时和按人类时间间隔发送鼠标双击；例如 `realtime 100 full`。
宿主文件错误和未实现的 BIOS 功能会显式报错或通知，不伪装成磁盘成功。
对未安装的 MSHERC、EGA RIL、倚天中文键盘扩展和 QBASIC TSR，
按其探测约定返回“未安装”，不会伪装设备存在，也不会吞掉其他未知 BIOS 调用。
Windows 95 Setup 的 `INT 67h / AX=DE00h` VCPI 探测返回非零 AH，明确报告没有驻留 VCPI；
不会把该安装检查当成未实现中断而停机，也不宣告提供 EMS/VCPI 服务。

## ISA DMA 底座

XT 提供第一片 8237 的寄存器，AT 另提供第二片和级联通道；支持 8 位/16 位地址计数、
页寄存器、屏蔽、控制器禁用、递减地址、自动初始化及终点状态的读取清除。
外设传输使用物理内存总线，不经过 CPU 分页、CPL 或 CPU 的 A20 门，并保留 VGA MMIO。
8 位通道在 64 KiB 页内回绕，16 位通道按字计数并在 128 KiB 页内回绕；
计数 FFFFh 对应完整的 65536 个传输单位，非自动初始化通道到终点后屏蔽。
方向不匹配会向外设报告错误，不先修改内存或消费数据。

这是供 FDC 和后续声音设备使用的外设 DMA 底座；不包含内存到内存复制、
完整总线仲裁/周期时序，也不等同于 IDE DMA。已通过边界、物理寻址、MMIO、
级联及终点行为测试，并回归 Windows 3.2 增强模式与全部 8088 真机数据。

## IDE 硬盘控制器（AT）

286/386/486 的 C: 同时接在第一 IDE 通道主盘，使用与 BIOS 相同的磁盘映像；
端口为 `1F0h–1F7h` / `3F6h`，中断为 IRQ14。8088 保持原有 BIOS 磁盘接口。
已实现 IDENTIFY、CHS/LBA28 PIO 读写、READ/WRITE MULTIPLE、逻辑几何初始化、
PIO 传输模式、写缓存开关、FLUSH CACHE、软件复位、nIEN 及设备错误状态。
未挂载的从盘不会冒充第二块硬盘；DMA、PACKET 等未实现命令返回 ABRT。

数据端口的 16/32 位 IN/OUT、INS/OUTS 使用完整的 ATA 字传输，
不再将高字节误读写到相邻任务寄存器。命令完成按设备时钟延迟，再置 DRQ/IRQ；
读取备用状态不撤销中断，读取主状态才确认中断。
测试覆盖 286/386/486 客户机 PIO 指令、多扇区和 256 扇区计数、跨块数据、
读写错误、复位，以及写入后关闭/重新打开映像读回。
另已重新从三张原盘完成 286 DOS 安装，并在真实 DOS DEBUG 中执行自编机器码：
经 ATA PIO 读取的整个 512 字节扇区与 BIOS 读取结果逐字比较，286/486 均通过。
Windows 3.1/3.2 增强模式与 DOS 窗口流程也已回归，但不以这些测试代替 Windows 95 安装验证。

## 软驱控制器

A: 另提供 82077/765 风格控制器，端口为 `3F0h–3F5h` / `3F7h`，使用 IRQ6 和 DMA 通道 2；
BIOS INT 13h 与控制器访问同一软盘。保留现有菜单/命令行的只读挂载行为，
写命令返回写保护，不会修改用户的原始安装软盘。

支持复位、四次 SENSE INTERRUPT、驱动器状态、SPECIFY、CONFIGURE、VERSION、
锁定配置、寻道/复位磁头、READ ID，以及 MFM 512 字节扇区的 DMA/PIO 读写和格式化。
多磁道读跨越两个磁头，按 DMA 终点停止；DMA 被屏蔽时等待恢复，方向错误报告 overrun。
换盘使用独立介质标识，取出后重新插入同一路径也会终止旧传输，不保留悬空磁盘指针。
寻道独立排队，不存在的 B: 返回设备检查；无介质或电机关闭时等待驱动超时/复位，
不伪造成功数据。未实现的命令返回 invalid-command。

BIOS INT 13h 对 A:/B: 的读、写、校验和格式化会像真实 BIOS 一样，先由客体指令向 DOR（`3F2h`）
写入对应的电机/选择位（A: 为 `1Ch`，B: 为 `2Dh`），其余功能、硬盘和不存在的驱动器不写 DOR。
Windows 9x 的 HSFLOP 靠截获这次写入把 BIOS 驱动器映射到控制器单元；缺少它时找不到 A:，
其“无驱动器”出错路径会经空指针改写 INT 1Ah 向量的段地址，之后在 V86 中调用 INT 1Ah
（例如 Windows 98 安装末尾的日期/时间对话框）即出现 `001D:000010D0` 的异常 06 蓝屏。
HSFLOP 会把检测到的驱动器数缓存在注册表（`cdrvs` / `cIOSFlop`），
修复前安装的系统须清除该缓存一次或重新安装。

单元测试覆盖 8088/286/386/486、DMA/PIO、跨磁头、格式化、换盘及写保护。
另在真实 DOS DEBUG 中执行自编机器码，经控制器和 DMA 读取软盘首扇区，
与 BIOS 读取的全部 512 字节比较；286/486 均通过，并正常返回 DOS。
未实现精确旋转/寻道时序、FM、删除数据标记写入或任意扇区 ID 布局；
读操作可按 DMA 字节数提前结束，非整扇区 DMA 写入报 overrun 而不覆盖剩余数据。

## ATAPI 光驱（AT）

286/386/486 提供第二 IDE 通道主设备，端口为 `170h–177h` / `376h`，使用 IRQ15。
菜单、`--cdrom <ISO 路径>` 或 `run.ps1 -Cdrom` 可挂载只读的 2048 字节扇区映像；
ISO 按需读取，不整体装入内存。光驱与第一通道硬盘互不占用设备或中断。

已实现 IDENTIFY PACKET DEVICE、12 字节 PIO 命令包、16/32 位数据端口、
主/备用状态、中断屏蔽、复位、主机限定字节数的分段传输及奇数字节尾部填充。
SCSI/MMC 子集包含 INQUIRY、TEST UNIT READY、REQUEST SENSE、READ CAPACITY、
READ(10/12)、SEEK、READ TOC、MODE SENSE 和锁盘/退盘；换盘、无介质、越界和
不支持的命令返回相应错误或 sense，不用空数据伪装读取成功。不提供 DMA、音轨或刻录。

已使用 Windows 98 启动软盘中的真实 OAKCDROM.SYS / MSCDEX 挂载光驱，
列出原始安装 ISO 的文件，并将 PRECOPY1.CAB 的 1,331,200 字节复制到独立硬盘副本；
退出虚拟机后解析 FAT16，确认持久化文件与 ISO 原文件逐字节一致。
Windows 95 OSR2 启动软盘中的 NEC IDE 驱动及 MSCDEX 也已识别光驱。
这些光驱测试只证明 DOS 启动环境和读取，不代表 Windows 98 已安装或进入桌面。
当前仍从 A:/C: 启动；未实现 El Torito 光盘启动，请使用启动软盘加载光驱驱动。

## 386 增强模式开发状态

8088 和 286 保持原有使用方式；386 现以 **experimental** 标记加入菜单、CPU 记忆设置、
`--cpu 386` 和 `run.ps1 -Cpu 386`。真实 Windows 3.1 安装已包含增强模式组件，
不带 `/B` 的 `WIN /3` 可在默认 SMARTDrive 配置下冷启动到桌面，且已验证文件管理器与 COM1 鼠标交互。
原来只在 286 下安装的硬盘可能没有 `WIN386.EXE`；请先复制硬盘，在 386 下用原始六张安装盘
重新运行 Windows Setup 补齐组件，不要只修改启动命令或覆盖唯一的已安装硬盘。

机器层现已接入 386 的 AT 双 PIC、8042、A20 和 RTC。BIOS 的键盘、计时、视频状态和磁盘缓冲区
按当前客体页表访问，避免 VM86 下误读写物理页零。显卡模式设置除更新 BIOS 状态外，还由 ROM
中的客体代码执行 VGA 端口读写，让 Windows VDD 能正常拦截并维护模式缓存，而不是绕过 VMM。
专用诊断入口 `--experimental-386 --headless <脚本>` 仍可使用；它不能与 `--cpu` 或 `--ui-test`
组合，会保留三重故障的错误现场而非自动复位，并限量输出无效指令异常探测记录。
Windows 用于 CPU 探测与 VM86 回调的部分无效指令异常是正常的客体行为，并不代表启动失败。

内部已加入可测试的 386 底座：32 位通用寄存器与 16/8 位别名、EIP、66h/67h 前缀、
FS/GS、SIB 寻址、主要 32 位整数/串操作、32 位代码/数据/栈段、CR0/CR2/CR3 和
两级 4KB 分页。测试覆盖从实模式进入平坦 32 位代码、超过 64KB 的 EIP、超过 1MB 的
数据与栈访问、页权限和访问/脏位、缺页错误码与跨页写入，以及已有 8088/286 回归。
这不等于完整的 386 指令与系统支持；未完成的路径会报错，不会宣称启动成功。
另已补齐 Windows 95/98 DOS 启动所需的 LSS/LFS/LGS 远指针加载，
包含 16/32 位目的操作数和 LSS 后一条指令的中断屏蔽。

内部系统层已加入 16/32 位中断门、陷阱门和调用门，386 TSS 的 LTR、特权栈、
调用门参数复制、RETF/IRETD，以及保护模式任务切换和嵌套任务返回。
系统表和 TSS 使用 supervisor 线性地址访问；分页任务切换验证了 CR3 切换后执行与返回。
测试还覆盖特权检查、失败时的寄存器/栈帧保护、RF 恢复，以及缺页与双重故障的嵌套分类。
虚拟 8086 核心已支持通过 IRETD 或 386 TSS 进入、16 位默认执行与 32 位前缀、
实模式段地址及 64KB 限制、用户态分页，以及经中断/陷阱门或任务门退出到保护模式。
中断门保存完整的九双字现场（另有适用的错误码），清空数据段，并允许监控程序用 IRETD 恢复。
CLI/STI、PUSHF/POPF、INT n 和 IRET 按 IOPL 拦截；HLT 仍要求 0 级。
端口 I/O 检查 386 TSS 位图，包括 VM86 下的 IOPL=3、多字节/字符串 I/O、
位图边界和 supervisor 分页访问；被拒绝的访问不会先读写部分设备字节。

新增机器码测试使用客体保护模式监控程序，将 IOPL=0 下的 INT 21h 经 IVT 反射给
16 位处理程序，再拦截并模拟其 IRET；这不依赖宿主直接调用 DOS 或绕过保护规则。
另有 VM86 任务切换、硬件中断、缺页恢复和字符串 I/O 副作用测试。
中断反射是客体监控程序的职责，CPU 不会把 VM86 中断直接偷送给实模式 IVT。

LAR/LSL 已支持 32 位结果和适用的 386 系统描述符。调试寄存器已实现 DR0–3、DR6/DR7
的读写、保留位、GD 异常及单步状态，满足当前 VMM 初始化；启用硬件地址断点和任务切换
调试陷阱仍会明确报错，DR4/DR5 不受支持。386 兼容性仍以真实系统和应用回归逐步扩展，
不能仅凭合成 CPU 测试或一次成功启动宣称所有增强模式功能均已完成。

## 实验性 486DX 核心

菜单、`--cpu 486` 和 `run.ps1 -Cpu 486` 提供带 x87 的 486DX 级别核心；
`CPUID` 报告 family 4、model 0（DX）及 FPU 位，不宣告 Pentium 或其他未提供的扩展。
BIOS 和 CMOS 的设备信息也报告协处理器；8088、286、386 档位仍不提供 FPU。
386 的寻址、保护模式、分页、VM86、系统门和任务切换路径由 386/486 共享，
同一套 CPU/系统测试分别在两个型号下运行，原有 386 不会获得 486 专属指令或标志位。

已实现 `BSWAP`、8/16/32 位 `XADD` / `CMPXCHG`、`INVLPG`、`INVD` / `WBINVD` 和 `CPUID`；
支持 AC/ID 标志的 PUSHFD/POPFD/IRETD、CR0 的 WP/AM/NE/cache 控制位及 CR3 的 PWT/PCD。
WP 对内核写只读页生效；AM+AC 在 3 级保护模式与 VM86 下产生对齐异常，缺页异常优先。
INVLPG/cache 操作执行特权检查，但当前没有宿主侧 TLB 或数据缓存需要实际清空。

真实 Windows 3.1 / 3.2 已验证增强模式桌面、DOS 全屏/窗口切换、命令与持久化文件写入。
这仍不代表完整 486 硬件或所有 Windows 安装兼容性。

## 边界

- 不是周期精确的 XT：不模拟预取队列、总线争用或 8086/8088 总线宽度差异。
- 暂不包含 CGA/单色模式、Mode X、完整 CRTC 时序/平滑卷动、可编程字形、声音、调试或快照。
- COM1 目前专用于鼠标，不是宿主串口转发；COM2 未连接设备。
- 硬盘同时提供 BIOS INT 13h 与 AT IDE PIO，另提供 ATAPI PIO 光驱和 FDC/DMA 软驱；
  IDE DMA 和第二块硬盘尚未接入。
- 显示使用宿主固定宽度字体绘制 CP437 字符，不模拟可编程 VGA 字形和全部扩展功能。
  图形模式 ROM 的 8×16 点阵由现有内置 8×8 字库纵向扩展，包含可见 ASCII、制表符和方块；
  不是完整的 IBM VGA 字库，缺少的扩展字形不会借用浏览器字体填充。
- 386/486、虚拟 8086、Windows 3.x 增强模式及 Windows 9x 仍属实验支持；不提供更高 CPU。
- RTC 目前只实现周期中断，不包含完整的闹钟、更新中断和日期时间设置。
- 支持 DOS 安装和普通命令行程序，不等同于兼容全部 DOS 游戏、驱动或磁盘工具。

## x87 数学协处理器

已原生编译复用 `vendor/softfloat` 的 8086 特化和 `tools/softfloat/kernel.c`，
保留与网页版共用的 80 位格式、64 位有效数、24/53/64 位精度控制、
四种舍入、整数/IEEE 浮点转换及异常标志，包括未屏蔽寄存器上溢/下溢的指数回绕。
不以宿主 `double` 近似扩展精度，数值入口串行保护共享内核状态。
测试覆盖超出 binary64 的精度、舍入中点、64 位整数边界、NaN/无穷、
异常标志及独立 binary64 运算比对。

486DX 已接入八级寄存器栈、标签和控制/状态字、D8h–DFh 指令、整数/BCD 转换、
实模式及保护模式环境保存恢复。超越函数采用多字整数定点运算，不依赖宿主浮点近似。
支持 CR0.EM/TS 的 `#NM`、CR0.NE 的 `#MF` 及传统 IRQ13/F0h/F1h 异常路径。
内存操作遵循分段、分页和对齐检查；跨页写入失败不会部分写入或弹出寄存器栈。
测试覆盖真实 FPU 探测指令、扩展精度、舍入、94/108 字节保存恢复、
VM86 缺页后的原子重试及保护模式 SIB 寻址。

未支持的指令编码仍会明确报错；三角函数参数绝对值达到 2^63 时置 C2，
F2XM1 超出定义域时保留 ST(0)。这不是周期或微码精确的 x87。
Windows 98 安装器已在硬盘副本上对照验证：旧版本报告缺少数学协处理器，
新版本启用稳定计时后，已在降低测试进程优先级的条件下通过硬件检查，
进入图形安装向导的 Welcome / Continue 页面；宿主执行 180 秒时，客体仅推进约 52 秒，
测速仍通过，验证不是靠宿主空闲时偶然达到最低速度。
请选择 **486DX** 并启用 **Stable CPU timing (Windows 98)**，可同时启用 **Full speed**。
仅使用实时模式的 Full speed 无法保证最低测速结果：宿主负载或绘制开销仍可能触发 66MHz 检查。
稳定计时使用约 32 MIPS 的虚拟指令吞吐量，并非周期精确的 66MHz 硬件；
CPU 空闲等待期间设备按宿主时间推进，避免空闲时加速时钟或停止中断。
原来的实时计时模式及其他 CPU 档位保持不变。
该验证不等同于 Windows 98 完整安装成功。

## 文件

- `cpu.h/cpp`、`protected.cpp`：不依赖 Windows 的解释器、保护模式、描述符和系统门。
- `386.cpp`：实验性的 386/486 整数执行、32 位寻址、分页、VM86、I/O 权限、返回和任务切换。
- `at.h/cpp`：8259 PIC、8042、A20、CMOS/RTC 和 AT 暖复位。
- `ide.h/cpp`：第一通道 ATA PIO 硬盘、任务寄存器、延迟完成和 IRQ14。
- `atapi.h/cpp`：第二通道 ATAPI PIO 光驱、ISO 按需读取、命令包、sense 和 IRQ15。
- `dma.h/cpp`：8237 DMA 寄存器、8/16 位外设传输、物理总线和终点计数。
- `fdc.h/cpp`：A: 软驱控制器、命令 FIFO、IRQ6、DMA/PIO、换盘和格式化。
- `softfloat.h/cpp`、`build-softfloat.ps1`：共享 SoftFloat C 数值内核的原生构建与类型化入口。
- `fpu.h/cpp`、`fpu-math.h/inl`：x87 指令、寄存器栈、环境及多字定点超越函数。
- `pc.h/cpp`：设备、BIOS、启动和磁盘映像；磁盘 I/O 使用 Windows API。
- `video.h/cpp`：VGA 显存、寄存器、调色板和图形像素。
- `font8x8.h`：从 `src/machine/font8x8.ts` 的 `builtinFont()` 导出的原生 ROM 字形数据。
- `serial.h/cpp`：COM1 的 8250 UART 和 Microsoft 串口鼠标。
- `main.cpp`：Win32/GDI 窗口、输入、等比缩放及无窗口验证入口。
- `display.h`：显示区域的等比布局。
- `timing.h`：实时设备时钟、分型号 CPU 预算和全速调度。
- `tests.cpp`、`test-cpu.mjs`、`test-dos.ps1`：核心回归、真机数据和真实安装验证。
