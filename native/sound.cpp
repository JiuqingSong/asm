#include "sound.h"
#include <cmath>

namespace asm86 {
namespace {
constexpr char Copyright[] = "COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.";
// DSP command E2h ("DMA identification"), as Creative's diagnostics and drivers check it.
constexpr int E2Increments[4][9] = {
    {0x01, -0x02, -0x04, 0x08, -0x10, 0x20, 0x40, -0x80, -106},
    {-0x01, 0x02, -0x04, 0x08, 0x10, -0x20, 0x40, -0x80, 165},
    {-0x01, 0x02, 0x04, -0x08, 0x10, -0x20, -0x40, 0x80, -151},
    {0x01, 0x02, 0x04, -0x08, -0x10, 0x20, -0x40, 0x80, 90}};
int16_t clip(double value) { return int16_t(std::lround(std::clamp(value, -1.0, 32767.0 / 32768) * 32768)); }
}

void SoundBlaster::setIrq() {
    bool raised = irq8 || irq16;
    if (line == raised) return;
    line = raised;
    if (interrupt) interrupt(raised);
}

void SoundBlaster::flush() {
    if (position && pcm) pcm(buffer.data(), position / 2);
    position = 0;
}

void SoundBlaster::resetDsp() {
    irq8 = irq16 = false; setIrq();
    fifo.clear(); command = -1; parameter = 0; test = 0;
    speaker = active = autoInit = paused = wide = stereo = signedData = recording = silence = false;
    block = reload = 1; left = 0; rate = 22050; timeConstant = true;
    period = PitHz / 22050; pauseRemaining = busyUntil = 0;
    resetNext = sourceNext = Never;
    e2Value = 0xaa; e2Count = 0;
}

void SoundBlaster::mixerReset() {
    mixer.fill(0);
    for (unsigned i = 0x30; i <= 0x35; ++i) mixer[i] = 0xc0; // Master, voice and FM at 24 of 31.
    mixer[0x3c] = 0x1f; mixer[0x3d] = 0x15; mixer[0x3e] = 0x0b;
    for (unsigned i = 0x44; i <= 0x47; ++i) mixer[i] = 0x80;
}

void SoundBlaster::reset() {
    resetDsp(); resetHigh = false; unsupportedCommands = 0; lastUnsupported = 0; lastCommand = 0;
    // No ASP/CSP is fitted; these are the register values Creative's Windows drivers accept as a plain SB16.
    asp.fill(0); asp[5] = 0x01; asp[9] = 0xf8;
    mixerReset(); mixerIndex = 0;
    midi.clear(); uart = false;
    fm.reset(); fmIndex.fill(0);
    previous.fill(0); current.fill(0); currentTime = 0;
    renderNext = holdUntil = Never; position = 0;
    if (clearOutput) clearOutput();
}

// SB Pro registers are views of the CT1745's 5-bit left/right registers.
uint8_t SoundBlaster::mixerRead(uint8_t index) const {
    auto pair = [&](unsigned left) { return uint8_t((mixer[left] & 0xf0) | (mixer[left + 1] >> 4)); };
    switch (index) {
    case 0x04: return pair(0x32);
    case 0x0a: return uint8_t((mixer[0x3a] >> 5) << 1);
    case 0x22: return pair(0x30);
    case 0x26: return pair(0x34);
    case 0x28: return pair(0x36);
    case 0x2e: return pair(0x38);
    case 0x80: return 0x02; // IRQ5.
    case 0x81: return 0x22; // DMA1 and DMA5.
    case 0x82: return uint8_t((irq8 ? 1 : 0) | (irq16 ? 2 : 0) | 0x20);
    case 0x0e: return uint8_t(0x11 | (mixer[0x0e] & 0x22));
    // Registers the CT1745 lacks (ViBRA/AWE extensions that drivers probe for) read as 0Ah and ignore writes.
    default: return index >= 0x30 && index <= 0x47 ? mixer[index] : 0x0a;
    }
}

void SoundBlaster::mixerWrite(uint8_t index, uint8_t value) {
    auto pair = [&](unsigned left) {
        mixer[left] = uint8_t((value & 0xf0) | 0x08);
        mixer[left + 1] = uint8_t((value << 4) | 0x08);
    };
    switch (index) {
    case 0x00: mixerReset(); break;
    case 0x04: pair(0x32); break;
    case 0x0a: mixer[0x3a] = uint8_t(((value >> 1) & 7) << 5); break;
    case 0x22: pair(0x30); break;
    case 0x26: pair(0x34); break;
    case 0x28: pair(0x36); break;
    case 0x2e: pair(0x38); break;
    case 0x0e: mixer[0x0e] = uint8_t(value & 0x22); break; // SB Pro stereo and filter bits.
    default: if (index >= 0x30 && index <= 0x47) mixer[index] = value; break; // 80h-82h: fixed resources and status.
    }
}

double SoundBlaster::gain(uint8_t index) const {
    unsigned level = mixer[index] >> 3;
    return level ? std::pow(10.0, -(31.0 - level) * 2 / 20) : 0;
}

uint8_t SoundBlaster::input(uint16_t port, double now) {
    if (!enabled) return 255;
    advance(now);
    switch (port) {
    case 0x220: case 0x222: case 0x228: case 0x388: case 0x38a: return fm.status(now);
    case 0x224: return mixerIndex;
    case 0x225: return mixerRead(mixerIndex);
    case 0x22a: {
        if (fifo.empty()) return 255;
        auto value = fifo.front(); fifo.pop_front(); return value;
    }
    case 0x22c: return resetHigh || now < busyUntil ? 0x80 : 0;
    case 0x22e: irq8 = false; setIrq(); return fifo.empty() ? 0 : 0x80;
    case 0x22f: irq16 = false; setIrq(); return 0xff;
    case 0x330: {
        if (midi.empty()) return 0xff;
        auto value = midi.front(); midi.pop_front(); return value;
    }
    case 0x331: return midi.empty() ? 0xbf : 0x3f; // Bit 7 clear: data ready; bit 6 clear: ready for output.
    default: return 255;
    }
}

unsigned SoundBlaster::parameters(uint8_t value) {
    if (value >= 0xb0 && value <= 0xcf) return 3;
    switch (value) {
    case 0x04: case 0x0f: case 0x10: case 0x38: case 0x40: case 0xe0: case 0xe2: case 0xe4: case 0xf9: return 1;
    case 0x05: case 0x0e: case 0x14: case 0x15: case 0x16: case 0x17: case 0x24: case 0x41: case 0x42: case 0x48:
    case 0x74: case 0x75: case 0x76: case 0x77: case 0x80: return 2;
    default: return 0;
    }
}

void SoundBlaster::wake(double now, double hold) {
    if (renderNext == Never) { previous = current; currentTime = now; renderNext = now; }
    if (hold != Never) holdUntil = holdUntil == Never ? hold : std::max(holdUntil, hold);
}

void SoundBlaster::output(uint16_t port, uint8_t value, double now) {
    if (!enabled) return;
    advance(now);
    switch (port) {
    case 0x220: case 0x228: case 0x388: fmIndex[0] = value; return;
    case 0x222: case 0x38a: fmIndex[1] = value; return;
    case 0x221: case 0x229: case 0x389: case 0x223: case 0x38b: {
        bool high = port == 0x223 || port == 0x38b;
        fm.write((high ? 0x100 : 0) | fmIndex[high], value, now);
        if (fm.active()) wake(now, Never);
        return;
    }
    case 0x224: mixerIndex = value; return;
    case 0x225: mixerWrite(mixerIndex, value); return;
    case 0x226:
        if (value & 1) { resetDsp(); resetHigh = true; }
        else if (resetHigh) { resetHigh = false; resetNext = now + PitHz * 3 / 1000000; }
        return;
    case 0x330:
        if (midiOut) midiOut(value);
        return;
    case 0x331:
        // Reset (FFh) and enter-UART (3Fh) are acknowledged with FEh; in UART mode only reset is recognised.
        if (value == 0xff) { uart = false; midi.clear(); midi.push_back(0xfe); }
        else if (!uart) { if (value == 0x3f) uart = true; midi.push_back(0xfe); }
        return;
    case 0x22c: break;
    default: return;
    }
    if (resetHigh || resetNext != Never) return;
    busyUntil = now + PitHz / 1000000;
    if (command < 0) { command = value; parameter = 0; }
    else params[parameter++] = value;
    if (parameter == parameters(uint8_t(command))) {
        execute(now); lastCommand = uint8_t(command); command = -1; parameter = 0;
    }
}

void SoundBlaster::start(unsigned count, bool automatic, bool sixteen, bool twoChannels, bool isSigned, bool input, double now) {
    left = reload = count; autoInit = automatic; active = true; paused = false; silence = false;
    wide = sixteen; stereo = twoChannels; signedData = isSigned; recording = input;
    // A time constant gives the total sample rate, which SB Pro-style stereo splits between both channels.
    auto frames = double(timeConstant && stereo ? rate / 2 : rate);
    period = PitHz / std::clamp(frames, 4000.0, 48000.0);
    sourceNext = now + period;
    // Drivers commonly rearm single-cycle DMA from the IRQ before the last frame has played out.
    if (!input) wake(now, Never);
}

void SoundBlaster::execute(double now) {
    auto reply = [this](uint8_t value) { if (fifo.size() < 256) fifo.push_back(value); };
    auto count = [this] { return 1 + params[1] + (unsigned(params[2]) << 8); };
    auto count2 = [this] { return 1 + params[0] + (unsigned(params[1]) << 8); };
    bool proStereo = mixer[0x0e] & 2;
    uint8_t c = uint8_t(command);
    if (c >= 0xb0 && c <= 0xcf) {
        // DSP 4 transfers: bit 3 records, bit 2 auto-initialises; the mode byte selects signed (bit 4) and stereo (bit 5).
        if (c & 1) { ++unsupportedCommands; lastUnsupported = c; return; }
        start(count(), c & 4, c < 0xc0, params[0] & 0x20, params[0] & 0x10, c & 8, now);
        return;
    }
    switch (c) {
    case 0x04: case 0x05: break; // ASP mode / codec parameter: no ASP fitted, accepted silently.
    case 0x0e: asp[params[0]] = params[1]; break;
    case 0x0f: reply(asp[params[0]]); break;
    case 0x10: {
        auto sample = int16_t((int(params[0]) - 128) * 256);
        wake(now, now + PitHz / 20);
        previous = current; current = {sample, sample}; currentTime = now;
        if (!active) period = PitHz / 22050;
        break;
    }
    case 0x14: case 0x15: case 0x91: start(c == 0x91 ? block : count2(), false, false, proStereo, false, false, now); break;
    case 0x1c: case 0x90: start(block, true, false, proStereo, false, false, now); break;
    case 0x20: reply(0x80); break;
    case 0x24: case 0x99: start(c == 0x99 ? block : count2(), false, false, false, false, true, now); break;
    case 0x2c: case 0x98: start(block, true, false, false, false, true, now); break;
    case 0x38: if (midiOut) midiOut(params[0]); break;
    case 0x40: rate = unsigned(std::lround(1000000.0 / (256 - params[0]))); timeConstant = true; break;
    case 0x41: case 0x42:
        rate = std::clamp((unsigned(params[0]) << 8) | params[1], 4000u, 48000u); timeConstant = false; break;
    case 0x45: if (active && !wide) autoInit = true; break;
    case 0x47: if (active && wide) autoInit = true; break;
    case 0x48: block = count2(); break;
    case 0x80:
        start(count2(), false, false, false, false, false, now); silence = true; break;
    case 0xa0: case 0xa8: break; // SB Pro input mode; the SB16 ignores it.
    case 0xd0: case 0xd5:
        if (active && !paused) {
            paused = true; pauseRemaining = std::max(0.0, sourceNext - now); sourceNext = Never;
            previous.fill(0); current.fill(0);
        }
        break;
    case 0xd4: case 0xd6:
        if (active && paused) { paused = false; sourceNext = now + pauseRemaining; if (!recording) wake(now, Never); }
        break;
    case 0xd1: speaker = true; break; // DSP 4 output is not gated by the speaker commands; only D8h reports them.
    case 0xd3: speaker = false; break;
    case 0xd8: reply(speaker ? 0xff : 0); break;
    case 0xd9: case 0xda: autoInit = false; break;
    case 0xe0: reply(uint8_t(params[0] ^ 255)); break;
    case 0xe1: reply(4); reply(5); break;
    case 0xe2: {
        auto& row = E2Increments[e2Count++ % 4];
        int value = e2Value;
        for (unsigned i = 0; i < 8; ++i) if ((params[0] >> i) & 1) value += row[i];
        e2Value = uint8_t(value + row[8]);
        if (dma) dma(1, &e2Value, 1, DmaDirection::ToMemory);
        break;
    }
    case 0xe3: for (auto ch : Copyright) reply(uint8_t(ch)); break;
    case 0xe4: test = params[0]; break;
    case 0xe8: reply(test); break;
    case 0xf2: raise(false); break;
    case 0xf3: raise(true); break;
    case 0xf8: reply(0); break;
    case 0xf9: // Internal RAM read: the bytes the Windows 9x SB16 driver checks before it accepts the DSP.
        reply(params[0] == 0x0e ? 0xff : params[0] == 0x0f ? 0x07 : params[0] == 0x37 ? 0x38 : 0); break;
    case 0xfd: reply(lastCommand); break;
    default: ++unsupportedCommands; lastUnsupported = c; break;
    }
}

void SoundBlaster::fetch(double event) {
    std::array<int16_t, 2> frame = current;
    for (unsigned ch = 0; ch < (stereo ? 2u : 1u) && active; ++ch) {
        int16_t sample = 0;
        if (!silence) {
            unsigned unit = wide ? 2 : 1;
            // Recording has no ADC: it writes digital silence in the selected format.
            std::array<uint8_t, 2> data{uint8_t(!wide && !signedData ? 0x80 : 0), uint8_t(wide && !signedData ? 0x80 : 0)};
            auto result = dma ? dma(wide ? 5 : 1, data.data(), unit, recording ? DmaDirection::ToMemory : DmaDirection::FromMemory)
                : DmaResult{};
            // A masked or misprogrammed DMA channel neither consumes the DSP block nor raises an IRQ.
            if (result.bytes != unit || result.error) break;
            if (wide) {
                auto raw = uint16_t(data[0] | (data[1] << 8));
                sample = signedData ? int16_t(raw) : int16_t(int(raw) - 32768);
            } else sample = int16_t((signedData ? int(int8_t(data[0])) : int(data[0]) - 128) * 256);
        }
        frame[ch] = sample;
        if (!stereo) frame[1] = sample;
        if (--left == 0) {
            raise(wide);
            if (autoInit) left = reload;
            else { active = false; holdUntil = event + period; }
        }
    }
    if (!recording) { previous = current; current = frame; currentTime = event; }
    sourceNext = active && !paused ? event + period : Never;
}

void SoundBlaster::render() {
    double t = std::clamp((renderNext - currentTime) / period, 0.0, 1.0);
    double l = (previous[0] + (current[0] - previous[0]) * t) / 32768, r = (previous[1] + (current[1] - previous[1]) * t) / 32768;
    l *= gain(0x32); r *= gain(0x33);
    double fl = 0, fr = 0;
    fm.generate(OutputRate, fl, fr);
    l += fl * gain(0x34); r += fr * gain(0x35);
    buffer[position++] = clip(l * gain(0x30));
    buffer[position++] = clip(r * gain(0x31));
    if (position == buffer.size()) flush();
}

void SoundBlaster::advance(double now) {
    if (!enabled) return;
    if (now >= resetNext) { resetNext = Never; fifo.push_back(0xaa); }
    while (std::min(sourceNext, renderNext) <= now) {
        if (sourceNext <= renderNext) { fetch(sourceNext); continue; }
        render();
        renderNext += PitHz / OutputRate;
        if (!playing() && (holdUntil == Never || renderNext >= holdUntil) && !fm.active()) {
            // Idle: stop the 48 kHz clock rather than streaming silence to the host.
            renderNext = holdUntil = Never; previous.fill(0); current.fill(0); flush();
        }
    }
}
}
