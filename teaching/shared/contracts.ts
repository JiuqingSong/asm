export const REGISTER_NAMES = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'] as const;
export type RegisterName = typeof REGISTER_NAMES[number];

export interface MachineState {
  readonly registers: readonly number[];
  readonly ip: number;
  readonly flags: number;
  readonly status: 'ready' | 'halted' | 'error';
  readonly error: string | null;
}

export interface StepResult {
  readonly start: number;
  readonly end: number;
  readonly opcode: number;
  readonly instruction: string;
}

export interface TeachingMachine {
  load(bytes: readonly number[]): void;
  step(): StepResult | null;
  state(): MachineState;
  peek(address: number, length: number): Uint8Array;
}

export interface Checkpoint {
  readonly step: number;
  readonly ip: number;
  readonly registers?: Partial<Record<RegisterName, number>>;
  readonly flags?: { readonly mask: number; readonly value: number };
  readonly status?: MachineState['status'];
}

export interface Experiment {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly assembly: string;
  readonly bytes: readonly number[];
  readonly checkpoints: readonly Checkpoint[];
  readonly fault?: { readonly step: number; readonly ip: number; readonly contains: string };
}

export interface Chapter {
  readonly number: 3 | 4;
  readonly title: string;
  readonly capabilities: string;
  readonly experiments: readonly Experiment[];
  readonly create: () => TeachingMachine;
}

export function checkpointErrors(state: MachineState, checkpoint: Checkpoint): string[] {
  const errors: string[] = [];
  if (state.ip !== checkpoint.ip) errors.push(`IP 应为 ${checkpoint.ip}，实际 ${state.ip}`);
  for (const name of REGISTER_NAMES) {
    const value = checkpoint.registers?.[name];
    if (value !== undefined && state.registers[REGISTER_NAMES.indexOf(name)] !== value) {
      errors.push(`${name} 应为 ${value}，实际 ${state.registers[REGISTER_NAMES.indexOf(name)]}`);
    }
  }
  if (checkpoint.flags && (state.flags & checkpoint.flags.mask) !== checkpoint.flags.value) {
    errors.push(`FLAGS & ${checkpoint.flags.mask.toString(16)} 应为 ${checkpoint.flags.value.toString(16)}，实际 ${(state.flags & checkpoint.flags.mask).toString(16)}`);
  }
  if (checkpoint.status && state.status !== checkpoint.status) errors.push(`状态应为 ${checkpoint.status}，实际 ${state.status}`);
  return errors;
}
