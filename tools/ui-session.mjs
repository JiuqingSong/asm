export async function enterMode(page, mode = 'debug', showDiskImages = false, driveD = false) {
  await page.waitForFunction(() => !!window.__app);
  await page.click(`[data-start="${mode}"]`);
  if (mode !== 'dual') {
    await page.waitForSelector('#startup-config[open]');
    if (mode === 'debug' && showDiskImages) await page.click('#config-images');
    if (mode === 'full' && driveD) await page.click('#config-drive-d'); // 完整模拟默认不启用 D:
    await page.click('#startup-config button[type="submit"]');
  }
  if (mode === 'full') await page.waitForSelector('#boot-choice[open]');
  else await page.waitForFunction(mode => window.__app.startupMode === mode && !!window.__app.cur.program && !document.querySelector('.toolbar').inert, {}, mode);
}
