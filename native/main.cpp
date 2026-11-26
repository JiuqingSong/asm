#include "pc.h"
#include "display.h"
#include "preferences.h"
#include "timing.h"
#include <commdlg.h>
#include <shellapi.h>
#include <windowsx.h>
#include <chrono>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>

// Win32 前端与无界面脚本共用 Pc；模拟执行、输入、绘图由同一消息线程协调。
using namespace asm86;
namespace {
enum { LoadFloppy=101, EjectFloppy, LoadHard, NewHard, BootA, BootC, Reset, Original, Maximize, Quit, FullSpeed, Cpu8088, Cpu286, Cpu386, Cpu486, CtrlAltDel, LoadCdrom, EjectCdrom, NewHard126, NewHard504, StableTiming, LoadOverlay, DiscardOverlay, PauseResume, NewHard2048, NewHard8192, NewHard32768 };
std::unique_ptr<Pc> pc;
std::unique_ptr<Preferences> preferences;
ExecutionTiming executionTiming;
bool running = false;

// 执行故障只停止 CPU，保留诊断画面；poweredOn、running、paused 不能互相替代。
bool poweredOn = false;
bool paused = false;

std::function<bool()> confirmationDecision;

auto statsOrigin = ExecutionTiming::HostClock::now();
uint64_t statsInstructions = 0, statsDisk = 0, statsReads = 0, statsWrites = 0;
uint64_t activityReads = 0, activityWrites = 0;
double measuredMips = 0;
bool rightCtrlDown = false;
bool fullSpeed = false;
bool stableTiming = false;
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
    // 客体时间来自 PIT clock，实测 MIPS 来自宿主时间差；两者不是同一个计时指标。
    std::wstring value = pc->cpu.model == CpuModel::I486 ? L"Asm86 native - 80486DX / AT (experimental)"
        : pc->cpu.model == CpuModel::I386 ? L"Asm86 native - 80386 / AT (experimental)"
        : pc->at() ? L"Asm86 native - 80286 / AT" : L"Asm86 native - 8088";
    value += L" | A: " + (pc->floppy ? pc->floppy->path.filename().wstring() : L"(empty)");
    value += L" | C: " + (pc->hard ? pc->hard->path.filename().wstring() : L"(empty)");
    if (pc->hard && pc->hard->hasOverlay()) value += L" | Overlay: " + pc->hard->overlayPath().filename().wstring();
    if (pc->at()) value += L" | CD: " + (pc->cdrom.medium() ? pc->cdrom.medium()->path.filename().wstring() : L"(empty)");
    value += fullSpeed ? L" | Full speed" : pc->cpu.model == CpuModel::I486 && stableTiming ? L" | Normal speed (486 ~32 MIPS virtual)"
        : pc->cpu.model == CpuModel::I486 ? L" | Normal speed (486 ~8 MIPS)"
        : pc->cpu.model == CpuModel::I386 ? L" | Normal speed (386 ~4 MIPS)"
        : pc->at() ? L" | Normal speed (286 ~2 MIPS)" : L" | Normal speed (8088 ~0.33 MIPS)";
    if (mouseCaptured) value += L" | Mouse captured (Right Ctrl releases)";
    if (stableTiming && pc->cpu.model == CpuModel::I486) value += L" | Stable CPU timing";
    if (!poweredOn) value += L" | powered off";
    else if (paused) value += L" | paused";
    else if (!running) value += L" | stopped";
    std::wostringstream metrics;
    metrics << L" | Guest: " << uint64_t(pc->clock / ExecutionTiming::PitHz) << L"s | "
        << std::fixed << std::setprecision(1) << measuredMips << L" MIPS | Disk R+" << activityReads << L" W+" << activityWrites;
    value += metrics.str();
    if (!ModifyMenuW(GetMenu(hwnd), PauseResume, MF_BYCOMMAND | MF_STRING |
        (poweredOn && (running || paused) ? MF_ENABLED : MF_GRAYED), PauseResume, paused ? L"Resume" : L"Pause"))
        throw std::runtime_error("Cannot update pause menu");
    if (EnableMenuItem(GetMenu(hwnd), CtrlAltDel, MF_BYCOMMAND | (poweredOn ? MF_ENABLED : MF_GRAYED)) == -1)
        throw std::runtime_error("Cannot update restart menu");
    if (EnableMenuItem(GetMenu(hwnd), DiscardOverlay, MF_BYCOMMAND |
        (!poweredOn && pc->hard && pc->hard->hasOverlay() ? MF_ENABLED : MF_GRAYED)) == -1)
        throw std::runtime_error("Cannot update overlay menu");
    if (EnableMenuItem(GetMenu(hwnd), StableTiming, MF_BYCOMMAND | (pc->cpu.model == CpuModel::I486 ? MF_ENABLED : MF_GRAYED)) == -1)
        throw std::runtime_error("Cannot update CPU timing menu");
    if (!ModifyMenuW(GetMenu(hwnd), FullSpeed, MF_BYCOMMAND | MF_STRING | (fullSpeed ? MF_CHECKED : MF_UNCHECKED), FullSpeed,
        stableTiming && pc->cpu.model == CpuModel::I486 ? L"Full speed (stable CPU timers)" : L"Full speed (real-time timers)"))
        throw std::runtime_error("Cannot update execution speed menu");
    SetWindowTextW(hwnd, value.c_str());
}

void resetStats() {
    statsOrigin = ExecutionTiming::HostClock::now(); statsInstructions = pc->instructions;
    statsDisk = pc->hard ? pc->hard->identity : 0;
    statsReads = pc->hard ? pc->hard->readSectors : 0; statsWrites = pc->hard ? pc->hard->writtenSectors : 0;
    measuredMips = 0; activityReads = activityWrites = 0;
}

void updateStats(HWND hwnd) {
    // 每秒更新一次；换盘时 identity 改变，不能用新盘计数减旧盘计数。
    auto now = ExecutionTiming::HostClock::now();
    auto seconds = std::chrono::duration<double>(now - statsOrigin).count();
    if (seconds < 1) return;
    measuredMips = running && pc->instructions >= statsInstructions ? double(pc->instructions - statsInstructions) / seconds / 1e6 : 0;
    auto identity = pc->hard ? pc->hard->identity : 0;
    auto reads = pc->hard ? pc->hard->readSectors : 0, writes = pc->hard ? pc->hard->writtenSectors : 0;
    activityReads = identity == statsDisk ? reads - statsReads : reads;
    activityWrites = identity == statsDisk ? writes - statsWrites : writes;
    statsOrigin = now; statsInstructions = pc->instructions; statsDisk = identity; statsReads = reads; statsWrites = writes;
    title(hwnd);
}

void releaseMouse(HWND hwnd) {
    if (!mouseCaptured) return;
    mouseCaptured = false;
    if (GetCapture() == hwnd) ReleaseCapture();
    ShowCursor(TRUE);
    pc->serialMouse.motion(0, 0, 0, pc->clock);
}

void releaseKeyboard() {
    // 失焦/暂停/弹窗时补发 break 扫描码，避免客体认为 Ctrl/Alt 等一直按着。
    for (unsigned scan = 0; scan < pressedKeys.size(); ++scan) {
        if (pressedKeys[scan] && running) pc->key(uint8_t(scan | 128), 0);
        pressedKeys[scan] = false;
    }
    if (!running) pc->modifiers(0);
}

bool confirmChange(HWND hwnd, const wchar_t* text) {
    // 先释放捕获再显示默认 No 的确认框；自动 GUI 测试使用注入决策，避免无人值守阻塞。
    releaseMouse(hwnd); releaseKeyboard(); rightCtrlDown = false;
    if (confirmationDecision) return confirmationDecision();
    auto answer = MessageBoxW(hwnd, text, L"Asm86 - confirm machine change", MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2);
    if (answer != IDYES && answer != IDNO) throw std::runtime_error("Cannot show machine confirmation dialog");
    return answer == IDYES;
}

void centerMouse(HWND hwnd) {
    RECT rect{}; GetClientRect(hwnd, &rect);
    POINT center{rect.right / 2, rect.bottom / 2};
    if (!ClientToScreen(hwnd, &center) || !SetCursorPos(center.x, center.y))
        throw std::runtime_error("Cannot center captured mouse pointer");
}

