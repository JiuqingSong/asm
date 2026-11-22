// 检查触屏设备（手机）的键盘输入：隐藏文本框、软键盘事件、外接键盘、额外按键
// 用法：node tools/ui-touch-keys.mjs [输出目录] [url]
import puppeteer, { KnownDevices } from 'puppeteer-core';
import { enterMode } from './ui-session.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '.';
const url = process.argv[3] ?? 'http://localhost:5317/';
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.emulate(KnownDevices['iPhone 13']);
const errors = [];
page.on('dialog', d => d.accept());
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
await page.goto(url, { waitUntil: 'networkidle0' });
await enterMode(page);
const wait = ms => new Promise(r => setTimeout(r, ms));
const screenText = () => page.$eval('.screen', e => e.innerText.replace(/\s+$/gm, '').trim());
let fail = 0;
const check = (name, ok) => { console.log((ok ? 'OK   ' : 'FAIL ') + name); if (!ok) fail++; };

check('有隐藏文本框和额外按键', await page.$eval('.screen-box', b => !!b.querySelector('.key-proxy') && b.querySelectorAll('.touch-keys button').length > 20));

await page.select('#examples', 'input');
await wait(300);
await page.click('#btn-run');
await wait(500);
await page.tap('.screen');
check('轻点屏幕后文本框获得焦点', await page.evaluate(() => document.activeElement?.className === 'key-proxy'));

// iOS 软键盘：keydown 只有 key，没有 code
await page.evaluate(() => {
  const t = document.activeElement;
  for (const ch of 'Hi') t.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
});
// Android 软键盘：keydown 是 229 / Unidentified，字符在 input 事件里
await page.evaluate(() => {
  const t = document.activeElement;
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
  t.value += ' ok!';
  t.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ' ok!', bubbles: true }));
  t.value = t.value.slice(0, -1);
  t.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
});
// 外接键盘：有 code
await page.keyboard.type('X');
await wait(200);
await page.screenshot({ path: join(out, 'touch-1.png') });
const before = await screenText();
check('软键盘和外接键盘输入出现在屏幕上：' + JSON.stringify(before.split('\n').pop()), /Hi okX/.test(before));
// 额外按键的 Enter：用文本框回车
await page.evaluate(() => document.activeElement.dispatchEvent(new InputEvent('input', { inputType: 'insertLineBreak', bubbles: true })));
await wait(600);
check('回车结束输入：' + await page.$eval('#status', e => e.textContent), !/等待/.test(await page.$eval('#status', e => e.textContent)));
const ctrlOn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.touch-keys button')].find(b => b.textContent === 'Ctrl');
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  return b.classList.contains('on') && document.activeElement?.className === 'key-proxy';
});
check('Ctrl 粘滞且不抢焦点', ctrlOn);
await page.screenshot({ path: join(out, 'touch-2.png') });
console.log(errors.join('\n') || '无页面错误');
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
