#pragma once
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace asm86::image {
constexpr uint64_t MaxHardBytes = 504ULL * 1024 * 1024;
constexpr uint64_t CylinderBytes = 16 * 63 * 512;
struct Entry {
    std::string name;
    bool directory;
    uint32_t size;
};
struct Info {
    uint64_t bytes, freeBytes;
    unsigned fatBits;
    std::vector<Entry> entries;
};
enum class BootSector { Floppy, Mbr, Partition };
void exportBoot(const std::filesystem::path& image, const std::filesystem::path& output,
                BootSector sector, unsigned partition = 1);
void importBoot(const std::filesystem::path& image, const std::filesystem::path& input,
                BootSector sector, unsigned partition = 1, bool full = false);
void installMbr(const std::filesystem::path& image);
uint64_t hardSize(const std::wstring& mib);
uint64_t floppySize(const std::wstring& kib);
void create(const std::filesystem::path& path, uint64_t bytes, bool floppy, bool raw);
void put(const std::filesystem::path& path, const std::vector<std::filesystem::path>& sources,
         const std::wstring& destination, bool overwrite);
Info inspect(const std::filesystem::path& path, const std::wstring& directory = L"\\");
std::vector<uint8_t> read(const std::filesystem::path& path, const std::wstring& file);
}