std::filesystem::path choose(HWND hwnd, bool save, bool optical = false, bool overlay = false) {
    wchar_t path[32768]{};
    OPENFILENAMEW dialog{}; dialog.lStructSize = sizeof(dialog); dialog.hwndOwner = hwnd;
    dialog.lpstrFilter = optical ? L"Optical images (*.iso)\0*.iso\0All files\0*.*\0"
        : overlay ? L"Asm86 overlays (*.cow)\0*.cow\0All files\0*.*\0" : L"Disk images (*.img;*.ima)\0*.img;*.ima\0All files\0*.*\0";
    dialog.lpstrFile = path; dialog.nMaxFile = DWORD(std::size(path)); dialog.lpstrDefExt = optical ? L"iso" : overlay ? L"cow" : L"img";
    dialog.Flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | (save ? (overlay ? 0 : OFN_OVERWRITEPROMPT) : OFN_FILEMUSTEXIST);
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
    // 图形模式批量展开 VGA，文本模式先画到内存 DC；整帧缩放一次以减少闪烁和 GDI 开销。
    if (!pc) return;
    if (!poweredOn) {
        RECT screen{0,0,width,height};
        FillRect(target, &screen, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
        return;
    }
    unsigned cols = std::max(1u, std::min(pc->columns(), 80u)), page = pc->activePage();
    bool graphics = pc->vga.graphics();
    auto v = viewport(width, height, int(pc->vga.width()), int(pc->vga.height()));
    static std::vector<uint32_t> pixels;
    if (graphics) {
        pc->vga.renderGraphics(pixels);
    } else {
        int cellWidth = 8;
        SetBkMode(back, OPAQUE);
        std::array<COLORREF, 16> palette{};
        for (unsigned i = 0; i < palette.size(); ++i) {
            auto rgb = pc->vga.color(pc->vga.paletteIndex(uint8_t(i)));
            palette[i] = pc->vga.blanked() ? RGB(0,0,0) : RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        }
        std::array<wchar_t, 80> text{};
        std::array<uint8_t, 80> attributes{};
        std::array<int, 80> advances{};
        advances.fill(cellWidth);
        const unsigned base = page * 4096;
        for (unsigned y = 0; y < 25; ++y) {
            for (unsigned x = 0; x < cols; ++x) {
                text[x] = glyphs[pc->vga.textByte(base + (y * cols + x) * 2)];
                attributes[x] = pc->vga.textByte(base + (y * cols + x) * 2 + 1);
            }
            for (unsigned x = 0; x < cols;) {
                unsigned end = x + 1;
                while (end < cols && attributes[end] == attributes[x]) ++end;
                auto attr = attributes[x];
                if (SetTextColor(back, palette[attr & 15]) == CLR_INVALID || SetBkColor(back, palette[(attr >> 4) & 7]) == CLR_INVALID)
                    throw std::runtime_error("Cannot set DOS text colors");
                RECT area{int(x) * cellWidth, int(y) * 16, int(end) * cellWidth, int(y + 1) * 16};
                if (!ExtTextOutW(back, area.left, area.top, ETO_OPAQUE | ETO_CLIPPED, &area, text.data() + x, end - x, advances.data()))
                    throw std::runtime_error("Cannot render DOS text");
                x = end;
            }
        }
        unsigned pos = pc->cursor(), x = pos & 255, y = pos >> 8;
        auto shape = pc->cpu.rw(0x40, 0x60);
        if (!pc->vga.blanked() && !(shape & 0x2000) && x < cols && y < 25 && (GetTickCount64() / 500) % 2 == 0) {
            RECT cursor{int(x) * cellWidth, int(y) * 16 + 14, int(x + 1) * cellWidth, int(y + 1) * 16};
            FillRect(back, &cursor, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
        }
    }

    // 只清宽高比留出的黑边；若先清视口再呈现，窗口会短暂露出黑帧而闪烁。
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
    // 单次最多运行约 8 ms；APM 关机/客体复位在片段结束后回到前端统一处理。
    bool hadDisc = pc->cdrom.medium() != nullptr;
    executionTiming.run(*pc, fullSpeed, std::chrono::milliseconds(8), stableTiming);
    if (pc->powerOffRequested) {
        releaseMouse(hwnd); releaseKeyboard(); rightCtrlDown = false;
        if (pc->hard) pc->hard->flush();
        poweredOn = running = paused = false; resetStats();
        title(hwnd); InvalidateRect(hwnd, nullptr, FALSE);
        return;
    }
    if (hadDisc != (pc->cdrom.medium() != nullptr)) title(hwnd);
    if (pc->rebootRequested) {
        if (pc->hard) pc->hard->flush();
        pc->boot(pc->floppy ? 0 : 0x80);
        executionTiming.reset(*pc); resetStats();
    }
    if (!pc->notice.empty()) {
        auto text = wide(pc->notice); pc->notice.clear();
        MessageBoxW(hwnd, text.c_str(), L"Firmware notice", MB_OK | MB_ICONWARNING);
    }
}

void command(HWND hwnd, int id) {
    // 更换 CPU/硬盘和回滚必须真正关机；软盘/光盘可热换，但由设备检查忙碌/锁盘状态。
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
    case LoadCdrom: {
        auto p = choose(hwnd, false, true);
        if (!p.empty()) pc->cdrom.insert(p);
        break;
    }
    case EjectCdrom: pc->cdrom.eject(); break;
    case LoadOverlay: {
        if (poweredOn) { MessageBoxW(hwnd, L"Power off before replacing the disk.", L"Disk overlay", MB_OK); break; }
        auto base = choose(hwnd, false); if (base.empty()) break;
        auto overlay = choose(hwnd, true, false, true); if (overlay.empty()) break;
        auto disk = std::make_unique<Disk>(base, false, false, overlay);
        pc->hard = std::move(disk);
        if (preferences) { preferences->hard(base); preferences->overlay(overlay); }
        break;
    }
    case DiscardOverlay:
        if (poweredOn || !pc->hard || !pc->hard->hasOverlay()) break;
        if (confirmChange(hwnd, L"Discard all writes in this overlay and return to the base disk?\nThis cannot be undone. The base IMG will not be modified."))
            pc->hard->discardOverlay();
        break;
    case NewHard: case NewHard126: case NewHard504: case NewHard2048: case NewHard8192: case NewHard32768: case LoadHard: {
        if (poweredOn || running) { MessageBoxW(hwnd, L"Power off the machine before replacing the hard disk (Machine > Power off).", L"Hard disk", MB_OK); break; }
        auto p = choose(hwnd, id != LoadHard);
        if (!p.empty()) {
            if (id == NewHard2048 || id == NewHard8192 || id == NewHard32768)
                Disk::createBytes(p, uint64_t(id == NewHard32768 ? 32 : id == NewHard8192 ? 8 : 2) << 30);
            else if (id != LoadHard) Disk::create(p, id == NewHard504 ? 1024 : id == NewHard126 ? 256 : 64);
            pc->hard = std::make_unique<Disk>(p, false, false);
            if (preferences) { preferences->hard(pc->hard->path); preferences->overlay({}); }
        }
        break;
    }
    case BootA: case BootC: case CtrlAltDel:
        if (id == CtrlAltDel && !poweredOn) break;
        if (poweredOn && !confirmChange(hwnd, L"Restart the machine and discard its current state?\nShut down Windows first to avoid filesystem corruption.")) break;
        releaseMouse(hwnd); releaseKeyboard();
        pc->boot(id == BootA || (id == CtrlAltDel && pc->floppy) ? 0 : 0x80);
        executionTiming.reset(*pc); resetStats();
        poweredOn = running = true; paused = false; break;
    case PauseResume:

        // 暂停不丢 RAM；恢复重置宿主计时基准，避免把暂停时间变成一大段客体补跑。
        if (!poweredOn || (!running && !paused)) break;
        if (running) {
            releaseMouse(hwnd); releaseKeyboard(); rightCtrlDown = false;
            running = false; paused = true;
        } else {
            executionTiming.reset(*pc); running = true; paused = false;
        }
        resetStats(); break;
    case Reset:
        if (poweredOn && !confirmChange(hwnd, L"Force power off?\nUnsaved guest data may be lost. Prefer shutting down within Windows.")) break;
        releaseMouse(hwnd); releaseKeyboard(); rightCtrlDown = false;
        poweredOn = running = paused = false; resetStats(); if (pc->hard) pc->hard->flush(); break;
    case Cpu8088: case Cpu286: case Cpu386: case Cpu486:
        if (poweredOn || running) { MessageBoxW(hwnd, L"Power off the machine before changing the CPU (Machine > Power off).", L"CPU", MB_OK); break; }
        pc->setModel(id == Cpu486 ? CpuModel::I486 : id == Cpu386 ? CpuModel::I386 : id == Cpu286 ? CpuModel::I286 : CpuModel::I8088);
        poweredOn = false;
        if (!CheckMenuRadioItem(GetMenu(hwnd), Cpu8088, Cpu486, id, MF_BYCOMMAND))
            throw std::runtime_error("Cannot update CPU menu");
        if (preferences) preferences->cpu(pc->cpu.model);
        break;
    case FullSpeed:
        fullSpeed = !fullSpeed;
        if (CheckMenuItem(GetMenu(hwnd), FullSpeed, MF_BYCOMMAND | (fullSpeed ? MF_CHECKED : MF_UNCHECKED)) == DWORD(-1))
            throw std::runtime_error("Cannot update execution speed menu");
        if (preferences) preferences->fullSpeed(fullSpeed);
        break;
    case StableTiming:
        if (pc->cpu.model != CpuModel::I486) break;
        stableTiming = !stableTiming;
        executionTiming.reset(*pc);
        if (CheckMenuItem(GetMenu(hwnd), StableTiming, MF_BYCOMMAND | (stableTiming ? MF_CHECKED : MF_UNCHECKED)) == DWORD(-1))
            throw std::runtime_error("Cannot update CPU timing menu");
        if (preferences) preferences->stableTiming(stableTiming);
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
            updateStats(hwnd);

            // 最小化只跳过刷新，不跳过 execute：后台安装不会因无 WM_PAINT 而停止。
            if (!IsIconic(hwnd)) InvalidateRect(hwnd, nullptr, FALSE); return 0;
            }
        case WM_APP:
            if (running && fullSpeed) execute(hwnd);
            return 0;
        case WM_KEYDOWN: case WM_SYSKEYDOWN: {
            bool rightCtrl = w == VK_RCONTROL || (w == VK_CONTROL && (l & (LPARAM(1) << 24)));
            if (rightCtrl) rightCtrlDown = true;
            if (!running) return 0;
            bool ctrl = GetKeyState(VK_CONTROL) < 0, alt = GetKeyState(VK_MENU) < 0;
            if (mouseCaptured && rightCtrl) {
                releaseMouse(hwnd); releaseKeyboard(); title(hwnd); return 0;
            }
            if (w == VK_DELETE && (rightCtrlDown || (ctrl && alt))) {
                if (!(l & (LPARAM(1) << 30))) command(hwnd, CtrlAltDel);
                return 0;
            }
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
            if (w == VK_RCONTROL || (w == VK_CONTROL && (l & (LPARAM(1) << 24)))) rightCtrlDown = false;
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
        case WM_KILLFOCUS: releaseMouse(hwnd); releaseKeyboard(); rightCtrlDown = false; title(hwnd); return 0;
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
        case WM_CLOSE:
            if (poweredOn && !confirmChange(hwnd, L"Close while the machine is powered on?\nThis forces power off and may lose guest data.")) return 0;
            releaseMouse(hwnd); releaseKeyboard(); poweredOn = running = paused = false;
            if (pc->hard) pc->hard->flush(); DestroyWindow(hwnd); return 0;
        case WM_DESTROY: KillTimer(hwnd, 1); PostQuitMessage(0); return 0;
        }
    } catch (const std::exception& e) {
        releaseMouse(hwnd); running = paused = false; resetStats(); title(hwnd);
        MessageBoxW(hwnd, wide(e.what()).c_str(), L"Asm86 - machine stopped", MB_OK | MB_ICONERROR); return 0;
    }
    return DefWindowProcW(hwnd, message, w, l);
}

