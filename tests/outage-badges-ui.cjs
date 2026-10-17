const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Outage badges: off by default; when on, a provider whose status page reports a problem is marked on Overview.
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
    const errors = [];
    const open = async (badgesOn) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript((on) => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', 'home');
        if (on) localStorage.setItem('personal.outageBadges', 'true');
      }, badgesOn);
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      await page.locator('.quota-provider-summary-cell').first().waitFor();
      return page;
    };

    const off = await open(false);
    await off.waitForTimeout(500);
    assert.equal(await off.locator('.provider-outage-badge').count(), 0, 'no badges unless switched on');
    await off.close();

    const on = await open(true);
    const claude = on.locator('.quota-provider-summary-cell').filter({ hasText: 'Claude' });
    const badge = claude.locator('.provider-outage-badge');
    await badge.waitFor();
    assert.equal((await badge.innerText()).trim(), 'Partial outage');
    assert.match(await badge.getAttribute('title'), /Elevated errors on Claude Opus/);
    const codex = on.locator('.quota-provider-summary-cell').filter({ hasText: 'Codex' });
    assert.equal(await codex.locator('.provider-outage-badge').count(), 0, 'an all-clear provider has no badge');
    await on.close();

    assert.deepEqual(errors, []);
    console.log('PASS: outage badges are off by default and mark only providers reporting a problem.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
