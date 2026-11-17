// 示例程序

export interface Example { id: string; title: string; source: string; input?: string; /** 双机示例：两台机器装载同一个程序 */ pair?: boolean }

export const EXAMPLES: Example[] = [
  {
    id: 'hello',
    title: 'Hello World（简化段）',
    source: `; 最简单的 DOS 程序：显示一行字
; 提示：按 F11 单步执行，观察右边寄存器的变化

.model small
.stack 100h

.data
msg     db  'Hello, 8086!', 0dh, 0ah, '$'   ; 0dh 0ah 是回车换行，$ 是结束符

.code
start:
        mov ax, @data       ; 数据段的段地址
        mov ds, ax          ; 不能把立即数直接送进 DS，要经过 AX 中转

        mov dx, offset msg  ; DS:DX 指向字符串
        mov ah, 9           ; 9 号功能：显示字符串
        int 21h

        mov ax, 4c00h       ; 4Ch 号功能：结束程序，返回码 0
        int 21h
end start
`,
  },
  {
    id: 'fullseg',
    title: 'Hello World（完整段定义）',
    source: `; 老教材里常见的完整段定义写法

DATA SEGMENT
    MSG DB 'Hello from full segments!', 0DH, 0AH, '$'
DATA ENDS

STACK1 SEGMENT STACK
    DW 64 DUP(0)
STACK1 ENDS

CODE SEGMENT
    ASSUME CS:CODE, DS:DATA, SS:STACK1
START:
    MOV AX, DATA        ; 段名代表段地址
    MOV DS, AX

    LEA DX, MSG         ; LEA 和 MOV DX, OFFSET MSG 效果相同
    MOV AH, 9
    INT 21H

    MOV AH, 4CH
    INT 21H
CODE ENDS
    END START
`,
  },
  {
    id: 'sum',
    title: '循环求和并显示十进制数',
    source: `; 计算 1+2+...+100，并以十进制显示结果
; 观察 LOOP 指令怎样让 CX 递减；在子程序 printnum 里观察栈的变化

.model small
.stack 100h

.code
start:
        mov cx, 100         ; 循环次数
        xor ax, ax          ; AX 清零（比 MOV AX,0 短）
again:
        add ax, cx
        loop again          ; CX 减 1，不为 0 就跳回 again

        call printnum       ; AX = 5050

        mov ah, 4ch
        int 21h

; 以十进制显示 AX 中的无符号数
; 方法：反复除以 10，把余数压栈，再依次弹出显示
printnum proc
        mov bx, 10
        xor cx, cx          ; CX 统计位数
divide:
        xor dx, dx          ; 被除数是 DX:AX，高位清零
        div bx              ; AX = 商，DX = 余数
        push dx             ; 余数入栈
        inc cx
        test ax, ax
        jnz divide
show:
        pop dx
        add dl, '0'         ; 数字变成 ASCII 字符
        mov ah, 2
        int 21h
        loop show
        ret
printnum endp

end start
`,
  },
  {
    id: 'stack',
    title: '子程序与栈',
    source: `; 观察 PUSH / POP / CALL / RET 时栈的变化
; 建议：把速度调到"每秒 5 步"，然后点运行，盯着右边的"栈"看

.model small
.stack 100h

.code
start:
        mov ax, 1111h
        mov bx, 2222h
        push ax             ; SP 减 2，1111h 写入栈顶
        push bx             ; 2222h 在更低的地址
        call swap           ; 返回地址也被压入栈中
        pop bx              ; 后进先出
        pop ax

        mov cx, 3
        call fact           ; 递归计算 3 的阶乘
        ; 结果在 AX 中：6

        mov ah, 4ch
        int 21h

; 交换栈中的两个参数（用 BP 访问栈）
swap    proc
        push bp
        mov bp, sp          ; [bp+2] 是返回地址，[bp+4] 和 [bp+6] 是参数
        mov ax, [bp+4]
        xchg ax, [bp+6]
        mov [bp+4], ax
        pop bp
        ret
swap    endp

; 递归求 CX 的阶乘，结果放在 AX
fact    proc
        cmp cx, 1
        ja recurse
        mov ax, 1
        ret
recurse:
        push cx
        dec cx
        call fact           ; 每递归一层，栈中多一个返回地址和一个 CX
        pop cx
        mul cx              ; AX = AX * CX
        ret
fact    endp

end start
`,
  },
  {
    id: 'input',
    title: '键盘输入：转换成大写',
    input: 'Hello asm\r',
    source: `; 读入一行文字，把小写字母转换成大写后显示
; 运行后点击下面的 DOS 屏幕，输入一行字，按回车

.model small
.stack 100h

.data
prompt  db  'Please type a line: $'
buf     db  60          ; 最多输入 59 个字符
len     db  ?           ; DOS 填入实际长度
text    db  60 dup(?)
crlf    db  0dh, 0ah, '$'

.code
start:
        mov ax, @data
        mov ds, ax

        mov dx, offset prompt
        mov ah, 9
        int 21h

        mov dx, offset buf
        mov ah, 0ah         ; 0Ah 号功能：行输入
        int 21h

        mov dx, offset crlf
        mov ah, 9
        int 21h

        mov cl, len
        xor ch, ch
        jcxz done
        mov si, offset text
convert:
        mov al, [si]
        cmp al, 'a'
        jb next
        cmp al, 'z'
        ja next
        sub al, 20h         ; 小写字母减 20h 就是大写
        mov [si], al
next:
        inc si
        loop convert

        mov byte ptr [si], '$'
        mov dx, offset text
        mov ah, 9
        int 21h
done:
        mov ah, 4ch
        int 21h
end start
`,
  },
  {
    id: 'sort',
    title: '冒泡排序',
    source: `; 对内存中的数组做冒泡排序
; 在右下角"变量"页可以看到 arr 的内容一步步变化

.model small
.stack 100h

.data
arr     dw  37, 5, 91, 12, 64, 3, 28, 50
n       equ ($ - arr) / 2       ; 元素个数（每个元素 2 字节）

.code
start:
        mov ax, @data
        mov ds, ax

        mov cx, n - 1           ; 外层循环 n-1 趟
outer:
        push cx
        mov si, offset arr
inner:
        mov ax, [si]
        cmp ax, [si+2]
        jbe noswap              ; 已经有序就不交换
        xchg ax, [si+2]
        mov [si], ax
noswap:
        add si, 2
        loop inner
        pop cx
        loop outer

        mov ah, 4ch
        int 21h
end start
`,
  },
  {
    id: 'reverse',
    title: '用栈反转字符串',
    source: `; 利用栈"后进先出"的特点反转字符串

.model small
.stack 100h

.data
src     db  'ABCDEFG'
len     equ $ - src
dst     db  len dup(?), '$'

.code
start:
        mov ax, @data
        mov ds, ax

        mov cx, len
        mov si, offset src
pushloop:
        mov al, [si]
        push ax             ; 栈只能按字操作，AL 跟着 AX 一起入栈
        inc si
        loop pushloop

        mov cx, len
        mov di, offset dst
poploop:
        pop ax
        mov [di], al
        inc di
        loop poploop

        mov dx, offset dst
        mov ah, 9
        int 21h             ; 显示 GFEDCBA

        mov ah, 4ch
        int 21h
end start
`,
  },
  {
    id: 'video',
    title: '直接写显存（彩色文字）',
    source: `; 文本模式的显存从 B800:0000 开始，每个字符占 2 字节：字符 + 属性
; 属性字节：高 4 位是背景色，低 4 位是前景色

.model small
.stack 100h

.data
msg     db  'Direct video memory!'
len     equ $ - msg

.code
start:
        mov ax, @data
        mov ds, ax
        mov ax, 0b800h
        mov es, ax              ; ES 指向显存

        mov ax, 3               ; 先清屏
        int 10h

        mov di, (5 * 80 + 30) * 2   ; 第 5 行第 30 列
        mov si, offset msg
        mov cx, len
        mov ah, 1Eh             ; 蓝底黄字
next:
        lodsb                   ; AL ← DS:[SI]，SI 加 1
        stosw                   ; ES:[DI] ← AX（字符 + 属性），DI 加 2
        inc ah                  ; 每个字符换一种颜色
        and ah, 7Fh
        loop next

        mov ah, 4ch
        int 21h
end start
`,
  },
  {
    id: 'timer',
    title: '时钟中断（INT 1Ch）',
    source: `; 挂接 INT 1Ch：定时器每秒中断约 18.2 次，BIOS 每次都会调用 INT 1Ch
; 主程序只是在循环里等待；计数是在中断处理程序里完成的
; 试试在 tick 过程里设一个断点，看看"主程序被打断"是什么样子

.model small
.stack 100h

.data
count   dw  0
oldvec  dd  ?

.code
start:
        mov ax, @data
        mov ds, ax

        mov ax, 351ch           ; 取原来的中断向量，保存起来
        int 21h
        mov word ptr oldvec, bx
        mov word ptr oldvec+2, es

        push ds
        mov dx, offset tick
        mov ax, seg tick
        mov ds, ax
        mov ax, 251ch           ; 设置新的中断向量
        int 21h
        pop ds

waitloop:
        mov ax, count
        cmp ax, 91              ; 91 次约 5 秒（模拟器里的时间）
        jb waitloop

        push ds
        lds dx, oldvec          ; 恢复原来的中断向量
        mov ax, 251ch
        int 21h
        pop ds

        mov ah, 4ch
        int 21h

; 中断处理程序：必须保护用到的寄存器，用 IRET 返回
tick    proc far
        push ax
        push ds
        mov ax, @data
        mov ds, ax
        inc count
        test count, 15          ; 每 16 次显示一个点
        jnz skip
        mov al, '.'
        mov ah, 0eh
        int 10h
skip:
        pop ds
        pop ax
        iret
tick    endp

end start
`,
  },
  {
    id: 'keyboard',
    title: '键盘中断（INT 9，读端口 60h）',
    source: `; 自己接管键盘中断：直接从端口 60h 读扫描码，以十六进制显示
; 按下和松开都会产生中断（松开的扫描码最高位为 1）；按 Esc 退出
; 运行后点击 DOS 屏幕再按键

.model small
.stack 100h

.data
oldvec  dd  ?
scan    db  0
hex     db  '0123456789ABCDEF'

.code
start:
        mov ax, @data
        mov ds, ax
        xor ax, ax
        mov es, ax              ; ES = 0，指向中断向量表

        cli                     ; 修改中断向量时先关中断
        mov ax, es:[9*4]        ; 保存原来的 INT 9 向量
        mov word ptr oldvec, ax
        mov ax, es:[9*4+2]
        mov word ptr oldvec+2, ax
        mov word ptr es:[9*4], offset kbd
        mov es:[9*4+2], cs
        sti

waitkey:
        cmp scan, 0
        je waitkey
        mov al, scan
        mov scan, 0
        cmp al, 1               ; Esc 的扫描码是 01h
        je quit
        call showhex
        jmp waitkey

quit:
        cli                     ; 恢复原来的中断向量
        mov ax, word ptr oldvec
        mov es:[9*4], ax
        mov ax, word ptr oldvec+2
        mov es:[9*4+2], ax
        sti
        mov ah, 4ch
        int 21h

; 显示 AL 的十六进制值和一个空格
showhex proc
        mov bx, offset hex
        push ax
        shr al, 1
        shr al, 1
        shr al, 1
        shr al, 1
        xlat                    ; AL ← [BX+AL]
        mov ah, 0eh
        int 10h
        pop ax
        and al, 0fh
        xlat
        mov ah, 0eh
        int 10h
        mov al, ' '
        int 10h
        ret
showhex endp

; 键盘中断处理程序
kbd:
        push ax
        push ds
        mov ax, @data
        mov ds, ax
        in al, 60h              ; 读扫描码
        mov scan, al
        mov al, 20h             ; 向 8259 发中断结束命令（EOI）
        out 20h, al
        pop ds
        pop ax
        iret

end start
`,
  },
  {
    id: 'music',
    title: 'PC 喇叭：两只老虎',
    source: `; 用 PC 喇叭演奏《两只老虎》
; 请把速度选成"原机速度"再运行，否则会一闪而过
;
; 原理：8253 定时器的 2 号通道产生方波，频率 = 1193182 / 分频值；
;       端口 61h 的位 0（打开 2 号通道）和位 1（接通喇叭）都为 1 时，喇叭就按这个频率响

.model small
.stack 100h

.data
msg     db  'Playing "Two Tigers" ...', 0dh, 0ah, '$'
; 每个音符两个字：分频值（1193182 / 频率）、时长（时钟滴答数，每秒约 18.2 个）
; C=4554(262Hz) D=4058 E=3616 F=3419 G=3044 A=2712 低音G=6088
song    dw  4554,4, 4058,4, 3616,4, 4554,4      ; 两只老虎
        dw  4554,4, 4058,4, 3616,4, 4554,4      ; 两只老虎
        dw  3616,4, 3419,4, 3044,8              ; 跑得快
        dw  3616,4, 3419,4, 3044,8              ; 跑得快
        dw  3044,2, 2712,2, 3044,2, 3419,2, 3616,4, 4554,4  ; 一只没有眼睛
        dw  3044,2, 2712,2, 3044,2, 3419,2, 3616,4, 4554,4  ; 一只没有尾巴
        dw  4554,4, 6088,4, 4554,8              ; 真奇怪
        dw  4554,4, 6088,4, 4554,8              ; 真奇怪
        dw  0                                   ; 结束

.code
start:
        mov ax, @data
        mov ds, ax
        mov dx, offset msg
        mov ah, 9
        int 21h

        mov al, 0B6h            ; 2 号通道，先写低字节再写高字节，方式 3（方波）
        out 43h, al
        mov si, offset song
next:
        mov ax, [si]            ; 分频值
        or ax, ax
        jz done
        out 42h, al             ; 低字节
        mov al, ah
        out 42h, al             ; 高字节

        in al, 61h
        or al, 3                ; 打开喇叭
        out 61h, al
        mov di, [si+2]
        dec di                  ; 留一个滴答做音符之间的停顿
        call delay

        in al, 61h
        and al, 0FCh            ; 关掉喇叭
        out 61h, al
        mov di, 1
        call delay

        add si, 4
        jmp next
done:
        mov ax, 4c00h
        int 21h

; 等待 DI 个时钟滴答：反复用 INT 1Ah 读 BIOS 的滴答计数
; （INT 1Ah 会改写 CX、DX，所以次数放在 DI 里）
delay   proc
        mov ah, 0
        int 1Ah
        mov bx, dx              ; 开始时的计数
wait1:
        mov ah, 0
        int 1Ah
        mov ax, dx
        sub ax, bx
        cmp ax, di
        jb wait1
        ret
delay   endp

end start
`,
  },
  {
    id: 'vga',
    title: 'VGA 256 色（13h 模式）',
    input: 'xx',
    source: `; VGA 的 13h 模式：320×200 像素，256 种颜色，每个像素占一个字节
; 显存从 A000:0000 开始，第 y 行第 x 列的像素在偏移 y*320+x 处
; 先画出 256 种颜色的色块，按一个键后让调色板"转"起来，再按一个键退出

.model small
.stack 200h

.data
title1  db  'VGA 256 colors, press a key$'

.code
start:
        mov ax, @data
        mov ds, ax
        mov ax, 0013h           ; 切换到 320x200 256 色模式
        int 10h
        mov ax, 0A000h
        mov es, ax              ; ES 指向显存
        cld

; 画 16×16 个色块：颜色 n 的色块在第 n/16 行、第 n mod 16 列
        xor bx, bx              ; BX = 颜色号
block:
        mov ax, bx
        and ax, 0Fh
        mov cl, 20
        mul cl                  ; x = 列 × 20
        mov di, ax
        mov ax, bx
        mov cl, 4
        shr ax, cl
        mov cl, 11
        mul cl
        add ax, 16              ; y = 行 × 11 + 16（上面留出标题的位置）
        mov dx, 320
        mul dx                  ; AX = y × 320
        add di, ax              ; DI = 色块左上角
        mov dx, 10              ; 色块高 10 像素
row:
        mov cx, 19              ; 宽 19 像素
        mov al, bl
        rep stosb               ; 一次画一行
        add di, 320 - 19
        dec dx
        jnz row
        inc bx
        cmp bx, 256
        jb block

        mov dx, offset title1   ; 图形模式下 BIOS 也能显示文字
        mov ah, 9
        int 21h
        mov ah, 0               ; 等待按键
        int 16h

; 调色板轮转：把 32~247 号颜色依次往前挪一个位置
; 端口 3C7h 设"读"的起始颜色号，3C8h 设"写"的起始颜色号，3C9h 依次读写红、绿、蓝（各 0~63）
rotate:
        mov al, 32              ; 先保存 32 号颜色
        mov dx, 3C7h
        out dx, al
        mov dx, 3C9h
        in al, dx
        mov bl, al
        in al, dx
        mov bh, al
        in al, dx
        mov ah, al
        push ax
        push bx

        mov cx, 215             ; 33~247 号依次往前挪：i+1 -> i
        mov si, 32
shift:
        mov ax, si
        inc ax
        mov dx, 3C7h
        out dx, al              ; 读 i+1 号
        mov dx, 3C9h
        in al, dx
        mov bl, al
        in al, dx
        mov bh, al
        in al, dx
        mov ah, al
        push ax
        mov ax, si
        mov dx, 3C8h
        out dx, al              ; 写 i 号
        pop ax
        mov dx, 3C9h
        mov al, bl
        out dx, al
        mov al, bh
        out dx, al
        mov al, ah
        out dx, al
        inc si
        loop shift

        mov al, 247             ; 原来的 32 号放到 247 号
        mov dx, 3C8h
        out dx, al
        pop bx
        pop ax
        mov dx, 3C9h
        mov al, bl
        out dx, al
        mov al, bh
        out dx, al
        mov al, ah
        out dx, al

        mov ah, 0               ; 等一个时钟滴答（约 1/18 秒）
        int 1Ah
        mov bx, dx
tick:
        mov ah, 0
        int 1Ah
        cmp dx, bx
        je tick

        mov ah, 1               ; 有按键就退出
        int 16h
        jz rotate
        mov ah, 0
        int 16h

        mov ax, 0003h           ; 回到文本模式
        int 10h
        mov ax, 4c00h
        int 21h
end start
`,
  },
  {
    id: 'lines',
    title: '画线（Bresenham 算法）',
    input: 'x',
    source: `; 从屏幕中心向四周画线：Bresenham 直线算法，只用整数加减法
; 每个点用 BIOS 的写像素功能 INT 10h AH=0Ch 画出（CX=x，DX=y，AL=颜色）
; 选"原机速度"运行，可以看到线一条一条画出来；按一个键退出

.model small
.stack 200h

.data
x0      dw  160             ; 起点：屏幕中心
y0      dw  100
x1      dw  ?               ; 终点
y1      dw  ?
ddx     dw  ?               ; |x1 - x0|
ddy     dw  ?               ; -|y1 - y0|
sx      dw  ?               ; x 方向的步长：+1 或 -1
sy      dw  ?
err     dw  ?
color   db  32

.code
start:
        mov ax, @data
        mov ds, ax
        mov ax, 0013h           ; 320x200 256 色
        int 10h

        mov x1, 0               ; 上下两条边上的终点
edges1:
        mov y1, 0
        call line
        mov y1, 199
        call line
        add x1, 8
        cmp x1, 320
        jb edges1

        mov y1, 0               ; 左右两条边上的终点
edges2:
        mov x1, 0
        call line
        mov x1, 319
        call line
        add y1, 8
        cmp y1, 200
        jb edges2

        mov ah, 0               ; 等待按键
        int 16h
        mov ax, 0003h           ; 回到文本模式
        int 10h
        mov ax, 4c00h
        int 21h

; 从 (x0,y0) 画到 (x1,y1)；每画一条换一种颜色
line    proc
        mov ax, x1
        sub ax, x0
        mov sx, 1
        jge l1
        neg ax
        mov sx, -1
l1:     mov ddx, ax             ; ddx = |x1-x0|
        mov ax, y1
        sub ax, y0
        mov sy, 1
        jge l2
        neg ax
        mov sy, -1
l2:     neg ax
        mov ddy, ax             ; ddy = -|y1-y0|
        add ax, ddx
        mov err, ax             ; err = ddx + ddy
        mov cx, x0
        mov dx, y0
plot:
        mov al, color
        mov ah, 0Ch             ; 写像素
        mov bh, 0
        int 10h
        cmp cx, x1
        jne step
        cmp dx, y1
        je done
step:
        mov ax, err
        shl ax, 1               ; e2 = 2*err
        cmp ax, ddy
        jl nox                  ; e2 >= ddy 时：x 走一步
        mov bx, ddy
        add err, bx
        add cx, sx
nox:
        cmp ax, ddx
        jg plot                 ; e2 <= ddx 时：y 走一步
        mov bx, ddx
        add err, bx
        add dx, sy
        jmp plot
done:
        inc color               ; 下一条线换个颜色（在 32~103 的色环里循环）
        cmp color, 104
        jb ok
        mov color, 32
ok:     ret
line    endp

end start
`,
  },
  {
    id: 'chat',
    title: '串口聊天（双机）',
    pair: true,
    source: `; 串口聊天：两台机器运行同一个程序，用串口线连接
; 在一台机器的屏幕上打字，字会出现在另一台机器的屏幕上；按 Esc 退出
; 用查询方式操作 8250：发送前等 THRE（发送保持寄存器空），有 DR（收到数据）才读

.model small
.stack 100h

COM1    equ 3F8h            ; COM1 的基地址
LSR     equ COM1 + 5        ; 线路状态寄存器
LCR     equ COM1 + 3        ; 线路控制寄存器
MCR     equ COM1 + 4        ; 调制解调器控制寄存器

.data
hello   db  'Serial chat (9600 bps, 8N1). Type here, Esc to quit.', 0dh, 0ah, '$'

.code
start:
        mov ax, @data
        mov ds, ax
        mov dx, offset hello
        mov ah, 9
        int 21h

        ; 初始化 8250：9600 bps，8 位数据，无校验，1 位停止
        mov dx, LCR
        mov al, 80h             ; DLAB=1，接下来写除数
        out dx, al
        mov dx, COM1
        mov al, 12              ; 115200 / 9600 = 12
        out dx, al
        inc dx
        mov al, 0
        out dx, al
        mov dx, LCR
        mov al, 03h             ; DLAB=0，8N1
        out dx, al
        mov dx, MCR
        mov al, 03h             ; DTR=1，RTS=1
        out dx, al

mainloop:
        ; 1. 收到数据了吗？
        mov dx, LSR
        in al, dx
        test al, 01h            ; DR 位
        jz checkkey
        mov dx, COM1
        in al, dx               ; 读出收到的字符
        call show

checkkey:
        ; 2. 键盘上有按键吗？
        mov ah, 1
        int 16h
        jz mainloop             ; ZF=1 表示没有按键
        mov ah, 0
        int 16h                 ; 取出按键，AL = ASCII
        cmp al, 27              ; Esc
        je quit
        push ax
        call show               ; 本机也显示一下
        pop ax

        ; 3. 发送：等发送保持寄存器空了再写
        mov ah, al
        mov dx, LSR
waitthr:
        in al, dx
        test al, 20h            ; THRE 位
        jz waitthr
        mov al, ah
        mov dx, COM1
        out dx, al
        jmp mainloop

quit:
        mov ax, 4c00h
        int 21h

; 显示 AL 中的字符，回车后自动换行
show    proc
        mov ah, 0eh
        int 10h
        cmp al, 0dh
        jne done
        mov al, 0ah
        int 10h
done:
        ret
show    endp

end start
`,
  },
  {
    id: 'blank-small',
    title: '空白模板（简化段）',
    source: `.model small
.stack 100h

.data
        ; 在这里定义变量

.code
start:
        mov ax, @data
        mov ds, ax

        ; 在这里写代码

        mov ax, 4c00h
        int 21h
end start
`,
  },
  {
    id: 'blank-full',
    title: '空白模板（完整段定义）',
    source: `DATA SEGMENT
        ; 在这里定义变量
DATA ENDS

STACK1 SEGMENT STACK
        DW 128 DUP(0)
STACK1 ENDS

CODE SEGMENT
        ASSUME CS:CODE, DS:DATA, SS:STACK1
START:
        MOV AX, DATA
        MOV DS, AX

        ; 在这里写代码

        MOV AH, 4CH
        INT 21H
CODE ENDS
        END START
`,
  },
];
