const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Navigation and desktop: pin a page to the top of the sidebar from the palette (kept across restarts), a
// breadcrumb on Advanced tools pages, pages come back scrolled where you left them, the palette opens the mini
// window, and the mini window shows the tray's status with a way back to the hub.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem('personal.lastPage', 'health'); sessionStorage.setItem('seeded', '1'); }
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    const openPalette = async () => {
      await page.locator('.sidebar-command-button').click();
      const palette = page.getByRole('dialog', { name: /command/i });
      await palette.waitFor();
      return palette;
    };

    // An Advanced tools page names where it sits.
    const crumbs = page.getByRole('navigation', { name: 'Where you are' });
    await crumbs.waitFor();
    assert.deepEqual(await crumbs.locator('li').allInnerTexts(), ['Advanced tools', 'Diagnostics', 'Health check']);

    // Pin it from the palette: it appears at the top of the sidebar and stays after a reload.
    let palette = await openPalette();
    assert.equal(await palette.locator('#palette-pin-page').innerText().then(text => text.split('\n')[0]), 'Pin Health check to the top of the sidebar');
    await palette.locator('#palette-pin-page').click();
    const pinnedGroup = page.getByRole('group', { name: 'Pinned' });
    await pinnedGroup.getByRole('button', { name: 'Health check' }).waitFor();
    await page.reload();
    await pinnedGroup.getByRole('button', { name: 'Health check' }).waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('personal.pinnedPages'))), ['health']);

    // Overview has no breadcrumb; a long page comes back scrolled where it was left.
    await page.locator('.nav-section').getByRole('button', { name: /^Overview/ }).first().click();
    await page.locator('.ad-card').first().waitFor();
    assert.equal(await crumbs.count(), 0);
    await page.evaluate(() => { document.body.style.minHeight = '4000px'; window.scrollTo({ top: 600 }); });
    await page.waitForFunction(() => window.scrollY >= 590);
    await pinnedGroup.getByRole('button', { name: 'Health check' }).click();
    await crumbs.waitFor();
    await page.locator('.nav-section').getByRole('button', { name: /^Overview/ }).first().click();
    await page.waitForFunction(() => window.scrollY >= 590, null, { timeout: 5000 });

    // Unpin from the palette.
    palette = await openPalette();
    await page.keyboard.type('Unpin');
    assert.equal(await palette.locator('#palette-pin-page').count(), 0, 'the pin command is for the page you are on');
    await page.keyboard.press('Escape');
    await pinnedGroup.getByRole('button', { name: 'Health check' }).click();
    palette = await openPalette();
    await palette.locator('#palette-pin-page').click();
    await pinnedGroup.waitFor({ state: 'detached' });

    // The palette opens the mini window.
    await page.evaluate(() => { window.__mockCalls = []; });
    palette = await openPalette();
    await palette.locator('#palette-mini-window').click();
    await page.waitForFunction(() => (window.__mockCalls || []).includes('open_mini_window'));

    // The mini window: waiting until the first summary arrives, then the tray's status, one provider per line.
    const mini = await browser.newPage({ viewport: { width: 340, height: 150 } });
    mini.on('pageerror', error => errors.push(String(error)));
    await mini.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); });
    await mini.goto(`${base}/?mock=running&mini=1`, { timeout: 60000 });
    await mini.getByText('Waiting for the hub’s first check…').waitFor();
    assert.equal(await mini.locator('.sidebar').count(), 0, 'only the mini view renders');
    await mini.close();
    const seeded = await browser.newPage({ viewport: { width: 340, height: 150 } });
    seeded.on('pageerror', error => errors.push(String(error)));
    await seeded.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      window.__mockHubSummary = { menuText: 'Quota: Codex all out · Claude 1 low', tooltipText: 'Codex all out · Claude 1 low', level: 'out' };
    });
    await seeded.goto(`${base}/?mock=running&mini=1`, { timeout: 60000 });
    await checkSeeded(seeded);

    assert.deepEqual(errors, []);
    console.log('PASS: pages pin from the palette, Advanced pages show where they sit, scroll is remembered, and the mini window shows the hub status.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

async function checkSeeded(mini) {
    await mini.getByText('A provider is out of quota').waitFor();
    assert.deepEqual(await mini.locator('.mini-hub li').allInnerTexts(), ['Codex all out', 'Claude 1 low']);
    await mini.evaluate(() => { window.__mockCalls = []; });
    // The browser mock's toolbar covers this tiny page, so press the button from the keyboard.
    await mini.getByRole('button', { name: 'Open the hub' }).focus();
    await mini.keyboard.press('Enter');
    await mini.waitForFunction(() => (window.__mockCalls || []).includes('show_main_from_mini'));
}
