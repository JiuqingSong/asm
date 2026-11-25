#include "pc.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace asm86 {
void Pc::resetAt() {
    pic[0].reset(8, !at()); pic[1].reset(0x70, false);
    ide.reset();
    cdrom.reset();
    controller.clear(); kbdCommand = 0x45; kbdOutput = 1; kbdWrite = fastA20 = cmosIndex = 0;
    keyboardLatch = 0; keyboardRead = false;
    pendingReset = false; cpu.a20 = false;
    cmos.fill(0); cmos[0x0a] = 0x26; cmos[0x0b] = 2; cmos[0x0d] = 128;
    cmos[0x10] = floppy ? uint8_t(floppy->floppyType << 4) : 0;
    cmos[0x12] = hard ? 0xf0 : 0; cmos[0x14] = uint8_t(0x20 | (floppy ? 1 : 0));
    cmos[0x15] = 0x80; cmos[0x16] = 2; cmos[0x18] = cmos[0x31] = at() ? 0x3c : 0;
    rtcEpoch = std::time(nullptr); nextRtc = std::numeric_limits<double>::infinity();
}
void Pc::keyboardIrq() {
    if ((!at() || ((kbdCommand & 0x11) == 1)) && (!controller.empty() || !keys.empty())) pic[0].raise(1);
}
void Pc::keyboardCommand(uint8_t value) {
    switch (value) {
    case 0x20: controller.push_back(kbdCommand); break;
    case 0x60: case 0xd1: kbdWrite = value; break;
    case 0xaa: kbdCommand |= 4; controller.push_back(0x55); break;
    case 0xab: controller.push_back(0); break;
    case 0xad: kbdCommand |= 16; break;
    case 0xae: kbdCommand &= ~16; break;
    case 0xa7: kbdCommand |= 32; break;
    case 0xa8: kbdCommand &= ~32; break;
    case 0xa9: controller.push_back(1); break;
    case 0xd0: controller.push_back(kbdOutput); break;
    case 0xc0: controller.push_back(0x40); break;
    case 0xdd: cpu.a20 = false; kbdOutput &= ~2; fastA20 &= ~2; break;
    case 0xdf: cpu.a20 = true; kbdOutput |= 2; fastA20 |= 2; break;
    default:
        if (value >= 0xf0) { if (!(value & 1)) pendingReset = true; }
        else throw std::runtime_error("Unsupported 8042 controller command " + std::to_string(value));
    }
    keyboardIrq();
}
void Pc::keyboardData(uint8_t value) {
    if (kbdWrite == 0xd1) {
        kbdOutput = value; cpu.a20 = value & 2; fastA20 = uint8_t((fastA20 & ~2) | (value & 2));
        if (!(value & 1)) pendingReset = true;
        kbdWrite = 0;
    } else if (kbdWrite == 0x60) { kbdCommand = value; kbdWrite = 0; }
    else if (kbdWrite) { kbdWrite = 0; controller.push_back(0xfa); }
    else {
        switch (value) {
        case 0xed: case 0xf0: case 0xf3: kbdWrite = value; controller.push_back(0xfa); break;
        case 0xf2: controller.push_back(0xfa); controller.push_back(0xab); controller.push_back(0x83); break;
        case 0xff: controller.push_back(0xfa); controller.push_back(0xaa); break;
        case 0xf4: case 0xf5: case 0xf6: controller.push_back(0xfa); break;
        case 0xee: controller.push_back(0xee); break;
        default: controller.push_back(0xfe); break;
        }
    }
    keyboardIrq();
}
void Pc::resetCpu() {
    pendingReset = false; auto code = cmos[15]; cmos[15] = 0;
    if (code != 5 && code != 9 && code != 10) { rebootRequested = true; return; }
    auto regs = cpu.r; auto selectors = cpu.s;
    cpu.reset(); cpu.r = regs;
    for (auto seg : {ES, SS, DS}) cpu.loadSegment(seg, selectors[seg]);
    if (code == 5) pic[0].command(0x20);
    auto off = cpu.rw(0x40, 0x67), seg = cpu.rw(0x40, 0x69);
    if (code == 9) {
        cpu.loadSegment(SS, seg); cpu.r[SP] = off;
        cpu.loadSegment(DS, cpu.pop()); cpu.loadSegment(ES, cpu.pop());
        for (int i = 7; i >= 0; --i) { auto value = cpu.pop(); if (i != SP) cpu.r[i] = value; }
        cpu.ip = cpu.pop(); cpu.loadSegment(CS, cpu.pop()); cpu.setFlags(cpu.pop());
    } else { cpu.ip = off; cpu.loadSegment(CS, seg); }
}
double Pc::rtcPeriod() const {
    unsigned rate = cmos[10] & 15;
    if (!at() || !(cmos[11] & 0x40) || !rate) return std::numeric_limits<double>::infinity();
    if (rate < 3) rate += 7;
    return 1193182.0 / (32768u >> (rate - 1));
}
void Pc::rtcSchedule() { nextRtc = clock + rtcPeriod(); }
void Pc::rtcAdvance() {
    cmos[12] |= 0xc0; pic[1].raise(0);
    auto period = rtcPeriod();
    nextRtc += period * (1 + std::floor((clock - nextRtc) / period));
}
uint8_t Pc::cmosRead() {
    auto current = rtcEpoch + std::time_t(clock / 1193182.0); std::tm t{}; localtime_s(&t, &current);
    auto encode = [&](int v) { return uint8_t(cmos[11] & 4 ? v : ((v / 10) << 4) | (v % 10)); };
    switch (cmosIndex) {
    case 0: return encode(t.tm_sec);
    case 2: return encode(t.tm_min);
    case 4: return cmos[11] & 2 ? encode(t.tm_hour) : uint8_t(encode(t.tm_hour % 12 ? t.tm_hour % 12 : 12) | (t.tm_hour >= 12 ? 128 : 0));
    case 6: return encode(t.tm_wday + 1);
    case 7: return encode(t.tm_mday);
    case 8: return encode(t.tm_mon + 1);
    case 9: return encode((t.tm_year + 1900) % 100);
    case 0x32: return encode((t.tm_year + 1900) / 100);
    case 12: { auto value = cmos[12]; cmos[12] = 0; return value; }
    default: return cmos[cmosIndex];
    }
}
void Pc::cmosWrite(uint8_t value) {
    cmos[cmosIndex] = value;
    if (cmosIndex == 10 || cmosIndex == 11) rtcSchedule();
}
}
