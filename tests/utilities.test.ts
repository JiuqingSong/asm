import { describe, it, expect } from 'vitest';
import { Machine } from '../src/machine/machine.ts';
import { loadExecutable } from '../src/machine/exe.ts';
import { UTILITIES, buildUtility } from '../src/dos/utilities.ts';

function runCom(bytes: Uint8Array, setup: (m: Machine) => void, cmdline = ''): Machine {
  const m = new Machine();
  m.load(loadExecutable(bytes, 'MOUSE.COM').program, cmdline, 'MOUSE.COM');
  setup(m);
  for (let k = 0; k < 20 && m.status !== 'exited'; k++) m.run(1_000_000);
  return m;
}
const vec33 = (m: Machine) => [m.mem[0xcc] | (m.mem[0xcd] << 8), m.mem[0xce] | (m.mem[0xcf] << 8)];

describe('DOS 小工具', () => {
  it('全部能汇编', () => {
    for (const u of UTILITIES) expect(buildUtility(u).length).toBeGreaterThan(10);
  });

  it('MOUSE.COM：把被 DOS 改成 IRET 的 INT 33h 改回 BIOS 里的驱动', () => {
    const com = buildUtility(UTILITIES.find(u => u.name === 'MOUSE.COM')!);
    // 模拟 DOS 启动后的样子：INT 33h 指向一条 IRET
    const m = runCom(com, m => { m.mem[0x600] = 0xcf; m.mem.set([0x00, 0x06, 0x00, 0x00], 0xcc); });
    expect(m.exitCode).toBe(0);
    expect(vec33(m)).toEqual([0x0198, 0xf000]);
    expect(m.mouse.used).toBe(true);
    expect(m.console).toMatch(/Mouse Driver installed/);
    // 再运行一次：已经装好了
    const again = runCom(com, () => { /* 向量本来就指向 BIOS */ });
    expect(again.console).toMatch(/already installed/);
    // 卸载
    const un = runCom(com, () => { /* */ }, ' /u');
    expect(vec33(un)).toEqual([0x019a, 0xf000]);
    expect(un.console).toMatch(/removed/);
  });

  it('SHUTDOWN.COM：写回缓冲区后通过 APM 关机', () => {
    const com = buildUtility(UTILITIES.find(u => u.name === 'SHUTDOWN.COM')!);
    const m = runCom(com, () => { /* */ });
    expect(m.poweredOff).toBe(true);
    expect(m.status).toBe('exited');
    expect(m.message).toMatch(/APM/);
    expect(m.video.peek(0xb8000)).toBe(0x20);   // 屏幕清空
  });
});
