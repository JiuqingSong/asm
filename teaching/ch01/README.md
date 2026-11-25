# 第 1 章独立工程

本章只有 64KB 字节内存，不执行 CPU 指令。核心不依赖 DOM；浏览器宿主和可卸载的只读观察模块位于相邻 `shared` 目录。

文字稿在原仓库为 [ch01.md](../../docs/book/ch01.md)，下载源码包中为 `CHAPTER.md`。

在本目录运行：

```text
npm ci
npm test
npm run build
npm run dev
```

原仓库也可以在根目录 `npm run dev`，打开 `/teaching/ch01/index.html`。`dist` 可由静态 HTTP 服务器提供给浏览器。

下载的 `source.tar` 含 `ch01`、所需 `shared`、文字稿和锁文件；请保留两个目录的相邻关系，无须完整仓库或其他章节。三个实验检查字节状态、地址与内容、观察副本隔离，以及错误输入不改变内存。尚未实现 CPU、分段、BIOS、DOS 或设备。
