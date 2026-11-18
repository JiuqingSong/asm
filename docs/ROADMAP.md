# AsmPerfect 86 开发计划

最后更新：2026-11-17（版本 0.9）。下次继续时，先读"现状"和"工作约定"，再从"下一步"里挑一项。

## 现状

线上地址：https://jiuqingsong.github.io/asm/ ，代码：https://github.com/JiuqingSong/asm

已经完成：

| 部分 | 内容 | 验证方式 |
|---|---|---|
| CPU | 8086/8088 全部指令，含未公开指令；286 档是 80286（含保护模式）；386 档是 80386（32 位指令、32 位保护模式、分页、V86） | SingleStepTests/8088 全部 3,007,000 个用例通过；SingleStepTests/80386 实模式 1,758,699 个用例中 53 个边角情况以外全部通过（`npm run test:cpu386`）；保护模式和分页见 tests/protected.test.ts、tests/cpu386.test.ts |
| 汇编器 | MASM 子集：简化段/完整段、宏、REPT/IRP/IRPC、条件汇编、多遍扫描、条件跳转自动扩展 | 9 个程序与 MASM 6.11（ML.EXE）逐字节一致 |
| 虚拟 PC | 中断向量表 + BIOS 陷阱、8259、8253、键盘（IRQ1/端口 60h）、8250 串口、PC 喇叭、BIOS/DOS 常用功能、虚拟磁盘 | 34 个端到端测试 |
| 调试 | 单步进入/跳过、后退（单机）、断点、按每秒 1~100 步动画执行、悬停显示值 | 测试 + 浏览器检查脚本 |
| 双机 | 两台机器的 COM1 用虚拟交叉线连接，按虚拟时间同步；三种接线、真实 8250 / 虚拟串口 | 2003 年的 send.asm/receive.asm 原样传输成功 |
| 速度 | 原机速度（默认，虚拟时间与真实时间同步）、全速、动画 | 浏览器实测：5 秒的程序用 5.1 秒 |
| 发布 | GitHub Pages（推送到 main 后由 GitHub Actions 自动测试、编译、发布） | Actions 的运行结果 |
| 调试器 | 反汇编视图（真机测试集 96,900 条指令长度全对；往返对照）、跳出、运行到光标处、修改寄存器和标志位 | 测试 + 浏览器检查脚本 `tools/ui-debug.mjs` |
| 图形模式 | VGA 13h（256 色、调色板端口）、CGA 04h/05h/06h、BIOS 写点/读点、图形模式下的文字（内置 8×8 点阵） | 示例"VGA 256 色""画线"；`tools/ui-gfx.mjs` |
| EGA/VGA 平面模式 | 0Dh、0Eh、10h、12h：4 个平面在 `Video.planar` 里，CPU 读写 A000 段经 `cpu.mmio` 交给图形控制器；属性控制器调色板 → DAC；反向执行能撤销平面写入；鼠标范围随模式变化。用户的 Turbo Pascal + EGAVGA.BGI 程序（中文界面、鼠标）能正常运行 | 测试 + `tools/ui-bgi.mjs`、`tools/run-exe.ts <EXE> "" <条数> <截图.png>` |
| 鼠标 | INT 33h 驱动：常用功能、事件回调（经 BIOS 桩代码远调用用户程序）、文本/图形光标；按键变化排队，至少保持 30 毫秒虚拟时间 | 测试 + `tools/ui-mouse.mjs` |
| 运行 DOS 程序 | 虚拟磁盘上的 EXE/COM 直接运行；DOS 内存控制块链（48h/49h/4Ah）、环境变量块；中文显示（GBK + 制表符识别） | 1996 年的 QuickBASIC 程序 SCRMK.EXE（PKLITE 压缩）能运行并显示中文菜单 |

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
- 80186 指令（`PUSH 立即数`、`SHL AX,4`、`PUSHA` 等）：可以做成"CPU 选 286 时允许"，CPU 和汇编器都要支持。
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
  - 286 保护模式 + A20 + 16MB 内存 + CMOS 复位恢复已完成（tests/protected.test.ts）：原版 HIMEM.SYS、DOS=HIGH、Windows 3.0 标准模式可以运行。Windows 3.1 也已经能安装、以标准模式运行，鼠标选 Microsoft, or IBM PS/2。386 第一段（32 位指令、32 位保护模式、分页）已完成：HIMEM.SYS 和 Windows 3.1 标准模式在 386 档上运行正常。下一步是第二段：用 EMM386.EXE 和 Windows 3.1 的 386 增强模式（`WIN /3`）检验虚拟 8086 模式和分页（V86 模式下的 BIOS 陷阱、I/O 许可位图、V86 中断的反射等已经写了，还没用真软件验证）；然后是 Windows 95（安装文件放在 ISO 当作的 D: 盘上）。用户的 Windows 3.1 映像在 D:Windows 3.1 EN，不提交。
- 缺少的 DOS 功能按需补：执行子程序（4Bh）等。运行 `node tools/run-exe.ts <文件>` 可以列出程序用到的中断、端口和没实现的功能。
- 图形模式（见第 2 项）。
- 中文显示的制表符识别是启发式规则（`src/ui/screen.ts` 的 `layoutGbk`），遇到识别错的屏幕，把它加进 `tests/screen.test.ts` 再调规则。

