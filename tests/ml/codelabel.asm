.model small
.stack 100h
.code
start:
 mov ax, retadd
 mov bx, offset retadd
 push ax
 jmp start
retadd:
 mov ah, 4ch
 int 21h
end start
