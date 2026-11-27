#include "pc.h"
#include "font8x8.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <ctime>
#include <cmath>
#include <sstream>
#include <stdexcept>
#include <wincrypt.h>
#include <winioctl.h>

// 整机连接层：CPU 总线 ↔ 外设、原始/差分磁盘、BIOS 服务及 ROM 中实际执行的客体代码。
namespace asm86 {
static std::atomic<uint64_t> nextDiskIdentity{0};
static constexpr uint16_t font16Offset = 0x8000;
static constexpr uint16_t font8Offset = 0x9000;
static constexpr uint16_t font14Offset = 0x9800;
static constexpr uint16_t cirrusFixupOffset = 0x180;

static std::runtime_error osError(const char* operation) {
    return std::runtime_error(std::string(operation) + " (Windows error " + std::to_string(GetLastError()) + ")");
}

static uint32_t floppyPayloadSectors(HANDLE file, uint32_t sectors) {
    // 部分软盘映像在有效扇区后附带 1024 字节元数据；只有 BPB 和尾注都匹配才剥离。
    uint32_t payload = sectors >= 2 ? sectors - 2 : 0;
    if (payload != 320 && payload != 360 && payload != 640 && payload != 720 &&
        payload != 1440 && payload != 2400 && payload != 2880) return sectors;
    std::array<uint8_t, 512> boot{};
    std::array<char, 1024> footer{};
    DWORD done = 0; LARGE_INTEGER position{};
    if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) ||
        !ReadFile(file, boot.data(), DWORD(boot.size()), &done, nullptr) || done != boot.size())
        throw osError("Cannot read floppy geometry");
    position.QuadPart = uint64_t(payload) * 512;
    if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) ||
        !ReadFile(file, footer.data(), DWORD(footer.size()), &done, nullptr) || done != footer.size())
        throw osError("Cannot read floppy metadata");
    auto word = [&](unsigned o) { return unsigned(boot[o]) | unsigned(boot[o + 1]) << 8; };
    unsigned heads = (payload == 320 || payload == 360) ? 1 : 2;
    unsigned spt = payload == 320 || payload == 640 ? 8 : payload == 2400 ? 15 : payload == 2880 ? 18 : 9;
    std::string metadata(footer.data(), footer.size());
    if (metadata.rfind("[FileVersion 003]", 0) != 0 || word(11) != 512 || word(19) != payload ||
        word(24) != spt || word(26) != heads || word(510) != 0xaa55 ||
        metadata.find("[SectorsPerTrack " + std::to_string(spt) + "]") == std::string::npos ||
        metadata.find("[Tracks " + std::to_string(payload / (heads * spt)) + "]") == std::string::npos)
        return sectors;
    return payload;
}

static std::runtime_error biosError(Cpu& c, uint8_t number) {
    auto off = c.rwS(SS, c.r[SP]), seg = c.rwS(SS, uint16_t(c.r[SP] + 2));
    std::ostringstream message;
    message << "Unsupported BIOS INT " << std::hex << unsigned(number) << "h AX=" << c.r[AX]
        << " BX=" << c.r[BX] << " CX=" << c.r[CX] << " DX=" << c.r[DX]
        << " return=" << seg << ':' << off << " bytes:";
    for (int i = -12; i < 8; ++i) message << ' ' << unsigned(c.rbF(seg, uint16_t(off + i)));
    return std::runtime_error(message.str());
}

static void installDiskFirmware(Cpu& cpu) {
    // ESDI_506 截获 INT 13h 期间的 IDE I/O，以关联 BIOS 80h 和主通道硬盘。
    // 按 diskrom.ts 的客体 PIO 路径实现传统读/写/校验，不能只从宿主复制扇区。
    // 栈布局：DI、SI、DX、CX、BX、ES、DS、AX、BP、IP、CS、FLAGS；BP 指向保存的 DI。
    // 高端/跨 64 KiB 缓冲及其它功能保留原陷阱路径；等待 BSY/DRQ 有有限超时。
    const uint8_t code[] = {
        0x80,0xfa,0x80, // CMP DL,80h：只接主通道的第一块硬盘。
        0x75,0x0a, // JNE trap。
        0x80,0xfc,0x02, // CMP AH,2：传统读扇区。
        0x72,0x05, // JB trap。
        0x80,0xfc,0x04, // CMP AH,4：传统写/校验扇区。
        0x76,0x05, // JBE harddisk。
        0xea, // JMP FAR F000:0860：保留软盘、EDD、其它 BIOS 服务。
        0x60,0x08,0x00,0xf0, // 小端远地址。
        0x55, // PUSH BP：保存寄存器。
        0x50, // PUSH AX。
        0x1e, // PUSH DS。
        0x06, // PUSH ES。
        0x53, // PUSH BX。
        0x51, // PUSH CX。
        0x52, // PUSH DX。
        0x56, // PUSH SI。
        0x57, // PUSH DI。
        0x8b,0xec, // MOV BP,SP：建立保存参数的栈帧。
        0xfb, // STI：允许 IRQ14 及 BIOS 定时器中断。
        0xbe,0x01,0xe4, // MOV SI,E401h：硬盘参数表。
        0xf6,0xc2,0x01, // TEST DL,1：检测驱动器低位。
        0x74,0x03, // JZ unit0。
        0x83,0xc6,0x10, // ADD SI,16：第二张参数表。
        0x2e,0x83,0x3c,0x00, // CMP WORD CS:[SI],0：零柱面表示没有盘。
        0x75,0x0b, // JNE present。
        0x5f, // POP DI：没有盘时恢复原参数并进入旧陷阱。
        0x5e, // POP SI。
        0x5a, // POP DX。
        0x59, // POP CX。
        0x5b, // POP BX。
        0x07, // POP ES。
        0x1f, // POP DS。
        0x58, // POP AX。
        0x5d, // POP BP。
        0xeb,0xd3, // JMP trap。
        0x80,0x7e,0x0e,0x00, // CMP BYTE [BP+14],0：扇区计数不能为零。
        0x75,0x05, // JNE checkchs。
        0xb4,0x04, // MOV AH,4：找不到扇区。
        0xe9,0x86,0x01, // JMP fail0。
        0x8a,0x46,0x07, // MOV AL,[BP+7]：CH 中的柱面低八位。
        0x8a,0x66,0x06, // MOV AH,[BP+6]：CL 中的柱面高两位。
        0xb1,0x06, // MOV CL,6。
        0xd2,0xec, // SHR AH,CL：得到完整十位柱面号。
        0x2e,0x3b,0x04, // CMP AX,CS:[SI]：检查柱面范围。
        0x72,0x05, // JB checkhead。
        0xb4,0x04, // MOV AH,4。
        0xe9,0x72,0x01, // JMP fail0。
        0x8a,0x46,0x05, // MOV AL,[BP+5]：DH 中的磁头号。
        0x2e,0x3a,0x44,0x02, // CMP AL,CS:[SI+2]：检查磁头范围。
        0x73,0xf2, // JAE badchs。
        0x8a,0x46,0x06, // MOV AL,[BP+6]：CL 中的扇区号。
        0x24,0x3f, // AND AL,3Fh。
        0x2e,0x3a,0x44,0x0e, // CMP AL,CS:[SI+14]：检查每道扇区范围。
        0x77,0xe7, // JA badchs。
        0x0a,0xc0, // OR AL,AL：扇区从 1 开始。
        0x74,0xe3, // JZ badchs。
        0x8c,0xc0, // MOV AX,ES：检查高端实模式缓冲。
        0x3d,0x00,0xf0, // CMP AX,F000h。
        0x73,0x18, // JAE slowpath：保留旧 BIOS 的二十位地址回绕。
        0x80,0x7e,0x0e,0x80, // CMP BYTE [BP+14],128：检查缓冲长度。
        0x73,0x12, // JAE slowpath。
        0x33,0xc0, // XOR AX,AX。
        0x8a,0x46,0x0e, // MOV AL,[BP+14]：扇区计数。
        0xb1,0x09, // MOV CL,9。
        0xd3,0xe0, // SHL AX,CL：字节数 = 扇区数 × 512。
        0x03,0x46,0x08, // ADD AX,[BP+8]：加缓冲偏移。
        0x73,0x10, // JNC fastpath：没有跨越段边界。
        0x0b,0xc0, // OR AX,AX：恰好到 10000h 也合法。
        0x74,0x0c, // JZ fastpath。
        0x5f, // POP DI：少见缓冲情况恢复参数后交旧 BIOS。
        0x5e, // POP SI。
        0x5a, // POP DX。
        0x59, // POP CX。
        0x5b, // POP BX。
        0x07, // POP ES。
        0x1f, // POP DS。
        0x58, // POP AX。
        0x5d, // POP BP。
        0xe9,0x71,0xff, // JMP trap。
        0xb4,0x01, // MOV AH,1：无效参数状态。
        0x80,0x7e,0x0e,0x00, // CMP BYTE [BP+14],0。
        0x75,0x03,0xe9,0x24,0x01, // JNE +3 / JMP fail0：8086 形式的远条件跳转。
        0x8a,0x46,0x07, // MOV AL,[BP+7]：重新取原始 CH，不能使用已改动的 CX。
        0x8a,0x66,0x06, // MOV AH,[BP+6]。
        0xb1,0x06, // MOV CL,6。
        0xd2,0xec, // SHR AH,CL：柱面号。
        0x32,0xff, // XOR BH,BH。
        0x2e,0x8a,0x5c,0x02, // MOV BL,CS:[SI+2]：磁头数。
        0xf7,0xe3, // MUL BX：DX:AX = 柱面 × 磁头数。
        0x8a,0x5e,0x05, // MOV BL,[BP+5]：磁头号。
        0x03,0xc3, // ADD AX,BX。
        0x83,0xd2,0x00, // ADC DX,0：不能丢失低字进位。
        0x2e,0x8a,0x5c,0x0e, // MOV BL,CS:[SI+14]：每道扇区数。
        0x8b,0xca, // MOV CX,DX：大盘翻译几何可令第一步乘积超过 65535。
        0xf7,0xe3, // MUL BX：计算低字乘每道扇区数。
        0x8b,0xf8, // MOV DI,AX：保存结果低字。
        0x52, // PUSH DX：保存低字乘法的高字。
        0x8b,0xc1, // MOV AX,CX。
        0xf7,0xe3, // MUL BX：计算原高字的贡献。
        0x5a, // POP DX。
        0x03,0xd0, // ADD DX,AX：合并完整的三十二位乘积。
        0x8b,0xc7, // MOV AX,DI。
        0x8a,0x5e,0x06, // MOV BL,[BP+6]：扇区号。
        0x80,0xe3,0x3f, // AND BL,3Fh。
        0x75,0x05, // JNZ secok。
        0xb4,0x04, // MOV AH,4。
        0xe9,0xe9,0x00, // JMP fail0。
        0xfe,0xcb, // DEC BL：LBA 的扇区从零开始。
        0x03,0xc3, // ADD AX,BX。
        0x83,0xd2,0x00, // ADC DX,0。
        0x8b,0xd8, // MOV BX,AX：DI:BX 保存 LBA。
        0x8b,0xfa, // MOV DI,DX。
        0x8b,0xc7, // MOV AX,DI。
        0x8a,0xc4, // MOV AL,AH：LBA 位 24..27。
        0x24,0x0f, // AND AL,0Fh。
        0x0c,0xe0, // OR AL,E0h：LBA 模式、主盘。
        0xf6,0x46,0x04,0x01, // TEST BYTE [BP+4],1。
        0x74,0x02, // JZ master。
        0x0c,0x10, // OR AL,10h：从盘选择位。
        0xba,0xf6,0x01, // MOV DX,1F6h：Device/Head。
        0xee, // OUT DX,AL。
        0xba,0xf2,0x01, // MOV DX,1F2h：Sector Count。
        0x8a,0x46,0x0e, // MOV AL,[BP+14]。
        0xee, // OUT DX,AL：写计数。
        0x42, // INC DX。
        0x8a,0xc3, // MOV AL,BL。
        0xee, // OUT DX,AL：LBA 位 0..7。
        0x42, // INC DX。
        0x8a,0xc7, // MOV AL,BH。
        0xee, // OUT DX,AL：LBA 位 8..15。
        0x42, // INC DX。
        0x8b,0xc7, // MOV AX,DI。
        0xee, // OUT DX,AL：LBA 位 16..23。
        0xba,0xf7,0x01, // MOV DX,1F7h：Command。
        0xb0,0x20, // MOV AL,20h：READ SECTORS。
        0x80,0x7e,0x0f,0x03, // CMP BYTE [BP+15],3。
        0x72,0x06, // JB command。
        0xb0,0x30, // MOV AL,30h：WRITE SECTORS。
        0x74,0x02, // JE command。
        0xb0,0x40, // MOV AL,40h：READ VERIFY SECTORS。
        0xee, // OUT DX,AL：执行真正的 ATA 命令。
        0x8b,0x7e,0x08, // MOV DI,[BP+8]：保留原 ES 段和分页语义。
        0x33,0xf6, // XOR SI,SI：已传送扇区数。
        0xfc, // CLD：传输向高地址进行，原 DF 由 IRET 恢复。
        0x80,0x7e,0x0f,0x04, // CMP BYTE [BP+15],4。
        0x74,0x3e, // JE finish：校验不传输数据。
        0xba,0xf7,0x01, // MOV DX,1F7h：Status。
        0xbb,0xff,0xff, // MOV BX,FFFFh：有限的轮询预算。
        0xec, // IN AL,DX。
        0xa8,0x80, // TEST AL,80h：BSY。
        0x75,0x0a, // JNZ pollagain。
        0xa8,0x01, // TEST AL,1：ERR。
        0x75,0x68, // JNZ error。
        0xa8,0x08, // TEST AL,8：DRQ。
        0x74,0x02, // JZ pollagain。
        0xeb,0x07, // JMP transfer。
        0x4b, // DEC BX。
        0x75,0xee, // JNZ waitdrq。
        0xb4,0x80, // MOV AH,80h：BIOS 超时。
        0xeb,0x77, // JMP errcount。
        0xba,0xf0,0x01, // MOV DX,1F0h：Data。
        0xb9,0x00,0x01, // MOV CX,256：每扇区 256 字。
        0x80,0x7e,0x0f,0x03, // CMP BYTE [BP+15],3。
        0x74,0x06, // JE writing。
        0xed, // IN AX,DX：从同一个 ATA FIFO 读完整数据字。
        0xab, // STOSW：写 ES:DI 并递增 DI。
        0xe2,0xfc, // LOOP reading。
        0xeb,0x08, // JMP next。
        0x26,0x8b,0x05, // MOV AX,ES:[DI]：取待写的数据字。
        0xef, // OUT DX,AX：写完整数据字。
        0x47, // INC DI。
        0x47, // INC DI。
        0xe2,0xf8, // LOOP writing。
        0x46, // INC SI：完成一个扇区。
        0x8b,0xc6, // MOV AX,SI。
        0x3a,0x46,0x0e, // CMP AL,[BP+14]。
        0x72,0xc2, // JB sector。
        0xba,0xf7,0x01, // MOV DX,1F7h：等待最终完成。
        0xbb,0xff,0xff, // MOV BX,FFFFh。
        0xec, // IN AL,DX。
        0xa8,0x80, // TEST AL,80h。
        0x75,0x27, // JNZ endagain。
        0xa8,0x01, // TEST AL,1。
        0x75,0x2a, // JNZ error。
        0x80,0x7e,0x0f,0x03, // CMP BYTE [BP+15],3。
        0x75,0x16, // JNE success。
        0xb0,0xe7, // MOV AL,E7h：BIOS 写完成后 FLUSH CACHE，保持持久性约定。
        0xee, // OUT DX,AL。
        0xbb,0xff,0xff, // MOV BX,FFFFh。
        0xec, // IN AL,DX。
        0xa8,0x80, // TEST AL,80h。
        0x74,0x07, // JZ flushend。
        0x4b, // DEC BX。
        0x75,0xf8, // JNZ flushwait。
        0xb4,0x80, // MOV AH,80h：刷新超时。
        0xeb,0x2e, // JMP errcount。
        0xa8,0x01, // TEST AL,1。
        0x75,0x0e, // JNZ error。
        0x8a,0x46,0x0e, // MOV AL,[BP+14]：成功扇区数。
        0x32,0xe4, // XOR AH,AH：成功状态。
        0xeb,0x2b, // JMP done。
        0x4b, // DEC BX。
        0x75,0xd1, // JNZ waitend。
        0xb4,0x80, // MOV AH,80h：完成超时。
        0xeb,0x1c, // JMP errcount。
        0xba,0xf1,0x01, // MOV DX,1F1h：Error。
        0xec, // IN AL,DX。
        0xb4,0x04, // MOV AH,4：IDNF 对应找不到扇区。
        0xa8,0x10, // TEST AL,10h。
        0x75,0x12, // JNZ errcount。
        0xb4,0x01, // MOV AH,1：ABRT 默认表示无效命令。
        0xa8,0x04, // TEST AL,4。
        0x74,0x0a, // JZ baddata。
        0x80,0x7e,0x0f,0x03, // CMP BYTE [BP+15],3。
        0x75,0x06, // JNE errcount。
        0xb4,0x03, // MOV AH,3：写只读盘的写保护错误。
        0xeb,0x02, // JMP errcount。
        0xb4,0x10, // MOV AH,10h：其它数据错误。
        0x8b,0xd6, // MOV DX,SI。
        0x8a,0xc2, // MOV AL,DL：实际完成扇区数。
        0xeb,0x02, // JMP done。
        0x32,0xc0, // XOR AL,AL：参数错误没有完成扇区。
        0x89,0x46,0x0e, // MOV [BP+14],AX：修改保存的返回 AX。
        0xbb,0x40,0x00, // MOV BX,40h。
        0x8e,0xdb, // MOV DS,BX。
        0x88,0x26,0x74,0x00, // MOV DS:[74h],AH：BDA 上次硬盘状态。
        0x80,0x66,0x16,0xfe, // AND BYTE [BP+22],FEh：清调用者 CF。
        0x0a,0xe4, // OR AH,AH。
        0x74,0x04, // JZ popall。
        0x80,0x4e,0x16,0x01, // OR BYTE [BP+22],1：失败时置 CF。
        0x5f, // POP DI。
        0x5e, // POP SI。
        0x5a, // POP DX。
        0x59, // POP CX。
        0x5b, // POP BX。
        0x07, // POP ES。
        0x1f, // POP DS。
        0x58, // POP AX。
        0x5d, // POP BP。
        0xcf, // IRET：恢复调用者及原 IF/DF，只改变返回 CF。
    };
    std::copy(std::begin(code), std::end(code), cpu.mem.begin() + 0xfa000);
    cpu.ww(0, 0x13 * 4, 0xa000);

    // BIOS 轮询数据时仍允许 IRQ14。EOI 也必须由客体 OUT 发出，否则 VPICD 不会解锁虚拟 IRQ。
    const uint8_t irq[] = {
        0x50,0x52, // PUSH AX / PUSH DX。
        0xba,0xf7,0x01,0xec, // MOV DX,1F7h / IN AL,DX：确认 ATA 中断。
        0xb0,0x20, // MOV AL,20h：非特定 EOI。
        0xe6,0xa0,0xe6,0x20, // OUT A0h,AL / OUT 20h,AL：确认从 PIC 和级联主 PIC。
        0x5a,0x58,0xcf // POP DX / POP AX / IRET。
    };
    std::copy(std::begin(irq), std::end(irq), cpu.mem.begin() + 0xf08c0);
    cpu.ww(0, 0x76 * 4, 0x08c0);
}

