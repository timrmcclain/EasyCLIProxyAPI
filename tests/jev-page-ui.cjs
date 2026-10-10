const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Advanced tools → Jev shows the status rows, the payoff answers, the
// interventions newest first, and Refresh updates a stale report.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
    });

    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.locator('.personal-advanced summary').click();
    await page.getByRole('button', { name: 'Jev', exact: true }).click();
    await page.getByRole('heading', { name: 'Jev', exact: true }).waitFor();

    // Status: hooks, self-test and replay are fine; the mock report is 60 hours old, so it's flagged first.
    const status = page.locator('.jev-page .health-item');
    await status.first().waitFor();
    assert.equal(await status.count(), 4);
    assert.match(await status.first().innerText(), /payoff report is out of date/);
    assert.ok(await status.first().evaluate(node => node.classList.contains('level-warn')));
    const statusText = await page.locator('.jev-page .health-list').innerText();
    assert.match(statusText, /4 Jev checks are switched on in Claude Code/);
    assert.match(statusText, /Self-test passed 73 of 73/);

    // Payoff: Jev's three answers plus its cost; the good/bad tone shows.
    const answers = page.locator('.jev-answers li');
    assert.equal(await answers.count(), 4);
    assert.match(await answers.nth(0).innerText(), /Saved Claude tokens\?/);
    assert.ok(await answers.nth(0).evaluate(node => node.classList.contains('tone-bad')));
    assert.match(await answers.nth(3).innerText(), /\$0\.05 in fees · 142 ms added to each check/);
    assert.match(await page.locator('.jev-alerts').innerText(), /blocked as unreadable/);
    assert.equal(await page.locator('.jev-answers summary').first().innerText(), 'Details');

    // Interventions: newest first, readable wording, project shown where known, counts by kind.
    const items = page.locator('.jev-interventions li');
    assert.equal(await items.count(), 4);
    assert.match(await items.nth(0).innerText(), /Sent back a "done" claim that wasn't verified/);
    assert.match(await items.nth(2).innerText(), /Blocked.*a remote patch that broke a rule.*Crestbid/s);
    assert.match(await items.nth(3).innerText(), /Stopped a compaction loop.*3 compactions in 15 minutes/s);
    assert.match(await page.locator('.jev-counts').innerText(), /1 sent back.*1 blocked.*1 guarded.*1 loop stopped/s);

    // Refresh brings the report up to date, so its warning clears.
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.jev-page .health-list')?.textContent?.includes('out of date'));
    assert.match(await page.locator('.jev-page .health-list').innerText(), /Payoff report updated .+ ago/);
    assert.equal(await page.locator('.jev-page .health-item.level-warn, .jev-page .health-item.level-fail').count(), 0);

    assert.deepEqual(errors, []);
    console.log('jev-page-ui: ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
