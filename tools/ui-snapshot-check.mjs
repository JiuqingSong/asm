// URL=http://localhost:5317/ node tools/ui-snapshot-check.mjs
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { enterMode } from './ui-session.mjs';

const temp = mkdtempSync(join(tmpdir(), 'asm-snapshot-'));
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, defaultViewport: { width: 1600, height: 1000 },
});
let page, phase = 'debug';
const errors = [];
try {
  page = await browser.newPage();
  page.on('pageerror', e => errors.push(`${phase}: ${e.stack ?? e.message}`));
  page.on('dialog', d => d.accept());
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: temp, eventsEnabled: true });
  const download = async () => {
    let name;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('快照下载超时')); }, 120_000);
      const begin = e => { name = e.suggestedFilename; };
      const progress = e => {
        if (e.state === 'inProgress') return;
        cleanup();
        if (e.state === 'completed') resolve();
        else reject(new Error('快照下载被取消'));
      };
      function cleanup() {
        clearTimeout(timer);
        cdp.off('Browser.downloadWillBegin', begin);
        cdp.off('Browser.downloadProgress', progress);
      }
      cdp.on('Browser.downloadWillBegin', begin);
      cdp.on('Browser.downloadProgress', progress);
    });
    await page.click('#btn-snapshot');
    await completed;
    await page.waitForFunction(() => !window.__app.loading);
    assert.match(name, /\.asmsnap$/);
    assert.equal(await page.evaluate(() => window.__app.run), 'idle');
    return join(temp, name);
  };
  const upload = async file => {
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-start="snapshot"]')]);
    await chooser.accept([file]);
  };
  const reloadSnapshot = async (file, mode) => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!window.__app);
    assert.equal(await page.evaluate(() => window.__app.sessions.length), 0);
    await upload(file);
    await page.waitForFunction(mode => !window.__app.loading && (window.__app.startupMode === mode ||
      (document.getElementById('startup-error').textContent && document.getElementById('startup-error').textContent !== '正在校验并载入快照…')),
    { timeout: 120_000 }, mode);
    assert.equal(await page.evaluate(() => window.__app.startupMode), mode, await page.$eval('#startup-error', e => e.textContent));
    assert.equal(await page.evaluate(() => window.__app.run), 'idle');
    assert.equal(await page.$eval('#boot-choice', e => e.open), false);
    assert.match(await page.$eval('#status', e => e.textContent), /暂停/);
  };
  const state = () => page.evaluate(() => window.__app.live.map(({ m }) => ({
    r: [...m.cpu.r], rh: [...m.cpu.rh], s: [...m.cpu.s], ip: m.cpu.ip, flags: m.cpu.flags,
    clock: m.clock, instructions: m.instructions, console: m.console,
    memory: [...m.mem.subarray(0x7c00, 0x7c10)],
    files: [...m.files].map(([name, bytes]) => [name, [...bytes]]),
    disks: m.drives.map(d => d && [d.name, d.dirty, d.changed, d.data.length, [...d.data.subarray(100, 108)]]),
  })));
  const paused = async expected => {
    assert.deepEqual(await state(), expected);
    await delay(250);
    assert.deepEqual(await state(), expected, '恢复后不能自动运行或推进虚拟时间');
    assert.equal(await page.evaluate(() => window.__app.live.every(s => s.m.status === 'paused')), true);
  };
  await page.goto(process.env.URL || 'http://localhost:5317/', { waitUntil: 'networkidle0' });
  await enterMode(page);
  await page.evaluate(() => {
    const app = window.__app, s = app.cur;
    app.editor.setText(s.model, '.model tiny\n.code\norg 100h\nstart: inc bx\njmp start\nend start');
    app.assembleAll(true);
    s.m.files.set('SAVED.TXT', new Uint8Array([1, 2, 3, 4]));
    s.m.cpu.r[3] = 123;
    s.m.cpu.r[0] = 0xabcd;
    app.editor.setBreakpoints(s.model, [4]);
    app.syncBreakpoints(s);
    s.model.pushEditOperations([], [{ range: s.model.getFullModelRange(), text: 'invalid source edited after loading' }], () => null);
    app.editor.setBreakpoints(s.model, [1]);
  });
  const debugFile = await download(), debug = await state();
  await reloadSnapshot(debugFile, 'debug');
  await paused(debug);
  const debugRegisters = await page.$eval('#regs', e => e.textContent);
  assert.equal(await page.evaluate(() => window.__app.cur.model.getValue()), 'invalid source edited after loading');
  assert.deepEqual(await page.evaluate(() => window.__app.editor.breakpointLines(window.__app.cur.model)), [1]);
  await page.click('#btn-run');
  await page.waitForFunction(() => window.__app.cur.m.instructions > 10);
  await page.click('#btn-pause');
  assert.equal(await page.evaluate(() => window.__app.cur.m.cpu.r[0]), 0xabcd, '继续时不能重新汇编已修改的源码');
  assert.equal(await page.evaluate(() => window.__app.cur.dirty), true);

  if (process.env.PRODUCTION_URL) {
    phase = 'production restore';
    const production = await browser.newPage();
    production.on('pageerror', e => errors.push(`${phase}: ${e.stack ?? e.message}`));
    await production.goto(process.env.PRODUCTION_URL, { waitUntil: 'networkidle0' });
    const [chooser] = await Promise.all([production.waitForFileChooser(), production.click('[data-start="snapshot"]')]);
    await chooser.accept([debugFile]);
    await production.waitForFunction(() => !document.querySelector('.toolbar').inert &&
      (document.body.classList.contains('has-session') ||
      (document.getElementById('startup-error').textContent && document.getElementById('startup-error').textContent !== '正在校验并载入快照…')),
    { timeout: 120_000 });
    assert.equal(await production.$eval('#mode-name', e => e.textContent), '直接调试', await production.$eval('#startup-error', e => e.textContent));
    assert.equal(await production.$eval('#regs', e => e.textContent), debugRegisters);
    assert.match(await production.$eval('#status', e => e.textContent), /暂停/);
    await production.click('#btn-run');
    await production.waitForFunction(before => document.getElementById('regs').textContent !== before, {}, debugRegisters);
    await production.click('#btn-pause');
    await production.close();
  }

  phase = 'dual';
  await page.click('#btn-home');
  await page.waitForFunction(() => window.__app.startupMode === null);
  await page.evaluate(() => {
    localStorage.removeItem('asm86.source');
    localStorage.removeItem('asm86.source.b');
  });
  await enterMode(page, 'dual');
  await page.select('#examples', 'chat');
  await page.click('#btn-run');
  const screens = await page.$$('.screen');
  await screens[0].click();
  await page.keyboard.type('BEFORE\r');
  await page.waitForFunction(() => window.__app.sessions[1].m.console.includes('BEFORE'));
  const dualFile = await download(), dual = await state();
  await reloadSnapshot(dualFile, 'dual');
  await paused(dual);
  assert.equal(await page.evaluate(() => window.__app.dual.link.connected), true);
  await (await page.$$('.screen'))[0].click();
  await page.keyboard.type('QUEUED\r');
  assert.deepEqual(await state(), dual, '暂停时键盘输入只能排队，不能执行客体代码');
  await page.click('#btn-run');
  await page.waitForFunction(() => window.__app.sessions[1].m.console.includes('QUEUED'));
  await (await page.$$('.screen'))[1].click();
  await page.keyboard.type('AFTER\r');
  await page.waitForFunction(() => window.__app.sessions[0].m.console.includes('AFTER'));
  assert.equal(await page.evaluate(() => window.__app.sessions[1].m.console.includes('BEFORE')), true);

  phase = 'full';
  await page.click('#btn-home');
  await page.waitForFunction(() => window.__app.startupMode === null);
  await enterMode(page, 'full');
  await page.evaluate(async () => {
    const { Disk, blankFloppy } = await import('/src/machine/disk.ts');
    const boot = blankFloppy();
    boot.set([0x43, 0xeb, 0xfd]);
    boot.set([0x55, 0xaa], 510);
    boot.set([99, 98, 97], 100);
    const m = window.__app.cur.m;
    m.drives[0] = new Disk('SNAPBOOT.IMG', boot, true);
    m.drives[0].dirty = true;
  });
  await page.click('[data-boot="0"]');
  await page.waitForFunction(() => !document.getElementById('boot-choice').open && window.__app.cur.m.instructions > 100);
  const fullFile = await download(), full = await state();
  await reloadSnapshot(fullFile, 'full');
  await paused(full);
  assert.equal(await page.$eval('.editor-pane', e => getComputedStyle(e).display), 'none');
  await page.click('#btn-run');
  await page.waitForFunction(n => window.__app.cur.m.instructions > n, {}, full[0].instructions);
  await page.click('#btn-pause');
  assert.equal(await page.evaluate(() => window.__app.cur.m.program.bootDrive), 0);
  assert.equal(await page.$eval('#boot-choice', e => e.open), false);

  phase = 'invalid snapshot';
  await page.reload({ waitUntil: 'networkidle0' });
  const invalid = join(temp, 'invalid.asmsnap');
  writeFileSync(invalid, 'not a snapshot');
  await upload(invalid);
  await page.waitForFunction(() => document.getElementById('startup-error').textContent !== '正在校验并载入快照…' && !window.__app.loading);
  assert.equal(await page.evaluate(() => window.__app.startupMode), null);
  assert.equal(await page.evaluate(() => window.__app.sessions.length), 0);
  assert.match(await page.$eval('#startup-error', e => e.textContent), /快照|snapshot/i);
  assert.deepEqual(errors, []);
  console.log('snapshot UI: debug/dirty source, dual communication, full boot, disk data, paused restoration and invalid upload passed');
} catch (e) {
  console.error('snapshot UI failure', phase, errors);
  if (page && !page.isClosed()) console.error(await page.evaluate(() => ({
    startupError: document.getElementById('startup-error').textContent,
    status: document.getElementById('status').textContent,
    loading: window.__app?.loading, mode: window.__app?.startupMode,
  })));
  throw e;
} finally {
  await browser.close();
  for (const name of readdirSync(temp)) unlinkSync(join(temp, name));
  rmdirSync(temp);
}
