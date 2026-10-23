const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Accounts' provider and status filters and Activity's result filter survive a restart;
// a link like "Show failed requests" doesn't overwrite the saved choice; an account's status pulses once when it
// changes, and nothing pulses on first load.
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
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'oauth');
    });
    const url = `${base}/?mock=running&mockDelay=5`;
    await page.goto(url, { timeout: 60000 });

    // Accounts: provider and status filters come back after a restart.
    const status = page.getByRole('combobox', { name: 'All Statuses' });
    const provider = page.getByRole('combobox', { name: 'All Providers' });
    await status.waitFor();
    await page.locator('.auth-file-card').first().waitFor();
    assert.equal(await page.locator('.status-changed').count(), 0, 'nothing pulses on first load');
    const someProvider = await provider.locator('option').nth(1).getAttribute('value');
    await provider.selectOption(someProvider);
    await status.selectOption('enabled');
    await page.reload();
    await status.waitFor();
    await page.locator('.auth-file-card').first().waitFor();
    assert.equal(await provider.inputValue(), someProvider, 'provider filter remembered');
    assert.equal(await status.inputValue(), 'enabled', 'status filter remembered');

    // A remembered provider with no accounts left falls back to every provider.
    await page.evaluate(() => localStorage.setItem('personal.accountsProvider', 'no-such-provider'));
    await page.reload();
    await page.locator('.auth-file-card').first().waitFor();
    await page.waitForFunction(() => document.querySelector('select[aria-label="All Providers"]')?.value === 'all');

    // Turning an account off pulses its status once.
    await status.selectOption('all');
    const card = page.locator('.auth-file-card').filter({ has: page.locator('.auth-list-switch[aria-checked="true"]:not(:disabled)') }).first();
    const before = await card.locator('.auth-status-badge').innerText();
    await card.locator('.auth-list-switch').click();
    await page.waitForFunction(text => [...document.querySelectorAll('.auth-status-badge')].some(badge => badge.classList.contains('status-changed') && badge.innerText !== text), before);
    await page.waitForFunction(() => !document.querySelector('.auth-status-badge.status-changed'), null, { timeout: 3000 });

    // Activity: the result filter is remembered; "Show failed requests" doesn't change what's saved.
    await page.locator('nav').getByRole('button', { name: /^Activity/ }).first().click();
    await page.getByRole('tab', { name: 'Requests' }).click();
    const more = page.getByRole('button', { name: 'More filters' });
    if (await more.count()) await more.click();
    const result = page.getByRole('button', { name: 'Request result' });
    await result.click();
    await page.getByRole('listbox', { name: 'Request result' }).getByRole('option', { name: 'Success' }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cpa-gui.usage-events-result.v1')), 'success');
    await page.reload();
    await page.getByRole('tab', { name: 'Requests', selected: true }).waitFor();
    const moreAgain = page.getByRole('button', { name: 'More filters' });
    if (await moreAgain.count()) await moreAgain.click();
    assert.match(await page.getByRole('button', { name: 'Request result' }).innerText(), /Success/, 'result filter remembered');

    await page.keyboard.press('Control+k');
    // Type only once the palette is open: keys pressed before it appears are lost on a busy machine.
    const paletteInput = page.getByRole('dialog', { name: /command/i }).getByRole('combobox').or(page.getByRole('dialog', { name: /command/i }).getByRole('textbox')).first();
    await paletteInput.waitFor();
    await paletteInput.fill('failed requests');
    await page.getByRole('dialog', { name: /command/i }).getByText('Show failed requests').click();
    const shown = page.getByRole('button', { name: 'Request result' });
    if (!(await shown.isVisible())) await page.getByRole('button', { name: 'More filters' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="Request result"]')].some(button => /Failed/.test(button.innerText)));
    assert.equal(await page.evaluate(() => localStorage.getItem('cpa-gui.usage-events-result.v1')), 'success', 'a link does not overwrite the saved choice');

    assert.deepEqual(errors, []);
    console.log('Filters are remembered; status changes pulse once.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