static void installVideoFirmware(Cpu& cpu, bool cirrus) {
    // INT 10h/AH=00 的设模必须由客体 IN/OUT、显存写入完成，VM86 监控器才能更新其 VGA 缓存。
    // 表中跳转偏移是固定的；只增加注释/换行，不能插入或删除任何机器码字节。
    // F1 10 是解释器私有 BIOS 陷阱，CF 才是标准 IRET；其余字节均是 16 位 x86 指令。
    const uint8_t handler[] = {
        0x80,0xfc,0x00,       // CMP AH,00h：区分设模与其他 INT 10h 服务。
        0x74,0x03,           // JE 0008h：设模进入客体 VGA 编程流程。
        0xf1,0x10,           // BIOS_TRAP 10h：其他服务交给 C++ video()。
        0xcf,                // IRET：返回调用者。
        0xf1,0x10,           // BIOS_TRAP 10h：先更新 BIOS 模式/BDA，再执行实际端口操作。
        0x50,0x53,0x51,0x52, // PUSH AX/BX/CX/DX：保存调用者通用寄存器。
        0x56,0x1e,0x06,0x57, // PUSH SI/DS/ES/DI：保存索引和段寄存器。
        0x0e,0x1f,           // PUSH CS / POP DS：DS 指向 ROM 中的模式配置表。
        0xfc,                // CLD：字符串读取/写入均向前。
        0x30,0xff,           // XOR BH,BH：模式号扩成 BX。
        0x88,0xc3,           // MOV BL,AL：保存模式参数。
        0x80,0xe3,0x7f,      // AND BL,7Fh：bit7 是保留显存标志，不属于模式编号。
        0xd1,0xe3,           // SHL BX,1：每个模式表指针占 2 字节。
        0x8b,0xb7,0x00,0x20, // MOV SI,[BX+2000h]：取模式端口序列地址。
        0xad,0x91,           // LODSW / XCHG AX,CX：配置条目数放入 CX。
        0xba,0xda,0x03,0xec, // MOV DX,03DAh / IN AL,DX：复位属性控制器索引/数据触发器。
        0xad,0x92,           // LODSW / XCHG AX,DX：读取本条 16 位端口号。
        0xac,0xee,           // LODSB / OUT DX,AL：读取并写入本条 8 位寄存器值。
        0xe2,0xfa,           // LOOP 0028h：遍历三字节端口/数值条目。

        0x89,0xe3,           // MOV BX,SP：定位保存的 AX（相对栈顶 +0Eh）。
        0x36,0x8b,0x47,0x0e, // MOV AX,SS:[BX+0Eh]：恢复原始模式/保留显存参数。
        0x88,0xc3,           // MOV BL,AL：保留 bit7 以便后续判断。
        0x24,0x7f,           // AND AL,7Fh：提取模式号。
        0x3c,0x0d,0x72,0x11, // CMP AL,0Dh / JB 004Dh：文本模式进入字体上传流程。
        0xf6,0xc3,0x80,      // TEST BL,80h：图形模式是否要求保留显存。
        0x75,0x71,           // JNE 00B2h：保留时跳过清屏。
        0xb8,0x00,0xa0,      // MOV AX,0A000h：图形显存段。
        0x8e,0xc0,           // MOV ES,AX。
        0x31,0xc0,           // XOR AX,AX：图形清屏填充值为零。
        0xb9,0x00,0x80,      // MOV CX,8000h：清除 32768 个字。
        0xeb,0x61,           // JMP 00AEh：共用 REP STOSW 清屏。

        0xba,0xc4,0x03,      // MOV DX,03C4h：Sequencer 索引/数据端口。
        0xb8,0x02,0x04,0xef, // MOV AX,0402h / OUT DX,AX：Map Mask=04h，选择字体平面 2。
        0xb8,0x04,0x06,0xef, // MOV AX,0604h / OUT DX,AX：临时关闭奇偶寻址。
        0xba,0xce,0x03,      // MOV DX,03CEh：Graphics Controller 索引/数据端口。
        0xb8,0x05,0x00,0xef, // MOV AX,0005h / OUT DX,AX：字体写入采用直接模式。
        0xb8,0x06,0x04,0xef, // MOV AX,0406h / OUT DX,AX：映射 A000h 字体窗口。
        0xb8,0x04,0x02,0xef, // MOV AX,0204h / OUT DX,AX：Read Map Select=2。
        0xb8,0x00,0xa0,      // MOV AX,0A000h。
        0x8e,0xc0,           // MOV ES,AX：字体目标段。
        0xbe,0x00,0x80,      // MOV SI,8000h：ROM 中的 8×16 字体。
        0x31,0xff,           // XOR DI,DI：字体平面起点。
        0xbb,0x00,0x01,      // MOV BX,0100h：256 个字符。
        0xb9,0x10,0x00,      // MOV CX,0010h：每个字符复制 16 行。
        0xf3,0xa4,           // REP MOVSB：复制当前字符点阵。
        0x83,0xc7,0x10,      // ADD DI,10h：每字符槽 32 字节，跳过未使用的后 16 字节。
        0x4b,0x75,0xf5,      // DEC BX / JNE 0074h：继续下一个字符。
        0xba,0xc4,0x03,      // MOV DX,03C4h：恢复文本 Sequencer。
        0xb8,0x02,0x03,0xef, // MOV AX,0302h / OUT DX,AX：允许字符/属性平面 0、1。
        0xb8,0x04,0x02,0xef, // MOV AX,0204h / OUT DX,AX：恢复奇偶寻址。
        0xba,0xce,0x03,      // MOV DX,03CEh：恢复文本 GC。
        0xb8,0x04,0x00,0xef, // MOV AX,0004h / OUT DX,AX：Read Map Select=0。
        0xb8,0x05,0x10,0xef, // MOV AX,1005h / OUT DX,AX：文本奇偶读取模式。
        0xb8,0x06,0x0e,0xef, // MOV AX,0E06h / OUT DX,AX：文本显存窗口 B800h。

        0x89,0xe3,           // MOV BX,SP。
        0x36,0x8b,0x47,0x0e, // MOV AX,SS:[BX+0Eh]：再次读取原模式参数。
        0xa8,0x80,0x75,0x0f, // TEST AL,80h / JNE 00B2h：文本保留显存时也跳过清屏。
        0xb8,0x00,0xb8,      // MOV AX,0B800h。
        0x8e,0xc0,           // MOV ES,AX：文本显存段。
        0xb8,0x20,0x07,      // MOV AX,0720h：空格字符 20h、灰字黑底属性 07h。
        0xb9,0x00,0x40,      // MOV CX,4000h：填充文本显存。
        0x31,0xff,           // XOR DI,DI：共用清屏入口。
        0xf3,0xab,           // REP STOSW：写入 CX 个 AX。
        0x5f,0x07,0x1f,0x5e, // POP DI/ES/DS/SI：与保存顺序相反。
        0x5a,0x59,0x5b,0x58, // POP DX/CX/BX/AX。
        0xcf                 // IRET：恢复调用者 CS:IP 和 FLAGS。
    };
    std::copy(std::begin(handler), std::end(handler), cpu.mem.begin() + 0xf0900);
    if (cirrus) {
        // 原 0048h 的 MOV CX,8000h / JMP 00AEh 换成 CALL 0B00h / JMP 00B2h，保持其它分支位置不变。
        const uint8_t callClear[] = {0xe8,0xb5,0x01,0xeb,0x65};
        std::copy(std::begin(callClear), std::end(callClear), cpu.mem.begin() + 0xf0948);
        const uint8_t clear[] = {
            0x80,0xfb,0x5c,0x73,0x08, // CMP BL,5Ch / JAE banks：仅扩展模式需要遍历 4 MiB。
            0x31,0xff,0xb9,0,0x80,0xf3,0xab,0xc3, // XOR DI,DI / MOV CX,8000h / REP STOSW / RET。
            0xba,0xce,3,              // MOV DX,03CEh：GC 索引/数据端口。
            0xb8,0x0b,0x20,0xef,      // MOV AX,200Bh / OUT DX,AX：单窗口、16 KiB bank 粒度。
            0xbb,9,0,0xbe,0x40,0,     // MOV BX,0009h / MOV SI,64：从 bank 0 开始清除 64 个 64 KiB 窗口。
            0x89,0xd8,0xef,           // MOV AX,BX / OUT DX,AX：写 GR9 的 bank 编号。
            0x31,0xc0,0x31,0xff,      // XOR AX,AX / XOR DI,DI：每窗口从零地址填零。
            0xb9,0,0x80,0xf3,0xab,    // MOV CX,8000h / REP STOSW：清除当前 64 KiB。
            0x81,0xc3,0,4,0x4e,0x75,0xed, // ADD BX,0400h / DEC SI / JNE loop：bank 每次前进四个 16 KiB。
            0xb8,9,0,0xef,            // MOV AX,0009h / OUT DX,AX：恢复 bank 0。
            0xb8,0x0b,0,0xef,0xc3     // MOV AX,000Bh / OUT DX,AX / RET：恢复普通 4 KiB bank 粒度。
        };
        std::copy(std::begin(clear), std::end(clear), cpu.mem.begin() + 0xf0b00);
    }
    cpu.ww(0, 0x10 * 4, 0x900);
    auto profile = std::make_unique<Vga>();
    if (cirrus) profile->enableCirrus(true);
    uint16_t address = 0x2100;

    // 每个模式存放：条目数 WORD，随后重复 {port WORD,value BYTE}；上面的 LODS/OUT 循环消费它。
    for (uint8_t mode : {0, 1, 2, 3, 0x0d, 0x0e, 0x10, 0x12, 0x13, 0x5f, 0x5c, 0x60}) {
        if (mode > 0x13 && !cirrus) continue;
        if (address < font16Offset && unsigned(address) + 3000 > font16Offset) address = 0xc000;
        profile->setMode(mode);
        cpu.ww(0xf000, uint16_t(0x2000 + mode * 2), address);
        auto start = address; address += 2;
        auto port = [&](uint16_t number, uint8_t value) {
            cpu.ww(0xf000, address, number); cpu.wb(0xf000, uint16_t(address + 2), value); address += 3;
        };
        auto indexed = [&](uint16_t number, uint8_t index, uint8_t value) {
            port(number, index); port(number + 1, value);
        };
        indexed(0x3c4, 0, 1);
        port(0x3c2, profile->input(0x3cc));
        for (uint8_t i = 1; i < 5; ++i) indexed(0x3c4, i, profile->seq[i]);
        if (cirrus) {
            indexed(0x3c4, 6, 0x12); indexed(0x3c4, 7, profile->seq[7]);
            indexed(0x3c4, 0x12, 0); indexed(0x3c4, 0x17, 0);
        }
        indexed(0x3c4, 0, profile->seq[0]);
        indexed(0x3d4, 0x11, profile->crtc[0x11] & 0x7f);
        for (uint8_t i = 0; i < 25; ++i) indexed(0x3d4, i, profile->crtc[i]);
        if (cirrus) { indexed(0x3d4, 0x1b, profile->crtc[0x1b]); indexed(0x3d4, 0x1d, 0); }
        for (uint8_t i = 0; i < 9; ++i) indexed(0x3ce, i, profile->gc[i]);
        if (cirrus) { indexed(0x3ce, 9, 0); indexed(0x3ce, 10, 0); indexed(0x3ce, 11, 0); }
        for (uint8_t i = 0; i < 21; ++i) { port(0x3c0, i); port(0x3c0, profile->attr[i]); }
        port(0x3c0, 0x20); port(0x3c6, 255); port(0x3c8, 0);
        for (auto component : profile->dac) port(0x3c9, component);
        cpu.ww(0xf000, start, uint16_t((address - start - 2) / 3));
        if ((start < font16Offset && address > font16Offset) || address > 0xef00)
            throw std::runtime_error("Video firmware tables overlap reserved BIOS data");
    }
    for (unsigned ch = 0; ch < 256; ++ch)
        for (unsigned row = 0; row < 16; ++row)
            cpu.wb(0xf000, uint16_t(font16Offset + ch * 16 + row), biosFont8x8[ch * 8 + row / 2]);
    for (unsigned ch = 0; ch < 256; ++ch) {
        for (unsigned row = 0; row < 8; ++row)
            cpu.wb(0xf000, uint16_t(font8Offset + ch * 8 + row), biosFont8x8[ch * 8 + row]);
        for (unsigned row = 0; row < 14; ++row)
            cpu.wb(0xf000, uint16_t(font14Offset + ch * 14 + row), biosFont8x8[ch * 8 + row * 8 / 14]);
    }
    cpu.ww(0, 0x43 * 4, font16Offset); cpu.ww(0, 0x43 * 4 + 2, 0xf000);
}

