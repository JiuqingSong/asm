#include "fdc.h"
#include "pc.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

// 82077/765 风格软驱控制器：命令、执行、PIO 数据、结果四类阶段，IRQ6 与 DMA2 独立握手。
namespace asm86 {
void FloppyController::signal() { if (interrupt) interrupt(irqPending && (dor & 8) && (dor & 4)); }

void FloppyController::irq(bool raised) { irqPending = raised; signal(); }

void FloppyController::deadlines() {
    nextEvent = due;
    for (auto time : seekTime) nextEvent = std::min(nextEvent, time);
}

void FloppyController::schedule(Action next, double now) {
    action = next; due = now + 600; phase = Phase::Execute; deadlines();
}

void FloppyController::softReset() {
    // 复位会产生四个驱动器的 SENSE INTERRUPT 状态；锁定配置跨软复位保留。
    if (dirty) { auto* image = activeDisk(); if (image) image->flush(); }
    phase = Phase::Command; action = Action::None;
    command.clear(); active.clear(); result.clear(); buffer.clear(); sectors.clear();
    pending = {{{0xc0,0}},{{0xc1,0}},{{0xc2,0}},{{0xc3,0}}};
    seekTime.fill(std::numeric_limits<double>::infinity());
    due = nextEvent = std::numeric_limits<double>::infinity();
    if (!locked) config = {0x20,0};
    dirty = false; irq(false);
}

void FloppyController::reset() {
    dor = 0x0c; rate = perpendicular = 0; cylinder.fill(0); specify.fill(0);
    locked = false; changed = true; seenMedia = activeMedia = 0; rotation = 0;
    softReset(); pending.clear();
}

void FloppyController::checkChange() {
    auto* image = disk ? disk() : nullptr;
    auto id = image ? image->identity : 0;
    if (id != seenMedia) { changed = true; seenMedia = id; }
}

Disk* FloppyController::medium(unsigned drive) {
    checkChange(); return drive == 0 && disk ? disk() : nullptr;
}

Disk* FloppyController::activeDisk() {
    // 用介质 identity 检测正在执行的命令期间换盘，不能把旧命令写到新映像。
    auto* image = medium(active[1] & 3);
    return image && image->identity == activeMedia ? image : nullptr;
}

void FloppyController::finish(std::vector<uint8_t> bytes, bool raised) {
    result = std::move(bytes); resultPosition = 0;
    phase = result.empty() ? Phase::Command : Phase::Result;
    action = Action::None; due = std::numeric_limits<double>::infinity(); deadlines();
    if (raised) irq(true);
}

void FloppyController::status(uint8_t st1, uint8_t st2, uint8_t c, uint8_t h, uint8_t r, uint8_t n, uint8_t actualHead) {
    auto* image = activeDisk();
    if (dirty && image) image->flush();
    dirty = false;
    finish({uint8_t(((st1 || (st2 & ~0x40)) ? 0x40 : 0) | ((actualHead == 255 ? h : actualHead) << 2) | (active[1] & 3)),
        st1, st2, c, h, r, n}, true);
}

uint8_t FloppyController::input(uint16_t port, double now) {
    // 3F2 DOR；3F4 MSR（RQM/DIO/NDMA/CB）；3F5 FIFO；3F7 DIR（bit7 换盘）。
    if (port == 0x3f2) return dor;
    if (port == 0x3f5) return readData(now);
    if (port == 0x3f7) { checkChange(); return (dor & 3) == 0 && changed ? 0x80 : 0; }
    if (port != 0x3f4) return 255;
    if (!(dor & 4)) return 0;
    uint8_t seeking = 0;
    for (unsigned i = 0; i < 4; ++i) if (std::isfinite(seekTime[i])) seeking |= uint8_t(1 << i);
    switch (phase) {
    case Phase::Command: return uint8_t(0x80 | (command.empty() ? 0 : 0x10) | seeking);
    case Phase::Execute: return uint8_t(0x10 | seeking);
    case Phase::Read: return 0xf0;
    case Phase::Write: return 0xb0;
    case Phase::Result: return uint8_t(0xd0 | seeking);
    }
    throw std::runtime_error("Invalid floppy controller phase");
}

void FloppyController::output(uint16_t port, uint8_t value, double now) {
    // DOR bit2 复位、bit3 IRQ/DMA 允许、bit4..7 电机；DSR/CCR 选择数据率。
    if (port == 0x3f2) {
        auto old = dor; dor = value;
        if (!(dor & 4)) softReset();
        else if (!(old & 4)) { softReset(); schedule(Action::Reset, now); }
        signal(); return;
    }
    if (port == 0x3f4 || port == 0x3f7) {
        rate = value & 3;
        if (port == 0x3f4 && (value & 0x80)) { softReset(); schedule(Action::Reset, now); }
        return;
    }
    if (port == 0x3f5 && (dor & 4)) writeData(value, now);
}

uint8_t FloppyController::readData(double now) {
    if (phase == Phase::Read) {
        irq(false); auto value = buffer[position++];
        if (position == buffer.size()) sectorDone(false, now); else irq(true);
        return value;
    }
    if (phase != Phase::Result) return 255;
    irq(false); auto value = result[resultPosition++];
    if (resultPosition == result.size()) { phase = Phase::Command; result.clear(); }
    return value;
}

void FloppyController::writeData(uint8_t value, double now) {
    if (phase == Phase::Write) {
        irq(false); buffer[position++] = value;
        if (position == buffer.size()) {
            if ((active[0] & 31) == 0x0d) formatDone();
            else sectorDone(false, now);
        } else irq(true);
        return;
    }
    if (phase != Phase::Command) return;
    command.push_back(value);
    static constexpr int parameters[] = {-1,-1,8,2,1,8,8,1,0,-1,1,-1,8,5,0,2,0,-1,1,3,0};

    // 按命令低 5 位查后续参数数；bit7 MT、bit6 MFM、bit5 SK 不改变基础命令编号。
    unsigned op = command[0] & 31;
    if (op >= std::size(parameters) || parameters[op] < 0
        || ((op == 0x0e || op == 0x10) && command[0] != op)) {
        command.clear(); finish({0x80}, false); return;
    }
    if (command.size() == unsigned(parameters[op] + 1)) execute(now);
}

void FloppyController::execute(double now) {
    auto c = std::move(command); command.clear();
    auto drive = c.size() > 1 ? c[1] & 3 : 0, head = c.size() > 1 ? (c[1] >> 2) & 1 : 0;
    auto* image = medium(drive);
    switch (c[0] & 31) {
    case 3: specify = {c[1],c[2]}; return; // SPECIFY：步进/磁头时间和 ND（非 DMA）位。
    case 4: // SENSE DRIVE STATUS：返回 ST3 的就绪、零道、双面、写保护。
        finish({uint8_t(drive | (head << 2) | (drive == 0 ? 0x20 : 0) | (cylinder[drive] == 0 ? 0x10 : 0)
            | ((!image || image->heads > 1) ? 8 : 0) | (image && image->readOnly ? 0x40 : 0))}, false); return;
    case 8: { // SENSE INTERRUPT STATUS：消费一个复位/寻道完成的 ST0+PCN。
        irq(false);
        if (pending.empty()) finish({0x80}, false);
        else { auto value = pending.front(); pending.pop_front(); finish({value[0],value[1]}, false); }
        return;
    }
    case 7: case 15: { // RECALIBRATE / SEEK（含相对寻道）：到期后产生完成 IRQ。
        int target = (c[0] & 31) == 7 ? 0 : c[2];
        if ((c[0] & 31) == 15 && (c[0] & 0x80)) target = cylinder[drive] + (c[0] & 0x40 ? target : -target);
        seekTarget[drive] = uint8_t(std::clamp(target, 0, 255)); seekHead[drive] = uint8_t(head);
        seekTime[drive] = now + 600; deadlines(); return;
    }
    case 14: // DUMPREG：当前柱面、SPECIFY、锁定和配置快照。
        finish({cylinder[0],cylinder[1],cylinder[2],cylinder[3],specify[0],specify[1],0,
            uint8_t((locked ? 0x80 : 0) | perpendicular),config[0],config[1]}, false); return;
    case 16: finish({0x90}, false); return; // VERSION：增强型 FDC。
    case 18: perpendicular = c[1] & 63; return; // PERPENDICULAR MODE。
    case 19: config = {c[2],c[3]}; return; // CONFIGURE：FIFO/隐式寻道等设置。
    case 20: locked = c[0] & 0x80; finish({uint8_t(locked ? 0x10 : 0)}, false); return; // LOCK/UNLOCK。
    }
    active = std::move(c); activeMedia = image ? image->identity : 0;
    sectors.clear(); buffer.clear(); position = sectorIndex = 0;
    dirty = false; phase = Phase::Execute;
    if (!image || !(dor & (0x10 << drive))) return;
    switch (active[0] & 31) {
    case 10: schedule(Action::Id, now); break;
    case 13: schedule(Action::Format, now); break;
    default:
        if (config[0] & 0x40) cylinder[drive] = active[2];
        schedule(Action::Transfer, now); break;
    }
}

void FloppyController::advance(double now) {
    for (unsigned i = 0; i < 4; ++i) if (now >= seekTime[i]) {
        seekTime[i] = std::numeric_limits<double>::infinity();
        uint8_t st0 = uint8_t(0x20 | (seekHead[i] << 2) | i);
        if (i) st0 |= 0x50;
        else { cylinder[i] = seekTarget[i]; checkChange(); if (medium(0)) changed = false; }
        pending.push_back({st0,cylinder[i]}); irq(true);
    }
    if (now < due) { deadlines(); return; }
    auto next = action; action = Action::None; due = std::numeric_limits<double>::infinity(); deadlines();
    if (next == Action::None) return;
    if (next == Action::Reset) { phase = Phase::Command; irq(true); return; }
    auto* image = activeDisk();
    if (!image) { status(4, 0, cylinder[active[1] & 3], (active[1] >> 2) & 1, 1, 2); return; }
    if (next == Action::Id) {
        auto drive = active[1] & 3, head = (active[1] >> 2) & 1;
        rotation = rotation % unsigned(image->spt) + 1;
        status(!(active[0] & 0x40) || cylinder[drive] >= image->cylinders || head >= image->heads ? 1 : 0,
            0, cylinder[drive], uint8_t(head), uint8_t(rotation), 2);
    } else if (next == Action::Format) formatReady(now);
    else if (sectors.empty()) transferReady(now);
    else transferData(now);
}

void FloppyController::transferReady(double now) {
    // READ TRACK(02)、WRITE DATA(05)、READ DATA(06)、READ DELETED DATA(0C)。
    // 参数 C/H/R/N/EOT/GPL/DTL；本后端只接受 N=2（512 字节），MT 可跨两个磁头。
    auto* image = activeDisk(); auto& c = active;
    unsigned drive = c[1] & 3, head = (c[1] >> 2) & 1, first = (c[0] & 31) == 2 ? 1 : c[4];
    auto fail = [&](uint8_t st1, uint8_t st2 = 0) { status(st1, st2, c[2], uint8_t(head), uint8_t(first), c[5]); };
    writing = (c[0] & 31) == 5;
    if (!(c[0] & 0x40) || cylinder[drive] >= image->cylinders || head >= unsigned(image->heads)) { fail(1); return; }
    if (c[2] != cylinder[drive]) { fail(4, 0x10); return; }
    if (writing && image->readOnly) { fail(2); return; }
    if (c[5] != 2 || c[3] != head || !first || first > unsigned(image->spt) || c[6] < first) { fail(4); return; }
    sectors.clear(); sectorIndex = 0;
    for (unsigned h = head; h <= head + ((c[0] & 0x80) && head == 0 && image->heads > 1 ? 1 : 0); ++h)
        for (unsigned r = h == head ? first : 1; r <= c[6]; ++r) {
            sectors.push_back({r <= unsigned(image->spt) ? uint32_t((c[2] * image->heads + h) * image->spt + r - 1) : 0xffffffffu,
                uint8_t(h),uint8_t(r)});
            if ((c[0] & 31) == 12) break;
        }
    buffer.clear(); transferData(now);
}

void FloppyController::transferData(double now) {
    // ND 模式逐字节 PIO；DMA 模式由通道 2 批量搬运，终端计数可以提前结束多扇区命令。
    auto* image = activeDisk();
    const auto& sector = sectors[sectorIndex];
    if (buffer.empty()) {
        buffer.resize(512);
        if (!image->read(sector.lba, buffer.data())) { status(4, 0, active[2], sector.head, sector.number, 2); return; }
        position = 0;
    }
    if (specify[1] & 1) { phase = writing ? Phase::Write : Phase::Read; irq(true); return; }
    if (!(dor & 8)) { schedule(Action::Transfer, now); return; }
    if (!dma) throw std::runtime_error("Floppy DMA channel is not connected");
    auto transfer = dma(buffer.data(), 512, writing ? DmaDirection::FromMemory : DmaDirection::ToMemory);
    if (transfer.error || (writing && transfer.bytes && transfer.bytes != 512)) {
        status(0x10, 0, active[2], sector.head, sector.number, 2); return;
    }
    if (!transfer.bytes) { schedule(Action::Transfer, now); return; }
    sectorDone(transfer.terminal, now);
}

void FloppyController::sectorDone(bool terminal, double now) {
    auto* image = activeDisk();
    if (!image) { status(4, 0, active[2], sectors[sectorIndex].head, sectors[sectorIndex].number, 2); return; }
    auto sector = sectors[sectorIndex];
    if (writing) {
        if (!image->write(sector.lba, buffer.data())) { status(2, 0, active[2], sector.head, sector.number, 2); return; }
        dirty = true;
    }
    buffer.clear(); ++sectorIndex;
    bool deleted = (active[0] & 31) == 12;
    if (!terminal && !deleted && sectorIndex < sectors.size()) { schedule(Action::Transfer, now); return; }
    uint8_t rc = active[2], rh = sector.head, rr = uint8_t(sector.number + 1);
    if (sector.number >= active[6]) {
        rr = 1;
        if ((active[0] & 0x80) && !rh) rh = 1;
        else { ++rc; if (active[0] & 0x80) rh = 0; }
    }
    status(!terminal && !deleted ? 0x80 : 0, deleted ? 0x40 : 0, rc, rh, rr, 2, sector.head);
}

void FloppyController::formatReady(double now) {
    // FORMAT TRACK(0D) 收到的是每扇区四字节 C/H/R/N 表，不是扇区内容。
    auto* image = activeDisk(); unsigned head = (active[1] >> 2) & 1, drive = active[1] & 3;
    if (image->readOnly) { status(2, 0, cylinder[drive], uint8_t(head), 1, active[2]); return; }
    if (!(active[0] & 0x40) || active[2] != 2 || !active[3] || active[3] > image->spt
        || head >= unsigned(image->heads) || cylinder[drive] >= image->cylinders) {
        status(4, 0, cylinder[drive], uint8_t(head), 1, active[2]); return;
    }
    buffer.resize(unsigned(active[3]) * 4); position = 0;
    if (specify[1] & 1) { phase = Phase::Write; irq(true); return; }
    if (!(dor & 8)) { schedule(Action::Format, now); return; }
    if (!dma) throw std::runtime_error("Floppy DMA channel is not connected");
    auto transfer = dma(buffer.data(), unsigned(buffer.size()), DmaDirection::FromMemory);
    if (transfer.error || (transfer.bytes && transfer.bytes != buffer.size())) { status(0x10, 0, cylinder[drive], uint8_t(head), 1, 2); return; }
    if (!transfer.bytes) { schedule(Action::Format, now); return; }
    formatDone();
}

void FloppyController::formatDone() {
    // 先验证整张 ID 表再写入，填充值由命令指定；任一非法 ID 都不能留下部分格式化。
    auto* image = activeDisk(); unsigned drive = active[1] & 3, head = (active[1] >> 2) & 1;
    if (!image) { status(4, 0, cylinder[drive], uint8_t(head), 1, 2); return; }
    for (unsigned i = 0; i < buffer.size(); i += 4) {
        if (buffer[i] != cylinder[drive] || buffer[i + 1] != head || !buffer[i + 2]
            || buffer[i + 2] > image->spt || buffer[i + 3] != 2) {
            status(4, buffer[i] != cylinder[drive] ? 0x10 : 0, buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]); return;
        }
    }
    std::array<uint8_t, 512> fill{}; fill.fill(active[5]);
    for (unsigned i = 0; i < buffer.size(); i += 4) {
        auto lba = uint32_t((cylinder[drive] * image->heads + head) * image->spt + buffer[i + 2] - 1);
        if (!image->write(lba, fill.data())) { status(2, 0, cylinder[drive], uint8_t(head), buffer[i + 2], 2); return; }
        dirty = true;
    }
    auto last = buffer[buffer.size() - 2];
    status(0, 0, cylinder[drive], uint8_t(head), last, 2);
}
}
