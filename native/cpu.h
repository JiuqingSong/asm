#pragma once
#include "fpu.h"
#include <array>
#include <cstdint>
#include <functional>
#include <type_traits>
#include <utility>
#include <vector>

namespace asm86 {
// 枚举顺序与 x86 寄存器编码一致，不可随意调整；AH..BH 复用 AX..BX 的高字节。
enum { AX, CX, DX, BX, SP, BP, SI, DI };
enum { ES, CS, SS, DS, FS, GS };
enum : uint16_t { CF=1, PF=4, AF=16, ZF=64, SF=128, TF=256, IF=512, DF=1024, OF=2048 };
enum class CpuModel { I8088, I286, I386, I486 };
struct CpuFault { uint8_t vector; int code; };

class Cpu {
    friend class Snapshot;
public:

    // 架构可见状态：通用/段寄存器、控制寄存器、描述符表和 x87。
    CpuModel model = CpuModel::I8088;
    Fpu fpu;
    bool hasFpu() const { return model == CpuModel::I486; }
    std::function<void(bool)> fpuIrq;
    void clearFpuIrq();
    bool a20 = false;
    uint32_t msw = 0xfff0, cr2 = 0, cr3 = 0;
    unsigned cpl = 0;
    struct Table { uint32_t base = 0, limit = 0; };
    struct SystemSegment { uint16_t selector = 0; uint32_t base = 0, limit = 0; uint8_t access = 0; };
    Table gdtr{0, 0xffff}, idtr{0, 0x3ff};
    SystemSegment ldtr{}, tr{};
    std::vector<uint8_t> mem = std::vector<uint8_t>(1 << 20);
    std::array<uint16_t, 8> r{};
    std::array<uint16_t, 6> s{};
    uint32_t ip = 0;
    uint16_t flags = 0xf002;
    bool halted = false, waiting = false, repContinue = false;

    // 设备桥接：CPU 只执行 IN/OUT、MMIO 和 IRQ 协议，具体外设由 Pc 绑定。
    std::function<uint8_t(uint16_t)> in;
    std::function<void(uint16_t, uint8_t)> out;
    std::function<uint32_t(uint16_t, unsigned)> inWide;
    std::function<void(uint16_t, uint32_t, unsigned)> outWide;
    std::function<bool(uint8_t)> trap;
    std::function<int()> irq;
    // 可选：主/从 PIC 的 IRR 与 IMR 字节地址（pending0, mask0, pending1, mask1）。
    // 两片都没有未屏蔽请求时不调用 irq()，避免每条指令一次间接调用；为空时每条指令都询问 irq()。
    std::array<const uint8_t*, 4> irqRequest{};
    std::function<void()> resetSignal;
    std::function<void(CpuFault, uint32_t)> onFault;
    std::function<void(uint32_t)> onWrite;
    uint32_t mmioStart = 0, mmioEnd = 0;
    std::array<std::pair<uint32_t, uint64_t>, 3> pciWindows{};
    bool mmioAddress(uint32_t address, unsigned size = 1) const;
    std::function<uint8_t(uint32_t)> mmioRead;
    std::function<void(uint32_t, uint8_t)> mmioWrite;

    // 分页 TLB：缓存线性页到物理页的翻译，不属于架构状态（快照不保存）。
    // MOV CR3、CR0 写入、任务切换、INVLPG 和复位时清空；CR3/CR0 被外部直接改写时也自动清空。
    void flushTlb();
    // 宿主改了 MMIO 窗口、PCI 窗口或内存钩子（onWrite/mmioRead/mmioWrite）后必须使 TLB 失效；
    // Pc 在每段执行前调用，直接驱动 Cpu 的测试在修改这些成员后也应调用。
    void validateTlb() { if (tlbStale()) flushTlb(); }

    uint8_t rb(uint16_t seg, uint16_t off) const;
    uint16_t rw(uint16_t seg, uint16_t off) const;
    void wb(uint16_t seg, uint16_t off, uint8_t value);
    void ww(uint16_t seg, uint16_t off, uint16_t value);

