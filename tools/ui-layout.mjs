// 布局检查：拖动三条分隔条、逐个最大化四个窗口（开发版）
// 用法：node tools/ui-layout.mjs <截图目录>
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
const sizes = () => page.evaluate(() => {
  const r = s => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return e.offsetParent === null ? '隐藏' : `${Math.round(b.width)}×${Math.round(b.height)}`; };
  return `编辑器 ${r('.editor-pane')}，屏幕 ${r('.screen-pane')}（字号 ${document.querySelector('.screen').style.fontSize}），寄存器 ${r('.cpu-pane')}，信息 ${r('.info-pane')}`;
});

await page.select('#examples', 'hello');
await sleep(300);
await page.click('#btn-run');
await sleep(800);
console.log('默认：', await sizes());
await page.screenshot({ path: join(out, 'layout-0.png') });

async function drag(sel, dx, dy) {
  const b = await page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(b.x + (dx * k) / 10, b.y + (dy * k) / 10);
  await page.mouse.up();
  await sleep(300);
}
await drag('.splitter.v', -200, 0);
await drag('.col-left .splitter.h', 0, -200);
await drag('.col-right .splitter.h', 0, 150);
console.log('拖动后：', await sizes());
await page.screenshot({ path: join(out, 'layout-1-dragged.png') });

const panes = ['.editor-pane', '.screen-pane', '.cpu-pane', '.info-pane'];
for (const [i, p] of panes.entries()) {
  await page.click(`${p} .max-btn`);
  await sleep(400);
  console.log(`最大化 ${p}：`, await sizes());
  await page.screenshot({ path: join(out, `layout-2-max${i}.png`) });
  await page.click(`${p} .max-btn`);
  await sleep(200);
}
// 双击标题栏最大化，Esc 还原
await page.click('.cpu-pane .pane-head', { clickCount: 2 });
await sleep(300);
console.log('双击寄存器标题：', await sizes());
await page.mouse.click(5, 5);
await page.keyboard.press('Escape');
await sleep(300);
console.log('Esc 后：', await sizes());
// 刷新后恢复大小
await page.evaluate(() => { window.__noClear = true; });
const saved = await page.evaluate(() => localStorage.getItem('asm86.layout'));
console.log('保存的布局：', saved);
// 双击分隔条恢复默认
await page.click('.splitter.v', { clickCount: 2 });
await page.click('.col-left .splitter.h', { clickCount: 2 });
await page.click('.col-right .splitter.h', { clickCount: 2 });
await sleep(300);
console.log('双击分隔条后：', await sizes());
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
