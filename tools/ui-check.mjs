// 用无头浏览器检查界面：截图 + 执行一组操作
// 用法：node tools/ui-check.mjs <输出目录> [url]
import puppeteer from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '.';
const url = process.argv[3] ?? 'http://localhost:5317/';
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('dialog', d => d.accept());
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
await page.goto(url, { waitUntil: 'networkidle0' });
await enterMode(page);
await new Promise(r => setTimeout(r, 800));
const shot = async (name) => { await page.screenshot({ path: join(out, name + '.png') }); };
const status = () => page.$eval('#status', e => e.textContent);
await shot('01-start');
console.log('初始状态：', await status());

// 单步几次
for (let i = 0; i < 4; i++) await page.click('#btn-step');
await new Promise(r => setTimeout(r, 300));
await shot('02-stepped');
console.log('单步 4 次后：', await status(), await page.$eval('#cs-ip', e => e.textContent));

// 运行到结束
await page.click('#btn-run');
await new Promise(r => setTimeout(r, 800));
console.log('运行后：', await status());
await shot('03-ran');

// 换成"子程序与栈"示例，单步进入子程序
await page.select('#examples', 'stack');
await new Promise(r => setTimeout(r, 300));
for (let i = 0; i < 5; i++) await page.click('#btn-step');
await new Promise(r => setTimeout(r, 300));
await shot('04-stack');
console.log('栈示例：', await page.$eval('#stack', e => e.innerText.replace(/\n+/g, ' | ')));

// 键盘输入示例
await page.select('#examples', 'input');
await new Promise(r => setTimeout(r, 300));
await page.click('#btn-run');
await new Promise(r => setTimeout(r, 500));
console.log('输入示例：', await status());
await page.focus('.screen');
await page.keyboard.type('Hello asm');
await page.keyboard.press('Enter');
await new Promise(r => setTimeout(r, 600));
console.log('输入后：', await status());
await shot('05-input');

// 冒泡排序：变量页
await page.select('#examples', 'sort');
await new Promise(r => setTimeout(r, 300));
await page.click('#btn-run');
await new Promise(r => setTimeout(r, 600));
console.log('排序变量：', await page.$eval('#tab-vars', e => e.innerText.replace(/\n+/g, ' | ')));
await shot('06-sort');

// 内存页
await page.click('.tabs button[data-tab="memory"]');
await new Promise(r => setTimeout(r, 200));
await shot('07-memory');

// 机器码显示 + 慢速动画
await page.select('#examples', 'sum');
await new Promise(r => setTimeout(r, 300));
await page.click('#show-bytes');
await page.select('#speed', '5');
await page.click('#btn-run');
await new Promise(r => setTimeout(r, 1300));
await shot('08-animate');
console.log('动画中：', await status(), await page.$eval('#cs-ip', e => e.textContent));
await page.click('#btn-pause');
await page.click('#btn-back');
await page.click('#btn-back');
await new Promise(r => setTimeout(r, 200));
console.log('后退两步：', await status(), await page.$eval('#cs-ip', e => e.textContent));
await page.select('#speed', '0');
await page.click('#show-bytes');

// 时钟中断示例
await page.select('#examples', 'timer');
await new Promise(r => setTimeout(r, 300));
await page.click('#btn-run');
await new Promise(r => setTimeout(r, 1500));
console.log('时钟示例：', await status());
await shot('09-timer');

// 汇编错误
await page.focus('.monaco-editor textarea');
await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
await page.keyboard.type(['.model small', '.code', 'start:', 'mov ds, 1234h', 'mov [bx], 1', 'shl ax, 4', 'jmp nowhere', 'end start', ''].join(String.fromCharCode(10)));
await page.click('#btn-assemble');
await new Promise(r => setTimeout(r, 400));
console.log('错误：', await status());
console.log(await page.$eval('#tab-messages', e => e.innerText));
await shot('10-errors');

console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
