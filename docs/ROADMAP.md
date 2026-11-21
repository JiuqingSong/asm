# AsmPerfect 86 开发计划

最后更新：2026-11-20（版本 0.69，文档整理：Windows 98 SE 完整安装、SB16 出声）。下次继续时，先读"现状"和"工作约定"，再从"下一步"里挑一项。

## 现状

线上地址：https://jiuqingsong.github.io/asm/ ，代码：https://github.com/JiuqingSong/asm

已经完成：

| 部分 | 内容 | 验证方式 |
|---|---|---|
| CPU | 8086/8088 全部指令，含未公开指令；286 档是 80286（含保护模式）；386 档是 80386（32 位指令、32 位保护模式、分页、V86）；486 档是 486SX（486 的新指令、AC/ID 位、CPUID、CR0.WP） | SingleStepTests/8088 全部 3,007,000 个用例通过；SingleStepTests/80386 实模式 1,758,699 个用例中 53 个边角情况以外全部通过（`npm run test:cpu386`）；保护模式和分页见 tests/protected.test.ts、tests/cpu386.test.ts |
| 可选 x87 | 386+80387 / 486DX，默认关闭；SoftFloat 3e 内嵌 WASM、80 位栈、异常、环境与寄存器保存/恢复、调试回退及状态面板；汇编器不扩展 x87 语法 | tests/x87.test.ts、tests/cpu386.test.ts；Win95 到桌面；Windows 98 SE 完整安装并运行（用户验证）；本机安全策略阻止原生差分程序执行，该项未通过验证 |
| Win98 安装 | PIT 通道 2 的门控倒计时、输出和 8254 状态/计数读回，修复安装向导 CPU 测速时除以零；486 的 `LOCK CMPXCHG`/`LOCK XADD` 不再误报无效指令（安装最后 REGSVR32 注册 OLEDB32.DLL 时用到） | tests/at-devices.test.ts、tests/cpu486.test.ts；Windows 98 SE 完整安装并运行（用户验证）。该硬件修复会改变原先读取 61h 位 5/通道 2 的程序行为，因此修复后的启动校验和不能直接当作仅添加 FPU 的校验和比较 |
| 汇编器 | MASM 子集：简化段/完整段、宏、REPT/IRP/IRPC、条件汇编、多遍扫描、条件跳转自动扩展 | 9 个程序与 MASM 6.11（ML.EXE）逐字节一致 |
| 虚拟 PC | 中断向量表 + BIOS 陷阱、8259、8253、键盘（IRQ1/端口 60h）、8250 串口、PC 喇叭、BIOS/DOS 常用功能、虚拟磁盘 | 34 个端到端测试 |
| 调试 | 单步进入/跳过、后退（单机）、断点、按每秒 1~100 步动画执行、悬停显示值 | 测试 + 浏览器检查脚本 |
| 双机 | 两台机器的 COM1 用虚拟交叉线连接，按虚拟时间同步；三种接线、真实 8250 / 虚拟串口 | 2003 年的 send.asm/receive.asm 原样传输成功 |
| 速度 | 原机速度（默认，虚拟时间与真实时间同步）、全速、动画。0.55~0.59 做了一轮提速：从磁盘启动（不记录历史）比之前快约 4 倍，Win95 启动在 Node 里约 1300 万~1700 万条/秒 | 浏览器实测：5 秒的程序用 5.1 秒；`node tools/bench-boot.ts`（见"验证"） |
| 发布 | GitHub Pages（推送到 main 后由 GitHub Actions 自动测试、编译、发布） | Actions 的运行结果 |
| 调试器 | 反汇编视图（真机测试集 96,900 条指令长度全对；往返对照）、跳出、运行到光标处、修改寄存器和标志位 | 测试 + 浏览器检查脚本 `tools/ui-debug.mjs` |
| 图形模式 | VGA 13h（256 色、调色板端口）、CGA 04h/05h/06h、BIOS 写点/读点、图形模式下的文字（内置 8×8 点阵） | 示例"VGA 256 色""画线"；`tools/ui-gfx.mjs` |
| EGA/VGA 平面模式 | 0Dh、0Eh、10h、12h：4 个平面在 `Video.planar` 里，CPU 读写 A000 段经 `cpu.mmio` 交给图形控制器；属性控制器调色板 → DAC；反向执行能撤销平面写入；鼠标范围随模式变化。用户的 Turbo Pascal + EGAVGA.BGI 程序（中文界面、鼠标）能正常运行 | 测试 + `tools/ui-bgi.mjs`、`tools/run-exe.ts <EXE> "" <条数> <截图.png>` |
| 鼠标 | INT 33h 驱动：常用功能、事件回调（经 BIOS 桩代码远调用用户程序）、文本/图形光标；按键变化排队，至少保持 30 毫秒虚拟时间 | 测试 + `tools/ui-mouse.mjs` |
| 运行 DOS 程序 | 虚拟磁盘上的 EXE/COM 直接运行；DOS 内存控制块链（48h/49h/4Ah）、环境变量块；中文显示（GBK + 制表符识别） | 1996 年的 QuickBASIC 程序 SCRMK.EXE（PKLITE 压缩）能运行并显示中文菜单 |
| 汇编器 80186/80286 | `.186` / `.286` / `.286P`（0.61） | tests/asm286.test.ts；tests/ml/i286.asm 与 MASM 6.11 逐字节一致 |
| 生成 EXE/COM、编辑器 | 代码窗口"生成 EXE/COM"（MZ 带重定位表 / COM）；新建、替换前只在有未保存修改时确认（0.63） | tests/executable.test.ts；`tools/ui-export-check.mjs` |
| 鼠标捕获 | 右 Ctrl 释放；可选"全屏捕获"用 Keyboard Lock 把 Esc 交给客体；关机后自动释放（0.63、0.65） | `tools/ui-capture-check.mjs` |
| 完整快照 | `.asmsnap`（src/machine/snapshot.ts，格式 v2，仍能读 v1）：模式、配置、CPU/内存/显存、全部设备、介质、源码和断点；双机含串口在途数据；非安全 HTTP 用 @noble/hashes 算 SHA-256（0.65~0.67） | tests/snapshot.test.ts；`tools/ui-snapshot-check.mjs` |
| SB16 声卡 | 可选非 PnP SB16（src/machine/sound.ts）：DSP 4.05、8/16 位 PCM、16 位 DMA、AudioWorklet 输出（src/ui/pcm.ts）；没有 FM/OPL、MIDI（0.66） | tests/sound.test.ts、tests/pcm.test.ts；`tools/ui-sound-check.mjs`；Win95/98 原版驱动播放 WAV（Win98 里音质还很差，未查） |
| 启动入口与设备配置 | 网页初始不创建虚拟 PC；直接调试按需安装硬件/BIOS/浅层 DOS/内置鼠标驱动；双机直接进入串口环境；完整模拟保留 BIOS、由磁盘系统提供 DOS 和鼠标驱动，隐藏源码；工具栏重启选设备，Ctrl+Alt+Del 沿用当前设备；A:、C:、光驱各行"从这里启动"，D: 默认不启用（0.63、0.68） | `tests/config.test.ts`、`tests/cdboot.test.ts`；`tools/ui-startup-check.mjs`；真实 MS-DOS 6.22 硬盘启动并运行 VER |

