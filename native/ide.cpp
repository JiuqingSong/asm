#include "ide.h"
#include "pc.h"
#include <algorithm>
#include <array>
#include <string>

namespace asm86 {
Disk* IdeChannel::selected() const { return !(device & 0x10) && disk ? disk() : nullptr; }
void IdeChannel::signal() { if (interrupt) interrupt(irqPending && !(control & 6)); }
void IdeChannel::irq(bool value) { irqPending = value; signal(); }
void IdeChannel::reset() {
    phase = Phase::Idle; nextEvent = std::numeric_limits<double>::infinity();
    features = cylinderLow = cylinderHigh = control = multiple = pendingError = 0;
    count = sector = error = 1; device = 0xa0; status = 0x50;
    logicalHeads = logicalSpt = position = remaining = blockCount = 0;
    blockSize = 1; writeCache = true; buffer.clear(); irq(false);
}
void IdeChannel::afterBusy(Action next, double now, uint8_t failure) {
    phase = Phase::Idle; status = 0x80; action = next; pendingError = failure; nextEvent = now + 120;
}
void IdeChannel::advance(double now) {
    if (now < nextEvent) return;
    nextEvent = std::numeric_limits<double>::infinity();
    if (action == Action::Reset) { status = 0x50; error = 1; return; }
    if (action == Action::Input) { phase = Phase::Input; position = 0; status = 0x58; }
    else if (action == Action::Write) expectWrite();
    else {
        if (pendingError) error = pendingError;
        status = uint8_t(0x50 | (pendingError ? 1 : 0));
    }
    irq(true);
}
uint8_t IdeChannel::input(uint16_t port, double now) {
    if (port == 0x1f0) return uint8_t(readWord(now));
    if (port == 0x1f6) return device;
    if (!selected()) return 0;
    switch (port) {
    case 0x1f1: return error;
    case 0x1f2: return count;
    case 0x1f3: return sector;
    case 0x1f4: return cylinderLow;
    case 0x1f5: return cylinderHigh;
    case 0x1f7: irq(false); return status;
    case 0x3f6: return status;
    default: return 255;
    }
}
void IdeChannel::output(uint16_t port, uint8_t value, double now) {
    if (port == 0x3f6) {
        auto old = control;
        if (value & 4) { reset(); status = 0x80; }
        else if (old & 4) { reset(); afterBusy(Action::Reset, now); }
        control = value & 14; signal(); return;
    }
    if (control & 4) return;
    switch (port) {
    case 0x1f0: writeWord(value, now); break;
    case 0x1f1: features = value; break;
    case 0x1f2: count = value; break;
    case 0x1f3: sector = value; break;
    case 0x1f4: cylinderLow = value; break;
    case 0x1f5: cylinderHigh = value; break;
    case 0x1f6: device = value | 0xa0; break;
    case 0x1f7: command(value, now); break;
    }
}
uint16_t IdeChannel::readWord(double now) {
    if (!selected() || phase != Phase::Input) return 0xffff;
    auto value = uint16_t(buffer[position] | (uint16_t(buffer[position + 1]) << 8));
    position += 2;
    if (position == buffer.size()) consumed(now);
    return value;
}
void IdeChannel::writeWord(uint16_t value, double now) {
    if (!selected() || phase != Phase::Output) return;
    buffer[position++] = uint8_t(value); buffer[position++] = uint8_t(value >> 8);
    if (position == buffer.size()) writeBlock(now);
}
bool IdeChannel::address(const Disk& drive, uint32_t& result) const {
    if (device & 0x40) result = (uint32_t(device & 15) << 24) | (uint32_t(cylinderHigh) << 16) | (uint32_t(cylinderLow) << 8) | sector;
    else {
        unsigned heads = logicalHeads ? logicalHeads : unsigned(drive.heads), spt = logicalSpt ? logicalSpt : unsigned(drive.spt);
        unsigned head = device & 15;
        if (head >= heads || !sector || sector > spt) return false;
        result = (((unsigned(cylinderHigh) << 8) | cylinderLow) * heads + head) * spt + sector - 1;
    }
    return result < drive.sectors;
}
void IdeChannel::setAddress(const Disk& drive, uint32_t value) {
    if (device & 0x40) {
        sector = uint8_t(value); cylinderLow = uint8_t(value >> 8); cylinderHigh = uint8_t(value >> 16);
        device = uint8_t((device & 0xf0) | ((value >> 24) & 15));
    } else {
        unsigned heads = logicalHeads ? logicalHeads : unsigned(drive.heads), spt = logicalSpt ? logicalSpt : unsigned(drive.spt);
        sector = uint8_t(value % spt + 1); value /= spt;
        device = uint8_t((device & 0xf0) | (value % heads)); value /= heads;
        cylinderLow = uint8_t(value); cylinderHigh = uint8_t(value >> 8);
    }
}
void IdeChannel::command(uint8_t value, double now) {
    auto* drive = selected();
    if (!drive || (status & 0x80)) return;
    irq(false); error = 0; remaining = 0; phase = Phase::Idle;
    nextEvent = std::numeric_limits<double>::infinity();
    switch (value) {
    case 0xec: identify(*drive, now); return;
    case 0x20: case 0x21: case 0x30: case 0x31: case 0xc4: case 0xc5: case 0x40: case 0x41: {
        bool writing = value == 0x30 || value == 0x31 || value == 0xc5;
        bool multi = value == 0xc4 || value == 0xc5;
        if ((writing && drive->readOnly) || (multi && !multiple)) { afterBusy(Action::Done, now, 4); return; }
        unsigned total = count ? count : 256;
        if (!address(*drive, lba) || total > drive->sectors - lba) { afterBusy(Action::Done, now, 0x10); return; }
        remaining = total; blockSize = multi ? multiple : 1;
        if (value == 0x40 || value == 0x41) {
            std::array<uint8_t, 512> verified{};
            for (unsigned i = 0; i < total; ++i)
                if (!drive->read(lba + i, verified.data())) { afterBusy(Action::Done, now, 0x10); return; }
            setAddress(*drive, lba + total - 1); count = 0; remaining = 0; afterBusy(Action::Done, now);
        } else if (writing) expectWrite();
        else readBlock(now);
        return;
    }
    case 0xc6:
        if (count > 16 || (count && (count & (count - 1)))) { afterBusy(Action::Done, now, 4); return; }
        multiple = count; break;
    case 0x91:
        if (!count || count > 63) { afterBusy(Action::Done, now, 4); return; }
        logicalHeads = (device & 15) + 1; logicalSpt = count; break;
    case 0x90: {
        auto savedControl = control; reset(); control = savedControl; error = 1; break;
    }
    case 0xef:
        if (features == 2) writeCache = true;
        else if (features == 0x82) { drive->flush(); writeCache = false; }
        else if (!(features == 3 && (count <= 1 || (count >= 8 && count <= 10)))) {
            afterBusy(Action::Done, now, 4); return;
        }
        break;
    case 0xe7: drive->flush(); break;
    case 0xe5: count = 0xff; break;
    default:
        if ((value & 0xf0) != 0x10 && (value & 0xf0) != 0x70) { afterBusy(Action::Done, now, 4); return; }
        if ((value & 0xf0) == 0x70 && !address(*drive, lba)) { afterBusy(Action::Done, now, 0x10); return; }
        break;
    }
    afterBusy(Action::Done, now);
}
void IdeChannel::identify(const Disk& drive, double now) {
    std::array<uint16_t, 256> words{};
    auto text = [&](unsigned first, unsigned length, std::string value) {
        value.resize(length * 2, ' ');
        for (unsigned i = 0; i < length; ++i) words[first + i] = uint16_t((uint16_t(uint8_t(value[i * 2])) << 8) | uint8_t(value[i * 2 + 1]));
    };
    words[0] = 0x40; words[1] = uint16_t(drive.cylinders); words[3] = uint16_t(drive.heads); words[6] = uint16_t(drive.spt);
    text(10, 10, "ASM86NATIVE0001"); text(23, 4, "1.0"); text(27, 20, "ASMPERFECT NATIVE IDE HARD DISK");
    words[47] = 0x8010; words[49] = 0x200; words[51] = 0x200; words[53] = 1;
    words[55] = uint16_t(logicalHeads ? logicalHeads : unsigned(drive.heads));
    words[56] = uint16_t(logicalSpt ? logicalSpt : unsigned(drive.spt));
    words[54] = uint16_t(std::min(65535u, drive.sectors / (unsigned(words[55]) * words[56])));
    auto capacity = uint32_t(words[54]) * words[55] * words[56];
    words[57] = uint16_t(capacity); words[58] = uint16_t(capacity >> 16);
    words[59] = multiple ? uint16_t(0x100 | multiple) : 0;
    words[60] = uint16_t(drive.sectors); words[61] = uint16_t(drive.sectors >> 16);
    words[80] = 0x1e; words[82] = 0x20; words[83] = 0x5000;
    words[85] = writeCache ? 0x20 : 0; words[86] = 0x5000;
    buffer.resize(512);
    for (unsigned i = 0; i < 256; ++i) { buffer[i * 2] = uint8_t(words[i]); buffer[i * 2 + 1] = uint8_t(words[i] >> 8); }
    blockCount = 0; afterBusy(Action::Input, now);
}
void IdeChannel::readBlock(double now) {
    auto* drive = disk ? disk() : nullptr;
    if (!drive) { afterBusy(Action::Done, now, 4); return; }
    blockCount = std::min(blockSize, remaining); buffer.resize(blockCount * 512);
    for (unsigned i = 0; i < blockCount; ++i)
        if (!drive->read(lba + i, buffer.data() + i * 512)) { afterBusy(Action::Done, now, 0x10); return; }
    setAddress(*drive, lba + blockCount - 1); afterBusy(Action::Input, now);
}
void IdeChannel::expectWrite() {
    blockCount = std::min(blockSize, remaining); buffer.assign(blockCount * 512, 0);
    position = 0; phase = Phase::Output; status = 0x58;
}
void IdeChannel::writeBlock(double now) {
    auto* drive = disk ? disk() : nullptr;
    if (!drive || drive->readOnly) { afterBusy(Action::Done, now, 4); return; }
    for (unsigned i = 0; i < blockCount; ++i)
        if (!drive->write(lba + i, buffer.data() + i * 512)) { afterBusy(Action::Done, now, 0x10); return; }
    if (!writeCache) drive->flush();
    setAddress(*drive, lba + blockCount - 1);
    lba += blockCount; remaining -= blockCount; count = uint8_t(remaining);
    afterBusy(remaining ? Action::Write : Action::Done, now);
}
void IdeChannel::consumed(double now) {
    if (remaining) {
        lba += blockCount; remaining -= blockCount; count = uint8_t(remaining);
        if (remaining) { readBlock(now); return; }
    }
    phase = Phase::Idle; status = 0x50;
}
}
