import { softfloatWasm } from './softfloat-wasm.ts';

export type Float80 = bigint;
export const F80_SIGN = 1n << 79n;
export const F80_INT = 1n << 63n;
export const F80_MASK = (1n << 64n) - 1n;
export const F80_INDEFINITE = 0xffffc000000000000000n;
export const f80Exponent = (a: Float80): number => Number(a >> 64n) & 0x7fff;
export const f80NaN = (a: Float80): boolean => f80Exponent(a) === 0x7fff && (a & (F80_INT - 1n)) !== 0n;
export const f80Unsupported = (a: Float80): boolean => f80Exponent(a) !== 0 && !(a & F80_INT);

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  get_buffer(): number;
  calculate(op: number, control: number): void;
}

let kernel: Kernel | undefined;
let buffer: Uint32Array;

export interface FloatResult { value: Float80; flags: number }

/** SoftFloat flags are translated to the x87 IE/ZE/OE/UE/PE bit positions. */
export function calculate(op: number, a: Float80, b: Float80, control: number): FloatResult {
  if (!kernel) {
    const bytes = Uint8Array.from(atob(softfloatWasm), c => c.charCodeAt(0));
    kernel = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as Kernel;
    buffer = new Uint32Array(kernel.memory.buffer, kernel.get_buffer(), 12);
  }
  buffer[0] = Number(a & 0xffffffffn);
  buffer[1] = Number((a >> 32n) & 0xffffffffn);
  buffer[2] = Number(a >> 64n);
  buffer[3] = Number(b & 0xffffffffn);
  buffer[4] = Number((b >> 32n) & 0xffffffffn);
  buffer[5] = Number(b >> 64n);
  kernel.calculate(op, control);
  const f = buffer[11];
  return {
    value: BigInt(buffer[8]) | (BigInt(buffer[9]) << 32n) | (BigInt(buffer[10]) << 64n),
    flags: ((f & 16) >> 4) | ((f & 8) >> 1) | ((f & 4) << 1) | ((f & 2) << 3) | ((f & 1) << 5) | ((f & 0x80) << 2),
  };
}

export function float80Bytes(a: Float80): Uint8Array {
  const bytes = new Uint8Array(10);
  for (let k = 0; k < 10; k++, a >>= 8n) bytes[k] = Number(a & 255n);
  return bytes;
}

export function bytesFloat80(bytes: Uint8Array): Float80 {
  let a = 0n;
  for (let k = bytes.length - 1; k >= 0; k--) a = (a << 8n) | BigInt(bytes[k]);
  return a;
}
