#pragma once
#include <cstdint>
#include <functional>
#include <limits>
#include <vector>

namespace asm86 {
class Disk;

// ATA 第一通道主盘，IRQ 回调只报告电平；由 Pc 转接到级联 PIC 的 IRQ14。
class IdeChannel {
public:
    std::function<Disk*()> disk;
    std::function<void(bool)> interrupt;
    double nextEvent = std::numeric_limits<double>::infinity();
    static bool owns(uint16_t port) { return (port >= 0x1f0 && port <= 0x1f7) || port == 0x3f6; }
    void reset();
    void advance(double now);
    uint8_t input(uint16_t port, double now);
    void output(uint16_t port, uint8_t value, double now);
    uint16_t readWord(double now);
    void writeWord(uint16_t value, double now);
private:

    // Phase 表示当前 PIO 数据方向；Action 表示 BSY 结束后要执行的状态转换。
    enum class Phase { Idle, Input, Output };
    enum class Action { Done, Input, Write, Reset };
    Phase phase = Phase::Idle;
    Action action = Action::Done;
    uint8_t features = 0, count = 1, sector = 1, cylinderLow = 0, cylinderHigh = 0;
    uint8_t device = 0xa0, control = 0, status = 0x50, error = 1, pendingError = 0, multiple = 0;

    // remaining 为整个命令剩余扇区，blockCount 为当前 DRQ 块，position 是块内字节位置。
    unsigned logicalHeads = 0, logicalSpt = 0, position = 0, remaining = 0, blockSize = 1, blockCount = 0;
    uint32_t lba = 0;
    bool irqPending = false, writeCache = true;
    std::vector<uint8_t> buffer;
    Disk* selected() const;
    void signal();
    void irq(bool value);
    void afterBusy(Action next, double now, uint8_t failure = 0);
    void command(uint8_t value, double now);
    bool address(const Disk& drive, uint32_t& result) const;
    void setAddress(const Disk& drive, uint32_t value);
    void identify(const Disk& drive, double now);
    void readBlock(double now);
    void expectWrite();
    void writeBlock(double now);
    void consumed(double now);
};
}
