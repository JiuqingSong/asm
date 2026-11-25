#include "pc.h"
#include "font8x8.h"
#include <algorithm>
#include <array>
#include <ctime>
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace asm86 {
static constexpr uint16_t font16Offset = 0x8000;
static std::runtime_error osError(const char* operation) {
    return std::runtime_error(std::string(operation) + " (Windows error " + std::to_string(GetLastError()) + ")");
}
static std::runtime_error biosError(Cpu& c, uint8_t number) {
    auto off = c.rwS(SS, c.r[SP]), seg = c.rwS(SS, uint16_t(c.r[SP] + 2));
    std::ostringstream message;
    message << "Unsupported BIOS INT " << std::hex << unsigned(number) << "h AX=" << c.r[AX]
        << " BX=" << c.r[BX] << " CX=" << c.r[CX] << " DX=" << c.r[DX]
        << " return=" << seg << ':' << off << " bytes:";
    for (int i = -12; i < 8; ++i) message << ' ' << unsigned(c.rbF(seg, uint16_t(off + i)));
    return std::runtime_error(message.str());
}
static void installVideoFirmware(Cpu& cpu) {
    // Guest OUTs must reach VM86 monitors, which cache VGA state independently of the hardware.
    const uint8_t handler[] = {
        0x80,0xfc,0,0x74,3,0xf1,0x10,0xcf,
        0xf1,0x10,0x50,0x53,0x51,0x52,0x56,0x1e,0x0e,0x1f,0xfc,
        0x30,0xff,0x88,0xc3,0x80,0xe3,0x7f,0xd1,0xe3,0x8b,0xb7,0,0x20,
        0xad,0x91,0xba,0xda,3,0xec,0xad,0x92,0xac,0xee,0xe2,0xfa,
        0x1f,0x5e,0x5a,0x59,0x5b,0x58,0xcf
    };
    std::copy(std::begin(handler), std::end(handler), cpu.mem.begin() + 0xf0900);
    cpu.ww(0, 0x10 * 4, 0x900);
    auto profile = std::make_unique<Vga>();
    uint16_t address = 0x2028;
    for (uint8_t mode : {0, 1, 2, 3, 0x0d, 0x0e, 0x10, 0x12, 0x13}) {
        profile->setMode(mode);
        cpu.ww(0xf000, uint16_t(0x2000 + mode * 2), address);
        auto start = address; address += 2;
        auto port = [&](uint16_t number, uint8_t value) {
            cpu.ww(0xf000, address, number); cpu.wb(0xf000, uint16_t(address + 2), value); address += 3;
        };
        auto indexed = [&](uint16_t number, uint8_t index, uint8_t value) {
            port(number, index); port(number + 1, value);
        };
        indexed(0x3c4, 0, 1);
        port(0x3c2, profile->input(0x3cc));
        for (uint8_t i = 1; i < 5; ++i) indexed(0x3c4, i, profile->seq[i]);
        indexed(0x3c4, 0, profile->seq[0]);
        indexed(0x3d4, 0x11, profile->crtc[0x11] & 0x7f);
        for (uint8_t i = 0; i < 25; ++i) indexed(0x3d4, i, profile->crtc[i]);
        for (uint8_t i = 0; i < 9; ++i) indexed(0x3ce, i, profile->gc[i]);
        for (uint8_t i = 0; i < 21; ++i) { port(0x3c0, i); port(0x3c0, profile->attr[i]); }
        port(0x3c0, 0x20); port(0x3c6, 255); port(0x3c8, 0);
        for (auto component : profile->dac) port(0x3c9, component);
        cpu.ww(0xf000, start, uint16_t((address - start - 2) / 3));
    }
    for (unsigned ch = 0; ch < 256; ++ch)
        for (unsigned row = 0; row < 16; ++row)
            cpu.wb(0xf000, uint16_t(font16Offset + ch * 16 + row), biosFont8x8[ch * 8 + row / 2]);
    cpu.ww(0, 0x43 * 4, font16Offset); cpu.ww(0, 0x43 * 4 + 2, 0xf000);
}
Disk::Disk(const std::filesystem::path& p, bool floppy, bool ro) : readOnly(ro), path(p) {
    file = CreateFileW(p.c_str(), GENERIC_READ | (ro ? 0 : GENERIC_WRITE), FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw osError("Cannot open disk image");
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size)) { auto e = osError("Cannot size disk image"); CloseHandle(file); throw e; }
    if (size.QuadPart <= 0 || size.QuadPart % 512 || size.QuadPart > 504LL * 1024 * 1024) {
        CloseHandle(file); throw std::runtime_error("Disk image must contain whole 512-byte sectors and be at most 504 MiB");
    }
    sectors = uint32_t(size.QuadPart / 512);
    if (floppy) {
        switch (sectors) {
        case 320: heads = 1; spt = 8; floppyType = 1; break;
        case 360: heads = 1; spt = 9; floppyType = 1; break;
        case 640: heads = 2; spt = 8; floppyType = 1; break;
        case 720: heads = 2; spt = 9; floppyType = 1; break;
        case 1440: heads = 2; spt = 9; floppyType = 3; break;
        case 2400: heads = 2; spt = 15; floppyType = 2; break;
        case 2880: heads = 2; spt = 18; floppyType = 4; break;
        default: CloseHandle(file); throw std::runtime_error("Unsupported floppy geometry");
        }
    } else { heads = 16; spt = 63; }
    cylinders = int(sectors / unsigned(heads * spt));
    if (!floppy && (cylinders < 1 || sectors % unsigned(heads * spt) || cylinders > 1024)) {
        CloseHandle(file); throw std::runtime_error("Hard disk image must use 16 heads, 63 sectors and 1..1024 complete cylinders");
    }
}
Disk::~Disk() { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); }
void Disk::create(const std::filesystem::path& p, unsigned cylinders) {
    if (cylinders < 1 || cylinders > 1024) throw std::runtime_error("Hard disk creation requires 1..1024 cylinders");
    auto h = CreateFileW(p.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) throw osError("Cannot create new hard disk image (existing files are never overwritten)");
    LARGE_INTEGER size{}; size.QuadPart = int64_t(cylinders) * 16 * 63 * 512;
    if (!SetFilePointerEx(h, size, nullptr, FILE_BEGIN) || !SetEndOfFile(h) || !FlushFileBuffers(h)) {
        auto e = osError("Cannot allocate hard disk image"); CloseHandle(h); throw e;
    }
    CloseHandle(h);
}
bool Disk::transfer(uint32_t lba, uint8_t* data, bool writing) {
    if (lba >= sectors || (writing && readOnly)) return false;
    LARGE_INTEGER pos{}; pos.QuadPart = uint64_t(lba) * 512;
    if (!SetFilePointerEx(file, pos, nullptr, FILE_BEGIN)) throw osError("Disk seek failed");
    DWORD done = 0;
    BOOL ok = writing ? WriteFile(file, data, 512, &done, nullptr) : ReadFile(file, data, 512, &done, nullptr);
    if (!ok || done != 512) throw osError(writing ? "Disk write failed" : "Disk read failed");
    return true;
}
bool Disk::read(uint32_t lba, uint8_t* p) { return transfer(lba, p, false); }
bool Disk::write(uint32_t lba, const uint8_t* p) { return transfer(lba, const_cast<uint8_t*>(p), true); }
void Disk::flush() { if (!readOnly && !FlushFileBuffers(file)) throw osError("Disk flush failed"); }

