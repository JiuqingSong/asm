import {
  bytesFloat80, calculate, float80Bytes, F80_INDEFINITE, F80_INT, F80_MASK, F80_SIGN,
  f80Exponent, f80NaN, f80Unsupported, type Float80, type FloatResult,
} from './softfloat.ts';
import { atan2, exp2m1, fixed, fromFixed, log2, scale80, trig } from './x87-math.ts';

const ONE = 0x3fff8000000000000000n;
const INFINITY = 0x7fff8000000000000000n;
const CONDITIONS = 0x4700;
const CONSTANTS = [
  ONE, 0x4000d49a784bcd1b8afen, 0x3fffb8aa3b295c17f0bcn,
  0x4000c90fdaa22168c235n, 0x3ffd9a209a84fbcff799n, 0x3ffeb17217f7d1cf79acn, 0n,
];

export interface FpuSnapshot {
  registers: Float80[];
  tags: Uint8Array;
  control: number;
  status: number;
  top: number;
  ip: number;
  cs: number;
  dp: number;
  ds: number;
  opcode: number;
}

export interface FpuContext {
  read(): Uint8Array;
  write(bytes: Uint8Array): void;
  ax(value: number): void;
  ip: number;
  cs: number;
  dp: number;
  ds: number;
  operand32: boolean;
  protectedMode: boolean;
}

export function fpuMemory(op: number, reg: number, operand32: boolean): { size: number; write: boolean } {
  const env = operand32 ? 28 : 14;
  if (!(op & 1)) return { size: op === 0xd8 || op === 0xda ? 4 : op === 0xdc ? 8 : 2, write: false };
  const sizes: Record<number, number[]> = {
    0xd9: [4, 0, 4, 4, env, 2, env, 2],
    0xdb: [4, 0, 4, 4, 0, 10, 0, 10],
    0xdd: [8, 0, 8, 8, env + 80, 0, env + 80, 2],
    0xdf: [2, 0, 2, 2, 10, 8, 10, 8],
  };
  return { size: sizes[op][reg], write: reg === 2 || reg === 3 || reg === 6 || reg === 7 };
}

export function fpuNoWait(op: number, modrm: number): boolean {
  return op === 0xdb && modrm >= 0xe0 && modrm <= 0xe4 ||
    op === 0xdf && modrm === 0xe0 ||
    modrm < 0xc0 && (op === 0xd9 || op === 0xdd) && (modrm & 0x38) >= 0x30;
}

class FpuAbort {}

export class X87 {
  registers: Float80[] = Array<Float80>(8).fill(0n);
  tags = new Uint8Array(8).fill(3);
  control = 0x037f;
  status = 0;
  top = 0;
  ip = 0;
  cs = 0;
  dp = 0;
  ds = 0;
  opcode = 0;
  onChange: (() => void) | null = null;
  onError: ((pending: boolean) => void) | null = null;

  get statusWord(): number { return (this.status & ~0x3800) | (this.top << 11); }
  get tagWord(): number { return this.tags.reduce((word, tag, i) => word | (tag << (i * 2)), 0); }
  get pending(): boolean { return (this.status & ~this.control & 0x3f) !== 0; }
  st(i = 0): Float80 { return this.registers[(this.top + i) & 7]; }
  tag(i = 0): number { return this.tags[(this.top + i) & 7]; }

