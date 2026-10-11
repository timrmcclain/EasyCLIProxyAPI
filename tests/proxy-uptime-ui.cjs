const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Health check shows the proxy's last week from stored checks: an overall figure with the outage count,
// and one cell per day coloured by that day's uptime, grey where the hub made no checks.
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
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
      // Yesterday: fully up. Today: up, then one 20-minute outage, then up again.
      const bucket = 10 * 60_000;
      const now = Math.floor(Date.now() / bucket) * bucket;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const yesterdayNoon = today.getTime() - 12 * 3_600_000;
      const history = [{ at: yesterdayNoon, up: 20, down: 0 }];
      // Today's checks sit in the hour before now, inside today unless the test runs just after midnight.
      const start = Math.max(today.getTime(), now - 5 * bucket);
      [[20, 0], [0, 20], [0, 20], [20, 0], [20, 0]].forEach(([up, down], index) => history.push({ at: start + index * bucket, up, down }));
      localStorage.setItem('personal.proxyUptime', JSON.stringify(history));
    });
    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.locator('.personal-advanced summary').click();
    await page.getByRole('button', { name: 'Health check', exact: true }).click();

    const card = page.locator('.health-uptime');
    await card.waitFor();
    assert.match(await card.locator('.health-uptime-heading').innerText(), /Proxy uptime, last 7 days/);
    // 80 up and 40 down checks overall: 66.7% up, in a single outage.
    assert.match(await card.locator('.health-uptime-heading span').innerText(), /^66\.7% up · 1 outage$/);
    const days = card.locator('.health-uptime-days li');
    assert.equal(await days.count(), 7);
    assert.equal(await days.nth(6).getAttribute('class'), 'uptime-fail', 'today had a long outage');
    assert.equal(await days.nth(5).getAttribute('class'), 'uptime-ok', 'yesterday was fully up');
    assert.equal(await days.nth(0).getAttribute('class'), 'uptime-none', 'no checks a week ago');
    assert.match(await days.nth(5).getAttribute('aria-label'), /: 100% up$/);

    if (process.env.SHOT) await card.screenshot({ path: process.env.SHOT });
    assert.deepEqual(errors, []);
    console.log('proxy-uptime-ui: ok');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
