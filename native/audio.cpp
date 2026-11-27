#include "audio.h"
#include "sound.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>

namespace asm86 {
void AudioOutput::open() {
    if (device) return;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 1;
    format.nSamplesPerSec = SoundBlaster::OutputRate; format.wBitsPerSample = 16;
    format.nBlockAlign = 2; format.nAvgBytesPerSec = format.nSamplesPerSec * 2;
    if (waveOutOpen(&device, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR)
        throw std::runtime_error("Cannot open Windows PCM output (48 kHz mono)");
}
void AudioOutput::clear() {
    if (!device) return;
    if (waveOutReset(device) != MMSYSERR_NOERROR)
        throw std::runtime_error("Cannot reset Windows PCM output");
    for (auto& slot : slots) if (slot.prepared) {
        if (waveOutUnprepareHeader(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
            throw std::runtime_error("Cannot release Windows PCM buffer during reset");
        slot.prepared = false;
    }
}
AudioOutput::~AudioOutput() {
    try { clear(); }
    catch (const std::exception& e) { std::cerr << e.what() << '\n'; }
    if (device && waveOutClose(device) != MMSYSERR_NOERROR)
        std::cerr << "Cannot close Windows PCM output\n";
}
unsigned AudioOutput::queued() const {
    unsigned count = 0;
    for (const auto& slot : slots) if (slot.prepared && !(slot.header.dwFlags & WHDR_DONE)) ++count;
    return count;
}
void AudioOutput::write(const int16_t* samples, unsigned count) {
    if (!device) return;
    while (count) {
        auto length = std::min(count, 480u);
        auto it = std::find_if(slots.begin(), slots.end(), [](const Slot& slot) {
            return !slot.prepared || (slot.header.dwFlags & WHDR_DONE);
        });
        if (it == slots.end()) { dropped += count; return; }
        auto& slot = *it;
        if (slot.prepared) {
            if (waveOutUnprepareHeader(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
                throw std::runtime_error("Cannot release Windows PCM buffer");
            slot.prepared = false;
        }
        std::copy_n(samples, length, slot.data.begin());
        slot.header = {}; slot.header.lpData = reinterpret_cast<LPSTR>(slot.data.data());
        slot.header.dwBufferLength = length * sizeof(int16_t);
        if (waveOutPrepareHeader(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
            throw std::runtime_error("Cannot prepare Windows PCM buffer");
        slot.prepared = true;
        if (waveOutWrite(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
            throw std::runtime_error("Cannot submit Windows PCM buffer");
        submitted += length;
        nonzero += std::count_if(samples, samples + length, [](int16_t value) { return value != 0; });
        samples += length; count -= length;
    }
}
}
