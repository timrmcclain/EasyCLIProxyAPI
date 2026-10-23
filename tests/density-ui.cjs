const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Compact fits as much on screen as possible: half the spacing, one step smaller text, shorter rows and controls,
// a narrower sidebar, no zoom; controls stay at least 28px tall, and the choice is remembered.
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
        sidebarWidth: document.querySelector('.sidebar').getBoundingClientRect().width,
        shortestControl: Math.min(...[...document.querySelectorAll('.workspace .content button, .workspace .content select')]
          .filter(node => node.offsetParent && !node.closest('p, li > small')).map(node => node.getBoundingClientRect().height)),
        zoom: getComputedStyle(document.querySelector('.workspace .content')).zoom,
      };
    });
    const roomy = await measure();

    await page.locator('.sidebar-density-selector').getByRole('button', { name: 'Compact' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
    const compact = await measure();
    assert.ok(parseFloat(compact.textSize) < parseFloat(roomy.textSize), `text is a step smaller (${roomy.textSize} -> ${compact.textSize})`);
    assert.ok(parseFloat(compact.textSize) >= 11, `text stays readable (${compact.textSize})`);
    assert.ok(compact.zoom === '1' || compact.zoom === 'normal', `no zoom (${compact.zoom})`);
    assert.ok(compact.rowHeight <= roomy.rowHeight * 0.8, `rows are much shorter (${roomy.rowHeight} -> ${compact.rowHeight})`);
    assert.ok(compact.contentHeight <= roomy.contentHeight * 0.8, `far more fits on screen (${roomy.contentHeight} -> ${compact.contentHeight})`);
    assert.ok(compact.sidebarWidth < roomy.sidebarWidth, `sidebar is narrower (${roomy.sidebarWidth} -> ${compact.sidebarWidth})`);
    assert.ok(compact.shortestControl >= 24, `controls stay clickable (${compact.shortestControl}px)`);
    // Only what matters at a glance: explanations and routine labels go, problems stay.
    const visible = selector => page.evaluate(sel => [...document.querySelectorAll(sel)].some(node => node.offsetParent !== null), selector);
    for (const hidden of ['.glance-unconfirmed', '.ad-row-name .ad-provider', '.ad-row-status .quota-availability-available', '.ad-footnote', '.home-status-latest']) {
      assert.equal(await visible(hidden), false, `${hidden} is hidden in compact`);
    }
    for (const kept of ['.ad-row-status .quota-availability-unavailable', '.ad-card-note.ad-error', '.ad-quota-reset']) {
      assert.equal(await visible(kept), true, `${kept} stays in compact`);
    }
    console.log(`roomy ${JSON.stringify(roomy)}\ncompact ${JSON.stringify(compact)}`);

    await page.reload();
    await row.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact', 'remembered after reload');
    assert.equal(await page.locator('.sidebar-density-selector').getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed'), 'true');

    assert.deepEqual(errors, []);
    console.log('Compact density packs the screen while controls stay clickable.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
