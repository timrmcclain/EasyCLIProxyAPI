const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: data management (size limit, shrink, repair) lives in Settings → Storage, reached from
// Activity, the palette and settings search. It has one primary button (Save limit), nothing destructive is primary,
// and shrinking and repairing each ask first.
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'usage-records');
      // Someone who last left Activity on the old Data Management tab lands on Overview.
      localStorage.setItem('cpa-gui.usage-records-tab.v1', 'data-management');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });

    // Activity no longer has the tab, only a link to Settings → Storage.
    // The first page compiles cold while other tests run, so allow it as long as the page load.
    await page.getByRole('tab', { name: 'Overview', selected: true }).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.usage-records-page .usage-data-management-panel').count(), 0);
    await page.getByRole('button', { name: 'Storage settings' }).click();
    const panel = page.locator('#config-native-storage .usage-data-management-panel');
    await panel.waitFor();
    assert.equal(await page.locator('#config-subpage-tab-storage').getAttribute('aria-selected'), 'true');
    await panel.getByText(/Currently using/).waitFor();

    // One primary button on the whole Settings page, and it isn't a destructive action.
    const primaries = await page.locator('main .primary-button:visible').allInnerTexts();
    assert.equal(primaries.length, 1, `one primary button, got ${JSON.stringify(primaries)}`);
    assert.equal(await panel.locator('.primary-button').count(), 1, 'the primary button is Save limit');
    assert.equal(await panel.locator('.primary-button').evaluate(el => /shrink|repair|delete/i.test(el.textContent)), false);
    const shrink = panel.locator('.danger-button');
    assert.equal(await shrink.count(), 1);
    const shrinkLook = await shrink.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, primary: el.classList.contains('primary-button') }));
    const primaryBackground = await panel.locator('.primary-button').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(shrinkLook.primary, false);
    assert.notEqual(shrinkLook.background, primaryBackground, 'shrink is outlined, not filled like the primary button');
    const repair = panel.getByRole('button', { name: 'Scan and repair' });
    assert.equal(await repair.getAttribute('class').then(c => c.includes('secondary-button')), true, 'repair is secondary');

    // Shrinking and repairing each ask first; cancelling changes nothing.
    await panel.getByLabel('Cleanup target size (MB)').fill('1');
    await shrink.click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    await repair.click();
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });

    // The palette and settings search both reach it.
    await page.locator('nav').getByRole('button', { name: /^Overview/ }).first().click();
    await page.keyboard.press('Control+k');
    // Type only once the palette is open: keys pressed before it appears are lost on a busy machine.
    const paletteInput = page.getByRole('dialog', { name: /command/i }).getByRole('combobox').or(page.getByRole('dialog', { name: /command/i }).getByRole('textbox')).first();
    await paletteInput.waitFor();
    await paletteInput.fill('storage');
    await page.getByRole('dialog', { name: /command/i }).getByRole('option', { name: /Storage/ }).first().click();
    await panel.waitFor();
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('shrink');
    await page.locator('.config-search-results').getByRole('button', { name: /Database size limit\s*Storage/ }).click();
    await panel.waitFor();
    assert.equal(await page.locator('#config-subpage-tab-storage').getAttribute('aria-selected'), 'true');

    assert.deepEqual(errors, []);
    console.log('Data management lives in Settings → Storage with one primary button; shrink and repair ask first.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
