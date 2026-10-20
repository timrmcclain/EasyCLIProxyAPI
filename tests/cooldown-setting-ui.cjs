const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Settings → Routing says "Cooldown after rate limits" (no "Disable cooldown: on"
// double negative). It's on while disable-cooling is false, and turning it off saves disable-cooling and comes back off.
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
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'config');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });

    const openRouting = async () => {
      await page.locator('#config-subpage-tab-routing').click();
      const retry = page.locator('#config-native-retry');
      const advanced = retry.locator('details').filter({ has: page.locator('summary', { hasText: 'Advanced' }) }).first();
      if (!(await advanced.evaluate(el => el.open))) await advanced.locator('summary').first().click();
      return retry.getByRole('switch', { name: 'Cooldown after rate limits' });
    };
    let cooldown = await openRouting();
    await page.waitForFunction(() => !document.querySelector('#config-native-retry [role="switch"]:disabled'));
    assert.equal(await page.getByText('Disable cooldown').count(), 0, 'no double negative');
    assert.equal(await cooldown.isChecked(), true, 'cooldown is on while disable-cooling is false');

    await cooldown.uncheck();
    await page.locator('.config-save-bar').getByRole('button', { name: 'Save all' }).click();
    await page.locator('.config-save-bar').waitFor({ state: 'detached' });

    // Leave and come back so the switch is read again from the saved config.
    await page.locator('nav').getByRole('button', { name: /^Overview/ }).first().click();
    await page.locator('nav').getByRole('button', { name: /^Settings/ }).first().click();
    cooldown = await openRouting();
    await page.waitForFunction(() => !document.querySelector('#config-native-retry [role="switch"]:disabled'));
    assert.equal(await cooldown.isChecked(), false, 'cooldown stays off after saving (disable-cooling: true)');

    assert.deepEqual(errors, []);
    console.log('Cooldown reads as a positive setting and saves its opposite correctly.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
