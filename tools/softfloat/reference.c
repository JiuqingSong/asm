/* Native x87 oracle used by tools/check-x87.ts; never linked into the emulator. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    unsigned op, cw, ae, be;
    unsigned long long as, bs;
    while (scanf("%x %x %x %llx %x %llx", &op, &cw, &ae, &as, &be, &bs) == 6) {
        struct { uint8_t bytes[10]; } a, b, out = {{0}};
        uint16_t control = cw, status;
        memcpy(a.bytes, &as, 8); memcpy(a.bytes + 8, &ae, 2);
        memcpy(b.bytes, &bs, 8); memcpy(b.bytes + 8, &be, 2);
        __asm__ volatile ("fninit; fldcw %0; fldt %1; fldt %2" : : "m"(control), "m"(b), "m"(a) : "st");
        switch (op) {
            case 0: __asm__ volatile (".byte 0xd8, 0xc1"); break;
            case 1: __asm__ volatile (".byte 0xd8, 0xe1"); break;
            case 2: __asm__ volatile (".byte 0xd8, 0xc9"); break;
            case 3: __asm__ volatile (".byte 0xd8, 0xf1"); break;
            case 4: __asm__ volatile ("fsqrt"); break;
            case 5: __asm__ volatile ("frndint"); break;
            case 6: __asm__ volatile ("fsin"); break;
            case 7: __asm__ volatile ("fcos"); break;
            case 8: __asm__ volatile ("f2xm1"); break;
            case 9: __asm__ volatile ("fyl2x"); break;
            case 10: __asm__ volatile ("fyl2xp1"); break;
            case 11: __asm__ volatile ("fpatan"); break;
            case 12: __asm__ volatile ("fprem"); break;
            case 13: __asm__ volatile ("fprem1"); break;
            case 14: __asm__ volatile ("fscale"); break;
        }
        __asm__ volatile ("fnstsw %0; fstpt %1; fninit" : "=m"(status), "=m"(out) : : "st");
        uint16_t exponent; uint64_t significand;
        memcpy(&significand, out.bytes, 8); memcpy(&exponent, out.bytes + 8, 2);
        printf("%04x%016llx %04x\n", exponent, (unsigned long long)significand, status);
    }
    return 0;
}