    // BIOS 的 segment:offset 参数仍是客体地址，必须经过当前页表（含 VM86 重映射）。
    uint8_t rbF(uint16_t seg, uint16_t off);
    uint16_t rwF(uint16_t seg, uint16_t off);
    void wbF(uint16_t seg, uint16_t off, uint8_t value);
    void wwF(uint16_t seg, uint16_t off, uint16_t value);
    uint8_t reg8(int i) const;
    void reg8(int i, uint8_t value);
    uint32_t r32(int i) const;
    void r32(int i, uint32_t value);
    uint32_t eflags() const;
    void setEflags(uint32_t value);
    uint8_t readLinear(uint32_t address, bool supervisor = false);
    void writeLinear(uint32_t address, uint8_t value, bool supervisor = false);
    uint32_t readDword(uint32_t address) const;
    void writeDword(uint32_t address, uint32_t value);
    uint32_t readSegment(int segment, uint32_t offset, unsigned size);
    void writeSegment(int segment, uint32_t offset, uint32_t value, unsigned size);
    void push(uint16_t value);
    uint16_t pop();
    void interrupt(uint8_t number, int code = -1, bool software = false, bool external = false);
    void setModel(CpuModel value, unsigned memoryMiB = 0);
    bool supports386() const { return model >= CpuModel::I386; }
    void setFlags(uint16_t value);
    uint32_t inputPort(uint16_t port, unsigned size);
    void outputPort(uint16_t port, uint32_t value, unsigned size);
    bool protectedMode() const { return msw & 1; }

    // readPhysical/writePhysical 保留 CPU 的 A20 行为；readBus/writeBus 专供 DMA 总线访问。
    uint8_t readPhysical(uint32_t address) const;
    uint8_t readBus(uint32_t address) const;
    uint16_t readWord(uint32_t address) const;
    void writePhysical(uint32_t address, uint8_t value);
    void writeBus(uint32_t address, uint8_t value);
    void writeWord(uint32_t address, uint16_t value);
    uint8_t rbS(int segment, uint32_t offset);
    uint16_t rwS(int segment, uint32_t offset);
    void wbS(int segment, uint32_t offset, uint8_t value);
    void wwS(int segment, uint32_t offset, uint16_t value);
    void loadSegment(int segment, uint16_t selector);
    void step();
    void reset();
    void stackedFlag(uint16_t mask, bool value);
private:

    // 段寄存器的隐藏缓存保存描述符基址、界限和权限；可见 selector 本身不足以寻址。
    struct Segment { uint32_t base = 0, limit = 0xffff; uint8_t access = 0x93, attributes = 0; bool null = false; };
    struct Descriptor : Segment { uint32_t address = 0, gateOffset = 0; uint16_t gateSelector = 0; uint8_t parameters = 0; };
    std::array<Segment, 6> segments{};

    // 32 位寄存器拆成上下两半，保证 BIOS 和 16 位核心仍共用同一份低字寄存器。
    std::array<uint16_t, 8> upperR{};
    std::array<uint32_t, 8> debugRegisters{};
    uint32_t upperFlags = 0;
    uint8_t hiddenSegments = 0;

