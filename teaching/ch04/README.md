# 第 4 章独立虚拟机

试验版本 pilot-1 / package 0.0.1，尚未创建 Git 提交或固定标签。

## 运行

需要 Node.js 22.18 或更新版本及 npm。下载的 tar 包解压后保持 `ch04` 与 `shared` 相邻，在 `ch04` 目录执行：

```text
npm ci
npm test
npm run dev
npm run build
```

打开 Vite 输出的地址；构建产物是 `dist` 静态页面。运行不需要第 3 章目录或完整项目。

原项目中的地址为 `/teaching/ch04/index.html`，源码下载为 `source.tar`，文字稿为 `manuscript.md`。独立源码包文字稿在 `CHAPTER.md`。

## 内容与边界

- `src/core.ts`：继承 MOV/HLT，增加 ADD/SUB/CMP/AND/OR/XOR 的 AX/16 位立即数编码。
- `src/experiments.ts`：六个实验及逐步断言，包含未实现 JMP 的失败实验。
- `src/main.ts`：只组合核心、实验和宿主。
- `tests/core.test.ts`：算术、比较、逻辑、观察副作用与上一章行为保留。
- `../shared`：不依赖未来章节的类型、实验检查、宿主与可选观察模块。

没有 ADC/SBB、字节运算、ModR/M、分支、分段、栈、设备、时间或中断。完整源码与第 3 章可以有相同的基础逻辑，但没有运行时引用上一章核心。

逻辑运算后 AF 未定义；本教学实现保留它，不将此行为作为真机契约。算术断言掩码为 08D5h，逻辑断言为 08C5h。

FLAGS 初值、教学错误和 HLT 边界与第 3 章相同。取消观察模块不影响 CPU；`state()`/`peek()` 只返回副本。机器码修改后要重新装载，原始断言不会自动变成新的预期。

## 工具和分发

独立工具版本固定在锁文件；使用 TypeScript 5.9.3、Vite 6.4.6 和修补后的 Vitest 5.1.1。新增代码未另行选定许可证，不携带商业系统映像，第三方工具适用各自许可证。
