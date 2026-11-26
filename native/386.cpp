#include "cpu.h"
#include <limits>
#include <stdexcept>

namespace asm86 {
uint32_t Cpu::r32(int i) const { return r[i] | (uint32_t(upperR[i]) << 16); }
void Cpu::r32(int i, uint32_t value) { r[i] = uint16_t(value); upperR[i] = uint16_t(value >> 16); }
uint32_t Cpu::eflags() const { return flags | upperFlags; }
void Cpu::setEflags(uint32_t value) {
    setFlags(uint16_t(value));
    upperFlags = value & (model == CpuModel::I486 ? 0x270000u : supports386() ? 0x30000u : 0);
}
uint32_t Cpu::fetch32() { auto low = fetch16(); return low | (uint32_t(fetch16()) << 16); }
uint32_t Cpu::readDword(uint32_t address) const { return readWord(address) | (uint32_t(readWord(address + 2)) << 16); }
void Cpu::writeDword(uint32_t address, uint32_t value) { writeWord(address, uint16_t(value)); writeWord(address + 2, uint16_t(value >> 16)); }
uint32_t Cpu::translate(uint32_t address, bool write, bool supervisor) {
    if (!supports386() || !(msw & 0x80000000u)) return address;
    const bool user = !supervisor && (cpl == 3 || virtual8086());
    auto missing = [&](bool present) {
        cr2 = address; fault(14, (present ? 1 : 0) | (write ? 2 : 0) | (user ? 4 : 0));
    };
    auto directory = (cr3 & 0xfffff000u) + (address >> 22) * 4;
    auto pde = readDword(directory);
    if (!(pde & 1)) missing(false);
    auto table = (pde & 0xfffff000u) + ((address >> 12) & 1023) * 4;
    auto pte = readDword(table);
    if (!(pte & 1)) missing(false);
    if (user && (!(pde & pte & 4) || (write && !(pde & pte & 2)))) missing(true);
    if (write && !user && model == CpuModel::I486 && (msw & 0x10000) && !(pde & pte & 2)) missing(true);
    if (!(pde & 0x20)) writeDword(directory, pde | 0x20);
    auto updated = pte | 0x20 | (write ? 0x40 : 0);
    if (updated != pte) writeDword(table, updated);
    return (pte & 0xfffff000u) | (address & 4095);
}
uint8_t Cpu::readLinear(uint32_t address, bool supervisor) { return readPhysical(translate(address, false, supervisor)); }
void Cpu::writeLinear(uint32_t address, uint8_t value, bool supervisor) { writePhysical(translate(address, true, supervisor), value); }
void Cpu::checkAlignment(uint32_t address, unsigned size) const {
    if (model == CpuModel::I486 && protectedMode() && cpl == 3 && (msw & 0x40000)
        && (upperFlags & 0x40000) && (address & (size - 1))) fault(17, 0);
}
uint8_t Cpu::rbF(uint16_t seg, uint16_t off) { return readLinear((uint32_t(seg) << 4) + off); }
uint16_t Cpu::rwF(uint16_t seg, uint16_t off) { return rbF(seg, off) | (uint16_t(rbF(seg, uint16_t(off + 1))) << 8); }
void Cpu::wbF(uint16_t seg, uint16_t off, uint8_t value) { writeLinear((uint32_t(seg) << 4) + off, value); }
void Cpu::wwF(uint16_t seg, uint16_t off, uint16_t value) {
    auto base = uint32_t(seg) << 4;
    auto low = translate(base + off, true, false), high = translate(base + uint16_t(off + 1), true, false);
    writePhysical(low, uint8_t(value)); writePhysical(high, uint8_t(value >> 8));
}
uint32_t Cpu::offsetPlus(uint32_t offset, unsigned delta) const {
    return supports386() ? offset + delta : uint16_t(offset + delta);
}
uint32_t Cpu::readSegment(int segment, uint32_t offset, unsigned size) {
    if (size == 1) return rbS(segment, offset);
    if (size == 2) return rwS(segment, offset);
    if (size != 4) throw std::runtime_error("Invalid CPU memory operand size");
    checkSegment(segment, offset, size, false);
    auto base = segmentBase(segment); uint32_t value = 0;
    std::array<uint32_t, 4> physical{};
    for (unsigned i = 0; i < size; ++i) physical[i] = translate(base + offset + i, false, false);
    checkAlignment(base + offset, size);
    for (unsigned i = 0; i < size; ++i) value |= uint32_t(readPhysical(physical[i])) << (i * 8);
    return value;
}
void Cpu::writeSegment(int segment, uint32_t offset, uint32_t value, unsigned size) {
    if (size == 1) { wbS(segment, offset, uint8_t(value)); return; }
    if (size == 2) { wwS(segment, offset, uint16_t(value)); return; }
    if (size != 4) throw std::runtime_error("Invalid CPU memory operand size");
    checkSegment(segment, offset, size, true);
    std::array<uint32_t, 4> physical{};
    for (unsigned i = 0; i < size; ++i) physical[i] = translate(segmentBase(segment) + offset + i, true, false);
    checkAlignment(segmentBase(segment) + offset, size);
    for (unsigned i = 0; i < size; ++i) writePhysical(physical[i], uint8_t(value >> (i * 8)));
}
uint32_t Cpu::stackPointer() const {
    return supports386() && (segments[SS].attributes & 0x40) ? r32(SP) : r[SP];
}
void Cpu::stackPointer(uint32_t value) {
    if (supports386() && (segments[SS].attributes & 0x40)) r32(SP, value);
    else r[SP] = uint16_t(value);
}
void Cpu::pushValue(uint32_t value, unsigned size) {
    auto sp = stackPointer() - size;
    if (!supports386() || !(segments[SS].attributes & 0x40)) sp = uint16_t(sp);
    writeSegment(SS, sp, value, size); stackPointer(sp);
}
uint32_t Cpu::popValue(unsigned size) {
    auto sp = stackPointer(), value = readSegment(SS, sp, size);
    stackPointer(sp + size); return value;
}
uint32_t Cpu::readSystem(uint32_t address, unsigned size) {
    uint32_t value = 0;
    for (unsigned i = 0; i < size; ++i) value |= uint32_t(readLinear(address + i, true)) << (i * 8);
    return value;
}
void Cpu::writeSystem(uint32_t address, uint32_t value, unsigned size) {
    std::array<uint32_t, 4> physical{};
    for (unsigned i = 0; i < size; ++i) physical[i] = translate(address + i, true, true);
    for (unsigned i = 0; i < size; ++i) writePhysical(physical[i], uint8_t(value >> (i * 8)));
}
void Cpu::checkIo(uint16_t port, unsigned size) {
    if (!protectedMode()) return;
    if (!virtual8086() && cpl <= unsigned((flags >> 12) & 3)) return;
    if (!supports386() || !(tr.access & 8) || tr.limit < 103) fault(13, 0);
    auto base = readSystem(tr.base + 102, 2), offset = base + (unsigned(port) >> 3);
    if (offset + 1 > tr.limit) fault(13, 0);
    auto bits = readSystem(tr.base + offset, 2);
    if (bits & (((1u << size) - 1) << (port & 7))) fault(13, 0);
}
void Cpu::validateStackPush(unsigned count, unsigned size) {
    if (!supports386()) return;
    auto sp = stackPointer();
    for (unsigned n = 0; n < count; ++n) {
        sp -= size; if (!(segments[SS].attributes & 0x40)) sp = uint16_t(sp);
        checkSegment(SS, sp, size, true);
        for (unsigned i = 0; i < size; ++i) translate(segmentBase(SS) + sp + i, true, false);
    }
}
void Cpu::farReturn386(uint16_t adjustment, bool interruptReturn) {
    bool vm = virtual8086();
    if (vm && interruptReturn) requireIo();
    if (!vm && protectedMode() && interruptReturn && (flags & 0x4000)) {
        if (tr.limit < 1) fault(10, tr.selector & 0xfffc);
        taskSwitch(uint16_t(readSystem(tr.base, 2)), false, true); return;
    }
    unsigned size = operand32 ? 4 : 2, consumed = size * (interruptReturn ? 3 : 2);
    auto sp = stackPointer();
    checkSegment(SS, sp, consumed, false);
    auto at = [&](unsigned delta) {
        auto off = sp + delta; if (!(segments[SS].attributes & 0x40)) off = uint16_t(off);
        return readSegment(SS, off, size);
    };
    auto offset = at(0); auto selector = uint16_t(at(size));
    auto value = interruptReturn ? at(size * 2) : eflags();
    if (!protectedMode() || vm) {
        if (offset > 0xffff) fault(13, 0);
        stackPointer(sp + consumed + adjustment); loadSegment(CS, selector); ip = offset;
        if (interruptReturn) {
            if (vm) popFlags(uint16_t(value), cpl); else setFlags(uint16_t(value));
            if (size == 4) upperFlags = (upperFlags & 0x20000) | (value & (model == CpuModel::I486 ? 0x250000u : 0x10000u));
        }
        return;
    }
    if (interruptReturn && size == 4 && !cpl && (value & 0x20000)) {
        checkSegment(SS, sp, 36, false);
        if (offset > 0xffff) fault(13, 0);
        auto newSp = at(12);
        std::array<uint16_t, 6> selectors{};
        selectors[CS] = selector; selectors[SS] = uint16_t(at(16));
        selectors[ES] = uint16_t(at(20)); selectors[DS] = uint16_t(at(24));
        selectors[FS] = uint16_t(at(28)); selectors[GS] = uint16_t(at(32));
        setEflags(value); cpl = 3;
        for (unsigned i = 0; i < selectors.size(); ++i) loadVirtualSegment(int(i), selectors[i]);
        r32(SP, newSp); ip = offset; return;
    }
    unsigned oldLevel = cpl, level = selector & 3;
    if (level < cpl) fault(13, selector & 0xfffc);
    auto d = codeDescriptor(selector); unsigned dpl = (d.access >> 5) & 3;
    if (d.access & 4 ? dpl > level : dpl != level) fault(13, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    if (offset > d.limit) fault(13, 0);
    if (level > cpl) {
        checkSegment(SS, sp, consumed + adjustment + size * 2, false);
        auto newSp = at(consumed + adjustment); auto newSs = uint16_t(at(consumed + adjustment + size));
        if (!(newSs & 0xfffc)) fault(13, 0);
        auto stack = descriptor(newSs);
        if ((newSs & 3) != level || unsigned((stack.access >> 5) & 3) != level || (stack.access & 0x1a) != 0x12)
            fault(13, newSs & 0xfffc);
        if (!(stack.access & 0x80)) fault(12, newSs & 0xfffc);
        loadCode(selector, d, level); cache(SS, newSs, stack); r32(SP, newSp);
        stackPointer(stackPointer() + adjustment); nullifyData();
    } else { loadCode(selector, d, level); stackPointer(sp + consumed + adjustment); }
    ip = offset;
    if (interruptReturn) {
        popFlags(uint16_t(value), oldLevel);
        auto mask = model == CpuModel::I486 ? 0x250000u : 0x10000u;
        if (size == 4) upperFlags = (upperFlags & ~mask) | (value & mask);
    }
}
void Cpu::taskSwitch386(uint16_t selector, bool nested, bool returning) {
    uint8_t vector = returning ? 10 : 13;
    if (!(selector & 0xfffc) || (selector & 4)) fault(vector, selector & 0xfffc);
    auto d = descriptor(selector, vector); unsigned type = d.access & 31;
    bool wide = type & 8, oldWide = tr.access & 8;
    if (type != unsigned(returning ? 3 : 1) && type != unsigned(returning ? 11 : 9)) fault(vector, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    if (d.limit < (wide ? 103u : 43u)) fault(10, selector & 0xfffc);
    if (tr.limit < (oldWide ? 103u : 43u)) fault(10, tr.selector & 0xfffc);
    auto nextIp = readSystem(d.base + (wide ? 32 : 14), wide ? 4 : 2);
    auto nextFlags = readSystem(d.base + (wide ? 36 : 16), wide ? 4 : 2);
    auto nextCr3 = wide && (msw & 0x80000000u) ? readSystem(d.base + 28, 4) : cr3;
    std::array<uint32_t, 8> registers{};
    std::array<uint16_t, 6> selectors{};
    for (unsigned i = 0; i < 8; ++i) registers[i] = readSystem(d.base + (wide ? 40 + i * 4 : 18 + i * 2), wide ? 4 : 2);
    for (unsigned i = 0; i < (wide ? 6u : 4u); ++i) selectors[i] = uint16_t(readSystem(d.base + (wide ? 72 + i * 4 : 34 + i * 2), 2));
    auto nextLdt = uint16_t(readSystem(d.base + (wide ? 96 : 42), 2));
    if (wide && (readSystem(d.base + 100, 2) & 1))
        throw std::runtime_error("386 task-switch debug traps are not implemented yet");
    auto validate = [&](uint32_t address, unsigned size) {
        for (unsigned i = 0; i < size; ++i) translate(address + i, true, true);
    };
    auto old = !nested ? descriptor(tr.selector) : Descriptor{};
    validate(tr.base + (oldWide ? 32 : 14), oldWide ? 40 : 20);
    for (unsigned i = 0; i < (oldWide ? 6u : 4u); ++i) validate(tr.base + (oldWide ? 72 + i * 4 : 34 + i * 2), 2);
    if (!nested) validate(old.address + 5, 1);
    if (!returning) validate(d.address + 5, 1);
    if (nested) validate(d.base, 2);
    auto savedFlags = returning ? eflags() & ~0x4000u : eflags();
    writeSystem(tr.base + (oldWide ? 32 : 14), ip, oldWide ? 4 : 2);
    writeSystem(tr.base + (oldWide ? 36 : 16), savedFlags, oldWide ? 4 : 2);
    for (unsigned i = 0; i < 8; ++i)
        writeSystem(tr.base + (oldWide ? 40 + i * 4 : 18 + i * 2), oldWide ? r32(i) : r[i], oldWide ? 4 : 2);
    for (unsigned i = 0; i < (oldWide ? 6u : 4u); ++i) writeSystem(tr.base + (oldWide ? 72 + i * 4 : 34 + i * 2), s[i], 2);
    if (!nested) writeSystem(old.address + 5, old.access & ~2, 1);
    if (!returning) writeSystem(d.address + 5, d.access | 2, 1);
    if (nested) writeSystem(d.base, tr.selector, 2);
    tr = {selector, d.base, d.limit, uint8_t(d.access | 2)}; msw |= 8;
    ip = nextIp; setEflags(nextFlags | (nested ? 0x4000 : 0));
    for (unsigned i = 0; i < 8; ++i) r32(i, registers[i]);
    s = selectors; cr3 = nextCr3 & 0xfffff000u;
    taskCommitted = true; startIp = ip; cpl = virtual8086() ? 3 : selectors[CS] & 3;
    debugRegisters[7] &= ~0x155u;
    try { loadLdt(nextLdt, 10); }
    catch (const CpuFault& f) { if (f.vector == 11) fault(10, f.code); throw; }
    if (virtual8086()) {
        for (unsigned i = 0; i < selectors.size(); ++i) loadVirtualSegment(int(i), selectors[i]);
        if (ip > 0xffff) fault(13, 0);
        return;
    }
    try {
        auto cd = codeDescriptor(selectors[CS]);
        if (cd.access & 4 ? unsigned((cd.access >> 5) & 3) > cpl : unsigned((cd.access >> 5) & 3) != cpl) fault(10, selectors[CS] & 0xfffc);
        if (!(cd.access & 0x80)) fault(11, selectors[CS] & 0xfffc);
        loadCode(selectors[CS], cd, cpl); loadSegment(SS, selectors[SS]);
        for (auto seg : {ES, DS, FS, GS}) loadSegment(seg, selectors[seg]);
    } catch (const CpuFault& f) { if (f.vector == 13) fault(10, f.code); throw; }
    if (ip > segments[CS].limit) fault(13, 0);
}
uint32_t Cpu::alu32(int op, uint32_t a, uint32_t b) {
    auto carry = ((op == 2 || op == 3) && (flags & CF)) ? 1u : 0u;
    uint32_t result;
    if (op == 0 || op == 2) {
        auto wide = uint64_t(a) + b + carry; result = uint32_t(wide);
        flag(CF, wide > 0xffffffffu); flag(AF, (a ^ b ^ result) & 16);
        flag(OF, (~(a ^ b) & (a ^ result) & 0x80000000u) != 0);
    } else if (op == 3 || op == 5 || op == 7) {
        result = a - b - carry; flag(CF, uint64_t(a) < uint64_t(b) + carry);
        flag(AF, (a ^ b ^ result) & 16); flag(OF, ((a ^ b) & (a ^ result) & 0x80000000u) != 0);
    } else {
        result = op == 1 ? a | b : op == 4 ? a & b : a ^ b;
        flags &= ~(CF | OF | AF);
    }
    szp(uint16_t(result), 2); flag(ZF, !result); flag(SF, (result & 0x80000000u) != 0);
    return result;
}
uint32_t Cpu::shift32(int op, uint32_t value, unsigned count) {
    count &= 31; if (!count) return value;
    if (op == 6) op = 4;
    auto original = value; bool carry = flags & CF;
    for (unsigned i = 0; i < count; ++i) {
        auto high = value >> 31, low = value & 1;
        switch (op) {
        case 0: value = (value << 1) | high; carry = high; break;
        case 1: value = (value >> 1) | (low << 31); carry = low; break;
        case 2: value = (value << 1) | unsigned(carry); carry = high; break;
        case 3: value = (value >> 1) | (uint32_t(carry) << 31); carry = low; break;
        case 4: value <<= 1; carry = high; break;
        case 5: value >>= 1; carry = low; break;
        case 7: value = (value >> 1) | (value & 0x80000000u); carry = low; break;
        }
    }
    flag(CF, carry);
    if (count == 1) flag(OF, op == 5 ? (original >> 31) != 0 : op == 7 ? false
        : op == 1 || op == 3 ? ((value ^ (value << 1)) >> 31) != 0 : bool(value >> 31) != carry);
    if (op >= 4) { szp(uint16_t(value), 2); flag(ZF, !value); flag(SF, (value >> 31) != 0); }
    return value;
}
void Cpu::muldiv32(int op) {
    auto source = getRM(4);
    if (op == 4 || op == 5) {
        uint64_t product = op == 4 ? uint64_t(r32(AX)) * source : uint64_t(int64_t(int32_t(r32(AX))) * int32_t(source));
        r32(AX, uint32_t(product)); r32(DX, uint32_t(product >> 32));
        flag(CF | OF, op == 4 ? (product >> 32) != 0 : int64_t(product) != int64_t(int32_t(uint32_t(product)))); return;
    }
    if (!source) fault(0);
    uint64_t bits = (uint64_t(r32(DX)) << 32) | r32(AX);
    if (op == 6) {
        auto quotient = bits / source;
        if (quotient > 0xffffffffu) fault(0);
        r32(AX, uint32_t(quotient)); r32(DX, uint32_t(bits % source));
    } else {
        auto numerator = int64_t(bits), divisor = int64_t(int32_t(source));
        if (numerator == std::numeric_limits<int64_t>::min() && divisor == -1) fault(0);
        auto quotient = numerator / divisor;
        if (quotient < std::numeric_limits<int32_t>::min() || quotient > std::numeric_limits<int32_t>::max()) fault(0);
        r32(AX, uint32_t(quotient)); r32(DX, uint32_t(numerator % divisor));
    }
}
void Cpu::string386(uint8_t op) {
    unsigned size = op & 1 ? (operand32 ? 4 : 2) : 1;
    auto count = address32 ? r32(CX) : r[CX];
    if (rep && !count) return;
    auto si = address32 ? r32(SI) : r[SI], di = address32 ? r32(DI) : r[DI];
    int source = overrideSeg >= 0 ? overrideSeg : DS;
    auto compare = [&](uint32_t a, uint32_t b) { if (size == 4) alu32(7, a, b); else alu(7, uint16_t(a), uint16_t(b), int(size)); };
    auto delta = flags & DF ? -int(size) : int(size);
    bool moveSi = false, moveDi = false;
    switch (op & 0xfe) {
    case 0x6c: {
        checkIo(r[DX], size); checkSegment(ES, di, size, true);
        for (unsigned i = 0; i < size; ++i) translate(segmentBase(ES) + di + i, true, false);
        checkAlignment(segmentBase(ES) + di, size);
        auto value = inputPort(r[DX], size);
        writeSegment(ES, di, value, size); moveDi = true; break;
    }
    case 0x6e: {
        checkIo(r[DX], size); auto value = readSegment(source, si, size);
        outputPort(r[DX], value, size);
        moveSi = true; break;
    }
    case 0xa4: writeSegment(ES, di, readSegment(source, si, size), size); moveSi = moveDi = true; break;
    case 0xa6: compare(readSegment(source, si, size), readSegment(ES, di, size)); moveSi = moveDi = true; break;
    case 0xaa: writeSegment(ES, di, getReg(int(size), AX), size); moveDi = true; break;
    case 0xac: setReg(int(size), AX, readSegment(source, si, size)); moveSi = true; break;
    case 0xae: compare(getReg(int(size), AX), readSegment(ES, di, size)); moveDi = true; break;
    }
    if (moveSi) { if (address32) r32(SI, si + delta); else r[SI] = uint16_t(si + delta); }
    if (moveDi) { if (address32) r32(DI, di + delta); else r[DI] = uint16_t(di + delta); }
    if (rep) {
        --count;
        if (address32) r32(CX, count); else r[CX] = uint16_t(count);
        bool more = address32 ? count != 0 : uint16_t(count) != 0;
        if ((op & 0xfe) == 0xa6 || (op & 0xfe) == 0xae) more = more && (bool(flags & ZF) == (rep == 0xf3));
        if (more) { ip = startIp; repContinue = true; }
    }
}
void Cpu::system386() {
    auto op = fetch8(); int size = operand32 ? 4 : 2;
    if (op == 8 || op == 9) {
        if (model != CpuModel::I486 || lockPrefix) fault(6);
        requireRing0(); return; // No emulated data cache needs writeback or invalidation.
    }
    if (op == 0xa2) {
        if (model != CpuModel::I486 || lockPrefix) fault(6);
        auto leaf = r32(AX);
        r32(AX, leaf == 0 ? 1 : leaf == 1 ? 0x400 : 0);
        r32(BX, leaf == 0 ? 0x756e6547 : 0);
        r32(DX, leaf == 0 ? 0x49656e69 : leaf == 1 ? 1 : 0);
        r32(CX, leaf == 0 ? 0x6c65746e : 0);
        return;
    }
    if (op >= 0xc8 && op <= 0xcf) {
        if (model != CpuModel::I486 || lockPrefix) fault(6);
        auto value = r32(op & 7);
        r32(op & 7, (value << 24) | ((value & 0xff00) << 8) | ((value >> 8) & 0xff00) | (value >> 24));
        return;
    }
    if (op == 0xb0 || op == 0xb1 || op == 0xc0 || op == 0xc1) {
        if (model != CpuModel::I486) fault(6);
        modrm(); int width = op & 1 ? size : 1;
        if (lockPrefix && mod == 3) fault(6);
        auto destination = getRM(width), source = getReg(width, reg);
        if (op < 0xc0) {
            auto accumulator = getReg(width, AX);
            if (width == 4) alu32(7, accumulator, destination);
            else alu(7, uint16_t(accumulator), uint16_t(destination), width);
            setRM(width, flags & ZF ? source : destination);
            if (!(flags & ZF)) setReg(width, AX, destination);
        } else {
            auto sum = width == 4 ? alu32(0, destination, source) : alu(0, uint16_t(destination), uint16_t(source), width);
            setReg(width, reg, destination); setRM(width, sum);
        }
        return;
    }
    if (op == 0x21 || op == 0x23) {
        requireRing0(); modrm(); if (mod != 3 || reg == 4 || reg == 5) fault(6);
        if (debugRegisters[7] & 0x2000) { debugRegisters[6] |= 0x2000; fault(1); }
        if (op == 0x21) r32(rm, debugRegisters[reg]);
        else {
            auto value = r32(rm);
            if (reg == 7 && (value & 0xff))
                throw std::runtime_error("386 armed hardware breakpoints are not implemented yet");
            debugRegisters[reg] = reg == 6 ? (value & 0xe00f) | 0xffff0ff0
                : reg == 7 ? (value & 0xffff23ffu) | 0x400 : value;
        }
        return;
    }
    if (op == 0x20 || op == 0x22) {
        requireRing0(); modrm(); if (mod != 3 || (reg != 0 && reg != 2 && reg != 3)) fault(6);
        if (op == 0x20) r32(rm, reg == 0 ? msw : reg == 2 ? cr2 : cr3);
        else {
            auto value = r32(rm);
            if (reg == 2) cr2 = value;
            else if (reg == 3) cr3 = value & (model == CpuModel::I486 ? 0xfffff018u : 0xfffff000u);
            else {
                setControl0(value);
            }
        }
        return;
    }
    if (op == 5) fault(6);
    if (op == 6) { requireRing0(); msw &= ~8u; return; }
    if (op == 1) {
        modrm();
        if (reg == 7 && model == CpuModel::I486 && mod != 3) {
            if (lockPrefix) fault(6);
            requireRing0(); return;
        }
        if (reg == 4) { setRM(mod == 3 ? size : 2, msw & 0xffff); return; }
        if (reg == 6) { requireRing0(); auto value = getRM(2); setControl0((msw & ~15u) | (value & 15) | (msw & 1)); return; }
        if (mod == 3 || reg > 3) fault(6);
        auto& table = reg == 0 || reg == 2 ? gdtr : idtr;
        if (reg < 2) {
            writeSegment(eaSeg, eaOff, table.limit, 2);
            writeSegment(eaSeg, offsetPlus(eaOff, 2), operand32 ? table.base : table.base & 0xffffff, 4);
        } else {
            requireRing0(); auto limit = readSegment(eaSeg, eaOff, 2);
            auto base = readSegment(eaSeg, offsetPlus(eaOff, 2), 4);
            table = {operand32 ? base : base & 0xffffff, limit};
        }
        return;
    }
    if (op <= 3) {
        if (virtual8086() && op != 1) fault(6);
        --ip; execSystem(); return;
    }
    if (op >= 0x80 && op <= 0x8f) {
        auto displacement = fetch(size);
        if (cond(op & 15)) {
            auto target = operand32 ? ip + displacement : uint16_t(ip + displacement);
            checkSegment(CS, target, 1, false, true); ip = target;
        }
        return;
    }
    if (op >= 0x90 && op <= 0x9f) { modrm(); setRM(1, cond(op & 15)); return; }
    if (op == 0xa0 || op == 0xa8) { pushValue(s[op == 0xa0 ? FS : GS], unsigned(size)); return; }
    if (op == 0xa1 || op == 0xa9) { auto value = popValue(unsigned(size)); loadSegment(op == 0xa1 ? FS : GS, uint16_t(value)); return; }
    if (op == 0xb2 || op == 0xb4 || op == 0xb5) {
        if (lockPrefix) fault(6);
        modrm(); if (mod == 3) fault(6);
        auto value = readSegment(eaSeg, eaOff, size);
        auto selector = uint16_t(readSegment(eaSeg, offsetPlus(eaOff, size), 2));
        int segment = op == 0xb2 ? SS : op == 0xb4 ? FS : GS;
        loadSegment(segment, selector); setReg(size, reg, value);
        if (segment == SS) inhibit = true;
        return;
    }
    if (op == 0xb6 || op == 0xb7 || op == 0xbe || op == 0xbf) {
        modrm(); auto value = getRM(op & 1 ? 2 : 1);
        if (op & 8) value = op & 1 ? uint32_t(int32_t(int16_t(value))) : uint32_t(int32_t(int8_t(value)));
        setReg(size, reg, value); return;
    }
    if (op == 0xaf) {
        modrm(); auto result = size == 4 ? int64_t(int32_t(getReg(size, reg))) * int32_t(getRM(size))
            : int64_t(int16_t(getReg(size, reg))) * int16_t(getRM(size));
        setReg(size, reg, uint32_t(result));
        flag(CF | OF, result != (size == 4 ? int64_t(int32_t(uint32_t(result))) : int64_t(int16_t(uint16_t(result))))); return;
    }
    if (op == 0xbc || op == 0xbd) {
        modrm(); auto value = getRM(size); flag(ZF, !value); if (!value) return;
        unsigned bit = op == 0xbc ? 0 : unsigned(size * 8 - 1);
        while (!(value & (1u << bit))) { if (op == 0xbc) ++bit; else --bit; }
        setReg(size, reg, bit); return;
    }
    if (op == 0xa3 || op == 0xab || op == 0xb3 || op == 0xbb || op == 0xba) {
        modrm(); bool immediate = op == 0xba;
        if (immediate && reg < 4) fault(6);
        auto index = immediate ? uint32_t(fetch8()) : getReg(size, reg);
        if (mod != 3 && !immediate) {
            auto signedIndex = size == 4 ? int32_t(index) : int32_t(int16_t(index));
            auto delta = (signedIndex >> (size == 4 ? 5 : 4)) * size;
            eaOff = address32 ? eaOff + uint32_t(delta) : uint16_t(eaOff + delta);
        }
        auto value = getRM(size), mask = 1u << (index & (size * 8 - 1));
        flag(CF, (value & mask) != 0);
        int kind = immediate ? reg - 4 : op == 0xa3 ? 0 : op == 0xab ? 1 : op == 0xb3 ? 2 : 3;
        if (kind) setRM(size, kind == 1 ? value | mask : kind == 2 ? value & ~mask : value ^ mask);
        return;
    }
    if (op == 0xa4 || op == 0xa5 || op == 0xac || op == 0xad) {
        modrm(); auto source = getReg(size, reg), value = getRM(size);
        unsigned count = (op & 1 ? reg8(1) : fetch8()) & 31;
        if (!count) return;
        if (size == 2) {
            auto combined = op & 8 ? (source << 16) | value : (value << 16) | source;
            auto result = op & 8 ? combined >> count : combined << count;
            flag(CF, op & 8 ? (combined >> (count - 1)) & 1 : (combined >> (32 - count)) & 1);
            auto word = uint16_t(op & 8 ? result : result >> 16); setRM(size, word); szp(word, 2);
            if (count == 1) flag(OF, ((value ^ word) & 0x8000) != 0);
        } else {
            auto result = op & 8 ? (value >> count) | (source << (32 - count)) : (value << count) | (source >> (32 - count));
            flag(CF, op & 8 ? (value >> (count - 1)) & 1 : (value >> (32 - count)) & 1);
            setRM(size, result); szp(uint16_t(result), 2); flag(SF, (result >> 31) != 0); flag(ZF, !result);
            if (count == 1) flag(OF, ((value ^ result) >> 31) != 0);
        }
        return;
    }
    fault(6);
}
bool Cpu::exec386(uint8_t op) {
    if (op == 0x0f) { system386(); return true; }
    if (op == 0xcd) {
        auto number = fetch8(); if (virtual8086()) requireIo();
        interrupt(number, -1, true); return true;
    }
    if (op == 0x9c || op == 0x9d) {
        if (virtual8086()) requireIo();
        unsigned size = operand32 ? 4 : 2;
        if (op == 0x9c) pushValue(eflags() & ~0x30000u, size);
        else {
            auto value = popValue(size); popFlags(uint16_t(value), cpl);
            if (size == 4 && model == CpuModel::I486) upperFlags = (upperFlags & ~0x240000u) | (value & 0x240000);
        }
        return true;
    }
    if ((op >= 0x70 && op <= 0x7f) || op == 0xeb) {
        auto displacement = int8_t(fetch8());
        if (op == 0xeb || cond(op & 15)) {
            auto target = operand32 ? ip + displacement : uint16_t(ip + displacement);
            checkSegment(CS, target, 1, false, true); ip = target;
        }
        return true;
    }
    if ((op >= 0xa4 && op <= 0xaf && op != 0xa8 && op != 0xa9) || (op >= 0x6c && op <= 0x6f)) {
        string386(op); return true;
    }
    if (op == 0x8c || op == 0x8e) {
        modrm(); if (reg > GS || (op == 0x8e && reg == CS)) fault(6);
        if (op == 0x8c) setRM(mod == 3 && operand32 ? 4 : 2, s[reg]);
        else { loadSegment(reg, uint16_t(getRM(2))); if (reg == SS) inhibit = true; }
        return true;
    }
    if (op == 0x8d) { modrm(); if (mod == 3) fault(6); setReg(operand32 ? 4 : 2, reg, eaOff); return true; }
    if (op == 0x8f) {
        modrm(); if (reg) fault(6);
        auto oldSp = r32(SP), value = popValue(operand32 ? 4 : 2);
        if (eaUsesSp) eaOff += r32(SP) - oldSp;
        setRM(operand32 ? 4 : 2, value); return true;
    }
    if (op == 0xe8 || op == 0xe9) {
        auto displacement = fetch(operand32 ? 4 : 2);
        auto target = operand32 ? ip + displacement : uint16_t(ip + displacement);
        checkSegment(CS, target, 1, false, true);
        if (op == 0xe8) pushValue(ip, operand32 ? 4 : 2);
        ip = target; return true;
    }
    if (op == 0xc8) {
        auto allocation = fetch16(); unsigned level = fetch8() & 31, size = operand32 ? 4 : 2;
        pushValue(getReg(int(size), BP), size); auto frame = stackPointer(), bp = getReg(int(size), BP);
        if (level) {
            for (unsigned i = 1; i < level; ++i) { bp = operand32 ? bp - size : uint16_t(bp - size); pushValue(readSegment(SS, bp, size), size); }
            pushValue(frame, size);
        }
        auto sp = stackPointer() - allocation; if (!(segments[SS].attributes & 0x40)) sp = uint16_t(sp);
        checkSegment(SS, sp, 1, true); setReg(int(size), BP, frame); stackPointer(sp); return true;
    }
    if (op == 0xc9) {
        stackPointer(segments[SS].attributes & 0x40 ? r32(BP) : r[BP]);
        setReg(operand32 ? 4 : 2, BP, popValue(operand32 ? 4 : 2)); return true;
    }
    if (op >= 0xe0 && op <= 0xe3) {
        auto displacement = int8_t(fetch8()); auto count = address32 ? r32(CX) : r[CX];
        if (op != 0xe3) { --count; if (address32) r32(CX, count); else { r[CX] = uint16_t(count); count = r[CX]; } }
        bool take = op == 0xe3 ? !count : count && (op == 0xe2 || (bool(flags & ZF) == (op == 0xe1)));
        if (take) {
            auto target = operand32 ? ip + displacement : uint16_t(ip + displacement);
            checkSegment(CS, target, 1, false, true); ip = target;
        }
        return true;
    }
    if (op == 0xd7) { auto address = (address32 ? r32(BX) : r[BX]) + reg8(0); reg8(0, rbS(overrideSeg >= 0 ? overrideSeg : DS, address32 ? address : uint16_t(address))); return true; }
    if (op >= 0xa0 && op <= 0xa3) {
        auto address = address32 ? fetch32() : fetch16(); int size = op & 1 ? (operand32 ? 4 : 2) : 1, segment = overrideSeg >= 0 ? overrideSeg : DS;
        if (op & 2) writeSegment(segment, address, getReg(size, AX), unsigned(size));
        else setReg(size, AX, readSegment(segment, address, unsigned(size)));
        return true;
    }
    if (!operand32) return false;
    if (op < 0x40 && (op & 7) < 6 && (op & 1)) {
        int kind = (op >> 3) & 7;
        if ((op & 7) >= 4) { auto value = alu32(kind, r32(AX), fetch32()); if (kind != 7) r32(AX, value); }
        else {
            modrm(); auto a = op & 2 ? getReg(4, reg) : getRM(4), b = op & 2 ? getRM(4) : getReg(4, reg);
            auto value = alu32(kind, a, b); if (kind != 7) { if (op & 2) setReg(4, reg, value); else setRM(4, value); }
        }
        return true;
    }
    if (op < 0x40 && (op & 7) == 6) { pushValue(s[(op >> 3) & 3], 4); return true; }
    if (op < 0x20 && (op & 7) == 7) { auto value = popValue(4); loadSegment((op >> 3) & 3, uint16_t(value)); return true; }
    if (op >= 0x40 && op <= 0x4f) {
        auto carry = flags & CF; auto value = alu32(op & 8 ? 5 : 0, r32(op & 7), 1);
        r32(op & 7, value); flags = uint16_t((flags & ~CF) | carry); return true;
    }
    if (op >= 0x50 && op <= 0x57) { pushValue(r32(op & 7), 4); return true; }
    if (op >= 0x58 && op <= 0x5f) { auto value = popValue(4); r32(op & 7, value); return true; }
    if (op >= 0xb8 && op <= 0xbf) { r32(op & 7, fetch32()); return true; }
    if (op >= 0x91 && op <= 0x97) { auto value = r32(AX); r32(AX, r32(op & 7)); r32(op & 7, value); return true; }
    switch (op) {
    case 0x60: { auto sp = r32(SP); for (unsigned i = 0; i < 8; ++i) pushValue(i == SP ? sp : r32(i), 4); break; }
    case 0x61: for (int i = 7; i >= 0; --i) { auto value = popValue(4); if (i != SP) r32(i, value); } break;
    case 0x62: {
        modrm(); if (mod == 3) fault(6);
        auto low = int32_t(readSegment(eaSeg, eaOff, 4)), high = int32_t(readSegment(eaSeg, offsetPlus(eaOff, 4), 4));
        if (int32_t(r32(reg)) < low || int32_t(r32(reg)) > high) fault(5);
        break;
    }
    case 0x68: { auto value = fetch32(); pushValue(value, 4); break; }
    case 0x6a: { auto value = uint32_t(int32_t(int8_t(fetch8()))); pushValue(value, 4); break; }
    case 0x69: case 0x6b: {
        modrm(); auto a = int32_t(getRM(4)), b = op == 0x69 ? int32_t(fetch32()) : int32_t(int8_t(fetch8()));
        auto result = int64_t(a) * b; r32(reg, uint32_t(result)); flag(CF | OF, result != int64_t(int32_t(uint32_t(result)))); break;
    }
    case 0x81: case 0x83: {
        modrm(); auto a = getRM(4), b = op == 0x83 ? uint32_t(int32_t(int8_t(fetch8()))) : fetch32();
        auto value = alu32(reg, a, b); if (reg != 7) setRM(4, value); break;
    }
    case 0x85: modrm(); alu32(4, getRM(4), r32(reg)); break;
    case 0x87: { modrm(); auto a = getRM(4), b = r32(reg); setRM(4, b); r32(reg, a); break; }
    case 0x89: modrm(); setRM(4, r32(reg)); break;
    case 0x8b: modrm(); r32(reg, getRM(4)); break;
    case 0x98: r32(AX, uint32_t(int32_t(int16_t(r[AX])))); break;
    case 0x99: r32(DX, r32(AX) & 0x80000000u ? 0xffffffffu : 0); break;
    case 0x9a: case 0xea: { auto offset = fetch32(); auto selector = fetch16(); farJump(selector, offset, op == 0x9a); break; }
    case 0xa9: alu32(4, r32(AX), fetch32()); break;
    case 0xc1: case 0xd1: case 0xd3: {
        modrm(); auto value = getRM(4); auto count = op == 0xc1 ? fetch8() : op == 0xd1 ? 1 : reg8(1);
        setRM(4, shift32(reg, value, unsigned(count))); break;
    }
    case 0xc2: { auto adjustment = fetch16(); auto target = popValue(4); checkSegment(CS, target, 1, false, true); ip = target; stackPointer(stackPointer() + adjustment); break; }
    case 0xc3: { auto target = popValue(4); checkSegment(CS, target, 1, false, true); ip = target; break; }
    case 0xc4: case 0xc5: {
        modrm(); if (mod == 3) fault(6);
        auto value = readSegment(eaSeg, eaOff, 4); auto selector = uint16_t(readSegment(eaSeg, offsetPlus(eaOff, 4), 2));
        loadSegment(op == 0xc4 ? ES : DS, selector); r32(reg, value); break;
    }
    case 0xc7: { modrm(); if (reg) fault(6); auto value = fetch32(); setRM(4, value); break; }
    case 0xca: { auto adjustment = fetch16(); farReturn(adjustment, false); break; }
    case 0xcb: farReturn(0, false); break;
    case 0xcf: farReturn(0, true); break;
    case 0xe5: case 0xed: {
        auto port = op == 0xe5 ? uint16_t(fetch8()) : r[DX]; checkIo(port, 4);
        r32(AX, inputPort(port, 4)); break;
    }
    case 0xe7: case 0xef: {
        auto port = op == 0xe7 ? uint16_t(fetch8()) : r[DX]; checkIo(port, 4);
        outputPort(port, r32(AX), 4);
        break;
    }
    case 0xf7:
        modrm();
        if (reg < 2) { auto a = getRM(4), b = fetch32(); alu32(4, a, b); }
        else if (reg == 2) setRM(4, ~getRM(4));
        else if (reg == 3) setRM(4, alu32(5, 0, getRM(4)));
        else muldiv32(reg);
        break;
    case 0xff:
        modrm();
        if (reg < 2) { auto carry = flags & CF; auto value = alu32(reg ? 5 : 0, getRM(4), 1); setRM(4, value); flags = uint16_t((flags & ~CF) | carry); }
        else if (reg == 2) { auto offset = getRM(4); checkSegment(CS, offset, 1, false, true); pushValue(ip, 4); ip = offset; }
        else if (reg == 4) { auto offset = getRM(4); checkSegment(CS, offset, 1, false, true); ip = offset; }
        else if (reg == 6) pushValue(getRM(4), 4);
        else if (reg == 3 || reg == 5) {
            if (mod == 3) fault(6);
            auto offset = readSegment(eaSeg, eaOff, 4); auto selector = uint16_t(readSegment(eaSeg, offsetPlus(eaOff, 4), 2));
            farJump(selector, offset, reg == 3);
        } else fault(6);
        break;
    default: return false;
    }
    return true;
}
void Cpu::setControl0(uint32_t value) {
    if ((value & 0x80000001u) == 0x80000000u) fault(13, 0);
    if (model == CpuModel::I486 && (value & 0x60000000u) == 0x20000000u) fault(13, 0);
    if (!(msw & 1) && (value & 1)) {
        for (unsigned i = 0; i < segments.size(); ++i)
            if (!(hiddenSegments & (1 << i))) segments[i].base = uint32_t(s[i]) << 4;
        hiddenSegments = 0; cpl = 0;
    } else if ((msw & 1) && !(value & 1)) { hiddenSegments = 63; cpl = 0; }
    msw = (value & (model == CpuModel::I486 ? 0xe005002fu : 0x8000000fu)) | 0x10;
}
}
