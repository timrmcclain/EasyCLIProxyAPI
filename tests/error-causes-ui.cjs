const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Activity → Overview groups failed requests by cause, worst first; expanding a fixable
// cause shows the provider's message and an Accounts button that navigates there, while a canceled request isn't counted.
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
    await page.locator('#usage-tab-overview').click();

    const card = page.getByRole('region', { name: 'Failures by cause' });
    await card.waitFor();
    const rows = card.locator('.error-cause-row');
    assert.equal(await rows.count(), 2, 'one rate limit and one revoked sign-in; the canceled request is left out');
    const labels = (await rows.locator('strong').allInnerTexts()).sort();
    assert.deepEqual(labels, ['Rate limited or out of quota', 'Sign-in expired or revoked']);
    assert.match(await rows.filter({ hasText: 'Rate limited' }).innerText(), /HTTP 429/);

    const signIn = rows.filter({ hasText: 'Sign-in expired' });
    assert.equal(await signIn.getAttribute('aria-expanded'), 'false');
    await signIn.click();
    assert.equal(await signIn.getAttribute('aria-expanded'), 'true');
    await card.getByText('OAuth access token has been revoked.').waitFor();
    await card.getByRole('button', { name: 'Open Accounts' }).click();
    await page.locator('.nav-section').getByRole('button', { name: 'Accounts', exact: true }).and(page.locator('.active, [aria-current="page"]')).waitFor();

    assert.deepEqual(errors, []);
    console.log('error causes ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
