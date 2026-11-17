.model tiny
.code
        org 100h
start:  jmp go
msg     db 'tiny$'
go:     mov dx, offset msg
        mov ah, 9
        int 21h
        ret
end start
