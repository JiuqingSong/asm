#include "fpu.h"
#include "fpu-math.h"
#include <algorithm>
#include <stdexcept>
#include "fpu-math.inl"

// x87 80 位寄存器栈与 D8..DF 译码；基础数值运算交给 SoftFloat，超越函数使用定点内核。
namespace asm86 {
using namespace fpuMath;
namespace {
constexpr Float80 ONE80{0x8000000000000000ull, 0x3fff};
constexpr Float80 INFINITY80{0x8000000000000000ull, 0x7fff};
constexpr Float80 INDEFINITE{0xc000000000000000ull, 0xffff};
constexpr uint16_t CONDITIONS = 0x4700;
constexpr std::array<Float80, 7> CONSTANTS{{
    // D9 E8..EE：FLD1、FLDL2T、FLDL2E、FLDPI、FLDLG2、FLDLN2、FLDZ。
    // 这里存的是 80 位浮点位模式，不是机器码字节。
    ONE80, {0xd49a784bcd1b8afeull, 0x4000}, {0xb8aa3b295c17f0bcull, 0x3fff},
    {0xc90fdaa22168c235ull, 0x4000}, {0x9a209a84fbcff799ull, 0x3ffd},
    {0xb17217f7d1cf79acull, 0x3ffe}, {}
}};
struct FpuAbort {};

uint64_t readUnsigned(const std::vector<uint8_t>& bytes, unsigned at, unsigned size) {
    if (at > bytes.size() || size > bytes.size() - at || size > 8) throw std::out_of_range("Short x87 memory operand");
    uint64_t n = 0;
    for (unsigned i = 0; i < size; ++i) n |= uint64_t(bytes[at + i]) << (i * 8);
    return n;
}

void writeUnsigned(std::vector<uint8_t>& bytes, unsigned at, uint64_t n, unsigned size) {
    for (unsigned i = 0; i < size; ++i) { bytes.at(at + i) = uint8_t(n); n >>= 8; }
}

Float80 read80(const std::vector<uint8_t>& bytes, unsigned at = 0) {
    return {readUnsigned(bytes, at, 8), uint16_t(readUnsigned(bytes, at + 8, 2))};
}

std::vector<uint8_t> rawBytes(uint64_t n, unsigned size) {
    std::vector<uint8_t> out(size); writeUnsigned(out, 0, n, size); return out;
}

uint64_t signExtend(uint64_t n, unsigned bits) {
    if (bits == 64) return n;
    uint64_t mask = (uint64_t(1) << bits) - 1;
    return (n & (uint64_t(1) << (bits - 1))) ? n | ~mask : n & mask;
}

Float80 signedZero(Float80 a) { return {0, uint16_t(a.signExponent & 0x8000)}; }

Float80 signedInfinity(Float80 a) { return {INFINITY80.significand, uint16_t(0x7fff | (a.signExponent & 0x8000))}; }
}

FpuMemoryOperation Fpu::memoryOperation(uint8_t op, unsigned reg, bool operand32) {
    // 偶数 ESC：D8 实数32、DA 整数32、DC 实数64、DE 整数16，均为算术/比较源。
    // 奇数 ESC 的 /0..7 操作数尺寸表（0 表示非法编码）：
    // D9：FLD32、非法、FST32、FSTP32、FLDENV、FLDCW、FNSTENV、FNSTCW。
    // DB：FILD32、非法、FIST32、FISTP32、非法、FLD80、非法、FSTP80。
    // DD：FLD64、非法、FST64、FSTP64、FRSTOR、非法、FNSAVE、FNSTSW。
    // DF：FILD16、非法、FIST16、FISTP16、FBLD、FILD64、FBSTP、FISTP64。
    if (op < 0xd8 || op > 0xdf || reg > 7) return {0, false};
    if (!(op & 1)) return {op == 0xd8 || op == 0xda ? 4u : op == 0xdc ? 8u : 2u, false};
    unsigned env = operand32 ? 28 : 14;
    const unsigned sizes[4][8] = {
        {4, 0, 4, 4, env, 2, env, 2},
        {4, 0, 4, 4, 0, 10, 0, 10},
        {8, 0, 8, 8, env + 80, 0, env + 80, 2},
        {2, 0, 2, 2, 10, 8, 10, 8}
    };
    return {sizes[(op - 0xd9) / 2][reg], reg == 2 || reg == 3 || reg == 6 || reg == 7};
}

bool Fpu::noWait(uint8_t op, uint8_t m) {
    // FN 控制/状态指令可以在未处理浮点异常时执行；带前置 9B FWAIT 的版本先等待。
    return (op == 0xdb && m >= 0xe0 && m <= 0xe4) || (op == 0xdf && m == 0xe0) ||
        (m < 0xc0 && (op == 0xd9 || op == 0xdd) && (m & 0x38) >= 0x30);
}

uint16_t Fpu::statusWord() const { return uint16_t((status & ~0x3800) | ((top & 7) << 11)); }

uint16_t Fpu::tagWord() const {
    // 每个物理栈槽两位 tag：0 有效、1 零、2 特殊、3 空；TOP 决定 ST(i) 的物理槽。
    uint16_t word = 0;
    for (unsigned i = 0; i < 8; ++i) word |= uint16_t((tags[i] & 3) << (i * 2));
    return word;
}

bool Fpu::pending() const { return (status & ~control & 0x3f) != 0; }

Float80 Fpu::st(unsigned i) const { return registers[(top + i) & 7]; }

uint8_t Fpu::tag(unsigned i) const { return tags[(top + i) & 7]; }

void Fpu::init() {
    control = 0x037f; status = 0; top = 0; tags.fill(3);
    ip = dp = 0; cs = ds = opcode = 0; updateError();
}

void Fpu::updateError() {
    if (pending()) status |= 0x8080; else status &= uint16_t(~0x8080);
    if (onError) onError(pending());
}

void Fpu::raise(uint16_t flags, bool registerResult) {
    status |= flags & 0x7f; updateError();
    if (flags & ~control & (registerResult ? 7 : 0x1f)) throw FpuAbort{};
}

Float80 Fpu::result(FloatResult r, bool registerResult) {
    status = uint16_t((status & ~0x200) | (r.flags & 0x200));
    raise(r.flags, registerResult); return r.value;
}

Float80 Fpu::stackFault(bool overflow) {
    status = uint16_t((status & ~0x200) | (overflow ? 0x200 : 0));
    raise(0x41); return INDEFINITE;
}

Float80 Fpu::get(unsigned i) {
    if (tag(i) == 3) return stackFault(false);
    Float80 value = st(i);
    if (unsupported(value)) { raise(1); return INDEFINITE; }
    return value;
}

void Fpu::denormal(Float80 a) { if (!exponent(a) && a.significand) raise(2); }

void Fpu::set(unsigned i, Float80 value) {
    unsigned p = (top + i) & 7, e = exponent(value);
    registers[p] = value;
    tags[p] = !value.significand && !e ? 1 : !e || e == 0x7fff || unsupported(value) ? 2 : 0;
}

void Fpu::push(Float80 value) {
    unsigned next = (top + 7) & 7;
    if (tags[next] != 3) value = stackFault(true);
    top = next; set(0, value);
}

void Fpu::pop() { tags[top] = 3; top = (top + 1) & 7; }

Float80 Fpu::arithmetic(unsigned kind, Float80 a, Float80 b) {
    // /0 FADD、/1 FMUL、/2 FCOM、/3 FCOMP、/4 FSUB、/5 FSUBR、/6 FDIV、/7 FDIVR。
    denormal(a); denormal(b);
    auto op = kind == 0 ? FloatOperation::Add : kind == 1 ? FloatOperation::Multiply :
        kind <= 5 ? FloatOperation::Subtract : FloatOperation::Divide;
    if (kind == 5 || kind == 7) std::swap(a, b);
    return result(calculateFloat(op, a, b, control), true);
}

void Fpu::compare(Float80 a, Float80 b, bool quiet) {
    denormal(a); denormal(b);
    auto r = calculateFloat(FloatOperation::Compare, a, b, control);
    if ((nan(a) || nan(b)) && !quiet) r.flags |= 1;
    result(r); status = uint16_t((status & ~CONDITIONS) | r.value.significand);
}

Float80 Fpu::fromInteger(uint64_t value) { return result(calculateFloat(FloatOperation::FromInteger64, {value, 0}, {}, control)); }

uint64_t Fpu::toInteger(Float80 value, unsigned bits) {
    auto r = calculateFloat(FloatOperation::ToInteger64, value, {}, control);
    uint64_t integer = r.value.significand;
    if ((bits < 64 && signExtend(integer, bits) != integer) || (r.flags & 1)) {
        r.flags = 1; integer = uint64_t(1) << (bits - 1);
    }
    result(r);
    return bits == 64 ? integer : integer & ((uint64_t(1) << bits) - 1);
}

void Fpu::execute(uint8_t op, uint8_t m, const FpuContext& c) {
    const Fpu old = *this;
    unsigned reg = (m >> 3) & 7;
    bool mem = m < 0xc0;
    bool controlInstruction = mem ? (op == 0xd9 || op == 0xdd) && reg >= 4 :
        (op == 0xdb && m >= 0xe0 && m <= 0xe4) || (op == 0xdf && m == 0xe0);
    try {
        if (op < 0xd8 || op > 0xdf) throw std::invalid_argument("Unsupported x87 opcode");
        if (!controlInstruction) {
            ip = c.ip; cs = c.cs; opcode = uint16_t(((op & 7) << 8) | m);
            if (mem) { dp = c.dp; ds = c.ds; }
            status &= uint16_t(~0x200);
        }
        if (mem) memory(op, reg, c); else registerOperation(op, m, c);
        updateError();
    } catch (const FpuAbort&) {
        // 未屏蔽浮点异常保留诊断/指针，但撤销寄存器、TOP 和 tag 修改；
        // 总线/分页异常则恢复整个 FPU 状态，并继续向 CPU 传播。
        registers = old.registers; tags = old.tags; top = old.top; updateError();
    } catch (...) {
        *this = old;
        if (onError) onError(pending());
        throw;
    }
}

void Fpu::memory(uint8_t op, unsigned reg, const FpuContext& c) {
    // ModR/M.mod!=3 时 /reg 决定内存指令；所有读写通过 CPU 已验证的完整操作数回调。
    auto shape = memoryOperation(op, reg, c.operand32);
    if (!shape.size) throw std::invalid_argument("Unsupported x87 memory encoding");
    auto read = [&]() {
        auto bytes = c.read();
        if (bytes.size() < shape.size) throw std::out_of_range("Short x87 memory operand");
        return bytes;
    };
    auto loadFloat = [&](const std::vector<uint8_t>& bytes) {
        uint64_t raw = readUnsigned(bytes, 0, op == 0xd8 || op == 0xd9 ? 4 : 8);
        bool single = op == 0xd8 || op == 0xd9;
        auto r = calculateFloat(single ? FloatOperation::FromFloat32 : FloatOperation::FromFloat64, {raw, 0}, {}, control);
        unsigned e = single ? unsigned((raw >> 23) & 255) : unsigned((raw >> 52) & 2047);
        if (!e && (raw & (single ? 0x7fffffull : 0xfffffffffffffull))) r.flags |= 2;
        return result(r);
    };
    auto writeInteger = [&](unsigned bits) {
        c.write(rawBytes(toInteger(get(), bits), bits / 8));
        if (reg == 3 || (op == 0xdf && reg == 7)) pop();
    };
    if (!(op & 1)) {
        auto bytes = read();
        Float80 value = op == 0xda || op == 0xde ?
            fromInteger(signExtend(readUnsigned(bytes, 0, shape.size), shape.size * 8)) : loadFloat(bytes);
        Float80 a = get();
        if (reg == 2 || reg == 3) { compare(a, value); if (reg == 3) pop(); }
        else set(0, arithmetic(reg, a, value));
        return;
    }
    if (op == 0xd9 || op == 0xdd) {
        if (reg == 0) push(loadFloat(read()));
        else if (reg == 2 || reg == 3) {
            auto raw = result(calculateFloat(op == 0xd9 ? FloatOperation::ToFloat32 : FloatOperation::ToFloat64, get(), {}, control));
            c.write(rawBytes(raw.significand, op == 0xd9 ? 4 : 8));
            if (reg == 3) pop();
        } else if (reg == 4) {
            auto bytes = read(); loadEnvironment(bytes, c);
            if (op == 0xdd) for (unsigned k = 0; k < 8; ++k)
                registers[(top + k) & 7] = read80(bytes, (c.operand32 ? 28 : 14) + k * 10);
        } else if (reg == 5) {
            control = uint16_t((readUnsigned(read(), 0, 2) & 0x1f3f) | 0x40);
        } else if (reg == 6) {
            auto out = environment(c);
            unsigned env = unsigned(out.size()); out.resize(env + (op == 0xdd ? 80 : 0));
            if (op == 0xdd) for (unsigned k = 0; k < 8; ++k) {
                writeUnsigned(out, env + k * 10, st(k).significand, 8);
                writeUnsigned(out, env + k * 10 + 8, st(k).signExponent, 2);
            }
            c.write(out);
            if (op == 0xdd) init(); else control |= 0x3f;
        } else if (reg == 7) c.write(rawBytes(op == 0xd9 ? control : statusWord(), 2));
        else throw std::invalid_argument("Unsupported x87 memory encoding");
        return;
    }
    if (reg == 0 || (reg == 5 && op == 0xdf)) {
        auto bytes = read(); push(fromInteger(signExtend(readUnsigned(bytes, 0, shape.size), shape.size * 8)));
    } else if (reg == 2 || reg == 3 || (reg == 7 && op == 0xdf)) {
        writeInteger(op == 0xdb ? 32 : reg == 7 ? 64 : 16);
    } else if (op == 0xdb && reg == 5) push(read80(read()));
    else if (op == 0xdb && reg == 7) {
        Float80 value = get(); auto out = rawBytes(value.significand, 10);
        writeUnsigned(out, 8, value.signExponent, 2); c.write(out); pop();
    } else if (op == 0xdf && reg == 4) {
        // DF /4 FBLD：9 字节各存两位 BCD，第 10 字节 bit7 为符号，共 18 位十进制数。
        auto bytes = read(); uint64_t value = 0;
        for (unsigned k = 9; k-- > 0;) value = value * 100 + (bytes[k] >> 4) * 10 + (bytes[k] & 15);
        push(fromInteger(bytes[9] & 0x80 ? uint64_t(0) - value : value));
    } else if (op == 0xdf && reg == 6) {
        // DF /6 FBSTP：按控制字舍入为 18 位 BCD，写入成功后再弹出 ST(0)。
        Float80 value = get();
        auto raw = result(calculateFloat(FloatOperation::ToInteger64, value, {}, control));
        uint64_t integer = raw.significand;
        bool negative = (integer >> 63) != 0;
        uint64_t magnitude = negative ? uint64_t(0) - integer : integer;
        std::vector<uint8_t> out(10);
        if (exponent(value) == 0x7fff || magnitude >= 1000000000000000000ull) {
            raise(1); out[7] = 0xc0; out[8] = out[9] = 0xff;
        } else {
            out[9] = sign(value) ? 0x80 : 0;
            for (unsigned k = 0; k < 9; ++k) {
                out[k] = uint8_t(magnitude % 10); magnitude /= 10;
                out[k] |= uint8_t((magnitude % 10) << 4); magnitude /= 10;
            }
        }
        c.write(out); pop();
    } else throw std::invalid_argument("Unsupported x87 memory encoding");
}

void Fpu::registerOperation(uint8_t op, uint8_t m, const FpuContext& c) {
    // ModR/M.mod=3：低三位指定 ST(i)。D8 操作 ST(0)，DC 操作 ST(i)，DE 算术后弹栈。
    unsigned reg = (m >> 3) & 7, i = m & 7;
    if (op == 0xd8 || op == 0xdc || (op == 0xde && m != 0xd9)) {
        Float80 a = get(), b = get(i);
        if (reg == 2 || reg == 3) { compare(a, b); if (reg == 3) pop(); }
        else if (op == 0xd8) set(0, arithmetic(reg, a, b));
        else { set(i, arithmetic(reg >= 4 ? reg ^ 1 : reg, b, a)); if (op == 0xde) pop(); }
        return;
    }
    if (op == 0xd9) {
        // D9 C0..C7 FLD ST(i)、C8..CF FXCH ST(i)、D0 FNOP；
        // E0 FCHS、E1 FABS、E4 FTST、E5 FXAM、E8..EE 加载常数。
        if (m < 0xc8) { push(get(i)); return; }
        if (m < 0xd0) { Float80 a = get(), b = get(i); set(0, b); set(i, a); return; }
        if (m == 0xd0) return;
        if (m == 0xe0 || m == 0xe1) {
            Float80 a = get(); a.signExponent = uint16_t(m == 0xe0 ? a.signExponent ^ 0x8000 : a.signExponent & 0x7fff);
            set(0, a); return;
        }
        if (m == 0xe4) { compare(get(), {}); return; }
        if (m == 0xe5) {
            Float80 a = st(); unsigned e = exponent(a);
            uint16_t code = tag() == 3 ? 0x4100 : !a.significand && !e ? 0x4000 : unsupported(a) ? 0 :
                e == 0x7fff ? nan(a) ? 0x100 : 0x500 : !e ? 0x4400 : 0x400;
            status = uint16_t((status & ~CONDITIONS) | code | (sign(a) ? 0x200 : 0)); return;
        }
        if (m >= 0xe8 && m <= 0xee) {
            Float80 value = CONSTANTS[m - 0xe8];
            unsigned rc = (control >> 10) & 3;
            if (m != 0xe8 && m != 0xee) {
                bool nearestUp = m >= 0xea;
                if (nearestUp && (rc == 1 || rc == 3)) --value.significand;
                else if (!nearestUp && rc == 2) ++value.significand;
            }
            push(value); return;
        }
        if (m >= 0xf0) { transcendental(m); return; }
    }
    if ((op == 0xda && m == 0xe9) || (op == 0xde && m == 0xd9)) {
        // DA E9 FUCOMPP（安静比较）/ DE D9 FCOMPP：比较 ST(0)/ST(1)，弹出两次。
        Float80 a = get(), b = get(1); compare(a, b, op == 0xda); pop(); pop(); return;
    }
    if (op == 0xdb && m >= 0xe0 && m <= 0xe4) {
        // DB E2 FNCLEX 清异常、DB E3 FNINIT 初始化；旧式 ENI/DISI/SETPM 保留无操作行为。
        if (m == 0xe2) { status &= 0x7f00; updateError(); }
        else if (m == 0xe3) init();
        return;
    }
    if (op == 0xdd) {
        // DD C0..C7 FFREE；D0..DF FST/FSTP ST(i)；E0..EF FUCOM/FUCOMP。
        if (reg == 0) { tags[(top + i) & 7] = 3; return; }
        if (reg == 2 || reg == 3) { set(i, get()); if (reg == 3) pop(); return; }
        if (reg == 4 || reg == 5) {
            Float80 a = get(), b = get(i); compare(a, b, true); if (reg == 5) pop(); return;
        }
    }
    if (op == 0xdf && m == 0xe0) { c.ax(statusWord()); return; } // DF E0 FNSTSW AX。
    throw std::invalid_argument("Unsupported x87 register encoding");
}

void Fpu::transcendental(uint8_t m) {
    // 均以前导 D9 编码：F0 F2XM1、F1 FYL2X、F2 FPTAN、F3 FPATAN、F4 FXTRACT、
    // F5 FPREM1、F6 FDECSTP、F7 FINCSTP、F8 FPREM、F9 FYL2XP1、FA FSQRT、
    // FB FSINCOS、FC FRNDINT、FD FSCALE、FE FSIN、FF FCOS。
    if (m == 0xf6 || m == 0xf7) { top = (top + (m == 0xf6 ? 7 : 1)) & 7; return; }
    Float80 a = get(); unsigned e = exponent(a); denormal(a);
    if (m == 0xfc) { set(0, result(calculateFloat(FloatOperation::RoundToInteger, a, {}, control), true)); return; }
    if (m == 0xfa) { set(0, result(calculateFloat(FloatOperation::SquareRoot, a, {}, control), true)); return; }
    if (m == 0xf5 || m == 0xf8) { remainder(a, get(1), m == 0xf5); return; }
    if (m == 0xfd) {
        Float80 b = get(1); denormal(b);
        if (nan(a) || nan(b)) { set(0, result(calculateFloat(FloatOperation::Add, a, b, control))); return; }
        if (exponent(b) == 0x7fff) {
            bool negative = sign(b), zero = !a.significand, infinity = e == 0x7fff;
            if ((negative && infinity) || (!negative && zero)) { raise(1); set(0, INDEFINITE); }
            else set(0, negative ? signedZero(a) : signedInfinity(a));
            return;
        }
        auto integer = calculateFloat(FloatOperation::ToInteger64, b, {}, control | 0xc00);
        int scale = exponent(b) >= 16383 + 16 ? sign(b) ? -65536 : 65536 :
            (integer.value.significand >> 63) ? -int(uint64_t(0) - integer.value.significand) : int(integer.value.significand);
        set(0, result(scale80(a, scale, control), true)); return;
    }
    if (m == 0xf4) {
        if (!a.significand && !e) { raise(4); set(0, {INFINITY80.significand, 0xffff}); push(a); }
        else if (e == 0x7fff) {
            Float80 value = nan(a) ? result(calculateFloat(FloatOperation::Add, a, {}, control)) : a;
            set(0, nan(a) ? value : INFINITY80); push(value);
        } else {
            uint64_t sig = a.significand; int exp = int(e ? e : 1) - 16383;
            while (!(sig >> 63)) { sig <<= 1; --exp; }
            set(0, fromInteger(uint64_t(int64_t(exp)))); push({sig, uint16_t((a.signExponent & 0x8000) | 0x3fff)});
        }
        return;
    }
    if (nan(a)) {
        bool binary = m == 0xf1 || m == 0xf9 || m == 0xf3;
        Float80 b = binary ? get(1) : Float80{};
        Float80 value = result(calculateFloat(FloatOperation::Add, a, b, control));
        if (binary) { set(1, value); pop(); }
        else { set(0, value); if (m == 0xf2 || m == 0xfb) push(m == 0xf2 ? ONE80 : value); }
        return;
    }
    if (m == 0xf1 || m == 0xf9) {
        Float80 b = get(1), logarithm;
        if (m == 0xf1 && sign(a) && a.significand) { raise(1); logarithm = INDEFINITE; }
        else if (m == 0xf1 && !a.significand && !e) { raise(4); logarithm = {INFINITY80.significand, 0xffff}; }
        else if (e == 0x7fff) {
            if (sign(a)) { raise(1); logarithm = INDEFINITE; } else logarithm = a;
        } else logarithm = result(fpuMath::log2(a, m == 0xf9, control));
        Float80 value = result(calculateFloat(FloatOperation::Multiply, b, logarithm, control | 0x300));
        set(1, value); pop(); return;
    }
    if (m == 0xf3) {
        Float80 b = get(1);
        if (nan(b)) set(1, result(calculateFloat(FloatOperation::Add, a, b, control)));
        else {
            bool xInf = e == 0x7fff, yInf = exponent(b) == 0x7fff;
            Float80 x = xInf ? Float80{ONE80.significand, uint16_t(0x3fff | (a.signExponent & 0x8000))} : yInf ? signedZero(a) : a;
            Float80 y = yInf ? Float80{ONE80.significand, uint16_t(0x3fff | (b.signExponent & 0x8000))} : xInf ? signedZero(b) : b;
            set(1, result(fpuMath::atan2(y, x, control)));
        }
        pop(); return;
    }
    if (m == 0xf0) {
        if (e == 0x7fff) { raise(1); set(0, INDEFINITE); }
        else if (e <= 16383) set(0, result(exp2m1(a, control)));
        else status |= 0x20; // 超出 [-1,1] 的结果未定义，保持与参考核心一致的行为。
        return;
    }
    if (e == 0x7fff) { raise(1); set(0, INDEFINITE); return; }
    if (e >= 16383 + 63) { status |= 0x400; return; }
    status &= uint16_t(~0x400);
    auto sine = trig(a, false, control), cosine = trig(a, true, control);
    if (m == 0xfe) set(0, result(sine));
    else if (m == 0xff) set(0, result(cosine));
    else if (m == 0xfb) { Float80 sv = result(sine), cv = result(cosine); set(0, sv); push(cv); }
    else if (m == 0xf2) {
        set(0, result(calculateFloat(FloatOperation::Divide, sine.value, cosine.value, control | 0x300))); push(ONE80);
    } else throw std::invalid_argument("Unsupported x87 transcendental encoding");
}

void Fpu::remainder(Float80 a, Float80 b, bool nearest) {
    // 指数差过大时只完成一次部分余数，C2=1 要求客体重复；完成后 C0/C3/C1 存商低三位。
    unsigned ae = exponent(a), be = exponent(b); denormal(b);
    if (nan(a) || nan(b)) { set(0, result(calculateFloat(FloatOperation::Add, a, b, control))); return; }
    if (ae == 0x7fff || (!b.significand && !be)) { raise(1); set(0, INDEFINITE); return; }
    if (be == 0x7fff || !a.significand) { status &= uint16_t(~CONDITIONS); return; }
    int diff = int(ae ? ae : 1) - int(be ? be : 1);
    bool partial = diff >= 64;
    int reduction = partial ? diff - 32 : 0;
    int aExp = int(ae ? ae : 1) - 16383 - 63, bExp = int(be ? be : 1) - 16383 - 63 + reduction;
    int common = std::min(aExp, bExp);
    Integer numerator = Integer::unsignedValue(a.significand) << unsigned(aExp - common);
    Integer denominator = Integer::unsignedValue(b.significand) << unsigned(bExp - common);
    Integer quotient = numerator / denominator, rem = numerator % denominator;
    if (nearest && !partial && (rem * Integer(2) > denominator || (rem * Integer(2) == denominator && (quotient.low() & 1))))
        quotient = quotient + Integer(1);
    numerator = numerator - quotient * denominator;
    if (sign(a)) numerator = -numerator;
    set(0, numerator ? fromFixed(numerator, 0x37f, -common).value : signedZero(a));
    if (partial) status |= 0x400;
    else {
        unsigned q = unsigned((sign(a) != sign(b) ? -quotient : quotient).low() & 7);
        status = uint16_t((status & ~CONDITIONS) | ((q & 4) << 6) | ((q & 2) << 13) | ((q & 1) << 9));
    }
}

std::vector<uint8_t> Fpu::environment(const FpuContext& c) const {
    // FLDENV/FNSTENV 与 FSAVE/FRSTOR 的环境头为 14/28 字节；实模式和保护模式指针布局不同。
    std::vector<uint8_t> bytes(c.operand32 ? 28 : 14, 0xff);
    unsigned stride = c.operand32 ? 4 : 2;
    writeUnsigned(bytes, 0, control, 2); writeUnsigned(bytes, stride, statusWord(), 2); writeUnsigned(bytes, stride * 2, tagWord(), 2);
    if (c.protectedMode) {
        if (c.operand32) {
            writeUnsigned(bytes, 12, ip, 4); writeUnsigned(bytes, 16, cs, 2); writeUnsigned(bytes, 18, opcode, 2);
            writeUnsigned(bytes, 20, dp, 4); writeUnsigned(bytes, 24, ds, 2);
        } else {
            writeUnsigned(bytes, 6, ip, 2); writeUnsigned(bytes, 8, cs, 2);
            writeUnsigned(bytes, 10, dp, 2); writeUnsigned(bytes, 12, ds, 2);
        }
    } else {
        uint32_t linearIp = uint32_t(cs) * 16 + ip, linearDp = uint32_t(ds) * 16 + dp;
        writeUnsigned(bytes, stride * 3, linearIp, 2); writeUnsigned(bytes, stride * 5, linearDp, 2);
        if (c.operand32) {
            writeUnsigned(bytes, 16, ((linearIp >> 16) << 12) | opcode, 4);
            writeUnsigned(bytes, 24, (linearDp >> 16) << 12, 4);
        } else {
            writeUnsigned(bytes, 8, ((linearIp >> 4) & 0xf000) | opcode, 2);
            writeUnsigned(bytes, 12, (linearDp >> 4) & 0xf000, 2);
        }
    }
    return bytes;
}

void Fpu::loadEnvironment(const std::vector<uint8_t>& bytes, const FpuContext& c) {
    unsigned stride = c.operand32 ? 4 : 2;
    control = uint16_t(readUnsigned(bytes, 0, 2));
    uint16_t sw = uint16_t(readUnsigned(bytes, stride, 2)), tw = uint16_t(readUnsigned(bytes, stride * 2, 2));
    status = sw & uint16_t(~0x3800); top = (sw >> 11) & 7;
    for (unsigned k = 0; k < 8; ++k) tags[k] = uint8_t((tw >> (k * 2)) & 3);
    if (c.protectedMode) {
        ip = uint32_t(readUnsigned(bytes, stride * 3, c.operand32 ? 4 : 2));
        cs = uint16_t(readUnsigned(bytes, stride * 4, 2));
        dp = uint32_t(readUnsigned(bytes, stride * 5, c.operand32 ? 4 : 2));
        ds = uint16_t(readUnsigned(bytes, stride * 6, 2));
        if (c.operand32) opcode = uint16_t(readUnsigned(bytes, 18, 2) & 0x7ff);
    } else {
        uint32_t iphi = uint32_t(readUnsigned(bytes, stride * 4, c.operand32 ? 4 : 2));
        uint32_t dphi = uint32_t(readUnsigned(bytes, stride * 6, c.operand32 ? 4 : 2));
        uint32_t mask = c.operand32 ? 0x0ffff000 : 0xf000;
        ip = uint32_t(readUnsigned(bytes, stride * 3, 2)) | ((iphi & mask) << 4); cs = 0;
        dp = uint32_t(readUnsigned(bytes, stride * 5, 2)) | ((dphi & mask) << 4); ds = 0;
        opcode = uint16_t(iphi & 0x7ff);
    }
}
}
