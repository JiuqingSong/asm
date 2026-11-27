#pragma once
#include "dma.h"
#include <array>
#include <deque>
#include <functional>
#include <limits>
#include <vector>

namespace asm86 {
class Disk;

// 主板只挂载 A:，仍模拟四个单元的寻道/复位状态供驱动探测。
class FloppyController {
public:
    FloppyController() { reset(); }
    std::function<Disk*()> disk;
    std::function<void(bool)> interrupt;
    std::function<DmaResult(uint8_t*, unsigned, DmaDirection)> dma;
    double nextEvent = std::numeric_limits<double>::infinity();
    static bool owns(uint16_t port) { return port >= 0x3f0 && port <= 0x3f7 && port != 0x3f6; }
    void reset();
    void advance(double now);
    uint8_t input(uint16_t port, double now);
    void output(uint16_t port, uint8_t value, double now);
private:

    // PIO 的 Read/Write 属于非 DMA 执行期；Result 阶段必须读完才能接收下一条命令。
    enum class Phase { Command, Execute, Read, Write, Result };
    enum class Action { None, Reset, Id, Transfer, Format };
    Phase phase = Phase::Command;
    Action action = Action::None;
    uint8_t dor = 0x0c, rate = 0, perpendicular = 0, resetSense = 0;
    std::array<uint8_t, 4> cylinder{}, seekTarget{}, seekHead{};
    std::array<double, 4> seekTime{};
    std::array<uint8_t, 2> specify{}, config{0x20,0};
    std::deque<std::array<uint8_t, 2>> pending;

    // command 正在接收，active 已执行，result 是 ST0/ST1/ST2/C/H/R/N 等返回字段。
    std::vector<uint8_t> command, active, result, buffer;
    unsigned position = 0, resultPosition = 0, rotation = 0, sectorIndex = 0;
    struct Sector { uint32_t lba; uint8_t head, number; };
    std::vector<Sector> sectors;
    uint64_t seenMedia = 0, activeMedia = 0;
    bool changed = true, irqPending = false, locked = false, writing = false, dirty = false;
    double due = std::numeric_limits<double>::infinity();
    void signal();
    void irq(bool raised);
    void schedule(Action next, double now);
    void deadlines();
    void softReset();
    Disk* medium(unsigned drive);
    Disk* activeDisk();
    void checkChange();
    void finish(std::vector<uint8_t> bytes, bool raised);
    void status(uint8_t st1, uint8_t st2, uint8_t c, uint8_t h, uint8_t r, uint8_t n, uint8_t actualHead = 255);
    void execute(double now);
    void transferReady(double now);
    void transferData(double now);
    void sectorDone(bool terminal, double now);
    void formatReady(double now);
    void formatDone();
    uint8_t readData(double now);
    void writeData(uint8_t value, double now);
};
}