  snapshot(): FpuSnapshot {
    return {
      registers: this.registers.slice(), tags: this.tags.slice(), control: this.control, status: this.status,
      top: this.top, ip: this.ip, cs: this.cs, dp: this.dp, ds: this.ds, opcode: this.opcode,
    };
  }
  restore(s: FpuSnapshot): void {
    this.registers = s.registers.slice(); this.tags.set(s.tags);
    this.control = s.control; this.status = s.status; this.top = s.top;
    this.ip = s.ip; this.cs = s.cs; this.dp = s.dp; this.ds = s.ds; this.opcode = s.opcode;
    this.updateError();
  }
  init(): void {
    this.control = 0x037f; this.status = 0; this.top = 0; this.tags.fill(3);
    this.ip = this.cs = this.dp = this.ds = this.opcode = 0;
    this.updateError();
  }
  private updateError(): void {
    if (this.pending) this.status |= 0x8080; else this.status &= ~0x8080;
    this.onError?.(this.pending);
  }
  private raise(flags: number, registerResult = false): void {
    this.status |= flags & 0x7f;
    this.updateError();
    if (flags & ~this.control & (registerResult ? 7 : 0x1f)) throw new FpuAbort();
  }
  private result(r: FloatResult, registerResult = false): Float80 {
    this.status = (this.status & ~0x200) | (r.flags & 0x200);
    this.raise(r.flags, registerResult);
    return r.value;
  }
  private stackFault(overflow: boolean): Float80 {
    this.status = (this.status & ~0x200) | (overflow ? 0x200 : 0);
    this.raise(0x41);
    return F80_INDEFINITE;
  }
  private get(i = 0): Float80 {
    if (this.tag(i) === 3) return this.stackFault(false);
    const value = this.st(i);
    if (f80Unsupported(value)) { this.raise(1); return F80_INDEFINITE; }
    return value;
  }
  private denormal(...values: Float80[]): void {
    if (values.some(value => f80Exponent(value) === 0 && (value & F80_MASK) !== 0n)) this.raise(2);
  }
  private set(i: number, value: Float80): void {
    const p = (this.top + i) & 7, e = f80Exponent(value);
    this.registers[p] = value;
    this.tags[p] = !(value & F80_MASK) && e === 0 ? 1 : e === 0 || e === 0x7fff || f80Unsupported(value) ? 2 : 0;
  }
  private push(value: Float80): void {
    const next = (this.top - 1) & 7;
    if (this.tags[next] !== 3) value = this.stackFault(true);
    this.top = next;
    this.set(0, value);
  }
  private pop(): void { this.tags[this.top] = 3; this.top = (this.top + 1) & 7; }
  private arithmetic(kind: number, a: Float80, b: Float80): Float80 {
    this.denormal(a, b);
    const op = kind === 0 ? 0 : kind === 1 ? 2 : kind <= 5 ? 1 : 3;
    if (kind === 5 || kind === 7) [a, b] = [b, a];
    return this.result(calculate(op, a, b, this.control), true);
  }
  private compare(a: Float80, b: Float80, quiet = false): void {
    this.denormal(a, b);
    const nan = f80NaN(a) || f80NaN(b);
    const r = calculate(6, a, b, this.control);
    if (nan && !quiet) r.flags |= 1;
    this.result(r);
    this.status = (this.status & ~CONDITIONS) | Number(r.value);
  }
  private fromInteger(value: bigint): Float80 { return this.result(calculate(7, BigInt.asUintN(64, value), 0n, this.control)); }
  private toInteger(value: Float80, bits: number): bigint {
    const r = calculate(8, value, 0n, this.control);
    let integer = BigInt.asIntN(64, r.value);
    const limit = 1n << BigInt(bits - 1);
    if (integer < -limit || integer >= limit || r.flags & 1) { r.flags = 1; integer = -limit; }
    this.result(r);
    return BigInt.asUintN(bits, integer);
  }

  execute(op: number, modrm: number, context: FpuContext): void {
    this.onChange?.();
    const oldRegisters = this.registers.slice(), oldTags = this.tags.slice(), oldTop = this.top;
    const reg = (modrm >> 3) & 7;
    const memory = modrm < 0xc0;
    const controlInstruction = memory ? op === 0xd9 && reg >= 4 || op === 0xdd && reg >= 4 :
      op === 0xdb && modrm >= 0xe0 && modrm <= 0xe4 || op === 0xdf && modrm === 0xe0;
    if (!controlInstruction) {
      this.ip = context.ip; this.cs = context.cs;
      this.opcode = ((op & 7) << 8) | modrm;
      if (memory) { this.dp = context.dp; this.ds = context.ds; }
      this.status &= ~0x200;
    }
    try {
      if (memory) this.memory(op, reg, context);
      else this.register(op, modrm, context);
    } catch (e) {
      if (!(e instanceof FpuAbort)) throw e;
      this.registers = oldRegisters; this.tags.set(oldTags); this.top = oldTop;
    }
    this.updateError();
  }

