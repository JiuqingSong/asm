// 开发用采样分析器：启动目标程序，约每毫秒暂停其主线程读取 RIP，退出后按 PDB 汇总到函数与源码行。
// 用法：sampler.exe [--skip 毫秒] [--lines N] [--functions N] -- <程序> [参数...]
// --skip 丢弃启动后一段时间的样本（例如快照加载与基底盘哈希）；exe 之外的样本按所在 DLL 归类。
#include <windows.h>
#include <dbghelp.h>
#include <psapi.h>
#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

static std::wstring quote(const std::wstring& value) {
    if (!value.empty() && value.find_first_of(L" \t\"") == std::wstring::npos) return value;
    std::wstring out = L"\"";
    for (size_t i = 0; i < value.size(); ++i) {
        size_t slashes = 0;
        while (i < value.size() && value[i] == L'\\') { ++slashes; ++i; }
        if (i == value.size()) { out.append(slashes * 2, L'\\'); break; }
        if (value[i] == L'"') out.append(slashes * 2 + 1, L'\\'); else out.append(slashes, L'\\');
        out += value[i];
    }
    return out + L"\"";
}

struct Module { DWORD64 base = 0, size = 0; std::wstring path; };

static std::vector<Module> modules(HANDLE process) {
    std::vector<HMODULE> handles(1024); DWORD needed = 0;
    std::vector<Module> result;
    if (!EnumProcessModules(process, handles.data(), DWORD(handles.size() * sizeof(HMODULE)), &needed)) return result;
    handles.resize(std::min<size_t>(handles.size(), needed / sizeof(HMODULE)));
    for (auto handle : handles) {
        MODULEINFO info{}; wchar_t path[MAX_PATH]{};
        if (GetModuleInformation(process, handle, &info, sizeof(info)) && GetModuleFileNameExW(process, handle, path, MAX_PATH))
            result.push_back({DWORD64(info.lpBaseOfDll), DWORD64(info.SizeOfImage), path});
    }
    return result;
}

static std::string narrow(const std::wstring& value) {
    std::string out; for (wchar_t ch : value) out += ch < 128 ? char(ch) : '?'; return out;
}

int wmain(int argc, wchar_t** argv) {
    unsigned topLines = 40, topFunctions = 40, skip = 0; int first = 1;
    for (; first < argc; ++first) {
        std::wstring option = argv[first];
        if (option == L"--") { ++first; break; }
        if (option == L"--lines" && first + 1 < argc) topLines = unsigned(_wtoi(argv[++first]));
        else if (option == L"--functions" && first + 1 < argc) topFunctions = unsigned(_wtoi(argv[++first]));
        else if (option == L"--skip" && first + 1 < argc) skip = unsigned(_wtoi(argv[++first]));
        else { fwprintf(stderr, L"Unknown option %ls\n", option.c_str()); return 2; }
    }
    if (first >= argc) { fwprintf(stderr, L"Usage: sampler [--skip ms] [--lines N] [--functions N] -- program [args...]\n"); return 2; }
    std::wstring command;
    for (int i = first; i < argc; ++i) command += (i > first ? L" " : L"") + quote(argv[i]);

    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &process)) {
        fwprintf(stderr, L"CreateProcess failed: %lu\n", GetLastError()); return 1;
    }
    timeBeginPeriod(1);
    ResumeThread(process.hThread);
    const auto started = GetTickCount64();
    std::unordered_map<DWORD64, uint64_t> samples; uint64_t total = 0;
    std::vector<Module> loaded;
    while (WaitForSingleObject(process.hProcess, 1) == WAIT_TIMEOUT) {
        if (GetTickCount64() - started < skip) continue;
        if (SuspendThread(process.hThread) == DWORD(-1)) break;
        CONTEXT context{}; context.ContextFlags = CONTEXT_CONTROL;
        if (GetThreadContext(process.hThread, &context)) { ++samples[context.Rip]; ++total; }
        ResumeThread(process.hThread);
        // 模块列表在采样开始后记录一次（此时 DLL 已加载完），退出后就无法再查询。
        if (loaded.empty()) loaded = modules(process.hProcess);
    }
    timeEndPeriod(1);
    DWORD exitCode = 0; GetExitCodeProcess(process.hProcess, &exitCode);
    if (loaded.empty()) { fwprintf(stderr, L"No samples or modules recorded\n"); return int(exitCode ? exitCode : 1); }

    // 目标已退出：在本进程内按记录的基址加载主模块 PDB（与 exe 同目录）并符号化。
    HANDLE symbols = HANDLE(uintptr_t(0x5a5a));
    SymSetOptions(SYMOPT_LOAD_LINES | SYMOPT_UNDNAME);
    if (!SymInitializeW(symbols, nullptr, FALSE)) { fwprintf(stderr, L"SymInitialize failed\n"); return 1; }
    const auto& image = loaded.front();
    SymSetSearchPathW(symbols, image.path.substr(0, image.path.find_last_of(L"\\/")).c_str());
    if (!SymLoadModuleExW(symbols, nullptr, image.path.c_str(), nullptr, image.base, DWORD(image.size), nullptr, 0))
        printf("Cannot load symbols for %s (error %lu)\n", narrow(image.path).c_str(), GetLastError());

    std::map<std::string, uint64_t> functions, lines;
    for (auto [rip, count] : samples) {
        if (rip < image.base || rip >= image.base + image.size) {
            std::string name = "[unknown module]";
            for (const auto& module : loaded)
                if (rip >= module.base && rip < module.base + module.size) {
                    auto path = narrow(module.path); name = "[" + path.substr(path.find_last_of("\\/") + 1) + "]";
                }
            functions[name] += count; continue;
        }
        alignas(SYMBOL_INFO) char buffer[sizeof(SYMBOL_INFO) + 512]{};
        auto* symbol = reinterpret_cast<SYMBOL_INFO*>(buffer); symbol->SizeOfStruct = sizeof(SYMBOL_INFO); symbol->MaxNameLen = 511;
        DWORD64 displacement = 0;
        functions[SymFromAddr(symbols, rip, &displacement, symbol) ? symbol->Name : "[no symbol]"] += count;
        IMAGEHLP_LINE64 line{}; line.SizeOfStruct = sizeof(line); DWORD column = 0;
        if (SymGetLineFromAddr64(symbols, rip, &column, &line)) {
            std::string file = line.FileName; auto slash = file.find_last_of("\\/");
            lines[file.substr(slash == std::string::npos ? 0 : slash + 1) + ":" + std::to_string(line.LineNumber)] += count;
        }
    }
    auto report = [&](const char* title, const std::map<std::string, uint64_t>& table, unsigned top) {
        std::vector<std::pair<uint64_t, std::string>> sorted;
        for (auto& [name, count] : table) sorted.push_back({count, name});
        std::sort(sorted.rbegin(), sorted.rend());
        printf("\n== %s ==\n", title);
        for (unsigned i = 0; i < sorted.size() && i < top; ++i)
            printf("%6.2f%%  %s\n", 100.0 * double(sorted[i].first) / double(std::max<uint64_t>(total, 1)), sorted[i].second.c_str());
    };
    printf("samples=%llu exit=%lu\n", (unsigned long long)total, exitCode);
    report("functions (self)", functions, topFunctions);
    report("source lines", lines, topLines);
    return int(exitCode);
}
