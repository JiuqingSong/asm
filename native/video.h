#pragma once
#include <array>
#include <cstdint>
#include <vector>

namespace asm86 {
class Vga {
public:
    Vga();
    void setMode(uint8_t value, bool clear = true);
    bool graphics() const { return gc[6] & 1; }
    bool indexed256() const { return gc[5] & 0x40; }
    uint8_t textByte(unsigned offset) const { return planes[offset & 1][(offset >> 1) & 65535]; }
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
    std::array<uint8_t, 8> seq{};
    std::array<uint8_t, 16> gc{};
    std::array<uint8_t, 32> crtc{};
    std::array<uint8_t, 21> attr{};
    std::array<uint8_t, 768> dac{};
private:
    std::array<std::array<uint8_t, 65536>, 4> planes{};
    std::array<uint8_t, 4> latch{};
    uint8_t seqIndex = 0, gcIndex = 0, crtcIndex = 0, attrAddress = 0x20, misc = 0x67;
    uint8_t pelMask = 255, readIndex = 0, writeIndex = 0, readPart = 0, writePart = 0, dacState = 0;
    bool attrData = false;
    int offset(uint32_t address) const;
};
}
