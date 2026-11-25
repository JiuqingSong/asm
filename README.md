# AsmPerfect 86

**在线使用：https://jiuqingsong.github.io/asm/** （打开网页就能用，不需要安装）

在浏览器里编写、汇编、运行和**单步调试** 8086 汇编程序。CPU、汇编器、BIOS/DOS 都是用 TypeScript 写的，不依赖 DOSBox，因此调试器能看到并回退每一条指令的效果。

## 运行

```bash
npm install
npm run dev        # 打开 http://localhost:5173
npm run build      # 生成静态网页到 dist/
```

### C++ 原生桌面版（Windows，首版）

独立的 C++ 8088 / 80286 及实验性 80386 / 80486SX DOS 虚拟机位于 [native/](native/README.md)，不依赖浏览器。
支持从真实 MS-DOS 6.22 安装软盘安装到可写硬盘映像、再次启动，以及随窗口等比缩放的
文本/VGA 图形显示、最大化、原始大小和全速切换，并加入 COM1（IRQ4）Microsoft 串口鼠标。
已支持 286 / AT 和 16 位保护模式，并用六张原始安装盘验证英文 Windows 3.1 标准模式安装、
硬盘冷启动及 COM1 鼠标移动、双击打开 File Manager；实验性 386 已通过 `WIN /3` 增强模式
安装、冷启动、文件管理器与键盘鼠标交互，“关于”窗口已确认 386 Enhanced Mode。
中文版 Windows 3.2 已在用户安装好的硬盘副本中验证冷启动进入桌面，仍属实验支持；
Windows 3.1 / 3.2 的 DOS 会话已验证全屏/窗口切换、命令输入、文件写入及退出返回桌面；
实验性 486 整数核心也已通过上述增强模式回归，但尚未包含 x87 或 Windows 95/98 安装支持。
AT 平台的硬盘另提供第一通道 IDE PIO / IRQ14，与 BIOS 共享映像；
第二通道 ATAPI PIO / IRQ15 光驱已用真实 OAKCDROM/MSCDEX 验证读取 ISO、复制文件及逐字节持久化校验，
可创建 31.5/126/504 MiB 硬盘，504 MiB 已通过真实 DOS 6.22 完整安装；
另已接入 8237 DMA 和 IRQ6 软驱控制器，真实 DOS 中控制器读取结果与 BIOS 逐字节一致。
尚无光盘启动和 Windows 95/98 完整安装验证。
不包含网页版的汇编器和调试器。
另提供独立 [IMG 命令行工具与图形界面](native/README.md#独立-img-工具)：
创建纯零或 FAT 数据硬盘/软盘、一次拖入多个文件和多层目录，
硬盘预设最大 504 MiB；导入失败（包括空间不足）保留原映像不变。
构建、安装、启动和验证方法见 [原生版说明](native/README.md)。

## 功能

- **启动选择**：打开网页只显示入口，不创建虚拟 PC。直接调试可选择硬件、BIOS、浅层 DOS 和内置鼠标驱动（默认保持原有环境）；双机对联直接进入串口实验；完整模拟先选设备，再选 A:、C: 或光盘引导，不预装 DOS 或内置鼠标驱动
- **完整快照**：主工具栏的 Take snapshot 暂停虚拟机，并将模式、CPU/内存、全部设备、所有磁盘/光盘、源码和断点下载为一个 `.asmsnap` 文件；双机同时保存两台机器和串口在途数据。启动页的 Load snapshot 上传恢复，保持暂停，点击运行才继续，不重新引导客体系统
- **编辑器**：语法高亮、断点（点击行号左侧）、错误标记、悬停提示（寄存器和变量的当前值、指令说明、`INT 21h` 当前 AH 对应的功能）、可选显示每行的地址和机器码
- **源码工具栏**：直接调试和双机模式的代码窗口内依次提供新建、打开、示例、保存、汇编和机器码开关，生成 EXE/COM 与最大化靠右；完整模拟隐藏整个代码窗口。主工具栏以"启动选择"开头，保留三种模式共用的 CPU、运行、暂停等控制
- **源码文件操作**：新建会先保护未保存修改，再清空当前编辑器和文件名（双机只清空当前机器）；直接调试中打开文件或载入示例也只在存在未保存修改时确认。汇编不会清除修改状态，保存或撤销回原版本后不再询问
- **生成 DOS 可执行文件**：直接调试和双机模式在代码窗口点击"生成 EXE/COM"，从当前源码重新汇编，成功后输入文件名并下载；普通分段程序生成带重定位表的 MZ EXE，`.MODEL TINY` / `ORG 100h` 程序生成 COM。错误显示在消息页，不影响正在调试的程序
- **调试**：单步进入（F11）、单步跳过（F10，整体执行 CALL/INT/LOOP）、跳出子程序（Shift+F11）、运行到光标处（Ctrl+F10）、**后退一步**（Ctrl+Shift+F11，可一直退回程序开头，内存同时恢复）、断点、按每秒 1~100 步的速度动画运行；点寄存器可以直接修改，点标志位可以切换
- **面板**：寄存器（高低字节分开、刚改变的值高亮）、标志位、栈（标出返回地址来自哪一行）、变量、内存、DOS 屏幕（80×25 彩色文本）、虚拟磁盘。四个窗口之间的分隔条可以拖动调整大小（双击恢复，大小会记住），每个窗口都可以最大化（标题栏右边的按钮或双击标题栏，Esc 还原）
- **硬件**：中断向量表、8259 中断控制器、8253 定时器（IRQ0 → INT 8 → INT 1Ch）、键盘控制器（IRQ1 → INT 9，端口 60h 扫描码）、8250 串口（COM1/COM2，含回环模式）。程序可以像在真机上一样挂接中断
- **双机模式**：两台虚拟 PC 的 COM1 用虚拟交叉线连接，按虚拟时间同步运行。可选接线方式（全握手 / 部分握手 / 三线制）、串口芯片（真实 8250 / 带缓冲和硬件流控的虚拟串口），面板上显示 DTR/RTS/CTS/DSR 信号和线路上的每个字节
- **CPU 型号**：8088、286、386、486 四档。286 档是 80286：186/286 的指令、16MB 内存、A20 门和完整的 16 位保护模式（HIMEM.SYS、Windows 3.0 和 3.1 的标准模式可以运行）；386 档是 80386：32 位寄存器和指令、32 位保护模式、分页、虚拟 8086 模式（实模式指令用 SingleStepTests/80386 真机测试集验证）。能运行 Windows 3.1 的 386 增强模式，能安装并运行 Windows 95；486 档加上 x87 后能安装并运行 Windows 98 SE；486 档支持 BSWAP、XADD、CMPXCHG、INVLPG、CPUID，EFLAGS 的 AC/ID 位和 CR0.WP，默认相当于不带浮点单元的 486SX
- **可选数学协处理器**：直接调试和完整模拟启动前可为 386/486 勾选 x87（默认不安装，8088/286 不可选），分别相当于 386+80387 / 486DX。80 位寄存器、浮点运算、异常、保存/恢复、单步回退和反汇编；寄存器面板可展开查看 x87 状态。数值核心使用本地内嵌的 Berkeley SoftFloat WASM。已验证带 FPU 的 Win95 到桌面，以及 Windows 98 SE 完整安装并运行（用户验证）
- **原机速度**：按所选 CPU 的真实速度运行（虚拟时间与真实时间同步），延时、时钟、波特率和声音都与原机一致；也可以全速运行或按每秒 1~100 步动画执行
- **PC 喇叭**：8253 的 2 号通道 + 端口 61h，用 Web Audio 发声（示例：两只老虎）
- **可选 SB16 声卡**：启动时勾选 Sound Blaster 16，提供非即插即用的数字 PCM 播放（220h、IRQ5、DMA1/5，8/16 位、单/双声道）。已使用 Windows 95/98 原版驱动实测 16 位立体声 WAV 播放；需安装系统自带的 Creative Sound Blaster 16 非 PnP 驱动，并选择“原机速度”播放。暂停、关机和恢复快照时清空宿主音频。FM/OPL、MIDI、录音及 DOS 游戏兼容性暂不包含
- **直接运行 DOS 程序**：直接调试始终显示独立文件区，把 EXE/COM 上传后点"运行"（MZ 重定位、PKLITE 等自解压程序、DOS 内存控制块链）；磁盘映像区需在启动前勾选"显示磁盘映像文件系统"（默认不勾选）。完整模拟只显示磁盘映像区，双机保留两个区域
- **从磁盘启动真 DOS**：完整模拟模式中放入软盘或硬盘映像（.img），点 A:、C: 或光驱那一行左边的"从这里启动"；INT 13h 按扇区读写，新建空白硬盘，映像保存在浏览器里；可以直接查看、放入、取出映像里的文件（FAT12/FAT16），提供关机程序 SHUTDOWN.COM。完整模式隐藏源码窗口，保留屏幕和右侧调试面板；工具栏"重启"重新选择启动设备，Ctrl+Alt+Del 沿用本次启动设备。MS-DOS 6.22 可以从安装盘启动，并安装到虚拟硬盘上
- **硬盘控制器**：C:、D: 也能经 IDE 第一通道的 ATA 控制器（IRQ14）读写，Windows 95 可以用 32 位方式访问硬盘
- **软驱控制器**：A:、B: 的软盘也能经 82077 软驱控制器（IRQ6、DMA）读写，Windows 95 可以用 32 位方式访问软盘
- **光驱**：光驱里可以放光盘映像（.iso），它是 IDE 第二通道上的 ATAPI 光驱：DOS 下用通用光驱驱动（如 OAKCDROM.SYS）加 MSCDEX，Windows 95 自动认出；可启动的光盘（软盘模拟方式如 Windows 98 安装盘，不模拟方式如 Windows XP、Linux 安装盘）可以"从光驱启动"
- **光盘映像当作硬盘**：D: 可以放 .iso（完整模拟要在选择设备时勾选"D: 盘"，默认不启用），模拟器把光盘内容变成一块只读的 FAT16 硬盘，DOS 里直接是 D:，不用光驱驱动和 MSCDEX；ISO 不读进内存，DOS 读到哪里才读哪一段
- **中文显示**：屏幕上勾选"中文"，像 UCDOS 那样把 GBK 显示成汉字，并自动识别西文制表符
- **图形模式**：VGA 13h（320×200、256 色，调色板端口 3C7h~3C9h、INT 10h AH=10h）、CGA 04h/05h/06h；EGA/VGA 16 色平面模式 0Dh、0Eh、10h、12h（640×480），模拟 4 个位平面、定序器、图形控制器（写模式 0~3、读模式 0/1、锁存器、逻辑运算、位屏蔽）和属性控制器调色板，Turbo Pascal/Turbo C 的 EGAVGA.BGI 驱动可以直接用；BIOS 写点/读点、图形模式下显示文字（内置 8×8 点阵字库）
- **鼠标**：直接调试可选内置 INT 33h 驱动（光标、位置、按键、活动范围、形状、移动量、事件回调等）；完整模拟可选 COM2 上的 Microsoft 串口鼠标，由客体系统安装实际硬件驱动。串口鼠标捕获后按右 Ctrl 释放；勾选工具栏的"全屏捕获"可将 Esc 传入客体（Chrome/Edge、HTTPS 或 localhost，需授权），普通捕获的 Esc 仍由浏览器保留。工具栏或客体 APM 关机后自动释放捕获并退出捕获全屏，黑屏不重新捕获
- **反汇编**："反汇编"页显示 CS:IP 前后的指令，也可以输入地址（如 335D:32AD 或标号名）查看任意位置，用按钮或鼠标滚轮翻页；可以按地址设断点、双击运行到那里；没有源码的程序也能单步
- **BIOS/DOS**：INT 10h、16h、1Ah，INT 21h 的常用功能（字符/字符串输入输出、行输入、中断向量、日期时间、文件读写、查找文件 4Eh/4Fh 和 FCB 11h/12h、改名、文件时间等；虚拟磁盘只有根目录）

## 汇编器支持的语法（MASM 子集）

- `.MODEL SMALL/TINY` 简化段定义，以及 `SEGMENT/ENDS/ASSUME/GROUP` 完整段定义；EXE 和 COM（`ORG 100h`）
- `DB/DW/DD/DQ/DT`、`DUP`、`?`、字符串、`EQU`、`=`、`LABEL`、`PROC/ENDP`（NEAR/FAR）
- 表达式：`OFFSET SEG TYPE SIZE LENGTH SIZEOF LENGTHOF PTR SHORT HIGH LOW`，算术、逻辑和比较运算，段超越
- 宏：`MACRO/ENDM`（含 `LOCAL`、`EXITM`、`&` 拼接）、`REPT`、`IRP`、`IRPC`；条件汇编 `IF/IFE/IFDEF/IFNDEF/IFB/IFNB/ELSE/ENDIF`
- `.STARTUP`、`.EXIT`
- 条件跳转超出范围时自动扩展（与 MASM 6 相同）
- 常见错误给出中文说明，例如"不能把立即数直接送入段寄存器"

暂不支持：`STRUC`、`INCLUDE`、多模块（`EXTRN`）、80186 及以上指令。

全部已实现的 CPU 指令、BIOS/DOS 功能、显卡、端口和内存布局见参考手册 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 测试

```bash
npm test                                  # 汇编器 + 虚拟机 + 示例程序的端到端测试
npm run test:cpu                          # 用 SingleStepTests/8088 真机测试集验证 CPU（约 300 万个用例）
npm run test:cpu386                       # 用 SingleStepTests/80386 的实模式测试集验证 386（约 176 万个用例）
node tools/ml-compare.ts tests/ml/*.asm   # 与 MASM 6.11 逐字节对照（需要 ML.EXE，用环境变量 ML_EXE 指定）
node tools/serial-demo.ts send.asm recv.asm 286 buffered   # 双机串口文件传输实验（命令行）
# 启动开发服务器后，检查三个启动入口、换模式、冷/热启动与映像保存：
# URL=http://localhost:5173/ node tools/ui-startup-check.mjs
# URL=http://localhost:5173/ node tools/ui-export-check.mjs   # 编辑器替换/新建、EXE/COM 下载和异址运行
# URL=http://localhost:5173/ node tools/ui-capture-check.mjs  # 真实鼠标/键盘锁定、右 Ctrl、Esc 透传和权限失败清理
# URL=http://localhost:5173/ node tools/ui-snapshot-check.mjs # 三种模式的完整快照、上传后暂停及继续；可设置 PRODUCTION_URL 验证生产版恢复
# URL=http://localhost:5173/ node tools/ui-sound-check.mjs    # SB16/DMA 到浏览器实际 PCM 输出，暂停/恢复与全速静音
```

`test:cpu` 需要先把测试集下载到 `test-data/8088/`（约 730MB，见 https://github.com/SingleStepTests/8088 的 `v2` 目录）；`test:cpu386` 需要 `test-data/80386/`（约 600MB，https://github.com/SingleStepTests/80386 的 `v1_ex_real_mode` 目录，MOO 格式）。

### SoftFloat 数值核心

使用 [Berkeley SoftFloat 3e](https://www.jhauser.us/arithmetic/SoftFloat.html) 的原始 C 源码和 `8086` 专用 NaN 规则，位于 `vendor/softfloat/`。上游归档 https://www.jhauser.us/arithmetic/SoftFloat-3e.zip 的 SHA256 为 `21130ce885d35c1fe73fc1e1bf2244178167e05c6747cad5f450cc991714c746`；`Makefile` 保留其 FAST_INT64 构建的源文件清单。许可证见 [vendor/softfloat/COPYING.txt](vendor/softfloat/COPYING.txt)，网页发布同时包含 `softfloat-license.txt`。

普通开发、测试和发布不需要 C 编译器：生成的 WASM 已内嵌在 `src/cpu/softfloat-wasm.ts`，不会联网获取数值核心。修改 C 接口或编译选项后，使用 Zig 0.14.1 重新生成：

```powershell
$env:ZIG = 'C:\path\to\zig.exe'
npm run build:softfloat
npm test
npm run build
```

基本四则运算、平方根、舍入和转换由 SoftFloat 完成；x87 状态机及高精度定点超越函数由 TypeScript 实现。暂不保证超越函数与某一代实体 387 的每个末位完全相同，也未完成全部特殊值和未屏蔽异常的真机差分验证。汇编器暂未增加 x87 助记符，可运行外部编译的 EXE/COM 或用 `DB` 写机器码。

`tools/softfloat/reference.c` 可用支持 x86 内联汇编的 GCC/Clang 编译为本机测试程序，再运行 `node tools/check-x87.ts <reference.exe>` 做真机差分。该检查不是普通测试的前提；若主机安全策略禁止执行，不绕过限制。本次验证环境的应用程序控制策略阻止了该程序，因此不能将差分检查记为通过。

## 开发计划

下一步要做的功能、工作约定和验证方法见 [docs/ROADMAP.md](docs/ROADMAP.md)。功能的完整列表见 [docs/REFERENCE.md](docs/REFERENCE.md)，增加或修改功能时要同步更新它。

## 结构

```
src/cpu/cpu.ts          8086 CPU（按指令解释执行）
src/asm/                汇编器：lexer（词法）、assembler（伪指令、宏、多遍扫描、段布局）、encoder（指令编码）
src/machine/            虚拟 PC：devices（8259/8253/键盘）、uart（8250 与串口线）、bios（BIOS 与 DOS 功能）、machine（装载、执行、调试、历史记录）、dual（双机同步运行）
src/ui/                 界面：editor（Monaco）、panels（寄存器/栈/变量/内存）、screen（DOS 屏幕）、examples（示例程序）
tools/                  CPU 测试运行器、ML 对照工具、浏览器界面检查脚本
```

BIOS 和 DOS 功能通过"陷阱"实现：中断向量指向 F000 段里的桩代码 `F1 nn CF`，CPU 执行到 `F1` 时调用 JS 处理函数。因此用户程序读取、替换、串接中断向量的行为和真机一致。
