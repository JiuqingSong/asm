// 磁盘映像面板（"虚拟磁盘"页上半部分）：软驱 A:、B:，硬盘 C:；插入/取出/新建/下载映像，从磁盘启动。
// 映像保存在浏览器的 IndexedDB 里，刷新页面后还在（硬盘上装好的 DOS 不会丢）。
import type { Machine } from '../machine/machine.ts';
import { Disk, blankHardDisk, blankFloppy, isFloppySize } from '../machine/disk.ts';
import { FatVolume } from '../machine/fat.ts';
import { UTILITIES, buildUtility } from '../dos/utilities.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const LETTERS = ['A:', 'B:', 'C:'];

// ----- IndexedDB：每台机器每个驱动器一条记录 -----
const DB = 'asm86-disks', STORE = 'drives';
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value === null) tx.objectStore(STORE).delete(key); else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function dbGet(key: string): Promise<{ name: string; floppy: boolean; data: Uint8Array } | undefined> {
  const db = await openDb();
  const v = await new Promise<unknown>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return v as { name: string; floppy: boolean; data: Uint8Array } | undefined;
}

export interface DriveHost {
  machines(): { m: Machine; tag: string; i: number }[];
  dual(): boolean;
  boot(i: number, drive: number): void;
  message(kind: 'ok' | 'error', text: string, i: number): void;
}

export class DrivesPanel {
  private el: HTMLElement;
  private input: HTMLInputElement;
  private host: DriveHost;
  private target: { i: number; k: number } | null = null;
  /** 正在浏览的磁盘和目录（"\\DOS" 这样的路径，空串是根目录） */
  private browse: { i: number; k: number; path: string } | null = null;
  /** 往映像里上传文件用的文件选择框 */
  private fileInput: HTMLInputElement;
  private saveTimers = new Map<string, number>();

  constructor(el: HTMLElement, host: DriveHost) {
    this.el = el; this.host = host;
    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.accept = '.img,.ima,.vfd,.dsk,.bin';
    this.input.hidden = true;
    document.body.appendChild(this.input);
    this.input.onchange = () => this.loadFile();
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.hidden = true;
    document.body.appendChild(this.fileInput);
    this.fileInput.onchange = () => this.uploadIntoImage();
    el.addEventListener('click', e => this.action(e));
    el.addEventListener('change', e => {
      const sel = (e.target as HTMLElement).closest('select[data-act="newhd"]') as HTMLSelectElement | null;
      if (sel && sel.value) { this.newHardDisk(+sel.dataset.i!, +sel.value); sel.value = ''; }
    });
  }

  /** 页面打开时：从浏览器里恢复上次的磁盘映像 */
  async restore(): Promise<void> {
    try {
      for (const { m, i } of this.host.machines()) {
        for (let k = 0; k < 3; k++) {
          const v = await dbGet(`${i}:${k}`);
          if (v) m.drives[k] = new Disk(v.name, new Uint8Array(v.data), v.floppy);
        }
      }
    } catch { /* 浏览器不允许使用 IndexedDB：映像只保存在内存里 */ }
    this.render();
  }

  /** 映像被写过：稍后保存到浏览器（安装软件时会连续写很多次，合并成一次） */
  changed(i: number): void {
    const { m } = this.host.machines().find(x => x.i === i) ?? {};
    if (!m) return;
    for (let k = 0; k < 3; k++) {
      const d = m.drives[k];
      if (!d || !d.dirty) continue;
      const key = `${i}:${k}`;
      clearTimeout(this.saveTimers.get(key));
      this.saveTimers.set(key, window.setTimeout(() => this.persist(i, k), 2000));
    }
    this.render();
  }

  private persist(i: number, k: number): void {
    const m = this.host.machines().find(x => x.i === i)?.m;
    if (!m) return;
    const d = m.drives[k];
    dbPut(`${i}:${k}`, d ? { name: d.name, floppy: d.floppy, data: d.data } : null).catch(() => { /* 存不下就算了 */ });
  }

  private machine(i: number): Machine { return this.host.machines().find(x => x.i === i)!.m; }