  private memory(op: number, reg: number, c: FpuContext): void {
    const writeInteger = (bits: number) => {
      c.write(float80Bytes(this.toInteger(this.get(), bits)).slice(0, bits / 8));
      if (reg === 3 || op === 0xdf && reg === 7) this.pop();
    };
    if (!(op & 1)) {
      const bytes = c.read();
      const raw = bytesFloat80(bytes);
      let value: Float80;
      if (op === 0xda || op === 0xde) value = this.fromInteger(BigInt.asIntN(bytes.length * 8, raw));
      else {
        const r = calculate(op === 0xd8 ? 9 : 10, raw, 0n, this.control);
        const exp = op === 0xd8 ? (Number(raw >> 23n) & 255) : Number(raw >> 52n) & 2047;
        if (exp === 0 && raw & (op === 0xd8 ? 0x7fffffn : 0xfffffffffffffn)) r.flags |= 2;
        value = this.result(r);
      }
      const a = this.get();
      if (reg === 2 || reg === 3) { this.compare(a, value); if (reg === 3) this.pop(); }
      else this.set(0, this.arithmetic(reg, a, value));
      return;
    }
    if (op === 0xd9 || op === 0xdd) {
      if (reg === 0) {
        const bytes = c.read(), raw = bytesFloat80(bytes);
        const r = calculate(op === 0xd9 ? 9 : 10, raw, 0n, this.control);
        const exp = op === 0xd9 ? Number(raw >> 23n) & 255 : Number(raw >> 52n) & 2047;
        if (exp === 0 && raw & (op === 0xd9 ? 0x7fffffn : 0xfffffffffffffn)) r.flags |= 2;
        this.push(this.result(r));
      } else if (reg === 2 || reg === 3) {
        const raw = this.result(calculate(op === 0xd9 ? 11 : 12, this.get(), 0n, this.control));
        c.write(float80Bytes(raw).slice(0, op === 0xd9 ? 4 : 8));
        if (reg === 3) this.pop();
      } else if (reg === 4) {
        const bytes = c.read();
        this.loadEnvironment(bytes, c);
        if (op === 0xdd) for (let k = 0; k < 8; k++) this.registers[(this.top + k) & 7] = bytesFloat80(bytes.subarray((c.operand32 ? 28 : 14) + k * 10, (c.operand32 ? 28 : 14) + k * 10 + 10));
      } else if (reg === 5 && op === 0xd9) {
        this.control = Number(bytesFloat80(c.read())) & 0x1f3f | 0x40;
      } else if (reg === 6) {
        const env = this.environment(c), out = new Uint8Array(env.length + (op === 0xdd ? 80 : 0));
        out.set(env);
        if (op === 0xdd) for (let k = 0; k < 8; k++) out.set(float80Bytes(this.st(k)), env.length + k * 10);
        c.write(out);
        if (op === 0xdd) this.init(); else this.control |= 0x3f;
      } else if (reg === 7) {
        const value = op === 0xd9 ? this.control : this.statusWord;
        c.write(new Uint8Array([value & 255, value >> 8]));
      } else throw new Error('Unsupported x87 memory encoding');
      return;
    }
    if (reg === 0 || reg === 5 && op === 0xdf) {
      const bytes = c.read();
      this.push(this.fromInteger(BigInt.asIntN(bytes.length * 8, bytesFloat80(bytes))));
    } else if (reg === 2 || reg === 3 || reg === 7 && op === 0xdf) {
      writeInteger(op === 0xdb ? 32 : reg === 7 ? 64 : 16);
    } else if (op === 0xdb && reg === 5) {
      this.push(bytesFloat80(c.read()));
    } else if (op === 0xdb && reg === 7) {
      const value = this.get();
      c.write(float80Bytes(value)); this.pop();
    } else if (op === 0xdf && reg === 4) {
      const bytes = c.read();
      let value = 0n;
      for (let k = 8; k >= 0; k--) value = value * 100n + BigInt((bytes[k] >> 4) * 10 + (bytes[k] & 15));
      this.push(this.fromInteger(bytes[9] & 0x80 ? -value : value));
    } else if (op === 0xdf && reg === 6) {
      const value = this.get();
      const raw = this.result(calculate(8, value, 0n, this.control));
      let integer = BigInt.asIntN(64, raw);
      const out = new Uint8Array(10);
      if (f80Exponent(value) === 0x7fff || integer <= -1000000000000000000n || integer >= 1000000000000000000n) {
        this.raise(1); out.set([0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0xff]);
      } else {
        out[9] = value & F80_SIGN ? 0x80 : 0;
        if (integer < 0n) integer = -integer;
        for (let k = 0; k < 9; k++) { out[k] = Number(integer % 10n); integer /= 10n; out[k] |= Number(integer % 10n) << 4; integer /= 10n; }
      }
      c.write(out); this.pop();
    } else throw new Error('Unsupported x87 memory encoding');
  }