BOOL processMessage(HWND hwnd) {
    // Full speed 主动执行 WM_APP，即使没有绘图事件也运行；消息队列持续繁忙时也保留执行机会。
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
    // 脚本键名转换为客体 make/break；修饰键可分开保持，确保 Win9x 能识别真实组合键。
    if (value == "ENTER") tapKey(0x1c, 13);
    else if (value == "ESC") tapKey(1, 27);
    else if (value == "SPACE") tapKey(0x39, 32);
    else if (value == "TAB") tapKey(0x0f, 9);
    else if (value == "ALT_DOWN" || value == "ALT_UP") {
        bool down = value == "ALT_DOWN";
        pc->key(down ? 0x38 : 0xb8, 0);
    }
    else if (value == "CTRL_DOWN" || value == "CTRL_UP") {
        pc->key(value == "CTRL_DOWN" ? 0x1d : 0x9d, 0);
    }
    else if (value == "UP") tapKey(0x48, 0);
    else if (value == "DOWN") tapKey(0x50, 0);
    else if (value == "LEFT") tapKey(0x4b, 0);
    else if (value == "RIGHT") tapKey(0x4d, 0);
    else if (value == "END") {
        pc->key(0xe0, 0); pc->key(0x4f, 0); pc->key(0xe0, 0); pc->key(0xcf, 0);
    }
    else if (value.size() == 1 && ((value[0] >= 'a' && value[0] <= 'z') ||
        (value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= '0' && value[0] <= '9'))) {
        // 快捷键只发送物理扫描码，让客体根据 Ctrl/Alt 状态译码；type 则明确提供文本字符。
        auto key = value[0]; if (key >= 'a' && key <= 'z') key -= 'a' - 'A';
        auto scan = MapVirtualKeyA(unsigned(key), MAPVK_VK_TO_VSC);
        if (!scan || scan > 0x7f) throw std::runtime_error("Cannot map scripted key to a keyboard scan code");
        tapKey(uint8_t(scan), 0);
    }
    else if (value.size() >= 2 && value[0] == 'F') {
        int n = std::stoi(value.substr(1)); if (n < 1 || n > 10) throw std::runtime_error("Expected F1..F10");
        tapKey(uint8_t(0x3a + n), 0);
    } else throw std::runtime_error("Unknown scripted key: " + value);
}

void saveFrame(const std::filesystem::path& path) {
    // 输出 32 位 top-down BMP；关机保存黑屏，不能把停留的旧 VGA 缓冲区当成仍在运行。
    if (!pc->vga.graphics()) throw std::runtime_error("A graphics frame requires a graphics video mode");
    unsigned width = pc->vga.width(), height = pc->vga.height();
    BITMAPFILEHEADER file{}; BITMAPINFOHEADER info{};
    file.bfType = 0x4d42; file.bfOffBits = sizeof(file) + sizeof(info); file.bfSize = file.bfOffBits + width * height * 4;
    info.biSize = sizeof(info); info.biWidth = LONG(width); info.biHeight = -LONG(height);
    info.biPlanes = 1; info.biBitCount = 32; info.biCompression = BI_RGB;
    std::vector<uint32_t> pixels;
    if (pc->powerOffRequested) pixels.resize(width * height);
    else pc->vga.renderGraphics(pixels);
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(&file), sizeof(file)); out.write(reinterpret_cast<const char*>(&info), sizeof(info));
    out.write(reinterpret_cast<const char*>(pixels.data()), std::streamsize(pixels.size() * sizeof(uint32_t)));
    if (!out) throw std::runtime_error("Cannot save graphics frame");
}