## 下一步（按建议顺序）

### 1. 调试器增强（剩下的部分，建议先做）

第一批（反汇编）和第二批（跳出、运行到光标处、修改寄存器）已经完成。还剩：

| 功能 | 做法要点 | 完成标准 |
|---|---|---|
| 修改内存 | 内存面板里双击一个字节编辑；变量面板里直接改变量的值；用 `Machine.poke()` 记入历史 | 改完后变量面板、悬停提示同步更新，后退能撤销 |
| 条件断点 | 断点上右键设置条件，如 `CX == 0`、`AL > 41h`、`[SI] == 0`；条件用一个小表达式解析器求值 | 循环里只在条件满足时停 |
| 数据断点 | 指定变量或地址，被写入时停下；在 `cpu.onWrite` 钩子里检查 | 冒泡排序中"arr 第 3 项被改写时停下" |
| 调用栈 | 根据栈里的返回地址（栈面板已能识别）列出调用链 | 递归求阶乘时能看到每一层 |

### 2. 图形模式（剩下的部分）

13h、CGA 模式、EGA/VGA 16 色平面模式和鼠标（INT 33h，含事件回调）已经完成。还剩：更多示例（例如用定时器驱动的小游戏、平面模式的汇编示例）、CRTC 起始地址（翻页/硬件卷屏）、8×14/8×16 的 ROM 字库（现在把 8×8 字形放大）。