static void diskIo(HANDLE file, uint64_t offset, uint8_t* data, DWORD size, bool writing) {
    LARGE_INTEGER position{}; position.QuadPart = int64_t(offset); DWORD done = 0;
    if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN)) throw osError("Disk seek failed");
    auto ok = writing ? WriteFile(file, data, size, &done, nullptr) : ReadFile(file, data, size, &done, nullptr);
    if (!ok || done != size) throw osError(writing ? "Disk write failed" : "Disk read failed");
}

static uint32_t diskWord(const uint8_t* p) {
    return p[0] | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

static void diskWord(uint8_t* p, uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) p[i] = uint8_t(value >> (i * 8));
}

static uint32_t diskCrc(const uint8_t* data, unsigned size) {
    // IEEE CRC32 的反射多项式；记录校验覆盖 LBA 和 512 字节数据，不包含尾部 CRC 自身。
    uint32_t value = 0xffffffffu;
    for (unsigned i = 0; i < size; ++i) {
        value ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit) value = (value >> 1) ^ (0xedb88320u & (0u - (value & 1)));
    }
    return ~value;
}

static std::array<uint8_t, 32> diskHash(HANDLE file, uint64_t size) {
    HCRYPTPROV provider = 0; HCRYPTHASH hash = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT))
        throw osError("Cannot initialize disk SHA256");
    std::array<uint8_t, 32> result{};
    try {
        if (!CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) throw osError("Cannot create disk SHA256");
        std::vector<uint8_t> buffer(1024 * 1024);
        for (uint64_t offset = 0; offset < size;) {
            auto count = DWORD(std::min<uint64_t>(buffer.size(), size - offset));
            diskIo(file, offset, buffer.data(), count, false);
            if (!CryptHashData(hash, buffer.data(), count, 0)) throw osError("Cannot hash base disk");
            offset += count;
        }
        DWORD count = DWORD(result.size());
        if (!CryptGetHashParam(hash, HP_HASHVAL, result.data(), &count, 0) || count != result.size())
            throw osError("Cannot finish disk SHA256");
    } catch (...) {
        if (hash) CryptDestroyHash(hash);
        CryptReleaseContext(provider, 0); throw;
    }
    CryptDestroyHash(hash); CryptReleaseContext(provider, 0); return result;
}

Disk::Disk(const std::filesystem::path& p, bool floppy, bool ro, const std::filesystem::path& overlay)
    : readOnly(ro), path(p), identity(++nextDiskIdentity), differential(overlay) {
    if (!overlay.empty() && (floppy || ro)) throw std::runtime_error("Overlays require a writable guest hard disk");

    // 差分模式对客体可写，对宿主底盘却只读；共享标志还阻止其他可写句柄破坏底盘。
    file = CreateFileW(p.c_str(), GENERIC_READ | (ro || !overlay.empty() ? 0 : GENERIC_WRITE), FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw osError("Cannot open disk image");
    try {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size)) throw osError("Cannot size disk image");
    if (size.QuadPart <= 0 || size.QuadPart % 512 || uint64_t(size.QuadPart) > MaxHardBytes) {
        throw std::runtime_error("Disk image must contain whole 512-byte sectors and be at most 32 GiB");
    }
    sectors = uint32_t(size.QuadPart / 512);
    if (floppy) {
        sectors = floppyPayloadSectors(file, sectors);
        switch (sectors) {
        case 320: heads = 1; spt = 8; floppyType = 1; break;
        case 360: heads = 1; spt = 9; floppyType = 1; break;
        case 640: heads = 2; spt = 8; floppyType = 1; break;
        case 720: heads = 2; spt = 9; floppyType = 1; break;
        case 1440: heads = 2; spt = 9; floppyType = 3; break;
        case 2400: heads = 2; spt = 15; floppyType = 2; break;
        case 2880: heads = 2; spt = 18; floppyType = 4; break;
        default: throw std::runtime_error("Unsupported floppy geometry");
        }
    } else { heads = 16; spt = 63; }
    cylinders = int(sectors / unsigned(heads * spt));
    if (!floppy && (cylinders < 1 || (size.QuadPart <= 504LL * 1024 * 1024 && sectors % unsigned(heads * spt)))) {
        throw std::runtime_error("Hard disk images up to 504 MiB require complete 16-head/63-sector cylinders");
    }
    if (!floppy) cylinders = std::min(cylinders, 16383);
    if (!overlay.empty()) openOverlay();
    } catch (...) {
        if (overlayFile != INVALID_HANDLE_VALUE) CloseHandle(overlayFile);
        CloseHandle(file); throw;
    }
}

