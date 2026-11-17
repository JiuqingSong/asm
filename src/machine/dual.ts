// 两台虚拟 PC 用串口线连接，按虚拟时间交替执行
import { IF } from '../cpu/cpu.ts';
import { Machine, type StopReason } from './machine.ts';
import { NullModem, type Wiring } from './uart.ts';

/** 两台机器之间允许的最大时间差（PIT 时钟）；远小于 57600bps 下一个字符的约 230 个时钟 */
const QUANTUM = 24;

export interface DualStop { reason: StopReason; who: number }

export class DualMachine {
  readonly m: [Machine, Machine];
  readonly link: NullModem;

  constructor(wiring: Wiring = 'loopback-rts') {
    this.m = [new Machine(), new Machine()];
    this.link = new NullModem(this.m[0].com1, this.m[1].com1, wiring);
    this.m[0].link = this.link;
    this.m[1].link = this.link;
  }

  /** 两台机器同时从时间 0 开始 */
  syncClocks(): void {
    const t = Math.max(this.m[0].clock, this.m[1].clock);
    for (const m of this.m) m.clock = t;
  }

  private active(m: Machine): boolean {
    return m.status === 'running' || m.status === 'ready' || m.status === 'paused';
  }

  /** 等待键盘的机器只有在有按键或有中断要处理时才需要执行 */
  private wakeable(m: Machine): boolean {
    return m.status === 'waiting' && (m.kbd.queue.length > 0 || (m.cpu.irq!.pending() && (m.cpu.flags & IF) !== 0));
  }

  /**
   * 两台机器一起连续运行，最多执行约 budget 条指令，或者都到达虚拟时间 untilClock。
   * 指定了 untilClock（按原机速度运行）时，等键盘的机器的时间也照常流逝。
   */
  run(budget: number, untilClock = Infinity): DualStop {
    let used = 0;
    const finished = (m: Machine) => m.status === 'exited' || m.status === 'error' || m.status === 'empty';
    while (used < budget) {
      const cand = [0, 1].filter(i => this.active(this.m[i]) || this.wakeable(this.m[i]));
      if (!cand.length) {
        // 都在等键盘或都结束了：如果线路上还有字节在传，让时间流逝到它到达
        const next = Math.min(...this.m.map(m => (m.status === 'waiting' ? m.nextSerialEvent() : Infinity)));
        if (next !== Infinity && next <= untilClock) {
          for (const m of this.m) m.idleTo(next);
          continue;
        }
        if (this.m.every(finished)) return { reason: 'exit', who: -1 };
        if (untilClock !== Infinity) {
          for (const m of this.m) m.idleTo(untilClock);
          return { reason: 'budget', who: -1 };
        }
        return { reason: 'wait', who: this.m.findIndex(m => m.status === 'waiting') };
      }
      if (cand.every(k => this.m[k].clock >= untilClock)) {
        for (const m of this.m) if (!cand.includes(m === this.m[0] ? 0 : 1)) m.idleTo(untilClock);
        return { reason: 'budget', who: -1 };
      }
      const i = cand.reduce((a, b) => (this.m[a].clock <= this.m[b].clock ? a : b));
      const me = this.m[i], other = this.m[1 - i];
      const otherActive = cand.includes(1 - i);
      const target = Math.min(untilClock, otherActive ? other.clock + QUANTUM : me.clock + QUANTUM * 8);
      const n = Math.max(1, Math.ceil((target - me.clock) / me.clocksPerInstr));
      const before = me.instructions;
      const r = me.run(n, target);
      used += Math.max(1, me.instructions - before);
      if (!otherActive) other.idleTo(me.clock);
      if (r === 'breakpoint' || r === 'error' || r === 'paused') {
        this.pauseAll();
        return { reason: r, who: i };
      }
    }
    return { reason: 'budget', who: -1 };
  }

  /** 单步调试其中一台；另一台同步运行到相同的虚拟时间 */
  step(who: number, how: 'into' | 'over' | 'out'): DualStop {
    const me = this.m[who], other = this.m[1 - who];
    const r = how === 'over' ? me.stepOver() : how === 'out' ? me.stepOut() : me.stepInto();
    this.catchUp(other, me.clock);
    return { reason: r, who };
  }

  catchUp(m: Machine, t: number): void {
    if (this.active(m) || this.wakeable(m)) {
      let guard = 0;
      while (m.clock < t && guard++ < 100_000) {
        const n = Math.max(1, Math.ceil((t - m.clock) / m.clocksPerInstr));
        const r = m.run(n, t);
        if (r !== 'budget') break;
      }
      if (m.status === 'running') m.pause();
    }
    m.idleTo(t);
  }

  pauseAll(): void { for (const m of this.m) m.pause(); }
}
