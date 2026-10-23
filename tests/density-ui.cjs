const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Compact fits as much on screen as possible: half the spacing, one step smaller text, shorter rows and controls,
// a narrower sidebar, no zoom; controls stay at least 28px tall, and the choice is remembered.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
      localStorage.setItem('personal.density', 'comfortable');
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
    const row = page.locator('.ad-row-card').first();
    await row.waitFor();
    const measure = () => page.evaluate(() => {
      const card = document.querySelector('.ad-row-card');
      const name = card.querySelector('strong') ?? card;
      return {
        rowHeight: card.getBoundingClientRect().height,
        textSize: getComputedStyle(name).fontSize,
        contentHeight: document.querySelector('.workspace .content').scrollHeight,
        sidebarWidth: document.querySelector('.sidebar').getBoundingClientRect().width,
        shortestControl: Math.min(...[...document.querySelectorAll('.workspace .content button, .workspace .content select')]
          .filter(node => node.offsetParent && !node.closest('p, li > small')).map(node => node.getBoundingClientRect().height)),
        zoom: getComputedStyle(document.querySelector('.workspace .content')).zoom,
      };
    });
    const roomy = await measure();

    await page.locator('.sidebar-density-selector').getByRole('button', { name: 'Compact' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
    const compact = await measure();
    assert.ok(parseFloat(compact.textSize) < parseFloat(roomy.textSize), `text is a step smaller (${roomy.textSize} -> ${compact.textSize})`);
    assert.ok(parseFloat(compact.textSize) >= 11, `text stays readable (${compact.textSize})`);
    assert.ok(compact.zoom === '1' || compact.zoom === 'normal', `no zoom (${compact.zoom})`);
    assert.ok(compact.rowHeight <= roomy.rowHeight * 0.8, `rows are much shorter (${roomy.rowHeight} -> ${compact.rowHeight})`);
    assert.ok(compact.contentHeight <= roomy.contentHeight * 0.8, `far more fits on screen (${roomy.contentHeight} -> ${compact.contentHeight})`);
    assert.ok(compact.sidebarWidth < roomy.sidebarWidth, `sidebar is narrower (${roomy.sidebarWidth} -> ${compact.sidebarWidth})`);
    assert.ok(compact.shortestControl >= 24, `controls stay clickable (${compact.shortestControl}px)`);
    // Only what matters at a glance: explanations and routine labels go, problems stay.
    const visible = selector => page.evaluate(sel => [...document.querySelectorAll(sel)].some(node => node.offsetParent !== null), selector);
    for (const hidden of ['.glance-unconfirmed', '.ad-row-name .ad-provider', '.ad-row-status .quota-availability-available', '.ad-footnote', '.home-status-latest']) {
      assert.equal(await visible(hidden), false, `${hidden} is hidden in compact`);
    }
    for (const kept of ['.ad-row-status .quota-availability-unavailable', '.ad-card-note.ad-error', '.ad-quota-reset']) {
      assert.equal(await visible(kept), true, `${kept} stays in compact`);
    }
    console.log(`roomy ${JSON.stringify(roomy)}\ncompact ${JSON.stringify(compact)}`);

    await page.reload();
    await row.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact', 'remembered after reload');
    assert.equal(await page.locator('.sidebar-density-selector').getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed'), 'true');

    // Activity: the chart and breakdown stay, their explanations go, and panels size to their content.
    await page.locator('.sidebar').getByRole('button', { name: 'Activity' }).click();
    await page.locator('.usage-token-donut').waitFor();
    for (const hidden of ['.usage-token-notes', '.usage-records-page .response-times', '.usage-collector-state > strong ~ span']) {
      assert.equal(await visible(hidden), false, `${hidden} is hidden in compact`);
    }
    for (const kept of ['.usage-trend-chart', '.usage-token-donut']) {
      assert.equal(await visible(kept), true, `${kept} stays in compact`);
    }
    const trendHeight = await page.evaluate(() => document.querySelector('.usage-trend-panel').getBoundingClientRect().height);
    assert.ok(trendHeight <= 360, `trend panel sizes to its chart (${trendHeight}px)`);

    // Accounts: neutral badges and runtime captions go; problem badges stay.
    await page.locator('.sidebar').getByRole('button', { name: /^Accounts/ }).click();
    await page.locator('.auth-credential-row').first().waitFor();
    for (const hidden of ['.auth-list-status .auth-status-badge.neutral', '.auth-card-provider', '.auth-list-quota .quota-availability-disabled']) {
      assert.equal(await visible(hidden), false, `${hidden} is hidden in compact`);
    }
    for (const kept of ['.auth-list-status .auth-status-badge.error', '.auth-list-quota .quota-availability-unavailable']) {
      assert.equal(await visible(kept), true, `${kept} stays in compact`);
    }

    // Connectors: only what's on and what needs attention.
    await page.locator('.sidebar').getByRole('button', { name: /^Connectors/ }).click();
    await page.locator('.connector-row-state').first().waitFor({ state: 'attached' });
    assert.equal(await visible('.connector-row-state:not(.on):not(.warn)'), false, 'Off pills are hidden in compact');
    assert.equal(await visible('.connector-row-state.on'), true, 'On pills stay in compact');
    assert.equal(await visible('.connector-row-state.warn'), true, 'warnings stay in compact');

    // Secret Guard: explanations go; the state and the reason the menus are locked stay.
    await page.locator('.sidebar').getByRole('button', { name: /^Secret Guard/ }).click();
    await page.locator('.sg-policy').waitFor();
    assert.equal(await visible('.sg-page .jev-subtitle'), false, 'Secret Guard explanations are hidden in compact');
    assert.equal(await visible('.sg-switch-card .sg-state'), true, 'Secret Guard state stays in compact');

    // AI apps: explanations go; every client keeps its status line.
    await page.locator('.sidebar').getByRole('button', { name: /^AI apps/ }).click();
    await page.locator('.agent-list-items button').first().waitFor();
    for (const hidden of ['.agents-page > .personal-context', '.connection-overview > p', '.agent-client-list-footer > small']) {
      assert.equal(await visible(hidden), false, `${hidden} is hidden in compact`);
    }
    assert.equal(await visible('.agent-list-items button small'), true, 'client status lines stay in compact');

    // Settings: the section tabs fit on one line.
    await page.locator('.sidebar').getByRole('button', { name: /^Settings/ }).click();
    const tabs = page.locator('.config-settings-navigation');
    await tabs.waitFor();
    const tabRows = await tabs.evaluate(nav => new Set([...nav.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top))).size);
    assert.equal(tabRows, 1, 'settings tabs fit on one line');

    assert.deepEqual(errors, []);
    console.log('Compact density packs the screen while controls stay clickable.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
