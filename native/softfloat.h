#pragma once
#include <cstdint>

namespace asm86 {
struct Float80 {
    uint64_t significand = 0;
    uint16_t signExponent = 0;
    bool operator==(const Float80& other) const { return significand == other.significand && signExponent == other.signExponent; }
};
enum class FloatOperation {
    Add, Subtract, Multiply, Divide, SquareRoot, RoundToInteger, Compare,
    FromInteger64, ToInteger64, FromFloat32, FromFloat64, ToFloat32, ToFloat64
};
struct FloatResult { Float80 value; uint16_t flags; };
FloatResult calculateFloat(FloatOperation operation, Float80 a, Float80 b = {}, uint16_t control = 0x037f);
}