  private register(op: number, m: number, c: FpuContext): void {
    const reg = (m >> 3) & 7, i = m & 7;
    if (op === 0xd8 || op === 0xdc || op === 0xde && m !== 0xd9) {
      const a = this.get(), b = this.get(i);
      if (reg === 2 || reg === 3) {
        this.compare(a, b); if (reg === 3) this.pop();
      } else if (op === 0xd8) this.set(0, this.arithmetic(reg, a, b));
      else {
        const kind = reg >= 4 ? reg ^ 1 : reg;
        this.set(i, this.arithmetic(kind, b, a));
        if (op === 0xde) this.pop();
      }
      return;
    }
    if (op === 0xd9) {
      if (m < 0xc8) { this.push(this.get(i)); return; }
      if (m < 0xd0) {
        const a = this.get(), b = this.get(i);
        this.set(0, b); this.set(i, a); return;
      }
      if (m === 0xd0) return;
      if (m === 0xe0 || m === 0xe1) { const a = this.get(); this.set(0, m === 0xe0 ? a ^ F80_SIGN : a & ~F80_SIGN); return; }
      if (m === 0xe4) { this.compare(this.get(), 0n); return; }
      if (m === 0xe5) {
        const a = this.st(), e = f80Exponent(a), empty = this.tag() === 3;
        const code = empty ? 0x4100 : !(a & F80_MASK) && e === 0 ? 0x4000 : f80Unsupported(a) ? 0 :
          e === 0x7fff ? f80NaN(a) ? 0x100 : 0x500 : e === 0 ? 0x4400 : 0x400;
        this.status = (this.status & ~CONDITIONS) | code | (a & F80_SIGN ? 0x200 : 0); return;
      }
      if (m >= 0xe8 && m <= 0xee) {
        let value = CONSTANTS[m - 0xe8];
        const rc = (this.control >> 10) & 3;
        if (m !== 0xe8 && m !== 0xee) {
          // Intel's constant ROM rounds at extended precision without raising PE.
          const nearestUp = m >= 0xea;
          if (nearestUp && (rc === 1 || rc === 3)) value--;
          else if (!nearestUp && rc === 2) value++;
        }
        this.push(value); return;
      }
      if (m >= 0xf0) { this.transcendental(m); return; }
    }
    if ((op === 0xda && m === 0xe9) || (op === 0xde && m === 0xd9)) {
      this.compare(this.get(), this.get(1), op === 0xda); this.pop(); this.pop(); return;
    }
    if (op === 0xdb && m >= 0xe0 && m <= 0xe4) {
      if (m === 0xe2) { this.status &= 0x7f00; this.updateError(); }
      else if (m === 0xe3) this.init();
      return;
    }
    if (op === 0xdd) {
      if (reg === 0) { this.tags[(this.top + i) & 7] = 3; return; }
      if (reg === 2 || reg === 3) { this.set(i, this.get()); if (reg === 3) this.pop(); return; }
      if (reg === 4 || reg === 5) { this.compare(this.get(), this.get(i), true); if (reg === 5) this.pop(); return; }
    }
    if (op === 0xdf && m === 0xe0) { c.ax(this.statusWord); return; }
    throw new Error(`Unsupported x87 register encoding ${op.toString(16)} ${m.toString(16)}`);
  }

