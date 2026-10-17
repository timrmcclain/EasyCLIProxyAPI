const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Signing in again to an account you already have: the hub offers to replace the older file, with Undo.
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

    // Each run starts a fresh mock, signs in to Codex again, and clicks Replace old file.
    const signInAgainAndReplace = async () => {
      const page = await browser.newPage({ viewport: { width: 1505, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      await page.locator('.app-shell').waitFor();
      await page.locator('.nav-section').getByRole('button', { name: 'Accounts', exact: true }).click();
      const files = page.locator('.auth-file-card');
      const card = name => files.filter({ has: page.locator(`.auth-card-filename[title="${name}"]`) });
      await card('codex-personal.json').waitFor();
      const before = await files.count();
      await page.locator('.auth-files-heading-actions').getByRole('button', { name: 'Add account', exact: true }).click();
      await page.locator('[data-oauth-provider="codex"] .oauth-start-button').click();
      const notice = page.locator('.app-notice-entry').filter({ hasText: 'already had 1 older file;' });
      await notice.waitFor();
      assert.match(await notice.innerText(), /takes over its place in routing/);
      await notice.getByRole('button', { name: 'Replace old file', exact: true }).click();
      const replaced = page.locator('.app-notice-entry').filter({ hasText: 'Replaced 1 older file.' });
      await replaced.waitFor();
      return { page, files, card, before, replaced };
    };

    {
      const { page, files, card, before } = await signInAgainAndReplace();
      await page.getByRole('button', { name: 'Back to accounts', exact: true }).click();
      await card('codex-mock-login.json').waitFor();
      assert.equal(await card('codex-personal.json').count(), 0, 'the older file was replaced');
      assert.equal(await files.count(), before, 'one file for the account, not two');
      await page.close();
    }
    {
      const { page, files, card, before, replaced } = await signInAgainAndReplace();
      await replaced.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.locator('.app-notice-entry').filter({ hasText: 'Older file restored.' }).waitFor();
      await page.getByRole('button', { name: 'Back to accounts', exact: true }).click();
      await card('codex-mock-login.json').waitFor();
      await card('codex-personal.json').waitFor();
      assert.equal(await files.count(), before + 1, 'after Undo, both files are back');
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: signing in again offers to replace the older file, and Undo restores it.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