void Disk::openOverlay() {
    // 64 字节头：magic[8]、version[4]、sectors[4]、base SHA256[32]、保留[16]。
    // 后续每条 520 字节：LBA[4]、data[512]、CRC32[4]；同 LBA 最后一条覆盖旧记录。
    std::array<uint8_t, 64> expected{};
    const char magic[] = "ASM86COW";
    std::copy(magic, magic + 8, expected.begin());
    diskWord(expected.data() + 8, 1); diskWord(expected.data() + 12, sectors);
    auto hash = diskHash(file, uint64_t(sectors) * 512);
    std::copy(hash.begin(), hash.end(), expected.begin() + 16);
    overlayFile = CreateFileW(differential.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (overlayFile == INVALID_HANDLE_VALUE) throw osError("Cannot open disk overlay");
    bool existing = GetLastError() == ERROR_ALREADY_EXISTS;
    if (!existing) {
        diskIo(overlayFile, 0, expected.data(), DWORD(expected.size()), true);
        if (!FlushFileBuffers(overlayFile)) throw osError("Cannot flush overlay header");
        return;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(overlayFile, &size)) throw osError("Cannot size disk overlay");
    if (size.QuadPart < 64 || (size.QuadPart - 64) % 520)
        throw std::runtime_error("Truncated disk overlay; preserve it for recovery or discard it manually. Base disk unchanged");
    std::array<uint8_t, 64> header{};
    diskIo(overlayFile, 0, header.data(), DWORD(header.size()), false);
    if (header != expected) throw std::runtime_error("Invalid overlay header or base disk SHA256 mismatch; base disk unchanged");
    std::array<uint8_t, 520> record{};
    for (uint64_t offset = 64; offset < uint64_t(size.QuadPart); offset += record.size()) {
        diskIo(overlayFile, offset, record.data(), DWORD(record.size()), false);
        auto lba = diskWord(record.data());
        if (lba >= sectors || diskWord(record.data() + 516) != diskCrc(record.data(), 516))
            throw std::runtime_error("Corrupt disk overlay record; base disk unchanged");
        overlayIndex[lba] = offset + 4;
    }
    overlayEnd = uint64_t(size.QuadPart);
}

void Disk::discardOverlay() {
    if (!hasOverlay()) throw std::runtime_error("No disk overlay is attached");
    LARGE_INTEGER end{}; end.QuadPart = 64;
    if (!SetFilePointerEx(overlayFile, end, nullptr, FILE_BEGIN) || !SetEndOfFile(overlayFile))
        throw osError("Cannot discard overlay writes");
    overlayIndex.clear(); overlayEnd = 64; changed = true; flush();
}

Disk::~Disk() {
    if (overlayFile != INVALID_HANDLE_VALUE) CloseHandle(overlayFile);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
}

void Disk::create(const std::filesystem::path& p, unsigned cylinders) {
    if (cylinders < 1 || cylinders > 1024) throw std::runtime_error("Hard disk creation requires 1..1024 cylinders");
    createBytes(p, uint64_t(cylinders) * 16 * 63 * 512);
}

void Disk::createBytes(const std::filesystem::path& p, uint64_t bytes) {
    // CREATE_NEW 保证不覆盖；大盘只建立稀疏文件长度，空洞读取为零，不分配整盘内存。
    if (bytes < 16 * 63 * 512 || bytes > MaxHardBytes || bytes % 512 ||
        (bytes <= 504ULL * 1024 * 1024 && bytes % (16 * 63 * 512)))
        throw std::runtime_error("Invalid raw hard disk size (maximum 32 GiB; small disks require complete cylinders)");
    auto h = CreateFileW(p.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) throw osError("Cannot create new hard disk image (existing files are never overwritten)");
    if (bytes > 504ULL * 1024 * 1024) {
        DWORD returned = 0;
        if (!DeviceIoControl(h, FSCTL_SET_SPARSE, nullptr, 0, nullptr, 0, &returned, nullptr)) {
            auto e = osError("Large disk creation requires a filesystem supporting sparse files"); CloseHandle(h); throw e;
        }
    }
    LARGE_INTEGER size{}; size.QuadPart = int64_t(bytes);
    if (!SetFilePointerEx(h, size, nullptr, FILE_BEGIN) || !SetEndOfFile(h) || !FlushFileBuffers(h)) {
        auto e = osError("Cannot allocate hard disk image"); CloseHandle(h); throw e;
    }
    CloseHandle(h);
}

int Disk::biosHeads() const {
    // 传统 INT 13h 只有 10 位柱面，通过增加逻辑磁头数覆盖较大范围；更高地址走 EDD/LBA。
    int result = heads;
    if (heads == 16) {
        while (result < 128 && sectors / unsigned(result * spt) > 1024) result *= 2;
        if (sectors / unsigned(result * spt) > 1024) result = 255;
    }
    return result;
}

int Disk::biosCylinders() const { return std::min(1024, int(sectors / unsigned(biosHeads() * spt))); }

bool Disk::transfer(uint32_t lba, uint8_t* data, bool writing) {
    // ATA 与 BIOS 共用此扇区入口；差分读先查最新记录，未命中才读底盘。
    if (lba >= sectors || (writing && readOnly)) return false;
    if (hasOverlay()) {
        if (writing) {
            std::array<uint8_t, 520> record{};
            diskWord(record.data(), lba); std::copy(data, data + 512, record.begin() + 4);
            diskWord(record.data() + 516, diskCrc(record.data(), 516));
            diskIo(overlayFile, overlayEnd, record.data(), DWORD(record.size()), true);
            overlayIndex[lba] = overlayEnd + 4; overlayEnd += record.size();
            return true;
        }
        auto found = overlayIndex.find(lba);
        if (found != overlayIndex.end()) {
            diskIo(overlayFile, found->second, data, 512, false); return true;
        }
    }
    diskIo(file, uint64_t(lba) * 512, data, 512, writing);
    return true;
}

bool Disk::read(uint32_t lba, uint8_t* p) {
    if (!transfer(lba, p, false)) return false;
    ++readSectors; return true;
}

bool Disk::write(uint32_t lba, const uint8_t* p) {
    if (!transfer(lba, const_cast<uint8_t*>(p), true)) return false;
    ++writtenSectors; return true;
}

void Disk::flush() {
    if (!readOnly && !FlushFileBuffers(hasOverlay() ? overlayFile : file)) throw osError("Disk flush failed");
}

Pc::Pc() {
    fdc.disk = [this]() { return floppy.get(); };
    fdc.interrupt = [this](bool raised) {
        if (raised) pic[0].raise(6);
        else pic[0].pending &= uint8_t(~0x40);
    };
    fdc.dma = [this](uint8_t* data, unsigned length, DmaDirection direction) { return dma.transfer(2, data, length, direction); };
    dma.read = [this](uint32_t address) { return cpu.readBus(address & (at() ? 0xffffffu : 0xfffffu)); };
    dma.write = [this](uint32_t address, uint8_t value) { cpu.writeBus(address & (at() ? 0xffffffu : 0xfffffu), value); };
    cpu.in = [this](uint16_t p) { return input(p); };
    cpu.out = [this](uint16_t p, uint8_t v) { output(p, v); };
    cpu.inWide = [this](uint16_t port, unsigned size) {
        uint32_t value = 0;
        if (at() && (port == 0x1f0 || port == 0x170))
            for (unsigned i = 0; i < size; i += 2) value |= uint32_t(port == 0x1f0 ? ide.readWord(clock) : cdrom.readWord(clock)) << (i * 8);
        else for (unsigned i = 0; i < size; ++i) value |= uint32_t(cpu.in(uint16_t(port + i))) << (i * 8);
        return value;
    };
    cpu.outWide = [this](uint16_t port, uint32_t value, unsigned size) {
        if (at() && (port == 0x1f0 || port == 0x170))
            for (unsigned i = 0; i < size; i += 2) {
                if (port == 0x1f0) ide.writeWord(uint16_t(value >> (i * 8)), clock);
                else cdrom.writeWord(uint16_t(value >> (i * 8)), clock);
            }
        else for (unsigned i = 0; i < size; ++i) cpu.out(uint16_t(port + i), uint8_t(value >> (i * 8)));
    };
    cpu.irq = [this]() { return acknowledge(); };
    cpu.trap = [this](uint8_t n) { return bios(n); };
    cpu.mmioStart = 0xa0000; cpu.mmioEnd = 0xc0000;
    cpu.mmioRead = [this](uint32_t a) {
        if (vga.cirrus() && (pciCommand & 2)) {
            if ((pciRomAddress & 1) && uint64_t(a) >= (pciRomAddress & ~1u) &&
                uint64_t(a) < uint64_t(pciRomAddress & ~1u) + PciRomBytes) {
                auto offset = a - (pciRomAddress & ~1u);
                return offset < pciRom.size() ? pciRom[offset] : uint8_t(255);
            }
            if (!(pciRomAddress & 1) && uint64_t(a) >= pciFramebuffer && uint64_t(a) < uint64_t(pciFramebuffer) + 0x2000000) return vga.linearRead(a - pciFramebuffer);
            if (uint64_t(a) >= pciRegisters && uint64_t(a) < uint64_t(pciRegisters) + 4096) {
                unsigned off = a - pciRegisters;
                if (off < 32) {
                    auto port = uint16_t(0x3c0 + off);
                    if ((off == 0x14 || off == 0x15 || off == 0x1a) && !(vga.input(0x3cc) & 1)) port -= 0x20;
                    auto value = vga.input(port);
                    return off == 0x1a ? uint8_t((uint64_t(clock) / 64) & 1 ? 9 : 0) : value;
                }
                return off >= 256 && off < 512 ? vga.registerRead(off - 256) : uint8_t(255);
            }
        }
        return vga.cirrus() && (!(pciCommand & 2) || (pciRomAddress & 1)) ? uint8_t(255) : vga.read(a);
    };
    cpu.mmioWrite = [this](uint32_t a, uint8_t v) {
        if (vga.cirrus() && (pciCommand & 2)) {
            if ((pciRomAddress & 1) && uint64_t(a) >= (pciRomAddress & ~1u) &&
                uint64_t(a) < uint64_t(pciRomAddress & ~1u) + PciRomBytes) return;
            if (!(pciRomAddress & 1) && uint64_t(a) >= pciFramebuffer && uint64_t(a) < uint64_t(pciFramebuffer) + 0x2000000) { vga.linearWrite(a - pciFramebuffer, v); return; }
            if (uint64_t(a) >= pciRegisters && uint64_t(a) < uint64_t(pciRegisters) + 4096) {
                unsigned off = a - pciRegisters;
                if (off < 32) {
                    auto port = uint16_t(0x3c0 + off);
                    if ((off == 0x14 || off == 0x15 || off == 0x1a) && !(vga.input(0x3cc) & 1)) port -= 0x20;
                    vga.output(port, v);
                }
                else if (off >= 256 && off < 512) vga.registerWrite(off - 256, v);
                return;
            }
        }
        if (!vga.cirrus() || ((pciCommand & 2) && !(pciRomAddress & 1))) vga.write(a, v);
    };
    serialMouse.setIrq = [this](bool raised) { if (raised) pic[0].raise(4); };
    ide.disk = [this]() { return hard.get(); };
    ide.interrupt = [this](bool raised) {
        if (raised) pic[1].raise(6);
        else pic[1].pending &= uint8_t(~0x40);
    };
    cdrom.interrupt = [this](bool raised) {
        if (raised) pic[1].raise(7);
        else pic[1].pending &= uint8_t(~0x80);
    };
    cpu.resetSignal = [this] { pendingReset = true; };
    cpu.fpuIrq = [this](bool raised) {
        if (raised) pic[1].raise(5);
        else pic[1].pending &= uint8_t(~0x20);
    };
}

void Pc::setModel(CpuModel model) { cpu.setModel(model); keys.clear(); resetAt(); }

void Pc::setCirrus(bool enabled) {
    vga.enableCirrus(enabled); pciAddress = 0; pciCommand = 3;
    pciFramebuffer = 0xe0000000; pciRegisters = 0xe2000000; pciRomAddress = 0xc0000;
    if (!enabled) pciRom.clear();
    mapPci();
}

void Pc::mapPci() {
    cpu.pciWindows = {};
    if (vga.cirrus() && (pciCommand & 2)) {
        if (!(pciRomAddress & 1)) cpu.pciWindows[0] = {pciFramebuffer, uint64_t(pciFramebuffer) + 0x2000000};
        cpu.pciWindows[1] = {pciRegisters, uint64_t(pciRegisters) + 4096};
        if (pciRomAddress & 1) cpu.pciWindows[2] = {pciRomAddress & ~1u, uint64_t(pciRomAddress & ~1u) + PciRomBytes};
    }
}

void Pc::installCirrusRom() {
    // C000 的 PCIR 标识与 INT 10h 入口把启动 VGA 关联到 PCI 显卡，而不是另一个 ISA VGA 设备。
    pciRom.assign(PciRomBytes, 0xff);
    pciRom[0] = 0x55; pciRom[1] = 0xaa; pciRom[2] = uint8_t(PciRomBytes / 512);
    pciRom[3] = 0xeb; pciRom[4] = 0x2b; // JMP SHORT 0030h：跳过 ROM 头进入初始化程序。
    pciRom[0x18] = 0; pciRom[0x19] = 1; // PCIR 数据结构位于 ROM 内 0100h。
    pciRom[0x1a] = pciRom[0x1b] = 0; // 不声明尚未实现的 PnP 扩展结构。
    auto offset = cpu.rw(0, 0x40), segment = cpu.rw(0, 0x42);
    const uint8_t forward[] = {
        0x9c, // PUSHF：给原处理器的 IRET 构造内层中断帧。
        0x9a, uint8_t(offset), uint8_t(offset >> 8), uint8_t(segment), uint8_t(segment >> 8), // CALL FAR 原 INT 10h。
        0xcf  // IRET：内层返回 C000 后，恢复原调用者的中断帧；真正入口仍属于 PCI 视频 ROM。
    };
    std::copy(std::begin(forward), std::end(forward), pciRom.begin() + 0x20);
    const uint8_t initialize[] = {
        0x9c, 0x60, 0x06,                // PUSHF / PUSHA / PUSH ES：保存初始化调用者状态。
        0x31,0xc0, 0x8e,0xc0,            // XOR AX,AX / MOV ES,AX：访问实模式 IVT。
        0x26,0xc7,0x06,0x40,0,0x20,0,    // MOV WORD ES:[0040h],0020h：INT 10h 偏移。
        0x26,0xc7,0x06,0x42,0,0,0xc0,    // MOV WORD ES:[0042h],C000h：INT 10h 段地址。
        0xb8,3,0, 0xcd,0x10,             // MOV AX,0003h / INT 10h：用客体 I/O 初始化文本模式。
        0x07,0x61,0x9d,0xcb              // POP ES / POPA / POPF / RETF：返回 BIOS 的远调用。
    };
    std::copy(std::begin(initialize), std::end(initialize), pciRom.begin() + 0x30);
    // PCIR 是数据：签名、vendor/device、结构长度、VGA 类别、映像长度、接口版本和最后映像标志。
    const uint8_t identity[] = {'P','C','I','R',0x13,0x10,0xb8,0,0,0,0x18,0,0,0,0,3,0x40,0,0,1,0,0x80,0,0};
    std::copy(std::begin(identity), std::end(identity), pciRom.begin() + 0x100);
    pciRom[cirrusFixupOffset] = 0xcb; // RETF：固定模式配置不需要参数修正，OEM A0h 的回调直接返回。
    std::fill(pciRom.end() - 4, pciRom.end(), 0); // 与 PCI2C 中未指定的 subsystem ID 一致。
    unsigned sum = 0; for (auto byte : pciRom) sum += byte;
    pciRom[PciRomBytes - 5] = uint8_t(pciRom[PciRomBytes - 5] - sum);
    std::copy(pciRom.begin(), pciRom.end(), cpu.mem.begin() + 0xc0000);
    cpu.ww(0, 0x40, 0x20); cpu.ww(0, 0x42, 0xc000);
}

uint8_t Pc::pciRead(unsigned offset) const {
    uint32_t value = 0;
    switch (offset & ~3u) {
    case 0: value = 0x00b81013; break;
    case 4: value = 0x02000000 | pciCommand; break;
    case 8: value = 0x03000047; break;
    case 12: value = unsigned(pciLatency) << 8; break;
    case 16: value = pciFramebuffer; break;
    case 20: value = pciRegisters; break;
    case 48: value = pciRomAddress; break;
    }
    return uint8_t(value >> ((offset & 3) * 8));
}

void Pc::pciWrite(unsigned offset, uint8_t value) {
    if (offset == 4) pciCommand = value & 0x23;
    else if (offset == 13) pciLatency = value;
    else if ((offset >= 16 && offset < 24) || (offset >= 48 && offset < 52)) {
        auto& bar = offset < 20 ? pciFramebuffer : offset < 24 ? pciRegisters : pciRomAddress;
        unsigned shift = (offset & 3) * 8;
        bar = (bar & ~(255u << shift)) | (uint32_t(value) << shift);
        bar &= offset < 20 ? 0xfe000000 : offset < 24 ? 0xfffff000 : ~(PciRomBytes - 1) | 1u;
    }
    mapPci();
}

bool Pc::pciBios(bool protectedCall) {
    auto& c = cpu; auto& r = c.r;
    auto result = [&](uint8_t error) {
        c.reg8(4, error);
        if (protectedCall) c.setFlags(uint16_t(error ? c.flags | CF : c.flags & ~CF));
        else c.stackedFlag(CF, error != 0);
        return true;
    };
    if (!vga.cirrus()) return result(0x81);
    switch (c.reg8(0)) {
    case 1: c.reg8(0, 1); r[BX] = 0x0210; r[CX] = 0; c.r32(DX, 0x20494350); c.r32(DI, 0xfb040); return result(0);
    case 2: case 3:
        if (r[SI] || (c.reg8(0) == 2 ? r[DX] != 0x1013 || r[CX] != 0x00b8 : (c.r32(CX) & 0xffffff) != 0x030000)) return result(0x86);
        r[BX] = 0x10; return result(0);
    case 8: case 9: case 10: case 11: case 12: case 13: {
        unsigned function = c.reg8(0), size = function == 8 || function == 11 ? 1 : function == 9 || function == 12 ? 2 : 4;
        if (r[BX] != 0x10) return result(0x86);
        if (r[DI] >= 256 || (r[DI] & (size - 1)) || unsigned(r[DI]) + size > 256) return result(0x87);
        uint32_t value = c.r32(CX);
        if (function <= 10) {
            value = 0; for (unsigned i = 0; i < size; ++i) value |= uint32_t(pciRead(r[DI] + i)) << (i * 8);
            if (size == 1) c.reg8(1, uint8_t(value));
            else if (size == 2) r[CX] = uint16_t(value);
            else c.r32(CX, value);
        } else for (unsigned i = 0; i < size; ++i) pciWrite(r[DI] + i, uint8_t(value >> (i * 8)));
        return result(0);
    }
    default: return result(0x81);
    }
}

unsigned Pc::columns() const { return cpu.rw(0x40, 0x4a); }

unsigned Pc::activePage() const { return cpu.rb(0x40, 0x62) & 7; }

unsigned Pc::cursor() const { return cpu.rw(0x40, uint16_t(0x50 + activePage() * 2)); }

unsigned Pc::biosColumns() { return cpu.rwF(0x40, 0x4a); }

unsigned Pc::biosPage() { return cpu.rbF(0x40, 0x62) & 7; }

unsigned Pc::biosCursor() { return cpu.rwF(0x40, uint16_t(0x50 + biosPage() * 2)); }

void Pc::boot(uint8_t drive) {
    // 重建 BIOS ROM/IVT/BDA 与设备复位状态，再将引导扇区载入 0000:7C00。
    Disk* d = drive == 0 ? floppy.get() : drive == 0x80 ? hard.get() : nullptr;
    if (!d) throw std::runtime_error("No image mounted in the selected boot drive");
    std::array<uint8_t, 512> sector{};
    d->read(0, sector.data());
    if (sector[510] != 0x55 || sector[511] != 0xaa) throw std::runtime_error("Boot sector has no 55AA signature");
    cpu.reset(); std::fill(cpu.mem.begin(), cpu.mem.end(), 0);
    vga.setMode(3);
    serialMouse.reset();
    bootDrive = drive; rebootRequested = powerOffRequested = false;
    apmConnected = false; apmEnabled = apmEngaged = true; apmVersion = 0x0100;
    instructions = 0; clock = 0; notice.clear(); keys.clear();
    resetAt();
    reload.fill(0); pitStart.fill(0); access.fill(3); pitMode.fill(3); writeHigh.fill(false); readHigh.fill(false); latched.fill(false);
    port61 = crtcIndex = 0; nextTimer = 65536;
    for (unsigned n = 0; n < 256; ++n) {
        uint16_t off = uint16_t(0x1000 + n * 8);
        cpu.ww(0, uint16_t(n * 4), off); cpu.ww(0, uint16_t(n * 4 + 2), 0xf000);

        // F1 nn / CF：解释器 BIOS_TRAP nn 后 IRET；INT 16h 前加 FB（STI）允许等待键盘时响应 IRQ。
        cpu.wb(0xf000, off, 0xf1); cpu.wb(0xf000, off + 1, uint8_t(n)); cpu.wb(0xf000, off + 2, 0xcf);
        if (n == 0x16) {
            cpu.wb(0xf000, off, 0xfb); cpu.wb(0xf000, off + 1, 0xf1);
            cpu.wb(0xf000, off + 2, uint8_t(n)); cpu.wb(0xf000, off + 3, 0xcf);
        }
    }

    // INT 4Fh 非零会让 Windows 探测驻留 CAM SCSI 提供者，因此明确置空。
    cpu.ww(0, 0x4f * 4, 0); cpu.ww(0, 0x4f * 4 + 2, 0);
    pciAddress = 0; pciCommand = 3; pciFramebuffer = 0xe0000000; pciRegisters = 0xe2000000; pciRomAddress = 0xc0000; mapPci();
    installVideoFirmware(cpu, vga.cirrus());
    if (vga.cirrus()) {
        installCirrusRom();
        // BIOS32 服务目录：_32_、32 位入口物理地址、修订、16 字节长度和校验和。
        const uint8_t directory[] = {'_','3','2','_',0x20,0xb0,0x0f,0,0,1,0,0,0,0,0,0};
        std::copy(std::begin(directory), std::end(directory), cpu.mem.begin() + 0xfb000);
        unsigned sum = 0; for (auto byte : directory) sum += byte;
        cpu.mem[0xfb00a] = uint8_t(-sum);
        // F1 E0 / RETF：查询 BIOS32 的 $PCI 服务；F1 E1 / RETF：保护模式 PCI BIOS。
        cpu.mem[0xfb020] = 0xf1; cpu.mem[0xfb021] = 0xe0; cpu.mem[0xfb022] = 0xcb;
        cpu.mem[0xfb040] = 0xf1; cpu.mem[0xfb041] = 0xe1; cpu.mem[0xfb042] = 0xcb;
    }
    cpu.ww(0, 0x1c * 4, 0x0700); cpu.ww(0, 0x1c * 4 + 2, 0xf000); cpu.wb(0xf000, 0x700, 0xcf);

    // INT 1Ch/68h 都指向 CF（IRET）空处理器；Windows 无调试器时也可能调用 68h。
    cpu.ww(0, 0x68 * 4, 0x0700); cpu.ww(0, 0x68 * 4 + 2, 0xf000);
    const uint8_t timer[] = {
        0x50,            // PUSH AX。
        0xf1,0x08,       // BIOS_TRAP 08h：维护 BIOS 时钟滴答。
        0xcd,0x1c,       // INT 1Ch：调用客体时钟回调。
        0xb0,0x20,       // MOV AL,20h：PIC 非特定 EOI。
        0xe6,0x20,       // OUT 20h,AL：确认 IRQ0。
        0x58,0xcf        // POP AX / IRET。
    };
    std::copy(std::begin(timer), std::end(timer), cpu.mem.begin() + 0xf0800);
    cpu.ww(0, 8 * 4, 0x800);
    const uint8_t keyboard[] = {
        0x50,            // PUSH AX。
        0xe4,0x60,       // IN AL,60h：读取键盘扫描码并确认控制器输出。
        0xf1,0x09,       // BIOS_TRAP 09h：更新 BIOS 键盘缓冲区。
        0xb0,0x20,       // MOV AL,20h。
        0xe6,0x20,       // OUT 20h,AL：确认 IRQ1。
        0x58,0xcf        // POP AX / IRET。
    };
    std::copy(std::begin(keyboard), std::end(keyboard), cpu.mem.begin() + 0xf0820);
    cpu.ww(0, 9 * 4, 0x820);

    // 鼠标驱动恢复 BIOS 向量后可能仍有 COM1 中断；屏蔽 IRQ4 防止无人处理的中断风暴。
    const uint8_t serial[] = {
        0x50,            // PUSH AX。
        0xe4,0x21,       // IN AL,21h：读取主 PIC 屏蔽字。
        0x0c,0x10,       // OR AL,10h：屏蔽 IRQ4。
        0xe6,0x21,       // OUT 21h,AL。
        0xb0,0x20,       // MOV AL,20h。
        0xe6,0x20,       // OUT 20h,AL：发送 EOI。
        0x58,0xcf        // POP AX / IRET。
    };
    std::copy(std::begin(serial), std::end(serial), cpu.mem.begin() + 0xf0840);
    cpu.ww(0, 0x0c * 4, 0x840);

    // 软盘 BIOS 通过真正的客体 OUT 打开电机。Win9x HSFLOP 捕获 DOR 写入以关联 BIOS 盘号和 FDC。
    // 缺少此动作会走无驱动器错误路径，后续空指针写入可破坏 INT 1Ah 向量。
    const uint8_t disk[] = {
        0x80,0xfa,0x01, 0x77,0x1a,        // CMP DL,1 / JA trap：只处理软盘 A/B 的电机。
        0x80,0xfc,0x02, 0x72,0x15,        // CMP AH,2 / JB trap：排除非读写服务。
        0x80,0xfc,0x05, 0x77,0x10,        // CMP AH,5 / JA trap：仅读/写/校验/格式化。
        0x50, 0x52, 0xb0,0x1c,            // PUSH AX / PUSH DX / MOV AL,1Ch：选 A、启动电机 A。
        0x08,0xd2, 0x74,0x02, 0xb0,0x2d,  // OR DL,DL / JZ out / MOV AL,2Dh：非零盘号选 B。
        0xba,0xf2,0x03, 0xee,             // MOV DX,3F2h / OUT DX,AL：写 FDC DOR。
        0x5a, 0x58,                       // POP DX / POP AX：恢复 BIOS 参数。
        0xf1,0x13, 0xcf};                 // BIOS_TRAP 13h / IRET：执行磁盘服务并返回。
    std::copy(std::begin(disk), std::end(disk), cpu.mem.begin() + 0xf0860);
    cpu.ww(0, 0x13 * 4, 0x860);
    if (at()) installDiskFirmware(cpu);
    cpu.ww(0x40, 0, 0x3f8); cpu.wb(0x40, 0x7c, 1);
    cpu.ww(0x40, 0x10, uint16_t(0x221 | (floppy ? 1 : 0) | (cpu.hasFpu() ? 2 : 0)));
    cpu.ww(0x40, 0x13, 640); cpu.ww(0x40, 0x1a, 0x1e); cpu.ww(0x40, 0x1c, 0x1e);
    cpu.ww(0x40, 0x80, 0x1e); cpu.ww(0x40, 0x82, 0x3e);
    cpu.wb(0x40, 0x49, 3); cpu.ww(0x40, 0x4a, 80); cpu.ww(0x40, 0x4c, 4096);
    cpu.ww(0x40, 0x60, 0x0607); cpu.ww(0x40, 0x63, 0x3d4);
    cpu.wb(0x40, 0x75, hard ? 1 : 0); cpu.wb(0x40, 0x84, 24); cpu.ww(0x40, 0x85, 16);
    auto now = std::time(nullptr); std::tm local{}; localtime_s(&local, &now);
    auto ticks = uint32_t((local.tm_hour * 3600 + local.tm_min * 60 + local.tm_sec) * (1193182.0 / 65536));
    cpu.ww(0x40, 0x6c, uint16_t(ticks)); cpu.ww(0x40, 0x6e, uint16_t(ticks >> 16));

    // DPT 是数据，不是机器码：步进/卸载、加载、停转等待、N=2（512 字节）、每道扇区数、
    // 读写 gap、DTL、格式化 gap、填充值 F6h、磁头稳定等待、电机启动等待。
    const uint8_t dpt[] = {0xdf, 2, 0x25, 2, 18, 0x1b, 0xff, 0x6c, 0xf6, 15, 8};
    std::copy(std::begin(dpt), std::end(dpt), cpu.mem.begin() + 0xfefc7);
    cpu.ww(0, 0x1e * 4, 0xefc7); cpu.ww(0, 0x1e * 4 + 2, 0xf000);
    if (hard) {
        cpu.ww(0, 0x41 * 4, 0xe401); cpu.ww(0, 0x41 * 4 + 2, 0xf000);
        cpu.ww(0xf000, 0xe401, uint16_t(hard->biosCylinders())); cpu.wb(0xf000, 0xe403, uint8_t(hard->biosHeads()));
        cpu.wb(0xf000, 0xe40f, uint8_t(hard->spt));
    }
    const char date[] = "11/08/82";
    std::copy(date, date + 8, cpu.mem.begin() + 0xffff5);
    cpu.mem[0xffffe] = at() ? 0xfc : 0xfe;
    const uint8_t reset[] = {0xea, 0x00, 0x06, 0x00, 0xf0}; // JMP FAR F000:0600（EA、offset16、segment16）。
    std::copy(std::begin(reset), std::end(reset), cpu.mem.begin() + 0xffff0);
    cpu.wb(0xf000, 0x600, 0xf1); cpu.wb(0xf000, 0x601, 0x19); // BIOS_TRAP 19h：重新引导。
    for (unsigned i = 0; i < 0x4000; i += 2) cpu.ww(0xb800, uint16_t(i), 0x0720);
    std::copy(sector.begin(), sector.end(), cpu.mem.begin() + 0x7c00);
    if (at()) std::copy(cpu.mem.begin() + 0xf0000, cpu.mem.begin() + 0x100000, cpu.mem.begin() + 0xff0000);
    for (auto seg : {ES, CS, SS, DS}) cpu.loadSegment(seg, 0);
    cpu.ip = 0x7c00; cpu.r[SP] = 0x7c00;
    cpu.r[DX] = drive; cpu.setFlags(0x0202);
}

void Pc::run(unsigned budget, double untilClock) {
    // 兼容脚本的步数驱动：运行一步推进 3.6 个 PIT tick，闲置轮询推进 256 tick 以等待设备唤醒。
    for (unsigned i = 0; i < budget && !rebootRequested && !powerOffRequested && clock < untilClock; ++i) {
        stepCpu();
        advanceClock(clock + ((cpu.halted || cpu.waiting) ? 256.0 : 3.6));
    }
}

void Pc::stepCpu() {
    cpu.step(); ++instructions;
    if (pendingReset) resetCpu();
}

void Pc::runCpu(unsigned budget) {
    // 实时前端单独推进设备时钟；此入口只跑 CPU，遇 HLT/BIOS 等待立即让出而不自行快进时间。
    for (unsigned i = 0; i < budget && !rebootRequested && !powerOffRequested; ++i) {
        stepCpu();
        if (cpu.halted || cpu.waiting) break;
    }
}

void Pc::advanceClock(double target) {
    // 全部设备共用单调 PIT 时钟；到期事件集中推进，无需每种设备启动宿主线程。
    if (!std::isfinite(target) || target < clock) throw std::runtime_error("Invalid device clock target");
    clock = target;
    if (clock >= serialMouse.nextEvent) serialMouse.advance(clock);
    if (clock >= nextTimer) {
        double period = reload[0] ? reload[0] : 65536;
        if (pitMode[0] == 0) nextTimer = 1e100;
        else nextTimer += period * (1 + std::floor((clock - nextTimer) / period));
        pic[0].raise(0);
    }
    if (clock >= nextRtc) rtcAdvance();
    if (at() && clock >= ide.nextEvent) ide.advance(clock);
    if (at() && clock >= cdrom.nextEvent) cdrom.advance(clock);
    if (clock >= fdc.nextEvent) fdc.advance(clock);
}

int Pc::acknowledge() {
    // AT 从片 PIC 通过主片 IRQ2 级联；CPU 收到的是最终向量，不是 IRQ 线号。
    if (at() && pic[1].next() >= 0) pic[0].raise(2);
    int line = pic[0].take();
    if (line < 0) return -1;
    if (line == 1) keyboardRead = false;
    if (at() && line == 2) {
        int slave = pic[1].take();
        return pic[1].base + (slave < 0 ? 7 : slave);
    }
    return pic[0].base + line;
}

uint16_t Pc::pitCounter(unsigned channel) const {
    auto period = reload[channel] ? unsigned(reload[channel]) : 65536u;
    // 读值与 IRQ 必须共用装载时刻，否则 Windows 高精度计时会在回绕附近倒退或停顿。
    return uint16_t(period - uint64_t(clock - pitStart[channel]) % period);
}

uint8_t Pc::input(uint16_t p) {
    if (vga.cirrus() && p >= 0xcf8 && p <= 0xcfb) return uint8_t(pciAddress >> ((p - 0xcf8) * 8));
    if (vga.cirrus() && p >= 0xcfc && p <= 0xcff)
        return (pciAddress & 0x80ffff00) == 0x80001000 ? pciRead((pciAddress & 0xfc) + p - 0xcfc) : 255;
    if (vga.cirrus() && !(pciCommand & 1) && p >= 0x3b0 && p <= 0x3df) return 255;
    if (FloppyController::owns(p)) return fdc.input(p, clock);
    if ((at() || p < 0xc0) && DmaController::owns(p)) return dma.input(p);
    if (at() && IdeChannel::owns(p)) return ide.input(p, clock);
    if (at() && AtapiCdrom::owns(p)) return cdrom.input(p, clock);
    if (p >= 0x3f8 && p <= 0x3ff) return serialMouse.input(p - 0x3f8, clock);
    if (p == 0x20 || (at() && p == 0xa0)) return pic[p == 0x20 ? 0 : 1].command();
    if (p == 0x21 || (at() && p == 0xa1)) return pic[p == 0x21 ? 0 : 1].mask;
    if (at() && p == 0x70) return cmosIndex;
    if (at() && p == 0x71) return cmosRead();
    if (at() && p == 0x92) return fastA20;
    if (p >= 0x40 && p <= 0x42) {
        unsigned ch = p - 0x40;
        uint16_t value = latched[ch] ? latch[ch] : pitCounter(ch);
        uint8_t result = uint8_t(value >> ((access[ch] == 2 || (access[ch] == 3 && readHigh[ch])) ? 8 : 0));
        if (access[ch] == 3) { readHigh[ch] = !readHigh[ch]; if (!readHigh[ch]) latched[ch] = false; }
        else latched[ch] = false;
        return result;
    }
    if (p == 0x60) {
        if (at() && !controller.empty()) { auto value = controller.front(); controller.pop_front(); keyboardIrq(); return value; }
        if (keys.empty() || (keyboardRead && (pic[0].service & 2))) return uint8_t(keyboardLatch >> 8);
        keyboardLatch = keys.front(); keys.pop_front(); keyboardRead = true;
        keyboardIrq();
        return uint8_t(keyboardLatch >> 8);
    }
    if (p == 0x61) return uint8_t((port61 & 0xcf) | ((uint64_t(clock / 18) & 1) << 4) | 0x20);
    if (p == 0x64) return uint8_t((at() ? kbdCommand & 4 : 0) | ((!keys.empty() || !controller.empty()) ? 1 : 0));
    if (p == 0x3da || p == 0x3ba) { vga.input(p); return (uint64_t(clock) / 64) & 1 ? 9 : 0; }
    if ((p >= 0x3c0 && p <= 0x3cf) || p == 0x3d4 || p == 0x3b4) return vga.input(p);
    if (p == 0x3d5 || p == 0x3b5) {
        if (vga.graphics()) return vga.input(p);
        auto pos = cursor(); unsigned cell = (pos >> 8) * columns() + (pos & 255) + activePage() * 2048;
        return crtcIndex == 14 ? uint8_t(cell >> 8) : crtcIndex == 15 ? uint8_t(cell) : vga.input(p);
    }
    if (p == 0x201) return 255;
    return 255; // 未安装设备的 ISA 端口读为全 1。
}

void Pc::output(uint16_t p, uint8_t v) {
    if (vga.cirrus() && p >= 0xcf8 && p <= 0xcfb) {
        unsigned shift = (p - 0xcf8) * 8; pciAddress = (pciAddress & ~(255u << shift)) | (uint32_t(v) << shift); return;
    }
    if (vga.cirrus() && p >= 0xcfc && p <= 0xcff) {
        if ((pciAddress & 0x80ffff00) == 0x80001000) pciWrite((pciAddress & 0xfc) + p - 0xcfc, v);
        return;
    }
    if (vga.cirrus() && !(pciCommand & 1) && p >= 0x3b0 && p <= 0x3df) return;
    if (FloppyController::owns(p)) { fdc.output(p, v, clock); return; }
    if ((at() || p < 0xc0) && DmaController::owns(p)) { dma.output(p, v); return; }
    if (at() && IdeChannel::owns(p)) { ide.output(p, v, clock); return; }
    if (at() && AtapiCdrom::owns(p)) { cdrom.output(p, v, clock); return; }
    if (p >= 0x3f8 && p <= 0x3ff) { serialMouse.output(p - 0x3f8, v, clock); return; }
    if (vga.output(p, v) && p != 0x3d4 && p != 0x3b4 && p != 0x3d5 && p != 0x3b5) return;
    if (p == 0x20 || (at() && p == 0xa0)) { pic[p == 0x20 ? 0 : 1].command(v); }
    else if (p == 0x21 || (at() && p == 0xa1)) { pic[p == 0x21 ? 0 : 1].data(v); }
    else if (at() && p == 0x64) keyboardCommand(v);
    else if (at() && p == 0x60) keyboardData(v);
    else if (at() && p == 0x70) cmosIndex = v & 127;
    else if (at() && p == 0x71) cmosWrite(v);
    else if (at() && p == 0xf0) cpu.clearFpuIrq();
    else if (at() && p == 0xf1) { cpu.clearFpuIrq(); cpu.fpu.init(); }
    else if (at() && p == 0x92) {
        if ((v & 1) && !(fastA20 & 1)) pendingReset = true;
        fastA20 = v; cpu.a20 = v & 2; kbdOutput = uint8_t((kbdOutput & ~2) | (v & 2));
    }
    else if (p == 0x43) {
        unsigned ch = v >> 6; if (ch == 3) return;
        unsigned mode = (v >> 4) & 3;
        if (!mode) {
            latch[ch] = pitCounter(ch);
            latched[ch] = true; readHigh[ch] = false;
        } else { access[ch] = uint8_t(mode); pitMode[ch] = (v >> 1) & 7; writeHigh[ch] = readHigh[ch] = false; }
    } else if (p >= 0x40 && p <= 0x42) {
        unsigned ch = p - 0x40;
        if (access[ch] == 2) reload[ch] = uint16_t(v) << 8;
        else if (access[ch] == 1) reload[ch] = v;
        else {
            reload[ch] = writeHigh[ch] ? uint16_t((reload[ch] & 255) | (uint16_t(v) << 8)) : uint16_t((reload[ch] & 0xff00) | v);
            writeHigh[ch] = !writeHigh[ch];
        }
        if (access[ch] != 3 || !writeHigh[ch]) {
            pitStart[ch] = clock;
            if (ch == 0) nextTimer = clock + (reload[ch] ? reload[ch] : 65536);
        }
    } else if (p == 0x61) port61 = v;
    else if (p == 0x3d4 || p == 0x3b4) crtcIndex = v;
    else if (p == 0x3d5 || p == 0x3b5) {
        if (vga.graphics()) return;
        if (crtcIndex == 14 || crtcIndex == 15) {
            auto pos = cursor(); unsigned cell = (pos >> 8) * columns() + (pos & 255) + activePage() * 2048;
            cell = crtcIndex == 14 ? (cell & 255) | (unsigned(v) << 8) : (cell & 0xff00) | v;
            cell -= activePage() * 2048; auto cols = std::max(1u, columns());
            cpu.ww(0x40, uint16_t(0x50 + activePage() * 2), uint16_t(((cell / cols) << 8) | (cell % cols)));
        }
    }
}

void Pc::key(uint8_t scan, uint8_t ascii) {
    keys.push_back(uint16_t((uint16_t(scan) << 8) | ascii)); keyboardIrq();
}

void Pc::modifiers(uint8_t value) { cpu.wb(0x40, 0x17, value); }

static uint8_t keyboardAscii(uint8_t scan, uint8_t flags) {
    static constexpr char plain[] = "\0\0331234567890-=\b\tqwertyuiop[]\r\0asdfghjkl;'`\0\\zxcvbnm,./\0*\0 ";
    static constexpr char shifted[] = "\0\033!@#$%^&*()_+\b\tQWERTYUIOP{}\r\0ASDFGHJKL:\"~\0|ZXCVBNM<>?\0*\0 ";
    if (scan >= sizeof(plain) - 1) {
        static constexpr char keypad[] = "789-456+1230.";
        return (flags & 0x20) && !(flags & 3) && scan >= 0x47 && scan <= 0x53 ? uint8_t(keypad[scan - 0x47]) : 0;
    }
    auto ch = uint8_t((flags & 3 ? shifted : plain)[scan]);
    if ((flags & 0x40) && plain[scan] >= 'a' && plain[scan] <= 'z') ch ^= 0x20;
    if (flags & 4) {
        if (ch >= 'a' && ch <= 'z') ch -= 'a' - 'A';
        if (ch >= '@' && ch <= '_') ch &= 31;
    }
    return ch;
}

void Pc::keyboard() {
    // ROM 已执行 IN 60h，AL 是 monitor 可接管的虚拟扫描码，不能在宿主再次直接读键盘队列。
    auto scan = cpu.reg8(0);
    auto ascii = keyboardRead && uint8_t(keyboardLatch >> 8) == scan
        ? uint8_t(keyboardLatch) : keyboardAscii(scan, cpu.rbF(0x40, 0x17));
    uint16_t value = uint16_t((uint16_t(scan) << 8) | ascii);
    keyboardRead = false;
    unsigned key = scan & 0x7f;
    uint8_t modifier = key == 0x2a ? 2 : key == 0x36 ? 1 : key == 0x1d ? 4 : key == 0x38 ? 8 : 0;
    if (modifier) {
        auto flags = cpu.rbF(0x40, 0x17);
        cpu.wbF(0x40, 0x17, uint8_t((scan & 0x80) ? flags & ~modifier : flags | modifier));
        if (key == 0x1d || key == 0x38) {
            auto extended = cpu.rbF(0x40, 0x18); uint8_t mask = key == 0x1d ? 1 : 2;
            cpu.wbF(0x40, 0x18, uint8_t((scan & 0x80) ? extended & ~mask : extended | mask));
        }
        keyboardIrq(); return;
    }
    if (key == 0x3a) {
        auto pressed = cpu.rbF(0x40, 0x18);
        if (!(scan & 0x80) && !(pressed & 0x40)) cpu.wbF(0x40, 0x17, cpu.rbF(0x40, 0x17) ^ 0x40);
        cpu.wbF(0x40, 0x18, uint8_t((scan & 0x80) ? pressed & ~0x40 : pressed | 0x40));
        keyboardIrq(); return;
    }
    if (scan & 0x80) { keyboardIrq(); return; }
    if (cpu.rbF(0x40, 0x17) & 8) value &= 0xff00;
    auto tail = cpu.rwF(0x40, 0x1c), next = uint16_t(tail + 2);
    if (next >= 0x3e) next = 0x1e;
    if (next != cpu.rwF(0x40, 0x1a)) { cpu.wwF(0x40, tail, value); cpu.wwF(0x40, 0x1c, next); }
    keyboardIrq();
}

std::string Pc::text() const {
    std::string result; unsigned cols = std::min(columns(), 80u), base = activePage() * 4096;
    for (unsigned y = 0; y < 25; ++y) {
        for (unsigned x = 0; x < cols; ++x) { auto c = vga.textByte(base + (y * cols + x) * 2); result += c >= 32 && c < 127 ? char(c) : ' '; }
        result += '\n';
    }
    return result;
}

bool Pc::biosGraphics() { return cpu.rbF(0x40, 0x49) >= 0x0d; }

unsigned Pc::biosCharacterHeight() {
    unsigned height = cpu.rwF(0x40, 0x85);
    if (!height || height > 32) throw std::runtime_error("Invalid graphics BIOS character height");
    return height;
}

unsigned Pc::biosRows() {
    if (!biosGraphics()) return 25;
    unsigned rows = std::min(unsigned(cpu.rbF(0x40, 0x84)) + 1, vga.height() / biosCharacterHeight());
    if (!rows) throw std::runtime_error("Graphics BIOS character height exceeds the display");
    return rows;
}

uint8_t Pc::glyphByte(uint8_t ch, unsigned row) {
    auto offset = cpu.rwF(0, 0x43 * 4), segment = cpu.rwF(0, 0x43 * 4 + 2);
    return cpu.rbF(segment, uint16_t(offset + ch * biosCharacterHeight() + row));
}

void Pc::drawGlyph(unsigned column, unsigned row, uint8_t ch, uint8_t color) {
    unsigned height = biosCharacterHeight(), left = column * 8, top = row * height;
    if (left + 8 > vga.width() || top + height > vga.height())
        throw std::runtime_error("Graphics BIOS character is outside the display");
    bool exclusiveOr = !vga.indexed256() && (color & 0x80);
    for (unsigned y = 0; y < height; ++y) {
        auto bits = glyphByte(ch, y);
        for (unsigned x = 0; x < 8; ++x) {
            bool ink = bits & (0x80 >> x);
            if (!exclusiveOr || ink) vga.pixel(left + x, top + y, ink ? color : 0, exclusiveOr);
        }
    }
}

uint8_t Pc::readGlyph(unsigned column, unsigned row) {
    unsigned height = biosCharacterHeight(), left = column * 8, top = row * height;
    if (left + 8 > vga.width() || top + height > vga.height())
        throw std::runtime_error("Graphics BIOS character is outside the display");
    std::array<uint8_t, 256> pixels{};
    bool uniform = true;
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < 8; ++x) {
        auto value = vga.pixel(left + x, top + y);
        pixels[y * 8 + x] = value; uniform &= value == pixels[0];
    }
    if (uniform) return ' ';
    for (unsigned ch = 0; ch < 256; ++ch) {
        int ink = -1, background = -1; bool matches = true;
        for (unsigned y = 0; y < height && matches; ++y) {
            auto bits = glyphByte(uint8_t(ch), y);
            for (unsigned x = 0; x < 8; ++x) {
                auto& color = bits & (0x80 >> x) ? ink : background;
                auto value = pixels[y * 8 + x];
                if (color < 0) color = value;
                else if (color != value) { matches = false; break; }
            }
        }
        if (matches && ink >= 0 && background >= 0 && ink != background) return uint8_t(ch);
    }
    return 0; // 像素不匹配当前任何字体字形时，BIOS 无法还原字符。
}

