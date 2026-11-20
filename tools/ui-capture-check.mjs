// URL=http://localhost:5317/ node tools/ui-capture-check.mjs
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { enterMode } from './ui-session.mjs';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, defaultViewport: { width: 1600, height: 1000 },
});
try {
  const page = await browser.newPage(), errors = [];
  const cdp = await page.createCDPSession();
  const url = process.env.URL || 'http://localhost:5317/';
  for (const name of ['keyboard-lock', 'pointer-lock'])
    await cdp.send('Browser.setPermission', { permission: { name }, setting: 'granted', origin: new URL(url).origin });
  page.on('pageerror', e => errors.push(e.stack ?? e.message));
  page.on('dialog', d => d.accept());
  await page.goto(url, { waitUntil: 'networkidle0' });
  await enterMode(page);
  assert.equal(await page.$eval('#fullscreen-capture', e => e.checked), false);
  await page.evaluate(() => {
    const app = window.__app, s = app.cur;
    app.editor.setText(s.model, `.model small
.stack 100h
.code
start: mov dx, 2fbh
mov al, 80h
out dx, al
mov dx, 2f8h
mov al, 96
out dx, al
inc dx
xor al, al
out dx, al
mov dx, 2fbh
mov al, 2
out dx, al
inc dx
mov al, 3
out dx, al
xor bx, bx
again: xor ax, ax
int 16h
cmp al, 27
jne again
inc bx
jmp again
end start`);
    s.dirty = true;
    window.__keys = [];
    const onKey = s.screen.onKey;
    s.screen.onKey = key => { window.__keys.push(key); onKey(key); };
  });
  await page.click('#btn-run');
  await page.waitForFunction(() => window.__app.cur.m.status === 'waiting' && window.__app.cur.screen.relative);
  const lock = async () => {
    await page.click('.screen');
    await page.waitForFunction(() => !!document.pointerLockElement || document.getElementById('tab-messages').textContent.includes('鼠标捕获失败'), { timeout: 10000 }).catch(async error => {
      console.error(await page.evaluate(() => ({
        fullscreen: document.fullscreenElement?.className,
        pointer: document.pointerLockElement?.className,
        pending: window.__app.cur.screen.capturing,
        relative: window.__app.cur.screen.relative,
        focused: document.activeElement?.className,
        status: document.getElementById('status').textContent,
        messages: document.getElementById('tab-messages').textContent,
      })));
      throw error;
    });
    assert.equal(await page.evaluate(() => !!document.pointerLockElement), true, await page.$eval('#tab-messages', e => e.textContent));
  };
  const unlock = async () => {
    await page.keyboard.down('ControlRight');
    await page.waitForFunction(() => !document.pointerLockElement && !document.fullscreenElement);
    await page.keyboard.down('ControlRight');
    await page.keyboard.up('ControlRight');
  };
  const ctrlEvents = () => page.evaluate(() => window.__keys.filter(e => (e.scan & 0x7f) === 0x1d));
  await lock();
  assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
  await page.keyboard.press('ControlLeft');
  assert.deepEqual((await ctrlEvents()).map(e => e.scan), [0x1d, 0x9d]);
  assert.equal(await page.evaluate(() => !!document.pointerLockElement), true, '左 Ctrl 不能释放捕获');
  await page.keyboard.down('ShiftLeft');
  const count = (await ctrlEvents()).length;
  await unlock();
  assert.equal((await ctrlEvents()).length, count, '释放捕获的右 Ctrl 按下和松开都不能传入客体');
  await page.waitForFunction(() => (window.__app.cur.m.mem[0x417] & 7) === 0);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.press('ControlRight');
  assert.equal((await ctrlEvents()).length, count + 2, '未捕获时右 Ctrl 仍可供客体使用');

  await page.click('#fullscreen-capture');
  await lock();
  await page.waitForFunction(() => !!document.fullscreenElement && !window.__app.cur.screen.capturing);
  assert.equal(await page.$eval('.capture-hint', e => e.checkVisibility()), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__app.cur.m.cpu.r[3] === 1);
  assert.equal(await page.evaluate(() => !!document.pointerLockElement && !!document.fullscreenElement), true, 'Esc 必须进入客体而不退出捕获');
  assert.deepEqual(await page.evaluate(() => window.__keys.filter(e => (e.scan & 0x7f) === 1).map(e => [e.scan, e.ascii])), [[1, 27], [0x81, 0]]);
  await unlock();
  await page.click('#btn-pause');

  await lock();
  await page.waitForFunction(() => !!document.fullscreenElement && !window.__app.cur.screen.capturing);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.pointerLockElement && !document.fullscreenElement);
  await lock();
  await page.waitForFunction(() => !!document.fullscreenElement && !window.__app.cur.screen.capturing);
  await cdp.send('Browser.setPermission', { permission: { name: 'keyboard-lock' }, setting: 'denied', origin: new URL(url).origin });
  await page.waitForFunction(() => !document.pointerLockElement && !document.fullscreenElement &&
    document.getElementById('tab-messages').textContent.includes('权限已撤销'));
  await page.click('.screen');
  await page.waitForFunction(() => !window.__app.cur.screen.capturing && !document.pointerLockElement && !document.fullscreenElement &&
    document.getElementById('tab-messages').textContent.includes('鼠标捕获失败'), { timeout: 10000 }).catch(async error => {
    console.error(await page.evaluate(async () => ({
      keyboardPermission: (await navigator.permissions.query({ name: 'keyboard-lock' })).state,
      fullscreen: document.fullscreenElement?.className,
      pointer: document.pointerLockElement?.className,
      pending: window.__app.cur.screen.capturing,
      messages: document.getElementById('tab-messages').textContent,
    })));
    throw error;
  });
  assert.match(await page.$eval('#tab-messages', e => e.textContent), /denied|allow|permission|拒绝/i);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'keyboard', { configurable: true, value: undefined });
  });
  await page.click('.screen');
  await page.waitForFunction(() => document.getElementById('tab-messages').textContent.includes('需要支持键盘锁定'));
  assert.equal(await page.evaluate(() => !document.pointerLockElement && !document.fullscreenElement), true);
  await page.evaluate(() => { delete navigator.keyboard; });
  await page.click('#btn-home');
  await page.waitForFunction(() => window.__app.startupMode === null);
  await enterMode(page, 'dual');
  assert.equal(await page.evaluate(() => window.__app.sessions.every(s => s.screen.fullscreenCapture)), true, '全屏捕获设置应保存并用于两台机器');
  assert.deepEqual(errors, []);
  console.log('PASS: 真实鼠标捕获；右 Ctrl 释放且无客体残留、左 Ctrl 保留；全屏锁定中 Esc 到达客体；退出清理；拒绝权限/不支持时明确报错；设置持久化');
} finally {
  await browser.close();
}
