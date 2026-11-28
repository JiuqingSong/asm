#include "snapshot.h"
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace asm86;
namespace {
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
struct Files {
    std::vector<std::filesystem::path> paths;
    ~Files() { for (const auto& path : paths) { std::error_code error; std::filesystem::remove(path, error); } }
    std::filesystem::path add(const std::filesystem::path& path) { paths.push_back(path); return path; }
};
bool equalFiles(const std::filesystem::path& left, const std::filesystem::path& right) {
    if (std::filesystem::file_size(left) != std::filesystem::file_size(right)) return false;
    std::ifstream a(left, std::ios::binary), b(right, std::ios::binary);
    std::array<char, 65536> x{}, y{};
    while (a) {
        a.read(x.data(), x.size()); b.read(y.data(), y.size());
        if (a.gcount() != b.gcount() || !std::equal(x.begin(), x.begin() + a.gcount(), y.begin())) return false;
    }
    return a.eof() && b.eof();
}
void rejected(const std::filesystem::path& path, const char* message) {
    bool caught = false;
    try { auto candidate = Snapshot::load(path); }
    catch (const std::runtime_error&) { caught = true; }
    check(caught, message);
}
void patch(const std::filesystem::path& path, uint64_t offset, uint8_t byte) {
    std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
    file.seekp(std::streamoff(offset)); file.put(char(byte)); file.close();
    check(bool(file), "Cannot prepare corrupt snapshot");
}
void checksum(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary); input.seekg(32);
    uint32_t crc = 0xffffffffu; std::array<char, 65536> bytes{};
    while (input) {
        input.read(bytes.data(), bytes.size());
        for (std::streamsize i = 0; i < input.gcount(); ++i) {
            crc ^= uint8_t(bytes[size_t(i)]);
            for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1)));
        }
    }
    check(input.eof(), "Cannot read snapshot checksum fixture"); input.close();
    std::fstream output(path, std::ios::binary | std::ios::in | std::ios::out); output.seekp(24);
    for (unsigned i = 0; i < 4; ++i) output.put(char((~crc) >> (i * 8)));
    output.close(); check(bool(output), "Cannot repair checksum fixture");
}
}

