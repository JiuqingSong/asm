# 第 3 章独立虚拟机

试验版本 pilot-1 / package 0.0.1，尚未创建 Git 提交或固定标签。

## 运行

需要 Node.js 22.18 或更新版本及 npm。下载的 tar 包使用 Windows 自带 tar 或支持 tar 的解压工具展开，保持 `ch03` 与 `shared` 相邻，在 `ch03` 目录执行：

```text
npm ci
npm test
npm run dev
npm run build
```

打开 Vite 输出的地址。构建产物是 `dist` 中的静态页面；不要直接通过 file 协议打开 TypeScript 源码。

在原项目开发服务器中，本章地址为 `/teaching/ch03/index.html`；构建后的 `source.tar` 与 `manuscript.md` 提供完整下载。独立工程自身不重新打包下载文件，文字稿见源码包中的 `CHAPTER.md`。

## 内容与边界

- `src/core.ts`：64KB 内存、MOV r16/立即数、HLT，不依赖完整 CPU、DOM 或观察模块。
- `src/experiments.ts`：四个实验的机器码、可读汇编、检查点和预期教学错误。
- `src/main.ts`：组合核心和宿主，不实现 CPU 语义。
- `tests/core.test.ts`：状态不变量和固定断言。
- `../shared/contracts.ts`：类型与检查点检查。
- `../shared/host.ts`：装载、按钮、有限步执行与断言。
- `../shared/observer.ts`：可卸载的只读观察模块，最近 100 步轨迹。
- `../shared/experiment-test.ts`：仅测试使用，不由运行核心导入。

不含第 4 章源码；不依赖原项目目录。没有 BIOS、DOS、分段、时钟、显卡、栈或中断。网页寄存器面板是宿主仪器，不是客体输出设备。

本章 FLAGS 初值仅建模为 0002h；真实 8088 高位为 F002h。截断指令、未实现操作码是明确的教学错误，不冒充 CPU 异常。HLT 不模拟唤醒。

输入修改后必须重新装载；检查点保留原实验期望，不随输入自动变化。取消观察模块后，运行与检查仍可进行。

## 工具和分发

TypeScript/Vite 沿用项目工具链；独立测试使用修补后的 Vitest 5.1.1，避免在新工程中沿用旧测试依赖的已知问题。依赖固定在 package-lock.json。

源码来自本项目的教学试验，不携带第三方 CPU 源码、商业 OS 或磁盘映像；新增教学源码未另行选定许可证，不应据此假设额外授权。依赖包适用各自许可证。
