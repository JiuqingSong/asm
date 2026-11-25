# 第 2 章独立工程

本章保留 64KB 字节内存，增加 `read16LE`、`write16LE`。数值解释和截断演示属于宿主工具，不是 CPU、ALU 或 FLAGS。

文字稿在原仓库为 [ch02.md](../../docs/book/ch02.md)，下载源码包中为 `CHAPTER.md`。

在本目录运行：

```text
npm ci
npm test
npm run build
npm run dev
```

原仓库也可以在根目录 `npm run dev`，打开 `/teaching/ch02/index.html`。`dist` 可由静态 HTTP 服务器提供给浏览器。

下载源码包含 `ch02`、所需 `shared`、文字稿与锁文件；保留两个目录的相邻关系，不需要其他章节或完整项目。五个实验检查进制、实际小端字节顺序、补码宽度、无符号截断，以及失败的两字节写入不改变内存。核心不依赖 DOM；观察模块可以卸载。
