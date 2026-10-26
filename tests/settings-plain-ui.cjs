const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Settings in plain words: each tab opens with what it's for and how it is set now; Expert mode opens every
// advanced section and the expert-only groups; Save as I go saves settings-only tabs a moment after a change
// and offers Undo, while tabs that restart the hub still wait for Save all.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'config');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });

    // Service & access: purpose, then the saved address and who can reach it.
    const summary = page.locator('.config-tab-summary');
    await page.locator('#config-native-keys .config-key-row:not(.skeleton)').first().waitFor();
    assert.equal(await summary.locator('.config-tab-purpose').innerText(), 'How your apps reach the hub, and who else can.');
    await page.waitForFunction(() => /Apps reach the hub at https?:\/\/[^ ]+:\d+ with \d+ keys?\./.test(document.querySelector('.config-tab-summary')?.textContent ?? ''));
    assert.match(await summary.innerText(), /(Only this computer can reach it|Other devices on your network can reach it too)\./);

    // Routing & reliability: retries and cooldowns as sentences.
    await page.locator('#config-subpage-tab-routing').click();
    await page.waitForFunction(() => /A failed request (is retried up to \d+ times?|is not retried)/.test(document.querySelector('.config-tab-summary')?.textContent ?? ''));
    assert.match(await summary.innerText(), /An account that hits a rate limit (rests before it is used again|is used again straight away)\./);

    // Expert mode: advanced sections open, and the remembered choice survives a reload.
    const advanced = page.locator('#config-native-retry details.config-advanced-details').first();
    assert.equal(await advanced.evaluate(node => node.open), false);
    await page.getByRole('switch', { name: 'Expert mode' }).check();
    assert.equal(await advanced.evaluate(node => node.open), true, 'expert mode opens advanced sections');
    await page.locator('#config-subpage-tab-oauth').click();
    assert.equal(await page.locator('#config-template-panel').isHidden(), false, 'expert-only upstream groups are shown');
    await page.reload();
    await page.locator('#config-subpage-tab-routing').click();
    assert.equal(await page.getByRole('switch', { name: 'Expert mode' }).isChecked(), true);
    assert.equal(await page.locator('#config-native-retry details.config-advanced-details').first().evaluate(node => node.open), true);

    // Save as I go: a routing change saves by itself, says so, and Undo puts back the version before it.
    await page.getByRole('switch', { name: 'Save as I go' }).check();
    await page.waitForFunction(() => !document.querySelector('#config-native-retry [role="switch"]:disabled'));
    await page.evaluate(() => { window.__mockCalls = []; });
    const cooldown = page.locator('#config-native-retry').getByRole('switch', { name: 'Cooldown after rate limits' });
    await cooldown.click();
    const status = page.locator('.config-autosave-status');
    await status.getByText(/^Saved /).waitFor();
    await page.locator('.config-save-bar').waitFor({ state: 'detached' });
    assert.ok((await page.evaluate(() => window.__mockCalls)).includes('save_retry_settings'), 'the change was saved');
    await status.getByRole('button', { name: 'Undo' }).click();
    await status.getByText(/^Put back the settings from before /).waitFor();
    assert.ok((await page.evaluate(() => window.__mockCalls)).includes('restore_core_config_history'), 'Undo restores the earlier config');

    // Service & access restarts the hub when saved, so it says it waits for Save all.
    await page.locator('#config-subpage-tab-general').click();
    assert.match(await summary.locator('.config-tab-autosave-note').innerText(), /waits for Save all/);

    assert.deepEqual(errors, []);
    console.log('PASS: Settings tabs explain themselves in sentences, Expert mode opens advanced sections, and Save as I go saves with Undo.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
