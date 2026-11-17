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
- **调试**：单步进入（F11）、单步跳过（F10，整体执行 CALL/INT/LOOP）、**后退一步**（Shift+F11，可一直退回程序开头，内存同时恢复）、断点、按每秒 1~100 步的速度动画运行
- **面板**：寄存器（高低字节分开、刚改变的值高亮）、标志位、栈（标出返回地址来自哪一行）、变量、内存、DOS 屏幕（80×25 彩色文本）、虚拟磁盘
- **硬件**：中断向量表、8259 中断控制器、8253 定时器（IRQ0 → INT 8 → INT 1Ch）、键盘控制器（IRQ1 → INT 9，端口 60h 扫描码）、8250 串口（COM1/COM2，含回环模式）。程序可以像在真机上一样挂接中断
- **双机模式**：两台虚拟 PC 的 COM1 用虚拟交叉线连接，按虚拟时间同步运行。可选接线方式（全握手 / 部分握手 / 三线制）、串口芯片（真实 8250 / 带缓冲和硬件流控的虚拟串口），面板上显示 DTR/RTS/CTS/DSR 信号和线路上的每个字节
- **CPU 型号**：8088、286、386 三种速度；选 286/386 时 PUSH SP 等少数指令按 286 的方式执行
- **BIOS/DOS**：INT 10h、16h、1Ah，INT 21h 的常用功能（字符/字符串输入输出、行输入、中断向量、日期时间、文件读写等）

## 汇编器支持的语法（MASM 子集）

- `.MODEL SMALL/TINY` 简化段定义，以及 `SEGMENT/ENDS/ASSUME/GROUP` 完整段定义；EXE 和 COM（`ORG 100h`）
- `DB/DW/DD/DQ/DT`、`DUP`、`?`、字符串、`EQU`、`=`、`LABEL`、`PROC/ENDP`（NEAR/FAR）
- 表达式：`OFFSET SEG TYPE SIZE LENGTH SIZEOF LENGTHOF PTR SHORT HIGH LOW`，算术、逻辑和比较运算，段超越
- 宏：`MACRO/ENDM`（含 `LOCAL`、`EXITM`、`&` 拼接）、`REPT`、`IRP`、`IRPC`；条件汇编 `IF/IFE/IFDEF/IFNDEF/IFB/IFNB/ELSE/ENDIF`
- `.STARTUP`、`.EXIT`
- 条件跳转超出范围时自动扩展（与 MASM 6 相同）
- 常见错误给出中文说明，例如"不能把立即数直接送入段寄存器"

暂不支持：`STRUC`、`INCLUDE`、多模块（`EXTRN`）、80186 及以上指令、图形模式。

## 测试

```bash
npm test                                  # 汇编器 + 虚拟机 + 示例程序的端到端测试
npm run test:cpu                          # 用 SingleStepTests/8088 真机测试集验证 CPU（约 300 万个用例）
node tools/ml-compare.ts tests/ml/*.asm   # 与 MASM 6.11 逐字节对照（需要 ML.EXE，用环境变量 ML_EXE 指定）
node tools/serial-demo.ts send.asm recv.asm 286 buffered   # 双机串口文件传输实验（命令行）
```

`test:cpu` 需要先把测试集下载到 `test-data/8088/`（约 730MB，见 https://github.com/SingleStepTests/8088 的 `v2` 目录）。

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
