#pragma once
#include "cpu.h"
#include "video.h"
#include "serial.h"
#include "at.h"
#include "ide.h"
#include "atapi.h"
#include "dma.h"
#include "fdc.h"
#include "sound.h"
#include <ctime>
#include <filesystem>
#include <memory>
#include <string>
#include <deque>
#include <limits>
#include <unordered_map>
#include <vector>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace asm86 {
// 扇区后端由 BIOS、ATA 和 FDC 共用；文件句柄独占可写方，复制 Disk 会破坏所有权。
class Disk {
    friend class Snapshot;
public:
    Disk(const std::filesystem::path& path, bool floppy, bool readOnly, const std::filesystem::path& overlay = {});
    Disk(const std::filesystem::path& path, std::vector<uint8_t> floppyImage);
    ~Disk();
    Disk(const Disk&) = delete;
    Disk& operator=(const Disk&) = delete;
    static void create(const std::filesystem::path& path, unsigned cylinders = 64);
    static constexpr uint64_t MaxHardBytes = 32ULL * 1024 * 1024 * 1024;
    static void createBytes(const std::filesystem::path& path, uint64_t bytes);
    int biosHeads() const;
    int biosCylinders() const;
    bool read(uint32_t lba, uint8_t* data);
    bool write(uint32_t lba, const uint8_t* data);
    void flush();
    void discardOverlay();
    bool hasOverlay() const { return overlayFile != INVALID_HANDLE_VALUE; }
    const std::filesystem::path& overlayPath() const { return differential; }
    uint32_t sectors = 0;
    int cylinders = 0, heads = 0, spt = 0, floppyType = 0;
    bool readOnly = false, changed = true;
    uint64_t readSectors = 0, writtenSectors = 0;
    std::filesystem::path path;
    const uint64_t identity;
private:

    // 差分索引只记录各 LBA 最新数据偏移；历史记录留在追加日志中，不自动合并到底盘。
    HANDLE file = INVALID_HANDLE_VALUE;
    HANDLE overlayFile = INVALID_HANDLE_VALUE;
    std::filesystem::path differential;
    std::unordered_map<uint32_t, uint64_t> overlayIndex;
    std::vector<uint8_t> memory;
    uint64_t overlayEnd = 64;
    bool ownedOverlay = false;
    std::array<uint8_t, 32> snapshotHash() const;
    void setGeometry(bool floppy);
    void openOverlay();
    bool transfer(uint32_t lba, uint8_t* data, bool writing);
};

class Pc {
    friend class Snapshot;
public:

    // 设备共用以 PIT 输入频率为单位的虚拟时钟；CPU 指令数与宿主耗时分别计量。
    Cpu cpu;
    Vga vga;
    SerialMouse serialMouse;
    IdeChannel ide;
    AtapiCdrom cdrom;
    DmaController dma;
    FloppyController fdc;
    SoundBlaster sound;
    std::unique_ptr<Disk> floppy, hard;
    uint64_t instructions = 0;
    double clock = 0;
    uint8_t bootDrive = 0;
    static constexpr uint8_t CdBootDrive = 0xe0;
    bool rebootRequested = false;
    bool powerOffRequested = false;
    std::string notice;
    Pc();
    void setModel(CpuModel model, unsigned memoryMiB = 0);
    void setCirrus(bool enabled);
    bool at() const { return cpu.model != CpuModel::I8088; }
    void boot(uint8_t drive);
    uint8_t restartDrive() const { return bootDrive == CdBootDrive ? CdBootDrive : floppy ? 0 : 0x80; }
    Disk* floppyDisk(uint8_t drive = 0) const;
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

    // AT 使用级联 8259、CMOS/RTC、8042、DMA/FDC；XT 仍保留自己的键盘/PIT路径。
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
    std::array<double, 3> pitStart{};
    std::array<uint16_t, 3> latch{};
    std::array<uint8_t, 3> access{3, 3, 3}, pitMode{3, 3, 3};
    std::array<bool, 3> writeHigh{}, readHigh{}, latched{};
    uint8_t port61 = 0, crtcIndex = 0;
    double nextTimer = 65536;
    uint16_t pitCounter(unsigned channel) const;
    uint8_t input(uint16_t port);
    void output(uint16_t port, uint8_t value);
    int acknowledge();
    bool bios(uint8_t number);
    bool apm();
    bool apmConnected = false, apmEnabled = true, apmEngaged = true;
    uint16_t apmVersion = 0x0100;
    bool video();
    uint32_t pciAddress = 0, pciFramebuffer = 0xe0000000, pciRegisters = 0xe2000000;
    static constexpr uint32_t PciRomBytes = 0x8000;
    uint32_t pciRomAddress = 0xc0000;
    std::vector<uint8_t> pciRom;
    uint16_t pciCommand = 3;
    uint8_t pciLatency = 0;
    void mapPci();
    void installCirrusRom();
    uint8_t pciRead(unsigned offset) const;
    void pciWrite(unsigned offset, uint8_t value);
    bool pciBios(bool protectedCall);
    bool disk();
    std::unique_ptr<Disk> cdFloppy;
    uint8_t cdBootMedia = 0xff, cdStatus = 0;
    uint16_t cdLoadSegment = 0, cdLoadCount = 0;
    uint32_t cdImageLba = 0;
    unsigned biosColumns();
    unsigned biosPage();
    unsigned biosCursor();
    bool biosGraphics();
    unsigned biosCharacterHeight();
    unsigned biosRows();
    uint8_t glyphByte(uint8_t ch, unsigned row);
    void drawGlyph(unsigned column, unsigned row, uint8_t ch, uint8_t color);
    uint8_t readGlyph(unsigned column, unsigned row);
    void put(uint8_t ch, uint8_t attr = 7, unsigned page = 8, bool writeAttribute = false);
    void scroll(unsigned top, unsigned left, unsigned bottom, unsigned right, unsigned lines, uint8_t attr, bool down, unsigned page = 8);
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
