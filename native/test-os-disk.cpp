#include "pc.h"
#include "image.h"
#include <iostream>
#include <stdexcept>

// 回归辅助工具：读取底盘+差分盘的实际 FAT 文件内容，不以屏幕回显代替持久化验证。
int wmain(int argc, wchar_t** argv) {
    try {
        bool executables = argc >= 5 && std::wstring(argv[3]) == L"--executables";
        if (!executables && argc != 5) throw std::runtime_error("Expected base IMG, overlay, guest file and expected ASCII content");
        asm86::Disk disk(argv[1], false, false, argv[2]);
        if (!disk.hasOverlay()) throw std::runtime_error("OS FAT file verification requires an overlay");
        if (executables) {
            for (int i = 4; i < argc; ++i) {
                auto bytes = asm86::image::readSectors(disk.sectors,
                    [&](uint32_t lba, uint8_t* data) { return disk.read(lba, data); }, argv[i]);
                if (bytes.size() < 2 || bytes[0] != 'M' || bytes[1] != 'Z')
                    throw std::runtime_error("Required guest executable has no MZ header");
            }
            std::cout << "Required guest executables verified through the validated overlay\n";
            return 0;
        }
        auto bytes = asm86::image::readSectors(disk.sectors,
            [&](uint32_t lba, uint8_t* data) { return disk.read(lba, data); }, argv[3]);

        // 比较 guest file 的内容而非键盘输入日志；错误预期必须返回非零退出码。
        std::string expected;
        for (auto p = argv[4]; *p; ++p) {
            if (*p > 127) throw std::runtime_error("Expected content must be ASCII");
            expected += char(*p);
        }
        auto actual = std::string(bytes.begin(), bytes.end());
        if (expected.empty() || (actual != expected && actual != expected + "\r\n"))
            throw std::runtime_error("Persisted guest file content does not match");
        std::cout << "Persisted FAT file verified through the validated overlay; sectors read=" << disk.readSectors << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "ERROR: " << e.what() << '\n'; return 1;
    }
}