  private action(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.act!.startsWith('fs-')) { this.fsAction(b); return; }
    if (!b.dataset.drive && b.dataset.act !== 'boot') return;
    const i = +b.dataset.i!, k = +(b.dataset.drive ?? 0), m = this.machine(i);
    switch (b.dataset.act) {
      case 'browse': {
        const same = this.browse && this.browse.i === i && this.browse.k === k;
        this.browse = same ? null : { i, k, path: '' };
        break;
      }
      case 'insert': this.target = { i, k }; this.input.click(); return;
      case 'eject': m.drives[k] = null; this.persist(i, k); if (this.browse?.i === i && this.browse.k === k) this.browse = null; break;
      case 'blank':
        m.drives[k] = new Disk('空白软盘.img', blankFloppy(), true);
        this.persist(i, k);
        break;
      case 'download': {
        const d = m.drives[k];
        if (!d) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([d.data.slice()]));
        a.download = /\.(img|ima|vfd|dsk)$/i.test(d.name) ? d.name : d.name + '.img';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      case 'boot': b.blur(); this.host.boot(i, +b.dataset.from!); return; // 让按钮失去焦点：否则之后按回车会再按一次"启动"
    }
    this.render();
  }

  // ======================= 映像里的文件 =======================

  private volume(): { v: FatVolume; d: Disk } | string {
    const b = this.browse;
    if (!b) return '没有选择磁盘';
    const d = this.machine(b.i).drives[b.k];
    if (!d) return '驱动器里没有磁盘';
    const v = FatVolume.open(d.data, d.floppy);
    return typeof v === 'string' ? v : { v, d };
  }

  /**
   * 修改映像里的文件。DOS 正在运行时会缓存磁盘的 FAT 表和目录，从外面改了它不知道，
   * 继续用旧的缓存分配空间会把文件写坏，所以先问一下，改完重新启动虚拟机
   */
  private modify(what: string, fn: (v: FatVolume) => string): void {
    const b = this.browse!;
    const m = this.machine(b.i);
    const booted = m.program?.format === 'boot' && m.status !== 'empty';
    if (booted && !confirm(`${what}\n\n虚拟机正在运行从磁盘启动的系统。DOS 在内存里缓存了磁盘的目录和 FAT 表，从外面修改磁盘后必须重新启动，否则 DOS 可能把文件写坏。\n\n修改后会自动重新启动虚拟机（没有保存的工作会丢失）。继续吗？`)) return;
    const vol = this.volume();
    if (typeof vol === 'string') { this.host.message('error', vol, b.i); return; }
    try {
      const msg = fn(vol.v);
      vol.d.dirty = true;
      this.persist(b.i, b.k);
      this.host.message('ok', msg, b.i);
    } catch (e) {
      this.host.message('error', (e as Error).message, b.i);
    }
    this.render();
    if (booted) this.host.boot(b.i, m.program!.bootDrive ?? 0);
  }

  private fsAction(btn: HTMLButtonElement): void {
    const b = this.browse;
    if (!b) return;
    const name = btn.dataset.name ?? '';
    const where = `${LETTERS[b.k]}\\${b.path.replace(/^\\/, '')}`;
    switch (btn.dataset.act) {
      case 'fs-enter': b.path = b.path + '\\' + name; break;
      case 'fs-up': b.path = b.path.replace(/\\[^\\]*$/, ''); break;
      case 'fs-upload': this.fileInput.click(); return;
      case 'fs-mkdir': {
        const n = prompt('新目录的名字（DOS 的 8.3 格式，例如 GAMES）：');
        if (n) this.modify(`在 ${where} 里新建目录 ${n.toUpperCase()}`, v => `在 ${where} 里新建了目录 ${v.mkdir(b.path, n)}`);
        return;
      }
      case 'fs-copy': {
        const m = this.machine(b.i);
        const list = [...m.files.entries()];
        if (!list.length) { this.host.message('error', '"文件"列表是空的', b.i); return; }
        this.modify(`把"文件"列表里的 ${list.length} 个文件复制到 ${where}`, v => {
          const names = list.map(([n, data]) => v.writeFile(b.path, n, data, new Date(m.fileTimes.get(n) ?? Date.now())));
          return `复制到 ${where}：${names.join('、')}`;
        });
        return;
      }
      case 'fs-util': {
        const u = UTILITIES.find(x => x.name === name)!;
        const bytes = buildUtility(u);
        const base = u.name.replace(/\.COM$/, '');
        // 放进 AUTOEXEC.BAT：开机时自动运行
        let auto = false;
        const vol = this.volume();
        if (typeof vol !== 'string' && b.k === 2 && vol.v.list('').some(e => e.name === 'AUTOEXEC.BAT')) {
          const text = new TextDecoder('latin1').decode(vol.v.readFile('', 'AUTOEXEC.BAT'));
          if (!new RegExp(`(^|[\\\\\\s])${base}(\\.COM)?\\s*$`, 'im').test(text)) auto = confirm(`把 ${u.name} 放进 ${where} 后，要不要同时加到 C:\\AUTOEXEC.BAT 里，每次启动 DOS 时自动运行？`);
        }
        this.modify(`把 ${u.name} 放进 ${where}${auto ? '，并加到 AUTOEXEC.BAT' : ''}`, v => {
          const n = v.writeFile(b.path, u.name, bytes);
          if (auto) {
            let text = new TextDecoder('latin1').decode(v.readFile('', 'AUTOEXEC.BAT')).replace(/\x1a+$/, '');
            if (text && !/\r?\n$/.test(text)) text += '\r\n';
            text += `${LETTERS[b.k]}${b.path}\\${n}\r\n`;
            v.writeFile('', 'AUTOEXEC.BAT', Uint8Array.from(text, c => c.charCodeAt(0) & 0xff));
          }
          return `${n} 已放进 ${where}（${bytes.length} 字节）。${auto ? '已加到 AUTOEXEC.BAT，以后启动时会自动加载。' : `在 DOS 里运行 ${base} 就会加载。`}`;
        });
        return;
      }
      case 'fs-get': {
        const vol = this.volume();
        if (typeof vol === 'string') return;
        const data = vol.v.readFile(b.path, name);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data.slice()]));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      case 'fs-del':
        this.modify(`删除 ${where}\\${name}`.replace('\\\\', '\\'), v => { v.remove(b.path, name); return `删除了 ${name}`; });
        return;
    }
    this.render();
  }

  private async uploadIntoImage(): Promise<void> {
    const files = Array.from(this.fileInput.files ?? []);
    this.fileInput.value = '';
    const b = this.browse;
    if (!files.length || !b) return;
    const data = await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), date: new Date(f.lastModified) })));
    this.modify(`把 ${files.length} 个文件放进磁盘`, v => {
      const names = data.map(f => {
        const n = v.writeFile(b.path, f.name, f.bytes, f.date);
        return n === f.name.toUpperCase() ? n : `${f.name} → ${n}`;
      });
      return `放进 ${LETTERS[b.k]}：${names.join('、')}`;
    });
  }

  private renderBrowser(): string {
    const b = this.browse!;
    const vol = this.volume();
    const head = `<div class="fs-head"><b>${LETTERS[b.k]}\\${esc(b.path.replace(/^\\/, ''))}</b>`;
    if (typeof vol === 'string') return `<div class="fs-box">${head}</div><div class="empty">${esc(vol)}</div></div>`;
    const { v } = vol;
    let list;
    try { list = v.list(b.path); } catch (e) { b.path = ''; list = v.list(''); }
    const kb = (n: number) => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.ceil(n / 1024) + 'KB';
    const date = (d: Date | null) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
    const rows = list.map(e => e.isDir
      ? `<div class="file-row"><button class="fs-dir" data-act="fs-enter" data-name="${esc(e.name)}">📁 ${esc(e.name)}</button><span class="spacer"></span><span class="note">${date(e.date)}</span><button data-act="fs-del" data-name="${esc(e.name)}" title="删除这个目录（必须是空的）">删除</button></div>`
      : `<div class="file-row"><span class="fn">${esc(e.name)}</span><span class="note">${e.size.toLocaleString()} 字节</span><span class="note">${date(e.date)}</span><button data-act="fs-get" data-name="${esc(e.name)}">下载</button><button data-act="fs-del" data-name="${esc(e.name)}">删除</button></div>`);
    return `<div class="fs-box">${head}<span class="note">${v.fat16 ? 'FAT16' : 'FAT12'}${v.label ? '，卷标 ' + esc(v.label) : ''}，剩余 ${kb(v.freeBytes())}</span></div>` +
      `<div class="mem-bar">${b.path ? '<button data-act="fs-up">↑ 上一级</button>' : ''}<button data-act="fs-upload" title="选择电脑上的文件放进这个目录（文件名会换成 DOS 的 8.3 格式）">上传文件到这里</button>` +
      `<button data-act="fs-mkdir">新建目录</button><button data-act="fs-copy" title="把下面"文件"列表里的全部文件复制到这个目录">复制"文件"列表到这里</button>` +
      UTILITIES.map(u => `<button data-act="fs-util" data-name="${u.name}" title="${esc(u.description)}">放入${u.name === 'MOUSE.COM' ? '鼠标驱动 ' : ''}${u.name}</button>`).join('') + '</div>' +
      (rows.length ? rows.join('') : '<div class="empty">这个目录是空的</div>') + '</div>';
  }

  private async loadFile(): Promise<void> {
    const f = this.input.files?.[0];
    this.input.value = '';
    if (!f || !this.target) return;
    const { i, k } = this.target;
    const data = new Uint8Array(await f.arrayBuffer());
    try {
      const floppy = k < 2;
      if (floppy && !isFloppySize(data.length)) throw new Error(`${f.name} 不是标准大小的软盘映像（${data.length} 字节）。硬盘映像请放进 C:`);
      this.machine(i).drives[k] = new Disk(f.name, data, floppy);
      this.persist(i, k);
      this.host.message('ok', `${LETTERS[k]} 放入了 ${f.name}`, i);
    } catch (e) {
      this.host.message('error', (e as Error).message, i);
    }
    this.render();
  }

  private newHardDisk(i: number, mb: number): void {
    const m = this.machine(i);
    if (m.drives[2] && !confirm('C: 上已经有一个硬盘映像，新建会把它替换掉（原来的内容不会保留）。确定吗？')) { this.render(); return; }
    m.drives[2] = new Disk(`硬盘${mb}MB.img`, blankHardDisk(mb), false);
    this.persist(i, 2);
    this.host.message('ok', `C: 新建了 ${mb}MB 的空白硬盘。用 DOS 启动软盘启动后，先用 FDISK 分区、FORMAT C: /S 格式化（DOS 6.22 的安装程序会自动做）`, i);
    this.render();
  }

  render(): void {
    const parts: string[] = ['<div class="drives-head">磁盘映像：放入软盘或硬盘的映像文件（.img），可以从磁盘启动真的 DOS</div>'];
    for (const { m, tag, i } of this.host.machines()) {
      if (this.host.dual()) parts.push(`<div class="pane-head sub">${tag} 机</div>`);
      for (let k = 0; k < 3; k++) {
        const d = m.drives[k];
        const at = `data-i="${i}" data-drive="${k}"`;
        const info = d ? `<span class="fn" title="${esc(d.name)}">${esc(d.name)}</span><span class="note" title="${d.geometryText}">${d.description}${d.dirty ? '，已修改' : ''}</span>`
          : `<span class="note">（空）</span>`;
        let btns = '';
        if (k < 2) {
          btns = `<button data-act="insert" ${at} title="选择一个软盘映像文件放进这个软驱">${d ? '换盘' : '放入'}</button>` +
            (d ? '' : `<button data-act="blank" ${at} title="放入一张未格式化的空白 1.44MB 软盘">空白盘</button>`);
        } else {
          btns = `<button data-act="insert" ${at} title="选择一个硬盘映像文件">上传映像</button>` +
            `<select data-act="newhd" data-i="${i}" title="新建一个空白硬盘"><option value="">新建硬盘…</option><option value="32">32MB</option><option value="64">64MB</option><option value="128">128MB</option><option value="504">504MB</option></select>`;
        }
        if (d) btns = `<button data-act="browse" ${at} title="查看、放入、取出映像里的文件">${this.browse?.i === i && this.browse.k === k ? '收起文件' : '文件'}</button>` + btns;
        if (d) btns += `<button data-act="download" ${at} title="把映像文件下载到电脑上保存">下载</button><button data-act="eject" ${at} title="${k < 2 ? '取出软盘' : '拿掉这个硬盘（浏览器里保存的映像也会删除）'}">${k < 2 ? '取出' : '移除'}</button>`;
        parts.push(`<div class="file-row drive-row"><b class="dl">${LETTERS[k]}</b>${info}<span class="spacer"></span>${btns}</div>`);
        if (this.browse && this.browse.i === i && this.browse.k === k) parts.push(this.renderBrowser());
      }
      parts.push(`<div class="drive-boot"><button data-act="boot" data-i="${i}" data-from="0" ${m.drives[0] ? '' : 'disabled'} title="像开机一样从 A: 的软盘启动">从 A: 启动</button>` +
        `<button data-act="boot" data-i="${i}" data-from="128" ${m.drives[2] ? '' : 'disabled'} title="从 C: 硬盘启动（A: 里有软盘时也从 C: 启动）">从 C: 启动</button></div>`);
    }
    this.el.innerHTML = parts.join('');
  }
}
