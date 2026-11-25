import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export const TEACHING_CHAPTERS = ['ch01', 'ch02', 'ch03', 'ch04'] as const;
export type TeachingChapterId = typeof TEACHING_CHAPTERS[number];

function filesIn(directory: string): { name: string; bytes: Buffer }[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? filesIn(path).map(file => ({ ...file, name: `${entry.name}/${file.name}` }))
      : [{ name: entry.name, bytes: readFileSync(path) }];
  });
}

export function chapterArchive(root: string, chapter: TeachingChapterId): Buffer {
  const manuscript = readFileSync(join(root, 'docs', 'book', `${chapter}.md`), 'utf8')
    .replaceAll(`../../teaching/${chapter}/`, './')
    .replaceAll('../../teaching/shared/', '../shared/')
    .replaceAll('../../src/', 'https://github.com/JiuqingSong/asm/blob/main/src/')
    .replace('[teaching.test.ts](../../tests/teaching.test.ts)', 'teaching.test.ts（仅在原完整项目的 tests 目录）');
  const files = [
    ...filesIn(join(root, 'teaching', chapter)).map(file => ({ ...file, name: `${chapter}/${file.name}` })),
    ...filesIn(join(root, 'teaching', 'shared'))
      .filter(file => file.name === 'style.css' || ((chapter === 'ch01' || chapter === 'ch02') === file.name.startsWith('memory-')))
      .map(file => ({ ...file, name: `shared/${file.name}` })),
    { name: `${chapter}/CHAPTER.md`, bytes: Buffer.from(manuscript) },
  ];
  const blocks: Buffer[] = [];
  for (const file of files) {
    if (Buffer.byteLength(file.name) > 100) throw new Error(`教学源码归档路径过长：${file.name}`);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, 'utf8');
    const octal = (offset: number, length: number, value: number) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    octal(100, 8, 0o644);
    octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, file.bytes.length); octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function teachingPackages(root: string): Plugin {
  return {
    name: 'teaching-source-packages',
    transformIndexHtml(_html, context) {
      if (!TEACHING_CHAPTERS.some(chapter => resolve(context.filename) === join(root, 'teaching', chapter, 'index.html'))) return [];
      return [{ tag: 'meta', attrs: { name: 'asm86-platform', content: '../../' }, injectTo: 'head' }];
    },
    generateBundle() {
      for (const chapter of TEACHING_CHAPTERS) {
        this.emitFile({ type: 'asset', fileName: `teaching/${chapter}/source.tar`, source: chapterArchive(root, chapter) });
        this.emitFile({ type: 'asset', fileName: `teaching/${chapter}/manuscript.md`, source: readFileSync(join(root, 'docs', 'book', `${chapter}.md`)) });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        const match = /\/teaching\/(ch0[1-4])\/(source\.tar|manuscript\.md)$/.exec(path);
        if (!match) { next(); return; }
        const chapter = TEACHING_CHAPTERS.find(item => item === match[1]);
        if (!chapter) { next(new Error('未知教学章节')); return; }
        try {
          const archive = match[2] === 'source.tar';
          response.setHeader('Content-Type', archive ? 'application/x-tar' : 'text/markdown; charset=utf-8');
          response.end(archive ? chapterArchive(root, chapter) : readFileSync(join(root, 'docs', 'book', `${chapter}.md`)));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