  private transcendental(m: number): void {
    if (m === 0xf6 || m === 0xf7) { this.top = (this.top + (m === 0xf6 ? 7 : 1)) & 7; return; }
    const a = this.get(), e = f80Exponent(a);
    this.denormal(a);
    if (m === 0xfc) { this.set(0, this.result(calculate(5, a, 0n, this.control), true)); return; }
    if (m === 0xfa) { this.set(0, this.result(calculate(4, a, 0n, this.control), true)); return; }
    if (m === 0xf5 || m === 0xf8) { this.remainder(a, this.get(1), m === 0xf5); return; }
    if (m === 0xfd) {
      const b = this.get(1);
      this.denormal(b);
      if (f80NaN(a) || f80NaN(b)) { this.set(0, this.result(calculate(0, a, b, this.control))); return; }
      if (f80Exponent(b) === 0x7fff) {
        const negative = !!(b & F80_SIGN), zero = !(a & F80_MASK), infinity = e === 0x7fff;
        if (negative && infinity || !negative && zero) { this.raise(1); this.set(0, F80_INDEFINITE); }
        else this.set(0, (a & F80_SIGN) | (negative ? 0n : INFINITY));
        return;
      }
      const integer = calculate(8, b, 0n, this.control | 0xc00);
      const scale = f80Exponent(b) >= 16383 + 16 ? b & F80_SIGN ? -65536 : 65536 : Number(BigInt.asIntN(64, integer.value));
      this.set(0, this.result(scale80(a, scale, this.control), true)); return;
    }
    if (m === 0xf4) {
      if (!(a & F80_MASK) && e === 0) { this.raise(4); this.set(0, INFINITY | F80_SIGN); this.push(a); }
      else if (e === 0x7fff) {
        const value = f80NaN(a) ? this.result(calculate(0, a, 0n, this.control)) : a;
        this.set(0, f80NaN(a) ? value : INFINITY); this.push(value);
      }
      else {
        let sig = a & F80_MASK, exp = (e || 1) - 16383;
        while (!(sig & F80_INT)) { sig <<= 1n; exp--; }
        this.set(0, this.fromInteger(BigInt(exp))); this.push((a & F80_SIGN) | ONE | (sig & (F80_INT - 1n)));
      }
      return;
    }
    if (f80NaN(a)) {
      const binary = m === 0xf1 || m === 0xf9 || m === 0xf3;
      const value = this.result(calculate(0, a, binary ? this.get(1) : 0n, this.control));
      if (binary) { this.set(1, value); this.pop(); }
      else {
        this.set(0, value);
        if (m === 0xf2 || m === 0xfb) this.push(m === 0xf2 ? ONE : value);
      }
      return;
    }
    if (m === 0xf1 || m === 0xf9) {
      const b = this.get(1);
      let logarithm: Float80;
      if (m === 0xf1 && a & F80_SIGN && a & F80_MASK) { this.raise(1); logarithm = F80_INDEFINITE; }
      else if (m === 0xf1 && !(a & F80_MASK) && e === 0) { this.raise(4); logarithm = INFINITY | F80_SIGN; }
      else if (e === 0x7fff) {
        if (a & F80_SIGN) { this.raise(1); logarithm = F80_INDEFINITE; }
        else logarithm = a;
      }
      else logarithm = this.result(log2(a, m === 0xf9, this.control));
      const result = this.result(calculate(2, b, logarithm, this.control | 0x300));
      this.set(1, result); this.pop(); return;
    }
    if (m === 0xf3) {
      const b = this.get(1);
      if (f80NaN(b)) this.set(1, this.result(calculate(0, a, b, this.control)));
      else {
        const xInf = e === 0x7fff, yInf = f80Exponent(b) === 0x7fff;
        const x = xInf ? (a & F80_SIGN) | ONE : yInf ? a & F80_SIGN : a;
        const y = yInf ? (b & F80_SIGN) | ONE : xInf ? b & F80_SIGN : b;
        this.set(1, this.result(atan2(y, x, this.control)));
      }
      this.pop(); return;
    }
    if (m === 0xf0) {
      if (e === 0x7fff) { this.raise(1); this.set(0, F80_INDEFINITE); }
      else if (e <= 16383) this.set(0, this.result(exp2m1(a, this.control)));
      // Outside [-1,1] the result is architecturally undefined; retain ST(0).
      else this.status |= 0x20;
      return;
    }
    if (e === 0x7fff) { this.raise(1); this.set(0, F80_INDEFINITE); return; }
    if (e >= 16383 + 63) { this.status |= 0x400; return; }
    this.status &= ~0x400;
    const sin = trig(a, false, this.control), cos = trig(a, true, this.control);
    if (m === 0xfe) this.set(0, this.result(sin));
    else if (m === 0xff) this.set(0, this.result(cos));
    else if (m === 0xfb) { const sv = this.result(sin), cv = this.result(cos); this.set(0, sv); this.push(cv); }
    else if (m === 0xf2) { this.set(0, this.result(calculate(3, sin.value, cos.value, this.control | 0x300))); this.push(ONE); }
    else throw new Error('Unsupported x87 transcendental encoding');
  }

