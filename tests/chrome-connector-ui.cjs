const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: the Connectors page's Claude in Chrome card reports the extension, Claude Code's sign-in
// and the browser link, and offers the right next step: Get the extension when it's missing, an explanation (and no
// launch button) when Claude Code's proxy token blocks Chrome, and "Open Claude Code with Chrome" when it can work.
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
    const openCard = async (variant) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(value => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', 'connectors');
        if (value) localStorage.setItem('mock.chrome', value); else localStorage.removeItem('mock.chrome');
      }, variant);
      await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
      const card = page.locator('.chrome-connector-card');
      const toggle = card.getByRole('button', { name: /Claude in Chrome/ });
      await toggle.waitFor();
      return { page, card, toggle };
    };

    // Like this computer: extension in both browsers, Claude Code routed through the hub with a token.
    {
      const { page, card, toggle } = await openCard(null);
      await card.locator('.connector-row-state', { hasText: 'Blocked by token sign-in' }).waitFor();
      await toggle.click();
      const steps = card.locator('.connector-steps ol > li');
      assert.equal(await steps.count(), 3);
      assert.match(await steps.nth(0).innerText(), /Google Chrome: 1\.0\.101[\s\S]*Microsoft Edge: 1\.0\.101/);
      assert.equal(await steps.nth(0).getAttribute('class'), 'done');
      assert.match(await steps.nth(1).innerText(), /through this hub using a token[\s\S]*doesn't change this for you/);
      assert.equal(await steps.nth(1).getAttribute('class'), null);
      assert.equal(await card.getByRole('button', { name: 'Open Claude Code with Chrome' }).count(), 0, 'no launch while a token blocks Chrome');
      assert.equal(await card.getByRole('button', { name: 'Get the extension' }).count(), 0);
      await page.close();
    }

    // No extension: one next step, the store page.
    {
      const { page, card, toggle } = await openCard('none');
      await card.locator('.connector-row-state', { hasText: 'Extension not installed' }).waitFor();
      await toggle.click();
      assert.match(await card.locator('.connector-steps ol > li').nth(0).innerText(), /Google Chrome: not installed/);
      await card.getByRole('button', { name: 'Get the extension' }).click();
      await page.waitForFunction(() => (window.__mockCalls ?? []).includes('open_external_url'));
      await page.close();
    }

    // Signed in with an account and linked: Ready, and the launch opens Claude Code with --chrome.
    {
      const { page, card, toggle } = await openCard('ready');
      await card.locator('.connector-row-state.on', { hasText: 'Ready' }).waitFor();
      await toggle.click();
      const steps = card.locator('.connector-steps ol > li');
      assert.deepEqual(await steps.evaluateAll(items => items.map(item => item.className)), ['done', 'done', 'done']);
      assert.match(await steps.nth(2).innerText(), /Google Chrome: linked[\s\S]*Microsoft Edge: not linked yet[\s\S]*Enabled by default/);
      await card.getByRole('button', { name: 'Open Claude Code with Chrome' }).click();
      await card.getByText('Opened in a terminal.').waitFor();
      assert.deepEqual(await page.evaluate(() => window.__mockLaunches), [{ client: 'claude-code', chrome: true }]);
      await page.close();
    }

    assert.deepEqual(errors, []);
    console.log('Claude in Chrome card shows the extension, sign-in and link, with the right next step for each.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
