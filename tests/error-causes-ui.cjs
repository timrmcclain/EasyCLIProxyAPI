const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Activity → Requests groups failed requests by cause, worst first; expanding a fixable
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
    await page.locator('#usage-tab-events').click();

    const card = page.getByRole('region', { name: 'Failures by cause' });
    await card.waitFor();
    // Starts folded, naming how many failed and the worst cause; opening it is remembered.
    assert.equal(await card.locator('details').evaluate(node => node.open), false);
    assert.match(await card.locator('summary').innerText(), /2 failed requests/);
    await card.locator('summary').click();
    await page.waitForFunction(() => localStorage.getItem('personal.failuresCardOpen') === 'true');
    const rows = card.locator('.error-cause-row');
    assert.equal(await rows.count(), 2, 'one rate limit and one revoked sign-in; the canceled request is left out');
    const labels = (await rows.locator('strong').allInnerTexts()).sort();
    assert.deepEqual(labels, ['Rate limited or out of quota', 'Sign-in expired or revoked']);
    assert.match(await rows.filter({ hasText: 'Rate limited' }).innerText(), /HTTP 429/);

    // Response times: one row per mock model, from successful requests only, each with a typical and slowest time.
    const timings = page.getByRole('region', { name: 'Response times by model' });
    await timings.waitFor();
    await timings.locator('summary').click();
    const timingRows = timings.locator('tbody tr');
    assert.equal(await timingRows.count(), 3, 'three mock models with enough successful requests');
    assert.deepEqual((await timingRows.locator('th').allInnerTexts()).sort(), ['claude-sonnet-4-6', 'gemini-3-pro', 'gpt-5.2-codex']);
    for (const text of await timingRows.allInnerTexts()) assert.match(text, /\d(\.\d)? s|\d+ ms/, `formatted durations in: ${text}`);

    const signIn = rows.filter({ hasText: 'Sign-in expired' });
    assert.equal(await signIn.getAttribute('aria-expanded'), 'false');
    await signIn.click();
    assert.equal(await signIn.getAttribute('aria-expanded'), 'true');
    await card.locator('blockquote').getByText('OAuth access token has been revoked.').waitFor();
    await card.getByRole('button', { name: 'Open Accounts' }).click();
    await page.locator('.nav-section').getByRole('button', { name: 'Accounts', exact: true }).and(page.locator('.active, [aria-current="page"]')).waitFor();

    assert.deepEqual(errors, []);
    console.log('error causes ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
