#include "platform.h"
#include <stdint.h>
#include "softfloat.h"

static uint32_t buffer[12];

uint32_t *get_buffer(void) { return buffer; }

static extFloat80_t load(int offset) {
    extFloat80_t value;
    value.signif = buffer[offset] | ((uint64_t)buffer[offset + 1] << 32);
    value.signExp = buffer[offset + 2];
    return value;
}

static int exponent(extFloat80_t a) {
    int e = a.signExp & 0x7fff;
    if (!e && a.signif) {
        e = 1;
        while (!(a.signif & UINT64_C(0x8000000000000000))) { a.signif <<= 1; e--; }
    }
    return e;
}

static extFloat80_t scale(extFloat80_t a, int delta) {
    if (!a.signif) return a;
    int e = a.signExp & 0x7fff;
    if (!e) {
        e = 1;
        while (!(a.signif & UINT64_C(0x8000000000000000))) { a.signif <<= 1; e--; }
    }
    a.signExp = (a.signExp & 0x8000) | (e + delta);
    return a;
}

void calculate(int op, int control) {
    extFloat80_t a = load(0), b = load(3), result = a;
    uint64_t bits = 0;
    /* x87: nearest, down, up, truncate; SoftFloat: nearest, truncate, down, up. */
    static const uint8_t rounding[] = {
        softfloat_round_near_even, softfloat_round_min,
        softfloat_round_max, softfloat_round_minMag
    };
    softfloat_roundingMode = rounding[(control >> 10) & 3];
    extF80_roundingPrecision = ((control >> 8) & 3) == 0 ? 32 :
                              ((control >> 8) & 3) == 2 ? 64 : 80;
    softfloat_exceptionFlags = 0;
    switch (op) {
        case 0: result = extF80_add(a, b); break;
        case 1: result = extF80_sub(a, b); break;
        case 2: result = extF80_mul(a, b); break;
        case 3: result = extF80_div(a, b); break;
        case 4: result = extF80_sqrt(a); break;
        case 5: result = extF80_roundToInt(a, softfloat_roundingMode, true); break;
        case 6:
            bits = extF80_eq(a, b) ? 0x4000 : extF80_lt_quiet(a, b) ? 0x100 : 0;
            if (extF80_isSignalingNaN(a) || extF80_isSignalingNaN(b) ||
                ((a.signExp & 0x7fff) == 0x7fff && (a.signif << 1)) ||
                ((b.signExp & 0x7fff) == 0x7fff && (b.signif << 1))) bits = 0x4500;
            break;
        case 7: result = i64_to_extF80((int64_t)a.signif); break;
        case 8: bits = extF80_to_i64(a, softfloat_roundingMode, true); break;
        case 9: { float32_t v = { (uint32_t)a.signif }; result = f32_to_extF80(v); break; }
        case 10: { float64_t v = { a.signif }; result = f64_to_extF80(v); break; }
        case 11: bits = extF80_to_f32(a).v; break;
        case 12: bits = extF80_to_f64(a).v; break;
    }
    uint8_t flags = softfloat_exceptionFlags;
    /* Unmasked register overflow/underflow stores an exponent-wrapped result. */
    int delta = (flags & softfloat_flag_overflow) && !(control & 8) ? -24576 :
                (flags & softfloat_flag_underflow) && !(control & 16) ? 24576 : 0;
    if (delta && op <= 3) {
        if (op <= 1) { a = scale(a, delta); b = scale(b, delta); }
        else if (op == 2) {
            if ((exponent(a) > exponent(b)) == (delta < 0)) a = scale(a, delta);
            else b = scale(b, delta);
        } else {
            int e = exponent(a) + delta;
            if (e > 0 && e < 0x7fff) a = scale(a, delta);
            else b = scale(b, -delta);
        }
        softfloat_exceptionFlags = 0;
        switch (op) {
            case 0: result = extF80_add(a, b); break;
            case 1: result = extF80_sub(a, b); break;
            case 2: result = extF80_mul(a, b); break;
            case 3: result = extF80_div(a, b); break;
        }
        flags = (flags & ~softfloat_flag_inexact) | (softfloat_exceptionFlags & softfloat_flag_inexact);
    }
    if (flags & softfloat_flag_inexact) {
        extFloat80_t truncated = result;
        uint64_t truncatedBits = bits;
        softfloat_roundingMode = softfloat_round_minMag;
        switch (op) {
            case 0: truncated = extF80_add(a, b); break;
            case 1: truncated = extF80_sub(a, b); break;
            case 2: truncated = extF80_mul(a, b); break;
            case 3: truncated = extF80_div(a, b); break;
            case 4: truncated = extF80_sqrt(a); break;
            case 5: truncated = extF80_roundToInt(a, softfloat_round_minMag, true); break;
            case 8: truncatedBits = extF80_to_i64(a, softfloat_round_minMag, true); break;
            case 11: truncatedBits = extF80_to_f32(a).v; break;
            case 12: truncatedBits = extF80_to_f64(a).v; break;
        }
        bool up;
        if (op == 8) {
            uint64_t absolute = (int64_t)bits < 0 ? -bits : bits;
            uint64_t truncatedAbsolute = (int64_t)truncatedBits < 0 ? -truncatedBits : truncatedBits;
            up = absolute > truncatedAbsolute;
        } else if (op == 11 || op == 12) {
            uint64_t mask = op == 11 ? UINT64_C(0x7fffffff) : UINT64_C(0x7fffffffffffffff);
            up = (bits & mask) > (truncatedBits & mask);
        } else {
            uint16_t e = result.signExp & 0x7fff, te = truncated.signExp & 0x7fff;
            up = e > te || (e == te && result.signif > truncated.signif);
        }
        if (up) flags |= 0x80;
    }
    buffer[8] = (uint32_t)result.signif;
    buffer[9] = (uint32_t)(result.signif >> 32);
    buffer[10] = result.signExp;
    buffer[11] = flags;
    if (op == 6 || op == 8 || op == 11 || op == 12) {
        buffer[8] = (uint32_t)bits;
        buffer[9] = (uint32_t)(bits >> 32);
        buffer[10] = 0;
    }
}
