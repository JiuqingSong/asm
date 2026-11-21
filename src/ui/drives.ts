// 磁盘映像面板（"虚拟磁盘"页上半部分）：软驱 A:、B:，硬盘 C:、D:（D: 也可以放光盘映像 .iso，变成只读硬盘）；插入/取出/新建/下载映像，从磁盘启动。
// 映像保存在浏览器的 IndexedDB 里，刷新页面后还在（硬盘上装好的 DOS 不会丢）。
// 光盘映像不读进内存：保存的是文件本身（Blob），DOS 读到哪里才从文件里读哪一段。
import { CD_BOOT, type Machine } from '../machine/machine.ts';
import { Disk, blankHardDisk, blankFloppy, isFloppyImage } from '../machine/disk.ts';
import { FatVolume } from '../machine/fat.ts';
import { IsoDisk, BlobSource, BytesSource, isIsoFile } from '../machine/iso.ts';
import { UTILITIES, buildUtility } from '../dos/utilities.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const LETTERS = ['A:', 'B:', 'C:', 'D:'];
/** 选文件时表示"放进光驱" */
const CD = -1;

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
interface DriveRecord { name: string; floppy: boolean; data?: Uint8Array; iso?: Blob }
async function dbGet(key: string): Promise<DriveRecord | undefined> {
  const db = await openDb();
  const v = await new Promise<unknown>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return v as DriveRecord | undefined;
}

/** 打开光盘映像文件：只读出目录，变成一块只读硬盘 */
async function isoDisk(name: string, f: Blob): Promise<Disk> {
  const d = new Disk(name, new Uint8Array(0), false, await IsoDisk.open(new BlobSource(f), name));
  d.isoFile = f;
  return d;
}

export interface DriveHost {
  machines(): { m: Machine; tag: string; i: number }[];
  dual(): boolean;
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
  private pendingSaves = new Set<Promise<void>>();
  /**
   * 是否启用 D: 盘。不启用时不显示 D: 那一行，也不从浏览器里把 D: 的映像（硬盘或光盘 ISO）装进内存；
   * 浏览器里保存的 D: 映像原样保留，下次启用时还在
   */
  driveD = true;

  constructor(el: HTMLElement, host: DriveHost) {
    this.el = el; this.host = host;
    BlobSource.onError = msg => this.host.message('error', msg, 0);
    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.accept = '.img,.ima,.vfd,.dsk,.bin,.iso';
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
    this.browse = null;
    try {
      for (const { m, i } of this.host.machines()) {
        for (let k = 0; k < 4; k++) {
          if (k === 3 && !this.driveD) { m.drives[3] = null; continue; }
          const v = await dbGet(`${i}:${k}`);
          try {
            if (v?.iso) m.drives[k] = await isoDisk(v.name, v.iso);
            else if (v?.data) m.drives[k] = new Disk(v.name, new Uint8Array(v.data), v.floppy);
          } catch (e) { this.host.message('error', `恢复 ${LETTERS[k]} 映像失败：${(e as Error).message}`, i); }
        }
        const cd = await dbGet(`${i}:cd`);
        if (cd?.iso) m.cdrom.insert(new BlobSource(cd.iso), cd.name);
        m.cdrom.onChange = () => this.render(); // 程序弹出光盘时刷新
      }
    } catch (e) { this.host.message('error', `无法恢复保存的磁盘映像：${(e as Error).message}`, 0); }
    this.render();
  }

  /** 快照里的介质已还原；不能再从 IndexedDB 装盘或触发设备复位。 */
  async adoptSnapshot(): Promise<void> {
    this.browse = null;
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    await Promise.all(this.pendingSaves);
    for (const { m, i } of this.host.machines()) {
      m.cdrom.onChange = () => this.render();
      for (let k = 0; k < (this.driveD ? 4 : 3); k++) await this.persist(i, k);
      const source = m.cdrom.source;
      let iso: Blob | null = null;
      if (source instanceof BlobSource) iso = source.blob;
      else if (source instanceof BytesSource) iso = new Blob([source.get(0, source.size).slice()]);
      else if (source) throw new Error('无法保存快照光盘：不支持的映像来源');
      await this.saveRecord(i, 'cd', iso ? { name: m.cdrom.discName!, floppy: false, iso } : null);
    }
    this.render();
  }

