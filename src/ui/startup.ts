import { CONFIG_OPTIONS, DEFAULT_CONFIG, configWarnings, type MachineConfig, type StartupMode } from '../machine/config.ts';
import { CPU_SPEEDS, CD_BOOT, type CpuSpeedId, type Machine } from '../machine/machine.ts';

export class StartupPanel {
  private configDialog = document.getElementById('startup-config') as HTMLDialogElement;
  private bootDialog = document.getElementById('boot-choice') as HTMLDialogElement;
  private selected: 'debug' | 'full' = 'debug';
  private busy = false;
  private launch: (mode: StartupMode, config: Readonly<MachineConfig>, cpu: CpuSpeedId, showDiskImages: boolean) => Promise<void>;
  private currentCpu: () => CpuSpeedId;
  private error: (message: string) => void;
  private snapshotInput: HTMLInputElement;

  constructor(
    launch: (mode: StartupMode, config: Readonly<MachineConfig>, cpu: CpuSpeedId, showDiskImages: boolean) => Promise<void>,
    currentCpu: () => CpuSpeedId,
    error: (message: string) => void,
    restoreSnapshot: (file: File) => Promise<void>,
  ) {
    this.launch = launch;
    this.currentCpu = currentCpu;
    this.error = error;
    this.snapshotInput = document.createElement('input');
    this.snapshotInput.type = 'file';
    this.snapshotInput.accept = '.asmsnap';
    this.snapshotInput.hidden = true;
    document.body.appendChild(this.snapshotInput);
    this.snapshotInput.onchange = async () => {
      const file = this.snapshotInput.files?.[0];
      this.snapshotInput.value = '';
      if (!file || this.busy) return;
      this.busy = true;
      document.getElementById('launcher')!.setAttribute('inert', '');
      document.getElementById('startup-error')!.textContent = '正在校验并载入快照…';
      try { await restoreSnapshot(file); }
      catch (e) { this.error((e as Error).message); }
      finally {
        this.busy = false;
        document.getElementById('launcher')!.removeAttribute('inert');
      }
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-start]')) b.onclick = () => {
      const mode = b.dataset.start;
      if (mode === 'dual') void this.enter('dual', DEFAULT_CONFIG, this.currentCpu(), true);
      else if (mode === 'debug' || mode === 'full') this.configure(mode);
      else if (mode === 'snapshot') this.snapshotInput.click();
    };
    const form = this.configDialog.querySelector('form')!;
    form.onsubmit = e => {
      e.preventDefault();
      const config = this.read();
      const cpu = (document.getElementById('config-cpu') as HTMLSelectElement).value as CpuSpeedId;
      const showDiskImages = this.selected === 'debug' && (document.getElementById('config-images') as HTMLInputElement).checked;
      this.configDialog.close();
      void this.enter(this.selected, config, cpu, showDiskImages);
    };
    document.getElementById('config-cancel')!.onclick = () => this.configDialog.close();
    document.getElementById('config-defaults')!.onclick = () => this.configure(this.selected);
    this.configDialog.onchange = () => this.warnings();
    const cpu = document.getElementById('config-cpu') as HTMLSelectElement;
    for (const c of CPU_SPEEDS) cpu.add(new Option(c.name, c.id));
  }

  private async enter(mode: StartupMode, config: Readonly<MachineConfig>, cpu: CpuSpeedId, showDiskImages: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    document.getElementById('launcher')!.setAttribute('inert', '');
    try { await this.launch(mode, config, cpu, showDiskImages); }
    catch (e) { this.error((e as Error).message); }
    finally {
      this.busy = false;
      document.getElementById('launcher')!.removeAttribute('inert');
    }
  }

  private configure(mode: 'debug' | 'full'): void {
    this.selected = mode;
    document.getElementById('config-title')!.textContent = mode === 'full' ? '完整模拟：选择设备' : '直接调试：选择设备和预设服务';
    const el = document.getElementById('config-options')!;
    el.replaceChildren();
    for (const option of CONFIG_OPTIONS) {
      if (mode === 'full' && option.software) continue;
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.option = option.key;
      input.checked = DEFAULT_CONFIG[option.key];
      label.append(input, document.createTextNode(option.label));
      el.appendChild(label);
    }
    (document.getElementById('config-cpu') as HTMLSelectElement).value = this.currentCpu();
    document.getElementById('config-images-option')!.classList.toggle('hidden', mode !== 'debug');
    (document.getElementById('config-images') as HTMLInputElement).checked = false;
    this.warnings();
    if (!this.configDialog.open) this.configDialog.showModal();
  }

  private read(): MachineConfig {
    const c = { ...DEFAULT_CONFIG };
    for (const option of CONFIG_OPTIONS) {
      const input = this.configDialog.querySelector<HTMLInputElement>(`[data-option="${option.key}"]`);
      if (input) c[option.key] = input.checked;
    }
    if (this.selected === 'full') { c.dos = false; c.mouseDriver = false; }
    return c;
  }

  private warnings(): void {
    const cpu = (document.getElementById('config-cpu') as HTMLSelectElement).value;
    const fpu = this.configDialog.querySelector<HTMLInputElement>('[data-option="fpu"]')!;
    fpu.disabled = cpu !== '386' && cpu !== '486';
    if (fpu.disabled) fpu.checked = false;
    const c = this.read();
    const warnings = configWarnings(c);
    if (this.selected === 'full') warnings.push('保留 BIOS，不预装 DOS 或 INT 33h 鼠标驱动；鼠标需要在客体系统中安装驱动。');
    document.getElementById('config-warnings')!.textContent = warnings.join('\n');
  }

  async boot(m: Machine, start: (drive: number) => Promise<boolean>): Promise<boolean> {
    const drives = document.getElementById('drives')!;
    const parent = drives.parentElement!;
    document.getElementById('boot-media')!.appendChild(drives);
    const buttons = [...this.bootDialog.querySelectorAll<HTMLButtonElement>('[data-boot]')];
    let working = false;
    let success = false;
    for (const b of buttons) {
      const drive = Number(b.dataset.boot);
      b.disabled = drive === CD_BOOT ? !m.config.cdrom : drive === 0 ? !m.floppyInstalled(0) : !m.config.ide;
      b.onclick = async () => {
        if (working) return;
        working = true;
        this.bootDialog.setAttribute('aria-busy', 'true');
        try {
          success = await start(drive);
          if (success) this.bootDialog.close();
        } catch (e) {
          this.error((e as Error).message);
          document.getElementById('boot-error')!.textContent = (e as Error).message;
        } finally {
          working = false;
          this.bootDialog.removeAttribute('aria-busy');
        }
      };
    }
    const cancel = document.getElementById('boot-cancel') as HTMLButtonElement;
    cancel.onclick = () => { if (!working) this.bootDialog.close(); };
    this.bootDialog.oncancel = e => { if (working) e.preventDefault(); };
    document.getElementById('boot-error')!.textContent = '';
    const closed = new Promise<void>(resolve => this.bootDialog.addEventListener('close', () => resolve(), { once: true }));
    this.bootDialog.showModal();
    await closed;
    parent.appendChild(drives);
    return success;
  }
}
