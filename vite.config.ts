/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { teachingPackages } from './tools/teaching-pack.ts';

export default defineConfig({
  plugins: [teachingPackages(process.cwd())],
  build: {
    // 保留原生的类字段：默认目标会把它们改写成 defineProperty，CPU 模拟器的对象访问会慢 40% 左右
    target: 'es2022',
    rollupOptions: {
      input: {
        app: resolve('index.html'),
        ch01: resolve('teaching', 'ch01', 'index.html'),
        ch02: resolve('teaching', 'ch02', 'index.html'),
        ch03: resolve('teaching', 'ch03', 'index.html'),
        ch04: resolve('teaching', 'ch04', 'index.html'),
      },
    },
  },
  test: {
    // 有些测试要模拟几秒钟的虚拟时间（例如两台机器经串口聊天），GitHub Actions 的机器比本机慢好几倍，
    // 默认的 5 秒会超时
    testTimeout: 60_000,
  },
});
