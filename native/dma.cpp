#include "dma.h"
#include <stdexcept>

namespace asm86 {
void DmaController::reset(bool at) {
    address.fill(0); count.fill(0); baseAddress.fill(0); baseCount.fill(0);
    mode.fill(0); page.fill(0); command.fill(0); request.fill(0); high.fill(false);
    mask = 255; terminal = 0; cascaded = at;
}
uint8_t DmaController::input(uint16_t port) {
    if (port >= 0x80 && port <= 0x8f) return page[port - 0x80];
    if (port >= 0xc0 && (port & 1)) return 255;
    unsigned controller = port >= 0xc0, reg = controller ? (port - 0xc0) / 2 : port;
    if (reg < 8) {
        unsigned channel = controller * 4 + reg / 2;
        auto value = reg & 1 ? count[channel] : address[channel];
        auto result = uint8_t(value >> (high[controller] ? 8 : 0));
        high[controller] = !high[controller]; return result;
    }
    if (reg == 8) {
        auto value = uint8_t(((terminal >> (controller * 4)) & 15) | (request[controller] << 4));
        terminal &= uint8_t(~(15 << (controller * 4))); return value;
    }
    if (reg == 15) return uint8_t(0xf0 | ((mask >> (controller * 4)) & 15));
    return 255;
}
void DmaController::output(uint16_t port, uint8_t value) {
    if (port >= 0x80 && port <= 0x8f) { page[port - 0x80] = value; return; }
    if (port >= 0xc0 && (port & 1)) return;
    unsigned controller = port >= 0xc0, reg = controller ? (port - 0xc0) / 2 : port, base = controller * 4;
    if (reg < 8) {
        unsigned channel = base + reg / 2;
        auto& current = reg & 1 ? count[channel] : address[channel];
        current = high[controller] ? uint16_t((current & 255) | (uint16_t(value) << 8)) : uint16_t((current & 0xff00) | value);
        (reg & 1 ? baseCount[channel] : baseAddress[channel]) = current;
        high[controller] = !high[controller]; return;
    }
    auto bit = uint8_t(1 << (base + (value & 3)));
    switch (reg) {
    case 8: command[controller] = value; break;
    case 9:
        if (value & 4) request[controller] |= uint8_t(1 << (value & 3));
        else request[controller] &= uint8_t(~(1 << (value & 3)));
        break;
    case 10: if (value & 4) mask |= bit; else mask &= uint8_t(~bit); break;
    case 11: mode[base + (value & 3)] = value; break;
    case 12: high[controller] = false; break;
    case 13:
        high[controller] = false; mask |= uint8_t(15 << base); command[controller] = request[controller] = 0;
        terminal &= uint8_t(~(15 << base)); break;
    case 14: mask &= uint8_t(~(15 << base)); break;
    case 15: mask = uint8_t((mask & ~(15 << base)) | ((value & 15) << base)); break;
    }
}
DmaResult DmaController::transfer(unsigned channel, uint8_t* data, unsigned length, DmaDirection direction) {
    if (channel >= 8 || channel == 4) throw std::runtime_error("Invalid peripheral DMA channel");
    if ((mask & (1 << channel)) || (command[channel / 4] & 4)
        || (channel < 4 && cascaded && ((mask & 0x10) || (command[1] & 4) || (mode[4] & 0xc0) != 0xc0))) return {};
    auto setting = mode[channel]; unsigned type = (setting >> 2) & 3;
    if (type != unsigned(direction) || (setting & 0xc0) == 0xc0 || (command[channel / 4] & 1)) return {0, false, true};
    if ((direction == DmaDirection::ToMemory && !write) || (direction == DmaDirection::FromMemory && !read))
        throw std::runtime_error("DMA physical memory bus is not connected");
    static constexpr unsigned pages[] = {7,3,1,2,0,11,9,10};
    unsigned width = channel >= 5 ? 2 : 1;
    auto upper = uint32_t(page[pages[channel]] & (width == 2 ? 0xfe : 0xff)) << 16;
    DmaResult result;
    while (result.bytes + width <= length) {
        auto physical = upper | (uint32_t(address[channel]) * width);
        for (unsigned i = 0; i < width; ++i) {
            if (direction == DmaDirection::ToMemory) write(physical + i, data[result.bytes + i]);
            else if (direction == DmaDirection::FromMemory) data[result.bytes + i] = read(physical + i);
        }
        result.bytes += width;
        address[channel] = uint16_t(address[channel] + (setting & 0x20 ? -1 : 1));
        if (count[channel]-- == 0) { result.terminal = true; break; }
    }
    if (result.terminal) {
        terminal |= uint8_t(1 << channel);
        request[channel / 4] &= uint8_t(~(1 << (channel & 3)));
        if (setting & 0x10) { address[channel] = baseAddress[channel]; count[channel] = baseCount[channel]; }
        else mask |= uint8_t(1 << channel);
    }
    return result;
}
}
