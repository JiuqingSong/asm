import { describeValue, type MemoryModel } from './memory-experiments.ts';

export function mountMemoryObserver(container: HTMLElement, memory: MemoryModel) {
  const view = document.createElement('pre');
  view.id = 'memory-state';
  container.replaceChildren(view);
  let disposed = false;
  return {
    render(address: number): void {
      if (disposed) return;
      const byte = memory.read8(address);
      const value = describeValue(byte, 8);
      const bytes = memory.peek(address, Math.min(16, memory.size - address));
      view.textContent = `查看地址 ${address} (0x${address.toString(16).toUpperCase()})\n`
        + `内容：十进制 ${byte} / 十六进制 ${value.hex} / 二进制 ${value.binary}\n`
        + `8 位无符号解释 ${value.unsigned} / 补码解释 ${value.signed}\n`
        + `相邻字节：${Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}\n`
        + '没有 CPU：这里没有 IP、FLAGS 或已执行指令。';
    },
    dispose(): void { disposed = true; container.replaceChildren(); },
  };
}
