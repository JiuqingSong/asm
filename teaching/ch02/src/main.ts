import { startMemoryChapter } from '../../shared/memory-host.ts';
import { Memory } from './core.ts';
import { EXPERIMENTS } from './experiments.ts';

startMemoryChapter({ number: 2, title: '数字如何进入机器', create: () => new Memory(), experiments: EXPERIMENTS });
