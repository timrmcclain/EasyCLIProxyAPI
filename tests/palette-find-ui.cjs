const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: the command palette finds single settings and accounts once you type (the opening list
// stays short), and runs tasks: failed requests, restoring a config, and stopping (after confirming) and starting the proxy.
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
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    await page.locator('.sidebar-command-button').waitFor();
    const titleIs = text => page.waitForFunction(expected => document.title === expected, text);
    const openPalette = async () => {
      await page.locator('.sidebar-command-button').click();
      const palette = page.getByRole('dialog', { name: /command/i });
      await palette.waitFor();
      return palette;
    };
    const option = (palette, id) => palette.locator(`[id="palette-${id}"]`);

    // Nothing typed: pages and actions only, no individual settings or accounts.
    let palette = await openPalette();
    await option(palette, 'failed-requests').waitFor();
    assert.equal(await palette.locator('[id^="palette-setting-"], [id^="palette-account-"]').count(), 0);

    // A single setting opens Settings with focus on that field.
    await palette.locator('input').fill('remote management');
    await option(palette, 'setting-management.allow-remote').click();
    await titleIs('Settings · Tim’s AI Hub');
    await page.waitForFunction(() => (document.activeElement?.closest('[id]')?.textContent ?? '').includes('Allow remote management'));

    // An account opens Overview's list searched for it.
    palette = await openPalette();
    await palette.locator('input').fill('claude.mock');
    await option(palette, 'account-claude-team.json').click();
    await titleIs('Overview · Tim’s AI Hub');
    await page.waitForFunction(() => document.querySelector('.quota-workflow-tools input[type="search"]')?.value === 'claude-team.json');

    // Show failed requests opens Activity.
    palette = await openPalette();
    await palette.locator('input').fill('failed');
    await option(palette, 'failed-requests').click();
    await titleIs('Activity · Tim’s AI Hub');

    // Restore a previous config opens Settings.
    palette = await openPalette();
    await palette.locator('input').fill('restore');
    await option(palette, 'restore-config').click();
    await titleIs('Settings · Tim’s AI Hub');

    // Stop proxy asks first; cancelling sends nothing, confirming stops it, and then Start proxy is offered.
    const stops = async () => (await page.evaluate(() => window.__mockCalls ?? [])).filter(entry => entry === 'stop_core_process').length;
    palette = await openPalette();
    assert.equal(await option(palette, 'start-proxy').count(), 0, 'start is not offered while running');
    await option(palette, 'stop-proxy').click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Stop the proxy?' }));
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(await stops(), 0, 'cancel does not stop');
    palette = await openPalette();
    await option(palette, 'stop-proxy').click();
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Stop proxy' }).click();
    await page.waitForFunction(() => (window.__mockCalls ?? []).includes('stop_core_process'));
    palette = await openPalette();
    await option(palette, 'start-proxy').click();
    await page.waitForFunction(() => (window.__mockCalls ?? []).includes('start_core_process'));

    assert.deepEqual(errors, []);
    console.log('PASS: palette finds settings and accounts, and runs proxy, failed-request and restore tasks.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
