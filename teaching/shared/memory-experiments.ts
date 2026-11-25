export interface MemoryModel {
  readonly size: number;
  reset(): void;
  read8(address: number): number;
  write8(address: number, value: number): void;
  peek(address: number, length: number): Uint8Array;
  read16LE?(address: number): number;
  write16LE?(address: number, value: number): void;
}

export type MemoryStep =
  | { readonly kind: 'write8' | 'write16'; readonly address: number; readonly value: number }
  | { readonly kind: 'read8' | 'read16'; readonly address: number; readonly expected: number }
  | { readonly kind: 'bytes'; readonly address: number; readonly expected: readonly number[] }
  | { readonly kind: 'interpret'; readonly width: 8 | 16; readonly value: number; readonly expectedSigned: number }
  | { readonly kind: 'sum'; readonly width: 8 | 16; readonly left: number; readonly right: number; readonly expectedLow: number; readonly expectedOutside: boolean }
  | { readonly kind: 'reject8' | 'reject16'; readonly address: number; readonly value: number; readonly contains: string }
  | { readonly kind: 'copy'; readonly address: number; readonly length: number };

export interface MemoryExperiment {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly steps: readonly MemoryStep[];
}

export function describeValue(value: number, width: 8 | 16) {
  const range = 2 ** width;
  if (!Number.isInteger(value) || value < 0 || value >= range) throw new Error(`位模式必须位于 0～${range - 1}`);
  return {
    unsigned: value,
    signed: value < range / 2 ? value : value - range,
    hex: value.toString(16).toUpperCase().padStart(width / 4, '0'),
    binary: value.toString(2).padStart(width, '0'),
  };
}

export function parseInteger(text: string): number {
  const input = text.trim();
  if (!/^(?:-?\d+|0x[0-9a-f]+|0b[01]+)$/i.test(input)) throw new Error('请输入完整的十进制整数、0x 十六进制数或 0b 二进制数');
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new Error('输入超出宿主可精确表示的整数范围');
  return value;
}

export function applyMemoryStep(memory: MemoryModel, step: MemoryStep): string {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error('断言失败：' + message);
  };
  switch (step.kind) {
    case 'write8':
      memory.write8(step.address, step.value);
      assert(memory.read8(step.address) === step.value, '字节写入后无法读回');
      return `宿主 write8(${step.address}, ${step.value})：读回相同值`;
    case 'read8':
      assert(memory.read8(step.address) === step.expected, `地址 ${step.address} 应为 ${step.expected}`);
      return `read8(${step.address}) = ${step.expected}`;
    case 'write16':
      if (!memory.write16LE || !memory.read16LE) throw new Error('本章没有 16 位读写能力');
      memory.write16LE(step.address, step.value);
      assert(memory.read16LE(step.address) === step.value, '16 位写入后无法读回');
      return `宿主 write16LE(${step.address}, ${step.value})：按低字节在前拆分`;
    case 'read16':
      if (!memory.read16LE) throw new Error('本章没有 16 位读取能力');
      assert(memory.read16LE(step.address) === step.expected, `16 位读取应为 ${step.expected}`);
      return `read16LE(${step.address}) = ${step.expected}`;
    case 'bytes':
      assert(memory.peek(step.address, step.expected.length).every((byte, index) => byte === step.expected[index]), '字节顺序不符合预期');
      return `地址 ${step.address} 起的字节顺序已检查`;
    case 'interpret': {
      const value = describeValue(step.value, step.width);
      assert(value.signed === step.expectedSigned, '补码解释不符合预期');
      return `宿主解释 ${step.width} 位 ${value.hex}：二进制 ${value.binary}，无符号 ${value.unsigned}，有符号 ${value.signed}`;
    }
    case 'sum': {
      describeValue(step.left, step.width);
      describeValue(step.right, step.width);
      const full = step.left + step.right;
      const range = 2 ** step.width;
      const low = full % range;
      assert(low === step.expectedLow && (full >= range) === step.expectedOutside, '截断结果或无符号越界判断错误');
      return `宿主数学演示（不是 CPU/ALU）：${step.left}+${step.right}=${full}，保留 ${step.width} 位为 ${low}，无符号越界=${full >= range}`;
    }
    case 'reject8':
    case 'reject16': {
      const before = memory.peek(0, memory.size);
      let fault: Error | null = null;
      try {
        if (step.kind === 'reject8') memory.write8(step.address, step.value);
        else {
          if (!memory.write16LE) throw new Error('本章没有 16 位写入能力');
          memory.write16LE(step.address, step.value);
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        fault = error;
      }
      assert(fault !== null && fault.message.includes(step.contains), '没有产生指定的输入错误');
      assert(memory.peek(0, memory.size).every((byte, index) => byte === before[index]), '失败操作改变了内存');
      return `预期输入错误：${fault?.message}；已检查整块内存不变`;
    }
    case 'copy': {
      const before = memory.peek(step.address, step.length);
      const copy = memory.peek(step.address, step.length);
      copy.fill(0);
      assert(memory.peek(step.address, step.length).every((byte, index) => byte === before[index]), '修改观察副本改变了内存');
      return '修改观察副本后，原内存不变';
    }
  }
}
