; MOUSE.COM - AsmPerfect 86 的鼠标驱动
;
; 虚拟 PC 的 BIOS 里已经有一个完整的 Microsoft 兼容鼠标驱动（INT 33h），
; 它的入口在 F000:0198。但 DOS 启动时会把 INT 20h~3Fh 里自己不用的中断
; （包括 INT 33h）都指向一条 IRET，程序就以为没有鼠标驱动了。
;
; 这个程序把 INT 33h 重新指向 BIOS 里的驱动，再复位一次鼠标。
; 驱动代码在 ROM 里，所以不需要常驻内存。可以放进 AUTOEXEC.BAT，开机自动运行。
;
; 用法：MOUSE        安装
;       MOUSE /U     卸载（INT 33h 改回 IRET）

        .model tiny
        .code
        org 100h

BIOS_SEG    equ 0F000h
BIOS_INT33  equ 33h * 8           ; BIOS 里 INT 33h 桩代码的偏移：0198h

start:
        ; 检查是不是在 AsmPerfect 86 上：BIOS 的桩代码应该是 F1 33 CF（陷阱指令 + IRET）
        mov ax, BIOS_SEG
        mov es, ax
        mov di, BIOS_INT33
        cmp byte ptr es:[di], 0F1h
        jne not_here
        cmp byte ptr es:[di+1], 33h
        jne not_here

        ; 命令行里有 /U 就卸载
        mov si, 81h
scan:   lodsb
        cmp al, 0Dh
        je install
        cmp al, '/'
        jne scan
        lodsb
        or al, 20h              ; 转成小写
        cmp al, 'u'
        je uninstall
        jmp scan

install:
        mov ax, 3533h           ; 读 INT 33h 现在的向量 -> ES:BX
        int 21h
        mov ax, es
        cmp ax, BIOS_SEG
        jne set_vec
        cmp bx, BIOS_INT33
        jne set_vec
        mov dx, offset msg_already
        jmp show

set_vec:
        push ds
        mov ax, BIOS_SEG
        mov ds, ax
        mov dx, BIOS_INT33
        mov ax, 2533h           ; INT 33h -> F000:0198
        int 21h
        pop ds
        xor ax, ax              ; 复位鼠标：AX = FFFFh 表示有鼠标，BX = 键数
        int 33h
        cmp ax, 0FFFFh
        jne not_here
        mov dx, offset msg_ok
        jmp show

uninstall:
        ; INT 33h 改指向一条 IRET：程序退出后自己的内存会被别的程序覆盖，
        ; 所以用 BIOS 桩代码最后的那条 IRET（F000:019A）
        push ds
        mov ax, BIOS_SEG
        mov ds, ax
        mov dx, BIOS_INT33 + 2
        mov ax, 2533h
        int 21h
        pop ds
        mov dx, offset msg_removed
        jmp show

not_here:
        mov dx, offset msg_fail
        mov ah, 9
        int 21h
        mov ax, 4C01h
        int 21h

show:   mov ah, 9
        int 21h
        mov ax, 4C00h
        int 21h


msg_ok      db 'AsmPerfect 86 Mouse Driver installed (INT 33h, Microsoft compatible, 2 buttons)', 13, 10, '$'
msg_already db 'AsmPerfect 86 Mouse Driver is already installed', 13, 10, '$'
msg_removed db 'AsmPerfect 86 Mouse Driver removed', 13, 10, '$'
msg_fail    db 'This mouse driver only works on the AsmPerfect 86 virtual PC', 13, 10, '$'

        end start
