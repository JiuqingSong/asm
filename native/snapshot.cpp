#include "snapshot.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#include <wincrypt.h>

namespace asm86 {
namespace {
constexpr uint64_t MaxSnapshotBytes = 1ULL << 30;
constexpr uint32_t MaxCowSectors = 1u << 20;
constexpr uint32_t Version = 1;
[[noreturn]] void bad(const char* message) { throw std::runtime_error(std::string("Snapshot: ") + message); }
void require(bool value, const char* message) { if (!value) bad(message); }
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct RemoveFile {
    std::filesystem::path path;
    ~RemoveFile() {
        if (!path.empty() && !DeleteFileW(path.c_str())) {
            auto error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
                std::fprintf(stderr, "Snapshot: cannot delete temporary file (Windows error %lu)\n", error);
        }
    }
};
uint32_t crcUpdate(uint32_t crc, const uint8_t* bytes, size_t size) {
    static const auto table = [] {
        std::array<uint32_t, 256> result{};
        for (unsigned i = 0; i < 256; ++i) {
            auto n = i;
            for (unsigned b = 0; b < 8; ++b) n = (n >> 1) ^ (0xedb88320u & (0u - (n & 1)));
            result[i] = n;
        }
        return result;
    }();
    for (size_t i = 0; i < size; ++i) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >> 8);
    return crc;
}
void io(HANDLE file, uint8_t* bytes, size_t size, bool writing) {
    while (size) {
        auto count = DWORD(std::min<size_t>(size, 1024 * 1024));
        DWORD done = 0;
        auto ok = writing ? WriteFile(file, bytes, count, &done, nullptr) : ReadFile(file, bytes, count, &done, nullptr);
        require(ok && done == count, writing ? "exact write failed" : "truncated stream or exact read failed");
        bytes += count; size -= count;
    }
}
void seek(HANDLE file, uint64_t offset) {
    LARGE_INTEGER at{}; at.QuadPart = int64_t(offset);
    require(SetFilePointerEx(file, at, nullptr, FILE_BEGIN), "seek failed");
}
uint64_t fileSize(HANDLE file) {
    LARGE_INTEGER size{};
    require(GetFileSizeEx(file, &size) && size.QuadPart >= 0, "cannot size file");
    return uint64_t(size.QuadPart);
}
struct Crypto {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    ~Crypto() { if (hash) CryptDestroyHash(hash); if (provider) CryptReleaseContext(provider, 0); }
};
std::array<uint8_t, 32> hashFile(HANDLE file) {
    Crypto crypto;
    require(CryptAcquireContextW(&crypto.provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT), "SHA256 provider failed");
    require(CryptCreateHash(crypto.provider, CALG_SHA_256, 0, 0, &crypto.hash), "SHA256 creation failed");
    std::array<uint8_t, 65536> buffer{};
    auto remaining = fileSize(file); seek(file, 0);
    while (remaining) {
        auto count = DWORD(std::min<uint64_t>(remaining, buffer.size()));
        io(file, buffer.data(), count, false);
        require(CryptHashData(crypto.hash, buffer.data(), count, 0), "SHA256 update failed");
        remaining -= count;
    }
    std::array<uint8_t, 32> digest{}; DWORD count = DWORD(digest.size());
    require(CryptGetHashParam(crypto.hash, HP_HASHVAL, digest.data(), &count, 0) && count == digest.size(), "SHA256 finish failed");
    return digest;
}
std::filesystem::path uniqueFile(const std::filesystem::path& prefix) {
    static uint64_t sequence = 0;
    for (unsigned attempt = 0; attempt < 100; ++attempt) {
        auto path = prefix; path += L"." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++sequence);
        Handle h;
        h.value = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h.value != INVALID_HANDLE_VALUE) return path;
        if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) bad("cannot create private sibling file");
    }
    bad("cannot reserve unique sibling file");
}
bool samePath(const std::filesystem::path& a, const std::filesystem::path& b) {
    if (a.empty() || b.empty()) return false;
    std::error_code error;
    if (std::filesystem::equivalent(a, b, error) && !error) return true;
    return _wcsicmp(std::filesystem::absolute(a).lexically_normal().c_str(),
        std::filesystem::absolute(b).lexically_normal().c_str()) == 0;
}
}

