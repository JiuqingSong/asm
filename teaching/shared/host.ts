import './style.css';
import { checkpointErrors, type Chapter, type Experiment } from './contracts.ts';
import { mountObserver } from './observer.ts';

export function startChapter(chapter: Chapter): void {
  const machine = chapter.create();
  const platformBase = document.querySelector<HTMLMetaElement>('meta[name="asm86-platform"]')?.content;
  document.title = `第 ${chapter.number} 章 · ${chapter.title}`;
  document.body.innerHTML = `
    <main>
      <h1>第 ${chapter.number} 章：${chapter.title}</h1>
      <p>独立教学虚拟机 · 核心版本 pilot-1 · 没有 BIOS、DOS、外设或分段。</p>
      <p id="capabilities"></p>
      <label>实验 <select id="experiment"></select></label>
      <p id="question"></p>
      <section><h2>应用程序提供的机器码</h2>
        <label for="bytes">十六进制字节（修改后点“装载 / 重置”）</label>
        <textarea id="bytes" spellcheck="false" rows="3"></textarea>
        <pre id="assembly"></pre>
      </section>
      <nav>
        <button id="load">装载 / 重置</button>
        <button id="step">单步</button>
        <button id="run">运行到停止（最多 1000 步）</button>
        <button id="verify">检查断言</button>
        <label><input id="observe" type="checkbox" checked> 安装观察模块</label>
      </nav>
      <p id="status" role="status"></p>
      <section id="observer"></section>
      <section><h2>本实验的检查点</h2><pre id="checkpoints"></pre></section>
      <section><h2>职责边界</h2>
        <p>应用提供字节；宿主将其装入 0000 并清零寄存器、设置 FLAGS=0002。
        CPU 核心译码并执行。观察模块只查看副本；网页显示不是客体显卡。</p>
        <p>本章 HLT 进入停机，不模拟中断唤醒。缺字节和未实现操作码是教学错误，不是硬件异常。</p>
      </section>
      <p><a id="full-platform">在完整 AsmPerfect 86 中对照（额外具有完整 CPU 能力）</a></p>
      <p id="distribution"><a href="./manuscript.md">阅读 / 下载本章文字稿</a> · <a href="./source.tar" download>下载本章完整源码（tar）</a></p>
    </main>`;
  const element = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少教学界面元素 ${id}`);
    return node as T;
  };
  const select = element<HTMLSelectElement>('experiment');
  const bytesInput = element<HTMLTextAreaElement>('bytes');
  const observerContainer = element('observer');
  const observerToggle = element<HTMLInputElement>('observe');
  const status = element('status');
  let observer: ReturnType<typeof mountObserver> | null = null;
  let experiment: Experiment = chapter.experiments[0];
  let steps = 0;
  let loaded = false;
  let checks: string[] = [];
  let seen = new Set<number>();
  let faultMatched = false;
  const report = (message: string, error = false) => {
    status.textContent = message;
    status.className = error ? 'error' : '';
  };
  const attachObserver = () => {
    observer?.dispose();
    observer = observerToggle.checked ? mountObserver(observerContainer, machine) : null;
    observer?.render();
  };
  const parseBytes = (): number[] => {
    const text = bytesInput.value.trim();
    if (!text) throw new Error('请输入机器码');
    return text.split(/\s+/).map(token => {
      if (!/^[0-9a-fA-F]{2}$/.test(token)) throw new Error(`非法字节 "${token}"：每项必须是两位十六进制数`);
      return parseInt(token, 16);
    });
  };
  const load = () => {
    try {
      machine.load(parseBytes());
      steps = 0;
      checks = [];
      seen = new Set();
      faultMatched = false;
      loaded = true;
      attachObserver();
      report('已装载：IP=0000，FLAGS=0002。单步观察；无观察模块也可执行。');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      report(error.message, true);
    }
  };
  const step = () => {
    if (!loaded) { report('请先装载程序', true); return; }
    if (machine.state().status !== 'ready') { report('机器已停止；检查断言或重新装载。'); return; }
    const before = observer ? machine.state() : null;
    try {
      const result = machine.step();
      if (!result) return;
      steps++;
      for (const checkpoint of experiment.checkpoints.filter(c => c.step === steps)) {
        seen.add(checkpoint.step);
        checks.push(...checkpointErrors(machine.state(), checkpoint).map(e => `第 ${steps} 步：${e}`));
      }
      if (observer && before) observer.record(result, before);
      report(`完成 ${steps} 步；状态=${machine.state().status}。点击“检查断言”验证。`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      steps++;
      const expected = experiment.fault;
      faultMatched = !!expected && expected.step === steps && expected.ip === machine.state().ip && error.message.includes(expected.contains);
      if (!faultMatched) checks.push(error.message);
      observer?.render();
      report((faultMatched ? '出现预期的教学错误：' : '执行失败：') + error.message, true);
    }
  };
  const verify = () => {
    const failures = [...checks];
    if (!loaded) failures.push('尚未成功装载程序');
    if (experiment.checkpoints.some(c => !seen.has(c.step))) failures.push('尚未执行全部检查点');
    if (experiment.fault ? !faultMatched : machine.state().status !== 'halted') failures.push('尚未达到预期停止状态');
    report(failures.length ? '断言未通过：\n' + failures.join('\n') : `断言通过：${experiment.title}；已检查实际执行的中间状态和停止状态。`, failures.length > 0);
  };
  const choose = () => {
    const selected = chapter.experiments.find(e => e.id === select.value);
    if (!selected) throw new Error('未知实验');
    experiment = selected;
    bytesInput.value = selected.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    element('question').textContent = selected.question;
    element('assembly').textContent = '对应汇编（仅供阅读，本页不内置汇编器）：\n' + selected.assembly;
    element('checkpoints').textContent = JSON.stringify({ checkpoints: selected.checkpoints, expectedTeachingError: selected.fault }, null, 2);
    const link = element<HTMLAnchorElement>('full-platform');
    link.href = platformBase
      ? new URL(`${platformBase}?lesson=${selected.id}`, location.href).href
      : 'https://jiuqingsong.github.io/asm/';
    if (!platformBase) link.textContent = '完整项目主页（本次教学对照尚未发布；本地对照请使用完整项目的启动页）';
    load();
  };
  element('capabilities').textContent = chapter.capabilities;
  if (!platformBase) {
    element('distribution').textContent = '独立运行：文字稿在源码包的 CHAPTER.md，完整源码即当前解压目录；在线分发链接由完整项目的教学发布构建提供。';
  }
  for (const item of chapter.experiments) select.add(new Option(item.title, item.id));
  const requested = new URLSearchParams(location.search).get('experiment');
  if (requested && chapter.experiments.some(e => e.id === requested)) select.value = requested;
  select.onchange = choose;
  element('load').onclick = load;
  element('step').onclick = step;
  element('run').onclick = () => {
    if (!loaded) { report('请先装载程序', true); return; }
    for (let budget = 0; budget < 1000 && machine.state().status === 'ready'; budget++) step();
    if (machine.state().status === 'ready') report('执行预算耗尽：仍未停止，不能记为验收通过', true);
  };
  element('verify').onclick = verify;
  observerToggle.onchange = attachObserver;
  bytesInput.oninput = () => {
    loaded = false;
    report('机器码已修改，请重新装载；检查断言仍以所选实验的原始预期为准。');
  };
  choose();
}
