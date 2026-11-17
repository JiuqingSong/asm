// 调试功能检查：运行到光标处、跳出、反汇编、修改寄存器（开发版）
// 用法：node tools/ui-debug.mjs <截图目录> [可执行文件]
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const [out = '.', exe] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('dialog', d => d.accept());
page.on('pageerror', e => errors.push(e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch { /* */ } });
await page.goto('http://localhost:5317/', { waitUntil: 'networkidle0' });
await page.waitForSelector('.monaco-editor');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = () => page.$eval('#status', e => e.textContent);
const where = () => page.$eval('#cs-ip', e => e.textContent);

await page.select('#examples', 'stack');
await sleep(300);
await page.select('#speed', '0');
// 光标放到 fact 里的 "mul cx" 一行，按 Ctrl+F10
const mulLine = await page.evaluate(() => {
  const a = window.__app;
  const model = a.cur.model;
  const n = model.getLinesContent().findIndex(l => l.includes('mul cx')) + 1;
  a.editor.editor.setPosition({ lineNumber: n, column: 1 });
  return n;
});
await page.keyboard.down('Control'); await page.keyboard.press('F10'); await page.keyboard.up('Control');
await sleep(500);
console.log(`运行到光标（第 ${mulLine} 行）：`, await status(), '|', await where());
// 第一次到 mul cx 时在最内层递归里；跳出一层
await page.keyboard.down('Shift'); await page.keyboard.press('F11'); await page.keyboard.up('Shift');
await sleep(300);
console.log('跳出：', await status(), '|', await where());
await page.click('.tabs button[data-tab="disasm"]');
await sleep(300);
console.log('反汇编页：\n' + (await page.$eval('#tab-disasm', e => e.innerText)).split('\n').slice(0, 8).join('\n'));
await page.screenshot({ path: join(out, 'debug-1-disasm.png') });

// 修改 AX
await page.click('#regs [data-reg="r0"]');
await sleep(100);
await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
await page.keyboard.type('BEEF');
await page.keyboard.press('Enter');
await sleep(200);
console.log('改 AX：', await status(), '| AX =', await page.evaluate(() => window.__app.cur.m.cpu.r[0].toString(16)));
await page.click('#flags [data-flag="1"]');
await sleep(200);
console.log('切换 CF：', await page.evaluate(() => (window.__app.cur.m.cpu.flags & 1) ? 'CF=1' : 'CF=0'));
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('F11'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('F11'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await sleep(200);
console.log('后退两次后：AX =', await page.evaluate(() => window.__app.cur.m.cpu.r[0].toString(16)), await page.evaluate(() => (window.__app.cur.m.cpu.flags & 1) ? 'CF=1' : 'CF=0'));
await page.screenshot({ path: join(out, 'debug-2-regs.png') });

if (exe) {
  await page.evaluate((name, bytes) => window.__app.sessions[0].m.files.set(name, new Uint8Array(bytes)), basename(exe).toUpperCase(), Array.from(readFileSync(exe)));
  await page.select('#cpu', '386');
  await page.select('#speed', '-1');
  await page.click('.tabs button[data-tab="files"]');
  await sleep(200);
  await page.click(`button[data-act="run"][data-name="${basename(exe).toUpperCase()}"]`);
  await sleep(2500);
  await page.click('#btn-pause');
  await sleep(300);
  console.log('可执行文件暂停后：', await where());
  await page.click('#btn-step');
  await page.click('#btn-step');
  await sleep(300);
  console.log('单步两次：', await where());
  await page.screenshot({ path: join(out, 'debug-3-exe.png') });
}
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