    // 直接映射 TLB。key = (代号 << 32) | 线性页号，清空只需递增代号；host 指向该页在宿主 RAM 中的起点
    // （只缓存整页都是普通 RAM 的翻译）。bits：PDE&PTE 的 U/S(4)、R/W(2)；0x40 表示 PTE 的 D 位已置。
    // 分页关闭时同样缓存恒等映射（bits 全开），供实模式/VM86 直接访问宿主内存。
    struct TlbEntry { uint64_t key = 0; uint8_t* host = nullptr; uint32_t frame = 0; uint8_t bits = 0; };
    static constexpr unsigned TlbEntries = 4096;
    std::array<TlbEntry, TlbEntries> tlb{}; // 内嵌数组，查表少一次指针加载。
    uint32_t tlbGeneration = 1;
    uint32_t tlbCr3 = 0, tlbMsw = 0, tlbMmioStart = 0, tlbMmioEnd = 0;
    bool tlbA20 = false; uint8_t tlbHooks = 0; const uint8_t* tlbMemory = nullptr; // Cpu 被复制或内存重新分配后 host 指针失效。
    uint8_t memoryHooks() const { return uint8_t((onWrite ? 1 : 0) | (mmioRead ? 2 : 0) | (mmioWrite ? 4 : 0)); }
    bool tlbStale() const {
        return cr3 != tlbCr3 || (msw & 0x80010000u) != tlbMsw || mmioStart != tlbMmioStart || mmioEnd != tlbMmioEnd
            || a20 != tlbA20 || memoryHooks() != tlbHooks || mem.data() != tlbMemory;
    }
    // 每次访问只检查指令执行中可能改变的 CR3/CR0/A20/内存缓冲区；MMIO 窗口与内存钩子只由宿主在指令之间修改，
    // 由 step() 开头和慢路径中的完整 tlbStale() 检查。
    bool tlbStaleFast() const {
        return cr3 != tlbCr3 || (msw & 0x80010000u) != tlbMsw || a20 != tlbA20 || mem.data() != tlbMemory;
    }
    uint64_t tlbKey(uint32_t linear) const { return (uint64_t(tlbGeneration) << 32) | (linear >> 12); }
    TlbEntry& tlbEntry(uint32_t linear) { return tlb[(linear >> 12) & (TlbEntries - 1)]; }
    void fillTlb(uint32_t linear, uint32_t frame, uint8_t bits);
    bool userAccess() const { return cpl == 3 || virtual8086(); }

    // 命中 TLB 且本次访问权限、D 位均满足时返回宿主内存指针，否则返回 nullptr 由慢路径处理
    // （慢路径负责 #PF、A/D 位、MMIO 与失效）。调用者须保证访问不跨页。
    __attribute__((always_inline)) uint8_t* hostAddress(uint32_t linear, bool write, bool user) {
        if (tlbStaleFast()) return nullptr;
        const auto& entry = tlb[(linear >> 12) & (TlbEntries - 1)];
        if (entry.key != tlbKey(linear)) return nullptr;
        const unsigned bits = entry.bits;
        if (user && !(bits & 4)) return nullptr;
        if (write && (!(bits & 0x40) || (!(bits & 2) && (user || (model == CpuModel::I486 && (msw & 0x10000)))))) return nullptr;
        return entry.host + (linear & 4095);
    }

    // 取指窗口：指令开始时查一次代码页，fetchHost[i] 对应 IP = startIp + i，i < fetchCount 时
    // 已满足 CS 界限、15 字节上限与页内连续；超出窗口回到逐字节慢路径（产生精确的 #GP/#PF）。
    // 读的是实时宿主内存而非副本，因此自修改代码的结果与慢路径相同。
    const uint8_t* fetchHost = nullptr; uint32_t fetchCount = 0;
    void openFetchWindow();

