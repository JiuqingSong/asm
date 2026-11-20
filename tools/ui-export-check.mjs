// URL=http://localhost:5317/ node tools/ui-export-check.mjs
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { enterMode } from './ui-session.mjs';
import { loadExecutable } from '../src/machine/exe.ts';
import { Machine } from '../src/machine/machine.ts';
import { EXAMPLES } from '../src/ui/examples.ts';

const temp = mkdtempSync(join(tmpdir(), 'asm-export-'));
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, defaultViewport: { width: 1600, height: 1000 },
});
try {
  const page = await browser.newPage(), errors = [], downloads = [];
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: temp, eventsEnabled: true });
  cdp.on('Browser.downloadWillBegin', e => downloads.push(e.suggestedFilename));
  let answer = 'hello-export', prompts = 0, phase = 'debug', acceptConfirm = true;
  const confirmations = [];
  page.on('pageerror', e => errors.push(`${phase}: ${e.stack ?? e.message}`));
  page.on('dialog', d => {
    if (d.type() === 'confirm') {
      confirmations.push(d.message());
      return acceptConfirm ? d.accept() : d.dismiss();
    }
    if (d.type() !== 'prompt') return d.accept();
    prompts++;
    return answer === null ? d.dismiss() : d.accept(answer);
  });
  const setSource = async (source, i = 0) => {
    await page.evaluate((source, i) => {
      const model = window.__app.sessions[i].model;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: source }], () => null);
    }, source, i);
    await delay(100);
  };
  const checkToolbars = async editorVisible => {
    const sourceIds = ['btn-new', 'btn-open', 'examples', 'btn-save', 'btn-assemble', 'show-bytes'];
    const mainIds = ['btn-home', 'btn-snapshot', 'cpu', 'btn-run', 'btn-pause', 'speed', 'fullscreen-capture', 'record-history', 'btn-back', 'btn-step', 'btn-over', 'btn-out', 'btn-reset', 'btn-cad', 'btn-power'];
    assert.deepEqual(await page.$$eval('.toolbar button, .toolbar select, .toolbar input', els => els.map(e => e.id)), mainIds);
    assert.deepEqual(await page.$$eval('.editor-tools button, .editor-tools select, .editor-tools input', els => els.map(e => e.id)), sourceIds);
    assert.equal(await page.evaluate(ids => ids.every(id => document.getElementById(id).checkVisibility()), mainIds), true);
    assert.equal(await page.evaluate(({ ids, visible }) =>
      ids.every(id => document.getElementById(id).checkVisibility() === visible),
    { ids: [...sourceIds, 'btn-export'], visible: editorVisible }), true);
    if (!editorVisible) return;
    assert.equal(await page.$eval('.ed-head', head => {
      const bounds = head.getBoundingClientRect();
      const controls = [...head.querySelectorAll('button, select, input')];
      return controls.every(e => {
        const r = e.getBoundingClientRect();
        return r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom;
      });
    }), true, '代码工具栏的按钮不能溢出标题栏');
    assert.equal(await page.$eval('.ed-head', head => {
      const exportButton = head.querySelector('#btn-export').getBoundingClientRect();
      const max = head.querySelector('.max-btn').getBoundingClientRect();
      return exportButton.right <= max.left && head.getBoundingClientRect().right - max.right <= 10;
    }), true, '生成和最大化按钮应依次靠右');
  };
  const download = async name => {
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cdp.off('Browser.downloadProgress', progress); reject(new Error('下载超时')); }, 15000);
      function progress(e) {
        if (e.state === 'inProgress') return;
        clearTimeout(timer);
        cdp.off('Browser.downloadProgress', progress);
        if (e.state === 'completed') resolve();
        else reject(new Error('下载被取消'));
      }
      cdp.on('Browser.downloadProgress', progress);
    });
    await page.click('#btn-export');
    await completed;
    // Monaco 的光标高亮有 50ms 防抖，等它结束再切换文档。
    await delay(100);
    assert.equal(downloads.at(-1), name);
    return readFileSync(join(temp, name));
  };
  const run = (bytes, name, text) => {
    const { program } = loadExecutable(bytes, name, 0x2345);
    const m = new Machine();
    m.load(program);
    assert.equal(m.run(10000), 'exit');
    assert.equal(m.console, text);
  };
  const com = text => `.model tiny
.code
org 100h
start: push cs
pop ds
mov dx, offset msg
mov ah, 9
int 21h
mov ax, 4c00h
int 21h
msg db '${text}$'
end start`;
  await page.goto(process.env.URL || 'http://localhost:5317/', { waitUntil: 'networkidle0' });
  await enterMode(page);
  for (const width of [1600, 1280, 900]) {
    await page.setViewport({ width, height: 1000 });
    await checkToolbars(true);
  }
  await page.setViewport({ width: 1600, height: 1000 });
  await page.click('#show-bytes');
  await page.waitForFunction(() => /[0-9A-F]{4}:[0-9A-F]{4}\s+[0-9A-F]{2}/.test(document.getElementById('editor').textContent));
  await page.click('#show-bytes');
  await page.click('#btn-step');
  await page.click('#btn-step');
  const snapshot = () => page.evaluate(() => {
    const m = window.__app.cur.m;
    return { instructions: m.instructions, ip: m.cpu.ip, regs: [...m.cpu.r], history: m.history.count };
  });
  const before = await snapshot();
  assert.ok(before.instructions > 0);
  run(await download('hello-export.exe'), 'hello-export.exe', 'Hello, 8086!\n');
  assert.deepEqual(await snapshot(), before, '导出不能重置或推进正在调试的程序');

  phase = 'invalid source';
  await setSource('.model small\n.code\nstart: mov ax,\nend start');
  const count = prompts;
  await page.click('#btn-export');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('汇编错误'));
  assert.match(await page.$eval('#tab-messages', e => e.textContent), /操作数为空/);
  assert.equal(prompts, count, '汇编失败不能询问文件名');
  assert.equal(downloads.length, 1);

  phase = 'COM';
  await setSource(com('COM EXPORT'));
  answer = '';
  await page.click('#btn-export');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('文件名不能为空'));
  assert.equal(downloads.length, 1);
  answer = null;
  await page.click('#btn-export');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已取消下载'));
  answer = 'tiny-export.com';
  run(await download('tiny-export.com'), 'tiny-export.com', 'COM EXPORT');
  assert.deepEqual(await snapshot(), before);

  phase = 'editor replacement';
  const source = () => page.evaluate(() => window.__app.cur.model.getValue());
  const hello = EXAMPLES.find(e => e.id === 'hello').source;
  await page.select('#examples', 'hello');
  let confirmed = confirmations.length;
  await page.select('#examples', 'stack');
  await page.select('#examples', 'hello');
  assert.equal(confirmations.length, confirmed, '未修改的示例应直接替换');
  await setSource(hello + '\n; modified');
  await page.click('#btn-assemble');
  assert.equal(await page.evaluate(() => window.__app.cur.dirty), false);
  acceptConfirm = false;
  await page.select('#examples', 'stack');
  assert.equal(await source(), hello + '\n; modified', '取消替换应保留修改，即使已经汇编');
  await page.click('#btn-new');
  assert.equal(await source(), hello + '\n; modified', '取消新建应保留修改');
  assert.equal(confirmations.length, confirmed + 2);
  acceptConfirm = true;
  await page.select('#examples', 'stack');
  assert.equal(confirmations.length, confirmed + 3);

  const bad = join(temp, 'invalid.asm'), good = join(temp, 'loaded.asm');
  writeFileSync(bad, '.model small\n.code\nstart: mov ds, 1234h\nend start');
  writeFileSync(good, hello);
  const open = async (path, name) => {
    await (await page.$('#file-input')).uploadFile(path);
    await page.waitForFunction(name => window.__app.cur.fileName === name, {}, name);
    await delay(100);
  };
  confirmed = confirmations.length;
  await open(good, 'loaded.asm');
  assert.equal(confirmations.length, confirmed, '未修改的源码打开文件时不确认');
  await setSource(hello + '\n; local edit');
  acceptConfirm = false;
  await open(bad, 'loaded.asm');
  assert.equal(await source(), hello + '\n; local edit', '取消打开文件应保留修改和文件名');
  assert.equal(confirmations.length, confirmed + 1);
  acceptConfirm = true;
  await open(bad, 'invalid.asm');
  assert.equal(confirmations.length, confirmed + 2);
  confirmed = confirmations.length;
  await page.click('#btn-new');
  assert.equal(confirmations.length, confirmed, '刚载入的错误源码也不算修改过');
  assert.equal(await source(), '');
  assert.deepEqual(await page.evaluate(() => {
    const s = window.__app.cur;
    return [s.fileName, s.program, s.m.status, window.__app.editor.model === s.model, window.__app.editor.editor.getRawOptions().readOnly];
  }), ['', null, 'empty', true, false]);
  assert.equal(await page.$eval('#msg-count', e => e.textContent), '');
  await page.click('#btn-new');
  assert.equal(confirmations.length, confirmed, '连续新建不重复询问');
  await setSource('\n');
  const blankEdit = await source();
  acceptConfirm = false;
  await page.click('#btn-new');
  assert.equal(await source(), blankEdit, '空白编辑也应受到保护');
  acceptConfirm = true;
  await page.click('#btn-new');
  assert.equal(await source(), '');

  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__app);
  await page.click('[data-start="debug"]');
  await page.waitForSelector('#startup-config[open]');
  await page.click('#startup-config button[type="submit"]');
  await page.waitForFunction(() => window.__app.startupMode === 'debug' && !document.querySelector('.toolbar').inert);
  assert.equal(await source(), '', '新建的空文档不能在恢复时变回默认示例');
  assert.equal(await page.evaluate(() => window.__app.cur.fileName), '');
  confirmed = confirmations.length;
  await page.select('#examples', 'hello');
  await setSource(hello + '\n; undo me');
  await page.evaluate(() => window.__app.cur.model.undo());
  await delay(100);
  assert.equal(await source(), hello);
  await page.click('#btn-new');
  assert.equal(confirmations.length, confirmed, '撤销回载入版本后不再询问');
  await page.select('#examples', 'hello');
  await setSource(hello + '\n; saved');
  await page.click('#btn-save');
  await delay(100);
  await page.click('#btn-new');
  assert.equal(confirmations.length, confirmed, '保存后不再询问');
  await page.select('#examples', 'hello');
  await setSource(hello + '\n; before switching modes');
  acceptConfirm = false;
  await page.select('#examples', 'chat');
  assert.equal(await page.evaluate(() => window.__app.startupMode), 'debug', '取消双机示例必须在切换模式前生效');
  acceptConfirm = true;
  confirmed = confirmations.length;
  await page.select('#examples', 'chat');
  await page.waitForFunction(() => window.__app.startupMode === 'dual' && window.__app.sessions.every(s => s.fileName === 'chat.asm') && !document.querySelector('.toolbar').inert);
  assert.equal(confirmations.length, confirmed + 1, '切换到双机示例只确认一次');
  await checkToolbars(true);

  phase = 'dual';
  const otherSource = await page.evaluate(() => window.__app.sessions[1].model.getValue());
  await setSource((await source()) + '\n; dual edit');
  acceptConfirm = false;
  await page.click('#btn-new');
  assert.notEqual(await source(), '', '双机新建也应保护当前文档的修改');
  acceptConfirm = true;
  await page.click('#btn-new');
  assert.equal(await source(), '');
  assert.equal(await page.evaluate(() => window.__app.cur.fileName), '');
  assert.equal(await page.evaluate(() => window.__app.sessions[1].model.getValue()), otherSource, '新建只清空当前机器的编辑器');
  await setSource(com('MACHINE A'), 0);
  await setSource(EXAMPLES.find(e => e.id === 'hello').source.replace('Hello, 8086!', 'MACHINE B'), 1);
  await page.click('#ed-tabs button:nth-child(2)');
  answer = 'machine-b.exe';
  run(await download('machine-b.exe'), 'machine-b.exe', 'MACHINE B\n');
  await page.click('#ed-tabs button:nth-child(1)');
  answer = 'machine-a.com';
  run(await download('machine-a.com'), 'machine-a.com', 'MACHINE A');
  phase = 'full';
  await page.click('#btn-home');
  await page.waitForFunction(() => window.__app.startupMode === null);
  await enterMode(page, 'full');
  await checkToolbars(false);
  assert.equal(await page.$eval('#btn-export', e => e.checkVisibility()), false);
  assert.equal(await page.$eval('#btn-new', e => e.checkVisibility()), false);
  assert.deepEqual(errors, []);
  console.log('PASS: EXE/COM 下载及异址运行；源码修改/汇编/撤销/保存后的替换确认；打开文件、新建/取消/恢复；双机切换和当前文档；完整模式隐藏');
} finally {
  await browser.close();
  for (const file of readdirSync(temp)) unlinkSync(join(temp, file));
  rmdirSync(temp);
}
