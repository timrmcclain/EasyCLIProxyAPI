const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Settings → Routing shows one order per provider. Your order follows the list, Smart puts
// the soonest-reset account first, Reserve keeps an account last, nothing is written until you save, and Undo puts
// the order back. When every Claude account is out, the Overview offers to switch Claude Code to another model and
// Switch back restores it.
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
        if (command === 'management_request' && req?.path === '/credentials/fields' && req.method === 'PATCH') {
          window.priorityWrites.push(req.body);
          const target = files.find(item => item.name === req.body.name);
          if (target) target.priority = req.body.priority;
          return { status: 'ok' };
        }
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

    // Settings → Routing: the Claude order card.
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-routing').click();
    const card = page.locator('.routing-order-card').filter({ has: page.getByRole('heading', { name: 'Claude', exact: true }) });
    await card.waitFor();
    const rows = () => card.locator('.routing-order-row').allInnerTexts();
    await page.waitForFunction(() => document.querySelectorAll('.routing-order-row').length === 2);
    let order = await rows();
    assert.match(order[0], /claude-account-01.*Primary/s, `your order starts from the proxy's priorities: ${order}`);
    assert.match(order[1], /claude-account-02.*Next/s);
    assert.match(await card.locator('.routing-order-next').innerText(), /New requests go to .*claude-account-01/);
    assert.deepEqual(await page.evaluate(() => window.priorityWrites), [], 'opening the order writes nothing');

    // Smart: previewed first, written only on Save.
    await card.getByRole('button', { name: 'Smart', exact: true }).click();
    await card.locator('.routing-order-save', { hasText: 'Not saved yet' }).waitFor();
    order = await rows();
    assert.match(order[0], /claude-account-02/, `the account resetting soonest goes first: ${order}`);
    assert.match(await card.locator('.routing-order-save').innerText(), /would go to .*claude-account-02/);
    assert.deepEqual(await page.evaluate(() => window.priorityWrites), [], 'the preview writes nothing');
    await card.getByRole('button', { name: 'Save order', exact: true }).click();
    await page.waitForFunction(() => window.priorityWrites.length > 0);
    assert.deepEqual(await page.evaluate(() => window.priorityWrites), [{ name: 'claude-account-02.json', priority: 20 }],
      'only the account whose priority changes is written');
    await card.locator('.routing-order-save').waitFor({ state: 'detached' });

    // Reserve: the soonest-reset account moves to the bottom even in Smart.
    await page.evaluate(() => { window.priorityWrites = []; });
    await card.getByRole('button', { name: /Use .*claude-account-02.* only when the others/ }).click();
    order = await rows();
    assert.match(order[0], /claude-account-01/, `Reserve moves the account down: ${order}`);
    assert.match(order[1], /claude-account-02.*Reserve/s);
    await card.getByRole('button', { name: 'Save order', exact: true }).click();
    await page.waitForFunction(() => window.priorityWrites.length === 2);
    assert.deepEqual(await page.evaluate(() => window.priorityWrites),
      [{ name: 'claude-account-01.json', priority: 20 }, { name: 'claude-account-02.json', priority: 10 }]);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('personal.routingOrders')));
    assert.equal(saved.providers.claude.mode, 'smart');
    assert.equal(saved.reserve.length, 1, 'the Reserve mark is saved');

    // Undo puts the order back the way it was before that save.
    await page.evaluate(() => { window.priorityWrites = []; });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('Order put back').waitFor();
    await page.waitForFunction(() => window.priorityWrites.length === 2);
    order = await rows();
    assert.match(order[0], /claude-account-02/, `undo restores the order: ${order}`);

    // Your order: move buttons rearrange it, and the order you save is what the proxy gets.
    await page.evaluate(() => { window.priorityWrites = []; });
    await card.getByRole('button', { name: 'Your order', exact: true }).click();
    await card.getByRole('button', { name: /Move .*claude-account-02.* down/ }).click();
    order = await rows();
    assert.match(order[0], /claude-account-01/, `moving rearranges the preview: ${order}`);
    await card.getByRole('button', { name: 'Save order', exact: true }).click();
    await page.waitForFunction(() => window.priorityWrites.length === 2);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('personal.routingOrders')))).providers.claude.mode, 'manual');
    await card.locator('.routing-order-history summary').click();
    assert.match(await card.locator('.routing-order-history').innerText(), /You/);

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
