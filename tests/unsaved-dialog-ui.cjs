const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Account settings: closing with nothing changed just closes; closing after an edit asks first,
// Escape or "Keep editing" goes back to the form, and only "Discard changes" closes it.
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
    await page.goto(`${base}/tests/fixtures/credential-settings.html?locale=en`);
    await page.locator('.credential-settings-body[aria-busy="false"] fieldset').waitFor();
    const closed = () => page.evaluate(() => window.closedCount ?? 0);
    const discardBar = page.locator('.credential-settings-discard');

    // Nothing changed: Escape closes straight away.
    await page.keyboard.press('Escape');
    assert.equal(await closed(), 1);
    assert.equal(await discardBar.count(), 0);

    // After an edit, Escape asks instead of closing; Escape again keeps editing.
    const field = page.locator('.credential-settings-grid input').first();
    await field.fill('edited-prefix');
    await page.keyboard.press('Escape');
    await discardBar.getByText('Discard unsaved changes?').waitFor();
    assert.equal(await discardBar.getAttribute('role'), 'alert');
    assert.equal(await closed(), 1, 'an edited dialog does not close on Escape');
    await page.keyboard.press('Escape');
    await discardBar.waitFor({ state: 'detached' });
    assert.equal(await field.inputValue(), 'edited-prefix', 'the edit survives');
    assert.equal(await page.evaluate(() => document.querySelector('dialog').open), true, 'the dialog is still open');

    // Cancel asks too; Keep editing returns to the form, Discard changes closes.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await discardBar.getByRole('button', { name: 'Keep editing' }).click();
    await discardBar.waitFor({ state: 'detached' });
    assert.equal(await closed(), 1);
    await page.getByRole('button', { name: 'Close' }).click();
    await discardBar.getByRole('button', { name: 'Discard changes' }).click();
    assert.equal(await closed(), 2);

    assert.deepEqual(errors, []);
    console.log('Unsaved account settings ask before closing.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
