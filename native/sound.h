#pragma once
#include "dma.h"
#include <array>
#include <deque>
#include <functional>
#include <limits>

namespace asm86 {
// Deliberately SB 2.01, not SB16: fixed A220/I5/D1, unsigned 8-bit mono PCM only.
class SoundBlaster {
public:
    static constexpr double PitHz = 1193182.0;
    static constexpr unsigned OutputRate = 48000;
    bool enabled = false;
    std::function<DmaResult(uint8_t*, unsigned)> dma;
    std::function<void(bool)> interrupt;
    std::function<void(const int16_t*, unsigned)> pcm;
    std::function<void()> clearOutput;
    unsigned unsupportedCommands = 0;
    static bool owns(uint16_t port) { return port >= 0x220 && port <= 0x22f; }
    void reset();
    uint8_t input(uint16_t port, double now);
    void output(uint16_t port, uint8_t value, double now);
    void advance(double now);
    double nextEvent() const;
private:
    static constexpr double Never = std::numeric_limits<double>::infinity();
    std::deque<uint8_t> fifo;
    std::array<uint8_t, 2> params{};
    std::array<int16_t, 480> buffer{};
    unsigned position = 0, parameter = 0, block = 1, left = 0;
    int command = -1;
    uint8_t test = 0;
    bool resetHigh = false, speaker = false, irq = false, active = false, autoInit = false, paused = false;
    double resetNext = Never, sourceNext = Never, renderNext = Never, tailEnd = Never;
    double period = PitHz / 22050, pauseRemaining = 0, busyUntil = 0;
    int16_t sample = 0;
    void setIrq(bool raised);
    void flush();
    void start(unsigned count, bool automatic, double now);
    void execute(double now);
    static unsigned parameters(uint8_t value);
};
}
