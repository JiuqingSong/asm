#pragma once
#include "pc.h"
#include <algorithm>
#include <chrono>
#include <cmath>

namespace asm86 {
class ExecutionTiming {
public:
    using HostClock = std::chrono::steady_clock;
    static constexpr double PitHz = 1193182.0;
    static double normalRate(CpuModel model) {
        return model == CpuModel::I486 ? 8000000.0 : model == CpuModel::I386 ? 4000000.0
            : model == CpuModel::I286 ? 2000000.0 : PitHz / 3.6;
    }
    void reset(const Pc& pc, HostClock::time_point now = HostClock::now()) {
        hostOrigin = now; guestOrigin = pc.clock; fraction = 0;
    }
    double target(HostClock::time_point now) const {
        return guestOrigin + std::chrono::duration<double>(now - hostOrigin).count() * PitHz;
    }
    void advance(Pc& pc, bool fullSpeed, HostClock::time_point now) {
        auto next = std::min(target(now), pc.clock + PitHz / 4000);
        auto elapsed = std::max(0.0, next - pc.clock);
        if (elapsed > 0) pc.advanceClock(next);
        unsigned budget = 1024;
        if (!fullSpeed) {
            auto credit = fraction + elapsed * normalRate(pc.cpu.model) / PitHz;
            budget = unsigned(std::floor(credit)); fraction = credit - budget;
        } else fraction = 0;
        pc.runCpu(budget);
    }
    void run(Pc& pc, bool fullSpeed, HostClock::duration quantum = std::chrono::milliseconds(8)) {
        const auto start = HostClock::now(), deadline = start + quantum;
        const auto until = target(start);
        do {
            advance(pc, fullSpeed, fullSpeed ? HostClock::now() : start);
        } while (!pc.rebootRequested && (fullSpeed || pc.clock < until) && HostClock::now() < deadline);
    }
private:
    HostClock::time_point hostOrigin = HostClock::now();
    double guestOrigin = 0, fraction = 0;
};
}
