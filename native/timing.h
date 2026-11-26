#pragma once
#include "pc.h"
#include <algorithm>
#include <chrono>
#include <cmath>

namespace asm86 {
// 宿主稳态时钟与客体 PIT 时钟之间的桥梁；正常档限速，Full speed 消耗尽可能多的宿主执行时间。
class ExecutionTiming {
public:
    using HostClock = std::chrono::steady_clock;
    static constexpr double PitHz = 1193182.0;
    static constexpr double Stable486Rate = 32000000.0;
    static double normalRate(CpuModel model) {
        return model == CpuModel::I486 ? 8000000.0 : model == CpuModel::I386 ? 4000000.0
            : model == CpuModel::I286 ? 2000000.0 : PitHz / 3.6;
    }
    void reset(const Pc& pc, HostClock::time_point now = HostClock::now()) {
        // 暂停恢复/速度切换后重建基准，不能补跑暂停期间的宿主时间。
        hostOrigin = now; guestOrigin = pc.clock; fraction = 0; stableIdle = false;
    }
    double target(HostClock::time_point now) const {
        return guestOrigin + std::chrono::duration<double>(now - hostOrigin).count() * PitHz;
    }
    void advance(Pc& pc, bool fullSpeed, HostClock::time_point now, bool stableTiming = false) {
        // 每小片先推进外设再执行 CPU；fraction 保存限速档不足一条指令的余量。
        if (pc.powerOffRequested) return;
        if (stableTiming && pc.cpu.model == CpuModel::I486) {
            advanceStable(pc, fullSpeed, now);
            return;
        }
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
    void run(Pc& pc, bool fullSpeed, HostClock::duration quantum = std::chrono::milliseconds(8), bool stableTiming = false) {
        // 每次最多占用一个 quantum，返回窗口消息循环，避免 Full speed 饿死菜单/输入。
        const auto start = HostClock::now(), deadline = start + quantum;
        const auto until = target(start);
        do {
            advance(pc, fullSpeed, fullSpeed ? HostClock::now() : start, stableTiming);
        } while (!pc.rebootRequested && !pc.powerOffRequested && (fullSpeed || pc.clock < until) && HostClock::now() < deadline);
    }
private:
    void advanceStable(Pc& pc, bool fullSpeed, HostClock::time_point now) {
        // 稳定 486 档：忙碌时按实际指令量推进时间；HLT/BIOS 等待时改用宿主时间唤醒设备。
        if (pc.cpu.halted || pc.cpu.waiting) {
            if (!stableIdle) { reset(pc, now); stableIdle = true; }
            auto next = std::max(pc.clock, std::min(target(now), pc.clock + PitHz / 4000));
            pc.advanceClock(next);
            pc.runCpu(1);
            if (!pc.cpu.halted && !pc.cpu.waiting && !pc.powerOffRequested) {
                stableIdle = false;
                pc.advanceClock(pc.clock + PitHz / Stable486Rate);
            }
            return;
        }
        stableIdle = false;
        unsigned budget = 4096;
        if (!fullSpeed) {
            auto remaining = target(now) - pc.clock;
            if (remaining <= 0) return;
            budget = unsigned(std::max(1.0, std::min(double(budget), std::floor(remaining * Stable486Rate / PitHz))));
        }
        auto before = pc.instructions;
        pc.runCpu(budget);
        if (pc.powerOffRequested) return;
        pc.advanceClock(pc.clock + double(pc.instructions - before) * PitHz / Stable486Rate);

        // 从空闲边界重新跟随宿主，避免把之前 CPU 停顿或超前执行的时间补偿到客体。
        if (pc.cpu.halted || pc.cpu.waiting) { reset(pc, now); stableIdle = true; }
    }
    HostClock::time_point hostOrigin = HostClock::now();
    double guestOrigin = 0, fraction = 0;
    bool stableIdle = false;
};
}
