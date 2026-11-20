// 窗口布局：拖动分隔条调整四个窗口的大小，每个窗口可以最大化
//
// 左列是编辑器和 DOS 屏幕，右列是寄存器/栈和信息页，两列之间一条竖的分隔条，
// 每一列中间一条横的分隔条。大小记在浏览器里，下次打开时恢复；双击分隔条恢复默认。

const KEY = 'asm86.layout';

interface Saved { right?: number; screen?: number; info?: number }

function load(): Saved {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved; } catch { return {}; }
}
function store(s: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 无痕模式等情况下忽略 */ }
}

export function setupLayout(onChange: () => void): () => void {
  const layout = document.querySelector('.layout') as HTMLElement;
  const root = document.documentElement;
  const screenPane = layout.querySelector('.screen-pane') as HTMLElement;
  const saved = load();

  const apply = () => {
    if (saved.right) root.style.setProperty('--right-w', saved.right + 'px'); else root.style.removeProperty('--right-w');
    if (saved.info) root.style.setProperty('--info-h', saved.info + 'px'); else root.style.removeProperty('--info-h');
    if (saved.screen) {
      screenPane.classList.add('sized');
      root.style.setProperty('--screen-set-h', saved.screen + 'px');
    } else {
      screenPane.classList.remove('sized');
      root.style.removeProperty('--screen-set-h');
    }
    onChange();
  };
  apply();

  // ----- 分隔条 -----
  for (const bar of layout.querySelectorAll<HTMLElement>('.splitter')) {
    const which = bar.dataset.split as 'right' | 'screen' | 'info';
    const vertical = bar.classList.contains('v');
    bar.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      document.body.classList.add('resizing', vertical ? 'v' : 'h');
      const col = bar.parentElement as HTMLElement;
      const move = (ev: PointerEvent) => {
        if (which === 'right') {
          const r = layout.getBoundingClientRect();
          const w = r.right - 6 - ev.clientX - 3;
          saved.right = Math.round(Math.max(260, Math.min(r.width - 320, w)));
        } else {
          const r = col.getBoundingClientRect();
          const h = Math.round(Math.max(110, Math.min(r.height - 110, r.bottom - ev.clientY - 3)));
          if (which === 'screen') saved.screen = h; else saved.info = h;
        }
        apply();
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        bar.classList.remove('dragging');
        document.body.classList.remove('resizing', 'v', 'h');
        store(saved);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('dblclick', () => {
      delete saved[which];
      apply();
      store(saved);
    });
  }

  // ----- 最大化 -----
  const toggleMax = (pane: HTMLElement) => {
    const on = !pane.classList.contains('maxed');
    for (const p of layout.querySelectorAll('.pane.maxed')) p.classList.remove('maxed');
    for (const c of layout.querySelectorAll('.col.holds-max')) c.classList.remove('holds-max');
    layout.classList.toggle('has-max', on);
    if (on) {
      pane.classList.add('maxed');
      pane.closest('.col')?.classList.add('holds-max');
    }
    for (const b of layout.querySelectorAll<HTMLButtonElement>('.max-btn')) {
      const mine = b.closest('.pane')!.classList.contains('maxed');
      b.textContent = mine ? '🗗' : '⛶';
      b.title = mine ? '还原（Esc，或双击标题栏）' : '最大化（也可以双击标题栏）';
    }
    onChange();
  };
  for (const b of layout.querySelectorAll<HTMLButtonElement>('.max-btn')) {
    b.addEventListener('click', e => { e.stopPropagation(); toggleMax(b.closest('.pane') as HTMLElement); });
  }
  // 双击标题栏的空白处（不是按钮、输入框、标签）也能最大化/还原
  for (const head of layout.querySelectorAll<HTMLElement>('.pane-head, .tabs')) {
    head.addEventListener('dblclick', e => {
      const t = e.target as HTMLElement;
      if (t.closest('button, input, select, label, .ed-tabs > *')) return;
      toggleMax(head.closest('.pane') as HTMLElement);
    });
  }
  // Esc 还原（DOS 屏幕有焦点时 Esc 是给程序的按键，不拦截）
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !layout.classList.contains('has-max')) return;
    const t = e.target as HTMLElement;
    if (t.closest('.screen, .monaco-editor, input, select')) return;
    const p = layout.querySelector('.pane.maxed') as HTMLElement | null;
    if (p) toggleMax(p);
  });
  return () => {
    const pane = layout.querySelector<HTMLElement>('.pane.maxed');
    if (pane) toggleMax(pane);
  };
}