### 3. 8255 虚拟实验面板

- 对应《微机原理》实验箱：8255 并行口（端口 A/B/C + 控制字），接 LED、数码管、开关、按键。
- 端口地址可配置（常见实验箱用 60h~63h 以外的地址，例如 280h~283h），不能和键盘控制器冲突。
- 面板做成一个标签页：8 个 LED、2 位数码管、8 个开关，开关状态可以被程序读到。
- 示例：流水灯、开关控制 LED、数码管计数。

### 4. PC 喇叭补全

- 现在只支持"定时器 2 号通道 + 端口 61h 的位 0、1 都为 1"的方波发声。
- 还缺：程序直接翻转端口 61h 的位 1 来发声（逐位驱动，"嘀嗒"声、简单的 PCM）。做法是记录每次翻转的虚拟时间，用 AudioWorklet 按时间生成波形；只在原机速度下有意义。

### 5. 汇编器补全

- STRUC/ENDS 结构体（含字段偏移、`.` 运算符）、INCLUDE（从虚拟磁盘或编辑器的其他标签页读取）、`@@:` 匿名标号与 `@B`/`@F`、`PROC USES`、MASM 6 的 `.IF/.WHILE/.REPEAT`。
- ~~80186 指令~~：已完成（0.61）：`.186` / `.286` / `.286P` 打开 80186、80286 的指令，和 MASM 6.11 逐字节一致（tests/ml/i286.asm）。还缺 386 的 32 位指令。
- 最有效的办法：拿 Jason 手上更多的老程序来试（例如汉诺塔），遇到不认识的语法就用 ML.EXE 对照着补。

### 6. 两台真实电脑互连

- 用 WebRTC DataChannel 当串口线：两个浏览器各运行一台机器，信令需要一个简单的配对服务（或用房间号）。
- 难点：两边的虚拟时间无法严格同步。可以只在"虚拟串口"模式下支持（发送缓冲 + 硬件流控本来就能容忍延迟），真实 8250 模式不支持。
- 完成标准：两台电脑分别运行 send.asm 和 receive.asm，文件传输成功。

### 7. 运行更多 DOS 程序