  /** 映像被写过：稍后保存到浏览器（安装软件时会连续写很多次，合并成一次） */
  changed(i: number): void {
    const { m } = this.host.machines().find(x => x.i === i) ?? {};
    if (!m) return;
    for (let k = 0; k < 4; k++) {
      const d = m.drives[k];
      if (!d || !d.dirty) continue;
      const key = `${i}:${k}`;
      clearTimeout(this.saveTimers.get(key));
      this.saveTimers.set(key, window.setTimeout(() => { this.saveTimers.delete(key); void this.persist(i, k); }, 2000));
    }
    this.render();
  }

  /** 关机时：马上把改过的映像存进浏览器（不等定时器） */
  async flushAll(i: number): Promise<void> {
    for (let k = 0; k < 4; k++) {
      const key = `${i}:${k}`;
      clearTimeout(this.saveTimers.get(key));
      this.saveTimers.delete(key);
    }
    await Promise.all(this.pendingSaves);
    const m = this.machine(i);
    for (let k = 0; k < 4; k++) {
      if (m.drives[k]?.dirty) await this.persist(i, k);
    }
  }

  private persist(i: number, k: number): Promise<void> {
    const m = this.host.machines().find(x => x.i === i)?.m;
    if (!m) return Promise.reject(new Error('保存映像时找不到对应虚拟机'));
    const d = m.drives[k];
    const rec: DriveRecord | null = !d ? null : d.isoFile ? { name: d.name, floppy: false, iso: d.isoFile } : { name: d.name, floppy: d.floppy, data: d.data };
    return this.saveRecord(i, String(k), rec);
  }

  private saveRecord(i: number, k: string, record: DriveRecord | null): Promise<void> {
    const saving = dbPut(`${i}:${k}`, record).catch(e => {
      this.host.message('error', `保存 ${k === 'cd' ? '光盘' : LETTERS[Number(k)]} 映像失败：${(e as Error).message}。请下载映像备份`, i);
      throw e;
    });
    this.pendingSaves.add(saving);
    void saving.then(() => this.pendingSaves.delete(saving), () => this.pendingSaves.delete(saving));
    return saving;
  }

  private machine(i: number): Machine { return this.host.machines().find(x => x.i === i)!.m; }

