const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Secret Guard page: switching it on installs the plugin and writes its config through the
// management API; findings can be marked rotated or safe; the policy writes per-provider modes.
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
      localStorage.setItem('personal.lastPage', 'secret-guard');
    });
    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.getByRole('heading', { name: 'Secret Guard', level: 1 }).waitFor();

    // It's in the main navigation, not buried under Advanced tools.
    assert.ok(await page.locator('nav').getByRole('button', { name: /Secret Guard/ }).first().isVisible(), 'nav entry is visible');

    // Starts off; switching on installs the plugin and writes its config.
    const toggle = page.getByRole('switch', { name: 'Check outgoing prompts' });
    await page.getByText('Off. Prompts go out without being checked.').waitFor();
    assert.equal(await toggle.isChecked(), false);
    await page.evaluate(() => { window.__mockCalls = []; });
    await toggle.check();
    await page.getByText(/On\. Every request is checked/).waitFor();
    await page.getByText(/Report only: nothing is changed or blocked/).waitFor();
    const calls = await page.evaluate(() => window.__mockCalls);
    assert.ok(calls.includes('secret_guard_install'), `installs the plugin: ${calls.join(', ')}`);
    assert.ok(calls.some(call => call === 'management_request /config/plugins/configs/secret-guard'), 'writes the plugin config');
    const config = await page.evaluate(async () => {
      return window.__TAURI_INTERNALS__.invoke('management_request', { request: { method: 'GET', path: '/config/plugins/configs/secret-guard' } });
    });
    assert.equal(config.enabled, true);
    assert.equal(config.default_mode, 'report', 'starts in report mode');
    assert.match(config.salt, /^[0-9a-f]{32}$/, 'a random salt is generated');
    assert.match(config.findings_file, /secret-guard\/findings\.jsonl$/);

    // Findings: newest first, with the app and provider in plain words, and advice.
    const items = page.locator('.sg-finding');
    assert.equal(await items.count(), 3);
    await page.getByText('GitHub token').first().waitFor();
    await page.getByText('Sent to Anthropic (Claude) by Claude Code').waitFor();
    await page.getByText('Sent to Anthropic (Claude), OpenAI (GPT, Codex) by Claude Desktop, Codex').waitFor();
    await page.getByText(/Revoke it in GitHub/).waitFor();
    assert.equal(await page.locator('#sg-findings-title .sg-count').textContent(), '3');

    // "I've rotated it" hides the finding until it's seen again; Undo brings it back.
    await items.first().getByRole('button', { name: "I've rotated it" }).click();
    await page.getByRole('button', { name: 'Show handled (1)' }).waitFor();
    assert.equal(await items.count(), 2);
    assert.equal(await page.locator('#sg-findings-title .sg-count').textContent(), '2');
    await page.getByRole('button', { name: 'Show handled (1)' }).click();
    const handled = page.locator('.sg-finding.handled');
    await handled.getByText('Rotated').waitFor();
    await handled.getByRole('button', { name: 'Undo' }).click();
    await page.locator('#sg-findings-title .sg-count').filter({ hasText: '3' }).waitFor();

    // "Mark as safe" adds the fingerprint to the plugin's allowlist.
    await items.filter({ hasText: 'AWS access key' }).getByRole('button', { name: 'Mark as safe' }).click();
    await page.locator('#sg-findings-title .sg-count').filter({ hasText: '2' }).waitFor();
    const allow = await page.evaluate(async () => {
      return (await window.__TAURI_INTERNALS__.invoke('management_request', { request: { method: 'GET', path: '/config/plugins/configs/secret-guard' } })).allow;
    });
    assert.deepEqual(allow, ['a09b33f2']);

    // Policy: choosing Block for xAI writes it and the status line drops "Report only".
    const xai = page.getByRole('combobox', { name: 'xAI (Grok)' });
    assert.equal(await xai.inputValue(), 'report');
    await xai.selectOption('block');
    await page.getByText(/On\. Every request is checked/).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes('Report only'));
    const modes = await page.evaluate(async () => {
      return (await window.__TAURI_INTERNALS__.invoke('management_request', { request: { method: 'GET', path: '/config/plugins/configs/secret-guard' } })).modes;
    });
    assert.equal(modes.xai, 'block');
    assert.equal(await xai.inputValue(), 'block');

    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

    // Overview shows a banner while findings are open, and Review comes back here.
    await page.locator('nav').getByRole('button', { name: /Overview/ }).first().click();
    const banner = page.locator('.sg-banner');
    await banner.getByText('Secret Guard found 2 credentials in prompts').waitFor();
    await banner.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('heading', { name: 'Secret Guard', level: 1 }).waitFor();

    // Switching off keeps the policy and findings.
    await toggle.uncheck();
    await page.getByText('Off. Prompts go out without being checked.').waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'xAI (Grok)' }).isDisabled(), true, 'policy is read-only while off');

    assert.deepEqual(errors, []);
    console.log('secret-guard: pass');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