- 186/286 实模式指令已完成（CPU 选 286/386 时）。可以下载 SingleStepTests 的 80286 测试集逐条验证（目前只有单元测试和真软件验证）。
- **Windows 3.0**：选 286/386 时可以安装并运行（实模式，到 Program Manager）。用户的映像在 D:\Downloads\Microsoft Windows 3.0 (5.25 1.2MB)，不提交。
  - 选 8088 时 Windows 走 8086 专用的路线，显示驱动编译出来的 BitBlt 代码跑飞（tools/boot.ts 的 WATCH/WATCHAT 可以跟踪），原因还没查清；怀疑和 8088 的指令预取队列（自修改代码）有关。
  - Windows 的鼠标驱动：安装时检测到"没有鼠标"，还没试过 Windows 3.0 的鼠标驱动能不能借用 INT 33h。
  - 286 保护模式 + A20 + 16MB 内存 + CMOS 复位恢复已完成（tests/protected.test.ts）：原版 HIMEM.SYS、DOS=HIGH、Windows 3.0 标准模式可以运行。Windows 3.1 也已经能安装、以标准模式运行，鼠标选 Microsoft, or IBM PS/2。386 第一段（32 位指令、32 位保护模式、分页）已完成：HIMEM.SYS 和 Windows 3.1 标准模式在 386 档上运行正常。第二段完成：Windows 3.1 的 386 增强模式能运行（Program Manager、全屏 DOS 窗口、EMS）。修过的问题：VGA 寄存器能读回；INT 10h 设置模式、清屏用 ROM 里的 OUT/REP STOSW 做；分页时 BIOS 访问内存经过页表（V86 陷阱里会产生真的缺页）；键盘控制器 64h 的输出缓冲区满位；INT 9 先 IN AL,60h；显示模式按显卡寄存器判断；显存全部在 4 个平面里。第三段完成（2026-11-18，0.38）：**Windows 95 能安装并运行到桌面**（从 ISO 当作的 D: 盘安装；加了从片 8259 + 实时钟 IRQ8、8237 DMA、非链式 256 色模式）。之后（0.40、0.41）：DOS 窗口化（Alt+Enter）显示正常（INT 10h 也装入调色板和 DAC）；IDE 第二通道上的 ATAPI 光驱：Windows 98 启动盘的光驱驱动 + MSCDEX 能读，Windows 95 用"添加新硬件"检测到 IDE 控制器后用自带的 32 位驱动读光盘。0.43：软驱控制器 82077（src/machine/fdc.ts，IRQ6，DMA 2 号通道真的传送），给 Windows 95 的 32 位软驱驱动用（用户验证过：添加新硬件后软驱不再是兼容方式）。之后：IDE 第一通道上的 ATA 硬盘（src/machine/ide.ts，IRQ14），给 Windows 95 的 ESDI_506 用。要让 ESDI_506 接管硬盘还需要：BIOS 的 INT 13h 读写经过 IDE 端口（diskrom.ts）、命令先忙一会儿再发中断、读状态寄存器撤销中断请求、硬件中断的默认处理用 OUT 发 EOI（否则 VPICD 一直屏蔽 IRQ14）。在用户的 Win95 映像上验证过：IOS.LOG 消失；用户在浏览器里确认"系统属性 → 性能"显示文件系统、虚拟内存都是 32 位，"按照最优性能配置"。已知问题：增强模式下的速度（tools/boot.ts 的 TRACEFROM/TRACEDIS/PORTLOG 可以跟踪）。用户的 Windows 3.1 映像在 D:Windows 3.1 EN，不提交。
- **Windows 98 SE**（0.64）：486 + x87 能完整安装并运行（用户验证）。修过 PIT 2 号通道（安装向导测速除以零）和 LOCK CMPXCHG/XADD。SB16 能装原版驱动、能出声，但音质很差，原因还没查，可以从这里继续。
- 缺少的 DOS 功能按需补：执行子程序（4Bh）等。运行 `node tools/run-exe.ts <文件>` 可以列出程序用到的中断、端口和没实现的功能。
- 图形模式（见第 2 项）。
- 中文显示的制表符识别是启发式规则（`src/ui/screen.ts` 的 `layoutGbk`），遇到识别错的屏幕，把它加进 `tests/screen.test.ts` 再调规则。

### 8. 更大的内存和硬盘（128MB 内存、2GB 硬盘）

和 Copilot 讨论过，还没做。建议先做可配置内存，再做大硬盘和分块存储：

