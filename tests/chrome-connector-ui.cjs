const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: the Connectors page's Claude in Chrome card draws the chain (extension, sign-in, browser
// link), marks the first break, and offers the one step that mends it: Get the extension; "Start a Chrome session"
// (its own config folder, signed in with /login) when the hub's token blocks Chrome; "Open Claude Code with Chrome"
// when it already works.
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

    const chainStates = card => card.locator('.chrome-link').evaluateAll(links => links.map(link => `${link.dataset.link}:${link.className.replace('chrome-link is-', '')}`));

    // Like this computer: extension in both browsers, Claude Code routed through the hub with a token.
    {
      const { page, card, toggle } = await openCard(null);
      await card.locator('.connector-row-state', { hasText: 'Off: token sign-in' }).waitFor();
      await toggle.click();
      assert.deepEqual(await chainStates(card), ['extension:done', 'signIn:broken', 'link:waiting'], 'the break is sign-in; the link waits on it');
      assert.equal(await card.locator('[data-link="extension"] small').innerText(), 'Chrome 1.0.101 · Edge 1.0.101');
      assert.equal(await card.locator('[data-link="link"] small').innerText(), 'Waiting on sign-in');
      const next = card.locator('.chrome-next');
      assert.equal(await next.locator('strong').innerText(), 'Claude Code signs in through this hub');
      assert.match(await next.innerText(), /everyday Claude Code stays as it is[\s\S]*\.claude-chrome[\s\S]*\/login/);
      assert.equal(await card.getByRole('button', { name: 'Open Claude Code with Chrome' }).count(), 0, 'with a token, the launch is a Chrome session');
      await next.getByRole('button', { name: 'Why' }).click();
      await page.waitForFunction(() => (window.__mockCalls ?? []).includes('open_external_url'));
      await next.getByRole('button', { name: 'Start a Chrome session' }).click();
      await card.getByText('Opened in a terminal. Type /login, then come back.').waitFor();
      assert.deepEqual(await page.evaluate(() => window.__mockLaunches), [{ client: 'claude-code', chrome: true }]);
      await page.close();
    }

    // Token setup, but the Chrome session is signed in: sign-in is done and the link is the next step.
    {
      const { page, card, toggle } = await openCard('session');
      await card.locator('.connector-row-state', { hasText: 'Not linked yet' }).waitFor();
      await toggle.click();
      assert.deepEqual(await chainStates(card), ['extension:done', 'signIn:done', 'link:broken']);
      assert.equal(await card.locator('[data-link="signIn"] small').innerText(), 'Claude account (Chrome session)');
      assert.equal(await card.locator('.chrome-next strong').innerText(), 'Link Claude Code to your browser');
      await card.getByRole('button', { name: 'Start a Chrome session' }).click();
      await card.getByText('Opened in a terminal.', { exact: true }).waitFor();
      await page.close();
    }

    // No extension: one next step, the store page.
    {
      const { page, card, toggle } = await openCard('none');
      await card.locator('.connector-row-state', { hasText: 'Needs the extension' }).waitFor();
      await toggle.click();
      assert.deepEqual(await chainStates(card), ['extension:broken', 'signIn:broken', 'link:waiting']);
      assert.equal(await card.locator('[data-link="extension"] small').innerText(), 'Not installed');
      assert.equal(await card.locator('.chrome-next strong').innerText(), 'Install the Claude extension');
      await card.getByRole('button', { name: 'Get the extension' }).click();
      await page.waitForFunction(() => (window.__mockCalls ?? []).includes('open_external_url'));
      await page.close();
    }

    // Signed in with an account and linked: Ready, and the launch opens Claude Code with --chrome.
    {
      const { page, card, toggle } = await openCard('ready');
      await card.locator('.connector-row-state.on', { hasText: 'Ready' }).waitFor();
      await toggle.click();
      assert.deepEqual(await chainStates(card), ['extension:done', 'signIn:done', 'link:done']);
      assert.equal(await card.locator('[data-link="link"] small').innerText(), 'Chrome');
      assert.match(await card.locator('.chrome-next').innerText(), /Ready to use[\s\S]*Enabled by default/);
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
