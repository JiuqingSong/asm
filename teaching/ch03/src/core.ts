import type { MachineState, StepResult, TeachingMachine } from '../../shared/contracts.ts';

export class CPU implements TeachingMachine {
  private memory = new Uint8Array(0x10000);
  private registers = new Uint16Array(8);
  private ip = 0;
  private flags = 0x0002;
  private status: MachineState['status'] = 'ready';
  private error: string | null = null;
  private codeLength = 0;

  load(bytes: readonly number[]): void {
    if (!bytes.length || bytes.length > this.memory.length || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
      throw new Error('程序必须包含 1～65536 个合法字节；装载失败，原状态未修改');
    }
    this.memory.fill(0);
    this.memory.set(bytes);
    this.registers.fill(0);
    this.ip = 0;
    this.flags = 0x0002;
    this.status = 'ready';
    this.error = null;
    this.codeLength = bytes.length;
  }

  state(): MachineState {
    return Object.freeze({
      registers: Object.freeze(Array.from(this.registers)),
      ip: this.ip, flags: this.flags, status: this.status, error: this.error,
    });
  }

  peek(address: number, length: number): Uint8Array {
    if (!Number.isInteger(address) || !Number.isInteger(length) || address < 0 || length < 0 || address + length > this.memory.length) {
      throw new Error('查看范围必须位于 64KB 内存中');
    }
    return this.memory.slice(address, address + length);
  }

  step(): StepResult | null {
    if (this.status === 'error') throw new Error(this.error ?? '机器已出错，请重新装载');
    if (this.status === 'halted') return null;
    const start = this.ip;
    let cursor = start;
    const fetch8 = (): number => {
      if (cursor >= this.codeLength) throw new Error('指令字节不足（教学装载边界，不是 8086 异常）');
      const byte = this.memory[cursor];
      cursor = (cursor + 1) & 0xffff;
      return byte;
    };
    try {
      const opcode = fetch8();
      let instruction: string;
      if (opcode >= 0xb8 && opcode <= 0xbf) {
        const low = fetch8(), high = fetch8();
        this.registers[opcode - 0xb8] = low | (high << 8);
        instruction = 'MOV r16, imm16';
      } else if (opcode === 0xf4) {
        this.status = 'halted';
        instruction = 'HLT';
      } else {
        throw new Error(`本章未实现操作码 ${opcode.toString(16).padStart(2, '0')}（不是客体 #UD）`);
      }
      this.ip = cursor;
      return { start, end: cursor, opcode, instruction };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.status = 'error';
      this.error = `IP=${start.toString(16).padStart(4, '0')}：${error.message}`;
      throw new Error(this.error);
    }
  }
}
