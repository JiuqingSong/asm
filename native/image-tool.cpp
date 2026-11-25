#include "image.h"
#include <iostream>
#include <stdexcept>

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
                "FAT data disks are formatted but NOT bootable DOS disks. --raw creates only zeros.\n"
                "Import requires FAT12/FAT16 and ASCII DOS 8.3 source names; folders are recursive.\n"
                "Unmount the image first. Existing images/files are never overwritten implicitly.\n";
            return 0;
        }
        if (argc < 3) throw std::runtime_error("Missing command or image path; use --help");
        std::wstring command = argv[1], size, destination = L"\\";
        bool raw = false, overwrite = false;
        std::vector<std::filesystem::path> sources;
        bool literal = false, hasSize = false, hasDest = false;
        for (int i = 3; i < argc; ++i) {
            std::wstring arg = argv[i];
            if (!literal && arg == L"--") { literal = true; continue; }
            if (!literal && (arg == L"--size" || arg == L"--dest" || arg == L"--dir")) {
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
        if (command == L"create-hard" || command == L"create-floppy") {
            if (!hasSize) throw std::runtime_error("--size is required");
            bool floppy = command == L"create-floppy";
            create(argv[2], floppy ? floppySize(size) : hardSize(size), floppy, raw);
            std::cout << "Created " << (raw ? "zero-filled raw image" : floppy ? "FAT12 data floppy" : "MBR / FAT16 data hard disk") << ".\n";
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
