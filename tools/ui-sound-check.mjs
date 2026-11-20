// URL=http://localhost:5317/ node tools/ui-sound-check.mjs
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(process.env.URL || 'http://localhost:5317/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__app);
  await page.click('[data-start="debug"]');
  await page.click('[data-option="sound"]');
  await page.click('#startup-config button[type="submit"]');
  await page.waitForFunction(() => !!window.__app.cur.program);
  await page.evaluate(() => {
    const app = window.__app, m = app.cur.m;
    app.editor.setText(app.cur.model, '.model tiny\n.code\norg 100h\nstart: jmp start\nend start');
    app.assembleAll(true);
    for (let frame = 0; frame < 16384; frame++) {
      for (let channel = 0; channel < 2; channel++) {
        const value = Math.round(Math.sin(frame * 2 * Math.PI * (channel ? 660 : 440) / 48000) * 12000);
        const offset = 0x20000 + frame * 4 + channel * 2;
        m.mem[offset] = value & 255; m.mem[offset + 1] = value >> 8 & 255;
      }
    }
    const out = m.cpu.io.out8;
    out(0xd8, 0);
    out(0xc4, 0); out(0xc4, 0);
    out(0xc6, 0xff); out(0xc6, 0x7f);
    out(0x8b, 2); out(0xd6, 0x59); out(0xd4, 1);
    for (const value of [0x41, 0xbb, 0x80, 0xd1, 0xb6, 0x30, 0xff, 0])
      out(0x22c, value);
  });
  await page.select('#speed', '-1');
  const stats = () => page.evaluate(() => ({ ...window.__app.cur.pcm.stats }));
  await page.click('#btn-run');
  await page.waitForFunction(() => window.__app.cur.pcm.stats.nonzero > 4096, { timeout: 20000 });
  const playing = await stats();
  assert.ok(playing.submitted > 4096);
  await page.click('#btn-pause');
  await delay(250);
  const stopped = await stats();
  await delay(250);
  assert.equal((await stats()).nonzero, stopped.nonzero, 'paused output must be flushed');
  await page.click('#btn-run');
  await page.waitForFunction(n => window.__app.cur.pcm.stats.nonzero > n + 4096, {}, stopped.nonzero);
  await page.click('#btn-pause');
  await page.select('#speed', '0');
  await page.click('#btn-run');
  await delay(250);
  const fast = await stats();
  await delay(250);
  assert.equal((await stats()).nonzero, fast.nonzero, 'full-speed output must remain muted');
  await page.click('#btn-pause');
  assert.deepEqual(errors, []);
  const messages = await page.evaluate(() => window.__app.messages.filter(message => message.level === 'error'));
  assert.deepEqual(messages, []);
  console.log('SB16 → DMA → AudioWorklet browser playback, pause/resume and full-speed mute verified', playing);
} finally {
  await browser.close();
}
