#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <thread>
#include <memory>
#include <stdexcept>

namespace {
enum { Type=101, Size, Raw, CreatePath, SavePath, Create, ImagePath, OpenPath, Destination,
       Overwrite, Sources, AddFiles, AddFolder, Clear, Import, List, Output,
       BootKind, BootPartition, BootFull, BootFile, OpenBoot, SaveBoot, ExportBoot, ImportBoot, InstallMbr };
constexpr UINT Completed = WM_APP + 1;
HWND window = nullptr;
HFONT font = nullptr;
std::thread worker;
bool busy = false, testing = false;
int testStep = 0, exitCode = 0;
std::filesystem::path testRoot;
std::string testImage;
std::vector<std::filesystem::path> sources;
struct Result { DWORD code = 1; std::wstring text; };
std::runtime_error winError(const char* text) {
    return std::runtime_error(std::string(text) + " (Windows error " + std::to_string(GetLastError()) + ")");
}
std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, text.data(), int(text.size()), nullptr, 0);
    if (!n) throw winError("Cannot decode command output");
    std::wstring out(n, L'\0');
    if (!MultiByteToWideChar(CP_UTF8, 0, text.data(), int(text.size()), out.data(), n)) throw winError("Cannot decode command output");
    return out;
}
std::wstring text(int id) {
    auto h = GetDlgItem(window, id);
    int n = GetWindowTextLengthW(h);
    std::wstring out(size_t(n) + 1, L'\0');
    GetWindowTextW(h, out.data(), n + 1); out.resize(n); return out;
}
void setText(int id, const std::wstring& value) { SetWindowTextW(GetDlgItem(window, id), value.c_str()); }
std::wstring quote(const std::wstring& arg) {
    std::wstring out = L"\""; unsigned slashes = 0;
    for (auto c : arg) {
        if (c == L'\\') { ++slashes; continue; }
        out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; out += c;
    }
    out.append(slashes * 2, L'\\'); return out + L"\"";
}
struct Handle {
    HANDLE h = nullptr;
    ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
};
Result execute(const std::vector<std::wstring>& args) {
    wchar_t module[32768]{};
    if (!GetModuleFileNameW(nullptr, module, DWORD(std::size(module))) || GetLastError() == ERROR_INSUFFICIENT_BUFFER)
        throw winError("Cannot find application directory");
    auto exe = std::filesystem::path(module).parent_path() / L"image-tool.exe";
    std::wstring command = quote(exe.wstring());
    for (const auto& arg : args) command += L" " + quote(arg);
    Handle reader, writer, input, process, thread;
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    if (!CreatePipe(&reader.h, &writer.h, &sa, 0) || !SetHandleInformation(reader.h, HANDLE_FLAG_INHERIT, 0))
        throw winError("Cannot create command output pipe");
    input.h = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    if (input.h == INVALID_HANDLE_VALUE) throw winError("Cannot open null input");
    STARTUPINFOW si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = input.h; si.hStdOutput = writer.h; si.hStdError = writer.h;
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi))
        throw winError("Cannot start image-tool.exe; keep both executables in the same directory");
    process.h = pi.hProcess; thread.h = pi.hThread;
    CloseHandle(writer.h); writer.h = nullptr;
    std::string output; char buffer[4096]; DWORD count;
    for (;;) {
        if (!ReadFile(reader.h, buffer, sizeof(buffer), &count, nullptr)) {
            if (GetLastError() == ERROR_BROKEN_PIPE) break;
            throw winError("Cannot read command output");
        }
        if (!count) break;
        output.append(buffer, count);
    }
    if (WaitForSingleObject(process.h, INFINITE) != WAIT_OBJECT_0) throw winError("Cannot wait for command");
    Result result;
    if (!GetExitCodeProcess(process.h, &result.code)) throw winError("Cannot read command exit code");
    result.text = wide(output); return result;
}
void state(bool active) {
    busy = active;
    for (int id = Type; id <= InstallMbr; ++id)
        if (id != Output) EnableWindow(GetDlgItem(window, id), !active);
    EnableWindow(GetDlgItem(window, BootPartition), !active &&
        SendMessageW(GetDlgItem(window, BootKind), CB_GETCURSEL, 0, 0) == 2);
    EnableWindow(GetDlgItem(window, InstallMbr), !active &&
        SendMessageW(GetDlgItem(window, BootKind), CB_GETCURSEL, 0, 0) == 1);
    DragAcceptFiles(window, !active);
}
void start(std::vector<std::wstring> args) {
    if (busy) return;
    state(true);
    setText(Output, L"Working... Please do not mount or edit the image.");
    worker = std::thread([args = std::move(args)] {
        auto result = std::make_unique<Result>();
        try { *result = execute(args); }
        catch (const std::exception& e) { result->text = wide(std::string("Error: ") + e.what()); }
        if (PostMessageW(window, Completed, 0, reinterpret_cast<LPARAM>(result.get()))) result.release();
        else OutputDebugStringW(L"Image utility: could not deliver command result\n");
    });
}
void sizes() {
    HWND list = GetDlgItem(window, Size);
    SendMessageW(list, CB_RESETCONTENT, 0, 0);
    bool floppy = SendMessageW(GetDlgItem(window, Type), CB_GETCURSEL, 0, 0) == 1;
    if (floppy) {
        for (auto s : {L"160 KiB",L"180 KiB",L"320 KiB",L"360 KiB",L"720 KiB",L"1200 KiB",L"1440 KiB"})
            SendMessageW(list, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(s));
        SendMessageW(list, CB_SETCURSEL, 6, 0);
    } else {
        for (auto s : {L"31.5 MiB",L"63 MiB",L"126 MiB",L"252 MiB",L"504 MiB"})
            SendMessageW(list, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(s));
        SendMessageW(list, CB_SETCURSEL, 0, 0);
    }
}
std::vector<std::filesystem::path> files(bool save, bool multi, bool boot = false) {
    std::vector<wchar_t> buffer(65536);
    OPENFILENAMEW ofn{}; ofn.lStructSize = sizeof(ofn); ofn.hwndOwner = window;
    ofn.lpstrFile = buffer.data(); ofn.nMaxFile = DWORD(buffer.size());
    ofn.lpstrFilter = multi ? L"All files\0*.*\0" : boot ? L"Boot sectors (*.bin)\0*.bin\0All files\0*.*\0" :
        L"Disk images (*.img;*.ima)\0*.img;*.ima\0All files\0*.*\0";
    ofn.lpstrDefExt = multi ? nullptr : boot ? L"bin" : L"img";
    ofn.Flags = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST |
        (save ? OFN_OVERWRITEPROMPT : OFN_FILEMUSTEXIST) | (multi ? OFN_ALLOWMULTISELECT : 0);
    if (!(save ? GetSaveFileNameW(&ofn) : GetOpenFileNameW(&ofn))) {
        if (CommDlgExtendedError()) throw std::runtime_error("File selection failed");
        return {};
    }
    std::vector<std::filesystem::path> out;
    std::filesystem::path first(buffer.data());
    auto p = buffer.data() + wcslen(buffer.data()) + 1;
    if (!multi || !*p) out.push_back(first);
    else while (*p) { out.push_back(first / p); p += wcslen(p) + 1; }
    return out;
}
void add(const std::filesystem::path& path) {
    auto absolute = std::filesystem::absolute(path).lexically_normal();
    for (const auto& source : sources) if (source == absolute) return;
    sources.push_back(absolute);
    SendMessageW(GetDlgItem(window, Sources), LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(absolute.c_str()));
}
void create() {
    auto path = text(CreatePath);
    if (path.empty()) throw std::runtime_error("Choose a new image path first");
    auto value = text(Size); value = value.substr(0, value.find(L' '));
    bool floppy = SendMessageW(GetDlgItem(window, Type), CB_GETCURSEL, 0, 0) == 1;
    std::vector<std::wstring> args{floppy ? L"create-floppy" : L"create-hard", path, L"--size", value};
    if (SendMessageW(GetDlgItem(window, Raw), BM_GETCHECK, 0, 0) == BST_CHECKED) args.push_back(L"--raw");
    start(std::move(args));
}
void import() {
    if (text(ImagePath).empty() || sources.empty()) throw std::runtime_error("Select an image and add files or folders first");
    std::vector<std::wstring> args{L"put", text(ImagePath), L"--dest", text(Destination)};
    if (SendMessageW(GetDlgItem(window, Overwrite), BM_GETCHECK, 0, 0) == BST_CHECKED) args.push_back(L"--overwrite");
    args.push_back(L"--");
    for (const auto& p : sources) args.push_back(p.wstring());
    start(std::move(args));
}
void bootAction(bool importing) {
    if (text(ImagePath).empty() || text(BootFile).empty())
        throw std::runtime_error("Select the image above and a boot sector file path first");
    auto kind = SendMessageW(GetDlgItem(window, BootKind), CB_GETCURSEL, 0, 0);
    std::vector<std::wstring> args{importing ? L"boot-import" : L"boot-export", text(ImagePath), text(BootFile),
        L"--sector", kind == 0 ? L"floppy" : kind == 1 ? L"mbr" : L"partition"};
    if (kind == 2) {
        args.push_back(L"--partition");
        args.push_back(std::to_wstring(SendMessageW(GetDlgItem(window, BootPartition), CB_GETCURSEL, 0, 0) + 1));
    }
    if (importing && SendMessageW(GetDlgItem(window, BootFull), BM_GETCHECK, 0, 0) == BST_CHECKED) {
        if (!testing && MessageBoxW(window,
            L"This replaces ALL 512 bytes, including the partition table or BPB.\n"
            L"The image may become unreadable. Make a backup first.\n\nContinue?",
            L"Full boot sector replacement", MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) != IDYES) return;
        args.push_back(L"--full");
    }
    start(std::move(args));
}
void installMbr() {
    if (text(ImagePath).empty()) throw std::runtime_error("Select the hard disk image above first");
    if (!testing && MessageBoxW(window,
        L"Install MBR boot code that loads the active partition?\n"
        L"Disk identity, partition table and partition contents will be preserved.\n"
        L"Back up the image first; unmount it from the VM before continuing.",
        L"Install MBR code", MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) != IDYES) return;
    start({L"boot-install-mbr", text(ImagePath)});
}
HWND control(const wchar_t* cls, const wchar_t* label, DWORD style, int x, int y, int width, int height, int id = 0) {
    HWND h = CreateWindowExW(cls == std::wstring(L"EDIT") ? WS_EX_CLIENTEDGE : 0, cls, label,
        WS_CHILD | WS_VISIBLE | style, x, y, width, height, window,
        reinterpret_cast<HMENU>(INT_PTR(id)), GetModuleHandleW(nullptr), nullptr);
    if (!h) throw winError("Cannot create control");
    SendMessageW(h, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE); return h;
}
void layout() {
    control(L"STATIC", L"Create image (FAT data disk, not bootable; existing files are never replaced)", 0, 14, 12, 745, 22);
    auto type = control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_TABSTOP, 14, 40, 170, 220, Type);
    SendMessageW(type, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Hard disk"));
    SendMessageW(type, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Floppy disk"));
    SendMessageW(type, CB_SETCURSEL, 0, 0);
    control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_TABSTOP, 196, 40, 150, 220, Size); sizes();
    control(L"BUTTON", L"Raw zeros (no filesystem)", BS_AUTOCHECKBOX | WS_TABSTOP, 362, 40, 260, 24, Raw);
    control(L"EDIT", L"", ES_AUTOHSCROLL | WS_TABSTOP, 14, 76, 540, 26, CreatePath);
    control(L"BUTTON", L"Save as...", WS_TABSTOP, 564, 76, 92, 26, SavePath);
    control(L"BUTTON", L"Create", WS_TABSTOP, 666, 76, 94, 26, Create);
    control(L"STATIC", L"Import into an existing FAT12/FAT16 image (unmount from VM first)", 0, 14, 124, 730, 22);
    control(L"EDIT", L"", ES_AUTOHSCROLL | WS_TABSTOP, 14, 154, 642, 26, ImagePath);
    control(L"BUTTON", L"Open IMG...", WS_TABSTOP, 666, 154, 94, 26, OpenPath);
    control(L"STATIC", L"Target directory:", 0, 14, 192, 120, 24);
    control(L"EDIT", L"\\", ES_AUTOHSCROLL | WS_TABSTOP, 140, 188, 200, 26, Destination);
    control(L"BUTTON", L"Overwrite existing ordinary files", BS_AUTOCHECKBOX | WS_TABSTOP, 356, 188, 330, 26, Overwrite);
    control(L"STATIC", L"Drop multiple files or folders here; all nested folders are imported (ASCII DOS 8.3 names).", 0, 14, 224, 746, 24);
    control(L"LISTBOX", L"", WS_BORDER | WS_VSCROLL | WS_HSCROLL | LBS_NOINTEGRALHEIGHT | WS_TABSTOP,
        14, 250, 746, 174, Sources);
    control(L"BUTTON", L"Add files...", WS_TABSTOP, 14, 436, 110, 28, AddFiles);
    control(L"BUTTON", L"Add folder...", WS_TABSTOP, 136, 436, 110, 28, AddFolder);
    control(L"BUTTON", L"Clear list", WS_TABSTOP, 258, 436, 100, 28, Clear);
    control(L"BUTTON", L"List target", WS_TABSTOP, 520, 436, 110, 28, List);
    control(L"BUTTON", L"Import all", WS_TABSTOP, 644, 436, 116, 28, Import);
    control(L"STATIC", L"Boot sector (uses the IMG above): export 512 bytes or import boot code", 0, 14, 480, 746, 24);
    auto kind = control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_TABSTOP, 14, 510, 242, 180, BootKind);
    for (auto name : {L"Floppy boot sector", L"Hard disk MBR", L"Hard disk partition boot sector"})
        SendMessageW(kind, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(name));
    SendMessageW(kind, CB_SETCURSEL, 0, 0);
    auto partition = control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_TABSTOP, 270, 510, 122, 150, BootPartition);
    for (auto name : {L"Primary slot 1", L"Primary slot 2", L"Primary slot 3", L"Primary slot 4"})
        SendMessageW(partition, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(name));
    SendMessageW(partition, CB_SETCURSEL, 0, 0); EnableWindow(partition, FALSE);
    control(L"BUTTON", L"Full 512 bytes (destructive import)", BS_AUTOCHECKBOX | WS_TABSTOP, 406, 510, 354, 24, BootFull);
    control(L"EDIT", L"", ES_AUTOHSCROLL | WS_TABSTOP, 14, 548, 540, 26, BootFile);
    control(L"BUTTON", L"Open BIN...", WS_TABSTOP, 564, 548, 92, 26, OpenBoot);
    control(L"BUTTON", L"Save as...", WS_TABSTOP, 666, 548, 94, 26, SaveBoot);
    control(L"STATIC", L"Code-only preserves BPB / partition table. Back up first.", 0, 14, 590, 364, 38);
    auto install = control(L"BUTTON", L"Install MBR", WS_TABSTOP, 392, 586, 116, 28, InstallMbr);
    EnableWindow(install, FALSE);
    control(L"BUTTON", L"Export sector", WS_TABSTOP, 520, 586, 110, 28, ExportBoot);
    control(L"BUTTON", L"Import sector", WS_TABSTOP, 644, 586, 116, 28, ImportBoot);
    control(L"EDIT", L"Ready. Import is all-or-nothing; insufficient space leaves the original IMG unchanged.",
        ES_MULTILINE | ES_READONLY | WS_VSCROLL | ES_AUTOVSCROLL | WS_TABSTOP, 14, 640, 746, 150, Output);
    DragAcceptFiles(window, TRUE);
}
void startTest() {
    std::cout << "GUI test: preparing multi-source drag/drop\n" << std::flush;
    wchar_t temp[MAX_PATH]{}, path[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp) || !GetTempFileNameW(temp, L"a86", 0, path)) throw winError("Cannot create GUI test directory");
    if (!DeleteFileW(path) || !CreateDirectoryW(path, nullptr)) throw winError("Cannot prepare GUI test directory");
    testRoot = path;
    std::filesystem::create_directories(testRoot / L"TREE" / L"SUB");
    std::ofstream(testRoot / L"TREE" / L"SUB" / L"NOTE.TXT") << "GUI drag/drop probe";
    auto folder = (testRoot / L"TREE").wstring(), file = (testRoot / L"OTHER.TXT").wstring();
    std::ofstream(std::filesystem::path(file)) << "Second drag source";
    std::filesystem::create_directories(testRoot / L"HUGE" / L"SUB");
    std::ofstream(testRoot / L"HUGE" / L"A.BIN", std::ios::binary) << std::string(750 * 1024, 'A');
    std::ofstream(testRoot / L"HUGE" / L"SUB" / L"B.BIN", std::ios::binary) << std::string(750 * 1024, 'B');
    size_t bytes = sizeof(DROPFILES) + (folder.size() + file.size() + 3) * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GHND, bytes);
    if (!memory) throw winError("Cannot allocate drag test");
    auto drop = static_cast<DROPFILES*>(GlobalLock(memory));
    if (!drop) { GlobalFree(memory); throw winError("Cannot lock drag test"); }
    drop->pFiles = sizeof(DROPFILES); drop->fWide = TRUE;
    auto names = reinterpret_cast<wchar_t*>(reinterpret_cast<uint8_t*>(drop) + sizeof(DROPFILES));
    memcpy(names, folder.c_str(), (folder.size() + 1) * sizeof(wchar_t));
    memcpy(names + folder.size() + 1, file.c_str(), (file.size() + 1) * sizeof(wchar_t));
    GlobalUnlock(memory);
    SendMessageW(window, WM_DROPFILES, reinterpret_cast<WPARAM>(memory), 0);
    if (sources.size() != 2) throw std::runtime_error("Multi-source drag test failed");
    SendMessageW(GetDlgItem(window, Type), CB_SETCURSEL, 1, 0); sizes();
    auto image = (testRoot / L"FLOPPY.IMG").wstring();
    setText(CreatePath, image); setText(ImagePath, image); setText(Destination, L"\\DATA");
    create();
}
LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    try {
        if (msg == WM_CREATE) { window = hwnd; layout(); if (testing) PostMessageW(hwnd, WM_APP + 2, 0, 0); return 0; }
        if (msg == WM_APP + 2) { startTest(); return 0; }
        if (msg == WM_DROPFILES) {
            auto drop = reinterpret_cast<HDROP>(wp);
            try {
                if (!busy) for (UINT i = 0, n = DragQueryFileW(drop, 0xffffffff, nullptr, 0); i < n; ++i) {
                    UINT length = DragQueryFileW(drop, i, nullptr, 0);
                    std::wstring path(size_t(length) + 1, L'\0');
                    if (!DragQueryFileW(drop, i, path.data(), length + 1)) throw winError("Cannot read dropped path");
                    path.resize(length); add(path);
                }
            } catch (...) { DragFinish(drop); throw; }
            DragFinish(drop); return 0;
        }
        if (msg == Completed) {
            if (testing) std::cout << "GUI test: command completed, step " << testStep << '\n' << std::flush;
            worker.join(); state(false);
            std::unique_ptr<Result> result(reinterpret_cast<Result*>(lp));
            setText(Output, result->text);
            if (testing) {
                if (testStep == 3) {
                    if (!result->code || result->text.find(L"Not enough free space") == std::wstring::npos)
                        throw std::runtime_error("GUI must report combined directory capacity overflow");
                    std::ifstream image(std::filesystem::path(text(ImagePath)), std::ios::binary);
                    std::string after(std::istreambuf_iterator<char>(image), {});
                    if (after != testImage) throw std::runtime_error("GUI failed-import rollback verification failed");
                    setText(BootFile, (testRoot / L"BOOT.BIN").wstring());
                    ++testStep; bootAction(false); return 0;
                }
                if (testStep == 4) {
                    if (result->code || std::filesystem::file_size(testRoot / L"BOOT.BIN") != 512)
                        throw std::runtime_error("GUI boot export must produce exactly 512 bytes");
                    std::fstream boot(testRoot / L"BOOT.BIN", std::ios::binary | std::ios::in | std::ios::out);
                    boot.seekp(100); boot.put(char(0x90)); boot.flush();
                    if (!boot) throw std::runtime_error("Cannot prepare GUI boot import fixture");
                    boot.close(); testImage[100] = char(0x90);
                    ++testStep; bootAction(true); return 0;
                }
                if (testStep == 5) {
                    if (result->code) throw std::runtime_error("GUI boot code import failed");
                    std::ifstream image(std::filesystem::path(text(ImagePath)), std::ios::binary);
                    std::string after(std::istreambuf_iterator<char>(image), {});
                    if (after != testImage) throw std::runtime_error("GUI boot import modified more than selected code");
                    ++testStep;
                    SendMessageW(GetDlgItem(window, Type), CB_SETCURSEL, 0, 0); sizes();
                    setText(CreatePath, (testRoot / L"HARD.IMG").wstring());
                    setText(ImagePath, text(CreatePath)); create(); return 0;
                }
                if (testStep == 6) {
                    if (result->code) throw std::runtime_error("GUI MBR fixture creation failed");
                    std::fstream image(testRoot / L"HARD.IMG", std::ios::binary | std::ios::in | std::ios::out);
                    image.write(std::string(440, char(0x90)).data(), 440); image.close();
                    if (!image) throw std::runtime_error("Cannot prepare obsolete MBR fixture");
                    std::ifstream before(testRoot / L"HARD.IMG", std::ios::binary);
                    testImage.assign(std::istreambuf_iterator<char>(before), {});
                    SendMessageW(GetDlgItem(window, BootKind), CB_SETCURSEL, 1, 0); state(false);
                    ++testStep; installMbr(); return 0;
                }
                if (testStep == 7) {
                    if (result->code) throw std::runtime_error("GUI MBR repair failed");
                    std::ifstream image(testRoot / L"HARD.IMG", std::ios::binary);
                    std::string after(std::istreambuf_iterator<char>(image), {});
                    if (after.size() != testImage.size() || after.substr(440) != testImage.substr(440) ||
                        after.substr(0, 440) == testImage.substr(0, 440))
                        throw std::runtime_error("GUI MBR repair changed data or left old code intact");
                    std::cout << "GUI drag/drop / boot export-import / MBR repair preservation checks passed\n" << std::flush;
                    DestroyWindow(hwnd); return 0;
                }
                if (result->code) throw std::runtime_error("GUI command failed");
                if (testStep++ == 0) import();
                else if (testStep == 2) start({L"list", text(ImagePath), L"--dir", L"\\DATA\\TREE\\SUB"});
                else {
                    if (result->text.find(L"NOTE.TXT") == std::wstring::npos) throw std::runtime_error("GUI recursive import verification failed");
                    std::ifstream image(std::filesystem::path(text(ImagePath)), std::ios::binary);
                    testImage.assign(std::istreambuf_iterator<char>(image), {});
                    sources.clear(); SendMessageW(GetDlgItem(window, Sources), LB_RESETCONTENT, 0, 0);
                    add(testRoot / L"HUGE"); import();
                }
            } else if (result->code) MessageBoxW(hwnd, result->text.c_str(), L"Image operation failed (original IMG unchanged)", MB_OK | MB_ICONERROR);
            else if (sources.empty() && !text(CreatePath).empty() && text(ImagePath).empty()) setText(ImagePath, text(CreatePath));
            return 0;
        }
        if (msg == WM_COMMAND && !busy) {
            switch (LOWORD(wp)) {
            case Type: if (HIWORD(wp) == CBN_SELCHANGE) sizes(); break;
            case SavePath: { auto selected = files(true, false); if (!selected.empty()) setText(CreatePath, selected.front().wstring()); break; }
            case OpenPath: { auto selected = files(false, false); if (!selected.empty()) setText(ImagePath, selected.front().wstring()); break; }
            case Create: create(); break;
            case AddFiles: for (const auto& p : files(false, true)) add(p); break;
            case AddFolder: {
                BROWSEINFOW bi{}; bi.hwndOwner = hwnd; bi.lpszTitle = L"Select a folder (all nested folders will be imported)";
                bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
                auto pidl = SHBrowseForFolderW(&bi);
                if (pidl) {
                    wchar_t path[MAX_PATH]{};
                    bool ok = SHGetPathFromIDListW(pidl, path); CoTaskMemFree(pidl);
                    if (!ok) throw std::runtime_error("Cannot read selected folder path");
                    add(path);
                }
                break;
            }
            case Clear: sources.clear(); SendMessageW(GetDlgItem(hwnd, Sources), LB_RESETCONTENT, 0, 0); break;
            case Import: import(); break;
            case List: start({L"list", text(ImagePath), L"--dir", text(Destination)}); break;
            case BootKind: if (HIWORD(wp) == CBN_SELCHANGE) state(false); break;
            case OpenBoot: { auto selected = files(false, false, true); if (!selected.empty()) setText(BootFile, selected.front().wstring()); break; }
            case SaveBoot: { auto selected = files(true, false, true); if (!selected.empty()) setText(BootFile, selected.front().wstring()); break; }
            case ExportBoot: bootAction(false); break;
            case ImportBoot: bootAction(true); break;
            case InstallMbr: installMbr(); break;
            }
            return 0;
        }
        if (msg == WM_CLOSE) {
            if (busy) { if (!testing) MessageBoxW(hwnd, L"Wait for the current operation to finish before closing.", L"Image utility", MB_OK); return 0; }
            DestroyWindow(hwnd); return 0;
        }
        if (msg == WM_DESTROY) { PostQuitMessage(exitCode); return 0; }
    } catch (const std::exception& e) {
        if (testing) { exitCode = 1; std::cerr << e.what() << '\n'; DestroyWindow(hwnd); }
        else MessageBoxW(hwnd, wide(e.what()).c_str(), L"Image utility error", MB_OK | MB_ICONERROR);
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    int argc = 0;
    auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return 1;
    testing = argc == 2 && std::wstring(argv[1]) == L"--ui-test";
    LocalFree(argv);
    if (testing) std::cout << "GUI test: starting\n" << std::flush;
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    WNDCLASSW cls{}; cls.lpfnWndProc = proc; cls.hInstance = instance; cls.lpszClassName = L"Asm86ImageUtility";
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
    if (!RegisterClassW(&cls)) { CoUninitialize(); return 1; }
    RECT rect{0,0,774,804};
    AdjustWindowRect(&rect, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE);
    HWND hwnd = CreateWindowW(cls.lpszClassName, L"Asm86 disk image utility", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
        CW_USEDEFAULT, CW_USEDEFAULT, rect.right - rect.left, rect.bottom - rect.top, nullptr, nullptr, instance, nullptr);
    if (!hwnd) { CoUninitialize(); return 1; }
    ShowWindow(hwnd, show);
    MSG msg{}; BOOL result;
    while ((result = GetMessageW(&msg, nullptr, 0, 0)) > 0) {
        if (!IsDialogMessageW(hwnd, &msg)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    }
    if (worker.joinable()) worker.join();
    if (!testRoot.empty()) {
        std::error_code cleanup;
        std::filesystem::remove_all(testRoot, cleanup);
        if (cleanup) { OutputDebugStringW(L"Could not clean GUI test fixture\n"); exitCode = 1; }
    }
    CoUninitialize(); return result == -1 ? 1 : exitCode;
}