int headless(const std::filesystem::path& script) {
    // run/wait 使用确定性指令预算；realtime/wait-realtime 使用与 GUI 相同的宿主计时。
    // expect-state powered-off 必须看到 APM 请求，不能因超时/CPU 停止就判成功。
    std::ifstream stream(script); if (!stream) throw std::runtime_error("Cannot open headless script");
    std::string line; unsigned lineNumber = 0; bool pacedFullSpeed = true;
    try { while (std::getline(stream, line)) {
        ++lineNumber; if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty() || line[0] == '#') continue;
        auto split = line.find(' '); auto op = line.substr(0, split);
        auto arg = split == std::string::npos ? std::string() : line.substr(split + 1);
        if (op == "run") {
            uint64_t count = std::stoull(arg);
            while (count && !pc->powerOffRequested) { auto n = unsigned(std::min<uint64_t>(count, 100000)); pc->run(n); count -= n; if (pc->rebootRequested) pc->boot(pc->floppy ? 0 : 0x80); }
        } else if (op == "realtime" || op == "wait-realtime" || op == "boot-normal") {
            std::istringstream input(arg); int milliseconds = 0; std::string speed = "full", extra, text;
            bool waiting = op == "wait-realtime", booting = op == "boot-normal";
            if (!(input >> milliseconds) || milliseconds < 0) throw std::runtime_error("Expected nonnegative realtime milliseconds");
            if (waiting) {
                speed = pacedFullSpeed ? "full" : "normal";
                std::getline(input >> std::ws, text);
                if (text.empty()) throw std::runtime_error("Expected wait-realtime <milliseconds> <text>");
            } else {
                if (!(input >> speed) || (speed != "normal" && speed != "full"))
                    throw std::runtime_error("Expected realtime/boot-normal <milliseconds> <normal|full>");
                if (booting) std::getline(input >> std::ws, text);
                else if (input >> extra) throw std::runtime_error("Unexpected realtime argument");
                pacedFullSpeed = speed == "full";
            }
            bool selectedNormal = false, dismissedWarning = false;
            auto ready = [&] { return pc->vga.graphics() && pc->vga.width() >= 640 && pc->vga.height() >= 480; };
            ExecutionTiming timing; timing.reset(*pc);
            const auto started = ExecutionTiming::HostClock::now(), deadline = started + std::chrono::milliseconds(milliseconds);
            const auto beforeClock = pc->clock;
            while (!pc->powerOffRequested && ExecutionTiming::HostClock::now() < deadline &&
                (!waiting || pc->text().find(text) == std::string::npos) && (!booting || !ready())) {
                if (booting && !pc->vga.graphics()) {
                    auto screen = pc->text();
                    if (!selectedNormal && screen.find("Startup Menu") != std::string::npos && screen.find("Normal") != std::string::npos) {
                        tapKey(2, '1'); namedKey("ENTER"); selectedNormal = true;
                        std::cout << "Selected Normal startup\n";
                    }
                    if (!dismissedWarning && !text.empty() && screen.find(text) != std::string::npos) {
                        namedKey("ENTER"); dismissedWarning = true;
                        std::cout << "Dismissed configured startup warning: " << text << '\n';
                    }
                }
                auto remaining = deadline - ExecutionTiming::HostClock::now();
                if (remaining <= ExecutionTiming::HostClock::duration::zero()) break;
                timing.run(*pc, speed == "full", std::min(remaining,
                    std::chrono::duration_cast<ExecutionTiming::HostClock::duration>(std::chrono::milliseconds(8))), stableTiming);
                if (pc->rebootRequested) { pc->boot(pc->floppy ? 0 : 0x80); timing.reset(*pc); }
                if (speed == "normal") Sleep(1);
            }
            if (waiting && pc->text().find(text) == std::string::npos)
                throw std::runtime_error("Script line " + std::to_string(lineNumber) + ": realtime timeout waiting for: " + text);
            if (booting && (pc->powerOffRequested || !ready()))
                throw std::runtime_error("Script line " + std::to_string(lineNumber) + ": timeout waiting for Windows graphics startup");
            std::cout << "Realtime " << speed << ": host="
                << std::chrono::duration<double>(ExecutionTiming::HostClock::now() - started).count()
                << "s guest=" << (pc->clock - beforeClock) / ExecutionTiming::PitHz << "s\n";
        } else if (op == "wait") {
            uint64_t count = 0;
            while (pc->text().find(arg) == std::string::npos && count < 1000000000) {
                if (pc->powerOffRequested) throw std::runtime_error("Guest powered off while waiting for: " + arg);
                pc->run(10000); count += 10000;
                if (pc->rebootRequested) pc->boot(pc->floppy ? 0 : 0x80);
            }
            if (count >= 1000000000) throw std::runtime_error("Script line " + std::to_string(lineNumber) + ": timed out waiting for: " + arg);
        } else if (op == "dump") {
            std::ofstream out(std::filesystem::u8path(arg), std::ios::binary);
            out.write(reinterpret_cast<const char*>(pc->cpu.mem.data()), std::streamsize(pc->cpu.mem.size()));
            if (!out) throw std::runtime_error("Cannot save diagnostic memory");
        } else if (op == "state") {
            // 诊断读取可能触发客体页故障，保留原 CR2，避免日志观察改变下一次异常的故障地址。
            std::cout << "CS:IP " << std::hex << pc->cpu.s[CS] << ':' << pc->cpu.ip << " flags=" << pc->cpu.flags
                << " msw=" << pc->cpu.msw << " cpl=" << pc->cpu.cpl;
            for (auto v : pc->cpu.r) std::cout << ' ' << v;
            std::cout << " code:";
            auto cr2 = pc->cpu.cr2;
            for (int i = 0; i < 24; ++i) {
                auto off = pc->cpu.supports386() ? pc->cpu.ip + i : uint16_t(pc->cpu.ip + i);
                try { std::cout << ' ' << unsigned(pc->cpu.rbS(CS, off)); }
                catch (const CpuFault& fault) { std::cout << " [memory fault " << unsigned(fault.vector) << ']'; break; }
            }
            pc->cpu.cr2 = cr2;
            std::cout << std::dec << " steps=" << pc->instructions << " video=" << unsigned(pc->vga.mode)
                << " COM1-mouse=" << pc->serialMouse.active() << '\n';
            if (pc->cpu.supports386()) {
                std::cout << std::hex << "386 EFLAGS=" << pc->cpu.eflags() << " CR2=" << pc->cpu.cr2 << " CR3=" << pc->cpu.cr3;
                for (int i = 0; i < 8; ++i) std::cout << ' ' << pc->cpu.r32(i);
                std::cout << " GDT=" << pc->cpu.gdtr.base << ':' << pc->cpu.gdtr.limit
                    << " LDT=" << pc->cpu.ldtr.base << ':' << pc->cpu.ldtr.limit
                    << " IDT=" << pc->cpu.idtr.base << ':' << pc->cpu.idtr.limit;
                std::cout << std::dec << '\n';
            }
        } else if (op == "expect") {
            if (pc->text().find(arg) == std::string::npos) throw std::runtime_error("Screen assertion failed: " + arg);
        } else if (op == "expect-state") {
            bool valid = arg == "powered-off" ? pc->powerOffRequested : arg == "graphics" ? !pc->powerOffRequested && pc->vga.graphics()
                : arg == "text" ? !pc->powerOffRequested && !pc->vga.graphics() : false;
            if (!valid) throw std::runtime_error("Script line " + std::to_string(lineNumber) + ": state assertion failed: " + arg);
        } else if (op == "reject-fault") {
            std::istringstream input(arg); unsigned vector; std::string address, extra;
            if (!(input >> vector >> address) || vector > 31 || (input >> extra))
                throw std::runtime_error("Expected reject-fault <vector 0..31> <linear address>");
            size_t used = 0; auto value = std::stoull(address, &used, 0);
            if (used != address.size() || value > UINT32_MAX) throw std::runtime_error("Invalid reject-fault address");
            auto previous = pc->cpu.onFault;
            pc->cpu.onFault = [previous, vector, value](CpuFault fault, uint32_t linear) {
                if (fault.vector == vector && linear == value)
                    throw std::runtime_error("Rejected guest fault " + std::to_string(vector) + " at linear address " + std::to_string(linear));
                if (previous) previous(fault, linear);
            };
        } else if (op == "key") namedKey(arg);
        else if (op == "type" || op == "type-paced") {
            // 先按修饰键，再 make/break 字符键；paced 版本留出宿主时间供图形系统消费输入。
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
                if (op == "type") pc->run(50000);
                else {
                    ExecutionTiming typing; typing.reset(*pc);
                    auto deadline = ExecutionTiming::HostClock::now() + std::chrono::milliseconds(100);
                    while (!pc->powerOffRequested && ExecutionTiming::HostClock::now() < deadline)
                        typing.run(*pc, pacedFullSpeed, std::chrono::milliseconds(8), stableTiming);
                }
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
        else if (op == "mount-cd") pc->cdrom.insert(std::filesystem::u8path(arg));
        else if (op == "eject-cd") pc->cdrom.eject();
        else if (op == "boot") pc->boot(arg == "c" ? 0x80 : 0);
        else if (op == "screen") {
            std::ofstream out(std::filesystem::u8path(arg)); out << pc->text();
            if (!out) throw std::runtime_error("Cannot save screen text");
        } else if (op == "frame") saveFrame(std::filesystem::u8path(arg));
        else throw std::runtime_error("Unknown script operation: " + op);
    } } catch (...) {
        if (pc->vga.graphics()) {
            try { saveFrame(std::filesystem::path(script.wstring() + L".failure.bmp")); }
            catch (const std::exception& e) { std::cerr << "Cannot save failure diagnostics: " << e.what() << '\n'; }
        }
        throw;
    }
    if (pc->hard) pc->hard->flush();
    std::cout << pc->text() << "\nHeadless script passed\n"; return 0;
}

