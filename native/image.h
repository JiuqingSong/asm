#pragma once
#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

namespace asm86::image {
// 文件路径版离线工具整盘加载内存，只处理 <=504 MiB FAT12/16；流式校验接口不受此上限。
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

// export 精确输出 512 字节；import 默认保留结构参数，仅 full=true 覆盖完整扇区。
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

// 回归校验按需读取逻辑扇区，支持 FAT12/16/32；不整盘加载，也不修改底盘或差分盘。
std::vector<uint8_t> readSectors(uint32_t sectors, const std::function<bool(uint32_t, uint8_t*)>& reader,
                               const std::wstring& file, uint32_t maxFileBytes = 16 * 1024 * 1024);
}
