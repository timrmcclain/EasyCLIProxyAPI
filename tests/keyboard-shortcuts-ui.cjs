const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: R presses the page's own Refresh, but not while typing or behind a dialog;
// ? lists every shortcut (also from Ctrl+K); Ctrl+number still switches sections.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'connectors');
      window.invoked = [];
      const timer = setInterval(() => {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals?.invoke || internals.invoke.recording) return;
        const original = internals.invoke;
        internals.invoke = async (command, args, ...rest) => { window.invoked.push(command); return original(command, args, ...rest); };
        internals.invoke.recording = true;
        clearInterval(timer);
      }, 5);
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    const refresh = page.locator('main [data-page-refresh]');
    await page.getByRole('heading', { name: 'Connectors', level: 1 }).waitFor();
    await page.waitForFunction(() => !document.querySelector('main [data-page-refresh]')?.disabled);
    const loads = () => page.evaluate(() => window.invoked.filter(command => command === 'get_connector_overview').length);

    // R refreshes the page, exactly as its Refresh button does.
    const before = await loads();
    await page.locator('main h1').click();
    await page.keyboard.press('r');
    await page.waitForFunction(count => window.invoked.filter(command => command === 'get_connector_overview').length > count, before);
    await page.waitForFunction(() => !document.querySelector('main [data-page-refresh]')?.disabled);
    assert.equal(await refresh.count(), 1);

    // ? lists the shortcuts; R does nothing behind it; Escape closes it.
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Refresh this page/);
    assert.match(await dialog.innerText(), /Ctrl\s*\+\s*K/);
    const withDialog = await loads();
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    assert.equal(await loads(), withDialog, 'R is ignored while a dialog is open');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // The list is also in Ctrl+K.
    await page.locator('.sidebar-command-button').click();
    const palette = page.getByRole('dialog', { name: /command/i });
    await palette.waitFor();
    await page.keyboard.type('keyboard');
    await palette.getByText('Keyboard shortcuts').click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // Ctrl+number still switches sections, and R then refreshes the new page instead.
    await page.keyboard.press('Control+2');
    await page.getByRole('heading', { name: 'Accounts', level: 1 }).first().waitFor();
    // / jumps to the page's search box; typing "r" there types it instead of refreshing.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('/');
    const search = page.locator('main [data-page-search]');
    await page.waitForFunction(() => document.activeElement?.matches('main [data-page-search]'));
    const atAccounts = await loads();
    await page.keyboard.type('r');
    assert.equal(await search.inputValue(), 'r', 'typing r in a search box types it');
    assert.equal(await loads(), atAccounts);

    assert.deepEqual(errors, []);
    console.log('Keyboard shortcuts work and stay out of the way while typing.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
