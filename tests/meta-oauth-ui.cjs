const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.META_OAUTH_TEST_BASE_URL || process.env.DEVIN_TEST_BASE_URL || 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());

    const open = async (query = '') => {
      await page.goto(base + '/tests/fixtures/meta-oauth.html?' + query, { waitUntil: 'domcontentloaded' });
      await page.locator('.oauth-card').first().waitFor();
      // The OAuth sign-in page lists only Claude and Codex until "Show other providers" is checked.
      await page.locator('.oauth-login-page .personal-provider-toggle input').check();
    };
    const managementCard = () => page.locator('.oauth-card').filter({ hasText: /Muse \(Meta\) OAuth|Muse OAuth|Meta OAuth/ });
    const calls = () => page.evaluate(() => window.metaFixture.calls);
    const fixture = () => page.evaluate(() => window.metaFixture);
    const installClipboard = () => page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value) => window.metaFixture.copied.push(String(value)) },
      });
    });
    const waitForStatusCall = () => page.waitForFunction(() => window.metaFixture.statusCalls > 0);
    const startManagement = async () => {
      const card = managementCard();
      await card.getByRole('button', { name: /Start Sign-In|开始登录/, exact: true }).click();
      await card.getByText('META-CODE-1', { exact: true }).waitFor();
    };

    // Management view: Meta is a seventh OAuth provider, with device code and no callback input.
    await open('locale=en');
    const card = managementCard();
    assert.equal(await page.locator('.oauth-card').count(), 7, 'Meta should add a seventh OAuth card');
    assert.equal(await card.count(), 1, 'the Muse (Meta) card should be unique');
    assert.equal(await card.getByRole('textbox').count(), 0, 'Meta must not render a callback textbox');
    await installClipboard();
    await startManagement();
    assert.ok((await calls()).some(call => call.cmd === 'start_oauth_login' && call.args.provider === 'meta' && call.args.browser === 'none'));
    assert.equal(await card.getByText('Device Code', { exact: true }).count(), 1);
    assert.equal(await card.getByRole('button', { name: 'Copy Device Code', exact: true }).count(), 1);
    await card.getByRole('button', { name: 'Copy Device Code', exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.copied.includes('META-CODE-1'));
    await card.getByRole('button', { name: 'Open Link', exact: true }).click();
    assert.ok((await calls()).some(call => call.cmd === 'open_oauth_url' && String(call.args.url).includes('meta-attempt-1')));

    // Complete the flow and confirm the newly written credential is assigned priority zero.
    await waitForStatusCall();
    await page.evaluate(() => { window.metaFixture.status = 'ok'; });
    await card.getByText('Completed', { exact: true }).waitFor();
    assert.ok((await fixture()).priorityPatches.some(patch => patch.name === 'meta-oauth-1.json' && patch.priority === 0));
    assert.equal(await card.getByText('META-CODE-1', { exact: true }).count(), 0, 'success clears the device code');

    // A refresh cancels the old session and stale completion cannot win over attempt two.
    await open('locale=en');
    const refreshed = managementCard();
    await page.evaluate(() => { window.metaFixture.holdStatus = true; });
    await refreshed.getByRole('button', { name: /Start Sign-In/, exact: true }).click();
    await refreshed.getByText('META-CODE-1', { exact: true }).waitFor();
    await page.waitForFunction(() => window.metaFixture.releaseStatus !== null);
    await refreshed.getByRole('button', { name: 'Refresh Link', exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.attempts === 2);
    await refreshed.getByText('META-CODE-2', { exact: true }).waitFor();
    const refreshedFixture = await fixture();
    assert.ok(refreshedFixture.cancelledStates.includes('meta-attempt-1'));
    assert.equal(await refreshed.getByText('META-CODE-1', { exact: true }).count(), 0);
    await page.evaluate(() => { if (window.metaFixture.releaseStatus) window.metaFixture.releaseStatus(); });
    await page.waitForTimeout(100);
    assert.equal(await refreshed.getByText('Completed', { exact: true }).count(), 0, 'stale attempt must not complete refreshed login');
    assert.ok(await refreshed.getByText('META-CODE-2', { exact: true }).isVisible());

    // Error state can be retried and a later success still clears its device code.
    await open('locale=en');
    const retry = managementCard();
    await retry.getByRole('button', { name: /Start Sign-In/, exact: true }).click();
    await retry.getByText('META-CODE-1', { exact: true }).waitFor();
    await waitForStatusCall();
    await page.evaluate(() => { window.metaFixture.status = 'error'; });
    await page.getByText(/sign-in failed/i).waitFor();
    await retry.getByRole('button', { name: /Start Sign-In/, exact: true }).click();
    await page.waitForFunction(() => window.metaFixture.attempts === 2);
    await retry.getByText('META-CODE-2', { exact: true }).waitFor();
    await page.waitForFunction(() => window.metaFixture.statusCalls > 1);
    await page.evaluate(() => { window.metaFixture.status = 'ok'; });
    await retry.getByText('Completed', { exact: true }).waitFor();

    // Meta's 900-second expiry outlives the old ten-minute fallback, then clears stale controls.
    await open('locale=en');
    const expiring = managementCard();
    await expiring.getByRole('button', { name: 'Start Sign-In', exact: true }).click();
    await expiring.getByText('META-CODE-1', { exact: true }).waitFor();
    const pollsBeforeClockAdvance = await page.evaluate(() => {
      window.metaFixture.clockOffsetMs = 601_000;
      return window.metaFixture.statusCalls;
    });
    await page.waitForFunction((previous) => window.metaFixture.statusCalls > previous, pollsBeforeClockAdvance);
    assert.ok(await expiring.getByText('META-CODE-1', { exact: true }).isVisible(), 'device code is still valid after 601 seconds');
    assert.ok(await expiring.locator('.primary-button').first().isDisabled(), 'sign-in stays locked while the device code is valid');
    await page.evaluate(() => { window.metaFixture.clockOffsetMs = 901_000; });
    await page.getByText('Authorization timed out. Please initiate login again.', { exact: true }).waitFor();
    assert.equal(await expiring.getByText('META-CODE-1', { exact: true }).count(), 0, 'expiry clears the device code');
    assert.equal(await expiring.getByRole('button', { name: 'Copy Link', exact: true }).count(), 0, 'expiry clears the authorization link');
    assert.ok(await expiring.getByRole('button', { name: 'Start Sign-In', exact: true }).isEnabled());

    // Check the rendered labels and width constraints in both themes and viewport classes.
    fs.mkdirSync('misc', { recursive: true });
    for (const [theme, width] of [['light', 1280], ['dark', 390]]) {
      await page.setViewportSize({ width, height: 900 });
      await open(`locale=zh-CN&theme=${theme}`);
      const zhCard = managementCard();
      await zhCard.getByRole('button', { name: /开始登录/ }).click();
      await zhCard.getByText('META-CODE-1', { exact: true }).waitFor();
      assert.equal(await zhCard.getByText('设备码', { exact: true }).count(), 1);
      assert.equal(await zhCard.getByRole('button', { name: '复制设备码', exact: true }).count(), 1);
      assert.equal(await zhCard.getByRole('textbox').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} viewport overflows horizontally`);
      await page.screenshot({ path: `misc/meta-oauth-${theme}.png`, fullPage: true });

    }

    assert.deepEqual(errors, []);
    console.log('Meta OAuth browser checks passed: provider card, device code copy/open, refresh cancellation, stale poll isolation, success priority, retry, device-code expiry and responsive labels.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
