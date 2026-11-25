#pragma once
#include "cpu.h"
#include "video.h"
#include "serial.h"
#include "at.h"
#include "ide.h"
#include "atapi.h"
#include "dma.h"
#include "fdc.h"
#include <ctime>
#include <filesystem>
#include <memory>
#include <string>
#include <deque>
#include <limits>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace asm86 {
class Disk {
public:
    Disk(const std::filesystem::path& path, bool floppy, bool readOnly);
    ~Disk();
    Disk(const Disk&) = delete;
    Disk& operator=(const Disk&) = delete;
    static void create(const std::filesystem::path& path, unsigned cylinders = 64);
    bool read(uint32_t lba, uint8_t* data);
    bool write(uint32_t lba, const uint8_t* data);
    void flush();
    uint32_t sectors = 0;
    int cylinders = 0, heads = 0, spt = 0, floppyType = 0;
    bool readOnly = false, changed = true;
    std::filesystem::path path;
    const uint64_t identity;
private:
    HANDLE file = INVALID_HANDLE_VALUE;
    bool transfer(uint32_t lba, uint8_t* data, bool writing);
};

class Pc {
public:
    Cpu cpu;
    Vga vga;
    SerialMouse serialMouse;
    IdeChannel ide;
    AtapiCdrom cdrom;
    DmaController dma;
    FloppyController fdc;
    std::unique_ptr<Disk> floppy, hard;
    uint64_t instructions = 0;
    double clock = 0;
    uint8_t bootDrive = 0;
    bool rebootRequested = false;
    std::string notice;
    Pc();
    void setModel(CpuModel model);
    bool at() const { return cpu.model != CpuModel::I8088; }
    void boot(uint8_t drive);
    void run(unsigned budget, double untilClock = std::numeric_limits<double>::infinity());
    void runCpu(unsigned budget);
    void advanceClock(double target);
    void key(uint8_t scan, uint8_t ascii);
    void modifiers(uint8_t value);
    std::string text() const;
    unsigned columns() const;
    unsigned activePage() const;
    unsigned cursor() const;
private:
    std::array<Pic, 2> pic{};
    std::array<uint8_t, 128> cmos{};
    uint8_t cmosIndex = 0, kbdCommand = 0x45, kbdOutput = 1, kbdWrite = 0, fastA20 = 0;
    bool pendingReset = false;
    std::deque<uint8_t> controller;
    double nextRtc = std::numeric_limits<double>::infinity();
    std::time_t rtcEpoch = 0;
    std::deque<uint16_t> keys;
    uint16_t keyboardLatch = 0;
    bool keyboardRead = false;
    std::array<uint16_t, 3> reload{0, 0, 0};
    std::array<uint16_t, 3> latch{};
    std::array<uint8_t, 3> access{3, 3, 3}, pitMode{3, 3, 3};
    std::array<bool, 3> writeHigh{}, readHigh{}, latched{};
    uint8_t port61 = 0, crtcIndex = 0;
    double nextTimer = 65536;
    uint8_t input(uint16_t port);
    void output(uint16_t port, uint8_t value);
    int acknowledge();
    bool bios(uint8_t number);
    bool video();
    bool disk();
    unsigned biosColumns();
    unsigned biosPage();
    unsigned biosCursor();
    void put(uint8_t ch, uint8_t attr = 7);
    void scroll(unsigned top, unsigned left, unsigned bottom, unsigned right, unsigned lines, uint8_t attr, bool down);
    void keyboard();
    void resetAt();
    void resetCpu();
    void stepCpu();
    void keyboardCommand(uint8_t value);
    void keyboardData(uint8_t value);
    uint8_t cmosRead();
    void cmosWrite(uint8_t value);
    void rtcSchedule();
    double rtcPeriod() const;
    void rtcAdvance();
    void keyboardIrq();
};
}
