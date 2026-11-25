#include "pc.h"
#include "display.h"
#include "preferences.h"
#include "timing.h"
#include <commdlg.h>
#include <shellapi.h>
#include <windowsx.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>

using namespace asm86;
namespace {
enum { LoadFloppy=101, EjectFloppy, LoadHard, NewHard, BootA, BootC, Reset, Original, Maximize, Quit, FullSpeed, Cpu8088, Cpu286, Cpu386, CtrlAltDel };
std::unique_ptr<Pc> pc;
std::unique_ptr<Preferences> preferences;
ExecutionTiming executionTiming;
bool running = false;
bool fullSpeed = false;
bool mouseCaptured = false;
std::array<bool, 128> pressedKeys{};
double mouseFractionX = 0, mouseFractionY = 0;
HFONT font = nullptr;
HBITMAP bitmap = nullptr;
HDC back = nullptr;
std::array<wchar_t, 256> glyphs{};
const COLORREF colors[] = {
    RGB(0,0,0),RGB(0,0,170),RGB(0,170,0),RGB(0,170,170),
    RGB(170,0,0),RGB(170,0,170),RGB(170,85,0),RGB(170,170,170),
    RGB(85,85,85),RGB(85,85,255),RGB(85,255,85),RGB(85,255,255),
    RGB(255,85,85),RGB(255,85,255),RGB(255,255,85),RGB(255,255,255)
};
std::wstring wide(const std::string& value) {
    int n = MultiByteToWideChar(CP_UTF8, 0, value.data(), int(value.size()), nullptr, 0);
    std::wstring result(n, L'\0'); MultiByteToWideChar(CP_UTF8, 0, value.data(), int(value.size()), result.data(), n); return result;
}
void title(HWND hwnd) {
    std::wstring value = pc->cpu.model == CpuModel::I386 ? L"Asm86 native - 80386 / AT (experimental)"
        : pc->at() ? L"Asm86 native - 80286 / AT" : L"Asm86 native - 8088";
    value += L" | A: " + (pc->floppy ? pc->floppy->path.filename().wstring() : L"(empty)");
    value += L" | C: " + (pc->hard ? pc->hard->path.filename().wstring() : L"(empty)");
    value += fullSpeed ? L" | Full speed" : pc->cpu.model == CpuModel::I386 ? L" | Normal speed (386 ~4 MIPS)"
        : pc->at() ? L" | Normal speed (286 ~2 MIPS)" : L" | Normal speed (8088 ~0.33 MIPS)";
    if (mouseCaptured) value += L" | Mouse captured (Right Ctrl releases)";
    if (!running) value += L" | stopped";
    SetWindowTextW(hwnd, value.c_str());
}
void releaseMouse(HWND hwnd) {
    if (!mouseCaptured) return;
    mouseCaptured = false;
    if (GetCapture() == hwnd) ReleaseCapture();
    ShowCursor(TRUE);
    pc->serialMouse.motion(0, 0, 0, pc->clock);
}
void releaseKeyboard() {
    for (unsigned scan = 0; scan < pressedKeys.size(); ++scan) {
        if (pressedKeys[scan] && running) pc->key(uint8_t(scan | 128), 0);
        pressedKeys[scan] = false;
    }
    if (!running) pc->modifiers(0);
}
void centerMouse(HWND hwnd) {
    RECT rect{}; GetClientRect(hwnd, &rect);
    POINT center{rect.right / 2, rect.bottom / 2};
    if (!ClientToScreen(hwnd, &center) || !SetCursorPos(center.x, center.y))
        throw std::runtime_error("Cannot center captured mouse pointer");
}
std::filesystem::path choose(HWND hwnd, bool save) {
    wchar_t path[32768]{};
    OPENFILENAMEW dialog{}; dialog.lStructSize = sizeof(dialog); dialog.hwndOwner = hwnd;
    dialog.lpstrFilter = L"Disk images (*.img;*.ima)\0*.img;*.ima\0All files\0*.*\0";
    dialog.lpstrFile = path; dialog.nMaxFile = DWORD(std::size(path)); dialog.lpstrDefExt = L"img";
    dialog.Flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | (save ? OFN_OVERWRITEPROMPT : OFN_FILEMUSTEXIST);
    if (save ? GetSaveFileNameW(&dialog) : GetOpenFileNameW(&dialog)) return path;
    if (CommDlgExtendedError()) throw std::runtime_error("File selection dialog failed");
    return {};
}
void original(HWND hwnd) {
    ShowWindow(hwnd, SW_RESTORE);
    RECT rect{0,0,int(pc->vga.width()),int(pc->vga.height())};
    AdjustWindowRectEx(&rect, WS_OVERLAPPEDWINDOW, TRUE, 0);
    SetWindowPos(hwnd, nullptr, 0, 0, rect.right - rect.left, rect.bottom - rect.top, SWP_NOMOVE | SWP_NOZORDER);
}
void render(HDC target, int width, int height) {
    if (!pc) return;
    unsigned cols = std::max(1u, std::min(pc->columns(), 80u)), page = pc->activePage();
    bool graphics = pc->vga.graphics();
    auto v = viewport(width, height, int(pc->vga.width()), int(pc->vga.height()));
    static std::vector<uint32_t> pixels;
    if (graphics) {
        pixels.resize(pc->vga.width() * pc->vga.height());
        for (unsigned y = 0; y < pc->vga.height(); ++y) for (unsigned x = 0; x < pc->vga.width(); ++x) {
            auto color = pc->vga.pixel(x, y);
            auto index = pc->vga.indexed256() ? color : pc->vga.paletteIndex(color);
            pixels[y * pc->vga.width() + x] = pc->vga.blanked() ? 0 : pc->vga.color(index);
        }
    } else {
        int cellWidth = 8;
        SetBkMode(back, OPAQUE);
        auto palette = [](uint8_t index) {
            auto rgb = pc->vga.color(pc->vga.paletteIndex(index));
            return pc->vga.blanked() ? RGB(0,0,0) : RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        };
        const unsigned base = page * 4096;
        for (unsigned y = 0; y < 25; ++y) for (unsigned x = 0; x < cols; ++x) {
            uint8_t ch = pc->vga.textByte(base + (y * cols + x) * 2), attr = pc->vga.textByte(base + (y * cols + x) * 2 + 1);
            SetTextColor(back, palette(attr & 15)); SetBkColor(back, palette((attr >> 4) & 7));
            RECT cell{int(x) * cellWidth, int(y) * 16, int(x + 1) * cellWidth, int(y + 1) * 16};
            ExtTextOutW(back, cell.left, cell.top, ETO_OPAQUE | ETO_CLIPPED, &cell, &glyphs[ch], 1, nullptr);
        }
        unsigned pos = pc->cursor(), x = pos & 255, y = pos >> 8;
        auto shape = pc->cpu.rw(0x40, 0x60);
        if (!pc->vga.blanked() && !(shape & 0x2000) && x < cols && y < 25 && (GetTickCount64() / 500) % 2 == 0) {
            RECT cursor{int(x) * cellWidth, int(y) * 16 + 14, int(x + 1) * cellWidth, int(y + 1) * 16};
            FillRect(back, &cursor, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
        }
    }
    // Only clear letterboxing: clearing the viewport exposes a black frame before presentation.
    const RECT margins[] = {{0,0,width,v.y}, {0,v.y + v.height,width,height},
        {0,v.y,v.x,v.y + v.height}, {v.x + v.width,v.y,width,v.y + v.height}};
    for (const auto& margin : margins) FillRect(target, &margin, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
    SetStretchBltMode(target, COLORONCOLOR);
    if (v.width && v.height) {
        if (graphics) {
            BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = LONG(pc->vga.width()); info.bmiHeader.biHeight = -LONG(pc->vga.height());
            info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
            if (StretchDIBits(target, v.x, v.y, v.width, v.height, 0, 0, int(pc->vga.width()), int(pc->vga.height()),
                pixels.data(), &info, DIB_RGB_COLORS, SRCCOPY) == int(GDI_ERROR))
                throw std::runtime_error("Cannot present VGA graphics frame");
        } else StretchBlt(target, v.x, v.y, v.width, v.height, back, 0, 0, int(cols) * 8, 400, SRCCOPY);
    }
}
void execute(HWND hwnd) {
    executionTiming.run(*pc, fullSpeed);
    if (pc->rebootRequested) {
        if (pc->hard) pc->hard->flush();
        pc->boot(pc->floppy ? 0 : 0x80);
        executionTiming.reset(*pc);
    }
    if (!pc->notice.empty()) {
        auto text = wide(pc->notice); pc->notice.clear();
        MessageBoxW(hwnd, text.c_str(), L"Firmware notice", MB_OK | MB_ICONWARNING);
    }
}
void command(HWND hwnd, int id) {
    switch (id) {
    case LoadFloppy: {
        auto p = choose(hwnd, false);
        if (!p.empty()) {
            pc->floppy = std::make_unique<Disk>(p, true, true);
            if (preferences) preferences->floppy(pc->floppy->path);
        }
        break;
    }
    case EjectFloppy:
        pc->floppy.reset();
        if (preferences) preferences->floppy({});
        break;
    case NewHard: case LoadHard: {
        if (running) { MessageBoxW(hwnd, L"Stop the machine before replacing the hard disk (Machine > Stop).", L"Hard disk", MB_OK); break; }
        auto p = choose(hwnd, id == NewHard);
        if (!p.empty()) { if (id == NewHard) Disk::create(p); pc->hard = std::make_unique<Disk>(p, false, false); } break;
    }
    case BootA: case BootC: case CtrlAltDel:
        releaseMouse(hwnd); releaseKeyboard();
        pc->boot(id == BootA || (id == CtrlAltDel && pc->floppy) ? 0 : 0x80);
        executionTiming.reset(*pc);
        running = true; break;
    case Reset: releaseMouse(hwnd); releaseKeyboard(); running = false; if (pc->hard) pc->hard->flush(); break;
    case Cpu8088: case Cpu286: case Cpu386:
        if (running) { MessageBoxW(hwnd, L"Stop the machine before changing the CPU (Machine > Stop).", L"CPU", MB_OK); break; }
        pc->setModel(id == Cpu386 ? CpuModel::I386 : id == Cpu286 ? CpuModel::I286 : CpuModel::I8088);
        if (!CheckMenuRadioItem(GetMenu(hwnd), Cpu8088, Cpu386, id, MF_BYCOMMAND))
            throw std::runtime_error("Cannot update CPU menu");
        if (preferences) preferences->cpu(pc->cpu.model);
        break;
    case FullSpeed:
        fullSpeed = !fullSpeed;
        if (CheckMenuItem(GetMenu(hwnd), FullSpeed, MF_BYCOMMAND | (fullSpeed ? MF_CHECKED : MF_UNCHECKED)) == DWORD(-1))
            throw std::runtime_error("Cannot update execution speed menu");
        if (preferences) preferences->fullSpeed(fullSpeed);
        break;
    case Original: original(hwnd); break;
    case Maximize: ShowWindow(hwnd, SW_MAXIMIZE); break;
    case Quit: SendMessageW(hwnd, WM_CLOSE, 0, 0); break;
    }
    title(hwnd); InvalidateRect(hwnd, nullptr, FALSE);
}
LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
    try {
        switch (message) {
        case WM_COMMAND: command(hwnd, LOWORD(w)); return 0;
        case WM_TIMER:
            {
            if (running) execute(hwnd);
            if (!IsIconic(hwnd)) InvalidateRect(hwnd, nullptr, FALSE); return 0;
            }
        case WM_APP:
            if (running && fullSpeed) execute(hwnd);
            return 0;
        case WM_KEYDOWN: case WM_SYSKEYDOWN: {
            if (!running) return 0;
            bool ctrl = GetKeyState(VK_CONTROL) < 0, alt = GetKeyState(VK_MENU) < 0;
            if (mouseCaptured && (w == VK_RCONTROL || (w == VK_CONTROL && (l & (LPARAM(1) << 24))))) {
                releaseMouse(hwnd); releaseKeyboard(); title(hwnd); return 0;
            }
            if (w == VK_DELETE && ctrl && alt) { command(hwnd, CtrlAltDel); return 0; }
            BYTE state[256]{}; GetKeyboardState(state);
            WORD character = 0; unsigned scan = (unsigned(l) >> 16) & 255;
            int converted = ToAscii(UINT(w), scan, state, &character, 0);
            uint8_t ascii = converted == 1 ? uint8_t(character) : 0;
            if (w == VK_RETURN) ascii = 13;
            if (w == VK_BACK) ascii = 8;
            if (w == VK_ESCAPE) ascii = 27;
            if (w >= VK_F1 && w <= VK_F10) scan = 0x3b + unsigned(w - VK_F1);
            pressedKeys[scan & 127] = true; pc->key(uint8_t(scan), ascii); return 0;
        }
        case WM_KEYUP: case WM_SYSKEYUP: {
            unsigned scan = (unsigned(l) >> 16) & 127;
            if (pressedKeys[scan] && running) pc->key(uint8_t(scan | 128), 0);
            pressedKeys[scan] = false;
            return 0;
        }
        case WM_MOUSEMOVE: case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_RBUTTONDOWN: case WM_RBUTTONUP: {
            if (!running) return 0;
            RECT rect{}; GetClientRect(hwnd, &rect);
            auto v = viewport(rect.right, rect.bottom, int(pc->vga.width()), int(pc->vga.height()));
            int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
            if (!mouseCaptured) {
                if (message != WM_LBUTTONDOWN || !pc->serialMouse.active() || x < v.x || y < v.y
                    || x >= v.x + v.width || y >= v.y + v.height) return 0;
                SetFocus(hwnd);
                if (GetFocus() != hwnd) throw std::runtime_error("Cannot focus the mouse capture window");
                SetCapture(hwnd);
                if (GetCapture() != hwnd) throw std::runtime_error("Cannot capture mouse input");
                mouseCaptured = true; mouseFractionX = mouseFractionY = 0;
                ShowCursor(FALSE); centerMouse(hwnd); title(hwnd);
            } else if (message == WM_MOUSEMOVE && v.width && v.height) {
                mouseFractionX += double(x - rect.right / 2) * pc->vga.width() / v.width;
                mouseFractionY += double(y - rect.bottom / 2) * pc->vga.height() / v.height;
                int dx = int(mouseFractionX), dy = int(mouseFractionY);
                mouseFractionX -= dx; mouseFractionY -= dy;
                pc->serialMouse.motion(dx, dy, uint8_t(((w & MK_LBUTTON) ? 1 : 0) | ((w & MK_RBUTTON) ? 2 : 0)), pc->clock);
                if (x != rect.right / 2 || y != rect.bottom / 2) centerMouse(hwnd);
                return 0;
            }
            pc->serialMouse.motion(0, 0, uint8_t(((w & MK_LBUTTON) ? 1 : 0) | ((w & MK_RBUTTON) ? 2 : 0)), pc->clock);
            return 0;
        }
        case WM_CAPTURECHANGED: releaseMouse(hwnd); title(hwnd); return 0;
        case WM_KILLFOCUS: releaseMouse(hwnd); releaseKeyboard(); title(hwnd); return 0;
        case WM_SIZE:
            if (mouseCaptured) { if (w == SIZE_MINIMIZED) releaseMouse(hwnd); else centerMouse(hwnd); }
            InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: {
            PAINTSTRUCT paint{}; auto dc = BeginPaint(hwnd, &paint); RECT client{}; GetClientRect(hwnd, &client);
            try { render(dc, client.right, client.bottom); }
            catch (...) { EndPaint(hwnd, &paint); throw; }
            EndPaint(hwnd, &paint); return 0;
        }
        case WM_CLOSE: releaseMouse(hwnd); if (pc->hard) pc->hard->flush(); DestroyWindow(hwnd); return 0;
        case WM_DESTROY: KillTimer(hwnd, 1); PostQuitMessage(0); return 0;
        }
    } catch (const std::exception& e) {
        releaseMouse(hwnd); running = false; title(hwnd);
        MessageBoxW(hwnd, wide(e.what()).c_str(), L"Asm86 - machine stopped", MB_OK | MB_ICONERROR); return 0;
    }
    return DefWindowProcW(hwnd, message, w, l);
}
BOOL processMessage(HWND hwnd) {
    MSG message{};
    if (running && fullSpeed) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2);
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) return FALSE;
            TranslateMessage(&message); DispatchMessageW(&message);
            if (!running || !fullSpeed) return TRUE;
            if (std::chrono::steady_clock::now() >= deadline) break;
        }
        if (running && fullSpeed) SendMessageW(hwnd, WM_APP, 0, 0);
        return TRUE;
    }
    auto result = GetMessageW(&message, nullptr, 0, 0);
    if (result > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    return result;
}
void tapKey(uint8_t scan, uint8_t ascii) {
    pc->key(scan, ascii); pc->key(scan | 0x80, 0);
}
void namedKey(const std::string& value) {
    if (value == "ENTER") tapKey(0x1c, 13);
    else if (value == "ESC") tapKey(1, 27);
    else if (value == "SPACE") tapKey(0x39, 32);
    else if (value == "TAB") tapKey(0x0f, 9);
    else if (value == "ALT_DOWN" || value == "ALT_UP") {
        bool down = value == "ALT_DOWN";
        pc->key(down ? 0x38 : 0xb8, 0);
    }
    else if (value == "UP") tapKey(0x48, 0);
    else if (value == "DOWN") tapKey(0x50, 0);
    else if (value == "LEFT") tapKey(0x4b, 0);
    else if (value == "RIGHT") tapKey(0x4d, 0);
    else if (value.size() >= 2 && value[0] == 'F') {
        int n = std::stoi(value.substr(1)); if (n < 1 || n > 10) throw std::runtime_error("Expected F1..F10");
        tapKey(uint8_t(0x3a + n), 0);
    } else throw std::runtime_error("Unknown scripted key: " + value);
}
int headless(const std::filesystem::path& script) {
    std::ifstream stream(script); if (!stream) throw std::runtime_error("Cannot open headless script");
    std::string line; unsigned lineNumber = 0;
    while (std::getline(stream, line)) {
        ++lineNumber; if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty() || line[0] == '#') continue;
        auto split = line.find(' '); auto op = line.substr(0, split);
        auto arg = split == std::string::npos ? std::string() : line.substr(split + 1);
        if (op == "run") {
            uint64_t count = std::stoull(arg);
            while (count) { auto n = unsigned(std::min<uint64_t>(count, 100000)); pc->run(n); count -= n; if (pc->rebootRequested) pc->boot(pc->floppy ? 0 : 0x80); }
        } else if (op == "realtime") {
            std::istringstream input(arg); int milliseconds = 0; std::string speed, extra;
            if (!(input >> milliseconds >> speed) || milliseconds < 0 || (input >> extra) || (speed != "normal" && speed != "full"))
                throw std::runtime_error("Expected realtime <milliseconds> <normal|full>");
            ExecutionTiming timing; timing.reset(*pc);
            const auto started = ExecutionTiming::HostClock::now(), deadline = started + std::chrono::milliseconds(milliseconds);
            const auto beforeClock = pc->clock;
            while (ExecutionTiming::HostClock::now() < deadline) {
                auto remaining = deadline - ExecutionTiming::HostClock::now();
                if (remaining <= ExecutionTiming::HostClock::duration::zero()) break;
                timing.run(*pc, speed == "full", std::min(remaining,
                    std::chrono::duration_cast<ExecutionTiming::HostClock::duration>(std::chrono::milliseconds(8))));
                if (pc->rebootRequested) { pc->boot(pc->floppy ? 0 : 0x80); timing.reset(*pc); }
                if (speed == "normal") Sleep(1);
            }
            std::cout << "Realtime " << speed << ": host="
                << std::chrono::duration<double>(ExecutionTiming::HostClock::now() - started).count()
                << "s guest=" << (pc->clock - beforeClock) / ExecutionTiming::PitHz << "s\n";
        } else if (op == "wait") {
            uint64_t count = 0;
            while (pc->text().find(arg) == std::string::npos && count < 1000000000) {
                pc->run(10000); count += 10000;
                if (pc->rebootRequested) pc->boot(pc->floppy ? 0 : 0x80);
            }
            if (count >= 1000000000) throw std::runtime_error("Script line " + std::to_string(lineNumber) + ": timed out waiting for: " + arg);
        } else if (op == "dump") {
            std::ofstream out(std::filesystem::u8path(arg), std::ios::binary);
            out.write(reinterpret_cast<const char*>(pc->cpu.mem.data()), std::streamsize(pc->cpu.mem.size()));
            if (!out) throw std::runtime_error("Cannot save diagnostic memory");
        } else if (op == "state") {
            std::cout << "CS:IP " << std::hex << pc->cpu.s[CS] << ':' << pc->cpu.ip << " flags=" << pc->cpu.flags
                << " msw=" << pc->cpu.msw << " cpl=" << pc->cpu.cpl;
            for (auto v : pc->cpu.r) std::cout << ' ' << v;
            std::cout << " code:";
            auto cr2 = pc->cpu.cr2;
            for (int i = 0; i < 24; ++i) {
                auto off = pc->cpu.model == CpuModel::I386 ? pc->cpu.ip + i : uint16_t(pc->cpu.ip + i);
                try { std::cout << ' ' << unsigned(pc->cpu.rbS(CS, off)); }
                catch (const CpuFault& fault) { std::cout << " [memory fault " << unsigned(fault.vector) << ']'; break; }
            }
            pc->cpu.cr2 = cr2;
            std::cout << std::dec << " steps=" << pc->instructions << " video=" << unsigned(pc->vga.mode)
                << " COM1-mouse=" << pc->serialMouse.active() << '\n';
            if (pc->cpu.model == CpuModel::I386) {
                std::cout << std::hex << "386 EFLAGS=" << pc->cpu.eflags() << " CR2=" << pc->cpu.cr2 << " CR3=" << pc->cpu.cr3;
                for (int i = 0; i < 8; ++i) std::cout << ' ' << pc->cpu.r32(i);
                std::cout << " GDT=" << pc->cpu.gdtr.base << ':' << pc->cpu.gdtr.limit
                    << " LDT=" << pc->cpu.ldtr.base << ':' << pc->cpu.ldtr.limit
                    << " IDT=" << pc->cpu.idtr.base << ':' << pc->cpu.idtr.limit;
                std::cout << std::dec << '\n';
            }
        } else if (op == "expect") {
            if (pc->text().find(arg) == std::string::npos) throw std::runtime_error("Screen assertion failed: " + arg);
        } else if (op == "key") namedKey(arg);
        else if (op == "type") {
            for (unsigned char ch : arg) {
                SHORT vk = VkKeyScanA(char(ch)); unsigned scan = vk == -1 ? 0 : MapVirtualKeyW(uint8_t(vk), MAPVK_VK_TO_VSC);
                if (!scan || scan > 0x7f) throw std::runtime_error("Cannot map scripted character to a keyboard scan code");
                if (vk & 0x100) pc->key(0x2a, 0);
                if (vk & 0x200) pc->key(0x1d, 0);
                if (vk & 0x400) pc->key(0x38, 0);
                tapKey(uint8_t(scan), ch);
                if (vk & 0x400) pc->key(0xb8, 0);
                if (vk & 0x200) pc->key(0x9d, 0);
                if (vk & 0x100) pc->key(0xaa, 0);
                pc->run(50000);
            }
        } else if (op == "mouse") {
            std::istringstream input(arg);
            int dx, dy, buttons;
            std::string extra;
            if (!(input >> dx >> dy >> buttons) || buttons < 0 || buttons > 3 || (input >> extra))
                throw std::runtime_error("Script line " + std::to_string(lineNumber) + ": expected mouse <dx> <dy> <buttons 0..3>");
            pc->serialMouse.motion(dx, dy, uint8_t(buttons), pc->clock);
        } else if (op == "mount") pc->floppy = std::make_unique<Disk>(std::filesystem::u8path(arg), true, true);
        else if (op == "eject") pc->floppy.reset();
        else if (op == "boot") pc->boot(arg == "c" ? 0x80 : 0);
        else if (op == "screen") {
            std::ofstream out(std::filesystem::u8path(arg)); out << pc->text();
            if (!out) throw std::runtime_error("Cannot save screen text");
        } else if (op == "frame") {
            if (!pc->vga.graphics()) throw std::runtime_error("A graphics frame requires a graphics video mode");
            unsigned width = pc->vga.width(), height = pc->vga.height();
            BITMAPFILEHEADER file{}; BITMAPINFOHEADER info{};
            file.bfType = 0x4d42; file.bfOffBits = sizeof(file) + sizeof(info); file.bfSize = file.bfOffBits + width * height * 4;
            info.biSize = sizeof(info); info.biWidth = LONG(width); info.biHeight = -LONG(height);
            info.biPlanes = 1; info.biBitCount = 32; info.biCompression = BI_RGB;
            std::vector<uint32_t> pixels(width * height);
            if (!pc->vga.blanked())             for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
                auto color = pc->vga.pixel(x, y);
                pixels[y * width + x] = pc->vga.color(pc->vga.indexed256() ? color : pc->vga.paletteIndex(color));
            }
            std::ofstream out(std::filesystem::u8path(arg), std::ios::binary);
            out.write(reinterpret_cast<const char*>(&file), sizeof(file)); out.write(reinterpret_cast<const char*>(&info), sizeof(info));
            out.write(reinterpret_cast<const char*>(pixels.data()), std::streamsize(pixels.size() * sizeof(uint32_t)));
            if (!out) throw std::runtime_error("Cannot save graphics frame");
        } else throw std::runtime_error("Unknown script operation: " + op);
    }
    if (pc->hard) pc->hard->flush();
    std::cout << pc->text() << "\nHeadless script passed\n"; return 0;
}
int application(int argc, wchar_t** argv) {
    pc = std::make_unique<Pc>();
    std::filesystem::path script; bool start = false, uiTest = false;
    bool cpuSpecified = false, speedSpecified = false, floppySpecified = false, experimental386 = false;
    for (int i = 1; i < argc; ++i) {
        std::wstring option = argv[i];
        if (option == L"--ui-test") { uiTest = true; continue; }
        if (option == L"--experimental-386") { experimental386 = true; continue; }
        if (option == L"--full-speed" || option == L"--normal-speed") {
            fullSpeed = option == L"--full-speed"; speedSpecified = true; continue;
        }
        if (i + 1 >= argc) throw std::runtime_error("Missing command-line option value");
        std::filesystem::path value = argv[++i];
        if (option == L"--floppy") { pc->floppy = std::make_unique<Disk>(value, true, true); floppySpecified = true; }
        else if (option == L"--hard") pc->hard = std::make_unique<Disk>(value, false, false);
        else if (option == L"--create-hard") { Disk::create(value); pc->hard = std::make_unique<Disk>(value, false, false); }
        else if (option == L"--cpu") {
            if (value != L"8088" && value != L"286" && value != L"386") throw std::runtime_error("--cpu must be 8088, 286 or 386");
            pc->setModel(value == L"386" ? CpuModel::I386 : value == L"286" ? CpuModel::I286 : CpuModel::I8088);
            cpuSpecified = true;
        }
        else if (option == L"--boot") {
            if (value != L"a" && value != L"c") throw std::runtime_error("--boot must be a or c");
            pc->bootDrive = value == L"c" ? 0x80 : 0; start = true;
        } else if (option == L"--headless") script = value;
        else throw std::runtime_error("Unknown command-line option");
    }
    if (experimental386) {
        if (script.empty() || uiTest || cpuSpecified)
            throw std::runtime_error("--experimental-386 requires --headless and cannot be combined with --cpu or --ui-test");
        pc->setModel(CpuModel::I386);
        pc->cpu.resetSignal = {};
        pc->cpu.onFault = [count = 0u](CpuFault fault, uint32_t address) mutable {
            if (fault.vector != 6 || count >= 32) return;
            ++count;
            auto& c = pc->cpu;
            std::cerr << "386 #UD at " << std::hex << c.s[CS] << ':' << c.ip
                << " CR0=" << c.msw << " bytes:";
            for (unsigned i = 0; i < 15; ++i) {
                auto physical = address + i;
                if (c.msw & 0x80000000u) {
                    auto pde = c.readDword((c.cr3 & 0xfffff000u) + (physical >> 22) * 4);
                    if (!(pde & 1)) { std::cerr << " [unmapped directory]"; break; }
                    auto pte = c.readDword((pde & 0xfffff000u) + ((physical >> 12) & 1023) * 4);
                    if (!(pte & 1)) { std::cerr << " [unmapped page]"; break; }
                    physical = (pte & 0xfffff000u) | (physical & 4095);
                }
                std::cerr << ' ' << unsigned(c.readPhysical(physical));
            }
            std::cerr << std::dec << '\n';
        };
    }
    if (!uiTest && script.empty()) {
        preferences = std::make_unique<Preferences>();
        if (!cpuSpecified) pc->setModel(preferences->cpu());
        if (!speedSpecified) fullSpeed = preferences->fullSpeed();
        if (!floppySpecified) {
            auto path = preferences->floppy();
            if (!path.empty()) {
                try { pc->floppy = std::make_unique<Disk>(path, true, true); }
                catch (const std::exception& e) {
                    auto message = L"Could not restore the remembered floppy:\n" + path.wstring() + L"\n\n" + wide(e.what())
                        + L"\n\nA: will remain empty. Insert another floppy or eject A: to clear the remembered path.";
                    MessageBoxW(nullptr, message.c_str(), L"Asm86 - remembered floppy unavailable", MB_OK | MB_ICONWARNING);
                }
            }
        }
        if (cpuSpecified) preferences->cpu(pc->cpu.model);
        if (speedSpecified) preferences->fullSpeed(fullSpeed);
        if (floppySpecified) preferences->floppy(pc->floppy->path);
    }
    if (start) { pc->boot(pc->bootDrive); running = true; }
    if (!script.empty()) return headless(script);
    auto instance = GetModuleHandleW(nullptr);
    SetProcessDPIAware();
    WNDCLASSW cls{}; cls.hInstance = instance; cls.lpfnWndProc = windowProc; cls.lpszClassName = L"Asm86Native";
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    if (!RegisterClassW(&cls)) throw std::runtime_error("Cannot register native window class");
    auto menu = CreateMenu(), disks = CreatePopupMenu(), machine = CreatePopupMenu(), view = CreatePopupMenu();
    AppendMenuW(disks, MF_STRING, LoadFloppy, L"Insert A: floppy (read-only)...");
    AppendMenuW(disks, MF_STRING, EjectFloppy, L"Eject A:");
    AppendMenuW(disks, MF_STRING, NewHard, L"Create C: hard disk (31.5 MiB)...");
    AppendMenuW(disks, MF_STRING, LoadHard, L"Open C: hard disk...");
    AppendMenuW(disks, MF_SEPARATOR, 0, nullptr); AppendMenuW(disks, MF_STRING, Quit, L"Exit");
    AppendMenuW(machine, MF_STRING, BootA, L"Boot / restart from A:");
    AppendMenuW(machine, MF_STRING, BootC, L"Boot / restart from C:");
    AppendMenuW(machine, MF_STRING, CtrlAltDel, L"Ctrl+Alt+Del");
    AppendMenuW(machine, MF_STRING, Reset, L"Stop");
    AppendMenuW(machine, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(machine, MF_STRING | (fullSpeed ? MF_CHECKED : MF_UNCHECKED), FullSpeed, L"Full speed (real-time timers)");
    AppendMenuW(machine, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I8088 ? MF_CHECKED : MF_UNCHECKED), Cpu8088, L"CPU: 8088");
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I286 ? MF_CHECKED : MF_UNCHECKED), Cpu286, L"CPU: 80286 / AT");
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I386 ? MF_CHECKED : MF_UNCHECKED), Cpu386, L"CPU: 80386 / AT (experimental)");
    AppendMenuW(view, MF_STRING, Original, L"Original size");
    AppendMenuW(view, MF_STRING, Maximize, L"Maximize");
    AppendMenuW(menu, MF_POPUP, UINT_PTR(disks), L"Disks");
    AppendMenuW(menu, MF_POPUP, UINT_PTR(machine), L"Machine");
    AppendMenuW(menu, MF_POPUP, UINT_PTR(view), L"View");
    auto hwnd = CreateWindowW(cls.lpszClassName, L"Asm86 native", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
        680, 460, nullptr, menu, instance, nullptr);
    if (!hwnd) throw std::runtime_error("Cannot create native window");
    auto dc = GetDC(hwnd); back = CreateCompatibleDC(dc); bitmap = CreateCompatibleBitmap(dc, 640, 400); ReleaseDC(hwnd, dc);
    if (!back || !bitmap) throw std::runtime_error("Cannot create screen back buffer");
    auto oldBitmap = SelectObject(back, bitmap);
    font = CreateFontW(16, 8, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_TT_PRECIS,
        CLIP_DEFAULT_PRECIS, NONANTIALIASED_QUALITY, FIXED_PITCH, L"Consolas");
    if (!font) throw std::runtime_error("Cannot create DOS display font");
    auto oldFont = SelectObject(back, font);
    for (unsigned i = 0; i < 256; ++i) {
        char ch = char(i); MultiByteToWideChar(437, 0, &ch, 1, &glyphs[i], 1); if (i == 0) glyphs[i] = L' ';
    }
    if (!running) { pc->cpu.ww(0x40, 0x4a, 80); pc->cpu.wb(0x40, 0x60, 0x20); }
    original(hwnd); title(hwnd); ShowWindow(hwnd, SW_SHOW); UpdateWindow(hwnd);
    executionTiming.reset(*pc);
    if (!SetTimer(hwnd, 1, 16, nullptr)) throw std::runtime_error("Cannot start execution timer");
    if (uiTest) {
        TEXTMETRICW metrics{};
        if (!GetTextMetricsW(back, &metrics)) throw std::runtime_error("Cannot measure DOS display font");
        std::cout << "Text cell metrics: " << metrics.tmAveCharWidth << 'x' << metrics.tmHeight << '\n';
        if (metrics.tmHeight > 16 || metrics.tmAveCharWidth > 8)
            throw std::runtime_error("DOS font exceeds the 8x16 cell and will be clipped");
        for (unsigned i = 0; i < 2000; ++i) pc->cpu.ww(0xb800, uint16_t(i * 2), 0x1f20);
        for (unsigned i = 32; i < 127; ++i) pc->cpu.wb(0xb800, uint16_t((i - 32) * 2), uint8_t(i));
        pc->cpu.ww(0x40, 0x60, 0x2000);
        RECT rect{}; GetClientRect(hwnd, &rect);
        if (rect.right != 640 || rect.bottom != 400) throw std::runtime_error("Original-size client area is not 640x400");
        auto reference = CreateCompatibleDC(back); auto referenceBitmap = CreateCompatibleBitmap(back, 32, 48);
        if (!reference || !referenceBitmap) throw std::runtime_error("Cannot create unclipped glyph reference");
        auto referenceOldBitmap = SelectObject(reference, referenceBitmap), referenceOldFont = SelectObject(reference, font);
        SetTextColor(reference, colors[15]); SetBkColor(reference, colors[1]);
        auto originalDc = GetDC(hwnd); render(originalDc, 640, 400); ReleaseDC(hwnd, originalDc);
        bool complete = true;
        for (unsigned i = 32; i < 127; ++i) {
            RECT area{0,0,32,48};
            ExtTextOutW(reference, 0, 0, ETO_OPAQUE, &area, &glyphs[i], 1, nullptr);
            int cellX = int((i - 32) % 80) * 8, cellY = int((i - 32) / 80) * 16;
            for (int y = 0; y < 48; ++y) for (int x = 0; x < 32; ++x) {
                auto expected = GetPixel(reference, x, y);
                if (x < 8 && y < 16) {
                    if (GetPixel(back, cellX + x, cellY + y) != expected) complete = false;
                } else if (expected == colors[15]) complete = false;
            }
        }
        SelectObject(reference, referenceOldFont); SelectObject(reference, referenceOldBitmap);
        DeleteObject(referenceBitmap); DeleteDC(reference);
        if (!complete) throw std::runtime_error("Rendered ASCII text differs from complete, unclipped glyphs");
        ShowWindow(hwnd, SW_MAXIMIZE); GetClientRect(hwnd, &rect);
        auto v = viewport(rect.right, rect.bottom);
        if (!IsZoomed(hwnd) || v.width <= 640 || v.height <= 400) throw std::runtime_error("Maximized content did not grow");
        auto testDc = GetDC(hwnd); render(testDc, rect.right, rect.bottom);
        bool pixelsCorrect = GetPixel(testDc, v.x + v.width - 2, v.y + v.height - 2) == colors[1];
        bool glyphVisible = false;
        for (int y = 0; y < 16; ++y) for (int x = 0; x < 8; ++x) {
            if (GetPixel(back, 8 + x, y) != colors[15]) continue;
            int sx = v.x + int((8 + x + 0.5) * v.width / 640);
            int sy = v.y + int((y + 0.5) * v.height / 400);
            if (GetPixel(testDc, sx, sy) == colors[15]) glyphVisible = true;
        }
        ReleaseDC(hwnd, testDc);
        if (!pixelsCorrect || !glyphVisible) throw std::runtime_error("Scaled text/background pixel verification failed");
        std::cout << "Maximized viewport: " << v.width << 'x' << v.height << '\n';
        original(hwnd); GetClientRect(hwnd, &rect);
        if (IsZoomed(hwnd) || rect.right != 640 || rect.bottom != 400) throw std::runtime_error("Original-size restore failed");
        std::cout << "Native UI maximize / scaled render / original-size checks passed\n";
        for (auto mode : {0x13, 0x12}) {
            pc->cpu.r[AX] = uint16_t(mode); pc->cpu.trap(0x10);
            for (unsigned y = 0; y < 16; ++y) for (unsigned x = 0; x < 16; ++x) {
                pc->vga.pixel(x, y, 4);
                pc->vga.pixel(pc->vga.width() - 1 - x, pc->vga.height() - 1 - y, 2);
            }
            auto checkGraphics = [&]() {
                GetClientRect(hwnd, &rect);
                auto area = viewport(rect.right, rect.bottom, int(pc->vga.width()), int(pc->vga.height()));
                auto target = GetDC(hwnd); render(target, rect.right, rect.bottom);
                bool correct = GetPixel(target, area.x + 2, area.y + 2) == colors[4]
                    && GetPixel(target, area.x + area.width - 3, area.y + area.height - 3) == colors[2];
                if (area.x > 0) correct = correct && GetPixel(target, 0, rect.bottom / 2) == RGB(0,0,0);
                if (area.y > 0) correct = correct && GetPixel(target, rect.right / 2, 0) == RGB(0,0,0);
                int saved = SaveDC(target);
                if (!saved) throw std::runtime_error("Cannot save graphics clipping test DC");
                IntersectClipRect(target, 0, 0, 1, 1);
                render(target, rect.right, rect.bottom);
                RestoreDC(target, saved);
                ReleaseDC(hwnd, target);
                if (!correct) throw std::runtime_error("VGA graphics pixel/color/letterbox presentation failed");
            };
            original(hwnd); GetClientRect(hwnd, &rect);
            if (rect.right != LONG(pc->vga.width()) || rect.bottom != LONG(pc->vga.height()))
                throw std::runtime_error("Graphics original-size client area is incorrect");
            checkGraphics(); ShowWindow(hwnd, SW_MAXIMIZE); checkGraphics();
        }
        pc->cpu.r[AX] = 3; pc->cpu.trap(0x10); original(hwnd);
        std::cout << "VGA 320x200 / 640x480 original-size / maximized pixel checks passed\n";
        auto savedPc = std::move(pc);
        pc = std::make_unique<Pc>();
        pc->cpu.reset(); pc->cpu.s[CS] = 0; pc->cpu.ip = 0x500; pc->cpu.flags = 0xf002;
        pc->cpu.mem[0x500] = 0xeb; pc->cpu.mem[0x501] = 0xfe;
        executionTiming.reset(*pc);
        running = true;
        if (fullSpeed) SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
        auto measure = [&]() {
            auto startTime = std::chrono::steady_clock::now(), deadline = startTime + std::chrono::milliseconds(120);
            auto before = pc->instructions;
            do {
                if (processMessage(hwnd) <= 0) throw std::runtime_error("Execution speed test message loop stopped");
            } while (std::chrono::steady_clock::now() < deadline);
            if (std::abs(pc->clock - executionTiming.target(ExecutionTiming::HostClock::now())) > ExecutionTiming::PitHz * 0.05)
                throw std::runtime_error("Window execution let device time drift more than 50ms from real time");
            return double(pc->instructions - before) / std::chrono::duration<double>(std::chrono::steady_clock::now() - startTime).count();
        };
        auto normalRate = measure();
        auto beforeToggle = pc->instructions;
        SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
        wchar_t caption[512]{}; GetWindowTextW(hwnd, caption, int(std::size(caption)));
        if (!(GetMenuState(menu, FullSpeed, MF_BYCOMMAND) & MF_CHECKED) || !std::wcsstr(caption, L"Full speed")
            || pc->instructions != beforeToggle)
            throw std::runtime_error("Full-speed toggle did not preserve machine state or update the UI");
        auto fullRate = measure();
        if (normalRate <= 0 || fullRate < normalRate * 4)
            throw std::runtime_error("Full-speed execution is still throttled");
        if (!PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, LPARAM(0x1c << 16)))
            throw std::runtime_error("Cannot post UI test keyboard input");
        InvalidateRect(hwnd, nullptr, FALSE);
        auto inputDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
        while ((!pc->cpu.in(0x64) || GetUpdateRect(hwnd, nullptr, FALSE))
            && std::chrono::steady_clock::now() < inputDeadline) {
            if (processMessage(hwnd) <= 0) throw std::runtime_error("Full-speed input test message loop stopped");
        }
        if (pc->cpu.in(0x60) != 0x1c || GetUpdateRect(hwnd, nullptr, FALSE))
            throw std::runtime_error("Full-speed execution blocked keyboard input or painting");
        if (!PostMessageW(hwnd, WM_COMMAND, FullSpeed, 0))
            throw std::runtime_error("Cannot post execution speed toggle");
        auto restoreDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
        while (fullSpeed && std::chrono::steady_clock::now() < restoreDeadline) {
            if (processMessage(hwnd) <= 0) throw std::runtime_error("Speed restore test message loop stopped");
        }
        if (fullSpeed) throw std::runtime_error("Full-speed execution blocked the speed menu command");
        auto restoredRate = measure();
        GetWindowTextW(hwnd, caption, int(std::size(caption)));
        if ((GetMenuState(menu, FullSpeed, MF_BYCOMMAND) & MF_CHECKED) || !std::wcsstr(caption, L"Normal speed")
            || restoredRate <= 0 || restoredRate > fullRate / 4)
            throw std::runtime_error("Normal-speed throttling was not restored");
        pc->cpu.out(0x3fb, 0x80); pc->cpu.out(0x3f8, 96); pc->cpu.out(0x3f9, 0);
        pc->cpu.out(0x3fb, 2); pc->cpu.out(0x3fc, 3);
        releaseKeyboard();
        while (pc->cpu.in(0x64) & 1) pc->cpu.in(0x60);
        POINT savedCursor{};
        if (!GetCursorPos(&savedCursor)) throw std::runtime_error("Cannot save the mouse test cursor position");
        auto capture = [&]() {
            GetClientRect(hwnd, &rect);
            SendMessageW(hwnd, WM_LBUTTONDOWN, 0, MAKELPARAM(rect.right / 2, rect.bottom / 2));
            GetWindowTextW(hwnd, caption, int(std::size(caption)));
            if (!mouseCaptured || GetCapture() != hwnd || GetFocus() != hwnd || !std::wcsstr(caption, L"Right Ctrl"))
                throw std::runtime_error("Clicking the active serial-mouse display did not capture and focus it");
        };
        try {
            capture();
            SendMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, LPARAM(0x1d << 16));
            if (!mouseCaptured) throw std::runtime_error("Left Ctrl incorrectly released mouse capture");
            SendMessageW(hwnd, WM_SYSKEYDOWN, VK_MENU, LPARAM(0x38 << 16));
            if (!mouseCaptured) throw std::runtime_error("Ctrl+Alt must remain available to the guest");
            SendMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
            if (mouseCaptured || GetCapture() == hwnd)
                throw std::runtime_error("Right Ctrl did not release mouse capture");
            for (auto scan : {0x1d, 0x38, 0x9d, 0xb8}) {
                if (pc->cpu.in(0x60) != scan)
                    throw std::runtime_error("Mouse release did not release held guest modifiers");
            }
            SendMessageW(hwnd, WM_KEYUP, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
            if (pc->cpu.in(0x64) & 1) throw std::runtime_error("The release shortcut leaked a Ctrl key to the guest");
            capture();
            SendMessageW(hwnd, WM_KILLFOCUS, 0, 0);
            if (mouseCaptured || GetCapture() == hwnd || !running)
                throw std::runtime_error("Losing focus must release capture without stopping execution");
        } catch (...) {
            releaseMouse(hwnd); SetCursorPos(savedCursor.x, savedCursor.y); throw;
        }
        if (!SetCursorPos(savedCursor.x, savedCursor.y)) throw std::runtime_error("Cannot restore the mouse test cursor position");
        std::cout << "Right-Ctrl release / left-Ctrl passthrough / focus-loss capture checks passed\n";

        WNDCLASSW backgroundClass{}; backgroundClass.hInstance = instance; backgroundClass.lpszClassName = L"Asm86BackgroundTest";
        backgroundClass.lpfnWndProc = [](HWND window, UINT message, WPARAM w, LPARAM l) -> LRESULT {
            if (message == WM_APP) {
                if (!PostMessageW(window, WM_APP, 0, 0)) PostQuitMessage(1);
                return 0;
            }
            return DefWindowProcW(window, message, w, l);
        };
        if (!RegisterClassW(&backgroundClass)) throw std::runtime_error("Cannot register the background execution test window");
        auto backgroundWindow = CreateWindowW(backgroundClass.lpszClassName, L"Asm86 background test",
            WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 180, 90, nullptr, nullptr, instance, nullptr);
        if (!backgroundWindow) throw std::runtime_error("Cannot create the background execution test window");
        try {
            ShowWindow(backgroundWindow, SW_SHOWNOACTIVATE);
            for (bool speed : {false, true}) {
                if (fullSpeed != speed) SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
                SetFocus(backgroundWindow);
                if (GetFocus() != backgroundWindow || measure() <= 0 || !running)
                    throw std::runtime_error("The virtual CPU stopped while its window was unfocused");
                ShowWindow(hwnd, SW_MINIMIZE);
                if (!IsIconic(hwnd) || measure() <= 0 || !running)
                    throw std::runtime_error("The virtual CPU stopped while its window was minimized");
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            if (!PostMessageW(backgroundWindow, WM_APP, 0, 0)) throw std::runtime_error("Cannot start busy-queue execution test");
            auto beforeBusyQueue = pc->instructions;
            if (processMessage(hwnd) <= 0) throw std::runtime_error("Busy-queue message processing stopped");
            MSG queued{};
            if (pc->instructions == beforeBusyQueue || !PeekMessageW(&queued, backgroundWindow, WM_APP, WM_APP, PM_REMOVE))
                throw std::runtime_error("Full-speed execution starved while messages remained continuously queued");
            auto beforeModalTick = pc->instructions;
            SendMessageW(hwnd, WM_TIMER, 1, 0);
            if (pc->instructions == beforeModalTick) throw std::runtime_error("Full-speed execution stopped inside timer-driven modal loops");
        } catch (...) {
            DestroyWindow(backgroundWindow); throw;
        }
        DestroyWindow(backgroundWindow); SetFocus(hwnd);
        if (fullSpeed) SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
        std::cout << "Normal/full-speed unfocused / minimized / continuously busy queue checks passed\n";
        SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
        SendMessageW(hwnd, WM_COMMAND, Reset, 0);
        auto stoppedAt = pc->instructions;
        SendMessageW(hwnd, WM_APP, 0, 0); SendMessageW(hwnd, WM_TIMER, 1, 0);
        if (running || pc->instructions != stoppedAt) throw std::runtime_error("Full-speed machine did not stop");
        SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
        std::cout << "Execution speed (steps/s): normal=" << normalRate << " full=" << fullRate
            << " restored=" << restoredRate << "\nFull-speed toggle / input / paint / stop checks passed\n";
        for (auto selection : {Cpu286, Cpu386}) {
            SendMessageW(hwnd, WM_COMMAND, selection, 0);
            GetWindowTextW(hwnd, caption, int(std::size(caption)));
            if (pc->cpu.model != (selection == Cpu386 ? CpuModel::I386 : CpuModel::I286)
                || !(GetMenuState(menu, selection, MF_BYCOMMAND) & MF_CHECKED)
                || !std::wcsstr(caption, selection == Cpu386 ? L"80386" : L"80286"))
                throw std::runtime_error("AT CPU selection did not update the machine, title and menu");
            running = true;
            SendMessageW(hwnd, WM_KEYDOWN, VK_SHIFT, LPARAM(0x2a << 16));
            if (pc->cpu.in(0x60) != 0x2a) throw std::runtime_error("AT modifier make code was not delivered");
            SendMessageW(hwnd, WM_KEYUP, VK_SHIFT, LPARAM(0x2a << 16));
            if (pc->cpu.in(0x60) != 0xaa) throw std::runtime_error("AT modifier break code was not delivered");
            SendMessageW(hwnd, WM_KEYDOWN, 'A', LPARAM(0x1e << 16));
            if (pc->cpu.in(0x60) != 0x1e) throw std::runtime_error("AT key make code was not delivered");
            SendMessageW(hwnd, WM_KILLFOCUS, 0, 0);
            if (pc->cpu.in(0x60) != 0x9e || pc->cpu.in(0x64) & 1)
                throw std::runtime_error("Losing focus did not release held AT keys");
            SendMessageW(hwnd, WM_COMMAND, Reset, 0);
        }
        SendMessageW(hwnd, WM_COMMAND, Cpu8088, 0);
        if (pc->at() || !(GetMenuState(menu, Cpu8088, MF_BYCOMMAND) & MF_CHECKED))
            throw std::runtime_error("8088 CPU selection was not restored");
        running = true;
        SendMessageW(hwnd, WM_SYSKEYDOWN, VK_MENU, LPARAM(0x38 << 16));
        if (pc->cpu.in(0x60) != 0x38) throw std::runtime_error("XT Alt make code was not delivered to resident keyboard hooks");
        SendMessageW(hwnd, WM_KILLFOCUS, 0, 0);
        if (pc->cpu.in(0x60) != 0xb8 || pc->cpu.in(0x64) & 1)
            throw std::runtime_error("Losing focus did not release held XT modifiers");
        running = false;
        std::cout << "CPU selection / XT-AT make-break / focus-loss checks passed\n";
        std::array<std::filesystem::path, 2> resetImages{};
        auto removeResetImages = [&]() {
            pc->floppy.reset(); pc->hard.reset();
            for (const auto& path : resetImages) if (!path.empty()) std::filesystem::remove(path);
        };
        try {
            if (GetMenuState(menu, CtrlAltDel, MF_BYCOMMAND) == DWORD(-1))
                throw std::runtime_error("Ctrl+Alt+Del is missing from the Machine menu");
            auto temp = std::filesystem::temp_directory_path();
            for (unsigned i = 0; i < resetImages.size(); ++i) {
                wchar_t path[MAX_PATH]{};
                if (!GetTempFileNameW(temp.c_str(), L"as8", 0, path))
                    throw std::runtime_error("Cannot create reset-test disk image");
                resetImages[i] = path;
                std::ofstream image(resetImages[i], std::ios::binary);
                image.seekp((i == 0 ? 1008 * 512 : 160 * 1024) - 1); image.put(0);
                std::array<char, 512> sector{};
                sector[0] = char(0xeb); sector[1] = char(0xfe); sector[2] = char('C' + i);
                sector[510] = 0x55; sector[511] = char(0xaa);
                image.seekp(0); image.write(sector.data(), sector.size()); image.close();
                if (!image) throw std::runtime_error("Cannot write reset-test boot sector");
            }
            pc->hard = std::make_unique<Disk>(resetImages[0], false, false);
            auto savedSpeed = fullSpeed;
            for (auto model : {Cpu8088, Cpu286, Cpu386}) {
                SendMessageW(hwnd, WM_COMMAND, Reset, 0);
                SendMessageW(hwnd, WM_COMMAND, model, 0);
                auto expectedModel = model == Cpu386 ? CpuModel::I386 : model == Cpu286 ? CpuModel::I286 : CpuModel::I8088;
                pc->floppy = std::make_unique<Disk>(resetImages[1], true, true);
                SendMessageW(hwnd, WM_COMMAND, CtrlAltDel, 0);
                if (!running || pc->bootDrive != 0 || pc->cpu.rb(0, 0x7c02) != 'D'
                    || pc->cpu.model != expectedModel || fullSpeed != savedSpeed)
                    throw std::runtime_error("Ctrl+Alt+Del did not boot the inserted floppy while preserving CPU/speed");
                pc->floppy.reset();
                SendMessageW(hwnd, WM_COMMAND, CtrlAltDel, 0);
                if (!running || pc->bootDrive != 0x80 || pc->cpu.rb(0, 0x7c02) != 'C'
                    || pc->cpu.model != expectedModel || fullSpeed != savedSpeed)
                    throw std::runtime_error("Ctrl+Alt+Del did not restart from the hard disk while preserving CPU/speed");
            }
        } catch (...) { removeResetImages(); throw; }
        running = false; removeResetImages();
        std::cout << "Ctrl+Alt+Del menu / floppy-first / hard-disk fallback / CPU-speed preservation checks passed\n";
        pc = std::move(savedPc);
        DestroyWindow(hwnd);
    }
    BOOL result;
    while ((result = processMessage(hwnd)) > 0) {}
    SelectObject(back, oldFont); SelectObject(back, oldBitmap); DeleteObject(font); DeleteObject(bitmap); DeleteDC(back);
    if (result == -1) throw std::runtime_error("Windows message loop failed");
    return 0;
}
}
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    int argc = 0; auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    try {
        if (!argv) throw std::runtime_error("Cannot parse command line");
        int result = application(argc, argv); LocalFree(argv); return result;
    } catch (const std::exception& e) {
        if (argv) LocalFree(argv);
        std::cerr << "ERROR: " << e.what() << '\n';
        if (pc) std::cerr << "CS:IP " << std::hex << pc->cpu.s[CS] << ':' << pc->cpu.ip << std::dec << '\n' << pc->text();
        if (!std::wcsstr(GetCommandLineW(), L"--headless") && !std::wcsstr(GetCommandLineW(), L"--ui-test"))
            MessageBoxW(nullptr, wide(e.what()).c_str(), L"Asm86", MB_OK | MB_ICONERROR);
        return 1;
    }
}
