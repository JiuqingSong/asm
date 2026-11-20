// 鼠标检查：鼠标画图示例（图形模式）和文本模式的鼠标光标（开发版）
// 用法：node tools/ui-mouse.mjs <截图目录>
import puppeteer from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [out = '.'] = process.argv.slice(2);
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

// 图形模式：画两笔，中间点右键换颜色
await page.select('#cpu', '386');
await page.select('#examples', 'mouse');
await sleep(300);
await page.click('#btn-run');
await sleep(800);
const box = await page.$eval('.screen canvas.gfx', c => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
await page.mouse.move(...at(0.1, 0.2));
await page.mouse.down();
for (let k = 0; k <= 40; k++) { await page.mouse.move(...at(0.1 + k * 0.015, 0.2 + k * 0.01)); await sleep(15); }
await page.mouse.up();
await page.mouse.click(...at(0.5, 0.5), { button: 'right' });
await sleep(200);
await page.mouse.move(...at(0.2, 0.8));
await page.mouse.down();
for (let k = 0; k <= 40; k++) { await page.mouse.move(...at(0.2 + k * 0.015, 0.8 - k * 0.012)); await sleep(15); }
await page.mouse.up();
await page.mouse.move(...at(0.6, 0.4));
await sleep(300);
console.log('画图：', await page.evaluate(() => {
  const m = window.__app.cur.m;
  let n = 0; const colors = new Set();
  for (let i = 0; i < 64000; i++) { const v = m.mem[0xa0000 + i]; if (v) { n++; colors.add(v); } }
  return `画了 ${n} 个像素，颜色 ${[...colors].join(',')}；光标 ${m.mouse.visible === 0 ? '显示' : '隐藏'}，位置 (${m.mouse.x},${m.mouse.y})`;
}));
await page.screenshot({ path: join(out, 'mouse-1-paint.png') });

// 文本模式：显示鼠标光标，打印点击位置
await page.click('#btn-pause');
await page.evaluate(() => {
  const a = window.__app;
  a.editor.setText(a.cur.model, [
    '.model small', '.stack 100h', '.data', "msg db 'Click anywhere, press a key to quit$'", '.code',
    'start: mov ax, @data', ' mov ds, ax', ' mov dx, offset msg', ' mov ah, 9', ' int 21h',
    ' mov ax, 0', ' int 33h', ' mov ax, 1', ' int 33h', ' mov ah, 0', ' int 16h', ' mov ax, 4c00h', ' int 21h', 'end start',
  ].join('\n'));
  a.cur.dirty = true;
});
await page.click('#btn-run');
await sleep(600);
const tb = await page.$eval('.screen', e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
await page.mouse.move(tb.x + tb.w * 0.3, tb.y + tb.h * 0.3);
await sleep(300);
console.log('文本模式：', await page.evaluate(() => { const m = window.__app.cur.m.mouse; return `光标 ${m.visible === 0 ? '显示' : '隐藏'}，位置 (${m.x},${m.y})，即第 ${m.y >> 3} 行第 ${m.x >> 3} 列`; }));
await page.screenshot({ path: join(out, 'mouse-2-text.png') });
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
