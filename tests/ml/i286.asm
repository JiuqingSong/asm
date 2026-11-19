; 80186 / 80286 指令：和 MASM 6.11 逐字节对照（node tools/ml-compare.ts tests/ml/i286.asm）
.286P
.MODEL SMALL
.STACK 100h
.DATA
v    DW 0
buf  DB 16 DUP (0)
bnd  DW 0, 100
gdt  DW 0, 0, 0
     DW 0
.CODE
start:
    mov ax, @data
    mov ds, ax
; ---- 80186 ----
    pusha
    popa
    push 5
    push -1
    push 7Fh
    push -128
    push -129
    push 80h
    push 1234h
    push 0FFFFh
    push 0FF80h
    push OFFSET v
    push SEG v
    push @data
    imul ax, bx, 10
    imul ax, bx, 1000
    imul ax, bx, 0FFFFh
    imul ax, bx, 0FF80h
    imul ax, bx, 80h
    imul ax, bx, -128
    imul cx, 3
    imul dx, v, -2
    imul si, [bx+di+4], 300
    imul di, es:[bp+2], 7
    shl ax, 4
    shl ax, 1
    shl ax, 0
    shl ax, 31
    shr al, 1
    shr al, 4
    sar byte ptr buf, 3
    rol v, 7
    rcr cl, 2
    rcl word ptr [bx+si], 9
    sal dx, 2
    enter 8, 0
    enter 100h, 2
    enter 0, 0
    leave
    bound ax, bnd
    bound si, [bx]
    insb
    insw
    outsb
    outsw
    rep insw
    rep outsb
    ins byte ptr es:[di], dx
    ins word ptr es:[di], dx
    outs dx, byte ptr [si]
    outs dx, word ptr [si]
    outs dx, word ptr es:[si]
; ---- 80286 ----
    arpl v, ax
    arpl bx, cx
    lar ax, bx
    lar dx, v
    lsl cx, v
    lsl si, di
    verr ax
    verw v
    smsw ax
    smsw v
    str bx
    str v
    sldt v
    sldt dx
    sgdt buf
    sidt buf
    sgdt [bx]
; ---- 80286 特权指令（.286P） ----
    clts
    lmsw ax
    lmsw v
    lgdt fword ptr gdt
    lidt fword ptr [bx+2]
    lldt ax
    lldt v
    ltr v
    ltr cx
    mov ax, 4C00h
    int 21h
END start
