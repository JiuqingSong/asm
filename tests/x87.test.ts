import { describe, it, expect } from 'vitest';
import { CPU, AX, CS, DS, SP } from '../src/cpu/cpu.ts';
import { X87, type FpuContext } from '../src/cpu/x87.ts';
import { calculate, bytesFloat80, float80Bytes } from '../src/cpu/softfloat.ts';
import { Machine } from '../src/machine/machine.ts';
import { assemble } from '../src/asm/assembler.ts';
import { disassemble } from '../src/cpu/disasm.ts';

const ONE = 0x3fff8000000000000000n;
function cpu(code: number[], enabled = true): CPU {
  const c = new CPU();
  if (enabled) c.fpu = new X87();
  c.is386 = true; c.is486 = true; c.setA20(true);
  c.msw = 0x30;
  c.s[CS] = c.s[DS] = 0; c.ip = 0x2000; c.r[SP] = 0x7000;
  c.setFlags(2);
  c.mem.set(code, 0x2000);
  for (const n of [6, 7, 13, 14, 16]) {
    c.mem.set([0, 0x30 + n, 0, 0], n * 4);
    c.mem[0x3000 + n * 256] = 0xf4;
  }
  return c;
}
function run(c: CPU, count = 100): CPU {
  for (let k = 0; k < count && !c.halted; k++) c.step();
  return c;
}
function data(c: CPU, value: bigint, address = 0x4000): void { c.mem.set(float80Bytes(value), address); }
const load80 = [0xdb, 0x2e, 0, 0x40];
const registerContext: FpuContext = {
  read: () => { throw new Error('Unexpected memory read'); },
  write: () => { throw new Error('Unexpected memory write'); },
  ax: () => {}, ip: 0x2000, cs: 0, dp: 0, ds: 0, operand32: false, protectedMode: false,
};
function extended(value: number): bigint {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return calculate(10, bytesFloat80(bytes), 0n, 0x37f).value;
}
function numeric(value: bigint): number {
  return new DataView(float80Bytes(calculate(12, value, 0n, 0x37f).value).buffer).getFloat64(0, true);
}

