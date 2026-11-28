#pragma once
#include "dma.h"
#include "opl3.h"
#include <algorithm>
#include <array>
#include <deque>
#include <functional>
#include <limits>

namespace asm86 {
// Sound Blaster 16 (DSP 4.05, CT1745 mixer) with fixed, non-PnP resources A220 I5 D1 H5 P330 and OPL3 at 388h:
// the "Sound Blaster 16 or compatible" legacy card that the Windows 9x/2000 drivers support.
// The MPU-401 is UART-only; its MIDI bytes go to the host's MIDI synthesiser.
class SoundBlaster {
    friend class Snapshot;
public:
    static constexpr double PitHz = 1193182.0;
    static constexpr unsigned OutputRate = 48000, OutputFrames = 480;
    bool enabled = false;
    std::function<DmaResult(unsigned channel, uint8_t*, unsigned, DmaDirection)> dma;
    std::function<void(bool)> interrupt;
    std::function<void(const int16_t*, unsigned frames)> pcm; // Interleaved stereo frames.
    std::function<void()> clearOutput;
    std::function<void(uint8_t)> midiOut;
    unsigned unsupportedCommands = 0;
    uint8_t lastUnsupported = 0; // Diagnostics only (title bar / script), not saved in snapshots.
    static bool owns(uint16_t port) {
        return (port >= 0x220 && port <= 0x22f) || port == 0x330 || port == 0x331 || (port >= 0x388 && port <= 0x38b);
    }
    SoundBlaster() { reset(); } // Power-on mixer levels and an idle DSP.
    void reset();
    uint8_t input(uint16_t port, double now);
    void output(uint16_t port, uint8_t value, double now);
    void advance(double now);
    double nextEvent() const { return std::min({resetNext, sourceNext, renderNext}); }
private:
    static constexpr double Never = std::numeric_limits<double>::infinity();
    static unsigned parameters(uint8_t value);
    // DSP command interface.
    std::deque<uint8_t> fifo;
    std::array<uint8_t, 3> params{};
    unsigned parameter = 0;
    int command = -1;
    uint8_t test = 0, lastCommand = 0, e2Value = 0xaa, e2Count = 0;
    std::array<uint8_t, 256> asp{};
    bool resetHigh = false, speaker = false, irq8 = false, irq16 = false, line = false;
    double resetNext = Never, busyUntil = 0;
    // One DSP transfer at a time. Counts are DMA units: bytes for 8-bit data, words for 16-bit data.
    bool active = false, autoInit = false, paused = false, wide = false, stereo = false, signedData = false,
        recording = false, silence = false, timeConstant = true;
    unsigned block = 1, reload = 1, left = 0, rate = 22050;
    double period = PitHz / 22050, sourceNext = Never, pauseRemaining = 0;
    // Output: the last two source frames are linearly interpolated onto the 48 kHz host clock.
    std::array<int16_t, 2> previous{}, current{};
    double currentTime = 0, renderNext = Never, holdUntil = Never;
    std::array<int16_t, OutputFrames * 2> buffer{};
    unsigned position = 0;
    // CT1745 mixer, MPU-401 UART and OPL3.
    std::array<uint8_t, 256> mixer{};
    uint8_t mixerIndex = 0;
    std::deque<uint8_t> midi;
    bool uart = false;
    Opl3 fm;
    std::array<uint8_t, 2> fmIndex{};
    bool playing() const { return active && !paused && !recording; }
    void setIrq();
    void raise(bool sixteen) { (sixteen ? irq16 : irq8) = true; setIrq(); }
    void flush();
    void resetDsp();
    void mixerReset();
    uint8_t mixerRead(uint8_t index) const;
    void mixerWrite(uint8_t index, uint8_t value);
    double gain(uint8_t index) const;
    void start(unsigned count, bool automatic, bool sixteen, bool twoChannels, bool isSigned, bool input, double now);
    void execute(double now);
    void fetch(double event);
    void render();
    void wake(double now, double hold);
};
}
