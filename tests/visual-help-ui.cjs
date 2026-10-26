const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Visual identity and help: warm ink-on-paper neutrals with one teal accent in both themes, numbers in tabular
// figures, Ask the hub from the palette answering through the user's own proxy, and the morning summary as an
// alert kind that is off until asked for.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'home'); });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    await page.locator('.ad-card').first().waitFor();

    // Warm neutrals: the canvas and text lean red-yellow (more red than blue); the accent stays teal (more green than red).
    const colours = () => page.evaluate(() => {
      const rgb = value => { const probe = document.createElement('div'); probe.style.color = value; document.body.append(probe);
        const parsed = getComputedStyle(probe).color.match(/\d+/g).map(Number); probe.remove(); return parsed; };
      const root = getComputedStyle(document.documentElement);
      return { canvas: rgb(root.getPropertyValue('--bg-secondary')), text: rgb(root.getPropertyValue('--text-primary')), accent: rgb(root.getPropertyValue('--primary-color')) };
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const { canvas, text, accent } = await colours();
      assert.ok(canvas[0] > canvas[2] && text[0] > text[2], `${theme}: warm neutrals ${JSON.stringify({ canvas, text })}`);
      assert.ok(accent[1] > accent[0], `${theme}: one teal accent ${JSON.stringify(accent)}`);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    assert.equal(await page.locator('.ad-row').first().evaluate(node => getComputedStyle(node).fontVariantNumeric), 'tabular-nums');

    // Ask the hub: from the palette, through the user's own proxy, with the model named.
    await page.evaluate(() => { window.__mockCalls = []; });
    await page.locator('.sidebar-command-button').click();
    const palette = page.getByRole('dialog', { name: /command/i });
    await palette.locator('#palette-ask-hub').click();
    const ask = page.getByRole('dialog', { name: 'Ask the hub' });
    await ask.waitFor();
    assert.match(await ask.locator('.ask-hub-hint').innerText(), /never keys, emails or your prompts/);
    await ask.getByLabel('Your question').fill('Why is Claude using my second account?');
    await ask.getByRole('button', { name: 'Ask', exact: true }).click();
    await ask.locator('.ask-hub-answer').waitFor();
    assert.match(await ask.locator('.ask-hub-answer p').innerText(), /^Demo: Claude is on your second account/);
    assert.match(await ask.locator('.ask-hub-answer small').innerText(), /^Answered by .+ through your hub\.$/);
    assert.ok((await page.evaluate(() => window.__mockCalls)).includes('ask_plugin_finder'), 'asked through the local proxy command');
    await page.keyboard.press('Escape');
    await ask.waitFor({ state: 'detached' });

    // The morning summary is an alert kind, off until asked for.
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('personal.alertKinds') ?? '{}').digest ?? null), null);
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-software').click();
    const desktopAlerts = page.getByRole('switch', { name: /Windows notifications|Desktop alerts/ }).first();
    if (await desktopAlerts.count() && !(await desktopAlerts.isChecked())) await desktopAlerts.click();
    const digest = page.getByRole('checkbox', { name: 'Morning summary (once a day, from 8am)' });
    await digest.waitFor();
    assert.equal(await digest.isChecked(), false, 'off until asked for');

    assert.deepEqual(errors, []);
    console.log('PASS: warm neutrals with one accent in both themes, tabular numbers, Ask the hub through the proxy, and an opt-in morning summary.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