    // 单条指令的译码暂存：ModR/M、有效地址、前缀、起始 IP 和默认操作数宽度。
    int mod = 0, reg = 0, rm = 0, eaSeg = DS, overrideSeg = -1;
    uint32_t eaOff = 0, startIp = 0;
    uint8_t rep = 0;
    bool inhibit = false;
    bool taskCommitted = false;
    bool operand32 = false, address32 = false, lockPrefix = false;
    bool eaUsesSp = false;
    bool fpuIrqRaised = false, fpuIrqInhibited = false;
    uint32_t busAddress(uint32_t address) const;
    const uint8_t* physicalRam(uint32_t address, unsigned size) const;
    void updateFpuIrq();
    bool waitFpu();
    void executeFpu(uint8_t op);
    uint8_t fetch8();
    uint16_t fetch16();
    uint32_t fetch(int size);
    uint32_t fetch32();
    uint32_t fetchWide(unsigned size);
    void modrm();
    uint32_t getReg(int size, int i) const;
    void setReg(int size, int i, uint32_t value);
    uint32_t getRM(int size);
    void setRM(int size, uint32_t value);
    void flag(uint16_t mask, bool v) { flags = v ? flags | mask : flags & ~mask; }
    void szp(uint16_t value, int size);
    uint16_t alu(int op, uint16_t a, uint16_t b, int size);
    uint16_t incdec(uint16_t value, int size, bool subtract);
    uint16_t shift(int op, uint16_t value, int count, int size);
    bool cond(int cc) const;
    void execute(uint8_t op);
    void string(uint8_t op);
    void muldiv(int op, int size);
    uint32_t segmentBase(int segment) const {
        return protectedMode() || (hiddenSegments & (1 << segment)) ? segments[segment].base : uint32_t(s[segment]) << 4;
    }
    // 每次取指和内存访问都要检查，内联后 size/write/execute 多为常量，可在调用处折叠。
    __attribute__((always_inline)) void checkSegment(int segment, uint32_t offset, unsigned size, bool write, bool execute = false) const {
        if (!protectedMode() || virtual8086()) {
            if (supports386() && uint64_t(offset) + size - 1 > segments[segment].limit) fault(segment == SS ? 12 : 13, 0);
            return;
        }
        const auto& d = segments[segment]; uint8_t vector = segment == SS ? 12 : 13;
        if (d.null || !(d.access & 0x80)) fault(vector, 0);

        // LOADALL 可能给 CS 隐藏缓存安装可写数据描述符，执行检查不能假设它一定是代码段。
        if (!execute && (write ? ((d.access & 8) || !(d.access & 2)) : ((d.access & 10) == 8))) fault(vector, 0);
        uint64_t end = uint64_t(offset) + size - 1;
        if ((d.access & 12) == 4) { if (offset <= d.limit || end > (d.attributes & 0x40 ? 0xffffffffu : 65535u)) fault(vector, 0); }
        else if (end > d.limit) fault(vector, 0);
    }
    void stepInstruction();
    void exec186(uint8_t op);
    void execSystem();
    void loadAll();
    void requireRing0() const;
    void requireIo() const;
    void checkIo(uint16_t port, unsigned size);
    bool virtual8086() const { return supports386() && (upperFlags & 0x20000); }
    void loadVirtualSegment(int segment, uint16_t selector);
    Descriptor descriptor(uint16_t selector, uint8_t vector = 13);
    Descriptor codeDescriptor(uint16_t selector);
    void cache(int segment, uint16_t selector, Descriptor descriptor);
    void loadCode(uint16_t selector, Descriptor descriptor, unsigned level);
    void loadLdt(uint16_t selector, uint8_t vector = 13);
    void switchStack(unsigned level);
    void farJump(uint16_t selector, uint32_t offset, bool call = false);
    void farReturn(uint16_t adjustment, bool interruptReturn);
    void farReturn386(uint16_t adjustment, bool interruptReturn);
    void taskSwitch(uint16_t selector, bool nested, bool returning = false);
    void taskSwitch386(uint16_t selector, bool nested, bool returning);
    void protectedInterrupt(uint8_t number, int code, bool software, bool external);
    void popFlags(uint16_t value, unsigned oldLevel);
    void nullifyData();
    bool exec386(uint8_t op);
    void system386();
    void setControl0(uint32_t value);
    void string386(uint8_t op);
    uint32_t alu32(int op, uint32_t a, uint32_t b);
    uint32_t shift32(int op, uint32_t value, unsigned count);
    void muldiv32(int op);
    uint32_t stackPointer() const;
    void stackPointer(uint32_t value);
    void pushValue(uint32_t value, unsigned size);
    uint32_t popValue(unsigned size);
    void validateStackPush(unsigned count, unsigned size);
    uint32_t readSystem(uint32_t address, unsigned size);
    void writeSystem(uint32_t address, uint32_t value, unsigned size);
    uint32_t translate(uint32_t address, bool write, bool supervisor);
    template<bool Operand> uint32_t translatePage(uint32_t address, bool write, std::conditional_t<Operand, bool*, bool> access);
    bool translateOperand(uint32_t address, unsigned size, bool write, std::array<uint32_t, 4>& physical);
    void checkAlignment(uint32_t address, unsigned size) const;
    uint32_t offsetPlus(uint32_t offset, unsigned delta) const;
    [[noreturn]] static void fault(uint8_t vector, int code = -1);
};
}
