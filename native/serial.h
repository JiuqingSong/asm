#pragma once
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>

namespace asm86 {
class SerialMouse {
public:
    void reset();
    uint8_t input(unsigned offset, double now);
    void output(unsigned offset, uint8_t value, double now);
    void advance(double now);
    void motion(int dx, int dy, uint8_t buttons, double now);
    bool active() const { return identified && (mcr & 0x13) == 3 && divisor() == 96; }
    std::function<void(bool)> setIrq;
    double nextEvent = std::numeric_limits<double>::infinity();
private:
    struct Byte { double at; uint8_t value; };
    std::deque<Byte> queue;
    uint8_t dll = 12, dlm = 0, ier = 0, lcr = 3, mcr = 0, scratch = 0;
    uint8_t rbr = 0, lsr = 0x60, msr = 0x30, delta = 0, buttons = 0, lastButtons = 0;
    bool irqLine = false, txPending = false, txInterrupt = false, identified = false;
    uint8_t transmitted = 0;
    int64_t pendingX = 0, pendingY = 0;
    double txDone = 0;
    uint8_t interruptId() const;
    void updateIrq();
    void receive(uint8_t value);
    void packet(double now);
    void schedule();
    unsigned divisor() const;
};
}
