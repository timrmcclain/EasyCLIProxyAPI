const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Compact fits more on screen by tightening spacing, not by shrinking: text keeps its size,
// rows get shorter, and the choice is remembered.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
      localStorage.setItem('personal.density', 'comfortable');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    const row = page.locator('.ad-row-card').first();
    await row.waitFor();
    const measure = () => page.evaluate(() => {
      const card = document.querySelector('.ad-row-card');
      const name = card.querySelector('strong') ?? card;
      return {
        rowHeight: card.getBoundingClientRect().height,
        textSize: getComputedStyle(name).fontSize,
        contentHeight: document.querySelector('.workspace .content').scrollHeight,
        zoom: getComputedStyle(document.querySelector('.workspace .content')).zoom,
      };
    });
    const roomy = await measure();

    await page.locator('.sidebar-density-selector').getByRole('button', { name: 'Compact' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
    const compact = await measure();
    assert.equal(compact.textSize, roomy.textSize, 'text keeps its size');
    assert.ok(compact.zoom === '1' || compact.zoom === 'normal', `no zoom (${compact.zoom})`);
    assert.ok(compact.rowHeight < roomy.rowHeight, `rows are shorter (${roomy.rowHeight} -> ${compact.rowHeight})`);
    assert.ok(compact.contentHeight < roomy.contentHeight - 80, `more fits on screen (${roomy.contentHeight} -> ${compact.contentHeight})`);

    await page.reload();
    await row.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact', 'remembered after reload');
    assert.equal(await page.locator('.sidebar-density-selector').getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed'), 'true');

    assert.deepEqual(errors, []);
    console.log('Compact density tightens spacing without shrinking text.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