void headlessRegressionTests() {
    auto savedPc = std::move(pc);
    auto savedTiming = stableTiming;
    stableTiming = false;
    std::filesystem::path path;
    try {
        wchar_t name[MAX_PATH]{};
        auto folder = std::filesystem::temp_directory_path();
        if (!GetTempFileNameW(folder.c_str(), L"ash", 0, name)) throw std::runtime_error("Cannot create headless-test script");
        path = name;
        auto run = [&](const std::string& commands, const std::vector<uint8_t>& code, const std::string& expectedError) {
            pc = std::make_unique<Pc>(); pc->setModel(CpuModel::I486);
            pc->cpu.loadSegment(CS, 0); pc->cpu.ip = 0x500; pc->cpu.setFlags(2);
            std::copy(code.begin(), code.end(), pc->cpu.mem.begin() + 0x500);
            std::ofstream out(path); out << commands; out.close();
            if (!out) throw std::runtime_error("Cannot write headless-test script");
            try { headless(path); }
            catch (const std::runtime_error& e) {
                if (expectedError.empty() || std::string(e.what()).find(expectedError) == std::string::npos) throw;
                return;
            }
            if (!expectedError.empty()) throw std::runtime_error("Headless script should have rejected: " + expectedError);
        };
        // EB FE=JMP $；仅忙等，用于验证未触发的故障监控和正常档输入预算。
        run("reject-fault 0 0x504\nrun 1000\n", {0xeb, 0xfe}, "");
        // 31 C0=XOR AX,AX；31 D2=XOR DX,DX；F7 F0=DIV AX，应在 0000:0504 产生 #DE。
        run("reject-fault 0 0x504\nrun 1000\n", {0x31,0xc0,0x31,0xd2,0xf7,0xf0}, "Rejected guest fault 0");
        run("boot-normal 0 full\n", {0xeb, 0xfe}, "timeout waiting for Windows graphics startup");
        run("realtime 0 normal\ntype-paced a\n", {0xeb, 0xfe}, "");
        if (pc->instructions > 1000000) throw std::runtime_error("Normal-speed paced typing exceeded its 100 ms instruction budget");
        std::filesystem::remove(path);
    } catch (...) {
        pc = std::move(savedPc); stableTiming = savedTiming;
        std::error_code cleanup;
        if (!path.empty()) std::filesystem::remove(path, cleanup);
        if (cleanup) std::cerr << "Cannot remove headless-test script: " << cleanup.message() << '\n';
        throw;
    }
    pc = std::move(savedPc); stableTiming = savedTiming;
    std::cout << "Headless targeted fault rejection / boot timeout / normal-speed paced typing checks passed\n";
}

