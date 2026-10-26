const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// The smallest window (640x570 at 150% scaling) fits everything: the sidebar becomes a 56px icon rail in both densities,
// every page stays one click away, nothing spills sideways, and theme, density and language live in one menu.
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
    for (const density of ['comfortable', 'compact']) {
      const page = await browser.newPage({ viewport: { width: 640, height: 570 } });
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(d => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', 'home');
        localStorage.setItem('personal.density', d);
      }, density);
      await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
      await page.locator('.ad-row-card').first().waitFor();

      const rail = await page.locator('.sidebar').evaluate(bar => {
        const box = bar.getBoundingClientRect();
        return { width: box.width, height: box.height, scrollWidth: bar.scrollWidth };
      });
      assert.ok(rail.width <= 64, `${density}: the sidebar is an icon rail (${rail.width}px wide)`);
      assert.ok(rail.height >= 560, `${density}: the rail runs the full window height (${rail.height}px)`);
      assert.ok(rail.scrollWidth <= 64, `${density}: nothing in the rail spills sideways (${rail.scrollWidth}px)`);
      const contentWidth = await page.locator('.workspace .content').evaluate(node => node.getBoundingClientRect().width);
      assert.ok(contentWidth >= 570, `${density}: the page keeps nearly the whole window (${contentWidth}px)`);

      // Every page is a visible, named icon button, including the Advanced tools under the wrench.
      await page.locator('.sidebar .personal-advanced > summary').click();
      const navButtons = page.locator('.sidebar .nav-section button');
      const count = await navButtons.count();
      assert.ok(count >= 10, `${density}: all pages are in the rail (${count})`);
      for (let index = 0; index < count; index += 1) {
        const button = navButtons.nth(index);
        const box = await button.boundingBox();
        assert.ok(box && box.width >= 32 && box.height >= 28, `${density}: nav button ${index} is clickable (${JSON.stringify(box)})`);
        assert.ok(box.x + box.width <= 64, `${density}: nav button ${index} sits inside the rail`);
        const name = await button.evaluate(node => (node.getAttribute('aria-label') || node.textContent || '').trim());
        assert.ok(name.length > 0, `${density}: nav button ${index} keeps an accessible name`);
        assert.ok(await button.getAttribute('title'), `${density}: nav button ${index} names its page on hover`);
      }

      // Each page fits the width: no horizontal scroll on the document.
      const pages = await navButtons.evaluateAll(nodes => nodes.filter(node => !node.disabled).map((node, index) => index));
      for (const index of pages) {
        const button = page.locator('.sidebar .nav-section button:not([disabled])').nth(index);
        if (!(await button.isVisible())) {
          await page.evaluate(() => { const fold = document.querySelector('.sidebar .personal-advanced'); if (fold) fold.open = true; });
        }
        await button.click();
        await page.waitForTimeout(250);
        const label = await button.getAttribute('title');
        const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
        assert.ok(widths.doc <= widths.view, `${density}: ${label} fits the window width (${widths.doc} > ${widths.view})`);
      }

      // Theme, density and language all work from the one preferences menu.
      const toggle = page.locator('.sidebar-preferences-toggle');
      assert.equal(await toggle.isVisible(), true, `${density}: the preferences button is on the rail`);
      await toggle.click();
      const panel = page.locator('#sidebar-preferences-panel');
      await panel.waitFor({ state: 'visible' });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      const panelBox = await panel.boundingBox();
      assert.ok(panelBox.x >= 56 && panelBox.y + panelBox.height <= 570, `${density}: the menu opens beside the rail, inside the window`);
      await panel.getByRole('button', { name: 'Dark' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await panel.getByRole('button', { name: 'Light' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme !== 'dark');
      const other = density === 'compact' ? 'comfortable' : 'compact';
      await panel.locator('.sidebar-density-selector button').nth(density === 'compact' ? 0 : 1).click();
      await page.waitForFunction(d => (document.documentElement.dataset.density || 'comfortable') === d, other);
      await panel.locator('.sidebar-density-selector button').nth(density === 'compact' ? 1 : 0).click();
      await page.waitForFunction(d => (document.documentElement.dataset.density || 'comfortable') === d, density);
      await panel.locator('.sidebar-language-trigger').click();
      await page.locator('#sidebar-language-list [role="option"]').filter({ hasText: '日本語' }).click();
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
      await page.locator('.sidebar-language-trigger').click();
      await page.locator('#sidebar-language-list [role="option"]').filter({ hasText: 'English' }).click();
      await page.waitForFunction(() => document.documentElement.lang === 'en');

      // Escape and an outside click both close it.
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      await panel.waitFor({ state: 'visible' });
      await page.mouse.click(400, 300);
      await panel.waitFor({ state: 'hidden' });

      // Widening the window brings back the full sidebar with the controls in its footer.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width > 150);
      assert.equal(await toggle.isVisible(), false, `${density}: the wide sidebar has no preferences button`);
      assert.equal(await page.locator('.sidebar-density-selector').isVisible(), true, `${density}: density is back in the wide footer`);

      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('The smallest window shows every page on an icon rail with one display menu.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