Pc::Pc() {
    cpu.in = [this](uint16_t p) { return input(p); };
    cpu.out = [this](uint16_t p, uint8_t v) { output(p, v); };
    cpu.inWide = [this](uint16_t port, unsigned size) {
        uint32_t value = 0;
        if (at() && (port == 0x1f0 || port == 0x170))
            for (unsigned i = 0; i < size; i += 2) value |= uint32_t(port == 0x1f0 ? ide.readWord(clock) : cdrom.readWord(clock)) << (i * 8);
        else for (unsigned i = 0; i < size; ++i) value |= uint32_t(cpu.in(uint16_t(port + i))) << (i * 8);
        return value;
    };
    cpu.outWide = [this](uint16_t port, uint32_t value, unsigned size) {
        if (at() && (port == 0x1f0 || port == 0x170))
            for (unsigned i = 0; i < size; i += 2) {
                if (port == 0x1f0) ide.writeWord(uint16_t(value >> (i * 8)), clock);
                else cdrom.writeWord(uint16_t(value >> (i * 8)), clock);
            }
        else for (unsigned i = 0; i < size; ++i) cpu.out(uint16_t(port + i), uint8_t(value >> (i * 8)));
    };
    cpu.irq = [this]() { return acknowledge(); };
    cpu.trap = [this](uint8_t n) { return bios(n); };
    cpu.mmioStart = 0xa0000; cpu.mmioEnd = 0xc0000;
    cpu.mmioRead = [this](uint32_t a) { return vga.read(a); };
    cpu.mmioWrite = [this](uint32_t a, uint8_t v) { vga.write(a, v); };
    serialMouse.setIrq = [this](bool raised) { if (raised) pic[0].raise(4); };
    ide.disk = [this]() { return hard.get(); };
    ide.interrupt = [this](bool raised) {
        if (raised) pic[1].raise(6);
        else pic[1].pending &= uint8_t(~0x40);
    };
    cdrom.interrupt = [this](bool raised) {
        if (raised) pic[1].raise(7);
        else pic[1].pending &= uint8_t(~0x80);
    };
    cpu.resetSignal = [this] { pendingReset = true; };
}
void Pc::setModel(CpuModel model) { cpu.setModel(model); keys.clear(); resetAt(); }
unsigned Pc::columns() const { return cpu.rw(0x40, 0x4a); }
unsigned Pc::activePage() const { return cpu.rb(0x40, 0x62) & 7; }
unsigned Pc::cursor() const { return cpu.rw(0x40, uint16_t(0x50 + activePage() * 2)); }
unsigned Pc::biosColumns() { return cpu.rwF(0x40, 0x4a); }
unsigned Pc::biosPage() { return cpu.rbF(0x40, 0x62) & 7; }
unsigned Pc::biosCursor() { return cpu.rwF(0x40, uint16_t(0x50 + biosPage() * 2)); }
void Pc::boot(uint8_t drive) {
    Disk* d = drive == 0 ? floppy.get() : drive == 0x80 ? hard.get() : nullptr;
    if (!d) throw std::runtime_error("No image mounted in the selected boot drive");
    std::array<uint8_t, 512> sector{};
    d->read(0, sector.data());
    if (sector[510] != 0x55 || sector[511] != 0xaa) throw std::runtime_error("Boot sector has no 55AA signature");
    cpu.reset(); std::fill(cpu.mem.begin(), cpu.mem.end(), 0);
    vga.setMode(3);
    serialMouse.reset();
    bootDrive = drive; rebootRequested = false; instructions = 0; clock = 0; notice.clear(); keys.clear();
    resetAt();
    reload.fill(0); access.fill(3); pitMode.fill(3); writeHigh.fill(false); readHigh.fill(false); latched.fill(false);
    port61 = crtcIndex = 0; nextTimer = 65536;
    for (unsigned n = 0; n < 256; ++n) {
        uint16_t off = uint16_t(0x1000 + n * 8);
        cpu.ww(0, uint16_t(n * 4), off); cpu.ww(0, uint16_t(n * 4 + 2), 0xf000);
        cpu.wb(0xf000, off, 0xf1); cpu.wb(0xf000, off + 1, uint8_t(n)); cpu.wb(0xf000, off + 2, 0xcf);
        if (n == 0x16) {
            cpu.wb(0xf000, off, 0xfb); cpu.wb(0xf000, off + 1, 0xf1);
            cpu.wb(0xf000, off + 2, uint8_t(n)); cpu.wb(0xf000, off + 3, 0xcf);
        }
    }
    installVideoFirmware(cpu);
    cpu.ww(0, 0x1c * 4, 0x0700); cpu.ww(0, 0x1c * 4 + 2, 0xf000); cpu.wb(0xf000, 0x700, 0xcf);
    const uint8_t timer[] = {0x50, 0xf1, 0x08, 0xcd, 0x1c, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf};
    std::copy(std::begin(timer), std::end(timer), cpu.mem.begin() + 0xf0800);
    cpu.ww(0, 8 * 4, 0x800);
    const uint8_t keyboard[] = {0x50, 0xe4, 0x60, 0xf1, 0x09, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf};
    std::copy(std::begin(keyboard), std::end(keyboard), cpu.mem.begin() + 0xf0820);
    cpu.ww(0, 9 * 4, 0x820);
    cpu.ww(0x40, 0, 0x3f8); cpu.wb(0x40, 0x7c, 1);
    cpu.ww(0x40, 0x10, uint16_t(0x221 | (floppy ? 1 : 0)));
    cpu.ww(0x40, 0x13, 640); cpu.ww(0x40, 0x1a, 0x1e); cpu.ww(0x40, 0x1c, 0x1e);
    cpu.ww(0x40, 0x80, 0x1e); cpu.ww(0x40, 0x82, 0x3e);
    cpu.wb(0x40, 0x49, 3); cpu.ww(0x40, 0x4a, 80); cpu.ww(0x40, 0x4c, 4096);
    cpu.ww(0x40, 0x60, 0x0607); cpu.ww(0x40, 0x63, 0x3d4);
    cpu.wb(0x40, 0x75, hard ? 1 : 0); cpu.wb(0x40, 0x84, 24); cpu.ww(0x40, 0x85, 16);
    auto now = std::time(nullptr); std::tm local{}; localtime_s(&local, &now);
    auto ticks = uint32_t((local.tm_hour * 3600 + local.tm_min * 60 + local.tm_sec) * (1193182.0 / 65536));
    cpu.ww(0x40, 0x6c, uint16_t(ticks)); cpu.ww(0x40, 0x6e, uint16_t(ticks >> 16));
    const uint8_t dpt[] = {0xdf, 2, 0x25, 2, 18, 0x1b, 0xff, 0x6c, 0xf6, 15, 8};
    std::copy(std::begin(dpt), std::end(dpt), cpu.mem.begin() + 0xfefc7);
    cpu.ww(0, 0x1e * 4, 0xefc7); cpu.ww(0, 0x1e * 4 + 2, 0xf000);
    if (hard) {
        cpu.ww(0, 0x41 * 4, 0xe401); cpu.ww(0, 0x41 * 4 + 2, 0xf000);
        cpu.ww(0xf000, 0xe401, uint16_t(hard->cylinders)); cpu.wb(0xf000, 0xe403, uint8_t(hard->heads));
        cpu.wb(0xf000, 0xe40f, uint8_t(hard->spt));
    }
    const char date[] = "11/08/82";
    std::copy(date, date + 8, cpu.mem.begin() + 0xffff5);
    cpu.mem[0xffffe] = at() ? 0xfc : 0xfe;
    const uint8_t reset[] = {0xea, 0x00, 0x06, 0x00, 0xf0};
    std::copy(std::begin(reset), std::end(reset), cpu.mem.begin() + 0xffff0);
    cpu.wb(0xf000, 0x600, 0xf1); cpu.wb(0xf000, 0x601, 0x19);
    for (unsigned i = 0; i < 0x4000; i += 2) cpu.ww(0xb800, uint16_t(i), 0x0720);
    std::copy(sector.begin(), sector.end(), cpu.mem.begin() + 0x7c00);
    if (at()) std::copy(cpu.mem.begin() + 0xf0000, cpu.mem.begin() + 0x100000, cpu.mem.begin() + 0xff0000);
    for (auto seg : {ES, CS, SS, DS}) cpu.loadSegment(seg, 0);
    cpu.ip = 0x7c00; cpu.r[SP] = 0x7c00;
    cpu.r[DX] = drive; cpu.setFlags(0x0202);
}
void Pc::run(unsigned budget, double untilClock) {
    for (unsigned i = 0; i < budget && !rebootRequested && clock < untilClock; ++i) {
        stepCpu();
        advanceClock(clock + ((cpu.halted || cpu.waiting) ? 256.0 : 3.6));
    }
}
void Pc::stepCpu() {
    cpu.step(); ++instructions;
    if (pendingReset) resetCpu();
}
void Pc::runCpu(unsigned budget) {
    for (unsigned i = 0; i < budget && !rebootRequested; ++i) {
        stepCpu();
        if (cpu.halted || cpu.waiting) break;
    }
}
void Pc::advanceClock(double target) {
    if (!std::isfinite(target) || target < clock) throw std::runtime_error("Invalid device clock target");
    clock = target;
    if (clock >= serialMouse.nextEvent) serialMouse.advance(clock);
    if (clock >= nextTimer) {
        double period = reload[0] ? reload[0] : 65536;
        if (pitMode[0] == 0) nextTimer = 1e100;
        else nextTimer += period * (1 + std::floor((clock - nextTimer) / period));
        pic[0].raise(0);
    }
    if (clock >= nextRtc) rtcAdvance();
    if (at() && clock >= ide.nextEvent) ide.advance(clock);
    if (at() && clock >= cdrom.nextEvent) cdrom.advance(clock);
}
int Pc::acknowledge() {
    if (at() && pic[1].next() >= 0) pic[0].raise(2);
    int line = pic[0].take();
    if (line < 0) return -1;
    if (line == 1) keyboardRead = false;
    if (at() && line == 2) {
        int slave = pic[1].take();
        return pic[1].base + (slave < 0 ? 7 : slave);
    }
    return pic[0].base + line;
}
uint8_t Pc::input(uint16_t p) {
    if (at() && IdeChannel::owns(p)) return ide.input(p, clock);
    if (at() && AtapiCdrom::owns(p)) return cdrom.input(p, clock);
    if (p >= 0x3f8 && p <= 0x3ff) return serialMouse.input(p - 0x3f8, clock);
    if (p == 0x20 || (at() && p == 0xa0)) return pic[p == 0x20 ? 0 : 1].command();
    if (p == 0x21 || (at() && p == 0xa1)) return pic[p == 0x21 ? 0 : 1].mask;
    if (at() && p == 0x70) return cmosIndex;
    if (at() && p == 0x71) return cmosRead();
    if (at() && p == 0x92) return fastA20;
    if (p >= 0x40 && p <= 0x42) {
        unsigned ch = p - 0x40;
        uint16_t value = latched[ch] ? latch[ch] : uint16_t((reload[ch] ? reload[ch] : 65536) - uint64_t(clock) % (reload[ch] ? reload[ch] : 65536));
        uint8_t result = uint8_t(value >> ((access[ch] == 2 || (access[ch] == 3 && readHigh[ch])) ? 8 : 0));
        if (access[ch] == 3) { readHigh[ch] = !readHigh[ch]; if (!readHigh[ch]) latched[ch] = false; }
        else latched[ch] = false;
        return result;
    }
    if (p == 0x60) {
        if (at() && !controller.empty()) { auto value = controller.front(); controller.pop_front(); keyboardIrq(); return value; }
        if (keys.empty() || (keyboardRead && (pic[0].service & 2))) return uint8_t(keyboardLatch >> 8);
        keyboardLatch = keys.front(); keys.pop_front(); keyboardRead = true;
        keyboardIrq();
        return uint8_t(keyboardLatch >> 8);
    }
    if (p == 0x61) return uint8_t((port61 & 0xcf) | ((uint64_t(clock / 18) & 1) << 4) | 0x20);
    if (p == 0x64) return uint8_t((at() ? kbdCommand & 4 : 0) | ((!keys.empty() || !controller.empty()) ? 1 : 0));
    if (p == 0x3da || p == 0x3ba) { vga.input(p); return (uint64_t(clock) / 64) & 1 ? 9 : 0; }
    if ((p >= 0x3c0 && p <= 0x3cf) || p == 0x3d4 || p == 0x3b4) return vga.input(p);
    if (p == 0x3d5 || p == 0x3b5) {
        if (vga.graphics()) return vga.input(p);
        auto pos = cursor(); unsigned cell = (pos >> 8) * columns() + (pos & 255) + activePage() * 2048;
        return crtcIndex == 14 ? uint8_t(cell >> 8) : crtcIndex == 15 ? uint8_t(cell) : vga.input(p);
    }
    if (p == 0x201) return 255;
    return 255; // Unpopulated ISA bus reads high.
}
void Pc::output(uint16_t p, uint8_t v) {
    if (at() && IdeChannel::owns(p)) { ide.output(p, v, clock); return; }
    if (at() && AtapiCdrom::owns(p)) { cdrom.output(p, v, clock); return; }
    if (p >= 0x3f8 && p <= 0x3ff) { serialMouse.output(p - 0x3f8, v, clock); return; }
    if (vga.output(p, v) && p != 0x3d4 && p != 0x3b4 && p != 0x3d5 && p != 0x3b5) return;
    if (p == 0x20 || (at() && p == 0xa0)) { pic[p == 0x20 ? 0 : 1].command(v); }
    else if (p == 0x21 || (at() && p == 0xa1)) { pic[p == 0x21 ? 0 : 1].data(v); }
    else if (at() && p == 0x64) keyboardCommand(v);
    else if (at() && p == 0x60) keyboardData(v);
    else if (at() && p == 0x70) cmosIndex = v & 127;
    else if (at() && p == 0x71) cmosWrite(v);
    else if (at() && p == 0x92) {
        if ((v & 1) && !(fastA20 & 1)) pendingReset = true;
        fastA20 = v; cpu.a20 = v & 2; kbdOutput = uint8_t((kbdOutput & ~2) | (v & 2));
    }
    else if (p == 0x43) {
        unsigned ch = v >> 6; if (ch == 3) return;
        unsigned mode = (v >> 4) & 3;
        if (!mode) {
            latch[ch] = uint16_t((reload[ch] ? reload[ch] : 65536) - uint64_t(clock) % (reload[ch] ? reload[ch] : 65536));
            latched[ch] = true; readHigh[ch] = false;
        } else { access[ch] = uint8_t(mode); pitMode[ch] = (v >> 1) & 7; writeHigh[ch] = readHigh[ch] = false; }
    } else if (p >= 0x40 && p <= 0x42) {
        unsigned ch = p - 0x40;
        if (access[ch] == 2) reload[ch] = uint16_t(v) << 8;
        else if (access[ch] == 1) reload[ch] = v;
        else {
            reload[ch] = writeHigh[ch] ? uint16_t((reload[ch] & 255) | (uint16_t(v) << 8)) : uint16_t((reload[ch] & 0xff00) | v);
            writeHigh[ch] = !writeHigh[ch];
        }
        if (ch == 0 && (access[ch] != 3 || !writeHigh[ch])) nextTimer = clock + (reload[ch] ? reload[ch] : 65536);
    } else if (p == 0x61) port61 = v;
    else if (p == 0x3d4 || p == 0x3b4) crtcIndex = v;
    else if (p == 0x3d5 || p == 0x3b5) {
        if (vga.graphics()) return;
        if (crtcIndex == 14 || crtcIndex == 15) {
            auto pos = cursor(); unsigned cell = (pos >> 8) * columns() + (pos & 255) + activePage() * 2048;
            cell = crtcIndex == 14 ? (cell & 255) | (unsigned(v) << 8) : (cell & 0xff00) | v;
            cell -= activePage() * 2048; auto cols = std::max(1u, columns());
            cpu.ww(0x40, uint16_t(0x50 + activePage() * 2), uint16_t(((cell / cols) << 8) | (cell % cols)));
        }
    }
}
void Pc::key(uint8_t scan, uint8_t ascii) {
    keys.push_back(uint16_t((uint16_t(scan) << 8) | ascii)); keyboardIrq();
}
void Pc::modifiers(uint8_t value) { cpu.wb(0x40, 0x17, value); }
static uint8_t keyboardAscii(uint8_t scan, uint8_t flags) {
    static constexpr char plain[] = "\0\0331234567890-=\b\tqwertyuiop[]\r\0asdfghjkl;'`\0\\zxcvbnm,./\0*\0 ";
    static constexpr char shifted[] = "\0\033!@#$%^&*()_+\b\tQWERTYUIOP{}\r\0ASDFGHJKL:\"~\0|ZXCVBNM<>?\0*\0 ";
    if (scan >= sizeof(plain) - 1) {
        static constexpr char keypad[] = "789-456+1230.";
        return (flags & 0x20) && !(flags & 3) && scan >= 0x47 && scan <= 0x53 ? uint8_t(keypad[scan - 0x47]) : 0;
    }
    auto ch = uint8_t((flags & 3 ? shifted : plain)[scan]);
    if ((flags & 0x40) && plain[scan] >= 'a' && plain[scan] <= 'z') ch ^= 0x20;
    if (flags & 4) {
        if (ch >= 'a' && ch <= 'z') ch -= 'a' - 'A';
        if (ch >= '@' && ch <= '_') ch &= 31;
    }
    return ch;
}
void Pc::keyboard() {
    // The ROM reads port 60h so a VM86 monitor can supply its virtual scan code.
    auto scan = cpu.reg8(0);
    auto ascii = keyboardRead && uint8_t(keyboardLatch >> 8) == scan
        ? uint8_t(keyboardLatch) : keyboardAscii(scan, cpu.rbF(0x40, 0x17));
    uint16_t value = uint16_t((uint16_t(scan) << 8) | ascii);
    keyboardRead = false;
    unsigned key = scan & 0x7f;
    uint8_t modifier = key == 0x2a ? 2 : key == 0x36 ? 1 : key == 0x1d ? 4 : key == 0x38 ? 8 : 0;
    if (modifier) {
        auto flags = cpu.rbF(0x40, 0x17);
        cpu.wbF(0x40, 0x17, uint8_t((scan & 0x80) ? flags & ~modifier : flags | modifier));
        if (key == 0x1d || key == 0x38) {
            auto extended = cpu.rbF(0x40, 0x18); uint8_t mask = key == 0x1d ? 1 : 2;
            cpu.wbF(0x40, 0x18, uint8_t((scan & 0x80) ? extended & ~mask : extended | mask));
        }
        keyboardIrq(); return;
    }
    if (key == 0x3a) {
        auto pressed = cpu.rbF(0x40, 0x18);
        if (!(scan & 0x80) && !(pressed & 0x40)) cpu.wbF(0x40, 0x17, cpu.rbF(0x40, 0x17) ^ 0x40);
        cpu.wbF(0x40, 0x18, uint8_t((scan & 0x80) ? pressed & ~0x40 : pressed | 0x40));
        keyboardIrq(); return;
    }
    if (scan & 0x80) { keyboardIrq(); return; }
    if (cpu.rbF(0x40, 0x17) & 8) value &= 0xff00;
    auto tail = cpu.rwF(0x40, 0x1c), next = uint16_t(tail + 2);
    if (next >= 0x3e) next = 0x1e;
    if (next != cpu.rwF(0x40, 0x1a)) { cpu.wwF(0x40, tail, value); cpu.wwF(0x40, 0x1c, next); }
    keyboardIrq();
}
std::string Pc::text() const {
    std::string result; unsigned cols = std::min(columns(), 80u), base = activePage() * 4096;
    for (unsigned y = 0; y < 25; ++y) {
        for (unsigned x = 0; x < cols; ++x) { auto c = vga.textByte(base + (y * cols + x) * 2); result += c >= 32 && c < 127 ? char(c) : ' '; }
        result += '\n';
    }
    return result;
}
void Pc::scroll(unsigned top, unsigned left, unsigned bottom, unsigned right, unsigned lines, uint8_t attr, bool down) {
    unsigned cols = std::min(biosColumns(), 80u); if (!cols) return;
    top = std::min(top, 24u); bottom = std::min(bottom, 24u); left = std::min(left, cols - 1); right = std::min(right, cols - 1);
    if (top > bottom || left > right) return;
    if (!lines || lines > bottom - top + 1) lines = bottom - top + 1;
    unsigned page = biosPage() * 4096;
    for (unsigned i = 0; i <= bottom - top; ++i) {
        unsigned y = down ? bottom - i : top + i;
        for (unsigned x = left; x <= right; ++x) {
            int source = int(y) + (down ? -int(lines) : int(lines));
            uint16_t cell = (source < int(top) || source > int(bottom)) ? uint16_t((uint16_t(attr) << 8) | 32)
                : cpu.rwF(0xb800, uint16_t(page + (unsigned(source) * cols + x) * 2));
            cpu.wwF(0xb800, uint16_t(page + (y * cols + x) * 2), cell);
        }
    }
}
void Pc::put(uint8_t ch, uint8_t attr) {
    unsigned cols = std::max(1u, std::min(biosColumns(), 80u)), pos = biosCursor(), x = pos & 255, y = pos >> 8;
    if (ch == 13) x = 0;
    else if (ch == 10) ++y;
    else if (ch == 8) { if (x) --x; }
    else if (ch != 7) {
        if (x < cols && y < 25) cpu.wbF(0xb800, uint16_t(biosPage() * 4096 + (y * cols + x) * 2), ch);
        if (++x >= cols) { x = 0; ++y; }
    }
    if (y >= 25) { scroll(0, 0, 24, cols - 1, 1, attr, false); y = 24; }
    cpu.wwF(0x40, uint16_t(0x50 + biosPage() * 2), uint16_t((y << 8) | x));
}
bool Pc::video() {
    auto& c = cpu; auto& r = c.r; auto ah = c.reg8(4), al = c.reg8(0), bh = c.reg8(7), bl = c.reg8(3);
    unsigned page = bh & 7, cols = biosColumns();
    if (vga.graphics() && (ah == 6 || ah == 7 || ah == 8 || ah == 9 || ah == 10 || ah == 0x0e || ah == 0x13))
        throw std::runtime_error("Graphics-mode BIOS character and scrolling services are not implemented yet");
    switch (ah) {
    case 0:
        vga.setMode(al & 0x7f, !(al & 0x80));
        c.wbF(0x40, 0x49, al & 0x7f);
        c.wwF(0x40, 0x4a, vga.graphics() ? uint16_t(vga.width() / 8) : (al & 0x7f) < 2 ? 40 : 80);
        c.wbF(0x40, 0x62, 0); c.wwF(0x40, 0x4e, 0);
        c.wwF(0x40, 0x4c, vga.mode == 0x13 ? 0xfa00 : vga.mode == 0x12 ? 0x9600
            : vga.mode == 0x10 ? 0x8000 : vga.mode == 0x0e ? 0x4000 : vga.mode == 0x0d ? 0x2000 : 4096);
        c.wbF(0x40, 0x84, vga.graphics() ? uint8_t(vga.height() / vga.charHeight() - 1) : 24);
        c.wwF(0x40, 0x85, uint16_t(vga.charHeight()));
        for (unsigned p = 0; p < 8; ++p) c.wwF(0x40, uint16_t(0x50 + p * 2), 0);
        if (!(al & 0x80) && !vga.graphics())
            for (unsigned i = 0; i < 0x8000; i += 2) c.wwF(0xb800, uint16_t(i), 0x0720);
        return true;
    case 1: c.wwF(0x40, 0x60, r[CX]); return true;
    case 2: c.wwF(0x40, uint16_t(0x50 + page * 2), r[DX]); return true;
    case 3: r[DX] = c.rwF(0x40, uint16_t(0x50 + page * 2)); r[CX] = c.rwF(0x40, 0x60); return true;
    case 4: c.reg8(4, 0); return true;
    case 5:
        if (vga.graphics() && al) throw std::runtime_error("Graphics BIOS pages other than page 0 are not implemented yet");
        c.wbF(0x40, 0x62, al & 7); c.wwF(0x40, 0x4e, uint16_t((al & 7) * 4096)); return true;
    case 6: case 7: scroll(c.reg8(5), c.reg8(1), c.reg8(6), c.reg8(2), al, bh, ah == 7); return true;
    case 8: {
        auto pos = c.rwF(0x40, uint16_t(0x50 + page * 2));
        r[AX] = c.rwF(0xb800, uint16_t(page * 4096 + ((pos >> 8) * cols + (pos & 255)) * 2)); return true;
    }
    case 9: case 10: {
        auto pos = c.rwF(0x40, uint16_t(0x50 + page * 2)); unsigned cell = (pos >> 8) * cols + (pos & 255);
        for (unsigned i = 0; i < r[CX] && cell + i < cols * 25; ++i) {
            auto off = uint16_t(page * 4096 + (cell + i) * 2); c.wbF(0xb800, off, al); if (ah == 9) c.wbF(0xb800, off + 1, bl);
        }
        return true;
    }
    case 0x0b: return true;
    case 0x0c: case 0x0d:
        if (!vga.graphics() || bh) throw std::runtime_error("BIOS pixel access requires graphics page 0");
        if (ah == 0x0c) vga.pixel(r[CX], r[DX], al, vga.mode != 0x13 && (al & 0x80));
        else c.reg8(0, vga.pixel(r[CX], r[DX]));
        return true;
    case 0x0e: put(al, bl ? bl : 7); return true;
    case 0x0f: c.reg8(4, uint8_t(cols)); c.reg8(0, c.rbF(0x40, 0x49)); c.reg8(7, uint8_t(biosPage())); return true;
    case 0x10:
        if (al == 0 && bl < 16) { vga.attr[bl] = bh & 63; return true; }
        if (al == 1) { vga.attr[0x11] = bh & 63; return true; }
        if (al == 2 || al == 9) {
            for (unsigned i = 0; i < 17; ++i) {
                auto& value = vga.attr[i < 16 ? i : 0x11];
                if (al == 2) value = c.rbF(c.s[ES], uint16_t(r[DX] + i)) & 63;
                else c.wbF(c.s[ES], uint16_t(r[DX] + i), value);
            }
            return true;
        }
        if (al == 3) { vga.attr[0x10] = uint8_t((vga.attr[0x10] & ~8) | ((bl & 1) << 3)); return true; }
        if (al == 7 && bl < 16) { c.reg8(7, vga.attr[bl]); return true; }
        if (al == 8) { c.reg8(7, vga.attr[0x11]); return true; }
        if (al == 0x13) {
            if (bl == 0) vga.attr[0x10] = uint8_t((vga.attr[0x10] & ~0x80) | ((bh & 1) << 7));
            else if (bl == 1) vga.attr[0x14] = uint8_t((vga.attr[0x10] & 0x80) ? bh & 15 : (bh & 3) << 2);
            else break;
            return true;
        }
        if (al == 0x18) { output(0x3c6, bl); return true; }
        if (al == 0x19) { r[BX] = input(0x3c6); return true; }
        if (al == 0x1a) {
            c.reg8(3, vga.attr[0x10] >> 7);
            c.reg8(7, uint8_t((vga.attr[0x10] & 0x80) ? vga.attr[0x14] & 15 : (vga.attr[0x14] >> 2) & 3));
            return true;
        }
        if (al == 0x10 || al == 0x15) {
            if (r[BX] > 255) throw std::runtime_error("VGA DAC palette index must be below 256");
            unsigned off = r[BX] * 3;
            if (al == 0x10) { vga.dac[off] = c.reg8(6) & 63; vga.dac[off + 1] = c.reg8(5) & 63; vga.dac[off + 2] = c.reg8(1) & 63; }
            else { c.reg8(6, vga.dac[off]); c.reg8(5, vga.dac[off + 1]); c.reg8(1, vga.dac[off + 2]); }
            return true;
        }
        if (al == 0x12 || al == 0x17) {
            if (unsigned(r[BX]) + r[CX] > 256) throw std::runtime_error("VGA DAC palette block exceeds 256 entries");
            for (unsigned i = 0; i < unsigned(r[CX]) * 3; ++i) {
                unsigned off = r[BX] * 3 + i; auto address = uint16_t(r[DX] + i);
                if (al == 0x12) vga.dac[off] = c.rbF(c.s[ES], address) & 63;
                else c.wbF(c.s[ES], address, vga.dac[off]);
            }
            return true;
        }
        break;
    case 0x11:
        if (al == 0x24) {
            if (bl > 3 || (!bl && !c.reg8(2))) throw std::runtime_error("Invalid graphics font row specifier");
            auto rows = bl == 0 ? c.reg8(2) : bl == 1 ? 14 : bl == 2 ? 25 : 43;
            c.wwF(0, 0x43 * 4, font16Offset); c.wwF(0, 0x43 * 4 + 2, 0xf000);
            c.wbF(0x40, 0x84, uint8_t(rows - 1)); c.wwF(0x40, 0x85, 16);
            return true;
        }
        if (al == 0x30) {
            auto segment = bh == 1 ? c.rwF(0, 0x43 * 4 + 2) : 0xf000;
            r[BP] = bh == 1 ? c.rwF(0, 0x43 * 4) : font16Offset;
            c.loadSegment(ES, uint16_t(segment)); r[CX] = c.rwF(0x40, 0x85); c.reg8(2, c.rbF(0x40, 0x84));
            return true;
        }
        if (al == 1 || al == 2 || al == 4 || al == 0x11 || al == 0x12 || al == 0x14) {
            if (al >= 0x10) { c.wbF(0x40, 0x84, 24); c.wwF(0x40, 0x85, 16); }
            return true;
        }
        break;
    case 0x12: if (bl == 0x10) { r[BX] = 3; r[CX] = 0; } return true;
    case 0x13: {
        auto saved = biosCursor(); c.wwF(0x40, uint16_t(0x50 + biosPage() * 2), r[DX]);
        uint16_t off = r[BP];
        for (unsigned i = 0; i < r[CX]; ++i) { auto ch = c.rbF(c.s[ES], off++); put(ch, bl); if (al & 2) ++off; }
        if (!(al & 1)) c.wwF(0x40, uint16_t(0x50 + biosPage() * 2), uint16_t(saved)); return true;
    }
    case 0x1a: c.reg8(0, 0x1a); r[BX] = 8; return true;
    case 0x1b: c.reg8(0, 0); return true;
    case 0x6f: r[BX] = 0; return true; // Video Seven extensions are absent.
    case 0xef: return true; // No MSHERC hook; preserve the caller's non-Hercules sentinel.
    case 0xfa:
        if (!r[BX]) return true; // No EGA Register Interface Library driver.
        break;
    }
    throw biosError(c, 0x10);
}
bool Pc::disk() {
    auto& c = cpu; auto& r = c.r; uint8_t drive = c.reg8(2), ah = c.reg8(4);
    bool hd = drive & 0x80; Disk* d = drive == 0 ? floppy.get() : drive == 0x80 ? hard.get() : nullptr;
    auto status = [&](uint8_t code) {
        c.reg8(4, code); c.stackedFlag(CF, code != 0); c.wbF(0x40, hd ? 0x74 : 0x41, code);
    };
    int cylinder = c.reg8(5) | ((c.reg8(1) & 0xc0) << 2), head = c.reg8(6), sector = c.reg8(1) & 63;
    if (ah == 0 || ah == 0x0d) { status(d || drive == 0 ? 0 : 1); return true; }
    if (ah == 1) { auto v = c.rbF(0x40, hd ? 0x74 : 0x41); status(v); return true; }
    if (ah == 8) {
        if (!d && drive != 0) { r[DX] = 0; status(1); return true; }
        int cy = d ? d->cylinders - 1 : 79, heads = d ? d->heads : 2, spt = d ? d->spt : 18;
        r[CX] = uint16_t(((cy & 255) << 8) | ((cy >> 2) & 0xc0) | spt);
        r[DX] = uint16_t(((heads - 1) << 8) | (hd ? (hard ? 1 : 0) : 1));
        if (!hd) { c.reg8(3, d ? uint8_t(d->floppyType) : 4); c.loadSegment(ES, 0xf000); r[DI] = 0xefc7; }
        status(0); return true;
    }
    if (ah == 0x15) {
        c.stackedFlag(CF, false); c.reg8(4, d ? (hd ? 3 : 2) : drive == 0 ? 2 : 0);
        if (d && hd) { r[CX] = uint16_t(d->sectors >> 16); r[DX] = uint16_t(d->sectors); }
        return true;
    }
    if (!d) { status(hd ? 1 : 0x80); return true; }
    if (ah == 0x16) { auto changed = d->changed; d->changed = false; status(changed ? 6 : 0); return true; }
    if (ah == 0x17 || ah == 0x18) { if (ah == 0x18) { c.loadSegment(ES, 0xf000); r[DI] = 0xefc7; } status(0); return true; }
    if (ah == 0x41) { status(1); return true; }
    if (ah == 9 || ah == 0x0c || (ah >= 0x10 && ah <= 0x14)) { status(0); return true; }
    if (ah < 2 || ah > 5) { status(1); notice = "Unsupported INT 13h function " + std::to_string(ah); return true; }
    if (cylinder >= d->cylinders || head >= d->heads || sector < 1 || sector > d->spt) { status(4); c.reg8(0, 0); return true; }
    unsigned count = ah == 5 ? unsigned(d->spt) : c.reg8(0);
    uint32_t lba = unsigned((cylinder * d->heads + head) * d->spt + (ah == 5 ? 0 : sector - 1));
    if (!count || lba + count > d->sectors) { status(4); c.reg8(0, 0); return true; }
    if ((ah == 3 || ah == 5) && d->readOnly) { status(3); c.reg8(0, 0); return true; }
    std::array<uint8_t, 512> buffer{};
    uint32_t addr = (uint32_t(c.s[ES]) << 4) + r[BX];
    for (unsigned i = 0; i < count; ++i) {
        if (ah == 2 || ah == 4) d->read(lba + i, buffer.data());
        if (ah == 2) for (auto v : buffer) { c.writeLinear(addr++ & 0xfffff, v); }
        if (ah == 3) { for (auto& v : buffer) v = c.readLinear(addr++ & 0xfffff); d->write(lba + i, buffer.data()); }
        if (ah == 5) { buffer.fill(0xf6); d->write(lba + i, buffer.data()); }
    }
    if (ah == 3 || ah == 5) d->flush();
    status(0); c.reg8(0, uint8_t(count)); return true;
}
bool Pc::bios(uint8_t n) {
    auto& c = cpu; auto& r = c.r; auto ah = c.reg8(4);
    // HP-HIL installation probes leave BX unchanged on a standard PC/AT.
    if (r[AX] == 0x6f00 && (n == 0x14 || n == 0x16 || n == 0x17)) return true;
    if (n == 0x68 && ah == 0x43) return true; // No resident extender with the F386h signature.
    if (n == 0x67 && r[AX] == 0xde00) { c.reg8(4, 0x84); return true; } // No resident VCPI provider.
    if (n == 0x5c && c.rbF(c.s[ES], r[BX]) == 0x7f) return true; // NetBIOS presence probe; no provider installed.
    switch (n) {
    case 8: {
        uint32_t ticks = c.rwF(0x40, 0x6c) | (uint32_t(c.rwF(0x40, 0x6e)) << 16);
        if (++ticks >= 0x1800b0) { ticks = 0; c.wbF(0x40, 0x70, uint8_t(c.rbF(0x40, 0x70) + 1)); }
        c.wwF(0x40, 0x6c, uint16_t(ticks)); c.wwF(0x40, 0x6e, uint16_t(ticks >> 16)); return true;
    }
    case 9: keyboard(); return true;
    case 0x10: return video();
    case 0x11: r[AX] = c.rwF(0x40, 0x10); return true;
    case 0x12: r[AX] = 640; return true;
    case 0x13: return disk();
    case 0x14:
        if (r[DX] || c.reg8(4) > 3) { c.reg8(4, 0x80); return true; }
        switch (c.reg8(4)) {
        case 0: {
            const unsigned baud[] = {110,150,300,600,1200,2400,4800,9600};
            auto format = c.reg8(0); unsigned divisor = 115200 / baud[format >> 5];
            output(0x3fb, 0x80); output(0x3f8, uint8_t(divisor)); output(0x3f9, uint8_t(divisor >> 8));
            output(0x3fb, format & 31); break;
        }
        case 1:
            output(0x3fc, uint8_t(input(0x3fc) | 3));
            if (!(input(0x3fd) & 0x20)) { c.reg8(4, 0x80); return true; }
            output(0x3f8, c.reg8(0)); c.reg8(4, input(0x3fd)); return true;
        case 2:
            if (!(input(0x3fd) & 1)) { c.reg8(4, 0x80); return true; }
            c.reg8(0, input(0x3f8)); c.reg8(4, input(0x3fd)); return true;
        }
        c.reg8(4, input(0x3fd)); c.reg8(0, input(0x3fe)); return true;
    case 0x15:
        if (ah == 0x88) { r[AX] = at() ? 15360 : 0; c.stackedFlag(CF, false); }
        else if (at() && ah == 0x24 && c.reg8(0) <= 3) {
            switch (c.reg8(0)) {
            case 0: case 1:
                c.a20 = c.reg8(0) != 0; kbdOutput = uint8_t((kbdOutput & ~2) | (c.a20 ? 2 : 0));
                fastA20 = uint8_t((fastA20 & ~2) | (c.a20 ? 2 : 0)); r[AX] = 0; break;
            case 2: r[AX] = c.a20 ? 1 : 0; r[CX] = 0; break;
            case 3: r[AX] = 0; r[BX] = 3; break;
            }
            c.stackedFlag(CF, false);
        }
        else if (at() && ah == 0x87) {
            uint32_t table = (uint32_t(c.s[ES]) << 4) + r[SI], count = uint32_t(r[CX]) * 2;
            auto base = [&](uint32_t entry) {
                return uint32_t(c.readLinear(entry + 2)) | (uint32_t(c.readLinear(entry + 3)) << 8)
                    | (uint32_t(c.readLinear(entry + 4)) << 16);
            };
            uint32_t source = base(table + 16), target = base(table + 24);
            bool invalid = count && (count - 1 > c.rwF(c.s[ES], uint16_t(r[SI] + 16)) || count - 1 > c.rwF(c.s[ES], uint16_t(r[SI] + 24))
                || source + count > c.mem.size() || target + count > c.mem.size());
            if (!invalid) {
                bool enabled = c.a20; c.a20 = true;
                for (uint32_t i = 0; i < count; ++i) c.writePhysical(target + i, c.readPhysical(source + i));
                c.a20 = enabled;
            }
            c.reg8(4, invalid ? 2 : 0); c.stackedFlag(CF, invalid);
        }
        else { c.reg8(4, 0x86); c.stackedFlag(CF, true); }
        return true;
    case 0x16: {
        auto head = c.rwF(0x40, 0x1a), tail = c.rwF(0x40, 0x1c);
        if (ah == 0 || ah == 0x10) {
            if (head == tail) return false;
            r[AX] = c.rwF(0x40, head); head += 2; if (head >= 0x3e) head = 0x1e;
            c.wwF(0x40, 0x1a, head); return true;
        }
        if (ah == 1 || ah == 0x11) { c.stackedFlag(ZF, head == tail); if (head != tail) r[AX] = c.rwF(0x40, head); return true; }
        if (ah == 2) { c.reg8(0, c.rbF(0x40, 0x17)); return true; }
        if (ah == 3) return true;
        // DOS probes for third-party keyboard extensions; an XT BIOS leaves AX unchanged.
        if (ah == 0x92 || ah == 0xa2) return true;
        // No ETen Chinese keyboard extension or QBASIC-compatible resident TSR.
        if (r[AX] == 0xdb00 || r[AX] == 0x55fe) return true;
        if (ah == 0x12) { r[AX] = c.rbF(0x40, 0x17); return true; }
        if (ah == 5) {
            auto next = uint16_t(tail + 2); if (next >= 0x3e) next = 0x1e;
            c.reg8(0, next == head ? 1 : 0); if (next != head) { c.wwF(0x40, tail, r[CX]); c.wwF(0x40, 0x1c, next); } return true;
        }
        throw biosError(c, 0x16);
    }
    case 0x17: c.reg8(4, 1); return true;
    case 0x19: rebootRequested = true; return true;
    case 0x1a: {
        auto bcd = [](int v) { return uint8_t((v / 10) * 16 + v % 10); };
        auto now = std::time(nullptr); std::tm t{}; localtime_s(&t, &now);
        if (ah == 0) { r[CX] = c.rwF(0x40, 0x6e); r[DX] = c.rwF(0x40, 0x6c); c.reg8(0, c.rbF(0x40, 0x70)); c.wbF(0x40, 0x70, 0); }
        else if (ah == 1) { c.wwF(0x40, 0x6e, r[CX]); c.wwF(0x40, 0x6c, r[DX]); }
        else if (ah == 2) { r[CX] = uint16_t((unsigned(bcd(t.tm_hour)) << 8) | bcd(t.tm_min)); r[DX] = uint16_t(unsigned(bcd(t.tm_sec)) << 8); }
        else if (ah == 4) { int year = t.tm_year + 1900; r[CX] = uint16_t((unsigned(bcd(year / 100)) << 8) | bcd(year % 100)); r[DX] = uint16_t((unsigned(bcd(t.tm_mon + 1)) << 8) | bcd(t.tm_mday)); }
        else { c.stackedFlag(CF, true); return true; }
        c.stackedFlag(CF, false); return true;
    }
    case 0x1b: case 0x1c: case 0x23: case 0x24: return true;
    case 0x18: throw std::runtime_error("Guest invoked INT 18h: no bootable system");
    case 0x2f: return true; // No resident multiplex services in the firmware.
    case 0x33: if (r[AX] == 0) r[AX] = 0; return true;
    default: throw biosError(c, n);
    }
}
}
