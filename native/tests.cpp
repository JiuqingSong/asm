#include "pc.h"
#include "display.h"
#include "preferences.h"
#include "timing.h"
#include "softfloat.h"
#include "image.h"
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

using namespace asm86;
namespace {
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void preferenceTests() {
    auto key = L"Software\\Asm86NativeTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    auto cleanup = [&]() {
        auto status = RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str());
        if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND)
            throw std::runtime_error("Cannot remove test preferences (Windows error " + std::to_string(status) + ")");
    };
    try {
        auto path = std::filesystem::path(L"Disk \u4e00 with spaces.img");
        {
            Preferences prefs(key.c_str());
            check(prefs.cpu() == CpuModel::I8088 && !prefs.fullSpeed() && prefs.floppy().empty(),
                "First launch must retain the default CPU, speed and empty floppy");
            prefs.cpu(CpuModel::I286); prefs.fullSpeed(true); prefs.floppy(path);
        }
        {
            Preferences prefs(key.c_str());
            check(prefs.cpu() == CpuModel::I286 && prefs.fullSpeed() && prefs.floppy() == std::filesystem::absolute(path),
                "CPU, speed and Unicode floppy path must survive reopening preferences");
            prefs.cpu(CpuModel::I386);
        }
        {
            Preferences prefs(key.c_str());
            check(prefs.cpu() == CpuModel::I386 && prefs.fullSpeed() && prefs.floppy() == std::filesystem::absolute(path),
                "Experimental 386 selection must persist without changing speed or floppy preferences");
            prefs.cpu(CpuModel::I486);
        }
        {
            Preferences prefs(key.c_str());
            check(prefs.cpu() == CpuModel::I486 && prefs.fullSpeed() && prefs.floppy() == std::filesystem::absolute(path),
                "Experimental 486 selection must survive reopening without changing other preferences");
            prefs.cpu(CpuModel::I8088); prefs.fullSpeed(false); prefs.floppy({});
        }
        {
            Preferences prefs(key.c_str());
            check(prefs.cpu() == CpuModel::I8088 && !prefs.fullSpeed() && prefs.floppy().empty(),
                "Switching back to 8088/normal speed and ejecting must persist");
            DWORD invalidCpu = 123;
            check(RegSetKeyValueW(HKEY_CURRENT_USER, key.c_str(), L"Cpu", REG_DWORD, &invalidCpu, sizeof(invalidCpu)) == ERROR_SUCCESS,
                "Cannot prepare malformed preference test");
            bool rejected = false;
            try { prefs.cpu(); } catch (const std::runtime_error&) { rejected = true; }
            check(rejected, "Invalid saved CPU must report an error instead of silently selecting a CPU");
            prefs.cpu(CpuModel::I286);
            const wchar_t invalidSpeed[] = L"full";
            check(RegSetKeyValueW(HKEY_CURRENT_USER, key.c_str(), L"FullSpeed", REG_SZ, invalidSpeed, sizeof(invalidSpeed)) == ERROR_SUCCESS,
                "Cannot prepare preference type test");
            rejected = false;
            try { prefs.fullSpeed(); } catch (const std::runtime_error&) { rejected = true; }
            check(rejected, "Malformed saved speed must report an error");
        }
    } catch (...) {
        try { cleanup(); } catch (const std::exception& e) { std::cerr << e.what() << '\n'; }
        throw;
    }
    cleanup();
}
void timingTests() {
    for (auto model : {CpuModel::I8088, CpuModel::I286, CpuModel::I386, CpuModel::I486}) for (bool full : {false, true}) {
        Pc p; p.setModel(model);
        auto& c = p.cpu;
        c.loadSegment(CS, 0); c.ip = 0x500; c.setFlags(2);
        c.mem[0x500] = 0xeb; c.mem[0x501] = 0xfe;
        c.out(0x21, p.at() ? 0xfa : 0xfe);
        unsigned startSecond = 0;
        if (p.at()) {
            c.out(0xa1, 0xfe); c.out(0x70, 11); c.out(0x71, 0x46);
            c.out(0x70, 0); startSecond = c.in(0x71);
        }
        c.out(0x3fb, 0x80); c.out(0x3f8, 96); c.out(0x3f9, 0);
        c.out(0x3fb, 2); c.out(0x3fc, 3);
        ExecutionTiming timing;
        ExecutionTiming::HostClock::time_point origin{};
        timing.reset(p, origin);
        unsigned pitTicks = 0, rtcTicks = 0;
        std::vector<uint8_t> mouseBytes;
        auto collect = [&]() {
            for (int irq; (irq = c.irq()) >= 0;) {
                if (irq == 8) ++pitTicks;
                else {
                    check(irq == 0x70, "Unexpected interrupt during real-time device test");
                    ++rtcTicks; c.out(0x70, 12); c.in(0x71); c.out(0xa0, 0x20);
                }
                c.out(0x20, 0x20);
            }
            auto status = c.in(0x3fd);
            check(!(status & 2), "Real-time mouse bytes must not overrun the UART");
            if (status & 1) mouseBytes.push_back(c.in(0x3f8));
        };
        for (unsigned frame = 1; frame <= 50; ++frame) {
            if (frame == 20 || frame == 30) p.serialMouse.motion(0, 0, 1, p.clock);
            if (frame == 25 || frame == 35) p.serialMouse.motion(0, 0, 0, p.clock);
            auto now = origin + std::chrono::milliseconds(frame * 20);
            do { timing.advance(p, full, now); collect(); } while (p.clock < timing.target(now));
        }
        auto end = origin + std::chrono::seconds(1);
        while (p.clock < timing.target(end)) { timing.advance(p, full, end); collect(); }
        check(p.clock == ExecutionTiming::PitHz && pitTicks == 18, "One host second must produce one device second and 18 BIOS timer IRQs");
        check(rtcTicks == (p.at() ? 1024u : 0u), "RTC must retain 1024 Hz without accumulating scheduling jitter");
        if (p.at()) {
            c.out(0x70, 0);
            check(c.in(0x71) == (startSecond + 1) % 60, "RTC calendar must advance one second at every CPU speed");
        }
        check(mouseBytes.size() == 13 && mouseBytes[0] == 'M'
            && mouseBytes[1] == 0x60 && mouseBytes[4] == 0x40 && mouseBytes[7] == 0x60 && mouseBytes[10] == 0x40,
            "Both human-paced clicks must traverse the real 1200-baud mouse transport");
        if (!full) check(std::abs(double(p.instructions) - ExecutionTiming::normalRate(model)) <= 1,
            "Normal-speed instruction budget must match the selected CPU model");
        auto before = p.instructions;
        for (unsigned i = 0; i < 1000; ++i) timing.advance(p, true, end);
        check(p.instructions == before + 1024000 && p.clock == ExecutionTiming::PitHz,
            "Full-speed CPU work must not advance device time without elapsed host time");
        before = p.instructions;
        timing.advance(p, false, end);
        check(p.instructions == before && p.clock == ExecutionTiming::PitHz, "Speed toggles must not introduce a clock jump or CPU credit burst");
    }
    Pc idle; idle.setModel(CpuModel::I8088);
    idle.cpu.loadSegment(CS, 0); idle.cpu.ip = 0x500; idle.cpu.mem[0x500] = 0xf4;
    idle.runCpu(100000);
    check(idle.cpu.halted && idle.instructions == 1 && idle.clock == 0, "A halted CPU must yield without accelerating time or banking instructions");
    std::cout << "Real-time CPU rates / PIT / RTC / UART / speed-toggle checks passed\n";
}
void cpu386Tests(CpuModel model) {
    auto real = [&]() {
        Cpu c; c.setModel(model); c.a20 = true;
        for (auto seg : {ES, CS, SS, DS, FS, GS}) c.loadSegment(seg, 0);
        c.r[SP] = 0x8000; c.ip = 0x500; c.setFlags(2); return c;
    };
    auto run = [](Cpu& c, const std::vector<uint8_t>& code, uint32_t at = 0x500) {
        std::copy(code.begin(), code.end(), c.mem.begin() + at); c.ip = at; c.halted = false;
        for (unsigned i = 0; i < 1000 && !c.halted; ++i) c.step();
        check(c.halted, "386 test program did not halt");
    };
    {
        auto c = real();
        c.r32(AX, 0x240002);
        run(c, {0x66,0x50,0x66,0x9d,0x66,0x9c,0x66,0x5b,0xf4});
        check(c.r32(BX) == (model == CpuModel::I486 ? 0x240002u : 2u),
            "PUSHFD/POPFD must distinguish 486 AC/ID flags from reserved 386 bits");
        c.setEflags(2); c.r[SP] = 0x8000;
        c.writeDword(0x8000, 0x700); c.writeDword(0x8004, 0); c.writeDword(0x8008, 0x240002); c.mem[0x700] = 0xf4;
        run(c, {0x66,0xcf});
        check(c.eflags() == (model == CpuModel::I486 ? 0x240002u : 2u),
            "Real-mode IRETD must restore supported AC/ID flags without exposing them on a 386");
    }
    for (auto op : {0xb2, 0xb4, 0xb5}) {
        auto c = real(); c.writeWord(0x4000, 0x1234); c.writeWord(0x4002, 0x2000);
        run(c, {0x0f, uint8_t(op), 0x06,0,0x40,0xf4});
        check(c.r[AX] == 0x1234 && c.s[op == 0xb2 ? SS : op == 0xb4 ? FS : GS] == 0x2000,
            "LSS/LFS/LGS must load the offset and segment of a real-mode far pointer");
    }
    {
        auto c = real(); c.writeDword(0x4000, 0x12345678); c.writeWord(0x4004, 0x2000);
        const uint8_t code[] = {0x66,0x0f,0xb2,0x26,0,0x40,0x90};
        std::copy(std::begin(code), std::end(code), c.mem.begin() + c.ip);
        c.setFlags(IF | 2); c.step();
        check(c.r32(SP) == 0x12345678 && c.s[SS] == 0x2000, "Dword LSS must load the full ESP and stack segment");
        c.writeWord(0x80, 0x700); c.writeWord(0x82, 0); c.irq = []() { return 0x20; };
        c.step(); check(c.ip == 0x507, "LSS must suppress a pending interrupt for the following instruction");
        c.step(); check(c.ip == 0x700, "LSS must allow the pending interrupt after the following instruction");
        auto invalid = real(); invalid.r[AX] = 0x5678; invalid.onFault = [](CpuFault f, uint32_t) { throw f; };
        bool rejected = false;
        try { run(invalid, {0x0f,0xb2,0xc0}); } catch (const CpuFault& fault) { rejected = fault.vector == 6; }
        check(rejected && invalid.r[AX] == 0x5678 && invalid.s[SS] == 0,
            "LSS with a register source must fault without changing its destination or stack segment");
    }
    if (model == CpuModel::I486) {
        auto c = real(); c.r32(AX, 0x12345678);
        run(c, {0x0f,0xc8,0xf4});
        check(c.r32(AX) == 0x78563412, "486 BSWAP must exchange all four bytes regardless of the default operand size");
        c.r32(AX, 0x7fffffff); c.r32(CX, 1);
        run(c, {0x66,0x0f,0xc1,0xc8,0xf4});
        check(c.r32(AX) == 0x80000000 && c.r32(CX) == 0x7fffffff && (c.flags & (OF|SF|CF|ZF)) == (OF|SF),
            "Dword XADD must exchange the source and compute signed-overflow flags");
        c.r32(AX, 0x1234ff80);
        run(c, {0x0f,0xc0,0xc0,0xf4});
        check(c.r32(AX) == 0x1234ff00 && (c.flags & (OF|CF|ZF)) == (OF|CF|ZF),
            "XADD with the same byte register must leave the sum, preserving the rest of EAX");
        c.r[AX] = 0x7fff; c.r[CX] = 1;
        run(c, {0x0f,0xc1,0xc8,0xf4});
        check(c.r[AX] == 0x8000 && c.r[CX] == 0x7fff && (c.flags & OF), "Word XADD must honor 16-bit operands");
        c.r32(AX, 0x12345678); c.r32(CX, 0xabcdef01); c.writeDword(0x2000, 0x12345678);
        run(c, {0x66,0x0f,0xb1,0x0e,0,0x20,0xf4});
        check(c.readDword(0x2000) == 0xabcdef01 && c.r32(AX) == 0x12345678 && (c.flags & ZF),
            "Successful CMPXCHG must store the source without changing the accumulator");
        unsigned writes = 0; c.onWrite = [&](uint32_t address) { if (address == 0x2000) ++writes; };
        run(c, {0x66,0x0f,0xb1,0x0e,0,0x20,0xf4});
        check(c.r32(AX) == 0xabcdef01 && c.readDword(0x2000) == 0xabcdef01 && !(c.flags & ZF) && writes == 1,
            "Failed CMPXCHG must load the accumulator and still perform a destination write cycle");
        c.r[AX] = 7; c.r[BX] = 8; c.r[CX] = 9;
        run(c, {0x0f,0xb0,0xcb,0xf4});
        check(c.reg8(0) == 8 && c.reg8(3) == 8 && !(c.flags & ZF), "Byte CMPXCHG must compare AL and preserve a mismatched destination");
        c.onWrite = {}; c.r32(AX, 0);
        run(c, {0x0f,0xa2,0xf4});
        check(c.r32(AX) == 1 && c.r32(BX) == 0x756e6547 && c.r32(DX) == 0x49656e69 && c.r32(CX) == 0x6c65746e,
            "486 CPUID leaf zero must identify GenuineIntel and the supported leaf range");
        c.r32(AX, 1); run(c, {0x0f,0xa2,0xf4});
        check(c.r32(AX) == 0x450 && !c.r32(DX) && !c.r32(CX),
            "486 CPUID must not advertise an x87 or other unavailable instruction-set extensions");
        c.r32(AX, 0xffffffff); run(c, {0x0f,0xa2,0xf4});
        check(!c.r32(AX) && !c.r32(BX) && !c.r32(CX) && !c.r32(DX), "Unsupported CPUID leaves must return no features");
        c.r32(AX, 0x2000); unsigned reads = 0;
        c.mmioStart = 0x2000; c.mmioEnd = 0x3000; c.mmioRead = [&](uint32_t) { ++reads; return uint8_t(0); };
        run(c, {0x67,0x0f,1,0x38,0x0f,8,0x0f,9,0xf4});
        check(reads == 0, "INVLPG and cache invalidation must not read or write the memory operand");
        c.mmioRead = {}; c.mmioStart = c.mmioEnd = 0;
        c.r32(AX, 0x50030); run(c, {0x0f,0x22,0xc0,0x0f,0x20,0xc3,0xf4});
        check(c.r32(BX) == 0x50030, "486 MOV CR0 must preserve AM, WP and NE");
        c.r32(AX, 0x12345018); run(c, {0x0f,0x22,0xd8,0x0f,0x20,0xd9,0xf4});
        check(c.r32(CX) == 0x12345018, "486 CR3 must preserve page-directory cache-control bits");
        c.r32(CX, 2); c.writeDword(0x2000, 3);
        run(c, {0xf0,0x66,0x0f,0xc1,0x0e,0,0x20,0xf4});
        check(c.readDword(0x2000) == 5 && c.r32(CX) == 3, "LOCK XADD must accept a memory destination");
        for (const auto& code : {std::vector<uint8_t>{0xf0,0x0f,0xc8}, {0xf0,0x0f,0xa2},
            {0xf0,0x0f,0xc1,0xc0}, {0xf0,0x0f,0xb1,0xc0}, {0xf0,0x0f,1,0x3e,0,0x20}}) {
            auto invalid = real(); invalid.ww(0, 24, 0x700); invalid.ww(0, 26, 0); invalid.mem[0x700] = 0xf4;
            run(invalid, code);
            check(invalid.ip == 0x701 && invalid.rwS(SS, invalid.r[SP]) == 0x500,
                "486 instructions must reject LOCK on register destinations and non-lockable operations");
        }
    } else {
        for (const auto& code : {std::vector<uint8_t>{0x0f,0xc8}, {0x0f,0xc1,0xc0}, {0x0f,0xb1,0xc0},
            {0x0f,0xa2}, {0x0f,8}, {0x0f,9}, {0x0f,1,0x3e,0,0x20}}) {
            auto c = real(); c.ww(0, 24, 0x700); c.ww(0, 26, 0); c.mem[0x700] = 0xf4;
            run(c, code);
            check(c.ip == 0x701 && c.rwS(SS, c.r[SP]) == 0x500, "486-only opcodes must remain #UD on a 386");
        }
    }
    {
        auto c = real();
        run(c, {0x66,0xb8,0xff,0xff,0xff,0x7f, 0x66,0x05,1,0,0,0,
            0x66,0x9c, 0x66,0x5b, 0xb8,0xef,0xbe, 0xb4,0x12, 0xf4});
        check(c.r32(AX) == 0x800012ef && c.r[AX] == 0x12ef,
            "32/16/8-bit register writes must alias without destroying the upper half");
        check((c.r32(BX) & (OF|SF|ZF|CF)) == (OF|SF) && c.r[SP] == 0x8000,
            "32-bit overflow flags and PUSHFD/POP with a 16-bit stack");
        run(c, {0x66,0x66,0xb8,0x78,0x56,0x34,0x12,0xe9,0,0,0xf4});
        check(c.r32(AX) == 0x12345678, "Repeated operand-size prefixes must not cancel each other");
        c.r32(AX, 0x80000000);
        run(c, {0x66,0xc1,0xe0,1,0xf4});
        check(c.r32(AX) == 0 && (c.flags & (CF|ZF|OF)) == (CF|ZF|OF), "32-bit shift flags");
        c.r32(AX, 0x80000000); c.r32(CX, 0xffffffff); c.r32(DX, 0xffffffff);
        c.ww(0, 0, 0x700); c.ww(0, 2, 0); c.mem[0x700] = 0xf4;
        run(c, {0x66,0xf7,0xf9});
        check(c.r32(AX) == 0x80000000 && c.r32(DX) == 0xffffffff && c.rwS(SS, c.r[SP]) == 0x500,
            "IDIV overflow must fault at its prefix without corrupting EDX:EAX");
    }
    {
        auto c = real(); c.r32(AX, 0x12345678);
        run(c, {0x0f,0x23,0xc0, 0x66,0x0f,0x21,0xc3, 0x0f,0x21,0xf1, 0x0f,0x21,0xfa, 0xf4});
        check(c.r32(BX) == 0x12345678 && c.r32(CX) == 0xffff0ff0 && c.r32(DX) == 0x400,
            "MOV DR must always transfer 32 bits and expose reset DR6/DR7 values");
        c.r32(AX, 0); run(c, {0x0f,0x23,0xf0, 0x0f,0x21,0xf1, 0xf4});
        check(c.r32(CX) == 0xffff0ff0, "Clearing DR6 must preserve its reserved bits");
        c.ww(0, 4, 0x700); c.ww(0, 6, 0);
        const uint8_t handler[] = {0x0f,0x21,0xf1,0xcf};
        std::copy(std::begin(handler), std::end(handler), c.mem.begin() + 0x700);
        c.r32(AX, 0x2400); run(c, {0x0f,0x23,0xf8, 0xf4});
        c.r32(AX, 0x87654321); run(c, {0x0f,0x23,0xc0, 0x0f,0x21,0xc3, 0xf4});
        check((c.r32(CX) & 0x2000) && c.r32(BX) == 0x87654321 && c.rw(0, 0x7ffa) == 0x500,
            "DR7 general detect must report DR6.BD, fault before MOV DR, clear GD and allow IRET to retry");
        c.r32(AX, 0); run(c, {0x0f,0x23,0xf0, 0xf4});
        c.mem[0x703] = 0xf4; c.setFlags(TF | 2);
        run(c, {0x90});
        check((c.r32(CX) & 0x4000) && !(c.r32(CX) & 0x2000),
            "A single-step debug exception must set DR6.BS rather than leave a cleared status register");
    }
    {
        auto c = real(); c.r32(AX, 0x10000);
        c.ww(0, 13 * 4, 0x700); c.ww(0, 13 * 4 + 2, 0); c.mem[0x700] = 0xf4;
        run(c, {0x66,0xff,0xe0});
        check(c.rwS(SS, c.r[SP]) == 0x500, "An invalid 32-bit near target must fault at the jump, not the target address");
    }
    {
        auto c = real(); c.r[SP] = 0xfff8;
        c.writeDword(0xfff8, 0x600); c.writeDword(0xfffc, 0); c.writeDword(0, 2); c.mem[0x600] = 0xf4;
        c.ww(0, 12 * 4, 0x700); c.ww(0, 12 * 4 + 2, 0); c.mem[0x700] = 0xf4;
        run(c, {0x66,0xcf});
        check(c.ip == 0x701 && c.r[SP] == 0xfff2 && c.rwS(SS, 0xfff2) == 0x500,
            "IRETD must reject a return frame crossing the stack limit instead of wrapping between dwords");
    }
    {
        auto c = real(); c.loadSegment(SS, 0x100);
        c.r32(BP, 0x200); c.r32(CX, 3); c.ww(0x100, 0x20c, 0x1234);
        run(c, {0x67,0x8b,0x54,0x8d,0, 0x64,0x67,0x89,0x14,0x8d,0,3,0,0, 0xf4});
        check(c.r[DX] == 0x1234 && c.rw(0, 0x30c) == 0x1234, "SIB EBP must default to SS; no-base SIB and FS override must select their own segment");
        c.r32(BX, 0x300); c.r32(SP, 0x8000); c.ww(0x100, 0x8000, 0xabcd); c.ww(0x100, 0x8002, 0x1234);
        run(c, {0x66,0x67,0x8f,0x04,0x23,0xf4});
        check(c.readDword(0x300) == 0x1234abcd && c.r32(SP) == 0x8004,
            "POP with a non-ESP SIB base must not adjust its destination address");
        c.r32(SP, 0x8000);
        run(c, {0x67,0x8f,0x04,0x24,0xf4});
        check(c.rw(0x100, 0x8002) == 0xabcd && c.r32(SP) == 0x8002,
            "16-bit POP [ESP] must address the destination after incrementing SP");
    }
    auto protectedMachine = [&](const std::vector<uint8_t>& code) {
        auto c = real();
        const uint8_t gdt[] = {0,0,0,0,0,0,0,0, 0xff,0xff,0,0,0,0x9a,0xcf,0,
            0xff,0xff,0,0,0,0x92,0xcf,0, 0xff,0xff,0,0,0,0x9a,0,0, 0xff,0xff,0,0,0,0x92,0,0};
        std::copy(std::begin(gdt), std::end(gdt), c.mem.begin() + 0x1000);
        c.writeWord(0x1100, 0x27); c.writeDword(0x1102, 0x1000);
        const std::vector<uint8_t> entry = {0x0f,0x01,0x16,0,0x11, 0x0f,0x20,0xc0, 0x66,0x83,0xc8,1,
            0x0f,0x22,0xc0, 0x66,0xea,0x17,0x20,0,0,8,0};
        std::copy(entry.begin(), entry.end(), c.mem.begin() + 0x2000);
        const std::vector<uint8_t> setup = {0x66,0xb8,0x10,0, 0x8e,0xd8,0x8e,0xc0,0x8e,0xd0, 0xbc,0,0,0x20,0};
        std::copy(setup.begin(), setup.end(), c.mem.begin() + 0x2017);
        std::copy(code.begin(), code.end(), c.mem.begin() + 0x2017 + setup.size());
        c.ip = 0x2000;
        for (unsigned i = 0; i < 1000 && !c.halted; ++i) c.step();
        check(c.halted && c.protectedMode(), "386 real-mode LGDT/MOV CR0/far jump must enter a 32-bit code segment");
        return c;
    };
    if (model == CpuModel::I486) {
        auto c = protectedMachine({0xf4});
        c.msw |= 0x40000; c.setEflags(0x63002); c.cpl = 3;
        c.loadSegment(DS, 0); c.loadSegment(SS, 0);
        for (unsigned size : {2u, 4u}) {
            c.writeDword(0x200, 0x12345678);
            bool rejected = false;
            try { c.readSegment(DS, 0x201, size); } catch (const CpuFault& f) { rejected = f.vector == 17 && f.code == 0; }
            check(rejected, "486 user and VM86 unaligned reads must raise #AC when CR0.AM and EFLAGS.AC are set");
            rejected = false;
            try { c.writeSegment(DS, 0x201, 0xaabbccdd, size); } catch (const CpuFault& f) { rejected = f.vector == 17 && f.code == 0; }
            check(rejected && c.readDword(0x200) == 0x12345678, "An alignment fault must occur before an unaligned store modifies memory");
            check(c.readSegment(DS, 0x200, size) == (size == 2 ? 0x5678u : 0x12345678u), "Aligned operands must remain accessible with alignment checking enabled");
        }
        c.loadSegment(CS, 0); c.ip = 0x500; c.halted = false;
        c.mem[0x500] = 0x66; c.mem[0x501] = 0xf3; c.mem[0x502] = 0x6d;
        c.r[DX] = 0x1f0; c.r[DI] = 0x201; c.r[CX] = 1;
        c.tr = {0x28, 0x9000, 0xff, 0x89}; c.writeWord(0x9066, 0x80);
        unsigned inputReads = 0;
        c.inWide = [&](uint16_t, unsigned) { ++inputReads; return uint32_t(0x12345678); };
        c.onFault = [](CpuFault fault, uint32_t) { throw fault; };
        bool alignment = false;
        try { c.step(); } catch (const CpuFault& f) { alignment = f.vector == 17 && f.code == 0; }
        check(alignment && inputReads == 0 && c.r[DI] == 0x201 && c.readDword(0x200) == 0x12345678,
            "An unaligned INSD destination must fault before consuming a wide device input");
        c.inWide = {}; c.onFault = {};
        c.msw &= ~0x40000u;
        check(c.readSegment(DS, 0x201, 2) == 0x3456, "Clearing CR0.AM must disable alignment faults");
        c.msw |= 0x40000; c.setEflags(0x23002);
        check(c.readSegment(DS, 0x201, 2) == 0x3456, "Clearing EFLAGS.AC must disable alignment faults");
        c.setEflags(0x63002); c.cr3 = 0x10000; c.writeDword(0x10000, 0x11007); c.msw |= 0x80000000u;
        bool rejected = false;
        try { c.readSegment(DS, 0x201, 4); } catch (const CpuFault& f) { rejected = f.vector == 14 && f.code == 4 && c.cr2 == 0x201; }
        check(rejected, "Page faults must take precedence over alignment faults for an unmapped unaligned operand");
        c = protectedMachine({0xf4}); c.msw |= 0x40000; c.setEflags(0x40002);
        c.mem[0x201] = 0x5a;
        check(c.readSegment(DS, 0x201, 4) == 0x5a, "Ring-zero memory accesses must not generate alignment checks");
        c.mem[0x101d] |= 0x60; c.mem[0x1025] |= 0x60;
        const uint32_t userFrame[] = {0x700, 0x1b, 0x40002, 0x8000, 0x23};
        for (unsigned i = 0; i < std::size(userFrame); ++i) c.writeDword(0x200000 + i * 4, userFrame[i]);
        c.mem[0x3000] = 0xcf; c.ip = 0x3000; c.halted = false; c.step();
        c.loadSegment(DS, 0x23);
        rejected = false;
        try { c.readSegment(DS, 0x201, 2); } catch (const CpuFault& f) { rejected = f.vector == 17 && f.code == 0; }
        check(c.cpl == 3 && rejected, "Protected-mode IRETD must restore AC and enforce alignment in an actual ring-three context");
        c.writeDword(0x8000, 0x240002); c.mem[0x700] = 0x66; c.mem[0x701] = 0x9d; c.step();
        check((c.eflags() & 0x240000) == 0x240000 && !(c.flags & 0x3000),
            "User POPFD may change AC/ID without acquiring IOPL privileges");
        for (const auto& code : {std::vector<uint8_t>{0x0f,8}, {0x0f,9}, {0x67,0x0f,1,0x38}}) {
            c = protectedMachine({0xf4}); c.setEflags(0x23002); c.cpl = 3;
            c.loadSegment(CS, 0); c.loadSegment(SS, 0); c.ip = 0x500; c.halted = false; c.r[SP] = 0x8000;
            bool denied = false;
            c.onFault = [](CpuFault fault, uint32_t) { throw fault; };
            std::copy(code.begin(), code.end(), c.mem.begin() + 0x500);
            try { c.step(); } catch (const CpuFault& f) { denied = f.vector == 13 && f.code == 0; }
            check(denied, "486 cache and TLB maintenance instructions must be privileged in VM86 mode");
        }
    }
    {
        auto c = protectedMachine({0xb8,0x78,0x56,0x34,0x12, 0xa3,0,0,0x10,0,
            0x8b,0x1d,0,0,0x10,0, 0x50,0x5a, 0x0f,0xb6,0xc8, 0x8d,0x34,0x8d,0,0x10,0,0, 0xf4});
        check(c.r32(AX) == 0x12345678 && c.r32(BX) == 0x12345678 && c.r32(DX) == 0x12345678
            && c.r32(CX) == 0x78 && c.r32(SI) == 0x11e0 && c.r32(SP) == 0x200000
            && c.readDword(0x100000) == 0x12345678 && c.readDword(0x1ffffc) == 0x12345678,
            "Flat 32-bit data, SIB addressing, MOVZX and a 32-bit stack must work above 1MiB");
        c.halted = false; c.mem[0x123450] = 0xb8; c.writeDword(0x123451, 0x89abcdef); c.mem[0x123455] = 0xf4;
        run(c, {0xbe,0x50,0x34,0x12,0,0xff,0xe6}, 0x3000);
        check(c.ip == 0x123456 && c.r32(AX) == 0x89abcdef, "EIP must not truncate at a 64KiB boundary");
        c.r32(BP, 0x1f8000); c.halted = false;
        run(c, {0x66,0xc8,0x10,0,0,0x66,0xc9,0xf4}, 0x3000);
        check(c.r32(SP) == 0x200000 && c.r32(BP) == 0x1f8000,
            "16-bit ENTER/LEAVE must preserve the high ESP bits in a 32-bit stack segment");
    }
    {
        auto c = protectedMachine({0xb8,0x10,0,0,0, 0x0f,0x02,0xc8, 0x0f,0x03,0xd0, 0xf4});
        check(c.r32(CX) == 0x00c09300 && c.r32(DX) == 0xffffffff && (c.flags & ZF),
            "32-bit LAR must return descriptor attributes; LSL must expand a granular limit");
        c.r32(CX, 0xdeadbeef); c.r32(DX, 0x12340000);
        run(c, {0x66,0x0f,0x02,0xc8, 0x66,0x0f,0x03,0xd0, 0xf4}, 0x3000);
        check(c.r32(CX) == 0xdead9300 && c.r32(DX) == 0x1234ffff,
            "16-bit descriptor queries must preserve the upper half of the destination");
        c.r[AX] = 0x20; c.mem[0x1025] = 0x09; c.mem[0x1026] = 1; c.writeWord(0x1020, 0x4567);
        run(c, {0x0f,0x02,0xc8, 0x0f,0x03,0xd0, 0xf4}, 0x3000);
        check(c.r32(CX) == 0x900 && c.r32(DX) == 0x14567 && (c.flags & ZF),
            "LAR and LSL must accept 386 TSS descriptors without requiring the present bit");
        c.mem[0x1025] = 0x8c;
        run(c, {0x0f,0x02,0xc8, 0x0f,0x03,0xd0, 0xf4}, 0x3000);
        check(c.r32(CX) == 0x8c00 && c.r32(DX) == 0x14567 && !(c.flags & ZF),
            "A 386 call gate must be queryable by LAR but rejected by LSL without changing its destination");
        for (auto selector : {0, 0x13, 0x28}) {
            c.r[AX] = uint16_t(selector); c.r32(CX, 0xabcdef01); c.r32(DX, 0x12345678);
            run(c, {0x0f,0x02,0xc8, 0x0f,0x03,0xd0, 0xf4}, 0x3000);
            check(c.r32(CX) == 0xabcdef01 && c.r32(DX) == 0x12345678 && !(c.flags & ZF),
                "Null, invisible and out-of-table selectors must clear ZF without modifying query destinations");
        }
    }
    {
        auto c = protectedMachine({0xb8,0x78,0x56,0x34,0x12,0xa3,0,0x30,0,0,
            0xb8,0xef,0xcd,0xab,0x89,0xa3,4,0x30,0,0,
            0xbe,0,0x30,0,0,0xbf,0,0x40,0,0,0xb9,2,0,0,0,0xf3,0xa5,0xf4});
        check(c.r32(CX) == 0 && c.r32(SI) == 0x3008 && c.r32(DI) == 0x4008
            && c.readDword(0x4000) == 0x12345678 && c.readDword(0x4004) == 0x89abcdef,
            "REP MOVSD must copy dwords using ECX/ESI/EDI in 32-bit code");
    }
    {
        auto c = real();
        c.writeDword(0x10000, 0x11007);
        c.writeDword(0x10400, 0x12007);
        c.writeDword(0x12000, 0x100007);
        c.cr3 = 0x10000; c.msw = 0x80000011u;
        c.writeLinear(0x40000000, 0x5a);
        check(c.mem[0x100000] == 0x5a && c.readLinear(0x40000000) == 0x5a
            && (c.readDword(0x10400) & 0x20) && (c.readDword(0x12000) & 0x60) == 0x60,
            "386 page translation must use PDE/PTE mapping and set accessed/dirty bits");
        c.cpl = 3; c.writeDword(0x12000, 0x100005);
        bool rejected = false;
        try { c.writeLinear(0x40000000, 0xa5); } catch (const CpuFault& f) { rejected = f.vector == 14 && f.code == 7 && c.cr2 == 0x40000000; }
        check(rejected && c.mem[0x100000] == 0x5a, "User writes to read-only pages must fault with CR2 and P/W/U error bits");
        c.cpl = 0; c.msw |= 0x10000;
        if (model == CpuModel::I486) {
            rejected = false;
            try { c.writeLinear(0x40000000, 0xa5); } catch (const CpuFault& f) { rejected = f.vector == 14 && f.code == 3; }
            check(rejected && c.mem[0x100000] == 0x5a, "486 CR0.WP must protect read-only pages against supervisor writes");
            c.msw &= ~0x10000u;
        }
        c.writeLinear(0x40000000, 0xa5);
        check(c.mem[0x100000] == 0xa5, "Supervisor writes must ignore read-only permissions on a 386 or with 486 WP clear");
        c.writeDword(0x11000 + 8 * 4, 0x8007); c.mem[0x8ffe] = 0x55; c.mem[0x8fff] = 0x66;
        rejected = false;
        try { c.writeSegment(DS, 0x8ffe, 0x12345678, 4); } catch (const CpuFault& f) { rejected = f.vector == 14 && f.code == 2 && c.cr2 == 0x9000; }
        check(rejected && c.mem[0x8ffe] == 0x55 && c.mem[0x8fff] == 0x66,
            "A dword store across a missing page must not partially modify RAM");
        c.writeDword(0x13000 + 0x100 * 4, 0x14007); c.writeDword(0x14000, 0x101007); c.mem[0x101000] = 0xcc;
        c.cr3 = 0x13000;
        check(c.readLinear(0x40000000) == 0xcc, "Switching CR3 must not retain an old page translation");
    }
    auto systemDescriptor = [](Cpu& c, unsigned selector, uint32_t base, uint32_t limit, uint8_t access, uint8_t attributes = 0) {
        auto a = c.gdtr.base + selector;
        c.writeWord(a, uint16_t(limit)); c.writeWord(a + 2, uint16_t(base));
        c.mem[a + 4] = uint8_t(base >> 16); c.mem[a + 5] = access;
        c.mem[a + 6] = uint8_t((limit >> 16) & 15) | attributes; c.mem[a + 7] = uint8_t(base >> 24);
    };
    auto gate = [](Cpu& c, uint32_t address, uint32_t offset, uint16_t selector, uint8_t access, uint8_t parameters = 0) {
        c.writeWord(address, uint16_t(offset)); c.writeWord(address + 2, selector);
        c.mem[address + 4] = parameters; c.mem[address + 5] = access; c.writeWord(address + 6, uint16_t(offset >> 16));
    };
    auto systemMachine = [&]() {
        auto c = protectedMachine({0xf4}); c.gdtr.limit = 0x5f; c.idtr = {0x8000, 0x7ff};
        systemDescriptor(c, 0x28, 0, 0xfffff, 0xfa, 0xc0);
        systemDescriptor(c, 0x30, 0, 0xfffff, 0xf2, 0xc0);
        systemDescriptor(c, 0x38, 0x9000, 103, 0x89);
        systemDescriptor(c, 0x40, 0xa000, 103, 0x89);
        c.writeDword(0x9004, 0x1f0000); c.writeWord(0x9008, 0x10);
        c.writeWord(0x9066, 104);
        run(c, {0x66,0xb8,0x38,0,0x0f,0,0xd8,0xf4}, 0x3000);
        check(c.tr.selector == 0x38 && c.mem[0x103d] == 0x8b, "LTR must accept and mark a 386 TSS busy");
        c.halted = false; c.ip = 0x3000; return c;
    };
    auto user = [](Cpu& c) {
        auto sp = c.r32(SP) - 20;
        const uint32_t frame[] = {0x4000, 0x2b, 0x202, 0x180000, 0x33};
        for (unsigned i = 0; i < std::size(frame); ++i) c.writeSegment(SS, sp + i * 4, frame[i], 4);
        c.r32(SP, sp); c.mem[c.ip] = 0xcf; c.step();
        check(c.cpl == 3 && c.s[CS] == 0x2b && c.s[SS] == 0x33 && c.r32(SP) == 0x180000
            && !c.s[DS], "IRETD must enter ring 3 and invalidate inaccessible data segments");
        c.loadSegment(DS, 0x33); c.loadSegment(ES, 0x33);
    };
    auto paging = [](Cpu& c) {
        c.writeDword(0x10000, 0x20007);
        for (unsigned i = 0; i < 1024; ++i) c.writeDword(0x20000 + i * 4, (i << 12) | 7);
        c.cr3 = 0x10000; c.msw |= 0x80000000u;
    };
    for (uint8_t type : {uint8_t(14), uint8_t(15)}) {
        auto c = systemMachine(); gate(c, 0x8180, 0x123450, 8, uint8_t(0x80 | type));
        c.mem[0x123450] = 0xcf; c.setEflags(0x14202);
        c.interrupt(0x30);
        check(c.ip == 0x123450 && c.r32(SP) == 0x1ffff4 && c.readDword(0x1ffff4) == 0x3000
            && c.readDword(0x1ffff8) == 8 && c.readDword(0x1ffffc) == 0x14202
            && !(c.eflags() & 0x14000) && bool(c.flags & IF) == (type == 15),
            "32-bit interrupt/trap gates must use full offsets and EFLAGS and clear NT/RF with the correct IF behavior");
        c.step();
        check(c.ip == 0x3000 && c.r32(SP) == 0x200000 && c.eflags() == 0x14202,
            "Same-level IRETD must restore full EIP, EFLAGS and ESP");
        c.mem[0x3000] = 0x90; c.step();
        check(!(c.eflags() & 0x10000), "RF restored by IRETD must clear after the retried instruction succeeds");
    }
    for (bool wide : {false, true}) {
        auto c = systemMachine(); gate(c, 0x8180, wide ? 0x12000 : 0x5000, 8, wide ? 0xee : 0xe6);
        user(c); if (!wide) c.r32(SP, 0x8000);
        auto oldSp = c.r32(SP);
        c.mem[0x4000] = 0x66; c.mem[0x4001] = 0xcd; c.mem[0x4002] = 0x30;
        c.mem[wide ? 0x12000 : 0x5000] = wide ? 0xcf : 0x66; c.mem[0x5001] = 0xcf;
        c.step();
        check(c.cpl == 0 && c.s[SS] == 0x10 && c.r32(SP) == 0x1f0000 - (wide ? 20u : 10u)
            && c.readSegment(SS, c.r32(SP), wide ? 4 : 2) == 0x4003,
            "Gate size, not INT operand size, must choose the frame width on the 386 TSS privilege stack");
        c.loadSegment(FS, 0x10); c.loadSegment(GS, 0x10); c.step();
        check(c.cpl == 3 && c.ip == 0x4003 && c.r32(SP) == oldSp && c.s[SS] == 0x33
            && c.s[DS] == 0x33 && !c.s[FS] && !c.s[GS] && (c.flags & IF),
            "IRET/IRETD must restore the outer stack and clear kernel-only FS/GS");
    }
    {
        auto c = systemMachine(); gate(c, 0x1048, 0x12000, 8, 0xec, 2);
        user(c); c.writeSegment(SS, 0x180000, 0x11223344, 4); c.writeSegment(SS, 0x180004, 0xaabbccdd, 4);
        const uint8_t call[] = {0x66,0x9a,0,0,0x4b,0};
        std::copy(std::begin(call), std::end(call), c.mem.begin() + 0x4000);
        c.mem[0x12000] = 0xca; c.mem[0x12001] = 8; c.mem[0x12002] = 0;
        c.step(); auto sp = c.r32(SP);
        check(c.cpl == 0 && c.ip == 0x12000 && sp == 0x1effe8 && c.readDword(sp) == 0x4006
            && c.readDword(sp + 8) == 0x11223344 && c.readDword(sp + 12) == 0xaabbccdd
            && c.readDword(sp + 16) == 0x180000 && c.readDword(sp + 20) == 0x33,
            "A 32-bit call gate must copy dword parameters and ignore the caller's operand size");
        c.step();
        check(c.cpl == 3 && c.ip == 0x4006 && c.r32(SP) == 0x180008,
            "RETF imm must discard gate parameters on both privilege stacks");
    }
    {
        auto c = systemMachine(); gate(c, 0x8180, 0x12000, 8, 0xee);
        for (auto addresses : {std::pair<uint32_t,uint32_t>{0x1000,0x11000}, {0x8000,0x18000}, {0x9000,0x19000}}) {
            std::copy_n(c.mem.begin() + addresses.first, 4096, c.mem.begin() + addresses.second);
            std::fill_n(c.mem.begin() + addresses.first, 4096, 0xa5);
        }
        paging(c);
        c.writeDword(0x20004, 0x11003); c.writeDword(0x20020, 0x18003); c.writeDword(0x20024, 0x19003);
        c.writeDword(0x20000 + 0x1ef * 4, 0x1ef003);
        user(c); c.mem[0x4000] = 0xcd; c.mem[0x4001] = 0x30; c.mem[0x12000] = 0xcf;
        c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && c.r32(SP) == 0x1effec,
            "IDT, GDT and TSS reads and kernel stack writes must use supervisor linear translation");
        c.step(); check(c.cpl == 3 && c.ip == 0x4002, "Paged interrupt/IRETD must return to the user mapping");
        c.writeDword(0x20020, 0);
        bool rejected = false;
        try { c.interrupt(0x30, -1, false, true); }
        catch (const CpuFault& f) { rejected = f.vector == 14 && f.code == 0 && c.cr2 == 0x8185; }
        check(rejected, "An external interrupt's IDT page fault must be supervisor/non-present, not have the EXT bit ORed into PF.P");
    }
    {
        auto c = systemMachine(); gate(c, 0x8180, 0x12000, 8, 0x8e); gate(c, 0x8068, 0x13000, 8, 0x8e);
        user(c); c.mem[0x4000] = 0xcd; c.mem[0x4001] = 0x30; c.step();
        check(c.cpl == 0 && c.ip == 0x13000 && c.readDword(c.r32(SP)) == 0x182
            && c.readDword(c.r32(SP) + 4) == 0x4000 && (c.readDword(c.r32(SP) + 12) & 0x10000),
            "A forbidden software INT must deliver a restartable #GP with the gate error code and RF");
    }
    {
        auto c = systemMachine(); gate(c, 0x8068, 0x13000, 8, 0x8e);
        const uint32_t frame[] = {0x4000,0x2b,0x202,0x180000,8};
        for (unsigned i = 0; i < std::size(frame); ++i) c.writeDword(0x1fffec + i * 4, frame[i]);
        c.r32(SP, 0x1fffec); c.mem[0x3000] = 0xcf; c.step();
        check(c.cpl == 0 && c.s[SS] == 0x10 && c.ip == 0x13000 && c.r32(SP) == 0x1fffdc
            && c.readDword(0x1fffdc) == 8 && c.readDword(0x1fffe0) == 0x3000,
            "Invalid IRETD outer-stack selectors must fault without committing CS, CPL or ESP");
    }
    for (unsigned scenario = 0; scenario < 4; ++scenario) {
        bool doubleFault = scenario >= 2;
        auto c = systemMachine(); gate(c, 0x8180, 0x12000, 8, 0xee);
        gate(c, 0x8068, 0x13000, 8, 0x8e); gate(c, c.idtr.base + (doubleFault ? 8 : 14) * 8, 0x5000, 0x2b, 0x8e);
        c.writeDword(0x9004, 0x1f0004); c.writeDword(0x1f0000, 0xdeadbeef);
        paging(c); c.writeDword(0x20000 + 0x1ef * 4, 0); c.writeDword(0x20000 + 0x1f0 * 4, 0x1f0003);
        if (scenario == 2) systemDescriptor(c, 0x10, 0, 0xffff, 0x92, 0x40);
        if (scenario == 3) {
            gate(c, 0x8070, 0x13000, 8, 0x8e); c.writeDword(0x2002c, 0);
            c.mem[0x4000] = 0xa1; c.writeDword(0x4001, 0xb000);
        } else { c.mem[0x4000] = scenario ? 0xfa : 0xcd; c.mem[0x4001] = 0x30; }
        user(c); c.step();
        check(c.cpl == 3 && c.s[SS] == 0x33 && c.ip == 0x5000 && c.r32(SP) == 0x17fff0
            && c.readDword(0x17fff0) == (doubleFault ? 0u : 2u) && c.readDword(0x17fff4) == 0x4000
            && c.cr2 == (scenario == 2 ? 0u : 0x1efffcu) && c.readDword(0x1f0000) == 0xdeadbeef,
            "Privilege faults must not partially write frames; GP/PF must remain PF while GP/SS and PF/PF become DF in the original context");
    }
    auto nextTask = [&](Cpu& c) {
        c.writeDword(0xa004, 0x1f0000); c.writeWord(0xa008, 0x10);
        c.writeDword(0xa020, 0x5000); c.writeDword(0xa024, 0x202); c.writeDword(0xa028, 0x89abcdef);
        c.writeDword(0xa038, 0x1e0000);
        for (unsigned i = 0; i < 6; ++i) c.writeWord(0xa048 + i * 4, i == CS ? 8 : 0x10);
        const uint8_t call[] = {0x9a,0,0,0,0,0x40,0};
        std::copy(std::begin(call), std::end(call), c.mem.begin() + 0x3000);
        c.mem[0x5000] = 0xcf; c.r32(AX, 0x1234abcd); c.loadSegment(FS, 0x10); c.loadSegment(GS, 0x10);
    };
    {
        auto c = systemMachine(); nextTask(c); paging(c);
        c.writeDword(0x12000, 0x21007); std::copy_n(c.mem.begin() + 0x20000, 4096, c.mem.begin() + 0x21000);
        c.writeDword(0x21014, 0x6003); c.writeDword(0x901c, 0x10000); c.writeDword(0xa01c, 0x12000);
        const uint8_t code[] = {0xb8,0x44,0x33,0x22,0x11,0xcf};
        std::copy(std::begin(code), std::end(code), c.mem.begin() + 0x6000); c.mem[0x5000] = 0xf4;
        c.step();
        check(c.tr.selector == 0x40 && c.cr3 == 0x12000 && c.r32(AX) == 0x89abcdef && (c.flags & 0x4000)
            && (c.msw & 8) && c.readWord(0xa000) == 0x38 && c.readDword(0x9020) == 0x3007
            && c.readDword(0x9028) == 0x1234abcd && c.readWord(0x9058) == 0x10 && c.readWord(0x905c) == 0x10,
            "A nested 386 task call must save full state, FS/GS, backlink, busy bits and load CR3");
        c.step(); check(c.r32(AX) == 0x11223344, "The incoming task must execute through its own page directory");
        c.step();
        check(c.tr.selector == 0x38 && c.cr3 == 0x10000 && c.ip == 0x3007 && c.r32(AX) == 0x1234abcd
            && c.r32(SP) == 0x200000 && c.mem[0x1045] == 0x89 && !(c.flags & 0x4000)
            && c.readDword(0xa020) == 0x5006 && !(c.readDword(0xa024) & 0x4000),
            "Nested-task IRETD must restore the outgoing task and clear the departed task's busy/NT state");
    }
    for (bool committed : {false, true}) {
        auto c = systemMachine(); nextTask(c);
        gate(c, c.idtr.base + (committed ? 10 : 14) * 8, 0x13000, 8, 0x8e);
        if (committed) c.writeWord(0xa054, 0x60);
        else { paging(c); c.writeDword(0x20028, 0); c.writeDword(0x9020, 0xfeedface); }
        c.step();
        check(c.ip == 0x13000 && c.tr.selector == (committed ? 0x40 : 0x38)
            && c.r32(AX) == (committed ? 0x89abcdef : 0x1234abcd)
            && c.readDword(c.r32(SP)) == (committed ? 0x60u : 0u)
            && c.readDword(c.r32(SP) + 4) == (committed ? 0x5000u : 0x3000u)
            && c.readDword(0x9020) == (committed ? 0x3007u : 0xfeedfaceu),
            "Task-switch faults before commit must restart the caller; invalid incoming segments must fault in the new task");
    }
    auto vm = [&](Cpu& c, uint32_t flags = 0x202) {
        const uint32_t frame[] = {0x4000, 0, flags | 0x20000, 0xabcd8000, 0, 0x200, 0x300, 0x400, 0x500};
        auto sp = c.r32(SP) - uint32_t(sizeof(frame));
        for (unsigned i = 0; i < std::size(frame); ++i) c.writeSegment(SS, sp + i * 4, frame[i], 4);
        c.r32(SP, sp); c.mem[c.ip] = 0xcf; c.step();
        check(c.cpl == 3 && (c.eflags() & 0x20000) && !c.s[CS] && !c.s[SS] && c.r32(SP) == 0xabcd8000
            && c.s[ES] == 0x200 && c.s[DS] == 0x300 && c.s[FS] == 0x400 && c.s[GS] == 0x500,
            "Ring-0 IRETD must load all nine VM86 frame slots without interpreting real-mode segments as descriptors");
    };
    auto vmCode = [](Cpu& c, const std::vector<uint8_t>& code) {
        std::copy(code.begin(), code.end(), c.mem.begin() + (uint32_t(c.s[CS]) << 4) + c.ip);
    };
    auto bitmap = [&](Cpu& c, uint32_t limit = 0x2068) {
        systemDescriptor(c, 0x38, 0x9000, limit, 0x89);
        c.r[AX] = 0x38; c.mem[c.ip] = 0x0f; c.mem[c.ip + 1] = 0; c.mem[c.ip + 2] = 0xd8; c.step();
        std::fill_n(c.mem.begin() + 0x9068, 8193, 0xff); c.writeWord(0x9066, 104);
        c.ip = 0x3000;
    };
    auto allowPort = [](Cpu& c, unsigned port) { c.mem[0x9068 + (port >> 3)] &= uint8_t(~(1 << (port & 7))); };
    {
        auto c = systemMachine(); vm(c);
        c.writeWord(0x600, 0xbeef); c.writeDword(0x5200, 0x89abcdef);
        vmCode(c, {0xb8,0xcd,0xab, 0xa3,0,6, 0x64,0x66,0xc7,6,0,2,0x78,0x56,0x34,0x12,
            0x65,0x66,0xa1,0,2, 0xb8,0,0, 0x8e,0xd8, 0xa1,0,6, 0x66,0x50, 0x66,0x5b,
            0x9a,0,0x50,0,1});
        c.mem[0x6000] = 0xb8; c.writeWord(0x6001, 0x1234); c.mem[0x6003] = 0xcb;
        for (unsigned i = 0; i < 12; ++i) c.step();
        check((c.eflags() & 0x20000) && c.ip == 0x4026 && !c.s[CS] && !c.s[DS] && c.r32(SP) == 0xabcd8000
            && c.readWord(0x3600) == 0xabcd && c.readDword(0x4200) == 0x12345678
            && c.r32(BX) == 0x89abbeef && c.r32(AX) == 0x89ab1234,
            "VM86 must use 16-bit defaults, real-mode segment reloads, FS/GS, 32-bit overrides and far calls without losing upper ESP");
    }
    const std::vector<std::vector<uint8_t>> sensitive = {
        {0xfa}, {0xfb}, {0x9c}, {0x9d}, {0xcf}, {0x66,0x9c}, {0x66,0x9d}, {0x66,0xcf},
        {0xcd,0x21}, {0x66,0xcd,0x21}, {0xf4}, {0x0f,0x20,0xc0}, {0x0f,0x01,0xf0}, {0x0f,0x06}
    };
    for (const auto& code : sensitive) {
        auto c = systemMachine(); gate(c, 0x8068, 0x12000, 8, 0x8e); vm(c, 0x4202);
        c.r32(AX, 0x12345678); c.writeDword(0x7ffc, 0xfeedface); vmCode(c, code); c.step();
        auto sp = c.r32(SP);
        check(c.cpl == 0 && !(c.eflags() & 0x20000) && c.ip == 0x12000 && sp == 0x1effd8
            && c.readDword(sp) == 0 && c.readDword(sp + 4) == 0x4000 && c.readDword(sp + 8) == 0
            && (c.readDword(sp + 12) & 0x20000) && c.readDword(sp + 16) == 0xabcd8000
            && c.readDword(sp + 20) == 0 && c.readDword(sp + 24) == 0x200 && c.readDword(sp + 28) == 0x300
            && c.readDword(sp + 32) == 0x400 && c.readDword(sp + 36) == 0x500
            && !c.s[ES] && !c.s[DS] && !c.s[FS] && !c.s[GS] && c.r32(AX) == 0x12345678
            && c.readDword(0x7ffc) == 0xfeedface,
            "VM86 sensitive instructions must fault before side effects, ignore NT task return and save a complete monitor frame");
        c.writeDword(sp + 4, 0x4000 + uint32_t(code.size()));
        c.mem[0x12000] = 0x83; c.mem[0x12001] = 0xc4; c.mem[0x12002] = 4; c.mem[0x12003] = 0xcf;
        c.step(); c.step();
        check(c.cpl == 3 && (c.eflags() & 0x20000) && c.ip == 0x4000 + code.size() && c.r32(SP) == 0xabcd8000
            && c.s[DS] == 0x300 && c.s[FS] == 0x400 && c.s[GS] == 0x500,
            "A monitor must be able to resume VM86 with IRETD and restore every segment and the full ESP");
    }
    for (const auto& code : std::vector<std::vector<uint8_t>>{{0x0f,0,0xc0},{0x0f,0,0xc8},{0x0f,2,0xc0},{0x63,0xc0}}) {
        auto c = systemMachine(); gate(c, 0x8030, 0x12000, 8, 0x8e); vm(c); vmCode(c, code); c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && c.r32(SP) == 0x1effdc && c.readDword(c.r32(SP)) == 0x4000,
            "Protected-only selector instructions must raise #UD in VM86, without pushing an error-code slot");
    }
    {
        auto c = systemMachine(); vm(c, 0x3202);
        vmCode(c, {0xfa,0xfb,0x90,0x66,0x9c,0x66,0x58,0x66,0x68,1,0,0,0,0x66,0x9d});
        c.step(); check(!(c.flags & IF), "VM86 CLI must work when IOPL is 3");
        c.step(); check(c.flags & IF, "VM86 STI must work when IOPL is 3");
        c.step(); c.step(); c.step();
        check(c.r32(AX) == 0x3202 && c.r32(SP) == 0xabcd8000, "VM86 PUSHFD must not expose VM or RF");
        c.step(); c.step();
        check((c.eflags() & 0x23201) == 0x23001 && !(c.flags & IF) && c.r32(SP) == 0xabcd8000,
            "VM86 POPFD may update IF but must preserve IOPL and VM");
    }
    for (bool wide : {false, true}) {
        auto c = systemMachine(); vm(c, 0x7202);
        c.writeWord(0x8000, 0x4500); c.writeWord(wide ? 0x8004 : 0x8002, 0x1234);
        if (wide) {
            c.writeWord(0x8002, 0); c.writeWord(0x8006, 0); c.writeDword(0x8008, 0x10003);
            vmCode(c, {0x66,0xcf});
        } else { c.writeWord(0x8004, 3); vmCode(c, {0xcf}); }
        c.step();
        check((c.eflags() & 0x23000) == 0x23000 && c.cpl == 3 && c.s[CS] == 0x1234 && c.ip == 0x4500
            && c.r32(SP) == 0xabcd8000 + (wide ? 12u : 6u) && (c.flags & CF) && !(c.flags & 0x4000)
            && bool(c.eflags() & 0x10000) == wide,
            "VM86 IRET/IRETD at IOPL 3 must ignore NT and retain VM/IOPL while restoring real-mode CS:IP");
    }
    for (uint8_t op : {uint8_t(0xcc), uint8_t(0xce), uint8_t(0xcd)}) {
        auto c = systemMachine(); unsigned vector = op == 0xcc ? 3 : op == 0xce ? 4 : 0x21;
        gate(c, c.idtr.base + vector * 8, 0x12000, 8, 0xee);
        vm(c, op == 0xcd ? 0x3302 : 0xb02); vmCode(c, {op,0x21});
        c.writeWord(vector * 4, 0x5000); c.writeWord(vector * 4 + 2, 0x100);
        c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && c.readDword(c.r32(SP)) == (op == 0xcd ? 0x4002u : 0x4001u),
            "VM86 INT3/INTO must bypass IOPL; software interrupts must use the protected IDT and suppress the old TF single-step");
    }
    {
        auto c = systemMachine(); gate(c, 0x8180, 0x12000, 8, 0x8e); vm(c);
        c.irq = [once = false]() mutable { if (once) return -1; once = true; return 0x30; };
        c.step(); c.irq = {};
        check(c.cpl == 0 && c.ip == 0x12000 && c.readDword(c.r32(SP)) == 0x4000
            && c.readDword(c.r32(SP) + 12) == 0xabcd8000,
            "Hardware IRQs must leave VM86 even at IOPL 0 and save the full ESP before executing the next instruction");
        c.mem[0x12000] = 0xcf; c.step();
        check(c.cpl == 3 && (c.eflags() & 0x20000) && c.ip == 0x4000 && c.r32(SP) == 0xabcd8000,
            "An IRQ monitor must return directly to the interrupted VM86 context");
    }
    for (bool wordGate : {false, true}) {
        auto c = systemMachine(); gate(c, 0x8180, 0x5000, wordGate ? 8 : 0x2b, wordGate ? 0xe6 : 0xee);
        gate(c, 0x8068, 0x12000, 8, 0x8e); vm(c, 0x3202); vmCode(c, {0xcd,0x30}); c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && c.readDword(c.r32(SP)) == (wordGate ? 8u : 0x28u)
            && c.readDword(c.r32(SP) + 4) == 0x4000 && (c.readDword(c.r32(SP) + 12) & 0x20000),
            "VM86 interrupts must reject 16-bit gates and non-ring-0 target code with a restartable selector error");
    }
    {
        auto c = systemMachine(); gate(c, 0x8068, 0x12000, 8, 0x8e);
        std::vector<uint8_t> monitor = {0x83,0xc4,4,0x60,0x66,0xb8,0x10,0,0x8e,0xd8,0x8d,0x6c,0x24,0x20,
            0x0f,0xb7,0x5d,4,0xc1,0xe3,4,0x03,0x5d,0,0x80,0x3b,0xcf};
        auto toIret = monitor.size(); monitor.insert(monitor.end(), {0x74,0});
        monitor.insert(monitor.end(), {0x83,0x45,0,2,0x0f,0xb7,0x5d,0x10,0xc1,0xe3,4,0x0f,0xb7,0x55,0x0c,
            0x66,0x83,0xea,6,0x66,0x89,0x55,0x0c,0x03,0xda,0x66,0x8b,0x45,8,0x66,0x89,0x43,4,
            0x66,0x8b,0x45,4,0x66,0x89,0x43,2,0x66,0x8b,0x45,0,0x66,0x89,3,
            0x0f,0xb7,5,0x84,0,0,0,0x89,0x45,0,0x0f,0xb7,5,0x86,0,0,0,0x89,0x45,4});
        auto toDone = monitor.size(); monitor.insert(monitor.end(), {0xeb,0});
        auto iret = monitor.size();
        monitor.insert(monitor.end(), {0x0f,0xb7,0x5d,0x10,0xc1,0xe3,4,0x0f,0xb7,0x55,0x0c,0x03,0xda,
            0x0f,0xb7,3,0x89,0x45,0,0x0f,0xb7,0x43,2,0x89,0x45,4,0x66,0x8b,0x43,4,
            0x66,0x25,0xff,0xcf,0x66,0x89,0x45,8,0x66,0x83,0xc2,6,0x66,0x89,0x55,0x0c});
        auto done = monitor.size(); monitor.insert(monitor.end(), {0x61,0xcf});
        check(iret - toIret - 2 < 128 && done - toDone - 2 < 128, "VM86 test monitor short branches must fit");
        monitor[toIret + 1] = uint8_t(iret - toIret - 2); monitor[toDone + 1] = uint8_t(done - toDone - 2);
        std::copy(monitor.begin(), monitor.end(), c.mem.begin() + 0x12000);
        c.writeWord(0x84, 0x5000); c.writeWord(0x86, 0x100); c.writeWord(0x3600, 0);
        const uint8_t handler[] = {0xff,6,0,6,0xcf};
        std::copy(std::begin(handler), std::end(handler), c.mem.begin() + 0x6000);
        vm(c); vmCode(c, {0xcd,0x21}); c.r32(AX, 0xcafebabe);
        unsigned entries = 0;
        for (unsigned i = 0; i < 150 && !((c.eflags() & 0x20000) && c.ip == 0x4002); ++i) {
            if (!(c.eflags() & 0x20000) && c.ip == 0x12000) ++entries;
            c.step();
        }
        check(entries == 2 && c.cpl == 3 && (c.eflags() & 0x23000) == 0x20000 && !c.s[CS] && c.ip == 0x4002
            && c.r32(SP) == 0xabcd8000 && c.r32(AX) == 0xcafebabe && c.readWord(0x3600) == 1,
            "Guest monitor machine code must reflect trapped INT 21h via the IVT and emulate the VM86 handler's IRET without a host shortcut");
    }
    {
        auto c = systemMachine(); user(c);
        c.r32(SP, 0x17fff4); c.writeDword(0x17fff4, 0x4100); c.writeDword(0x17fff8, 0x2b);
        c.writeDword(0x17fffc, 0x20202); c.mem[0x4000] = 0xcf; c.step();
        check(c.cpl == 3 && !(c.eflags() & 0x20000) && c.ip == 0x4100 && c.r32(SP) == 0x180000,
            "Protected ring-3 IRETD must not grant itself VM86 mode by setting VM in its flags image");
    }
    {
        auto c = systemMachine(); gate(c, 0x8070, 0x12000, 8, 0x8e); vm(c); paging(c);
        c.writeDword(0x2000c, 0x140007); c.writeWord(0x140600, 0xbeef);
        vmCode(c, {0xa1,0,6,0xa3,0,6}); c.step();
        check(c.r[AX] == 0xbeef, "VM86 real-mode linear addresses must still be translated through user pages");
        c.writeDword(0x2000c, 0x140005); c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && c.cr2 == 0x3600 && c.readDword(c.r32(SP)) == 7
            && c.readDword(c.r32(SP) + 4) == 0x4003 && c.readWord(0x140600) == 0xbeef,
            "VM86 writes to read-only pages must fault as user writes and restart inside the original segment");
    }
    for (bool stack : {false, true}) {
        auto c = systemMachine(); gate(c, c.idtr.base + (stack ? 12 : 13) * 8, 0x12000, 8, 0x8e); vm(c);
        vmCode(c, stack ? std::vector<uint8_t>{0x36,0x67,0xa1,0,0,1,0} : std::vector<uint8_t>{0x67,0xa1,0,0,1,0}); c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && c.readDword(c.r32(SP)) == 0 && c.readDword(c.r32(SP) + 4) == 0x4000,
            "32-bit VM86 effective addresses must obey 64KiB segment limits and select #SS or #GP correctly");
    }
    {
        auto c = systemMachine(); gate(c, 0x8070, 0x12000, 8, 0x8e);
        const uint32_t frame[] = {0x4000,0,0x20202,0x8000,0,0,0,0,0};
        for (unsigned i = 0; i < std::size(frame); ++i) c.writeDword(0x1fffe0 + i * 4, frame[i]);
        c.r32(SP, 0x1fffe0); c.mem[0x3000] = 0xcf; paging(c); c.writeDword(0x20800, 0); c.step();
        check(c.cpl == 0 && !(c.eflags() & 0x20000) && c.s[CS] == 8 && c.s[DS] == 0x10 && c.ip == 0x12000
            && c.cr2 == 0x200000 && c.r32(SP) == 0x1fffd0 && c.readDword(0x1fffd4) == 0x3000,
            "IRETD must read the entire VM86 frame before committing mode, segments or ESP");
    }
    {
        auto c = systemMachine(); nextTask(c); gate(c, 0x8068, 0x12000, 8, 0x8e);
        c.writeDword(0xa020, 0x4000); c.writeDword(0xa024, 0x20202); c.writeDword(0xa038, 0xabcd8000);
        const uint16_t segments[] = {0x200,0,0,0x300,0x400,0x500};
        for (unsigned i = 0; i < std::size(segments); ++i) c.writeWord(0xa048 + i * 4, segments[i]);
        systemDescriptor(c, 0x50, 0xc000, 103, 0x89);
        c.writeDword(0xc020, 0x13000); c.writeDword(0xc024, 2); c.writeDword(0xc038, 0x1d0000);
        for (unsigned i = 0; i < 6; ++i) c.writeWord(0xc048 + i * 4, i == CS ? 8 : 0x10);
        gate(c, 0x8180, 0, 0x50, 0x85); c.mem[0x13000] = 0xcf; c.mem[0x4000] = 0x40; c.mem[0x4001] = 0xf4;
        c.step(); c.step();
        check(c.tr.selector == 0x40 && c.cpl == 3 && (c.eflags() & 0x20000) && c.r32(AX) == 0x89abcdf0,
            "A 386 TSS with VM set must enter 16-bit VM86 execution rather than interpreting its segments as selectors");
        c.irq = [once = false]() mutable { if (once) return -1; once = true; return 0x30; };
        c.step(); c.irq = {};
        check(c.tr.selector == 0x50 && c.cpl == 0 && !(c.eflags() & 0x20000)
            && (c.readDword(0xa024) & 0x20000) && c.readDword(0xa038) == 0xabcd8000
            && c.readWord(0xa058) == 0x400 && c.readWord(0xa05c) == 0x500,
            "A task-gate IRQ must save the VM86 task's VM flag, full ESP, FS and GS before loading protected code");
        c.step();
        check(c.tr.selector == 0x40 && c.cpl == 3 && (c.eflags() & 0x20000) && c.ip == 0x4001 && c.r32(AX) == 0x89abcdf0,
            "Nested-task IRETD must restore a VM86 task through its TSS");
        c.step();
        const uint8_t monitor[] = {0x68,2,0x40,0,0,0x9d,0xcf};
        std::copy(std::begin(monitor), std::end(monitor), c.mem.begin() + 0x12000);
        c.step(); c.step(); c.step();
        check(c.tr.selector == 0x38 && c.cpl == 0 && !(c.eflags() & 0x20000) && c.ip == 0x3007 && c.r32(AX) == 0x1234abcd,
            "A protected monitor may use nested-task IRETD to leave the VM86 task and restore its protected caller");
    }
    {
        auto c = systemMachine(); nextTask(c); gate(c, 0x8068, 0x12000, 8, 0x8e); gate(c, 0x8070, 0, 0x40, 0x85);
        c.writeDword(0x9004, 0x1f0004); c.writeDword(0xa01c, 0x10000); c.writeDword(0x1f0000, 0xfeedface);
        vm(c); vmCode(c, {0xfa}); paging(c);
        c.writeDword(0x207bc, 0); c.writeDword(0x207c0, 0x1f0003); c.step();
        check(c.tr.selector == 0x40 && c.cpl == 0 && c.ip == 0x5000 && c.cr2 == 0x1efffc
            && c.r32(SP) == 0x1dfffc && c.readDword(c.r32(SP)) == 2 && c.readDword(0x9020) == 0x4000
            && (c.readDword(0x9024) & 0x20000) && c.readDword(0x9038) == 0xabcd8000
            && c.readWord(0x9054) == 0x300 && c.readWord(0x9058) == 0x400 && c.readWord(0x905c) == 0x500
            && c.readDword(0x1f0000) == 0xfeedface,
            "A page fault during VM86 monitor-frame construction must restore VM state before a task-gate handler saves it");
        c.writeDword(0x207bc, 0x1ef007); c.writeDword(0x9004, 0x1f0000);
        const uint8_t handler[] = {0x83,0xc4,4,0xcf};
        std::copy(std::begin(handler), std::end(handler), c.mem.begin() + 0x5000); c.step(); c.step();
        check(c.tr.selector == 0x38 && c.cpl == 3 && (c.eflags() & 0x20000) && c.ip == 0x4000
            && c.r32(SP) == 0xabcd8000 && c.s[DS] == 0x300 && c.s[GS] == 0x500,
            "A task-gate page-fault handler must be able to return to the original VM86 faulting instruction");
    }
    {
        auto c = systemMachine(); bitmap(c); gate(c, 0x8068, 0x12000, 8, 0x8e);
        for (unsigned p = 7; p < 10; ++p) allowPort(c, p);
        vm(c); c.r[DX] = 7; c.r32(AX, 0x12345678); vmCode(c, {0x66,0xef});
        std::vector<std::pair<uint16_t,uint8_t>> writes; c.out = [&](uint16_t p, uint8_t v) { writes.emplace_back(p, v); };
        c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && writes.empty(), "Denied dword I/O must check every bit before touching any device byte");
        allowPort(c, 10); c.mem[0x12000] = 0x83; c.mem[0x12001] = 0xc4; c.mem[0x12002] = 4; c.mem[0x12003] = 0xcf;
        c.step(); c.step(); c.step();
        check(c.cpl == 3 && c.ip == 0x4002 && writes == std::vector<std::pair<uint16_t,uint8_t>>{{7,0x78},{8,0x56},{9,0x34},{10,0x12}},
            "Updating the TSS bitmap and retrying through IRETD must allow a cross-byte dword port operation");
    }
    for (unsigned mode = 0; mode < 4; ++mode) {
        auto c = systemMachine(); if (mode != 3) bitmap(c, mode == 2 ? 111 : 0x2068);
        gate(c, 0x8068, 0x12000, 8, 0x8e); vm(c, 0x3202);
        unsigned reads = 0; c.in = [&](uint16_t) { ++reads; return uint8_t(0x5a); };
        c.r[DX] = mode == 1 ? 0xffff : mode == 2 ? 56 : 0x60;
        if (mode == 1) allowPort(c, 0xffff);
        if (mode == 2) allowPort(c, 56);
        vmCode(c, {uint8_t(mode == 1 ? 0xed : 0xec)}); c.step();
        check(c.cpl == 0 && c.ip == 0x12000 && !reads && c.readDword(c.r32(SP)) == 0,
            "VM86 must consult the bitmap even at IOPL 3, including missing maps, the last map byte and port FFFF's guard bits");
    }
    {
        auto c = systemMachine(); bitmap(c); allowPort(c, 0xffff); vm(c);
        c.r[DX] = 0xffff; vmCode(c, {0xec}); unsigned reads = 0;
        c.in = [&](uint16_t p) { check(p == 0xffff, "Port byte must not wrap before I/O"); ++reads; return uint8_t(0x5a); };
        c.step();
        check(c.cpl == 3 && c.ip == 0x4001 && c.reg8(0) == 0x5a && reads == 1,
            "A permitted byte at port FFFF must not be rejected by the adjacent guard byte");
    }
    {
        auto c = systemMachine(); bitmap(c); allowPort(c, 0x60); allowPort(c, 0x61); user(c);
        c.r32(AX, 0xaabb0000); c.mem[0x4000] = 0x66; c.mem[0x4001] = 0xe5; c.mem[0x4002] = 0x60; unsigned reads = 0;
        c.in = [&](uint16_t p) { ++reads; return uint8_t(p + 0x20); }; c.step();
        check(c.cpl == 3 && !(c.eflags() & 0x20000) && c.r32(AX) == 0xaabb8180 && reads == 2,
            "Protected ring-3 word I/O must also use the 386 bitmap while preserving the upper EAX word");
    }
    {
        auto c = systemMachine(); bitmap(c); for (unsigned p = 7; p <= 10; ++p) allowPort(c, p);
        gate(c, 0x8068, 0x12000, 8, 0x8e); vm(c); c.r[DX] = 7; c.r[CX] = 2; c.r[SI] = 0x600;
        c.writeDword(0x3600, 0x12345678); vmCode(c, {0xf3,0x66,0x6f}); unsigned writes = 0;
        c.out = [&](uint16_t, uint8_t) { ++writes; }; c.step(); c.mem[0x9069] |= 4; c.step();
        check(c.cpl == 0 && writes == 4 && c.r[CX] == 1 && c.r[SI] == 0x604 && c.readDword(c.r32(SP) + 4) == 0x4000,
            "REP OUTSD must retain completed iterations but fault before the next denied iteration changes ports or indices");
    }
    {
        auto c = systemMachine(); bitmap(c); for (unsigned p = 7; p <= 10; ++p) allowPort(c, p);
        gate(c, 0x8070, 0x12000, 8, 0x8e); vm(c); c.r[DX] = 7; c.r[DI] = 0xffe;
        vmCode(c, {0x66,0x6d}); paging(c); c.writeDword(0x2000c, 0); c.writeDword(0x20024, 0x9003);
        c.writeWord(0x2ffe, 0xfeed); unsigned reads = 0; c.in = [&](uint16_t) { ++reads; return uint8_t(0x5a); }; c.step();
        check(c.cpl == 0 && !reads && c.cr2 == 0x3000 && c.readDword(c.r32(SP)) == 6
            && c.r[DI] == 0xffe && c.readWord(0x2ffe) == 0xfeed,
            "INS must prevalidate the complete VM86 destination before consuming device input or partially storing a dword");
    }
    {
        auto c = systemMachine(); bitmap(c); gate(c, 0x8070, 0x12000, 8, 0x8e);
        c.writeWord(0x9066, 0xfff); c.mem[0x9fff] = 0; vm(c); c.r[DX] = 0; vmCode(c, {0xec});
        paging(c); c.writeDword(0x20024, 0x9003); c.writeDword(0x20028, 0);
        unsigned reads = 0; c.in = [&](uint16_t) { ++reads; return uint8_t(0); }; c.step();
        check(c.cpl == 0 && !reads && c.cr2 == 0xa000 && c.readDword(c.r32(SP)) == 0,
            "I/O bitmap words must use supervisor paging and must not turn a missing bitmap page into permission or device input");
    }
    std::cout << "386 register alias / 32-bit code-data-stack / SIB / integer / paging foundation checks passed\n";
    std::cout << "386 gates / TSS stacks / call parameters / IRETD / paged task switches / fault rollback checks passed\n";
    std::cout << "386 VM86 entry-exit / sensitive instructions / interrupts / task gates / I/O bitmap / string I/O checks passed\n";
}
uint32_t read32(std::istream& f) {
    unsigned char b[4]{}; f.read(reinterpret_cast<char*>(b), 4);
    if (!f) throw std::runtime_error("Truncated test corpus");
    return uint32_t(b[0]) | (uint32_t(b[1]) << 8) | (uint32_t(b[2]) << 16) | (uint32_t(b[3]) << 24);
}
using Registers = std::array<uint16_t, 14>;
Registers registers(std::istream& f) {
    Registers r{}; for (auto& v : r) v = uint16_t(read32(f)); return r;
}
std::map<uint32_t, uint8_t> ram(std::istream& f) {
    std::map<uint32_t, uint8_t> result;
    auto n = read32(f); if (n > 1 << 20) throw std::runtime_error("Invalid corpus memory size");
    while (n--) { auto a = read32(f), v = read32(f); if (a >= 1 << 20 || v > 255) throw std::runtime_error("Invalid corpus memory"); result[a] = uint8_t(v); }
    return result;
}
int corpus(const char* path) {
    std::ifstream f(path, std::ios::binary); if (!f) throw std::runtime_error("Cannot open corpus");
    auto count = read32(f); Cpu c; std::set<uint32_t> written; c.onWrite = [&](uint32_t a) { written.insert(a); };
    unsigned failed = 0;
    for (unsigned t = 0; t < count; ++t) {
        auto mask = read32(f), exception = read32(f);
        auto initial = registers(f), final = registers(f); auto before = ram(f), after = ram(f);
        c.reset();
        for (int i = 0; i < 8; ++i) c.r[i] = initial[i];
        for (int i = 0; i < 4; ++i) c.s[i] = initial[8 + i];
        c.ip = initial[12]; c.flags = initial[13];
        for (const auto& [a,v] : before) c.mem[a] = v;
        written.clear();
        unsigned guard = 0; do { c.step(); } while (c.repContinue && ++guard < 1000000);
        bool bad = guard == 1000000;
        std::string detail;
        for (int i = 0; i < 14; ++i) {
            uint16_t actual = i < 8 ? c.r[i] : i < 12 ? c.s[i - 8] : i == 12 ? c.ip : c.flags;
            unsigned m = i == 13 ? mask : 65535;
            bool divException = exception && c.ip == uint32_t((before.count(0) ? before.at(0) : 0) | ((before.count(1) ? before.at(1) : 0) << 8));
            if (i == 13 && divException) m = 0;
            if ((actual & m) != (final[i] & m)) { bad = true; detail += " reg" + std::to_string(i) + "=" + std::to_string(actual) + " expected=" + std::to_string(final[i]); }
        }
        uint32_t flagAddr = ((uint32_t(c.s[SS]) << 4) + uint16_t(c.r[SP] + 4)) & 0xfffff;
        bool divException = exception && c.ip == uint32_t((before.count(0) ? before.at(0) : 0) | ((before.count(1) ? before.at(1) : 0) << 8));
        for (const auto& [a,v] : after) {
            unsigned m = divException && a == flagAddr ? 0 : divException && a == ((flagAddr + 1) & 0xfffff) ? 7 : 255;
            if ((c.mem[a] & m) != (v & m)) { bad = true; detail += " mem" + std::to_string(a) + "=" + std::to_string(c.mem[a]) + " expected=" + std::to_string(v); }
        }
        for (auto a : written) if (!after.count(a) && c.mem[a] != (before.count(a) ? before.at(a) : 0)) { bad = true; detail += " unexpected write " + std::to_string(a); }
        if (bad) { if (failed++ < 3) std::cerr << "case " << t << detail << '\n'; }
        for (const auto& [a,v] : before) { (void)v; c.mem[a] = 0; }
        for (auto a : written) c.mem[a] = 0;
    }
    std::cout << count - failed << '/' << count << " CPU cases passed\n"; return failed ? 1 : 0;
}
void protectedTests() {
    Cpu c; c.setModel(CpuModel::I286);
    auto real = [&] {
        c.reset(); for (auto seg : {ES, CS, SS, DS}) c.loadSegment(seg, 0);
        c.ip = 0x500; c.r[SP] = 0x1000;
    };
    auto emit = [&](std::initializer_list<uint8_t> bytes) {
        c.ip = 0x500; std::copy(bytes.begin(), bytes.end(), c.mem.begin() + 0x500);
    };
    real(); c.setFlags(0xffff);
    check((c.flags & 0xf000) == 0, "286 real-mode FLAGS must differ from 8088 CPU-detection bits");
    c.setFlags(2);
    emit({0x54}); c.step();
    check(c.r[SP] == 0xffe && c.rw(0, 0xffe) == 0x1000, "286 PUSH SP must push its original value");
    c.r[AX] = 3; emit({0xc1, 0xe0, 0x21}); c.step();
    check(c.r[AX] == 6, "286 immediate shifts must mask the shift count");
    emit({0xd1, 0xf0}); c.step();
    check(c.r[AX] == 12, "286 shift group /6 must alias SHL rather than 8088 SETMO");
    real(); c.r[AX] = 0x1234; c.r[BP] = 0x5678; emit({0x60, 0x61});
    c.step(); c.r[AX] = c.r[BP] = 0; c.step();
    check(c.r[AX] == 0x1234 && c.r[BP] == 0x5678 && c.r[SP] == 0x1000, "PUSHA / POPA must preserve registers and original SP");
    c.writeWord(0, 0x700); c.writeWord(2, 0); c.r[BX] = 0;
    emit({0xf7, 0xf3}); c.step();
    check(c.ip == 0x700 && c.rw(0, c.r[SP]) == 0x500, "286 divide faults must restart at the faulting instruction");

    real(); c.mem[0x10] = 0x11; c.mem[0x100010] = 0x22;
    check(c.rb(0xffff, 0x20) == 0x11, "Disabled A20 must wrap the high-memory alias");
    c.a20 = true;
    check(c.rb(0xffff, 0x20) == 0x22, "Enabled A20 must expose extended memory");
    for (unsigned i = 0; i < 4; ++i) {
        auto a = 0x836 + i * 6; c.writeWord(a, 0); c.mem[a + 2] = i == DS ? 0x12 : 0;
        c.mem[a + 3] = i == CS ? 0x92 : 0x93; c.writeWord(a + 4, 0xffff);
    }
    c.writeWord(0x806, 0); c.writeWord(0x818, 2); c.writeWord(0x81a, 0x600);
    c.mem[0x120010] = 0x5a; emit({0x0f, 5}); c.step();
    check(c.ip == 0x600 && c.rbS(DS, 0x10) == 0x5a, "LOADALL must restore hidden real-mode segment bases");
    c.loadSegment(DS, 0);
    check(c.rbS(DS, 0x10) == 0x11, "A real-mode segment reload must discard the LOADALL cache");
    c.r[AX] = 1; emit({0x0f, 1, 0xf0, 0x90}); c.step(); c.step();
    check(c.ip == 0x504 && c.protectedMode(), "Protected-mode entry must allow a LOADALL data-type CS cache to keep executing");
    real(); c.mem[0x83f] = 0x9b;
    c.writeWord(0x806, 9); c.writeWord(0x822, 3); c.mem[0x600] = 0x0f; c.mem[0x601] = 6;
    emit({0x0f, 5}); c.step(); c.step();
    check(c.protectedMode() && c.cpl == 0 && !(c.msw & 8),
        "LOADALL must derive CPL from cached access rights rather than the visible CS selector");

    real(); c.gdtr = {0x1000, 0x47}; c.idtr = {0x9000, 0x7ff};
    auto descriptor = [&](unsigned selector, unsigned base, uint16_t limit, uint8_t access) {
        auto a = c.gdtr.base + selector; c.writeWord(a, limit); c.writeWord(a + 2, uint16_t(base));
        c.mem[a + 4] = uint8_t(base >> 16); c.mem[a + 5] = access;
    };
    descriptor(8, 0x2000, 0xffff, 0x9a); descriptor(0x10, 0x3000, 0x1f, 0x92);
    descriptor(0x18, 0x4000, 0xffff, 0x92); descriptor(0x20, 0x6000, 0xffff, 0xfa);
    descriptor(0x28, 0x7000, 0xffff, 0xf2); descriptor(0x30, 0x8000, 0xffff, 0xf2);
    descriptor(0x38, 0xa000, 43, 0x81); descriptor(0x40, 0xb000, 43, 0x81);
    c.r[AX] = 1; emit({0x0f, 1, 0xf0, 0xea, 0, 0, 8, 0}); c.step(); c.step();
    check(c.protectedMode() && c.s[CS] == 8 && c.ip == 0, "LMSW and far jump must enter protected mode through a real descriptor");
    c.idtr.limit = 0;
    try { c.interrupt(13, 0); check(false, "An IDT-limit violation must fault"); }
    catch (const CpuFault& f) { check(f.vector == 13 && f.code == 0x6a, "CPU exception delivery must not set the external-event error bit"); }
    try { c.interrupt(0x40, -1, false, true); check(false, "An external IDT-limit violation must fault"); }
    catch (const CpuFault& f) { check(f.vector == 13 && f.code == 0x203, "Hardware interrupt delivery must set the external-event error bit"); }
    c.idtr.limit = 0x7ff;
    c.loadSegment(DS, 0x10); c.loadSegment(SS, 0x18); c.r[SP] = 0x1000;
    c.mem[0x3000] = 0x44; c.mem[0x5000] = 0x55; descriptor(0x10, 0x5000, 0x1f, 0x92);
    check(c.rbS(DS, 0) == 0x44, "Descriptor mutations must not change a loaded segment cache");
    c.loadSegment(DS, 0x10);
    check(c.rbS(DS, 0) == 0x55, "Reloading a selector must refresh its cached descriptor");
    auto gate = [&](unsigned vector, uint16_t offset, uint8_t access) {
        auto a = c.idtr.base + vector * 8; c.writeWord(a, offset); c.writeWord(a + 2, 8); c.mem[a + 5] = access;
    };
    gate(13, 0x100, 0x86); c.mem[0x2000] = 0xa1; c.writeWord(0x2001, 0x1f);
    c.step();
    check(c.ip == 0x100 && c.r[SP] == 0xff8 && c.rwS(SS, 0xff8) == 0 && c.rwS(SS, 0xffa) == 0,
        "Segment-limit faults must deliver #GP(0) with a restartable instruction pointer");
    c.ip = 0x200; c.mem[0x2200] = 0x0f; c.mem[0x2201] = 0; c.mem[0x2202] = 0xd8; c.r[AX] = 0x38;
    c.step(); c.writeWord(0xa002, 0x1000); c.writeWord(0xa004, 0x18);
    check(c.tr.selector == 0x38 && c.mem[0x103d] == 0x83, "LTR must cache the TSS and mark its descriptor busy");
    c.tr.selector = 0;
    c.push(0x33); c.push(0x1000); c.push(0x202); c.push(0x23); c.push(0);
    c.mem[0x2203] = 0xcf; c.step();
    check(c.cpl == 3 && c.s[CS] == 0x23 && c.s[SS] == 0x33 && c.r[SP] == 0x1000, "IRET must restore the outer-privilege stack");
    gate(0x30, 0x300, 0xe6); c.mem[0x6000] = 0xcd; c.mem[0x6001] = 0x30; c.mem[0x2300] = 0xcf;
    c.step();
    check(c.cpl == 0 && c.s[SS] == 0x18 && c.ip == 0x300 && c.r[SP] == 0xff6 && !(c.flags & IF),
        "An interrupt gate must use the hidden TSS cache even with a LOADALL-style zero TR selector");
    c.step();
    check(c.cpl == 3 && c.ip == 2 && c.r[SP] == 0x1000 && c.s[SS] == 0x33, "IRET must return from a privilege-changing interrupt");
    c.mem[0x6002] = 0xfa; c.step();
    check(c.cpl == 0 && c.ip == 0x100 && c.rwS(SS, c.r[SP] + 2) == 2, "Unprivileged CLI must fault without advancing IP");
    c.tr.selector = 0x38;
    c.ip = 0x400; c.mem[0x2400] = 0x9a; c.writeWord(0x2401, 0); c.writeWord(0x2403, 0x40);
    c.writeWord(0xb00e, 0x500); c.writeWord(0xb010, 2); c.writeWord(0xb01a, 0x1200);
    c.writeWord(0xb022, 0x10); c.writeWord(0xb024, 8); c.writeWord(0xb026, 0x18); c.writeWord(0xb028, 0x10);
    c.step();
    check(c.tr.selector == 0x40 && c.ip == 0x500 && (c.flags & 0x4000) && c.readWord(0xb000) == 0x38,
        "Nested task calls must save the old task and install the new TSS backlink");
    c.mem[0x2500] = 0xcf; c.step();
    check(c.tr.selector == 0x38 && c.ip == 0x405 && !(c.flags & 0x4000) && c.mem[0x1045] == 0x81,
        "Nested-task IRET must restore the previous task and clear the departed task's busy bit");
}
void atTests(CpuModel model) {
    Pc p; p.setModel(model); auto& c = p.cpu;
    c.loadSegment(CS, 0); c.ip = 0x500; c.mem[0x500] = 0xf4;
    c.r[SP] = 0x1000;
    for (auto number : {0x14, 0x16, 0x17}) {
        c.r[AX] = 0x6f00; c.r[BX] = 0;
        check(c.trap(uint8_t(number)) && c.r[BX] == 0 && c.r[AX] == 0x6f00, "HP-HIL probes must not advertise a nonexistent mouse interface");
    }
    c.r[AX] = 0x4340;
    check(c.trap(0x68) && c.r[AX] == 0x4340, "The resident-extender probe must report absence without claiming F386h");
    c.r[AX] = 0xde00; c.r[BX] = 0x1338;
    check(c.trap(0x67) && c.reg8(4) == 0x84 && c.r[BX] == 0x1338,
        "VCPI installation checks must report no provider instead of stopping Windows Setup or advertising a version");
    c.r[BX] = 0x510; c.mem[0x510] = 0x7f; c.r[AX] = 0;
    check(c.trap(0x5c) && c.r[AX] == 0, "An absent NetBIOS provider must not answer its presence probe");
    c.r[AX] = 0x8700; c.r[SI] = 0x600; c.r[CX] = 2;
    c.writeWord(0x610, 3); c.writeWord(0x612, 0x10); c.mem[0x614] = 0x10;
    c.writeWord(0x618, 3); c.writeWord(0x61a, 0x10); c.mem[0x61c] = 0x11;
    c.mem[0x100010] = 0x5a; c.mem[0x100013] = 0xa5;
    check(c.trap(0x15) && c.mem[0x110010] == 0x5a && c.mem[0x110013] == 0xa5 && !c.a20,
        "BIOS extended-memory copies must honor 24-bit descriptor bases and restore A20");
    c.r[AX] = 0x8700; c.r[CX] = 3; c.mem[0x110010] = 0;
    check(c.trap(0x15) && c.reg8(4) == 2 && (c.rw(0, 0x1004) & CF) && c.mem[0x110010] == 0,
        "BIOS extended-memory copies must reject descriptor-limit overruns before writing");
    c.out(0x64, 0xaa); check(c.in(0x64) & 1, "8042 self-test must set output-buffer-full");
    check(c.in(0x60) == 0x55 && !(c.in(0x64) & 1), "8042 self-test reply must drain the output buffer");
    c.out(0x64, 0xd1); c.out(0x60, 3);
    check(c.a20 && (c.in(0x92) & 2), "8042 output port must enable A20");
    c.out(0x92, 0); check(!c.a20, "Fast A20 port must update the memory gate");
    c.out(0x64, 0xd0); check(c.in(0x60) == 1, "Both A20 interfaces must report the same gate state");
    c.out(0x20, 0x20);
    c.out(0x21, 0xff); c.out(0xa1, 0xfe); c.out(0x70, 0x0b); c.out(0x71, 0x42);
    p.run(20);
    check(c.irq() == -1, "A masked master cascade must block slave RTC interrupts");
    c.out(0x21, 0xfb);
    check(c.irq() == 0x70 && c.irq() == -1, "RTC IRQ8 must traverse both PICs and respect in-service priority");
    c.out(0x70, 12); check((c.in(0x71) & 0xc0) == 0xc0 && c.in(0x71) == 0, "RTC status C must identify periodic IRQ and clear on read");
    c.out(0xa0, 0x20); c.out(0x20, 0x20);
    p.run(20); check(c.irq() == 0x70, "EOI on both PICs must permit the next RTC interrupt");
    c.out(0x70, 0x0b); c.out(0x71, 2);
    c.writeWord(0x467, 0x700); c.writeWord(0x469, 0);
    c.out(0x70, 15); c.out(0x71, 5); c.r[AX] = 0x1234; c.mem[0x800] = 0x5a;
    c.out(0x64, 0xfe); p.run(1);
    check(c.s[CS] == 0 && c.ip == 0x700 && !c.protectedMode() && c.r[AX] == 0x1234 && c.mem[0x800] == 0x5a,
        "AT warm reset must resume at the BDA return pointer without destroying RAM or registers");
    const uint16_t frame[] = {0x1234, 0x2345, 0x11, 0x22, 0x33, 0x9999, 0x44, 0x55, 0x66, 0x77, 0x900, 0, 0x202};
    for (unsigned i = 0; i < std::size(frame); ++i) c.writeWord(0x2100 + i * 2, frame[i]);
    c.writeWord(0x467, 0x100); c.writeWord(0x469, 0x200); c.out(0x70, 15); c.out(0x71, 9);
    c.idtr.limit = 0; c.mem[0x700] = 0xcc; p.run(1);
    check(c.s[CS] == 0 && c.ip == 0x900 && c.s[SS] == 0x200 && c.r[SP] == 0x11a
        && c.s[DS] == 0x1234 && c.s[ES] == 0x2345 && c.r[AX] == 0x77 && c.r[DI] == 0x11
        && c.r[BX] == 0x44 && (c.flags & IF) && !p.rebootRequested && c.mem[0x800] == 0x5a,
        "A deliberate triple fault must perform CMOS 09h's stack-based real-mode return instead of rebooting DOS");
}
void keyboardProbeTests() {
    for (auto model : {CpuModel::I8088, CpuModel::I286, CpuModel::I386, CpuModel::I486}) {
        Pc p; p.setModel(model); auto& c = p.cpu;
        auto irq1 = [&]() { c.reg8(0, c.in(0x60)); return c.trap(9); };
        c.r[SP] = 0x1000; c.r[BX] = 0x822a; c.r[CX] = 1;
        c.ww(0x40, 0x1a, 0x1e); c.ww(0x40, 0x1c, 0x20); c.ww(0x40, 0x1e, 0x1c0d);
        c.ww(0, 0x1004, 0xa55a);
        for (auto ax : {0xdb00, 0x55fe}) {
            for (auto dx : {0, 0xffff}) {
                c.r[AX] = uint16_t(ax); c.r[DX] = uint16_t(dx);
                auto before = c.r;
                check(c.trap(0x16) && c.r == before && c.rw(0, 0x1004) == 0xa55a,
                    "Absent ETen/QBASIC TSR probes must preserve registers and saved flags");
                check(c.rw(0x40, 0x1a) == 0x1e && c.rw(0x40, 0x1c) == 0x20 && c.rw(0x40, 0x1e) == 0x1c0d,
                    "Keyboard installation probes must not consume queued input");
            }
        }
        c.r[AX] = 0x7e00;
        bool rejected = false;
        try { c.trap(0x16); } catch (const std::runtime_error&) { rejected = true; }
        check(rejected, "Unimplemented keyboard services must still report an explicit error");
        c.ww(0x40, 0x1a, 0x1e); c.ww(0x40, 0x1c, 0x1e);
        p.key(1, 27); p.key(0x1e, 'a');
        check(c.irq() == 9 && c.in(0x60) == 1 && irq1() && c.rw(0x40, 0x1e) == 0x011b,
            "An EDIT-style IRQ1 hook must not swallow a key when it reads port 60h before chaining");
        c.out(0x20, 0x20);
        check(c.irq() == 9 && irq1() && c.rw(0x40, 0x20) == 0x1e61,
            "Chaining a peeked key must leave the following queued key for its own interrupt");
        c.out(0x20, 0x20); p.key(0x2d, 'x');
        check(c.irq() == 9 && c.in(0x60) == 0x2d, "A raw keyboard driver must still receive its scan code");
        c.out(0x20, 0x20); p.key(0x15, 'y');
        check(c.irq() == 9 && irq1() && c.rw(0x40, 0x22) == 0x1579,
            "A new IRQ1 must not reuse a previous driver's unchained key");
        for (auto scan : {0x38, 0xb8, 0x9e}) {
            auto tail = c.rw(0x40, 0x1c);
            c.out(0x20, 0x20); p.key(uint8_t(scan), 0);
            check(c.irq() == 9 && c.in(0x60) == scan && irq1() && c.rw(0x40, 0x1c) == tail,
                "Modifier and break scan codes must reach hooks without entering the BIOS character buffer");
            check((c.rb(0x40, 0x17) & 8) == (scan == 0x38 ? 8 : 0),
                "The BIOS must update Alt state inside IRQ1 so resident hooks observe its transition");
            if (scan == 0x38) {
                c.out(0x20, 0x20); p.key(0x21, 'f');
                check(c.irq() == 9 && irq1() && c.rw(0x40, tail) == 0x2100,
                    "Alt+letter must reach DOS menus as an extended BIOS key, not printable text");
            }
        }
        for (auto state : {0x2a02, 0x3603, 0xaa01, 0xb600, 0x3a40, 0x3a40, 0xba40, 0x3a00}) {
            c.out(0x20, 0x20); p.key(uint8_t(state >> 8), 0);
            check(c.irq() == 9 && irq1() && c.rb(0x40, 0x17) == uint8_t(state),
                "BIOS modifier handling must distinguish left/right Shift and suppress Caps Lock auto-repeat");
        }
    }
}
void apmTests(const std::filesystem::path& disk) {
    for (auto model : {CpuModel::I8088, CpuModel::I286, CpuModel::I386, CpuModel::I486}) {
        Pc p; p.setModel(model); p.hard = std::make_unique<Disk>(disk, false, false); p.boot(0x80);
        auto& c = p.cpu;
        auto call = [&](uint8_t function, uint16_t device, uint16_t value = 0) {
            c.loadSegment(CS, 0); c.loadSegment(SS, 0); c.r[SP] = 0x9000; c.ip = 0x500;
            c.halted = c.waiting = false; c.setFlags(CF | DF | 2);
            c.mem[0x500] = 0xcd; c.mem[0x501] = 0x15; c.mem[0x502] = 0xf4;
            c.r[AX] = uint16_t(0x5300 | function); c.r[BX] = device; c.r[CX] = value;
            p.runCpu(100);
            check((c.flags & DF) && (p.powerOffRequested || (c.halted && c.r[SP] == 0x9000)),
                "APM INT 15h must return through the guest interrupt frame preserving unrelated flags");
            return c.flags & CF ? c.reg8(4) : uint8_t(0);
        };
        if (model == CpuModel::I8088) {
            check(call(0, 0) == 0x86 && !p.powerOffRequested, "XT must not advertise AT APM support");
            continue;
        }
        check(call(0, 0) == 0 && c.r[AX] == 0x0102 && c.r[BX] == 0x504d && c.r[CX] == 0,
            "APM discovery must identify a real-mode-only BIOS without claiming protected-mode or idle throttling");
        check(call(0x10, 0) == 0 && c.reg8(3) == 0 && c.r[CX] == 0,
            "APM capabilities must be queryable before connection and advertise no batteries, standby or suspend");
        check(call(7, 1, 3) == 3 && !p.powerOffRequested, "Disconnected APM calls cannot power off");
        check(call(2, 0) == 6 && call(3, 0) == 8, "Unimplemented protected-mode APM interfaces must report unsupported");
        check(call(1, 0) == 0 && call(1, 0) == 2, "APM connection must reject duplicate connections");
        check(call(7, 1, 3) == 0x0a && !p.powerOffRequested, "APM 1.0 connections cannot request global power off");
        check(call(0x0e, 0, 0x0101) == 0 && c.r[AX] == 0x0101, "APM must negotiate the Windows 95 driver version");
        check(call(7, 0xffff, 3) == 9 && call(7, 1, 0) == 0x0a && !p.powerOffRequested,
            "Invalid APM device IDs and power states must not shut down the machine");
        check(call(7, 1, 1) == 0x60 && call(7, 1, 2) == 0x60 && !p.powerOffRequested,
            "Unsupported standby and suspend must fail explicitly without powering off");
        check(call(8, 1, 0) == 0 && call(7, 1, 3) == 1, "Disabled power management must reject shutdown");
        check(call(8, 1, 1) == 0 && call(0x0f, 1, 0) == 0 && call(7, 1, 3) == 0x0b,
            "Disengaged power management must reject shutdown");
        check(call(9, 1) == 0 && call(0x0b, 0) == 0x80, "APM defaults and empty event polling");
        check(call(0x0a, 1) == 0 && c.r[BX] == 0x01ff && c.r[CX] == 0x80ff && c.r[DX] == 0xffff,
            "Desktop APM status must report AC power and no system battery");
        check(call(0xff, 0) == 0x0c, "Unsupported APM functions must return an explicit BIOS error");
        check(call(4, 0) == 0 && call(4, 0) == 3, "APM disconnect must clear the connection");
        check(call(1, 0) == 0 && call(7, 1, 3) == 0x0a, "Reconnecting must reset the negotiated APM version");
        check(call(0x0e, 0, 0x0102) == 0 && call(8, 1, 1) == 0 && call(7, 1, 3) == 0 && p.powerOffRequested,
            "An enabled, connected APM driver must be able to request whole-machine power off");
        auto instructions = p.instructions; auto clock = p.clock;
        p.run(1000); p.runCpu(1000);
        ExecutionTiming timing; timing.reset(p);
        timing.advance(p, true, ExecutionTiming::HostClock::now() + std::chrono::seconds(1));
        check(p.instructions == instructions && p.clock == clock,
            "A powered-off core must not run guest instructions or advance scheduled device time");
        p.boot(0x80);
        check(!p.powerOffRequested && call(7, 1, 3) == 3, "Boot must clear both power-off and APM connection state");
    }
    std::cout << "APM real-mode discovery / connection / errors / Windows 95 power-off / explicit reboot checks passed\n";
}
void videoFirmwareTests(const std::filesystem::path& disk) {
    Pc p; auto& c = p.cpu;
    auto observed = std::make_unique<Vga>();
    auto input = c.in; auto output = c.out;
    c.in = [&](uint16_t port) { observed->input(port); return input(port); };
    c.out = [&](uint16_t port, uint8_t value) { observed->output(port, value); output(port, value); };
    p.hard = std::make_unique<Disk>(disk, false, false);
    for (auto model : {CpuModel::I8088, CpuModel::I286, CpuModel::I386, CpuModel::I486}) {
        p.setModel(model); p.boot(0x80); observed->setMode(3);
        const uint8_t camProbe[] = {0xa1,0x3c,1,0x0b,0x06,0x3e,1,0x74,5,0xb8,0,0x81,0xcd,0x4f,0xf4};
        c.halted = false; c.loadSegment(CS, 0); c.loadSegment(SS, 0); c.loadSegment(DS, 0);
        c.ip = 0x500; c.r[SP] = 0x9000;
        std::copy(std::begin(camProbe), std::end(camProbe), c.mem.begin() + 0x500);
        p.runCpu(100);
        check(c.halted && c.r[AX] == 0,
            "A guest CAM probe must see no resident SCSI provider and skip sending a CCB through INT 4Fh");
        c.halted = false; c.loadSegment(CS, 0); c.loadSegment(SS, 0); c.ip = 0x500;
        c.mem[0x500] = 0xcd; c.mem[0x501] = 0x68; c.mem[0x502] = 0xf4;
        c.r[SP] = 0x9000; c.r[AX] = 0x4f79; c.setFlags(CF | DF | 2);
        auto debugRegisters = c.r; auto debugFlags = c.flags;
        p.runCpu(100);
        check(c.halted && c.r == debugRegisters && c.flags == debugFlags,
            "An absent INT 68h debugger must preserve registers and flags through the firmware's empty IRET hook");
        c.halted = false; c.ip = 0x500; c.mem[0x501] = 0x0c;
        c.r[AX] = 0x0d83; c.r[BX] = 0xffff; c.r[CX] = 7; c.r[DX] = 0x069e;
        c.out(0x21, 0xed); c.out(0x3fc, 8); c.out(0x3f9, 2);
        check(c.irq() == 0x0c, "An unowned COM1 transmitter interrupt must reach the restored BIOS IRQ4 vector");
        auto serialRegisters = c.r; auto serialFlags = c.flags;
        p.runCpu(100);
        check(c.halted && c.r == serialRegisters && c.flags == serialFlags,
            "The default serial interrupt must return with caller registers and flags intact");
        check(c.in(0x21) == 0xfd && c.in(0x3fa) == 2,
            "The default serial interrupt must mask only IRQ4 without consuming the driver's UART state");
        c.out(0x20, 0x0b);
        check(c.in(0x20) == 0, "The default serial interrupt must acknowledge the PIC's in-service IRQ");
        p.key(0x1e, 'a');
        check(c.irq() == 9, "Masking an unowned serial interrupt must leave keyboard IRQ1 deliverable");
        c.in(0x60); c.out(0x20, 0x20); p.serialMouse.reset();
        for (uint16_t mode : {0x12, 0x93, 3}) {
            c.halted = false;
            c.loadSegment(CS, 0); c.loadSegment(SS, 0);
            c.loadSegment(DS, 0x1234); c.loadSegment(ES, 0x4321);
            c.ip = 0x500; c.mem[0x500] = 0xcd; c.mem[0x501] = 0x10; c.mem[0x502] = 0xf4;
            for (unsigned i = 0; i < c.r.size(); ++i) c.r[i] = uint16_t(0x1000 + i * 0x101);
            c.r[AX] = mode; c.r[SP] = 0x9000; c.setFlags(DF | CF | 2);
            auto registers = c.r; auto segments = c.s; auto flags = c.flags;
            p.runCpu(60000);
            check(c.halted && c.r == registers && c.s == segments && c.flags == flags,
                "Video firmware port programming must preserve registers, segments and caller flags");
            check(observed->seq == p.vga.seq && observed->gc == p.vga.gc && observed->crtc == p.vga.crtc
                && observed->attr == p.vga.attr && observed->dac == p.vga.dac && !p.vga.blanked(),
                "A guest I/O monitor must observe the complete BIOS mode transition, including return to text");
        }
        auto monitor = c.in;
        unsigned keyboardReads = 0;
        c.in = [&](uint16_t port) {
            if (port == 0x60) { ++keyboardReads; return uint8_t(0x1e); }
            return monitor(port);
        };
        c.halted = false; c.loadSegment(CS, 0); c.loadSegment(SS, 0);
        c.ip = 0x500; c.r[SP] = 0x9000; c.r[AX] = 0xa55a; c.setFlags(2);
        c.mem[0x500] = 0xcd; c.mem[0x501] = 9; c.mem[0x502] = 0xf4;
        c.ww(0x40, 0x1a, 0x1e); c.ww(0x40, 0x1c, 0x1e);
        p.runCpu(100);
        check(c.halted && keyboardReads == 1 && c.r[AX] == 0xa55a && c.rw(0x40, 0x1e) == 0x1e61,
            "IRQ1 ROM must read a monitor-provided scan code through guest IN and preserve AX");
        c.in = monitor;
        c.r[AX] = 0x1130; c.r[BX] = 0x600;
        check(c.trap(0x10), "ROM font query failed");
        auto font = (unsigned(c.s[ES]) << 4) + c.r[BP];
        bool ink = false;
        for (unsigned row = 0; row < 16; ++row) {
            ink |= c.readPhysical(font + 'A' * 16 + row) != 0;
            check(c.readPhysical(font + ' ' * 16 + row) == 0, "ROM space glyph must be blank");
        }
        check(font + 4096 <= 0x100000 && ink, "ROM graphics font must contain readable 8x16 glyphs inside the BIOS ROM");
        c.out(0x3c4, 4); c.out(0x3c5, 6);
        c.out(0x3ce, 6); c.out(0x3cf, 4); c.out(0x3ce, 4); c.out(0x3cf, 2);
        for (unsigned row = 0; row < 16; ++row)
            check(c.rb(0xa000, uint16_t('A' * 32 + row)) == c.readPhysical(font + 'A' * 16 + row),
                "Text-mode planar reads must expose VGA font plane 2 to DOS-window grabbers");
        for (uint16_t mode : {0x0d, 0x0e, 0x10, 0x12, 0x13}) {
            c.r[AX] = mode; c.trap(0x10);
            c.r[BX] = 0; c.r[DX] = 0; c.r[AX] = 0x0200; c.trap(0x10);
            c.r[BX] = 14; c.r[CX] = 1; c.r[AX] = 0x0941; c.trap(0x10);
            auto offset = c.rw(0, 0x10c), segment = c.rw(0, 0x10e);
            unsigned height = c.rw(0x40, 0x85); bool visible = false;
            for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < 8; ++x) {
                bool ink = c.rb(segment, uint16_t(offset + 'A' * height + y)) & (0x80 >> x);
                visible |= ink;
                check(p.vga.pixel(x, y) == (ink ? 14 : 0), "Graphics BIOS must use the mode's actual ROM font layout");
            }
            check(visible, "The selected graphics ROM font must contain visible glyphs");
        }
    }
}
void virtualVideoFirmwareTests(const std::filesystem::path& disk) {
    for (auto model : {CpuModel::I386, CpuModel::I486}) {
        Pc p; p.setModel(model); p.hard = std::make_unique<Disk>(disk, false, false); p.boot(0x80);
        auto& c = p.cpu; c.a20 = true;
        std::copy(c.mem.begin(), c.mem.begin() + 0x100000, c.mem.begin() + 0x200000);
        c.cr3 = 0x10000; c.writeDword(0x10000, 0x11007);
        for (unsigned i = 0; i < 256; ++i) c.writeDword(0x11000 + i * 4, (0x200000 + i * 4096) | 7);
        c.msw = 0x80000011; c.setEflags(0x23407); c.cpl = 3;
        for (auto seg : {ES, CS, SS, DS, FS, GS}) c.loadSegment(seg, 0);
        c.tr = {0x28, 0x12000, 0x2068, 0x89}; c.writeWord(0x212066, 0x68);
        p.vga.setMode(0x12); p.vga.pixel(0, 0, 9);
        auto observer = std::make_unique<Vga>(); observer->setMode(0x12);
        c.in = [&](uint16_t port) { return observer->input(port); };
        c.out = [&](uint16_t port, uint8_t value) { observer->output(port, value); };
        auto runMode = [&](uint16_t mode) {
            c.halted = false; c.waiting = false;
            c.loadSegment(CS, 0xf000); c.loadSegment(SS, 0);
            c.loadSegment(DS, 0x1234); c.loadSegment(ES, 0x4321);
            c.ip = 0x900; c.r[SP] = 0x9000; c.r[AX] = mode; c.setEflags(0x23407);
            auto registers = c.r; auto flags = c.flags;
            c.push(flags); c.push(0); c.push(0x500);
            unsigned steps = 0;
            while ((c.s[CS] != 0 || c.ip != 0x500) && steps++ < 60000) p.runCpu(1);
            check(c.s[CS] == 0 && c.ip == 0x500 && c.r == registers && c.flags == flags
                && c.s[DS] == 0x1234 && c.s[ES] == 0x4321,
                "VM86 mode firmware must return with caller registers, segments and flags intact");
            check(p.vga.graphics() && p.vga.width() == 640 && p.vga.height() == 480 && p.vga.pixel(0, 0) == 9,
                "A monitor-virtualized BIOS mode change must never reset or clear the physical desktop VGA");
        };
        c.writeWord(0x2b8000, 0x5a58); runMode(3);
        check(!observer->graphics() && c.mem[0x200449] == 3 && c.readWord(0x20044a) == 80
            && c.readWord(0x2b8000) == 0x0720 && c.readWord(0x2bfffe) == 0x0720,
            "Virtual text mode must program monitored ports and clear every guest text page");
        for (unsigned row = 0; row < 16; ++row)
            check(c.mem[0x2a0000 + 'A' * 32 + row] == c.mem[0x2f8000 + 'A' * 16 + row],
                "Virtual text mode must upload the ROM font through guest memory writes");
        c.writeWord(0x2b8000, 0x5a58); c.mem[0x2a0000 + 'A' * 32] = 0xff; runMode(0x83);
        check(c.readWord(0x2b8000) == 0x5a58 && c.mem[0x2a0000 + 'A' * 32] == c.mem[0x2f8000 + 'A' * 16],
            "No-clear text mode must preserve guest screen contents while still restoring the font");
        c.mem[0x2a0000] = c.mem[0x2affff] = 0x5a; runMode(0x13);
        check(observer->graphics() && observer->indexed256() && c.readWord(0x20044a) == 40
            && c.mem[0x2a0000] == 0 && c.mem[0x2affff] == 0,
            "Virtual graphics mode must use its own geometry and clear mapped guest VRAM");
        c.mem[0x2a0000] = 0x6c; runMode(0x93);
        check(c.mem[0x2a0000] == 0x6c, "No-clear virtual graphics mode must preserve guest VRAM");
    }
    std::cout << "VM86 virtual VGA mode / guest font upload / text-graphics clears / physical desktop isolation checks passed\n";
}
void pagedBiosTests(const std::filesystem::path& disk) {
    Pc p; p.setModel(CpuModel::I386); auto& c = p.cpu; c.a20 = true;
    p.hard = std::make_unique<Disk>(disk, false, false);
    c.cr3 = 0x10000; c.writeDword(0x10000, 0x11007);
    for (unsigned i = 0; i < 256; ++i) c.writeDword(0x11000 + i * 4, (0x200000 + i * 4096) | 7);
    c.msw = 0x80000011; c.setEflags(0x23002); c.cpl = 3;
    for (auto seg : {ES, CS, SS, DS, FS, GS}) c.loadSegment(seg, 0);
    c.r[SP] = 0x3000; c.writeWord(0x203004, 0x202);
    c.ww(0x40, 0x4a, 80); c.writeWord(0x20044a, 40); c.mem[0x200449] = 3;
    c.r[AX] = 0x0f00;
    check(c.trap(0x10) && c.r[AX] == 0x2803 && p.columns() == 80,
        "Firmware must use the guest BDA while host rendering retains physical display state");
    c.writeWord(0x20041a, 0x1e); c.writeWord(0x20041c, 0x20); c.writeWord(0x20041e, 0x1c0d);
    c.r[AX] = 0x0100;
    check(c.trap(0x16) && c.r[AX] == 0x1c0d && !(c.readWord(0x203004) & ZF) && c.rw(0x40, 0x1c) == 0,
        "VM86 keyboard BIOS must read mapped queue entries and update mapped interrupt-frame flags");
    c.reg8(0, 0x1e);
    check(c.trap(9) && c.readWord(0x200420) == 0x1e61 && c.readWord(0x20041c) == 0x22 && c.rw(0x40, 0x1c) == 0,
        "Firmware IRQ1 must accept a virtual scan code without host input and append to the mapped VM queue");
    c.reg8(0, 0x2a); c.trap(9); c.reg8(0, 0x1e); c.trap(9); c.reg8(0, 0xaa); c.trap(9);
    check(c.readWord(0x200422) == 0x1e41 && c.readWord(0x20041c) == 0x24 && c.mem[0x200417] == 0,
        "Virtual scan-code translation must use the current VM's Shift state and handle key releases");
    c.writeDword(0x20046c, 1234); c.writeDword(0x46c, 5678);
    check(c.trap(8) && c.readDword(0x20046c) == 1235 && c.readDword(0x46c) == 5678,
        "Firmware timer ticks must update the mapped BDA without corrupting another VM's memory");
    c.loadSegment(ES, 0x100); c.r[DX] = 0xff0;
    for (unsigned i = 0; i < 17; ++i) c.mem[0x201ff0 + i] = uint8_t(i * 3);
    c.r[AX] = 0x1002;
    check(c.trap(0x10) && p.vga.attr[15] == 45 && p.vga.attr[0x11] == 48,
        "Firmware palette buffers must follow guest page mappings across page boundaries");
    c.mem[0x2f8000] = 0x5a; c.writeWord(0x200485, 16); c.r[AX] = 0x1130;
    check(c.trap(0x10) && c.s[ES] == 0xf000 && c.rbS(ES, c.r[BP]) == 0x5a,
        "Firmware segment returns must reload VM86 segment caches");
    c.r[AX] = 0x1124; c.r[BX] = 0; c.r[DX] = 0xc01e;
    check(c.trap(0x10) && c.readWord(0x20010c) == 0x8000 && c.readWord(0x20010e) == 0xf000
        && c.mem[0x200484] == 29 && c.readWord(0x200485) == 16 && c.readDword(0x10c) == 0 && c.mem[0x484] == 0,
        "VM86 graphics font selection must update the mapped font vector and BDA, not physical page zero");
    p.vga.setMode(0x13);
    c.mem[0x200449] = 0x13; c.writeWord(0x20044a, 40); c.mem[0x200484] = 24; c.writeWord(0x200485, 8);
    c.writeWord(0x200450, 0); c.writeWord(0x20010c, 0x100); c.writeWord(0x20010e, 0x3000);
    for (unsigned row = 0; row < 8; ++row) c.mem[0x230100 + 'A' * 8 + row] = 0x80;
    c.r[BX] = 5; c.r[CX] = 1; c.r[AX] = 0x0941;
    check(c.trap(0x10) && p.vga.pixel(0, 0) == 5 && p.vga.pixel(1, 0) == 0,
        "VM86 graphics characters must read the mapped BDA, font vector and guest glyph bytes");
    c.mem[0x449] = 0x13; c.mem[0x200449] = 3; c.writeWord(0x20044a, 80); c.writeWord(0x200485, 16);
    c.mem[0x200462] = 0; c.writeWord(0x200450, 0);
    p.vga.pixel(0, 0, 9); p.vga.pixel(1, 0, 6);
    c.writeWord(0x2b8000, 0x0720); c.writeWord(0x2b8002, 0x0720);
    c.r[BX] = 2; c.r[CX] = 2; c.r[AX] = 0x0941;
    check(c.trap(0x10) && c.readWord(0x2b8000) == 0x0241 && c.readWord(0x2b8002) == 0x0241
        && p.vga.pixel(0, 0) == 9 && p.vga.pixel(1, 0) == 6,
        "A logical text VM must write mapped text cells instead of drawing over the physical graphics display");
    c.r[BX] = 0; c.r[AX] = 0x0800;
    check(c.trap(0x10) && c.r[AX] == 0x0241, "Logical text character reads must return the mapped text word");
    c.r[AX] = 0x0e42;
    check(c.trap(0x10) && c.readWord(0x2b8000) == 0x0242 && c.readWord(0x200450) == 1,
        "Logical text teletype must preserve attributes and update the VM cursor");
    c.r[BX] = 0x0700; c.r[CX] = 0; c.r[DX] = 1; c.r[AX] = 0x0600;
    check(c.trap(0x10) && c.readWord(0x2b8000) == 0x0720 && c.readWord(0x2b8002) == 0x0720
        && p.vga.pixel(0, 0) == 9 && p.vga.pixel(1, 0) == 6,
        "Logical text scrolling must not clear pixels on the physical graphics display");
    c.r[AX] = 0x0501;
    check(c.trap(0x10) && c.mem[0x200462] == 1 && p.vga.pixel(0, 0) == 9,
        "Logical text VMs must allow nonzero text pages while the physical VGA remains graphical");
    c.loadSegment(ES, 0x3000); c.r[BP] = 0x100;
    c.mem[0x230100] = 'C'; c.mem[0x230101] = 4; c.mem[0x230102] = 'D'; c.mem[0x230103] = 5;
    c.r[BX] = 0x100; c.r[CX] = 2; c.r[DX] = 0; c.r[AX] = 0x1303;
    check(c.trap(0x10) && c.readWord(0x2b9000) == 0x0443 && c.readWord(0x2b9002) == 0x0544
        && c.readWord(0x200452) == 2 && p.vga.pixel(0, 0) == 9,
        "Logical text strings must use mapped buffers and text pages rather than the physical graphics font");
    c.loadSegment(ES, 0x100); c.r[BX] = 0xfff; c.r[AX] = 0x0201; c.r[CX] = 1; c.r[DX] = 0x80;
    c.mem[0x474] = 0xcc;
    std::array<uint8_t, 512> sector{}; p.hard->read(0, sector.data());
    check(c.trap(0x13) && !(c.readWord(0x203004) & CF)
        && std::equal(sector.begin(), sector.end(), c.mem.begin() + 0x201fff) && c.mem[0x474] == 0xcc,
        "Firmware disk reads and status must target mapped guest buffers and BDA");
    for (unsigned i = 0; i < 512; ++i) c.mem[0x201fff + i] = uint8_t(i ^ 0xa5);
    c.r[AX] = 0x0301; c.r[CX] = 2;
    check(c.trap(0x13) && !(c.readWord(0x203004) & CF), "Mapped firmware disk write failed");
    p.hard->read(1, sector.data());
    check(std::equal(sector.begin(), sector.end(), c.mem.begin() + 0x201fff),
        "Firmware disk writes must read the VM's data rather than same-address physical RAM");
    c.mem[0x201fff] = 0x55; c.mem[0x202000] = 0x66; c.writeDword(0x11008, 0x202005);
    bool rejected = false;
    try { c.wwF(0x100, 0xfff, 0xabcd); }
    catch (const CpuFault& f) { rejected = f.vector == 14 && f.code == 7 && c.cr2 == 0x2000; }
    check(rejected && c.mem[0x201fff] == 0x55 && c.mem[0x202000] == 0x66,
        "Firmware word stores must prevalidate both guest pages before modifying memory");
    std::cout << "386 AT / paged VM86 BIOS / keyboard / timer / video / disk-buffer checks passed\n";
}
void graphicsBiosTests() {
    Pc p; auto& c = p.cpu;
    auto bios = [&](uint16_t ax) { c.r[AX] = ax; check(c.trap(0x10), "Graphics BIOS call was not handled"); };
    for (uint16_t mode : {0x0d, 0x0e, 0x10, 0x12, 0x13}) {
        bios(mode);
        unsigned height = c.rw(0x40, 0x85), columns = c.rw(0x40, 0x4a), rows = c.rb(0x40, 0x84) + 1;
        c.ww(0, 0x10c, 0x100); c.ww(0, 0x10e, 0x2000);
        for (unsigned y = 0; y < height; ++y) {
            c.wb(0x2000, uint16_t(0x100 + 'A' * height + y), uint8_t(y & 1 ? 0x24 : 0x81));
            c.wb(0x2000, uint16_t(0x100 + 'B' * height + y), 0x42);
        }
        c.r[BX] = 0; c.r[DX] = 0x0101; bios(0x0200);
        c.r[BX] = 0xa5; c.r[CX] = 2; bios(0x0941);
        uint8_t color = mode == 0x13 ? 0xa5 : 5;
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < 16; ++x) {
            bool ink = (y & 1 ? 0x24 : 0x81) & (0x80 >> (x & 7));
            check(p.vga.pixel(8 + x, height + y) == (ink ? color : 0),
                "Repeated graphics characters must use guest font bytes, clear background, and preserve 8-bit colors");
        }
        check(c.rw(0x40, 0x50) == 0x0101, "AH=09 must not advance the graphics cursor");
        c.r[BX] = 0; bios(0x0800);
        check(c.reg8(0) == 'A', "Graphics character readback must recognize the current font");
        p.vga.pixel(9, height, 2); bios(0x0800);
        check(c.reg8(0) == 0, "Graphics readback must not invent a character for unmatched pixels");
        c.r[BX] = 5; c.r[CX] = 1; bios(0x0a41);
        c.r[BX] = 0x83; bios(0x0941); bios(0x0941);
        check(p.vga.pixel(8, height) == (mode == 0x13 ? 0x83 : 5) && p.vga.pixel(9, height) == 0,
            "Planar XOR must restore the original glyph after two draws; 256-color mode must not XOR");
        c.r[BX] = 0; bios(0x0e41);
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < 8; ++x)
            check(p.vga.pixel(8 + x, height + y) == 0, "Graphics teletype must allow black foreground");
        auto stripes = [&]() {
            for (unsigned y = 0; y < 4 * height; ++y) for (unsigned x = 0; x < 24; ++x)
                p.vga.pixel(x, y, x >= 16 ? 9 : uint8_t(1 + y / height));
            c.r[CX] = 0; c.r[DX] = 0x0201; c.r[BX] = 0x0700;
        };
        stripes(); bios(0x0601);
        for (unsigned y = 0; y < 4 * height; ++y) for (unsigned x = 0; x < 24; ++x)
            check(p.vga.pixel(x, y) == (x >= 16 ? 9 : y >= 3 * height ? 4 : y >= 2 * height ? 7 : 2 + y / height),
                "Graphics upward scroll must copy overlapping rows and preserve pixels outside the window");
        stripes(); bios(0x0701);
        for (unsigned y = 0; y < 3 * height; ++y) for (unsigned x = 0; x < 16; ++x)
            check(p.vga.pixel(x, y) == (y < height ? 7 : y / height),
                "Graphics downward scroll must copy bottom-up and fill the exposed row");
        bios(0x0600);
        check(p.vga.pixel(0, 0) == 7 && p.vga.pixel(15, 3 * height - 1) == 7 && p.vga.pixel(16, 0) == 9,
            "Zero-line graphics scroll must clear only the selected window");
        c.r[BX] = 0; c.r[DX] = uint16_t(((rows - 1) << 8) | (columns - 1)); bios(0x0200);
        c.r[BX] = 5; bios(0x0e41);
        check(c.rw(0x40, 0x50) == (rows - 1) << 8
            && p.vga.pixel((columns - 1) * 8, (rows - 2) * height) == 5
            && p.vga.pixel((columns - 1) * 8, (rows - 1) * height) == 0,
            "Graphics teletype must wrap, scroll the glyph upward, and clear the bottom row");
        c.loadSegment(ES, 0x3000); c.r[BP] = 0xfffe;
        c.wb(0x3000, 0xfffe, 'A'); c.wb(0x3000, 0xffff, 3); c.wb(0x3000, 0, 'B'); c.wb(0x3000, 1, 4);
        c.ww(0x40, 0x50, 5); c.r[BX] = 0; c.r[CX] = 2; c.r[DX] = 0x0201; bios(0x1302);
        check(c.rw(0x40, 0x50) == 5 && p.vga.pixel(8, 2 * height) == 3 && p.vga.pixel(17, 2 * height) == 4,
            "Graphics strings must use embedded attributes, wrap the input offset, and restore the cursor");
        bios(0x1303);
        check(c.rw(0x40, 0x50) == 0x0203, "Graphics string cursor-update flag must be honored");
        c.r[BX] = 0x100; bool rejected = false;
        try { bios(0x0e41); } catch (const std::runtime_error&) { rejected = true; }
        check(rejected, "Unsupported nonzero graphics pages must still report an error");
    }
    bios(3); c.r[BX] = 0x200; c.r[DX] = 0; c.r[CX] = 2;
    c.ww(0x40, 0x54, 9); bios(0x1302);
    check(c.rw(0xb800, 8192) == 0x0341 && c.rw(0xb800, 8194) == 0x0442
        && c.rw(0x40, 0x54) == 9 && c.rw(0x40, 0x50) == 0 && p.activePage() == 0,
        "Text strings must write attributes on the requested page without changing the active page or its cursor");
    std::cout << "Graphics BIOS / guest fonts / XOR / scroll / teletype / character readback / strings checks passed\n";
}
void videoTests() {
    Pc p; auto& c = p.cpu;
    auto bios = [&](uint16_t ax) { c.r[AX] = ax; check(c.trap(0x10), "VGA BIOS call was not handled"); };
    c.r[DX] = 0xffff; c.r[BX] = 0x100; bios(0xef00);
    check(c.r[AX] == 0xef00 && c.r[DX] == 0xffff && c.r[BX] == 0x100,
        "EDIT's MSHERC probe must leave the not-installed sentinel unchanged");
    c.r[BX] = 0; c.r[DX] = 0x40; bios(0xfa40);
    check(c.r[BX] == 0 && c.r[AX] == 0xfa40 && c.r[DX] == 0x40,
        "EDIT's EGA RIL probe must report no resident register-interface driver");
    bios(0x12);
    c.r[BX] = 0x100; bios(0x1013); c.r[BX] = 0xa01; bios(0x1013);
    c.r[BX] = 0xffff; bios(0x101a);
    check(c.r[BX] == 0xa01 && p.vga.paletteIndex(1) == 0xa1,
        "16-color DAC page state must round-trip and select the displayed palette bank");
    c.r[BX] = 0; bios(0x1013); c.r[BX] = 0x301; bios(0x1013); bios(0x101a);
    check(c.r[BX] == 0x300 && p.vga.paletteIndex(1) == 0xc1,
        "64-color DAC paging must use color-select bits 2 and 3");
    c.r[BX] = 0x3f; bios(0x1018); c.r[BX] = 0xffff; bios(0x1019);
    check(c.r[BX] == 0x3f && p.vga.color(0xc1) == p.vga.color(1), "DAC mask save/restore must affect displayed colors");
    c.r[DX] = 0x600;
    for (unsigned i = 0; i < 17; ++i) c.wb(c.s[ES], uint16_t(0x600 + i), uint8_t(i * 3));
    bios(0x1002); c.r[DX] = 0x700; bios(0x1009); bios(0x1008);
    check(c.reg8(7) == 48 && c.rb(c.s[ES], 0x700) == 0 && c.rb(c.s[ES], 0x70f) == 45 && c.rb(c.s[ES], 0x710) == 48,
        "Palette save must include all sixteen entries and the separate overscan register");
    auto gc = [&](uint8_t index, uint8_t value) { c.out(0x3ce, index); c.out(0x3cf, value); };
    auto mask = [&](uint8_t value) { c.out(0x3c4, 2); c.out(0x3c5, value); };
    bios(0x13);
    check(p.vga.graphics() && p.columns() == 40 && c.rw(0x40, 0x85) == 8, "Mode 13h BIOS state");
    c.reset(); c.s[CS] = 0; c.s[ES] = 0xa000; c.ip = 0x500; c.r[DI] = 63999; c.r[AX] = 0x345a;
    c.mem[0x500] = 0xab; c.step();
    check(p.vga.pixel(319, 199) == 0x5a && c.rw(0xa000, 63999) == 0x345a, "STOSW must route both bytes through chain-4 VRAM");
    mask(1); c.ww(0xa000, 0, 0xabcd);
    check(p.vga.pixel(0, 0) == 0xcd && p.vga.pixel(1, 0) == 0, "Chain-4 sequencer plane mask");
    c.r[BX] = 0x5a; c.r[DX] = 63 << 8; c.r[CX] = (31 << 8) | 5; bios(0x1010);
    check(p.vga.color(0x5a) == 0xff7d14, "BIOS DAC colors must use six-bit components");
    c.out(0x3c8, 255); c.out(0x3c9, 255); c.out(0x3c9, 0); c.out(0x3c9, 1);
    check(c.in(0x3c8) == 0 && c.in(0x3c7) == 0, "DAC write auto-increment and state");
    c.out(0x3c7, 255);
    check(c.in(0x3c9) == 63 && c.in(0x3c9) == 0 && c.in(0x3c9) == 1 && c.in(0x3c7) == 3, "DAC readback and wrap");
    bios(0x93); check(p.vga.pixel(319, 199) == 0x5a, "No-clear mode set must retain VRAM");
    bios(0x12);
    check(p.vga.width() == 640 && p.vga.height() == 480 && c.rb(0x40, 0x84) == 29, "Mode 12h dimensions and text rows");
    const uint8_t patterns[] = {0xaa, 0xcc, 0xf0, 0x0f};
    for (unsigned plane = 0; plane < 4; ++plane) { mask(uint8_t(1 << plane)); c.wb(0xa000, 0, patterns[plane]); }
    for (unsigned plane = 0; plane < 4; ++plane) {
        gc(4, uint8_t(plane)); check(c.rb(0xa000, 0) == patterns[plane], "Planar read-map selection");
    }
    check(p.vga.pixel(0, 0) == 7 && p.vga.pixel(4, 0) == 11, "Planar color assembly");
    mask(15); gc(5, 1); c.rb(0xa000, 0); c.wb(0xa000, 1, 0);
    check(p.vga.pixel(8, 0) == 7 && p.vga.pixel(12, 0) == 11, "Write mode 1 must copy all four latches");
    gc(5, 2); gc(8, 0x80); c.rb(0xa000, 2); c.wb(0xa000, 2, 11);
    check(p.vga.pixel(16, 0) == 11 && p.vga.pixel(17, 0) == 0, "Write mode 2 color expansion and bit mask");
    gc(5, 3); gc(0, 5); gc(3, 1); gc(8, 255); c.rb(0xa000, 3); c.wb(0xa000, 3, 1);
    check(p.vga.pixel(24, 0) == 5 && p.vga.pixel(25, 0) == 0, "Write mode 3 rotation and set/reset");
    gc(5, 0); gc(0, 9); gc(1, 15); gc(3, 0x18); c.rb(0xa000, 3); c.wb(0xa000, 3, 0xff);
    check(p.vga.pixel(24, 0) == 12 && p.vga.pixel(25, 0) == 9, "Write mode 0 logical XOR with set/reset");
    gc(5, 8); gc(2, 9); gc(7, 15);
    check(c.rb(0xa000, 3) == 0x7f, "Read mode 1 color comparison");
    gc(5, 0); gc(0, 0); gc(1, 0); gc(3, 0); gc(4, 0); gc(6, 0x0d); mask(1);
    c.wb(0xb800, 0, 0x5a);
    check(c.rb(0xa000, 0) == 255 && c.rb(0xb800, 0) == 0x5a, "Graphics-controller aperture mapping");
    c.in(0x3da); c.out(0x3c0, 0x20 | 2); c.out(0x3c0, 4);
    check(p.vga.paletteIndex(2) == 4, "Attribute palette remapping");
    c.out(0x3c0, 7); c.in(0x3da); c.out(0x3c0, 0x20 | 2);
    check(c.in(0x3c1) == 4 && !p.vga.blanked(), "Status read must reset the attribute-controller flip-flop");
    c.r[BX] = 0; c.r[CX] = 639; c.r[DX] = 479; bios(0x0c0e); bios(0x0d00);
    check(c.reg8(0) == 14, "BIOS pixel write/read at the final visible pixel");
    bios(0x0c83); bios(0x0d00); check(c.reg8(0) == 13, "16-color BIOS XOR drawing");
    bool rejected = false; try { bios(0x11); } catch (const std::runtime_error&) { rejected = true; }
    check(rejected && p.vga.mode == 0x12, "Unsupported video modes must fail without changing the mode");
    bios(3); c.wb(0xb800, 0, 'V');
    check(!p.vga.graphics() && c.rb(0xb800, 0) == 'V' && c.rb(0xb800, 1) == 7, "Return to text mode and flat text VRAM");
    for (auto mode : {0x0d, 0x0e, 0x10, 0x12, 0x13}) {
        bios(uint16_t(mode)); p.vga.pixel(p.vga.width() - 1, p.vga.height() - 1, 15);
        check(p.vga.pixel(p.vga.width() - 1, p.vga.height() - 1) == 15, "Graphics mode stride and final row");
    }
    for (unsigned selector = 0; selector < 4; ++selector) {
        c.r[AX] = 0x1124; c.r[BX] = uint16_t(selector); c.r[CX] = 0; c.r[DX] = 0xc01e;
        auto registers = c.r; auto segments = c.s;
        check(c.trap(0x10) && c.r == registers && c.s == segments,
            "ROM graphics font selection must preserve caller registers");
        auto rows = selector == 0 ? 30 : selector == 1 ? 14 : selector == 2 ? 25 : 43;
        check(c.rb(0x40, 0x84) == rows - 1 && c.rw(0x40, 0x85) == 16,
            "ROM graphics font selection must honor custom and predefined row counts");
        auto offset = c.rw(0, 0x43 * 4), segment = c.rw(0, 0x43 * 4 + 2);
        c.r[BX] = 0x100; bios(0x1130);
        check(c.s[ES] == segment && c.r[BP] == offset && c.r[CX] == 16 && c.reg8(2) == rows - 1,
            "Current graphics font query must return INT 43 and the selected geometry");
    }
    auto vector = c.readDword(0x10c); auto rows = c.rb(0x40, 0x84);
    c.r[BX] = 4;
    rejected = false; try { bios(0x1124); } catch (const std::runtime_error&) { rejected = true; }
    check(rejected && c.readDword(0x10c) == vector && c.rb(0x40, 0x84) == rows,
        "Invalid graphics font selection must fail without modifying the current font");
    auto profile = std::make_unique<Vga>();
    auto restore = [&]() {
        for (unsigned i = 0; i < 5; ++i) { c.out(0x3c4, uint8_t(i)); c.out(0x3c5, profile->seq[i]); }
        for (unsigned i = 0; i < 9; ++i) gc(uint8_t(i), profile->gc[i]);
        for (unsigned i = 0; i < 25; ++i) { c.out(0x3d4, uint8_t(i)); c.out(0x3d5, profile->crtc[i]); }
    };
    bios(3); c.ww(0xb800, 0, 0x1f51); c.ww(0xb800, 2, 0x2e5a);
    c.out(0x3c4, 4); c.out(0x3c5, 6); gc(6, 4); gc(4, 0);
    check(c.rb(0xa000, 0) == 'Q' && c.rb(0xa000, 1) == 'Z',
        "Text characters must share the same plane-zero bytes seen by VGA save/restore code");
    gc(4, 1);
    check(c.rb(0xa000, 0) == 0x1f && c.rb(0xa000, 1) == 0x2e,
        "Text attributes must occupy contiguous plane-one bytes, not sparse CPU byte offsets");
    mask(1); c.wb(0xa000, 0, 'R'); profile->setMode(3); restore();
    check(c.rb(0xb800, 0) == 'R' && p.vga.textByte(0) == 'R',
        "Planar text restoration must update both guest odd/even reads and the host text display");
    const unsigned dimensions[][3] = {{0x0d,320,200},{0x0e,640,200},{0x10,640,350},{0x12,640,480},{0x13,320,200}};
    for (const auto& entry : dimensions) {
        bios(3); profile->setMode(uint8_t(entry[0])); restore();
        check(p.vga.mode == 3 && p.vga.graphics() && p.vga.width() == entry[1] && p.vga.height() == entry[2]
            && p.vga.indexed256() == (entry[0] == 0x13),
            "Direct VGA register restoration must select graphics, geometry and palette independently of BIOS metadata");
        c.wb(0xa000, 0, 0x80);
        check(p.vga.pixel(0, 0) == (entry[0] == 0x13 ? 0x80 : 15),
            "Register-restored graphics must route guest memory writes through the VGA planes");
        p.vga.pixel(entry[1] - 1, entry[2] - 1, 11);
        check(p.vga.pixel(entry[1] - 1, entry[2] - 1) == 11, "Restored graphics must address the final visible pixel");
        profile->setMode(3); restore(); c.wb(0xb800, 0, 'T');
        check(!p.vga.graphics() && p.vga.textByte(0) == 'T',
            "Direct text restoration must return guest text memory to the existing text display");
    }
}
void serialTests() {
    Pc p; auto& c = p.cpu;
    c.reset(); c.s[CS] = 0; c.ip = 0x500; c.mem[0x500] = 0xeb; c.mem[0x501] = 0xfe;
    c.out(0x21, 0xef);
    c.out(0x3fb, 0x80); c.out(0x3f8, 96); c.out(0x3f9, 0);
    check(c.in(0x3f8) == 96 && c.in(0x3f9) == 0, "COM1 divisor latch");
    c.out(0x3fb, 2); c.out(0x3f9, 1); c.out(0x3fc, 3);
    check(!(c.in(0x3fd) & 1), "Mouse identification must not arrive immediately");
    p.clock = p.serialMouse.nextEvent - 4; p.run(1);
    check(!(c.in(0x3fd) & 1), "Mouse identification must respect 1200-baud wire time");
    p.run(1);
    check((c.in(0x3fd) & 1) && c.irq() == -1, "OUT2 must gate the COM1 interrupt");
    c.out(0x3fc, 11);
    check(c.irq() == 12 && c.in(0x3fa) == 4 && c.in(0x3f8) == 'M', "COM1 mouse identification must interrupt on IRQ4");
    c.out(0x20, 0x20);
    check(c.in(0x2fd) == 255 && c.in(0x2f8) == 255, "Mouse must not be exposed on COM2");
    auto byte = [&]() {
        check(p.serialMouse.nextEvent < 1e100, "Missing scheduled serial byte");
        p.clock = p.serialMouse.nextEvent; p.run(1);
        check((c.in(0x3fd) & 1) && c.irq() == 12, "Each serial byte must produce IRQ4");
        auto value = c.in(0x3f8); c.out(0x20, 0x20); return value;
    };
    auto packet = [&](int expectedX, int expectedY, uint8_t expectedButtons) {
        unsigned header = byte(), x = byte(), y = byte();
        int dx = int8_t(uint8_t(((header & 3) << 6) | x));
        int dy = int8_t(uint8_t(((header & 12) << 4) | y));
        unsigned buttons = ((header >> 5) & 1) | ((header >> 3) & 2);
        check((header & 0x40) && !(x & 0xc0) && !(y & 0xc0)
            && dx == expectedX && dy == expectedY && buttons == expectedButtons, "Microsoft serial mouse packet");
    };
    p.serialMouse.motion(-130, 260, 3, p.clock);
    packet(-128, 127, 3); packet(-2, 127, 3); packet(0, 6, 3);
    p.serialMouse.motion(0, 0, 0, p.clock); packet(0, 0, 0);
    check(p.serialMouse.nextEvent > 1e100, "Idle mouse must not schedule continuous input");
    c.out(0x3fc, 9); c.out(0x3fc, 11);
    check(byte() == 'M', "RTS power cycle must identify the mouse again");
    c.out(0x3fc, 31); check((c.in(0x3fe) & 0xf0) == 0xf0, "8250 modem loopback inputs");
    c.out(0x3f8, 0x35);
    check(!(c.in(0x3fd) & 1), "UART loopback transmit must take virtual time");
    check(byte() == 0x35, "UART transmit/receive loopback");
    c.out(0x3f8, 0x33); p.clock = p.serialMouse.nextEvent; p.run(1);
    c.out(0x3f8, 0x44); p.clock = p.serialMouse.nextEvent; p.run(1);
    check((c.in(0x3fd) & 3) == 3 && !(c.in(0x3fd) & 2) && c.in(0x3f8) == 0x33, "8250 overrun status and unread-byte retention");
    p.serialMouse.reset(); c.r[DX] = 0; c.r[AX] = 0x0082;
    check(c.trap(0x14) && c.reg8(4) == 0x60, "BIOS COM1 initialization status");
    c.out(0x3fb, 0x80); check(c.in(0x3f8) == 96, "BIOS must configure COM1 at 1200 baud");
    c.out(0x3fb, 2); c.out(0x3f9, 1);
    c.out(0x20, 0x13); c.out(0x21, 8); c.out(0x21, 1); c.out(0x21, 0xef);
    const uint8_t handler[] = {0x50,0x52,0xba,0xf8,3,0xec,0xa2,0,6,0xb0,0x20,0xe6,0x20,0x5a,0x58,0xcf};
    std::copy(std::begin(handler), std::end(handler), c.mem.begin() + 0x700);
    c.ww(0, 12 * 4, 0x700); c.ww(0, 12 * 4 + 2, 0);
    c.s[SS] = 0; c.r[SP] = 0x8000; c.flags |= IF;
    c.out(0x3fc, 11); p.run(50000);
    check(c.mem[0x600] == 'M' && c.r[SP] == 0x8000, "Guest IRQ4 handler must read COM1 and return through IRET");
}
void ideTests(const std::filesystem::path& path) {
    for (auto model : {CpuModel::I286, CpuModel::I386, CpuModel::I486}) {
        Pc p; p.setModel(model); auto& c = p.cpu;
        p.hard = std::make_unique<Disk>(path, false, false);
        for (auto seg : {ES, CS, SS, DS}) c.loadSegment(seg, 0);
        c.setFlags(2); c.r[SP] = 0x8000;
        c.out(0x21, 0xfb); c.out(0xa1, 0xbf);
        auto tick = [&]() { p.advanceClock(p.clock + 120); };
        auto acknowledge = [&]() { c.in(0x1f7); c.out(0xa0, 0x20); c.out(0x20, 0x20); };
        auto address = [&](uint32_t lba, uint8_t count) {
            c.out(0x1f6, uint8_t(0xe0 | (lba >> 24))); c.out(0x1f2, count); c.out(0x1f3, uint8_t(lba));
            c.out(0x1f4, uint8_t(lba >> 8)); c.out(0x1f5, uint8_t(lba >> 16));
        };
        c.out(0x1f7, 0xec);
        check(c.in(0x3f6) == 0x80 && c.irq() == -1, "ATA must remain busy and defer IRQ14 until command completion");
        p.advanceClock(p.clock + 119);
        check(c.in(0x3f6) == 0x80 && c.irq() == -1, "ATA completion must respect its device-clock deadline");
        p.advanceClock(p.clock + 1);
        check(c.in(0x3f6) == 0x58 && c.irq() == 0x76 && c.irq() == -1, "ATA DRQ must raise IRQ14 through both PICs exactly once");
        acknowledge();
        std::array<uint16_t, 256> identity{};
        for (auto& word : identity) word = uint16_t(c.inputPort(0x1f0, 2));
        check((uint32_t(identity[61]) << 16 | identity[60]) == p.hard->sectors && (identity[49] & 0x300) == 0x200
            && c.in(0x3f6) == 0x50, "ATA IDENTIFY must expose the mounted disk's capacity and PIO/LBA, but not DMA");
        c.out(0x21, 0xff); c.out(0xa1, 0xff);
        auto run = [&](std::vector<uint8_t> code) {
            std::copy(code.begin(), code.end(), c.mem.begin() + 0x500); c.ip = 0x500; c.halted = false;
            p.runCpu(1000);
            check(c.halted, "ATA guest PIO program did not halt");
        };
        for (unsigned width : {2u, 4u}) {
            if (width == 4 && !c.supports386()) continue;
            std::array<uint8_t, 512> expected{};
            for (unsigned i = 0; i < expected.size(); ++i) expected[i] = uint8_t(i * 37 + width);
            std::copy(expected.begin(), expected.end(), c.mem.begin() + 0x4000);
            address(100 + width, 1); c.out(0x1f7, 0x30);
            check(c.in(0x3f6) == 0x58, "ATA first write block must request data without an initial completion interrupt");
            c.r[DX] = 0x1f0; c.r[SI] = 0x4000; c.r[CX] = uint16_t(512 / width);
            run(width == 2 ? std::vector<uint8_t>{0xf3,0x6f,0xf4} : std::vector<uint8_t>{0x66,0xf3,0x6f,0xf4});
            check(c.in(0x3f6) == 0x80, "ATA write must report busy until its completion deadline");
            tick(); c.in(0x1f7);
            check(c.in(0x3f6) == 0x50 && c.in(0x1f2) == 0, "A complete PIO write must consume the sector count");
            address(100 + width, 1); c.out(0x1f7, 0x20); tick(); c.in(0x1f7);
            c.r[DI] = 0x5000; c.r[CX] = uint16_t(512 / width);
            run(width == 2 ? std::vector<uint8_t>{0xf3,0x6d,0xf4} : std::vector<uint8_t>{0x66,0xf3,0x6d,0xf4});
            check(std::equal(expected.begin(), expected.end(), c.mem.begin() + 0x5000),
                "REP INSW/INSD and OUTSW/OUTSD must transfer complete words at the same ATA data port, not adjacent task-file registers");
            c.out(0x1f7, 0xe7); tick(); c.in(0x1f7);
            p.hard.reset();
            {
                Disk reopened(path, false, true); std::array<uint8_t, 512> actual{};
                check(reopened.read(100 + width, actual.data()) && actual == expected,
                    "PIO writes and FLUSH CACHE must persist through closing and reopening the disk");
            }
            p.hard = std::make_unique<Disk>(path, false, false);
        }
        c.out(0x1f6, 0xa0); c.out(0x1f2, 1); c.out(0x1f3, 40); c.out(0x1f4, 0); c.out(0x1f5, 0);
        std::array<uint8_t, 512> chs{}; chs[0] = 0x34; chs[1] = 0x12; check(p.hard->write(39, chs.data()), "Cannot prepare CHS sector");
        c.out(0x1f7, 0x20); tick(); c.in(0x1f7); c.r[DX] = 0x1f0;
        run({0xed,0xf4});
        check(c.r[AX] == 0x1234, "IN AX,DX must use a single ATA word transfer and support CHS addressing");
        for (unsigned i = 1; i < 256; ++i) c.inputPort(0x1f0, 2);
        c.out(0x1f2, 16); c.out(0x1f7, 0xc6); tick(); c.in(0x1f7);
        address(200, 18); c.out(0x1f7, 0xc5);
        for (unsigned sector = 0; sector < 18; ++sector) {
            if (sector == 16) { check(c.in(0x3f6) == 0x80, "WRITE MULTIPLE must delay the next block"); tick(); c.in(0x1f7); }
            for (unsigned i = 0; i < 256; ++i) c.outputPort(0x1f0, 0x8000 + sector, 2);
        }
        tick(); c.in(0x1f7); address(200, 18); c.out(0x1f7, 0xc4); tick(); c.in(0x1f7);
        for (unsigned sector = 0; sector < 18; ++sector) {
            if (sector == 16) { check(c.in(0x3f6) == 0x80 && c.in(0x1f2) == 2, "READ MULTIPLE must handle a partial final block"); tick(); c.in(0x1f7); }
            for (unsigned i = 0; i < 256; ++i)
                check(c.inputPort(0x1f0, 2) == 0x8000 + sector, "READ/WRITE MULTIPLE must preserve every sector's data across blocks");
        }
        address(300, 0); c.out(0x1f7, 0xc4);
        for (unsigned block = 0; block < 16; ++block) {
            tick(); c.in(0x1f7);
            for (unsigned i = 0; i < 16 * 256; ++i) c.inputPort(0x1f0, 2);
        }
        check(c.in(0x3f6) == 0x50 && c.in(0x1f2) == 0 && c.in(0x1f3) == uint8_t(555),
            "An ATA sector count of zero must transfer 256 sectors, not zero");
        address(p.hard->sectors, 1); c.out(0x1f7, 0x20); tick();
        check((c.in(0x1f7) & 9) == 1 && c.in(0x1f1) == 0x10, "Out-of-range ATA sectors must report IDNF without DRQ");
        c.out(0x1f7, 0xc8); tick();
        check((c.in(0x1f7) & 1) && c.in(0x1f1) == 4, "Unsupported ATA DMA commands must report ABRT, not successful completion");
        c.out(0x1f6, 0xb0);
        check(c.in(0x1f7) == 0, "The unmounted ATA slave must not impersonate a second disk");
        c.out(0x1f6, 0xa0); c.out(0x21, 0xfb); c.out(0xa1, 0xbf);
        c.out(0x3f6, 2); c.out(0x1f7, 0xec); tick();
        check(c.irq() == -1 && c.in(0x3f6) == 0x58, "ATA nIEN must mask IRQ14 without suppressing command completion");
        c.out(0x3f6, 0);
        check(c.irq() == 0x76, "Reenabling ATA interrupts must expose a pending completion");
        acknowledge();
        c.out(0x3f6, 4); check(c.in(0x3f6) == 0x80, "ATA SRST must assert busy");
        c.out(0x3f6, 0); tick();
        check(c.in(0x1f7) == 0x50 && c.in(0x1f1) == 1 && c.in(0x1f2) == 1 && c.in(0x1f3) == 1
            && c.in(0x1f4) == 0 && c.in(0x1f5) == 0 && c.inputPort(0x1f0, 2) == 0xffff,
            "ATA software reset must restore its signature and discard any interrupted transfer");
        p.hard.reset(); p.hard = std::make_unique<Disk>(path, false, true);
        address(100, 1); c.out(0x1f7, 0x30); tick();
        check((c.in(0x1f7) & 9) == 1 && c.in(0x1f1) == 4, "ATA writes to read-only media must fail before accepting data");
    }
    std::cout << "ATA PIO / CHS-LBA / IRQ14 / word-dword I/O / multi-sector / reset / disk-persistence checks passed\n";
}
void atapiTests(const std::filesystem::path& path) {
    std::vector<uint8_t> expected(4096);
    for (unsigned i = 0; i < expected.size(); ++i) expected[i] = uint8_t(i * 19 + i / 2048);
    {
        Disk fixture(path, false, false);
        for (unsigned i = 0; i < expected.size() / 512; ++i)
            check(fixture.write(64 + i, expected.data() + i * 512), "Cannot prepare synthetic optical sectors");
        fixture.flush();
    }
    Pc p; p.setModel(CpuModel::I486); auto& c = p.cpu; p.cdrom.insert(path);
    auto tick = [&]() { p.advanceClock(p.clock + 120); };
    auto acknowledge = [&]() { c.in(0x177); c.out(0xa0, 0x20); c.out(0x20, 0x20); };
    c.out(0x21, 0xfb); c.out(0xa1, 0x7f);
    check(c.in(0x174) == 0x14 && c.in(0x175) == 0xeb && c.in(0x1f7) == 0,
        "The secondary ATAPI master must expose its signature independently of the primary ATA channel");
    c.out(0x177, 0xec); tick();
    check(c.in(0x376) == 0x41 && c.in(0x171) == 4 && c.irq() == 0x77,
        "ATA IDENTIFY must abort on an ATAPI device and deliver IRQ15, not IRQ14");
    acknowledge(); c.out(0x177, 0xa1); tick();
    check(c.irq() == 0x77 && c.in(0x172) == 2, "IDENTIFY PACKET DEVICE must report a device-to-host data phase");
    acknowledge();
    auto config = c.inputPort(0x170, 2);
    for (unsigned i = 1; i < 256; ++i) c.inputPort(0x170, 2);
    check(config == 0x8580 && c.in(0x376) == 0x50, "ATAPI IDENTIFY must describe a removable CD-ROM using polled 12-byte packets");
    c.out(0x21, 0xff); c.out(0xa1, 0xff);
    auto send = [&](std::array<uint8_t, 12> packet, unsigned limit = 2048) {
        c.out(0x171, 0); c.out(0x174, uint8_t(limit)); c.out(0x175, uint8_t(limit >> 8)); c.out(0x177, 0xa0);
        check(c.in(0x376) == 0x80, "ATAPI PACKET must defer its DRQ phase");
        tick();
        check(c.in(0x376) == 0x48 && c.in(0x172) == 1, "ATAPI PACKET must request a command packet, not data");
        for (unsigned i = 0; i < packet.size(); i += 2)
            c.outputPort(0x170, packet[i] | (uint32_t(packet[i + 1]) << 8), 2);
        tick();
    };
    auto receive = [&]() {
        std::vector<uint8_t> data;
        for (unsigned block = 0; block < 4096; ++block) {
            auto status = c.in(0x376);
            if (status & 0x80) { tick(); continue; }
            c.in(0x177);
            if (!(status & 8)) return data;
            auto count = unsigned(c.in(0x174)) | (unsigned(c.in(0x175)) << 8);
            check(count && c.in(0x172) == 2, "ATAPI data phases must report their actual payload byte count and direction");
            for (unsigned i = 0; i < count;) {
                unsigned width = count - i >= 4 ? 4 : 2;
                auto value = c.inputPort(0x170, width);
                for (unsigned k = 0; k < width && i + k < count; ++k) data.push_back(uint8_t(value >> (k * 8)));
                i += width;
            }
        }
        throw std::runtime_error("ATAPI test transfer did not complete");
    };
    send({0}); receive();
    check(c.in(0x376) == 0x41 && c.in(0x172) == 3, "A newly inserted disc must report unit attention before ordinary commands");
    send({3,0,0,0,18});
    auto data = receive();
    check(data.size() == 18 && data[2] == 6 && data[12] == 0x28, "REQUEST SENSE must preserve and report media-change attention");
    send({0}); receive();
    check(c.in(0x376) == 0x50, "TEST UNIT READY must succeed after acknowledging media change");
    send({0x25}); data = receive();
    auto last = p.cdrom.medium()->sectors - 1;
    check(data.size() == 8 && ((uint32_t(data[0]) << 24) | (uint32_t(data[1]) << 16) | (uint32_t(data[2]) << 8) | data[3]) == last
        && data[6] == 8 && data[7] == 0, "READ CAPACITY must report the mounted image's 2048-byte blocks in big-endian order");
    send({0x28,0,0,0,0,16,0,0,2}, 510); data = receive();
    check(data == expected && c.in(0x172) == 3, "READ(10) must reconstruct complete ISO data across host-limited transfer phases");
    send({0xa8,0,0,0,0,16,0,0,0,2}, 127); data = receive();
    check(data == expected, "READ(12) must preserve every byte across odd-sized transfer chunks and padded data words");
    send({0x12,0,0,0,35}, 7); data = receive();
    check(data.size() == 35 && data[0] == 5 && std::string(data.begin() + 8, data.begin() + 13) == "ASM86",
        "INQUIRY must obey odd allocation lengths and short host transfer limits");
    send({3,0,0,0,0}); data = receive();
    check(data.empty() && c.in(0x376) == 0x50, "A zero SCSI allocation length must not accidentally transfer an entire response");
    std::array<uint8_t, 12> invalid{0x28};
    auto outside = p.cdrom.medium()->sectors;
    for (unsigned i = 0; i < 4; ++i) invalid[2 + i] = uint8_t(outside >> ((3 - i) * 8));
    invalid[8] = 1; send(invalid); receive();
    send({3,0,0,0,18}); data = receive();
    check(data.size() == 18 && data[2] == 5 && data[12] == 0x21, "Out-of-range optical reads must return illegal-request sense, not padded success data");
    send({0x43,0,0,0,0,0,0xaa,0,12}); data = receive();
    check(data.size() == 12 && data[6] == 0xaa, "READ TOC starting at lead-out must not return track one in its place");
    send({0x1e,0,0,0,1}); receive();
    bool denied = false;
    try { p.cdrom.eject(); } catch (const std::runtime_error&) { denied = true; }
    check(denied && p.cdrom.medium(), "Host media changes must respect a guest's medium-removal lock");
    send({0x1b,0,0,0,2}); receive();
    send({3,0,0,0,18}); data = receive();
    check(data.size() == 18 && data[2] == 5 && data[12] == 0x53 && data[13] == 2,
        "Guest eject must report medium-removal-prevented sense while locked");
    send({0x1e,0,0,0,0}); receive(); send({0x1b,0,0,0,2}); receive();
    check(!p.cdrom.medium(), "Unlocking and guest eject must actually release the mounted ISO");
    send({0}); receive(); send({3,0,0,0,18}); data = receive();
    check(data.size() == 18 && data[2] == 2 && data[12] == 0x3a, "An empty optical drive must report no-medium sense");
    c.out(0x376, 4); c.out(0x376, 0); tick();
    check(c.in(0x174) == 0x14 && c.in(0x175) == 0xeb && c.in(0x171) == 1,
        "ATAPI software reset must restore its signature even without media");
    std::cout << "ATAPI / IRQ15 / packet phases / ISO streaming / host limits / sense / TOC / media-lock checks passed\n";
}
void softfloatTests() {
    using Op = FloatOperation;
    const Float80 one{0x8000000000000000ull,0x3fff}, tiny{0x8000000000000000ull,0x3fc0};
    auto sum = calculateFloat(Op::Add, one, tiny);
    check(sum.value == Float80{0x8000000000000001ull,0x3fff} && !sum.flags
        && calculateFloat(Op::Subtract, sum.value, one).value == tiny,
        "Native arithmetic must preserve all 64 extended significand bits rather than narrowing to host double");
    const Float80 halfUlp{0x8000000000000000ull,0x3fe7};
    auto nearest = calculateFloat(Op::Add, one, halfUlp, 0x007f);
    auto upward = calculateFloat(Op::Add, one, halfUlp, 0x087f);
    check(nearest.value == one && nearest.flags == 0x20 && upward.value == Float80{0x8000010000000000ull,0x3fff}
        && upward.flags == 0x220, "Single-precision x87 control must round ties to even and expose C1 when directed rounding increases magnitude");
    check(calculateFloat(Op::Add, one, tiny, 0x027f).value == one
        && calculateFloat(Op::Subtract, one, one, 0x077f).value == Float80{0,0x8000},
        "Precision and rounding control must also preserve the architectural sign of an exact zero");
    const Float80 fraction{0xc000000000000000ull,0x3fff};
    for (auto control : {0x037f,0x077f,0x0b7f,0x0f7f}) {
        auto value = calculateFloat(Op::ToInteger64, fraction, {}, uint16_t(control));
        check(value.value.significand == uint64_t(control == 0x037f || control == 0x0b7f ? 2 : 1)
            && (value.flags & 0x20), "Integer conversions must obey all four x87 rounding directions and signal precision loss");
    }
    auto integer = calculateFloat(Op::FromInteger64, {9007199254740993ull,0});
    check(integer.value == Float80{0x8000000000000400ull,0x4034}
        && calculateFloat(Op::ToInteger64, integer.value).value.significand == 9007199254740993ull,
        "Signed integer conversions must round-trip values beyond binary64's exact integer range");
    auto minimum = calculateFloat(Op::FromInteger64, {0x8000000000000000ull,0});
    auto overflow = calculateFloat(Op::ToInteger64, {0x8000000000000000ull,0x403e});
    check(minimum.value == Float80{0x8000000000000000ull,0xc03e}
        && calculateFloat(Op::ToInteger64, minimum.value).flags == 0
        && overflow.value.significand == 0x8000000000000000ull && (overflow.flags & 1),
        "The signed 64-bit minimum must remain exact while positive overflow reports integer indefinite and invalid operation");
    auto divide = calculateFloat(Op::Divide, one, {});
    auto invalid = calculateFloat(Op::SquareRoot, {0x8000000000000000ull,0xbfff});
    auto unordered = calculateFloat(Op::Compare, {0xc000000000000000ull,0x7fff}, one);
    check(divide.value == Float80{0x8000000000000000ull,0x7fff} && (divide.flags & 4)
        && invalid.value == Float80{0xc000000000000000ull,0xffff} && (invalid.flags & 1)
        && unordered.value.significand == 0x4500,
        "Native SoftFloat must preserve division-by-zero, invalid-operation and unordered comparison results");
    const Float80 huge{0x8000000000000000ull,0x7ffe}, smallest{0x8000000000000000ull,1};
    auto masked = calculateFloat(Op::Multiply, huge, huge);
    auto wrapped = calculateFloat(Op::Multiply, huge, huge, 0x0377);
    auto underflow = calculateFloat(Op::Multiply, smallest, smallest, 0x036f);
    check(masked.value == Float80{0x8000000000000000ull,0x7fff} && (masked.flags & 0x28) == 0x28
        && wrapped.value == Float80{0x8000000000000000ull,0x5ffd} && (wrapped.flags & 8)
        && underflow.value == Float80{0x8000000000000000ull,0x2003} && (underflow.flags & 0x10),
        "Unmasked register range exceptions must preserve x87 exponent-wrapped results, unlike masked infinity/zero results");
    auto tie = calculateFloat(Op::FromFloat64, {0x3ff0000010000000ull,0}).value;
    check(calculateFloat(Op::ToFloat32, tie).value.significand == 0x3f800000
        && calculateFloat(Op::ToFloat32, tie, {}, 0x0b7f).value.significand == 0x3f800001,
        "Binary32 stores must obey rounding control at an exact halfway value");
    auto extended = [](double value) {
        uint64_t bits = 0; std::memcpy(&bits, &value, sizeof(bits));
        return calculateFloat(Op::FromFloat64, {bits,0}).value;
    };
    auto numeric = [](Float80 value) {
        auto bits = calculateFloat(Op::ToFloat64, value).value.significand;
        double result = 0; std::memcpy(&result, &bits, sizeof(result)); return result;
    };
    uint32_t seed = 0x387486;
    auto sample = [&]() { seed = seed * 1664525u + 1013904223u; return (double(seed) / 4294967296.0 - 0.5) * 1e6; };
    for (unsigned i = 0; i < 32; ++i) {
        double a = sample(), b = sample();
        const double expected[] = {a + b,a - b,a * b,a / b,std::sqrt(std::abs(a))};
        for (unsigned operation = 0; operation < std::size(expected); ++operation) {
            auto result = calculateFloat(FloatOperation(operation), extended(operation == 4 ? std::abs(a) : a), extended(b), 0x027f);
            check(numeric(result.value) == expected[operation], "Native 53-bit arithmetic must match independently rounded binary64 calculations");
        }
    }
    std::cout << "Native SoftFloat / 80-bit precision / rounding / conversions / exception flags / wrapped exponents checks passed\n";
}
void fdcTests(const std::filesystem::path& base) {
    auto path = std::filesystem::path(base.native() + L".floppy");
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    check(file != INVALID_HANDLE_VALUE, "Cannot create isolated FDC fixture");
    LARGE_INTEGER size{}; size.QuadPart = 1474560;
    bool allocated = SetFilePointerEx(file, size, nullptr, FILE_BEGIN) && SetEndOfFile(file);
    CloseHandle(file);
    try {
        check(allocated, "Cannot size isolated floppy fixture");
        for (auto model : {CpuModel::I8088,CpuModel::I286,CpuModel::I386,CpuModel::I486}) {
            Pc p; p.setModel(model); auto& c = p.cpu;
            p.floppy = std::make_unique<Disk>(path, true, false);
            std::array<uint8_t, 512> first{}, second{};
            for (unsigned i = 0; i < first.size(); ++i) { first[i] = uint8_t(i * 7); second[i] = uint8_t(i * 13 + 1); }
            check(p.floppy->write(0, first.data()) && p.floppy->write(1, second.data())
                && p.floppy->write(17, first.data()) && p.floppy->write(18, second.data()), "Cannot prepare FDC sectors");
            auto tick = [&]() { p.advanceClock(p.clock + 600); };
            auto send = [&](std::initializer_list<uint8_t> bytes) {
                for (auto value : bytes) {
                    check((c.in(0x3f4) & 0xc0) == 0x80, "FDC must request a host command byte");
                    c.out(0x3f5, value);
                }
            };
            auto receive = [&](unsigned count) {
                std::vector<uint8_t> bytes;
                for (unsigned i = 0; i < count; ++i) {
                    check((c.in(0x3f4) & 0xd0) == 0xd0, "FDC must expose its result bytes through the FIFO");
                    bytes.push_back(c.in(0x3f5));
                }
                check((c.in(0x3f4) & 0xd0) == 0x80, "FDC must return to command phase after its final result byte");
                return bytes;
            };
            auto program = [&](uint16_t address, unsigned bytes, bool writing = false) {
                c.out(0x0a, 6); c.out(0x0c, 0); c.out(4, uint8_t(address)); c.out(4, uint8_t(address >> 8));
                c.out(5, uint8_t(bytes - 1)); c.out(5, uint8_t((bytes - 1) >> 8));
                c.out(0x81, 0); c.out(0x0b, writing ? 0x4a : 0x46); c.out(0x0a, 2);
            };
            c.out(0x21, 0xbf); c.out(0x3f2, 0);
            check(c.in(0x3f4) == 0, "FDC must remain unavailable while DOR reset is asserted");
            c.out(0x3f2, 0x1c); check(c.irq() == -1, "FDC reset interrupt must not arrive before the device delay");
            tick(); check(c.irq() == 0x0e, "FDC reset completion must signal IRQ6");
            for (unsigned drive = 0; drive < 4; ++drive) {
                send({8}); auto data = receive(2);
                check(data[0] == 0xc0 + drive && data[1] == 0, "FDC reset must provide four ordered SENSE INTERRUPT statuses");
            }
            c.out(0x20, 0x20);
            check(c.in(0x3f7) == 0x80, "A newly inserted floppy must assert the disk-change line");
            c.out(0x3f2, 0x14); send({0x0f,0,1}); tick();
            check(c.irq() == -1, "DOR must gate FDC interrupts while disabled");
            c.out(0x3f2, 0x1c); check(c.irq() == 0x0e, "Reenabling the FDC interrupt gate must expose its pending seek completion");
            send({8}); auto data = receive(2);
            check(data == std::vector<uint8_t>({0x20,1}) && c.in(0x3f7) == 0, "Seek completion must update PCN and clear a present medium's change line");
            c.out(0x20, 0x20); c.out(0x21, 0xff);
            send({0x4a,0}); tick(); data = receive(7);
            check(data[0] == 0 && data[3] == 1 && data[6] == 2, "READ ID must use the current cylinder and 512-byte sector IDs");
            send({7,0}); tick(); send({8}); receive(2); send({3,0xdf,2});
            program(0x6000, 1024); send({0xc6,0,0,0,18,2,18,0x1b,0xff}); tick(); tick(); data = receive(7);
            check(data == std::vector<uint8_t>({4,0,0,0,1,2,2})
                && std::equal(first.begin(), first.end(), c.mem.begin() + 0x6000)
                && std::equal(second.begin(), second.end(), c.mem.begin() + 0x6200),
                "Multi-track DMA must cross head zero EOT, stop exactly at terminal count, and report next CHRN");
            program(0x6400, 512); c.out(0x0a, 6); send({0x46,0,0,0,1,2,1,0x1b,0xff}); tick();
            check(c.in(0x3f4) == 0x10 && c.mem[0x6401] == 0, "A masked DMA channel must leave the FDC command pending without consuming its sector");
            c.out(0x0a, 2); tick(); data = receive(7);
            check(data[1] == 0 && std::equal(first.begin(), first.end(), c.mem.begin() + 0x6400), "Unmasking DMA must resume the same FDC sector");
            program(0x6400, 512); send({0x46,0,0,0,1,2,255,0x1b,0xff}); tick(); data = receive(7);
            check(data[1] == 0 && data[5] == 2, "DMA terminal count must stop a valid read before an oversized EOT reaches nonexistent sectors");
            program(0x6800, 32); c.mem[0x6820] = 0xa5;
            send({0x46,0,0,0,1,2,1,0x1b,0xff}); tick(); data = receive(7);
            check(data[1] == 0 && std::equal(first.begin(), first.begin() + 32, c.mem.begin() + 0x6800) && c.mem[0x6820] == 0xa5,
                "An early DMA terminal count on a read must not overwrite bytes beyond the programmed length");
            program(0x6a00, 512, true); send({0x46,0,0,0,1,2,1,0x1b,0xff}); tick(); data = receive(7);
            check(data[1] == 0x10, "A reversed DMA direction must report FDC overrun rather than fabricate transferred data");
            send({3,0xdf,3}); send({0x46,0,0,0,1,2,1,0x1b,0xff}); tick();
            std::array<uint8_t, 512> pio{};
            for (auto& value : pio) { check(c.in(0x3f4) == 0xf0, "Non-DMA read must request FIFO input"); value = c.in(0x3f5); }
            data = receive(7); check(pio == first && data[1] == 0x80, "PIO reads must expose every byte and report EOT without a DMA terminal count");
            send({0x45,0,0,0,2,2,2,0x1b,0xff}); tick();
            for (auto value : first) { check(c.in(0x3f4) == 0xb0, "Non-DMA write must request FIFO output"); c.out(0x3f5, value); }
            receive(7); check(p.floppy->read(1, pio.data()) && pio == first, "PIO writes must persist their complete sector");
            send({3,0xdf,2});
            const uint8_t ids[] = {0,0,1,2,0,0,2,2};
            std::copy(std::begin(ids), std::end(ids), c.mem.begin() + 0x7000);
            program(0x7000, 8, true); send({0x4d,0,2,2,0x54,0xe5}); tick(); data = receive(7);
            check(data[1] == 0 && p.floppy->read(0, pio.data())
                && std::all_of(pio.begin(), pio.end(), [](uint8_t v) { return v == 0xe5; }), "FORMAT TRACK must consume DMA CHRN IDs and fill the actual sectors");
            p.floppy.reset(); p.floppy = std::make_unique<Disk>(path, true, true);
            send({0x45,0,0,0,1,2,1,0x1b,0xff}); tick(); data = receive(7);
            check(data[1] == 2 && c.in(0x3f7) == 0x80, "Read-only floppy media must report write protection and reinsertion");
            program(0x7200, 512); send({0x46,0,0,0,1,2,1,0x1b,0xff});
            p.floppy.reset(); p.floppy = std::make_unique<Disk>(path, true, true);
            tick(); data = receive(7);
            check(data[1] == 4 && c.mem[0x7200] == 0, "Replacing media at the same path must abort an old transfer without dereferencing a stale Disk");
            send({0x0f,0,2}); send({0x0f,1,3});
            check((c.in(0x3f4) & 3) == 3, "Concurrent seeks must retain both drive-busy bits");
            tick(); send({8}); data = receive(2);
            check(data == std::vector<uint8_t>({0x20,2}), "Concurrent seeks must retain the real drive's completion");
            send({8}); data = receive(2);
            check(data == std::vector<uint8_t>({0x71,0}), "An absent second drive must report equipment-check instead of a successful seek");
            send({9}); check(receive(1)[0] == 0x80, "Unsupported deleted-sector writes must report invalid-command status");
            c.out(0x3f2, 0x0c); send({0x46,0,2,0,1,2,1,0x1b,0xff}); tick();
            check(c.in(0x3f4) == 0x10 && !std::isfinite(p.fdc.nextEvent), "A stopped motor must not fabricate a completed floppy read");
            c.out(0x3f2, 0); c.out(0x3f2, 0x1c); tick();
            for (unsigned i = 0; i < 4; ++i) { send({8}); receive(2); }
        }
    } catch (...) {
        std::filesystem::remove(path); throw;
    }
    std::filesystem::remove(path);
    std::cout << "FDC / IRQ6 / reset-sense / DMA-PIO / multi-track / media-change / write-protection / format checks passed\n";
}
void dmaTests() {
    Pc p; p.setModel(CpuModel::I486); auto& c = p.cpu;
    auto program = [&](unsigned channel, uint16_t address, uint16_t count, uint8_t mode, uint8_t page) {
        static constexpr uint16_t pages[] = {0x87,0x83,0x81,0x82,0,0x8b,0x89,0x8a};
        bool word = channel >= 4;
        uint16_t mask = word ? 0xd4 : 0x0a, flip = word ? 0xd8 : 0x0c;
        uint16_t addr = word ? uint16_t(0xc0 + (channel - 4) * 4) : uint16_t(channel * 2);
        c.out(mask, uint8_t(4 | (channel & 3))); c.out(flip, 0);
        c.out(addr, uint8_t(address)); c.out(addr, uint8_t(address >> 8));
        auto counter = uint16_t(addr + (word ? 2 : 1));
        c.out(counter, uint8_t(count)); c.out(counter, uint8_t(count >> 8));
        c.out(pages[channel], page); c.out(word ? 0xd6 : 0x0b, uint8_t(mode | (channel & 3)));
        c.out(mask, uint8_t(channel & 3));
    };
    std::array<uint8_t, 4> bytes{0x11,0x22,0x33,0x44};
    auto result = p.dma.transfer(2, bytes.data(), 4, DmaDirection::ToMemory);
    check(result.bytes == 0 && !result.terminal && !result.error, "Masked DMA must wait without consuming device bytes");
    c.msw |= 0x80000001u; c.cr3 = 0xff0000; c.cpl = 3; c.a20 = false;
    program(2, 0xfffe, 3, 0x44, 0x12);
    result = p.dma.transfer(2, bytes.data(), 4, DmaDirection::ToMemory);
    check(result.bytes == 4 && result.terminal && c.mem[0x12fffe] == 0x11 && c.mem[0x12ffff] == 0x22
        && c.mem[0x120000] == 0x33 && c.mem[0x120001] == 0x44 && c.mem[0x2fffe] == 0,
        "DMA must address physical memory independently of A20, paging and CPL, wrapping only its 16-bit address");
    check((c.in(8) & 4) && !(c.in(8) & 4) && (c.in(15) & 4), "DMA terminal count must latch, clear on status read, and mask a non-auto-init channel");
    c.out(0x0c, 0);
    check(c.in(5) == 255 && c.in(5) == 255, "DMA count must underflow to FFFF at terminal count");
    c.mem[0x21000] = 1; c.mem[0x21001] = 2; c.mem[0x21002] = 3;
    program(1, 0x1002, 2, 0x68, 2);
    result = p.dma.transfer(1, bytes.data(), 4, DmaDirection::FromMemory);
    check(result.bytes == 3 && result.terminal && bytes[0] == 3 && bytes[1] == 2 && bytes[2] == 1,
        "Decrementing DMA memory-to-device transfers must stop at the exact byte terminal count");
    bytes = {0x55,0x66,0x77,0x88}; program(5, 0xffff, 1, 0x44, 0x13);
    result = p.dma.transfer(5, bytes.data(), 4, DmaDirection::ToMemory);
    check(result.bytes == 4 && result.terminal && c.mem[0x13fffe] == 0x55 && c.mem[0x13ffff] == 0x66
        && c.mem[0x120000] == 0x77 && c.mem[0x120001] == 0x88,
        "16-bit DMA must count words, ignore the low page bit, and wrap within a 128 KiB page");
    program(1, 0x3000, 1, 0x54, 0);
    auto first = p.dma.transfer(1, bytes.data(), 4, DmaDirection::ToMemory);
    auto second = p.dma.transfer(1, bytes.data() + 2, 2, DmaDirection::ToMemory);
    check(first.bytes == 2 && first.terminal && second.bytes == 2 && second.terminal
        && c.mem[0x3000] == 0x77 && c.mem[0x3001] == 0x88, "Auto-initialized DMA must restore base address/count for the next block");
    program(2, 0x4000, 0, 0x44, 0); c.out(0xd4, 4);
    result = p.dma.transfer(2, bytes.data(), 1, DmaDirection::ToMemory);
    check(!result.bytes && !result.error, "Masking the AT cascade must suspend first-controller DMA");
    c.out(0xd4, 0); c.out(8, 4);
    result = p.dma.transfer(2, bytes.data(), 1, DmaDirection::ToMemory);
    check(!result.bytes && !result.error, "The DMA controller-disable command must suspend peripheral requests");
    c.out(8, 0);
    result = p.dma.transfer(2, bytes.data(), 1, DmaDirection::FromMemory);
    check(result.error && !result.bytes && c.mem[0x4000] == 0, "A DMA direction mismatch must report an error before altering memory or device data");
    result = p.dma.transfer(2, bytes.data(), 1, DmaDirection::ToMemory);
    check(result.bytes == 1 && result.terminal && c.mem[0x4000] == 0x55, "Resuming DMA must still transfer exactly the unconsumed request");
    program(2, 0x8000, 1, 0x44, 0x0b); bytes[0] = 'D'; bytes[1] = 0x1f;
    result = p.dma.transfer(2, bytes.data(), 2, DmaDirection::ToMemory);
    check(result.terminal && p.vga.textByte(0) == 'D' && p.vga.textByte(1) == 0x1f, "DMA must reach the VGA memory bus rather than bypassing MMIO into the RAM backing array");
    std::vector<uint8_t> block(65536);
    program(2, 0, 0xffff, 0x40, 0);
    result = p.dma.transfer(2, block.data(), unsigned(block.size()), DmaDirection::Verify);
    check(result.bytes == 65536 && result.terminal, "FFFF DMA count must represent a full 65536-unit transfer, not zero units");
    Pc xt; xt.cpu.out(0x0c, 0); xt.cpu.out(4, 0); xt.cpu.out(4, 1);
    xt.cpu.out(5, 0); xt.cpu.out(5, 0); xt.cpu.out(0x81, 0x10);
    xt.cpu.out(0x0b, 0x46); xt.cpu.out(0x0a, 2);
    result = xt.dma.transfer(2, bytes.data(), 1, DmaDirection::ToMemory);
    check(result.terminal && xt.cpu.mem[0x100] == 'D' && xt.cpu.in(0xc0) == 255, "XT DMA must retain its 20-bit bus and not expose an AT second controller");
    std::cout << "8237 DMA / physical-MMIO bus / page wrapping / decrement / cascade / auto-init / exact terminal-count checks passed\n";
}
void diskSizingTests(const std::filesystem::path& base) {
    auto path = std::filesystem::path(base.native() + L".sizing");
    check(!std::filesystem::exists(path), "Disk sizing fixture already exists");
    try {
        for (auto invalid : {0u, 1025u}) {
            bool rejected = false;
            try { Disk::create(path, invalid); } catch (const std::runtime_error&) { rejected = true; }
            check(rejected && !std::filesystem::exists(path), "Invalid disk geometry must be rejected before creating a file");
        }
        for (auto cylinders : {256u, 1024u}) {
            {
                Disk::create(path, cylinders);
                Pc p; p.setModel(CpuModel::I486); p.hard = std::make_unique<Disk>(path, false, false);
                auto& disk = *p.hard;
                check(disk.cylinders == int(cylinders) && disk.sectors == cylinders * 1008
                    && std::filesystem::file_size(path) == uint64_t(cylinders) * 1008 * 512,
                    "Larger disks must retain exact complete-cylinder capacity when reopened");
                std::array<uint8_t, 512> sector{}; sector[0] = 0xf4; sector[510] = 0x55; sector[511] = 0xaa;
                check(disk.write(0, sector.data()), "Cannot prepare sizing fixture boot sector");
                sector[0] = 0x5a;
                check(disk.write(disk.sectors - 1, sector.data()) && !disk.write(disk.sectors, sector.data()),
                    "The final sector must be writable and the first out-of-range sector rejected");
                disk.flush(); p.boot(0x80);
                auto& c = p.cpu; c.loadSegment(CS, 0); c.ip = 0x500;
                const uint8_t code[] = {0xb8,0,8,0xb2,0x80,0xcd,0x13,0xf4};
                std::copy(std::begin(code), std::end(code), c.mem.begin() + c.ip); p.run(100);
                auto maximum = cylinders - 1;
                check(!(c.flags & CF) && c.r[CX] == uint16_t(((maximum & 255) << 8) | ((maximum >> 2) & 0xc0) | 63)
                    && c.reg8(6) == 15, "INT 13h must report every cylinder of a 126/504 MiB disk without CHS truncation");
                c.out(0x3f6, 2); c.out(0x1f6, 0xe0); c.out(0x1f7, 0xec); p.advanceClock(p.clock + 120);
                std::array<uint16_t, 256> identify{};
                for (auto& word : identify) word = uint16_t(c.inputPort(0x1f0, 2));
                check(identify[1] == cylinders && (identify[60] | (uint32_t(identify[61]) << 16)) == disk.sectors,
                    "ATA IDENTIFY must agree with BIOS and the larger image's actual capacity");
            }
            {
                Disk disk(path, false, true); std::array<uint8_t, 512> sector{};
                check(disk.read(disk.sectors - 1, sector.data()) && sector[0] == 0x5a,
                    "Writes at the end of a larger disk must persist after closing and reopening");
            }
            std::filesystem::remove(path);
        }
    } catch (...) {
        std::filesystem::remove(path);
        throw;
    }
    std::cout << "126/504 MiB disk creation / BIOS-ATA geometry / final-sector persistence checks passed\n";
    auto floppyPath = std::filesystem::path(base.native() + L".footer");
    check(!std::filesystem::exists(floppyPath), "Footer fixture already exists");
    try {
        std::vector<uint8_t> bytes(1440 * 1024 + 1024);
        bytes[11] = 0; bytes[12] = 2; bytes[19] = 0x40; bytes[20] = 0x0b;
        bytes[24] = 18; bytes[26] = 2; bytes[510] = 0x55; bytes[511] = 0xaa;
        bytes[1440 * 1024 - 512] = 0x5a;
        const char footer[] = "[FileVersion 003] [SectorsPerTrack 18] [Tracks 80]";
        std::copy(std::begin(footer), std::end(footer), bytes.begin() + 1440 * 1024);
        auto save = [&]() {
            std::ofstream f(floppyPath, std::ios::binary);
            f.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
            check(bool(f), "Cannot write footer fixture");
        };
        save();
        {
            Disk disk(floppyPath, true, true);
            std::array<uint8_t, 512> sector{};
            check(disk.sectors == 2880 && disk.cylinders == 80 && disk.spt == 18 &&
                disk.read(2879, sector.data()) && sector[0] == 0x5a && !disk.read(2880, sector.data()),
                "Known footer must not expose metadata as extra floppy sectors");
        }
        for (auto offset : {size_t(1440 * 1024), size_t(19), size_t(24)}) {
            auto old = bytes[offset]; bytes[offset] ^= 1; save();
            bool rejected = false;
            try { Disk disk(floppyPath, true, true); } catch (const std::runtime_error&) { rejected = true; }
            check(rejected, "Unknown footer or inconsistent BPB must not be silently truncated");
            bytes[offset] = old;
        }
        std::filesystem::remove(floppyPath);
    } catch (...) { std::filesystem::remove(floppyPath); throw; }
    std::cout << "Floppy metadata footer / exact payload / inconsistent geometry rejection checks passed\n";
}
void mbrBootstrapTests(const std::filesystem::path& base) {
    auto path = std::filesystem::path(base.native() + L".mbr");
    check(!std::filesystem::exists(path), "MBR fixture already exists");
    try {
        image::create(path, 64 * image::CylinderBytes, false, false);
        std::array<uint8_t, 512> mbr{}, vbr{};
        {
            Disk disk(path, false, false); check(disk.read(0, mbr.data()), "Cannot read generated MBR");
            const uint8_t code[] = {0xc6,0x06,0,0x90,0xa5,0x88,0x16,1,0x90,0xfa,0xf4,0xeb,0xfd};
            std::copy(std::begin(code), std::end(code), vbr.begin()); vbr[510] = 0x55; vbr[511] = 0xaa;
            check(disk.write(63, vbr.data()), "Cannot install synthetic VBR"); disk.flush();
        }
        auto boot = [&](CpuModel model, bool success) {
            Pc p; p.setModel(model); p.hard = std::make_unique<Disk>(path, false, true);
            p.boot(0x80); p.run(10000);
            check(success ? p.cpu.mem[0x9000] == 0xa5 && p.cpu.mem[0x9001] == 0x80 :
                p.cpu.mem[0x9000] == 0 && p.text().find("Cannot load active partition boot sector.") != std::string::npos,
                "MBR must chainload the VBR with DL=80h or explicitly report invalid boot metadata");
        };
        for (auto model : {CpuModel::I8088, CpuModel::I286, CpuModel::I386, CpuModel::I486}) boot(model, true);
        std::filesystem::remove(path);
        Disk::create(path, 1024);
        auto putDword = [&](size_t o, uint32_t v) {
            for (unsigned i = 0; i < 4; ++i) mbr[o + i] = uint8_t(v >> (8 * i));
        };
        auto saveMbr = [&]() { Disk d(path, false, false); check(d.write(0, mbr.data()), "Cannot write test MBR"); d.flush(); };
        std::fill(mbr.begin() + 446, mbr.begin() + 510, 0);
        constexpr uint32_t start = 300 * 1008 + 63;
        mbr[494] = 0x80; mbr[498] = 6; putDword(502, start); putDword(506, 1024 * 1008 - start);
        {
            Disk disk(path, false, false); check(disk.write(start, vbr.data()), "Cannot install high-cylinder VBR");
            disk.flush();
        }
        saveMbr();
        for (auto model : {CpuModel::I8088, CpuModel::I286, CpuModel::I386, CpuModel::I486}) boot(model, true);
        mbr[494] = 0; saveMbr(); boot(CpuModel::I8088, false);
        mbr[494] = 0x80; mbr[446] = 0x80; saveMbr(); boot(CpuModel::I8088, false);
        mbr[446] = 0; putDword(502, 0xffffffff); saveMbr(); boot(CpuModel::I8088, false);
        putDword(502, start); saveMbr();
        {
            Disk disk(path, false, false); vbr[510] = 0;
            check(disk.write(start, vbr.data()), "Cannot write invalid VBR"); disk.flush();
        }
        boot(CpuModel::I8088, false);
        std::filesystem::remove(path);
    } catch (...) { std::filesystem::remove(path); throw; }
    std::cout << "Generated MBR / VBR chainload / high-cylinder LBA / fourth slot / DL / invalid metadata checks passed\n";
}
void unit() {
    videoTests(); graphicsBiosTests(); serialTests(); keyboardProbeTests();
    Cpu c; c.reset(); c.s[CS] = c.s[SS] = 0; c.ip = 0x100;
    c.mem[0x100] = 0x54; c.r[SP] = 0x200; c.step();
    check(c.r[SP] == 0x1fe && c.rw(0, 0x1fe) == 0x1fe, "8088 PUSH SP");
    c.ww(0xffff, 0xffff, 0x1234);
    check(c.mem[0xffef] == 0x34 && c.mem[0xffff0] == 0x12, "20-bit address and segment word wrapping");
    auto v = viewport(1920, 1080);
    check(v.width == 1728 && v.height == 1080 && v.x == 96, "Maximized content must grow proportionally");
    v = viewport(640, 400); check(v.width == 640 && v.height == 400 && !v.x && !v.y, "Original content size");
    v = viewport(320, 100); check(v.width == 160 && v.height == 100 && v.x == 80, "Small window aspect ratio");
    v = viewport(1920, 1080, 640, 480);
    check(v.width == 1440 && v.height == 1080 && v.x == 240, "VGA 640x480 aspect ratio");
    wchar_t dir[MAX_PATH]{}; GetTempPathW(MAX_PATH, dir);
    auto path = std::filesystem::path(dir) / (L"asm86-native-test-" + std::to_wstring(GetCurrentProcessId()) + L".img");
    Disk::create(path);
    try {
        std::array<uint8_t, 512> bytes{}; bytes[0] = 42; bytes[511] = 99;
        {
            Disk d(path, false, false); check(d.sectors == 64512, "Hard disk geometry"); check(d.write(17, bytes.data()), "Disk write");
            bytes.fill(0);
            const uint8_t program[] = {0xb4, 0, 0xcd, 0x16, 0xa3, 0, 5, 0xf4};
            std::copy(std::begin(program), std::end(program), bytes.begin());
            bytes[510] = 0x55; bytes[511] = 0xaa; check(d.write(0, bytes.data()), "Write synthetic boot sector"); d.flush();
        }
        bytes.fill(0);
        { Disk d(path, false, false); check(d.read(17, bytes.data()) && bytes[0] == 42 && bytes[511] == 99, "Disk survives reopen"); check(!d.read(d.sectors, bytes.data()), "Reject out-of-range disk access"); }
        {
            Pc p; p.hard = std::make_unique<Disk>(path, false, false); p.boot(0x80);
            check(p.cpu.rw(0x40, 0) == 0x3f8 && p.cpu.rw(0x40, 2) == 0
                && (p.cpu.rw(0x40, 0x10) & 0xe00) == 0x200, "BIOS must advertise one serial port at COM1");
            p.cpu.out(0x20, 0x13); p.cpu.out(0x21, 8); p.cpu.out(0x21, 1); p.cpu.out(0x21, 0xff);
            check(p.cpu.in(0x21) == 0xff, "Single PIC initialization must not consume the interrupt mask as ICW3");
            p.cpu.out(0x21, 0);
            p.run(1000); check(p.cpu.waiting, "BIOS keyboard read should wait");
            p.key(0x1c, 13); p.run(1000);
            check(p.cpu.rw(0, 0x500) == 0x1c0d, "IRQ1 must wake blocking INT 16h");
            auto beforeClock = p.clock;
            p.run(100000, beforeClock + 100);
            check(p.clock >= beforeClock + 100 && p.clock < beforeClock + 356, "Idle execution respects virtual-time budget");
            auto refresh = p.cpu.in(0x61) & 16; p.clock += 18;
            check((p.cpu.in(0x61) & 16) != refresh, "Refresh status must toggle for DOS keyboard initialization");
            p.cpu.halted = false; p.cpu.s[CS] = 0xffff; p.cpu.ip = 0;
            p.run(2); check(p.rebootRequested, "Firmware reset vector requests reboot");
        }
        softfloatTests(); dmaTests(); fdcTests(path); diskSizingTests(path); mbrBootstrapTests(path); ideTests(path); atapiTests(path); apmTests(path); videoFirmwareTests(path); virtualVideoFirmwareTests(path); pagedBiosTests(path);
        bool rejected = false; try { Disk::create(path); } catch (const std::exception&) { rejected = true; }
        check(rejected, "Existing disk must never be overwritten");
    } catch (...) { std::filesystem::remove(path); throw; }
    std::filesystem::remove(path);
    std::cout << "Native unit tests passed\n";
}
}
int main(int argc, char** argv) {
    try { if (argc == 2) return corpus(argv[1]); preferenceTests(); timingTests(); cpu386Tests(CpuModel::I386); cpu386Tests(CpuModel::I486);
        protectedTests(); atTests(CpuModel::I286); atTests(CpuModel::I386); atTests(CpuModel::I486); unit(); return 0; }
    catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
