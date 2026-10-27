const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// First-run setup: four steps read from the hub's real state with one next action at a time, a "you're set up"
// moment for someone who watched it get there, quiet for a hub that was already set up, and back from the palette.
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
    const open = async (query) => {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'home'); });
      await page.goto(`${base}/?${query}&mockDelay=5`, { timeout: 60000 });
      return page;
    };
    const fromPalette = async (page, id) => {
      await page.locator('.sidebar-command-button').click();
      await page.getByRole('dialog', { name: /command/i }).locator(`#palette-${id}`).click();
    };

    // A new install: the hub is running and nothing else, so the next step is adding an account.
    const fresh = await open('mock=running&mockFresh=all');
    const card = fresh.locator('section.first-run');
    await card.waitFor();
    await fresh.waitForFunction(() => document.querySelector('.first-run-lights')?.getAttribute('aria-valuenow') === '1');
    assert.equal(await card.locator('.first-run-lights-label').innerText(), '1 of 4 done');
    assert.match(await card.locator('li.done').innerText(), /Start the hub\s+Running on this computer\./);
    const current = card.locator('li[aria-current="step"]');
    assert.match(await current.locator('.first-run-text').innerText(), /^Add an AI account\s+The hub spends subscriptions/);
    assert.equal(await card.locator('li button').count(), 1, 'one next action at a time');
    assert.match(await card.locator('li.later').first().innerText(), /After the step above\./);

    // Hidden stays hidden, and comes back from the palette.
    await card.getByRole('button', { name: 'Hide for now' }).click();
    await card.waitFor({ state: 'detached' });
    await fresh.reload();
    await fresh.locator('.ad-card, .first-run, .home-status').first().waitFor();
    await fresh.waitForTimeout(500);
    assert.equal(await fresh.locator('section.first-run').count(), 0, 'still hidden after a reload');
    await fromPalette(fresh, 'show-setup');
    await card.waitFor();
    await current.getByRole('button', { name: 'Add an account' }).click();
    await fresh.getByRole('heading', { level: 1, name: 'Accounts' }).waitFor();
    await fresh.close();

    // Set up but no request yet: the test request ticks off the last step, then the "you're set up" moment.
    const almost = await open('mock=running&mockFresh=request');
    const almostCard = almost.locator('section.first-run');
    await almost.waitForFunction(() => document.querySelector('.first-run-lights')?.getAttribute('aria-valuenow') === '3');
    assert.match(await almostCard.locator('li.done').nth(2).innerText(), /Point an app at the hub\s+Connected: .+ and \d+ more\./);
    const last = almostCard.locator('li[aria-current="step"]');
    assert.match(await last.innerText(), /Or just use your app/);
    await last.getByRole('button', { name: 'Send a test request' }).click();
    await almost.getByRole('heading', { name: "You're set up" }).waitFor();
    assert.equal(await almostCard.locator('.first-run-lights').getAttribute('aria-valuenow'), '4');
    assert.ok(await almost.evaluate(() => JSON.parse(localStorage.getItem('personal.setupTestPassed') ?? 'null')?.model), 'the test is remembered');
    await almostCard.getByRole('button', { name: 'Choose which account is spent first' }).click();
    await almost.locator('#config-subpage-tab-routing[aria-selected="true"]').waitFor();
    assert.equal(await almost.evaluate(() => localStorage.getItem('personal.setupChecklist')), 'done');
    await almost.close();

    // Already set up when it opened: no steps and no moment, closed for good.
    const existing = await open('mock=running');
    await existing.locator('.ad-card').first().waitFor();
    await existing.waitForFunction(() => localStorage.getItem('personal.setupChecklist') === 'done');
    assert.equal(await existing.locator('section.first-run').count(), 0);
    // Asked for anyway: the finished card, with what to do next.
    await fromPalette(existing, 'show-setup');
    await existing.getByRole('heading', { name: "You're set up" }).waitFor();
    await existing.getByRole('button', { name: 'Done', exact: true }).click();
    await existing.locator('section.first-run').waitFor({ state: 'detached' });
    await existing.close();

    assert.deepEqual(errors, []);
    console.log('PASS: four steps from the hub\'s state with one next action, hide and bring back, a test request to finish, "you\'re set up" only when watched, quiet when already set up.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
