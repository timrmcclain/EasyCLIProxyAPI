const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Settings that have their own editor elsewhere (model aliases, excluded models, plugin settings) are shown in
// Settings as a read-only summary with a link to that editor, so the same value is never saved two different ways.
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
    const open = async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'config'); });
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      await page.locator('#config-subpage-panel').waitFor();
      return page;
    };
    const showUpstreams = async (page) => {
      await page.locator('#config-subpage-tab-oauth').click();
      await page.locator('#config-subpage-panel').getByRole('button', { name: 'Show advanced settings', exact: true }).click();
      const group = page.locator('#config-group-oauth-models');
      await group.waitFor();
      return group;
    };
    const fieldNamed = (group, name) => group.locator('.template-config-field').filter({ has: group.page().locator('.template-config-label', { hasText: name }) });

    // Model aliases: summary, no reset or editor, and the link opens Settings → Model aliases.
    {
      const page = await open();
      const group = await showUpstreams(page);
      const aliases = fieldNamed(group, 'Model aliases');
      await aliases.locator('.owned-setting').waitFor();
      assert.equal(await aliases.locator('input, textarea, select').count(), 0, 'no second editor for model aliases');
      assert.equal(await aliases.locator('.template-config-reset').count(), 0, 'no reset that could clear the owner\'s value');
      const excluded = fieldNamed(group, 'Excluded models');
      assert.equal(await excluded.locator('input, textarea, select').count(), 0, 'no second editor for excluded models');
      await aliases.getByRole('button', { name: 'Edit in Model aliases' }).click();
      await page.locator('#config-subpage-tab-aliases[aria-selected="true"]').waitFor();
      await page.locator('#config-native-aliases:not([hidden])').waitFor();
      await page.close();
    }

    // Excluded models: the link opens Accounts.
    {
      const page = await open();
      const group = await showUpstreams(page);
      await fieldNamed(group, 'Excluded models').getByRole('button', { name: 'Edit in Accounts' }).click();
      await page.waitForFunction(() => localStorage.getItem('personal.lastPage') === 'oauth');
      await page.close();
    }

    // Plugins: one summary row instead of five editors, linking to the Plugins page.
    {
      const page = await open();
      await page.locator('#config-subpage-tab-extensions').click();
      await page.locator('.config-extension-guide').getByRole('button', { name: 'Show advanced settings', exact: true }).click();
      const plugins = page.locator('#config-group-extensions-plugins');
      await plugins.waitFor();
      assert.equal(await plugins.locator('.template-config-field').count(), 1);
      assert.match(await plugins.locator('.owned-setting-summary').innerText(), /^(On|Off) · \d+ plugins? configured$/);
      assert.equal(await plugins.locator('input, textarea, select').count(), 0);
      await plugins.getByRole('button', { name: 'Edit in Plugins' }).click();
      await page.waitForFunction(() => localStorage.getItem('personal.lastPage') === 'plugins');
      await page.close();
    }

    assert.deepEqual(errors, []);
    console.log('PASS: settings with their own editor show a summary and a link instead of a second editor.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