class SnapshotArchive {
public:
    HANDLE file;
    bool reading;
    uint64_t limit, position = 0;
    uint32_t crc = 0xffffffffu;
    std::filesystem::path source;
    SnapshotArchive(HANDLE file, bool reading, uint64_t limit, const std::filesystem::path& source)
        : file(file), reading(reading), limit(limit), source(source) {}
    void bytes(uint8_t* data, size_t size) {
        require(position <= limit && size <= limit - position, "payload exceeds declared size or allocation limit");
        io(file, data, size, !reading); crc = crcUpdate(crc, data, size); position += size;
    }
    template<class T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>, int> = 0>
    void value(T& data) {
        static_assert(sizeof(T) <= 8);
        std::array<uint8_t, sizeof(T)> b{};
        using U = std::make_unsigned_t<T>;
        if (!reading) for (unsigned i = 0; i < b.size(); ++i) b[i] = uint8_t(U(data) >> (i * 8));
        bytes(b.data(), b.size());
        if (reading) {
            U n = 0; for (unsigned i = 0; i < b.size(); ++i) n |= U(b[i]) << (i * 8);
            if constexpr (std::is_signed_v<T>) {
                // Preserve two's-complement without implementation-defined unsigned-to-signed conversion.
                data = (n >> (sizeof(T) * 8 - 1)) ? T(-1 - T(U(~n))) : T(n);
            } else data = n;
        }
    }
    void value(bool& data) {
        uint8_t b = data ? 1 : 0; value(b); require(b <= 1, "invalid boolean"); if (reading) data = b != 0;
    }
    void value(double& data) {
        static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);
        uint64_t bits = 0; if (!reading) std::memcpy(&bits, &data, 8);
        value(bits); if (reading) std::memcpy(&data, &bits, 8);
        require(!std::isnan(data) && data != -std::numeric_limits<double>::infinity(), "invalid virtual time");
    }
    void value(Float80& data) { fields(data.significand, data.signExponent); }
    template<class T, size_t N> void value(std::array<T, N>& data) {
        if constexpr (std::is_same_v<T, uint8_t>) bytes(data.data(), N);
        else for (auto& item : data) value(item);
    }
    template<class... T> void fields(T&... data) { (value(data), ...); }
    template<class E> void enumeration(E& data, uint32_t maximum) {
        uint32_t n = uint32_t(data); value(n); require(n <= maximum, "invalid enum"); if (reading) data = E(n);
    }
    template<class C> void sequence(C& data, uint32_t maximum) {
        require(data.size() <= maximum, "container exceeds limit");
        uint32_t count = uint32_t(data.size()); value(count);
        require(count <= maximum && uint64_t(count) <= limit - position, "invalid container length");
        if (reading) data.resize(count);
        for (auto& item : data) value(item);
    }
    void blob(std::vector<uint8_t>& data, uint32_t maximum) {
        require(data.size() <= maximum, "byte buffer exceeds limit");
        uint32_t count = uint32_t(data.size()); value(count);
        require(count <= maximum && count <= limit - position, "invalid byte buffer length");
        if (reading) data.resize(count);
        bytes(data.data(), count);
    }
    void text(std::string& data) {
        uint32_t count = uint32_t(data.size()); require(data.size() <= 32768, "string exceeds limit");
        value(count); require(count <= 32768 && count <= limit - position, "invalid string length");
        if (reading) data.resize(count);
        bytes(reinterpret_cast<uint8_t*>(data.data()), count);
    }
    void path(std::filesystem::path& data) {
        std::string utf8 = reading ? std::string() : std::filesystem::absolute(data).u8string();
        text(utf8); require(!utf8.empty() && utf8.find('\0') == std::string::npos, "invalid media path");
        if (reading) {
            require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), int(utf8.size()), nullptr, 0) > 0, "invalid UTF8 path");
            data = std::filesystem::u8path(utf8); require(data.is_absolute(), "media path must be absolute");
        }
    }
};

