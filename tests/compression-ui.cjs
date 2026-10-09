const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Compression page and Home chip against the browser mock: off by default, the switch turns it on,
// the savings dashboard renders, app routing choices stick, and Home links back to the page.
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
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    await page.locator('.home-status').waitFor();

    // Off: no chip on Home, and the page is reachable from Advanced tools.
    assert.equal(await page.locator('.home-status-compression').count(), 0, 'chip hidden while compression is off');
    await page.locator('.personal-advanced summary').click();
    await page.getByRole('button', { name: 'Compression', exact: true }).click();
    await page.locator('.compression-page').waitFor();
    const toggle = page.getByRole('switch', { name: 'Compress context' });
    assert.equal(await toggle.isChecked(), false);
    // The page reads "Starting…" until its first status check returns.
    await page.locator('.compression-state').filter({ hasText: /Off/ }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.compression-metric').count(), 0, 'no stats while off');

    // On: state, four totals, a 14-day chart and the tables.
    await toggle.click();
    await page.locator('.compression-metric').first().waitFor();
    assert.match(await page.locator('.compression-state').innerText(), /On · port 8787/);
    assert.equal(await page.locator('.compression-metric').count(), 4);
    assert.equal(await page.locator('.compression-metric strong').first().innerText(), '1.5M');
    assert.equal(await page.locator('.compression-bar').count(), 14);
    assert.ok(await page.getByRole('cell', { name: 'claude-opus-4-6' }).first().isVisible());
    assert.ok(await page.getByRole('cell', { name: 'Claude Desktop' }).isVisible());
    assert.equal(await page.getByRole('cell', { name: /passthrough/ }).count(), 0, 'pass-through calls are not listed');

    // Routing choices round-trip through the backend.
    const desktop = page.getByRole('checkbox', { name: 'Claude Desktop' });
    assert.equal(await desktop.isChecked(), true);
    await desktop.click();
    await page.waitForFunction(() => !document.querySelectorAll('.compression-apps input')[1].checked);
    assert.equal(await page.getByRole('checkbox', { name: 'Claude Code' }).isChecked(), true);

    // Home shows the chip while on, and it opens the page.
    await page.getByRole('button', { name: /^Overview/ }).first().click();
    const chip = page.locator('.home-status-compression');
    await chip.waitFor();
    assert.match(await chip.innerText(), /Compression · 1\.5M saved/);
    await chip.click();
    await page.locator('.compression-page').waitFor();

    // Memory is opt-in and starts off.
    const memory = page.getByRole('switch', { name: /Memory across sessions/ });
    assert.equal(await memory.isChecked(), false);
    await memory.click();
    await page.waitForFunction(() => document.querySelector('.compression-memory input').checked);

    // Learnings: analyze needs a folder, previews CLAUDE.local.md, and writes once.
    const learn = page.locator('.compression-learn');
    const analyze = learn.getByRole('button', { name: 'Analyze' });
    assert.equal(await analyze.isDisabled(), true, 'analyze waits for a folder');
    await learn.getByLabel('Project folder').fill('C:/Projects/demo');
    await analyze.click();
    await learn.getByText('Will write C:/Projects/demo/CLAUDE.local.md').waitFor();
    assert.match(await learn.locator('pre').innerText(), /Headroom Learned Patterns/);
    const write = learn.getByRole('button', { name: 'Write CLAUDE.local.md' });
    await write.click();
    await page.waitForFunction(() => document.querySelector('.compression-learn-proposal button').disabled);

    // Off again: the dashboard goes away.
    await page.getByRole('switch', { name: 'Compress context' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.compression-metric').length === 0);

    // Turning it off through the switch stops the service, so there's nothing to stop.
    assert.equal(await page.locator('.compression-stray').count(), 0, 'no stop prompt once the service is down');

    // Off but still running (e.g. left behind for open sessions): offer to stop it, and only then.
    const stray = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    stray.on('pageerror', error => errors.push(String(error)));
    await stray.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'compression');
    });
    await stray.goto(`${base}/?mock=running&mockDelay=5&mockHeadroom=stray`, { timeout: 60000 });
    const prompt = stray.locator('.compression-stray');
    await prompt.waitFor({ timeout: 15000 });
    assert.equal(await stray.getByRole('switch', { name: 'Compress context' }).isChecked(), false);
    assert.match(await prompt.innerText(), /still running/);
    await prompt.getByRole('button', { name: 'Stop service' }).click();
    await prompt.waitFor({ state: 'detached' });
    assert.match(await stray.locator('.compression-state').innerText(), /Off/);

    assert.deepEqual(errors, []);
    console.log('compression-ui passed');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
