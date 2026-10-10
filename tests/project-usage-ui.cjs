const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Activity → By project lists Claude Code projects by folder name, biggest share first,
// hides the proxy's filters (they don't apply to session logs), and switching to 30 days reloads the numbers.
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
    await page.locator('.nav-section').getByRole('button', { name: 'Activity', exact: true }).click();
    await page.locator('#usage-tab-projects').click();

    const rows = page.locator('.project-usage-table tbody tr');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 3);
    assert.equal(await page.locator('.usage-filter-row').count(), 0, 'proxy filters are hidden on this tab');

    const first = rows.first();
    assert.match(await first.innerText(), /^\s*EasyCLIProxyAPI\s/, 'named by folder, biggest share first');
    assert.equal(await first.locator('td').first().getAttribute('title'), 'C:\\Users\\demo\\git\\EasyCLIProxyAPI', 'full path on hover');
    const shares = await rows.locator('td:nth-child(2) small').allInnerTexts();
    const total = shares.reduce((sum, share) => sum + Number.parseInt(share, 10), 0);
    assert.ok(total >= 99 && total <= 101, `shares add up to about 100%: ${shares}`);
    const weekSessions = await first.locator('td').nth(2).innerText();
    assert.equal(weekSessions, '9');

    await page.getByRole('button', { name: 'Last 30 days' }).click();
    await page.waitForFunction(() => document.querySelector('.project-usage-table tbody tr td:nth-child(3)')?.textContent === '27');
    assert.equal(await page.getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed'), 'true');

    // The tab is remembered like the others.
    await page.reload();
    await page.locator('.project-usage-table tbody tr').first().waitFor();

    assert.deepEqual(errors, []);
    console.log('project usage ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