  private action(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.act!.startsWith('fs-')) { this.fsAction(b); return; }
    if (b.dataset.act === 'cd-insert') { this.target = { i: +b.dataset.i!, k: CD }; this.input.click(); return; }
    if (b.dataset.act === 'cd-eject') {
      const i = +b.dataset.i!;
      this.machine(i).cdrom.eject();
      void this.saveRecord(i, 'cd', null);
      this.render();
      return;
    }
    if (!b.dataset.drive) return;
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
    }
    this.render();
  }

  // ======================= 映像里的文件 =======================

  private volume(): { v: FatVolume; d: Disk } | string {
    const b = this.browse;
    if (!b) return '没有选择磁盘';
    const d = this.machine(b.i).drives[b.k];
    if (!d) return '驱动器里没有磁盘';
    if (d.iso) return '光盘映像在 DOS 里读（只读），这里不能浏览';
    const v = FatVolume.open(d.data, d.floppy);
    return typeof v === 'string' ? v : { v, d };
  }

  /**
   * 修改映像里的文件（不重启虚拟机）。DOS 正在运行时：软盘发出"换过盘"的信号让 DOS 重新读；
   * 硬盘只能提醒用户，DOS 缓存着原来的目录和 FAT 表
   */
  private modify(_what: string, fn: (v: FatVolume) => string): void {
    const b = this.browse!;
    const m = this.machine(b.i);
    const booted = m.program?.format === 'boot' && m.status !== 'empty' && !m.poweredOff;
    const vol = this.volume();
    if (typeof vol === 'string') { this.host.message('error', vol, b.i); return; }
    try {
      let msg = fn(vol.v);
      vol.d.dirty = true;
      this.persist(b.i, b.k);
      if (booted) {
        if (vol.d.floppy) {
          // 软盘：发出"换过盘"的信号，DOS 下次访问时会重新读目录和 FAT 表
          vol.d.changed = true;
        } else {
          // 硬盘：DOS 不知道磁盘被改过，内存里还缓存着原来的目录和 FAT 表
          msg += '。DOS 正在运行：如果在 DOS 里看不到新文件，或者要在 DOS 里写文件，最好先重新启动一次（工具栏的"重启"），' +
            '因为 DOS 缓存着原来的目录和 FAT 表，按旧的缓存写文件可能和刚放进去的文件冲突';
        }
      }
      this.host.message('ok', msg, b.i);
    } catch (e) {
      this.host.message('error', (e as Error).message, b.i);
    }
    this.render();
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
        if (typeof vol !== 'string' && u.autoexec && b.k === 2 && vol.v.list('').some(e => e.name === 'AUTOEXEC.BAT')) {
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
      `<button data-act="fs-mkdir">新建目录</button><button class="dos-files" data-act="fs-copy" title="把下面"文件"列表里的全部文件复制到这个目录">复制"文件"列表到这里</button>` +
      UTILITIES.filter(u => u.name !== 'MOUSE.COM' || this.machine(b.i).mouseDriverEnabled).map(u => `<button data-act="fs-util" data-name="${u.name}" title="${esc(u.description)}">放入${u.name === 'MOUSE.COM' ? '鼠标驱动 ' : u.name === 'SHUTDOWN.COM' ? '关机程序 ' : ''}${u.name}</button>`).join('') + '</div>' +
      (rows.length ? rows.join('') : '<div class="empty">这个目录是空的</div>') + '</div>';
  }

  private async loadFile(): Promise<void> {
    const f = this.input.files?.[0];
    this.input.value = '';
    if (!f || !this.target) return;
    const { i, k } = this.target;
    if (k === CD) {
      const m = this.machine(i);
      m.cdrom.insert(new BlobSource(f), f.name);
      void this.saveRecord(i, 'cd', { name: f.name, floppy: false, iso: f });
      const iso = await isIsoFile(f);
      this.host.message('ok', `光驱里放入了 ${f.name}${iso ? '' : '（这个文件不像 ISO9660 光盘映像，DOS 可能读不出来）'}。DOS 下要在 CONFIG.SYS 里装光驱驱动（例如 DEVICE=OAKCDROM.SYS /D:MSCD001），` +
        `AUTOEXEC.BAT 里运行 MSCDEX /D:MSCD001；Windows 95 会自己认出光驱。映像不会读进内存，读到哪里才从文件里读哪一段`, i);
      this.render();
      return;
    }
    try {
      const floppy = k < 2;
      if (!floppy && await isIsoFile(f)) {
        if (k !== 3) throw new Error(`${f.name} 是光盘映像，请放进${this.driveD ? ' D: 或' : ''}光驱（C: 要用来启动 DOS）`);
        const d = await isoDisk(f.name, f);
        this.machine(i).drives[k] = d;
        this.persist(i, k);
        this.host.message('ok', `D: 放入了光盘映像 ${f.name}：它被变成一块只读的 FAT16 硬盘（${d.description}）。` +
          `重新启动 DOS 后光盘的内容就在 D:，不需要光驱驱动和 MSCDEX；长文件名换成了 8.3 格式。映像不会读进内存，DOS 读到哪里才从文件里读哪一段`, i);
        this.render();
        return;
      }
      const data = new Uint8Array(await f.arrayBuffer());
      if (floppy && !isFloppyImage(data)) throw new Error(`${f.name} 不是标准大小的软盘映像（${data.length} 字节）。` +
        (this.driveD ? '硬盘映像请放进 C: 或 D:，光盘映像（.iso）请放进 D: 或光驱' : '硬盘映像请放进 C:，光盘映像（.iso）请放进光驱'));
      const disk = new Disk(f.name, data, floppy);
      this.machine(i).drives[k] = disk;
      this.persist(i, k);
      const note = floppy && data.length !== disk.data.length
        ? `（识别并忽略了尾部 ${data.length - disk.data.length} 字节说明，按 ${disk.description} 软盘装入；保存和下载为标准原始映像，原文件未修改）` : '';
      this.host.message('ok', `${LETTERS[k]} 放入了 ${f.name}${note}`, i);
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
    const parts: string[] = ['<div class="drives-head">磁盘映像：放入软盘或硬盘的映像文件（.img），可以从磁盘启动真的 DOS；光盘映像（.iso）可以放进光驱' +
      (this.driveD ? '，也可以放在 D:（变成只读硬盘，DOS 不用装光驱驱动）' : '') + '</div>'];
    /** 行首的"从这里启动"按钮，只在"选择启动设备"对话框里显示（见 style.css 的 .boot-slot） */
    const bootSlot = (i: number, drive: number | null, cls: string, enabled: boolean) => `<span class="boot-slot">` +
      (drive === null ? '' : `<button class="boot-here ${cls}" data-boot="${drive}" data-i="${i}"${enabled ? '' : ' disabled'}>从这里启动</button>`) + '</span>';
    for (const { m, tag, i } of this.host.machines()) {
      if (this.host.dual()) parts.push(`<div class="pane-head sub">${tag} 机</div>`);
      for (let k = 0; k < 4; k++) {
        if (k === 3 && !this.driveD) continue;
        const d = m.drives[k];
        const installed = k < 2 ? m.floppyInstalled(k) : m.config.ide;
        const at = `data-i="${i}" data-drive="${k}"`;
        const info = d ? `<span class="fn" title="${esc(d.name)}">${esc(d.name)}</span><span class="note" title="${d.geometryText}">${d.description}${d.dirty ? '，已修改' : ''}</span>`
          : `<span class="note">（空）</span>`;
        let btns = '';
        if (k < 2) {
          btns = `<button data-act="insert" ${at} title="选择一个软盘映像文件放进这个软驱">${d ? '换盘' : '放入'}</button>` +
            (d ? '' : `<button data-act="blank" ${at} title="放入一张未格式化的空白 1.44MB 软盘">空白盘</button>`);
        } else {
          btns = k === 3
            ? `<button data-act="insert" ${at} title="选择第二块硬盘的映像文件（.img），或者光盘映像（.iso，变成一块只读硬盘，DOS 里不用光驱驱动就能读）">上传映像/ISO</button>`
            : `<button data-act="insert" ${at} title="选择一个硬盘映像文件">上传映像</button>` +
            `<select data-act="newhd" data-i="${i}" title="新建一个空白硬盘"><option value="">新建硬盘…</option><option value="32">32MB</option><option value="64">64MB</option><option value="128">128MB</option><option value="504">504MB</option></select>`;
        }
        if (d && !d.iso) btns = `<button data-act="browse" ${at} title="查看、放入、取出映像里的文件">${this.browse?.i === i && this.browse.k === k ? '收起文件' : '文件'}</button>` + btns;
        if (d) btns += (d.iso ? '' : `<button data-act="download" ${at} title="把映像文件下载到电脑上保存">下载</button>`) + `<button data-act="eject" ${at} title="${k < 2 ? '取出软盘' : '拿掉这个硬盘（浏览器里保存的映像也会删除）'}">${k < 2 ? '取出' : '移除'}</button>`;
        const slot = k === 0 ? bootSlot(i, 0, 'boot-a', installed) : k === 2 ? bootSlot(i, 0x80, 'boot-c', installed) : bootSlot(i, null, '', false);
        parts.push(`<div class="file-row drive-row">${slot}<b class="dl">${LETTERS[k]}</b>${installed ? '' : '<span class="note">未安装（映像保留）</span>'}${info}<span class="spacer"></span>${btns}</div>`);
        if (this.browse && this.browse.i === i && this.browse.k === k) parts.push(this.renderBrowser());
      }
      const disc = m.cdrom.discName;
      parts.push(`<div class="file-row drive-row">${bootSlot(i, CD_BOOT, 'boot-cd', m.config.cdrom)}<b class="dl" title="IDE 第二通道上的 ATAPI 光驱">光驱</b>${m.config.cdrom ? '' : '<span class="note">未安装（映像保留）</span>'}` +
        (disc ? `<span class="fn" title="${esc(disc)}">${esc(disc)}</span><span class="note">${Math.round(m.cdrom.discSize / 1024 / 1024)}MB</span>` : '<span class="note">（没有光盘）</span>') +
        `<span class="spacer"></span><button data-act="cd-insert" data-i="${i}" title="选择一个光盘映像文件（.iso）放进光驱">${disc ? '换光盘' : '放入光盘'}</button>` +
        (disc ? `<button data-act="cd-eject" data-i="${i}" title="取出光盘">弹出</button>` : '') + '</div>');
    }
    this.el.innerHTML = parts.join('');
  }
}
