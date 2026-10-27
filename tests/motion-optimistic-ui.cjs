const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Motion and instant feedback: a routing row moved with its arrow glides to its new place (not under reduced
// motion), and switching an account off shows at once, before the hub answers, and goes back with a message when
// the hub refuses.
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
    const open = async (lastPage) => {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(value => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', value);
      }, lastPage);
      await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
      return page;
    };
    // A row moved with its arrow glides; under reduced motion it just moves.
    const page = await open('home');
    await page.locator('.ad-card').first().waitFor();
    await page.locator('.nav-section').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#config-subpage-tab-routing').click();
    const card = page.locator('.routing-order-card').first();
    await card.locator('.routing-order-row').nth(1).waitFor();
    await card.getByRole('button', { name: 'Your order', exact: true }).click();
    const gliding = () => card.locator('.routing-order-row').evaluateAll(rows => rows.filter(row => row.getAnimations().some(a => a.playState === 'running')).length);
    await card.getByRole('button', { name: /^Move .* down$/ }).first().click();
    assert.ok(await gliding() >= 2, 'both swapped rows glide');
    await page.waitForTimeout(400);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await card.getByRole('button', { name: /^Move .* down$/ }).first().click();
    assert.equal(await gliding(), 0, 'no glide under reduced motion');
    await page.close();

    // Switching an account off shows at once, while the hub is still answering.
    const accounts = await open('oauth');
    const row = accounts.locator('.auth-file-card').filter({ has: accounts.locator('.auth-list-switch[aria-checked="true"]:not(:disabled)') }).first();
    await row.waitFor();
    const name = await row.locator('.auth-list-switch').getAttribute('aria-label');
    const sw = accounts.getByRole('switch', { name, exact: true });
    await accounts.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.statusWrites = 0;
      window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
        if (command === 'management_request' && args?.request?.path === '/credentials/status') {
          window.statusWrites += 1;
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (window.refuseStatus) throw new Error('The hub refused the change');
        }
        return original(command, args, ...rest);
      };
    });
    const started = Date.now();
    await sw.click();
    await accounts.waitForFunction(() => window.statusWrites === 1);
    const flipped = accounts.getByRole('switch', { name: name.replace(/^Disable/, 'Enable'), exact: true });
    await flipped.waitFor({ timeout: 600 });
    assert.equal(await flipped.getAttribute('aria-checked'), 'false');
    assert.ok(Date.now() - started < 1400, 'shown before the hub answered');
    await accounts.getByText(/was disabled|disabled/i).first().waitFor();

    // Refused: it goes back the way the hub has it, with the reason.
    await accounts.getByRole('button', { name: 'Undo', exact: true }).first().waitFor();
    await accounts.evaluate(() => { window.refuseStatus = true; });
    await flipped.click();
    await accounts.getByRole('switch', { name, exact: true }).waitFor({ timeout: 600 });
    await accounts.getByText('The hub refused the change').waitFor();
    assert.equal(await accounts.getByRole('switch', { name: name.replace(/^Disable/, 'Enable'), exact: true }).getAttribute('aria-checked'), 'false', 'back as the hub has it');
    await accounts.close();

    assert.deepEqual(errors, []);
    console.log('PASS: moved rows glide (not under reduced motion), and switching an account off shows at once and rolls back when refused.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