  private remainder(a: Float80, b: Float80, nearest: boolean): void {
    const ae = f80Exponent(a), be = f80Exponent(b);
    this.denormal(b);
    if (f80NaN(a) || f80NaN(b)) { this.set(0, this.result(calculate(0, a, b, this.control))); return; }
    if (ae === 0x7fff || !(b & F80_MASK) && be === 0) {
      this.raise(1); this.set(0, F80_INDEFINITE); return;
    }
    if (be === 0x7fff || !(a & F80_MASK)) { this.status &= ~CONDITIONS; return; }
    const diff = (ae || 1) - (be || 1);
    const partial = diff >= 64, reduction = partial ? diff - 32 : 0;
    const aExp = (ae || 1) - 16383 - 63, bExp = (be || 1) - 16383 - 63 + reduction;
    const common = Math.min(aExp, bExp);
    let numerator = (a & F80_MASK) << BigInt(aExp - common);
    const denominator = (b & F80_MASK) << BigInt(bExp - common);
    let quotient = numerator / denominator;
    const rem = numerator % denominator;
    if (nearest && !partial && (rem * 2n > denominator || rem * 2n === denominator && (quotient & 1n))) quotient++;
    numerator -= quotient * denominator;
    if (a & F80_SIGN) numerator = -numerator;
    const result = fromFixed(numerator, 0x37f, -common).value;
    this.set(0, numerator ? result : a & F80_SIGN);
    if (partial) this.status |= 0x400;
    else {
      const q = Number((((a ^ b) & F80_SIGN) ? -quotient : quotient) & 7n);
      this.status = (this.status & ~CONDITIONS) | ((q & 4) << 6) | ((q & 2) << 13) | ((q & 1) << 9);
    }
  }

  private environment(c: FpuContext): Uint8Array {
    const bytes = new Uint8Array(c.operand32 ? 28 : 14).fill(0xff);
    const v = new DataView(bytes.buffer);
    const stride = c.operand32 ? 4 : 2;
    v.setUint16(0, this.control, true); v.setUint16(stride, this.statusWord, true); v.setUint16(stride * 2, this.tagWord, true);
    if (c.protectedMode) {
      if (c.operand32) {
        v.setUint32(12, this.ip, true); v.setUint16(16, this.cs, true); v.setUint16(18, this.opcode, true);
        v.setUint32(20, this.dp, true); v.setUint16(24, this.ds, true);
      } else {
        v.setUint16(6, this.ip, true); v.setUint16(8, this.cs, true);
        v.setUint16(10, this.dp, true); v.setUint16(12, this.ds, true);
      }
    } else {
      const ip = (this.cs * 16 + this.ip) >>> 0, dp = (this.ds * 16 + this.dp) >>> 0;
      v.setUint16(stride * 3, ip, true);
      v.setUint16(stride * 5, dp, true);
      if (c.operand32) {
        v.setUint32(16, ((ip >>> 16) << 12) | this.opcode, true);
        v.setUint32(24, (dp >>> 16) << 12, true);
      } else {
        v.setUint16(8, ((ip >> 4) & 0xf000) | this.opcode, true);
        v.setUint16(12, (dp >> 4) & 0xf000, true);
      }
    }
    return bytes;
  }
  private loadEnvironment(bytes: Uint8Array, c: FpuContext): void {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), stride = c.operand32 ? 4 : 2;
    this.control = v.getUint16(0, true);
    const sw = v.getUint16(stride, true), tags = v.getUint16(stride * 2, true);
    this.status = sw & ~0x3800; this.top = (sw >> 11) & 7;
    for (let k = 0; k < 8; k++) this.tags[k] = (tags >> (k * 2)) & 3;
    if (c.protectedMode) {
      this.ip = c.operand32 ? v.getUint32(12, true) : v.getUint16(6, true);
      this.cs = v.getUint16(stride * 4, true);
      this.dp = c.operand32 ? v.getUint32(20, true) : v.getUint16(10, true);
      this.ds = v.getUint16(stride * 6, true);
      if (c.operand32) this.opcode = v.getUint16(18, true) & 0x7ff;
    } else {
      const iphi = c.operand32 ? v.getUint32(16, true) : v.getUint16(8, true);
      const dphi = c.operand32 ? v.getUint32(24, true) : v.getUint16(12, true);
      const mask = c.operand32 ? 0x0ffff000 : 0xf000;
      this.ip = (v.getUint16(stride * 3, true) | ((iphi & mask) << 4)) >>> 0; this.cs = 0;
      this.dp = (v.getUint16(stride * 5, true) | ((dphi & mask) << 4)) >>> 0; this.ds = 0;
      this.opcode = iphi & 0x7ff;
    }
  }
}
