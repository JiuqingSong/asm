import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // 保留原生的类字段：默认目标会把它们改写成 defineProperty，CPU 模拟器的对象访问会慢 40% 左右
    target: 'es2022',
  },
});
