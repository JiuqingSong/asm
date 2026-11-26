#pragma once
#include <cstdint>

namespace asm86 {
// x87 扩展精度：64 位显式整数位/尾数 + 1 位符号/15 位指数，不使用宿主 long double。
struct Float80 {
    uint64_t significand = 0;
    uint16_t signExponent = 0;
    bool operator==(const Float80& other) const { return significand == other.significand && signExponent == other.signExponent; }
};
enum class FloatOperation {
    // 枚举顺序就是共享 C 数值内核的 operation ABI，不可重新排序。
    Add, Subtract, Multiply, Divide, SquareRoot, RoundToInteger, Compare,
    FromInteger64, ToInteger64, FromFloat32, FromFloat64, ToFloat32, ToFloat64
};
struct FloatResult { Float80 value; uint16_t flags; };

FloatResult calculateFloat(FloatOperation operation, Float80 a, Float80 b = {}, uint16_t control = 0x037f);
}
