const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Settings → Diagnostics lists saved versions of the proxy's config, newest (current) first;
// restoring an older one asks first, then marks it current. Settings search finds the section too.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); });
    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-diagnostics').click();

    const section = page.getByRole('region', { name: 'Config history' });
    await section.waitFor();
    const rows = section.locator('li');
    assert.equal(await rows.count(), 3);
    assert.match(await rows.nth(0).innerText(), /Current/);
    assert.equal(await rows.nth(0).getByRole('button').count(), 0, 'the current version has no Restore button');
    // Each version names the settings it changed, and the confirmation names what restoring would change.
    assert.match(await rows.nth(0).innerText(), /Changed: port, routing\.strategy/);
    assert.match(await rows.nth(1).innerText(), /Changed: api-keys/);

    // Restoring asks first; cancelling changes nothing.
    await rows.nth(2).getByRole('button', { name: 'Restore' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('Restore this config version?').waitFor();
    await dialog.getByText(/Restoring changes: port, routing\.strategy\./).waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.match(await rows.nth(0).innerText(), /Current/);

    await rows.nth(2).getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
    await section.getByRole('status').filter({ hasText: 'Restored the version from' }).waitFor();
    assert.match(await rows.nth(2).innerText(), /Current/, 'the restored version is now current');
    assert.equal(await rows.nth(0).getByRole('button', { name: 'Restore' }).count(), 1, 'the previous version can be restored back');

    assert.deepEqual(errors, []);
    console.log('config history ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