void Pc::scroll(unsigned top, unsigned left, unsigned bottom, unsigned right, unsigned lines, uint8_t attr, bool down, unsigned page) {
    bool graphics = biosGraphics();
    unsigned cols = std::min(biosColumns(), graphics ? vga.width() / 8 : 80u); if (!cols) return;
    unsigned rows = biosRows();
    top = std::min(top, rows - 1); bottom = std::min(bottom, rows - 1); left = std::min(left, cols - 1); right = std::min(right, cols - 1);
    if (top > bottom || left > right) return;
    if (!lines || lines > bottom - top + 1) lines = bottom - top + 1;
    if (page == 8) page = biosPage();
    if (graphics) {
        if (page) throw std::runtime_error("Graphics BIOS pages other than page 0 are not implemented yet");
        unsigned height = biosCharacterHeight(), first = top * height, last = (bottom + 1) * height, shift = lines * height;
        uint8_t fill = vga.indexed256() ? attr : attr & 15;
        for (unsigned i = 0; i < last - first; ++i) {
            unsigned y = down ? last - 1 - i : first + i;
            int source = int(y) + (down ? -int(shift) : int(shift));
            for (unsigned x = left * 8; x < (right + 1) * 8; ++x)
                vga.pixel(x, y, source < int(first) || source >= int(last) ? fill : vga.pixel(x, unsigned(source)));
        }
        return;
    }
    page *= 4096;
    for (unsigned i = 0; i <= bottom - top; ++i) {
        unsigned y = down ? bottom - i : top + i;
        for (unsigned x = left; x <= right; ++x) {
            int source = int(y) + (down ? -int(lines) : int(lines));
            uint16_t cell = (source < int(top) || source > int(bottom)) ? uint16_t((uint16_t(attr) << 8) | 32)
                : cpu.rwF(0xb800, uint16_t(page + (unsigned(source) * cols + x) * 2));
            cpu.wwF(0xb800, uint16_t(page + (y * cols + x) * 2), cell);
        }
    }
}

