const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Activity → Conversations tells the story of recent requests: cost, cache savings, conversations with plain-words
// failures and "why this account", a cost split, a when-you-use-AI heatmap and search. Account cards gain a colour,
// a group, seven-day health bars, and the alternatives panel names the best one to switch to.
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
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'usage-records');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`);

    await page.getByRole('tab', { name: 'Conversations' }).click();
    const feed = page.locator('.activity-feed');
    await feed.waitFor();
    assert.match(await feed.locator('.af-summary').innerText(), /Estimated cost\s*\$\d/);
    assert.match(await feed.locator('.af-summary').innerText(), /Saved by the cache\s*\$\d/);
    const cards = feed.locator('.af-card');
    assert.ok(await cards.count() > 3, 'requests are grouped into conversation cards');
    // A failure reads as its cause in plain words.
    assert.match(await feed.locator('.af-failure').first().innerText(), /^(Rate limited or out of quota|Sign-in expired or revoked)/);
    // The cost chart has a bar with a direct label, and splits by account or model on request.
    assert.ok(await feed.locator('.af-bar').count() >= 1);
    assert.ok(await feed.locator('.af-parts li').count() >= 1);
    await feed.getByRole('button', { name: 'Model', exact: true }).click();
    assert.equal(await feed.getByRole('button', { name: 'Model', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.ok(await feed.locator('.af-bar-stack > span').first().evaluate(node => node.getBoundingClientRect().height > 10), 'bar segments fill the bar');
    assert.equal(await feed.locator('.af-heat-row').count(), 7);
    // Search narrows the conversations; "failed" finds only the ones with failures.
    const all = await cards.count();
    await feed.getByRole('searchbox').fill('failed');
    await page.waitForTimeout(100);
    const failedOnly = await cards.count();
    assert.ok(failedOnly > 0 && failedOnly < all, `search narrows ${all} to ${failedOnly}`);
    assert.equal(await feed.locator('.af-card:not(.has-failures)').count(), 0);
    // A conversation's requests open in place.
    await cards.first().getByRole('button', { name: 'Show requests' }).click();
    assert.ok(await cards.first().locator('.af-requests li').count() >= 1);

    // Overview: a colour and group per account, seven-day health, and a ranked alternative.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'home' })));
    const card = page.locator('.ad-card').first();
    await card.waitFor();
    assert.equal(await card.locator('.ad-row > .account-avatar').count(), 1);
    await card.locator('.ad-account-details > summary').click();
    await card.locator('.account-health-bars').waitFor();
    assert.equal(await card.locator('.account-health-day').count(), 7);
    const ring = () => card.locator('.ad-row > .account-avatar').evaluate(node => getComputedStyle(node).getPropertyValue('--account-color').trim());
    await card.getByRole('button', { name: /^Use rose for / }).click();
    assert.equal(await ring(), '#c23a5e');
    await card.getByLabel('Group').fill('Work');
    await card.getByLabel('Group').press('Enter');
    await page.locator('.ad-display-options > summary').click();
    await page.getByLabel('Group accounts by').selectOption('purpose');
    assert.ok((await page.locator('.quota-group-heading').allInnerTexts()).some(text => text.startsWith('Work')));
    const saved = await page.evaluate(() => [JSON.parse(localStorage.getItem('personal.accountColors')), JSON.parse(localStorage.getItem('personal.accountGroups'))]);
    assert.deepEqual(Object.values(saved[0]), ['#c23a5e']);
    assert.deepEqual(Object.values(saved[1]), ['Work']);

    await page.locator('.quota-compare').click();
    const best = page.locator('.ux-best');
    assert.match(await best.innerText(), /^Best alternative: .+ has \d+% left\./);
    await best.getByRole('button', { name: 'Use it first for an hour' }).click();
    await page.locator('.ad-focus').waitFor();

    assert.deepEqual(errors, []);
    console.log('PASS: Conversations tells the story of recent requests, and accounts have colours, groups, health and a best alternative.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
