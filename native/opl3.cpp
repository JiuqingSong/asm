#include "opl3.h"
#include <algorithm>
#include <cmath>

namespace asm86 {
namespace {
constexpr double Pi = 3.141592653589793;
constexpr double Multiples[16] = {0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15};
// Key-scale attenuation in dB at block 7, falling 3 dB per lower octave (YM3812 application manual).
constexpr double KeyScale[16] = {0, 9, 12, 13.875, 15, 16.125, 16.875, 17.625, 18, 18.75, 19.125, 19.5, 19.875, 20.25, 20.625, 21};
constexpr double KeyScaleFactor[4] = {0, 1, 0.5, 2};
const std::array<double, 1024>& sineTable() {
    static const auto table = [] {
        std::array<double, 1024> result{};
        for (unsigned i = 0; i < result.size(); ++i) result[i] = std::sin(2 * Pi * i / 1024);
        return result;
    }();
    return table;
}
// Phase is a 10-bit cycle position, as in the chip's waveform ROM addressing.
double waveform(unsigned wave, unsigned p) {
    const auto& sine = sineTable();
    p &= 1023;
    switch (wave) {
    case 0: return sine[p];
    case 1: return p < 512 ? sine[p] : 0;
    case 2: return std::fabs(sine[p]);
    case 3: return (p & 511) < 256 ? std::fabs(sine[p]) : 0;
    case 4: return p < 512 ? sine[(p * 2) & 1023] : 0;
    case 5: return p < 512 ? std::fabs(sine[(p * 2) & 1023]) : 0;
    case 6: return p < 512 ? 1 : -1;
    default: return p < 512 ? std::exp2(-double(p) / 32) : -std::exp2(-double((p & 511) ^ 511) / 32);
    }
}
// Envelope timings from the YM3812/YMF262 manuals: attack 0..100% and decay 0..96 dB at rate 4 (AR/DR = 1);
// each rate step of 4 halves the time, and the two low bits subdivide it.
double rateMs(double base, unsigned rate) {
    rate = std::min(rate, 60u);
    return base * std::exp2(-double(rate >> 2)) * 4 / (4 + (rate & 3));
}
}

void Opl3::reset() {
    regs.fill(0); ops = {}; lfoAm = lfoVib = noiseClock = 0; noise = 1; flags = 0;
    timerStart.fill(0); timerPeriod.fill(0); timerRunning.fill(false);
}

bool Opl3::active() const {
    return std::any_of(ops.begin(), ops.end(), [](const Operator& op) { return op.stage != Off; });
}

void Opl3::keyOperator(unsigned op, bool on) {
    auto& o = ops[op];
    if (on && !o.key) { o.stage = Attack; o.phase = 0; }
    else if (!on && o.key && o.stage != Off) o.stage = Release;
    o.key = on;
}

void Opl3::updateTimers(double now) {
    for (unsigned t = 0; t < 2; ++t) {
        if (!timerRunning[t] || now < timerStart[t] + timerPeriod[t]) continue;
        if (!(regs[4] & (t ? 0x20 : 0x40))) flags |= t ? 0x20 : 0x40;
        timerStart[t] += timerPeriod[t] * std::floor((now - timerStart[t]) / timerPeriod[t]);
    }
}

uint8_t Opl3::status(double now) {
    updateTimers(now);
    return uint8_t(flags | (flags & 0x60 ? 0x80 : 0));
}

void Opl3::write(unsigned reg, uint8_t value, double now) {
    reg &= 0x1ff;
    if (reg == 4) {
        updateTimers(now);
        if (value & 0x80) { flags = 0; return; }
        regs[4] = value;
        for (unsigned t = 0; t < 2; ++t) {
            bool startBit = value & (t ? 2 : 1);
            if (startBit && !timerRunning[t]) {
                timerStart[t] = now;
                timerPeriod[t] = (256 - regs[2 + t]) * (t ? 320.0 : 80.0) * PitHz / 1000000;
            }
            timerRunning[t] = startBit;
        }
        // Masking a timer also clears its flag.
        flags &= uint8_t(~(value & 0x60));
        if (!(flags & 0x60)) flags = 0;
        return;
    }
    regs[reg] = value;
    unsigned low = reg & 0xff;
    if (!((low >= 0xb0 && low <= 0xb8) || reg == 0xbd || reg == 0x104 || reg == 0x105)) return;
    std::array<bool, 36> keys{};
    for (unsigned bank = 0; bank < 2; ++bank)
        for (unsigned c = 0; c < 9; ++c) {
            unsigned op = bank * 18 + (c / 3) * 6 + c % 3;
            keys[op] = keys[op + 3] = regs[bank * 0x100 + 0xb0 + c] & 0x20;
        }
    if (opl3())
        for (unsigned bank = 0; bank < 2; ++bank)
            for (unsigned p = 0; p < 3; ++p) if (regs[0x104] & (1 << (bank * 3 + p))) {
                unsigned a = bank * 18 + p, b = a + 6;
                keys[b] = keys[b + 3] = keys[a];
            }
    if (regs[0xbd] & 0x20) {
        auto rhythm = regs[0xbd];
        if (rhythm & 0x10) keys[12] = keys[15] = true;
        if (rhythm & 0x01) keys[13] = true;
        if (rhythm & 0x08) keys[16] = true;
        if (rhythm & 0x04) keys[14] = true;
        if (rhythm & 0x02) keys[17] = true;
    }
    for (unsigned op = 0; op < 36; ++op) keyOperator(op, keys[op]);
}

double Opl3::operatorOutput(unsigned op, unsigned channel, double modulation, double rate, int forcedPhase) {
    auto& o = ops[op];
    unsigned bank = op / 18, local = op % 18, offset = bank * 0x100 + (local / 6) * 8 + local % 6;
    unsigned c = bank * 0x100 + channel % 9;
    uint8_t r20 = regs[0x20 + offset], r40 = regs[0x40 + offset], r60 = regs[0x60 + offset], r80 = regs[0x80 + offset];
    unsigned fnum = regs[0xa0 + c] | ((regs[0xb0 + c] & 3) << 8), block = (regs[0xb0 + c] >> 2) & 7;
    double frequency = fnum * 49716.0 / double(1u << (20 - block));
    if (r20 & 0x40) {
        auto triangle = lfoVib < 0.5 ? lfoVib * 4 - 1 : 3 - lfoVib * 4;
        frequency *= std::exp2((regs[0xbd] & 0x40 ? 14 : 7) * triangle / 1200);
    }
    auto increment = frequency * Multiples[r20 & 15] / rate;
    unsigned keyCode = (block << 1) | ((fnum >> (regs[8] & 0x40 ? 8 : 9)) & 1);
    unsigned offsetRate = r20 & 0x10 ? keyCode : keyCode >> 2;
    auto decayStep = [&](unsigned value) {
        if (!value) return 0.0;
        return 96 / (rateMs(78561.28, value * 4 + offsetRate) / 1000 * rate);
    };
    switch (o.stage) {
    case Attack: {
        unsigned ar = r60 >> 4;
        if (!ar) break;
        unsigned effective = std::min(63u, ar * 4 + offsetRate);
        if (effective >= 60) o.envelope = 0;
        else o.envelope *= std::exp(-6.87 / (rateMs(5652.48, effective) / 1000 * rate));
        if (o.envelope < 0.1) { o.envelope = 0; o.stage = Decay; }
        break;
    }
    case Decay: {
        unsigned sl = r80 >> 4;
        double level = sl == 15 ? 93 : sl * 3.0;
        o.envelope += decayStep(r60 & 15);
        if (o.envelope >= level) { o.envelope = level; o.stage = r20 & 0x20 ? Sustain : Release; }
        break;
    }
    case Sustain:
        if (!(r20 & 0x20)) o.stage = Release;
        break;
    case Release:
        o.envelope += decayStep(r80 & 15);
        if (o.envelope >= 96) { o.envelope = 96; o.stage = Off; }
        break;
    case Off: break;
    }
    unsigned wave = opl3() ? regs[0xe0 + offset] & 7 : regs[1] & 0x20 ? regs[0xe0 + offset] & 3 : 0;
    double attenuation = o.envelope + (r40 & 63) * 0.75
        + std::max(0.0, KeyScale[fnum >> 6] - (7 - double(block)) * 3) * KeyScaleFactor[r40 >> 6];
    if (r20 & 0x80) {
        auto triangle = lfoAm < 0.5 ? lfoAm * 2 : 2 - lfoAm * 2;
        attenuation += (regs[0xbd] & 0x80 ? 4.8 : 1.0) * triangle;
    }
    double value = 0;
    if (o.stage != Off && attenuation < 96) {
        unsigned p = forcedPhase >= 0 ? unsigned(forcedPhase) : unsigned(int64_t(std::floor((o.phase + modulation) * 1024)));
        value = waveform(wave, p) * std::exp(-attenuation * 0.1151292546497023);
    }
    o.previous = o.out; o.out = value;
    o.phase += increment; o.phase -= std::floor(o.phase);
    return value;
}

void Opl3::generate(double rate, double& left, double& right) {
    lfoAm += 3.7 / rate; lfoAm -= std::floor(lfoAm);
    lfoVib += 6.07 / rate; lfoVib -= std::floor(lfoVib);
    for (noiseClock += 49716 / rate; noiseClock >= 1; --noiseClock) {
        uint32_t bit = ((noise >> 14) ^ noise) & 1;
        noise = (noise >> 1) | (bit << 22);
    }
    if (!active()) return;
    // A full-scale operator is +/-4095 of the chip's 16-bit accumulator.
    constexpr double Scale = 4095.0 / 32768;
    // Operator output in cycles of carrier phase: +/-4095 shifts a 10-bit phase by four cycles.
    constexpr double Mod = 4095.0 / 1024;
    auto feedback = [&](unsigned op, unsigned fb) {
        return fb ? (ops[op].out + ops[op].previous) * Mod / double(1u << (9 - fb)) : 0.0;
    };
    auto silent = [&](unsigned first, unsigned count) {
        for (unsigned i = 0; i < count; ++i) if (ops[first + i * 3].stage != Off) return false;
        return true;
    };
    bool rhythm = regs[0xbd] & 0x20;
    for (unsigned bank = 0; bank < 2; ++bank)
        for (unsigned c = 0; c < 9; ++c) {
            unsigned base = bank * 0x100, op1 = bank * 18 + (c / 3) * 6 + c % 3, channel = bank * 9 + c;
            bool four = opl3() && c < 3 && (regs[0x104] & (1 << (bank * 3 + c)));
            if (opl3() && c >= 3 && c < 6 && (regs[0x104] & (1 << (bank * 3 + c - 3)))) continue;
            if (bank == 0 && rhythm && c >= 6) continue;
            uint8_t c0 = regs[base + 0xc0 + c];
            unsigned fb = (c0 >> 1) & 7;
            double sample;
            // In four-operator mode channel A's F-number, block and key drive all four operators.
            if (four) {
                if (silent(op1, 2) && silent(op1 + 6, 2)) continue;
                uint8_t second = regs[base + 0xc3 + c];
                auto o1 = operatorOutput(op1, channel, feedback(op1, fb), rate);
                switch ((c0 & 1) << 1 | (second & 1)) {
                case 0: {
                    auto o2 = operatorOutput(op1 + 3, channel, o1 * Mod, rate);
                    auto o3 = operatorOutput(op1 + 6, channel, o2 * Mod, rate);
                    sample = operatorOutput(op1 + 9, channel, o3 * Mod, rate); break;
                }
                case 1: {
                    auto o2 = operatorOutput(op1 + 3, channel, o1 * Mod, rate);
                    auto o3 = operatorOutput(op1 + 6, channel, 0, rate);
                    sample = o2 + operatorOutput(op1 + 9, channel, o3 * Mod, rate); break;
                }
                case 2: {
                    auto o2 = operatorOutput(op1 + 3, channel, 0, rate);
                    auto o3 = operatorOutput(op1 + 6, channel, o2 * Mod, rate);
                    sample = o1 + operatorOutput(op1 + 9, channel, o3 * Mod, rate); break;
                }
                default: {
                    auto o2 = operatorOutput(op1 + 3, channel, 0, rate);
                    auto o3 = operatorOutput(op1 + 6, channel, o2 * Mod, rate);
                    sample = o1 + o3 + operatorOutput(op1 + 9, channel, 0, rate); break;
                }
                }
            } else {
                if (silent(op1, 2)) { ops[op1].out = ops[op1].previous = 0; continue; }
                auto o1 = operatorOutput(op1, channel, feedback(op1, fb), rate);
                sample = c0 & 1 ? o1 + operatorOutput(op1 + 3, channel, 0, rate)
                    : operatorOutput(op1 + 3, channel, o1 * Mod, rate);
            }
            bool toLeft = !opl3() || (c0 & 0x10), toRight = !opl3() || (c0 & 0x20);
            if (toLeft) left += sample * Scale;
            if (toRight) right += sample * Scale;
        }
    if (!rhythm) return;
    // Rhythm: BD is channel 6 doubled; HH/SD/TOM/CY derive their phases from operators 13 and 17 and the noise LFSR.
    double drums = 0;
    if (!silent(12, 2)) {
        uint8_t c0 = regs[0xc6];
        auto o1 = operatorOutput(12, 6, feedback(12, (c0 >> 1) & 7), rate);
        drums += 2 * (c0 & 1 ? operatorOutput(15, 6, 0, rate) : operatorOutput(15, 6, o1 * Mod, rate));
    }
    unsigned hh = unsigned(ops[13].phase * 1024) & 1023, tc = unsigned(ops[17].phase * 1024) & 1023;
    auto bit = [](unsigned value, unsigned n) { return (value >> n) & 1; };
    unsigned mix = (bit(hh, 2) ^ bit(hh, 7)) | (bit(hh, 3) ^ bit(tc, 5)) | (bit(tc, 3) ^ bit(tc, 5));
    unsigned noiseBit = noise & 1;
    drums += 2 * operatorOutput(13, 7, 0, rate, int((mix << 9) | ((mix ^ noiseBit) ? 0xd0 : 0x34)));
    drums += 2 * operatorOutput(16, 7, 0, rate, int((bit(hh, 8) << 9) | ((bit(hh, 8) ^ noiseBit) << 8)));
    drums += 2 * operatorOutput(14, 8, 0, rate);
    drums += 2 * operatorOutput(17, 8, 0, rate, int((mix << 9) | 0x80));
    left += drums * Scale; right += drums * Scale;
}
}