int application(int argc, wchar_t** argv) {
    // 先完整解析参数再打开硬盘，让 --hard 与 --overlay 顺序无关，并避免误开成可写底盘。
    pc = std::make_unique<Pc>();
    std::filesystem::path script, hardPath, overlayPath; bool start = false, uiTest = false, discardOverlay = false, overlaySpecified = false;
    bool cpuSpecified = false, speedSpecified = false, timingSpecified = false, floppySpecified = false, hardSpecified = false, experimental386 = false;
    for (int i = 1; i < argc; ++i) {
        std::wstring option = argv[i];
        if (option == L"--ui-test") { uiTest = true; continue; }
        if (option == L"--discard-overlay") { discardOverlay = true; continue; }
        if (option == L"--experimental-386") { experimental386 = true; continue; }
        if (option == L"--full-speed" || option == L"--normal-speed") {
            fullSpeed = option == L"--full-speed"; speedSpecified = true; continue;
        }
        if (option == L"--stable-timing" || option == L"--real-time-timing") {
            stableTiming = option == L"--stable-timing"; timingSpecified = true; continue;
        }
        if (i + 1 >= argc) throw std::runtime_error("Missing command-line option value");
        std::filesystem::path value = argv[++i];
        if (option == L"--floppy") { pc->floppy = std::make_unique<Disk>(value, true, true); floppySpecified = true; }
        else if (option == L"--hard") { hardPath = value; hardSpecified = true; }
        else if (option == L"--overlay") {
            if (value.empty()) throw std::runtime_error("--overlay requires a nonempty overlay path");
            overlayPath = value; overlaySpecified = true;
        }
        else if (option == L"--cdrom") pc->cdrom.insert(value);
        else if (option == L"--create-hard") {
            uint64_t bytes = 64ULL * 1008 * 512;
            if (i + 1 < argc && std::wstring(argv[i + 1]).rfind(L"--", 0) != 0) {
                std::wstring size = argv[++i];
                if (size == L"31.5" || size == L"126" || size == L"504")
                    bytes = (size == L"504" ? 1024ULL : size == L"126" ? 256ULL : 64ULL) * 1008 * 512;
                else if (size == L"1024" || size == L"2048" || size == L"8192" || size == L"32768")
                    bytes = std::stoull(size) * 1024 * 1024;
                else throw std::runtime_error("Optional --create-hard size must be 31.5, 126, 504, 1024, 2048, 8192 or 32768 MiB");
            }
            Disk::createBytes(value, bytes); hardPath = value;
            hardSpecified = true;
        }
        else if (option == L"--cpu") {
            if (value != L"8088" && value != L"286" && value != L"386" && value != L"486")
                throw std::runtime_error("--cpu must be 8088, 286, 386 or 486");
            pc->setModel(value == L"486" ? CpuModel::I486 : value == L"386" ? CpuModel::I386 : value == L"286" ? CpuModel::I286 : CpuModel::I8088);
            cpuSpecified = true;
        }
        else if (option == L"--boot") {
            if (value != L"a" && value != L"c") throw std::runtime_error("--boot must be a or c");
            pc->bootDrive = value == L"c" ? 0x80 : 0; start = true;
        } else if (option == L"--headless") script = value;
        else throw std::runtime_error("Unknown command-line option");
    }
    if (hardSpecified) pc->hard = std::make_unique<Disk>(hardPath, false, false, overlayPath);
    if (discardOverlay) {
        if (start || uiTest || !script.empty() || !pc->hard || !pc->hard->hasOverlay())
            throw std::runtime_error("--discard-overlay requires --hard and --overlay, without boot, headless or UI test");
        pc->hard->discardOverlay(); std::cout << "Overlay writes discarded; base disk unchanged\n"; return 0;
    }
    if (overlaySpecified && !hardSpecified && (uiTest || !script.empty()))
        throw std::runtime_error("--overlay requires --hard in scripted mode");
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
        // 仅交互 GUI 恢复/保存用户偏好；headless 与 ui-test 完全隔离真实用户设置。
        preferences = std::make_unique<Preferences>();
        if (!cpuSpecified) pc->setModel(preferences->cpu());
        if (!speedSpecified) fullSpeed = preferences->fullSpeed();
        if (!timingSpecified) stableTiming = preferences->stableTiming();
        if (!hardSpecified) {
            auto path = preferences->hard();
            if (!path.empty()) {
                try { pc->hard = std::make_unique<Disk>(path, false, false, overlaySpecified ? overlayPath : preferences->overlay()); }
                catch (const std::exception& e) {
                    auto message = L"Could not restore the remembered hard disk:\n" + path.wstring() + L"\n\n" + wide(e.what())
                        + L"\n\nC: will remain empty. Open another hard disk to replace the remembered path.";
                    MessageBoxW(nullptr, message.c_str(), L"Asm86 - remembered hard disk unavailable", MB_OK | MB_ICONWARNING);
                }
            }
        }
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
        if (timingSpecified) preferences->stableTiming(stableTiming);
        if (floppySpecified) preferences->floppy(pc->floppy->path);
        if (overlaySpecified && !pc->hard) throw std::runtime_error("--overlay requires a base hard disk");
        if (hardSpecified) preferences->hard(pc->hard->path);
        if ((hardSpecified || overlaySpecified) && pc->hard) preferences->overlay(pc->hard->overlayPath());
    }
    if (!script.empty()) {
        if (start) pc->boot(pc->bootDrive);
        return headless(script);
    }
    if (uiTest) headlessRegressionTests();
    auto instance = GetModuleHandleW(nullptr);
    SetProcessDPIAware();
    WNDCLASSW cls{}; cls.hInstance = instance; cls.lpfnWndProc = windowProc; cls.lpszClassName = L"Asm86Native";
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    if (!RegisterClassW(&cls)) throw std::runtime_error("Cannot register native window class");
    auto menu = CreateMenu(), disks = CreatePopupMenu(), machine = CreatePopupMenu(), view = CreatePopupMenu();
    AppendMenuW(disks, MF_STRING, LoadFloppy, L"Insert A: floppy (read-only)...");
    AppendMenuW(disks, MF_STRING, EjectFloppy, L"Eject A:");
    auto sizes = CreatePopupMenu();
    AppendMenuW(sizes, MF_STRING, NewHard, L"31.5 MiB...");
    AppendMenuW(sizes, MF_STRING, NewHard126, L"126 MiB...");
    AppendMenuW(sizes, MF_STRING, NewHard504, L"504 MiB...");
    AppendMenuW(sizes, MF_STRING, NewHard2048, L"2 GiB (sparse)...");
    AppendMenuW(sizes, MF_STRING, NewHard8192, L"8 GiB (sparse)...");
    AppendMenuW(sizes, MF_STRING, NewHard32768, L"32 GiB (sparse)...");
    AppendMenuW(disks, MF_POPUP, UINT_PTR(sizes), L"Create C: hard disk");
    AppendMenuW(disks, MF_STRING, LoadHard, L"Open C: hard disk...");
    AppendMenuW(disks, MF_STRING, LoadOverlay, L"Open C: with overlay (base read-only)...");
    AppendMenuW(disks, MF_STRING, DiscardOverlay, L"Discard overlay writes (powered off)...");
    AppendMenuW(disks, MF_STRING, LoadCdrom, L"Insert ATAPI CD-ROM (.iso)...");
    AppendMenuW(disks, MF_STRING, EjectCdrom, L"Eject ATAPI CD-ROM");
    AppendMenuW(disks, MF_SEPARATOR, 0, nullptr); AppendMenuW(disks, MF_STRING, Quit, L"Exit");
    AppendMenuW(machine, MF_STRING, BootA, L"Boot / restart from A:");
    AppendMenuW(machine, MF_STRING, BootC, L"Boot / restart from C:");
    AppendMenuW(machine, MF_STRING, CtrlAltDel, L"Ctrl+Alt+Del\tRight Ctrl+Del");
    AppendMenuW(machine, MF_STRING, Reset, L"Power off");
    AppendMenuW(machine, MF_STRING, PauseResume, L"Pause");
    AppendMenuW(machine, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(machine, MF_STRING | (fullSpeed ? MF_CHECKED : MF_UNCHECKED), FullSpeed, L"Full speed (real-time timers)");
    AppendMenuW(machine, MF_STRING | (stableTiming ? MF_CHECKED : MF_UNCHECKED), StableTiming, L"Stable CPU timing (Windows 98)");
    AppendMenuW(machine, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I8088 ? MF_CHECKED : MF_UNCHECKED), Cpu8088, L"CPU: 8088");
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I286 ? MF_CHECKED : MF_UNCHECKED), Cpu286, L"CPU: 80286 / AT");
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I386 ? MF_CHECKED : MF_UNCHECKED), Cpu386, L"CPU: 80386 / AT (experimental)");
    AppendMenuW(machine, MF_STRING | (pc->cpu.model == CpuModel::I486 ? MF_CHECKED : MF_UNCHECKED), Cpu486, L"CPU: 80486DX / AT (experimental)");
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
    executionTiming.reset(*pc); resetStats();
    if (!SetTimer(hwnd, 1, 16, nullptr)) throw std::runtime_error("Cannot start execution timer");
    if (uiTest) {
        // 以下集成测试直接发送 Win32 消息，使用私有临时盘和可控确认结果，不操作用户原盘。
        confirmationDecision = [] { return true; };
        if (poweredOn || running) throw std::runtime_error("GUI startup must remain powered off even with --boot");
        auto checkBlackScreen = [&]() {
            RECT area{}; GetClientRect(hwnd, &area);
            auto target = CreateCompatibleDC(back);
            auto image = CreateCompatibleBitmap(back, area.right, area.bottom);
            if (!target || !image) throw std::runtime_error("Cannot allocate power-off screen test");
            auto old = SelectObject(target, image);
            FillRect(target, &area, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
            render(target, area.right, area.bottom);
            SelectObject(target, old);
            BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = area.right; info.bmiHeader.biHeight = -area.bottom;
            info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
            std::vector<uint32_t> pixels(size_t(area.right) * area.bottom);
            auto rows = GetDIBits(back, image, 0, UINT(area.bottom), pixels.data(), &info, DIB_RGB_COLORS);
            DeleteObject(image); DeleteDC(target);
            if (rows != area.bottom || !std::all_of(pixels.begin(), pixels.end(), [](uint32_t p) { return !(p & 0xffffff); }))
                throw std::runtime_error("Powered-off screen must be entirely black");
        };
        pc->cpu.ww(0xb800, 0, 0x4f58);
        checkBlackScreen();
        auto initialInstructions = pc->instructions;
        SendMessageW(hwnd, WM_APP, 0, 0); SendMessageW(hwnd, WM_TIMER, 1, 0);
        SendMessageW(hwnd, WM_COMMAND, CtrlAltDel, 0);
        SendMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
        SendMessageW(hwnd, WM_KEYDOWN, VK_DELETE, LPARAM((0x53 << 16) | (1 << 24)));
        SendMessageW(hwnd, WM_KEYUP, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
        if (poweredOn || running || pc->instructions != initialInstructions ||
            !(GetMenuState(menu, CtrlAltDel, MF_BYCOMMAND) & MF_GRAYED))
            throw std::runtime_error("Timers or restart commands powered on an idle GUI");
        poweredOn = true;
        TEXTMETRICW metrics{};
        if (!GetTextMetricsW(back, &metrics)) throw std::runtime_error("Cannot measure DOS display font");
        std::cout << "Text cell metrics: " << metrics.tmAveCharWidth << 'x' << metrics.tmHeight << '\n';
        if (metrics.tmHeight > 16 || metrics.tmAveCharWidth > 8)
            throw std::runtime_error("DOS font exceeds the 8x16 cell and will be clipped");
        for (unsigned i = 0; i < 2000; ++i) pc->cpu.ww(0xb800, uint16_t(i * 2), 0x1f20);
        for (unsigned i = 32; i < 127; ++i) pc->cpu.wb(0xb800, uint16_t((i - 32) * 2), uint8_t(i));
        pc->cpu.ww(0x40, 0x60, 0x2000);
        SendMessageW(hwnd, WM_COMMAND, Reset, 0); checkBlackScreen(); poweredOn = true;
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
        {
            auto referenceDc = CreateCompatibleDC(back);
            auto referenceImage = CreateCompatibleBitmap(back, 640, 400);
            if (!referenceDc || !referenceImage) throw std::runtime_error("Cannot create text-run reference buffer");
            auto previousImage = SelectObject(referenceDc, referenceImage);
            auto previousFont = SelectObject(referenceDc, font);
            SetBkMode(referenceDc, OPAQUE);
            auto capture = [&](HDC dc, HBITMAP image, HGDIOBJ previous) {
                BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
                info.bmiHeader.biWidth = 640; info.bmiHeader.biHeight = -400;
                info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
                std::vector<uint32_t> pixels(640 * 400);
                SelectObject(dc, previous);
                auto rows = GetDIBits(dc, image, 0, 400, pixels.data(), &info, DIB_RGB_COLORS);
                SelectObject(dc, image);
                if (rows != 400) throw std::runtime_error("Cannot capture text-run comparison");
                return pixels;
            };
            for (unsigned cols : {80u, 40u}) for (unsigned pattern = 0; pattern < 5; ++pattern) {
                pc->vga.setMode(cols == 80 ? 3 : 1);
                pc->cpu.ww(0x40, 0x4a, uint16_t(cols)); pc->cpu.wb(0x40, 0x62, 1);
                pc->cpu.ww(0x40, 0x60, 0x2000);
                if (pattern == 3) {
                    pc->vga.attr[1] = 4; pc->vga.attr[0x12] = 5; pc->vga.output(0x3c6, 0x53);
                    pc->vga.output(0x3c8, 0);
                    for (unsigned i = 0; i < 768; ++i) pc->vga.output(0x3c9, uint8_t((i * 13 + 7) & 63));
                }
                if (pattern == 4) pc->vga.seq[1] |= 0x20;
                RECT area{0,0,640,400};
                FillRect(back, &area, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
                FillRect(referenceDc, &area, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
                for (unsigned y = 0; y < 25; ++y) for (unsigned x = 0; x < cols; ++x) {
                    auto ch = uint8_t(y * cols + x);
                    auto attr = uint8_t(pattern == 0 ? 0x1f : pattern == 1 ? y * 11 + x / 7 : y * cols + x);
                    pc->cpu.ww(0xb800, uint16_t(4096 + (y * cols + x) * 2), ch | (uint16_t(attr) << 8));
                    auto color = [&](uint8_t index) {
                        auto rgb = pc->vga.color(pc->vga.paletteIndex(index));
                        return pc->vga.blanked() ? RGB(0,0,0) : RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
                    };
                    SetTextColor(referenceDc, color(attr & 15)); SetBkColor(referenceDc, color((attr >> 4) & 7));
                    RECT cell{int(x) * 8,int(y) * 16,int(x + 1) * 8,int(y + 1) * 16};
                    if (!ExtTextOutW(referenceDc, cell.left, cell.top, ETO_OPAQUE | ETO_CLIPPED, &cell, &glyphs[ch], 1, nullptr))
                        throw std::runtime_error("Cannot draw per-cell text reference");
                }
                auto target = GetDC(hwnd); render(target, 640, 400); ReleaseDC(hwnd, target);
                if (capture(back, bitmap, oldBitmap) != capture(referenceDc, referenceImage, previousImage))
                    throw std::runtime_error("Batched text differs from per-cell glyphs, attributes, palette or blanking");
            }
            SelectObject(referenceDc, previousFont); SelectObject(referenceDc, previousImage);
            DeleteObject(referenceImage); DeleteDC(referenceDc);
            pc->vga.setMode(3); pc->cpu.ww(0x40, 0x4a, 80); pc->cpu.wb(0x40, 0x62, 0);
        }
        std::cout << "Text runs / all CP437 glyphs / 40-80 columns / attributes / active page / live palette / blanking pixel checks passed\n";
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
        SendMessageW(hwnd, WM_COMMAND, Reset, 0); checkBlackScreen(); poweredOn = true;
        pc->cpu.r[AX] = 3; pc->cpu.trap(0x10); original(hwnd);
        std::cout << "Powered-off startup / no automatic boot / text-graphics black-screen checks passed\n";
        std::cout << "VGA 320x200 / 640x480 original-size / maximized pixel checks passed\n";
        auto savedPc = std::move(pc);
        pc = std::make_unique<Pc>();
        pc->cpu.reset(); pc->cpu.s[CS] = 0; pc->cpu.ip = 0x500; pc->cpu.flags = 0xf002;
        pc->cpu.mem[0x500] = 0xeb; pc->cpu.mem[0x501] = 0xfe; // EB FE=JMP $：无限短跳转用于测速，不访问磁盘。
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
        for (auto selection : {Cpu286, Cpu386, Cpu486}) {
            SendMessageW(hwnd, WM_COMMAND, selection, 0);
            GetWindowTextW(hwnd, caption, int(std::size(caption)));
            if (pc->cpu.model != (selection == Cpu486 ? CpuModel::I486 : selection == Cpu386 ? CpuModel::I386 : CpuModel::I286)
                || !(GetMenuState(menu, selection, MF_BYCOMMAND) & MF_CHECKED)
                || !std::wcsstr(caption, selection == Cpu486 ? L"80486DX" : selection == Cpu386 ? L"80386" : L"80286"))
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
        if (stableTiming) SendMessageW(hwnd, WM_COMMAND, StableTiming, 0);
        SendMessageW(hwnd, WM_COMMAND, StableTiming, 0);
        GetWindowTextW(hwnd, caption, int(std::size(caption)));
        if (!stableTiming || !(GetMenuState(menu, StableTiming, MF_BYCOMMAND) & MF_CHECKED) || !std::wcsstr(caption, L"Stable CPU timing"))
            throw std::runtime_error("Stable CPU timing did not update the title and menu");
        pc->cpu.loadSegment(CS, 0); pc->cpu.ip = 0x500; pc->cpu.setFlags(2);
        pc->cpu.halted = pc->cpu.waiting = false;
        pc->cpu.mem[0x500] = 0xeb; pc->cpu.mem[0x501] = 0xfe;
        running = poweredOn = true;
        auto stableBefore = pc->instructions; auto stableClock = pc->clock;
        Sleep(2); SendMessageW(hwnd, WM_TIMER, 1, 0);
        if (pc->instructions == stableBefore || std::abs(double(pc->instructions - stableBefore)
            - (pc->clock - stableClock) * ExecutionTiming::Stable486Rate / ExecutionTiming::PitHz) > 0.0001)
            throw std::runtime_error("GUI stable timing did not bind device time to executed CPU instructions");
        stableClock = pc->clock;
        SendMessageW(hwnd, WM_COMMAND, StableTiming, 0);
        if (stableTiming || pc->clock != stableClock || GetMenuState(menu, StableTiming, MF_BYCOMMAND) & MF_CHECKED)
            throw std::runtime_error("Restoring real-time CPU timing introduced a guest clock jump");
        SendMessageW(hwnd, WM_COMMAND, Reset, 0);
        std::cout << "Stable CPU timing menu / execution / live-toggle / real-time restoration checks passed\n";
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
        std::filesystem::path resetOverlay;
        auto removeResetImages = [&]() {
            pc->floppy.reset(); pc->hard.reset();
            if (!resetOverlay.empty()) std::filesystem::remove(resetOverlay);
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

                // EB FE=JMP $；第三字节仅为盘标记 C/D，不可执行；尾部 55 AA 是引导签名。
                sector[0] = char(0xeb); sector[1] = char(0xfe); sector[2] = char('C' + i);
                sector[510] = 0x55; sector[511] = char(0xaa);
                image.seekp(0); image.write(sector.data(), sector.size()); image.close();
                if (!image) throw std::runtime_error("Cannot write reset-test boot sector");
            }
            pc->hard = std::make_unique<Disk>(resetImages[0], false, false);
            auto savedSpeed = fullSpeed;
            for (auto model : {Cpu8088, Cpu286, Cpu386, Cpu486}) {
                SendMessageW(hwnd, WM_COMMAND, Reset, 0);
                SendMessageW(hwnd, WM_COMMAND, model, 0);
                auto expectedModel = model == Cpu486 ? CpuModel::I486 : model == Cpu386 ? CpuModel::I386 : model == Cpu286 ? CpuModel::I286 : CpuModel::I8088;
                pc->floppy = std::make_unique<Disk>(resetImages[1], true, true);
                SendMessageW(hwnd, WM_COMMAND, BootA, 0);
                if (!poweredOn || !running || pc->bootDrive != 0 || pc->cpu.rb(0, 0x7c02) != 'D')
                    throw std::runtime_error("Boot from A: must power on the guest");
                pc->cpu.wb(0, 0x7c02, 'X');
                SendMessageW(hwnd, WM_COMMAND, CtrlAltDel, 0);
                if (!running || pc->bootDrive != 0 || pc->cpu.rb(0, 0x7c02) != 'D'
                    || pc->cpu.model != expectedModel || fullSpeed != savedSpeed)
                    throw std::runtime_error("Ctrl+Alt+Del did not boot the inserted floppy while preserving CPU/speed");
                pc->floppy.reset();
                SendMessageW(hwnd, WM_COMMAND, Reset, 0);
                SendMessageW(hwnd, WM_COMMAND, BootC, 0);
                if (!poweredOn || !running || pc->bootDrive != 0x80 || pc->cpu.rb(0, 0x7c02) != 'C')
                    throw std::runtime_error("Boot from C: must power on the guest");
                SendMessageW(hwnd, WM_COMMAND, CtrlAltDel, 0);
                if (!running || pc->bootDrive != 0x80 || pc->cpu.rb(0, 0x7c02) != 'C'
                    || pc->cpu.model != expectedModel || fullSpeed != savedSpeed)
                    throw std::runtime_error("Ctrl+Alt+Del did not restart from the hard disk while preserving CPU/speed");
                pc->cpu.wb(0, 0x7c02, 'X');
                SendMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, LPARAM(0x1d << 16));
                SendMessageW(hwnd, WM_KEYDOWN, VK_DELETE, LPARAM((0x53 << 16) | (1 << 24)));
                SendMessageW(hwnd, WM_KEYUP, VK_CONTROL, LPARAM(0x1d << 16));
                if (pc->cpu.rb(0, 0x7c02) != 'X') throw std::runtime_error("Left Ctrl+Del must not restart the guest");
                pc->cpu.out(0x3fb, 0x80); pc->cpu.out(0x3f8, 96); pc->cpu.out(0x3f9, 0);
                pc->cpu.out(0x3fb, 2); pc->cpu.out(0x3fc, 3);
                capture();
                SendMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
                if (mouseCaptured) throw std::runtime_error("Right Ctrl release no longer works");
                SendMessageW(hwnd, WM_KEYDOWN, VK_DELETE, LPARAM((0x53 << 16) | (1 << 24)));
                if (!poweredOn || !running || pc->bootDrive != 0x80 || pc->cpu.rb(0, 0x7c02) != 'C' ||
                    pc->cpu.model != expectedModel || fullSpeed != savedSpeed)
                    throw std::runtime_error("Right Ctrl+Del did not reboot after releasing capture");
                pc->cpu.wb(0, 0x7c02, 'X');
                SendMessageW(hwnd, WM_KEYDOWN, VK_DELETE, LPARAM((0x53 << 16) | (1 << 24) | (1 << 30)));
                if (pc->cpu.rb(0, 0x7c02) != 'X') throw std::runtime_error("Repeated Delete must not repeatedly reboot");
                SendMessageW(hwnd, WM_KEYUP, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
                SendMessageW(hwnd, WM_KEYDOWN, VK_DELETE, LPARAM((0x53 << 16) | (1 << 24)));
                if (pc->cpu.rb(0, 0x7c02) != 'X') throw std::runtime_error("Right Ctrl remained stuck after key-up");
                SendMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, LPARAM((0x1d << 16) | (1 << 24)));
                SendMessageW(hwnd, WM_KILLFOCUS, 0, 0);
                SendMessageW(hwnd, WM_KEYDOWN, VK_DELETE, LPARAM((0x53 << 16) | (1 << 24)));
                if (pc->cpu.rb(0, 0x7c02) != 'X') throw std::runtime_error("Right Ctrl remained stuck after focus loss");
                releaseKeyboard();
                if (expectedModel != CpuModel::I8088) {
                    auto& c = pc->cpu;
                    c.loadSegment(CS, 0); c.loadSegment(SS, 0); c.r[SP] = 0x9000; c.setFlags(2);
                    c.r[AX] = 0x5301; c.r[BX] = 0; c.trap(0x15);
                    c.r[AX] = 0x530e; c.r[CX] = 0x0101; c.trap(0x15);

                    // MOV AX,5307h / MOV BX,1 / MOV CX,3 / INT 15h：APM 全系统关机。
                    // 后接 MOV BYTE [0600h],FFh；它不能执行，否则前端未及时停止客体。
                    const uint8_t shutdown[] = {0xb8,7,0x53,0xbb,1,0,0xb9,3,0,0xcd,0x15,0xc6,6,0,6,0xff};
                    std::copy(std::begin(shutdown), std::end(shutdown), c.mem.begin() + 0x500);
                    c.mem[0x600] = 0;
                    c.ip = 0x500; c.halted = c.waiting = false;
                    executionTiming.reset(*pc, ExecutionTiming::HostClock::now() - std::chrono::milliseconds(10));
                    execute(hwnd);
                    if (poweredOn || running || !pc->powerOffRequested || c.mem[0x600] == 0xff)
                        throw std::runtime_error("Guest APM shutdown must stop execution and power off the GUI");
                    checkBlackScreen();
                    auto stoppedInstructions = pc->instructions;
                    SendMessageW(hwnd, WM_APP, 0, 0); SendMessageW(hwnd, WM_TIMER, 1, 0);
                    if (pc->instructions != stoppedInstructions)
                        throw std::runtime_error("APM-powered-off GUI must not resume execution");
                    SendMessageW(hwnd, WM_COMMAND, BootC, 0);
                    if (!poweredOn || !running || pc->powerOffRequested)
                        throw std::runtime_error("Explicit boot must clear guest APM shutdown state");
                }
            }
            if (fullSpeed) SendMessageW(hwnd, WM_COMMAND, FullSpeed, 0);
            if (stableTiming) SendMessageW(hwnd, WM_COMMAND, StableTiming, 0);
            SendMessageW(hwnd, WM_KEYDOWN, 'A', LPARAM(0x1e << 16));
            SendMessageW(hwnd, WM_COMMAND, PauseResume, 0);
            auto heldInstructions = pc->instructions; auto heldClock = pc->clock;
            Sleep(150); SendMessageW(hwnd, WM_TIMER, 1, 0); SendMessageW(hwnd, WM_APP, 0, 0);
            if (!paused || running || !poweredOn || pressedKeys[0x1e] || pc->instructions != heldInstructions || pc->clock != heldClock)
                throw std::runtime_error("Pause must release input and freeze both CPU and guest device time");
            unsigned prompts = 0;
            confirmationDecision = [&] { ++prompts; return false; };
            for (int action : {Reset, BootC, CtrlAltDel}) {
                SendMessageW(hwnd, WM_COMMAND, action, 0);
                if (!paused || running || !poweredOn || pc->instructions != heldInstructions || pc->clock != heldClock)
                    throw std::runtime_error("Declining a destructive action must preserve the paused machine");
            }
            SendMessageW(hwnd, WM_CLOSE, 0, 0);
            if (!IsWindow(hwnd) || prompts != 4) throw std::runtime_error("Closing a powered-on machine must honor a declined confirmation");
            confirmationDecision = [] { return true; };
            SendMessageW(hwnd, WM_COMMAND, PauseResume, 0);
            SendMessageW(hwnd, WM_TIMER, 1, 0);
            if (!running || paused || pc->instructions <= heldInstructions || pc->clock - heldClock > ExecutionTiming::PitHz * 0.05)
                throw std::runtime_error("Resume must execute without catching up the paused host interval");
            std::array<uint8_t, 512> bytes{};
            if (!pc->hard->read(0, bytes.data()) || !pc->hard->write(0, bytes.data())) throw std::runtime_error("Cannot exercise disk activity counters");
            statsOrigin = ExecutionTiming::HostClock::now() - std::chrono::seconds(1);
            updateStats(hwnd); GetWindowTextW(hwnd, caption, int(std::size(caption)));
            if (measuredMips <= 0 || activityReads != 1 || activityWrites != 1 || !std::wcsstr(caption, L"MIPS"))
                throw std::runtime_error("Runtime status must report measured guest work and actual successful disk I/O");
            SendMessageW(hwnd, WM_COMMAND, Reset, 0);
            pc->hard.reset();
            resetOverlay = std::filesystem::path(resetImages[0].wstring() + L".cow");
            pc->hard = std::make_unique<Disk>(resetImages[0], false, false, resetOverlay);
            std::array<uint8_t, 512> baseline{}, modified{}; modified.fill(0x4c);
            if (!pc->hard->read(7, baseline.data()) || !pc->hard->write(7, modified.data())) throw std::runtime_error("Cannot prepare overlay UI test");
            SendMessageW(hwnd, WM_COMMAND, BootC, 0); SendMessageW(hwnd, WM_COMMAND, PauseResume, 0);
            SendMessageW(hwnd, WM_COMMAND, DiscardOverlay, 0);
            if (!pc->hard->read(7, bytes.data()) || bytes != modified)
                throw std::runtime_error("A paused but powered-on machine must not allow overlay rollback");
            SendMessageW(hwnd, WM_COMMAND, Reset, 0);
            confirmationDecision = [] { return false; };
            SendMessageW(hwnd, WM_COMMAND, DiscardOverlay, 0);
            if (!pc->hard->read(7, bytes.data()) || bytes != modified) throw std::runtime_error("Declining overlay discard must preserve its writes");
            confirmationDecision = [] { return true; };
            SendMessageW(hwnd, WM_COMMAND, DiscardOverlay, 0);
            if (!pc->hard->read(7, bytes.data()) || bytes != baseline || std::filesystem::file_size(resetOverlay) != 64)
                throw std::runtime_error("Confirmed powered-off discard must restore the base disk view");
            std::cout << "Pause-resume / frozen guest time / no catch-up / measured MIPS-disk I/O / declined destructive actions / guarded overlay rollback checks passed\n";
        } catch (...) { releaseMouse(hwnd); SetCursorPos(savedCursor.x, savedCursor.y); removeResetImages(); throw; }
        if (!SetCursorPos(savedCursor.x, savedCursor.y)) throw std::runtime_error("Cannot restore reset-test cursor");
        std::cout << "Guest APM shutdown / black screen / stopped execution / explicit power-on checks passed\n";
        running = false; removeResetImages();
        std::cout << "Ctrl+Alt+Del menu / Right-Ctrl+Del / capture release / floppy-first / hard-disk fallback / CPU-speed preservation checks passed\n";
        pc = std::move(savedPc);
        unsigned acceptedClose = 0;
        confirmationDecision = [&] { ++acceptedClose; return true; };
        poweredOn = true;
        SendMessageW(hwnd, WM_CLOSE, 0, 0);
        if (IsWindow(hwnd) || acceptedClose != 1 || poweredOn || running)
            throw std::runtime_error("An accepted powered-on close must flush, power off and close the window");
        confirmationDecision = {};
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
        if (!std::wcsstr(GetCommandLineW(), L"--headless") && !std::wcsstr(GetCommandLineW(), L"--ui-test") &&
            !std::wcsstr(GetCommandLineW(), L"--discard-overlay"))
            MessageBoxW(nullptr, wide(e.what()).c_str(), L"Asm86", MB_OK | MB_ICONERROR);
        return 1;
    }
}