void snapshotTests() {
    Files files;
    auto prefix = std::filesystem::current_path() / (L"snapshot-test-" + std::to_wstring(GetCurrentProcessId()));
    auto base = files.add(prefix.wstring() + L".img");
    auto cow = files.add(prefix.wstring() + L".cow");
    auto first = files.add(prefix.wstring() + L".asnp");
    auto second = files.add(prefix.wstring() + L".again.asnp");
    auto broken = files.add(prefix.wstring() + L".broken.asnp");
    auto iso = files.add(prefix.wstring() + L".iso");
    auto floppy = files.add(prefix.wstring() + L".floppy");
    auto fdFirst = files.add(prefix.wstring() + L".fd.asnp");
    auto fdAgain = files.add(prefix.wstring() + L".fd-again.asnp");
    Disk::create(base, 1);
    { std::ofstream file(iso, std::ios::binary); std::array<char, 4096> data{}; file.write(data.data(), data.size()); check(bool(file), "ISO fixture write"); }
    Pc p; p.setModel(CpuModel::I486, 16); p.setCirrus(true);
    p.hard = std::make_unique<Disk>(base, false, false, cow);
    p.cdrom.insert(iso);
    auto& c = p.cpu;
    const std::array<uint8_t, 8> cmosMarker{0xdb, 0xe7, 0xa9, 0xc5, 0xb3, 0xf1, 0x8d, 0x97};
    for (unsigned n = 0; n < cmosMarker.size(); ++n) {
        c.out(0x70, uint8_t(0x50 + n)); c.out(0x71, cmosMarker[n]);
    }
    c.reset(); for (auto segment : {ES, CS, SS, DS, FS, GS}) c.loadSegment(segment, 0);
    c.a20 = true; c.ip = 0x500; c.r[SP] = 0x9000;
    // Real guest loop, later resumed after hidden protected-mode data caching.
    const uint8_t program[] = {0xff, 0x06, 0, 0x60, 0xeb, 0xfa};
    std::copy(std::begin(program), std::end(program), c.mem.begin() + 0x500);
    c.msw |= 1;
    c.gdtr = {0x1000, 23};
    auto descriptor = [&](unsigned offset, uint32_t address, uint8_t access) {
        auto at = 0x1000 + offset;
        c.writeWord(at, 0xffff); c.writeWord(at + 2, uint16_t(address));
        c.mem[at + 4] = uint8_t(address >> 16); c.mem[at + 5] = access;
        c.mem[at + 6] = 0; c.mem[at + 7] = uint8_t(address >> 24);
    };
    descriptor(8, 0, 0x9a); descriptor(16, 0x10000, 0x92);
    const uint8_t jump[] = {0xea, 0, 5, 8, 0};
    std::copy(std::begin(jump), std::end(jump), c.mem.begin() + 0x400);
    c.ip = 0x400; c.step(); c.loadSegment(DS, 16);
    descriptor(16, 0x20000, 0x92); // Cached DS must stay at 0x10000, not the changed descriptor.
    c.r32(BX, 0x87654321); c.cr2 = 0x12345678; c.cr3 = 0x4000;
    c.ldtr = {0x28, 0x7000, 0xffff, 0x82}; c.tr = {0x30, 0x8000, 103, 0x8b};
    c.fpu.registers[5] = {0x923456789abcdef0ULL, 0x4002}; c.fpu.tags[5] = 0;
    c.fpu.top = 5; c.fpu.cs = 8; c.fpu.ip = 0xabc; c.fpu.dp = 0x1234;
    std::array<uint8_t, 512> sector{}; sector.fill(0x31);
    check(p.hard->write(7, sector.data()), "Seed snapshot COW");
    check(p.hard->write(9, sector.data()) && p.hard->write(8, sector.data()) &&
        p.hard->write(7, sector.data()), "Seed multiple unordered COW entries and a replaced record");
    c.out(0x1f2, 1); c.out(0x1f3, 7); c.out(0x1f6, 0xe0); c.out(0x1f7, 0x30);
    p.advanceClock(1000);
    for (unsigned n = 0; n < 17; ++n) p.ide.writeWord(uint16_t(0x4141 + n), p.clock); // Partial ATA write.
    c.out(0x176, 0xa0); c.out(0x174, 0); c.out(0x175, 8); c.out(0x177, 0xa0);
    p.advanceClock(p.clock + 200); p.cdrom.writeWord(0x0012, p.clock); // Partial ATAPI INQUIRY packet.
    c.out(0x3f5, 3); c.out(0x3f5, 0xdf); // Partial FDC SPECIFY.
    c.out(0x64, 0x60); // 8042 pending command-byte write.
    c.out(0x43, 0x36); c.out(0x40, 0x34); // PIT reload low byte only.
    c.out(0x20, 0x11); c.out(0x21, 0x20); // Partial cascaded PIC initialization.
    c.out(0x3fb, 0x80); c.out(0x3f8, 96); c.out(0x3f9, 0); c.out(0x3fb, 3);
    c.out(0x3fc, 3); // Scheduled serial mouse identification byte.
    p.sound.enabled = true;
    c.out(0x0a, 5); c.out(0x0c, 0); c.out(2, 0); c.out(2, 0x80);
    c.out(3, 3); c.out(3, 0); c.out(0x0b, 0x49); c.out(0x0a, 1);
    for (unsigned n = 0; n < 4; ++n) c.mem[0x8000 + n] = uint8_t(32 + n * 64);
    c.out(0x22c, 0x40); c.out(0x22c, 156); c.out(0x22c, 0xd1);
    c.out(0x22c, 0x14); c.out(0x22c, 3); // Pending DMA block high parameter.
    auto gr = [&](uint8_t reg, uint8_t value) { c.out(0x3ce, reg); c.out(0x3cf, value); };
    auto word = [&](uint8_t reg, uint16_t value) { gr(reg, uint8_t(value)); gr(reg + 1, uint8_t(value >> 8)); };
    c.out(0x3c4, 7); c.out(0x3c5, 0x11);
    word(0x20, 2); word(0x22, 1); word(0x24, 8); word(0x26, 8); word(0x28, 0x2000);
    gr(0x30, 4); gr(0x32, 0x0d); gr(0x31, 2);
    c.writeBus(0xe0000000, 20); c.writeBus(0xe0000000, 21); // Partial Cirrus system-source BLT.
    p.runCpu(50);
    auto before = c.rw(0x1000, 0x6000);
    Snapshot::save(p, first);
    auto resumed = Snapshot::load(first);
    auto fork = resumed->hard->overlayPath();
    check(fork != cow && std::filesystem::exists(fork), "Restore must own a distinct COW fork");
    Snapshot::save(*resumed, second);
    check(equalFiles(first, second), "All typed CPU/device/partial-command state must roundtrip exactly");
    auto finish = [&](Pc& vm) {
        auto& cpu = vm.cpu;
        cpu.out(0x60, 0x45); cpu.out(0x40, 0x12); cpu.out(0x21, 4); cpu.out(0x21, 1);
        cpu.out(0x3f5, 2);
        for (unsigned n = 17; n < 256; ++n) vm.ide.writeWord(0x5a5a, vm.clock);
        for (unsigned n = 1; n < 6; ++n) vm.cdrom.writeWord(n == 2 ? 36 : 0, vm.clock);
        for (unsigned n = 2; n < 8; ++n) cpu.writeBus(0xe0000000, uint8_t(n + 20));
        cpu.out(0x22c, 0);
        vm.runCpu(100); vm.advanceClock(vm.clock + 1000);
    };
    finish(p); finish(*resumed);
    check(resumed->cpu.rw(0x1000, 0x6000) > before && resumed->cpu.rw(0x2000, 0x6000) == 0,
        "Resumed guest must execute using hidden DS cache, not changed GDT");
    check(resumed->cpu.readBus(0xe0002000) == 20 && resumed->cpu.readBus(0xe000200a) == 26,
        "Partial BLT must finish after restore");
    check((resumed->cpu.in(8) & 2) && resumed->cpu.in(0x22e) == 0, "Resumed pending DSP DMA must reach terminal IRQ");
    // Apply identical observation side effects before comparing the complete post-resume state.
    p.cpu.in(8); p.cpu.in(0x22e);
    Snapshot::save(p, first); Snapshot::save(*resumed, second);
    check(equalFiles(first, second), "Original and resumed CPU/device/disk progression must match exactly");
    resumed.reset(); check(!std::filesystem::exists(fork), "Owned resume fork must be cleaned on VM destruction");
    // An earlier snapshot remains a private rewind even after the live overlay changes.
    sector.fill(0x63); check(p.hard->write(7, sector.data()), "Change original overlay after save");
    auto rewound = Snapshot::load(first);
    std::array<uint8_t, 512> actual{};
    check(rewound->hard->read(7, actual.data()) && actual[0] == 0x41, "Snapshot must preserve earlier COW write version");
    check(p.hard->read(7, actual.data()) && actual[0] == 0x63, "Loading cannot rewind the original overlay");
    { Disk readonly(base, false, true); check(readonly.read(7, actual.data()) && actual[0] == 0, "Snapshot never mutates base"); }
    rewound.reset();
    {
        std::ofstream image(floppy, std::ios::binary);
        std::array<char, 512> bytes{}; bytes.fill(0x37); image.write(bytes.data(), bytes.size());
        image.seekp(1474560 - 1); image.put(0); image.close(); check(bool(image), "Cannot prepare FDC snapshot fixture");
        Pc q; q.setModel(CpuModel::I286);
        q.floppy = std::make_unique<Disk>(floppy, true, true);
        auto& cpu = q.cpu;
        cpu.out(0x21, 0xbf); cpu.out(0x3f2, 0x1c);
        cpu.out(0x0a, 6); cpu.out(0x0c, 0); cpu.out(4, 0); cpu.out(4, 0x90);
        cpu.out(5, 0xff); cpu.out(5, 1); cpu.out(0x81, 0); cpu.out(0x0b, 0x46); cpu.out(0x0a, 2);
        for (auto byte : {0x46, 0, 0, 0, 1, 2, 1, 0x1b, 0xff}) cpu.out(0x3f5, uint8_t(byte));
        Snapshot::save(q, fdFirst);
        auto restored = Snapshot::load(fdFirst);
        q.advanceClock(600); restored->advanceClock(600);
        check(q.cpu.mem[0x9000] == 0x37 && restored->cpu.mem[0x9000] == 0x37 &&
            q.cpu.irq() == 14 && restored->cpu.irq() == 14, "Scheduled FDC DMA and IRQ must resume against remapped media identity");
        for (unsigned i = 0; i < 7; ++i) check(q.cpu.in(0x3f5) == restored->cpu.in(0x3f5), "Resumed FDC results differ");
        Snapshot::save(q, fdFirst); Snapshot::save(*restored, fdAgain);
        check(equalFiles(fdFirst, fdAgain), "Consumed FDC result and pending DMA state must match after resume");
    }
    std::filesystem::copy_file(first, broken);
    patch(broken, 100, 0xa5); rejected(broken, "CRC corruption must be rejected");
    std::filesystem::copy_file(first, broken, std::filesystem::copy_options::overwrite_existing);
    patch(broken, 8, 3); rejected(broken, "Future snapshot version must be rejected");
    std::filesystem::copy_file(first, broken, std::filesystem::copy_options::overwrite_existing);
    for (unsigned i = 36; i < 40; ++i) patch(broken, i, 255);
    checksum(broken); rejected(broken, "CRC-valid oversized allocation request must be rejected before allocation");
    std::filesystem::copy_file(first, broken, std::filesystem::copy_options::overwrite_existing);
    patch(broken, 40 + (16u << 20), 2); checksum(broken);
    rejected(broken, "CRC-valid invalid typed boolean must be rejected");
    std::filesystem::copy_file(first, broken, std::filesystem::copy_options::overwrite_existing);
    {
        std::ifstream file(broken, std::ios::binary);
        std::vector<uint8_t> data(size_t(std::filesystem::file_size(broken)));
        file.read(reinterpret_cast<char*>(data.data()), std::streamsize(data.size()));
        check(bool(file), "Cannot locate typed CMOS snapshot field");
        auto at = std::search(data.begin(), data.end(), cmosMarker.begin(), cmosMarker.end());
        check(at != data.end(), "Missing CMOS marker in snapshot");
        const auto offset = size_t(at - data.begin()) + 128 - 0x50;
        file.close(); patch(broken, offset, 255);
    }
    checksum(broken); rejected(broken, "CRC-valid out-of-range CMOS index must be rejected before guest access");
    std::filesystem::copy_file(first, broken, std::filesystem::copy_options::overwrite_existing);
    std::filesystem::resize_file(broken, std::filesystem::file_size(broken) - 1); rejected(broken, "Truncated snapshot must be rejected");
    p.cdrom.reset(); p.cdrom.eject(); patch(iso, 0, 1); rejected(first, "Changed optical base must be rejected");
    patch(iso, 0, 0);
    p.hard.reset();
    { Disk writable(base, false, false); sector.fill(0x17); check(writable.write(0, sector.data()), "Change base"); writable.flush(); }
    rejected(first, "Changed hard base must be rejected");
    Pc direct; direct.hard = std::make_unique<Disk>(base, false, false);
    bool caught = false;
    try { Snapshot::save(direct, first); } catch (const std::runtime_error&) { caught = true; }
    check(caught && equalFiles(first, second), "Failed direct-image save must preserve the existing snapshot atomically");
    direct.hard.reset();
    std::cout << "Snapshots: full typed roundtrip / hidden CPU-x87 / real guest progress / partial ATA-ATAPI-FDC-BLT-PIT-8042 / pending FDC-DSP DMA-IRQ / COW fork-rewind / CRC-version-truncation-base / malformed typed-state rejection passed\n";
}
