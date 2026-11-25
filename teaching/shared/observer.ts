import { REGISTER_NAMES, type MachineState, type StepResult, type TeachingMachine } from './contracts.ts';

const hex = (value: number, width = 4) => value.toString(16).toUpperCase().padStart(width, '0');

export function mountObserver(container: HTMLElement, machine: TeachingMachine) {
  const stateView = document.createElement('pre');
  stateView.id = 'machine-state';
  const traceView = document.createElement('pre');
  traceView.id = 'execution-trace';
  container.replaceChildren(stateView, traceView);
  const trace: string[] = [];
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const state = machine.state();
    const names = REGISTER_NAMES.map((name, i) => `${name}=${hex(state.registers[i])}`).join('  ');
    const flags = [['CF', 1], ['PF', 4], ['AF', 16], ['ZF', 64], ['SF', 128], ['OF', 2048]] as const;
    stateView.textContent = `${names}\nIP=${hex(state.ip)}  FLAGS=${hex(state.flags)}  状态=${state.status}\n`
      + flags.map(([name, mask]) => `${name}=${state.flags & mask ? 1 : 0}`).join('  ')
      + `\n内存 0000..001F：${Array.from(machine.peek(0, 32), b => hex(b, 2)).join(' ')}\n`
      + (state.error ?? '');
    traceView.textContent = trace.length ? '实际执行记录（最近 100 步）：\n' + trace.join('\n') : '尚未记录指令；观察模块不会执行客体指令。';
  };

  return {
    render,
    record(result: StepResult, before: MachineState): void {
      if (disposed) return;
      const after = machine.state();
      trace.push(`${hex(result.start)} → ${hex(result.end)}  ${hex(result.opcode, 2)} ${result.instruction}`
        + `  AX ${hex(before.registers[0])}→${hex(after.registers[0])} FLAGS ${hex(before.flags)}→${hex(after.flags)}`);
      if (trace.length > 100) trace.shift();
      render();
    },
    dispose(): void {
      disposed = true;
      trace.length = 0;
      container.replaceChildren();
    },
  };
}
