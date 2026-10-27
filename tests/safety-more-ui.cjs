const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Secret Guard's finer controls and connector use: a finding can be always masked; each app can be made stricter
// (never looser) than its provider; the masked words around a finding show only when that's switched on, which it
// isn't by default; and each connector in use says when Claude Code last used it.
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
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem('personal.lastPage', 'secret-guard'); sessionStorage.setItem('seeded', '1'); }
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });

    await page.getByText('Off. Prompts go out without being checked.').waitFor();
    await page.getByRole('switch', { name: 'Check outgoing prompts' }).click();
    await page.getByText(/On\. Every request is checked/).waitFor();
    const findings = page.locator('.sg-finding');
    await findings.first().waitFor();

    // The masked words around a finding, where the plugin logged them, and which apps sent it.
    const database = findings.filter({ hasText: 'database password' }).first();
    assert.match(await database.locator('.sg-context').innerText(), /^Around it: …migrate with DATABASE_URL=postgres:\/\/app:\[connection_string_password\]@/);
    assert.match(await database.locator('.sg-finding-meta').first().innerText(), /Claude Desktop, Codex/);
    assert.equal(await findings.filter({ hasText: 'GitHub' }).first().locator('.sg-context').count(), 0, 'nothing shown where nothing was logged');

    // Always mask: on a finding, then shown on it, and undone the same way.
    const github = findings.filter({ hasText: 'GitHub' }).first();
    await github.getByRole('button', { name: 'Always mask', exact: true }).click();
    await github.locator('.sg-action-always').waitFor();
    assert.equal(await github.getByRole('button', { name: 'Stop always masking' }).getAttribute('aria-pressed'), 'true');
    await github.getByRole('button', { name: 'Stop always masking' }).click();
    await github.locator('.sg-action-always').waitFor({ state: 'detached' });

    // By app: same as the provider unless set, and Off isn't offered because an app can't loosen its provider.
    const codex = page.getByRole('combobox', { name: 'Codex', exact: true });
    assert.equal(await codex.inputValue(), '');
    assert.deepEqual(await codex.locator('option').evaluateAll(options => options.map(option => option.value)), ['', 'report', 'redact', 'block']);
    await codex.selectOption('redact');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Codex"]')?.value === 'redact' && !document.querySelector('select[aria-label="Codex"]').disabled);
    for (const name of ['Claude Code', 'Claude Desktop', 'OpenCode']) await page.getByRole('combobox', { name, exact: true }).waitFor();

    // Context: off by default, and it says what turning it on writes.
    const context = page.getByRole('switch', { name: 'Show the words around each finding' });
    assert.equal(await context.isChecked(), false, 'off by default');
    assert.match(await page.locator('.sg-context-switch + .jev-subtitle').innerText(), /Off by default\. .*every secret in them masked/);
    await context.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Show the words around each finding"]')?.checked === true);

    // Connectors: when Claude Code last used each one in use.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'connectors' })));
    await page.locator('.connector-row-toggle').first().waitFor();
    const card = name => page.locator('.connector-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await card('Firecrawl').locator('.connector-row-toggle').click();
    const used = card('Firecrawl').locator('.connector-last-used');
    await used.waitFor();
    assert.match(await used.innerText(), /^Last used in Claude Code .*6.* ago\.$/);
    assert.match(await used.getAttribute('title'), /only tool names and times, never what was said/);
    // On in Claude Code but never used there; one on only for Claude Desktop still shows its use from the desktop
    // app's Code tab, which runs Claude Code with Claude Desktop's connectors; and one not in use says nothing.
    await card('Google (personal)').locator('.connector-row-toggle').click();
    assert.equal(await card('Google (personal)').locator('.connector-last-used').innerText(), 'Not used in Claude Code in the last 90 days.');
    await card('GitHub').locator('.connector-row-toggle').click();
    await card('Browser (Playwright)').locator('.connector-row-toggle').click();
    assert.match(await card('Browser (Playwright)').locator('.connector-last-used').innerText(), /^Last used in Claude Code .*2.* ago\.$/);
    assert.equal(await card('GitHub').locator('.connector-last-used').count(), 0);

    assert.deepEqual(errors, []);
    console.log('PASS: always-mask per finding, per-app modes that only tighten, masked context off by default, and connector last use from Claude Code.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
