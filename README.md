# AsmPerfect 86

在浏览器里编写、汇编、运行和**单步调试** 8086 汇编程序。CPU、汇编器、BIOS/DOS 都是用 TypeScript 写的，不依赖 DOSBox，因此调试器能看到并回退每一条指令的效果。

## 运行

```bash
npm install
npm run dev        # 打开 http://localhost:5173
npm run build      # 生成静态网页到 dist/
```

## 功能

- **编辑器**：语法高亮、断点（点击行号左侧）、错误标记、悬停提示（寄存器和变量的当前值、指令说明、`INT 21h` 当前 AH 对应的功能）、可选显示每行的地址和机器码
- **调试**：单步进入（F11）、单步跳过（F10，整体执行 CALL/INT/LOOP）、跳出子程序（Shift+F11）、运行到光标处（Ctrl+F10）、**后退一步**（Ctrl+Shift+F11，可一直退回程序开头，内存同时恢复）、断点、按每秒 1~100 步的速度动画运行；点寄存器可以直接修改，点标志位可以切换
- **面板**：寄存器（高低字节分开、刚改变的值高亮）、标志位、栈（标出返回地址来自哪一行）、变量、内存、DOS 屏幕（80×25 彩色文本）、虚拟磁盘。四个窗口之间的分隔条可以拖动调整大小（双击恢复，大小会记住），每个窗口都可以最大化（标题栏右边的按钮或双击标题栏，Esc 还原）
- **硬件**：中断向量表、8259 中断控制器、8253 定时器（IRQ0 → INT 8 → INT 1Ch）、键盘控制器（IRQ1 → INT 9，端口 60h 扫描码）、8250 串口（COM1/COM2，含回环模式）。程序可以像在真机上一样挂接中断
- **双机模式**：两台虚拟 PC 的 COM1 用虚拟交叉线连接，按虚拟时间同步运行。可选接线方式（全握手 / 部分握手 / 三线制）、串口芯片（真实 8250 / 带缓冲和硬件流控的虚拟串口），面板上显示 DTR/RTS/CTS/DSR 信号和线路上的每个字节
- **CPU 型号**：8088、286、386 三种速度；选 286/386 时 PUSH SP 等少数指令按 286 的方式执行
- **原机速度**：按所选 CPU 的真实速度运行（虚拟时间与真实时间同步），延时、时钟、波特率和声音都与原机一致；也可以全速运行或按每秒 1~100 步动画执行
- **PC 喇叭**：8253 的 2 号通道 + 端口 61h，用 Web Audio 发声（示例：两只老虎）
- **直接运行 DOS 程序**：把 EXE/COM 上传到虚拟磁盘后点"运行"（MZ 重定位、PKLITE 等自解压程序、DOS 内存控制块链）
- **从磁盘启动真 DOS**：放入软盘或硬盘映像（.img），像开机一样从 A: 或 C: 启动；INT 13h 按扇区读写，新建空白硬盘，映像保存在浏览器里。MS-DOS 6.22 可以从安装盘启动，并安装到虚拟硬盘上
- **中文显示**：屏幕上勾选"中文"，像 UCDOS 那样把 GBK 显示成汉字，并自动识别西文制表符
- **图形模式**：VGA 13h（320×200、256 色，调色板端口 3C7h~3C9h、INT 10h AH=10h）、CGA 04h/05h/06h；EGA/VGA 16 色平面模式 0Dh、0Eh、10h、12h（640×480），模拟 4 个位平面、定序器、图形控制器（写模式 0~3、读模式 0/1、锁存器、逻辑运算、位屏蔽）和属性控制器调色板，Turbo Pascal/Turbo C 的 EGAVGA.BGI 驱动可以直接用；BIOS 写点/读点、图形模式下显示文字（内置 8×8 点阵字库）
- **鼠标**：INT 33h 鼠标驱动（检测、显示/隐藏光标、读位置和按键、按下/松开计数、活动范围、光标形状、移动量、事件回调等），文本模式和图形模式都有光标
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
node tools/ml-compare.ts tests/ml/*.asm   # 与 MASM 6.11 逐字节对照（需要 ML.EXE，用环境变量 ML_EXE 指定）
node tools/serial-demo.ts send.asm recv.asm 286 buffered   # 双机串口文件传输实验（命令行）
```

`test:cpu` 需要先把测试集下载到 `test-data/8088/`（约 730MB，见 https://github.com/SingleStepTests/8088 的 `v2` 目录）。

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

## Releasing (family server)

AsmPerfect 86 runs on the family server at **http://192.168.0.120:8075/** and appears on the
family front page (http://192.168.0.120:8060/).

1. Commit and push.
2. Double-click `release.bat`. It refuses unless everything is pushed; then the server pulls from
   GitHub, rebuilds the image (`deploy/Dockerfile`: Node builds the app, a small Python server
   serves it) and restarts the container, and the script checks that the page reports this commit.

The version shown in the app (hover the title) is `0.<number of commits>`. The app keeps no data on
the server: programs, settings and the virtual disks stay in each browser.

### Setting up the server (once)

On the server (`ssh songthin@192.168.0.120`), with a read-only deploy key for this repo:

```bash
ssh-keygen -q -t ed25519 -C "asmperfect-server" -f ~/.ssh/github_asmperfect -N ""
printf '\nHost github-asmperfect\n    HostName github.com\n    User git\n    IdentityFile ~/.ssh/github_asmperfect\n    IdentitiesOnly yes\n' >> ~/.ssh/config
cat ~/.ssh/github_asmperfect.pub   # add it: repo -> Settings -> Deploy keys, "Allow write access" unticked
ssh -o StrictHostKeyChecking=accept-new -T git@github-asmperfect
git clone git@github-asmperfect:JiuqingSong/asm.git ~/asmperfect
~/asmperfect/deploy/setup-server.sh
```

Never commit or edit inside the server's clone; `git pull --ff-only` must keep working.