### 8. 其他

- 分享链接：把代码压缩后放进网址的 `#` 部分，打开就装载。
- 多文件：编辑器里保存多个程序，而不是只记住最近一份。
- 双机模式下后退：需要把串口线上的在途字节、UART 状态也纳入历史记录，工作量较大，优先级低。
- DOS 屏幕显示中文（GBK 双字节，类似 UCDOS）：不是真实 DOS 的行为，按需做。
- 手机/平板布局；CI（GitHub Actions 跑 `npm test`，CPU 测试集太大，不放 CI）。

## 工作约定

### 代码结构

```
src/cpu/cpu.ts          CPU（改动后必须跑 npm run test:cpu）
src/asm/                汇编器：lexer、assembler（伪指令、宏、多遍扫描、段布局）、encoder（指令编码）
src/machine/            devices（8259/8253/键盘）、uart（8250、串口线）、bios（BIOS/DOS 陷阱）、machine（装载、执行、调试、历史记录、虚拟时钟）、dual（双机调度）
src/ui/                 main（会话、运行控制）、editor（Monaco）、panels、screen、speaker、examples、help
.github/workflows/      GitHub Pages 的发布流程
tools/                  测试和检查脚本（见下）
```

### 验证

每次改动后至少跑前两项；改了哪部分就加跑对应的检查：

| 命令 | 什么时候跑 |
|---|---|
| `npx tsc --noEmit -p .` | 每次 |
| `npm test` | 每次（80 个测试） |
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
| `node tools/boot.ts <A: 映像> [C: 映像 或 new:64] [百万条指令] [按键…]` | 改了 INT 13h、开机流程：命令行里从磁盘启动并按键（`{ENTER}` `{F3}` `{SWAP}` 换盘 `{SHOT}` 显示屏幕），`SAVE_C` 保存硬盘映像 |
| `node tools/ui-fs.mjs <截图目录> <装好 DOS 的硬盘映像> <文件…>` | 改了映像里的文件（src/machine/fat.ts）：浏览、建目录、上传，再启动 DOS 用 DIR 查看 |
| `node tools/ui-boot.mjs <截图目录> <A: 映像> [按键…]` | 改了磁盘映像面板：在浏览器里放入软盘、新建硬盘、启动、按键（用户的 DOS 6.22 映像在 D:\DOS，不提交）；`HD=` 上传 C:，`ISO=` 把光盘映像放进 D: |
| `node tools/mkiso.ts <目录> <输出.iso> [卷标]` | 生成测试用的 ISO9660 光盘映像；配合 `ISO=映像 BOOT=C node tools/boot.ts - <C: 映像> …` 检查光盘变成的 D:（src/machine/iso.ts） |
| `node tools/trace-fpu.ts <TP 程序.EXE> [参数] [F2 或 3E:EC]` | 借用 Turbo Pascal 程序里的 8087 仿真器，统计一条浮点指令或 Sin/Cos 等函数执行的 8086 指令和循环 |
| `node tools/disasm-check.ts` | 改了反汇编器（需要 test-data/8088/） |
| `node tools/run-exe.ts <EXE> [命令行] [条数] [截图.png]` | 看一个 DOS 程序用到了哪些中断、端口和没实现的功能；同目录的文件放进虚拟磁盘，图形模式可存截图 |
| `node tools/ui-bgi.mjs <截图目录> <EXE> [x,y ...]` | 改了平面模式：在浏览器里运行 BGI 图形程序并单击（用户的 D:OLDgraphdmoGRAPHDMO.EXE，不提交） |

新功能要加测试；新的汇编语法要在 `tests/ml/` 加一个 ML 对照程序。

### 发布

提交并推送到 main，GitHub Actions 会运行测试、编译并更新 GitHub Pages 上的网页。

### 需要记住的坑

- `vite.config.ts` 的构建目标必须是 `es2022`：默认目标会把类字段改写成 `defineProperty`，CPU 模拟慢 40% 左右，386 的原机速度会跟不上。
- CPU 核心（src/cpu/cpu.ts）是 8088/286/386 共用的。改了以后三个都要跑：`npm run test:cpu`（8088，约 1 分钟）、`npm run test:cpu386`（386 实模式，约 20 秒）、`npx vitest run`（286/386 保护模式）。8088/286 的快速路径（pushN/popN、readLin 不查 16MB 边界）是为了速度特意分开的。
- 机器的 `run()` 要按虚拟时间（`untilClock`）限制，不能只按指令条数：等磁盘、HLT 时一条"指令"可能走过很长的虚拟时间，双机会失去同步。
- 2003 年的 send.asm/receive.asm 在仓库外（`d:\asmperfect\`），不提交；依赖它们的测试找不到文件时自动跳过。它们只有在"286/386 + 虚拟串口 + DOS 文件操作消耗时间"下才能成功，原因见 README 和提交记录。
- 界面里的调试对象 `window.__app` 只在开发版里有，正式版没有。
