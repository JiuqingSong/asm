// "原机速度"检查：示例程序按真实时间运行所需的秒数
// 用法：node tools/ui-realtime.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5317/';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const errors = [];
page.on('dialog', d => d.accept());
page.on('pageerror', e => errors.push(e.message));
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch { /* */ } });
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForSelector('.monaco-editor');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = () => page.$eval('#status', e => e.textContent);

for (const [id, cpu, expect] of [['timer', '8088', '约 5 秒'], ['music', '8088', '约 7 秒'], ['timer', '386', '约 5 秒（与 CPU 速度无关）']]) {
  await page.select('#examples', id);
  await sleep(300);
  await page.select('#cpu', cpu);
  await page.select('#speed', '-1');
  const t0 = Date.now();
  await page.click('#btn-run');
  await sleep(200);
  const during = await status();
  while (Date.now() - t0 < 20000) {
    await sleep(100);
    if (!(await status()).includes('运行中')) break;
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await page.evaluate(() => {
    const m = window.__app.cur.m;
    return `${m.instructions.toLocaleString()} 条指令，虚拟时间 ${(m.clock / 1193182).toFixed(2)} 秒`;
  });
  console.log(`${id} / ${cpu}：用时 ${sec} 秒（应为${expect}），${info}；运行中显示"${during}"，结束后"${await status()}"`);
}
console.log(errors.length ? '页面错误：' + errors.join(' / ') : '没有页面错误');
await browser.close();
