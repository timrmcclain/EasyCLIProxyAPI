const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Who pays for an app: on an app's page, pick its accounts and what happens when none can take a request; saving
// installs App Routing and writes the rule, and clearing it puts the app back on the normal order.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'agents');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });

    const row = page.locator('.agent-list-items button').filter({ hasText: 'Claude Desktop' }).first();
    await row.waitFor();
    await row.click();
    const card = page.locator('.app-routing-card');
    await card.getByText('Who pays for Claude Desktop', { exact: true }).waitFor();
    await card.getByText('Using the normal routing order.').waitFor();
    const save = card.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isDisabled(), true, 'nothing to save yet');
    assert.equal(await card.getByRole('button', { name: /^Use the normal order for/ }).count(), 0, 'nothing to clear yet');

    // Pick one account and Only, then save.
    const first = card.locator('.app-routing-account input').first();
    await first.check();
    const name = await card.locator('.app-routing-account').first().getAttribute('title');
    await card.getByRole('radio', { name: /Refuse the request/ }).check();
    await page.evaluate(() => { window.__mockCalls = []; });
    await save.click();
    await card.getByText('Saved. Claude Desktop now uses the accounts you picked.').waitFor();
    const calls = await page.evaluate(() => window.__mockCalls);
    assert.ok(calls.includes('app_routing_install'), `installs the plugin: ${calls.join(', ')}`);
    assert.ok(calls.some(call => call.startsWith('management_request') && call.includes('/config/plugins/configs/app-routing')), 'writes the rule');
    await card.getByText(/^App Routing is on\. Chosen accounts for Claude Desktop: 1\.$/).waitFor();
    assert.equal(await first.isChecked(), true, 'the saved account stays ticked');
    assert.equal(await card.getByRole('radio', { name: /Refuse the request/ }).isChecked(), true);
    assert.ok(name, 'each account shows its file name on hover');

    // Another app keeps the normal order.
    const codex = page.locator('.agent-list-items button').filter({ hasText: 'Codex' }).first();
    await codex.click();
    await card.getByText('Who pays for Codex', { exact: true }).waitFor();
    await card.getByText('Using the normal routing order.').waitFor();
    assert.equal(await card.locator('.app-routing-account input:checked').count(), 0);

    // Back to Claude Desktop, then clear it.
    await row.click();
    await card.getByText('Who pays for Claude Desktop', { exact: true }).waitFor();
    await card.getByText(/^App Routing is on/).waitFor();
    await card.getByRole('button', { name: 'Use the normal order for Claude Desktop' }).click();
    await card.getByText('Claude Desktop uses the normal order again.').waitFor();
    await card.getByText('Using the normal routing order.').waitFor();
    assert.equal(await card.locator('.app-routing-account input:checked').count(), 0);

    assert.deepEqual(errors, []);
    console.log('PASS: an app can be given its own accounts, with Only or Prefer, and put back on the normal order.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
