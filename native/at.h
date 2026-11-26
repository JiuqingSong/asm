#pragma once
#include <cstdint>

namespace asm86 {
// 8259 PIC：IRR=pending、IMR=mask、ISR=service；取中断和发送 EOI 是两个不同阶段。
class Pic {
public:
    uint8_t mask = 0, pending = 0, service = 0, base = 8;
    void reset(uint8_t vector, bool standalone) {
        mask = pending = service = init = priority = 0; base = vector;
        single = standalone; needs4 = true; readService = autoEoi = false;
    }
    void raise(unsigned line) { pending |= uint8_t(1 << line); }
    int next() const {
        // 从旋转优先级起点扫描；已在服务的更高优先级中断阻止低优先级嵌套。
        for (unsigned i = 0; i < 8; ++i) {
            unsigned line = (priority + i) & 7;
            if (service & (1 << line)) break;
            if (pending & ~mask & (1 << line)) return int(line);
        }
        return -1;
    }
    int take() {
        int line = next();
        if (line >= 0) { pending &= uint8_t(~(1 << line)); if (!autoEoi) service |= uint8_t(1 << line); }
        return line;
    }
    uint8_t command() const { return readService ? service : pending; }
    void command(uint8_t value) {
        // ICW1 开始初始化；OCW2 处理指定/非指定 EOI 与轮转；OCW3 选择读 IRR/ISR。
        if (value & 16) {
            init = 1; mask = service = pending = priority = 0;
            single = value & 2; needs4 = value & 1; autoEoi = readService = false;
        } else if (value & 32) {
            int line = value & 64 ? value & 7 : -1;
            if (line < 0) for (unsigned i = 0; i < 8; ++i)
                if (service & (1 << ((priority + i) & 7))) { line = int((priority + i) & 7); break; }
            if (line >= 0) { service &= uint8_t(~(1 << line)); if (value & 128) priority = uint8_t((line + 1) & 7); }
        } else if ((value & 0x18) == 8) {
            if (value & 2) readService = value & 1;
        } else if ((value & 0xc0) == 0xc0) priority = uint8_t((value + 1) & 7);
    }
    void data(uint8_t value) {
        // 初始化时依次接收 ICW2 向量、ICW3 级联、ICW4 模式；平时数据端口写屏蔽字。
        if (init == 1) { base = value & 0xf8; init = single ? (needs4 ? 3 : 0) : 2; }
        else if (init == 2) init = needs4 ? 3 : 0;
        else if (init == 3) { autoEoi = value & 2; init = 0; }
        else mask = value;
    }
private:
    uint8_t init = 0, priority = 0;
    bool single = true, needs4 = true, readService = false, autoEoi = false;
};
}
