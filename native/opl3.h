#pragma once
#include <array>
#include <cstdint>

namespace asm86 {
// YMF262 (OPL3) FM synthesiser: both register banks, OPL2 compatibility, 2/4-operator channels, rhythm mode,
// 8 waveforms, tremolo/vibrato and the two status timers. A behavioural model (floating point, rendered directly
// at the host rate) rather than a gate-level one: timbres and envelopes match, exact DAC bit patterns do not.
class Opl3 {
    friend class Snapshot;
public:
    static constexpr double PitHz = 1193182.0;
    void reset();
    void write(unsigned reg, uint8_t value, double now);
    uint8_t status(double now);
    // One host sample at `rate` Hz; adds to left/right in roughly [-1, 1].
    void generate(double rate, double& left, double& right);
    bool active() const;
private:
    enum Stage : uint8_t { Off, Attack, Decay, Sustain, Release };
    struct Operator {
        double phase = 0, envelope = 96, out = 0, previous = 0;
        Stage stage = Off;
        bool key = false;
    };
    std::array<uint8_t, 512> regs{};
    std::array<Operator, 36> ops{};
    double lfoAm = 0, lfoVib = 0;
    uint32_t noise = 1;
    double noiseClock = 0;
    uint8_t flags = 0;
    std::array<double, 2> timerStart{}, timerPeriod{};
    std::array<bool, 2> timerRunning{};
    bool opl3() const { return regs[0x105] & 1; }
    void keyOperator(unsigned op, bool on);
    void updateTimers(double now);
    double operatorOutput(unsigned op, unsigned channel, double modulation, double rate, int forcedPhase = -1);
};
}
