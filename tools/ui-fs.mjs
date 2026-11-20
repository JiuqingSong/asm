// 磁盘映像里的文件（开发版）：放入硬盘映像，浏览目录，新建目录，上传文件，再从 C: 启动用 DIR 查看
// 用法：node tools/ui-fs.mjs <截图目录> <装好 DOS 的硬盘映像> <要放进去的文件...>
import puppeteer from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const [out, hd, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'games' : undefined));
page.on('pageerror', e => errors.push(e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); indexedDB.deleteDatabase('asm86-disks'); } catch { /* */ } });
await page.goto(process.env.URL || 'http://localhost:5317/', { waitUntil: 'networkidle0' });
await enterMode(page, 'full');
const sleep = ms => new Promise(r => setTimeout(r, ms));
await page.select('#speed', '0');
await sleep(300);
let [ch] = await Promise.all([page.waitForFileChooser(), page.click('#drives button[data-act="insert"][data-drive="2"]')]);
await ch.accept([hd]);
await sleep(1000);
await page.click('#drives button[data-act="browse"][data-drive="2"]');
await sleep(300);
const list = () => page.$$eval('#drives .fs-box', b => b.map(x => x.innerText.replace(/\s+/g, ' ').trim()).join(' | '));
console.log('根目录：', (await list()).slice(0, 300));
await page.click('#drives button[data-act="fs-enter"][data-name="DOS"]');
await sleep(300);
console.log('进入 DOS：', (await list()).slice(0, 160));
await page.click('#drives button[data-act="fs-up"]');
await sleep(300);
await page.click('#drives button[data-act="fs-mkdir"]');   // 提示框里输入 games
await sleep(300);
await page.click('#drives button[data-act="fs-enter"][data-name="GAMES"]');
await sleep(300);
[ch] = await Promise.all([page.waitForFileChooser(), page.click('#drives button[data-act="fs-upload"]')]);
await ch.accept(files);
await sleep(1500);
console.log('GAMES 里：', await list());
await page.screenshot({ path: join(out, 'fs-1.png') });
await page.click('#boot-choice button[data-boot="128"]');
await sleep(8000);
await page.focus('.screen');
await page.keyboard.type('dir games', { delay: 30 });
await page.keyboard.press('Enter');
await sleep(3000);
console.log('DOS 里 DIR：', await page.evaluate(() => document.querySelector('.screen').innerText.split(/\n/).filter(s => s.trim()).slice(-8).join(' / ')));
await page.screenshot({ path: join(out, 'fs-2-dir.png') });
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
void basename;
