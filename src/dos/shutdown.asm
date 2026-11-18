; SHUTDOWN.COM - 把磁盘缓冲区写回磁盘，然后关机
;
; 1. INT 21h AH=0Dh：DOS 把缓冲区里还没写的数据写进磁盘
; 2. INT 2Fh AX=4A10h BX=0001h：SMARTDRV 把写缓存写进磁盘（没有装 SMARTDRV 时什么也不做）
; 3. 通过 APM（高级电源管理，INT 15h AX=53xxh）关闭电源
;
; 在有 APM 的真机上也能用。

        .model tiny
        .code
        org 100h

start:
        mov dx, offset msg_flush
        mov ah, 9
        int 21h
        mov ah, 0Dh             ; DOS：写回磁盘缓冲区
        int 21h
        mov ax, 4A10h           ; SMARTDRV：写回写缓存
        mov bx, 0001h
        int 2Fh

        mov ax, 5300h           ; APM：有没有？
        xor bx, bx
        int 15h
        jc no_apm
        cmp bx, 504Dh           ; 'PM'
        jne no_apm
        mov ax, 5301h           ; 连接实模式接口
        xor bx, bx
        int 15h
        mov ax, 530Eh           ; 告诉 APM 我们用 1.2 版的接口
        xor bx, bx
        mov cx, 0102h
        int 15h
        mov dx, offset msg_off
        mov ah, 9
        int 21h
        mov ax, 5307h           ; 设置电源状态：所有设备（BX=1），关机（CX=3）
        mov bx, 0001h
        mov cx, 0003h
        int 15h

no_apm:
        mov dx, offset msg_fail
        mov ah, 9
        int 21h
        mov ax, 4C01h
        int 21h

msg_flush db 'Writing disk buffers...', 13, 10, '$'
msg_off   db 'Power off.', 13, 10, '$'
msg_fail  db 'This computer cannot be turned off by software (no APM).', 13, 10
          db 'It is now safe to turn off your computer.', 13, 10, '$'

        end start