void Snapshot::disk(SnapshotArchive& a, std::unique_ptr<Disk>& drive, bool floppy) {
    bool present = drive != nullptr; a.value(present); if (!present) return;
    uint8_t kind = !a.reading ? (!drive->memory.empty() ? 2 : drive->hasOverlay() ? 1 : 0) : 0;
    a.value(kind); require(kind <= 2 && (!floppy || kind != 1), "invalid disk kind");
    std::filesystem::path path = a.reading ? std::filesystem::path() : drive->path;
    a.path(path);
    bool ro = !a.reading && drive->readOnly; a.value(ro);
    require(kind == 2 || ro || kind == 1, "writable disk needs COW; use --hard BASE --overlay WRITES.cow (direct images cannot be rolled back)");
    if (kind == 2) {
        std::vector<uint8_t> memory = a.reading ? std::vector<uint8_t>() : drive->memory;
        a.blob(memory, 2880u * 1024);
        if (a.reading) {
            drive = std::make_unique<Disk>(path, std::move(memory));
            drive->readOnly = ro;
        }
    } else {
        std::array<uint8_t, 32> digest = a.reading ? std::array<uint8_t, 32>{} : drive->snapshotHash();
        a.value(digest);
        if (a.reading) {
            auto candidate = std::make_unique<Disk>(path, floppy, true);
            require(candidate->snapshotHash() == digest, "base disk SHA256 mismatch; original disks unchanged");
            if (kind == 1) {
                require(!ro && !floppy, "invalid COW disk flags");
                RemoveFile cleanup{uniqueFile(a.source.wstring() + L".resume.cow")};
                {
                    Handle file;
                    file.value = CreateFileW(cleanup.path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
                    require(file.value != INVALID_HANDLE_VALUE, "cannot initialize private overlay");
                    std::array<uint8_t, 64> header{};
                    std::copy_n("ASM86COW", 8, header.begin()); header[8] = 1;
                    for (unsigned i = 0; i < 4; ++i) header[12 + i] = uint8_t(candidate->sectors >> (i * 8));
                    std::copy(digest.begin(), digest.end(), header.begin() + 16);
                    io(file.value, header.data(), header.size(), true);
                    require(FlushFileBuffers(file.value), "cannot flush private overlay header");
                }
                candidate = std::make_unique<Disk>(path, false, false, cleanup.path);
                candidate->ownedOverlay = true; cleanup.path.clear();
            }
            drive = std::move(candidate);
        }
        if (kind == 1) {
            uint32_t count = a.reading ? 0 : uint32_t(drive->overlayIndex.size()); a.value(count);
            require(count <= MaxCowSectors && count <= drive->sectors && uint64_t(count) * 516 <= a.limit - a.position,
                "invalid COW sector count (maximum 1,048,576 changed sectors / 512 MiB)");
            std::array<uint8_t, 512> data{};
            if (a.reading) {
                for (uint32_t i = 0; i < count; ++i) {
                    uint32_t lba = 0; a.value(lba); a.value(data);
                    require(lba < drive->sectors && !drive->overlayIndex.count(lba), "invalid or duplicate COW LBA");
                    require(drive->write(lba, data.data()), "cannot restore private COW sector");
                }
                drive->flush();
            } else {
                std::vector<uint32_t> lbas; lbas.reserve(count);
                for (const auto& entry : drive->overlayIndex) lbas.push_back(entry.first);
                std::sort(lbas.begin(), lbas.end());
                for (auto lba : lbas) {
                    a.value(lba);
                    require(drive->transfer(lba, data.data(), false), "cannot read COW sector");
                    a.value(data);
                }
            }
        }
    }
    uint32_t sectors = drive->sectors;
    int cylinders = drive->cylinders, heads = drive->heads, spt = drive->spt, type = drive->floppyType;
    a.fields(sectors, cylinders, heads, spt, type);
    require(sectors == drive->sectors && cylinders == drive->cylinders && heads == drive->heads && spt == drive->spt && type == drive->floppyType,
        "disk geometry mismatch");
    a.fields(drive->changed, drive->readSectors, drive->writtenSectors);
}

void Snapshot::optical(SnapshotArchive& a, AtapiCdrom& cd) {
    bool present = cd.disc != nullptr; a.value(present); if (!present) return;
    auto path = a.reading ? std::filesystem::path() : cd.disc->path; a.path(path);
    Handle lock;
    lock.value = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(lock.value != INVALID_HANDLE_VALUE, "cannot lock optical base");
    auto digest = a.reading ? std::array<uint8_t, 32>{} : hashFile(lock.value); a.value(digest);
    if (a.reading) {
        require(hashFile(lock.value) == digest, "optical base SHA256 mismatch");
        cd.disc = std::make_unique<IsoImage>(path);
    }
}

void Snapshot::state(SnapshotArchive& a, Pc& p) {
    auto& c = p.cpu;
    a.enumeration(c.model, 3);
    a.blob(c.mem, 256u << 20);
    a.fields(c.a20, c.msw, c.cr2, c.cr3, c.cpl, c.gdtr.base, c.gdtr.limit, c.idtr.base, c.idtr.limit);
    for (auto* seg : {&c.ldtr, &c.tr}) a.fields(seg->selector, seg->base, seg->limit, seg->access);
    a.fields(c.r, c.s, c.ip, c.flags, c.halted, c.waiting, c.repContinue);
    a.fields(c.mmioStart, c.mmioEnd);
    for (auto& window : c.pciWindows) a.fields(window.first, window.second);
    for (auto& seg : c.segments) a.fields(seg.base, seg.limit, seg.access, seg.attributes, seg.null);
    a.fields(c.upperR, c.debugRegisters, c.upperFlags, c.hiddenSegments);
    a.fields(c.mod, c.reg, c.rm, c.eaSeg, c.overrideSeg, c.eaOff, c.startIp, c.rep, c.inhibit, c.taskCommitted,
        c.operand32, c.address32, c.lockPrefix, c.eaUsesSp, c.fpuIrqRaised, c.fpuIrqInhibited);
    auto& f = c.fpu;
    a.fields(f.registers, f.tags, f.control, f.status, f.cs, f.ds, f.opcode, f.top, f.ip, f.dp);
    auto& v = p.vga;
    a.fields(v.mode, v.seq, v.gc, v.crtc, v.attr, v.dac, v.planes, v.latch);
    a.blob(v.vram, Vga::VramBytes);
    a.fields(v.cursorDac, v.hiddenDac, v.hiddenAccess, v.cursorX, v.cursorY, v.blt);
    a.blob(v.bltSource, 65536);
    a.fields(v.bltSourcePitch, v.bltRows, v.bltPadding, v.seqIndex, v.gcIndex, v.crtcIndex, v.attrAddress, v.misc,
        v.pelMask, v.readIndex, v.writeIndex, v.readPart, v.writePart, v.dacState, v.attrData);
    auto& s = p.serialMouse;
    uint32_t count = uint32_t(s.queue.size()); a.value(count);
    require(count <= 65536 && uint64_t(count) * 9 <= a.limit - a.position, "invalid serial queue length");
    if (a.reading) s.queue.resize(count);
    for (auto& b : s.queue) a.fields(b.at, b.value);
    a.fields(s.dll, s.dlm, s.ier, s.lcr, s.mcr, s.scratch, s.rbr, s.lsr, s.msr, s.delta, s.buttons, s.lastButtons,
        s.irqLine, s.txPending, s.txInterrupt, s.identified, s.transmitted, s.pendingX, s.pendingY, s.txDone, s.nextEvent);
    auto& d = p.dma;
    a.fields(d.address, d.count, d.baseAddress, d.baseCount, d.mode, d.page, d.command, d.request, d.high, d.mask, d.terminal, d.cascaded);
    auto& i = p.ide;
    a.enumeration(i.phase, 2); a.enumeration(i.action, 3);
    a.fields(i.features, i.count, i.sector, i.cylinderLow, i.cylinderHigh, i.device, i.control, i.status, i.error,
        i.pendingError, i.multiple, i.logicalHeads, i.logicalSpt, i.position, i.remaining, i.blockSize, i.blockCount,
        i.lba, i.irqPending, i.writeCache, i.nextEvent);
    a.blob(i.buffer, 256 * 512);
    auto& cd = p.cdrom;
    a.enumeration(cd.phase, 2); a.enumeration(cd.action, 3);
    a.fields(cd.sense.key, cd.sense.asc, cd.sense.ascq, cd.features, cd.reason, cd.lbaLow, cd.byteLow, cd.byteHigh,
        cd.device, cd.control, cd.status, cd.error, cd.pendingError, cd.irqPending, cd.mediaChanged, cd.locked,
        cd.packetCommand, cd.packetPosition, cd.position, cd.responsePosition, cd.byteLimit, cd.payload,
        cd.readOffset, cd.readRemaining, cd.packet, cd.nextEvent);
    a.blob(cd.buffer, 65536); a.blob(cd.response, 65536);
    auto& fd = p.fdc;
    a.enumeration(fd.phase, 4); a.enumeration(fd.action, 4);
    a.fields(fd.dor, fd.rate, fd.perpendicular, fd.resetSense, fd.cylinder, fd.seekTarget, fd.seekHead, fd.seekTime, fd.specify, fd.config);
    a.sequence(fd.pending, 65536);
    a.blob(fd.command, 32); a.blob(fd.active, 32); a.blob(fd.result, 32); a.blob(fd.buffer, 65536);
    a.fields(fd.position, fd.resultPosition, fd.rotation, fd.sectorIndex);
    count = uint32_t(fd.sectors.size()); a.value(count);
    require(count <= 65536 && uint64_t(count) * 6 <= a.limit - a.position, "invalid FDC sector list");
    if (a.reading) fd.sectors.resize(count);
    for (auto& sector : fd.sectors) a.fields(sector.lba, sector.head, sector.number);
    auto mediaTag = [&](uint64_t identity) -> uint8_t {
        return !identity ? 0 : p.floppy && identity == p.floppy->identity ? 1 :
            p.cdFloppy && identity == p.cdFloppy->identity ? 2 : 3;
    };
    uint8_t seenMedia = a.reading ? 0 : mediaTag(fd.seenMedia);
    uint8_t activeMedia = a.reading ? 0 : mediaTag(fd.activeMedia);
    a.fields(seenMedia, activeMedia, fd.changed, fd.irqPending, fd.locked, fd.writing, fd.dirty, fd.due, fd.nextEvent);
    require(seenMedia <= 3 && activeMedia <= 3, "invalid FDC media reference");
    auto& sb = p.sound;
    a.fields(sb.enabled, sb.unsupportedCommands);
    a.sequence(sb.fifo, 65536);
    a.fields(sb.params, sb.buffer, sb.position, sb.parameter, sb.block, sb.left, sb.command, sb.test, sb.resetHigh,
        sb.speaker, sb.irq, sb.active, sb.autoInit, sb.paused, sb.resetNext, sb.sourceNext, sb.renderNext,
        sb.tailEnd, sb.period, sb.pauseRemaining, sb.busyUntil, sb.sample);
    a.fields(p.instructions, p.clock, p.bootDrive, p.rebootRequested, p.powerOffRequested);
    a.text(p.notice);
    for (auto& pic : p.pic) a.fields(pic.mask, pic.pending, pic.service, pic.base, pic.init, pic.priority,
        pic.single, pic.needs4, pic.readService, pic.autoEoi);
    a.fields(p.cmos, p.cmosIndex, p.kbdCommand, p.kbdOutput, p.kbdWrite, p.fastA20, p.pendingReset);
    a.sequence(p.controller, 65536); a.value(p.nextRtc);
    int64_t epoch = int64_t(p.rtcEpoch); a.value(epoch); if (a.reading) p.rtcEpoch = std::time_t(epoch);
    a.sequence(p.keys, 65536);
    a.fields(p.keyboardLatch, p.keyboardRead, p.reload, p.pitStart, p.latch, p.access, p.pitMode, p.writeHigh,
        p.readHigh, p.latched, p.port61, p.crtcIndex, p.nextTimer, p.apmConnected, p.apmEnabled, p.apmEngaged,
        p.apmVersion, p.pciAddress, p.pciFramebuffer, p.pciRegisters, p.pciRomAddress, p.pciCommand, p.pciLatency);
    a.blob(p.pciRom, Pc::PciRomBytes);
    a.fields(p.cdBootMedia, p.cdStatus, p.cdLoadSegment, p.cdLoadCount, p.cdImageLba);
    // Saved FDC identity references must follow the fresh owned media, including an emulated CD floppy.
    disk(a, p.floppy, true); disk(a, p.hard, false); disk(a, p.cdFloppy, true); optical(a, p.cdrom);
    if (a.reading) {
        auto remap = [&](uint8_t tag) -> uint64_t {
            if (!tag) return 0;
            if (tag == 1) { require(p.floppy != nullptr, "missing FDC floppy reference"); return p.floppy->identity; }
            if (tag == 2) { require(p.cdFloppy != nullptr, "missing FDC boot media reference"); return p.cdFloppy->identity; }
            return std::numeric_limits<uint64_t>::max();
        };
        fd.seenMedia = remap(seenMedia); fd.activeMedia = remap(activeMedia);
    }
    validate(p);
}

void Snapshot::validate(const Pc& p) {
    const auto& c = p.cpu;
    require(c.mem.size() == (1u << 20) || c.mem.size() == (16u << 20) || c.mem.size() == (32u << 20) ||
        c.mem.size() == (64u << 20) || c.mem.size() == (128u << 20) || c.mem.size() == (256u << 20), "invalid RAM size");
    require(c.cpl <= 3 && c.fpu.top < 8 && c.eaSeg >= 0 && c.eaSeg < 6 && c.overrideSeg >= -1 && c.overrideSeg < 6,
        "invalid CPU state");
    require(c.mod >= 0 && c.mod <= 3 && c.reg >= 0 && c.reg < 8 && c.rm >= 0 && c.rm < 8 &&
        c.hiddenSegments <= 63, "invalid CPU decoder state");
    require(p.cmosIndex < p.cmos.size() && p.vga.attrAddress < 64, "invalid device register index");
    for (auto tag : c.fpu.tags) require(tag <= 3, "invalid x87 tag");
    require(std::isfinite(p.clock) && p.clock >= 0 && p.clock <= 0x1p52, "invalid guest clock");
    require(p.vga.vram.empty() || p.vga.vram.size() == Vga::VramBytes, "invalid VRAM size");
    require(p.vga.readPart < 3 && p.vga.writePart < 3 && p.vga.bltSourcePitch <= 65536 && p.vga.bltRows <= 2048 &&
        p.vga.bltPadding < 4 && p.vga.bltSource.size() <= p.vga.bltSourcePitch, "invalid VGA partial transfer");
    require(p.ide.position <= p.ide.buffer.size() && p.ide.remaining <= 256 && p.ide.blockSize >= 1 &&
        p.ide.blockSize <= 256 && p.ide.blockCount <= 256 && p.ide.logicalHeads <= 16 && p.ide.logicalSpt <= 255 &&
        !(p.ide.position & 1) && !(p.ide.buffer.size() & 1), "invalid IDE transfer");
    if (p.ide.phase != IdeChannel::Phase::Idle)
        require(p.ide.position < p.ide.buffer.size(), "empty active IDE transfer");
    if (std::isfinite(p.ide.nextEvent) && p.ide.action == IdeChannel::Action::Input)
        require(p.ide.buffer.size() >= 2, "empty scheduled IDE input");
    if (std::isfinite(p.ide.nextEvent) && p.ide.action == IdeChannel::Action::Write)
        require(p.ide.remaining >= 1, "empty scheduled IDE output");
    require(p.cdrom.packetPosition <= 12 && p.cdrom.position <= p.cdrom.buffer.size() &&
        p.cdrom.responsePosition <= p.cdrom.response.size() && p.cdrom.byteLimit >= 1 && p.cdrom.byteLimit <= 65536 &&
        p.cdrom.payload <= 65536 && !(p.cdrom.position & 1) && !(p.cdrom.packetPosition & 1) && !(p.cdrom.buffer.size() & 1),
        "invalid ATAPI transfer");
    if (p.cdrom.phase == AtapiCdrom::Phase::Input) require(p.cdrom.position < p.cdrom.buffer.size(), "empty active ATAPI transfer");
    if (p.cdrom.phase == AtapiCdrom::Phase::Packet) require(p.cdrom.packetPosition < 12, "complete packet in packet phase");
    if (std::isfinite(p.cdrom.nextEvent) && p.cdrom.action == AtapiCdrom::Action::Input)
        require(p.cdrom.buffer.size() >= 2, "empty scheduled ATAPI input");
    if (p.cdrom.disc) require(p.cdrom.readOffset <= p.cdrom.disc->bytes &&
        p.cdrom.readRemaining <= p.cdrom.disc->bytes - p.cdrom.readOffset, "invalid ATAPI media range");
    const auto& fd = p.fdc;
    if (fd.phase == FloppyController::Phase::Result) require(fd.resultPosition < fd.result.size(), "empty FDC result phase");
    if (fd.phase == FloppyController::Phase::Read || fd.phase == FloppyController::Phase::Write)
        require(fd.position < fd.buffer.size() && fd.active.size() >= 2, "invalid active FDC data phase");
    if (!fd.command.empty()) {
        static constexpr int parameters[] = {-1,-1,8,2,1,8,8,1,0,-1,1,-1,8,5,0,2,0,-1,1,3,0};
        unsigned op = fd.command[0] & 31;
        require(op < std::size(parameters) && parameters[op] >= 0 && fd.command.size() <= unsigned(parameters[op]),
            "invalid partial FDC command");
    }
    if (!fd.active.empty()) {
        auto op = fd.active[0] & 31;
        require((op == 10 && fd.active.size() == 2) || (op == 13 && fd.active.size() == 6) ||
            ((op == 2 || op == 5 || op == 6 || op == 12) && fd.active.size() == 9), "invalid active FDC command");
        if ((fd.phase == FloppyController::Phase::Read || fd.phase == FloppyController::Phase::Write) && op != 13)
            require(fd.buffer.size() == 512 && fd.sectorIndex < fd.sectors.size(), "invalid FDC sector transfer");
        if (fd.phase == FloppyController::Phase::Write && op == 13)
            require(fd.buffer.size() == unsigned(fd.active[3]) * 4 && !fd.buffer.empty(), "invalid FDC format transfer");
    }
    if (fd.action != FloppyController::Action::None && fd.action != FloppyController::Action::Reset)
        require(fd.active.size() >= 2, "missing FDC scheduled command");
    if (fd.action == FloppyController::Action::Id) require((fd.active[0] & 31) == 10, "invalid FDC ID action");
    if (fd.action == FloppyController::Action::Format) require((fd.active[0] & 31) == 13, "invalid FDC format action");
    if (fd.action == FloppyController::Action::Transfer) {
        require(fd.active.size() == 9 && (fd.sectors.empty() || fd.sectorIndex < fd.sectors.size()) &&
            (fd.buffer.empty() || fd.buffer.size() == 512), "invalid scheduled FDC transfer");
    }
    require(!fd.dirty || fd.active.size() >= 2, "missing dirty FDC command");
    require(p.sound.position < p.sound.buffer.size() && p.sound.parameter <= 2 && p.sound.block >= 1 &&
        p.sound.block <= 65536 && p.sound.left <= 65536 && p.sound.command >= -1 && p.sound.command <= 255 &&
        std::isfinite(p.sound.period) && p.sound.period >= SoundBlaster::PitHz / 23000 &&
        p.sound.period <= SoundBlaster::PitHz / 4000 && std::isfinite(p.sound.pauseRemaining) &&
        p.sound.pauseRemaining >= 0 && p.sound.pauseRemaining <= p.sound.period, "invalid SoundBlaster transfer");
    require(!p.sound.active || p.sound.left >= 1, "empty active SoundBlaster block");
    if (p.sound.command >= 0) require(p.sound.parameter < SoundBlaster::parameters(uint8_t(p.sound.command)), "invalid DSP partial command");
    for (auto time : p.pitStart) require(std::isfinite(time) && time >= 0 && time <= p.clock, "invalid PIT origin");
    auto deadline = [&](double time) { require(time >= p.clock, "scheduled event precedes guest clock"); };
    deadline(p.nextTimer); deadline(p.nextRtc); deadline(p.serialMouse.nextEvent); deadline(fd.nextEvent);
    if (p.at()) { deadline(p.ide.nextEvent); deadline(p.cdrom.nextEvent); }
    if (p.sound.enabled) { deadline(p.sound.resetNext); deadline(p.sound.sourceNext); deadline(p.sound.renderNext); deadline(p.sound.tailEnd); }
    for (auto time : fd.seekTime) deadline(time);
    double serialTime = p.clock;
    for (const auto& byte : p.serialMouse.queue) { require(byte.at >= serialTime, "invalid serial event ordering"); serialTime = byte.at; }
    for (const auto& pic : p.pic) require(pic.init <= 3 && pic.priority < 8, "invalid PIC initialization");
    for (auto access : p.access) require(access <= 3, "invalid PIT access");
}

void Snapshot::save(Pc& pc, const std::filesystem::path& value) {
    // TLB 不写入快照；保存时同时清空运行中的 TLB，使继续执行与恢复后的执行完全一致。
    pc.cpu.flushTlb();
    auto path = std::filesystem::absolute(value);
    for (auto* disk : {pc.floppy.get(), pc.hard.get(), pc.cdFloppy.get()}) {
        if (!disk) continue;
        require(!samePath(path, disk->path) && !samePath(path, disk->overlayPath()), "destination aliases attached disk or overlay");
        require(disk->readOnly || disk->hasOverlay() || !disk->memory.empty(),
            "writable disk needs COW; use --hard BASE --overlay WRITES.cow (direct images cannot be rolled back)");
        require(disk->overlayIndex.size() <= MaxCowSectors, "COW exceeds snapshot limit of 1,048,576 changed sectors / 512 MiB");
    }
    if (pc.cdrom.medium()) require(!samePath(path, pc.cdrom.medium()->path), "destination aliases optical base");
    validate(pc);
    RemoveFile cleanup{uniqueFile(path.wstring() + L".saving")};
    {
        Handle file;
        file.value = CreateFileW(cleanup.path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        require(file.value != INVALID_HANDLE_VALUE, "cannot open reserved snapshot output");
        std::array<uint8_t, 32> header{}; io(file.value, header.data(), header.size(), true);
        SnapshotArchive archive(file.value, false, MaxSnapshotBytes - header.size(), path);
        state(archive, pc);
        seek(file.value, 0);
        std::copy_n("ASM86SNP", 8, header.begin());
        auto put = [&](unsigned offset, uint64_t n, unsigned width) { for (unsigned i = 0; i < width; ++i) header[offset + i] = uint8_t(n >> (i * 8)); };
        put(8, Version, 4); put(16, archive.position, 8); put(24, ~archive.crc, 4);
        io(file.value, header.data(), header.size(), true);
        require(FlushFileBuffers(file.value), "snapshot flush failed");
    }
    require(MoveFileExW(cleanup.path.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH), "atomic snapshot replace failed");
    cleanup.path.clear();
}

std::unique_ptr<Pc> Snapshot::load(const std::filesystem::path& value) {
    auto path = std::filesystem::absolute(value);
    Handle file;
    file.value = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(file.value != INVALID_HANDLE_VALUE, "cannot open input");
    auto size = fileSize(file.value); require(size >= 32 && size <= MaxSnapshotBytes, "invalid file size");
    std::array<uint8_t, 32> header{}; io(file.value, header.data(), header.size(), false);
    require(std::equal(header.begin(), header.begin() + 8, "ASM86SNP"), "invalid magic");
    auto get = [&](unsigned offset, unsigned width) {
        uint64_t n = 0; for (unsigned i = 0; i < width; ++i) n |= uint64_t(header[offset + i]) << (i * 8); return n;
    };
    require(get(8, 4) == Version, "unsupported format version");
    require(get(12, 4) == 0 && get(28, 4) == 0, "invalid reserved header");
    require(get(16, 8) == size - 32, "truncated snapshot or trailing bytes");
    uint32_t crc = 0xffffffffu; std::array<uint8_t, 65536> buffer{};
    for (uint64_t remaining = size - 32; remaining;) {
        auto count = size_t(std::min<uint64_t>(remaining, buffer.size()));
        io(file.value, buffer.data(), count, false); crc = crcUpdate(crc, buffer.data(), count); remaining -= count;
    }
    require(uint64_t(~crc) == get(24, 4), "payload CRC32 mismatch");
    seek(file.value, 32);
    auto pc = std::make_unique<Pc>();
    SnapshotArchive archive(file.value, true, size - 32, path); state(archive, *pc);
    require(archive.position == archive.limit && uint64_t(~archive.crc) == get(24, 4), "payload layout mismatch");
    return pc;
}
}
