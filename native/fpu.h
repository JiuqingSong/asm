#pragma once
#include "softfloat.h"
#include <array>
#include <functional>
#include <vector>

namespace asm86 {
struct FpuContext {
    std::function<std::vector<uint8_t>()> read;
    std::function<void(const std::vector<uint8_t>&)> write;
    std::function<void(uint16_t)> ax;
    uint32_t ip = 0, dp = 0;
    uint16_t cs = 0, ds = 0;
    bool operand32 = false, protectedMode = false;
};
struct FpuMemoryOperation { unsigned size; bool write; };

class Fpu {
public:
    std::array<Float80, 8> registers{};
    std::array<uint8_t, 8> tags{{3, 3, 3, 3, 3, 3, 3, 3}};
    uint16_t control = 0x037f, status = 0, cs = 0, ds = 0, opcode = 0;
    unsigned top = 0;
    uint32_t ip = 0, dp = 0;
    std::function<void(bool)> onError;

    void init();
    uint16_t statusWord() const;
    uint16_t tagWord() const;
    bool pending() const;
    Float80 st(unsigned i = 0) const;
    uint8_t tag(unsigned i = 0) const;
    // Memory callbacks must validate/commit their entire operand atomically.
    // A callback exception restores all FPU state and propagates; an unmasked
    // floating-point abort retains diagnostics but rolls back registers/TOP/tags.
    void execute(uint8_t op, uint8_t modrm, const FpuContext& context);
    static FpuMemoryOperation memoryOperation(uint8_t op, unsigned reg, bool operand32);
    static bool noWait(uint8_t op, uint8_t modrm);
private:
    void updateError();
    void raise(uint16_t flags, bool registerResult = false);
    Float80 result(FloatResult r, bool registerResult = false);
    Float80 stackFault(bool overflow);
    Float80 get(unsigned i = 0);
    void denormal(Float80 a);
    void set(unsigned i, Float80 value);
    void push(Float80 value);
    void pop();
    Float80 arithmetic(unsigned kind, Float80 a, Float80 b);
    void compare(Float80 a, Float80 b, bool quiet = false);
    Float80 fromInteger(uint64_t value);
    uint64_t toInteger(Float80 value, unsigned bits);
    void memory(uint8_t op, unsigned reg, const FpuContext& c);
    void registerOperation(uint8_t op, uint8_t modrm, const FpuContext& c);
    void transcendental(uint8_t modrm);
    void remainder(Float80 a, Float80 b, bool nearest);
    std::vector<uint8_t> environment(const FpuContext& c) const;
    void loadEnvironment(const std::vector<uint8_t>& bytes, const FpuContext& c);
};
}