void Pc::put(uint8_t ch, uint8_t attr, unsigned page, bool writeAttribute) {
    bool graphics = biosGraphics();
    if (page == 8) page = biosPage();
    if (graphics && page) throw std::runtime_error("Graphics BIOS pages other than page 0 are not implemented yet");
    unsigned cols = std::max(1u, std::min(biosColumns(), graphics ? vga.width() / 8 : 80u));
    unsigned rows = biosRows(), pos = cpu.rwF(0x40, uint16_t(0x50 + page * 2)), x = pos & 255, y = pos >> 8;
    if (ch == 13) x = 0;
    else if (ch == 10) ++y;
    else if (ch == 8) { if (x) --x; }
    else if (ch != 7) {
        if (x < cols && y < rows) {
            if (graphics) drawGlyph(x, y, ch, attr);
            else {
                auto off = uint16_t(page * 4096 + (y * cols + x) * 2);
                cpu.wbF(0xb800, off, ch);
                if (writeAttribute) cpu.wbF(0xb800, uint16_t(off + 1), attr);
            }
        }
        if (++x >= cols) { x = 0; ++y; }
    }
    if (y >= rows) { scroll(0, 0, rows - 1, cols - 1, 1, graphics ? 0 : attr, false, page); y = rows - 1; }
    cpu.wwF(0x40, uint16_t(0x50 + page * 2), uint16_t((y << 8) | x));
}

