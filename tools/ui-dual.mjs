// 双机界面检查：串口聊天示例 + （如果提供）send.asm/receive.asm 文件传输
// 用法：node tools/ui-dual.mjs <截图目录> [send.asm] [receive.asm]
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [out = '.', sendPath, recvPath] = process.argv.slice(2);
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
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch { /* */ } });
await page.goto('http://localhost:5317/', { waitUntil: 'networkidle0' });
await page.waitForSelector('.monaco-editor');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = () => page.$eval('#status', e => e.textContent);

await page.select('#examples', 'chat');
await sleep(400);
console.log('模式：', await page.$eval('#mode', e => e.value), '标签：', await page.$eval('#ed-tabs', e => e.innerText.replace(/\n/g, ' | ')));
await page.click('#btn-run');
await sleep(500);
const screens = await page.$$('.screen');
await screens[0].click();
await page.keyboard.type('hello B');
await page.keyboard.press('Enter');
await sleep(800);
await screens[1].click();
await page.keyboard.type('hi A!');
await sleep(800);
console.log('聊天：', await status());
console.log('A 屏幕：', JSON.stringify(await page.evaluate(() => window.__app.sessions[0].m.console)));
console.log('B 屏幕：', JSON.stringify(await page.evaluate(() => window.__app.sessions[1].m.console)));
await page.click('.tabs button[data-tab="serial"]');
await sleep(300);
await page.screenshot({ path: join(out, 'dual-chat.png') });

if (sendPath && existsSync(sendPath)) {
  await page.click('#btn-pause');
  const send = readFileSync(sendPath, 'latin1');
  const recv = readFileSync(recvPath, 'latin1');
  await page.select('#cpu', '286');
  await page.select('#uart-mode', 'buffered');
  await page.evaluate((send, recv) => {
    const a = window.__app;
    a.editor.setText(a.sessions[0].model, send); a.sessions[0].dirty = true; a.sessions[0].fileName = 'send.asm';
    a.editor.setText(a.sessions[1].model, recv); a.sessions[1].dirty = true; a.sessions[1].fileName = 'receive.asm';
    a.sessions[0].cmdline.value = ' c:' + String.fromCharCode(92) + 'test.txt';
    const text = 'Hello from 2003!\r\n'.repeat(300);
    a.sessions[0].m.files.set('TEST.TXT', new TextEncoder().encode(text));
  }, send, recv);
  await page.click('#btn-run');
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = await status();
    if (!st.includes('运行中')) break;
  }
  console.log('文件传输：', await status());
  console.log(await page.evaluate(() => {
    const a = window.__app;
    const src = a.sessions[0].m.files.get('TEST.TXT');
    const dst = a.sessions[1].m.files.get('TEST.TXT');
    const same = !!dst && src.length === dst.length && src.every((b, i) => b === dst[i]);
    return `发送 ${src?.length} 字节，收到 ${dst?.length ?? '没有'} 字节，一致：${same}`;
  }));
  await page.screenshot({ path: join(out, 'dual-transfer.png') });
}
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