- 内存：CPU 里固定 16MB 的边界判断、页表地址的 16MB 回绕都改成按配置的容量；BIOS 加 INT 15h E801/E820，CMOS 按兼容上限报告；**历史记录现在用"16MB 以上的地址"表示显卡平面数据，扩大内存后会冲突，必须改编码**；286 仍最多 16MB。
- 硬盘：实际容量和 CHS 几何参数分开保存；加硬盘的 INT 13h 扩展（41h/42h/43h/48h）；BIOS 和 IDE IDENTIFY 报告的容量一致。IDE 已有 28 位 LBA，不用做 AHCI/DMA。
- 浏览器存储：硬盘映像现在整个读进内存、整个存进 IndexedDB，要改成"分块读取 + 有限缓存 + 脏块增量保存"（光盘的按需读取可以参考），并检查存储配额。这是最大的一块。

### 9. 声卡第二期

- 先查 Windows 98 里音质差的原因（重采样、缓冲欠载、DMA/IRQ 节奏都可能）。
- OPL2/OPL3 FM 合成（DOS 游戏的音乐，建议复用许可证合适的成熟核心）、DOS 下的 BLASTER 环境变量和游戏兼容性。Copilot 估 4~8 周或更多。

### 10. Windows 2000 / XP

- 奔腾档：CMPXCHG8B、RDTSC、CR4/MSR，CPUID 如实报告（XP 安装盘现在停在 CMPXCHG8B 检查）。
- 内存 128~256MB、几 GB 硬盘（第 8 项）；先走非 ACPI 的 Standard PC HAL、单 CPU，不做 APIC/PCI/ACPI。
- 更大的工作是验证 NT 内核用到的保护模式组合（内核态切换、缺页和重执行、TLB、x87 上下文切换），以及诊断工具和速度。建议先装 Windows 2000 Professional。

### 11. 其他

- 分享链接：把代码压缩后放进网址的 `#` 部分，打开就装载。
- 多文件：编辑器里保存多个程序，而不是只记住最近一份。
- 双机模式下后退：需要把串口线上的在途字节、UART 状态也纳入历史记录，工作量较大，优先级低。
- DOS 屏幕显示中文（GBK 双字节，类似 UCDOS）：不是真实 DOS 的行为，按需做。
- 手机/平板布局；CI（GitHub Actions 跑 `npm test`，CPU 测试集太大，不放 CI）。

## 工作约定

### 代码结构

```
src/cpu/cpu.ts          CPU（改动后必须跑 npm run test:cpu）
src/cpu/x87.ts          可选 x87；x87-math.ts 超越函数；softfloat.ts + softfloat-wasm.ts 内嵌 SoftFloat 3e（vendor/softfloat，npm run build:softfloat 重新生成）
src/asm/                汇编器：lexer、assembler（伪指令、宏、多遍扫描、段布局）、encoder（指令编码）
src/machine/            devices（8259/8253/键盘）、uart（8250、串口线）、bios（BIOS/DOS 陷阱）、machine（装载、执行、调试、历史记录、虚拟时钟）、dual（双机调度）、config（启动配置）、snapshot（完整快照）、sound（SB16）、ide/atapi/fdc（磁盘控制器）
src/ui/                 main（会话、运行控制）、startup（启动入口和设备选择）、drives（虚拟磁盘页）、editor（Monaco）、panels、screen、speaker、pcm（声卡输出）、examples、help
.github/workflows/      GitHub Pages 的发布流程
tools/                  测试和检查脚本（见下）
```

### 验证

每次改动后至少跑前两项；改了哪部分就加跑对应的检查：