bool Pc::video() {
    auto& c = cpu; auto& r = c.r; auto ah = c.reg8(4), al = c.reg8(0), bh = c.reg8(7), bl = c.reg8(3);
    unsigned page = bh & 7, cols = biosColumns();
    bool graphics = biosGraphics();
    if (vga.cirrus() && ah == 0x12) {
        switch (bl) {
        case 0x80: r[AX] = 0x39; c.reg8(3, 0x47); return true;
        case 0x81: r[AX] = 0x0100; return true;
        case 0x82: c.reg8(0, 0x47); return true;
        case 0x85: c.reg8(0, uint8_t(Vga::VramBytes / 65536)); return true;
        case 0xa0:
            c.reg8(4, al < 0x80 && c.rwF(0xf000, uint16_t(0x2000 + al * 2)) ? 1 : 0);
            // 固定端口配置不是 OEM 标准/补充参数表；按协议返回未定义指针，不能让驱动误读配置字节。
            c.loadSegment(DS, 0xffff); c.loadSegment(ES, 0xffff);
            r[SI] = r[DI] = 0xffff; r[BX] = cirrusFixupOffset;
            return true;
        }
    }
    if (graphics && bh && (ah == 8 || ah == 9 || ah == 10 || ah == 0x0e || ah == 0x13))
        throw std::runtime_error("Graphics BIOS pages other than page 0 are not implemented yet");
    switch (ah) {
    case 0: {
        bool virtualized = c.supports386() && (c.eflags() & 0x20000);
        std::unique_ptr<Vga> virtualDisplay;
        auto* display = &vga;
        if (virtualized) {
            virtualDisplay = std::make_unique<Vga>();
            if (vga.cirrus()) virtualDisplay->enableCirrus(true);
            display = virtualDisplay.get();
        }
        display->setMode(al & 0x7f, !(al & 0x80));
        c.wbF(0x40, 0x49, al & 0x7f);
        c.wwF(0x40, 0x4a, display->graphics() ? uint16_t(display->width() / 8) : (al & 0x7f) < 2 ? 40 : 80);
        c.wbF(0x40, 0x62, 0); c.wwF(0x40, 0x4e, 0);
        c.wwF(0x40, 0x4c, display->mode == 0x13 ? 0xfa00 : display->mode == 0x12 ? 0x9600
            : display->mode == 0x10 ? 0x8000 : display->mode == 0x0e ? 0x4000 : display->mode == 0x0d ? 0x2000 : 4096);
        c.wbF(0x40, 0x84, display->graphics() ? uint8_t(display->height() / display->charHeight() - 1) : 24);
        c.wwF(0x40, 0x85, uint16_t(display->charHeight()));
        if (display->graphics()) {
            c.wwF(0, 0x43 * 4, display->charHeight() == 8 ? font8Offset : display->charHeight() == 14 ? font14Offset : font16Offset);
            c.wwF(0, 0x43 * 4 + 2, 0xf000);
        }
        for (unsigned p = 0; p < 8; ++p) c.wwF(0x40, uint16_t(0x50 + p * 2), 0);
        if (!virtualized && !(al & 0x80) && !display->graphics())
            for (unsigned i = 0; i < 0x8000; i += 2) c.wwF(0xb800, uint16_t(i), 0x0720);
        return true;
    }
    case 1: c.wwF(0x40, 0x60, r[CX]); return true;
    case 2: c.wwF(0x40, uint16_t(0x50 + page * 2), r[DX]); return true;
    case 3: r[DX] = c.rwF(0x40, uint16_t(0x50 + page * 2)); r[CX] = c.rwF(0x40, 0x60); return true;
    case 4: c.reg8(4, 0); return true;
    case 5:
        if (graphics && al) throw std::runtime_error("Graphics BIOS pages other than page 0 are not implemented yet");
        c.wbF(0x40, 0x62, al & 7); c.wwF(0x40, 0x4e, uint16_t((al & 7) * 4096)); return true;
    case 6: case 7: scroll(c.reg8(5), c.reg8(1), c.reg8(6), c.reg8(2), al, bh, ah == 7); return true;
    case 8: {
        auto pos = c.rwF(0x40, uint16_t(0x50 + page * 2));
        if (graphics) { r[AX] = readGlyph(pos & 255, pos >> 8); return true; }
        r[AX] = c.rwF(0xb800, uint16_t(page * 4096 + ((pos >> 8) * cols + (pos & 255)) * 2)); return true;
    }
    case 9: case 10: {
        auto pos = c.rwF(0x40, uint16_t(0x50 + page * 2)); unsigned cell = (pos >> 8) * cols + (pos & 255);
        unsigned rows = biosRows();
        if (graphics) cols = std::min(cols, vga.width() / 8);
        if (!cols) throw std::runtime_error("Invalid BIOS text column count");
        cell = (pos >> 8) * cols + (pos & 255);
        for (unsigned i = 0; i < r[CX] && cell + i < cols * rows; ++i) {
            if (graphics) { drawGlyph((cell + i) % cols, (cell + i) / cols, al, bl); continue; }
            auto off = uint16_t(page * 4096 + (cell + i) * 2); c.wbF(0xb800, off, al); if (ah == 9) c.wbF(0xb800, off + 1, bl);
        }
        return true;
    }
    case 0x0b: return true;
    case 0x0c: case 0x0d:
        if (!graphics || !vga.graphics() || bh) throw std::runtime_error("BIOS pixel access requires graphics page 0");
        if (ah == 0x0c) vga.pixel(r[CX], r[DX], al, vga.mode != 0x13 && (al & 0x80));
        else c.reg8(0, vga.pixel(r[CX], r[DX]));
        return true;
    case 0x0e: put(al, graphics ? bl : bl ? bl : 7, page); return true;
    case 0x0f: c.reg8(4, uint8_t(cols)); c.reg8(0, c.rbF(0x40, 0x49)); c.reg8(7, uint8_t(biosPage())); return true;
    case 0x10:
        if (al == 0 && bl < 16) { vga.attr[bl] = bh & 63; return true; }
        if (al == 1) { vga.attr[0x11] = bh & 63; return true; }
        if (al == 2 || al == 9) {
            for (unsigned i = 0; i < 17; ++i) {
                auto& value = vga.attr[i < 16 ? i : 0x11];
                if (al == 2) value = c.rbF(c.s[ES], uint16_t(r[DX] + i)) & 63;
                else c.wbF(c.s[ES], uint16_t(r[DX] + i), value);
            }
            return true;
        }
        if (al == 3) { vga.attr[0x10] = uint8_t((vga.attr[0x10] & ~8) | ((bl & 1) << 3)); return true; }
        if (al == 7 && bl < 16) { c.reg8(7, vga.attr[bl]); return true; }
        if (al == 8) { c.reg8(7, vga.attr[0x11]); return true; }
        if (al == 0x13) {
            if (bl == 0) vga.attr[0x10] = uint8_t((vga.attr[0x10] & ~0x80) | ((bh & 1) << 7));
            else if (bl == 1) vga.attr[0x14] = uint8_t((vga.attr[0x10] & 0x80) ? bh & 15 : (bh & 3) << 2);
            else break;
            return true;
        }
        if (al == 0x18) { output(0x3c6, bl); return true; }
        if (al == 0x19) { r[BX] = input(0x3c6); return true; }
        if (al == 0x1a) {
            c.reg8(3, vga.attr[0x10] >> 7);
            c.reg8(7, uint8_t((vga.attr[0x10] & 0x80) ? vga.attr[0x14] & 15 : (vga.attr[0x14] >> 2) & 3));
            return true;
        }
        if (al == 0x10 || al == 0x15) {
            if (r[BX] > 255) throw std::runtime_error("VGA DAC palette index must be below 256");
            unsigned off = r[BX] * 3;
            if (al == 0x10) { vga.dac[off] = c.reg8(6) & 63; vga.dac[off + 1] = c.reg8(5) & 63; vga.dac[off + 2] = c.reg8(1) & 63; }
            else { c.reg8(6, vga.dac[off]); c.reg8(5, vga.dac[off + 1]); c.reg8(1, vga.dac[off + 2]); }
            return true;
        }
        if (al == 0x12 || al == 0x17) {
            if (unsigned(r[BX]) + r[CX] > 256) throw std::runtime_error("VGA DAC palette block exceeds 256 entries");
            for (unsigned i = 0; i < unsigned(r[CX]) * 3; ++i) {
                unsigned off = r[BX] * 3 + i; auto address = uint16_t(r[DX] + i);
                if (al == 0x12) vga.dac[off] = c.rbF(c.s[ES], address) & 63;
                else c.wbF(c.s[ES], address, vga.dac[off]);
            }
            return true;
        }
        break;
    case 0x11:
        if (al == 0x24) {
            if (bl > 3 || (!bl && !c.reg8(2))) throw std::runtime_error("Invalid graphics font row specifier");
            auto rows = bl == 0 ? c.reg8(2) : bl == 1 ? 14 : bl == 2 ? 25 : 43;
            c.wwF(0, 0x43 * 4, font16Offset); c.wwF(0, 0x43 * 4 + 2, 0xf000);
            c.wbF(0x40, 0x84, uint8_t(rows - 1)); c.wwF(0x40, 0x85, 16);
            return true;
        }
        if (al == 0x30) {
            auto segment = bh == 1 ? c.rwF(0, 0x43 * 4 + 2) : 0xf000;
            r[BP] = bh == 1 ? c.rwF(0, 0x43 * 4) : font16Offset;
            c.loadSegment(ES, uint16_t(segment)); r[CX] = c.rwF(0x40, 0x85); c.reg8(2, c.rbF(0x40, 0x84));
            return true;
        }
        if (al == 1 || al == 2 || al == 4 || al == 0x11 || al == 0x12 || al == 0x14) {
            if (al >= 0x10) { c.wbF(0x40, 0x84, 24); c.wwF(0x40, 0x85, 16); }
            return true;
        }
        break;
    case 0x12: if (bl == 0x10) { r[BX] = 3; r[CX] = 0; } return true;
    case 0x13: {
        auto cursorOffset = uint16_t(0x50 + page * 2);
        auto saved = c.rwF(0x40, cursorOffset); c.wwF(0x40, cursorOffset, r[DX]);
        uint16_t off = r[BP];
        for (unsigned i = 0; i < r[CX]; ++i) {
            auto ch = c.rbF(c.s[ES], off++), attr = al & 2 ? c.rbF(c.s[ES], off++) : bl;
            put(ch, attr, page, true);
        }
        if (!(al & 1)) c.wwF(0x40, cursorOffset, saved); return true;
    }
    case 0x1a: c.reg8(0, 0x1a); r[BX] = 8; return true;
    case 0x1b: c.reg8(0, 0); return true;
    case 0x4f: r[AX] = 0x014f; return true; // 尚无 VBE/SVGA（含 DDC），返回 VBE 失败状态。
    case 0x6f: r[BX] = 0; return true; // 无 Video Seven 扩展。
    case 0xef: return true; // 无 MSHERC 驻留接口，保留调用者的非 Hercules 哨兵。
    case 0xfa:
        if (!r[BX]) return true; // 无 EGA Register Interface Library 驻留驱动。
        break;
    }
    throw biosError(c, 0x10);
}

bool Pc::disk() {
    // INT 13h：00/0D 复位、01 状态、02/03 读写、04 校验、05 格式化、08 几何。
    // 扩展 41 检测、42/43 LBA 读写、44 校验、47 寻道、48 参数；状态通过 AH 和栈上的 CF 返回。
    auto& c = cpu; auto& r = c.r; uint8_t drive = c.reg8(2), ah = c.reg8(4);
    bool hd = drive & 0x80; Disk* d = drive == 0 ? floppy.get() : drive == 0x80 ? hard.get() : nullptr;
    auto status = [&](uint8_t code) {
        c.reg8(4, code); c.stackedFlag(CF, code != 0); c.wbF(0x40, hd ? 0x74 : 0x41, code);
    };
    int cylinder = c.reg8(5) | ((c.reg8(1) & 0xc0) << 2), head = c.reg8(6), sector = c.reg8(1) & 63;
    if (ah == 0 || ah == 0x0d) { status(d || drive == 0 ? 0 : 1); return true; }
    if (ah == 1) { auto v = c.rbF(0x40, hd ? 0x74 : 0x41); status(v); return true; }
    if (ah == 8) {
        if (!d && drive != 0) { r[DX] = 0; status(1); return true; }
        int cy = d ? d->biosCylinders() - 1 : 79, heads = d ? d->biosHeads() : 2, spt = d ? d->spt : 18;
        r[CX] = uint16_t(((cy & 255) << 8) | ((cy >> 2) & 0xc0) | spt);
        r[DX] = uint16_t(((heads - 1) << 8) | (hd ? (hard ? 1 : 0) : 1));
        if (!hd) { c.reg8(3, d ? uint8_t(d->floppyType) : 4); c.loadSegment(ES, 0xf000); r[DI] = 0xefc7; }
        status(0); return true;
    }
    if (ah == 0x15) {
        c.stackedFlag(CF, false); c.reg8(4, d ? (hd ? 3 : 2) : drive == 0 ? 2 : 0);
        if (d && hd) { r[CX] = uint16_t(d->sectors >> 16); r[DX] = uint16_t(d->sectors); }
        return true;
    }
    if (!d) { status(hd ? 1 : 0x80); return true; }
    if (ah == 0x16) { auto changed = d->changed; d->changed = false; status(changed ? 6 : 0); return true; }
    if (ah == 0x17 || ah == 0x18) { if (ah == 0x18) { c.loadSegment(ES, 0xf000); r[DI] = 0xefc7; } status(0); return true; }
    if (ah == 0x41) {
        if (!hd || r[BX] != 0x55aa) { status(1); return true; }
        r[BX] = 0xaa55; r[CX] = 5; status(0); c.reg8(4, 0x21); return true;
    }
    if (hd && ah == 0x48) {
        auto ds = c.s[DS], si = r[SI];
        if (si > 0xffe6 || c.rwF(ds, si) < 26) { status(1); return true; }
        std::array<uint8_t, 26> parameters{};
        parameters[0] = 26;
        auto heads = d->biosHeads(), cylinders = d->biosCylinders();
        parameters[2] = uint64_t(heads) * cylinders * d->spt == d->sectors ? 2 : 0;
        diskWord(parameters.data() + 4, unsigned(cylinders)); diskWord(parameters.data() + 8, unsigned(heads));
        diskWord(parameters.data() + 12, unsigned(d->spt)); diskWord(parameters.data() + 16, d->sectors);
        parameters[25] = 2;
        for (unsigned i = 0; i < parameters.size(); ++i) c.wbF(ds, uint16_t(si + i), parameters[i]);
        status(0); return true;
    }
    if (hd && (ah == 0x42 || ah == 0x43 || ah == 0x44 || ah == 0x47)) {
        // DS:SI 指向 16 字节 DAP：大小/保留、count16、offset16:segment16、LBA64。
        auto ds = c.s[DS], si = r[SI];
        if (si > 0xfff0 || c.rbF(ds, si) != 16 || c.rbF(ds, uint16_t(si + 1))) { status(1); return true; }
        auto count = c.rwF(ds, uint16_t(si + 2));
        auto offset = c.rwF(ds, uint16_t(si + 4)), segment = c.rwF(ds, uint16_t(si + 6));
        uint64_t lba = 0;
        for (unsigned i = 0; i < 8; ++i) lba |= uint64_t(c.rbF(ds, uint16_t(si + 8 + i))) << (8 * i);
        auto failure = [&](uint8_t code) { c.wwF(ds, uint16_t(si + 2), 0); status(code); return true; };
        if (!count || count > 127 || (ah == 0x43 && c.reg8(0) > 1)) return failure(1);
        if (lba >= d->sectors || count > d->sectors - lba) return failure(4);
        if ((ah == 0x42 || ah == 0x43) && uint32_t(offset) + uint32_t(count) * 512 > 0x10000) return failure(9);
        if (ah == 0x43 && d->readOnly) return failure(3);
        if (ah == 0x47) { status(0); return true; }
        std::vector<uint8_t> data(unsigned(count) * 512);
        auto address = (uint32_t(segment) << 4) + offset;
        if (ah == 0x43) {
            // 完整读取客体缓冲区后才落盘，避免第二页故障造成半次磁盘写入。
            for (unsigned i = 0; i < data.size(); ++i) data[i] = c.readLinear(address + i);
        }
        for (unsigned i = 0; i < count; ++i) {
            bool ok = ah == 0x43 ? d->write(uint32_t(lba) + i, data.data() + i * 512)
                : d->read(uint32_t(lba) + i, data.data() + i * 512);
            if (!ok) { c.wwF(ds, uint16_t(si + 2), uint16_t(i)); status(4); return true; }
        }
        if (ah == 0x42) for (unsigned i = 0; i < data.size(); ++i) c.writeLinear(address + i, data[i]);
        if (ah == 0x43) {
            d->flush();
            if (c.reg8(0) == 1) {
                std::array<uint8_t, 512> verified{};
                for (unsigned i = 0; i < count; ++i) {
                    if (!d->read(uint32_t(lba) + i, verified.data()) ||
                        !std::equal(verified.begin(), verified.end(), data.begin() + i * 512)) return failure(0x10);
                }
            }
        }
        status(0); return true;
    }
    if (ah == 9 || ah == 0x0c || (ah >= 0x10 && ah <= 0x14)) { status(0); return true; }
    if (ah < 2 || ah > 5) { status(1); notice = "Unsupported INT 13h function " + std::to_string(ah); return true; }
    if (cylinder >= d->biosCylinders() || head >= d->biosHeads() || sector < 1 || sector > d->spt) { status(4); c.reg8(0, 0); return true; }
    unsigned count = ah == 5 ? unsigned(d->spt) : c.reg8(0);
    uint32_t lba = unsigned((cylinder * d->biosHeads() + head) * d->spt + (ah == 5 ? 0 : sector - 1));
    if (!count || lba + count > d->sectors) { status(4); c.reg8(0, 0); return true; }
    if ((ah == 3 || ah == 5) && d->readOnly) { status(3); c.reg8(0, 0); return true; }
    std::array<uint8_t, 512> buffer{};
    uint32_t addr = (uint32_t(c.s[ES]) << 4) + r[BX];
    for (unsigned i = 0; i < count; ++i) {
        if (ah == 2 || ah == 4) d->read(lba + i, buffer.data());
        if (ah == 2) for (auto v : buffer) { c.writeLinear(addr++ & 0xfffff, v); }
        if (ah == 3) { for (auto& v : buffer) v = c.readLinear(addr++ & 0xfffff); d->write(lba + i, buffer.data()); }
        if (ah == 5) { buffer.fill(0xf6); d->write(lba + i, buffer.data()); }
    }
    if (ah == 3 || ah == 5) d->flush();
    status(0); c.reg8(0, uint8_t(count)); return true;
}

