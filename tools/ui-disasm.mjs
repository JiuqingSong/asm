// 反汇编页检查：输入地址、翻页、滚轮、回到 CS:IP（开发版）
// 用法：node tools/ui-disasm.mjs <截图目录> <EXE 文件> [地址]
//   和 EXE 在同一个目录里的文件都放进虚拟磁盘
import puppeteer from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const [out, exe, addr = '335D:32AD'] = process.argv.slice(2);
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
await page.select('#cpu', '386');
await page.click('.tabs button[data-tab="files"]');
await sleep(200);
await page.click(`button[data-act="run"][data-name="${basename(exe).toUpperCase()}"]`);
await sleep(3000);
await page.click('#btn-pause');
await sleep(300);
await page.click('.tabs button[data-tab="disasm"]');
await sleep(300);
const state = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#tab-disasm .drow .da')].map(e => e.textContent);
  return `地址栏 ${document.querySelector('.dis-addr').value}，第一行 ${rows[0]}，最后一行 ${rows[rows.length - 1]}（${rows.length} 行）；${document.querySelector('.dis-note').textContent}`;
});
console.log('暂停后：', await state());
const input = await page.$('.dis-addr');
await input.click({ clickCount: 3 });
await input.type(addr);
await page.keyboard.press('Enter');
await sleep(300);
console.log(`输入 ${addr}：`, await state());
await page.screenshot({ path: join(out, 'disasm-1-goto.png') });
await page.click('#tab-disasm button[data-act="next"]');
await sleep(200);
console.log('下一页：', await state());
await page.click('#tab-disasm button[data-act="prev"]');
await sleep(200);
console.log('上一页：', await state());
const box = await page.$eval('.dis-list', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(box.x, box.y);
for (let k = 0; k < 4; k++) { await page.mouse.wheel({ deltaY: 100 }); await sleep(60); }
console.log('滚轮向下 4 格：', await state());
for (let k = 0; k < 2; k++) { await page.mouse.wheel({ deltaY: -100 }); await sleep(60); }
console.log('滚轮向上 2 格：', await state());
await page.screenshot({ path: join(out, 'disasm-2-scrolled.png') });
await page.click('#tab-disasm button[data-act="follow"]');
await sleep(200);
console.log('回到 CS:IP：', await state());
await page.click('#btn-step');
await sleep(300);
console.log('单步后：', await state());
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
