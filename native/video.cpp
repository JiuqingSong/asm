#include "video.h"
#include <algorithm>
#include <stdexcept>
#include <string>

namespace asm86 {
Vga::Vga() { setMode(3); }
unsigned Vga::width() const { return mode == 0x0d || mode == 0x13 ? 320 : 640; }
unsigned Vga::height() const {
    return mode == 0x12 ? 480 : mode == 0x10 ? 350 : graphics() ? 200 : 400;
}
unsigned Vga::charHeight() const { return mode == 0x10 ? 14 : mode == 0x12 || !graphics() ? 16 : 8; }
void Vga::setMode(uint8_t value, bool clear) {
    if (value > 3 && value != 0x0d && value != 0x0e && value != 0x10 && value != 0x12 && value != 0x13)
        throw std::runtime_error("Unsupported native VGA mode " + std::to_string(value));
    mode = value;
    if (clear) for (auto& plane : planes) plane.fill(0);
    latch.fill(0); seq.fill(0); gc.fill(0); attr.fill(0);
    seqIndex = gcIndex = crtcIndex = readIndex = writeIndex = readPart = writePart = dacState = 0;
    attrAddress = 0x20; attrData = false; pelMask = 255;
    seq[0] = 3; seq[1] = mode == 0x0d ? 9 : 1;
    seq[2] = graphics() ? 15 : 3; seq[4] = mode == 0x13 ? 14 : graphics() ? 6 : 2;
    gc[5] = mode == 0x13 ? 0x40 : graphics() ? 0 : 0x10;
    gc[6] = graphics() ? 5 : 14; gc[7] = 15; gc[8] = 255;
    const uint8_t palette[] = {0,1,2,3,4,5,0x14,7,0x38,0x39,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f};
    std::copy(std::begin(palette), std::end(palette), attr.begin());
    attr[0x10] = mode == 0x13 ? 0x41 : graphics() ? 1 : 0x0c; attr[0x12] = 15;
    if (mode == 0x0d || mode == 0x0e || mode == 0x13)
        for (unsigned i = 0; i < 16; ++i) attr[i] = uint8_t(i);
    misc = mode == 0x12 ? 0xe3 : mode == 0x10 ? 0xa3 : graphics() ? 0x63 : 0x67;
    crtc = {0x5f,0x4f,0x50,0x82,0x54,0x80,0xbf,0x1f,0,0x40,0,0,0,0,0,0,
        0x9c,0x8e,0x8f,0x28,0,0x96,0xb9,0xe3,0xff};
    if (mode == 0x12) {
        crtc[6] = 0x0b; crtc[7] = 0x3e; crtc[0x10] = 0xea; crtc[0x11] = 0x8c;
        crtc[0x12] = 0xdf; crtc[0x15] = 0xe7; crtc[0x16] = 4;
    } else if (mode == 0x10) {
        crtc[0x10] = 0x83; crtc[0x11] = 0x85; crtc[0x12] = 0x5d; crtc[0x14] = 15;
        crtc[0x15] = 0x63; crtc[0x16] = 0xba;
    } else if (mode == 0x13) {
        crtc[9] = 0x41; crtc[0x14] = 0x40; crtc[0x17] = 0xa3;
    } else if (mode == 0x0d || mode == 0x0e) {
        crtc[9] = 0xc0;
        if (mode == 0x0d) { crtc[0] = 0x2d; crtc[1] = 0x27; crtc[0x13] = 0x14; }
    } else {
        seq[1] = mode < 2 ? 8 : 0;
        crtc[9] = 0x4f; crtc[10] = 13; crtc[11] = 14; crtc[0x14] = 0x1f; crtc[0x17] = 0xa3;
        if (mode < 2) { crtc[0] = 0x2d; crtc[1] = 0x27; crtc[0x13] = 0x14; }
    }
    dac.fill(0);
    const uint8_t ega16[16][3] = {
        {0,0,0},{0,0,42},{0,42,0},{0,42,42},{42,0,0},{42,0,42},{42,21,0},{42,42,42},
        {21,21,21},{21,21,63},{21,63,21},{21,63,63},{63,21,21},{63,21,63},{63,63,21},{63,63,63}
    };
    if (mode == 0x13 || mode == 0x0d || mode == 0x0e) {
        for (unsigned i = 0; i < 16; ++i) std::copy(ega16[i], ega16[i] + 3, dac.begin() + i * 3);
    } else for (unsigned i = 0; i < 64; ++i) {
        dac[i * 3] = uint8_t(((i >> 2) & 1) * 42 + ((i >> 5) & 1) * 21);
        dac[i * 3 + 1] = uint8_t(((i >> 1) & 1) * 42 + ((i >> 4) & 1) * 21);
        dac[i * 3 + 2] = uint8_t((i & 1) * 42 + ((i >> 3) & 1) * 21);
    }
    if (mode == 0x13) {
        const uint8_t grays[] = {0,5,8,11,14,17,20,24,28,32,36,40,45,50,56,63};
        for (unsigned i = 0; i < 16; ++i) std::fill_n(dac.begin() + (16 + i) * 3, 3, grays[i]);
        const unsigned groups[][2] = {{63,0},{63,31},{63,45},{28,0},{28,14},{28,20},{16,0},{16,8},{16,11}};
        unsigned index = 32;
        for (const auto& group : groups) {
            unsigned hi = group[0], lo = group[1], steps[5]{};
            for (unsigned k = 0; k < 5; ++k) steps[k] = lo + ((hi - lo) * k + 2) / 4;
            auto set = [&](unsigned r, unsigned g, unsigned b) {
                dac[index * 3] = uint8_t(r); dac[index * 3 + 1] = uint8_t(g); dac[index++ * 3 + 2] = uint8_t(b);
            };
            for (unsigned k = 0; k < 4; ++k) set(steps[k], lo, hi);
            for (unsigned k = 0; k < 4; ++k) set(hi, lo, steps[4 - k]);
            for (unsigned k = 0; k < 4; ++k) set(hi, steps[k], lo);
            for (unsigned k = 0; k < 4; ++k) set(steps[4 - k], hi, lo);
            for (unsigned k = 0; k < 4; ++k) set(lo, hi, steps[k]);
            for (unsigned k = 0; k < 4; ++k) set(lo, steps[4 - k], hi);
        }
    }
}
int Vga::offset(uint32_t address) const {
    if (address < 0xa0000 || address >= 0xc0000) return -1;
    switch ((gc[6] >> 2) & 3) {
    case 0: return int(address - 0xa0000);
    case 1: return address < 0xb0000 ? int(address - 0xa0000) : -1;
    case 2: return address >= 0xb0000 && address < 0xb8000 ? int(address - 0xb0000) : -1;
    default: return address >= 0xb8000 ? int(address - 0xb8000) : -1;
    }
}
uint8_t Vga::read(uint32_t address) {
    int off = offset(address); if (off < 0) return 255;
    if (seq[4] & 8) return planes[off & 3][(off >> 2) & 65535];
    if (!(seq[4] & 4)) return planes[off & 1][off & 65534];
    for (unsigned p = 0; p < 4; ++p) latch[p] = planes[p][off & 65535];
    if (!(gc[5] & 8)) return latch[gc[4] & 3];
    uint8_t result = 255;
    for (unsigned p = 0; p < 4; ++p)
        if (gc[7] & (1 << p)) result &= gc[2] & (1 << p) ? latch[p] : uint8_t(~latch[p]);
    return result;
}
void Vga::write(uint32_t address, uint8_t value) {
    int off = offset(address); if (off < 0) return;
    if ((seq[4] & 8) || !(seq[4] & 4)) {
        unsigned p = off & (seq[4] & 8 ? 3 : 1);
        if (seq[2] & (1 << p)) planes[p][seq[4] & 8 ? (off >> 2) & 65535 : off & 65534] = value;
        return;
    }
    unsigned wm = gc[5] & 3, rotation = gc[3] & 7, operation = (gc[3] >> 3) & 3;
    if ((wm == 0 || wm == 3) && rotation) value = uint8_t((value >> rotation) | (value << (8 - rotation)));
    uint8_t mask = wm == 3 ? uint8_t(gc[8] & value) : gc[8];
    for (unsigned p = 0; p < 4; ++p) {
        if (!(seq[2] & (1 << p))) continue;
        uint8_t data = latch[p];
        if (wm != 1) {
            if (wm == 0) data = gc[1] & (1 << p) ? (gc[0] & (1 << p) ? 255 : 0) : value;
            else data = (wm == 2 ? value : gc[0]) & (1 << p) ? 255 : 0;
            if (operation == 1) data &= latch[p];
            else if (operation == 2) data |= latch[p];
            else if (operation == 3) data ^= latch[p];
            data = uint8_t((data & mask) | (latch[p] & ~mask));
        }
        planes[p][off & 65535] = data;
    }
}
uint8_t Vga::pixel(unsigned x, unsigned y) const {
    if (x >= width() || y >= height()) throw std::runtime_error("VGA pixel is outside the display");
    if (mode == 0x13) {
        auto off = y * width() + x;
        return planes[off & 3][(off >> 2) & 65535];
    }
    unsigned off = (y * (crtc[0x13] * 2) + x / 8 + ((unsigned(crtc[12]) << 8) | crtc[13])) & 65535;
    uint8_t result = 0;
    for (unsigned p = 0; p < 4; ++p) result |= uint8_t(((planes[p][off] >> (7 - (x & 7))) & 1) << p);
    return result;
}
void Vga::pixel(unsigned x, unsigned y, uint8_t value, bool exclusiveOr) {
    if (x >= width() || y >= height()) throw std::runtime_error("VGA pixel is outside the display");
    if (mode == 0x13) {
        auto off = y * width() + x;
        planes[off & 3][off >> 2] = value;
        return;
    }
    unsigned off = y * (width() / 8) + x / 8, mask = 0x80 >> (x & 7);
    for (unsigned p = 0; p < 4; ++p) {
        auto& byte = planes[p][off];
        if (exclusiveOr) { if (value & (1 << p)) byte ^= uint8_t(mask); }
        else byte = uint8_t(value & (1 << p) ? byte | mask : byte & ~mask);
    }
}
uint8_t Vga::paletteIndex(uint8_t value) const {
    auto palette = attr[value & attr[0x12] & 15], select = attr[0x14];
    return uint8_t(((select & 12) << 4) | ((attr[0x10] & 0x80) ? ((select & 3) << 4) | (palette & 15) : palette & 63));
}
uint32_t Vga::color(uint8_t index) const {
    unsigned off = (index & pelMask) * 3;
    return (uint32_t(dac[off] * 255 / 63) << 16) | (uint32_t(dac[off + 1] * 255 / 63) << 8) | (dac[off + 2] * 255 / 63);
}
uint8_t Vga::input(uint16_t port) {
    switch (port) {
    case 0x3c0: return attrAddress;
    case 0x3c1: return (attrAddress & 31) < attr.size() ? attr[attrAddress & 31] : 0;
    case 0x3c4: return seqIndex;
    case 0x3c5: return seq[seqIndex & 7];
    case 0x3c6: return pelMask;
    case 0x3c7: return dacState;
    case 0x3c8: return writeIndex;
    case 0x3c9: {
        auto value = dac[readIndex * 3 + readPart];
        if (++readPart == 3) { readPart = 0; ++readIndex; } return value;
    }
    case 0x3cc: return misc;
    case 0x3ce: return gcIndex;
    case 0x3cf: return gc[gcIndex & 15];
    case 0x3b4: case 0x3d4: return crtcIndex;
    case 0x3b5: case 0x3d5: return crtc[crtcIndex & 31];
    case 0x3ba: case 0x3da: attrData = false; return 0;
    }
    return 255;
}
bool Vga::output(uint16_t port, uint8_t value) {
    switch (port) {
    case 0x3c0:
        if (!attrData) attrAddress = value & 63;
        else if ((attrAddress & 31) < attr.size()) attr[attrAddress & 31] = value;
        attrData = !attrData; return true;
    case 0x3c2: misc = value; return true;
    case 0x3c4: seqIndex = value; return true;
    case 0x3c5: seq[seqIndex & 7] = value; return true;
    case 0x3c6: pelMask = value; return true;
    case 0x3c7: readIndex = value; readPart = 0; dacState = 3; return true;
    case 0x3c8: writeIndex = value; writePart = 0; dacState = 0; return true;
    case 0x3c9:
        dac[writeIndex * 3 + writePart] = value & 63;
        if (++writePart == 3) { writePart = 0; ++writeIndex; } return true;
    case 0x3ce: gcIndex = value; return true;
    case 0x3cf: gc[gcIndex & 15] = value; return true;
    case 0x3b4: case 0x3d4: crtcIndex = value; return true;
    case 0x3b5: case 0x3d5: crtc[crtcIndex & 31] = value; return true;
    }
    return false;
}
}
