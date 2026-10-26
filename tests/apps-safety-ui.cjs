const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Apps, connectors and Safety: app lights and a test request, connectors split into in use and available with
// what each can reach and the last check remembered, the proxy key's age, Secret Guard severity with a weekly
// summary and a rotate link, and a "Try it" box for sensitive words.
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
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem('personal.lastPage', 'agents'); sessionStorage.setItem('seeded', '1'); }
    });
    const go = async name => {
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('app:navigate', { detail })), name);
    };
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });

    // AI apps: each installed app has a light that names its state.
    const lights = page.locator('.agent-client-list .agent-light');
    await lights.first().waitFor();
    const titles = await lights.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
    assert.ok(titles.every(title => /^(Working|Connected through the hub|Installed, not connected|Needs attention)/.test(title)), titles.join(' | '));
    // A connected app sends a real test request through the hub and says how it went.
    const testButton = page.getByRole('button', { name: 'Send a test request' });
    await testButton.click();
    await page.locator('.connection-test [role="status"]').waitFor();
    assert.match(await page.locator('.connection-test [role="status"]').innerText(), /^Sent a test request for .+ through the hub\. It worked in [\d.]+ s\.$/);

    // Connectors: in use first, then available; each says what it can reach; a check is remembered.
    await go('connectors');
    await page.locator('.connector-row-toggle').first().waitFor();
    assert.deepEqual(await page.locator('.connectors-section-heading').allInnerTexts(), ['IN USE', 'AVAILABLE']);
    assert.match(await page.locator('.connector-card').first().locator('.connector-trust').innerText(), /^(Runs on this PC|Reads your account|Cloud service|Can act on this PC)$/);
    assert.equal(await page.getByRole('button', { name: /Windows/ }).first().locator('.connector-trust').innerText(), 'Can act on this PC');
    const google = page.getByRole('button', { name: /Google/ }).first();
    await google.click();
    const googleCard = page.locator('.connector-card.is-open').first();
    await googleCard.getByRole('button', { name: 'Check connection' }).first().click();
    await googleCard.locator('.connector-test').first().waitFor();
    await page.reload();
    await page.locator('.connector-card.is-open .connector-last-test').waitFor();
    assert.match(await page.locator('.connector-card.is-open .connector-last-test').innerText(), /^Last test .+ ago: worked, 74 tools$/);

    // Settings: the key apps use shows how long the hub has seen it, and reminds after 90 days.
    await page.evaluate(() => localStorage.removeItem('personal.keyFirstSeen'));
    const settings = () => page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await settings();
    await page.locator('#config-native-keys .config-key-row:not(.skeleton)').first().waitFor();
    const age = page.locator('.config-key-age');
    await age.waitFor();
    assert.match(await age.innerText(), /^Apps have used this key to reach the hub since at least .+\.$/);
    await page.evaluate(() => {
      const seen = JSON.parse(localStorage.getItem('personal.keyFirstSeen'));
      for (const key of Object.keys(seen)) seen[key] = Date.now() - 120 * 86_400_000;
      localStorage.setItem('personal.keyFirstSeen', JSON.stringify(seen));
    });
    await page.locator('.nav-section').getByRole('button', { name: /^Overview/ }).first().click();
    await settings();
    await page.locator('.config-key-age strong').waitFor();
    assert.match(await page.locator('.config-key-age strong').innerText(), /more than 90 days; consider rotating it/);

    // Sensitive words: paste text and see which of the list's words it contains.
    await page.locator('#config-subpage-tab-requests').click();
    const words = page.locator('.config-sensitive-words-card').first();
    await words.locator('.config-sensitive-words-row input').first().waitFor();
    const firstWord = await words.locator('.config-sensitive-words-row input').first().inputValue();
    await words.locator('.config-sensitive-words-test > summary').click();
    const sample = words.locator('.config-sensitive-words-test textarea');
    await sample.fill(`Please mention ${firstWord.toUpperCase()} here.`);
    assert.equal(await words.locator('.config-sensitive-words-result').innerText(), `Found 1 (ignoring case): ${firstWord}`);
    await sample.fill('nothing relevant in this one');
    assert.equal(await words.locator('.config-sensitive-words-result').innerText(), 'None of these words appear in the text.');

    // Secret Guard: each finding has a severity, a rotate link where there is one, and the week is summed up.
    await go('secret-guard');
    await page.getByText('Off. Prompts go out without being checked.').waitFor();
    await page.getByRole('switch', { name: 'Check outgoing prompts' }).click();
    await page.getByText(/On\. Every request is checked/).waitFor();
    const findings = page.locator('.sg-finding');
    await findings.first().waitFor();
    assert.match(await page.locator('.sg-week').innerText(), /^Last 7 days: 3 secrets caught\s+2 stopped before reaching a provider\s+1 only reported\s+3 critical$/);
    const github = findings.filter({ hasText: 'GitHub' }).first();
    assert.equal(await github.locator('.sg-severity').innerText(), 'Critical');
    assert.match(await github.locator('.sg-severity-hint').innerText(), /^Can spend money or change code/);
    await page.evaluate(() => { window.__mockCalls = []; });
    await github.getByRole('button', { name: 'Open the page to rotate it' }).click();
    await page.waitForFunction(() => (window.__mockCalls || []).includes('open_external_url'));

    assert.deepEqual(errors, []);
    console.log('PASS: apps show lights and a test request; connectors are grouped with trust badges and remembered checks; keys show their age; Secret Guard ranks findings; sensitive words can be tried.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
