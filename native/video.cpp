#include "video.h"
#include "font8x8.h"
#include <algorithm>
#include <stdexcept>
#include <string>

// VGA 的端口/平面/锁存器模型：客体可直接改寄存器，显示尺寸不能只依赖最近 BIOS 模式号。
namespace asm86 {
Vga::Vga() { setMode(3); }

void Vga::enableCirrus(bool enabled) {
    if (enabled) vram.assign(VramBytes, 0);
    else vram.clear();
    setMode(3);
}

unsigned Vga::bitsPerPixel() const {
    if (!packed()) return indexed256() ? 8 : 4;
    switch (seq[7] & 14) {
    case 0: return 8;
    case 4: return 24;
    case 6: return (hiddenDac & 0xc0) == 0xc0 && (hiddenDac & 15) == 10 ? 8 : 16;
    case 8: return 32;
    default: throw std::runtime_error("Unsupported Cirrus pixel clocking mode");
    }
}

unsigned Vga::width() const {
    if (packed()) return (unsigned(crtc[1]) + 1) * 8;
    return graphics() ? (unsigned(crtc[1]) + 1) * (indexed256() ? 4 : 8) : 640;
}

unsigned Vga::height() const {
    if (!graphics()) return 400;
    unsigned lines = (unsigned(crtc[0x12]) | ((crtc[7] & 2) << 7) | ((crtc[7] & 0x40) << 3)) + 1;
    return std::max(1u, lines / ((crtc[9] & 31) + 1) / (crtc[9] & 0x80 ? 2 : 1));
}

unsigned Vga::charHeight() const { return mode == 0x10 ? 14 : mode == 0x12 || !graphics() ? 16 : 8; }

void Vga::setMode(uint8_t value, bool clear) {
    // 0..3 文本；0D 320×200、0E 640×200、10 640×350、12 640×480 四平面 16 色；
    // 13 为 320×200×256 色。以下数组是 VGA 寄存器/颜色数据，不是 x86 机器码。
    bool extended = cirrus() && (value == 0x5f || value == 0x5c || value == 0x60);
    if (value > 3 && value != 0x0d && value != 0x0e && value != 0x10 && value != 0x12 && value != 0x13 && !extended)
        throw std::runtime_error("Unsupported native VGA mode " + std::to_string(value));
    mode = value;
    const bool graphical = mode >= 0x0d;
    if (clear) {
        for (auto& plane : planes) plane.fill(0);
        std::fill(vram.begin(), vram.end(), 0);
    }
    if (!graphical)
        for (unsigned ch = 0; ch < 256; ++ch)
            for (unsigned row = 0; row < 16; ++row)
                planeByte(2, ch * 32 + row, biosFont8x8[ch * 8 + row / 2]);
    latch.fill(0); seq.fill(0); gc.fill(0); attr.fill(0);
    seqIndex = gcIndex = crtcIndex = readIndex = writeIndex = readPart = writePart = dacState = 0;
    attrAddress = 0x20; attrData = false; pelMask = 255;
    hiddenDac = hiddenAccess = 0; cursorX = cursorY = 0;
    bltSource.clear(); bltRows = bltPadding = 0;
    seq[0] = 3; seq[1] = mode == 0x0d ? 9 : 1;
    seq[2] = graphical ? 15 : 3; seq[4] = mode == 0x13 ? 14 : graphical ? 6 : 2;
    gc[5] = mode == 0x13 ? 0x40 : graphical ? 0 : 0x10;
    gc[6] = graphical ? 5 : 14; gc[7] = 15; gc[8] = 255;
    const uint8_t palette[] = {0,1,2,3,4,5,0x14,7,0x38,0x39,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f};
    std::copy(std::begin(palette), std::end(palette), attr.begin());
    attr[0x10] = mode == 0x13 ? 0x41 : graphical ? 1 : 0x0c; attr[0x12] = 15;
    if (mode == 0x0d || mode == 0x0e || mode == 0x13)
        for (unsigned i = 0; i < 16; ++i) attr[i] = uint8_t(i);
    misc = mode == 0x12 ? 0xe3 : mode == 0x10 ? 0xa3 : graphical ? 0x63 : 0x67;
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
    if (cirrus()) {
        seq[6] = 0x12; seq[0x0f] = 0x98; seq[0x1f] = 0x22;
        crtc[0x27] = 0xb8;
        if (extended) {
            unsigned columns = value == 0x5f ? 640 : value == 0x5c ? 800 : 1024;
            unsigned rows = value == 0x5f ? 480 : value == 0x5c ? 600 : 768;
            seq[7] = 0x11; seq[4] = 14; gc[5] = 0x40; gc[6] = 5;
            crtc[1] = uint8_t(columns / 8 - 1); crtc[9] = 0;
            crtc[0x12] = uint8_t(rows - 1);
            crtc[7] = uint8_t(((rows - 1) & 0x100 ? 2 : 0) | ((rows - 1) & 0x200 ? 0x40 : 0));
            crtc[0x13] = uint8_t(columns / 8); crtc[0x1b] = 2; crtc[0x17] = 0xe3;
        }
    }
}

uint8_t Vga::planeByte(unsigned plane, unsigned index) const {
    return cirrus() ? vram[(index * 4 + plane) & (VramBytes - 1)] : planes[plane][index & 65535];
}

void Vga::planeByte(unsigned plane, unsigned index, uint8_t value) {
    if (cirrus()) vram[(index * 4 + plane) & (VramBytes - 1)] = value;
    else planes[plane][index & 65535] = value;
}

unsigned Vga::bankAddress(unsigned off) const {
    unsigned bank = gc[9];
    if (gc[0x0b] & 1) { bank = gc[off & 0x8000 ? 10 : 9]; off &= 0x7fff; }
    else off &= 0xffff;
    return (off + (bank << (gc[0x0b] & 0x20 ? 14 : 12))) & (VramBytes - 1);
}

int Vga::offset(uint32_t address) const {
    // GC6 选择 A0000 的 128/64 KiB、B0000 或 B8000 的 32 KiB CPU 访问窗口。
    if (address < 0xa0000 || address >= 0xc0000) return -1;
    switch ((gc[6] >> 2) & 3) {
    case 0: return int(address - 0xa0000);
    case 1: return address < 0xb0000 ? int(address - 0xa0000) : -1;
    case 2: return address >= 0xb0000 && address < 0xb8000 ? int(address - 0xb0000) : -1;
    default: return address >= 0xb8000 ? int(address - 0xb8000) : -1;
    }
}

uint8_t Vga::read(uint32_t address) {
    // 每次读取装入四个 latch；chain4 按低地址位选平面，奇偶模式分开字符/属性。
    // Read Mode 1 用 Color Compare/Don't Care 逐平面比较，返回八个像素的匹配位。
    if (cirrus() && (seq[0x17] & 4) && !(seq[0x17] & 0x40) && address >= 0xb8000 && address < 0xb8100)
        return registerRead(address - 0xb8000);
    int off = offset(address); if (off < 0) return 255;
    if (packed() && (seq[4] & 8)) return vram[bankAddress(unsigned(off))];
    bool chain4 = seq[4] & 8, oddEven = !(seq[4] & 4);
    unsigned index = (chain4 ? off >> 2 : oddEven ? off >> 1 : off) & 65535;
    if (cirrus()) index = bankAddress(unsigned(off)) >> (chain4 ? 2 : oddEven ? 1 : 0);
    for (unsigned p = 0; p < 4; ++p) latch[p] = planeByte(p, index);
    if (!(gc[5] & 8)) return latch[chain4 ? off & 3 : oddEven ? (gc[4] & 2) | (off & 1) : gc[4] & 3];
    uint8_t result = 255;
    for (unsigned p = 0; p < 4; ++p)
        if (gc[7] & (1 << p)) result &= gc[2] & (1 << p) ? latch[p] : uint8_t(~latch[p]);
    return result;
}

void Vga::write(uint32_t address, uint8_t value) {
    // Write Mode 0：旋转输入/SetReset；1：直接复制 latch；2：低四位扩成各平面；
    // 3：旋转输入生成位掩码，SetReset 决定颜色。最后与 latch 按逻辑运算和 Bit Mask 合成。
    if (cirrus() && (seq[0x17] & 4) && !(seq[0x17] & 0x40) && address >= 0xb8000 && address < 0xb8100) {
        registerWrite(address - 0xb8000, value); return;
    }
    int off = offset(address); if (off < 0) return;
    if (packed() && (seq[4] & 8)) {
        if (feedBlt(value)) return;
        if ((gc[0x0b] & 4) && (gc[5] & 7) >= 4) {
            unsigned bytes = gc[0x0b] & 0x10 ? 2 : 1;
            unsigned start = bankAddress(unsigned(off)) * 8 * bytes;
            for (unsigned bit = 0; bit < 8; ++bit) {
                bool foreground = value & (0x80 >> bit);
                if (!(seq[2] & (0x80 >> bit)) || (!foreground && (gc[5] & 7) == 4)) continue;
                for (unsigned b = 0; b < bytes; ++b)
                    vram[(start + bit * bytes + b) & (VramBytes - 1)] = gc[b ? foreground ? 0x11 : 0x10 : foreground ? 1 : 0];
            }
        } else vram[bankAddress(unsigned(off))] = value;
        return;
    }
    bool chain4 = seq[4] & 8, oddEven = !(seq[4] & 4);
    unsigned index = (chain4 ? off >> 2 : oddEven ? off >> 1 : off) & 65535;
    if (cirrus()) index = bankAddress(unsigned(off)) >> (chain4 ? 2 : oddEven ? 1 : 0);
    unsigned planeMask = seq[2] & (chain4 ? 1u << (off & 3) : oddEven ? 5u << (off & 1) : 15u);
    unsigned wm = gc[5] & 3, rotation = gc[3] & 7, operation = (gc[3] >> 3) & 3;
    if ((wm == 0 || wm == 3) && rotation) value = uint8_t((value >> rotation) | (value << (8 - rotation)));
    uint8_t mask = wm == 3 ? uint8_t(gc[8] & value) : gc[8];
    for (unsigned p = 0; p < 4; ++p) {
        if (!(planeMask & (1 << p))) continue;
        uint8_t data = latch[p];
        if (wm != 1) {
            if (wm == 0) data = gc[1] & (1 << p) ? (gc[0] & (1 << p) ? 255 : 0) : value;
            else data = (wm == 2 ? value : gc[0]) & (1 << p) ? 255 : 0;
            if (operation == 1) data &= latch[p];
            else if (operation == 2) data |= latch[p];
            else if (operation == 3) data ^= latch[p];
            data = uint8_t((data & mask) | (latch[p] & ~mask));
        }
        planeByte(p, index, data);
    }
}

uint8_t Vga::pixel(unsigned x, unsigned y) const {
    // BIOS 像素访问：256 色每个平面交错一个像素；16 色四平面同一 bit 合成颜色号。
    if (x >= width() || y >= height()) throw std::runtime_error("VGA pixel is outside the display");
    if (packed()) {
        if (bitsPerPixel() != 8) throw std::runtime_error("Indexed BIOS pixel read requires an 8-bit Cirrus mode");
        return vram[(displayStart() + y * displayPitch() + x) & (VramBytes - 1)];
    }
    if (indexed256()) {
        unsigned off = (y * (crtc[0x13] * 2) + x / 4 + ((unsigned(crtc[12]) << 8) | crtc[13])) & 65535;
        return planeByte(x & 3, off);
    }
    unsigned off = (y * (crtc[0x13] * 2) + x / 8 + ((unsigned(crtc[12]) << 8) | crtc[13])) & 65535;
    uint8_t result = 0;
    for (unsigned p = 0; p < 4; ++p) result |= uint8_t(((planeByte(p, off) >> (7 - (x & 7))) & 1) << p);
    return result;
}

void Vga::pixel(unsigned x, unsigned y, uint8_t value, bool exclusiveOr) {
    if (x >= width() || y >= height()) throw std::runtime_error("VGA pixel is outside the display");
    if (packed()) {
        if (bitsPerPixel() != 8) throw std::runtime_error("Indexed BIOS pixel write requires an 8-bit Cirrus mode");
        vram[(displayStart() + y * displayPitch() + x) & (VramBytes - 1)] = value; return;
    }
    if (indexed256()) {
        unsigned off = (y * (crtc[0x13] * 2) + x / 4 + ((unsigned(crtc[12]) << 8) | crtc[13])) & 65535;
        planeByte(x & 3, off, value);
        return;
    }
    unsigned off = (y * (crtc[0x13] * 2) + x / 8 + ((unsigned(crtc[12]) << 8) | crtc[13])) & 65535;
    unsigned mask = 0x80 >> (x & 7);
    for (unsigned p = 0; p < 4; ++p) {
        auto byte = planeByte(p, off);
        if (exclusiveOr) { if (value & (1 << p)) byte ^= uint8_t(mask); }
        else byte = uint8_t(value & (1 << p) ? byte | mask : byte & ~mask);
        planeByte(p, off, byte);
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

void Vga::renderGraphics(std::vector<uint32_t>& pixels) const {
    // 一帧预计算调色板，按每四个/八个像素展开平面；不逐像素重算端口状态。
    if (!graphics()) throw std::runtime_error("A graphics frame requires a graphics video mode");
    const auto columns = width(), rows = height();
    pixels.resize(columns * rows);
    if (blanked()) { std::fill(pixels.begin(), pixels.end(), 0); return; }
    if (packed()) {
        unsigned bytes = bitsPerPixel() / 8, start = displayStart(), pitch = displayPitch();
        if (bytes == 1) {
            std::array<uint32_t, 256> palette{};
            for (unsigned i = 0; i < palette.size(); ++i) palette[i] = color(uint8_t(i));
            for (unsigned y = 0; y < rows; ++y)
                for (unsigned x = 0; x < columns; ++x) pixels[y * columns + x] = palette[vram[(start + y * pitch + x) & (VramBytes - 1)]];
        } else for (unsigned y = 0; y < rows; ++y)
            for (unsigned x = 0; x < columns; ++x) pixels[y * columns + x] = packedColor(start + y * pitch + x * bytes);
        renderCursor(pixels); return;
    }
    const bool indexed = indexed256();
    std::array<uint32_t, 256> palette{};
    for (unsigned i = 0; i < (indexed ? 256u : 16u); ++i)
        palette[i] = color(indexed ? uint8_t(i) : paletteIndex(uint8_t(i)));
    const unsigned start = (unsigned(crtc[12]) << 8) | crtc[13], stride = crtc[0x13] * 2;
    for (unsigned y = 0; y < rows; ++y) {
        auto* row = pixels.data() + y * columns;
        const auto address = start + y * stride;
        if (indexed) {
            for (unsigned x = 0; x < columns; x += 4) {
                auto offset = (address + x / 4) & 65535;
                for (unsigned plane = 0; plane < 4; ++plane)
                    row[x + plane] = palette[planeByte(plane, offset)];
            }
        } else {
            for (unsigned x = 0; x < columns; x += 8) {
                auto offset = (address + x / 8) & 65535;
                const auto p0 = planeByte(0, offset), p1 = planeByte(1, offset), p2 = planeByte(2, offset), p3 = planeByte(3, offset);
                for (unsigned bit = 0; bit < 8; ++bit) {
                    unsigned shift = 7 - bit;
                    auto index = ((p0 >> shift) & 1) | (((p1 >> shift) & 1) << 1)
                        | (((p2 >> shift) & 1) << 2) | (((p3 >> shift) & 1) << 3);
                    row[x + bit] = palette[index];
                }
            }
        }
    }
}

unsigned Vga::displayStart() const {
    unsigned start = (unsigned(crtc[12]) << 8) | crtc[13];
    start |= (unsigned(crtc[0x1b] & 1) << 16) | (unsigned(crtc[0x1b] & 12) << 15) | (unsigned(crtc[0x1d] & 0x80) << 12);
    return (start * 4) & (VramBytes - 1);
}

unsigned Vga::displayPitch() const { return (unsigned(crtc[0x13]) | (unsigned(crtc[0x1b] & 0x10) << 4)) * 8; }

uint32_t Vga::packedColor(unsigned offset) const {
    auto byte = [&](unsigned n) { return vram[(offset + n) & (VramBytes - 1)]; };
    unsigned bpp = bitsPerPixel();
    if (bpp == 8) return color(byte(0));
    if (bpp >= 24) return byte(0) | (uint32_t(byte(1)) << 8) | (uint32_t(byte(2)) << 16);
    unsigned value = byte(0) | (unsigned(byte(1)) << 8);
    if ((hiddenDac & 0xc1) == 0xc1)
        return ((value & 31) * 255 / 31) | (((value >> 5) & 63) * 255 / 63 << 8) | (((value >> 11) & 31) * 255 / 31 << 16);
    return ((value & 31) * 255 / 31) | (((value >> 5) & 31) * 255 / 31 << 8) | (((value >> 10) & 31) * 255 / 31 << 16);
}

void Vga::renderCursor(std::vector<uint32_t>& pixels) const {
    if (!(seq[0x12] & 1)) return;
    unsigned size = seq[0x12] & 4 ? 64 : 32;
    unsigned base = VramBytes - 16384 + unsigned(seq[0x13] & (size == 64 ? 0x3c : 0x3f)) * 256;
    auto cursorColor = [&](unsigned index) {
        return (uint32_t(cursorDac[index * 3]) * 255 / 63 << 16)
            | (uint32_t(cursorDac[index * 3 + 1]) * 255 / 63 << 8) | (cursorDac[index * 3 + 2] * 255 / 63);
    };
    for (unsigned y = 0; y < size && cursorY + y < height(); ++y)
        for (unsigned x = 0; x < size && cursorX + x < width(); ++x) {
            unsigned off = base + (size == 64 ? y * 16 : y * 4) + x / 8;
            unsigned plane1 = size == 64 ? off + 8 : off + 128, bit = 7 - (x & 7);
            unsigned code = ((vram[off] >> bit) & 1) | (((vram[plane1] >> bit) & 1) << 1);
            auto& pixel = pixels[(cursorY + y) * width() + cursorX + x];
            if (code == 1) pixel ^= 0xffffff;
            else if (code >= 2) pixel = cursorColor(code == 2 ? 0 : 15);
        }
}

uint8_t Vga::linearRead(uint32_t offset) {
    if (!cirrus() || !(seq[7] & 0xf0)) return 255;
    if ((seq[0x17] & 0x44) == 0x44 && (offset & 0xffffff) >= VramBytes - 256 && (offset & 0xffffff) < VramBytes)
        return registerRead(offset & 255);
    unsigned aperture = (offset >> 22) & 3;
    if (aperture == 3) throw std::runtime_error("Cirrus YUV aperture is not implemented");
    if (aperture == 1) offset ^= 1;
    else if (aperture == 2) offset ^= 3;
    return vram[offset & (VramBytes - 1)];
}

void Vga::linearWrite(uint32_t offset, uint8_t value) {
    if (!cirrus() || !(seq[7] & 0xf0)) return;
    if ((seq[0x17] & 0x44) == 0x44 && (offset & 0xffffff) >= VramBytes - 256 && (offset & 0xffffff) < VramBytes) {
        registerWrite(offset & 255, value); return;
    }
    bool systemWindow = (offset & 0x1000000) != 0;
    if (systemWindow == bool(gc[0x31] & 0x40) && feedBlt(value)) return;
    if (systemWindow) return;
    unsigned aperture = (offset >> 22) & 3;
    if (aperture == 3) throw std::runtime_error("Cirrus YUV aperture is not implemented");
    if (aperture == 1) offset ^= 1;
    else if (aperture == 2) offset ^= 3;
    vram[offset & (VramBytes - 1)] = value;
}

static int bltRegister(unsigned off) {
    // GD5446 的 MMIO 字节偏移并不等于 GC 索引；状态寄存器单独位于 40h。
    const uint8_t map[] = {0,0x10,0x12,0x14,1,0x11,0x13,0x15,
        0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,
        0x28,0x29,0x2a,0xff,0x2c,0x2d,0x2e,0x2f,
        0x30,0xff,0x32,0x33,0x34,0x35};
    if (off == 0x40) return 0x31;
    return off < sizeof(map) && map[off] != 0xff ? map[off] : -1;
}

uint8_t Vga::registerRead(unsigned off) {
    int index = bltRegister(off); return index >= 0 ? gc[unsigned(index)] : 255;
}

void Vga::registerWrite(unsigned off, uint8_t value) {
    int index = bltRegister(off); if (index >= 0) graphicsRegister(unsigned(index), value);
}

void Vga::graphicsRegister(unsigned index, uint8_t value) {
    if (index == 0x31) {
        auto status = gc[index] & 3;
        gc[index] = uint8_t((value & 0xe0) | status);
        if (value & 4) { bltSource.clear(); bltSourcePitch = bltRows = bltPadding = 0; gc[index] &= 0xe0; }
        else if (value & 2) startBlt();
        return;
    }
    // 按 CR5E 的说明，任一解锁位即可写 GR33；Windows 98 驱动只置 GR31[7]。
    // 若要求两位置位，实色填充会被误当成图案填充，窗口背景因此出现条纹。
    if (index == 0x33 && !(gc[0x31] & 0x80) && !(crtc[0x5e] & 0x20)) return;
    gc[index] = value;
    if (index == 0x2a && (gc[0x31] & 0x80)) startBlt();
}

void Vga::startBlt() {
    if (gc[0x31] & 1) throw std::runtime_error("Cirrus buffered BitBLT while busy is not implemented");
    blt = gc; bltSource.clear(); bltRows = bltPadding = 0;
    unsigned width = (unsigned(blt[0x20]) | (unsigned(blt[0x21] & 31) << 8)) + 1;
    unsigned bytes = ((blt[0x30] >> 4) & 3) + 1;
    if ((blt[0x30] & 1) && (blt[0x30] & 0xc8))
        throw std::runtime_error("Cirrus reverse BitBLT cannot use color expansion, transparency or patterns");
    gc[0x31] |= 3;
    if (blt[0x30] & 4) {
        if (blt[0x30] & 0x40) throw std::runtime_error("Cirrus system-source pattern BitBLT is invalid");
        unsigned skip = (blt[0x2f] >> 5) & 3;
        if (skip && (blt[0x30] & 0x80) && !(blt[0x33] & 1))
            throw std::runtime_error("Cirrus unaligned color expansion requires dword granularity");
        unsigned count = (blt[0x30] & 0x80 ? ((width + bytes - 1) / bytes + 7) / 8 : width) + skip;
        bltSourcePitch = !(blt[0x30] & 0x80) || (blt[0x33] & 1) ? (count + 3) & ~3u : count;
        bltSource.reserve(bltSourcePitch);
    } else { executeBlt(); gc[0x31] &= 0xe0; }
}

bool Vga::feedBlt(uint8_t value) {
    if (bltPadding) { --bltPadding; return true; }
    if (!(gc[0x31] & 1) || !(blt[0x30] & 4) || (gc[0x31] & 0x20)) return false;
    bltSource.push_back(value);
    if (bltSource.size() == bltSourcePitch) {
        executeBlt(); bltSource.clear();
        unsigned height = (unsigned(blt[0x22]) | (unsigned(blt[0x23] & 7) << 8)) + 1;
        if (++bltRows == height) {
            // 字节粒度颜色扩展仍由 DWORD 总线写入；最后一个 DWORD 的余字节不能落入 framebuffer。
            bltPadding = (4 - (height * bltSourcePitch & 3)) & 3;
            bltSourcePitch = 0; gc[0x31] &= 0xe0;
        }
    }
    return true;
}

void Vga::executeBlt() {
    auto word = [&](unsigned n) { return unsigned(blt[n]) | (unsigned(blt[n + 1]) << 8); };
    auto address = [&](unsigned n) { return (word(n) | (unsigned(blt[n + 2]) << 16)) & (VramBytes - 1); };
    const unsigned width = (word(0x20) & 0x1fff) + 1, height = (word(0x22) & 0x7ff) + 1;
    const unsigned dst = address(0x28), src = address(0x2c), dp = word(0x24) & 0x1fff, sp = word(0x26) & 0x1fff;
    const uint8_t mode = blt[0x30], extensions = blt[0x33];
    const bool system = mode & 4, expand = mode & 0x80, pattern = mode & 0x40, reverse = mode & 1;
    const unsigned bytes = ((mode >> 4) & 3) + 1;
    const unsigned sourceSkip = (blt[0x2f] >> 5) & 3;
    auto rop = [&](uint8_t source, uint8_t dest) -> uint8_t {
        switch (blt[0x32]) {
        case 0: return 0; case 0x90: return uint8_t(~(source | dest)); case 0x50: return uint8_t(~source & dest);
        case 0xd0: return uint8_t(~source); case 9: return uint8_t(source & ~dest); case 0x0b: return uint8_t(~dest);
        case 0x59: return source ^ dest; case 0xda: return uint8_t(~(source & dest)); case 5: return source & dest;
        case 0x95: return uint8_t(~(source ^ dest)); case 6: return dest; case 0xd6: return uint8_t(~source | dest);
        case 0x0d: return source; case 0xad: return uint8_t(source | ~dest); case 0x6d: return source | dest; case 0x0e: return 255;
        default: throw std::runtime_error("Unsupported Cirrus BitBLT ROP " + std::to_string(blt[0x32]));
        }
    };
    auto colorByte = [&](bool foreground, unsigned component) {
        return blt[component == 0 ? foreground ? 1 : 0 : 0x10 + (component - 1) * 2 + (foreground ? 1 : 0)];
    };
    unsigned firstRow = system ? bltRows : 0, lastRow = system ? firstRow + 1 : height;
    for (unsigned y = firstRow; y < lastRow; ++y) for (unsigned x = 0; x < width; ++x) {
        unsigned pixel = x / bytes, component = x % bytes;
        bool foreground = true;
        uint8_t value;
        if (expand) {
            unsigned off = pattern ? (src & ~7u) + ((src + y) & 7) : src + y * (((width + bytes - 1) / bytes + 7) / 8) + pixel / 8;
            foreground = (extensions & 4) || (((system ? bltSource[sourceSkip + pixel / 8] : vram[off & (VramBytes - 1)]) >> (7 - (pixel & 7))) & 1);
            if (extensions & 2) foreground = !foreground;
            if ((mode & 8) && !foreground) continue;
            value = colorByte(foreground, component);
        } else {
            unsigned off = pattern ? (src & ~(bytes == 3 ? 255u : 64 * bytes - 1)) + ((src + y) & 7) * (bytes == 3 ? 32 : 8 * bytes) + (pixel & 7) * bytes + component
                : reverse ? src - y * sp - x : src + y * sp + x;
            value = system ? bltSource[sourceSkip + x] : vram[off & (VramBytes - 1)];
            if (mode & 8) {
                if (bytes > 2) throw std::runtime_error("Cirrus source transparency requires 8/16-bit pixels");
                unsigned pixelOff = reverse ? off + component : off - component;
                unsigned pixelValue = system ? bltSource[sourceSkip + pixel * bytes] : vram[pixelOff & (VramBytes - 1)];
                if (bytes == 2) pixelValue |= unsigned(system ? bltSource[sourceSkip + pixel * bytes + 1] : vram[(pixelOff + 1) & (VramBytes - 1)]) << 8;
                if (pixelValue == (word(0x34) & (bytes == 1 ? 255 : 65535))) continue;
            }
        }
        unsigned clipping = bytes == 3 ? blt[0x2f] & 31 : (blt[0x2f] & 7) * bytes;
        if ((expand || pattern) && x < clipping && (!expand || !(extensions & 8) || !foreground)) continue;
        unsigned off = (reverse ? dst - y * dp - x : dst + y * dp + x) & (VramBytes - 1);
        vram[off] = rop(value, vram[off]);
    }
}

uint8_t Vga::input(uint16_t port) {
    // 3C4/5 Sequencer；3CE/F GC；3B4/5 或 3D4/5 CRTC；3C7..9 DAC。
    // 读取 3DA/3BA 复位属性控制器索引/数据触发器；这是客体设模序列必需的副作用。
    switch (port) {
    case 0x3c0: return attrAddress;
    case 0x3c1: return (attrAddress & 31) < attr.size() ? attr[attrAddress & 31] : 0;
    case 0x3c4: return cirrus() && (seqIndex & 31) == 0x10 ? uint8_t(0x10 | ((cursorX & 7) << 5))
        : cirrus() && (seqIndex & 31) == 0x11 ? uint8_t(0x11 | ((cursorY & 7) << 5)) : seqIndex;
    case 0x3c5: return seq[seqIndex & (cirrus() ? 31 : 7)];
    case 0x3c6:
        if (cirrus() && hiddenAccess++ == 4) { hiddenAccess = 0; return hiddenDac; }
        return pelMask;
    case 0x3c7: return dacState;
    case 0x3c8: return writeIndex;
    case 0x3c9: {
        auto value = cirrus() && (seq[0x12] & 2) ? cursorDac[(readIndex & 15) * 3 + readPart] : dac[readIndex * 3 + readPart];
        if (++readPart == 3) { readPart = 0; ++readIndex; } return value;
    }
    case 0x3cc: return misc;
    case 0x3ce: return gcIndex;
    case 0x3cf: return gc[gcIndex & (cirrus() ? 63 : 15)];
    case 0x3b4: case 0x3d4: return crtcIndex;
    case 0x3b5: case 0x3d5: return crtc[crtcIndex & (cirrus() ? 255 : 31)];
    case 0x3ba: case 0x3da: attrData = false; return 0;
    }
    return 255;
}

bool Vga::output(uint16_t port, uint8_t value) {
    // 3C0 同端口交替写属性索引/数据；DAC 的 R/G/B 每三次读写才推进颜色索引。
    switch (port) {
    case 0x3c0:
        if (!attrData) attrAddress = value & 63;
        else if ((attrAddress & 31) < attr.size()) attr[attrAddress & 31] = value;
        attrData = !attrData; return true;
    case 0x3c2: misc = value; return true;
    case 0x3c4: seqIndex = value; return true;
    case 0x3c5: {
        unsigned index = seqIndex & (cirrus() ? 31 : 7);
        // SR6 不限制 GD5446 扩展寄存器访问；Windows 98 的探测要求钥匙/反码分别回读 12h/0Fh。
        if (cirrus() && index == 6) value = (value & 0x17) == 0x12 ? 0x12 : 0x0f;
        if (cirrus() && index == 0x10) cursorX = (unsigned(value) << 3) | (seqIndex >> 5);
        if (cirrus() && index == 0x11) cursorY = (unsigned(value) << 3) | (seqIndex >> 5);
        seq[index] = value; return true;
    }
    case 0x3c6:
        if (cirrus() && hiddenAccess == 4) hiddenDac = value;
        else pelMask = value;
        hiddenAccess = 0; return true;
    case 0x3c7: readIndex = value; readPart = 0; dacState = 3; return true;
    case 0x3c8: writeIndex = value; writePart = 0; dacState = 0; hiddenAccess = 0; return true;
    case 0x3c9:
        if (cirrus() && (seq[0x12] & 2)) cursorDac[(writeIndex & 15) * 3 + writePart] = value & 63;
        else dac[writeIndex * 3 + writePart] = value & 63;
        if (++writePart == 3) { writePart = 0; ++writeIndex; } return true;
    case 0x3ce: gcIndex = value; return true;
    case 0x3cf:
        if (cirrus()) graphicsRegister(gcIndex & 63, value);
        else gc[gcIndex & 15] = value;
        return true;
    case 0x3b4: case 0x3d4: crtcIndex = value; return true;
    case 0x3b5: case 0x3d5:
        if (!cirrus() || crtcIndex != 0x27) crtc[crtcIndex & (cirrus() ? 255 : 31)] = value;
        return true;
    }
    return false;
}
}
