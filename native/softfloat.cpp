#include "softfloat.h"
#include <mutex>

extern "C" {
uint32_t* get_buffer(void);

void calculate(int operation, int control);
}

namespace asm86 {
FloatResult calculateFloat(FloatOperation operation, Float80 a, Float80 b, uint16_t control) {
    // 共享 C 内核通过单个全局缓冲区交换数据；锁住打包/计算/取结果的整个事务。
    static std::mutex mutex;
    const std::lock_guard<std::mutex> lock(mutex);
    auto* buffer = get_buffer();
    buffer[0] = uint32_t(a.significand); buffer[1] = uint32_t(a.significand >> 32); buffer[2] = a.signExponent;
    buffer[3] = uint32_t(b.significand); buffer[4] = uint32_t(b.significand >> 32); buffer[5] = b.signExponent;
    calculate(int(operation), control);
    auto flags = buffer[11];

    // 将 SoftFloat invalid/divzero/overflow/underflow/inexact 和舍入方向映射到 x87 状态位。
    return {{uint64_t(buffer[8]) | (uint64_t(buffer[9]) << 32), uint16_t(buffer[10])},
        uint16_t(((flags & 16) >> 4) | ((flags & 8) >> 1) | ((flags & 4) << 1)
            | ((flags & 2) << 3) | ((flags & 1) << 5) | ((flags & 0x80) << 2))};
}
}
