// URL=http://localhost:5329/ node tools/ui-teaching-check.mjs
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';

const base = process.env.URL || 'http://127.0.0.1:5329/';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  defaultViewport: { width: 1400, height: 1000 },
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  for (const chapter of ['ch01', 'ch02']) {
    await page.goto(new URL(`teaching/${chapter}/index.html`, base).href, { waitUntil: 'networkidle0' });
    assert.equal(await page.$('#step'), null);
    const experiments = await page.$$eval('#experiment option', options => options.map(option => option.value));
    for (const id of experiments) {
      await page.select('#experiment', id);
      await page.click('#verify');
      assert.match(await page.$eval('#status', element => element.textContent), /断言未通过/);
      await page.click('#run');
      await page.click('#verify');
      assert.match(await page.$eval('#status', element => element.textContent), /断言通过/, id);
      assert.match(await page.$eval('#trace', element => element.textContent), /1\./);
      await page.click('#observe');
      assert.equal(await page.$('#memory-state'), null);
      await page.click('#reset');
      await page.click('#run'); await page.click('#verify');
      assert.match(await page.$eval('#status', element => element.textContent), /断言通过/);
      await page.click('#observe');
    }
    await page.select('#experiment', experiments[0]);
    await page.click('#next');
    await page.$eval('#address', element => { element.value = 'bad'; });
    await page.click('#peek');
    assert.match(await page.$eval('#status', element => element.textContent), /请输入完整/);
    await page.click('#run'); await page.click('#verify');
    assert.match(await page.$eval('#status', element => element.textContent), /断言通过/);
    await page.$eval('#address', element => { element.value = '0'; });
    await page.$eval('#value', element => { element.value = '256'; });
    await page.click('#write');
    assert.match(await page.$eval('#status', element => element.textContent), /字节必须/);
    await page.click('#verify');
    assert.match(await page.$eval('#status', element => element.textContent), /断言通过/);
    await page.$eval('#value', element => { element.value = '0x41'; });
    await page.click('#write'); await page.click('#verify');
    assert.match(await page.$eval('#status', element => element.textContent), /断言未通过/);
    await page.click('#run');
    assert.match(await page.$eval('#status', element => element.textContent), /请重置/);
    await page.click('#reset');
    for (const input of ['65', '0x41', '0b01000001']) {
      await page.$eval('#value', (element, value) => { element.value = value; }, input);
      await page.click('#write');
      assert.match(await page.$eval('#memory-state', element => element.textContent), /十进制 65 \/ 十六进制 41 \/ 二进制 01000001/);
    }
    assert.equal(await page.$eval('#numeric', element => element.hidden), chapter === 'ch01');
    if (chapter === 'ch02') {
      await page.click('#interpret');
      const wide = await page.$eval('#interpretation', element => JSON.parse(element.textContent));
      assert.equal(wide.signed, -1); assert.equal(wide.unsigned, 65535);
      await page.select('#width', '8');
      await page.$eval('#number', element => { element.value = '0xFF'; });
      await page.click('#interpret');
      const narrow = await page.$eval('#interpretation', element => JSON.parse(element.textContent));
      assert.equal(narrow.signed, -1); assert.equal(narrow.unsigned, 255);
      await page.$eval('#number', element => { element.value = '256'; });
      await page.click('#interpret');
      assert.match(await page.$eval('#status', element => element.textContent), /位模式必须/);
    }
    const archive = await fetch(new URL(`teaching/${chapter}/source.tar`, base));
    assert.equal(archive.status, 200);
    assert.ok(Buffer.from(await archive.arrayBuffer()).subarray(0, 100).toString().startsWith(`${chapter}/`));
    const manuscript = await page.goto(new URL(`teaching/${chapter}/manuscript.md`, base).href);
    assert.equal(manuscript.status(), 200);
  }
  for (const chapter of ['ch03', 'ch04']) {
    await page.goto(new URL(`teaching/${chapter}/index.html`, base).href, { waitUntil: 'networkidle0' });
    const experiments = await page.$$eval('#experiment option', options => options.map(option => option.value));
    for (const id of experiments) {
      await page.select('#experiment', id);
      await page.click('#run');
      await page.click('#verify');
      assert.match(await page.$eval('#status', element => element.textContent), /断言通过/, id);
      assert.equal(await page.$eval('#full-platform', element => element.href), new URL(`?lesson=${id}`, base).href);
    }
    await page.select('#experiment', experiments[0]);
    await page.click('#step');
    assert.match(await page.$eval('#machine-state', element => element.textContent), /IP=0003/);
    assert.match(await page.$eval('#execution-trace', element => element.textContent), /0000 → 0003/);
    await page.click('#observe');
    assert.equal(await page.$('#machine-state'), null);
    await page.click('#load');
    await page.click('#run');
    await page.click('#verify');
    assert.match(await page.$eval('#status', element => element.textContent), /断言通过/);
    await page.click('#observe');
    assert.match(await page.$eval('#machine-state', element => element.textContent), /状态=halted/);
    await page.$eval('#bytes', element => {
      element.value = 'B8 100';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#load');
    assert.match(await page.$eval('#status', element => element.textContent), /非法字节/);
    await page.click('#verify');
    assert.match(await page.$eval('#status', element => element.textContent), /断言未通过/);
    await page.$eval('#bytes', element => {
      element.value = 'B8 00 00 '.repeat(1001) + 'F4';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#load');
    await page.click('#run');
    assert.match(await page.$eval('#status', element => element.textContent), /执行预算耗尽/);
    assert.match(await page.$eval('#machine-state', element => element.textContent), /IP=0BB8.*状态=ready/);
    const archive = await fetch(new URL(`teaching/${chapter}/source.tar`, base));
    assert.equal(archive.status, 200);
    const archiveBytes = Buffer.from(await archive.arrayBuffer());
    assert.ok(archiveBytes.length > 1024);
    assert.ok(archiveBytes.subarray(0, 100).toString().startsWith(`${chapter}/`));
    const manuscript = await page.goto(new URL(`teaching/${chapter}/manuscript.md`, base).href);
    assert.equal(manuscript.status(), 200);
  }

  await page.goto(new URL('teaching/ch04/index.html?experiment=ch04-overflow', base).href, { waitUntil: 'networkidle0' });
  await page.$eval('#bytes', element => {
    element.value = element.value.replace('FF 7F', 'FF FF');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#load'); await page.click('#run'); await page.click('#verify');
  assert.match(await page.$eval('#status', element => element.textContent), /断言未通过/);

  await page.goto(new URL('?lesson=ch04-carry', base).href, { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#teaching-experiments', element => element.value), 'ch04-carry');
  await page.click('#btn-teaching');
  await page.waitForSelector('body.has-session');
  await page.waitForFunction(() => document.getElementById('btn-teaching').disabled === false);
  await page.click('#btn-step');
  await page.click('#btn-step');
  // __app is a development-only test hook; production uses the same controls.
  const state = await page.evaluate(() => {
    const app = window.__app;
    if (!app) return null;
    return { ax: app.cur.m.cpu.r[0], ip: app.cur.m.cpu.ip, flags: app.cur.m.cpu.flags, config: app.cur.m.config };
  });
  if (state) {
    assert.equal(state.ax, 0);
    assert.equal(state.ip, 0x106);
    assert.equal(state.flags & 0x08d5, 0x55);
    assert.ok(Object.values(state.config).every(value => value === false));
  }
  await page.click('#btn-home');
  await page.waitForSelector('body:not(.has-session)');
  assert.deepEqual(errors, []);
  console.log('Teaching browser checks passed: all experiments, real trace, observer removal, invalid input, failed assertions, downloads and full-platform entry.');
} finally {
  await browser.close();
}