| 命令 | 什么时候跑 |
|---|---|
| `npx tsc --noEmit -p .` | 每次 |
| `npm test` | 每次（246 个测试） |
| `npm run test:cpu` | 改了 `src/cpu/`（需要 `test-data/8088/`，约 730MB，不在仓库里） |
| `node tools/ml-compare.ts tests/ml/*.asm ../send.asm ../receive.asm` | 改了汇编器（需要 ML.EXE：默认 `../bin/ML.EXE`，或用 `ML_EXE` 指定） |
| `node tools/ui-check.mjs <截图目录>` | 改了界面（需要 `npm run dev -- --port 5317`，用本机 Chrome） |
| `node tools/ui-dual.mjs <截图目录> ../send.asm ../receive.asm` | 改了双机或串口 |
| `node tools/ui-realtime.mjs [网址]` | 改了运行速度或定时器 |
| `node tools/ui-debug.mjs <截图目录> [EXE]` | 改了调试功能（跳出、运行到光标处、反汇编、改寄存器） |
| `node tools/ui-gfx.mjs <截图目录>` | 改了图形模式 |
| `node tools/ui-mouse.mjs <截图目录>` | 改了鼠标 |
| `node tools/ui-layout.mjs <截图目录>` | 改了窗口布局（分隔条、最大化，src/ui/layout.ts） |
| `node tools/ui-disasm.mjs <截图目录> <EXE> [地址]` | 改了反汇编页（输入地址、翻页、滚轮、回到 CS:IP） |
| `node tools/bench-boot.ts <C: 映像> [百万条指令] [CPU]` | 改了 CPU 或机器的执行循环、设备、中断：打印速度和机器状态的校验和。改动前先把 src 复制一份，用 `SRC=那份目录` 跑一遍对比，**校验和必须完全相同**（CMOS 时间已固定，同一份代码每次结果一样）。`MOUSE=1` 加上鼠标移动和点击，`HIST=1` 打开历史记录。速度看"CPU 时间"，前后交替多跑几次 |
| `node tools/boot.ts <A: 映像> [C: 映像 或 new:64] [百万条指令] [按键…]` | 改了 INT 13h、开机流程：命令行里从磁盘启动并按键（`{ENTER}` `{F3}` `{SWAP}` 换盘 `{SHOT}` 显示屏幕），`SAVE_C` 保存硬盘映像 |
| `node tools/ui-fs.mjs <截图目录> <装好 DOS 的硬盘映像> <文件…>` | 改了映像里的文件（src/machine/fat.ts）：浏览、建目录、上传，再启动 DOS 用 DIR 查看 |
| `node tools/ui-boot.mjs <截图目录> <A: 映像> [按键…]` | 改了磁盘映像面板：在浏览器里放入软盘、新建硬盘、启动、按键（用户的 DOS 6.22 映像在 D:\DOS，不提交）；`HD=` 上传 C:，`ISO=` 把光盘映像放进 D: |
| `node tools/mkiso.ts <目录> <输出.iso> [卷标]` | 生成测试用的 ISO9660 光盘映像；配合 `ISO=映像 BOOT=C node tools/boot.ts - <C: 映像> …` 检查光盘变成的 D:（src/machine/iso.ts） |
| `node tools/trace-fpu.ts <TP 程序.EXE> [参数] [F2 或 3E:EC]` | 借用 Turbo Pascal 程序里的 8087 仿真器，统计一条浮点指令或 Sin/Cos 等函数执行的 8086 指令和循环 |
| `node tools/disasm-check.ts` | 改了反汇编器（需要 test-data/8088/） |
| `node tools/run-exe.ts <EXE> [命令行] [条数] [截图.png]` | 看一个 DOS 程序用到了哪些中断、端口和没实现的功能；同目录的文件放进虚拟磁盘，图形模式可存截图 |
| `node tools/ui-bgi.mjs <截图目录> <EXE> [x,y ...]` | 改了平面模式：在浏览器里运行 BGI 图形程序并单击（用户的 D:OLDgraphdmoGRAPHDMO.EXE，不提交） |
| `URL=http://localhost:5173/ node tools/ui-startup-check.mjs` | 改了启动入口、设备配置、冷/热启动 |
| `URL=… node tools/ui-export-check.mjs` | 改了编辑器新建/替换、生成 EXE/COM |
| `URL=… node tools/ui-capture-check.mjs` | 改了鼠标/键盘捕获 |
| `URL=… node tools/ui-snapshot-check.mjs` | 改了快照，或给设备加了新状态（`PRODUCTION_URL` 可验证生产版恢复） |
| `URL=… node tools/ui-sound-check.mjs` | 改了 SB16 或 PCM 输出 |

