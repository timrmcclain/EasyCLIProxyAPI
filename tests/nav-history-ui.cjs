const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Moving between pages: Alt+Left/Right and the mouse's back/forward buttons retrace the pages visited, the window
// title names the page, focus lands on the page heading, a skip link jumps past the sidebar, and Advanced tools
// stays open or closed as it was left.
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
      localStorage.removeItem('personal.advancedNavOpen');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    const nav = page.locator('.nav-section');
    await nav.getByRole('button', { name: 'Accounts', exact: true }).waitFor();
    const current = () => page.evaluate(() => localStorage.getItem('personal.lastPage'));
    const titleIs = async (text) => page.waitForFunction(expected => document.title === expected, text);

    await titleIs('Overview · Tim’s AI Hub');
    await nav.getByRole('button', { name: 'Accounts', exact: true }).click();
    await titleIs('Accounts · Tim’s AI Hub');
    // Focus moved from the sidebar to the page's heading.
    await page.waitForFunction(() => document.activeElement?.matches('#main-content h1, #main-content h2'));
    await nav.getByRole('button', { name: 'Activity', exact: true }).click();
    await titleIs('Activity · Tim’s AI Hub');

    await page.keyboard.press('Alt+ArrowLeft');
    await titleIs('Accounts · Tim’s AI Hub');
    await page.keyboard.press('Alt+ArrowLeft');
    await titleIs('Overview · Tim’s AI Hub');
    assert.equal(await current(), 'home');
    await page.keyboard.press('Alt+ArrowRight');
    await titleIs('Accounts · Tim’s AI Hub');
    // The mouse's forward and back buttons do the same.
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 4 })));
    await titleIs('Activity · Tim’s AI Hub');
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 3 })));
    await titleIs('Accounts · Tim’s AI Hub');
    // Visiting a new page drops the forward history.
    await nav.getByRole('button', { name: 'Connectors', exact: true }).click();
    await titleIs('Connectors · Tim’s AI Hub');
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(300);
    assert.equal(await page.title(), 'Connectors · Tim’s AI Hub');

    // Alt+Left inside a text field stays with the field.
    await page.locator('.sidebar-command-button').click();
    const search = page.getByRole('dialog').locator('input').first();
    await search.waitFor();
    await search.press('Alt+ArrowLeft');
    assert.equal(await page.title(), 'Connectors · Tim’s AI Hub');
    await page.keyboard.press('Escape');

    // The skip link is the first thing Tab reaches in a freshly opened window, and takes focus to the page.
    {
      const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await fresh.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await fresh.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'home'); });
      await fresh.goto(`${base}/?mock=running&mockDelay=5`);
      await fresh.locator('.nav-section').waitFor();
      await fresh.keyboard.press('Tab');
      assert.equal(await fresh.evaluate(() => document.activeElement?.className), 'skip-link');
      assert.equal(await fresh.evaluate(() => document.activeElement?.textContent), 'Skip to content');
      await fresh.keyboard.press('Enter');
      assert.equal(await fresh.evaluate(() => document.activeElement?.id), 'main-content');
      await fresh.close();
    }

    // Advanced tools: left open, it stays open after a restart; closed, it stays closed.
    const advanced = page.locator('details.personal-advanced');
    assert.equal(await advanced.evaluate(node => node.open), false);
    await advanced.locator('summary').click();
    await page.waitForFunction(() => localStorage.getItem('personal.advancedNavOpen') === 'true');
    await page.reload();
    await page.locator('details.personal-advanced').waitFor();
    assert.equal(await page.locator('details.personal-advanced').evaluate(node => node.open), true);
    await page.locator('details.personal-advanced summary').click();
    await page.waitForFunction(() => localStorage.getItem('personal.advancedNavOpen') === 'false');
    await page.reload();
    await page.locator('details.personal-advanced').waitFor();
    assert.equal(await page.locator('details.personal-advanced').evaluate(node => node.open), false);

    assert.deepEqual(errors, []);
    console.log('PASS: back/forward between pages, page titles, heading focus, skip link and remembered Advanced tools.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
