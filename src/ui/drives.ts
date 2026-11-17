// 磁盘映像面板（"虚拟磁盘"页上半部分）：软驱 A:、B:，硬盘 C:；插入/取出/新建/下载映像，从磁盘启动。
// 映像保存在浏览器的 IndexedDB 里，刷新页面后还在（硬盘上装好的 DOS 不会丢）。
import type { Machine } from '../machine/machine.ts';
import { Disk, blankHardDisk, blankFloppy, isFloppySize } from '../machine/disk.ts';

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
  private saveTimers = new Map<string, number>();

  constructor(el: HTMLElement, host: DriveHost) {
    this.el = el; this.host = host;
    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.accept = '.img,.ima,.vfd,.dsk,.bin';
    this.input.hidden = true;
    document.body.appendChild(this.input);
    this.input.onchange = () => this.loadFile();
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
    if (!b || !b.dataset.drive && b.dataset.act !== 'boot') return;
    const i = +b.dataset.i!, k = +(b.dataset.drive ?? 0), m = this.machine(i);
    switch (b.dataset.act) {
      case 'insert': this.target = { i, k }; this.input.click(); return;
      case 'eject': m.drives[k] = null; this.persist(i, k); break;
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
      case 'boot': this.host.boot(i, +b.dataset.from!); return;
    }
    this.render();
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
        if (d) btns += `<button data-act="download" ${at} title="把映像文件下载到电脑上保存">下载</button><button data-act="eject" ${at} title="${k < 2 ? '取出软盘' : '拿掉这个硬盘（浏览器里保存的映像也会删除）'}">${k < 2 ? '取出' : '移除'}</button>`;
        parts.push(`<div class="file-row drive-row"><b class="dl">${LETTERS[k]}</b>${info}<span class="spacer"></span>${btns}</div>`);
      }
      parts.push(`<div class="drive-boot"><button data-act="boot" data-i="${i}" data-from="0" ${m.drives[0] ? '' : 'disabled'} title="像开机一样从 A: 的软盘启动">从 A: 启动</button>` +
        `<button data-act="boot" data-i="${i}" data-from="128" ${m.drives[2] ? '' : 'disabled'} title="从 C: 硬盘启动（A: 里有软盘时也从 C: 启动）">从 C: 启动</button></div>`);
    }
    this.el.innerHTML = parts.join('');
  }
}