新功能要加测试；新的汇编语法要在 `tests/ml/` 加一个 ML 对照程序。

### 发布

提交并推送到 main，GitHub Actions 会运行测试、编译并更新 GitHub Pages 上的网页。

### 需要记住的坑

- `vite.config.ts` 的构建目标必须是 `es2022`：默认目标会把类字段改写成 `defineProperty`，CPU 模拟慢 40% 左右，386 的原机速度会跟不上。
- CPU 核心（src/cpu/cpu.ts）是 8088/286/386/486 共用的。改了以后三个都要跑：`npm run test:cpu`（8088，约 1 分钟）、`npm run test:cpu386`（386 实模式，约 20 秒）、`npx vitest run`（286/386 保护模式）。8088/286 的快速路径（pushN/popN、readLin 不查 16MB 边界）是为了速度特意分开的。
- **速度相关（0.55~0.59 的提速靠这些，改代码时别破坏）**：
  - 找瓶颈：`node --cpu-prof tools/bench-boot.ts …` 看函数和行的自身时间；再和 `--max-inlined-bytecode-size-cumulative=8000` 的结果逐函数对比，差别大的地方就是 V8 内联预算（每个函数约 920 字节码）不够、没被内联的调用。浏览器里改不了这个参数，只能改代码
  - 每条指令都走的路径（`Machine.runLoop → exec1 → cpu.step`、`advanceInstr`）要保持小；不常用的分支放进单独的函数
  - 虚拟时间 `clock` 是小数：作为参数传给没被内联的函数时 V8 每次都在堆上分配，所以热路径上的函数不带小数参数（`advanceInstr()` 从字段里读）
  - 取指令窗口（`fLo/fHi/fDelta`）：每条指令开始时核对 CS 基址、界限、CPL、CR0、A20；作废 TLB 时一起作废（`fetchKey = -1` 的地方）
  - 段的快速界限（`rdMax/wrMax`）：改了 `cLimit`、`cAccess`、`cNull` 之后必须调用 `segFast(i)`
  - 中断请求线 `cpu.irqCheck`：8259、鼠标的状态变了要通过 `onChange` 通知；新加的中断来源如果不经过 8259 的 `raise/lower`，也要把 `irqCheck` 置成 true
  - 串口和鼠标按事件推进（`Machine.serialNext`）：程序读写串口寄存器会置 `UART.touched`；新外设接到串口上时（不是串口鼠标）会自动退回每条指令推进
  - 历史记录约占 20% 的时间，所以从磁盘启动时默认不记录（工具栏"记录"）
- 机器的 `run()` 要按虚拟时间（`untilClock`）限制，不能只按指令条数：等磁盘、HLT 时一条"指令"可能走过很长的虚拟时间，双机会失去同步。
- 2003 年的 send.asm/receive.asm 在仓库外（`d:\asmperfect\`），不提交；依赖它们的测试找不到文件时自动跳过。它们只有在"286/386 + 虚拟串口 + DOS 文件操作消耗时间"下才能成功，原因见 README 和提交记录。
- 快照（src/machine/snapshot.ts）：设备加了新的内部状态，要同时加进快照；格式变了要升版本号，并保留读取旧版本（现在是 v2，能读 v1，tests/fixtures/snapshot-v1.asmsnap）。
- 改 PIT 2 号通道之后，从磁盘启动的校验和会变（读 61h 位 5 的程序行为不同），不能拿来和改之前的直接比。
- 界面里的调试对象 `window.__app` 只在开发版里有，正式版没有。
