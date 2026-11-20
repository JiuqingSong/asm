import { calculate, F80_INT, F80_MASK, F80_SIGN, f80Exponent, type Float80, type FloatResult } from './softfloat.ts';

// Extra precision is needed for argument reduction, including operands near 2^63.
const P = 256n;
const ONE = 1n << P;
const PI = 0x3243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89n;
const LN2 = 0xb17217f7d1cf79abc9e3b39803f2f6af40f343267298b62d8a0d175b8baafa2bn;
const mul = (a: bigint, b: bigint) => (a * b) >> P;
const div = (a: bigint, b: bigint) => (a << P) / b;
const abs = (a: bigint) => a < 0n ? -a : a;

export function fixed(a: Float80): bigint {
  const shift = BigInt((f80Exponent(a) || 1) - 16383 - 63) + P;
  const mantissa = a & F80_MASK;
  const n = shift >= 0n ? mantissa << shift : mantissa >> -shift;
  return a & F80_SIGN ? -n : n;
}

export function fromFixed(value: bigint, control: number, precision = Number(P)): FloatResult {
  if (!value) return { value: 0n, flags: 0 };
  const sign = value < 0n;
  let m = abs(value);
  const length = m.toString(2).length;
  let exponent = length - 1 - precision + 16383;
  const pc = (control >> 8) & 3;
  const bits = pc === 0 ? 24 : pc === 2 ? 53 : 64;
  const cut = Math.max(length - bits, 1 - exponent + length - 64, 0);
  const tail = m & ((1n << BigInt(cut)) - 1n);
  let kept = m >> BigInt(cut);
  const rc = (control >> 10) & 3;
  const half = cut ? 1n << BigInt(cut - 1) : 0n;
  const up = tail !== 0n && (rc === 0 ? tail > half || (tail === half && (kept & 1n) !== 0n) : rc === 1 ? sign : rc === 2 ? !sign : false);
  if (up) kept++;
  const shift = length - cut - 64;
  m = shift >= 0 ? kept >> BigInt(shift) : kept << BigInt(-shift);
  if (m >= 1n << 64n) { m >>= 1n; exponent++; }
  let flags = tail ? 0x20 : 0;
  if (exponent <= 0) { m >>= BigInt(1 - exponent); exponent = 0; if (tail) flags |= 0x10; }
  if (exponent >= 0x7fff) {
    flags |= 0x28;
    const infinity = rc === 0 || (rc === 1 && sign) || (rc === 2 && !sign);
    exponent = infinity ? 0x7fff : 0x7ffe;
    m = infinity ? F80_INT : F80_MASK;
  }
  return { value: (sign ? F80_SIGN : 0n) | (BigInt(exponent) << 64n) | m, flags: flags | (up ? 0x200 : 0) };
}

function logFixed(x: bigint): bigint {
  const z = div(x - ONE, x + ONE), z2 = mul(z, z);
  let power = z, sum = z;
  for (let k = 3n; k < 1200n; k += 2n) {
    power = mul(power, z2);
    const term = power / k;
    if (!term) break;
    sum += term;
  }
  return sum * 2n;
}

function atanFixed(x: bigint): bigint {
  const sign = x < 0n ? -1n : 1n;
  x = abs(x);
  const inverse = x > ONE;
  if (inverse) x = div(ONE, x);
  const reduced = x > ONE / 2n;
  if (reduced) x = div(x - ONE, x + ONE);
  const x2 = mul(x, x);
  let power = x, sum = x;
  for (let k = 3n; k < 1200n; k += 2n) {
    power = -mul(power, x2);
    const term = power / k;
    if (!term) break;
    sum += term;
  }
  if (reduced) sum += PI / 4n;
  return sign * (inverse ? PI / 2n - sum : sum);
}

export function trig(a: Float80, cosine: boolean, control: number): FloatResult {
  if (f80Exponent(a) < 16383 - 128) return {
    value: cosine ? 0x3fff8000000000000000n : a,
    flags: a & F80_MASK ? 0x20 : 0,
  };
  let x = fixed(a) % (PI * 2n);
  if (x > PI) x -= PI * 2n;
  if (x < -PI) x += PI * 2n;
  const x2 = mul(x, x);
  let term = cosine ? ONE : x, sum = term;
  for (let k = 1n; k < 200n; k++) {
    term = -mul(term, x2) / ((2n * k - (cosine ? 1n : 0n)) * (2n * k + (cosine ? 0n : 1n)));
    if (!term) break;
    sum += term;
  }
  const result = fromFixed(sum, control | 0x300);
  if (a & F80_MASK) result.flags |= 0x20;
  if (!cosine && !(a & F80_MASK)) result.value = a;
  return result;
}

