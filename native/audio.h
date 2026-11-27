#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmsystem.h>
#include <array>
#include <cstdint>

namespace asm86 {
// A bounded waveOut queue, polled on the VM/UI thread; never blocks guest execution.
class AudioOutput {
public:
    AudioOutput() = default;
    ~AudioOutput();
    AudioOutput(const AudioOutput&) = delete;
    AudioOutput& operator=(const AudioOutput&) = delete;
    void open();
    void clear();
    void write(const int16_t* samples, unsigned count);
    unsigned queued() const;
    uint64_t submitted = 0, dropped = 0, nonzero = 0;
private:
    struct Slot { WAVEHDR header{}; std::array<int16_t, 480> data{}; bool prepared = false; };
    std::array<Slot, 16> slots{};
    HWAVEOUT device = nullptr;
};
}
