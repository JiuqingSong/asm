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
// Hold the original open without write sharing until the atomic rename completes.
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
                // POSIX replacement keeps the locked old file alive for its open handle.
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
    Bytes& b;
    size_t base = 0, fat = 0, root = 0, data = 0, fatBytes = 0;
    uint32_t clusters = 0, clusterBytes = 0;
    uint16_t rootEntries = 0;
    unsigned fats = 0, bits = 0;
    explicit Volume(Bytes& bytes) : b(bytes) {
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
        size_t at = fat + (bits == 16 ? c * 2 : c * 3 / 2);
        return bits == 16 ? w(b, at) : (c & 1 ? w(b, at) >> 4 : w(b, at) & 0xfff);
    }
    void set(uint32_t c, uint32_t v) {
        for (unsigned i = 0; i < fats; ++i) {
            size_t at = fat + i * fatBytes + (bits == 16 ? c * 2 : c * 3 / 2);
            if (bits == 16) sw(b, at, uint16_t(v));
            else sw(b, at, uint16_t(c & 1 ? (w(b, at) & 0xf) | (v << 4) : (w(b, at) & 0xf000) | v));
        }
    }
    bool eoc(uint32_t c) const { return c >= (bits == 16 ? 0xfff8u : 0xff8u); }
    size_t at(uint32_t c) const { return data + size_t(c - 2) * clusterBytes; }
    std::vector<uint32_t> chain(uint32_t c) const {
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
                // Preserve the end-of-directory sentinel if a deleted stale entry follows it.
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
            // Avoid leaving long-name aliases attached to newly replaced 8.3 entries.
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
    // Data disks deliberately contain no DOS system files or borrowed DOS boot code.
    const uint8_t code[] = {0xfa,0x31,0xc0,0x8e,0xd8,0x8e,0xd0,0xbc,0x00,0x7c,0xfb,
        0xbe,0x80,0x7c,0xac,0x84,0xc0,0x74,0x09,0xb4,0x0e,0xbb,0x07,0x00,0xcd,0x10,0xeb,0xf2,
        0x31,0xc0,0xcd,0x16,0xcd,0x19,0xeb,0xfe};
    b[at] = 0xeb; b[at + 1] = 0x3c; b[at + 2] = 0x90;
    std::copy(std::begin(code), std::end(code), b.begin() + at + 62);
    const char message[] = "Non-system data disk. Insert a DOS boot disk and press a key.\r\n";
    std::copy(std::begin(message), std::end(message), b.begin() + at + 128);
    sw(b, at + 510, 0xaa55);
}
void mbrCode(Bytes& b) {
    // Relocate to 0000:0600, select one active entry, derive 16/63 CHS from its LBA,
    // then read and jump to its VBR at 0000:7C00. These are self-authored 8088 instructions.
    const uint8_t code[] = {
        0xfa,0x31,0xc0,0x8e,0xd8,0x8e,0xc0,0x8e,0xd0,0xbc,0x00,0x7c,0xfc,0xfb,0xbe,0x00,
        0x7c,0xbf,0x00,0x06,0xb9,0x00,0x01,0xf3,0xa5,0xea,0x1e,0x06,0x00,0x00,0x88,0x16,
        0xb0,0x07,0xbd,0xbe,0x07,0xb9,0x04,0x00,0x31,0xf6,0x80,0x7e,0x00,0x00,0x75,0x03,
        0xe9,0x12,0x00,0x80,0x7e,0x00,0x80,0x74,0x03,0xe9,0x7b,0x00,0x85,0xf6,0x74,0x03,
        0xe9,0x74,0x00,0x89,0xee,0x83,0xc5,0x10,0xe2,0xe0,0x85,0xf6,0x75,0x03,0xe9,0x66,
        0x00,0x80,0x7c,0x04,0x00,0x75,0x03,0xe9,0x5d,0x00,0x8b,0x44,0x08,0x8b,0x54,0x0a,
        0x89,0xc3,0x09,0xd3,0x75,0x03,0xe9,0x4e,0x00,0x83,0xfa,0x0f,0x76,0x03,0xe9,0x46,
        0x00,0xbb,0x3f,0x00,0xf7,0xf3,0x89,0xd1,0x41,0x31,0xd2,0xbb,0x10,0x00,0xf7,0xf3,
        0x3d,0xff,0x03,0x76,0x03,0xe9,0x2f,0x00,0x88,0xd6,0x8a,0x16,0xb0,0x07,0x88,0xc5,
        0xd0,0xcc,0xd0,0xcc,0x08,0xe1,0xbb,0x00,0x7c,0xb8,0x01,0x02,0xcd,0x13,0x73,0x03,
        0xe9,0x14,0x00,0x81,0x3e,0xfe,0x7d,0x55,0xaa,0x74,0x03,0xe9,0x09,0x00,0x8a,0x16,
        0xb0,0x07,0xea,0x00,0x7c,0x00,0x00,0xbe,0xd0,0x06,0xbb,0x07,0x00,0xac,0x84,0xc0,
        0x75,0x03,0xe9,0x07,0x00,0xb4,0x0e,0xcd,0x10,0xe9,0xf1,0xff,0xfa,0xf4,0xeb,0xfd,
    };
    const char message[] = "Cannot load active partition boot sector.\r\n";
    std::fill_n(b.begin(), 440, 0);
    std::copy(std::begin(code), std::end(code), b.begin());
    std::copy(std::begin(message), std::end(message), b.begin() + sizeof(code));
    sw(b, 510, 0xaa55);
}
Bytes formatted(uint64_t size, bool floppy) {
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
    // Decimal parsing is exact: 1 cylinder = 0.4921875 MiB; avoid floating-point rounding.
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
}
