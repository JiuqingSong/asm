#pragma once
#include <array>
#include <cstdint>
#include <functional>

namespace asm86 {
enum class DmaDirection : uint8_t { Verify, ToMemory, FromMemory };
struct DmaResult { unsigned bytes = 0; bool terminal = false, error = false; };
class DmaController {
public:
    std::function<uint8_t(uint32_t)> read;
    std::function<void(uint32_t, uint8_t)> write;
    static bool owns(uint16_t port) { return port <= 15 || (port >= 0x80 && port <= 0x8f) || (port >= 0xc0 && port <= 0xdf); }
    void reset(bool at);
    uint8_t input(uint16_t port);
    void output(uint16_t port, uint8_t value);
    DmaResult transfer(unsigned channel, uint8_t* data, unsigned length, DmaDirection direction);
private:
    std::array<uint16_t, 8> address{}, count{}, baseAddress{}, baseCount{};
    std::array<uint8_t, 8> mode{};
    std::array<uint8_t, 16> page{};
    std::array<uint8_t, 2> command{}, request{};
    std::array<bool, 2> high{};
    uint8_t mask = 255, terminal = 0;
    bool cascaded = false;
};
}