describe('x87 80387 / 486DX', () => {
  it('executes a real detection sequence and advertises the same hardware through CPUID', () => {
    const c = run(cpu([0xdb, 0xe3, 0xdf, 0xe0, 0xd9, 0x3e, 0, 0x40, 0xf4]));
    expect(c.r[AX]).toBe(0);
    expect([...c.mem.subarray(0x4000, 0x4002)]).toEqual([0x7f, 3]);
    for (const enabled of [false, true]) {
      const probe = cpu([0x66, 0xb8, 1, 0, 0, 0, 0x0f, 0xa2, 0xf4], enabled);
      run(probe);
      expect(probe.r[2] & 1).toBe(Number(enabled));
    }
  });

  it('preserves extended precision beyond JavaScript Number', () => {
    // (1 + 2^-63) - 1 = 2^-63, not zero.
    const c = cpu([0xdb, 0xe3, 0xd9, 0xe8, ...load80, 0xde, 0xc1, 0xd9, 0xe8, 0xde, 0xe9, 0xf4]);
    data(c, 0x3fc08000000000000000n);
    run(c);
    expect(c.fpu!.st()).toBe(0x3fc08000000000000000n);
    expect(c.fpu!.status & 0x3f).toBe(0);
  });

  it.each([
    [0x037f, 2n], [0x077f, 1n], [0x0b7f, 2n], [0x0f7f, 1n],
  ])('honors integer rounding CW=%s', (control, expected) => {
    const c = cpu([...load80, 0xdf, 0x1e, 0, 0x41, 0xf4]);
    c.fpu!.control = control;
    data(c, 0x3fffc000000000000000n);
    run(c);
    expect(bytesFloat80(c.mem.subarray(0x4100, 0x4102))).toBe(expected);
    expect(c.fpu!.tag()).toBe(3);
    expect(c.fpu!.status & 0x20).toBe(0x20);
  });

  it('honors precision control and the sign of zero', () => {
    const tiny = 0x3fc98000000000000000n; // 2^-54
    expect(calculate(0, ONE, tiny, 0x37f).value).not.toBe(ONE);
    expect(calculate(0, ONE, tiny, 0x27f).value).toBe(ONE);
    expect(calculate(1, ONE, ONE, 0x77f).value).toBe(1n << 79n);
  });

  it('matches independently rounded binary64 arithmetic in 53-bit precision mode', () => {
    let seed = 0x387486;
    const sample = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 0x100000000 - 0.5) * 1e6; };
    for (let k = 0; k < 100; k++) {
      const a = sample(), b = sample();
      for (const [op, expected] of [[0, a + b], [1, a - b], [2, a * b], [3, a / b], [4, Math.sqrt(Math.abs(a))]]) {
        const result = calculate(op, extended(op === 4 ? Math.abs(a) : a), extended(b), 0x27f);
        expect(numeric(result.value)).toBe(expected);
      }
    }
  });

  it('evaluates transcendentals over large, tiny and signed-zero arguments', () => {
    for (const value of [-1e10, -Math.PI, -1, -1e-50, -0, 0, 0.5, 1, Math.PI, 1e10]) {
      for (const [op, expected] of [[0xfe, Math.sin(value)], [0xff, Math.cos(value)], [0xf3, Math.atan2(value, -2)]]) {
        const f = new X87();
        f.registers[0] = extended(op === 0xf3 ? -2 : value);
        f.registers[1] = extended(value); f.tags[0] = f.tags[1] = 0;
        f.execute(0xd9, op, registerContext);
        const actual = numeric(f.st());
        expect(Math.abs(actual - expected)).toBeLessThan(1e-14);
        if (expected === 0) expect(Object.is(actual, expected)).toBe(true);
      }
    }
    for (const value of [1e-200, 0.125, 1, 3, 1e200]) {
      const f = new X87();
      f.registers[0] = extended(value); f.registers[1] = ONE; f.tags[0] = f.tags[1] = 0;
      f.execute(0xd9, 0xf1, registerContext);
      expect(numeric(f.st())).toBeCloseTo(Math.log2(value), 12);
    }
  });

  it('stores extended, single, double and signed 64-bit integers', () => {
    const c = cpu([0xdf, 0x2e, 0, 0x40, 0xd9, 0xc0, 0xdb, 0x3e, 0, 0x41,
      0xd9, 0xc0, 0xd9, 0x1e, 0, 0x42, 0xd9, 0xc0, 0xdd, 0x1e, 0, 0x43,
      0xdf, 0x3e, 0, 0x44, 0xf4]);
    data(c, BigInt.asUintN(64, -123456789012345n));
    run(c);
    expect(bytesFloat80(c.mem.subarray(0x4400, 0x4408))).toBe(BigInt.asUintN(64, -123456789012345n));
    expect(bytesFloat80(c.mem.subarray(0x4100, 0x410a))).toBe(calculate(7, BigInt.asUintN(64, -123456789012345n), 0n, 0x37f).value);
    expect(new DataView(c.mem.buffer).getFloat64(0x4300, true)).toBe(-123456789012345);
    expect(Number.isFinite(new DataView(c.mem.buffer).getFloat32(0x4200, true))).toBe(true);
  });

  it('saves and restores all eight registers, TOP and tags in both environment sizes', () => {
    for (const prefix of [[], [0x66]]) {
      const c = cpu([0xd9, 0xe8, 0xd9, 0xeb, ...prefix, 0xdd, 0x36, 0, 0x40,
        ...prefix, 0xdd, 0x26, 0, 0x40, 0xf4]);
      c.step(); c.step();
      const before = c.fpu!.snapshot();
      c.step();
      expect(c.fpu!.tagWord).toBe(0xffff);
      run(c);
      expect(c.fpu!.registers).toEqual(before.registers);
      expect(c.fpu!.tagWord).toBe(0x0fff);
      expect(c.fpu!.top).toBe(6);
      expect(c.fpu!.control).toBe(before.control);
      expect(c.fpu!.ip + c.fpu!.cs * 16).toBe(before.ip);
    }
  });

  it('reports #NM before executing even FNINIT; WAIT uses TS/MP but not EM', () => {
    for (const bits of [4, 8]) {
      const c = cpu([0xdb, 0xe3]);
      c.fpu!.control = 0x77f; c.msw |= bits;
      c.step();
      expect(c.ip).toBe(0x3700);
      expect(c.fpu!.control).toBe(0x77f);
    }
    const c = cpu([0x9b, 0xf4]); c.msw |= 4;
    c.step(); expect(c.ip).toBe(0x2001);
    c.ip = 0x2000; c.msw = 0x3a; c.step(); expect(c.ip).toBe(0x3700);
  });

  it('defers unmasked divide-by-zero to WAIT; FNSTSW and FNCLEX do not wait', () => {
    const c = cpu([0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9, 0xdf, 0xe0, 0x9b]);
    c.fpu!.control &= ~4;
    c.step(); c.step(); c.step();
    expect(c.fpu!.pending).toBe(true);
    expect(c.fpu!.statusWord & 0x8084).toBe(0x8084);
    c.step(); expect(c.r[AX] & 4).toBe(4);
    c.step(); expect(c.ip).toBe(0x4000);
    c.mem.set([0xdb, 0xe2], 0x4000); c.step();
    expect(c.fpu!.pending).toBe(false);
  });

  it('detects masked stack overflow/underflow and leaves empty tags observable', () => {
    const c = cpu([...Array(9).fill([0xd9, 0xe8]).flat(), 0xf4]);
    run(c);
    expect(c.fpu!.status & 0x241).toBe(0x241);
    expect(c.fpu!.st()).toBe(0xffffc000000000000000n);
    const empty = run(cpu([0xd9, 0xe0, 0xf4]));
    expect(empty.fpu!.status & 0x241).toBe(0x41);
  });

  it('suppresses data changes on unmasked stack faults, but commits unmasked precision results', () => {
    const c = cpu([...Array(8).fill([0xd9, 0xe8]).flat(), 0xd9, 0xf4]);
    for (let k = 0; k < 8; k++) c.step();
    c.fpu!.control &= ~1;
    const before = c.fpu!.snapshot();
    c.step();
    expect(c.fpu!.registers).toEqual(before.registers);
    expect(c.fpu!.tags).toEqual(before.tags);
    expect(c.fpu!.top).toBe(before.top);
    expect(c.fpu!.pending).toBe(true);
    const rounded = cpu([...load80, 0xdf, 0x1e, 0, 0x41]);
    data(rounded, 0x3fffc000000000000000n);
    rounded.fpu!.control &= ~0x20;
    rounded.step(); rounded.step();
    expect(rounded.mem[0x4100]).toBe(2);
    expect(rounded.fpu!.tag()).toBe(3);
    expect(rounded.fpu!.pending).toBe(true);
  });

  it('wraps unmasked register overflow and preserves masked overflow behavior', () => {
    const huge = 0x7ffe8000000000000000n;
    expect(calculate(2, huge, huge, 0x37f).value).toBe(0x7fff8000000000000000n);
    const wrapped = calculate(2, huge, huge, 0x377);
    expect(wrapped.flags & 8).toBe(8);
    expect(wrapped.value).toBe(0x5ffd8000000000000000n);
  });

  it('does not pop or partially write across a segment fault', () => {
    const c = cpu([0xd9, 0xe8, 0xdb, 0x3e, 0xfc, 0xff]);
    c.step(); const before = c.fpu!.snapshot();
    c.mem.fill(0x5a, 0xfffc, 0x10000);
    c.step();
    expect(c.ip).toBe(0x3d00);
    expect(c.fpu!.snapshot()).toEqual(before);
    expect([...c.mem.subarray(0xfffc, 0x10000)]).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
  });

  it('packs real/protected 14/28-byte environments using architectural pointer fields', () => {
    for (const protectedMode of [false, true]) for (const operand32 of [false, true]) {
      const f = new X87();
      f.ip = operand32 ? 0x12345678 : 0x2345; f.cs = 0xa000;
      f.dp = operand32 ? 0x23456789 : 0x3456; f.ds = 0xb000; f.opcode = 0x345;
      const before = f.snapshot();
      let bytes: Uint8Array = new Uint8Array();
      const ctx: FpuContext = {
        read: () => bytes, write: b => { bytes = b; }, ax: () => {},
        ip: 0, cs: 0, dp: 0, ds: 0, operand32, protectedMode,
      };
      f.execute(0xd9, 0x30, ctx);
      const v = new DataView(bytes.buffer);
      if (!protectedMode && operand32) {
        expect(v.getUint16(12, true)).toBe(0x5678);
        expect(v.getUint32(16, true)).toBe(0x123e345);
        expect(v.getUint16(20, true)).toBe(0x6789);
        expect(v.getUint32(24, true)).toBe(0x2350000);
      }
      f.init(); f.execute(0xd9, 0x20, ctx);
      expect(f.ip).toBe(protectedMode ? before.ip : before.ip + before.cs * 16);
      expect(f.dp).toBe(protectedMode ? before.dp : before.dp + before.ds * 16);
      expect(f.cs).toBe(protectedMode ? before.cs : 0);
      expect(f.ds).toBe(protectedMode ? before.ds : 0);
    }
  });

  it('scales extreme finite values exactly and implements infinite scale operands', () => {
    const scale = (a: bigint, b: bigint) => {
      const c = cpu([0xd9, 0xfd, 0xf4]);
      c.fpu!.registers[0] = a; c.fpu!.registers[1] = b;
      c.fpu!.tags[0] = c.fpu!.tags[1] = 0;
      run(c); return c.fpu!;
    };
    const integer = calculate(7, 20000n, 0n, 0x37f).value;
    expect(scale(1n, integer).st()).toBe((BigInt(16383 + 20000 - 16445) << 64n) | (1n << 63n));
    expect(scale(ONE, 0xffff8000000000000000n).st()).toBe(0n);
    expect(scale(0n, 0x7fff8000000000000000n).status & 1).toBe(1);
    const quiet = scale(ONE, 0x7fff8000000000000000n);
    expect(quiet.st()).toBe(0x7fff8000000000000000n);
    expect(quiet.status & 0x3f).toBe(0);
  });

  it('performs packed BCD, remainder, logarithm and trigonometric operations', () => {
    const remainder = cpu([0xdf, 0x06, 0, 0x40, 0xdf, 0x06, 2, 0x40, 0xd9, 0xf8, 0xf4]);
    remainder.mem.set([3, 0, 17, 0], 0x4000);
    run(remainder);
    expect(remainder.fpu!.st()).toBe(calculate(7, 2n, 0n, 0x37f).value);
    expect(remainder.fpu!.status & 0x4700).toBe(0x300);
    const logs = run(cpu([0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0xf1, 0xf4]));
    expect(logs.fpu!.st()).toBe(ONE);
    const sin = cpu([...load80, 0xd9, 0xfe, 0xf4]); data(sin, 0x3ffec90fdaa22168c235n);
    run(sin);
    const n = calculate(12, sin.fpu!.st(), 0n, 0x37f).value;
    expect(new DataView(float80Bytes(n).buffer).getFloat64(0, true)).toBeCloseTo(Math.SQRT1_2, 15);
    const bcd = cpu([0xdf, 0x26, 0, 0x40, 0xdf, 0x36, 0, 0x41, 0xf4]);
    bcd.mem.set([0x89, 0x67, 0x45, 0x23, 1, 0, 0, 0, 0, 0x80], 0x4000);
    run(bcd);
    expect([...bcd.mem.subarray(0x4100, 0x410a)]).toEqual([...bcd.mem.subarray(0x4000, 0x400a)]);
  });
});

