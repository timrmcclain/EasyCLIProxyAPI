const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 1423, strictPort: true } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto('http://127.0.0.1:1423/?mock=running');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await page.getByRole('heading', { name: 'Accounts & quota' }).waitFor();
    assert.equal(await nav.getByRole('button').count(), 6, 'Six everyday pages are visible; the rest sit under Advanced tools');
    assert.equal(await nav.locator('.personal-advanced').evaluate(node => node.open), false, 'Advanced tools start collapsed');
    await page.locator('.quota-ledger-notes > summary').click();
    await page.locator('.ledger-evidence strong').filter({ hasText: 'codex-personal.json' }).waitFor();
    // The mock serves the provider fixtures: Claude, Antigravity, Codex, Grok, Kimi, Devin and Gemini accounts.
    assert.equal(await page.locator('.quota-provider-summary-cell').count(), 7);
    assert.equal(await page.locator('.quota-provider-summary-cell').filter({ hasText: 'Gemini' }).locator('.quota-summary-value').innerText(), '—', 'Unknown availability must not look like zero allowance');
    assert.ok((await page.locator('.quota-provider-summary-cell').filter({ hasText: 'Gemini' }).innerText()).includes('Availability unconfirmed'));
    assert.equal(await page.locator('.ad-metrics').count(), 0, 'Overview uses provider quota strip instead of generic metric cards');
    assert.ok((await page.locator('.ledger-evidence').boundingBox()).height < 110, 'Latest request stays compact');
    const filters = page.getByRole('group', { name: 'Filter accounts by provider' });
    await filters.getByRole('button', { name: /^Claude/ }).click();
    assert.equal(await page.locator('.ad-card').count(), 2, 'Filtering shows both Claude accounts, healthy or not');
    const team = page.locator('.ad-card').filter({ hasText: 'claude-team.json' });
    await team.locator('.ad-account-details > summary').click();
    assert.ok((await team.innerText()).includes('Claude Desktop'));
    await team.locator('.ad-account-details > summary').click();
    await filters.getByRole('button', { name: /^Grok/ }).click();
    await page.getByRole('searchbox', { name: 'Search accounts' }).fill('claude');
    assert.equal(await page.locator('.ad-card').count(), 0);
    await page.getByText('No accounts match these filters', { exact: true }).waitFor();
    await page.locator('.quota-no-results').getByRole('button', { name: 'Clear filters', exact: true }).click();
    // Healthy accounts collapse behind a toggle once no filter is active.
    await page.locator('.ad-healthy-toggle').getByRole('button', { name: 'Show all', exact: true }).click();
    assert.ok(await page.locator('.ad-card').count() >= 3);
    await page.getByLabel('Hide emails', { exact: true }).check();
    assert.ok(!(await page.locator('.account-dashboard').innerText()).includes('@example.com'));
    assert.ok(!(await page.locator('.ad-card h3').first().getAttribute('title')).includes('@'));
    await page.getByLabel('Hide emails', { exact: true }).uncheck();
    const details = page.locator('.ad-account-details').first();
    assert.equal(await details.getAttribute('open'), null);
    await details.locator('summary').click();
    assert.equal(await details.getByRole('spinbutton').isVisible(), true);
    assert.equal(await page.locator('.sidebar-contact').count(), 0);
    await nav.getByRole('button', { name: 'Accounts', exact: true }).click();
    await page.getByRole('heading', { name: 'Saved accounts' }).waitFor();
    await page.locator('#oauth-subpage-tab-login').click();
    assert.equal(await page.locator('.oauth-card').count(), 2);
    await page.getByLabel('Show other providers').check();
    assert.equal(await page.locator('.oauth-card').count(), 7, 'Antigravity, Kimi, xAI, Devin and Meta join Claude and Codex');
    await page.getByLabel('Show other providers').uncheck();
    assert.equal(await page.locator('.oauth-card').count(), 2);
    await nav.getByRole('button', { name: 'Connected apps', exact: true }).click();
    await page.locator('.personal-context > summary').filter({ hasText: 'Desktop and terminal connections are separate.' }).waitFor();
    // The app list shows detected apps; Manage Clients narrows it and Restore automatic display brings the others back.
    const listedApps = page.locator('.agent-list-items > button');
    const detectedCount = await listedApps.count();
    assert.ok(detectedCount > 1);
    assert.ok((await page.locator('.agent-list-items > button.active').innerText()).includes('Claude Desktop'));
    const manager = page.locator('.agent-client-manager');
    await page.getByRole('button', { name: 'Manage Clients', exact: true }).click();
    for (const label of await manager.locator('.agent-client-catalog input:checked').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))) {
      if (label !== 'Claude Desktop') await manager.getByRole('checkbox', { name: label, exact: true }).uncheck();
    }
    await manager.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await listedApps.count(), 1);
    assert.ok((await listedApps.first().innerText()).includes('Claude Desktop'));
    await page.getByRole('button', { name: 'Manage Clients', exact: true }).click();
    await manager.getByRole('button', { name: 'Restore automatic display', exact: true }).click();
    await manager.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await listedApps.count(), detectedCount, 'Other apps return to the list');
    await page.screenshot({ path: path.join(os.tmpdir(), 'easycli-personal-connections.png'), fullPage: true });
    await nav.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.locator('.usage-records-page').waitFor();
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.config-page').waitFor();
    await nav.locator('.personal-advanced > summary').click();
    assert.equal(await nav.locator('.personal-advanced').getByRole('button').count(), 6, 'Advanced tools hold Compression, Quota Lookup, Proxy, API Access, Plugins and About');
    await nav.getByRole('button', { name: 'About & maintenance' }).click();
    await page.getByText(/Personal build: app updates are manual/).waitFor();
    assert.equal(await page.locator('.app-module-card button').count(), 0);
    assert.equal(await page.locator('.core-module-card button').count(), 3);
    assert.equal(await page.locator('.maintenance-downloads').getAttribute('open'), null);
    await page.screenshot({ path: path.join(os.tmpdir(), 'easycli-maintenance-final.png'), fullPage: true });
    await page.locator('.maintenance-downloads summary').click();
    assert.equal(await page.locator('.version-source-control select').isVisible(), true);
    // The mock has limited accounts, so Overview's name includes its attention dot.
    await nav.getByRole('button', { name: /^Overview/ }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const colors = await nav.getByRole('button', { name: 'Accounts', exact: true }).evaluate((el) => ({ text: getComputedStyle(el).color, background: getComputedStyle(el.closest('.sidebar')).backgroundColor }));
    assert.equal(colors.text, 'rgb(189, 201, 210)', 'Dark navigation must use readable text');
    // The connection card lives in the collapsed Proxy & connection details section on Overview.
    await page.locator('.home-proxy-details > summary').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.client-api-card')).backgroundColor === 'rgba(255, 255, 255, 0.035)');
    await page.screenshot({ path: path.join(os.tmpdir(), 'easycli-personal-final-dark.png'), fullPage: true });
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'easycli-personal-final-light.png'), fullPage: true });
    await page.setViewportSize({ width: 640, height: 700 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'App overflows at minimum window width');
    assert.deepEqual(errors, []);
    console.log('PASS: all navigation, provider/app disclosure, desktop guidance, update protection, dark text, minimum window width.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
