// Included by fpu.cpp; the fixed-point implementation shares its translation unit.
#include "fpu-math.h"
#include <algorithm>
#include <stdexcept>

namespace asm86::fpuMath {
Integer Integer::unsignedValue(uint64_t n) {
    Integer r;
    if (n) {
        r.words.push_back(uint32_t(n));
        if (n >> 32) r.words.push_back(uint32_t(n >> 32));
    }
    return r;
}
Integer::Integer(int64_t n) {
    uint64_t magnitude = n < 0 ? uint64_t(0) - uint64_t(n) : uint64_t(n);
    if (magnitude) {
        words.push_back(uint32_t(magnitude));
        if (magnitude >> 32) words.push_back(uint32_t(magnitude >> 32));
    }
    negative = n < 0;
}
Integer Integer::hex(const char* text) {
    Integer r;
    for (; *text; ++text) {
        unsigned digit = *text >= 'a' ? unsigned(*text - 'a' + 10) : unsigned(*text - '0');
        r = (r << 4) + Integer(digit);
    }
    return r;
}
void Integer::normalize() {
    while (!words.empty() && !words.back()) words.pop_back();
    if (words.empty()) negative = false;
}
unsigned Integer::length() const {
    if (words.empty()) return 0;
    unsigned n = unsigned(words.size() - 1) * 32;
    for (uint32_t v = words.back(); v; v >>= 1) ++n;
    return n;
}
uint64_t Integer::low() const {
    uint64_t n = words.empty() ? 0 : words[0];
    if (words.size() > 1) n |= uint64_t(words[1]) << 32;
    return negative ? uint64_t(0) - n : n;
}
Integer Integer::abs() const { Integer r = *this; r.negative = false; return r; }
Integer Integer::operator-() const { Integer r = *this; if (r) r.negative = !r.negative; return r; }
int Integer::magnitudeCompare(const Integer& a, const Integer& b) {
    if (a.words.size() != b.words.size()) return a.words.size() < b.words.size() ? -1 : 1;
    for (size_t i = a.words.size(); i-- > 0;) {
        if (a.words[i] != b.words[i]) return a.words[i] < b.words[i] ? -1 : 1;
    }
    return 0;
}
bool Integer::operator==(const Integer& b) const { return negative == b.negative && words == b.words; }
bool Integer::operator<(const Integer& b) const {
    if (negative != b.negative) return negative;
    int cmp = magnitudeCompare(*this, b);
    return negative ? cmp > 0 : cmp < 0;
}
Integer Integer::operator<<(unsigned n) const {
    if (!*this) return {};
    Integer r;
    r.negative = negative;
    unsigned full = n / 32, part = n % 32;
    r.words.resize(words.size() + full + 1);
    uint64_t carry = 0;
    for (size_t i = 0; i < words.size(); ++i) {
        uint64_t v = (uint64_t(words[i]) << part) | carry;
        r.words[i + full] = uint32_t(v);
        carry = v >> 32;
    }
    r.words[words.size() + full] = uint32_t(carry);
    r.normalize();
    return r;
}
Integer Integer::operator>>(unsigned n) const {
    unsigned full = n / 32, part = n % 32;
    Integer r;
    bool discarded = false;
    for (size_t i = 0; i < std::min<size_t>(full, words.size()); ++i) discarded |= words[i] != 0;
    if (full < words.size()) {
        discarded |= (words[full] & ((uint64_t(1) << part) - 1)) != 0;
        r.words.resize(words.size() - full);
        for (size_t i = full; i < words.size(); ++i) {
            uint64_t v = words[i];
            if (part && i + 1 < words.size()) v |= uint64_t(words[i + 1]) << 32;
            r.words[i - full] = uint32_t(v >> part);
        }
        r.normalize();
    }
    if (negative && discarded) r = r + Integer(1);
    if (r) r.negative = negative;
    return r;
}
Integer Integer::operator+(const Integer& b) const {
    Integer r;
    if (negative == b.negative) {
        r.negative = negative;
        r.words.resize(std::max(words.size(), b.words.size()) + 1);
        uint64_t carry = 0;
        for (size_t i = 0; i + 1 < r.words.size(); ++i) {
            uint64_t v = carry + (i < words.size() ? words[i] : 0) + uint64_t(i < b.words.size() ? b.words[i] : 0);
            r.words[i] = uint32_t(v); carry = v >> 32;
        }
        r.words.back() = uint32_t(carry);
    } else {
        const bool swap = magnitudeCompare(*this, b) < 0;
        const Integer& a = swap ? b : *this;
        const Integer& sub = swap ? *this : b;
        r.negative = a.negative; r.words.resize(a.words.size());
        uint64_t borrow = 0;
        for (size_t i = 0; i < a.words.size(); ++i) {
            uint64_t rhs = uint64_t(i < sub.words.size() ? sub.words[i] : 0) + borrow;
            r.words[i] = uint32_t(uint64_t(a.words[i]) - rhs);
            borrow = uint64_t(a.words[i]) < rhs;
        }
    }
    r.normalize();
    return r;
}
Integer Integer::operator-(const Integer& b) const { return *this + -b; }
Integer Integer::operator*(const Integer& b) const {
    if (!*this || !b) return {};
    Integer r;
    r.negative = negative != b.negative; r.words.resize(words.size() + b.words.size());
    for (size_t i = 0; i < words.size(); ++i) {
        uint64_t carry = 0;
        for (size_t j = 0; j < b.words.size(); ++j) {
            uint64_t v = uint64_t(words[i]) * b.words[j] + r.words[i + j] + carry;
            r.words[i + j] = uint32_t(v); carry = v >> 32;
        }
        r.words[i + b.words.size()] = uint32_t(carry);
    }
    r.normalize();
    return r;
}
void Integer::divide(const Integer& a, const Integer& b, Integer& q, Integer& r) {
    if (!b) throw std::domain_error("x87 integer division by zero");
    r = a.abs(); q = {};
    Integer divisor = b.abs();
    if (magnitudeCompare(r, divisor) >= 0) {
        unsigned shift = r.length() - divisor.length();
        divisor = divisor << shift;
        q.words.resize(shift / 32 + 1);
        for (unsigned i = shift + 1; i-- > 0;) {
            if (magnitudeCompare(r, divisor) >= 0) {
                r = r - divisor;
                q.words[i / 32] |= uint32_t(1) << (i % 32);
            }
            divisor = divisor >> 1;
        }
    }
    q.normalize(); if (q) q.negative = a.negative != b.negative;
    if (r) r.negative = a.negative;
}
Integer Integer::operator/(const Integer& b) const { Integer q, r; divide(*this, b, q, r); return q; }
Integer Integer::operator%(const Integer& b) const { Integer q, r; divide(*this, b, q, r); return r; }

static const Integer ONE = Integer(1) << 256;
static const Integer PI = Integer::hex("3243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89");
static const Integer LN2 = Integer::hex("b17217f7d1cf79abc9e3b39803f2f6af40f343267298b62d8a0d175b8baafa2b");
static Integer mul(const Integer& a, const Integer& b) { return (a * b) >> 256; }
static Integer div(const Integer& a, const Integer& b) { return (a << 256) / b; }
unsigned exponent(Float80 a) { return a.signExponent & 0x7fff; }
bool nan(Float80 a) { return exponent(a) == 0x7fff && (a.significand & 0x7fffffffffffffffull); }
bool unsupported(Float80 a) { return exponent(a) && !(a.significand >> 63); }
bool sign(Float80 a) { return (a.signExponent & 0x8000) != 0; }
Integer fixed(Float80 a) {
    int shift = int(exponent(a) ? exponent(a) : 1) - 16383 - 63 + 256;
    Integer n = Integer::unsignedValue(a.significand);
    n = shift >= 0 ? n << unsigned(shift) : n >> unsigned(-shift);
    return sign(a) ? -n : n;
}
FloatResult fromFixed(const Integer& value, uint16_t control, int precision) {
    if (!value) return {{}, 0};
    const bool negative = value.negative;
    Integer m = value.abs();
    int length = int(m.length()), exp = length - 1 - precision + 16383;
    unsigned pc = (control >> 8) & 3;
    int bits = pc == 0 ? 24 : pc == 2 ? 53 : 64;
    int cut = std::max({length - bits, 1 - exp + length - 64, 0});
    Integer kept = m >> unsigned(cut);
    Integer tail = m - (kept << unsigned(cut));
    unsigned rc = (control >> 10) & 3;
    Integer half = cut ? Integer(1) << unsigned(cut - 1) : Integer();
    bool up = bool(tail) && (rc == 0 ? tail > half || (tail == half && (kept.low() & 1)) :
        rc == 1 ? negative : rc == 2 ? !negative : false);
    if (up) kept = kept + Integer(1);
    int shift = length - cut - 64;
    m = shift >= 0 ? kept >> unsigned(shift) : kept << unsigned(-shift);
    if (m.length() > 64) { m = m >> 1; ++exp; }
    uint16_t flags = tail ? 0x20 : 0;
    if (exp <= 0) { m = m >> unsigned(1 - exp); exp = 0; if (tail) flags |= 0x10; }
    if (exp >= 0x7fff) {
        flags |= 0x28;
        bool infinity = rc == 0 || (rc == 1 && negative) || (rc == 2 && !negative);
        exp = infinity ? 0x7fff : 0x7ffe;
        m = Integer::unsignedValue(infinity ? 0x8000000000000000ull : UINT64_MAX);
    }
    return {{m.low(), uint16_t(exp | (negative ? 0x8000 : 0))}, uint16_t(flags | (up ? 0x200 : 0))};
}
static Integer logFixed(const Integer& x) {
    Integer z = div(x - ONE, x + ONE), z2 = mul(z, z), power = z, sum = z;
    for (int k = 3; k < 1200; k += 2) {
        power = mul(power, z2);
        Integer term = power / Integer(k);
        if (!term) break;
        sum = sum + term;
    }
    return sum * Integer(2);
}
static Integer atanFixed(Integer x) {
    bool negative = x.negative;
    x = x.abs();
    bool inverse = x > ONE;
    if (inverse) x = div(ONE, x);
    bool reduced = x > ONE / Integer(2);
    if (reduced) x = div(x - ONE, x + ONE);
    Integer x2 = mul(x, x), power = x, sum = x;
    for (int k = 3; k < 1200; k += 2) {
        power = -mul(power, x2);
        Integer term = power / Integer(k);
        if (!term) break;
        sum = sum + term;
    }
    if (reduced) sum = sum + PI / Integer(4);
    if (inverse) sum = PI / Integer(2) - sum;
    return negative ? -sum : sum;
}
FloatResult trig(Float80 a, bool cosine, uint16_t control) {
    if (exponent(a) < 16383 - 128) return {cosine ? Float80{0x8000000000000000ull, 0x3fff} : a, uint16_t(a.significand ? 0x20 : 0)};
    Integer x = fixed(a) % (PI * Integer(2));
    if (x > PI) x = x - PI * Integer(2);
    if (x < -PI) x = x + PI * Integer(2);
    Integer x2 = mul(x, x), term = cosine ? ONE : x, sum = term;
    for (int k = 1; k < 200; ++k) {
        term = -mul(term, x2) / Integer((2 * k - (cosine ? 1 : 0)) * (2 * k + (cosine ? 0 : 1)));
        if (!term) break;
        sum = sum + term;
    }
    auto r = fromFixed(sum, control | 0x300);
    if (a.significand) r.flags |= 0x20;
    if (!cosine && !a.significand) r.value = a;
    return r;
}
FloatResult exp2m1(Float80 a, uint16_t control) {
    if (exponent(a) < 16383 - 128) {
        auto r = calculateFloat(FloatOperation::Multiply, a, {0xb17217f7d1cf79acull, 0x3ffe}, control | 0x300);
        if (a.significand) r.flags |= 0x20;
        return r;
    }
    Integer x = mul(fixed(a), LN2), term = x, sum = x;
    for (int k = 2; k < 250; ++k) {
        term = mul(term, x) / Integer(k);
        if (!term) break;
        sum = sum + term;
    }
    auto r = fromFixed(sum, control | 0x300);
    if (a.significand) r.flags |= 0x20; else r.value = a;
    return r;
}
FloatResult log2(Float80 a, bool plusOne, uint16_t control) {
    if (plusOne && exponent(a) < 16383 - 128) {
        auto r = calculateFloat(FloatOperation::Multiply, a, {0xb8aa3b295c17f0bcull, 0x3fff}, control | 0x300);
        if (a.significand) r.flags |= 0x20;
        return r;
    }
    int exp = int(exponent(a) ? exponent(a) : 1) - 16383;
    Integer mantissa = Integer::unsignedValue(a.significand) << (256 - 63);
    if (plusOne) {
        Integer x = fixed(a) + ONE;
        if (x <= Integer()) return {x ? Float80{0xc000000000000000ull, 0xffff} : Float80{0x8000000000000000ull, 0xffff}, uint16_t(x ? 1 : 4)};
        exp = int(x.length()) - 1 - 256;
        mantissa = exp >= 0 ? x >> unsigned(exp) : x << unsigned(-exp);
    } else {
        while (mantissa && mantissa < ONE) { mantissa = mantissa << 1; --exp; }
    }
    auto r = fromFixed((Integer(exp) << 256) + div(logFixed(mantissa), LN2), control | 0x300);
    if (mantissa != ONE) r.flags |= 0x20;
    return r;
}
FloatResult atan2(Float80 y, Float80 x, uint16_t control) {
    if (!y.significand) {
        if (!sign(x)) return {{0, uint16_t(y.signExponent & 0x8000)}, 0};
        return fromFixed(sign(y) ? -PI : PI, control | 0x300);
    }
    if (!x.significand) return fromFixed(sign(y) ? -PI / Integer(2) : PI / Integer(2), control | 0x300);
    int ey = int(exponent(y) ? exponent(y) : 1) - 16383, ex = int(exponent(x) ? exponent(x) : 1) - 16383;
    if (ey - ex < -128 && !sign(x)) {
        auto r = calculateFloat(FloatOperation::Divide, y, x, control | 0x300); r.flags |= 0x20; return r;
    }
    int top = std::max(ey, ex);
    auto scale = [top](Float80 v, int e) {
        int shift = e - top + 256 - 63;
        Integer n = Integer::unsignedValue(v.significand);
        n = shift >= 0 ? n << unsigned(shift) : n >> unsigned(-shift);
        return sign(v) ? -n : n;
    };
    Integer fx = scale(x, ex), fy = scale(y, ey);
    Integer angle = fx ? atanFixed(div(fy, fx)) : fy.negative ? -PI / Integer(2) : PI / Integer(2);
    if (fx.negative) angle = angle + (sign(y) ? -PI : PI);
    auto r = fromFixed(angle, control | 0x300); r.flags |= 0x20; return r;
}
FloatResult scale80(Float80 a, int amount, uint16_t control) {
    if (!a.significand || exponent(a) == 0x7fff) return {a, 0};
    Integer mantissa = Integer::unsignedValue(a.significand);
    if (sign(a)) mantissa = -mantissa;
    int precision = 16383 + 63 - int(exponent(a) ? exponent(a) : 1) - std::max(-65536, std::min(65536, amount));
    auto r = fromFixed(mantissa, control | 0x300, precision);
    unsigned wrap = r.flags & ~control & 0x18;
    if (wrap) {
        auto adjusted = fromFixed(mantissa, control | 0x300, precision + (wrap & 8 ? 24576 : -24576));
        r.value = adjusted.value; r.flags = uint16_t((r.flags & 0x18) | adjusted.flags);
    }
    return r;
}
}
