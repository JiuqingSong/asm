#include "audio.h"
#include "sound.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>

namespace asm86 {
void AudioOutput::open() {
    if (device) return;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2;
    format.nSamplesPerSec = SoundBlaster::OutputRate; format.wBitsPerSample = 16;
    format.nBlockAlign = 4; format.nAvgBytesPerSec = format.nSamplesPerSec * 4;
    if (waveOutOpen(&device, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR)
        throw std::runtime_error("Cannot open Windows PCM output (48 kHz stereo)");
}
void AudioOutput::restart() {
    if (waveOutRestart(device) != MMSYSERR_NOERROR) throw std::runtime_error("Cannot start Windows PCM output");
    priming = false;
}
void AudioOutput::service() {
    if (device && priming && queued() && GetTickCount64() - primeStart >= PrimeBuffers * 10) restart();
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
    priming = false;
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
void AudioOutput::write(const int16_t* samples, unsigned frames) {
    if (!device) return;
    if (!priming && !queued()) {
        if (waveOutPause(device) != MMSYSERR_NOERROR) throw std::runtime_error("Cannot pause Windows PCM output");
        priming = true; primeStart = GetTickCount64();
    }
    while (frames) {
        auto length = std::min(frames, 480u);
        auto it = std::find_if(slots.begin(), slots.end(), [](const Slot& slot) {
            return !slot.prepared || (slot.header.dwFlags & WHDR_DONE);
        });
        if (it == slots.end()) { dropped += frames; return; }
        auto& slot = *it;
        if (slot.prepared) {
            if (waveOutUnprepareHeader(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
                throw std::runtime_error("Cannot release Windows PCM buffer");
            slot.prepared = false;
        }
        std::copy_n(samples, length * 2, slot.data.begin());
        slot.header = {}; slot.header.lpData = reinterpret_cast<LPSTR>(slot.data.data());
        slot.header.dwBufferLength = length * 2 * sizeof(int16_t);
        if (waveOutPrepareHeader(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
            throw std::runtime_error("Cannot prepare Windows PCM buffer");
        slot.prepared = true;
        if (waveOutWrite(device, &slot.header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
            throw std::runtime_error("Cannot submit Windows PCM buffer");
        submitted += length;
        nonzero += std::count_if(samples, samples + length * 2, [](int16_t value) { return value != 0; });
        samples += length * 2; frames -= length;
    }
    if (priming && queued() >= PrimeBuffers) restart();
}

void MidiOutput::open() {
    if (device) return;
    // A host without a MIDI synthesiser still gets PCM and FM; guest MIDI bytes are then discarded.
    if (midiOutOpen(&device, MIDI_MAPPER, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR) device = nullptr;
}
void MidiOutput::clear() {
    status = 0; have = 0; sysex = false;
    if (device && midiOutReset(device) != MMSYSERR_NOERROR) throw std::runtime_error("Cannot reset Windows MIDI output");
}
MidiOutput::~MidiOutput() {
    if (device) { midiOutReset(device); midiOutClose(device); }
}
void MidiOutput::write(uint8_t value) {
    if (!device) return;
    auto send = [&](DWORD message) {
        if (midiOutShortMsg(device, message) != MMSYSERR_NOERROR) throw std::runtime_error("Cannot send Windows MIDI message");
        ++messages;
    };
    if (value >= 0xf8) { send(value); return; } // Real-time bytes may appear anywhere.
    if (value == 0xf0) { sysex = true; return; }
    if (value == 0xf7) { sysex = false; return; }
    if (value & 0x80) { sysex = false; status = value >= 0xf0 ? 0 : value; have = 0; return; }
    if (sysex || !status) return;
    data[have++] = value;
    unsigned needed = (status & 0xf0) == 0xc0 || (status & 0xf0) == 0xd0 ? 1 : 2;
    if (have < needed) return;
    send(status | (DWORD(data[0]) << 8) | (needed == 2 ? DWORD(data[1]) << 16 : 0));
    have = 0;
}
}
