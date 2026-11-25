#include "atapi.h"
#include <algorithm>
#include <stdexcept>
#include <string>

namespace asm86 {
IsoImage::IsoImage(const std::filesystem::path& value) : path(value), file(value, std::ios::binary) {
    if (!file) throw std::runtime_error("Cannot open optical image: " + path.u8string());
    file.seekg(0, std::ios::end);
    auto length = file.tellg();
    if (!file || length <= 0 || uint64_t(length) % 2048 || uint64_t(length) / 2048 > 0xffffffffu)
        throw std::runtime_error("Optical image must contain complete 2048-byte ISO sectors: " + path.u8string());
    bytes = uint64_t(length); sectors = uint32_t(bytes / 2048);
}
bool IsoImage::read(uint64_t offset, uint8_t* data, unsigned length) {
    if (offset > bytes || length > bytes - offset) return false;
    file.seekg(std::streamoff(offset));
    file.read(reinterpret_cast<char*>(data), std::streamsize(length));
    if (!file) throw std::runtime_error("Cannot read optical image: " + path.u8string());
    return true;
}
void AtapiCdrom::signal() { if (interrupt) interrupt(irqPending && !(control & 6)); }
void AtapiCdrom::irq(bool value) { irqPending = value; signal(); }
void AtapiCdrom::insert(const std::filesystem::path& path) {
    if (locked) throw std::runtime_error("The guest has locked the optical drive");
    if (status & 0x88) throw std::runtime_error("Wait for the optical transfer to finish before changing media");
    auto next = std::make_unique<IsoImage>(path);
    disc = std::move(next); mediaChanged = true;
}
void AtapiCdrom::eject() {
    if (locked) throw std::runtime_error("The guest has locked the optical drive");
    if (status & 0x88) throw std::runtime_error("Wait for the optical transfer to finish before changing media");
    disc.reset(); mediaChanged = true;
}
void AtapiCdrom::reset() {
    phase = Phase::Idle; nextEvent = std::numeric_limits<double>::infinity();
    features = control = status = pendingError = 0;
    reason = lbaLow = error = 1; byteLow = 0x14; byteHigh = 0xeb; device = 0xa0;
    packetPosition = position = responsePosition = 0; readRemaining = 0;
    sense = {}; locked = packetCommand = false; response.clear(); buffer.clear(); irq(false);
}
void AtapiCdrom::afterBusy(Action next, double now, uint8_t failure) {
    phase = Phase::Idle; status = 0x80; action = next; pendingError = failure; nextEvent = now + 120;
}
void AtapiCdrom::advance(double now) {
    if (now < nextEvent) return;
    nextEvent = std::numeric_limits<double>::infinity();
    if (action == Action::Reset) { status = 0; error = 1; return; }
    if (action == Action::Packet) { phase = Phase::Packet; reason = 1; status = 0x48; return; }
    if (action == Action::Input) {
        phase = Phase::Input; reason = 2; position = 0; status = 0x58;
        byteLow = uint8_t(payload); byteHigh = uint8_t(payload >> 8);
    } else {
        if (packetCommand) reason = 3;
        if (pendingError) error = pendingError;
        status = pendingError ? 0x41 : 0x50;
    }
    irq(true);
}
uint8_t AtapiCdrom::input(uint16_t port, double now) {
    if (port == 0x170) return uint8_t(readWord(now));
    if (port == 0x176) return device;
    if (device & 0x10) return 0;
    switch (port) {
    case 0x171: return error;
    case 0x172: return reason;
    case 0x173: return lbaLow;
    case 0x174: return byteLow;
    case 0x175: return byteHigh;
    case 0x177: irq(false); return status;
    case 0x376: return status;
    default: return 255;
    }
}
void AtapiCdrom::output(uint16_t port, uint8_t value, double now) {
    if (port == 0x376) {
        auto old = control;
        if (value & 4) { reset(); status = 0x80; }
        else if (old & 4) { reset(); afterBusy(Action::Reset, now); }
        control = value & 14; signal(); return;
    }
    if (control & 4) return;
    switch (port) {
    case 0x170: writeWord(value, now); break;
    case 0x171: features = value; break;
    case 0x172: reason = value; break;
    case 0x173: lbaLow = value; break;
    case 0x174: byteLow = value; break;
    case 0x175: byteHigh = value; break;
    case 0x176: device = value | 0xa0; break;
    case 0x177: if (!(device & 0x10)) command(value, now); break;
    }
}
uint16_t AtapiCdrom::readWord(double now) {
    if ((device & 0x10) || phase != Phase::Input) return 0xffff;
    auto value = uint16_t(buffer[position] | (uint16_t(buffer[position + 1]) << 8));
    position += 2;
    if (position == buffer.size()) consumed(now);
    return value;
}
void AtapiCdrom::writeWord(uint16_t value, double now) {
    if ((device & 0x10) || phase != Phase::Packet) return;
    packet[packetPosition++] = uint8_t(value); packet[packetPosition++] = uint8_t(value >> 8);
    if (packetPosition == packet.size()) runPacket(now);
}
void AtapiCdrom::command(uint8_t value, double now) {
    if (status & 0x80) return;
    irq(false); error = 0; packetCommand = false; readRemaining = 0; responsePosition = 0; response.clear();
    switch (value) {
    case 0xa0:
        if (features & 3) { afterBusy(Action::Complete, now, 4); return; }
        byteLimit = unsigned(byteLow) | (unsigned(byteHigh) << 8);
        if (!byteLimit || byteLimit == 0xffff) byteLimit = 0xfffe;
        packetPosition = 0; packet.fill(0); afterBusy(Action::Packet, now); return;
    case 0xa1: identify(now); return;
    case 8: {
        auto saved = control; reset(); control = saved; afterBusy(Action::Reset, now); return;
    }
    case 0x90: {
        auto saved = control; reset(); control = saved; afterBusy(Action::Complete, now); return;
    }
    case 0xec:
        reason = lbaLow = 1; byteLow = 0x14; byteHigh = 0xeb; afterBusy(Action::Complete, now, 4); return;
    case 0xef:
        if (features == 3 && (reason <= 1 || (reason >= 8 && reason <= 12))) { afterBusy(Action::Complete, now); return; }
        break;
    }
    afterBusy(Action::Complete, now, 4);
}
void AtapiCdrom::identify(double now) {
    std::array<uint16_t, 256> words{};
    auto text = [&](unsigned first, unsigned length, std::string value) {
        value.resize(length * 2, ' ');
        for (unsigned i = 0; i < length; ++i) words[first + i] = uint16_t((uint16_t(uint8_t(value[i * 2])) << 8) | uint8_t(value[i * 2 + 1]));
    };
    words[0] = 0x8580; text(10, 10, "ASM86NATIVECD01"); text(23, 4, "1.0"); text(27, 20, "ASMPERFECT NATIVE ATAPI CD-ROM");
    words[49] = 0x200; words[80] = 0x1e; words[82] = 0x10;
    buffer.resize(512);
    for (unsigned i = 0; i < 256; ++i) { buffer[i * 2] = uint8_t(words[i]); buffer[i * 2 + 1] = uint8_t(words[i] >> 8); }
    payload = 512; afterBusy(Action::Input, now);
}
void AtapiCdrom::complete(double now) {
    sense = {}; afterBusy(Action::Complete, now);
}
void AtapiCdrom::fail(double now, Sense value) {
    sense = value; readRemaining = 0; response.clear();
    afterBusy(Action::Complete, now, uint8_t((value.key << 4) | 4));
}
void AtapiCdrom::reply(std::vector<uint8_t> data, unsigned allocation, double now) {
    data.resize(std::min(data.size(), size_t(allocation)));
    response = std::move(data); responsePosition = 0; readRemaining = 0;
    if (response.empty()) complete(now); else nextBlock(now);
}
void AtapiCdrom::nextBlock(double now) {
    uint64_t left = readRemaining ? readRemaining : response.size() - responsePosition;
    payload = unsigned(std::min<uint64_t>(byteLimit, left));
    buffer.assign((payload + 1) & ~1u, 0);
    if (readRemaining) {
        if (!disc) { fail(now, {2, 0x3a, 0}); return; }
        if (!disc->read(readOffset, buffer.data(), payload)) { fail(now, {5, 0x21, 0}); return; }
        readOffset += payload; readRemaining -= payload;
    } else {
        std::copy_n(response.begin() + responsePosition, payload, buffer.begin());
        responsePosition += payload;
    }
    afterBusy(Action::Input, now);
}
void AtapiCdrom::consumed(double now) {
    if (readRemaining || responsePosition < response.size()) { nextBlock(now); return; }
    if (packetCommand) complete(now);
    else { phase = Phase::Idle; status = 0x50; }
}
void AtapiCdrom::runPacket(double now) {
    packetCommand = true;
    auto op = packet[0];
    auto be16 = [&](unsigned i) { return (unsigned(packet[i]) << 8) | packet[i + 1]; };
    auto be32 = [&](unsigned i) { return (uint32_t(packet[i]) << 24) | (uint32_t(packet[i + 1]) << 16) | (uint32_t(packet[i + 2]) << 8) | packet[i + 3]; };
    if (op != 3 && op != 0x12 && op != 0x46 && op != 0x4a && op != 0x1a && op != 0x5a) {
        if (mediaChanged && disc) { mediaChanged = false; fail(now, {6, 0x28, 0}); return; }
        if (!disc && op != 0x1b && op != 0x1e && op != 0xbb && op != 0xbd) { fail(now, {2, 0x3a, 0}); return; }
    }
    switch (op) {
    case 0: complete(now); return;
    case 3: {
        std::vector<uint8_t> data(18, 0);
        data[0] = 0x70; data[2] = sense.key; data[7] = 10; data[12] = sense.asc; data[13] = sense.ascq;
        sense = {}; reply(std::move(data), packet[4], now); return;
    }
    case 0x12: {
        if (packet[1] & 1) { fail(now, {5, 0x24, 0}); return; }
        std::vector<uint8_t> data(36, ' ');
        std::fill_n(data.begin(), 8, 0);
        data[0] = 5; data[1] = 0x80; data[3] = 0x21; data[4] = 31;
        const std::string text = "ASM86   NATIVE CD-ROM   1.0 ";
        std::copy(text.begin(), text.end(), data.begin() + 8);
        reply(std::move(data), packet[4], now); return;
    }
    case 0x1b:
        if ((packet[4] & 3) == 2) {
            if (locked) { fail(now, {5, 0x53, 2}); return; }
            disc.reset(); mediaChanged = true;
        }
        complete(now); return;
    case 0x1e:
        if (packet[4] & ~1) { fail(now, {5, 0x24, 0}); return; }
        locked = packet[4] & 1; complete(now); return;
    case 0x25: {
        std::vector<uint8_t> data(8, 0); auto last = disc->sectors - 1;
        for (unsigned i = 0; i < 4; ++i) data[i] = uint8_t(last >> ((3 - i) * 8));
        data[6] = 8; reply(std::move(data), 8, now); return;
    }
    case 0x28: case 0xa8: {
        auto first = be32(2), total = op == 0x28 ? be16(7) : be32(6);
        if (!total) { complete(now); return; }
        if (first >= disc->sectors || total > disc->sectors - first) { fail(now, {5, 0x21, 0}); return; }
        readOffset = uint64_t(first) * 2048; readRemaining = uint64_t(total) * 2048; nextBlock(now); return;
    }
    case 0x2b:
        if (be32(2) >= disc->sectors) { fail(now, {5, 0x21, 0}); return; }
        complete(now); return;
    case 0x43: toc(now); return;
    case 0x1a: case 0x5a: modeSense(op == 0x5a, now); return;
    case 0x42: {
        std::vector<uint8_t> data(packet[2] & 0x40 ? 16 : 4, 0);
        data[1] = 0x15; data[3] = uint8_t(data.size() - 4);
        if (data.size() > 4) { data[4] = 1; data[5] = 0x14; data[6] = data[7] = 1; }
        reply(std::move(data), be16(7), now); return;
    }
    case 0xbb: complete(now); return;
    case 0xbd: reply(std::vector<uint8_t>(8, 0), be16(8), now); return;
    case 0x4a: reply({0, 2, 0x80, 0x10}, be16(7), now); return;
    case 0x46: reply({0, 0, 0, 4, 0, 0, 0, uint8_t(disc ? 8 : 0)}, be16(7), now); return;
    default: fail(now, {5, 0x20, 0}); return;
    }
}
void AtapiCdrom::toc(double now) {
    auto format = (packet[2] & 15) ? packet[2] & 15 : packet[9] >> 6;
    auto start = packet[6];
    if (format > 1 || (format == 0 && start > 1 && start != 0xaa)) { fail(now, {5, 0x24, 0}); return; }
    auto address = [&](std::vector<uint8_t>& data, unsigned at, uint32_t lba) {
        if (packet[1] & 2) {
            auto frames = lba + 150;
            data[at + 1] = uint8_t(frames / 4500); data[at + 2] = uint8_t((frames / 75) % 60); data[at + 3] = uint8_t(frames % 75);
        } else for (unsigned i = 0; i < 4; ++i) data[at + i] = uint8_t(lba >> ((3 - i) * 8));
    };
    std::vector<uint8_t> data(format == 1 || start == 0xaa ? 12 : 20, 0);
    data[1] = uint8_t(data.size() - 2); data[2] = data[3] = 1;
    data[5] = 0x14; data[6] = start == 0xaa ? 0xaa : 1; address(data, 8, start == 0xaa ? disc->sectors : 0);
    if (data.size() == 20) { data[13] = 0x14; data[14] = 0xaa; address(data, 16, disc->sectors); }
    reply(std::move(data), (unsigned(packet[7]) << 8) | packet[8], now);
}
void AtapiCdrom::modeSense(bool ten, double now) {
    unsigned header = ten ? 8 : 4, page = packet[2] & 63;
    if (page != 0x2a && page != 0x0d && page != 0x3f) { fail(now, {5, 0x24, 0}); return; }
    std::vector<uint8_t> data(header, 0);
    if (page == 0x2a || page == 0x3f) {
        const uint8_t caps[] = {0x2a,0x12,1,0,0,0,uint8_t(0x29 | (locked ? 2 : 0)),0,5,0x84,0,2,1,0,0,0,5,0x84,0,0};
        data.insert(data.end(), std::begin(caps), std::end(caps));
    }
    if (page == 0x0d || page == 0x3f) { const uint8_t params[] = {0x0d,6,0,0,0,0x3c,0,0x4b}; data.insert(data.end(), std::begin(params), std::end(params)); }
    unsigned allocation = ten ? (unsigned(packet[7]) << 8) | packet[8] : packet[4];
    if (ten) { data[1] = uint8_t(data.size() - 2); data[2] = 1; data[3] = 0x80; }
    else { data[0] = uint8_t(data.size() - 1); data[1] = 1; data[2] = 0x80; }
    reply(std::move(data), allocation, now);
}
}
