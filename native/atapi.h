#pragma once
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <vector>

namespace asm86 {
class IsoImage {
public:
    explicit IsoImage(const std::filesystem::path& path);
    bool read(uint64_t offset, uint8_t* data, unsigned length);
    std::filesystem::path path;
    uint32_t sectors = 0;
private:
    std::ifstream file;
    uint64_t bytes = 0;
};
class AtapiCdrom {
public:
    std::function<void(bool)> interrupt;
    double nextEvent = std::numeric_limits<double>::infinity();
    static bool owns(uint16_t port) { return (port >= 0x170 && port <= 0x177) || port == 0x376; }
    const IsoImage* medium() const { return disc.get(); }
    void insert(const std::filesystem::path& path);
    void eject();
    void reset();
    void advance(double now);
    uint8_t input(uint16_t port, double now);
    void output(uint16_t port, uint8_t value, double now);
    uint16_t readWord(double now);
    void writeWord(uint16_t value, double now);
private:
    enum class Phase { Idle, Packet, Input };
    enum class Action { Packet, Input, Complete, Reset };
    struct Sense { uint8_t key = 0, asc = 0, ascq = 0; };
    std::unique_ptr<IsoImage> disc;
    Phase phase = Phase::Idle;
    Action action = Action::Reset;
    Sense sense{};
    uint8_t features = 0, reason = 1, lbaLow = 1, byteLow = 0x14, byteHigh = 0xeb;
    uint8_t device = 0xa0, control = 0, status = 0, error = 1, pendingError = 0;
    bool irqPending = false, mediaChanged = false, locked = false, packetCommand = false;
    unsigned packetPosition = 0, position = 0, responsePosition = 0, byteLimit = 0xfffe, payload = 0;
    uint64_t readOffset = 0, readRemaining = 0;
    std::array<uint8_t, 12> packet{};
    std::vector<uint8_t> buffer, response;
    void signal();
    void irq(bool value);
    void afterBusy(Action next, double now, uint8_t failure = 0);
    void command(uint8_t value, double now);
    void runPacket(double now);
    void identify(double now);
    void complete(double now);
    void fail(double now, Sense value);
    void reply(std::vector<uint8_t> data, unsigned allocation, double now);
    void nextBlock(double now);
    void consumed(double now);
    void toc(double now);
    void modeSense(bool ten, double now);
};
}
