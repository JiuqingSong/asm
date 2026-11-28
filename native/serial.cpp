#include "serial.h"
#include <algorithm>

// COM1 的 8250 UART 与 Microsoft 三字节串口鼠标；字节按串行传输时间排队，而非瞬间送达。
namespace asm86 {
namespace {
constexpr double MouseByteClocks = 1193182.0 * 9 / 1200;
// 'M' 之后是即插即用 COM 设备规范 1.00 的 6 位 ID：Begin 08h、修订 1.00（01h 24h）、"PNP0F01" 每字符减 20h、End 09h。
// 6 位编码不置位 bit 6，旧驱动会把它当作非包头字节丢弃；Windows 2000 的 serenum 只凭此 ID 才安装串口鼠标驱动。
constexpr uint8_t Identification[] = {0x4d, 0x08, 0x01, 0x24, 0x30, 0x2e, 0x30, 0x10, 0x26, 0x10, 0x11, 0x09};
}

unsigned SerialMouse::divisor() const {
    unsigned value = (unsigned(dlm) << 8) | dll; return value ? value : 65536;
}

void SerialMouse::reset() {
    dll = 12; dlm = ier = mcr = scratch = rbr = delta = buttons = lastButtons = 0;
    lcr = 3; lsr = 0x60; msr = 0x30;
    txPending = txInterrupt = identified = false; pendingX = pendingY = 0;
    queue.clear(); nextEvent = std::numeric_limits<double>::infinity();
    if (irqLine && setIrq) setIrq(false);
    irqLine = false;
}

uint8_t SerialMouse::interruptId() const {
    // UART 中断优先级：线路错误 > 接收可读 > 发送空 > Modem 状态变化；IIR=1 表示无中断。
    if ((ier & 4) && (lsr & 0x1e)) return 6;
    if ((ier & 1) && (lsr & 1)) return 4;
    if ((ier & 2) && txInterrupt) return 2;
    if ((ier & 8) && delta) return 0;
    return 1;
}

void SerialMouse::updateIrq() {
    bool raised = (mcr & 8) && interruptId() != 1;
    if (raised != irqLine) { irqLine = raised; if (setIrq) setIrq(raised); }
}

void SerialMouse::schedule() {
    nextEvent = queue.empty() ? std::numeric_limits<double>::infinity() : queue.front().at;
    if (txPending) nextEvent = std::min(nextEvent, txDone);
}

void SerialMouse::receive(uint8_t value) {
    if (lsr & 1) lsr |= 2;
    else { rbr = value; lsr |= 1; }
}

void SerialMouse::packet(double now) {
    // 鼠标包不是机器码：首字节 01LRyyxx，后两字节为 x/y 低 6 位；位移分拆到 -128..127。
    if (!queue.empty() || !identified || (mcr & 0x13) != 3 || divisor() != 96) return;
    if (!pendingX && !pendingY && buttons == lastButtons) return;
    int x = int(std::max<int64_t>(-128, std::min<int64_t>(127, pendingX)));
    int y = int(std::max<int64_t>(-128, std::min<int64_t>(127, pendingY)));
    pendingX -= x; pendingY -= y; lastButtons = buttons;
    const uint8_t bytes[] = {
        uint8_t(0x40 | ((buttons & 1) << 5) | ((buttons & 2) << 3) | ((uint8_t(y) >> 6) << 2) | (uint8_t(x) >> 6)),
        uint8_t(x & 63), uint8_t(y & 63)
    };
    for (unsigned i = 0; i < 3; ++i) queue.push_back({now + MouseByteClocks * (i + 1), bytes[i]});
}

void SerialMouse::advance(double now) {
    if (txPending && now >= txDone) {
        txPending = false; lsr |= 0x60; txInterrupt = true;
        if (mcr & 16) receive(transmitted);
    }
    while (!queue.empty() && queue.front().at <= now) {
        auto byte = queue.front(); queue.pop_front();
        bool sameFormat = divisor() == 96 && !(lcr & 0x3c) && (lcr & 3) >= 2;
        auto value = uint8_t(byte.value | ((lcr & 3) == 3 ? 0x80 : 0));
        if (!sameFormat) lsr |= 8;
        receive(value);
        if (queue.empty()) packet(byte.at);
    }
    schedule(); updateIrq();
}

void SerialMouse::motion(int dx, int dy, uint8_t value, double now) {
    advance(now); buttons = value & 3;
    if (identified && !(mcr & 16)) { pendingX += dx; pendingY += dy; packet(now); }
    else { pendingX = pendingY = 0; lastButtons = buttons; }
    schedule();
}

uint8_t SerialMouse::input(unsigned offset, double now) {
    // offset 0/1 在 LCR.DLAB=1 时变为 DLL/DLM，否则是接收数据/IER；读状态有确认副作用。
    advance(now);
    uint8_t value = 0;
    switch (offset) {
    case 0:
        if (lcr & 0x80) return dll;
        value = rbr; lsr &= ~1; break;
    case 1: return lcr & 0x80 ? dlm : ier;
    case 2: value = interruptId(); if (value == 2) txInterrupt = false; break;
    case 3: return lcr;
    case 4: return mcr;
    case 5: value = lsr; lsr &= ~0x1e; break;
    case 6: value = msr | delta; delta = 0; break;
    case 7: return scratch;
    }
    updateIrq(); return value;
}

void SerialMouse::output(unsigned offset, uint8_t value, double now) {
    // MCR 的 DTR/RTS 电平变化触发鼠标识别：4Dh（'M'）加即插即用 ID；loopback 则走 UART 回环。
    advance(now);
    switch (offset) {
    case 0:
        if (lcr & 0x80) { dll = value; break; }
        transmitted = value; lsr &= ~0x60; txInterrupt = false; txPending = true;
        txDone = now + (1 + 5 + (lcr & 3) + ((lcr & 8) ? 1 : 0) + ((lcr & 4) ? 2 : 1))
            * double(divisor()) * 1193182 / 115200;
        break;
    case 1:
        if (lcr & 0x80) dlm = value;
        else {
            if (!(ier & 2) && (value & 2) && (lsr & 0x20)) txInterrupt = true;
            ier = value & 15;
        }
        break;
    case 3: lcr = value; break;
    case 4: {
        auto previous = mcr; mcr = value & 31;
        uint8_t inputs = mcr & 16 ? uint8_t(((mcr & 2) << 3) | ((mcr & 1) << 5) | ((mcr & 4) << 4) | ((mcr & 8) << 4)) : 0x30;
        uint8_t changes = inputs ^ msr;
        delta |= uint8_t(((changes & 0x10) >> 4) | ((changes & 0x20) >> 4) | ((changes & 0x80) >> 4)
            | ((msr & ~inputs & 0x40) >> 4));
        msr = inputs;
        if ((previous ^ mcr) & 0x13) {
            queue.clear(); identified = false; pendingX = pendingY = 0; lastButtons = buttons;
            if ((mcr & 0x13) == 3) {
                identified = true;
                for (unsigned i = 0; i < sizeof Identification; ++i)
                    queue.push_back({now + MouseByteClocks * (i + 2), Identification[i]});
            }
        }
        break;
    }
    case 7: scratch = value; break;
    }
    packet(now); schedule(); updateIrq();
}
}
