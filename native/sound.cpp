#include "sound.h"
#include <algorithm>

namespace asm86 {
void SoundBlaster::setIrq(bool raised) {
    if (irq == raised) return;
    irq = raised;
    if (interrupt) interrupt(raised);
}
void SoundBlaster::flush() {
    if (position && pcm) pcm(buffer.data(), position);
    position = 0;
}
void SoundBlaster::reset() {
    setIrq(false);
    fifo.clear(); command = -1; parameter = position = 0; test = 0;
    resetHigh = speaker = active = autoInit = paused = false;
    block = 1; left = 0; sample = 0; unsupportedCommands = 0;
    period = PitHz / 22050; pauseRemaining = busyUntil = 0;
    resetNext = sourceNext = renderNext = tailEnd = Never;
    if (clearOutput) clearOutput();
}
double SoundBlaster::nextEvent() const { return std::min({resetNext, sourceNext, renderNext, tailEnd}); }
uint8_t SoundBlaster::input(uint16_t port, double now) {
    if (!enabled) return 255;
    advance(now);
    switch (port) {
    case 0x22a: {
        if (fifo.empty()) return 255;
        auto value = fifo.front(); fifo.pop_front(); return value;
    }
    case 0x22c: return resetHigh || now < busyUntil ? 0x80 : 0;
    case 0x22e: setIrq(false); return fifo.empty() ? 0 : 0x80;
    default: return 255;
    }
}
unsigned SoundBlaster::parameters(uint8_t value) {
    switch (value) {
    case 0x14: case 0x48: return 2;
    case 0x40: case 0xe0: case 0xe4: return 1;
    // Consume known unsupported commands' parameters, rather than interpreting them as commands.
    case 0x24: case 0x80: return 2;
    case 0x10: case 0x38: return 1;
    default: return 0;
    }
}
void SoundBlaster::output(uint16_t port, uint8_t value, double now) {
    if (!enabled) return;
    advance(now);
    if (port == 0x226) {
        if (value & 1) { reset(); resetHigh = true; }
        else if (resetHigh) { resetHigh = false; resetNext = now + PitHz * 3 / 1000000; }
        return;
    }
    if (port != 0x22c || resetHigh || resetNext != Never) return;
    busyUntil = now + PitHz / 1000000;
    if (command < 0) { command = value; parameter = 0; }
    else params[parameter++] = value;
    if (parameter == parameters(uint8_t(command))) {
        execute(now); command = -1; parameter = 0;
    }
}
void SoundBlaster::start(unsigned count, bool automatic, double now) {
    left = count; autoInit = automatic; active = true; paused = false;
    tailEnd = Never; sourceNext = now + period;
    // DOS commonly rearms single-cycle DMA from the IRQ before the final sample's hold time ends.
    if (renderNext == Never) { sample = 0; renderNext = sourceNext; }
}
void SoundBlaster::execute(double now) {
    auto reply = [this](uint8_t value) { if (fifo.size() < 256) fifo.push_back(value); };
    switch (command) {
    case 0xe1: reply(2); reply(1); break;
    case 0xe0: reply(uint8_t(params[0] ^ 255)); break;
    case 0xe4: test = params[0]; break;
    case 0xe8: reply(test); break;
    case 0xd1: speaker = true; break;
    case 0xd3: speaker = false; sample = 0; break;
    case 0xd8: reply(speaker ? 255 : 0); break;
    case 0x40: {
        auto rate = 1000000.0 / (256 - params[0]);
        if (rate < 4000 || rate > 23000) { ++unsupportedCommands; break; }
        period = PitHz / rate; break;
    }
    case 0x48: block = 1 + params[0] + (unsigned(params[1]) << 8); break;
    case 0x14: start(1 + params[0] + (unsigned(params[1]) << 8), false, now); break;
    case 0x1c: start(block, true, now); break;
    case 0xda: autoInit = false; break;
    case 0xd0:
        if (active && !paused) {
            paused = true; pauseRemaining = std::max(0.0, sourceNext - now);
            sourceNext = renderNext = Never; sample = 0; flush();
            if (clearOutput) clearOutput();
        }
        break;
    case 0xd4:
        if (active && paused) {
            paused = false; sourceNext = now + pauseRemaining; renderNext = sourceNext;
        }
        break;
    case 0xf2: setIrq(true); break;
    default: ++unsupportedCommands; break;
    }
}
void SoundBlaster::advance(double now) {
    if (!enabled) return;
    if (now >= resetNext) { resetNext = Never; fifo.push_back(0xaa); }
    while (std::min({sourceNext, renderNext, tailEnd}) <= now) {
        if (tailEnd <= sourceNext && tailEnd <= renderNext) {
            renderNext = tailEnd = Never; sample = 0; flush();
        } else if (sourceNext <= renderNext) {
            const auto event = sourceNext;
            uint8_t value = 128;
            auto result = dma ? dma(&value, 1) : DmaResult{};
            // A masked/misprogrammed DMA must neither consume the DSP block nor raise an IRQ.
            if (result.bytes == 1 && !result.error) {
                sample = speaker ? int16_t((int(value) - 128) * 256) : 0;
                if (--left == 0) {
                    setIrq(true);
                    if (autoInit) left = block;
                    else { active = false; tailEnd = event + period; sourceNext = Never; }
                }
            } else sample = 0;
            if (active) sourceNext = event + period;
        } else {
            buffer[position++] = sample;
            if (position == buffer.size()) flush();
            renderNext += PitHz / OutputRate;
        }
    }
}
}
