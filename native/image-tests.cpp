#include "image.h"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <functional>
#include <algorithm>

namespace {
using Bytes = std::vector<uint8_t>;
void require(bool condition, const char* text) { if (!condition) throw std::runtime_error(text); }
void fails(const std::function<void()>& action, const std::string& message) {
    try { action(); }
    catch (const std::exception& e) {
        require(std::string(e.what()).find(message) != std::string::npos, e.what()); return;
    }
    throw std::runtime_error("Expected operation to fail: " + message);
}
Bytes bytes(const std::filesystem::path& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot open test fixture");
    return Bytes(std::istreambuf_iterator<char>(f), {});
}
void write(const std::filesystem::path& path, const Bytes& data) {
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(data.data()), std::streamsize(data.size()));
    if (!f) throw std::runtime_error("Cannot write test fixture");
}
uint16_t word(const Bytes& b, size_t o) { return uint16_t(b[o] | unsigned(b[o + 1]) << 8); }
uint32_t integer(const Bytes& b, size_t o) { return word(b, o) | uint32_t(word(b, o + 2)) << 16; }
void layout(const std::filesystem::path& path, bool floppy, uint64_t size) {
    auto b = bytes(path);
    require(b.size() == size, "Exact image capacity");
    size_t base = floppy ? 0 : 63 * 512;
    require(word(b, 510) == 0xaa55 && word(b, base + 510) == 0xaa55, "MBR and VBR signatures");
    if (!floppy) {
        require(b[446] == 0x80 && integer(b, 454) == 63 && integer(b, 458) == size / 512 - 63, "Partition start/size");
        auto end = size / 512 - 1, cylinder = end / (16 * 63);
        require(b[451] == 15 && (b[452] & 63) == 63 &&
            (b[453] | unsigned(b[452] & 0xc0) << 2) == cylinder, "Last-sector CHS");
    }
    require(word(b, base + 11) == 512 && b[base + 16] == 2, "Standard FAT BPB");
    require(word(b, base + 24) == (floppy ? 18 : 63) && word(b, base + 26) == (floppy ? 2 : 16), "Expected geometry");
    auto total = word(b, base + 19) ? word(b, base + 19) : integer(b, base + 32);
    require(total == (size - base) / 512, "BPB total sectors");
    size_t fat = base + word(b, base + 14) * 512, fatSize = word(b, base + 22) * 512;
    require(std::equal(b.begin() + fat, b.begin() + fat + fatSize, b.begin() + fat + fatSize), "FAT mirrors");
}
}
int main() {
    using namespace asm86::image;
    std::filesystem::path root;
    try {
        wchar_t temp[MAX_PATH]{}, file[MAX_PATH]{};
        require(GetTempPathW(MAX_PATH, temp) && GetTempFileNameW(temp, L"a86", 0, file), "Test temp path");
        require(DeleteFileW(file) && CreateDirectoryW(file, nullptr), "Test temp directory");
        root = file;
        auto floppy = root / L"FLOPPY.IMG", hard = root / L"HARD.IMG";
        for (const auto& s : {L"160",L"180",L"320",L"360",L"720",L"1200",L"1440"}) {
            create(floppy, floppySize(s), true, false);
            auto info = inspect(floppy);
            require(info.bytes == floppySize(s) && info.fatBits == 12 && info.entries.empty(), "FAT12 floppy format");
            std::filesystem::remove(floppy);
        }
        create(floppy, floppySize(L"1440"), true, false); layout(floppy, true, floppySize(L"1440"));
        for (const auto& s : {L"31.5",L"63",L"126",L"252",L"504"}) {
            create(hard, hardSize(s), false, false);
            auto info = inspect(hard);
            require(info.bytes == hardSize(s) && info.fatBits == 16 && info.freeBytes > hardSize(s) * 95 / 100, "FAT16 capacity");
            layout(hard, false, hardSize(s));
            std::filesystem::remove(hard);
        }
        fails([&] { hardSize(L"505"); }, "at most 504");
        fails([&] { hardSize(L"32"); }, "whole");
        fails([&] { hardSize(L"-31.5"); }, "unsigned");
        fails([&] { floppySize(L"2880"); }, "Floppy size");
        fails([&] { create(floppy, floppySize(L"1440"), true, false); }, "already exists");
        auto raw = root / L"RAW.IMG";
        create(raw, floppySize(L"360"), true, true);
        auto zero = bytes(raw);
        require(zero.size() == 360 * 1024 && std::all_of(zero.begin(), zero.end(), [](auto b) { return !b; }), "Raw image is all zeros");
        fails([&] { inspect(raw); }, "Unformatted");

        std::filesystem::create_directories(root / L"TREE" / L"SUB");
        Bytes payload(5000);
        for (size_t i = 0; i < payload.size(); ++i) payload[i] = uint8_t(i * 37);
        write(root / L"TREE" / L"SUB" / L"DATA.BIN", payload);
        write(root / L"TREE" / L"EMPTY.TXT", {});
        write(root / L"NOTE.TXT", {'o','k'});
        put(floppy, {root / L"TREE", root / L"NOTE.TXT"}, L"\\DATA\\FILES", false);
        require(read(floppy, L"\\DATA\\FILES\\TREE\\SUB\\DATA.BIN") == payload, "Multi-cluster FAT12 recursive import");
        require(read(floppy, L"\\DATA\\FILES\\TREE\\EMPTY.TXT").empty(), "Empty file");
        require(read(floppy, L"\\DATA\\FILES\\NOTE.TXT") == Bytes({'o','k'}), "Multiple source import");
        auto before = bytes(floppy);
        fails([&] { put(floppy, {root / L"NOTE.TXT"}, L"\\DATA\\FILES", false); }, "already exists");
        require(bytes(floppy) == before, "Duplicate rollback");
        Bytes larger(10000, 0x5a); write(root / L"NOTE.TXT", larger);
        put(floppy, {root / L"NOTE.TXT"}, L"\\DATA\\FILES", true);
        require(read(floppy, L"\\DATA\\FILES\\NOTE.TXT") == larger, "Explicit replacement and chain extension");
        before = bytes(floppy);
        write(root / L"TOO-LONG-NAME.TXT", {1});
        fails([&] { put(floppy, {root / L"NOTE.TXT", root / L"TOO-LONG-NAME.TXT"}, L"\\ROLLBACK", true); }, "8.3");
        require(bytes(floppy) == before, "Late invalid-name rollback includes new destination directories");
        write(root / L"HUGE.BIN", Bytes(1400 * 1024, 7));
        write(root / L"EXTRA.BIN", Bytes(80 * 1024, 8));
        fails([&] { put(floppy, {root / L"HUGE.BIN", root / L"EXTRA.BIN"}, L"\\FULL", false); }, "free space");
        require(bytes(floppy) == before, "Combined FAT allocation overflow is atomic");
        std::filesystem::create_directory(root / L"MANY");
        for (int i = 0; i < 40; ++i) write(root / L"MANY" / (L"F" + std::to_wstring(i) + L".TXT"), {uint8_t(i)});
        put(floppy, {root / L"MANY"}, L"\\", false);
        require(inspect(floppy, L"\\MANY").entries.size() == 40, "Subdirectory cluster expansion");
        before = bytes(floppy);
        HANDLE mounted = CreateFileW(floppy.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        require(mounted != INVALID_HANDLE_VALUE, "Open mounted fixture");
        try { fails([&] { put(floppy, {root / L"NOTE.TXT"}, L"\\", false); }, "mounted"); }
        catch (...) { CloseHandle(mounted); throw; }
        CloseHandle(mounted);
        require(bytes(floppy) == before, "Mounted image unchanged");
        auto corrupt = before;
        size_t fat = word(corrupt, 14) * 512, fatBytes = word(corrupt, 22) * 512;
        corrupt[fat + fatBytes + 10] ^= 1; write(floppy, corrupt);
        fails([&] { put(floppy, {root / L"NOTE.TXT"}, L"\\", false); }, "FAT copies disagree");
        require(bytes(floppy) == corrupt, "Corrupt FAT is not modified");
        write(floppy, before);

        create(hard, hardSize(L"31.5"), false, false);
        put(hard, {root / L"TREE"}, L"\\INSTALL", false);
        require(read(hard, L"\\INSTALL\\TREE\\SUB\\DATA.BIN") == payload, "FAT16 import persists");
        auto h = bytes(hard);
        std::fill(h.begin(), h.begin() + 440, 0x90); // Existing boot code must survive imports.
        write(hard, h);
        put(hard, {root / L"NOTE.TXT"}, L"\\INSTALL", false);
        auto after = bytes(hard);
        require(std::equal(h.begin(), h.begin() + 512, after.begin()), "Existing MBR preserved byte-for-byte");
        require(std::equal(h.begin() + 63 * 512, h.begin() + 64 * 512, after.begin() + 63 * 512), "Existing VBR preserved byte-for-byte");
        auto bootFile = root / L"BOOT.BIN";
        exportBoot(floppy, bootFile, BootSector::Floppy);
        auto boot = bytes(bootFile), floppyBefore = bytes(floppy);
        require(boot == Bytes(floppyBefore.begin(), floppyBefore.begin() + 512), "Floppy export is exactly the original 512 bytes");
        fails([&] { exportBoot(floppy, bootFile, BootSector::Floppy); }, "already exists");
        boot[100] ^= 0x7f; boot[43] ^= 1; write(bootFile, boot);
        importBoot(floppy, bootFile, BootSector::Floppy);
        auto expected = floppyBefore; expected[100] = boot[100];
        require(bytes(floppy) == expected, "Code-only floppy import preserves OEM/BPB and every other sector");
        require(read(floppy, L"\\DATA\\FILES\\TREE\\SUB\\DATA.BIN") == payload, "Files readable after boot code import");
        write(bootFile, Bytes(511));
        fails([&] { importBoot(floppy, bootFile, BootSector::Floppy, 1, true); }, "exactly 512");
        require(bytes(floppy) == expected, "Short boot input does not modify image");
        write(bootFile, Bytes(513));
        fails([&] { importBoot(floppy, bootFile, BootSector::Floppy, 1, true); }, "exactly 512");
        boot[510] = 0; write(bootFile, boot);
        fails([&] { importBoot(floppy, bootFile, BootSector::Floppy); }, "55AA");
        require(bytes(floppy) == expected, "Invalid signature rollback");
        boot[510] = 0x55; boot[1] = 0; write(bootFile, boot);
        fails([&] { importBoot(floppy, bootFile, BootSector::Floppy); }, "boot jump");
        require(bytes(floppy) == expected, "Boot jump into preserved BPB must be rejected");
        boot[1] = 0x3c; write(bootFile, boot);
        HANDLE bootMounted = CreateFileW(floppy.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        require(bootMounted != INVALID_HANDLE_VALUE, "Open boot mounted fixture");
        try { fails([&] { importBoot(floppy, bootFile, BootSector::Floppy); }, "mounted"); }
        catch (...) { CloseHandle(bootMounted); throw; }
        CloseHandle(bootMounted);
        require(bytes(floppy) == expected, "Mounted boot import rejected without side effects");

        std::filesystem::remove(bootFile);
        exportBoot(hard, bootFile, BootSector::Mbr);
        auto hardBefore = bytes(hard);
        require(bytes(bootFile) == Bytes(hardBefore.begin(), hardBefore.begin() + 512), "MBR export includes partition table");
        boot = bytes(bootFile);
        std::fill(boot.begin(), boot.begin() + 510, 0x5a); write(bootFile, boot);
        importBoot(hard, bootFile, BootSector::Mbr);
        auto hardExpected = hardBefore;
        std::copy_n(boot.begin(), 440, hardExpected.begin());
        require(bytes(hard) == hardExpected, "MBR code import preserves disk signature, reserved bytes and partition table");

        std::filesystem::remove(bootFile);
        exportBoot(hard, bootFile, BootSector::Partition);
        boot = bytes(bootFile);
        require(boot == Bytes(hardExpected.begin() + 63 * 512, hardExpected.begin() + 64 * 512), "Partition export uses MBR LBA, not sector zero");
        boot[100] ^= 0x7f; boot[28] = 0; write(bootFile, boot);
        importBoot(hard, bootFile, BootSector::Partition);
        hardExpected[63 * 512 + 100] = boot[100];
        require(bytes(hard) == hardExpected, "Partition code import preserves hidden sectors and other BPB fields");
        require(read(hard, L"\\INSTALL\\TREE\\SUB\\DATA.BIN") == payload, "FAT16 remains readable after VBR import");
        fails([&] { importBoot(hard, bootFile, BootSector::Partition, 2); }, "not FAT");
        fails([&] { importBoot(hard, bootFile, BootSector::Partition, 5); }, "1..4");
        require(bytes(hard) == hardExpected, "Invalid partition selections leave image unchanged");

        auto secondSlot = hardExpected;
        std::copy_n(secondSlot.begin() + 446, 16, secondSlot.begin() + 462);
        std::fill_n(secondSlot.begin() + 446, 16, 0); write(hard, secondSlot);
        std::filesystem::remove(bootFile);
        exportBoot(hard, bootFile, BootSector::Partition, 2);
        require(bytes(bootFile) == Bytes(secondSlot.begin() + 63 * 512, secondSlot.begin() + 64 * 512), "Explicit second primary slot");
        secondSlot[470] = 0xff; secondSlot[471] = 0xff; secondSlot[472] = 0xff; secondSlot[473] = 0x7f;
        write(hard, secondSlot);
        fails([&] { importBoot(hard, bootFile, BootSector::Partition, 2, true); }, "bounds");
        require(bytes(hard) == secondSlot, "Out-of-bounds partition rejected before modification");

        Bytes full(512);
        for (size_t i = 0; i < full.size(); ++i) full[i] = uint8_t(i * 17);
        write(bootFile, full);
        write(hard, hardExpected);
        importBoot(hard, bootFile, BootSector::Partition, 1, true);
        std::copy(full.begin(), full.end(), hardExpected.begin() + 63 * 512);
        require(bytes(hard) == hardExpected, "Full partition import changes exactly its selected 512 bytes");
        importBoot(floppy, bootFile, BootSector::Floppy, 1, true);
        std::copy(full.begin(), full.end(), expected.begin());
        require(bytes(floppy) == expected, "Explicit full mode replaces all 512 bytes and nothing else");
        importBoot(hard, bootFile, BootSector::Mbr, 1, true);
        std::copy(full.begin(), full.end(), hardExpected.begin());
        require(bytes(hard) == hardExpected, "Full MBR mode intentionally replaces partition table");
        importBoot(raw, bootFile, BootSector::Floppy, 1, true);
        std::copy(full.begin(), full.end(), zero.begin());
        require(bytes(raw) == zero, "Full sector import supports unformatted media");
        std::filesystem::remove_all(root);
        std::cout << "Image utility FAT12/FAT16 / recursive import / rollback / boot-sector exact export / code-only preservation / full replacement checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Image tests failed: " << e.what() << '\n';
        if (!root.empty()) {
            std::error_code cleanup; std::filesystem::remove_all(root, cleanup);
            if (cleanup) std::cerr << "Fixture cleanup failed: " << cleanup.message() << '\n';
        }
        return 1;
    }
}
