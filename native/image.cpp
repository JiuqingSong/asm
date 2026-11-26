#include "image.h"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0a00
#include <windows.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <set>
#include <stdexcept>

// 离线 FAT12/FAT16 编辑先在内存副本校验再原子发布；回归另提供 FAT12/16/32 流式只读接口。
namespace asm86::image {
namespace {
using Bytes = std::vector<uint8_t>;
using Name = std::array<uint8_t, 11>;

std::runtime_error error(const char* text) {
    return std::runtime_error(std::string(text) + " (Windows error " + std::to_string(GetLastError()) + ")");
}

struct File {
    HANDLE h;
    File(const std::filesystem::path& path, DWORD access, DWORD share, DWORD disposition)
        : h(CreateFileW(path.c_str(), access, share, nullptr, disposition, FILE_ATTRIBUTE_NORMAL, nullptr)) {
        if (h == INVALID_HANDLE_VALUE) throw error("Cannot open file; check path, permissions and whether the image is mounted");
    }
    ~File() { if (h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    File(const File&) = delete;
    File& operator=(const File&) = delete;
    uint64_t size() const {
        LARGE_INTEGER n{};
        if (!GetFileSizeEx(h, &n) || n.QuadPart < 0) throw error("Cannot read file size");
        return uint64_t(n.QuadPart);
    }
    void transfer(uint8_t* data, size_t size, bool writing) {
        while (size) {
            DWORD n = DWORD(std::min<size_t>(size, 1024 * 1024)), done = 0;
            BOOL ok = writing ? WriteFile(h, data, n, &done, nullptr) : ReadFile(h, data, n, &done, nullptr);
            if (!ok || done != n) throw error(writing ? "File write failed" : "File read failed");
            data += n; size -= n;
        }
    }
};

Bytes load(File& f, uint64_t limit) {
    auto n = f.size();
    if (n > limit) throw std::runtime_error("File exceeds the supported capacity");
    Bytes data(static_cast<size_t>(n));
    f.transfer(data.data(), data.size(), false);
    return data;
}

File editableImage(const std::filesystem::path& path) {
    DWORD attrs = GetFileAttributesW(path.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) throw error("Cannot inspect image");
    if (attrs & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_REPARSE_POINT))
        throw std::runtime_error("Read-only images, symbolic links and junctions cannot be modified");
    return File(path, GENERIC_READ | GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE, OPEN_EXISTING);
}

// 原文件保持无写共享句柄，直到同目录临时文件完成刷新并原子替换。
void publish(const std::filesystem::path& path, Bytes& data, bool replace) {
    wchar_t temp[MAX_PATH]{};
    auto parent = std::filesystem::absolute(path).parent_path();
    if (!GetTempFileNameW(parent.c_str(), L"a86", 0, temp)) throw error("Cannot create staging file beside image");
    try {
        {
            File f(temp, GENERIC_WRITE | DELETE, FILE_SHARE_DELETE, OPEN_EXISTING);
            f.transfer(data.data(), data.size(), true);
            if (!FlushFileBuffers(f.h)) throw error("Cannot flush staged image");
            if (replace) {
                // POSIX 替换允许旧文件继续由锁定句柄持有，新路径一次性指向完整新文件。
                auto target = std::filesystem::absolute(path).make_preferred().wstring();
                if (target.rfind(L"\\\\?\\", 0) == 0) target = L"\\??\\" + target.substr(4);
                else target = target.rfind(L"\\\\", 0) == 0 ? L"\\??\\UNC\\" + target.substr(2) : L"\\??\\" + target;
                size_t length = target.size() * sizeof(wchar_t);
                size_t size = offsetof(FILE_RENAME_INFO, FileName) + length + sizeof(wchar_t);
                std::vector<uint64_t> storage((size + sizeof(uint64_t) - 1) / sizeof(uint64_t));
                auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
                rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
                rename->FileNameLength = DWORD(length);
                memcpy(rename->FileName, target.data(), length);
                if (!SetFileInformationByHandle(f.h, FileRenameInfoEx, rename, DWORD(size)))
                    throw error("Cannot atomically replace image (requires Windows 10+ and a supporting filesystem); original image was not changed");
            }
        }
        if (!replace && !MoveFileExW(temp, path.c_str(), MOVEFILE_WRITE_THROUGH))
            throw error("Cannot publish image; original image was not changed");
    } catch (const std::exception& e) {
        if (!DeleteFileW(temp)) {
            auto cleanup = GetLastError();
            if (cleanup != ERROR_FILE_NOT_FOUND)
                throw std::runtime_error(std::string(e.what()) + "; staging cleanup failed (Windows error " +
                    std::to_string(cleanup) + "), remove: " + std::filesystem::path(temp).u8string());
        }
        throw;
    }
}

uint16_t w(const Bytes& b, size_t o) { return uint16_t(b.at(o) | unsigned(b.at(o + 1)) << 8); }

uint32_t d(const Bytes& b, size_t o) { return w(b, o) | uint32_t(w(b, o + 2)) << 16; }

void sw(Bytes& b, size_t o, uint16_t v) { b.at(o) = uint8_t(v); b.at(o + 1) = uint8_t(v >> 8); }

void sd(Bytes& b, size_t o, uint32_t v) { sw(b, o, uint16_t(v)); sw(b, o + 2, uint16_t(v >> 16)); }

Name name83(const std::wstring& text) {
    Name result{}; result.fill(' ');
    auto dot = text.find(L'.');
    auto base = text.substr(0, dot), ext = dot == std::wstring::npos ? L"" : text.substr(dot + 1);
    if (base.empty() || base.size() > 8 || ext.size() > 3 || (dot != std::wstring::npos && ext.empty()))
        throw std::runtime_error("Names must use DOS 8.3 format (1-8 ASCII characters, optional 1-3 character extension)");
    auto copy = [&](const std::wstring& part, size_t at) {
        for (wchar_t c : part) {
            if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
            if (!((c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') ||
                std::wstring(L"$%'-_@~`!(){}^#&").find(c) != std::wstring::npos))
                throw std::runtime_error("Names must be ASCII DOS 8.3; spaces, Unicode, dots and special path characters are not allowed");
            result[at++] = uint8_t(c);
        }
    };
    copy(base, 0); copy(ext, 8);
    if (base == L"." || base == L"..") throw std::runtime_error("Relative parent components are not allowed");
    return result;
}

std::string display(const Name& n) {
    std::string a(n.begin(), n.begin() + 8), b(n.begin() + 8, n.end());
    a.erase(a.find_last_not_of(' ') + 1); b.erase(b.find_last_not_of(' ') + 1);
    return a + (b.empty() ? "" : "." + b);
}

std::vector<Name> parts(const std::wstring& path) {
    std::vector<Name> result;
    size_t start = 0;
    while (start < path.size()) {
        auto end = path.find_first_of(L"\\/", start);
        if (end == std::wstring::npos) end = path.size();
        if (end != start) result.push_back(name83(path.substr(start, end - start)));
        start = end + 1;
    }
    return result;
}

struct Volume {
    // 所有偏移为映像字节偏移；base 是分区起点，fat/root/data 是各区域起点。
    Bytes& b;
    size_t base = 0, fat = 0, root = 0, data = 0, fatBytes = 0;
    uint32_t clusters = 0, clusterBytes = 0;
    uint16_t rootEntries = 0;
    unsigned fats = 0, bits = 0;
    explicit Volume(Bytes& bytes) : b(bytes) {
        // 先区分软盘式 BPB 与 MBR 分区，再由实际簇数判定 FAT12/16，不信任卷标字符串。
        if (b.size() < 512 || b.size() % 512 || b.size() > MaxHardBytes)
            throw std::runtime_error("Image must contain 512-byte sectors and be at most 504 MiB");
        uint32_t volumeSectors = uint32_t(b.size() / 512);
        auto bpb = [&](size_t at) {
            return at + 512 <= b.size() && w(b, at + 11) == 512 && b[at + 13] &&
                w(b, at + 14) && b[at + 16] && w(b, at + 17) && w(b, at + 22);
        };
        if (!bpb(0)) {
            if (w(b, 510) != 0xaa55) throw std::runtime_error("Unformatted image: create a FAT data image or run DOS FDISK/FORMAT first");
            bool found = false;
            for (size_t o = 446; o < 510; o += 16) {
                if (b[o + 4] != 1 && b[o + 4] != 4 && b[o + 4] != 6 && b[o + 4] != 0x0e) continue;
                if (found) throw std::runtime_error("Multiple DOS partitions are not supported; select a single-partition image");
                uint32_t start = d(b, o + 8), count = d(b, o + 12);
                if (!start || !count || uint64_t(start) + count > b.size() / 512)
                    throw std::runtime_error("Invalid or out-of-bounds DOS partition");
                base = size_t(start) * 512; volumeSectors = count; found = true;
            }
            if (!found) throw std::runtime_error("No FAT12/FAT16 primary partition found (FAT32, NTFS and extended partitions are unsupported)");
        }
        if (!bpb(base)) throw std::runtime_error("Invalid FAT12/FAT16 BPB; volume may be unformatted");
        uint32_t total = w(b, base + 19);
        if (!total) total = d(b, base + 32);
        unsigned spc = b[base + 13], reserved = w(b, base + 14);
        fats = b[base + 16]; rootEntries = w(b, base + 17);
        fatBytes = size_t(w(b, base + 22)) * 512;
        if ((spc & (spc - 1)) || spc > 128 || fats > 2 || !total || total > volumeSectors)
            throw std::runtime_error("Invalid FAT geometry or volume bounds");
        fat = base + size_t(reserved) * 512;
        root = fat + fats * fatBytes;
        data = root + ((size_t(rootEntries) * 32 + 511) / 512) * 512;
        size_t end = base + size_t(total) * 512;
        if (data >= end || end > b.size()) throw std::runtime_error("FAT metadata exceeds volume");
        clusterBytes = spc * 512;
        clusters = uint32_t((end - data) / clusterBytes);
        bits = clusters < 4085 ? 12 : 16;
        if (!clusters || clusters > 65518 || (uint64_t(clusters + 2) * bits + 7) / 8 > fatBytes)
            throw std::runtime_error("Unsupported FAT cluster count or undersized allocation table");
        if (get(0) != ((bits == 12 ? 0xf00 : 0xff00) | b[base + 21]) || !eoc(get(1)))
            throw std::runtime_error("Invalid reserved FAT entries");
        for (unsigned i = 1; i < fats; ++i)
            if (!std::equal(b.begin() + fat, b.begin() + fat + fatBytes, b.begin() + fat + i * fatBytes))
                throw std::runtime_error("FAT copies disagree; repair the image in DOS before importing");
        validate();
    }
    uint32_t get(uint32_t c) const {
        // FAT12 两项共享三个字节，奇偶簇分别取高/低 12 位；FAT16 每项一个小端字。
        size_t at = fat + (bits == 16 ? c * 2 : c * 3 / 2);
        return bits == 16 ? w(b, at) : (c & 1 ? w(b, at) >> 4 : w(b, at) & 0xfff);
    }
    void set(uint32_t c, uint32_t v) {
        // 修改所有 FAT 副本，并保留相邻 FAT12 项共享的半字节。
        for (unsigned i = 0; i < fats; ++i) {
            size_t at = fat + i * fatBytes + (bits == 16 ? c * 2 : c * 3 / 2);
            if (bits == 16) sw(b, at, uint16_t(v));
            else sw(b, at, uint16_t(c & 1 ? (w(b, at) & 0xf) | (v << 4) : (w(b, at) & 0xf000) | v));
        }
    }
    bool eoc(uint32_t c) const { return c >= (bits == 16 ? 0xfff8u : 0xff8u); }
    size_t at(uint32_t c) const { return data + size_t(c - 2) * clusterBytes; }
    std::vector<uint32_t> chain(uint32_t c) const {
        // 校验界限、保留簇和环，不能让坏 FAT 把遍历变成无限循环。
        std::vector<uint32_t> out;
        std::set<uint32_t> seen;
        if (!c) return out;
        for (;;) {
            if (c < 2 || c >= clusters + 2 || c >= (bits == 16 ? 0xfff0u : 0xff0u) || !seen.insert(c).second)
                throw std::runtime_error("Invalid or cyclic FAT cluster chain");
            out.push_back(c);
            c = get(c);
            if (eoc(c)) return out;
        }
    }
    std::vector<size_t> slots(uint32_t dir) const {
        // FAT12/16 根目录大小固定且不在簇链中；子目录可以沿簇链增长。
        std::vector<size_t> out;
        if (!dir) {
            for (unsigned i = 0; i < rootEntries; ++i) out.push_back(root + i * 32);
        } else {
            for (auto c : chain(dir))
                for (unsigned i = 0; i < clusterBytes; i += 32) out.push_back(at(c) + i);
        }
        return out;
    }
    std::vector<size_t> entries(uint32_t dir) const {
        std::vector<size_t> out;
        for (auto o : slots(dir)) {
            if (!b[o]) break;
            if (b[o] == 0xe5 || (b[o + 11] & 8)) continue;
            out.push_back(o);
        }
        return out;
    }
    Name entryName(size_t o) const {
        Name n{}; std::copy_n(b.begin() + o, 11, n.begin()); return n;
    }
    size_t find(uint32_t dir, const Name& n) const {
        for (auto o : entries(dir)) if (entryName(o) == n) return o;
        return std::numeric_limits<size_t>::max();
    }
    void validate() const {
        // 全树检查交叉簇链、重复名字、目录深度及文件长度；不自动修复损坏的原盘。
        std::vector<bool> owned(clusters + 2);
        auto claim = [&](uint32_t c) {
            auto links = chain(c);
            for (auto n : links) {
                if (owned[n]) throw std::runtime_error("Cross-linked FAT entries; repair the image before importing");
                owned[n] = true;
            }
            return links.size();
        };
        std::vector<std::pair<uint32_t, unsigned>> pending{{0, 0}};
        while (!pending.empty()) {
            auto [dir, depth] = pending.back(); pending.pop_back();
            if (depth > 64) throw std::runtime_error("Directory nesting exceeds 64 levels");
            std::set<Name> names;
            for (auto o : entries(dir)) {
                if (b[o] == '.') continue;
                if (!names.insert(entryName(o)).second) throw std::runtime_error("Duplicate FAT directory names");
                if (w(b, o + 20)) throw std::runtime_error("FAT32 directory entries are unsupported");
                uint32_t c = w(b, o + 26);
                size_t length = claim(c);
                if (b[o + 11] & 16) {
                    if (!c) throw std::runtime_error("Directory has no cluster");
                    pending.push_back({c, depth + 1});
                } else if (uint64_t(length) * clusterBytes < d(b, o + 28))
                    throw std::runtime_error("File size exceeds its FAT chain");
            }
        }
    }
    std::vector<uint32_t> allocate(uint32_t n) {
        std::vector<uint32_t> out;
        for (uint32_t c = 2; c < clusters + 2 && out.size() < n; ++c) if (!get(c)) out.push_back(c);
        if (out.size() != n) throw std::runtime_error("Not enough free space in image");
        for (size_t i = 0; i < out.size(); ++i) {
            set(out[i], i + 1 < out.size() ? out[i + 1] : (bits == 16 ? 0xffff : 0xfff));
            std::fill_n(b.begin() + at(out[i]), clusterBytes, 0);
        }
        return out;
    }
    size_t freeSlot(uint32_t dir) {
        auto all = slots(dir);
        for (size_t i = 0; i < all.size(); ++i) {
            auto o = all[i];
            if (!b[o] || b[o] == 0xe5) {
                // 复用目录结束项时仍保留后续 00h 哨兵，避免旧的删除项后数据重新暴露。
                if (!b[o] && i + 1 < all.size()) b[all[i + 1]] = 0;
                return o;
            }
        }
        if (!dir) throw std::runtime_error("FAT root directory is full; use a subdirectory");
        auto links = chain(dir), added = allocate(1);
        set(links.back(), added.front());
        return at(added.front());
    }
    void writeEntry(size_t o, const Name& n, uint8_t attr, uint32_t c, uint32_t size) {
        std::fill_n(b.begin() + o, 32, 0);
        std::copy(n.begin(), n.end(), b.begin() + o);
        b[o + 11] = attr; sw(b, o + 26, uint16_t(c)); sd(b, o + 28, size);
        SYSTEMTIME t{}; GetLocalTime(&t);
        uint16_t date = uint16_t((std::clamp<unsigned>(t.wYear, 1980, 2107) - 1980) << 9 | t.wMonth << 5 | t.wDay);
        uint16_t time = uint16_t(t.wHour << 11 | t.wMinute << 5 | t.wSecond / 2);
        sw(b, o + 14, time); sw(b, o + 16, date); sw(b, o + 18, date);
        sw(b, o + 22, time); sw(b, o + 24, date);
    }
    uint32_t directory(uint32_t parent, const Name& n, bool make) {
        auto o = find(parent, n);
        if (o != std::numeric_limits<size_t>::max()) {
            if (!(b[o + 11] & 16)) throw std::runtime_error("Destination directory conflicts with a file: " + display(n));
            return w(b, o + 26);
        }
        if (!make) throw std::runtime_error("Directory not found: " + display(n));
        o = freeSlot(parent);
        uint32_t c = allocate(1).front();
        writeEntry(o, n, 16, c, 0);
        Name dot{}; dot.fill(' '); dot[0] = '.';
        writeEntry(at(c), dot, 16, c, 0); dot[1] = '.';
        writeEntry(at(c) + 32, dot, 16, parent, 0);
        return c;
    }
    uint32_t resolve(const std::wstring& path, bool make) {
        uint32_t c = 0;
        for (const auto& n : parts(path)) c = directory(c, n, make);
        return c;
    }
    void import(uint32_t dir, const std::filesystem::path& source, bool overwrite, unsigned depth = 0) {
        if (depth > 64) throw std::runtime_error("Source directory nesting exceeds 64 levels");
        auto status = std::filesystem::symlink_status(source);
        DWORD attrs = GetFileAttributesW(source.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES) throw error("Cannot inspect source");
        if ((attrs & FILE_ATTRIBUTE_REPARSE_POINT) || std::filesystem::is_symlink(status))
            throw std::runtime_error("Symbolic links and junctions are not imported");
        auto n = name83(source.filename().wstring());
        if (std::filesystem::is_directory(status)) {
            uint32_t child = directory(dir, n, true);
            std::set<Name> children;
            for (const auto& e : std::filesystem::directory_iterator(source)) {
                if (!children.insert(name83(e.path().filename().wstring())).second)
                    throw std::runtime_error("Source directory names collide after DOS uppercase conversion");
                import(child, e.path(), overwrite, depth + 1);
            }
            return;
        }
        if (!std::filesystem::is_regular_file(status)) throw std::runtime_error("Source is not a regular file or directory");
        File input(source, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING);
        auto size = input.size();
        if (size > uint64_t(clusters) * clusterBytes) throw std::runtime_error("Source file is larger than this volume");
        auto o = find(dir, n);
        if (o != std::numeric_limits<size_t>::max()) {
            if (!overwrite) throw std::runtime_error("File already exists: " + display(n) + " (use --overwrite explicitly)");
            if (b[o + 11] & (16 | 1 | 2 | 4)) throw std::runtime_error("Cannot overwrite a directory, read-only, hidden or system file: " + display(n));

            // 此工具只支持 8.3；不能覆盖带 LFN 别名的条目后留下失配的长文件名。
            auto all = slots(dir);
            auto it = std::find(all.begin(), all.end(), o);
            if (it != all.begin() && b[*(it - 1) + 11] == 0x0f && b[*(it - 1)] != 0xe5)
                throw std::runtime_error("Cannot overwrite a file with a long-name alias in this 8.3-only tool");
            for (auto c : chain(w(b, o + 26))) set(c, 0);
        } else o = freeSlot(dir);
        auto links = allocate(uint32_t((size + clusterBytes - 1) / clusterBytes));
        uint64_t remaining = size;
        for (auto c : links) {
            size_t count = size_t(std::min<uint64_t>(remaining, clusterBytes));
            input.transfer(b.data() + at(c), count, false); remaining -= count;
        }
        writeEntry(o, n, 32, links.empty() ? 0 : links.front(), uint32_t(size));
    }
};
struct Floppy { uint32_t kib; uint8_t spc, media; uint16_t roots, fat, spt, heads; };
constexpr Floppy floppies[] = {
    {160,1,0xfe,64,1,8,1}, {180,1,0xfc,64,2,9,1},
    {320,2,0xff,112,1,8,2}, {360,2,0xfd,112,2,9,2},
    {720,2,0xf9,112,3,9,2}, {1200,1,0xf9,224,7,15,2}, {1440,1,0xf0,224,9,18,2}
};

size_t bootOffset(const Bytes& b, BootSector sector, unsigned partition) {
    if (b.size() < 512 || b.size() % 512 || b.size() > MaxHardBytes)
        throw std::runtime_error("Image must contain 512-byte sectors and be at most 504 MiB");
    if (sector == BootSector::Floppy) {
        bool floppy = std::any_of(std::begin(floppies), std::end(floppies), [&](auto f) {
            if (b.size() == f.kib * 1024ULL) return true;
            size_t size = f.kib * 1024;
            const char tag[] = "[FileVersion 003]";
            return b.size() == size + 1024 && std::equal(std::begin(tag), std::end(tag) - 1, b.begin() + size) &&
                w(b, 11) == 512 && w(b, 19) == size / 512 && w(b, 24) == f.spt && w(b, 26) == f.heads;
        });
        if (!floppy) throw std::runtime_error("Selected floppy image has unsupported geometry");
        return 0;
    }
    if (b.size() % CylinderBytes)
        throw std::runtime_error("Hard image must use complete 16-head/63-sector cylinders");
    if (sector == BootSector::Mbr) return 0;
    if (partition < 1 || partition > 4) throw std::runtime_error("Primary partition slot must be 1..4");
    if (w(b, 510) != 0xaa55) throw std::runtime_error("MBR has no 55AA signature");
    size_t entry = 446 + (partition - 1) * 16;
    uint8_t type = b[entry + 4];
    if (type != 1 && type != 4 && type != 6 && type != 0x0e)
        throw std::runtime_error("Selected primary partition is not FAT12/FAT16");
    uint32_t start = d(b, entry + 8), count = d(b, entry + 12);
    if (!start || !count || uint64_t(start) + count > b.size() / 512)
        throw std::runtime_error("Selected partition is empty or outside image bounds");
    return size_t(start) * 512;
}

size_t bootHeader(const Bytes& b) {
    unsigned spc = b[13], fats = b[16], roots = w(b, 17), fat = w(b, 22), reserved = w(b, 14);
    uint32_t total = w(b, 19) ? w(b, 19) : d(b, 32);
    uint64_t metadata = reserved + uint64_t(fats) * fat + (roots * 32 + 511) / 512;
    if (w(b, 11) != 512 || !spc || (spc & (spc - 1)) || spc > 128 ||
        !reserved || !fats || fats > 2 || !roots || !fat || total <= metadata)
        throw std::runtime_error("Code-only volume import requires valid FAT12/FAT16 BPBs; use --full only for intentional sector replacement");
    auto clusters = (total - metadata) / spc;
    if (!clusters || clusters > 65518 || (uint64_t(clusters + 2) * (clusters < 4085 ? 12 : 16) + 7) / 8 > uint64_t(fat) * 512)
        throw std::runtime_error("Code-only volume import does not support this FAT layout");
    size_t header = b[38] == 0x28 || b[38] == 0x29 ? 62 : 36;
    int entry = b[0] == 0xeb && b[2] == 0x90 ? 2 + int(int8_t(b[1]))
        : b[0] == 0xe9 ? 3 + int(int16_t(w(b, 1))) : -1;
    if (entry < int(header) || entry >= 510)
        throw std::runtime_error("Unsupported boot jump or BPB layout; code must start after the preserved header");
    return header;
}

void nonboot(Bytes& b, size_t at) {
    // 数据盘不附带 DOS 系统文件；这段自有 16 位代码仅输出提示并等待换引导盘。
    const uint8_t code[] = {
        0xfa,                // CLI：初始化栈时屏蔽中断。
        0x31,0xc0,           // XOR AX,AX。
        0x8e,0xd8,           // MOV DS,AX：提示字符串采用绝对 0000:7C80。
        0x8e,0xd0,           // MOV SS,AX。
        0xbc,0x00,0x7c,      // MOV SP,7C00h：设置引导栈。
        0xfb,                // STI：恢复中断。
        0xbe,0x80,0x7c,      // MOV SI,7C80h：提示文本地址。
        0xac,                // LODSB：取下一字符。
        0x84,0xc0,           // TEST AL,AL：检查零结束。
        0x74,0x09,           // JZ 等待键盘。
        0xb4,0x0e,           // MOV AH,0Eh：BIOS 电传打字输出。
        0xbb,0x07,0x00,      // MOV BX,0007h：第 0 页、灰字黑底。
        0xcd,0x10,           // INT 10h：输出 AL。
        0xeb,0xf2,           // JMP 字符循环。
        0x31,0xc0,           // XOR AX,AX：INT 16h/AH=0 等待按键。
        0xcd,0x16,           // INT 16h。
        0xcd,0x19,           // INT 19h：重新引导。
        0xeb,0xfe            // JMP $：若 BIOS 意外返回，留在此处。
    };

    // EB 3C 是从扇区起点跳到偏移 3Eh 的短 JMP，90 是 NOP，跳过 BPB。
    b[at] = 0xeb; b[at + 1] = 0x3c; b[at + 2] = 0x90;
    std::copy(std::begin(code), std::end(code), b.begin() + at + 62);
    const char message[] = "Non-system data disk. Insert a DOS boot disk and press a key.\r\n";
    std::copy(std::begin(message), std::end(message), b.begin() + at + 128);
    sw(b, at + 510, 0xaa55);
}

void mbrCode(Bytes& b) {
    // 自有 8088 MBR：移到 0000:0600 后选唯一活动分区，将 LBA 按 16/63 几何转成 CHS，
    // 再将分区 VBR 读到 0000:7C00。跳转和消息地址固定，不能改动字节数。
    const uint8_t code[] = {
        0xfa,0x31,0xc0,       // CLI / XOR AX,AX：原子设置段/栈。
        0x8e,0xd8,0x8e,0xc0, // MOV DS,AX / MOV ES,AX：复制源/目标均在第零段。
        0x8e,0xd0,           // MOV SS,AX。
        0xbc,0x00,0x7c,      // MOV SP,7C00h。
        0xfc,0xfb,           // CLD / STI：向前复制，恢复中断。
        0xbe,0x00,0x7c,      // MOV SI,7C00h：原 MBR。
        0xbf,0x00,0x06,      // MOV DI,0600h：重定位目标。
        0xb9,0x00,0x01,      // MOV CX,0100h：512 字节=256 字。
        0xf3,0xa5,           // REP MOVSW：复制 MBR 和分区表。
        0xea,0x1e,0x06,0x00,0x00, // JMP FAR 0000:061Eh：开始执行重定位副本。

        0x88,0x16,0xb0,0x07, // MOV [07B0h],DL：保存 BIOS 引导盘号。
        0xbd,0xbe,0x07,      // MOV BP,07BEh：重定位后分区表（0600h+446）。
        0xb9,0x04,0x00,      // MOV CX,4：四个主分区槽。
        0x31,0xf6,           // XOR SI,SI：尚未找到活动分区。
        0x80,0x7e,0x00,0x00, // CMP BYTE [BP],0：非活动槽。
        0x75,0x03,           // JNE 检查活动标志。
        0xe9,0x12,0x00,      // JMP 下一分区槽。
        0x80,0x7e,0x00,0x80, // CMP BYTE [BP],80h：活动标志必须恰好为 80h。
        0x74,0x03,           // JE 检查是否重复活动。
        0xe9,0x7b,0x00,      // JMP 错误输出。
        0x85,0xf6,0x74,0x03, // TEST SI,SI / JE 保存活动槽。
        0xe9,0x74,0x00,      // JMP 错误输出：发现第二个活动分区。
        0x89,0xee,           // MOV SI,BP：记住活动分区。
        0x83,0xc5,0x10,      // ADD BP,10h：分区项长 16 字节。
        0xe2,0xe0,           // LOOP 扫描分区。
        0x85,0xf6,0x75,0x03, // TEST SI,SI / JNE 检查分区类型。
        0xe9,0x66,0x00,      // JMP 错误输出：没有活动分区。
        0x80,0x7c,0x04,0x00, // CMP BYTE [SI+4],0：类型为零是空分区。
        0x75,0x03,           // JNE 读取起始 LBA。
        0xe9,0x5d,0x00,      // JMP 错误输出。

        0x8b,0x44,0x08,      // MOV AX,[SI+8]：LBA 低字。
        0x8b,0x54,0x0a,      // MOV DX,[SI+0Ah]：LBA 高字，合成 DX:AX。
        0x89,0xc3,0x09,0xd3, // MOV BX,AX / OR BX,DX：起始 LBA 不能为零。
        0x75,0x03,           // JNE 检查 LBA 范围。
        0xe9,0x4e,0x00,      // JMP 错误输出。
        0x83,0xfa,0x0f,      // CMP DX,0Fh：限制 DIV 的商与传统磁盘地址范围。
        0x76,0x03,           // JBE 执行 CHS 转换。
        0xe9,0x46,0x00,      // JMP 错误输出。
        0xbb,0x3f,0x00,      // MOV BX,63：每道扇区数。
        0xf7,0xf3,           // DIV BX：DX:AX/63，AX 为道号，DX 为扇区零基余数。
        0x89,0xd1,0x41,      // MOV CX,DX / INC CX：CL 为 1 基扇区号。
        0x31,0xd2,           // XOR DX,DX：下一次除法使用 16 位道号。
        0xbb,0x10,0x00,      // MOV BX,16：磁头数。
        0xf7,0xf3,           // DIV BX：AX 为柱面，DX 为磁头。
        0x3d,0xff,0x03,      // CMP AX,03FFh：柱面必须 <=1023。
        0x76,0x03,           // JBE 编码 INT 13h 参数。
        0xe9,0x2f,0x00,      // JMP 错误输出。
        0x88,0xd6,           // MOV DH,DL：磁头号移到 DH。
        0x8a,0x16,0xb0,0x07, // MOV DL,[07B0h]：恢复盘号。
        0x88,0xc5,           // MOV CH,AL：柱面低 8 位。
        0xd0,0xcc,0xd0,0xcc, // ROR AH,1 两次：柱面高 2 位移到 CL 高位位置。
        0x08,0xe1,           // OR CL,AH：合成柱面/扇区字段。
        0xbb,0x00,0x7c,      // MOV BX,7C00h：ES:BX 为 VBR 缓冲区。
        0xb8,0x01,0x02,      // MOV AX,0201h：AH=读扇区，AL=1。
        0xcd,0x13,           // INT 13h：读取分区引导扇区。
        0x73,0x03,           // JNC 检查签名。
        0xe9,0x14,0x00,      // JMP 错误输出：BIOS 读失败。
        0x81,0x3e,0xfe,0x7d,0x55,0xaa, // CMP WORD [7DFEh],AA55h：校验 VBR 签名。
        0x74,0x03,           // JE 启动分区。
        0xe9,0x09,0x00,      // JMP 错误输出。
        0x8a,0x16,0xb0,0x07, // MOV DL,[07B0h]：向 VBR 传递原盘号。
        0xea,0x00,0x7c,0x00,0x00, // JMP FAR 0000:7C00：交出控制权。

        0xbe,0xd0,0x06,      // MOV SI,06D0h：重定位后的错误字符串。
        0xbb,0x07,0x00,      // MOV BX,7：第零显示页、文本属性。
        0xac,0x84,0xc0,      // LODSB / TEST AL,AL：逐字符读取到零结束。
        0x75,0x03,           // JNE 输出字符。
        0xe9,0x07,0x00,      // JMP 停机。
        0xb4,0x0e,           // MOV AH,0Eh：电传打字功能。
        0xcd,0x10,           // INT 10h。
        0xe9,0xf1,0xff,      // JMP 字符循环。
        0xfa,0xf4,0xeb,0xfd, // CLI / HLT / JMP HLT：错误时不继续执行磁盘数据。
    };
    const char message[] = "Cannot load active partition boot sector.\r\n";
    std::fill_n(b.begin(), 440, 0);
    std::copy(std::begin(code), std::end(code), b.begin());
    std::copy(std::begin(message), std::end(message), b.begin() + sizeof(code));
    sw(b, 510, 0xaa55);
}

Bytes formatted(uint64_t size, bool floppy) {
    // 软盘使用固定 FAT12 布局；硬盘在 LBA63 建 FAT16 卷，迭代求 FAT 大小及每簇扇区数。
    Bytes b(static_cast<size_t>(size));
    uint32_t total = uint32_t(size / 512), base = floppy ? 0 : 63;
    uint16_t roots = 512, fatSectors = 0, spc = 1, spt = 63, heads = 16;
    uint8_t media = 0xf8;
    if (floppy) {
        const auto& f = *std::find_if(std::begin(floppies), std::end(floppies), [&](auto v) { return v.kib * 1024ULL == size; });
        roots = f.roots; fatSectors = f.fat; spc = f.spc; spt = f.spt; heads = f.heads; media = f.media;
    } else {
        spc = size <= 16 * 1024 * 1024 ? 2 : size <= 128 * 1024 * 1024 ? 4 : size <= 256 * 1024 * 1024 ? 8 : 16;
        for (;;) {
            fatSectors = 1;
            for (;;) {
                uint32_t count = (total - base - 1 - 2 * fatSectors - roots / 16) / spc;
                uint16_t needed = uint16_t(((count + 2) * 2 + 511) / 512);
                if (needed <= fatSectors) break;
                fatSectors = needed;
            }
            uint32_t count = (total - base - 1 - 2 * fatSectors - roots / 16) / spc;
            if (count >= 4085 && count <= 65518) break;
            if (count < 4085 || spc >= 128) throw std::runtime_error("Hard disk is too small for FAT16; use at least 10 cylinders (4.921875 MiB) or create a raw image");
            spc *= 2;
        }
        mbrCode(b);
        auto chs = [&](size_t at, uint32_t lba) {
            uint32_t c = lba / (16 * 63);
            b[at] = uint8_t(lba / 63 % 16);
            b[at + 1] = uint8_t((lba % 63 + 1) | ((c >> 2) & 0xc0)); b[at + 2] = uint8_t(c);
        };
        b[446] = 0x80; chs(447, base); b[450] = total - base < 65536 ? 4 : 6; chs(451, total - 1);
        sd(b, 454, base); sd(b, 458, total - base);
    }
    size_t at = size_t(base) * 512;
    nonboot(b, at);
    const char oem[] = "ASM86   "; std::copy_n(oem, 8, b.begin() + at + 3);
    sw(b, at + 11, 512); b[at + 13] = uint8_t(spc); sw(b, at + 14, 1);
    b[at + 16] = 2; sw(b, at + 17, roots);
    if (total - base <= 65535) sw(b, at + 19, uint16_t(total - base)); else sd(b, at + 32, total - base);
    b[at + 21] = media; sw(b, at + 22, fatSectors); sw(b, at + 24, spt); sw(b, at + 26, heads);
    sd(b, at + 28, base); b[at + 36] = floppy ? 0 : 0x80; b[at + 38] = 0x29;
    sd(b, at + 39, GetTickCount());
    const char label[] = "NO NAME    "; std::copy_n(label, 11, b.begin() + at + 43);
    const char* type = floppy ? "FAT12   " : "FAT16   "; std::copy_n(type, 8, b.begin() + at + 54);
    for (unsigned i = 0; i < 2; ++i) {
        size_t f = at + (1 + i * fatSectors) * 512;
        b[f] = media; b[f + 1] = 0xff; b[f + 2] = 0xff; if (!floppy) b[f + 3] = 0xff;
    }
    Volume verify(b);
    return b;
}
}

uint64_t hardSize(const std::wstring& text) {
    // 精确十进制解析：每柱面 0.4921875 MiB，避免浮点舍入创建不完整柱面。
    uint64_t scaled = 0, scale = 1; bool dot = false; unsigned digits = 0;
    if (text.empty()) throw std::runtime_error("Missing hard disk size in MiB");
    for (wchar_t c : text) {
        if (c == L'.' && !dot) { dot = true; continue; }
        if (c < L'0' || c > L'9' || ++digits > 10) throw std::runtime_error("Hard size must be an unsigned decimal MiB value");
        scaled = scaled * 10 + unsigned(c - L'0'); if (dot) scale *= 10;
    }
    if (!digits || text.front() == L'.' || text.back() == L'.' || scaled * 1024 * 1024 % scale)
        throw std::runtime_error("Hard size must resolve to whole bytes");
    uint64_t bytes = scaled * 1024 * 1024 / scale;
    if (!bytes || bytes > MaxHardBytes || bytes % CylinderBytes)
        throw std::runtime_error("Hard size must use whole 16-head/63-sector cylinders and be at most 504 MiB (e.g. 31.5, 63, 126, 252, 504)");
    return bytes;
}

uint64_t floppySize(const std::wstring& text) {
    for (const auto& f : floppies) if (text == std::to_wstring(f.kib)) return f.kib * 1024ULL;
    throw std::runtime_error("Floppy size in KiB must be 160, 180, 320, 360, 720, 1200 or 1440");
}

void create(const std::filesystem::path& path, uint64_t bytes, bool floppy, bool raw) {
    bool valid = floppy ? std::any_of(std::begin(floppies), std::end(floppies), [&](auto f) { return f.kib * 1024ULL == bytes; })
        : bytes && bytes <= MaxHardBytes && bytes % CylinderBytes == 0;
    if (!valid) throw std::runtime_error("Unsupported disk capacity or geometry");
    if (std::filesystem::exists(path)) throw std::runtime_error("Destination already exists; creation never overwrites files");
    Bytes b = raw ? Bytes(static_cast<size_t>(bytes)) : formatted(bytes, floppy);
    publish(path, b, false);
}

void put(const std::filesystem::path& path, const std::vector<std::filesystem::path>& sources,
         const std::wstring& destination, bool overwrite) {
    if (sources.empty()) throw std::runtime_error("At least one source file or directory is required");
    auto original = editableImage(path);
    Bytes b = load(original, MaxHardBytes);
    Volume volume(b);
    uint32_t dir = volume.resolve(destination, true);
    std::set<Name> names;
    for (const auto& source : sources) {
        auto absolute = std::filesystem::absolute(source).lexically_normal();
        if (std::filesystem::equivalent(path, absolute)) throw std::runtime_error("Cannot import the image into itself");
        if (!names.insert(name83(absolute.filename().wstring())).second)
            throw std::runtime_error("Source names collide after DOS uppercase conversion");
        volume.import(dir, absolute, overwrite);
    }
    volume.validate();
    publish(path, b, true);
}

void exportBoot(const std::filesystem::path& path, const std::filesystem::path& output,
                BootSector sector, unsigned partition) {
    if (std::filesystem::exists(output)) throw std::runtime_error("Export destination already exists; export never overwrites files");
    File input(path, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING);
    auto b = load(input, MaxHardBytes);
    auto offset = bootOffset(b, sector, partition);
    Bytes boot(b.begin() + offset, b.begin() + offset + 512);
    publish(output, boot, false);
}

void installMbr(const std::filesystem::path& path) {
    auto original = editableImage(path);
    auto b = load(original, MaxHardBytes);
    bootOffset(b, BootSector::Mbr, 1);
    unsigned active = 0;
    for (unsigned slot = 1; slot <= 4; ++slot) {
        auto flag = b[446 + (slot - 1) * 16];
        if (!flag) continue;
        if (flag != 0x80 || active) throw std::runtime_error("Invalid or multiple active partitions; repair the partition table first");
        bootOffset(b, BootSector::Partition, slot); active = slot;
    }
    if (!active) throw std::runtime_error("No active FAT primary partition; mark the intended partition active in DOS FDISK first");
    mbrCode(b);
    publish(path, b, true);
}

void importBoot(const std::filesystem::path& path, const std::filesystem::path& input,
                BootSector sector, unsigned partition, bool full) {
    // 默认只移植代码：MBR 保留磁盘标识/分区表，VBR 保留原 BPB；full 是显式整扇区替换。
    Bytes source;
    {
        File file(input, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING);
        if (file.size() != 512) throw std::runtime_error("Boot sector input must be exactly 512 bytes");
        source = load(file, 512);
    }
    auto original = editableImage(path);
    auto b = load(original, MaxHardBytes);
    auto offset = bootOffset(b, sector, partition);
    if (full) std::copy(source.begin(), source.end(), b.begin() + offset);
    else {
        if (w(source, 510) != 0xaa55) throw std::runtime_error("Code-only input must have a 55AA boot signature");
        if (sector == BootSector::Mbr) {
            std::copy_n(source.begin(), 440, b.begin());
        } else {
            Bytes target(b.begin() + offset, b.begin() + offset + 512);
            size_t header = bootHeader(target);
            if (header != bootHeader(source))
                throw std::runtime_error("Source and target BPB header formats differ; code-only import cannot safely merge them");
            std::copy_n(source.begin(), 3, b.begin() + offset);
            std::copy(source.begin() + header, source.begin() + 510, b.begin() + offset + header);
        }
        b[offset + 510] = source[510]; b[offset + 511] = source[511];
    }
    publish(path, b, true);
}

Info inspect(const std::filesystem::path& path, const std::wstring& directory) {
    File input(path, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING);
    Bytes b = load(input, MaxHardBytes);
    Volume v(b);
    Info info{b.size(), 0, v.bits, {}};
    for (uint32_t c = 2; c < v.clusters + 2; ++c) if (!v.get(c)) info.freeBytes += v.clusterBytes;
    for (auto o : v.entries(v.resolve(directory, false))) {
        if (b[o] == '.') continue;
        info.entries.push_back({display(v.entryName(o)), bool(b[o + 11] & 16), d(b, o + 28)});
    }
    return info;
}

Bytes read(const std::filesystem::path& path, const std::wstring& file) {
    File input(path, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING);
    Bytes b = load(input, MaxHardBytes);
    Volume v(b);
    auto names = parts(file);
    if (names.empty()) throw std::runtime_error("Missing file name");
    uint32_t dir = 0;
    for (size_t i = 0; i + 1 < names.size(); ++i) dir = v.directory(dir, names[i], false);
    auto o = v.find(dir, names.back());
    if (o == std::numeric_limits<size_t>::max() || (b[o + 11] & 16)) throw std::runtime_error("File not found");
    Bytes result(d(b, o + 28)); size_t position = 0;
    for (auto c : v.chain(w(b, o + 26))) {
        size_t count = std::min<size_t>(v.clusterBytes, result.size() - position);
        std::copy_n(b.begin() + v.at(c), count, result.begin() + position); position += count;
    }
    return result;
}

Bytes readSectors(uint32_t sectors, const std::function<bool(uint32_t, uint8_t*)>& reader,
                  const std::wstring& file, uint32_t maxFileBytes) {
    auto sector = [&](uint64_t lba) {
        Bytes bytes(512);
        if (lba >= sectors) throw std::runtime_error("FAT sector is outside the disk");
        if (!reader(uint32_t(lba), bytes.data())) throw std::runtime_error("Cannot read FAT disk sector");
        return bytes;
    };
    auto boot = sector(0);
    auto isBpb = [&](const Bytes& b) {
        return w(b, 510) == 0xaa55 && w(b, 11) == 512 && b[13] && w(b, 14) &&
            b[16] && (w(b, 22) || (!w(b, 17) && d(b, 36)));
    };
    uint32_t base = 0, volumeSectors = sectors;
    if (!isBpb(boot)) {
        if (w(boot, 510) != 0xaa55) throw std::runtime_error("Unformatted disk");
        bool found = false;
        for (unsigned at = 446; at < 510; at += 16) {
            auto type = boot[at + 4];
            if (type != 1 && type != 4 && type != 6 && type != 0x0e && type != 0x0b && type != 0x0c) continue;
            if (found) throw std::runtime_error("Multiple FAT primary partitions are not supported");
            base = d(boot, at + 8); volumeSectors = d(boot, at + 12);
            if (!base || !volumeSectors || uint64_t(base) + volumeSectors > sectors)
                throw std::runtime_error("Invalid or out-of-bounds FAT partition");
            found = true;
        }
        if (!found) throw std::runtime_error("No FAT12/FAT16/FAT32 primary partition found");
        boot = sector(base);
    }
    if (!isBpb(boot)) throw std::runtime_error("Invalid FAT BPB");
    auto total = w(boot, 19) ? uint32_t(w(boot, 19)) : d(boot, 32);
    unsigned spc = boot[13], fats = boot[16], rootEntries = w(boot, 17);
    uint32_t fatSectors = w(boot, 22) ? uint32_t(w(boot, 22)) : d(boot, 36);
    uint64_t rootSectors = (uint64_t(rootEntries) * 32 + 511) / 512;
    uint64_t metadata = w(boot, 14) + uint64_t(fats) * fatSectors + rootSectors;
    if ((spc & (spc - 1)) || spc > 128 || fats > 2 || !total || total > volumeSectors || metadata >= total)
        throw std::runtime_error("Invalid FAT geometry or volume bounds");
    uint32_t clusters = uint32_t((total - metadata) / spc);
    unsigned bits = clusters < 4085 ? 12 : clusters < 65525 ? 16 : 32;
    uint32_t reservedCluster = bits == 12 ? 0xff0 : bits == 16 ? 0xfff0 : 0xffffff0;
    if (!clusters || uint64_t(clusters) + 2 > reservedCluster ||
        (uint64_t(clusters + 2) * bits + 7) / 8 > uint64_t(fatSectors) * 512 ||
        (bits == 32 ? w(boot, 22) || rootEntries || w(boot, 42) : !w(boot, 22) || !rootEntries))
        throw std::runtime_error("Unsupported FAT layout or undersized allocation table");
    uint64_t fat = uint64_t(base) + w(boot, 14);
    uint64_t root = fat + uint64_t(fats) * fatSectors, data = uint64_t(base) + metadata;
    bool mirrored = bits != 32 || !(w(boot, 40) & 0x80);
    unsigned activeFat = mirrored ? 0 : w(boot, 40) & 15;
    if (activeFat >= fats) throw std::runtime_error("Invalid active FAT index");
    auto get = [&](uint32_t cluster) {
        // FAT12 项可能跨扇区；FAT32 屏蔽高四位，并遵守活动 FAT/镜像标志。
        uint64_t offset = bits == 12 ? uint64_t(cluster) * 3 / 2 : uint64_t(cluster) * (bits / 8);
        auto value = [&](unsigned copy) {
            auto bytes = sector(fat + uint64_t(copy) * fatSectors + offset / 512);
            unsigned at = unsigned(offset % 512);
            if (bits == 12 && at == 511) {
                auto next = sector(fat + uint64_t(copy) * fatSectors + offset / 512 + 1);
                bytes.push_back(next[0]);
            }
            return bits == 32 ? d(bytes, at) & 0xfffffff : bits == 16 ? uint32_t(w(bytes, at))
                : cluster & 1 ? uint32_t(w(bytes, at) >> 4) : uint32_t(w(bytes, at) & 0xfff);
        };
        auto result = value(activeFat);
        if (mirrored) for (unsigned copy = 1; copy < fats; ++copy)
            if (value(copy) != result) throw std::runtime_error("FAT copies disagree on the requested chain");
        return result;
    };
    auto eoc = [&](uint32_t cluster) { return cluster >= reservedCluster + 8; };
    auto valid = [&](uint32_t cluster) {
        if (cluster < 2 || cluster >= clusters + 2 || cluster >= reservedCluster)
            throw std::runtime_error("Invalid FAT cluster chain");
    };
    auto mediaPrefix = bits == 12 ? 0xf00u : bits == 16 ? 0xff00u : 0xfffff00u;
    auto statusMask = bits == 12 ? 0xfffu : bits == 16 ? 0x3fffu : 0x3ffffffu;
    // FAT16/32 第二项包含清洁关机和 I/O 错误标志，不能把这些状态位当作簇链损坏。
    if (get(0) != (mediaPrefix | boot[21]) || (get(1) & statusMask) < (statusMask - 7))
        throw std::runtime_error("Invalid reserved FAT entries");
    uint32_t directory = bits == 32 ? d(boot, 44) & 0xfffffff : 0;
    if (bits == 32) valid(directory);
    auto names = parts(file);
    if (names.empty()) throw std::runtime_error("Missing file name");
    Bytes entry;
    for (size_t component = 0; component < names.size(); ++component) {
        entry.clear();
        std::set<uint32_t> seen;
        uint32_t cluster = directory;
        bool ended = false;
        do {
            if (directory) {
                valid(cluster);
                if (!seen.insert(cluster).second) throw std::runtime_error("Cyclic FAT directory chain");
            }
            uint64_t first = directory ? data + uint64_t(cluster - 2) * spc : root;
            unsigned count = directory ? spc : unsigned(rootSectors);
            for (unsigned s = 0; s < count && entry.empty() && !ended; ++s) {
                auto bytes = sector(first + s);
                for (unsigned at = 0; at < 512; at += 32) {
                    if (!directory && uint64_t(s) * 16 + at / 32 >= rootEntries) { ended = true; break; }
                    if (!bytes[at]) { ended = true; break; }
                    if (bytes[at] == 0xe5 || (bytes[at + 11] & 8)) continue;
                    if (std::equal(names[component].begin(), names[component].end(), bytes.begin() + at)) {
                        entry.assign(bytes.begin() + at, bytes.begin() + at + 32); break;
                    }
                }
            }
            if (!directory || ended || !entry.empty()) break;
            cluster = get(cluster);
        } while (!eoc(cluster));
        if (entry.empty()) throw std::runtime_error("File not found: " + display(names[component]));
        auto firstCluster = uint32_t(w(entry, 26));
        if (bits == 32) firstCluster |= uint32_t(w(entry, 20) & 0xfff) << 16;
        else if (w(entry, 20)) throw std::runtime_error("Invalid FAT12/FAT16 directory entry");
        if (component + 1 < names.size()) {
            if (!(entry[11] & 16)) throw std::runtime_error("Path component is not a directory");
            valid(firstCluster); directory = firstCluster;
        } else directory = firstCluster;
    }
    if (entry[11] & 16) throw std::runtime_error("Requested file is a directory");
    uint32_t length = d(entry, 28);
    if (length > maxFileBytes || length > uint64_t(clusters) * spc * 512)
        throw std::runtime_error("File exceeds the verification limit or volume capacity");
    if (!length && !directory) return {};
    Bytes result(length);
    size_t position = 0;
    std::set<uint32_t> seen;
    for (uint32_t cluster = directory;;) {
        valid(cluster);
        if (!seen.insert(cluster).second) throw std::runtime_error("Cyclic FAT file chain");
        for (unsigned s = 0; s < spc && position < length; ++s) {
            auto bytes = sector(data + uint64_t(cluster - 2) * spc + s);
            auto count = std::min<size_t>(512, length - position);
            std::copy_n(bytes.begin(), count, result.begin() + position); position += count;
        }
        auto next = get(cluster);
        if (eoc(next)) {
            if (position != length) throw std::runtime_error("Truncated FAT file chain");
            return result;
        }
        if (position == length) throw std::runtime_error("FAT file chain exceeds its declared size");
        cluster = next;
    }
}
}
