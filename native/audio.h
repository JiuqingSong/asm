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
    void write(const int16_t* samples, unsigned frames); // Interleaved 16-bit stereo.
    // Starts playback held back for a short sound that never fills the pre-buffer; call regularly.
    void service();
    unsigned queued() const;
    uint64_t submitted = 0, dropped = 0, nonzero = 0;
private:
    struct Slot { WAVEHDR header{}; std::array<int16_t, 960> data{}; bool prepared = false; };
    std::array<Slot, 16> slots{};
    HWAVEOUT device = nullptr;
    // After an underrun (or at start) the device stays paused until four buffers (40 ms) absorb host jitter.
    static constexpr unsigned PrimeBuffers = 4;
    bool priming = false;
    ULONGLONG primeStart = 0;
    void restart();
};
// Guest MPU-401 UART bytes to the host MIDI mapper (usually the GS wavetable synthesiser).
// Running status is honoured; system-exclusive messages are dropped.
class MidiOutput {
public:
    MidiOutput() = default;
    ~MidiOutput();
    MidiOutput(const MidiOutput&) = delete;
    MidiOutput& operator=(const MidiOutput&) = delete;
    void open();
    void write(uint8_t value);
    void clear();
    uint64_t messages = 0;
private:
    HMIDIOUT device = nullptr;
    uint8_t status = 0, data[2]{};
    unsigned have = 0;
    bool sysex = false;
};
}
