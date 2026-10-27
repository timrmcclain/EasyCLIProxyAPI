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
    // Requests: a success is its green dot alone, a failure keeps its word, and the row count goes while paging stays.
    await page.locator('#usage-tab-events').click();
    await page.locator('.usage-request-log .usage-result.failed').first().waitFor();
    const results = await page.evaluate(() => ({
      success: getComputedStyle(document.querySelector('.usage-request-log .usage-result.success')).fontSize,
      dot: document.querySelector('.usage-request-log .usage-result.success .usage-result-dot').getBoundingClientRect().width,
      failed: getComputedStyle(document.querySelector('.usage-request-log .usage-result.failed')).fontSize,
    }));
    assert.equal(results.success, '0px', 'a success shows only its dot in compact');
    assert.ok(results.dot >= 6, `the success dot stays visible (${results.dot}px)`);
    assert.ok(parseFloat(results.failed) >= 11, `a failure keeps its word (${results.failed})`);
    assert.equal(await visible('.usage-pagination-summary'), false, 'the row count is hidden in compact');
    // Costs: each model's requests, tokens and cost stay; the per-token prices go and Edit stays.
    await page.locator('#usage-tab-pricing').click();
    await page.locator('.usage-pricing-table tbody tr').first().waitFor();
    const costColumns = await page.evaluate(() => [...document.querySelectorAll('.usage-pricing-table thead th')].filter(th => th.offsetParent).map(th => th.textContent.trim()));
    assert.equal(costColumns.length, 5, `costs keep five columns in compact (${costColumns.join(', ')})`);
    assert.equal(await visible('.usage-pricing-table .usage-price-row-actions button'), true, 'Edit stays in compact');

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
    // The unavailable pill comes from a second, later load than the on/off pills, so wait for it to exist first.
    await page.locator('.connector-row-state.warn').first().waitFor({ state: 'attached' });
    assert.equal(await visible('.connector-row-state.warn'), true, 'warnings stay in compact');

    // Secret Guard: explanations go; the state and the reason the menus are locked stay.
    await page.locator('.sidebar').getByRole('button', { name: /^Secret Guard/ }).click();
    await page.locator('.sg-policy').waitFor();
    // The state line appears once Secret Guard's status loads; waiting for it to be visible also proves compact keeps it.
    await page.locator('.sg-switch-card .sg-state').first().waitFor({ state: 'visible' });
    assert.equal(await visible('.sg-page .jev-subtitle'), false, 'Secret Guard explanations are hidden in compact');
    assert.equal(await visible('.sg-switch-card .sg-state'), true, 'Secret Guard state stays in compact');

    // AI apps: explanations go; every client keeps its status line.
    await page.locator('.sidebar').getByRole('button', { name: /^AI apps/ }).click();
    await page.locator('.agent-list-items button').first().waitFor();
    for (const hidden of ['.agents-page > .personal-context', '.connection-overview > p', '.agent-client-list-footer > small']) {
      assert.equal(await visible(hidden), false, `${hidden} is hidden in compact`);
    }
    assert.equal(await visible('.agent-list-items button small'), true, 'client status lines stay in compact');

    // Advanced tools. Health check: with problems present, only the problems show.
    await page.evaluate(() => { localStorage.setItem('personal.lastPage', 'health'); });
    await page.reload();
    await page.locator('.health-item').first().waitFor();
    assert.equal(await visible('.health-item.level-ok'), false, 'passing checks are hidden while something needs fixing');
    assert.equal(await visible('.health-item.level-fail'), true, 'problems stay in compact');
    // Proxy: field labels stay; the format note and process detail go.
    await page.evaluate(() => { localStorage.setItem('personal.lastPage', 'proxy'); });
    await page.reload();
    await page.locator('.home-runtime-details').waitFor();
    assert.equal(await visible('.home-runtime-details [data-runtime="pid"]'), false, 'process ID is hidden in compact');
    assert.equal(await visible('.home-access-panel .home-field-label > span:first-child'), true, 'field labels stay in compact');
    // Proxy plugins: version, source and platform lines go; each plugin's name, what it does and its actions stay.
    await page.evaluate(() => { localStorage.setItem('personal.lastPage', 'plugins'); });
    await page.reload();
    await page.locator('.plugins-page .plugin-card').first().waitFor();
    assert.equal(await visible('.plugins-page .plugin-card .plugin-meta'), false, 'plugin version and source lines are hidden in compact');
    assert.equal(await visible('.plugins-page .plugin-card .plugin-card-actions button'), true, 'plugin actions stay in compact');
    // Updates: the cards size to their content; every version and action stays.
    await page.evaluate(() => { localStorage.setItem('personal.lastPage', 'versions'); });
    await page.reload();
    const core = page.locator('.version-management-page .core-module-card');
    await core.waitFor();
    assert.ok((await core.boundingBox()).height <= 170, `the proxy engine card sizes to its content (${(await core.boundingBox()).height}px)`);
    assert.equal(await core.locator('.version-metric-tile').count(), 2, 'current and latest versions stay in compact');
    assert.equal(await core.locator('.version-card-actions button').count(), 3, 'all three update actions stay in compact');
    // Jev: the Status heading is for screen readers only; the status card shows.
    await page.evaluate(() => { localStorage.setItem('personal.lastPage', 'jev'); });
    await page.reload();
    await page.locator('.jev-page .jev-card').first().waitFor();
    assert.ok((await page.locator('#jev-status-title').boundingBox()).height <= 1, 'the Status heading is visually hidden in compact');
    assert.equal(await page.locator('#jev-status-title').innerText(), 'Status', 'it is still read out');
    await page.evaluate(() => { localStorage.setItem('personal.lastPage', 'home'); });

    // Command palette: the key hints go; the list stays.
    await page.keyboard.press('Control+k');
    await page.locator('.command-palette-list li').first().waitFor();
    assert.equal(await visible('.command-palette-footer'), false, 'palette key hints are hidden in compact');
    await page.keyboard.press('Escape');

    // Settings: the section tabs fit on one line.
    await page.locator('.sidebar').getByRole('button', { name: /^Settings/ }).click();
    const tabs = page.locator('.config-settings-navigation');
    await tabs.waitFor();
    const tabRows = await tabs.evaluate(nav => new Set([...nav.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top))).size);
    assert.equal(tabRows, 1, 'settings tabs fit on one line');
    // Logs & diagnostics: the log keeps its own folder button, the settings card's second one goes, and the log box
    // sizes to its lines.
    await tabs.locator('button', { hasText: 'Logs & diagnostics' }).click();
    await page.locator('.proxy-log-panel .proxy-log-line').first().waitFor();
    assert.equal(await visible('.config-diagnostics-actions > button'), false, 'the duplicate Open log folder is hidden in compact');
    assert.equal(await visible('.proxy-log-toolbar button'), true, 'the log toolbar stays in compact');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.proxy-log-lines')).minHeight), '0px', 'the log box sizes to its lines');
    // Storage: the routine badge and the limit's explanation go; current usage and what each cleanup deletes stay.
    await tabs.locator('button', { hasText: /^Storage$/ }).click();
    // Usage loads after the tab opens; waiting for it to be visible also proves compact keeps it.
    await page.locator('.usage-storage-limit-action > div:first-child > small').waitFor({ state: 'visible' });
    assert.equal(await visible('.usage-data-management-badge'), false, 'the Manual action badge is hidden in compact');
    assert.equal(await visible('.usage-storage-limit-action > div:first-child > small'), true, 'current usage stays in compact');
    assert.equal(await visible('.usage-data-management-action:not(.usage-storage-limit-action) > div:first-child > span'), true, 'what each cleanup deletes stays in compact');
    // Extensions & integrations: the explanation goes; the title and both buttons stay, on one line.
    await tabs.locator('button', { hasText: 'Extensions & integrations' }).click();
    const guide = page.locator('.config-extension-guide');
    await guide.waitFor();
    assert.equal(await visible('.config-extension-guide > p'), false, 'the plugins explanation is hidden in compact');
    assert.equal(await guide.locator('button').count(), 2, 'Open Plugins and advanced settings stay in compact');
    const guideCenters = await guide.evaluate(card => [card.querySelector('h2'), ...card.querySelectorAll('button')].map(node => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; }));
    const guideRows = Math.max(...guideCenters) - Math.min(...guideCenters) <= 4 ? 1 : 2;
    assert.equal(guideRows, 1, 'the plugins title and buttons share one line');
    // App preferences: Quiet hours' times show once it's ticked; the empty save row goes.
    await tabs.locator('button', { hasText: 'App preferences' }).click();
    const quiet = page.locator('.alert-quiet-hours');
    await quiet.waitFor();
    const quietOn = await quiet.locator('legend input').isChecked();
    assert.equal(await visible('.alert-quiet-range'), quietOn, 'quiet hours times follow the Quiet hours box in compact');
    assert.equal(await visible('.config-software-panel .config-settings-save-row'), false, 'the empty save row is hidden in compact');
    // Service & access: each key is one line, its numbering goes, and every key action stays.
    await tabs.locator('button', { hasText: 'Service & access' }).click();
    const keyRow = page.locator('.config-keys-panel .config-key-row').first();
    await keyRow.waitFor();
    assert.equal(await visible('.config-keys-panel .config-key-index'), false, 'key numbering is hidden in compact');
    assert.equal(await keyRow.locator('.config-key-actions button').count(), 3, 'copy, edit and delete stay in compact');
    assert.ok((await keyRow.boundingBox()).height <= 40, `each key is one line (${(await keyRow.boundingBox()).height}px)`);
    // Model aliases: each alias is one line; its kind stays and the source note goes.
    await tabs.locator('button', { hasText: 'Model aliases' }).click();
    const aliasRow = page.locator('.thinking-alias-row').first();
    await aliasRow.waitFor();
    assert.equal(await visible('.thinking-alias-route-source small > span'), false, 'the alias source note is hidden in compact');
    assert.equal(await visible('.thinking-alias-route-source small > em'), true, 'the alias kind stays in compact');
    assert.ok((await aliasRow.boundingBox()).height <= 44, `each alias is one line (${(await aliasRow.boundingBox()).height}px)`);
    // Routing & reliability: all three strategies stay at control height; empty save rows go until something changes.
    await tabs.locator('button', { hasText: 'Routing & reliability' }).click();
    const strategy = page.locator('.routing-segmented button');
    await strategy.first().waitFor();
    assert.equal(await strategy.count(), 3, 'all three routing strategies stay in compact');
    assert.ok((await strategy.first().boundingBox()).height <= 32, `strategy buttons are control height (${(await strategy.first().boundingBox()).height}px)`);
    assert.equal(await visible('#config-native-routing .config-settings-save-row'), false, 'an empty save row is hidden in compact');
    // Models & requests: a closed payload rule is one line; sensitive words share rows and stay editable.
    await tabs.locator('button', { hasText: 'Models & requests' }).click();
    const rule = page.locator('.template-config-field-wide:has(> details.template-config-custom)').first();
    await rule.waitFor();
    assert.ok((await rule.boundingBox()).height <= 40, `a closed payload rule is one line (${(await rule.boundingBox()).height}px)`);
    const words = page.locator('.config-sensitive-words-row');
    await words.first().waitFor();
    const wordTops = await words.evaluateAll(rows => rows.slice(0, 2).map(row => Math.round(row.getBoundingClientRect().top)));
    assert.equal(wordTops[0], wordTops[1], 'sensitive words share a row in compact');
    assert.equal(await words.first().locator('input').isEditable(), true, 'sensitive words stay editable');
    // Upstreams & credentials: a setting owned by another page is one line with its edit button.
    await tabs.locator('button', { hasText: 'Upstreams & credentials' }).click();
    await page.locator('.config-extension-guide-actions button', { hasText: 'Show advanced' }).click();
    const owned = page.locator('.template-config-field:has(> .template-config-control > .owned-setting)').first();
    await owned.waitFor();
    assert.ok((await owned.boundingBox()).height <= 40, `an owned setting is one line (${(await owned.boundingBox()).height}px)`);
    assert.equal(await owned.locator('button').isVisible(), true, 'its edit button stays in compact');

    // Sidebar: every page and control fits without scrolling, including with Advanced tools open.
    await page.evaluate(() => { const fold = document.querySelector('.sidebar .personal-advanced'); if (fold) fold.open = true; });
    const sidebar = await page.evaluate(() => { const bar = document.querySelector('.sidebar'); return { scroll: bar.scrollHeight, client: bar.clientHeight }; });
    assert.ok(sidebar.scroll <= sidebar.client, `the sidebar fits without scrolling (${sidebar.scroll} > ${sidebar.client})`);
    assert.equal(await visible('.sidebar-density-selector'), true, 'Roomy/Compact stays in compact');

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
