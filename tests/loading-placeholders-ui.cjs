const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Loading placeholders: Overview holds the shape of the account cards while they load, words kept for screen readers.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'home'); });
    await page.goto(`${base}/?mock=running&mockDelay=1200`, { timeout: 60000 });

    const placeholder = page.locator('.ui-skeleton-card');
    await placeholder.waitFor();
    assert.equal(await placeholder.getAttribute('role'), 'status');
    assert.equal(await placeholder.getAttribute('aria-busy'), 'true');
    assert.equal(await placeholder.locator('.sr-only').innerText(), 'Loading accounts…');
    assert.equal(await placeholder.locator('i').count(), 3, 'three card shapes');
    const box = await placeholder.locator('i').first().boundingBox();
    assert.ok(box && box.height >= 100 && box.width >= 200, `card-sized ${JSON.stringify(box)}`);

    // The real cards take its place.
    await page.locator('.ad-card').first().waitFor({ timeout: 60000 });
    await placeholder.waitFor({ state: 'detached' });

    assert.deepEqual(errors, []);
    console.log('PASS: account cards load behind card-shaped placeholders that screen readers hear as "Loading accounts…".');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
