; COM 程序
code segment
        assume cs:code, ds:code
        org 100h
start:  mov dx, offset msg
        mov ah, 9
        int 21h
        mov ax, 4c00h
        int 21h
msg     db 'Hello COM$'
code ends
        end start
