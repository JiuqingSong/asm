// 图形模式检查：VGA 示例、画线示例的截图（开发版）
// 用法：node tools/ui-gfx.mjs <截图目录>
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
const status = () => page.$eval('#status', e => e.textContent);

await page.select('#cpu', '386');
await page.select('#examples', 'vga');
await sleep(300);
await page.click('#btn-run');
await sleep(1500);
console.log('VGA：', await status());
await page.screenshot({ path: join(out, 'gfx-1-vga.png') });
await page.focus('.screen');
await page.keyboard.press('Space');
await sleep(1500);
await page.screenshot({ path: join(out, 'gfx-2-rotate.png') });
await page.keyboard.press('Space');
await sleep(500);
console.log('VGA 退出后：', await status());

await page.select('#cpu', '8088');
await page.select('#examples', 'lines');
await sleep(300);
await page.click('#btn-run');
await sleep(1200);
await page.screenshot({ path: join(out, 'gfx-3-lines-drawing.png') });
await sleep(4000);
console.log('画线：', await status());
await page.screenshot({ path: join(out, 'gfx-4-lines.png') });
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
