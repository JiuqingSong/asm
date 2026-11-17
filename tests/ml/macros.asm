; 宏、LOCAL、REPT、IRP、条件汇编
.model small
.stack
DEBUG = 1
print macro msg
        mov dx, offset msg
        mov ah, 9
        int 21h
endm
delay macro n
        local again
        mov cx, n
again:  loop again
endm
pushall macro
        irp r, <ax, bx, cx, dx>
        push r
        endm
endm
.data
m1 db 'one$'
m2 db 'two$'
tbl label byte
        rept 4
        db 0AAh
        endm
.code
start:  mov ax, @data
        mov ds, ax
        print m1
        print m2
        delay 10
        delay 20
        pushall
if DEBUG
        nop
else
        hlt
endif
ifdef UNDEFINED_SYM
        int 3
endif
        irpc x, 123
        mov al, x
        endm
        mov ah, 4ch
        int 21h
end start
