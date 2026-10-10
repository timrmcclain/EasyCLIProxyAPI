const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: clicking a row in Activity → Requests opens everything recorded about that request,
// including the provider's error for a failed one; Escape closes it.
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
    const rows = page.locator('.usage-events-table tbody tr');
    await rows.first().waitFor();

    // A failed request (the mock's 6th) shows its status and the provider's error.
    const failedRow = rows.filter({ hasText: '429' }).first();
    await failedRow.click();
    const dialog = page.getByRole('dialog', { name: 'Request details' });
    await dialog.waitFor();
    const text = await dialog.innerText();
    assert.match(text, /Time\s+\S+.*\d{1,2}:\d{2}/, 'the time includes hours and minutes');
    for (const expected of ['Result', 'HTTP 429', 'Account', 'Model requested', 'First token', 'Cache read', 'Proxy key', 'Error from the provider', 'Mock rate limit exceeded']) {
      assert.ok(text.includes(expected), `details include ${expected}: ${text}`);
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // Keyboard: Enter on a focused row opens a successful request, which has no error section.
    await rows.first().focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.equal(await dialog.getByText('Error from the provider').count(), 0);
    assert.match(await dialog.innerText(), /App\s+(Codex|Claude Code|Claude Desktop)/);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });

    assert.deepEqual(errors, []);
    console.log('request details ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
