; 跳转：短/近/远，向前/向后，条件跳转扩展
.model small
.stack 100h
.code
start:
back1:  nop
        jmp back1
        jmp short fwd1
        jmp fwd1
        jz back1
        jnz fwd1
        loop back1
        jcxz fwd1
fwd1:   jmp near ptr fwd1
        call sub1
        call far ptr sub2
        call sub2
        call bx
        call word ptr [bx]
        call dword ptr [bx]
        jmp bx
        jmp word ptr [si]
        jmp dword ptr [si]
        je far1
        db 200 dup(90h)
far1:   jne start
        ja start
        jmp start
        jmp far ptr start
sub1    proc
        ret
        ret 4
sub1    endp
sub2    proc far
        ret
        retn
        retf 2
sub2    endp
        mov ah, 4ch
        int 21h
end start
