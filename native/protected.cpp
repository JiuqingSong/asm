#include "cpu.h"
#include <algorithm>
#include <stdexcept>
#include <string>
#include <tuple>

namespace asm86 {
void Cpu::setModel(CpuModel value) { model = value; mem.resize(value != CpuModel::I8088 ? 1 << 24 : 1 << 20); a20 = false; reset(); }
void Cpu::setFlags(uint16_t value) {
    flags = uint16_t((value & (model == CpuModel::I8088 || (model == CpuModel::I286 && !protectedMode()) ? 0x0fd5 : 0x7fd5))
        | (model == CpuModel::I8088 ? 0xf002 : 2));
}
[[noreturn]] void Cpu::fault(uint8_t vector, int code) { throw CpuFault{vector, code}; }
void Cpu::requireRing0() const { if (protectedMode() && cpl) fault(13, 0); }
void Cpu::requireIo() const { if (protectedMode() && cpl > unsigned((flags >> 12) & 3)) fault(13, 0); }
uint32_t Cpu::segmentBase(int segment) const {
    return protectedMode() || (hiddenSegments & (1 << segment)) ? segments[segment].base : uint32_t(s[segment]) << 4;
}
void Cpu::checkSegment(int segment, uint32_t offset, unsigned size, bool write, bool execute) const {
    if (!protectedMode() || virtual8086()) {
        if (supports386() && uint64_t(offset) + size - 1 > segments[segment].limit) fault(segment == SS ? 12 : 13, 0);
        return;
    }
    const auto& d = segments[segment]; uint8_t vector = segment == SS ? 12 : 13;
    if (d.null || !(d.access & 0x80)) fault(vector, 0);
    // LOADALL may leave a writable data descriptor in the executable CS cache.
    if (!execute && (write ? ((d.access & 8) || !(d.access & 2)) : ((d.access & 10) == 8))) fault(vector, 0);
    uint64_t end = uint64_t(offset) + size - 1;
    if ((d.access & 12) == 4) { if (offset <= d.limit || end > (d.attributes & 0x40 ? 0xffffffffu : 65535u)) fault(vector, 0); }
    else if (end > d.limit) fault(vector, 0);
}
uint8_t Cpu::rbS(int segment, uint32_t offset) {
    checkSegment(segment, offset, 1, false);
    return supports386() ? readLinear(segmentBase(segment) + offset) : readPhysical(segmentBase(segment) + offset);
}
uint16_t Cpu::rwS(int segment, uint32_t offset) {
    checkSegment(segment, offset, 2, false);
    auto base = segmentBase(segment);
    if (supports386()) {
        auto low = translate(base + offset, false, false), high = translate(base + offset + 1, false, false);
        checkAlignment(base + offset, 2);
        return readPhysical(low) | (uint16_t(readPhysical(high)) << 8);
    }
    return readPhysical(base + offset) | (uint16_t(readPhysical(base + uint16_t(offset + 1))) << 8);
}
void Cpu::wbS(int segment, uint32_t offset, uint8_t value) {
    checkSegment(segment, offset, 1, true);
    if (supports386()) writeLinear(segmentBase(segment) + offset, value);
    else writePhysical(segmentBase(segment) + offset, value);
}
void Cpu::wwS(int segment, uint32_t offset, uint16_t value) {
    checkSegment(segment, offset, 2, true); auto base = segmentBase(segment);
    if (supports386()) {
        auto low = translate(base + offset, true, false), high = translate(base + offset + 1, true, false);
        checkAlignment(base + offset, 2);
        writePhysical(low, uint8_t(value)); writePhysical(high, uint8_t(value >> 8)); return;
    }
    writePhysical(base + offset, uint8_t(value)); writePhysical(base + uint16_t(offset + 1), uint8_t(value >> 8));
}
Cpu::Descriptor Cpu::descriptor(uint16_t selector, uint8_t vector) {
    unsigned index = selector & 0xfff8; Table table = gdtr;
    if (selector & 4) {
        if (!ldtr.selector) fault(vector, selector & 0xfffc);
        table = {ldtr.base, ldtr.limit};
    }
    if (index + 7 > table.limit) fault(vector, selector & 0xfffc);
    Descriptor d; d.address = table.base + index;
    auto byte = [&](uint32_t a) { return uint8_t(readSystem(a, 1)); };
    auto word = [&](uint32_t a) { return uint16_t(readSystem(a, 2)); };
    d.limit = word(d.address); d.base = word(d.address + 2) | (uint32_t(byte(d.address + 4)) << 16);
    d.access = byte(d.address + 5);
    d.gateOffset = uint16_t(d.limit); d.gateSelector = word(d.address + 2); d.parameters = byte(d.address + 4) & 31;
    if (supports386()) {
        d.gateOffset |= uint32_t(word(d.address + 6)) << 16;
        d.attributes = byte(d.address + 6) & 0xf0;
        d.limit |= uint32_t(byte(d.address + 6) & 15) << 16;
        if (d.attributes & 0x80) d.limit = (d.limit << 12) | 4095;
        d.base |= uint32_t(byte(d.address + 7)) << 24;
    }
    return d;
}
Cpu::Descriptor Cpu::codeDescriptor(uint16_t selector) {
    if (!(selector & 0xfffc)) fault(13, 0);
    auto d = descriptor(selector); if ((d.access & 0x18) != 0x18) fault(13, selector & 0xfffc); return d;
}
void Cpu::cache(int segment, uint16_t selector, Descriptor d) {
    if (!(d.access & 1)) { d.access |= 1; writeLinear(d.address + 5, d.access, true); }
    s[segment] = selector; segments[segment] = d; hiddenSegments &= uint8_t(~(1 << segment));
}
void Cpu::loadCode(uint16_t selector, Descriptor d, unsigned level) {
    cache(CS, uint16_t((selector & 0xfffc) | level), d); cpl = level;
}
void Cpu::loadVirtualSegment(int segment, uint16_t selector) {
    s[segment] = selector; segments[segment] = {};
    segments[segment].base = uint32_t(selector) << 4;
    segments[segment].access = segment == CS ? 0xfb : 0xf3;
    hiddenSegments &= uint8_t(~(1 << segment));
}
void Cpu::loadSegment(int segment, uint16_t selector) {
    if (virtual8086()) { loadVirtualSegment(segment, selector); return; }
    if (!protectedMode()) {
        s[segment] = selector; segments[segment].base = uint32_t(selector) << 4;
        if (supports386() && segment == CS) {
            segments[CS].attributes = 0; segments[CS].limit = 0xffff; segments[CS].access = 0x9b; segments[CS].null = false;
        }
        hiddenSegments &= uint8_t(~(1 << segment)); return;
    }
    if (segment == CS) fault(6);
    if (!(selector & 0xfffc)) {
        if (segment == SS) fault(13, 0);
        s[segment] = selector; segments[segment].null = true; return;
    }
    auto d = descriptor(selector); unsigned dpl = (d.access >> 5) & 3;
    if (segment == SS) {
        if ((selector & 3) != cpl || dpl != cpl || (d.access & 0x1a) != 0x12) fault(13, selector & 0xfffc);
        if (!(d.access & 0x80)) fault(12, selector & 0xfffc);
    } else {
        if (!(d.access & 0x10) || (d.access & 10) == 8) fault(13, selector & 0xfffc);
        if ((d.access & 12) != 12 && std::max(cpl, unsigned(selector & 3)) > dpl) fault(13, selector & 0xfffc);
        if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    }
    cache(segment, selector, d);
}
void Cpu::loadLdt(uint16_t selector, uint8_t vector) {
    if (!(selector & 0xfffc)) { ldtr = {}; return; }
    if (selector & 4) fault(vector, selector & 0xfffc);
    auto d = descriptor(selector, vector);
    if ((d.access & 31) != 2) fault(vector, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    ldtr = {selector, d.base, d.limit};
}
void Cpu::switchStack(unsigned level) {
    bool wide = supports386() && (tr.access & 8);
    unsigned size = wide ? 4 : 2, off = wide ? 4 + level * 8 : 2 + level * 4;
    // LOADALL can install a valid hidden TSS cache with a zero visible selector.
    if (off + size + 1 > tr.limit) fault(10, tr.selector & 0xfffc);
    auto sp = readSystem(tr.base + off, size); auto ss = uint16_t(readSystem(tr.base + off + size, 2));
    if (!(ss & 0xfffc)) fault(10, 0);
    auto d = descriptor(ss, 10);
    if ((ss & 3) != level || unsigned((d.access >> 5) & 3) != level || (d.access & 0x1a) != 0x12) fault(10, ss & 0xfffc);
    if (!(d.access & 0x80)) fault(12, ss & 0xfffc);
    cache(SS, ss, d);
    if (supports386()) { r32(SP, sp); cpl = level; }
    else r[SP] = uint16_t(sp);
}
void Cpu::nullifyData() {
    for (auto i : {ES, DS, FS, GS})
        if ((segments[i].access & 12) != 12 && unsigned((segments[i].access >> 5) & 3) < cpl) {
            s[i] = 0; segments[i].null = true;
        }
}
void Cpu::farJump(uint16_t selector, uint32_t offset, bool call) {
    auto width = supports386() && operand32 ? 4u : 2u;
    if (!protectedMode() || virtual8086()) {
        if (supports386() && offset > 0xffff) fault(13, 0);
        if (call) { validateStackPush(2, width); pushValue(s[CS], width); pushValue(ip, width); }
        loadSegment(CS, selector); ip = offset; return;
    }
    if (!(selector & 0xfffc)) fault(13, 0);
    auto d = descriptor(selector); unsigned dpl = (d.access >> 5) & 3;
    if (d.access & 0x10) {
        if (!(d.access & 8) || (d.access & 4 ? dpl > cpl : (dpl != cpl || (selector & 3) > cpl))) fault(13, selector & 0xfffc);
        if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
        if (offset > d.limit) fault(13, 0);
        if (call) { validateStackPush(2, width); pushValue(s[CS], width); pushValue(ip, width); }
        loadCode(selector, d, cpl); ip = offset; return;
    }
    if (std::max(cpl, unsigned(selector & 3)) > dpl) fault(13, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    auto type = d.access & 31;
    if (type == 1 || type == 5 || (supports386() && type == 9)) { taskSwitch(type == 5 ? d.gateSelector : selector, call); return; }
    if (type != 4 && !(supports386() && type == 12)) fault(13, selector & 0xfffc);
    width = type == 12 ? 4 : 2;
    auto gateOffset = width == 4 ? d.gateOffset : uint16_t(d.gateOffset);
    auto target = codeDescriptor(d.gateSelector); unsigned level = (target.access >> 5) & 3;
    if (target.access & 4 ? level > cpl : call ? level > cpl : level != cpl) fault(13, d.gateSelector & 0xfffc);
    if (!(target.access & 0x80)) fault(11, d.gateSelector & 0xfffc);
    if (gateOffset > target.limit) fault(13, 0);
    if (call) {
        auto ss = s[SS], cs = s[CS]; auto sp = stackPointer(), ret = ip;
        if (!(target.access & 4) && level < cpl) {
            std::array<uint32_t, 31> parameters{};
            for (unsigned i = 0; i < d.parameters; ++i) {
                auto off = sp + i * width;
                if (!(segments[SS].attributes & 0x40)) off = uint16_t(off);
                parameters[i] = readSegment(SS, off, width);
            }
            switchStack(level); validateStackPush(d.parameters + 4, width);
            pushValue(ss, width); pushValue(sp, width);
            for (unsigned i = d.parameters; i; --i) pushValue(parameters[i - 1], width);
        } else level = cpl;
        validateStackPush(2, width); pushValue(cs, width); pushValue(ret, width);
    } else level = cpl;
    loadCode(d.gateSelector, target, level); ip = gateOffset;
}
void Cpu::popFlags(uint16_t value, unsigned oldLevel) {
    if (protectedMode()) {
        if (oldLevel) value = uint16_t((value & ~0x3000) | (flags & 0x3000));
        if (oldLevel > unsigned((flags >> 12) & 3)) value = uint16_t((value & ~IF) | (flags & IF));
    }
    setFlags(value);
}
void Cpu::farReturn(uint16_t adjustment, bool interruptReturn) {
    if (supports386()) { farReturn386(adjustment, interruptReturn); return; }
    if (protectedMode() && interruptReturn && (flags & 0x4000)) { taskSwitch(readWord(tr.base), false, true); return; }
    auto sp = r[SP], offset = rwS(SS, sp), selector = rwS(SS, uint16_t(sp + 2));
    uint16_t value = interruptReturn ? rwS(SS, uint16_t(sp + 4)) : flags;
    unsigned consumed = interruptReturn ? 6 : 4;
    if (!protectedMode()) {
        r[SP] = uint16_t(sp + consumed + adjustment); loadSegment(CS, selector); ip = offset;
        if (interruptReturn) setFlags(value);
        return;
    }
    unsigned oldLevel = cpl, level = selector & 3;
    if (level < cpl) fault(13, selector & 0xfffc);
    auto d = codeDescriptor(selector); unsigned dpl = (d.access >> 5) & 3;
    if (d.access & 4 ? dpl > level : dpl != level) fault(13, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    if (offset > d.limit) fault(13, 0);
    if (level > cpl) {
        auto newSp = rwS(SS, uint16_t(sp + consumed + adjustment));
        auto newSs = rwS(SS, uint16_t(sp + consumed + adjustment + 2));
        loadCode(selector, d, level); loadSegment(SS, newSs); r[SP] = uint16_t(newSp + adjustment); nullifyData();
    } else { loadCode(selector, d, level); r[SP] = uint16_t(sp + consumed + adjustment); }
    ip = offset;
    if (interruptReturn) popFlags(value, oldLevel);
}
void Cpu::protectedInterrupt(uint8_t number, int code, bool software, bool external) {
    bool vm = virtual8086();
    unsigned error = number * 8 + 2 + unsigned(external);
    if (unsigned(number) * 8 + 7 > idtr.limit) fault(13, int(error));
    auto a = idtr.base + number * 8; auto access = readSystem(a + 5, 1); auto selector = uint16_t(readSystem(a + 2, 2));
    auto offset = readSystem(a, 2); unsigned type = access & 31;
    bool wide = supports386() && (type == 14 || type == 15);
    if (type != 5 && type != 6 && type != 7 && !wide) fault(13, int(error));
    if (software && unsigned((access >> 5) & 3) < cpl) fault(13, int(number * 8 + 2));
    if (!(access & 0x80)) fault(11, int(error));
    if (type == 5) { taskSwitch(selector, true); if (code >= 0) pushValue(uint32_t(code), tr.access & 8 ? 4 : 2); return; }
    unsigned width = wide ? 4 : 2;
    if (wide) offset |= readSystem(a + 6, 2) << 16;
    auto d = codeDescriptor(selector); unsigned level = (d.access >> 5) & 3;
    if (level > cpl) fault(13, selector & 0xfffc);
    if (vm && (!wide || level || (d.access & 4))) fault(13, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    if (offset > d.limit) fault(13, 0);
    auto oldFlags = eflags(); auto oldCs = s[CS]; auto oldIp = ip;
    if (vm) {
        auto oldSs = s[SS]; auto oldSp = r32(SP);
        std::array<uint16_t, 4> data = {s[GS], s[FS], s[DS], s[ES]};
        upperFlags &= ~0x20000u; switchStack(0);
        validateStackPush(9 + unsigned(code >= 0), width);
        for (auto value : data) pushValue(value, width);
        pushValue(oldSs, width); pushValue(oldSp, width);
        for (auto segment : {ES, DS, FS, GS}) loadSegment(segment, 0);
    } else if (!(d.access & 4) && level < cpl) {
        auto oldSs = s[SS]; auto oldSp = stackPointer(); switchStack(level);
        validateStackPush(5 + unsigned(code >= 0), width); pushValue(oldSs, width); pushValue(oldSp, width);
    } else level = cpl;
    validateStackPush(3 + unsigned(code >= 0), width);
    pushValue(oldFlags, width); pushValue(oldCs, width); pushValue(oldIp, width);
    if (code >= 0) pushValue(uint32_t(code), width);
    loadCode(selector, d, level); ip = offset; flags &= ~(TF | 0x4000);
    if (supports386()) upperFlags &= ~0x10000u;
    if (type == 6 || type == 14) flags &= ~IF;
}
void Cpu::taskSwitch(uint16_t selector, bool nested, bool returning) {
    if (supports386()) { taskSwitch386(selector, nested, returning); return; }
    if (!(selector & 0xfffc) || (selector & 4)) fault(returning ? 10 : 13, selector & 0xfffc);
    auto d = descriptor(selector, returning ? 10 : 13);
    if ((d.access & 31) != (returning ? 3 : 1)) fault(returning ? 10 : 13, selector & 0xfffc);
    if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
    if (d.limit < 43 || tr.limit < 43) fault(10, selector & 0xfffc);
    writeWord(tr.base + 14, ip); writeWord(tr.base + 16, uint16_t(returning ? flags & ~0x4000 : flags));
    for (unsigned i = 0; i < 8; ++i) writeWord(tr.base + 18 + i * 2, r[i]);
    for (unsigned i = 0; i < 4; ++i) writeWord(tr.base + 34 + i * 2, s[i]);
    if (!nested) { auto old = descriptor(tr.selector); writePhysical(old.address + 5, old.access & ~2); }
    if (!returning) writePhysical(d.address + 5, d.access | 2);
    if (nested) writeWord(d.base, tr.selector);
    tr = {selector, d.base, d.limit}; msw |= 8;
    ip = readWord(d.base + 14); setFlags(uint16_t(readWord(d.base + 16) | (nested ? 0x4000 : 0)));
    for (unsigned i = 0; i < 8; ++i) r[i] = readWord(d.base + 18 + i * 2);
    std::array<uint16_t, 4> selectors{};
    for (unsigned i = 0; i < 4; ++i) selectors[i] = readWord(d.base + 34 + i * 2);
    taskCommitted = true; startIp = ip;
    loadLdt(readWord(d.base + 42), 10); cpl = selectors[CS] & 3;
    try {
        auto cd = codeDescriptor(selectors[CS]);
        if (cd.access & 4 ? unsigned((cd.access >> 5) & 3) > cpl : unsigned((cd.access >> 5) & 3) != cpl) fault(10, selectors[CS] & 0xfffc);
        if (!(cd.access & 0x80)) fault(11, selectors[CS] & 0xfffc);
        loadCode(selectors[CS], cd, cpl); loadSegment(SS, selectors[SS]);
        loadSegment(ES, selectors[ES]); loadSegment(DS, selectors[DS]);
        if (ip > cd.limit) fault(13, 0);
    } catch (const CpuFault& f) { if (f.vector == 13 && f.code > 0) fault(10, f.code); throw; }
}
void Cpu::loadAll() {
    requireRing0();
    msw = uint16_t((msw & 0xfff0) | (readWord(0x806) & 15) | (msw & 1));
    tr.selector = readWord(0x816); setFlags(readWord(0x818)); ip = readWord(0x81a); ldtr.selector = readWord(0x81c);
    for (unsigned i = 0; i < 4; ++i) s[3 - i] = readWord(0x81e + i * 2);
    for (unsigned i = 0; i < 8; ++i) r[7 - i] = readWord(0x826 + i * 2);
    auto readCache = [&](uint32_t a) {
        Segment d; d.base = readWord(a) | (uint32_t(readPhysical(a + 2)) << 16);
        d.access = readPhysical(a + 3); d.limit = readWord(a + 4); return d;
    };
    for (unsigned i = 0; i < 4; ++i) segments[i] = readCache(0x836 + i * 6);
    auto g = readCache(0x84e), l = readCache(0x854), it = readCache(0x85a), t = readCache(0x860);
    gdtr = {g.base, g.limit}; idtr = {it.base, it.limit};
    ldtr.base = l.base; ldtr.limit = l.limit; tr.base = t.base; tr.limit = t.limit;
    hiddenSegments = protectedMode() ? 0 : 15; cpl = protectedMode() ? (segments[CS].access >> 5) & 3 : 0;
}
void Cpu::execSystem() {
    auto op = fetch8();
    if (op == 5) { loadAll(); return; }
    if (op == 6) { requireRing0(); msw &= ~8; return; }
    if (op > 3) fault(6);
    if (op != 1 && !protectedMode()) fault(6);
    modrm();
    if (op == 1) {
        if (reg == 4) { setRM(2, msw); return; }
        if (reg == 6) {
            requireRing0(); auto value = getRM(2);
            if (!protectedMode() && (value & 1)) {
                for (unsigned i = 0; i < 4; ++i)
                    if (!(hiddenSegments & (1 << i))) segments[i].base = uint32_t(s[i]) << 4;
                hiddenSegments = 0; cpl = 0;
            }
            msw = uint16_t((msw & 0xfff0) | (value & 15) | (msw & 1)); return;
        }
        if (mod == 3 || reg > 3) fault(6);
        auto& table = reg == 0 || reg == 2 ? gdtr : idtr;
        if (reg < 2) {
            wwS(eaSeg, eaOff, table.limit); wwS(eaSeg, uint16_t(eaOff + 2), uint16_t(table.base));
            wbS(eaSeg, uint16_t(eaOff + 4), uint8_t(table.base >> 16)); wbS(eaSeg, uint16_t(eaOff + 5), 255);
        } else {
            requireRing0(); auto limit = rwS(eaSeg, eaOff);
            auto base = rwS(eaSeg, uint16_t(eaOff + 2)) | (uint32_t(rbS(eaSeg, uint16_t(eaOff + 4))) << 16);
            table = {base, limit};
        }
        return;
    }
    if (op == 0) {
        if (reg == 0 || reg == 1) { setRM(2, reg == 0 ? ldtr.selector : tr.selector); return; }
        if (reg == 2) { requireRing0(); loadLdt(getRM(2)); return; }
        if (reg == 3) {
            requireRing0(); auto selector = uint16_t(getRM(2));
            if (!(selector & 0xfffc) || (selector & 4)) fault(13, selector & 0xfffc);
            auto d = descriptor(selector);
            if ((d.access & 31) != 1 && !(supports386() && (d.access & 31) == 9)) fault(13, selector & 0xfffc);
            if (!(d.access & 0x80)) fault(11, selector & 0xfffc);
            writeSystem(d.address + 5, d.access | 2, 1); tr = {selector, d.base, d.limit, uint8_t(d.access | 2)}; return;
        }
        if (reg > 5) fault(6);
    }
    auto selector = getRM(2); flags &= ~ZF;
    if (!(selector & 0xfffc)) return;
    Descriptor d;
    try { d = descriptor(selector); } catch (const CpuFault& f) { if (f.vector == 13) return; throw; }
    unsigned type = d.access & 31;
    if ((d.access & 0x1c) != 0x1c && std::max(cpl, unsigned(selector & 3)) > unsigned((d.access >> 5) & 3)) return;
    if (op == 0) {
        if (!(d.access & 0x10) || (reg == 4 ? (d.access & 10) == 8 : (d.access & 10) != 2)) return;
    } else {
        if (!(d.access & 0x10)) {
            bool valid = type == 1 || type == 2 || type == 3 || (op == 2 && (type == 4 || type == 5));
            if (supports386()) valid = valid || type == 9 || type == 11 || (op == 2 && type == 12);
            if (!valid) return;
        }
        auto value = op == 2 ? (uint32_t(d.attributes) << 16) | (uint32_t(d.access) << 8) : d.limit;
        setReg(supports386() && operand32 ? 4 : 2, reg, value);
    }
    flags |= ZF;
}
void Cpu::exec186(uint8_t op) {
    switch (op) {
    case 0x60: { auto sp = r[SP]; for (unsigned i = 0; i < 8; ++i) push(i == SP ? sp : r[i]); return; }
    case 0x61: for (int i = 7; i >= 0; --i) { auto v = pop(); if (i != SP) r[i] = v; } return;
    case 0x62: {
        modrm(); if (mod == 3) fault(6);
        auto low = int16_t(rwS(eaSeg, eaOff)), high = int16_t(rwS(eaSeg, uint16_t(eaOff + 2)));
        if (int16_t(r[reg]) < low || int16_t(r[reg]) > high) fault(5);
        return;
    }
    case 0x63: {
        if (!protectedMode() || virtual8086()) fault(6);
        modrm(); auto value = getRM(2); bool change = (value & 3) < (r[reg] & 3);
        if (change) setRM(2, uint16_t((value & ~3) | (r[reg] & 3)));
        flag(ZF, change); return;
    }
    case 0x68: { auto value = fetch16(); push(value); return; }
    case 0x6a: { auto value = uint16_t(int16_t(int8_t(fetch8()))); push(value); return; }
    case 0x69: case 0x6b: {
        modrm(); auto a = int16_t(getRM(2)); auto b = op == 0x69 ? int16_t(fetch16()) : int16_t(int8_t(fetch8()));
        auto result = int32_t(a) * b; r[reg] = uint16_t(result); flag(CF | OF, result != int16_t(r[reg])); return;
    }
    case 0x6c: case 0x6d: case 0x6e: case 0x6f: string(op); return;
    case 0xc0: case 0xc1: {
        modrm(); auto count = fetch8(); int size = (op & 1) ? 2 : 1;
        auto result = shift(reg, getRM(size), count, size); setRM(size, result); return;
    }
    case 0xc8: {
        auto allocation = fetch16(); unsigned level = fetch8() & 31;
        push(r[BP]); auto frame = r[SP];
        if (level) {
            auto bp = r[BP];
            for (unsigned i = 1; i < level; ++i) { bp -= 2; push(rwS(SS, bp)); }
            push(frame);
        }
        auto sp = uint16_t(r[SP] - allocation); checkSegment(SS, sp, 1, true); r[BP] = frame; r[SP] = sp; return;
    }
    case 0xc9: { auto bp = rwS(SS, r[BP]); r[SP] = uint16_t(r[BP] + 2); r[BP] = bp; return; }
    default: fault(6);
    }
}
void Cpu::step() {
    if (model == CpuModel::I8088) { stepInstruction(); return; }
    auto save = [&]() { return std::make_tuple(r, upperR, s, segments, ip, flags, upperFlags, cpl, hiddenSegments); };
    auto restore = [&](const auto& state) {
        std::tie(r, upperR, s, segments, ip, flags, upperFlags, cpl, hiddenSegments) = state;
    };
    auto before = save(); auto oldAddress = segmentBase(CS) + ip;
    taskCommitted = false;
    try { stepInstruction(); }
    catch (const CpuFault& f) {
        if (!taskCommitted) restore(before);
        if (onFault) onFault(f, oldAddress);
        auto pending = f;
        auto contributory = [](uint8_t v) { return v == 0 || (v >= 9 && v <= 13); };
        for (;;) {
            auto deliveryState = save(); taskCommitted = false;
            if (supports386() && pending.vector != 1 && pending.vector != 8) upperFlags |= 0x10000;
            try { interrupt(pending.vector, pending.code); return; }
            catch (const CpuFault& delivery) {
                if (!taskCommitted) restore(deliveryState);
                if (pending.vector == 8) {
                    if (resetSignal) { resetSignal(); return; }
                    std::string bytes;
                    for (unsigned i = 0; i < 16; ++i) bytes += " " + std::to_string(readPhysical(oldAddress + i));
                    throw std::runtime_error("x86 triple fault at " + std::to_string(s[CS]) + ":" + std::to_string(ip)
                        + " while delivering exception " + std::to_string(f.vector) + " code " + std::to_string(f.code)
                        + " double=" + std::to_string(delivery.vector) + ":" + std::to_string(delivery.code)
                        + " CPL=" + std::to_string(cpl) + " FLAGS=" + std::to_string(flags)
                        + " CS-access=" + std::to_string(segments[CS].access) + " SS-access=" + std::to_string(segments[SS].access)
                        + " TR=" + std::to_string(tr.selector) + ":" + std::to_string(tr.base) + ":" + std::to_string(tr.limit)
                        + " GDT=" + std::to_string(gdtr.base) + ":" + std::to_string(gdtr.limit)
                        + " IDT=" + std::to_string(idtr.base) + ":" + std::to_string(idtr.limit) + " bytes:" + bytes);
                }
                bool doubleFault = !supports386()
                    || (contributory(pending.vector) && contributory(delivery.vector))
                    || (pending.vector == 14 && (delivery.vector == 14 || contributory(delivery.vector)));
                pending = doubleFault ? CpuFault{8, 0} : delivery;
            }
        }
    }
}
}
