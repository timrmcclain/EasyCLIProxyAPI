const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: the Overview warns when a connected app no longer matches the hub and
// Re-apply fixes it; Settings → Keys replaces the key for every app and then removes the old one;
// the Windows notifications switch exists and defaults on; provider cards show a run-out forecast.
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

    // Drift: Claude Code still points at the hub but with an old key.
    await page.goto(`${base}/?mock=running&mockDrift=claude-code`, { timeout: 60000 });
    const banner = page.locator('.app-drift-banner');
    await banner.waitFor();
    assert.match(await banner.innerText(), /Claude Code no longer matches the hub/);
    // Health check lists the drifted app first, as a failure, and Fix opens Connected apps.
    await page.locator('.personal-advanced summary').click();
    await page.getByRole('button', { name: 'Health check', exact: true }).click();
    const firstCheck = page.locator('.health-item').first();
    await firstCheck.waitFor();
    assert.equal(await firstCheck.getAttribute('class'), 'health-item level-fail');
    assert.match(await firstCheck.innerText(), /Claude Code no longer matches the hub/);
    assert.ok(await page.locator('.health-item.level-ok').filter({ hasText: 'The proxy is running.' }).count());
    await firstCheck.getByRole('button', { name: 'Fix' }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('personal.lastPage')), 'agents');
    await page.locator('.nav-section').getByRole('button', { name: /^Overview/ }).first().click();
    await banner.waitFor();
    await banner.getByRole('button', { name: 'Re-apply', exact: true }).click();
    await banner.waitFor({ state: 'detached' });

    // Tray: the background watcher sends a per-provider summary for the tray menu and tooltip.
    await page.waitForFunction(() => window.__mockTray, null, { timeout: 20000 });
    const tray = await page.evaluate(() => window.__mockTray);
    assert.match(tray.menuText, /^Quota: .*(ok|low|out)/);
    assert.ok(tray.tooltipText.length > 0 && !tray.tooltipText.startsWith('Quota:'));
    // The same line is written for the Claude Code status line wrapper.
    assert.equal(await page.evaluate(() => window.__mockQuotaLine), tray.menuText);

    // Forecast: give every account a falling series ending at its current reading, then reload.
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('personal.quotaHistory') || '{}')).length > 0, null, { timeout: 20000 });
    await page.evaluate(() => {
      const history = JSON.parse(localStorage.getItem('personal.quotaHistory'));
      const now = Date.now();
      for (const key of Object.keys(history)) {
        const last = history[key][history[key].length - 1];
        history[key] = [
          { ...last, at: now - 60 * 60_000, percent: Math.min(100, last.percent + 30) },
          { ...last, at: now - 30 * 60_000, percent: Math.min(100, last.percent + 15) },
          { ...last, at: now - 60_000 },
        ];
      }
      localStorage.setItem('personal.quotaHistory', JSON.stringify(history));
    });
    await page.reload();
    await page.locator('.quota-summary-forecast').first().waitFor({ timeout: 20000 });
    assert.match(await page.locator('.quota-summary-forecast').first().innerText(), /^Runs out in about .+ at this pace$/);

    // Runway & resets: with pace data, providers get a verdict; the soonest partly used windows are listed.
    const runway = page.locator('.glance-runway');
    const verdicts = await runway.locator('.glance-runway-verdict').allInnerTexts();
    assert.ok(verdicts.length > 0 && verdicts.length <= 5, 'the five worst providers');
    if (verdicts.length === 5) assert.match(await runway.locator('.glance-runway-more').innerText(), /^and \d+ more$/);
    assert.ok(verdicts.some(text => /^(Out in about .+|Lasts until reset)$/.test(text)), `a provider has a measured runway: ${verdicts.join(' | ')}`);
    const resetTimes = await runway.locator('.glance-runway-resets time').evaluateAll(nodes => nodes.map(node => Date.parse(node.getAttribute('datetime'))));
    assert.ok(resetTimes.length > 0 && resetTimes.length <= 2, 'up to two resets');
    assert.deepEqual(resetTimes, [...resetTimes].sort((a, b) => a - b), 'soonest first');

    // Key rotation: the new key goes first, apps are re-applied, the old key waits to be removed.
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-panel').waitFor();
    const keyRows = page.locator('#config-native-keys .config-key-row:not(.skeleton)');
    await keyRows.first().waitFor();
    const keysBefore = await keyRows.count();
    const firstBefore = await keyRows.first().locator('code').innerText();
    await page.getByRole('button', { name: 'Replace key for all apps', exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByRole('button', { name: 'Replace key', exact: true }).click();
    await page.locator('.config-rotation-pending').waitFor();
    assert.equal(await keyRows.count(), keysBefore + 1, 'a key was added');
    assert.match(await keyRows.first().innerText(), /Replacement key/);
    assert.notEqual(await keyRows.first().locator('code').innerText(), firstBefore, 'the new key is first');
    assert.equal(await page.locator('.config-rotation-pending strong').innerText(), firstBefore, 'the old key waits for removal');
    await page.getByText(/New key in use\. Re-applied: .*Claude Code/).first().waitFor();

    await page.getByRole('button', { name: 'Remove old key', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('.config-rotation-pending').waitFor({ state: 'detached' });
    assert.equal(await keyRows.count(), keysBefore, 'the old key was removed');

    // Windows notifications: on by default, remembered when switched off.
    await page.locator('#config-subpage-tab-software').click();
    const notifications = page.getByRole('switch', { name: 'Windows notifications' });
    assert.equal(await notifications.isChecked(), true);
    await notifications.click();
    assert.equal(await page.evaluate(() => localStorage.getItem('personal.desktopAlerts')), 'false');

    // Claude Code status line: off by default, switches on and back off through Undo.
    const statusLine = page.getByRole('switch', { name: "Quota in Claude Code's status line" });
    assert.equal(await statusLine.isChecked(), false);
    await statusLine.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label^="Quota in Claude"]')?.checked === true);
    await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label^="Quota in Claude"]')?.checked === false);

    assert.deepEqual(errors, []);
    console.log('drift-rotation-ui: ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
