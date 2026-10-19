const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// "Use my GitHub sign-in" on Connectors, against a fake GitHub CLI: success saves the token on the hub's side and
// marks the sign-in settings configured; a missing or signed-out CLI says what to run, and nothing is saved.
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
    const open = async (preset) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript((outcome) => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', 'connectors');
        if (outcome) globalThis.mockGitHubCliSetup = outcome;
        window.invoked = [];
        const timer = setInterval(() => {
          const internals = window.__TAURI_INTERNALS__;
          if (!internals?.invoke || internals.invoke.recording) return;
          const original = internals.invoke;
          internals.invoke = async (command, args, ...rest) => { window.invoked.push({ command, args }); return original(command, args, ...rest); };
          internals.invoke.recording = true;
          clearInterval(timer);
        }, 5);
      }, preset);
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      const row = page.locator('.connector-row-toggle').filter({ hasText: /^GitHub/ });
      await row.waitFor();
      if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
      const card = page.locator('.connector-github-setup');
      await card.waitFor();
      return { page, card };
    };

    // Success: the hub reads gh's token itself, so the page only sends which apps and access level.
    {
      const { page, card } = await open(null);
      assert.match(await card.innerText(), /Reads the token from the GitHub CLI \(gh\)/);
      await card.getByRole('button', { name: 'Use my GitHub sign-in' }).click();
      await card.getByText('Saved. Restart Claude Code or Claude Desktop to use it.').waitFor();
      const call = await page.evaluate(() => window.invoked.find(entry => entry.command === 'github_cli_setup')?.args.request);
      assert.deepEqual(Object.keys(call).sort(), ['access', 'claudeCode', 'claudeDesktop']);
      const githubCard = page.locator('.connector-card.is-open').filter({ has: page.locator('.connector-github-setup') });
      await githubCard.locator('.connector-secrets-status', { hasText: 'Configured' }).waitFor();
      assert.equal(await page.evaluate(() => window.invoked.some(entry => entry.command === 'apply_connector_change')), false);
      await page.close();
    }

    // Problems say what to do and save nothing.
    for (const [outcome, text] of [
      [{ status: 'missingCli' }, /The GitHub CLI isn['’]t installed\. Install it \(winget install GitHub\.cli\)/],
      [{ status: 'notSignedIn' }, /Run gh auth login in a terminal/],
      [{ status: 'failed', message: 'The GitHub CLI didn’t answer in time.' }, /Couldn['’]t use the GitHub sign-in: The GitHub CLI didn’t answer in time\./],
    ]) {
      const { page, card } = await open(outcome);
      await card.getByRole('button', { name: 'Use my GitHub sign-in' }).click();
      await card.getByText(text).waitFor();
      const githubCard = page.locator('.connector-card.is-open').filter({ has: page.locator('.connector-github-setup') });
      await githubCard.locator('.connector-secrets-status', { hasText: 'Not set' }).waitFor();
      await page.close();
    }

    assert.deepEqual(errors, []);
    console.log('PASS: "Use my GitHub sign-in" saves the GitHub CLI token on the hub side and explains every other outcome.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