bool Pc::apm() {
    auto& c = cpu; auto& r = c.r;
    auto result = [&](uint8_t error) {
        c.stackedFlag(CF, error != 0); c.reg8(4, error); return true;
    };
    auto function = c.reg8(0);
    if (!at()) return result(0x86);
    if (function == 0) {
        if (r[BX]) return result(9);
        r[AX] = 0x0102; r[BX] = 0x504d; r[CX] = (!apmEnabled ? 8 : 0) | (!apmEngaged ? 16 : 0);
        c.stackedFlag(CF, false); return true;
    }
    if (function >= 1 && function <= 3) {
        if (r[BX]) return result(9);
        if (apmConnected) return result(2);
        if (function != 1) return result(function == 2 ? 6 : 8);
        apmConnected = true; apmVersion = 0x0100; return result(0);
    }
    if (function == 0x10) {
        if (r[BX]) return result(9);
        c.reg8(3, 0); r[CX] = 0; return result(0);
    }
    if (!apmConnected) return result(3);
    switch (function) {
    case 4:
        if (r[BX]) return result(9);
        apmConnected = false; apmVersion = 0x0100; return result(0);
    case 5: case 6: return result(0); // APM CPU idle/busy 成功，但不改模拟时钟速率。
    case 7:
        if (r[BX] != 1) return result(9);
        if (!apmEnabled) return result(1);
        if (!apmEngaged) return result(0x0b);
        if (r[CX] == 1 || r[CX] == 2) return result(0x60);
        if (r[CX] != 3) return result(0x0a);
        if (apmVersion == 0x0100) return result(0x0a);
        result(0); powerOffRequested = true; return true;
    case 8:
        if (r[BX] != (apmVersion == 0x0100 ? 0xffff : 1)) return result(9);
        if (r[CX] > 1) return result(0x0a);
        if (!apmEngaged) return result(0x0b);
        apmEnabled = r[CX] != 0; return result(0);
    case 9:
        if (r[BX] != (apmVersion == 0x0100 ? 0xffff : 1)) return result(9);
        apmEnabled = apmEngaged = true; return result(0);
    case 0x0a:
        if (r[BX] != 1) return result(9);
        r[BX] = 0x01ff; r[CX] = 0x80ff; r[DX] = 0xffff; return result(0);
    case 0x0b: return result(0x80);
    case 0x0e:
        if (r[BX]) return result(9);
        if (r[CX] < 0x0100) return result(0x0a);
        apmVersion = std::min(r[CX], uint16_t(0x0102));
        r[AX] = apmVersion; c.stackedFlag(CF, false); return true;
    case 0x0f:
        if (r[BX] != 1) return result(9);
        if (!apmEnabled) return result(1);
        if (r[CX] > 1) return result(0x0a);
        apmEngaged = r[CX] != 0; return result(0);
    default: return result(0x0c);
    }
}

bool Pc::bios(uint8_t n) {
    // n 是私有 ROM 陷阱传来的 BIOS 中断号；CF/ZF 返回值写调用者栈帧，最终由 IRET 恢复。
    auto& c = cpu; auto& r = c.r; auto ah = c.reg8(4);
    if (n == 0xe0 && vga.cirrus()) {
        if (c.r32(AX) != 0x49435024 || c.reg8(3)) { c.reg8(0, 0x80); return true; }
        c.reg8(0, 0); c.r32(BX, 0xf0000); c.r32(CX, 0x10000); c.r32(DX, 0xb040); return true;
    }
    if (n == 0xe1 && vga.cirrus()) return pciBios(true);

    // 标准 PC/AT 未装 HP-HIL 接口，探测必须保留 BX 而不能误宣告设备存在。
    if (r[AX] == 0x6f00 && (n == 0x14 || n == 0x16 || n == 0x17)) return true;
    if (n == 0x68 && ah == 0x43) return true; // 没有返回 F386h 签名的驻留扩展器。
    if (n == 0x67 && r[AX] == 0xde00) { c.reg8(4, 0x84); return true; } // 未安装 VCPI 提供者。
    if (n == 0x5c) {
        // 7Fh 是 BWNB 安装探测：未安装时不改其哨兵。其它请求返回 FBh（NetBIOS emulator not found）。
        // 没有驻留提供者接收 NCB，不改控制块、不排队或调用异步完成回调，更不能返回成功。
        if (c.rbF(c.s[ES], r[BX]) != 0x7f) c.reg8(0, 0xfb);
        return true;
    }
    switch (n) {
    case 8: {
        // IRQ0 累加 BDA 0040:006C 的双字 tick；一天 1800B0h tick，溢出累加午夜计数。
        uint32_t ticks = c.rwF(0x40, 0x6c) | (uint32_t(c.rwF(0x40, 0x6e)) << 16);
        if (++ticks >= 0x1800b0) { ticks = 0; c.wbF(0x40, 0x70, uint8_t(c.rbF(0x40, 0x70) + 1)); }
        c.wwF(0x40, 0x6c, uint16_t(ticks)); c.wwF(0x40, 0x6e, uint16_t(ticks >> 16)); return true;
    }
    case 9: keyboard(); return true;
    case 0x10: return video();
    case 0x11: r[AX] = c.rwF(0x40, 0x10); return true;
    case 0x12: r[AX] = 640; return true;
    case 0x13: return disk();
    case 0x14:

        // AH=0 初始化 UART、1 发送、2 接收、3 状态；DX=0 是 COM1，AL 高三位编码波特率。
        if (r[DX] || c.reg8(4) > 3) { c.reg8(4, 0x80); return true; }
        switch (c.reg8(4)) {
        case 0: {
            const unsigned baud[] = {110,150,300,600,1200,2400,4800,9600};
            auto format = c.reg8(0); unsigned divisor = 115200 / baud[format >> 5];
            output(0x3fb, 0x80); output(0x3f8, uint8_t(divisor)); output(0x3f9, uint8_t(divisor >> 8));
            output(0x3fb, format & 31); break;
        }
        case 1:
            output(0x3fc, uint8_t(input(0x3fc) | 3));
            if (!(input(0x3fd) & 0x20)) { c.reg8(4, 0x80); return true; }
            output(0x3f8, c.reg8(0)); c.reg8(4, input(0x3fd)); return true;
        case 2:
            if (!(input(0x3fd) & 1)) { c.reg8(4, 0x80); return true; }
            c.reg8(0, input(0x3f8)); c.reg8(4, input(0x3fd)); return true;
        }
        c.reg8(4, input(0x3fd)); c.reg8(0, input(0x3fe)); return true;
    case 0x15:

        // 53h=APM，88h=扩展内存 KiB，24h=A20，87h=按描述符拷贝 CX 个字的扩展内存块。
        if (ah == 0x53) return apm();
        if (ah == 0x88) { r[AX] = at() ? 15360 : 0; c.stackedFlag(CF, false); }
        else if (at() && ah == 0x24 && c.reg8(0) <= 3) {
            switch (c.reg8(0)) {
            case 0: case 1:
                c.a20 = c.reg8(0) != 0; kbdOutput = uint8_t((kbdOutput & ~2) | (c.a20 ? 2 : 0));
                fastA20 = uint8_t((fastA20 & ~2) | (c.a20 ? 2 : 0)); r[AX] = 0; break;
            case 2: r[AX] = c.a20 ? 1 : 0; r[CX] = 0; break;
            case 3: r[AX] = 0; r[BX] = 3; break;
            }
            c.stackedFlag(CF, false);
        }
        else if (at() && ah == 0x87) {
            uint32_t table = (uint32_t(c.s[ES]) << 4) + r[SI], count = uint32_t(r[CX]) * 2;
            auto base = [&](uint32_t entry) {
                return uint32_t(c.readLinear(entry + 2)) | (uint32_t(c.readLinear(entry + 3)) << 8)
                    | (uint32_t(c.readLinear(entry + 4)) << 16);
            };
            uint32_t source = base(table + 16), target = base(table + 24);
            bool invalid = count && (count - 1 > c.rwF(c.s[ES], uint16_t(r[SI] + 16)) || count - 1 > c.rwF(c.s[ES], uint16_t(r[SI] + 24))
                || source + count > c.mem.size() || target + count > c.mem.size());
            if (!invalid) {
                bool enabled = c.a20; c.a20 = true;
                for (uint32_t i = 0; i < count; ++i) c.writePhysical(target + i, c.readPhysical(source + i));
                c.a20 = enabled;
            }
            c.reg8(4, invalid ? 2 : 0); c.stackedFlag(CF, invalid);
        }
        else { c.reg8(4, 0x86); c.stackedFlag(CF, true); }
        return true;
    case 0x16: {
        // BDA 1Ah/1Ch 是键盘环形队列头/尾，范围 1Eh..3Dh，每项为 scan:ASCII。
        // 阻塞读队列为空时返回 false，由解释器保留陷阱位置等待 IRQ，而不是伪造一个零键。
        auto head = c.rwF(0x40, 0x1a), tail = c.rwF(0x40, 0x1c);
        if (ah == 0 || ah == 0x10) {
            if (head == tail) return false;
            r[AX] = c.rwF(0x40, head); head += 2; if (head >= 0x3e) head = 0x1e;
            c.wwF(0x40, 0x1a, head); return true;
        }
        if (ah == 1 || ah == 0x11) { c.stackedFlag(ZF, head == tail); if (head != tail) r[AX] = c.rwF(0x40, head); return true; }
        if (ah == 2) { c.reg8(0, c.rbF(0x40, 0x17)); return true; }
        if (ah == 3) return true;

        // DOS 探测第三方键盘扩展；XT BIOS 应保持 AX 不变。
        if (ah == 0x92 || ah == 0xa2) return true;

        // 未安装倚天中文键盘扩展或 QBASIC 兼容驻留 TSR，不宣告其存在。
        if (r[AX] == 0xdb00 || r[AX] == 0x55fe) return true;
        if (ah == 0x12) { r[AX] = c.rbF(0x40, 0x17); return true; }
        if (ah == 5) {
            auto next = uint16_t(tail + 2); if (next >= 0x3e) next = 0x1e;
            c.reg8(0, next == head ? 1 : 0); if (next != head) { c.wwF(0x40, tail, r[CX]); c.wwF(0x40, 0x1c, next); } return true;
        }
        throw biosError(c, 0x16);
    }
    case 0x17: c.reg8(4, 1); return true;
    case 0x19: rebootRequested = true; return true;
    case 0x1a: {
        if (ah == 0xb1) return pciBios(false);
        // AH=0/1 读写 BDA tick；AH=2/4 取宿主本地时间/日期并编码成 BIOS BCD 字段。
        auto bcd = [](int v) { return uint8_t((v / 10) * 16 + v % 10); };
        auto now = std::time(nullptr); std::tm t{}; localtime_s(&t, &now);
        if (ah == 0) { r[CX] = c.rwF(0x40, 0x6e); r[DX] = c.rwF(0x40, 0x6c); c.reg8(0, c.rbF(0x40, 0x70)); c.wbF(0x40, 0x70, 0); }
        else if (ah == 1) { c.wwF(0x40, 0x6e, r[CX]); c.wwF(0x40, 0x6c, r[DX]); }
        else if (ah == 2) { r[CX] = uint16_t((unsigned(bcd(t.tm_hour)) << 8) | bcd(t.tm_min)); r[DX] = uint16_t(unsigned(bcd(t.tm_sec)) << 8); }
        else if (ah == 4) { int year = t.tm_year + 1900; r[CX] = uint16_t((unsigned(bcd(year / 100)) << 8) | bcd(year % 100)); r[DX] = uint16_t((unsigned(bcd(t.tm_mon + 1)) << 8) | bcd(t.tm_mday)); }
        else { c.stackedFlag(CF, true); return true; }
        c.stackedFlag(CF, false); return true;
    }
    case 0x1b: case 0x1c: case 0x23: case 0x24: return true;
    case 0x18: throw std::runtime_error("Guest invoked INT 18h: no bootable system");
    case 0x2f: return true; // 固件不提供驻留 multiplex 服务。
    case 0x33: if (r[AX] == 0) r[AX] = 0; return true;
    default: throw biosError(c, n);
    }
}
}
