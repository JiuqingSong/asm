// 在浏览器里直接运行一个 DOS 可执行文件（开发版），打开中文显示，截图
// 用法：node tools/ui-exe.mjs <截图目录> <EXE 文件> [其他要放进虚拟磁盘的文件...]
import puppeteer from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const [out, exe, ...extra] = process.argv.slice(2);
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
await enterMode(page);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const files = [exe, ...extra].map(f => [basename(f).toUpperCase(), Array.from(readFileSync(f))]);
await page.evaluate(files => {
  for (const [name, bytes] of files) window.__app.sessions[0].m.files.set(name, new Uint8Array(bytes));
}, files);
await page.select('#cpu', process.env.CPU || '386');
await page.click('.tabs button[data-tab="files"]');
await sleep(200);
await page.click(`button[data-act="run"][data-name="${basename(exe).toUpperCase()}"]`);
await sleep(2500);
await page.click('.cn-toggle');
await sleep(500);
console.log('状态：', await page.$eval('#status', e => e.textContent));
await page.screenshot({ path: join(out, 'exe-1.png') });
await page.focus('.screen');
await page.keyboard.press('Escape');
await sleep(2500);
await page.screenshot({ path: join(out, 'exe-2-menu.png') });
await page.keyboard.press('ArrowRight');
await sleep(2000);
await page.screenshot({ path: join(out, 'exe-3-menu2.png') });
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
