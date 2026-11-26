#include "image.h"
#include <iostream>
#include <stdexcept>

// 命令行只做严格参数解析和结果输出，文件操作/原子发布统一交给 image 模块。
int wmain(int argc, wchar_t** argv) {
    using namespace asm86::image;
    try {
        if (argc == 1 || (argc == 2 && std::wstring(argv[1]) == L"--help")) {
            std::cout <<
                "Asm86 disk image utility (sizes: MiB for hard disk, KiB for floppy)\n"
                "  image-tool create-hard IMAGE --size 31.5|63|126|252|504 [--raw]\n"
                "  image-tool create-floppy IMAGE --size 160|180|320|360|720|1200|1440 [--raw]\n"
                "  image-tool put IMAGE SOURCE... [--dest \\DIR\\SUB] [--overwrite]\n"
                "  image-tool list IMAGE [--dir \\DIR]\n"
                "  image-tool boot-export IMAGE OUTPUT --sector floppy|mbr|partition [--partition 1..4]\n"
                "  image-tool boot-import IMAGE INPUT --sector floppy|mbr|partition [--partition 1..4] [--full]\n"
                "  image-tool boot-install-mbr IMAGE\n"
                "Install self-authored MBR code to load the active partition; preserve disk identity/table.\n"
                "Boot exports are exactly 512 bytes. Import preserves BPB/partition table by default.\n"
                "--full replaces all 512 bytes, including BPB or partition table: BACK UP FIRST.\n"
                "FAT data disks are formatted but NOT bootable DOS disks. --raw creates only zeros.\n"
                "Import requires FAT12/FAT16 and ASCII DOS 8.3 source names; folders are recursive.\n"
                "Unmount the image first. Existing images/files are never overwritten implicitly.\n";
            return 0;
        }
        if (argc < 3) throw std::runtime_error("Missing command or image path; use --help");
        std::wstring command = argv[1], size, destination = L"\\";
        bool raw = false, overwrite = false, full = false, hasSector = false, hasPartition = false;
        BootSector sector = BootSector::Floppy;
        unsigned partition = 1;
        bool boot = command == L"boot-export" || command == L"boot-import";
        if (boot && argc < 4) throw std::runtime_error("Boot command requires a sector file path");
        std::vector<std::filesystem::path> sources;
        bool literal = false, hasSize = false, hasDest = false;
        for (int i = boot ? 4 : 3; i < argc; ++i) {
            // -- 后全部按源路径解释，允许文件名以 -- 开头；重复/跨命令选项显式报错。
            std::wstring arg = argv[i];
            if (!literal && arg == L"--") { literal = true; continue; }
            if (!literal && (arg == L"--sector" || arg == L"--partition")) {
                if (!boot || ++i == argc) throw std::runtime_error("Boot sector option requires a value and a boot command");
                std::wstring value = argv[i];
                if (arg == L"--sector") {
                    if (hasSector) throw std::runtime_error("Repeated --sector");
                    hasSector = true;
                    if (value == L"floppy") sector = BootSector::Floppy;
                    else if (value == L"mbr") sector = BootSector::Mbr;
                    else if (value == L"partition") sector = BootSector::Partition;
                    else throw std::runtime_error("--sector must be floppy, mbr or partition");
                } else {
                    if (hasPartition || value.size() != 1 || value[0] < L'1' || value[0] > L'4')
                        throw std::runtime_error("--partition must occur once and be 1..4");
                    hasPartition = true; partition = unsigned(value[0] - L'0');
                }
            } else if (!literal && arg == L"--full") {
                if (full || command != L"boot-import") throw std::runtime_error("--full is only valid once for boot-import");
                full = true;
            } else if (!literal && (arg == L"--size" || arg == L"--dest" || arg == L"--dir")) {
                if (++i == argc) throw std::runtime_error("Option requires a value");
                if (arg == L"--size") {
                    if (hasSize || (command != L"create-hard" && command != L"create-floppy")) throw std::runtime_error("Invalid or repeated --size");
                    hasSize = true; size = argv[i];
                } else {
                    if (hasDest || (arg == L"--dest" ? command != L"put" : command != L"list")) throw std::runtime_error("Invalid or repeated destination option");
                    hasDest = true; destination = argv[i];
                }
            } else if (!literal && arg == L"--raw") {
                if (raw || (command != L"create-hard" && command != L"create-floppy")) throw std::runtime_error("Invalid or repeated --raw");
                raw = true;
            } else if (!literal && arg == L"--overwrite") {
                if (overwrite || command != L"put") throw std::runtime_error("Invalid or repeated --overwrite");
                overwrite = true;
            } else {
                if (command != L"put" || (!literal && arg.rfind(L"--", 0) == 0)) throw std::runtime_error("Unknown option or unexpected argument");
                sources.emplace_back(arg);
            }
        }
        if (boot) {
            if (!hasSector) throw std::runtime_error("--sector is required");
            if (hasPartition && sector != BootSector::Partition) throw std::runtime_error("--partition is only valid for --sector partition");
            if (command == L"boot-export") exportBoot(argv[2], argv[3], sector, partition);
            else importBoot(argv[2], argv[3], sector, partition, full);
            std::cout << (command == L"boot-export" ? "Exported exactly 512 bytes.\n" : full ?
                "Imported complete 512-byte sector (including BPB/partition table); image published atomically.\n" :
                "Imported boot code, preserved BPB/partition table; image published atomically.\n");
        } else if (command == L"create-hard" || command == L"create-floppy") {
            if (!hasSize) throw std::runtime_error("--size is required");
            bool floppy = command == L"create-floppy";
            create(argv[2], floppy ? floppySize(size) : hardSize(size), floppy, raw);
            std::cout << "Created " << (raw ? "zero-filled raw image" : floppy ? "FAT12 data floppy" : "MBR / FAT16 data hard disk") << ".\n";
        } else if (command == L"boot-install-mbr") {
            installMbr(argv[2]);
            std::cout << "Installed MBR code; preserved disk identity, partition table and all other sectors.\n";
        } else if (command == L"put") {
            put(argv[2], sources, destination, overwrite);
            std::cout << "Imported all sources successfully; image published atomically.\n";
        } else if (command == L"list") {
            auto info = inspect(argv[2], destination);
            std::cout << "Image bytes: " << info.bytes << "  FAT" << info.fatBits << "  Free bytes: " << info.freeBytes << '\n';
            for (const auto& e : info.entries) std::cout << (e.directory ? "<DIR> " : "      ") << e.name << "  " << e.size << '\n';
        } else throw std::runtime_error("Unknown command; use --help");
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << '\n';
        return 1;
    }
}
