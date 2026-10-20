const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Switching Settings category after scrolling one starts the new category at its top, not at the old offset.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('personal.lastPage', 'config'); });
    await page.goto(`${base}/?mock=running&mockDelay=5`);
    await page.locator('#config-subpage-panel').waitFor();

    const tabs = await page.locator('[id^="config-subpage-tab-"]').evaluateAll(nodes => nodes.map(node => node.id.replace('config-subpage-tab-', '')));
    assert.equal(tabs.length, 9, 'nine categories');
    // Where the category's top sits relative to the visible area of whatever scrolls it.
    const panelTop = () => page.evaluate(() => {
      const panel = document.getElementById('config-subpage-panel');
      let container = panel.parentElement;
      while (container && !(/(auto|scroll)/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight)) container = container.parentElement;
      return panel.getBoundingClientRect().top - (container ? container.getBoundingClientRect().top : 0);
    });
    const scrollDown = () => page.evaluate(() => {
      const panel = document.getElementById('config-subpage-panel');
      let container = panel.parentElement;
      while (container && !(/(auto|scroll)/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight)) container = container.parentElement;
      if (container) container.scrollTop = container.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
    });

    let checked = 0;
    for (const from of tabs) {
      await page.locator(`#config-subpage-tab-${from}`).click();
      await scrollDown();
      if (await panelTop() >= 0) continue; // too short to scroll past its top
      for (const to of tabs.filter(id => id !== from)) {
        // The tab bar may scroll out of view with the content; reach it the way a keyboard user would.
        await page.locator(`#config-subpage-tab-${to}`).evaluate(node => node.click());
        await page.waitForTimeout(50);
        const top = await panelTop();
        assert.ok(top >= -1, `${from} → ${to}: new category starts at its top (offset ${top})`);
        await page.locator(`#config-subpage-tab-${from}`).evaluate(node => node.click());
        await scrollDown();
        checked += 1;
      }
    }
    assert.ok(checked >= 7, `at least one long category checked against every other (${checked} switches)`);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${checked} category switches after scrolling all start at the new category's top.`);
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
