/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // 保留原生的类字段：默认目标会把它们改写成 defineProperty，CPU 模拟器的对象访问会慢 40% 左右
    target: 'es2022',
  },
  test: {
    // 有些测试要模拟几秒钟的虚拟时间（例如两台机器经串口聊天），GitHub Actions 的机器比本机慢好几倍，
    // 默认的 5 秒会超时
    testTimeout: 60_000,
  },
});
