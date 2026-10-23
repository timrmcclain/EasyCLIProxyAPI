const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Settings → Routing previews the soonest-reset-first order and the switch writes it as
// account priorities; when every Claude account is out, the Overview offers to switch Claude Code to another model
// and Switch back restores it.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
    });
    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.quota-refresh') && !document.querySelector('.quota-refresh').disabled);
    await page.evaluate(() => {
      // Two Claude accounts: the second has less left but its weekly window resets sooner.
      const files = [0, 1].map(i => ({ name: `claude-account-0${i + 1}.json`, auth_index: `route-${i}`, provider: 'claude', status: 'active', disabled: false, priority: 10 - i, account_id: `route-${i}` }));
      const original = window.__TAURI_INTERNALS__.invoke;
      const reset = days => new Date(Date.now() + days * 86400000).toISOString();
      window.priorityWrites = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
        const req = args?.request;
        if (command === 'management_request' && req?.path === '/credentials' && req.method === 'GET') return { files };
        if (command === 'management_request' && req?.path === '/credentials/fields' && req.method === 'PATCH') { window.priorityWrites.push(req.body); return { status: 'ok' }; }
        if (command === 'management_request' && req?.path === '/requests/api-call' && String(req.body?.authIndex).startsWith('route-')) {
          const index = Number(req.body.authIndex.split('-')[1]);
          const url = req.body.url;
          if (url.includes('/api/oauth/profile')) return { status_code: 200, body: { account: { has_claude_max: true } } };
          if (url.includes('/api/oauth/usage')) return { status_code: 200, body: {
            five_hour: { utilization: window.claudeOut ? 100 : 10, resets_at: reset(.1) },
            seven_day: { utilization: window.claudeOut ? 100 : [20, 60][index], resets_at: reset([5, 2][index]) },
          } };
          return { status_code: 200, body: {} };
        }
        return original(command, args, ...rest);
      };
    });
    await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.quota-refresh').disabled && document.querySelector('.ad-list-heading'));

    // Settings → Routing: preview and switch.
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-routing').click();
    const setting = page.locator('.qrouting');
    await setting.waitFor();
    await setting.locator('summary', { hasText: 'Order right now' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.qrouting-preview ol li').length === 2);
    const order = await setting.locator('.qrouting-preview ol li').allInnerTexts();
    assert.match(order[0], /claude-account-02/, `the account resetting soonest goes first: ${order}`);
    assert.match(order[1], /claude-account-01/);
    const toggle = setting.getByRole('switch', { name: 'Use soonest-reset accounts first' });
    assert.equal(await toggle.isChecked(), false, 'off by default');
    await toggle.click();
    await page.waitForFunction(() => window.priorityWrites.length > 0);
    assert.deepEqual(await page.evaluate(() => window.priorityWrites), [{ name: 'claude-account-02.json', priority: 20 }],
      'only the account whose priority changes is written');
    assert.equal(await toggle.isChecked(), true);
    // Save for last: the soonest-reset account moves to the bottom, and the new order is written at once.
    await page.evaluate(() => { window.priorityWrites = []; });
    await setting.locator('.qrouting-preview ol li', { hasText: 'claude-account-02' }).getByRole('button', { name: 'Save for last' }).click();
    await page.waitForFunction(() => window.priorityWrites.length === 2);
    const saved = await setting.locator('.qrouting-preview ol li').allInnerTexts();
    assert.match(saved[0], /claude-account-01/, `the account saved for last moves down: ${saved}`);
    assert.match(saved[1], /claude-account-02.*Saved for last/s);
    assert.deepEqual(await page.evaluate(() => window.priorityWrites),
      [{ name: 'claude-account-01.json', priority: 20 }, { name: 'claude-account-02.json', priority: 10 }]);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('personal.routingLast')))).length, 1, 'the mark is saved');
    await toggle.click();
    await page.getByText('Your own account priorities are back.').waitFor();
    assert.equal(await toggle.isChecked(), false);

    // Every Claude account out: the Overview offers the switch.
    await page.evaluate(() => { window.claudeOut = true; });
    await page.locator('.nav-section').getByRole('button', { name: /^Overview/ }).click();
    await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
    const offer = page.locator('.app-drift-banner', { hasText: 'Every Claude account is out' });
    await offer.waitFor();
    const select = offer.getByRole('combobox', { name: 'Model to switch Claude Code to' });
    const choices = await select.locator('option').allInnerTexts();
    assert.ok(choices.length > 0 && choices.every(name => !/^claude/i.test(name)), `only non-Claude models: ${choices}`);
    await select.selectOption('gemini-3-pro');
    await offer.getByRole('button', { name: 'Switch Claude Code', exact: true }).click();
    const switched = page.locator('.app-drift-banner', { hasText: 'Claude Code is using gemini-3-pro while Claude is out.' });
    await switched.waitFor();
    await switched.getByRole('button', { name: 'Switch back', exact: true }).click();
    await switched.waitFor({ state: 'detached' });
    await offer.waitFor();

    assert.deepEqual(errors, []);
    console.log('quota routing and Claude fallback ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
