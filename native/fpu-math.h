#pragma once
#include "softfloat.h"
#include <vector>

namespace asm86::fpuMath {
// 有符号任意精度整数：右移是算术移位，除法向零截断，保持与参考 x87 的 BigInt 语义一致。
class Integer {
public:

    // 小端 32 位 limb 保存绝对值，negative 单独保存符号；零统一为空 words 且不带负号。
    std::vector<uint32_t> words;
    bool negative = false;
    Integer(int64_t n = 0);
    static Integer unsignedValue(uint64_t n);
    static Integer hex(const char* text);
    explicit operator bool() const { return !words.empty(); }
    unsigned length() const;
    uint64_t low() const;
    Integer abs() const;
    Integer operator-() const;
    Integer operator<<(unsigned n) const;
    Integer operator>>(unsigned n) const;
    Integer operator+(const Integer& b) const;
    Integer operator-(const Integer& b) const;
    Integer operator*(const Integer& b) const;
    Integer operator/(const Integer& b) const;
    Integer operator%(const Integer& b) const;
    bool operator==(const Integer& b) const;
    bool operator!=(const Integer& b) const { return !(*this == b); }
    bool operator<(const Integer& b) const;
    bool operator>(const Integer& b) const { return b < *this; }
    bool operator<=(const Integer& b) const { return !(b < *this); }
    bool operator>=(const Integer& b) const { return !(*this < b); }
private:
    void normalize();
    static int magnitudeCompare(const Integer& a, const Integer& b);
    static void divide(const Integer& a, const Integer& b, Integer& q, Integer& r);
};

unsigned exponent(Float80 a);

bool nan(Float80 a);

bool unsupported(Float80 a);

bool sign(Float80 a);

Integer fixed(Float80 a);

FloatResult fromFixed(const Integer& value, uint16_t control, int precision = 256);

FloatResult trig(Float80 a, bool cosine, uint16_t control);

FloatResult exp2m1(Float80 a, uint16_t control);

FloatResult log2(Float80 a, bool plusOne, uint16_t control);

FloatResult atan2(Float80 y, Float80 x, uint16_t control);

FloatResult scale80(Float80 a, int amount, uint16_t control);
}
