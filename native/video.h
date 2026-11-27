#pragma once
#include <array>
#include <cstdint>
#include <vector>

namespace asm86 {
// 端口状态公开给 BIOS 生成配置表，显存平面/锁存器保留在设备内部。
class Vga {
public:
    Vga();
    void enableCirrus(bool enabled);
    bool cirrus() const { return !vram.empty(); }
    bool packed() const { return cirrus() && (seq[7] & 1); }
    unsigned bitsPerPixel() const;
    static constexpr uint32_t VramBytes = 4 * 1024 * 1024;
    uint8_t linearRead(uint32_t offset);
    void linearWrite(uint32_t offset, uint8_t value);
    uint8_t registerRead(unsigned offset);
    void registerWrite(unsigned offset, uint8_t value);
    void setMode(uint8_t value, bool clear = true);
    bool graphics() const { return packed() || (gc[6] & 1); }
    bool indexed256() const { return packed() ? bitsPerPixel() == 8 : (gc[5] & 0x40) != 0; }
    uint8_t textByte(unsigned offset) const { return planeByte(offset & 1, (offset >> 1) & 65535); }
    unsigned width() const;
    unsigned height() const;
    unsigned charHeight() const;
    uint8_t read(uint32_t address);
    void write(uint32_t address, uint8_t value);
    uint8_t input(uint16_t port);
    bool output(uint16_t port, uint8_t value);
    uint8_t pixel(unsigned x, unsigned y) const;
    void pixel(unsigned x, unsigned y, uint8_t color, bool exclusiveOr = false);
    uint8_t paletteIndex(uint8_t color) const;
    uint32_t color(uint8_t index) const;
    void renderGraphics(std::vector<uint32_t>& pixels) const;
    bool blanked() const { return (seq[1] & 0x20) || !(attrAddress & 0x20); }
    uint8_t mode = 3;
    std::array<uint8_t, 32> seq{};
    std::array<uint8_t, 64> gc{};
    std::array<uint8_t, 256> crtc{};
    std::array<uint8_t, 21> attr{};
    std::array<uint8_t, 768> dac{};
private:

    // 四平面各 64 KiB；latch 是最近一次显存读取，写入模式会用它保留未覆盖的位。
    std::array<std::array<uint8_t, 65536>, 4> planes{};
    std::array<uint8_t, 4> latch{};
    std::vector<uint8_t> vram;
    std::array<uint8_t, 48> cursorDac{};
    uint8_t hiddenDac = 0, hiddenAccess = 0;
    unsigned cursorX = 0, cursorY = 0;
    std::array<uint8_t, 64> blt{};
    std::vector<uint8_t> bltSource;
    unsigned bltSourcePitch = 0, bltRows = 0, bltPadding = 0;
    uint8_t planeByte(unsigned plane, unsigned index) const;
    void planeByte(unsigned plane, unsigned index, uint8_t value);
    unsigned bankAddress(unsigned offset) const;
    unsigned displayStart() const;
    unsigned displayPitch() const;
    uint32_t packedColor(unsigned offset) const;
    void renderCursor(std::vector<uint32_t>& pixels) const;
    void startBlt();
    void executeBlt();
    bool feedBlt(uint8_t value);
    void graphicsRegister(unsigned index, uint8_t value);
    uint8_t seqIndex = 0, gcIndex = 0, crtcIndex = 0, attrAddress = 0x20, misc = 0x67;
    uint8_t pelMask = 255, readIndex = 0, writeIndex = 0, readPart = 0, writePart = 0, dacState = 0;
    bool attrData = false;
    int offset(uint32_t address) const;
};
}
