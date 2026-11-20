// URL=http://localhost:5317/ node tools/ui-startup-check.mjs [截图目录]
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enterMode } from './ui-session.mjs';
import { buildIso } from './mkiso.ts';

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'asm-startup-'));
const floppyIso = join(temp, 'floppy.iso'), noemuIso = join(temp, 'noemu.iso'), textFile = join(temp, 'VISIBLE.TXT');
writeFileSync(textFile, 'visible files\n');
const boot = new Uint8Array(1440 * 1024);
boot.set([0xeb, 0xfe, 0x44]);
boot.set([0x55, 0xaa], 510);
const iso = buildIso([], 'STARTUP', boot);
writeFileSync(floppyIso, iso);
iso[19 * 2048 + 33] = 0;
iso[19 * 2048 + 38] = 4;
writeFileSync(noemuIso, iso);
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, defaultViewport: { width: 1600, height: 1000 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  let phase = 'landing';
  page.on('pageerror', e => errors.push(`${phase}: ${e.stack ?? e.message}`));
  page.on('dialog', d => d.accept());
  const shot = async name => { if (out) await page.screenshot({ path: join(out, name + '.png') }); };
  const home = async () => {
    await page.click('#btn-home');
    await page.waitForFunction(() => window.__app.startupMode === null);
  };
  const checkFiles = async visible => {
    assert.equal(await page.$$eval('#tab-files > .dos-files', (els, visible) =>
      els.length > 0 && els.every(e => (getComputedStyle(e).display !== 'none') === visible), visible), true);
  };
  await page.goto(process.env.URL || 'http://localhost:5317/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__app);
  assert.equal(await page.evaluate(() => window.__app.sessions.length), 0);
  await shot('startup');
  for (const mode of ['debug', 'full']) {
    await page.click(`[data-start="${mode}"]`);
    assert.equal(await page.$eval('#config-images-option', e => getComputedStyle(e).display !== 'none'), mode === 'debug');
    assert.equal(await page.$eval('#config-images', e => e.checked), false);
    if (mode === 'debug') await page.click('#config-images');
    const positions = () => page.evaluate(() =>
      ['#startup-config', '#config-options', '#config-warnings', '#config-cancel', ...Array.from(document.querySelectorAll('#config-options input'), e => `[data-option="${e.dataset.option}"]`)]
        .map(selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }));
    const before = await positions();
    for (const key of ['com2', 'pic', 'dma', 'fdc', ...(mode === 'debug' ? ['bios', 'dos'] : [])]) {
      await page.click(`[data-option="${key}"]`);
      assert.deepEqual(await positions(), before, `${mode}: toggling ${key} must not move the options`);
    }
    assert.equal(await page.$eval('#config-warnings', e => e.scrollHeight > e.clientHeight), true);
    await page.click('#config-defaults');
    assert.equal(await page.$eval('#config-images', e => e.checked), false);
    assert.deepEqual(await positions(), before, `${mode}: clearing warnings must not resize the dialog`);
    await page.click('#config-cancel');
  }
  phase = 'debug';
  await enterMode(page);
  await page.click('.tabs button[data-tab="files"]');
  await checkFiles(true);
  assert.equal(await page.$eval('#drives', e => e.checkVisibility()), false);
  const [fileChooser] = await Promise.all([page.waitForFileChooser(), page.click('#file-upload')]);
  await fileChooser.accept([textFile]);
  await page.waitForFunction(() => document.getElementById('files').textContent.includes('VISIBLE.TXT'));
  assert.equal(await page.evaluate(() => new TextDecoder().decode(window.__app.cur.m.files.get('VISIBLE.TXT'))), 'visible files\n');
  await page.click('#btn-run');
  await page.waitForFunction(() => window.__app.cur.m.status === 'exited');
  assert.match(await page.evaluate(() => window.__app.cur.m.console), /Hello/);
  assert.equal(await page.$eval('.editor-pane', e => getComputedStyle(e).display !== 'none'), true);
  assert.equal(await page.$$eval('#drives [data-act="boot"]', e => e.length), 0);
  await shot('debug');
  const splitter = await page.$('[data-split="screen"]');
  const rect = await splitter.boundingBox();
  await page.mouse.move(rect.x + 10, rect.y + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + 10, rect.y + 80);
  await page.mouse.up();
  assert.equal(await page.$eval('.screen-pane', e => e.classList.contains('sized')), true);
  await page.click('.editor-pane .max-btn');
  await home();
  phase = 'debug disk images enabled';
  await enterMode(page, 'debug', true);
  await page.click('.tabs button[data-tab="files"]');
  await checkFiles(true);
  assert.equal(await page.$eval('#drives', e => e.checkVisibility()), true);
  assert.equal(await page.evaluate(() => document.getElementById('files').getBoundingClientRect().bottom <= document.getElementById('drives').getBoundingClientRect().top), true);
  await home();
  phase = 'disabled devices';
  await page.click('[data-start="debug"]');
  await page.click('[data-option="dos"]');
  await page.click('[data-option="mouseDriver"]');
  await page.click('[data-option="vga"]');
  await page.click('#startup-config button[type="submit"]');
  await page.waitForFunction(() => window.__app.startupMode === 'debug' && !!window.__app.cur.program && !document.querySelector('.toolbar').inert);
  assert.deepEqual(await page.evaluate(() => [...window.__app.cur.m.mem.subarray(0x84, 0x88)]), [0, 0, 0, 0]);
  assert.deepEqual(await page.evaluate(() => [...window.__app.cur.m.mem.subarray(0xcc, 0xd0)]), [0, 0, 0, 0]);
  assert.equal(await page.$eval('.screen-box', e => e.classList.contains('no-video')), true);
  await page.click('.tabs button[data-tab="files"]');
  await checkFiles(true);
  assert.equal(await page.$eval('#drives', e => e.checkVisibility()), false);
  await home();
  phase = 'dual';
  await enterMode(page, 'dual');
  await page.click('.tabs button[data-tab="files"]');
  await checkFiles(true);
  assert.equal(await page.$eval('#drives', e => e.checkVisibility()), true);
  await page.select('#examples', 'chat');
  await page.click('#btn-run');
  const screens = await page.$$('.screen');
  await screens[0].click();
  await page.keyboard.type('PING\r');
  await page.waitForFunction(() => window.__app.sessions[1].m.console.includes('PING'));
  await screens[1].click();
  await page.keyboard.type('PONG\r');
  await page.waitForFunction(() => window.__app.sessions[0].m.console.includes('PONG'));
  await shot('dual');
  await home();
  phase = 'full';
  await enterMode(page, 'full');
  await checkFiles(false);
  assert.equal(await page.$eval('#boot-media #drives', e => e.checkVisibility()), true);
  assert.equal(await page.$eval('.editor-pane', e => getComputedStyle(e).display), 'none');
  assert.equal(await page.$eval('#config-options', e => !!e.querySelector('[data-option="dos"]')), false);
  await page.click('[data-boot="0"]');
  await page.waitForFunction(() => document.getElementById('boot-error').textContent.includes('没有'));
  assert.equal(await page.$eval('#boot-choice', e => e.open), true);
  await page.evaluate(async () => {
    const { Disk, blankFloppy } = await import('/src/machine/disk.ts');
    const a = blankFloppy(), c = new Uint8Array(1024 * 1024);
    for (const [data, marker] of [[a, 0x41], [c, 0x43]]) {
      data.set([0xeb, 0xfe, marker]);
      data.set([0x55, 0xaa], 510);
    }
    const app = window.__app, m = app.cur.m;
    m.drives[0] = new Disk('A.IMG', a, true);
    m.drives[2] = new Disk('C.IMG', c, false);
    m.drives[0].dirty = m.drives[2].dirty = true;
    app.drives.changed(0);
  });
  await page.click('[data-boot="0"]');
  await page.waitForFunction(() => !document.getElementById('boot-choice').open);
  assert.equal(await page.evaluate(() => window.__app.cur.m.mem[0x7c02]), 0x41);
  assert.deepEqual(await page.evaluate(() => [...window.__app.cur.m.mem.subarray(0x84, 0x88)]), [0, 0, 0, 0]);
  const geometry = await page.evaluate(() => ({
    screen: document.querySelector('.screen-pane').getBoundingClientRect().height,
    left: document.querySelector('.col-left').getBoundingClientRect().height,
    right: document.querySelector('.cpu-pane').getBoundingClientRect().height,
  }));
  assert.ok(geometry.screen >= geometry.left - 2 && geometry.right > 100, JSON.stringify(geometry));
  await shot('full');
  await page.click('#btn-reset');
  await page.waitForSelector('#boot-choice[open]');
  await page.click('[data-boot="128"]');
  await page.waitForFunction(() => !document.getElementById('boot-choice').open);
  assert.equal(await page.evaluate(() => window.__app.cur.m.mem[0x7c02]), 0x43);
  await page.click('#btn-reset');
  await page.waitForSelector('#boot-choice[open]');
  await page.click('[data-boot="224"]');
  await page.waitForFunction(() => document.getElementById('boot-error').textContent.includes('没有光盘'));
  await page.click('#boot-cancel');
  assert.equal(await page.evaluate(() => window.__app.cur.m.mem[0x7c02]), 0x43);
  assert.equal(await page.evaluate(() => window.__app.cur.m.program.bootDrive), 0x80);
  await page.evaluate(() => {
    const m = window.__app.cur.m, load = m.load.bind(m);
    window.__bootCount = 0;
    m.load = (...args) => { window.__bootCount++; return load(...args); };
  });
  await page.click('#btn-cad');
  await page.waitForFunction(() => window.__bootCount > 0);
  assert.equal(await page.$eval('#boot-choice', e => e.open), false);
  assert.equal(await page.evaluate(() => window.__app.cur.m.program.bootDrive), 0x80);
  for (const [file, drive] of [[floppyIso, 0], [noemuIso, 0xe0]]) {
    phase = 'CD boot';
    await page.click('#btn-reset');
    await page.waitForSelector('#boot-choice[open]');
    const [chooser] = await Promise.all([
      page.waitForFileChooser(), page.click('#drives [data-act="cd-insert"]'),
    ]);
    await chooser.accept([file]);
    await page.waitForFunction(name => window.__app.cur.m.cdrom.discName === name, {}, file === floppyIso ? 'floppy.iso' : 'noemu.iso');
    await page.click('[data-boot="224"]');
    await page.waitForFunction(() => !document.getElementById('boot-choice').open);
    assert.equal(await page.evaluate(() => window.__app.cur.m.mem[0x7c02]), 0x44);
    assert.equal(await page.evaluate(() => window.__app.cur.m.cpu.r[2] & 0xff), drive);
    assert.equal(await page.evaluate(() => window.__app.cur.m.program.bootDrive), 0xe0);
    await page.evaluate(() => { window.__bootCount = 0; });
    await page.click('#btn-cad');
    await page.waitForFunction(() => window.__bootCount > 0);
    assert.equal(await page.$eval('#boot-choice', e => e.open), false);
    assert.equal(await page.evaluate(() => window.__app.cur.m.mem[0x7c02]), 0x44);
  }
  await page.evaluate(() => window.__app.drives.flushAll(0));
  phase = 'reload';
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__app);
  assert.equal(await page.evaluate(() => window.__app.sessions.length), 0);
  await enterMode(page, 'full');
  assert.equal(await page.evaluate(() => window.__app.cur.m.drives[2].name), 'C.IMG');
  await page.click('#boot-cancel');
  await page.click('#btn-reset');
  await page.waitForSelector('#boot-choice[open]');
  assert.deepEqual(errors, []);
  console.log('PASS: 启动页、默认文件区上传、可选磁盘映像区、设备关闭、双机通信、A/C/两种光盘引导、重启/热启动、取消恢复、映像持久化和完整模式布局');
} finally {
  await browser.close();
  for (const file of [floppyIso, noemuIso, textFile]) if (existsSync(file)) unlinkSync(file);
  rmdirSync(temp);
}
