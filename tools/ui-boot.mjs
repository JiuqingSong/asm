// 从磁盘映像启动的界面检查（开发版）：通过"放入"按钮选择软盘映像，新建硬盘，从 A: 启动，按键，截图
// 用法：node tools/ui-boot.mjs <截图目录> <A: 映像> [按键...]
//   按键：Enter、F3、Escape 之类的键名，或者 "text:要输入的文字"，或者 "wait:秒数"
//   环境变量 HD=硬盘映像：上传到 C:（否则新建 64MB 空白硬盘）；ISO=光盘映像：放进 D:；FROM=C 从 C: 启动；A: 映像写 - 表示不放软盘
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [out, image, ...keys] = process.argv.slice(2);
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
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); indexedDB.deleteDatabase('asm86-disks'); } catch { /* */ } });
await page.goto(process.env.URL || 'http://localhost:5317/', { waitUntil: 'networkidle0' });
await page.waitForSelector('.monaco-editor');
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.select('#cpu', '386');
await page.select('#speed', '0'); // 全速
await page.click('.tabs button[data-tab="files"]');
await sleep(300);
if (image !== '-') {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#drives button[data-act="insert"][data-drive="0"]')]);
  await chooser.accept([image]);
  await sleep(500);
}
if (process.env.HD) {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#drives button[data-act="insert"][data-drive="2"]')]);
  await chooser.accept([process.env.HD]);
  await sleep(1000);
} else await page.select('#drives select[data-act="newhd"]', '64');
if (process.env.CD) { // 光盘映像放进光驱
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#drives button[data-act="cd-insert"]')]);
  await chooser.accept([process.env.CD]);
  await sleep(1000);
}
if (process.env.ISO) { // 光盘映像放进 D:
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#drives button[data-act="insert"][data-drive="3"]')]);
  await chooser.accept([process.env.ISO]);
  await sleep(1000);
}
await sleep(300);
console.log('磁盘：', await page.$$eval('#drives .drive-row', rows => rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));
await page.screenshot({ path: join(out, 'boot-0-drives.png') });
await page.click(`#drives button[data-act="boot"][data-from="${process.env.FROM === 'C' ? 128 : 0}"]`);
const screenText = () => page.evaluate(() => {
  if (!window.__app) return document.querySelector('.screen').innerText.split(/\n/).filter(s => s.trim()).slice(0, 8).join(' / ');
  const m = window.__app.cur.m, rows = [];
  for (let r = 0; r < 25; r++) { let s = ''; for (let c = 0; c < 80; c++) s += String.fromCharCode(m.video.textCell(r * 80 + c)[0] || 32); rows.push(s.trimEnd()); }
  return rows.filter(Boolean).slice(0, 8).join(' / ');
});
await sleep(8000);
console.log('启动后：', await screenText());
await page.screenshot({ path: join(out, 'boot-1.png') });
let n = 1;
for (const k of keys) {
  if (k.startsWith('wait:')) { await sleep(+k.slice(5) * 1000); continue; }
  await page.focus('.screen');
  if (k.startsWith('text:')) await page.keyboard.type(k.slice(5), { delay: 50 });
  else await page.keyboard.press(k);
  await sleep(4000);
  console.log(`按 ${k}：`, await screenText());
  await page.screenshot({ path: join(out, `boot-${++n}.png`) });
}
console.log('状态：', await page.$eval('#status', e => e.textContent));
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
