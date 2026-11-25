import './style.css';
import { applyMemoryStep, describeValue, parseInteger, type MemoryExperiment, type MemoryModel } from './memory-experiments.ts';
import { mountMemoryObserver } from './memory-observer.ts';

export function startMemoryChapter(chapter: {
  readonly number: 1 | 2;
  readonly title: string;
  readonly experiments: readonly MemoryExperiment[];
  readonly create: () => MemoryModel;
}): void {
  const memory = chapter.create();
  const platformBase = document.querySelector<HTMLMetaElement>('meta[name="asm86-platform"]')?.content;
  document.title = `第 ${chapter.number} 章 · ${chapter.title}`;
  document.body.innerHTML = `<main>
    <h1>第 ${chapter.number} 章：${chapter.title}</h1>
    <p>pilot-1 · 只有 64KB 内存模型，没有 CPU、BIOS、DOS、设备或指令执行。</p>
    <label>实验 <select id="experiment"></select></label><p id="question"></p>
    <nav><button id="reset">重置实验</button><button id="next">下一项宿主操作</button>
      <button id="run">完成本组操作</button><button id="verify">检查断言</button>
      <label><input id="observe" type="checkbox" checked> 安装观察模块</label></nav>
    <p id="status" role="status"></p>
    <section><h2>直接查看与写入（宿主调试能力）</h2>
      <label>地址 <input id="address" value="0x10"></label>
      <label>字节值 <input id="value" value="0x41"></label>
      <button id="peek">查看地址</button><button id="write">写一个字节</button>
      <p>接受十进制、0x 十六进制、0b 二进制。修改内存后必须重置才能使用原实验验收。</p>
      <div id="observer"></div></section>
    <section><h2>本组操作与断言</h2><pre id="steps"></pre><h2>实际宿主操作记录</h2><pre id="trace"></pre></section>
    <section id="numeric"><h2>位模式解释（宿主工具，不是 ALU）</h2>
      <label>位宽 <select id="width"><option value="8">8</option><option value="16" selected>16</option></select></label>
      <label>无符号位模式 <input id="number" value="0xFFFF"></label>
      <button id="interpret">解释，不改内存</button><pre id="interpretation"></pre></section>
    <p>寄存器和取指要到第 3 章才进入模型。看到 B8 不代表已经执行 MOV，看到数学结果不代表已经实现 ADD。</p>
    <p id="distribution"><a href="./manuscript.md">阅读 / 下载文字稿</a> · <a href="./source.tar" download>下载本章完整源码</a></p>
  </main>`;
  const get = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少内存实验元素 ${id}`);
    return node as T;
  };
  const select = get<HTMLSelectElement>('experiment');
  const address = get<HTMLInputElement>('address');
  const observe = get<HTMLInputElement>('observe');
  let observer: ReturnType<typeof mountMemoryObserver> | null = null;
  let experiment = chapter.experiments[0];
  let index = 0, failed = false, modified = false;
  let viewAddress = 16;
  let trace: string[] = [];
  const report = (text: string, error = false) => {
    get('status').textContent = text;
    get('status').className = error ? 'error' : '';
  };
  const attempt = (action: () => void) => {
    try { action(); } catch (error) {
      if (!(error instanceof Error)) throw error;
      report(error.message, true);
    }
  };
  const render = () => observer?.render(viewAddress);
  const attach = () => {
    observer?.dispose();
    observer = observe.checked ? mountMemoryObserver(get('observer'), memory) : null;
    render();
  };
  const reset = () => {
    memory.reset();
    index = 0; failed = modified = false; trace = [];
    get('trace').textContent = '尚未进行宿主操作；此处不会执行客体指令。';
    address.value = '0x10';
    viewAddress = 16;
    attach();
    report('已重置内存和实验进度。');
  };
  const next = () => {
    if (failed || modified) { report('实验已失败或被手工修改，请重置', true); return; }
    if (index === experiment.steps.length) { report('操作已完成，请检查断言'); return; }
    try {
      const result = applyMemoryStep(memory, experiment.steps[index]);
      trace.push(`${index + 1}. ${result}`);
      index++;
      get('trace').textContent = trace.join('\n');
      render();
      report(`已完成 ${index}/${experiment.steps.length} 项宿主操作。`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed = true;
      report(error.message, true);
    }
  };
  const choose = () => {
    const selected = chapter.experiments.find(item => item.id === select.value);
    if (!selected) throw new Error('未知内存实验');
    experiment = selected;
    get('question').textContent = selected.question;
    get('steps').textContent = JSON.stringify(selected.steps, null, 2);
    reset();
  };
  for (const item of chapter.experiments) select.add(new Option(item.title, item.id));
  select.onchange = () => attempt(choose);
  get('reset').onclick = () => attempt(reset);
  get('next').onclick = next;
  get('run').onclick = () => {
    if (failed || modified) { report('实验已失败或被手工修改，请重置', true); return; }
    while (index < experiment.steps.length && !failed && !modified) next();
  };
  get('verify').onclick = () => {
    const passed = !failed && !modified && index === experiment.steps.length;
    report(passed ? '断言通过：逐项检查了实际读写、解释或预期输入错误。' : '断言未通过：请重置并完成所有操作，且不要混入手工修改。', !passed);
  };
  observe.onchange = () => attempt(attach);
  get('peek').onclick = () => attempt(() => {
    const selectedAddress = parseInteger(address.value);
    memory.read8(selectedAddress);
    viewAddress = selectedAddress;
    render();
    report('查看完成，未修改内存。');
  });
  get('write').onclick = () => attempt(() => {
    const selectedAddress = parseInteger(address.value);
    memory.write8(selectedAddress, parseInteger(get<HTMLInputElement>('value').value));
    viewAddress = selectedAddress;
    modified = true;
    render();
    report('已通过宿主写入一个字节；原实验验收需要重置。');
  });
  get('interpret').onclick = () => attempt(() => {
    const width = get<HTMLSelectElement>('width').value === '8' ? 8 : 16;
    get('interpretation').textContent = JSON.stringify(describeValue(parseInteger(get<HTMLInputElement>('number').value), width), null, 2);
    report('宿主解释完成，内存未修改，也没有执行 CPU 指令。');
  });
  get('numeric').hidden = chapter.number === 1;
  if (!platformBase) get('distribution').textContent = '独立源码包中的文字稿见 CHAPTER.md；当前目录就是完整源码。';
  choose();
}
