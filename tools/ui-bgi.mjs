// 在浏览器里运行一个用 BGI 驱动的图形程序（640×480 的 VGA 平面模式，开发版），用鼠标点几下，截图
// 用法：node tools/ui-bgi.mjs <截图目录> <EXE 文件> [x,y ...]
//   和 EXE 在同一个目录里的其他文件（BGI 驱动、字库）都放进虚拟磁盘；
//   x,y 是要依次单击的位置（程序的 640×480 坐标），每次单击后截一张图
import puppeteer from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const [out, exe, ...clicks] = process.argv.slice(2);
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

const dir = dirname(exe);
const files = readdirSync(dir).filter(n => statSync(join(dir, n)).isFile()).map(n => [n.toUpperCase(), Array.from(readFileSync(join(dir, n)))]);
await page.evaluate(files => {
  for (const [name, bytes] of files) window.__app.sessions[0].m.files.set(name, new Uint8Array(bytes));
}, files);
await page.select('#cpu', process.env.CPU || '386');
await page.click('.tabs button[data-tab="files"]');
await sleep(200);
await page.click(`button[data-act="run"][data-name="${basename(exe).toUpperCase()}"]`);
await sleep(4000);
const info = () => page.evaluate(() => {
  const m = window.__app.cur.m;
  return `模式 ${m.mem[0x449].toString(16)}h，鼠标 (${m.mouse.x},${m.mouse.y}) ${m.mouse.visible === 0 ? '显示' : '隐藏'}，范围 y≤${m.mouse.maxY}；${document.querySelector('#status').textContent}`;
});
console.log('启动：', await info());
await page.screenshot({ path: join(out, 'bgi-0.png') });
const box = await page.$eval('.screen canvas.gfx', c => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
let k = 0;
for (const c of clicks) {
  const [x, y] = c.split(',').map(Number);
  const px = box.x + (x + 0.5) * box.w / 640, py = box.y + (y + 0.5) * box.h / 480;
  await page.mouse.move(px, py);
  await sleep(200);
  await page.mouse.down();
  await sleep(150);
  await page.mouse.up();
  await sleep(1500);
  console.log(`单击 (${x},${y})：`, await info());
  await page.screenshot({ path: join(out, `bgi-${++k}.png`) });
}
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
