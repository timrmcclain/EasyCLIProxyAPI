const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Settings → Diagnostics shows the end of the proxy log, filters it by level and text,
// and masks emails when Hide emails is on.
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
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-diagnostics').click();

    const section = page.getByRole('region', { name: 'Proxy log' });
    await section.waitFor();
    const lines = section.locator('.proxy-log-line');
    await lines.first().waitFor();
    assert.equal(await lines.count(), 4);
    assert.match(await section.locator('.proxy-log-lines').innerText(), /someone@example\.com/, 'emails show while Hide emails is off');
    assert.equal(await section.locator('.proxy-log-error').count(), 1, 'the error line is marked');

    await section.getByLabel('Show').selectOption('warn');
    assert.equal(await lines.count(), 2, 'warnings and errors only');
    await section.getByLabel('Show').selectOption('error');
    assert.equal(await lines.count(), 1);
    await section.getByLabel('Show').selectOption('all');
    await section.getByLabel('Search the log').fill('cooldown');
    assert.equal(await lines.count(), 1);
    assert.match(await lines.first().innerText(), /quota cooldown/);
    await section.getByLabel('Search the log').fill('nothing-like-this');
    await section.getByText('No lines match.').waitFor();
    assert.match(await section.innerText(), /Showing the newest 4 lines/);

    // With Hide emails on, addresses are masked the same way as everywhere else.
    await page.evaluate(() => localStorage.setItem('personal.hideEmails', 'true'));
    await page.reload();
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-diagnostics').click();
    const masked = page.getByRole('region', { name: 'Proxy log' }).locator('.proxy-log-lines');
    await masked.locator('.proxy-log-line').first().waitFor();
    const text = await masked.innerText();
    assert.ok(!text.includes('someone@example.com'), 'email hidden');
    assert.match(text, /s•••@example\.com/);

    assert.deepEqual(errors, []);
    console.log('proxy log ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