export function exp2m1(a: Float80, control: number): FloatResult {
  if (f80Exponent(a) < 16383 - 128) {
    const result = calculate(2, a, 0x3ffeb17217f7d1cf79acn, control | 0x300);
    if (a & F80_MASK) result.flags |= 0x20;
    return result;
  }
  const x = mul(fixed(a), LN2);
  let term = x, sum = x;
  for (let k = 2n; k < 250n; k++) {
    term = mul(term, x) / k;
    if (!term) break;
    sum += term;
  }
  const result = fromFixed(sum, control | 0x300);
  if (a & F80_MASK) result.flags |= 0x20;
  else result.value = a;
  return result;
}

export function log2(a: Float80, plusOne: boolean, control: number): FloatResult {
  if (plusOne && f80Exponent(a) < 16383 - 128) {
    const result = calculate(2, a, 0x3fffb8aa3b295c17f0bcn, control | 0x300);
    if (a & F80_MASK) result.flags |= 0x20;
    return result;
  }
  let exponent = (f80Exponent(a) || 1) - 16383;
  let mantissa = (a & F80_MASK) << (P - 63n);
  if (plusOne) {
    const x = fixed(a) + ONE;
    if (x <= 0n) return { value: x ? 0xffffc000000000000000n : 0xffff8000000000000000n, flags: x ? 1 : 4 };
    const length = x.toString(2).length;
    exponent = length - 1 - Number(P);
    mantissa = exponent >= 0 ? x >> BigInt(exponent) : x << BigInt(-exponent);
  } else {
    while (mantissa && mantissa < ONE) { mantissa <<= 1n; exponent--; }
  }
  const result = fromFixed((BigInt(exponent) << P) + div(logFixed(mantissa), LN2), control | 0x300);
  if (mantissa !== ONE) result.flags |= 0x20;
  return result;
}

export function atan2(y: Float80, x: Float80, control: number): FloatResult {
  if (!(y & F80_MASK)) {
    if (!(x & F80_SIGN)) return { value: y & F80_SIGN, flags: 0 };
    return fromFixed(y & F80_SIGN ? -PI : PI, control | 0x300);
  }
  if (!(x & F80_MASK)) return fromFixed(y & F80_SIGN ? -PI / 2n : PI / 2n, control | 0x300);
  const ey = (f80Exponent(y) || 1) - 16383, ex = (f80Exponent(x) || 1) - 16383;
  if (ey - ex < -128 && !(x & F80_SIGN)) {
    const result = calculate(3, y, x, control | 0x300);
    result.flags |= 0x20;
    return result;
  }
  // Scaling both operands avoids discarding subnormal values in fixed-point conversion.
  const top = Math.max(ey, ex);
  const scale = (v: Float80, e: number) => {
    const shift = BigInt(e - top) + P - 63n;
    const n = shift >= 0n ? (v & F80_MASK) << shift : (v & F80_MASK) >> -shift;
    return v & F80_SIGN ? -n : n;
  };
  const fx = scale(x, ex), fy = scale(y, ey);
  let angle = fx ? atanFixed(div(fy, fx)) : fy < 0n ? -PI / 2n : PI / 2n;
  if (fx < 0n) angle += y & F80_SIGN ? -PI : PI;
  const result = fromFixed(angle, control | 0x300);
  result.flags |= 0x20;
  return result;
}

export function scale80(a: Float80, amount: number, control: number): FloatResult {
  if (!(a & F80_MASK) || f80Exponent(a) === 0x7fff) return { value: a, flags: 0 };
  const mantissa = (a & F80_SIGN ? -1n : 1n) * (a & F80_MASK);
  const precision = 16383 + 63 - (f80Exponent(a) || 1) - Math.max(-65536, Math.min(65536, amount));
  const result = fromFixed(mantissa, control | 0x300, precision);
  const wrap = result.flags & ~control & 0x18;
  if (wrap) {
    const adjusted = fromFixed(mantissa, control | 0x300, precision + (wrap & 8 ? 24576 : -24576));
    result.value = adjusted.value;
    result.flags = (result.flags & 0x18) | adjusted.flags;
  }
  return result;
}
