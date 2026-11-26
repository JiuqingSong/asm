#include "pc.h"
#include "image.h"
#include <fstream>
#include <iostream>
#include <stdexcept>

// 回归辅助工具：读取底盘+差分盘的实际 FAT 文件内容，不以屏幕回显代替持久化验证。
int wmain(int argc, wchar_t** argv) {
    std::filesystem::path temporary;
    try {
        if (argc != 5) throw std::runtime_error("Expected base IMG, overlay, guest file and expected ASCII content");
        asm86::Disk disk(argv[1], false, false, argv[2]);
        if (!disk.hasOverlay() || uint64_t(disk.sectors) * 512 > asm86::image::MaxHardBytes)
            throw std::runtime_error("OS FAT file verification requires an overlay and a disk no larger than 504 MiB");
        wchar_t name[MAX_PATH]{};
        auto folder = std::filesystem::temp_directory_path();
        if (!GetTempFileNameW(folder.c_str(), L"asv", 0, name)) throw std::runtime_error("Cannot create verification snapshot");
        temporary = name;
        {
            // 合并逻辑扇区到私有临时快照，复用离线 FAT 解析器；绝不修改只读底盘。
            std::ofstream out(temporary, std::ios::binary);
            if (!out) throw std::runtime_error("Cannot open verification snapshot");
            std::array<uint8_t, 512> bytes{};
            for (uint32_t lba = 0; lba < disk.sectors; ++lba) {
                if (!disk.read(lba, bytes.data())) throw std::runtime_error("Cannot read guest disk sector");
                out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
            }
            out.close();
            if (!out) throw std::runtime_error("Cannot finish verification snapshot");
        }
        auto bytes = asm86::image::read(temporary, argv[3]);

        // 比较 guest file 的内容而非键盘输入日志；错误预期必须返回非零退出码。
        std::string expected;
        for (auto p = argv[4]; *p; ++p) {
            if (*p > 127) throw std::runtime_error("Expected content must be ASCII");
            expected += char(*p);
        }
        if (expected.empty() || std::string(bytes.begin(), bytes.end()).find(expected) == std::string::npos)
            throw std::runtime_error("Persisted guest file content does not match");
        std::filesystem::remove(temporary);
        std::cout << "Persisted FAT file verified through the validated overlay\n";
        return 0;
    } catch (const std::exception& e) {
        std::error_code cleanup;
        if (!temporary.empty()) std::filesystem::remove(temporary, cleanup);
        if (cleanup) std::cerr << "Cannot remove verification snapshot: " << cleanup.message() << '\n';
        std::cerr << "ERROR: " << e.what() << '\n'; return 1;
    }
}