describe('optional FPU machine integration', () => {
  const program = () => assemble('.model tiny\n.code\norg 100h\nstart: db 0d9h,0e8h,0d9h,0ebh\nhlt\nend start');
  it('keeps firmware, CMOS and CPU presence consistent and disables pre-386 CPUs', () => {
    for (const enabled of [false, true]) {
      const m = new Machine({ fpu: enabled });
      m.setCpu('486'); m.load(program());
      expect(m.mem[0x410] & 2).toBe(enabled ? 2 : 0);
      expect(m.cmos[0x14] & 2).toBe(enabled ? 2 : 0);
      expect(m.cpu.fpuEnabled).toBe(enabled);
      m.setCpu('286');
      expect(m.mem[0x410] & 2).toBe(0);
      expect(m.cpu.fpuEnabled).toBe(false);
    }
  });
  it('undoes FPU state alongside integer registers and resets on restart', () => {
    const m = new Machine({ fpu: true });
    m.setCpu('386'); m.load(program());
    m.stepInto();
    expect(m.cpu.fpu!.top).toBe(7);
    m.stepInto(); expect(m.cpu.fpu!.top).toBe(6);
    m.stepBack(); expect(m.cpu.fpu!.top).toBe(7); expect(m.cpu.fpu!.st()).toBe(ONE);
    m.stepBack(); expect(m.cpu.fpu!.tagWord).toBe(0xffff);
    m.stepInto(); m.load(program()); expect(m.cpu.fpu!.tagWord).toBe(0xffff);
  });
  it('routes legacy errors to IRQ13 and acknowledges/reset ports without disturbing the mouse', () => {
    const m = new Machine({ fpu: true });
    m.setCpu('386'); m.load(program());
    m.cpu.fpu!.control &= ~4;
    m.cpu.fpu!.status |= 4;
    m.cpu.updateFpuIrq();
    expect(m.pic2.irr & 0x20).toBe(0x20);
    m.cpu.msw |= 0x21; // Preserve NE across model changes by keeping protected mode enabled.
    m.setCpu('486'); expect(m.pic2.irr & 0x20).toBe(0);
    expect(m.cpu.fpu!.pending).toBe(true);
    m.setCpu('386'); expect(m.pic2.irr & 0x20).toBe(0x20);
    m.cpu.io.out8(0xf0, 0); expect(m.pic2.irr & 0x20).toBe(0);
    expect(m.cpu.fpu!.pending).toBe(true);
    m.cpu.io.out8(0xf1, 0); expect(m.cpu.fpu!.pending).toBe(false);
    expect(m.cpu.fpu!.control).toBe(0x37f);
    expect(m.mem[0x75 * 4] | (m.mem[0x75 * 4 + 1] << 8)).not.toBe(0x75 * 8);
  });
  it('disassembles x87 without changing the operand length', () => {
    for (const [bytes, text] of [
      [[0xdb, 0xe3], 'FNINIT'],
      [[0xd9, 0xeb], 'FLDPI'],
      [[0xde, 0xc1], 'FADDP ST(1),ST'],
      [[0x66, 0xdd, 0x36, 0, 0x40], 'FNSAVE DS:[4000h]'],
      [[0xdf, 0xe0], 'FNSTSW AX'],
    ] as [number[], string][]) {
      const d = disassemble(i => bytes[i], 0, { is386: true });
      expect(d.text).toBe(text); expect(d.length).toBe(bytes.length);
    }
  });
});
