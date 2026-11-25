#include "cpu.h"
#include <stdexcept>

namespace asm86 {
uint8_t Cpu::rb(uint16_t seg, uint16_t off) const {
    return readPhysical((uint32_t(seg) << 4) + off);
}
uint8_t Cpu::readPhysical(uint32_t address) const {
    auto a = address & (model == CpuModel::I8088 ? 0xfffff : model == CpuModel::I286 ? (a20 ? 0xffffff : 0xefffff) : (a20 ? 0xffffffffu : 0xffefffffu));
    if (supports386() && (a & 0xffef0000u) == 0xffef0000u) a = 0xf0000 | (a & 0xffff);
    return readBus(a);
}
uint8_t Cpu::readBus(uint32_t a) const {
    return a >= mmioStart && a < mmioEnd && mmioRead ? mmioRead(a) : a < mem.size() ? mem[a] : 0xff;
}
uint16_t Cpu::rw(uint16_t seg, uint16_t off) const { return rb(seg, off) | (uint16_t(rb(seg, uint16_t(off + 1))) << 8); }
void Cpu::wb(uint16_t seg, uint16_t off, uint8_t v) {
    writePhysical((uint32_t(seg) << 4) + off, v);
}
uint16_t Cpu::readWord(uint32_t address) const { return readPhysical(address) | (uint16_t(readPhysical(address + 1)) << 8); }
void Cpu::writeWord(uint32_t address, uint16_t value) { writePhysical(address, uint8_t(value)); writePhysical(address + 1, uint8_t(value >> 8)); }
void Cpu::writePhysical(uint32_t address, uint8_t v) {
    auto a = address & (model == CpuModel::I8088 ? 0xfffff : model == CpuModel::I286 ? (a20 ? 0xffffff : 0xefffff) : (a20 ? 0xffffffffu : 0xffefffffu));
    if (supports386() && (a & 0xffef0000u) == 0xffef0000u) a = 0xf0000 | (a & 0xffff);
    writeBus(a, v);
}
void Cpu::writeBus(uint32_t a, uint8_t v) {
    if (onWrite) onWrite(a);
    if (a >= mmioStart && a < mmioEnd && mmioWrite) mmioWrite(a, v);
    else if (a < mem.size()) mem[a] = v;
}
void Cpu::ww(uint16_t seg, uint16_t off, uint16_t v) { wb(seg, off, uint8_t(v)); wb(seg, uint16_t(off + 1), uint8_t(v >> 8)); }
uint8_t Cpu::reg8(int i) const { return uint8_t(r[i & 3] >> ((i & 4) ? 8 : 0)); }
void Cpu::reg8(int i, uint8_t v) {
    auto& a = r[i & 3];
    a = (i & 4) ? uint16_t((a & 255) | (uint16_t(v) << 8)) : uint16_t((a & 0xff00) | v);
}
uint32_t Cpu::getReg(int size, int i) const { return size == 1 ? reg8(i) : size == 4 ? r32(i) : r[i]; }
void Cpu::setReg(int size, int i, uint32_t v) { if (size == 1) reg8(i, uint8_t(v)); else if (size == 4) r32(i, v); else r[i] = uint16_t(v); }
void Cpu::reset() {
    r.fill(0); s.fill(0); s[CS] = 0xffff; ip = 0;
    msw = supports386() ? 0x10 : 0xfff0; cr2 = cr3 = upperFlags = 0;
    upperR.fill(0); cpl = 0; hiddenSegments = 0;
    if (model == CpuModel::I486) { msw = 0x60000010; r[DX] = 0x450; }
    debugRegisters.fill(0); debugRegisters[6] = 0xffff0ff0; debugRegisters[7] = 0x400;
    gdtr = {0, 0xffff}; idtr = {0, 0x3ff}; ldtr = {}; tr = {};
    for (auto& segment : segments) segment = {};
    segments[CS].access = 0x9b;
    setFlags(2);
    if (model != CpuModel::I8088) {
        s[CS] = 0xf000; ip = 0xfff0; segments[CS].base = supports386() ? 0xffff0000 : 0xff0000; hiddenSegments = 1 << CS;
    }
    halted = waiting = repContinue = inhibit = false;
    eaOff = 0; eaSeg = DS;
}
uint8_t Cpu::fetch8() {
    if (supports386() && ip - startIp >= 15) fault(13, 0);
    if (protectedMode() || supports386()) checkSegment(CS, ip, 1, false, true);
    auto v = supports386() ? readLinear(segmentBase(CS) + ip) : readPhysical(segmentBase(CS) + ip);
    ++ip; if (!supports386()) ip = uint16_t(ip); return v;
}
uint16_t Cpu::fetch16() { auto lo = fetch8(); return lo | (uint16_t(fetch8()) << 8); }
uint32_t Cpu::fetch(int size) { return size == 1 ? fetch8() : size == 4 ? fetch32() : fetch16(); }
uint32_t Cpu::inputPort(uint16_t port, unsigned size) {
    if (size != 1 && size != 2 && size != 4) throw std::runtime_error("Invalid CPU I/O operand size");
    if (size > 1 && inWide) return inWide(port, size);
    uint32_t value = 0;
    for (unsigned i = 0; i < size; ++i) value |= uint32_t(in ? in(uint16_t(port + i)) : 255) << (i * 8);
    return value;
}
void Cpu::outputPort(uint16_t port, uint32_t value, unsigned size) {
    if (size != 1 && size != 2 && size != 4) throw std::runtime_error("Invalid CPU I/O operand size");
    if (size > 1 && outWide) { outWide(port, value, size); return; }
    if (out) for (unsigned i = 0; i < size; ++i) out(uint16_t(port + i), uint8_t(value >> (i * 8)));
}
void Cpu::push(uint16_t v) {
    if (supports386()) { pushValue(v, 2); return; }
    auto sp = uint16_t(r[SP] - 2); wwS(SS, sp, v); r[SP] = sp;
}
uint16_t Cpu::pop() {
    if (supports386()) return uint16_t(popValue(2));
    auto value = rwS(SS, r[SP]); r[SP] += 2; return value;
}
void Cpu::flag(uint16_t mask, bool v) { flags = v ? flags | mask : flags & ~mask; }
void Cpu::stackedFlag(uint16_t mask, bool v) {
    auto off = uint16_t(r[SP] + 4), f = rwS(SS, off);
    wwS(SS, off, v ? f | mask : f & ~mask);
}
void Cpu::interrupt(uint8_t n, int code, bool software, bool external) {
    if (supports386() && n == 1 && !software) debugRegisters[7] &= ~0x2000u;
    if (protectedMode()) {
        try { protectedInterrupt(n, code, software, external); }
        catch (CpuFault& f) { if (external && f.vector >= 10 && f.vector <= 13 && f.code >= 0) f.code |= 1; throw; }
        halted = waiting = false; return;
    }
    if (model != CpuModel::I8088 && unsigned(n) * 4 + 3 > idtr.limit) fault(13, 0);
    push(flags); flags &= ~(IF | TF); push(s[CS]); push(ip);
    ip = readWord(idtr.base + n * 4); loadSegment(CS, readWord(idtr.base + n * 4 + 2));
    halted = waiting = false;
}
void Cpu::modrm() {
    auto b = fetch8(); mod = b >> 6; reg = (b >> 3) & 7; rm = b & 7; eaUsesSp = false;
    if (mod == 3) return;
    if (address32) {
        uint32_t base = 0, index = 0; int seg = DS;
        if (rm == 4) {
            auto sib = fetch8(); unsigned b = sib & 7, ix = (sib >> 3) & 7;
            if (ix != SP) index = r32(ix) << (sib >> 6);
            if (b == BP && !mod) base = fetch32();
            else { base = r32(b); if (b == BP || b == SP) seg = SS; eaUsesSp = b == SP; }
        } else if (rm == BP && !mod) base = fetch32();
        else { base = r32(rm); if (rm == BP) seg = SS; }
        if (mod == 1) base += int8_t(fetch8());
        if (mod == 2) base += fetch32();
        eaOff = base + index; eaSeg = overrideSeg >= 0 ? overrideSeg : seg; return;
    }
    uint16_t off = 0; int seg = DS;
    switch (rm) {
    case 0: off = r[BX] + r[SI]; break;
    case 1: off = r[BX] + r[DI]; break;
    case 2: off = r[BP] + r[SI]; seg = SS; break;
    case 3: off = r[BP] + r[DI]; seg = SS; break;
    case 4: off = r[SI]; break;
    case 5: off = r[DI]; break;
    case 6: if (mod == 0) off = fetch16(); else { off = r[BP]; seg = SS; } break;
    case 7: off = r[BX]; break;
    }
    if (mod == 1) off += int8_t(fetch8());
    if (mod == 2) off += fetch16();
    eaOff = off; eaSeg = overrideSeg >= 0 ? overrideSeg : seg;
}
uint32_t Cpu::getRM(int size) {
    if (mod == 3) return getReg(size, rm);
    return size == 1 ? rbS(eaSeg, eaOff) : size == 2 ? rwS(eaSeg, eaOff) : readSegment(eaSeg, eaOff, unsigned(size));
}
void Cpu::setRM(int size, uint32_t v) {
    if (mod == 3) setReg(size, rm, v);
    else if (size == 1) wbS(eaSeg, eaOff, uint8_t(v));
    else if (size == 2) wwS(eaSeg, eaOff, uint16_t(v));
    else writeSegment(eaSeg, eaOff, v, unsigned(size));
}
void Cpu::szp(uint16_t v, int size) {
    v &= size == 1 ? 255 : 65535;
    uint8_t parity = uint8_t(v); parity ^= parity >> 4; parity &= 15;
    flags = (flags & ~(SF | ZF | PF)) | ((v & (size == 1 ? 128 : 32768)) ? SF : 0)
        | (v == 0 ? ZF : 0) | (((0x6996 >> parity) & 1) ? 0 : PF);
}
uint16_t Cpu::alu(int op, uint16_t a, uint16_t b, int size) {
    const int mask = size == 1 ? 255 : 65535, sign = size == 1 ? 128 : 32768;
    int result = 0, carry = ((op == 2 || op == 3) && (flags & CF)) ? 1 : 0;
    switch (op) {
    case 0: case 2:
        result = int(a) + b + carry;
        flag(CF, result > mask); flag(AF, (a ^ b ^ result) & 16);
        flag(OF, (result ^ a) & (result ^ b) & sign); break;
    case 3: case 5: case 7:
        result = int(a) - b - carry;
        flag(CF, result < 0); flag(AF, (a ^ b ^ result) & 16);
        flag(OF, (a ^ b) & (a ^ result) & sign); break;
    default:
        result = op == 1 ? a | b : op == 4 ? a & b : a ^ b;
        flags &= ~(CF | OF | AF); break;
    }
    auto v = uint16_t(result & mask); szp(v, size); return v;
}
uint16_t Cpu::incdec(uint16_t v, int size, bool sub) {
    auto carry = flags & CF;
    auto result = alu(sub ? 5 : 0, v, 1, size);
    flags = uint16_t((flags & ~CF) | carry); return result;
}
uint16_t Cpu::shift(int op, uint16_t v, int count, int size) {
    if (model != CpuModel::I8088) { count &= 31; if (op == 6) op = 4; }
    if (!count) return v;
    const unsigned mask = size == 1 ? 255 : 65535, sign = size == 1 ? 128 : 32768;
    unsigned value = v, carry = (flags & CF) != 0;
    for (int i = 0; i < count; ++i) {
        unsigned next;
        switch (op) {
        case 0: carry = (value & sign) != 0; value = ((value << 1) | carry) & mask; break;
        case 1: carry = value & 1; value = (value >> 1) | (carry ? sign : 0); break;
        case 2: next = (value & sign) != 0; value = ((value << 1) | carry) & mask; carry = next; break;
        case 3: next = value & 1; value = (value >> 1) | (carry ? sign : 0); carry = next; break;
        case 4: carry = (value & sign) != 0; value = (value << 1) & mask; break;
        case 5: carry = value & 1; value >>= 1; break;
        case 6: carry = 0; value = mask; break;
        case 7: carry = value & 1; value = (value >> 1) | (value & sign); break;
        }
    }
    flag(CF, carry != 0);
    flag(OF, ((value & sign) != 0) ^ ((op == 0 || op == 2 || op == 4 || op == 6) ? carry != 0 : (value & (sign >> 1)) != 0));
    if (op >= 4) { szp(uint16_t(value), size); flag(AF, op == 4 && (value & 16)); }
    return uint16_t(value);
}
bool Cpu::cond(int cc) const {
    bool result;
    switch (cc >> 1) {
    case 0: result = flags & OF; break;
    case 1: result = flags & CF; break;
    case 2: result = flags & ZF; break;
    case 3: result = flags & (CF | ZF); break;
    case 4: result = flags & SF; break;
    case 5: result = flags & PF; break;
    case 6: result = bool(flags & SF) != bool(flags & OF); break;
    default: result = (flags & ZF) || bool(flags & SF) != bool(flags & OF); break;
    }
    return (cc & 1) ? !result : result;
}
void Cpu::string(uint8_t op) {
    if (rep && !r[CX]) return;
    const int size = (op & 1) ? 2 : 1, seg = overrideSeg >= 0 ? overrideSeg : DS;
    auto read = [&](int si, uint16_t off) { return size == 1 ? uint16_t(rbS(si, off)) : rwS(si, off); };
    auto write = [&](int si, uint16_t off, uint16_t v) { if (size == 1) wbS(si, off, uint8_t(v)); else wwS(si, off, v); };
    const int delta = (flags & DF) ? -size : size;
    switch (op & 0xfe) {
    case 0x6c: {
        requireIo(); checkSegment(ES, r[DI], unsigned(size), true);
        auto value = uint16_t(inputPort(r[DX], unsigned(size)));
        write(ES, r[DI], value); r[DI] += delta; break;
    }
    case 0x6e: {
        requireIo(); auto value = read(seg, r[SI]);
        outputPort(r[DX], value, unsigned(size));
        r[SI] += delta; break;
    }
    case 0xa4: write(ES, r[DI], read(seg, r[SI])); r[SI] += delta; r[DI] += delta; break;
    case 0xa6: alu(7, read(seg, r[SI]), read(ES, r[DI]), size); r[SI] += delta; r[DI] += delta; break;
    case 0xaa: write(ES, r[DI], getReg(size, AX)); r[DI] += delta; break;
    case 0xac: setReg(size, AX, read(seg, r[SI])); r[SI] += delta; break;
    case 0xae: alu(7, getReg(size, AX), read(ES, r[DI]), size); r[DI] += delta; break;
    }
    if (rep) {
        --r[CX];
        bool more = r[CX] != 0;
        if ((op & 0xfe) == 0xa6 || (op & 0xfe) == 0xae) more = more && (bool(flags & ZF) == (rep == 0xf3));
        if (more) { ip = startIp; repContinue = true; }
    }
}
void Cpu::muldiv(int op, int size) {
    auto src = getRM(size);
    if (op == 4 || op == 5) {
        int64_t product;
        if (op == 4) product = int64_t(getReg(size, AX)) * src;
        else product = size == 1 ? int64_t(int8_t(reg8(0))) * int8_t(src) : int64_t(int16_t(r[AX])) * int16_t(src);
        r[AX] = uint16_t(product);
        if (size == 2) r[DX] = uint16_t(uint64_t(product) >> 16);
        bool overflow = op == 4 ? (size == 1 ? product > 255 : product > 65535)
            : size == 1 ? product != int8_t(uint8_t(product)) : product != int16_t(uint16_t(product));
        flag(CF | OF, overflow); szp(getReg(size, AX), size); flags &= ~AF;
        return;
    }
    int64_t numerator, divisor;
    if (op == 6) { numerator = size == 1 ? r[AX] : (uint32_t(r[DX]) << 16) | r[AX]; divisor = src; }
    else {
        numerator = size == 1 ? int16_t(r[AX]) : int32_t((uint32_t(r[DX]) << 16) | r[AX]);
        divisor = size == 1 ? int8_t(src) : int16_t(src);
    }
    if (!divisor) { if (model != CpuModel::I8088) fault(0); interrupt(0); return; }
    auto q = numerator / divisor, rem = numerator % divisor;
    const int64_t hi = op == 6 ? (size == 1 ? 255 : 65535) : (size == 1 ? 127 : 32767);
    const int64_t lo = op == 6 ? 0 : -hi - (model != CpuModel::I8088 ? 1 : 0);
    if (q < lo || q > hi) { if (model != CpuModel::I8088) fault(0); interrupt(0); return; }
    if (op == 7 && rep && model == CpuModel::I8088) q = -q;
    if (size == 1) r[AX] = uint16_t((uint16_t(uint8_t(rem)) << 8) | uint8_t(q));
    else { r[AX] = uint16_t(q); r[DX] = uint16_t(rem); }
}
void Cpu::stepInstruction() {
    repContinue = false;
    if (!inhibit && (flags & IF) && irq) {
        int n = irq();
        if (n >= 0) { interrupt(uint8_t(n), -1, false, true); return; }
    }
    inhibit = false;
    if (halted) return;
    bool trace = flags & TF;
    startIp = ip; overrideSeg = -1; rep = 0; lockPrefix = false;
    const bool bigCode = supports386() && !virtual8086() && (segments[CS].attributes & 0x40);
    operand32 = address32 = bigCode;
    for (int prefixes = 0; prefixes < 65536; ++prefixes) {
        auto op = fetch8();
        if (supports386()) {
            if (op == 0x66) { operand32 = !bigCode; continue; }
            if (op == 0x67) { address32 = !bigCode; continue; }
            if (op == 0x64 || op == 0x65) { overrideSeg = op == 0x64 ? FS : GS; continue; }
        }
        if (op == 0x26 || op == 0x2e || op == 0x36 || op == 0x3e) { overrideSeg = (op >> 3) & 3; continue; }
        if (op == 0xf2 || op == 0xf3) { rep = op; continue; }
        if (op == 0xf0 || op == 0xf1) {
            if (op == 0xf0) lockPrefix = true;
            if (op == 0xf1 && (segmentBase(CS) + startIp) >= 0xf0000 && (segmentBase(CS) + startIp) < 0xf2000 && trap) {
                auto n = fetch8(); waiting = !trap(n); if (waiting) ip = startIp;
                return;
            }
            continue;
        }
        bool interruptInstruction = supports386() && (op == 0xcc || op == 0xcd || (op == 0xce && (flags & OF)));
        execute(op);
        if (supports386() && op != 0xcf && op != 0x9d && !taskCommitted) upperFlags &= ~0x10000u;
        if (!supports386()) ip = uint16_t(ip);
        if (trace && !repContinue && !interruptInstruction && !(supports386() && taskCommitted)) {
            if (supports386()) debugRegisters[6] |= 0x4000;
            interrupt(1);
        }
        return;
    }
    throw std::runtime_error("8088 prefix stream exceeds a complete code segment");
}
void Cpu::execute(uint8_t op) {
    if (supports386() && exec386(op)) return;
    int size = (op & 1) ? 2 : 1;
    if (model != CpuModel::I8088) {
        if (op == 0x0f) { execSystem(); return; }
        if ((op >= 0x60 && op < 0x70) || op == 0xc0 || op == 0xc1 || op == 0xc8 || op == 0xc9) { exec186(op); return; }
    }
    if (op < 0x40 && (op & 7) < 6) {
        int kind = (op >> 3) & 7; uint16_t result;
        if ((op & 7) >= 4) {
            auto a = getReg(size, AX), b = fetch(size); result = alu(kind, a, b, size);
            if (kind != 7) setReg(size, AX, result);
        } else {
            modrm(); auto a = (op & 2) ? getReg(size, reg) : getRM(size);
            auto b = (op & 2) ? getRM(size) : getReg(size, reg); result = alu(kind, a, b, size);
            if (kind != 7) { if (op & 2) setReg(size, reg, result); else setRM(size, result); }
        }
        return;
    }
    if (op < 0x40 && (op & 7) == 6) { push(s[(op >> 3) & 3]); return; }
    if (op < 0x20 && (op & 7) == 7) {
        int i = (op >> 3) & 3; auto v = pop(); loadSegment(i, v); if (i == SS) inhibit = true; return;
    }
    if (op >= 0x40 && op <= 0x4f) { r[op & 7] = incdec(r[op & 7], 2, op & 8); return; }
    if (op >= 0x50 && op <= 0x57) {
        if ((op & 7) == SP && model == CpuModel::I8088) { r[SP] -= 2; wwS(SS, r[SP], r[SP]); } else push(r[op & 7]); return;
    }
    if (op >= 0x58 && op <= 0x5f) { auto v = pop(); r[op & 7] = v; return; }
    if (op >= 0x60 && op <= 0x7f) { int d = int8_t(fetch8()); if (cond(op & 15)) ip += d; return; }
    if (op >= 0xb0 && op <= 0xbf) { int z = op < 0xb8 ? 1 : 2; auto v = fetch(z); setReg(z, op & 7, v); return; }
    if (op >= 0x91 && op <= 0x97) { auto v = r[AX]; r[AX] = r[op & 7]; r[op & 7] = v; return; }
    if (op >= 0xa4 && op <= 0xaf && op != 0xa8 && op != 0xa9) { string(op); return; }
    switch (op) {
    case 0x27: case 0x2f: {
        int al = reg8(0), v = al; bool sub = op == 0x2f, oldAF = flags & AF, oldCF = flags & CF;
        if ((al & 15) > 9 || oldAF) { v += sub ? -6 : 6; flags |= AF; } else flags &= ~AF;
        if (al > (oldAF ? 0x9f : 0x99) || oldCF) { v += sub ? -0x60 : 0x60; flags |= CF; } else flags &= ~CF;
        flag(OF, sub ? (al & ~v & 128) : (~al & v & 128)); reg8(0, uint8_t(v)); szp(uint8_t(v), 1); return;
    }
    case 0x37: case 0x3f: {
        int al = reg8(0), ah = reg8(4), v = al; bool sub = op == 0x3f;
        if ((al & 15) > 9 || (flags & AF)) { v += sub ? -6 : 6; ah += sub ? -1 : 1; flags |= AF | CF; } else flags &= ~(AF | CF);
        r[AX] = uint16_t((uint16_t(uint8_t(ah)) << 8) | (v & 15)); szp(uint8_t(v), 1);
        flag(OF, sub ? (al & ~v & 128) : (~al & v & 128)); return;
    }
    case 0x80: case 0x81: case 0x82: case 0x83: {
        modrm(); auto a = getRM(size);
        uint16_t b = op == 0x83 ? uint16_t(int16_t(int8_t(fetch8()))) : fetch(size);
        auto v = alu(reg, a, b, size); if (reg != 7) setRM(size, v); return;
    }
    case 0x84: case 0x85: modrm(); alu(4, getRM(size), getReg(size, reg), size); return;
    case 0x86: case 0x87: { modrm(); auto a = getRM(size), b = getReg(size, reg); setRM(size, b); setReg(size, reg, a); return; }
    case 0x88: case 0x89: modrm(); setRM(size, getReg(size, reg)); return;
    case 0x8a: case 0x8b: modrm(); setReg(size, reg, getRM(size)); return;
    case 0x8c: modrm(); setRM(2, s[reg & 3]); return;
    case 0x8d: modrm(); r[reg] = eaOff; return;
    case 0x8e: { modrm(); if (model != CpuModel::I8088 && (reg == CS || reg > 3)) fault(6); auto v = getRM(2); loadSegment(reg & 3, uint16_t(v)); if ((reg & 3) == SS) inhibit = true; return; }
    case 0x8f: { modrm(); auto v = pop(); setRM(2, v); return; }
    case 0x90: case 0x9b: return;
    case 0x98: r[AX] = uint16_t(int16_t(int8_t(reg8(0)))); return;
    case 0x99: r[DX] = (r[AX] & 0x8000) ? 0xffff : 0; return;
    case 0x9a: { auto off = fetch16(), seg = fetch16(); farJump(seg, off, true); return; }
    case 0x9c: push(flags); return;
    case 0x9d: popFlags(pop(), cpl); return;
    case 0x9e: flags = (flags & 0xff00) | (reg8(4) & 0xd5) | 2; return;
    case 0x9f: reg8(4, uint8_t(flags)); return;
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
        auto off = fetch16(); int seg = overrideSeg >= 0 ? overrideSeg : DS;
        if (op < 0xa2) setReg(size, AX, size == 1 ? rbS(seg, off) : rwS(seg, off));
        else if (size == 1) wbS(seg, off, reg8(0)); else wwS(seg, off, r[AX]); return;
    }
    case 0xa8: case 0xa9: { auto v = fetch(size); alu(4, getReg(size, AX), v, size); return; }
    case 0xc0: case 0xc2: { auto n = fetch16(), off = pop(); ip = off; r[SP] += n; return; }
    case 0xc1: case 0xc3: ip = pop(); return;
    case 0xc4: case 0xc5: {
        modrm(); if (model == CpuModel::I286 && mod == 3) fault(6);
        auto off = rwS(eaSeg, eaOff), seg = rwS(eaSeg, uint16_t(eaOff + 2));
        loadSegment(op == 0xc4 ? ES : DS, seg); r[reg] = off; return;
    }
    case 0xc6: case 0xc7: { modrm(); auto v = fetch(size); setRM(size, v); return; }
    case 0xc8: case 0xca: { auto n = fetch16(); farReturn(n, false); return; }
    case 0xc9: case 0xcb: farReturn(0, false); return;
    case 0xcc: interrupt(3, -1, true); return;
    case 0xcd: { auto n = fetch8(); interrupt(n, -1, true); return; }
    case 0xce: if (flags & OF) interrupt(4, -1, true); return;
    case 0xcf: farReturn(0, true); return;
    case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        modrm(); int count = (op & 2) ? reg8(1) : 1; auto v = shift(reg, getRM(size), count, size); setRM(size, v); return;
    }
    case 0xd4: {
        auto base = fetch8(), al = reg8(0); if (!base) { if (model == CpuModel::I286) fault(0); interrupt(0); return; }
        r[AX] = uint16_t((uint16_t(al / base) << 8) | (al % base)); szp(reg8(0), 1); flags &= ~(CF | OF | AF); return;
    }
    case 0xd5: { auto base = fetch8(); auto v = alu(0, reg8(0), uint8_t(reg8(4) * base), 1); r[AX] = v; return; }
    case 0xd6: reg8(0, (flags & CF) ? 255 : 0); return;
    case 0xd7: reg8(0, rbS(overrideSeg >= 0 ? overrideSeg : DS, uint16_t(r[BX] + reg8(0)))); return;
    case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
        if (model != CpuModel::I8088 && (msw & 12)) fault(7);
        modrm(); return;
    case 0xe0: case 0xe1: case 0xe2: {
        int d = int8_t(fetch8()); --r[CX];
        if (r[CX] && (op == 0xe2 || (bool(flags & ZF) == (op == 0xe1)))) ip += d; return;
    }
    case 0xe3: { int d = int8_t(fetch8()); if (!r[CX]) ip += d; return; }
    case 0xe4: case 0xe5: case 0xec: case 0xed: {
        uint16_t p = op < 0xe8 ? fetch8() : r[DX];
        checkIo(p, unsigned(size));
        setReg(size, AX, inputPort(p, unsigned(size))); return;
    }
    case 0xe6: case 0xe7: case 0xee: case 0xef: {
        uint16_t p = op < 0xe8 ? fetch8() : r[DX];
        checkIo(p, unsigned(size));
        outputPort(p, r[AX], unsigned(size)); return;
    }
    case 0xe8: { auto d = fetch16(); auto ret = ip; push(uint16_t(ret)); ip = uint16_t(ret + d); return; }
    case 0xe9: { auto d = fetch16(); ip += d; return; }
    case 0xea: { auto off = fetch16(), seg = fetch16(); farJump(seg, off); return; }
    case 0xeb: { int d = int8_t(fetch8()); ip += d; return; }
    case 0xf4: requireRing0(); halted = true; return;
    case 0xf5: flags ^= CF; return;
    case 0xf6: case 0xf7: {
        modrm();
        if (reg < 2) { auto a = getRM(size), b = fetch(size); alu(4, a, b, size); }
        else if (reg == 2) setRM(size, uint16_t(~getRM(size)));
        else if (reg == 3) setRM(size, alu(5, 0, getRM(size), size));
        else muldiv(reg, size); return;
    }
    case 0xf8: flags &= ~CF; return;
    case 0xf9: flags |= CF; return;
    case 0xfa: requireIo(); flags &= ~IF; return;
    case 0xfb: requireIo(); flags |= IF; inhibit = true; return;
    case 0xfc: flags &= ~DF; return;
    case 0xfd: flags |= DF; return;
    case 0xfe: modrm(); if (reg < 2) setRM(1, incdec(getRM(1), 1, reg == 1)); return;
    case 0xff:
        modrm();
        switch (reg) {
        case 0: case 1: setRM(2, incdec(getRM(2), 2, reg == 1)); break;
        case 2: { auto off = getRM(2); push(ip); ip = off; break; }
        case 3: { if (model == CpuModel::I286 && mod == 3) fault(6); auto off = rwS(eaSeg, eaOff), seg = rwS(eaSeg, uint16_t(eaOff + 2)); farJump(seg, off, true); break; }
        case 4: ip = getRM(2); break;
        case 5: { if (model == CpuModel::I286 && mod == 3) fault(6); auto off = rwS(eaSeg, eaOff), seg = rwS(eaSeg, uint16_t(eaOff + 2)); farJump(seg, off); break; }
        default:
            if (mod == 3 && rm == SP && model == CpuModel::I8088) { r[SP] -= 2; wwS(SS, r[SP], r[SP]); } else push(getRM(2)); break;
        }
        return;
    default:
        if (model != CpuModel::I8088) fault(6);
        throw std::runtime_error("Unimplemented 8088 opcode: " + std::to_string(op));
    }
}
}
