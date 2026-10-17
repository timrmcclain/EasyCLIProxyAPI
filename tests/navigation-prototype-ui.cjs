const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// The prototype navigation from the UI review, switched on: six main groups, Settings and Diagnostics apart,
// a group's pages listed above the page, and every page still reachable.
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
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.newNavigation', 'true');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.locator('.app-shell').waitFor();
    const nav = page.locator('.nav-section');
    const entry = name => nav.getByRole('button', { name, exact: true });

    const main = await nav.locator(':scope > button').allInnerTexts();
    assert.deepEqual(main.map(text => text.trim()), ['Overview', 'Accounts', 'Activity', 'AI apps', 'Tools & connectors', 'Safety'], 'six main groups in order');
    assert.deepEqual((await nav.locator('.nav-utility-groups > button').allInnerTexts()).map(text => text.trim()), ['Settings', 'Diagnostics']);
    assert.equal(await nav.locator('.personal-advanced').count(), 0, 'no Advanced tools section');
    // All eight entries fit in the sidebar at 1440x900 without scrolling it.
    assert.equal(await nav.evaluate(node => node.scrollHeight <= node.clientHeight + 1), true, 'sidebar entries fit without scrolling');

    // A group with several pages lists them above the page; one with a single page does not.
    await entry('Safety').click();
    const sections = page.locator('.nav-group-sections');
    await sections.waitFor();
    assert.equal(await sections.getByRole('button').count(), 2, 'Safety lists Secret Guard and Jev');
    assert.equal(await entry('Safety').getAttribute('aria-current'), 'page');
    await sections.getByRole('button').nth(1).click();
    assert.equal(await sections.getByRole('button').nth(1).getAttribute('aria-current'), 'page');
    await entry('Activity').click();
    await sections.waitFor({ state: 'detached' });

    // Reopening a group returns to the page last used in it.
    await entry('Safety').click();
    assert.equal(await page.locator('.nav-group-sections button').nth(1).getAttribute('aria-current'), 'page', 'Safety reopens on Jev');

    // Settings holds Proxy, Updates, Proxy plugins and Compression as sections.
    await nav.locator('.nav-utility-groups > button').filter({ hasText: 'Settings' }).click();
    assert.equal(await page.locator('.nav-group-sections button').count(), 5);

    // Ctrl+number follows the new order.
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+2');
    await page.waitForFunction(() => document.querySelector('.nav-section > button[aria-current="page"]')?.textContent?.trim() === 'Accounts');
    assert.equal(await page.locator('.nav-group-sections button').count(), 2, 'Accounts lists Accounts and API Access');

    // Phone width: the sidebar row still fits.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no page overflow at 390px');

    assert.deepEqual(errors, []);
    console.log('PASS: prototype navigation groups pages, lists sections, remembers the last page and keeps shortcuts.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
