const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: an account with a week of stored readings shows a 7-day chart in its details, broken where
// readings stopped for hours; an account without readings says the chart is still collecting.
async function showAll(page) {
  await page.getByRole('button', { name: 'Refresh accounts', exact: true }).waitFor();
  await page.locator('.ad-card, .ad-list-heading').first().waitFor();
  const button = page.locator('.ad-list-heading').getByRole('button', { name: /^Show all \d+$/ });
  if (await button.count()) await button.click();
}

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
    await showAll(page);
    const rows = page.locator('article.ad-row-card');
    await rows.first().waitFor();
    const [withTrend, withoutTrend] = await rows.evaluateAll(cards => cards.slice(0, 2).map(card => card.getAttribute('data-account-key')));

    // A week of hourly readings falling from 100% to 40%, with a 10-hour gap two days ago.
    await page.evaluate(key => {
      const now = Date.now();
      const samples = [];
      for (let hour = 7 * 24 - 1; hour >= 0; hour -= 1) {
        if (hour > 38 && hour < 48) continue;
        samples.push({ at: now - hour * 3_600_000, percent: 40 + hour * (60 / (7 * 24)) });
      }
      localStorage.setItem('personal.quotaTrends', JSON.stringify({ [key]: { label: '7-day window', samples } }));
    }, withTrend);
    await page.reload();
    await showAll(page);

    const card = page.locator(`article[data-account-key="${withTrend}"]`);
    await card.locator('summary').click();
    const chart = card.locator('figure.quota-trend');
    await chart.waitFor();
    assert.equal(await chart.locator('figcaption').innerText(), '7-day window, last 7 days');
    assert.match(await chart.getByRole('img').getAttribute('aria-label'), /^40% left now, lowest 40%$/);
    assert.equal(await chart.locator('polyline').count(), 2, 'the 10-hour gap breaks the line in two');

    const empty = page.locator(`article[data-account-key="${withoutTrend}"]`);
    await empty.locator('summary').click();
    await empty.getByText('A 7-day chart of this account').waitFor();
    assert.equal(await empty.locator('figure.quota-trend').count(), 0);

    if (process.env.SHOT) await chart.screenshot({ path: process.env.SHOT });
    assert.deepEqual(errors, []);
    console.log('quota trend ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
