import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { CPU as Chapter3 } from '../teaching/ch03/src/core.ts';
import { CPU as Chapter4 } from '../teaching/ch04/src/core.ts';
import { Memory as Chapter2Memory } from '../teaching/ch02/src/core.ts';
import { EXPERIMENTS as CH01 } from '../teaching/ch01/src/experiments.ts';
import { EXPERIMENTS as CH03 } from '../teaching/ch03/src/experiments.ts';
import { EXPERIMENTS as CH04 } from '../teaching/ch04/src/experiments.ts';
import { CPU, CS } from '../src/cpu/cpu.ts';
import { assemble } from '../src/asm/assembler.ts';
import { TEACHING_CONFIG, teachingSource } from '../src/ui/teaching.ts';
import { chapterArchive, TEACHING_CHAPTERS } from '../tools/teaching-pack.ts';
import { checkExperiment } from '../teaching/shared/experiment-test.ts';
import { applyMemoryStep } from '../teaching/shared/memory-experiments.ts';

describe('教学实验与完整实现的已定义行为对照', () => {
  it('第二章仍满足第一章字节状态与错误边界实验', () => {
    for (const experiment of CH01) {
      const memory = new Chapter2Memory();
      for (const step of experiment.steps) applyMemoryStep(memory, step);
    }
  });
  for (const [create, experiments] of [[() => new Chapter3(), CH03], [() => new Chapter4(), CH04]] as const) {
    for (const experiment of experiments.filter(e => !e.fault)) {
      it(experiment.id, () => {
        const program = assemble(teachingSource(experiment));
        expect(program.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(program.chunks.flatMap(c => Array.from(c.bytes))).toEqual(experiment.bytes);
        const teaching = create();
        teaching.load(experiment.bytes);
        const full = new CPU();
        full.mem.set(program.chunks.flatMap(c => Array.from(c.bytes)));
        full.s[CS] = 0; full.ip = 0;
        full.setFlags(2);
        for (let step = 1; !full.halted && step < 20; step++) {
          teaching.step(); full.step();
          const state = teaching.state();
          expect(state.ip).toBe(full.ip);
          expect(state.registers).toEqual(Array.from(full.r));
          expect(state.status === 'halted').toBe(full.halted);
          const checkpoint = experiment.checkpoints.find(c => c.step === step);
          const mask = checkpoint?.flags?.mask ?? 0x08c5;
          expect(state.flags & (mask & 0x0fd5)).toBe(full.flags & (mask & 0x0fd5));
        }
        expect(full.halted).toBe(true);
      });
    }
  }

  it('第 4 章仍满足上一章成功与失败实验；所有可选服务确实关闭', () => {
    for (const experiment of CH03) checkExperiment(new Chapter4(), experiment);
    expect(Object.values(TEACHING_CONFIG).every(value => value === false)).toBe(true);
  });

  it('满 64KB 映像在 FFFFh 执行 HLT 后，16 位 IP 回绕到 0', () => {
    const bytes = Array(0x10000).fill(0);
    for (let i = 0; i < 0xffff; i += 3) bytes[i] = 0xb8;
    bytes[0xffff] = 0xf4;
    for (const machine of [new Chapter3(), new Chapter4()]) {
      machine.load(bytes);
      for (let i = 0; i < 0xffff / 3; i++) machine.step();
      expect(machine.state().ip).toBe(0xffff);
      machine.step();
      expect(machine.state().ip).toBe(0);
      expect(machine.state().status).toBe('halted');
    }
  });

  it('归档可校验且各章没有依赖另一章核心，包含独立构建、测试、稿件和锁文件', () => {
    for (const chapter of TEACHING_CHAPTERS) {
      const archive = chapterArchive(resolve('.'), chapter);
      const names: string[] = [];
      let offset = 0;
      while (archive[offset] !== 0) {
        const header = archive.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString().split('\0')[0];
        names.push(name);
        const checksum = parseInt(header.subarray(148, 154).toString(), 8);
        const copy = Buffer.from(header);
        copy.fill(32, 148, 156);
        expect(copy.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
        const length = parseInt(header.subarray(124, 135).toString(), 8);
        offset += 512 + Math.ceil(length / 512) * 512;
      }
      expect(names).toContain(`${chapter}/src/core.ts`);
      expect(names).toContain(`${chapter}/package-lock.json`);
      const opening = chapter === 'ch01' || chapter === 'ch02';
      expect(names).toContain(`${chapter}/tests/${opening ? 'memory' : 'core'}.test.ts`);
      expect(names).toContain(`${chapter}/CHAPTER.md`);
      expect(names).toContain(opening ? 'shared/memory-host.ts' : 'shared/host.ts');
      expect(names).not.toContain(opening ? 'shared/host.ts' : 'shared/memory-host.ts');
      expect(names.some(name => TEACHING_CHAPTERS.some(other => other !== chapter && name.startsWith(`${other}/`)))).toBe(false);
    }
  });
});
