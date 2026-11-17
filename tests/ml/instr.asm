; 各种指令形式
.model small
.stack 200h
.data
bvar    db 12h
wvar    dw 3456h
dvar    dd 12345678h
arr     dw 10 dup(0)
farp    dd start
msg     db 'Hello', 0dh, 0ah, '$'
.code
start:
        mov ax, @data
        mov ds, ax
        add ax, 5
        add ax, 1234h
        add al, 5
        add bx, 5
        add bx, 1234h
        add bx, -1
        and ax, 0FFFEh
        and bx, 0FFFEh
        sub cx, dx
        adc ax, bx
        sbb al, ah
        cmp si, di
        xor ax, ax
        or bvar, 80h
        or wvar, 80h
        or wvar, 8000h
        add bvar, al
        add al, bvar
        add wvar, bx
        add bx, wvar
        cmp byte ptr [bx], 0
        cmp word ptr [bx+si+2], 1
        cmp byte ptr [bp-2], 7Fh
        mov ax, bx
        mov al, bl
        mov ax, wvar
        mov wvar, ax
        mov al, bvar
        mov bvar, al
        mov bx, wvar
        mov wvar, bx
        mov ax, [bx]
        mov ax, [bp]
        mov ax, [si]
        mov ax, [di+4]
        mov ax, [bx+si]
        mov ax, [bp+di+1000h]
        mov ax, arr[si]
        mov ax, arr[bx+di+2]
        mov ax, es:[bx]
        mov ax, ds:[bx]
        mov ax, ss:[bp]
        mov ax, cs:[bx]
        mov ax, es:wvar
        mov al, es:[80h]
        mov ax, ds:[1234h]
        mov word ptr [bx], 1234h
        mov byte ptr [bx], 12h
        mov wvar, 5
        mov bvar, 5
        mov ax, 1234h
        mov bl, 12h
        mov ds, ax
        mov es, wvar
        mov ax, cs
        mov wvar, ds
        mov ax, offset msg
        mov dx, offset msg + 2
        lea dx, msg
        lea bx, [bx+si+4]
        lds si, dvar
        les di, dvar
        xchg ax, bx
        xchg bx, ax
        xchg cx, dx
        xchg al, ah
        xchg wvar, ax
        xchg ax, wvar
        test al, 1
        test ax, 1
        test bl, 1
        test bvar, 1
        test ax, bx
        test bvar, al
        inc ax
        inc al
        inc bvar
        inc wvar
        dec si
        dec byte ptr [bx]
        push ax
        push ds
        push cs
        push wvar
        push word ptr [bx]
        pop ax
        pop es
        pop wvar
        pushf
        popf
        not ax
        neg bvar
        mul bl
        mul wvar
        imul cx
        div byte ptr [si]
        idiv bx
        shl ax, 1
        shl ax, cl
        shr bvar, 1
        sar word ptr [bx], cl
        rol al, 1
        ror wvar, cl
        rcl dx, 1
        rcr bl, cl
        sal ax, 1
        in al, 60h
        in ax, 40h
        in al, dx
        in ax, dx
        out 61h, al
        out dx, al
        out dx, ax
        int 21h
        int 3
        into
        cbw
        cwd
        aaa
        aas
        aam
        aad
        daa
        das
        clc
        stc
        cmc
        cld
        std
        cli
        sti
        lahf
        sahf
        nop
        xlat
        rep movsb
        rep movsw
        repe cmpsb
        repne scasw
        rep stosb
        lodsw
        movs word ptr es:[di], word ptr [si]
        lods byte ptr es:[si]
        hlt
        mov ah, 4ch
        int 21h
end start
