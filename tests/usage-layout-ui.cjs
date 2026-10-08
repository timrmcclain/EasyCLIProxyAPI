const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1213, height: 600 } });
    await page.route('**/*', (route) => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/tests/fixtures/usage-layout.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.usage-trend-x-axis').waitFor();

    const statInfo1213 = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.usage-stat-card'));
      const metas = Array.from(document.querySelectorAll('.usage-stat-card-meta'));
      const tokenPanel = document.querySelector('.usage-health-panel');
      const trendPanel = document.querySelector('.usage-trend-panel');
      if (!(tokenPanel instanceof HTMLElement) || !(trendPanel instanceof HTMLElement)) throw new Error('Overview panels did not render');
      const tokenRect = tokenPanel.getBoundingClientRect();
      const trendRect = trendPanel.getBoundingClientRect();
      const tpsCard = cards.find((card) => card.querySelector('.usage-stat-card-label')?.textContent?.trim() === 'TPS');
      const tpsValue = tpsCard?.querySelector('.usage-stat-card-value')?.textContent?.trim() ?? '';
      return {
        cardCount: cards.length,
        metaCount: metas.length,
        detailPanelCount: document.querySelectorAll('.usage-stat-details-panel').length,
        tokensBesideTrend: tokenRect.left > trendRect.right && Math.abs(tokenRect.top - trendRect.top) < 1,
        tokenCount: tokenPanel.querySelectorAll('.usage-token-row').length,
        cacheShare: tokenPanel.querySelector('.usage-token-donut-label strong')?.textContent,
        contextText: tokenPanel.querySelector('.usage-token-context')?.textContent,
        successTitle: cards.find((card) => card.classList.contains('tone-success'))?.getAttribute('title') ?? '',
        tokenContentInsidePanel: tokenPanel.querySelector('.usage-token-context').getBoundingClientRect().bottom <= tokenRect.bottom,
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
        tpsValue,
      };
    });

    assert.equal(statInfo1213.cardCount, 6, 'There are 6 stat cards');
    assert.equal(statInfo1213.cardRows, 1, 'At 1213px width, all 6 cards fit into a single row');
    assert.equal(statInfo1213.metaCount, 0, 'The top stat cards show only their labels and primary values');
    assert.equal(statInfo1213.detailPanelCount, 0, 'The statistics details panel is removed');
    assert.equal(statInfo1213.tokensBesideTrend, true, 'Token composition sits beside the trend without an empty slot');
    assert.equal(statInfo1213.tokenCount, 4, 'Token composition separates uncached input, cache reads, cache writes and output');
    assert.equal(statInfo1213.cacheShare, '21.1%', 'The ring shows cache reads as a share of input plus output without double counting');
    assert.equal(statInfo1213.tokenContentInsidePanel, true, 'Supporting details remain inside the Token card');
    // Request outcomes are shown once, on the success-rate card, instead of being repeated in the Token card.
    assert.match(statInfo1213.successTitle, /50\D+4\D+0\D/, 'The success-rate card carries the success, failed and canceled counts');
    assert.equal(await page.locator('.usage-health-panel .usage-token-results').count(), 0, 'The Token card does not repeat request outcomes');
    for (const value of ['54', '0', 'RPM', '0.23', '2.84 s']) {
      assert.ok(statInfo1213.contextText.includes(value), `The Token card retains supporting performance and pricing details: ${value}`);
    }
    assert.ok(!statInfo1213.tpsValue.includes('TPS'), `TPS value should not contain TPS unit: ${statInfo1213.tpsValue}`);
    assert.ok(/^\d+(\.\d+)?$/.test(statInfo1213.tpsValue), `TPS value should be numeric: ${statInfo1213.tpsValue}`);

    await page.setViewportSize({ width: 950, height: 600 });
    await page.waitForFunction(() => {
      const trend = document.querySelector('.usage-trend-panel')?.getBoundingClientRect();
      const tokens = document.querySelector('.usage-health-panel')?.getBoundingClientRect();
      return !!trend && !!tokens && tokens.top >= trend.bottom;
    });

    // Narrow windows reflow the panels at their real size (stacked) instead of scaling them down.
    const geometry = await page.evaluate(() => {
      const layout = document.querySelector('.usage-overview-layout');
      const panel = document.querySelector('.usage-trend-panel');
      const plot = document.querySelector('.usage-trend-plot');
      const xAxis = document.querySelector('.usage-trend-x-axis');
      const tokenPanel = document.querySelector('.usage-health-panel');
      const canvas = document.querySelector('.usage-overview-canvas');
      const cards = Array.from(document.querySelectorAll('.usage-stat-card'));
      if (!(layout instanceof HTMLElement) || !(panel instanceof HTMLElement)
        || !(plot instanceof HTMLElement) || !(xAxis instanceof HTMLElement)
        || !(tokenPanel instanceof HTMLElement) || !(canvas instanceof HTMLElement)) throw new Error('Fixture did not render');
      const panelRect = panel.getBoundingClientRect();
      const xAxisRect = xAxis.getBoundingClientRect();
      const tokenRect = tokenPanel.getBoundingClientRect();
      return {
        layoutClientWidth: layout.clientWidth,
        layoutScrollWidth: layout.scrollWidth,
        plotHeight: plot.getBoundingClientRect().height,
        canvasTransform: getComputedStyle(canvas).transform,
        xAxisInsidePanel: xAxisRect.bottom <= panelRect.bottom,
        tokensBelowTrend: tokenRect.top >= panelRect.bottom,
        sameWidth: Math.abs(tokenRect.width - panelRect.width) < 1 && Math.abs(tokenRect.left - panelRect.left) < 1,
        tokenContentInsidePanel: tokenPanel.querySelector('.usage-token-context').getBoundingClientRect().bottom <= tokenRect.bottom,
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
      };
    });

    assert.equal(geometry.cardRows, 1, 'Summary cards stay compact to leave room for the charts');
    assert.equal(geometry.layoutScrollWidth, geometry.layoutClientWidth, 'The overview does not introduce horizontal scrolling');
    assert.equal(geometry.canvasTransform, 'none', 'The panels are not scaled down with a CSS transform');
    assert.ok(geometry.plotHeight >= 140, `The trend plot keeps its real size (${geometry.plotHeight})`);
    assert.equal(geometry.xAxisInsidePanel, true, 'The X axis remains inside the trend panel instead of being clipped');
    assert.equal(geometry.tokensBelowTrend, true, 'A narrow window stacks the Token card below the trend');
    assert.equal(geometry.sameWidth, true, 'The stacked panels share the full width');
    assert.equal(geometry.tokenContentInsidePanel, true, 'The stacked Token card contains all supporting details');

    assert.ok(await page.locator('.usage-trend-x-axis').evaluate((axis) => {
      const layout = axis.closest('.usage-overview-layout');
      if (!layout) return false;
      return axis.getBoundingClientRect().bottom <= layout.getBoundingClientRect().bottom + 1;
    }), 'The complete X axis is visible without scrolling the overview');

    await page.locator('.usage-trend-plot').hover();
    await page.locator('.usage-trend-tooltip').waitFor();
    await page.locator('.usage-trend-plot').press('Home');
    assert.ok(await page.locator('.usage-trend-tooltip-total').textContent(), 'The reflowed chart still supports pointer and keyboard inspection');
    await page.locator('.usage-trend-plot').press('Escape');

    const narrowAxis = await page.evaluate(() => ({
      width: document.querySelector('.usage-trend-plot')?.getBoundingClientRect().width ?? 0,
      ticks: document.querySelectorAll('.usage-trend-x-axis span').length,
    }));
    await page.setViewportSize({ width: 2400, height: 600 });
    await page.waitForFunction((previous) => {
      const plot = document.querySelector('.usage-trend-plot');
      const ticks = document.querySelectorAll('.usage-trend-x-axis span').length;
      return !!plot && plot.getBoundingClientRect().width > previous.width && ticks > previous.ticks;
    }, narrowAxis);
    const wideAxis = await page.evaluate(() => ({
      width: document.querySelector('.usage-trend-plot')?.getBoundingClientRect().width ?? 0,
      ticks: document.querySelectorAll('.usage-trend-x-axis span').length,
    }));
    assert.ok(wideAxis.width > narrowAxis.width, 'The trend plot follows the wider window');
    assert.ok(wideAxis.ticks > narrowAxis.ticks, 'The X axis adds readable ticks when more width is available');

    // Panels reflow at their real size: side by side with equal heights on wide windows, stacked on
    // narrow ones. They never shrink below a 360px floor; shorter windows scroll the overview instead.
    for (const [width, height] of [[1213, 1000], [1600, 1000], [1213, 600], [1280, 540], [950, 600]]) {
      await page.setViewportSize({ width, height });
      const stackedExpected = width < 1000;
      await page.waitForFunction((stacked) => {
        const trend = document.querySelector('.usage-trend-panel').getBoundingClientRect();
        const tokens = document.querySelector('.usage-health-panel').getBoundingClientRect();
        return (tokens.top >= trend.bottom) === stacked;
      }, stackedExpected);
      const panels = await page.evaluate(() => {
        const layout = document.querySelector('.usage-overview-layout');
        const trend = document.querySelector('.usage-trend-panel').getBoundingClientRect();
        const tokens = document.querySelector('.usage-health-panel').getBoundingClientRect();
        const context = document.querySelector('.usage-token-context').getBoundingClientRect();
        const composition = document.querySelector('.usage-token-composition').getBoundingClientRect();
        const donut = document.querySelector('.usage-token-donut').getBoundingClientRect();
        const breakdown = document.querySelector('.usage-token-breakdown').getBoundingClientRect();
        return {
          topDifference: Math.abs(trend.top - tokens.top),
          bottomDifference: Math.abs(trend.bottom - tokens.bottom),
          canvasHeight: document.querySelector('.usage-overview-canvas').getBoundingClientRect().height,
          contentInside: context.bottom <= tokens.bottom,
          windowBottomGap: window.innerHeight - tokens.bottom,
          windowRightGap: window.innerWidth - tokens.right,
          verticalOverflow: layout.scrollHeight - layout.clientHeight,
          horizontalOverflow: layout.scrollWidth - layout.clientWidth,
          chartInside: donut.top >= composition.top && donut.bottom <= composition.bottom
            && breakdown.top >= composition.top && breakdown.bottom <= composition.bottom
            && Array.from(document.querySelectorAll('.usage-token-row')).every((row) => {
              const bounds = row.getBoundingClientRect();
              return bounds.top >= composition.top && bounds.bottom <= composition.bottom;
            }),
        };
      });
      const size = `${width}×${height}`;
      if (!stackedExpected) {
        assert.ok(panels.topDifference < 1 && panels.bottomDifference < 1, `The two Token panels have equal heights at ${size}`);
      }
      assert.equal(panels.contentInside, true, `${size}: the Token panel preserves all supporting details`);
      assert.equal(panels.chartInside, true, `${size}: the ring and legend fit their chart area`);
      assert.equal(panels.horizontalOverflow, 0, `${size}: resizing does not introduce horizontal scrolling`);
      assert.ok(panels.windowRightGap >= 0 && panels.windowRightGap <= 20, `${size}: the overview keeps a compact margin at the window edge`);
      if (!stackedExpected && panels.canvasHeight > 361) {
        assert.equal(panels.verticalOverflow, 0, `${size}: a window taller than the panel floor needs no vertical scrolling`);
        assert.ok(panels.windowBottomGap >= 0 && panels.windowBottomGap <= 20, `${size}: the panels use the available height with a compact bottom margin`);
      } else {
        if (!stackedExpected) assert.ok(Math.abs(panels.canvasHeight - 360) < 1, `${size}: side-by-side panels only stop shrinking at their 360px floor (${panels.canvasHeight})`);
        // Content below the fold stays reachable by scrolling the overview rather than being clipped.
        const reachable = await page.locator('.usage-overview-layout').evaluate((layout) => {
          layout.scrollTop = layout.scrollHeight;
          const visible = document.querySelector('.usage-health-panel').getBoundingClientRect().bottom <= layout.getBoundingClientRect().bottom + 1;
          layout.scrollTop = 0;
          return visible;
        });
        assert.equal(reachable, true, `${size}: the whole Token panel can be scrolled into view`);
      }
    }

    const filterGroup = page.locator('.usage-filter-group');
    const filterBounds = await filterGroup.boundingBox();
    assert.equal(await page.locator('.usage-filter-reset-btn').count(), 0, 'The overview does not show a reset filters button');
    // Filters are SelectMenu comboboxes (time range first, model second); pick options by position.
    const filterTrigger = (index) => page.locator('.usage-filter-item .select-menu-trigger').nth(index);
    const chooseOption = async (index, option) => {
      const trigger = filterTrigger(index);
      await trigger.click();
      const listbox = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
      const choice = typeof option === 'number' ? listbox.getByRole('option').nth(option) : listbox.getByRole('option', { name: option, exact: true });
      const label = (await choice.textContent()).trim();
      await choice.click();
      await page.waitForFunction(({ index, label }) => document.querySelectorAll('.usage-filter-item .select-menu-trigger')[index]?.textContent.trim() === label, { index, label });
      return label;
    };
    const filterText = async (index) => (await filterTrigger(index).textContent()).trim();
    const allModelsLabel = await filterText(1);
    await chooseOption(1, 'test-model');
    await page.locator('.usage-trend-x-axis').waitFor();
    assert.equal(await filterText(1), 'test-model', 'Model filtering remains available');
    assert.equal(await page.locator('.usage-filter-reset-btn').count(), 0, 'Selecting a filter does not reveal a reset button');
    assert.deepEqual(await filterGroup.boundingBox(), filterBounds, 'Selecting a filter does not shift or resize the filter row');
    await chooseOption(1, 0);
    await chooseOption(0, 6); // Custom
    await page.locator('.usage-custom-range').waitFor();
    assert.equal(await page.locator('.usage-filter-reset-btn').count(), 0, 'Custom date filters do not reveal a reset button');
    await chooseOption(0, 0); // Last 4 hours
    await page.locator('.usage-trend-x-axis').waitFor();
    assert.equal(await filterText(1), allModelsLabel, 'Filters can still be cleared through their own dropdowns');

    console.log('PASS: usage overview layout, responsive trend axis, and stable filters without a reset button passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
