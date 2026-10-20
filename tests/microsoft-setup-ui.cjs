const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// One-click Microsoft 365 setup on Connectors, against a fake Microsoft: success saves the IDs and offers a
// Claude Desktop restart; the other outcomes explain what to do; a consent link outside Microsoft is never shown.
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
        if (outcome) globalThis.mockMicrosoftSetup = outcome;
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
      // Connectors are one-line rows until opened.
      const row = page.getByRole('button', { name: /Microsoft 365 \(work\)/ });
      await row.waitFor();
      if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
      const card = page.locator('.connector-auto-setup:not(.connector-github-setup)');
      await card.waitFor();
      return { page, card };
    };

    // Success: the IDs are saved for Claude Desktop and a restart is one click.
    {
      const { page, card } = await open(null);
      assert.match(await card.innerText(), /creates one app registration named "Claude Desktop \(Microsoft 365\)"/);
      assert.equal(await page.locator('.connector-manual-steps').evaluate(node => node.open), false, 'manual steps are folded away');
      await card.getByRole('button', { name: 'Set up automatically' }).click();
      await card.getByText('Set up. Restart Claude Desktop, then sign in to Microsoft 365 there.').waitFor();
      const apply = await page.evaluate(() => window.invoked.find(call => call.command === 'apply_connector_change')?.args.request);
      assert.equal(apply.id, 'microsoft365');
      assert.equal(apply.claudeDesktop, true);
      assert.deepEqual(apply.secrets, { MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555', MICROSOFT_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      await card.getByRole('button', { name: 'Restart Claude Desktop' }).click();
      await card.getByText('Claude Desktop restarted.').waitFor();
      assert.deepEqual(await page.evaluate(() => window.invoked.find(call => call.command === 'restart_agent_app')?.args), { client: 'claude-desktop' });
      await card.getByRole('button', { name: 'Run setup again' }).waitFor();
      await page.close();
    }

    // Rows: collapsed by default with each app's state visible; an opened row stays open after a reload.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'connectors');
        globalThis.mockConnectorTest = { status: 'needsSignIn', toolCount: null, message: null };
      });
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      const toggles = page.locator('.connector-row-toggle');
      await toggles.first().waitFor();
      assert.equal(await toggles.count(), 8);
      assert.equal(await page.locator('.connector-card-body:visible').count(), 0, 'all rows start collapsed');
      const google = page.getByRole('button', { name: /Google/ }).first();
      assert.match(await google.innerText(), /Claude Code · On[\s\S]*Claude Desktop · On/);
      // All closed: a grid of cards, several per row, each with a short description.
      const cards = page.locator('.connector-card');
      const [first, second] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
      assert.ok(Math.abs(first.y - second.y) < 2 && second.x > first.x + first.width / 2, 'closed connectors sit side by side in a grid');
      assert.ok(first.height < 220, `a closed card stays compact (${first.height}px)`);
      assert.equal(await page.locator('.connector-card-teaser:visible').count(), 8);
      await google.click();
      await page.reload();
      await page.locator('.connector-row-toggle').first().waitFor();
      assert.equal(await page.getByRole('button', { name: /Google/ }).first().getAttribute('aria-expanded'), 'true', 'opened row remembered');
      // With one open, every connector is a full-width row again and closed rows drop their description.
      const rows = page.locator('.connector-card');
      const [openBox, nextBox] = [await rows.nth(0).boundingBox(), await rows.nth(1).boundingBox()];
      assert.ok(nextBox.y > openBox.y + openBox.height - 2 && Math.abs(nextBox.width - openBox.width) < 2, 'rows stack full width while one is open');
      assert.equal(await page.locator('.connector-card-teaser:visible').count(), 0);
      // A Claude Code check that needs sign-in explains the separate sign-in and offers to open Claude Code.
      const googleCard = page.locator('.connector-card.is-open').first();
      await googleCard.getByRole('button', { name: 'Check connection' }).first().click();
      await googleCard.getByText(/Claude Code signs in separately, once: open Claude Code, type \/mcp, choose google-workspace/).waitFor();
      await googleCard.getByRole('button', { name: 'Open Claude Code' }).waitFor();
      await page.close();
    }

    // Claude Code without its own Microsoft 365 sign-in: the row says so before any test, the card explains /mcp,
    // and coming back to the window after signing in shows the new state.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'connectors');
        globalThis.mockMicrosoftCodeSignedIn = false;
      });
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      const row = page.getByRole('button', { name: /Microsoft 365 \(work\)/ });
      await row.waitFor();
      assert.match(await row.innerText(), /Claude Code · Needs sign-in/);
      await row.click();
      const hint = page.locator('.connector-code-sign-in');
      await hint.getByText(/Claude Code isn't signed in yet\. It signs in separately, once: open Claude Code, type \/mcp, choose microsoft-365/).waitFor();
      await hint.getByRole('button', { name: 'Open Claude Code' }).waitFor();
      await page.evaluate(() => { globalThis.mockMicrosoftCodeSignedIn = true; window.dispatchEvent(new Event('focus')); });
      await page.waitForFunction(() => /Claude Code · On/.test([...document.querySelectorAll('.connector-row-toggle')].find(node => /Microsoft 365/.test(node.textContent))?.textContent ?? ''));
      assert.equal(await hint.count(), 0, 'the hint goes once Claude Code is signed in');
      await page.close();
    }

    // Needs an admin: the approval link can be copied or opened.
    {
      const url = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/adminconsent?client_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const { page, card } = await open({ status: 'ok', tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', consent: 'needsAdmin', consentUrl: url });
      await card.getByRole('button', { name: 'Set up automatically' }).click();
      await card.getByText(/needs admin approval/).waitFor();
      await card.getByRole('button', { name: 'Open approval page' }).click();
      assert.deepEqual(await page.evaluate(() => window.invoked.find(call => call.command === 'open_external_url')?.args), { url });
      await page.close();
    }

    // A consent link that isn't Microsoft's is not offered.
    {
      const { page, card } = await open({ status: 'ok', tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', consent: 'needsAdmin', consentUrl: 'https://evil.example/consent' });
      await card.getByRole('button', { name: 'Set up automatically' }).click();
      await card.getByText(/needs admin approval/).waitFor();
      assert.equal(await card.getByRole('button', { name: 'Open approval page' }).count(), 0);
      await page.close();
    }

    // Missing module and an account that can't register apps both say what to do, and save nothing.
    for (const [outcome, text] of [
      [{ status: 'missingModule' }, 'Install-Module Microsoft.Graph.Applications -Scope CurrentUser'],
      [{ status: 'needsAdminToSetUp' }, /Ask your Microsoft 365 admin to run automatic setup/],
    ]) {
      const { page, card } = await open(outcome);
      await card.getByRole('button', { name: 'Set up automatically' }).click();
      await card.getByText(text).waitFor();
      assert.equal(await page.evaluate(() => window.invoked.some(call => call.command === 'apply_connector_change')), false);
      await page.close();
    }

    assert.deepEqual(errors, []);
    console.log('PASS: one-click Microsoft 365 setup saves the IDs, restarts Claude Desktop, and explains every other outcome.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
