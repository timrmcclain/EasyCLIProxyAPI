const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Settings shows one Save bar per tab instead of a Save button on every card: editing a field shows the
// bar, the per-card Save it replaces is hidden, and Save all saves the change and clears the bar.
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
    await page.locator('.app-shell').waitFor();
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-routing').click();

    const bar = page.locator('.config-save-bar');
    const retry = page.locator('#config-input-config-network-requestRetry');
    await retry.waitFor();
    assert.equal(await bar.count(), 0, 'no bar before anything changes');
    assert.equal(await page.locator('.config-settings-content button.config-card-save:visible').count(), 0, 'per-card Save buttons are replaced by the bar');

    const original = await retry.inputValue();
    const changed = String((Number(original) || 0) + 1);
    await retry.fill(changed);
    await bar.waitFor();
    assert.match(await bar.innerText(), /Unsaved changes on this tab/);

    // Every tab stays reachable without horizontal scrolling.
    const tabsFit = await page.evaluate(() => [...document.querySelectorAll('.config-subpage-tabs [role=tab]')]
      .every(tab => { const r = tab.getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; }));
    assert.equal(tabsFit, true, 'all Settings tabs are on screen');

    await bar.getByRole('button', { name: 'Save all' }).click();
    await bar.waitFor({ state: 'detached' });
    assert.equal(await retry.inputValue(), changed, 'the saved value stays');

    // Template-driven cards save through the same bar.
    await page.locator('#config-subpage-tab-oauth').click();
    await page.getByRole('button', { name: 'Show advanced settings' }).click();
    const field = page.locator('#config-template-panel input[type=text]:visible:not([disabled])').first();
    await field.waitFor();
    const before = await field.inputValue();
    const edited = `${before}x`;
    await field.fill(edited);
    await bar.waitFor();
    assert.equal(await page.locator('#config-template-panel .template-config-actions .primary-button').count(), 0, 'template cards keep only Discard');
    await bar.getByRole('button', { name: 'Save all' }).click();
    await bar.waitFor({ state: 'detached' });
    assert.equal(await field.inputValue(), edited, 'the template field saved');

    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    assert.deepEqual(errors, []);
    console.log('settings save bar: pass');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
