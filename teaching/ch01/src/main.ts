import { startMemoryChapter } from '../../shared/memory-host.ts';
import { Memory } from './core.ts';
import { EXPERIMENTS } from './experiments.ts';

startMemoryChapter({ number: 1, title: '我们究竟要模拟什么', create: () => new Memory(), experiments: EXPERIMENTS });
