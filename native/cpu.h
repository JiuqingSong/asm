#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <vector>

namespace asm86 {
enum { AX, CX, DX, BX, SP, BP, SI, DI };
enum { ES, CS, SS, DS, FS, GS };
enum : uint16_t { CF=1, PF=4, AF=16, ZF=64, SF=128, TF=256, IF=512, DF=1024, OF=2048 };
enum class CpuModel { I8088, I286, I386, I486 };
struct CpuFault { uint8_t vector; int code; };

class Cpu {
public:
    CpuModel model = CpuModel::I8088;
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
    std::function<uint8_t(uint16_t)> in;
    std::function<void(uint16_t, uint8_t)> out;
    std::function<uint32_t(uint16_t, unsigned)> inWide;
    std::function<void(uint16_t, uint32_t, unsigned)> outWide;
    std::function<bool(uint8_t)> trap;
    std::function<int()> irq;
    std::function<void()> resetSignal;
    std::function<void(CpuFault, uint32_t)> onFault;
    std::function<void(uint32_t)> onWrite;
    uint32_t mmioStart = 0, mmioEnd = 0;
    std::function<uint8_t(uint32_t)> mmioRead;
    std::function<void(uint32_t, uint8_t)> mmioWrite;

    uint8_t rb(uint16_t seg, uint16_t off) const;
    uint16_t rw(uint16_t seg, uint16_t off) const;
    void wb(uint16_t seg, uint16_t off, uint8_t value);
    void ww(uint16_t seg, uint16_t off, uint16_t value);
    // Firmware real-mode pointers still use the current guest page tables.
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
    void setModel(CpuModel value);
    bool supports386() const { return model >= CpuModel::I386; }
    void setFlags(uint16_t value);
    uint32_t inputPort(uint16_t port, unsigned size);
    void outputPort(uint16_t port, uint32_t value, unsigned size);
    bool protectedMode() const { return msw & 1; }
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
    struct Segment { uint32_t base = 0, limit = 0xffff; uint8_t access = 0x93, attributes = 0; bool null = false; };
    struct Descriptor : Segment { uint32_t address = 0, gateOffset = 0; uint16_t gateSelector = 0; uint8_t parameters = 0; };
    std::array<Segment, 6> segments{};
    // BIOS code and the 16-bit cores keep using the same low-word register bank.
    std::array<uint16_t, 8> upperR{};
    std::array<uint32_t, 8> debugRegisters{};
    uint32_t upperFlags = 0;
    uint8_t hiddenSegments = 0;
    int mod = 0, reg = 0, rm = 0, eaSeg = DS, overrideSeg = -1;
    uint32_t eaOff = 0, startIp = 0;
    uint8_t rep = 0;
    bool inhibit = false;
    bool taskCommitted = false;
    bool operand32 = false, address32 = false, lockPrefix = false;
    bool eaUsesSp = false;
    uint8_t fetch8();
    uint16_t fetch16();
    uint32_t fetch(int size);
    uint32_t fetch32();
    void modrm();
    uint32_t getReg(int size, int i) const;
    void setReg(int size, int i, uint32_t value);
    uint32_t getRM(int size);
    void setRM(int size, uint32_t value);
    void flag(uint16_t mask, bool value);
    void szp(uint16_t value, int size);
    uint16_t alu(int op, uint16_t a, uint16_t b, int size);
    uint16_t incdec(uint16_t value, int size, bool subtract);
    uint16_t shift(int op, uint16_t value, int count, int size);
    bool cond(int cc) const;
    void execute(uint8_t op);
    void string(uint8_t op);
    void muldiv(int op, int size);
    uint32_t segmentBase(int segment) const;
    void checkSegment(int segment, uint32_t offset, unsigned size, bool write, bool execute = false) const;
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
    void checkAlignment(uint32_t address, unsigned size) const;
    uint32_t offsetPlus(uint32_t offset, unsigned delta) const;
    [[noreturn]] static void fault(uint8_t vector, int code = -1);
};
}
