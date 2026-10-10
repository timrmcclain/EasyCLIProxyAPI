const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: the command palette's Actions group checks every quota at once, and Restart proxy only
// restarts after confirming (cancelling sends nothing).
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); });
    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.locator('.sidebar-command-button').waitFor();
    const calls = () => page.evaluate(() => window.__mockCalls ?? []);
    const count = (list, name) => list.filter(command => command === name).length;
    const openPalette = async () => {
      await page.locator('.sidebar-command-button').click();
      const palette = page.getByRole('dialog', { name: /command/i });
      await palette.waitFor();
      return palette;
    };

    // Check all quotas now: a forced check asks the providers for quota again, even though the watcher just did.
    const quotaRequests = list => list.filter(entry => entry === 'management_request /requests/api-call').length;
    await page.waitForFunction(() => (window.__mockCalls ?? []).includes('management_request /requests/api-call'));
    await page.waitForTimeout(1500);
    let palette = await openPalette();
    assert.equal(await palette.locator('#palette-check-quota, #palette-restart-proxy').count(), 2);
    const before = quotaRequests(await calls());
    await palette.locator('#palette-check-quota').click();
    await palette.waitFor({ state: 'detached' });
    await page.waitForFunction(seen => (window.__mockCalls ?? []).filter(entry => entry === 'management_request /requests/api-call').length > seen, before);

    // Restart proxy: cancelling sends nothing; confirming restarts.
    palette = await openPalette();
    await palette.locator('#palette-restart-proxy').click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Restart proxy' }));
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /cuts off requests in progress/);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(count(await calls(), 'restart_core_process'), 0, 'cancel does not restart');

    palette = await openPalette();
    await palette.locator('#palette-restart-proxy').click();
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Restart proxy' }).click();
    await page.waitForFunction(() => (window.__mockCalls ?? []).includes('restart_core_process'));

    assert.deepEqual(errors, []);
    console.log('palette actions ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
