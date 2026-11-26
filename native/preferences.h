#pragma once
#include "cpu.h"
#include <windows.h>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace asm86 {
class Preferences {
    HKEY key = nullptr;
    static void checked(LSTATUS status, const char* operation) {
        if (status != ERROR_SUCCESS)
            throw std::runtime_error(std::string(operation) + " (Windows error " + std::to_string(status) + ")");
    }
    DWORD number(const wchar_t* name, DWORD fallback) const {
        DWORD value = 0, bytes = sizeof(value);
        auto status = RegGetValueW(key, nullptr, name, RRF_RT_REG_DWORD, nullptr, &value, &bytes);
        if (status == ERROR_FILE_NOT_FOUND) return fallback;
        checked(status, "Cannot read native preferences");
        return value;
    }
    void number(const wchar_t* name, DWORD value) {
        checked(RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof(value)),
            "Cannot save native preferences");
    }
    std::filesystem::path imagePath(const wchar_t* name) const {
        std::wstring value(32768, L'\0'); DWORD bytes = DWORD(value.size() * sizeof(wchar_t));
        auto status = RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ, nullptr, value.data(), &bytes);
        if (status == ERROR_FILE_NOT_FOUND) return {};
        checked(status, "Cannot read remembered disk image");
        if (bytes < sizeof(wchar_t) || bytes % sizeof(wchar_t) || value[bytes / sizeof(wchar_t) - 1] != L'\0')
            throw std::runtime_error("Invalid disk image path in native preferences");
        value.resize(bytes / sizeof(wchar_t) - 1);
        if (value.find(L'\0') != std::wstring::npos) throw std::runtime_error("Invalid disk image path in native preferences");
        return value;
    }
    void imagePath(const wchar_t* name, const std::filesystem::path& path) {
        auto value = path.empty() ? std::wstring() : std::filesystem::absolute(path).wstring();
        checked(RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
            DWORD((value.size() + 1) * sizeof(wchar_t))), "Cannot save remembered disk image");
    }
public:
    explicit Preferences(const wchar_t* subkey = L"Software\\Asm86\\Native") {
        checked(RegCreateKeyExW(HKEY_CURRENT_USER, subkey, 0, nullptr, 0, KEY_QUERY_VALUE | KEY_SET_VALUE,
            nullptr, &key, nullptr), "Cannot open native preferences");
    }
    ~Preferences() { RegCloseKey(key); }
    Preferences(const Preferences&) = delete;
    Preferences& operator=(const Preferences&) = delete;
    CpuModel cpu() const {
        auto value = number(L"Cpu", 8088);
        if (value == 8088) return CpuModel::I8088;
        if (value == 286) return CpuModel::I286;
        if (value == 386) return CpuModel::I386;
        if (value == 486) return CpuModel::I486;
        throw std::runtime_error("Invalid CPU in native preferences");
    }
    void cpu(CpuModel value) {
        switch (value) {
        case CpuModel::I8088: number(L"Cpu", 8088); return;
        case CpuModel::I286: number(L"Cpu", 286); return;
        case CpuModel::I386: number(L"Cpu", 386); return;
        case CpuModel::I486: number(L"Cpu", 486); return;
        }
        throw std::runtime_error("Invalid CPU in native preferences");
    }
    bool fullSpeed() const {
        auto value = number(L"FullSpeed", 0);
        if (value > 1) throw std::runtime_error("Invalid speed in native preferences");
        return value != 0;
    }
    void fullSpeed(bool value) { number(L"FullSpeed", value ? 1 : 0); }
    bool stableTiming() const {
        auto value = number(L"StableTiming", 0);
        if (value > 1) throw std::runtime_error("Invalid CPU timing in native preferences");
        return value != 0;
    }
    void stableTiming(bool value) { number(L"StableTiming", value ? 1 : 0); }
    std::filesystem::path floppy() const { return imagePath(L"Floppy"); }
    void floppy(const std::filesystem::path& path) { imagePath(L"Floppy", path); }
    std::filesystem::path hard() const { return imagePath(L"HardDisk"); }
    void hard(const std::filesystem::path& path) { imagePath(L"HardDisk", path); }
    std::filesystem::path overlay() const { return imagePath(L"Overlay"); }
    void overlay(const std::filesystem::path& path) { imagePath(L"Overlay", path); }
};
}
