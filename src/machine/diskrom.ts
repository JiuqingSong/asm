// BIOS ROM 里 INT 13h 的入口：硬盘（80h、81h）的读、写、校验扇区（AH=02h、03h、04h）和真的 AT BIOS 一样
// 经 IDE 控制器的端口完成（算出 LBA，写任务文件寄存器和命令，等 DRQ，从数据端口读写 256 个字），其余功能
// 进入陷阱由 JavaScript 完成（bios.ts）。
//
// 为什么要这样：Windows 95 的 32 位 IDE 驱动（ESDI_506.PDR）启动时截获控制器的端口，再调用一次 BIOS 的
// INT 13h，看 BIOS 是不是真的经过这些端口读硬盘，据此确认 BIOS 的 80h 号盘就是这个控制器上的盘。BIOS 不碰
// 端口的话它在 IOS.LOG 里写"ESDI trap handler not called"，硬盘只能用"MS-DOS 兼容方式"。
//
// 只用 8086 指令（CPU 选 8088 时也能运行）；几何参数取 ROM 里的硬盘参数表（INT 41h/46h 指向的那两个）。
import { assemble } from '../asm/assembler.ts';

/** 代码在 BIOS 段里的位置（VGA 的 DAC 表到 1300h 为止） */
export const DISK_ROM = 0x1400;

const SOURCE = (trap: number, fdpt: number) => `
rom segment
assume cs:rom
org 0${DISK_ROM.toString(16)}h
int13 proc far
        cmp dl, 80h
        jb totrap
        cmp dl, 81h
        ja totrap
        cmp ah, 2
        jb totrap
        cmp ah, 4
        jbe harddisk
totrap: db 0EAh                         ; jmp far F000:陷阱桩
        dw 0${trap.toString(16)}h, 0F000h

harddisk:
        push bp
        push ax
        push ds
        push es
        push bx
        push cx
        push dx
        push si
        push di
        mov bp, sp
        ; [bp+0] di、2 si、4 dx、6 cx、8 bx、10 es、12 ds、14 ax、16 bp、18 ip、20 cs、22 flags
        sti
        mov si, 0${fdpt.toString(16)}h      ; 硬盘参数表：0 柱面数，2 磁头数，14 每道扇区数
        test dl, 1
        jz unit0
        add si, 16
unit0:  cmp word ptr cs:[si], 0
        jne present
        pop di                          ; 没有这个盘：交给陷阱（报告错误）
        pop si
        pop dx
        pop cx
        pop bx
        pop es
        pop ds
        pop ax
        pop bp
        jmp totrap

present:
        mov ah, 1                       ; 扇区数为 0：无效参数
        cmp byte ptr [bp+14], 0
        je fail0
        ; LBA = (柱面 × 磁头数 + 磁头) × 每道扇区数 + 扇区 − 1；柱面 = CH | (CL 的位 6~7 << 2)
        mov al, ch
        mov ah, cl
        mov cl, 6
        shr ah, cl
        xor bh, bh
        mov bl, cs:[si+2]
        mul bx
        mov bl, [bp+5]
        add ax, bx
        mov bl, cs:[si+14]
        mul bx
        mov bl, [bp+6]
        and bl, 3Fh
        jnz secok
        mov ah, 4                       ; 扇区号 0：找不到扇区
        jmp fail0
secok:  dec bl
        add ax, bx
        adc dx, 0
        mov bx, ax                      ; DI:BX = LBA
        mov di, dx

        ; 驱动器/磁头寄存器：LBA 方式、主盘或从盘、LBA 的位 24~27
        mov ax, di
        mov al, ah
        and al, 0Fh
        or al, 0E0h
        test byte ptr [bp+4], 1
        jz master
        or al, 10h
master: mov dx, 1F6h
        out dx, al
        mov dx, 1F2h
        mov al, [bp+14]
        out dx, al                      ; 扇区数
        inc dx
        mov al, bl
        out dx, al                      ; LBA 位 0~7
        inc dx
        mov al, bh
        out dx, al                      ; 位 8~15
        inc dx
        mov ax, di
        out dx, al                      ; 位 16~23
        mov dx, 1F7h
        mov al, 20h                     ; READ SECTORS
        cmp byte ptr [bp+15], 3
        jb command
        mov al, 30h                     ; WRITE SECTORS
        je command
        mov al, 40h                     ; READ VERIFY SECTORS
command:
        out dx, al

        ; ES:BX 规格化成 ES:DI（DI < 16），每个扇区后段值加 32
        mov ax, [bp+8]
        mov di, ax
        and di, 0Fh
        mov cl, 4
        shr ax, cl
        add ax, [bp+10]
        mov es, ax
        xor si, si                      ; 已经传送的扇区数
        cld
        cmp byte ptr [bp+15], 4
        je finish

sector: mov dx, 1F7h
waitdrq:
        in al, dx
        test al, 80h
        jnz waitdrq
        test al, 1
        jnz error
        test al, 8
        jz error
        mov dx, 1F0h
        mov cx, 256
        cmp byte ptr [bp+15], 3
        je writing
reading:
        in ax, dx
        stosw
        loop reading
        jmp short next
writing:
        mov ax, es:[di]
        out dx, ax
        inc di
        inc di
        loop writing
next:   sub di, 512
        mov ax, es
        add ax, 32
        mov es, ax
        inc si
        mov ax, si
        cmp al, [bp+14]
        jb sector

finish: mov dx, 1F7h
waitend:
        in al, dx
        test al, 80h
        jnz waitend
        test al, 1
        jnz error
        mov al, [bp+14]
        xor ah, ah
        jmp short done

error:  mov dx, 1F1h                    ; 错误寄存器 → INT 13h 的状态
        in al, dx
        mov ah, 4                       ; 找不到扇区
        test al, 10h
        jnz errcount
        mov ah, 1                       ; 命令被中止：写只读盘时是写保护，否则无效命令
        test al, 4
        jz baddata
        cmp byte ptr [bp+15], 3
        jne errcount
        mov ah, 3
        jmp short errcount
baddata:
        mov ah, 10h                     ; 其他：数据错
errcount:
        mov dx, si
        mov al, dl
        jmp short done
fail0:  xor al, al

done:   mov [bp+14], ax                 ; 返回的 AX
        mov bx, 40h
        mov ds, bx
        mov ds:[74h], ah                ; 40:74 = 上次硬盘操作的状态
        and byte ptr [bp+22], 0FEh      ; CF = 有没有出错
        or ah, ah
        jz popall
        or byte ptr [bp+22], 1
popall: pop di
        pop si
        pop dx
        pop cx
        pop bx
        pop es
        pop ds
        pop ax
        pop bp
        iret
int13 endp
rom ends
end
`;

let cached: Uint8Array | null = null;

/** 汇编 INT 13h 的入口代码；trap 是原来的陷阱桩（F000:trap），fdpt 是硬盘参数表的偏移 */
export function diskRom(trap: number, fdpt: number): Uint8Array {
  if (cached) return cached;
  const p = assemble(SOURCE(trap, fdpt), { loadSeg: 0 });
  const errors = p.diagnostics.filter(d => d.severity === 'error');
  if (errors.length) throw new Error('INT 13h 的 ROM 代码汇编出错：' + errors.map(d => `${d.line}: ${d.message}`).join('；'));
  const seg = p.segments[0];
  cached = Uint8Array.from(seg.bytes.slice(DISK_ROM), b => (b < 0 ? 0 : b));
  return cached;
}
