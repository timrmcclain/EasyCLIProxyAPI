const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Alerts are kept in the hub: the sidebar shows how many are new, the list opens each alert's page, and alerts kept
// from popping up (a kind switched off, quiet hours) are still listed with the reason. Settings has a switch per
// kind and quiet hours.
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
      // Announced already, so the first part sees only the seeded alerts; the update alert is checked below.
      localStorage.setItem('personal.updateNotified.core', '7.3.16');
      const now = Date.now();
      localStorage.setItem('personal.alertHistory', JSON.stringify([
        { id: 'a', at: now - 60_000, kind: 'secrets', title: 'Secret Guard found a key', body: 'An app sent an API key.', page: 'secret-guard', read: false },
        { id: 'b', at: now - 120_000, kind: 'quota', title: 'Claude (work) is out', body: 'Resets in 2h.', page: 'home', read: false, silenced: 'quiet' },
      ]));
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`);

    // The sidebar counts new alerts; opening the list marks them read.
    const button = page.locator('.sidebar-alerts-link');
    await button.getByText('Alerts (2 new)').waitFor();
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Recent alerts' });
    await dialog.waitFor();
    const items = dialog.locator('.alert-history-item');
    assert.equal(await items.count(), 2);
    assert.match(await items.nth(0).innerText(), /Secret Guard found a key[\s\S]*Secret Guard findings/);
    assert.match(await items.nth(1).innerText(), /Not shown: quiet hours/);
    await button.getByText('Alerts', { exact: true }).waitFor();

    // Open goes to the alert's page.
    await items.nth(0).getByRole('button', { name: 'Open' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => localStorage.getItem('personal.lastPage') === 'secret-guard');

    // A new alert during quiet hours is recorded, marked, and does not pop up.
    const result = await page.evaluate(async () => {
      localStorage.setItem('personal.quietHours', JSON.stringify({ enabled: true, start: '00:00', end: '23:59' }));
      const shown = [];
      const OriginalNotification = window.Notification;
      window.Notification = function (title) { shown.push(title); };
      const { notify } = await import('/src/services/notifications.ts');
      await notify('proxy', [{ title: 'The proxy stopped', body: 'Requests fail until it is back.' }]);
      window.Notification = OriginalNotification;
      const [latest] = JSON.parse(localStorage.getItem('personal.alertHistory'));
      return { latest, shown };
    });
    assert.equal(result.latest.title, 'The proxy stopped');
    assert.equal(result.latest.silenced, 'quiet');
    assert.equal(result.latest.page, 'home');
    assert.deepEqual(result.shown, []);
    await button.getByText('Alerts (1 new)').waitFor();

    // A new proxy engine version is announced once, not on every check.
    await page.evaluate(() => localStorage.removeItem('personal.updateNotified.core'));
    await page.reload();
    await page.waitForFunction(() => localStorage.getItem('personal.updateNotified.core') === '7.3.16');
    await page.reload();
    await page.locator('.sidebar-alerts-link').waitFor();
    await page.waitForTimeout(1500);
    const updates = await page.evaluate(() => JSON.parse(localStorage.getItem('personal.alertHistory')).filter(entry => entry.kind === 'updates'));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].title, 'Proxy engine update available: 7.3.16');
    assert.equal(updates[0].page, 'versions');

    // Settings: one switch per kind, and quiet hours, saved as you change them.
    await page.evaluate(() => {
      localStorage.removeItem('personal.quietHours');
      localStorage.setItem('personal.lastPage', 'config');
    });
    await page.reload();
    const settings = page.locator('.alert-kind-settings');
    if (!(await settings.count())) {
      await page.locator('#config-subpage-tab-app, [id^="config-subpage-tab-"]').filter({ hasText: /App|preferences/i }).first().click().catch(() => undefined);
    }
    await settings.waitFor();
    assert.equal(await settings.locator('.alert-kind-option input[type="checkbox"]').count(), 7, 'six kinds and quiet hours');
    await settings.getByLabel('Updates available').uncheck();
    await settings.getByLabel('Quiet hours').check();
    await settings.locator('input[type="time"]').first().fill('21:30');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('personal.alertKinds')).updates), false);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('personal.quietHours'))), { enabled: true, start: '21:30', end: '07:00' });

    assert.deepEqual(errors, []);
    console.log('PASS: alerts are kept in the hub, open their page, respect quiet hours and per-kind switches.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
